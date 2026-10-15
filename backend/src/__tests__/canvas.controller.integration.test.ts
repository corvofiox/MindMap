/**
 * Canvas controller integration tests.
 *
 * These exercise the REAL `canvasRouter` mounted on a real Express app against a
 * real in-memory SQLite database. That matters here specifically: the previous
 * version of this file defined its own inline routes and asserted on unawaited
 * supertest objects, so injecting a mutation that made the real list route always
 * return 500 still left all 25 tests passing. Every assertion below reads an
 * actual HTTP response or an actual database row.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import type express from 'express'
import Database from 'better-sqlite3'

vi.mock('../utils/logger.js', () => ({ log: vi.fn(), logError: vi.fn() }))

vi.mock('../middleware/rateLimit.middleware.js', () => ({
  apiLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  authLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}))

vi.mock('../database/connection.js', async () => {
  const { installDbMock } = await import('./helpers/integration-harness.js')
  return installDbMock()
})

// The websocket layer is not under test and importing it opens real sockets.
vi.mock('../websocket/index.js', () => ({
  getCanvasActiveUsers: vi.fn(() => []),
  closeRoom: vi.fn(),
  kickUserFromRoom: vi.fn(),
  shouldUpsertOnlyForSnapshot: vi.fn(() => false),
}))

import {
  authHeader,
  buildApp,
  countRows,
  createTestDatabase,
  readColumn,
  seedCanvas,
  seedFolder,
  seedMember,
  seedProject,
  seedUser,
  setTestEnv,
  type TestDatabase,
} from './helpers/integration-harness.js'

// canvas-state.ts is exercised FOR REAL here (the controller drives it); the test
// only uses a few of its siblings' exports as fixtures: flushing the debounced Yjs
// persistence so `yjs_update` row assertions are deterministic, dropping per-test
// in-memory docs (canvas ids restart at 1 in every fresh database), and decoding
// a persisted doc to read back live entities.
import { flushAllCanvasStates, getCanvasState, getCanvasStatesSnapshot, removeCanvasState } from '../websocket/canvas-state.js'
import { decodeBase64ToDoc, docToJsonSnapshot } from '../websocket/yjs-schema.js'
// Mocked at the top of this file; imported to assert room teardown side effects.
import { closeRoom } from '../websocket/index.js'

setTestEnv()

const { canvasRouter } = await import('../controllers/canvas.controller.js')

/**
 * Read the canvas row's `yjs_update` column and decode it so assertions can look
 * for entity ids inside the serialized Yjs doc (ids are stored verbatim in the
 * update binary, so a latin1 decode exposes them as plain substrings). An absent
 * column fails the test instead of letting `toContain` pass vacuously.
 *
 * NOTE: byte-level scanning can only prove PRESENCE — Yjs tombstones keep a
 * deleted Y.Map key's bytes in the encoded update. Absence of an entity must be
 * asserted through readDocNodeIds, which decodes into a real Y.Doc.
 */
function readDocText(database: TestDatabase, canvasId: number): string {
  const raw = readColumn<string>(
    database.raw,
    'SELECT yjs_update FROM canvases WHERE id = ?',
    canvasId,
  )
  expect(typeof raw).toBe('string')
  return Buffer.from(raw as string, 'base64').toString('latin1')
}

describe('canvas.controller (integration, real router + real DB)', () => {
  let app: express.Express
  let t: TestDatabase
  let ownerId: number
  let memberId: number
  let outsiderId: number
  let projectId: number

  beforeEach(() => {
    // The real canvas-state module keeps docs in a module-level map while canvas
    // ids restart at 1 in every fresh in-memory database — drop stale docs so
    // each test loads from its own database, and no stale debounced persist can
    // write into it either.
    for (const stateId of Array.from(getCanvasStatesSnapshot().keys())) {
      removeCanvasState(stateId)
    }
    vi.mocked(closeRoom).mockClear()

    t = createTestDatabase()
    app = buildApp('/api/canvases', canvasRouter)

    ownerId = seedUser(t.raw, 'owner@test.com', 'hash', 'Owner')
    memberId = seedUser(t.raw, 'member@test.com', 'hash', 'Member')
    outsiderId = seedUser(t.raw, 'outsider@test.com', 'hash', 'Outsider')
    projectId = seedProject(t.raw, ownerId, 'P')
    seedMember(t.raw, projectId, memberId, 'editor')
  })

  describe('GET /:projectId — list canvases', () => {
    it('returns the project\u2019s canvases for the owner', async () => {
      seedCanvas(t.raw, projectId, 'Alpha')
      seedCanvas(t.raw, projectId, 'Beta')

      const res = await supertest(app).get(`/api/canvases/${projectId}`).set(authHeader(ownerId))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data).toHaveLength(2)
      expect(res.body.data.map((c: { name: string }) => c.name).sort()).toEqual(['Alpha', 'Beta'])
    })

    it('returns an empty array when the project has no canvases', async () => {
      const res = await supertest(app).get(`/api/canvases/${projectId}`).set(authHeader(ownerId))
      expect(res.status).toBe(200)
      expect(res.body.data).toEqual([])
    })

    it('allows a project member (not just the owner)', async () => {
      seedCanvas(t.raw, projectId, 'Shared')
      const res = await supertest(app).get(`/api/canvases/${projectId}`).set(authHeader(memberId))
      expect(res.status).toBe(200)
      expect(res.body.data).toHaveLength(1)
    })

    it('rejects an unauthenticated request with 401', async () => {
      const res = await supertest(app).get(`/api/canvases/${projectId}`)
      expect(res.status).toBe(401)
      expect(res.body.success).toBe(false)
    })

    it('forbids a non-member from reading the project\u2019s canvases', async () => {
      const res = await supertest(app).get(`/api/canvases/${projectId}`).set(authHeader(outsiderId))
      expect([403, 404]).toContain(res.status)
      expect(res.body.success).toBe(false)
    })

    it('returns 400 for a non-numeric project id', async () => {
      const res = await supertest(app).get('/api/canvases/not-a-number').set(authHeader(ownerId))
      expect(res.status).toBe(400)
    })

    it('omits the heavy yjsUpdate column from the list payload', async () => {
      seedCanvas(t.raw, projectId, 'Big', { yjsUpdate: 'AAAA' })
      const res = await supertest(app).get(`/api/canvases/${projectId}`).set(authHeader(ownerId))
      expect(res.status).toBe(200)
      expect(res.body.data[0].yjsUpdate).toBeUndefined()
    })
  })

  describe('GET /detail/:id — canvas detail', () => {
    it('returns the canvas with its yjs data for the owner', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'Detail', { yjsUpdate: 'QUJD' })
      const res = await supertest(app).get(`/api/canvases/detail/${canvasId}`).set(authHeader(ownerId))

      expect(res.status).toBe(200)
      expect(res.body.data.id).toBe(canvasId)
      expect(res.body.data.name).toBe('Detail')
      expect(res.body.data.yjsUpdate).toBe('QUJD')
    })

    it('returns 404 for a canvas that does not exist', async () => {
      const res = await supertest(app).get('/api/canvases/detail/999999').set(authHeader(ownerId))
      expect(res.status).toBe(404)
    })

    it('returns 400 for a non-numeric canvas id', async () => {
      const res = await supertest(app).get('/api/canvases/detail/abc').set(authHeader(ownerId))
      expect(res.status).toBe(400)
    })

    it('denies a non-member access to the detail payload (IDOR guard)', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'Private', { yjsUpdate: 'QUJD' })
      const res = await supertest(app)
        .get(`/api/canvases/detail/${canvasId}`)
        .set(authHeader(outsiderId))
      expect([403, 404]).toContain(res.status)
      // The full yjs blob must not leak.
      expect(JSON.stringify(res.body)).not.toContain('QUJD')
    })
  })

  describe('POST /:projectId — create canvas', () => {
    it('creates a canvas for the project owner and persists it', async () => {
      const res = await supertest(app)
        .post(`/api/canvases/${projectId}`)
        .set(authHeader(ownerId))
        .send({ name: 'New Canvas' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.name).toBe('New Canvas')
      expect(countRows(t.raw, 'canvases', 'project_id = ?', projectId)).toBe(1)
    })

    it('rejects canvas creation by a non-member', async () => {
      const res = await supertest(app)
        .post(`/api/canvases/${projectId}`)
        .set(authHeader(outsiderId))
        .send({ name: 'Sneaky' })

      expect([403, 404]).toContain(res.status)
      expect(countRows(t.raw, 'canvases')).toBe(0)
    })

    it('rejects an unauthenticated create', async () => {
      const res = await supertest(app).post(`/api/canvases/${projectId}`).send({ name: 'X' })
      expect(res.status).toBe(401)
      expect(countRows(t.raw, 'canvases')).toBe(0)
    })
  })

  describe('PUT /:id — update canvas', () => {
    it('renames the canvas for the owner', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'Before')
      const res = await supertest(app)
        .put(`/api/canvases/${canvasId}`)
        .set(authHeader(ownerId))
        .send({ name: 'After' })

      expect(res.status).toBe(200)
      expect(readColumn<string>(t.raw, 'SELECT name FROM canvases WHERE id = ?', canvasId)).toBe(
        'After',
      )
    })

    it('returns 400 for a non-numeric id', async () => {
      const res = await supertest(app).put('/api/canvases/xyz').set(authHeader(ownerId)).send({ name: 'N' })
      expect(res.status).toBe(400)
    })

    it('does not let a non-member update the canvas', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'Untouched')
      const res = await supertest(app)
        .put(`/api/canvases/${canvasId}`)
        .set(authHeader(outsiderId))
        .send({ name: 'Hijacked' })

      expect([403, 404]).toContain(res.status)
      expect(readColumn<string>(t.raw, 'SELECT name FROM canvases WHERE id = ?', canvasId)).toBe(
        'Untouched',
      )
    })
  })

  describe('DELETE /:id — delete canvas', () => {
    it('deletes the canvas and its row is gone', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'Doomed')
      const res = await supertest(app).delete(`/api/canvases/${canvasId}`).set(authHeader(ownerId))

      expect(res.status).toBe(200)
      expect(countRows(t.raw, 'canvases', 'id = ?', canvasId)).toBe(0)
    })

    it('refuses deletion by a non-member and keeps the row', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'Kept')
      const res = await supertest(app).delete(`/api/canvases/${canvasId}`).set(authHeader(outsiderId))

      expect([403, 404]).toContain(res.status)
      expect(countRows(t.raw, 'canvases', 'id = ?', canvasId)).toBe(1)
    })
  })

  describe('POST /:id/data — save canvas snapshot', () => {
    it('accepts a JSON node snapshot from the owner', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'Snapshot')
      const res = await supertest(app)
        .post(`/api/canvases/${canvasId}/data`)
        .set(authHeader(ownerId))
        .send({ nodes: [{ id: 'n1', title: 'A', x: 1, y: 2 }] })

      expect([200, 201]).toContain(res.status)
      expect(res.body.success).toBe(true)
    })

    it('returns 400 for a non-numeric canvas id', async () => {
      const res = await supertest(app)
        .post('/api/canvases/nope/data')
        .set(authHeader(ownerId))
        .send({ nodes: [] })
      expect(res.status).toBe(400)
    })

    it('rejects a snapshot from a non-member', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'Guarded')
      const res = await supertest(app)
        .post(`/api/canvases/${canvasId}/data`)
        .set(authHeader(outsiderId))
        .send({ nodes: [{ id: 'evil', title: 'E' }] })

      expect([403, 404]).toContain(res.status)
    })
  })

  describe('PUT /:id — version-checked thumbnail branch (optimistic lock)', () => {
    it('writes the thumbnail when clientVersion is at least the current row version', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'Thumb')
      t.raw.prepare('UPDATE canvases SET thumbnail = ? WHERE id = ?').run('old-thumb', canvasId)
      const rowVersion = Number(
        readColumn<number>(t.raw, 'SELECT updated_at FROM canvases WHERE id = ?', canvasId),
      )

      const res = await supertest(app)
        .put(`/api/canvases/${canvasId}`)
        .set(authHeader(ownerId))
        .send({ thumbnail: 'new-thumb-data', clientVersion: rowVersion + 1000 })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      // The optimistic lock let the write through: the row's thumbnail changed.
      expect(
        readColumn<string>(t.raw, 'SELECT thumbnail FROM canvases WHERE id = ?', canvasId),
      ).toBe('new-thumb-data')
    })

    it('returns 409 and keeps the old thumbnail when clientVersion is stale', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'Thumb')
      t.raw.prepare('UPDATE canvases SET thumbnail = ? WHERE id = ?').run('old-thumb', canvasId)

      // Bump the row's optimistic-lock version with a rename first, then pretend
      // the client generated its thumbnail from the pre-rename state.
      await supertest(app)
        .put(`/api/canvases/${canvasId}`)
        .set(authHeader(ownerId))
        .send({ name: 'Renamed' })
      const bumped = Number(
        readColumn<number>(t.raw, 'SELECT updated_at FROM canvases WHERE id = ?', canvasId),
      )
      expect(bumped).toBeGreaterThan(0)

      const res = await supertest(app)
        .put(`/api/canvases/${canvasId}`)
        .set(authHeader(ownerId))
        .send({ thumbnail: 'stale-thumb-data', clientVersion: bumped - 1000 })

      expect(res.status).toBe(409)
      expect(res.body.success).toBe(false)
      expect(res.body.error).toContain('缩略图版本过期')
      // An expired thumbnail must be dropped, not written over the newer row.
      expect(
        readColumn<string>(t.raw, 'SELECT thumbnail FROM canvases WHERE id = ?', canvasId),
      ).toBe('old-thumb')
    })

    it('returns 400 when clientVersion is present but not a number', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'Thumb')

      const res = await supertest(app)
        .put(`/api/canvases/${canvasId}`)
        .set(authHeader(ownerId))
        .send({ thumbnail: 'thumb', clientVersion: 'abc' })

      expect(res.status).toBe(400)
      expect(res.body.error).toContain('缩略图更新必须携带数字类型')
      expect(readColumn(t.raw, 'SELECT thumbnail FROM canvases WHERE id = ?', canvasId)).toBeNull()
    })

    it('merges yjsData carried alongside the thumbnail into the Yjs doc', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'Thumb')
      const yjsData = Buffer.from(
        JSON.stringify({ nodes: [{ id: 'thumb-node-1', title: 'N' }] }),
        'utf8',
      ).toString('base64')
      const rowVersion = Number(
        readColumn<number>(t.raw, 'SELECT updated_at FROM canvases WHERE id = ?', canvasId),
      )

      const res = await supertest(app)
        .put(`/api/canvases/${canvasId}`)
        .set(authHeader(ownerId))
        .send({ thumbnail: 'with-node-thumb', clientVersion: rowVersion + 1000, yjsData })

      expect(res.status).toBe(200)
      // The Yjs doc is persisted asynchronously (100ms debounce); force the
      // flush so the yjs_update column reflects the merge before reading it.
      await flushAllCanvasStates()
      expect(readDocText(t, canvasId)).toContain('thumb-node-1')
      expect(
        readColumn<string>(t.raw, 'SELECT thumbnail FROM canvases WHERE id = ?', canvasId),
      ).toBe('with-node-thumb')
    })

    it('returns 400 for corrupt or non-object yjsData in the thumbnail branch', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'Thumb')

      const corrupt = await supertest(app)
        .put(`/api/canvases/${canvasId}`)
        .set(authHeader(ownerId))
        .send({
          thumbnail: 'thumb',
          clientVersion: Date.now(),
          yjsData: Buffer.from('not json', 'utf8').toString('base64'),
        })
      expect(corrupt.status).toBe(400)
      expect(corrupt.body.error).toContain('invalid or corrupt yjsData')

      const nonObject = await supertest(app)
        .put(`/api/canvases/${canvasId}`)
        .set(authHeader(ownerId))
        .send({
          thumbnail: 'thumb',
          clientVersion: Date.now(),
          yjsData: Buffer.from('[1,2]', 'utf8').toString('base64'),
        })
      expect(nonObject.status).toBe(400)
      expect(nonObject.body.error).toContain('invalid or corrupt yjsData')

      expect(readColumn(t.raw, 'SELECT thumbnail FROM canvases WHERE id = ?', canvasId)).toBeNull()
    })

    it('falls back to the unlocked main branch when only a thumbnail is sent', async () => {
      // Collaborative clients deliberately omit clientVersion ("last thumbnail
      // wins"); those requests must still succeed through the main branch.
      const canvasId = seedCanvas(t.raw, projectId, 'Thumb')
      t.raw.prepare('UPDATE canvases SET thumbnail = ? WHERE id = ?').run('old-thumb', canvasId)

      const res = await supertest(app)
        .put(`/api/canvases/${canvasId}`)
        .set(authHeader(ownerId))
        .send({ thumbnail: 'fallback-thumb' })

      expect(res.status).toBe(200)
      expect(
        readColumn<string>(t.raw, 'SELECT thumbnail FROM canvases WHERE id = ?', canvasId),
      ).toBe('fallback-thumb')
    })
  })

  describe('PUT /:id + POST /:id/data — Yjs snapshot merge semantics', () => {
    /**
     * Read the doc back over HTTP (GET /detail/:id returns the persisted
     * `yjs_update`) and decode it with the project's own Yjs decoder, returning
     * the ids of the LIVE node entities. Unlike a byte scan, this proves both
     * presence and absence: deleted entities are tombstoned in the update bytes
     * but no longer appear in the decoded doc.
     */
    async function readDocNodeIds(canvasId: number): Promise<string[]> {
      const res = await supertest(app).get(`/api/canvases/detail/${canvasId}`).set(authHeader(ownerId))
      expect(res.status).toBe(200)
      const doc = decodeBase64ToDoc(res.body.data.yjsUpdate)
      expect(doc).not.toBeNull()
      return docToJsonSnapshot(doc as NonNullable<typeof doc>).nodes.map((n) => String(n.id))
    }

    it('merges a yjsData snapshot into the doc without touching the thumbnail', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'Merge')
      t.raw.prepare('UPDATE canvases SET thumbnail = ? WHERE id = ?').run('keep-me', canvasId)
      const yjsData = Buffer.from(
        JSON.stringify({ nodes: [{ id: 'merge-node-1', title: 'M' }] }),
        'utf8',
      ).toString('base64')

      const res = await supertest(app)
        .put(`/api/canvases/${canvasId}`)
        .set(authHeader(ownerId))
        .send({ yjsData })

      expect(res.status).toBe(200)
      await flushAllCanvasStates()
      expect(await readDocNodeIds(canvasId)).toContain('merge-node-1')
      // The merge path writes the doc, never the thumbnail column.
      expect(
        readColumn<string>(t.raw, 'SELECT thumbnail FROM canvases WHERE id = ?', canvasId),
      ).toBe('keep-me')
    })

    it('returns 400 for corrupt or non-object yjsData without writing the row', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'Corrupt')
      t.raw.prepare('UPDATE canvases SET thumbnail = ? WHERE id = ?').run('untouched', canvasId)

      const corrupt = await supertest(app)
        .put(`/api/canvases/${canvasId}`)
        .set(authHeader(ownerId))
        .send({ yjsData: Buffer.from('not json', 'utf8').toString('base64') })
      expect(corrupt.status).toBe(400)
      expect(corrupt.body.error).toContain('invalid or corrupt yjsData')

      const nonObject = await supertest(app)
        .put(`/api/canvases/${canvasId}`)
        .set(authHeader(ownerId))
        .send({ yjsData: Buffer.from('[1,2]', 'utf8').toString('base64') })
      expect(nonObject.status).toBe(400)
      expect(nonObject.body.error).toContain('invalid or corrupt yjsData')

      expect(
        readColumn<string>(t.raw, 'SELECT thumbnail FROM canvases WHERE id = ?', canvasId),
      ).toBe('untouched')
    })

    it('deletes an entity the snapshot omits but the client explicitly declares deleted', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'Declared')

      // Seed the doc with a peer entity through the data endpoint first.
      const seeded = await supertest(app)
        .post(`/api/canvases/${canvasId}/data`)
        .set(authHeader(ownerId))
        .send({ nodes: [{ id: 'peer-gone', title: 'P' }], deletedIds: { nodes: [] } })
      expect(seeded.status).toBe(200)

      // The snapshot omits 'peer-gone' AND declares it deleted: a "known and
      // intentional deletion", so the merge must actually remove it.
      const res = await supertest(app)
        .post(`/api/canvases/${canvasId}/data`)
        .set(authHeader(ownerId))
        .send({ nodes: [{ id: 'fresh-1' }], deletedIds: { nodes: ['peer-gone'] } })
      expect(res.status).toBe(200)

      await flushAllCanvasStates()
      const nodeIds = await readDocNodeIds(canvasId)
      expect(nodeIds).toContain('fresh-1')
      expect(nodeIds).not.toContain('peer-gone')
    })

    it('upsertOnly mode honors declared deletions while protecting undeclared peers', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'Ghost')
      const seeded = await supertest(app)
        .post(`/api/canvases/${canvasId}/data`)
        .set(authHeader(ownerId))
        .send({ nodes: [{ id: 'peer-declared' }, { id: 'peer-protected' }] })
      expect(seeded.status).toBe(200)

      // The snapshot omits both peers but only declares one deleted. The merge
      // runs upsertOnly ('peer-protected' is missing and undeclared — it may be
      // a collaborator's edit a stale snapshot never saw): the declared deletion
      // must still be executed, the undeclared peer must NOT be ghost-revived
      // into a deletion (nor silently dropped — it must stay in the doc).
      const res = await supertest(app)
        .post(`/api/canvases/${canvasId}/data`)
        .set(authHeader(ownerId))
        .send({ nodes: [{ id: 'fresh-2' }], deletedIds: { nodes: ['peer-declared'] } })
      expect(res.status).toBe(200)

      await flushAllCanvasStates()
      const nodeIds = await readDocNodeIds(canvasId)
      expect(nodeIds).toContain('fresh-2')
      expect(nodeIds).toContain('peer-protected')
      expect(nodeIds).not.toContain('peer-declared')
    })

    it('never deletes a doc entity a PUT snapshot merely omits (stale-snapshot protection)', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'Stale')
      const seeded = await supertest(app)
        .post(`/api/canvases/${canvasId}/data`)
        .set(authHeader(ownerId))
        .send({ nodes: [{ id: 'peer-stay' }] })
      expect(seeded.status).toBe(200)

      // A PUT yjsData snapshot omitting 'peer-stay' is treated as possibly
      // stale: the merge runs upsertOnly, so the peer survives. (PUT does not
      // read body.deletedIds at all — declaration-based deletion only exists on
      // POST /:id/data.)
      const res = await supertest(app)
        .put(`/api/canvases/${canvasId}`)
        .set(authHeader(ownerId))
        .send({
          yjsData: Buffer.from(JSON.stringify({ nodes: [{ id: 'fresh-put' }] }), 'utf8').toString('base64'),
        })
      expect(res.status).toBe(200)

      await flushAllCanvasStates()
      const nodeIds = await readDocNodeIds(canvasId)
      expect(nodeIds).toContain('fresh-put')
      expect(nodeIds).toContain('peer-stay')
    })

    it('refuses to ghost-revive a deleted entity inside an upsertOnly merge (H2)', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'Tombstone')

      // 1) Seed three entities.
      const seeded = await supertest(app)
        .post(`/api/canvases/${canvasId}/data`)
        .set(authHeader(ownerId))
        .send({ nodes: [{ id: 'victim' }, { id: 'peer' }, { id: 'extra' }] })
      expect(seeded.status).toBe(200)

      // 2) B deletes 'victim'. The explicit declaration keeps the merge in
      //    authoritative (upsertOnly=false) mode, so the deletion really lands
      //    and 'victim' becomes a tombstone in the doc.
      const deleted = await supertest(app)
        .post(`/api/canvases/${canvasId}/data`)
        .set(authHeader(ownerId))
        .send({ nodes: [{ id: 'peer' }, { id: 'extra' }], deletedIds: { nodes: ['victim'] } })
      expect(deleted.status).toBe(200)
      await flushAllCanvasStates()
      expect(await readDocNodeIds(canvasId)).not.toContain('victim')

      // 3) A's stale snapshot still carries 'victim' and omits 'extra'. Omitting
      //    an undeclared doc entity makes the merge upsertOnly (stale snapshot),
      //    and the tombstoned 'victim' must NOT be written back — otherwise the
      //    entity reappears for A while B (who deleted it) never sees it.
      const stale = await supertest(app)
        .post(`/api/canvases/${canvasId}/data`)
        .set(authHeader(ownerId))
        .send({ nodes: [{ id: 'victim' }, { id: 'peer' }] })
      expect(stale.status).toBe(200)

      await flushAllCanvasStates()
      const nodeIds = await readDocNodeIds(canvasId)
      expect(nodeIds).not.toContain('victim')
      expect(nodeIds).toContain('peer')
      expect(nodeIds).toContain('extra')
    })
  })

  describe('POST /:id/data — legacy payloads, declaration caps, empty bodies', () => {
    it('accepts the legacy base64 yjsData field and merges its entities', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'Legacy')
      const yjsData = Buffer.from(
        JSON.stringify({ nodes: [{ id: 'legacy-node-1', title: 'L' }] }),
        'utf8',
      ).toString('base64')

      const res = await supertest(app)
        .post(`/api/canvases/${canvasId}/data`)
        .set(authHeader(ownerId))
        .send({ yjsData })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      await flushAllCanvasStates()
      // Decode through the project's own Yjs decoder: proves the entity landed
      // in the live doc, not merely that the request was accepted.
      const detail = await supertest(app)
        .get(`/api/canvases/detail/${canvasId}`)
        .set(authHeader(ownerId))
      expect(detail.status).toBe(200)
      const doc = decodeBase64ToDoc(detail.body.data.yjsUpdate)
      expect(doc).not.toBeNull()
      const ids = docToJsonSnapshot(doc as NonNullable<typeof doc>).nodes.map((n) => String(n.id))
      expect(ids).toContain('legacy-node-1')
    })

    it('returns 400 for a corrupt legacy yjsData field', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'LegacyBad')
      const res = await supertest(app)
        .post(`/api/canvases/${canvasId}/data`)
        .set(authHeader(ownerId))
        .send({ yjsData: Buffer.from('not json', 'utf8').toString('base64') })

      expect(res.status).toBe(400)
      expect(res.body.error).toContain('invalid or corrupt yjsData')
      // A rejected decode must not touch the row.
      expect(countRows(t.raw, 'canvases', 'id = ?', canvasId)).toBe(1)
    })

    it('ignores a deletion declaration above the per-collection cap (stays upsertOnly)', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'Cap')
      // Seed a peer entity that the next snapshot will omit.
      const seeded = await supertest(app)
        .post(`/api/canvases/${canvasId}/data`)
        .set(authHeader(ownerId))
        .send({ nodes: [{ id: 'cap-peer' }] })
      expect(seeded.status).toBe(200)

      // 10_001 declarations exceeds MAX_DELETED_IDS_PER_COLLECTION: the whole
      // collection declaration is dropped, so 'cap-peer' is an undeclared
      // missing entity → upsertOnly must protect it from ghost deletion.
      const flood = Array.from({ length: 10_001 }, (_, i) => `filler-${i}`)
      const res = await supertest(app)
        .post(`/api/canvases/${canvasId}/data`)
        .set(authHeader(ownerId))
        .send({ nodes: [{ id: 'cap-fresh' }], deletedIds: { nodes: flood } })

      expect(res.status).toBe(200)
      await flushAllCanvasStates()
      const detail = await supertest(app)
        .get(`/api/canvases/detail/${canvasId}`)
        .set(authHeader(ownerId))
      const doc = decodeBase64ToDoc(detail.body.data.yjsUpdate)
      const ids = docToJsonSnapshot(doc as NonNullable<typeof doc>).nodes.map((n) => String(n.id))
      expect(ids).toContain('cap-fresh')
      expect(ids).toContain('cap-peer')
    })

    it('honors a declaration at exactly the cap (boundary is inclusive)', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'CapEdge')
      const seeded = await supertest(app)
        .post(`/api/canvases/${canvasId}/data`)
        .set(authHeader(ownerId))
        .send({ nodes: [{ id: 'edge-peer' }] })
      expect(seeded.status).toBe(200)

      // 10_000 is the last accepted size; one real declaration inside it must
      // still execute, proving the cap rejects only the oversized payload.
      const declared = Array.from({ length: 9_999 }, (_, i) => `filler-${i}`)
      declared.push('edge-peer')
      const res = await supertest(app)
        .post(`/api/canvases/${canvasId}/data`)
        .set(authHeader(ownerId))
        .send({ nodes: [{ id: 'edge-fresh' }], deletedIds: { nodes: declared } })

      expect(res.status).toBe(200)
      await flushAllCanvasStates()
      const detail = await supertest(app)
        .get(`/api/canvases/detail/${canvasId}`)
        .set(authHeader(ownerId))
      const doc = decodeBase64ToDoc(detail.body.data.yjsUpdate)
      const ids = docToJsonSnapshot(doc as NonNullable<typeof doc>).nodes.map((n) => String(n.id))
      expect(ids).toContain('edge-fresh')
      expect(ids).not.toContain('edge-peer')
    })

    it('loads the canvas doc even when the body carries no collections', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'Empty')
      const res = await supertest(app)
        .post(`/api/canvases/${canvasId}/data`)
        .set(authHeader(ownerId))
        .send({})

      expect(res.status).toBe(200)
      // The empty-body path still calls loadCanvasStateFromDb so later reads
      // are consistent; a mutation dropping that call leaves loaded=false.
      expect(getCanvasState(canvasId)?.loaded).toBe(true)
    })
  })

  describe('PUT /:id — main-branch metadata fields', () => {
    it('persists previewText and sortOrder', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'Meta')

      const res = await supertest(app)
        .put(`/api/canvases/${canvasId}`)
        .set(authHeader(ownerId))
        .send({ previewText: 'preview body', sortOrder: 7 })

      expect(res.status).toBe(200)
      expect(
        readColumn<string>(t.raw, 'SELECT preview_text FROM canvases WHERE id = ?', canvasId),
      ).toBe('preview body')
      expect(
        readColumn<number>(t.raw, 'SELECT sort_order FROM canvases WHERE id = ?', canvasId),
      ).toBe(7)
    })

    it('moves a canvas into a folder of its own project', async () => {
      const folderId = seedFolder(t.raw, projectId, 'Target')
      const canvasId = seedCanvas(t.raw, projectId, 'Movable')

      const res = await supertest(app)
        .put(`/api/canvases/${canvasId}`)
        .set(authHeader(ownerId))
        .send({ folderId })

      expect(res.status).toBe(200)
      expect(
        readColumn<number>(t.raw, 'SELECT folder_id FROM canvases WHERE id = ?', canvasId),
      ).toBe(folderId)
    })

    it('removes a canvas from its folder when folderId is null', async () => {
      const folderId = seedFolder(t.raw, projectId, 'Source')
      const canvasId = seedCanvas(t.raw, projectId, 'Nested', { folderId })

      const res = await supertest(app)
        .put(`/api/canvases/${canvasId}`)
        .set(authHeader(ownerId))
        .send({ folderId: null })

      expect(res.status).toBe(200)
      expect(
        readColumn<number | null>(t.raw, 'SELECT folder_id FROM canvases WHERE id = ?', canvasId),
      ).toBeNull()
    })

    it('rejects a non-numeric or cross-project folderId without writing the row', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'Guarded')

      const badType = await supertest(app)
        .put(`/api/canvases/${canvasId}`)
        .set(authHeader(ownerId))
        .send({ folderId: 'abc' })
      expect(badType.status).toBe(400)
      expect(badType.body.error).toContain('无效的文件夹')

      const otherProject = seedProject(t.raw, ownerId, 'Other')
      const foreignFolder = seedFolder(t.raw, otherProject, 'Foreign')
      const crossProject = await supertest(app)
        .put(`/api/canvases/${canvasId}`)
        .set(authHeader(ownerId))
        .send({ folderId: foreignFolder })
      expect(crossProject.status).toBe(400)
      expect(crossProject.body.error).toContain('文件夹不属于该项目')

      // Neither rejected request may have linked the canvas to a folder.
      expect(
        readColumn<number | null>(t.raw, 'SELECT folder_id FROM canvases WHERE id = ?', canvasId),
      ).toBeNull()
    })
  })

  describe('folders', () => {
    it('lists folders for the project', async () => {
      seedFolder(t.raw, projectId, 'F1')
      const res = await supertest(app)
        .get(`/api/canvases/${projectId}/folders`)
        .set(authHeader(ownerId))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(Array.isArray(res.body.data)).toBe(true)
    })

    it('creates a folder in the project', async () => {
      const res = await supertest(app)
        .post(`/api/canvases/${projectId}/folders`)
        .set(authHeader(ownerId))
        .send({ name: 'New Folder' })

      expect([200, 201]).toContain(res.status)
      expect(countRows(t.raw, 'folders', 'project_id = ?', projectId)).toBe(1)
    })

    it('renames a folder', async () => {
      const folderId = seedFolder(t.raw, projectId, 'Old')
      const res = await supertest(app)
        .put(`/api/canvases/folders/${folderId}`)
        .set(authHeader(ownerId))
        .send({ name: 'Renamed' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(readColumn<string>(t.raw, 'SELECT name FROM folders WHERE id = ?', folderId)).toBe(
        'Renamed',
      )
    })

    it('deletes a folder', async () => {
      const folderId = seedFolder(t.raw, projectId, 'Doomed')
      const res = await supertest(app)
        .delete(`/api/canvases/folders/${folderId}`)
        .set(authHeader(ownerId))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(countRows(t.raw, 'folders', 'id = ?', folderId)).toBe(0)
    })

    it('rejects folder creation with a non-numeric, nonexistent, or cross-project parentId', async () => {
      const badType = await supertest(app)
        .post(`/api/canvases/${projectId}/folders`)
        .set(authHeader(ownerId))
        .send({ name: 'Bad', parentId: 'abc' })
      expect(badType.status).toBe(400)
      expect(badType.body.error).toContain('无效的父文件夹')

      const missing = await supertest(app)
        .post(`/api/canvases/${projectId}/folders`)
        .set(authHeader(ownerId))
        .send({ name: 'Missing Parent', parentId: 999999 })
      expect(missing.status).toBe(400)
      expect(missing.body.error).toContain('父文件夹不属于该项目')

      const otherProject = seedProject(t.raw, ownerId, 'Other P')
      const foreignFolder = seedFolder(t.raw, otherProject, 'Foreign')
      const crossProject = await supertest(app)
        .post(`/api/canvases/${projectId}/folders`)
        .set(authHeader(ownerId))
        .send({ name: 'Cross', parentId: foreignFolder })
      expect(crossProject.status).toBe(400)
      expect(crossProject.body.error).toContain('父文件夹不属于该项目')

      expect(countRows(t.raw, 'folders', 'project_id = ?', projectId)).toBe(0)
    })

    it('rejects folder rename by a non-member, for a missing folder, and for a non-numeric id', async () => {
      const folderId = seedFolder(t.raw, projectId, 'Mine')

      const forbidden = await supertest(app)
        .put(`/api/canvases/folders/${folderId}`)
        .set(authHeader(outsiderId))
        .send({ name: 'Hijack' })
      expect(forbidden.status).toBe(403)
      expect(readColumn<string>(t.raw, 'SELECT name FROM folders WHERE id = ?', folderId)).toBe('Mine')

      const missing = await supertest(app)
        .put('/api/canvases/folders/999999')
        .set(authHeader(ownerId))
        .send({ name: 'X' })
      expect(missing.status).toBe(404)

      const badId = await supertest(app)
        .put('/api/canvases/folders/abc')
        .set(authHeader(ownerId))
        .send({ name: 'X' })
      expect(badId.status).toBe(400)
      expect(readColumn<string>(t.raw, 'SELECT name FROM folders WHERE id = ?', folderId)).toBe('Mine')
    })

    it('rejects folder deletion by a non-member, for a missing folder, and for a non-numeric id', async () => {
      const folderId = seedFolder(t.raw, projectId, 'Keep')

      const forbidden = await supertest(app)
        .delete(`/api/canvases/folders/${folderId}`)
        .set(authHeader(outsiderId))
      expect(forbidden.status).toBe(403)
      expect(countRows(t.raw, 'folders', 'id = ?', folderId)).toBe(1)

      const missing = await supertest(app)
        .delete('/api/canvases/folders/999999')
        .set(authHeader(ownerId))
      expect(missing.status).toBe(404)

      const badId = await supertest(app)
        .delete('/api/canvases/folders/abc')
        .set(authHeader(ownerId))
      expect(badId.status).toBe(400)
      expect(countRows(t.raw, 'folders', 'id = ?', folderId)).toBe(1)
    })

    it('deletes the whole folder subtree with its canvases and closes their rooms', async () => {
      const parentId = seedFolder(t.raw, projectId, 'PARENT')
      const childId = seedFolder(t.raw, projectId, 'CHILD', parentId)
      const canvasId = seedCanvas(t.raw, projectId, 'Inner', { folderId: childId })

      const res = await supertest(app)
        .delete(`/api/canvases/folders/${parentId}`)
        .set(authHeader(ownerId))

      expect(res.status).toBe(200)
      expect(res.body.data.foldersDeleted).toBe(2)
      // Both the parent and the nested child folder are gone.
      expect(countRows(t.raw, 'folders', 'project_id = ?', projectId)).toBe(0)
      // The canvas living inside the child folder is gone too.
      expect(countRows(t.raw, 'canvases', 'id = ?', canvasId)).toBe(0)
      // The websocket module is mocked in this file: the deleted canvas's room
      // must have been torn down before the rows were removed.
      expect(closeRoom).toHaveBeenCalledWith(canvasId, 'folder-deleted')
    })
  })
})
