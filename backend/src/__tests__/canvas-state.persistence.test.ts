/**
 * canvas-state PERSISTENCE tests — real database, real rows.
 *
 * Why this file exists: an adversarial mutation review found that changing
 * `persistCanvasState`'s WHERE clause from `eq(canvases.id, canvasId)` to
 * `eq(canvases.id, canvasId + 1)` left **36/36 tests green**. Every existing
 * dirty-tracking test mocked `connection.js` with a stub whose
 * `update().set().where()` chain was a `vi.fn()` — the WHERE clause was never
 * evaluated, and no test ever read the `yjs_update` column back to confirm the
 * write landed in the right row. The failure mode is silent cross-canvas data
 * corruption.
 *
 * So this suite runs against the REAL harness database (drizzle over in-memory
 * SQLite), where the WHERE clause actually executes and rows can be read back.
 *
 * Also covers the persist-failure guards the review flagged (B11 corrupt-data
 * refusal, empty-encoding refusal, retry exhaustion) at the same layer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as Y from 'yjs'

vi.mock('../utils/logger.js', () => ({ log: vi.fn(), logError: vi.fn() }))

vi.mock('../database/connection.js', async () => {
  const { installDbMock } = await import('./helpers/integration-harness.js')
  return installDbMock()
})

import {
  createTestDatabase,
  seedCanvas,
  seedProject,
  seedUser,
  setTestEnv,
  readColumn,
  setTestDb,
  type TestDatabase,
} from './helpers/integration-harness.js'
import * as schema from '../database/schema.js'

setTestEnv()

const {
  loadCanvasStateFromDb,
  persistCanvasState,
  removeCanvasState,
  getCanvasJsonSnapshot,
  getCanvasState,
  getCanvasDoc,
  mergeJsonSnapshotIntoCanvas,
  flushPendingPersist,
} = await import('../websocket/canvas-state.js')
const { encodeDocToBase64, jsonSnapshotToDoc } = await import('../websocket/yjs-schema.js')

function readRow(t: TestDatabase, id: number): { yjs_update: string | null } | undefined {
  return t.raw.prepare('SELECT yjs_update FROM canvases WHERE id = ?').get(id) as
    | { yjs_update: string | null }
    | undefined
}

describe('canvas-state persistence (real database rows)', () => {
  let t: TestDatabase
  let canvasA: number
  let canvasB: number

  beforeEach(() => {
    t = createTestDatabase()
    const ownerId = seedUser(t.raw, 'owner@test.com', 'hash', 'Owner')
    const projectId = seedProject(t.raw, ownerId, 'P')
    // Two canvases with DISTINCT persisted content, so a cross-row write is
    // detectable rather than masked by identical payloads.
    canvasA = seedCanvas(t.raw, projectId, 'A', {
      yjsUpdate: encodeDocToBase64(jsonSnapshotToDoc({ nodes: [{ id: 'a-only' }] })),
    })
    canvasB = seedCanvas(t.raw, projectId, 'B', {
      yjsUpdate: encodeDocToBase64(jsonSnapshotToDoc({ nodes: [{ id: 'b-only' }] })),
    })
  })

  afterEach(() => {
    removeCanvasState(canvasA)
    removeCanvasState(canvasB)
  })

  it('persists a DIRTY canvas A into row A — and leaves row B untouched', async () => {
    const before = readRow(t, canvasB)!.yjs_update

    await loadCanvasStateFromDb(canvasA)
    // R1 mutation review: a freshly loaded doc is clean, so persist would
    // short-circuit as a no-op and the row-A assertion below would pass on the
    // seeded bytes without the UPDATE ever running. Dirty the doc with a real
    // edit so the write path (UPDATE ... WHERE canvases.id = canvasId) MUST
    // execute for the test to pass.
    await mergeJsonSnapshotIntoCanvas(canvasA, { nodes: [{ id: 'flagship-edit', x: 7, y: 7 }] })
    await persistCanvasState(canvasA)

    // Row A must now hold exactly the encoded in-memory doc (with the edit).
    const doc = getCanvasDoc(canvasA)!
    const expected = encodeDocToBase64(doc)
    expect(readRow(t, canvasA)!.yjs_update).toBe(expected)
    // And the encoded doc really carries the edit, not just the seed bytes.
    const rowA = Buffer.from(readRow(t, canvasA)!.yjs_update!, 'base64').toString('latin1')
    expect(rowA).toContain('flagship-edit')

    // The critical assertion the old suite could never make: the write must NOT
    // have landed in any other row.
    expect(readRow(t, canvasB)!.yjs_update).toBe(before)
  })

  it('persists canvas B into row B independently', async () => {
    await loadCanvasStateFromDb(canvasB)
    await persistCanvasState(canvasB)

    const docB = (await import('../websocket/canvas-state.js')).getCanvasDoc(canvasB)!
    expect(readRow(t, canvasB)!.yjs_update).toBe(encodeDocToBase64(docB))

    // Row A must retain its own distinct content (a-only, not b-only).
    // yjs_update is base64 of the Yjs binary, so decode before searching — the
    // entity ids are stored as UTF-8 inside the binary.
    const rowA = Buffer.from(readRow(t, canvasA)!.yjs_update!, 'base64').toString('latin1')
    expect(rowA).toContain('a-only')
    expect(rowA).not.toContain('b-only')
  })

  it('persists only after an edit marks the doc dirty (clean doc = no-op)', async () => {
    const before = readRow(t, canvasA)!.yjs_update
    const state = await loadCanvasStateFromDb(canvasA)
    expect(state.loaded).toBe(true)

    // Freshly loaded == matches the persisted snapshot; persist must not rewrite.
    await persistCanvasState(canvasA)
    expect(readRow(t, canvasA)!.yjs_update).toBe(before)
  })

  it('refuses to persist an EMPTY doc over real data (data-loss guard)', async () => {
    await loadCanvasStateFromDb(canvasA)

    // Simulate the doc becoming empty/corrupt in memory (as after a bad apply).
    const state = (await import('../websocket/canvas-state.js')).getCanvasState(canvasA)!
    const emptyDoc = new Y.Doc()
    Object.defineProperty(state, 'doc', { value: emptyDoc, configurable: true })

    const before = readRow(t, canvasA)!.yjs_update
    const ok = await persistCanvasState(canvasA)

    // The guard must refuse, and the real row must survive untouched.
    expect(ok).toBe(false)
    expect(readRow(t, canvasA)!.yjs_update).toBe(before)
  }, 10000)

  it('silently swallows the write when the canvas row was deleted mid-session', async () => {
    // Dirty the doc first, so persist actually attempts the UPDATE.
    await loadCanvasStateFromDb(canvasA)
    t.raw.prepare('DELETE FROM canvases WHERE id = ?').run(canvasA)

    // Make the doc dirty so the persist is not short-circuited as a no-op.
    const { mergeJsonSnapshotIntoCanvas } = await import('../websocket/canvas-state.js')
    await mergeJsonSnapshotIntoCanvas(canvasA, { nodes: [{ id: 'dirty', x: 1, y: 1 }] })
    const beforeB = readRow(t, canvasB)!.yjs_update

    // The UPDATE matches 0 rows: drizzle resolves without error, and no other
    // row may be affected. Documents the current swallow behaviour.
    const ok = await persistCanvasState(canvasA)
    expect(ok).toBe(true)
    expect(readRow(t, canvasB)!.yjs_update).toBe(beforeB)
  })

  it('keeps two canvases\u2019 in-memory docs independent', async () => {
    const stateA = await loadCanvasStateFromDb(canvasA)
    const stateB = await loadCanvasStateFromDb(canvasB)

    const snapA = getCanvasJsonSnapshot(canvasA)
    const snapB = getCanvasJsonSnapshot(canvasB)

    expect(snapA.nodes.map((n: any) => n.id)).toEqual(['a-only'])
    expect(snapB.nodes.map((n: any) => n.id)).toEqual(['b-only'])
    expect(stateA.doc).not.toBe(stateB.doc)
  })
})

describe('canvas-state corrupt-data guard (B11)', () => {
  let t: TestDatabase
  let projectId: number
  let canvasId: number

  beforeEach(() => {
    t = createTestDatabase()
    const ownerId = seedUser(t.raw, 'owner2@test.com', 'hash', 'Owner2')
    projectId = seedProject(t.raw, ownerId, 'P2')
  })

  afterEach(() => {
    removeCanvasState(canvasId)
  })

  it('throws on a corrupt yjs_update column instead of serving an empty doc', async () => {
    // B11: an undecodable authoritative column must fail loudly. Serving an
    // empty doc would let a client edit + persist it, destroying real data.
    canvasId = seedCanvas(t.raw, projectId, 'Corrupt', { yjsUpdate: 'not-valid-yjs-base64!!' })

    await expect(loadCanvasStateFromDb(canvasId)).rejects.toThrow(/canvas/i)
  })

  it('treats a NULL yjs_update with a legacy yjs_data fallback as loadable', async () => {
    const legacy = Buffer.from(
      JSON.stringify({ nodes: [{ id: 'legacy-node', x: 1, y: 2 }] }),
      'utf-8',
    ).toString('base64')
    canvasId = seedCanvas(t.raw, projectId, 'Legacy', { yjsUpdate: null })
    t.raw.prepare('UPDATE canvases SET yjs_data = ? WHERE id = ?').run(legacy, canvasId)

    const state = await loadCanvasStateFromDb(canvasId)
    expect(state.loaded).toBe(true)
    const snap = getCanvasJsonSnapshot(canvasId)
    expect(snap.nodes.some((n: any) => n.id === 'legacy-node')).toBe(true)
  })
})

describe('canvas-state persist-failure paths (real database rows)', () => {
  let t: TestDatabase
  let projectId: number
  let canvasA: number
  let canvasB: number

  /**
   * A drizzle instance whose `update` throws while everything else is
   * forwarded to the real one. This simulates the DB failing mid-persist
   * (connection lost, disk full, …) while keeping the database readable, so
   * the test can prove afterwards that no row was corrupted.
   */
  function makeUpdateThrowingDb(realDb: BetterSQLite3Database<typeof schema>) {
    return new Proxy(realDb, {
      get(target, prop) {
        if (prop === 'update') {
          return () => {
            throw new Error('simulated db failure')
          }
        }
        return Reflect.get(target, prop, target)
      },
    }) as unknown as BetterSQLite3Database<typeof schema>
  }

  beforeEach(() => {
    t = createTestDatabase()
    const ownerId = seedUser(t.raw, 'fail-owner@test.com', 'hash', 'FailOwner')
    projectId = seedProject(t.raw, ownerId, 'PF')
    canvasA = seedCanvas(t.raw, projectId, 'FA', {
      yjsUpdate: encodeDocToBase64(jsonSnapshotToDoc({ nodes: [{ id: 'fail-a' }] })),
    })
    canvasB = seedCanvas(t.raw, projectId, 'FB', {
      yjsUpdate: encodeDocToBase64(jsonSnapshotToDoc({ nodes: [{ id: 'fail-b' }] })),
    })
  })

  afterEach(() => {
    removeCanvasState(canvasA)
    removeCanvasState(canvasB)
    // Restore the healthy db in case a test swapped in a throwing one — the
    // mocked connection module's holder is shared across this whole file.
    setTestDb(t.db)
  })

  it('returns false without throwing when the UPDATE fails, sets persistError, and leaves both rows intact', async () => {
    const beforeA = readColumn(t.raw, 'SELECT yjs_update FROM canvases WHERE id = ?', canvasA)
    const beforeB = readColumn(t.raw, 'SELECT yjs_update FROM canvases WHERE id = ?', canvasB)

    await loadCanvasStateFromDb(canvasA)
    // Dirty the doc, then cancel the debounced background persist so the
    // manual calls below are the only writers (deterministic retry timing).
    await mergeJsonSnapshotIntoCanvas(canvasA, { nodes: [{ id: 'extra', x: 1, y: 1 }] })
    flushPendingPersist(canvasA)

    setTestDb(makeUpdateThrowingDb(t.db))

    // Attempt 1: exhausts the retry budget, reports failure via the return
    // value and via state.persistError — and never throws.
    const state = getCanvasState(canvasA)!
    await expect(persistCanvasState(canvasA)).resolves.toBe(false)
    // The finally block reset the in-flight flag even though the write failed.
    expect(state.isPersisting).toBe(false)
    expect(state.persistError).not.toBeNull()
    expect(state.persistError!.message).toContain('simulated db failure')
    expect(state.persistError!.attempts).toBeGreaterThanOrEqual(1)

    // Neither row was touched: the failed writer must not corrupt the DB.
    expect(readColumn(t.raw, 'SELECT yjs_update FROM canvases WHERE id = ?', canvasA)).toBe(beforeA)
    expect(readColumn(t.raw, 'SELECT yjs_update FROM canvases WHERE id = ?', canvasB)).toBe(beforeB)

    // Attempt 2 with the DB still broken: may be called again, still no throw.
    await expect(persistCanvasState(canvasA)).resolves.toBe(false)
    expect(state.isPersisting).toBe(false)

    // Attempt 3 with the real DB back: the state is not stuck — the write lands,
    // persistError clears, and the row holds exactly the in-memory doc.
    setTestDb(t.db)
    await expect(persistCanvasState(canvasA)).resolves.toBe(true)
    expect(state.persistError).toBeNull()
    expect(state.isPersisting).toBe(false)
    expect(readColumn(t.raw, 'SELECT yjs_update FROM canvases WHERE id = ?', canvasA)).toBe(
      encodeDocToBase64(getCanvasDoc(canvasA)!),
    )

    // And canvas B's row still holds its own distinct content.
    const rowB = Buffer.from(
      readColumn<string>(t.raw, 'SELECT yjs_update FROM canvases WHERE id = ?', canvasB)!,
      'base64',
    ).toString('latin1')
    expect(rowB).toContain('fail-b')
    expect(rowB).not.toContain('extra')
  }, 20000)

  it('isPersisting never stays stuck: persistCanvasState is callable again right after a failure', async () => {
    await loadCanvasStateFromDb(canvasA)
    await mergeJsonSnapshotIntoCanvas(canvasA, { nodes: [{ id: 'dirty-again', x: 2, y: 2 }] })
    flushPendingPersist(canvasA)

    setTestDb(makeUpdateThrowingDb(t.db))
    await expect(persistCanvasState(canvasA)).resolves.toBe(false)

    // If isPersisting had not been reset in the finally block, this call would
    // short-circuit to false without even attempting the UPDATE.
    setTestDb(t.db)
    await expect(persistCanvasState(canvasA)).resolves.toBe(true)
    expect(getCanvasState(canvasA)!.lastPersistedUpdateCount).toBe(
      getCanvasState(canvasA)!.lastSeenUpdateCount,
    )
  }, 20000)
})
