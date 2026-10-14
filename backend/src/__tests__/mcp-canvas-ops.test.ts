/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * MCP canvas-ops tests.
 *
 * These cover the server-side entity layer that replaced the frontend
 * `aiTools.ts`: entity-scoped upsert/delete against the authoritative Yjs doc,
 * and the MCP-scoped undo manager.
 *
 * The key behavioural guarantees asserted here:
 *   - a write touches ONLY the named entities (unlike the whole-collection
 *     replace used by legacy REST snapshot clients);
 *   - writes carry MCP_ORIGIN, which is what makes undo trackable and keeps
 *     agent edits out of other origins' undo stacks;
 *   - deleting a node does not silently take connections with it (the tool layer
 *     performs that cascade explicitly).
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
  and: vi.fn(() => true),
  sql: vi.fn(),
}))

import {
  MCP_ORIGIN,
  deleteEntities,
  getCanvasSnapshot,
  getUndoManager,
  upsertEntities,
} from '../mcp/canvas-ops.js'
import { removeCanvasState } from '../websocket/canvas-state.js'
import { encodeDocToBase64, jsonSnapshotToDoc } from '../websocket/yjs-schema.js'

const CANVAS_ID = 7

describe('MCP canvas-ops', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockCanvasRow)) delete (mockCanvasRow as any)[k]
    removeCanvasState(CANVAS_ID)
  })

  afterEach(() => {
    removeCanvasState(CANVAS_ID)
  })

  describe('upsertEntities', () => {
    it('inserts new entities and reports the ids written', async () => {
      const result = await upsertEntities(CANVAS_ID, {
        nodes: [{ id: 'n1', title: 'A', x: 0, y: 0 }],
        connections: [{ id: 'c1', fromNodeId: 'n1', toNodeId: 'n2' }],
      })

      expect(result.written.nodes).toEqual(['n1'])
      expect(result.written.connections).toEqual(['c1'])

      const snapshot = await getCanvasSnapshot(CANVAS_ID)
      expect(snapshot.nodes).toHaveLength(1)
      expect(snapshot.connections).toHaveLength(1)
      expect((snapshot.nodes[0] as any).title).toBe('A')
    })

    it('field-merges into an existing entity instead of replacing it', async () => {
      await upsertEntities(CANVAS_ID, {
        nodes: [{ id: 'n1', title: 'Original', content: 'keep me', x: 5 }],
      })
      await upsertEntities(CANVAS_ID, { nodes: [{ id: 'n1', title: 'Renamed' }] })

      const snapshot = await getCanvasSnapshot(CANVAS_ID)
      const node = snapshot.nodes.find((n) => n.id === 'n1') as any
      expect(node.title).toBe('Renamed')
      // Fields absent from the second call must survive.
      expect(node.content).toBe('keep me')
      expect(node.x).toBe(5)
    })

    it('skips entities without a usable string id, counting them', async () => {
      const result = await upsertEntities(CANVAS_ID, {
        nodes: [
          { id: 'good', title: 'ok' },
          { title: 'no id' } as any,
          { id: '', title: 'empty id' } as any,
          null as any,
        ],
      })

      expect(result.written.nodes).toEqual(['good'])
      expect(result.skipped.nodes).toBe(3)
      const snapshot = await getCanvasSnapshot(CANVAS_ID)
      expect(snapshot.nodes).toHaveLength(1)
    })

    it('preserves array fields (group.nodeIds) across a round trip', async () => {
      await upsertEntities(CANVAS_ID, {
        groups: [{ id: 'g1', name: 'G', nodeIds: ['n1', 'n2', 'n3'] }],
      })
      const snapshot = await getCanvasSnapshot(CANVAS_ID)
      const group = snapshot.groups.find((g) => g.id === 'g1') as any
      expect(group.nodeIds).toEqual(['n1', 'n2', 'n3'])
    })

    it('touches only the named entities, leaving others intact', async () => {
      await upsertEntities(CANVAS_ID, {
        nodes: [
          { id: 'keep1', title: 'keep1' },
          { id: 'keep2', title: 'keep2' },
        ],
      })
      await upsertEntities(CANVAS_ID, { nodes: [{ id: 'new', title: 'new' }] })

      const snapshot = await getCanvasSnapshot(CANVAS_ID)
      expect(snapshot.nodes.map((n) => n.id).sort()).toEqual(['keep1', 'keep2', 'new'])
    })
  })

  describe('deleteEntities', () => {
    it('deletes named entities and reports missing ones separately', async () => {
      await upsertEntities(CANVAS_ID, {
        nodes: [{ id: 'n1' }, { id: 'n2' }],
      })

      const result = await deleteEntities(CANVAS_ID, {
        nodeIds: ['n1', 'does-not-exist'],
      })

      expect(result.deleted.nodes).toEqual(['n1'])
      expect(result.missing.nodes).toEqual(['does-not-exist'])
      const snapshot = await getCanvasSnapshot(CANVAS_ID)
      expect(snapshot.nodes.map((n) => n.id)).toEqual(['n2'])
    })

    it('does NOT cascade a node delete to its connections', async () => {
      // The cascade is the tool layer's job (deleteNode); canvas-ops must stay
      // entity-scoped so a caller can delete a node but keep/re-point edges.
      await upsertEntities(CANVAS_ID, {
        nodes: [{ id: 'n1' }, { id: 'n2' }],
        connections: [{ id: 'c1', fromNodeId: 'n1', toNodeId: 'n2' }],
      })

      await deleteEntities(CANVAS_ID, { nodeIds: ['n1'] })

      const snapshot = await getCanvasSnapshot(CANVAS_ID)
      expect(snapshot.nodes.map((n) => n.id)).toEqual(['n2'])
      expect(snapshot.connections).toHaveLength(1)
    })

    it('deletes across collections in one call', async () => {
      await upsertEntities(CANVAS_ID, {
        nodes: [{ id: 'n1' }],
        groups: [{ id: 'g1' }],
        domains: [{ id: 'd1' }],
        connections: [{ id: 'c1' }],
      })

      const result = await deleteEntities(CANVAS_ID, {
        nodeIds: ['n1'],
        groupIds: ['g1'],
        domainIds: ['d1'],
        connectionIds: ['c1'],
      })

      expect(result.deleted.nodes).toEqual(['n1'])
      expect(result.deleted.groups).toEqual(['g1'])
      expect(result.deleted.domains).toEqual(['d1'])
      expect(result.deleted.connections).toEqual(['c1'])
      const snapshot = await getCanvasSnapshot(CANVAS_ID)
      expect(snapshot.nodes).toHaveLength(0)
      expect(snapshot.groups).toHaveLength(0)
      expect(snapshot.domains).toHaveLength(0)
      expect(snapshot.connections).toHaveLength(0)
    })
  })

  describe('getUndoManager', () => {
    it('tracks MCP-origin writes and undoes them', async () => {
      const state = await import('../websocket/canvas-state.js').then((m) =>
        m.loadCanvasStateFromDb(CANVAS_ID),
      )
      const manager = getUndoManager(state.doc)

      await upsertEntities(CANVAS_ID, { nodes: [{ id: 'n1', title: 'A' }] })
      expect(manager.canUndo()).toBe(true)

      manager.undo()
      const snapshot = await getCanvasSnapshot(CANVAS_ID)
      expect(snapshot.nodes).toHaveLength(0)

      manager.redo()
      const redone = await getCanvasSnapshot(CANVAS_ID)
      expect(redone.nodes).toHaveLength(1)
    })

    it('ignores writes from other origins, so it never reverts peer edits', async () => {
      const { loadCanvasStateFromDb } = await import('../websocket/canvas-state.js')
      const state = await loadCanvasStateFromDb(CANVAS_ID)
      const manager = getUndoManager(state.doc)

      // A remote edit (a human collaborator) uses a different origin.
      const { ensureRoot } = await import('../websocket/yjs-schema.js')
      const { nodes } = ensureRoot(state.doc)
      state.doc.transact(() => {
        const ymap = new Y.Map<unknown>()
        ymap.set('title', 'human edit')
        nodes.set('human-1', ymap)
      }, 'some-other-origin')

      expect(manager.canUndo()).toBe(false)
    })

    it('returns the same manager for the same doc and a fresh one after a doc swap', async () => {
      const { loadCanvasStateFromDb } = await import('../websocket/canvas-state.js')
      const state = await loadCanvasStateFromDb(CANVAS_ID)
      const first = getUndoManager(state.doc)
      expect(getUndoManager(state.doc)).toBe(first)

      // Simulate a reconnect swapping in a new doc for the same canvas.
      removeCanvasState(CANVAS_ID)
      const second = await loadCanvasStateFromDb(CANVAS_ID)
      expect(getUndoManager(second.doc)).not.toBe(first)
    })
  })

  describe('MCP_ORIGIN', () => {
    it('is a frozen object identity, not a bare string', () => {
      expect(Object.isFrozen(MCP_ORIGIN)).toBe(true)
      expect(MCP_ORIGIN).toEqual({ source: 'mcp-server' })
    })
  })

  describe('getCanvasSnapshot', () => {
    it('reads a doc seeded from the yjs_update column', async () => {
      const seed = jsonSnapshotToDoc({
        nodes: [{ id: 'seeded', title: 'from db' } as any],
      })
      mockCanvasRow.yjsUpdate = encodeDocToBase64(seed)

      const snapshot = await getCanvasSnapshot(CANVAS_ID)
      expect(snapshot.nodes).toHaveLength(1)
      expect((snapshot.nodes[0] as any).id).toBe('seeded')
    })
  })
})
