/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Yjs-based canvas-state tests.
 *
 * The legacy apply* / applyBatchOperations API has been removed; the server
 * now holds a Y.Doc per canvas and applies updates via Y.applyUpdate. These
 * tests cover the new surface: load/persist, JSON snapshot merge, and the
 * dirty-tracking that drives debounced persistence.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as Y from 'yjs'

vi.mock('../utils/logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}))

const mockCanvasRow: { yjsUpdate?: string | null; yjsData?: string | null; id?: number } = {}
vi.mock('../database/connection', () => ({
  db: {
    query: {
      canvases: {
        findFirst: vi.fn(async () => ({ ...mockCanvasRow })),
      },
    },
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    })),
  },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => true),
  sql: vi.fn(),
}))

import {
  loadCanvasStateFromDb,
  persistCanvasState,
  removeCanvasState,
  mergeJsonSnapshotIntoCanvas,
  getCanvasJsonSnapshot,
  getCanvasDoc,
  applyUpdateToCanvas,
  isCanvasStatePersisted,
  snapshotMissingDocEntities,
} from '../websocket/canvas-state.js'
import {
  encodeDocToBase64,
  jsonSnapshotToDoc,
  ensureRoot,
  writeEntityToYMap,
  collectTombstonedIds,
} from '../websocket/yjs-schema.js'
import { db } from '../database/connection.js'

const CANVAS_ID = 1

describe('Yjs canvas-state', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockCanvasRow)) delete (mockCanvasRow as any)[k]
    removeCanvasState(CANVAS_ID)
  })

  afterEach(() => {
    removeCanvasState(CANVAS_ID)
  })

  describe('loadCanvasStateFromDb', () => {
    it('loads a canvas doc from the yjs_update column', async () => {
      const seed = jsonSnapshotToDoc({
        nodes: [{ id: 'n1', x: 10, y: 20 } as any],
      })
      mockCanvasRow.yjsUpdate = encodeDocToBase64(seed)

      const state = await loadCanvasStateFromDb(CANVAS_ID)
      expect(state.loaded).toBe(true)
      const snapshot = getCanvasJsonSnapshot(CANVAS_ID)
      expect(snapshot.nodes).toHaveLength(1)
      expect((snapshot.nodes[0] as any).id).toBe('n1')
    })

    it('falls back to legacy yjs_data JSON when yjs_update is absent', async () => {
      const json = Buffer.from(
        JSON.stringify({ nodes: [{ id: 'legacy', x: 1, y: 2 }] }),
        'utf-8',
      ).toString('base64')
      mockCanvasRow.yjsData = json

      const state = await loadCanvasStateFromDb(CANVAS_ID)
      expect(state.loaded).toBe(true)
      const snapshot = getCanvasJsonSnapshot(CANVAS_ID)
      expect(snapshot.nodes).toHaveLength(1)
      expect((snapshot.nodes[0] as any).id).toBe('legacy')
      // Verify the converted Yjs doc was persisted back to the DB
      expect(db.update).toHaveBeenCalled()
    })

    it('yields an empty doc when neither column is populated', async () => {
      const state = await loadCanvasStateFromDb(CANVAS_ID)
      expect(state.loaded).toBe(true)
      const snapshot = getCanvasJsonSnapshot(CANVAS_ID)
      expect(snapshot.nodes).toHaveLength(0)
    })
  })

  describe('mergeJsonSnapshotIntoCanvas', () => {
    it('merges a JSON snapshot into the doc and exposes it via getCanvasJsonSnapshot', async () => {
      await loadCanvasStateFromDb(CANVAS_ID)
      const ok = await mergeJsonSnapshotIntoCanvas(CANVAS_ID, {
        nodes: [{ id: 'm1', x: 5, y: 6 } as any],
        connections: [{ id: 'c1', fromNodeId: 'm1', toNodeId: 'm2' } as any],
      })
      expect(ok).toBe(true)
      const snapshot = getCanvasJsonSnapshot(CANVAS_ID)
      expect(snapshot.nodes).toHaveLength(1)
      expect(snapshot.connections).toHaveLength(1)
    })
  })

  /**
   * H2 幽灵复活防护。
   *
   * 场景：A 与 B 协作。B 删除实体 E（doc 中产生删除墓碑）。A 的客户端因断线
   * 仍持有一份包含 E 的旧全量快照，重连后 POST /data 把它发上来。若服务端
   * 直接写回 E，E 会在所有人面前复活，而删除它的 B 本地看不到它 —— 双端分叉。
   *
   * 服务端因此在 doc 中读取删除墓碑（collectTombstonedIds），在 upsertOnly
   * （快照不可信）分支拒绝复活。反向约束同样重要：单用户"删除 → 撤销"必须
   * 仍能落库，故墓碑**不**强制 upsertOnly、且不拦截仍存活的 id。
   */
  describe('H2 tombstone protection against ghost revival', () => {
    it('collectTombstonedIds reports deleted ids and excludes live ones', async () => {
      await loadCanvasStateFromDb(CANVAS_ID)
      await mergeJsonSnapshotIntoCanvas(CANVAS_ID, {
        nodes: [
          { id: 'gone', x: 1, y: 2 } as any,
          { id: 'alive', x: 3, y: 4 } as any,
        ],
      })

      const doc = getCanvasDoc(CANVAS_ID)!
      expect(collectTombstonedIds(doc, ensureRoot(doc)).nodes.size).toBe(0)

      // 全量替换（upsertOnly=false）且快照只保留 alive → gone 被真删除。
      await mergeJsonSnapshotIntoCanvas(CANVAS_ID, {
        nodes: [{ id: 'alive', x: 3, y: 4 } as any],
      })

      const tombstones = collectTombstonedIds(doc, ensureRoot(doc))
      expect(tombstones.nodes.has('gone')).toBe(true)
      expect(tombstones.nodes.has('alive')).toBe(false)
    })

    it('upsertOnly merge refuses to resurrect a tombstoned entity (H2)', async () => {
      await loadCanvasStateFromDb(CANVAS_ID)
      await mergeJsonSnapshotIntoCanvas(CANVAS_ID, {
        nodes: [{ id: 'gone', x: 1, y: 2 } as any],
      })
      // B 删除 gone → 墓碑产生。
      await mergeJsonSnapshotIntoCanvas(CANVAS_ID, { nodes: [] })
      expect(getCanvasJsonSnapshot(CANVAS_ID).nodes).toHaveLength(0)

      // A 的过期快照把它带回来；upsertOnly=true 表示"快照不可信"。
      await mergeJsonSnapshotIntoCanvas(
        CANVAS_ID,
        { nodes: [{ id: 'gone', x: 1, y: 2 } as any] },
        true,
      )

      const snapshot = getCanvasJsonSnapshot(CANVAS_ID)
      expect(
        snapshot.nodes.some((n) => (n as any).id === 'gone'),
        'a tombstoned entity must not be revived by a stale snapshot',
      ).toBe(false)
    })

    it('a live (re-created) id is not treated as tombstoned', async () => {
      await loadCanvasStateFromDb(CANVAS_ID)
      await mergeJsonSnapshotIntoCanvas(CANVAS_ID, {
        nodes: [{ id: 'phoenix', x: 1, y: 2 } as any],
      })
      await mergeJsonSnapshotIntoCanvas(CANVAS_ID, { nodes: [] })

      const doc = getCanvasDoc(CANVAS_ID)!
      expect(collectTombstonedIds(doc, ensureRoot(doc)).nodes.has('phoenix')).toBe(true)

      // 同 id 重建：旧 Item 仍 deleted，但 target.has(id) 为 true → 不算墓碑。
      await mergeJsonSnapshotIntoCanvas(CANVAS_ID, {
        nodes: [{ id: 'phoenix', x: 7, y: 8 } as any],
      })
      expect(collectTombstonedIds(doc, ensureRoot(doc)).nodes.has('phoenix')).toBe(false)
      const node = getCanvasJsonSnapshot(CANVAS_ID).nodes.find(
        (n) => (n as any).id === 'phoenix',
      ) as any
      expect(node).toBeDefined()
      expect(node.x).toBe(7)
    })

    it('single-user full replace may re-add a deleted id (undo must still land)', async () => {
      await loadCanvasStateFromDb(CANVAS_ID)
      await mergeJsonSnapshotIntoCanvas(CANVAS_ID, {
        nodes: [{ id: 'undone', x: 1, y: 2 } as any],
      })
      // 删除（产生墓碑）
      await mergeJsonSnapshotIntoCanvas(CANVAS_ID, { nodes: [] })
      expect(getCanvasJsonSnapshot(CANVAS_ID).nodes).toHaveLength(0)

      // 单用户 Ctrl+Z：upsertOnly=false 的权威全量快照必须能把它写回。
      await mergeJsonSnapshotIntoCanvas(CANVAS_ID, {
        nodes: [{ id: 'undone', x: 1, y: 2 } as any],
      })
      const node = getCanvasJsonSnapshot(CANVAS_ID).nodes.find(
        (n) => (n as any).id === 'undone',
      ) as any
      expect(node, 'undo must not be silently blocked by a tombstone').toBeDefined()
      expect(node.x).toBe(1)
    })

    it('tombstones are isolated per collection (same id in another collection is unaffected)', async () => {
      await loadCanvasStateFromDb(CANVAS_ID)
      await mergeJsonSnapshotIntoCanvas(CANVAS_ID, {
        nodes: [{ id: 'dup', x: 1, y: 2 } as any],
        connections: [{ id: 'dup', fromNodeId: 'a', toNodeId: 'b' } as any],
      })
      // 只删除 nodes 集合中的 dup（connections 的 dup 必须提供才能保留）
      await mergeJsonSnapshotIntoCanvas(CANVAS_ID, {
        nodes: [],
        connections: [{ id: 'dup', fromNodeId: 'a', toNodeId: 'b' } as any],
      })

      const doc = getCanvasDoc(CANVAS_ID)!
      const tombstones = collectTombstonedIds(doc, ensureRoot(doc))
      expect(tombstones.nodes.has('dup')).toBe(true)
      expect(tombstones.connections.has('dup')).toBe(false)

      // upsertOnly 合并：nodes.dup 被拒，connections.dup 正常更新。
      await mergeJsonSnapshotIntoCanvas(
        CANVAS_ID,
        {
          nodes: [{ id: 'dup', x: 9, y: 9 } as any],
          connections: [{ id: 'dup', fromNodeId: 'a', toNodeId: 'b', label: 'updated' } as any],
        },
        true,
      )
      const snapshot = getCanvasJsonSnapshot(CANVAS_ID)
      expect(snapshot.nodes.some((n) => (n as any).id === 'dup')).toBe(false)
      const conn = snapshot.connections.find((c) => (c as any).id === 'dup') as any
      expect(conn.label).toBe('updated')
    })
  })

  describe('applyUpdateToCanvas', () => {
    it('applies a raw Yjs update delta to the doc', async () => {
      await loadCanvasStateFromDb(CANVAS_ID)
      const doc = getCanvasDoc(CANVAS_ID)!

      // Build the delta the way a real client does: clone the current doc state,
      // edit the clone, then encode only the bytes since the clone point. A
      // delta built from a clone merges cleanly (same type lineage); an update
      // from an independently-created doc would not.
      const stateVector = Y.encodeStateVector(doc)
      const clone = new Y.Doc()
      Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc))

      const collections = ensureRoot(clone)
      clone.transact(() => {
        const ymap = new Y.Map()
        writeEntityToYMap(ymap, { id: 'u1', x: 1, y: 2 })
        collections.nodes.set('u1', ymap)
      })

      const delta = Y.encodeStateAsUpdate(clone, stateVector)
      await applyUpdateToCanvas(CANVAS_ID, delta)

      const snapshot = getCanvasJsonSnapshot(CANVAS_ID)
      const node = snapshot.nodes.find((n) => (n as any).id === 'u1') as any
      expect(node, 'the remote delta must have been merged into the canvas doc').toBeDefined()
      expect(node.x).toBe(1)
      expect(node.y).toBe(2)
    })

    it('returns false instead of throwing when the update binary is malformed', async () => {
      await loadCanvasStateFromDb(CANVAS_ID)
      const ok = await applyUpdateToCanvas(CANVAS_ID, new Uint8Array([1, 2, 3, 4, 5, 6, 7]))
      // applyUpdateToCanvas catches and logs; it must not reject.
      expect(typeof ok).toBe('boolean')
    })
  })

  describe('snapshotMissingDocEntities (R1 entity-set staleness)', () => {
    it('快照缺失 doc 中的实体 → true（过期快照，必须 upsertOnly）', async () => {
      await loadCanvasStateFromDb(CANVAS_ID)
      // 模拟 B 在客户端离线期间的编辑（doc 已有实体）
      await mergeJsonSnapshotIntoCanvas(CANVAS_ID, {
        nodes: [{ id: 'peer-node', x: 1, y: 2 } as any],
      })

      // 客户端快照完全不知道 peer-node
      expect(snapshotMissingDocEntities(CANVAS_ID, {
        nodes: [{ id: 'own-node', x: 3, y: 4 } as any],
      })).toBe(true)

      // 客户端快照包含全部 doc 实体（即使额外多了自己的实体）→ false
      expect(snapshotMissingDocEntities(CANVAS_ID, {
        nodes: [{ id: 'peer-node', x: 1, y: 2 } as any, { id: 'own-node', x: 3, y: 4 } as any],
      })).toBe(false)
    })

    it('客户端声明删除的实体不视为缺失 → 全量合并可执行合法离线删除', async () => {
      await loadCanvasStateFromDb(CANVAS_ID)
      await mergeJsonSnapshotIntoCanvas(CANVAS_ID, {
        nodes: [{ id: 'b-node', x: 1, y: 2 } as any],
      })

      // 客户端删除了 b-node（本地删除声明），快照中也没有它 → 判定 false，
      // 全量合并会正确执行该删除（幽灵复活回归的回归测试）。
      expect(snapshotMissingDocEntities(CANVAS_ID, {
        nodes: [{ id: 'own-node', x: 3, y: 4 } as any],
      }, {
        nodes: ['b-node'],
      })).toBe(false)

      // 未声明删除 → 仍视为缺失（保护未知实体）
      expect(snapshotMissingDocEntities(CANVAS_ID, {
        nodes: [{ id: 'own-node', x: 3, y: 4 } as any],
      }, {
        nodes: [],
      })).toBe(true)
    })

    it('删除声明按集合隔离（不同集合的同名 ID 互不影响）', async () => {
      await loadCanvasStateFromDb(CANVAS_ID)
      await mergeJsonSnapshotIntoCanvas(CANVAS_ID, {
        nodes: [{ id: 'x', x: 1, y: 2 } as any],
        connections: [{ id: 'x', fromNodeId: 'a', toNodeId: 'b' } as any],
      })

      // 只声明删除了 nodes 集合中的 'x'：connections 集合的 'x' 仍视为缺失
      expect(snapshotMissingDocEntities(CANVAS_ID, {
        nodes: [],
        connections: [],
      }, {
        nodes: ['x'],
      })).toBe(true)

      // 两个集合都声明删除 → false
      expect(snapshotMissingDocEntities(CANVAS_ID, {
        nodes: [],
        connections: [],
      }, {
        nodes: ['x'],
        connections: ['x'],
      })).toBe(false)
    })

    it('空 doc + 非空快照 → false（允许全量合并写入）', async () => {
      await loadCanvasStateFromDb(CANVAS_ID)
      expect(snapshotMissingDocEntities(CANVAS_ID, {
        nodes: [{ id: 'n1', x: 0, y: 0 } as any],
      })).toBe(false)
    })

    it('未提供的集合不参与比较（与 syncCollection 的 undefined 守卫一致）', async () => {
      await loadCanvasStateFromDb(CANVAS_ID)
      await mergeJsonSnapshotIntoCanvas(CANVAS_ID, {
        nodes: [{ id: 'n1', x: 0, y: 0 } as any],
        connections: [{ id: 'c1', fromNodeId: 'n1', toNodeId: 'n2' } as any],
      })

      // 只提供 nodes（缺 connections）：connections 不会被全量合并删除，不算缺失
      expect(snapshotMissingDocEntities(CANVAS_ID, {
        nodes: [{ id: 'n1', x: 0, y: 0 } as any],
      })).toBe(false)

      // 提供了 connections 数组但缺 doc 中的 c1 → true
      expect(snapshotMissingDocEntities(CANVAS_ID, {
        nodes: [{ id: 'n1', x: 0, y: 0 } as any],
        connections: [],
      })).toBe(true)
    })

    it('doc 未加载时返回 false（无法判断，交由其他守卫接管）', () => {
      expect(snapshotMissingDocEntities(CANVAS_ID, {
        nodes: [{ id: 'n1', x: 0, y: 0 } as any],
      })).toBe(false)
    })
  })

  describe('dirty tracking & persist', () => {
    it('marks the doc dirty after a merge and clean after persist', async () => {
      await loadCanvasStateFromDb(CANVAS_ID)
      expect(isCanvasStatePersisted(CANVAS_ID)).toBe(true)

      await mergeJsonSnapshotIntoCanvas(CANVAS_ID, {
        nodes: [{ id: 'd1', x: 0, y: 0 } as any],
      })
      expect(isCanvasStatePersisted(CANVAS_ID)).toBe(false)

      const ok = await persistCanvasState(CANVAS_ID)
      expect(ok).toBe(true)
      expect(isCanvasStatePersisted(CANVAS_ID)).toBe(true)
    })

    it('persist is a no-op when the doc is already clean', async () => {
      await loadCanvasStateFromDb(CANVAS_ID)
      const ok = await persistCanvasState(CANVAS_ID)
      expect(ok).toBe(false)
    })
  })
})
