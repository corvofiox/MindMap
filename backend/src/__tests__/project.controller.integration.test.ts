/**
 * Project controller integration tests.
 *
 * These exercise the REAL `projectRouter` mounted on a real Express app against a
 * real in-memory SQLite database. The previous version of this file defined its
 * own inline Express routes, called supertest without `await`, and asserted
 * `expect(response).toBeDefined()` — so it imported nothing from
 * `../controllers/` and stayed green even when the controller was mutated to
 * always fail. Every assertion below reads an actual HTTP response or an actual
 * database row, so a behavioural change in the router fails the suite.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import type express from 'express'
import { closeRoom, kickUserFromRoom } from '../websocket/index.js'

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
  updateUserRole: vi.fn(),
  shouldUpsertOnlyForSnapshot: vi.fn(() => false),
}))

// Project deletion reaches into the in-memory Yjs registry; the DB is the
// observable side effect we assert on, and the real module schedules timers.
vi.mock('../websocket/canvas-state.js', () => ({
  removeCanvasState: vi.fn(),
  getCanvasJsonSnapshot: vi.fn(() => null),
  getCanvasYjsUpdateBase64: vi.fn(() => null),
  loadCanvasStateFromDb: vi.fn(),
}))

import {
  authHeader,
  buildApp,
  countRows,
  createTestDatabase,
  readColumn,
  seedCanvas,
  seedMember,
  seedProject,
  seedUser,
  setTestEnv,
  type TestDatabase,
} from './helpers/integration-harness.js'

setTestEnv()

const { projectRouter } = await import('../controllers/project.controller.js')

describe('project.controller (integration, real router + real DB)', () => {
  let app: express.Express
  let t: TestDatabase
  let ownerId: number
  let memberId: number
  let outsiderId: number
  let projectId: number

  beforeEach(() => {
    t = createTestDatabase()
    app = buildApp('/api/projects', projectRouter)

    vi.mocked(closeRoom).mockClear()
    vi.mocked(kickUserFromRoom).mockClear()

    ownerId = seedUser(t.raw, 'owner@test.com', 'hash', 'Owner')
    memberId = seedUser(t.raw, 'member@test.com', 'hash', 'Member')
    outsiderId = seedUser(t.raw, 'outsider@test.com', 'hash', 'Outsider')
    projectId = seedProject(t.raw, ownerId, 'P')
    seedMember(t.raw, projectId, memberId, 'editor')
  })

  describe('GET / — list projects (owned + collaborated)', () => {
    it('returns owned projects with memberRole owner', async () => {
      const res = await supertest(app).get('/api/projects').set(authHeader(ownerId))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0].id).toBe(projectId)
      expect(res.body.data[0].name).toBe('P')
      expect(res.body.data[0].memberRole).toBe('owner')
    })

    it('returns collaborated projects with the member role', async () => {
      const res = await supertest(app).get('/api/projects').set(authHeader(memberId))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0].id).toBe(projectId)
      expect(res.body.data[0].memberRole).toBe('editor')
    })

    it('returns an empty array for a user with no projects', async () => {
      const res = await supertest(app).get('/api/projects').set(authHeader(outsiderId))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data).toEqual([])
    })

    it('sorts projects by updatedAt descending', async () => {
      const older = seedProject(t.raw, ownerId, 'Older')
      const newer = seedProject(t.raw, ownerId, 'Newer')
      const now = Math.floor(Date.now() / 1000)
      t.raw.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now - 500, older)
      t.raw.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now - 10, newer)

      const res = await supertest(app).get('/api/projects').set(authHeader(ownerId))

      expect(res.status).toBe(200)
      expect(res.body.data.map((p: { id: number }) => p.id)).toEqual([projectId, newer, older])
    })

    it('converts createdAt/updatedAt to ISO strings', async () => {
      const res = await supertest(app).get('/api/projects').set(authHeader(ownerId))

      expect(res.status).toBe(200)
      expect(res.body.data[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(res.body.data[0].updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('rejects an unauthenticated request with 401', async () => {
      const res = await supertest(app).get('/api/projects')

      expect(res.status).toBe(401)
      expect(res.body.success).toBe(false)
    })
  })

  describe('GET /:id — project detail', () => {
    it('returns the project to its owner', async () => {
      const res = await supertest(app).get(`/api/projects/${projectId}`).set(authHeader(ownerId))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.id).toBe(projectId)
      expect(res.body.data.memberRole).toBe('owner')
    })

    it('returns the project to a member with the member role', async () => {
      const res = await supertest(app).get(`/api/projects/${projectId}`).set(authHeader(memberId))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.memberRole).toBe('editor')
    })

    it('returns 403 for a non-member', async () => {
      const res = await supertest(app).get(`/api/projects/${projectId}`).set(authHeader(outsiderId))

      expect(res.status).toBe(403)
      expect(res.body.success).toBe(false)
    })

    it('returns 404 for a project that does not exist', async () => {
      const res = await supertest(app).get('/api/projects/999999').set(authHeader(ownerId))

      expect(res.status).toBe(404)
      expect(res.body.success).toBe(false)
    })

    it('returns 400 for a non-numeric id', async () => {
      const res = await supertest(app).get('/api/projects/not-a-number').set(authHeader(ownerId))

      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
    })

    it('rejects an unauthenticated request with 401', async () => {
      const res = await supertest(app).get(`/api/projects/${projectId}`)

      expect(res.status).toBe(401)
      expect(res.body.success).toBe(false)
    })
  })

  describe('POST / — create project', () => {
    it('creates a project owned by the caller and persists the row', async () => {
      const res = await supertest(app)
        .post('/api/projects')
        .set(authHeader(ownerId))
        .send({ name: 'Created', description: 'Desc', is_public: true })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.name).toBe('Created')
      expect(res.body.data.memberRole).toBe('owner')
      expect(countRows(t.raw, 'projects', 'name = ?', 'Created')).toBe(1)
      expect(readColumn<number>(t.raw, 'SELECT owner_id FROM projects WHERE name = ?', 'Created')).toBe(
        ownerId,
      )
      expect(readColumn<number>(t.raw, 'SELECT is_public FROM projects WHERE name = ?', 'Created')).toBe(
        1,
      )
    })

    it('accepts camelCase isCollaborative as an alias', async () => {
      const res = await supertest(app)
        .post('/api/projects')
        .set(authHeader(ownerId))
        .send({ name: 'Camel', isCollaborative: true })

      expect(res.status).toBe(200)
      expect(
        readColumn<number>(t.raw, 'SELECT is_collaborative FROM projects WHERE name = ?', 'Camel'),
      ).toBe(1)
    })

    it('defaults description to null and flags to false', async () => {
      await supertest(app).post('/api/projects').set(authHeader(ownerId)).send({ name: 'Bare' })

      expect(
        readColumn<string | null>(t.raw, 'SELECT description FROM projects WHERE name = ?', 'Bare'),
      ).toBeNull()
      expect(
        readColumn<number>(t.raw, 'SELECT is_public FROM projects WHERE name = ?', 'Bare'),
      ).toBe(0)
      expect(
        readColumn<number>(t.raw, 'SELECT is_collaborative FROM projects WHERE name = ?', 'Bare'),
      ).toBe(0)
    })

    it('takes the owner from the token, never from the body', async () => {
      await supertest(app)
        .post('/api/projects')
        .set(authHeader(memberId))
        .send({ name: 'Spoofed', ownerId: outsiderId })

      expect(
        readColumn<number>(t.raw, 'SELECT owner_id FROM projects WHERE name = ?', 'Spoofed'),
      ).toBe(memberId)
    })

    it('rejects an unauthenticated create and writes nothing', async () => {
      const res = await supertest(app).post('/api/projects').send({ name: 'Anon' })

      expect(res.status).toBe(401)
      expect(countRows(t.raw, 'projects', 'name = ?', 'Anon')).toBe(0)
    })
  })

  describe('PUT /:id — update project (owner only)', () => {
    it('renames the project for the owner and persists it', async () => {
      const res = await supertest(app)
        .put(`/api/projects/${projectId}`)
        .set(authHeader(ownerId))
        .send({ name: 'Renamed', description: 'New desc' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.name).toBe('Renamed')
      expect(readColumn<string>(t.raw, 'SELECT name FROM projects WHERE id = ?', projectId)).toBe(
        'Renamed',
      )
      expect(
        readColumn<string>(t.raw, 'SELECT description FROM projects WHERE id = ?', projectId),
      ).toBe('New desc')
    })

    it('leaves omitted fields untouched', async () => {
      await supertest(app)
        .put(`/api/projects/${projectId}`)
        .set(authHeader(ownerId))
        .send({ name: 'OnlyName' })

      expect(
        readColumn<string>(t.raw, 'SELECT description FROM projects WHERE id = ?', projectId),
      ).toBeNull()
      expect(readColumn<number>(t.raw, 'SELECT is_public FROM projects WHERE id = ?', projectId)).toBe(
        0,
      )
    })

    it('refuses a non-owner update and does not modify the row', async () => {
      const res = await supertest(app)
        .put(`/api/projects/${projectId}`)
        .set(authHeader(outsiderId))
        .send({ name: 'Hijacked' })

      expect(res.status).toBe(403)
      expect(res.body.success).toBe(false)
      expect(readColumn<string>(t.raw, 'SELECT name FROM projects WHERE id = ?', projectId)).toBe('P')
    })

    it('does not let a project member rename the project', async () => {
      const res = await supertest(app)
        .put(`/api/projects/${projectId}`)
        .set(authHeader(memberId))
        .send({ name: 'MemberEdit' })

      expect(res.status).toBe(403)
      expect(readColumn<string>(t.raw, 'SELECT name FROM projects WHERE id = ?', projectId)).toBe('P')
    })

    it('returns 404 for a project that does not exist', async () => {
      const res = await supertest(app)
        .put('/api/projects/999999')
        .set(authHeader(ownerId))
        .send({ name: 'Ghost' })

      expect(res.status).toBe(404)
    })

    it('returns 400 for a non-numeric id', async () => {
      const res = await supertest(app)
        .put('/api/projects/abc')
        .set(authHeader(ownerId))
        .send({ name: 'X' })

      expect(res.status).toBe(400)
    })

    it('rejects an unauthenticated update', async () => {
      const res = await supertest(app).put(`/api/projects/${projectId}`).send({ name: 'Anon' })

      expect(res.status).toBe(401)
      expect(readColumn<string>(t.raw, 'SELECT name FROM projects WHERE id = ?', projectId)).toBe('P')
    })
  })

  describe('DELETE /:id — delete project (owner only)', () => {
    it('deletes the project and cascades to canvases and members', async () => {
      seedCanvas(t.raw, projectId, 'C1')
      seedCanvas(t.raw, projectId, 'C2')
      expect(countRows(t.raw, 'canvases', 'project_id = ?', projectId)).toBe(2)
      expect(countRows(t.raw, 'project_members', 'project_id = ?', projectId)).toBe(1)

      const res = await supertest(app).delete(`/api/projects/${projectId}`).set(authHeader(ownerId))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.message).toBe('Project deleted')
      expect(countRows(t.raw, 'projects', 'id = ?', projectId)).toBe(0)
      expect(countRows(t.raw, 'canvases', 'project_id = ?', projectId)).toBe(0)
      expect(countRows(t.raw, 'project_members', 'project_id = ?', projectId)).toBe(0)
    })

    it('refuses a non-owner delete and keeps the project', async () => {
      const res = await supertest(app).delete(`/api/projects/${projectId}`).set(authHeader(outsiderId))

      expect(res.status).toBe(403)
      expect(countRows(t.raw, 'projects', 'id = ?', projectId)).toBe(1)
    })

    it('closes the websocket rooms of every canvas in the project', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'Live')

      await supertest(app).delete(`/api/projects/${projectId}`).set(authHeader(ownerId))

      expect(closeRoom).toHaveBeenCalledWith(canvasId, 'project-deleted')
    })

    it('does not let a member delete the project', async () => {
      const res = await supertest(app).delete(`/api/projects/${projectId}`).set(authHeader(memberId))

      expect(res.status).toBe(403)
      expect(countRows(t.raw, 'projects', 'id = ?', projectId)).toBe(1)
    })

    it('returns 404 for a project that does not exist', async () => {
      const res = await supertest(app).delete('/api/projects/999999').set(authHeader(ownerId))

      expect(res.status).toBe(404)
    })

    it('returns 400 for a non-numeric id', async () => {
      const res = await supertest(app).delete('/api/projects/nope').set(authHeader(ownerId))

      expect(res.status).toBe(400)
    })

    it('rejects an unauthenticated delete and keeps the project', async () => {
      const res = await supertest(app).delete(`/api/projects/${projectId}`)

      expect(res.status).toBe(401)
      expect(countRows(t.raw, 'projects', 'id = ?', projectId)).toBe(1)
    })
  })

  describe('POST /:id/members — add member (owner only)', () => {
    it('adds a member with the requested role and persists it', async () => {
      const res = await supertest(app)
        .post(`/api/projects/${projectId}/members`)
        .set(authHeader(ownerId))
        .send({ userId: outsiderId, role: 'editor' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.userId).toBe(outsiderId)
      expect(res.body.data.role).toBe('editor')
      expect(
        countRows(t.raw, 'project_members', 'project_id = ? AND user_id = ?', projectId, outsiderId),
      ).toBe(1)
      expect(
        readColumn<string>(
          t.raw,
          'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
          projectId,
          outsiderId,
        ),
      ).toBe('editor')
    })

    it('defaults the role to viewer', async () => {
      await supertest(app)
        .post(`/api/projects/${projectId}/members`)
        .set(authHeader(ownerId))
        .send({ userId: outsiderId })

      expect(
        readColumn<string>(
          t.raw,
          'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
          projectId,
          outsiderId,
        ),
      ).toBe('viewer')
    })

    it('does not let a member add another member (no escalation)', async () => {
      const res = await supertest(app)
        .post(`/api/projects/${projectId}/members`)
        .set(authHeader(memberId))
        .send({ userId: outsiderId, role: 'editor' })

      expect(res.status).toBe(403)
      expect(
        countRows(t.raw, 'project_members', 'project_id = ? AND user_id = ?', projectId, outsiderId),
      ).toBe(0)
    })

    it('does not let an outsider add a member', async () => {
      const res = await supertest(app)
        .post(`/api/projects/${projectId}/members`)
        .set(authHeader(outsiderId))
        .send({ userId: ownerId, role: 'editor' })

      expect(res.status).toBe(403)
      expect(
        countRows(t.raw, 'project_members', 'project_id = ? AND user_id = ?', projectId, ownerId),
      ).toBe(0)
    })

    it('returns 409 when the user is already a member', async () => {
      const res = await supertest(app)
        .post(`/api/projects/${projectId}/members`)
        .set(authHeader(ownerId))
        .send({ userId: memberId, role: 'viewer' })

      expect(res.status).toBe(409)
      expect(res.body.success).toBe(false)
      expect(
        countRows(t.raw, 'project_members', 'project_id = ? AND user_id = ?', projectId, memberId),
      ).toBe(1)
    })

    it('returns 400 when adding yourself', async () => {
      const res = await supertest(app)
        .post(`/api/projects/${projectId}/members`)
        .set(authHeader(ownerId))
        .send({ userId: ownerId })

      expect(res.status).toBe(400)
      expect(
        countRows(t.raw, 'project_members', 'project_id = ? AND user_id = ?', projectId, ownerId),
      ).toBe(0)
    })

    it('returns 400 for an invalid role', async () => {
      const res = await supertest(app)
        .post(`/api/projects/${projectId}/members`)
        .set(authHeader(ownerId))
        .send({ userId: outsiderId, role: 'owner' })

      expect(res.status).toBe(400)
      expect(
        countRows(t.raw, 'project_members', 'project_id = ? AND user_id = ?', projectId, outsiderId),
      ).toBe(0)
    })

    it('returns 400 when the user id is missing', async () => {
      const res = await supertest(app)
        .post(`/api/projects/${projectId}/members`)
        .set(authHeader(ownerId))
        .send({ role: 'editor' })

      expect(res.status).toBe(400)
    })

    it('returns 404 for an unknown target user', async () => {
      const res = await supertest(app)
        .post(`/api/projects/${projectId}/members`)
        .set(authHeader(ownerId))
        .send({ userId: 987654 })

      expect(res.status).toBe(404)
    })

    it('returns 404 for an unknown project', async () => {
      const res = await supertest(app)
        .post('/api/projects/999999/members')
        .set(authHeader(ownerId))
        .send({ userId: outsiderId })

      expect(res.status).toBe(404)
    })

    it('returns 400 for a non-numeric project id', async () => {
      const res = await supertest(app)
        .post('/api/projects/nope/members')
        .set(authHeader(ownerId))
        .send({ userId: outsiderId })

      expect(res.status).toBe(400)
    })

    it('rejects an unauthenticated add and writes nothing', async () => {
      const res = await supertest(app)
        .post(`/api/projects/${projectId}/members`)
        .send({ userId: outsiderId })

      expect(res.status).toBe(401)
      expect(
        countRows(t.raw, 'project_members', 'project_id = ? AND user_id = ?', projectId, outsiderId),
      ).toBe(0)
    })
  })

  describe('DELETE /:id/members/:userId — remove member (owner only)', () => {
    it('removes the member for the owner', async () => {
      expect(
        countRows(t.raw, 'project_members', 'project_id = ? AND user_id = ?', projectId, memberId),
      ).toBe(1)

      const res = await supertest(app)
        .delete(`/api/projects/${projectId}/members/${memberId}`)
        .set(authHeader(ownerId))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.message).toBe('Member removed')
      expect(
        countRows(t.raw, 'project_members', 'project_id = ? AND user_id = ?', projectId, memberId),
      ).toBe(0)
    })

    it('does not let a member remove the owner (no escalation)', async () => {
      seedMember(t.raw, projectId, ownerId, 'owner')

      const res = await supertest(app)
        .delete(`/api/projects/${projectId}/members/${ownerId}`)
        .set(authHeader(memberId))

      expect(res.status).toBe(403)
      expect(
        countRows(t.raw, 'project_members', 'project_id = ? AND user_id = ?', projectId, ownerId),
      ).toBe(1)
    })

    it('does not let an outsider remove a member', async () => {
      const res = await supertest(app)
        .delete(`/api/projects/${projectId}/members/${memberId}`)
        .set(authHeader(outsiderId))

      expect(res.status).toBe(403)
      expect(
        countRows(t.raw, 'project_members', 'project_id = ? AND user_id = ?', projectId, memberId),
      ).toBe(1)
    })

    it('returns 404 for an unknown project', async () => {
      const res = await supertest(app)
        .delete(`/api/projects/999999/members/${memberId}`)
        .set(authHeader(ownerId))

      expect(res.status).toBe(404)
      expect(res.body.success).toBe(false)
    })

    it('returns 400 for a non-numeric project id', async () => {
      const res = await supertest(app)
        .delete(`/api/projects/nope/members/${memberId}`)
        .set(authHeader(ownerId))

      expect(res.status).toBe(400)
    })

    it('returns 400 for a non-numeric user id', async () => {
      const res = await supertest(app)
        .delete(`/api/projects/${projectId}/members/not-a-number`)
        .set(authHeader(ownerId))

      expect(res.status).toBe(400)
    })

    it('kicks the removed member out of the project canvas rooms', async () => {
      const canvasId = seedCanvas(t.raw, projectId, 'Live')

      await supertest(app)
        .delete(`/api/projects/${projectId}/members/${memberId}`)
        .set(authHeader(ownerId))

      expect(kickUserFromRoom).toHaveBeenCalledWith(canvasId, memberId, 'removed')
    })

    it('rejects an unauthenticated removal and keeps the member', async () => {
      const res = await supertest(app).delete(`/api/projects/${projectId}/members/${memberId}`)

      expect(res.status).toBe(401)
      expect(
        countRows(t.raw, 'project_members', 'project_id = ? AND user_id = ?', projectId, memberId),
      ).toBe(1)
    })
  })
})
