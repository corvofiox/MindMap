/**
 * Collaboration controller integration tests.
 *
 * `collaboration.controller.ts` is 543 lines with 8 routes and sat at ~13% line
 * coverage — the only real coverage came from a single accept-invitation
 * regression test. This file exercises the rest of the surface against the real
 * router, a real in-memory database, and a mocked websocket layer.
 *
 * The authorization rules here are security-relevant (who may invite, remove, or
 * change the role of whom), so each is asserted together with the database state
 * it must NOT change on rejection.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import type express from 'express'

vi.mock('../utils/logger.js', () => ({ log: vi.fn(), logError: vi.fn() }))

vi.mock('../middleware/rateLimit.middleware.js', () => ({
  apiLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  authLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}))

vi.mock('../database/connection.js', async () => {
  const { installDbMock } = await import('./helpers/integration-harness.js')
  return installDbMock()
})

// The controller imports these from the websocket module; expose them as spies so
// tests can assert the collaboration side effects (eviction / role change) fire.
vi.mock('../websocket/index.js', () => ({
  kickUserFromRoom: vi.fn(),
  updateUserRole: vi.fn(),
  closeRoom: vi.fn(),
  getCanvasActiveUsers: vi.fn(() => []),
}))

import { kickUserFromRoom, updateUserRole } from '../websocket/index.js'

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

const { collaborationRouter } = await import('../controllers/collaboration.controller.js')

/** Insert a pending invitation and return its id. */
function seedInvitation(
  raw: TestDatabase['raw'],
  projectId: number,
  inviterId: number,
  inviteeId: number,
  role = 'editor',
): number {
  const now = Math.floor(Date.now() / 1000)
  return Number(
    raw
      .prepare(
        'INSERT INTO project_invitations (project_id, inviter_id, invitee_id, role, status, created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(projectId, inviterId, inviteeId, role, 'pending', now).lastInsertRowid,
  )
}

describe('collaboration.controller (integration, real router + real DB)', () => {
  let app: express.Express
  let t: TestDatabase
  let ownerId: number
  let memberId: number
  let outsiderId: number
  let projectId: number

  beforeEach(() => {
    kickUserFromRoom.mockClear()
    updateUserRole.mockClear()

    t = createTestDatabase()
    app = buildApp('/api/collaboration', collaborationRouter)

    ownerId = seedUser(t.raw, 'owner@test.com', 'hash', 'Owner')
    memberId = seedUser(t.raw, 'member@test.com', 'hash', 'Member')
    outsiderId = seedUser(t.raw, 'outsider@test.com', 'hash', 'Outsider')
    projectId = seedProject(t.raw, ownerId, 'P', { isCollaborative: true })
    seedMember(t.raw, projectId, memberId, 'editor')
  })

  describe('GET /projects/:projectId/members', () => {
    it('lists the owner plus members for a member of the project', async () => {
      const res = await supertest(app)
        .get(`/api/collaboration/projects/${projectId}/members`)
        .set(authHeader(memberId))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      // Shape: { members, invitations, ownerId }
      expect(res.body.data.ownerId).toBe(ownerId)
      const ids = res.body.data.members.map((m: { userId: number }) => m.userId)
      expect(ids).toContain(ownerId)
      expect(ids).toContain(memberId)
      // The response must carry the owner flag so the UI can gate controls.
      const ownerEntry = res.body.data.members.find((m: { userId: number }) => m.userId === ownerId)
      expect(ownerEntry.isOwner).toBe(true)
    })

    it('does not leak member emails of a project to a non-member', async () => {
      const res = await supertest(app)
        .get(`/api/collaboration/projects/${projectId}/members`)
        .set(authHeader(outsiderId))
      expect([403, 404]).toContain(res.status)
    })

    it('returns 400 for a non-numeric project id', async () => {
      const res = await supertest(app)
        .get('/api/collaboration/projects/nope/members')
        .set(authHeader(ownerId))
      expect(res.status).toBe(400)
    })

    it('returns 404 for a project that does not exist', async () => {
      const res = await supertest(app)
        .get('/api/collaboration/projects/999999/members')
        .set(authHeader(ownerId))
      expect(res.status).toBe(404)
    })

    it('requires authentication', async () => {
      const res = await supertest(app).get(`/api/collaboration/projects/${projectId}/members`)
      expect(res.status).toBe(401)
    })
  })

  describe('POST /projects/:projectId/invite', () => {
    it('lets the owner invite a user, creating a pending invitation', async () => {
      const res = await supertest(app)
        .post(`/api/collaboration/projects/${projectId}/invite`)
        .set(authHeader(ownerId))
        .send({ userId: outsiderId, role: 'editor' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      const status = readColumn<string>(
        t.raw,
        'SELECT status FROM project_invitations WHERE project_id = ? AND invitee_id = ?',
        projectId,
        outsiderId,
      )
      expect(status).toBe('pending')
      const role = readColumn<string>(
        t.raw,
        'SELECT role FROM project_invitations WHERE invitee_id = ?',
        outsiderId,
      )
      expect(role).toBe('editor')
    })

    it('defaults the role to viewer when omitted', async () => {
      await supertest(app)
        .post(`/api/collaboration/projects/${projectId}/invite`)
        .set(authHeader(ownerId))
        .send({ userId: outsiderId })

      expect(
        readColumn<string>(t.raw, 'SELECT role FROM project_invitations WHERE invitee_id = ?', outsiderId),
      ).toBe('viewer')
    })

    it('rejects a role outside the editor/viewer whitelist (no privilege escalation)', async () => {
      for (const role of ['owner', 'admin', 'root', 123]) {
        const res = await supertest(app)
          .post(`/api/collaboration/projects/${projectId}/invite`)
          .set(authHeader(ownerId))
          .send({ userId: outsiderId, role })
        expect(res.status, `role=${String(role)}`).toBe(400)
      }
      expect(countRows(t.raw, 'project_invitations')).toBe(0)
    })

    it('refuses an invite issued by a non-owner', async () => {
      const res = await supertest(app)
        .post(`/api/collaboration/projects/${projectId}/invite`)
        .set(authHeader(memberId))
        .send({ userId: outsiderId, role: 'editor' })

      expect(res.status).toBe(403)
      expect(countRows(t.raw, 'project_invitations')).toBe(0)
    })

    it('refuses inviting yourself', async () => {
      const res = await supertest(app)
        .post(`/api/collaboration/projects/${projectId}/invite`)
        .set(authHeader(ownerId))
        .send({ userId: ownerId })

      expect(res.status).toBe(400)
      expect(countRows(t.raw, 'project_invitations')).toBe(0)
    })

    it('rejects a missing userId and an unknown project', async () => {
      const noUser = await supertest(app)
        .post(`/api/collaboration/projects/${projectId}/invite`)
        .set(authHeader(ownerId))
        .send({ role: 'editor' })
      expect(noUser.status).toBe(400)

      const noProject = await supertest(app)
        .post('/api/collaboration/projects/999999/invite')
        .set(authHeader(ownerId))
        .send({ userId: outsiderId })
      expect(noProject.status).toBe(404)
    })

    it('returns 400 for a non-numeric project id', async () => {
      const res = await supertest(app)
        .post('/api/collaboration/projects/nope/invite')
        .set(authHeader(ownerId))
        .send({ userId: outsiderId })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('无效的项目ID')
      expect(countRows(t.raw, 'project_invitations')).toBe(0)
    })

    it('refuses inviting a user who is already a member', async () => {
      const res = await supertest(app)
        .post(`/api/collaboration/projects/${projectId}/invite`)
        .set(authHeader(ownerId))
        .send({ userId: memberId })

      expect(res.status).toBe(400)
      expect(res.body.error).toContain('已是项目成员')
      expect(countRows(t.raw, 'project_invitations', 'invitee_id = ?', memberId)).toBe(0)
    })

    it('refuses a second invite while a pending invitation is still open', async () => {
      const first = await supertest(app)
        .post(`/api/collaboration/projects/${projectId}/invite`)
        .set(authHeader(ownerId))
        .send({ userId: outsiderId })
      expect(first.status).toBe(200)

      const second = await supertest(app)
        .post(`/api/collaboration/projects/${projectId}/invite`)
        .set(authHeader(ownerId))
        .send({ userId: outsiderId })
      expect(second.status).toBe(400)
      expect(second.body.error).toContain('已向该用户发送过邀请')
      // No duplicate invitation row may be created.
      expect(countRows(t.raw, 'project_invitations', 'invitee_id = ?', outsiderId)).toBe(1)
    })

    it('flips a non-collaborative project to collaborative on the first invite', async () => {
      const soloProject = seedProject(t.raw, ownerId, 'Solo', { isCollaborative: false })
      expect(
        readColumn<number>(t.raw, 'SELECT is_collaborative FROM projects WHERE id = ?', soloProject),
      ).toBe(0)

      const res = await supertest(app)
        .post(`/api/collaboration/projects/${soloProject}/invite`)
        .set(authHeader(ownerId))
        .send({ userId: outsiderId })

      expect(res.status).toBe(200)
      expect(
        readColumn<number>(t.raw, 'SELECT is_collaborative FROM projects WHERE id = ?', soloProject),
      ).toBe(1)
    })
  })

  describe('GET /invitations', () => {
    it('returns only the caller\u2019s own incoming invitations', async () => {
      seedInvitation(t.raw, projectId, ownerId, outsiderId)
      const otherProject = seedProject(t.raw, memberId, 'Other')
      seedInvitation(t.raw, otherProject, memberId, memberId)

      const res = await supertest(app).get('/api/collaboration/invitations').set(authHeader(outsiderId))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0].projectId).toBe(projectId)
    })

    it('returns an empty list when the caller has none', async () => {
      const res = await supertest(app).get('/api/collaboration/invitations').set(authHeader(outsiderId))
      expect(res.status).toBe(200)
      expect(res.body.data).toEqual([])
    })
  })

  describe('POST /invitations/:id/accept', () => {
    it('accepts as the invitee and creates the membership row', async () => {
      const invitationId = seedInvitation(t.raw, projectId, ownerId, outsiderId)

      const res = await supertest(app)
        .post(`/api/collaboration/invitations/${invitationId}/accept`)
        .set(authHeader(outsiderId))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(
        readColumn<string>(t.raw, 'SELECT status FROM project_invitations WHERE id = ?', invitationId),
      ).toBe('accepted')
      expect(
        countRows(t.raw, 'project_members', 'project_id = ? AND user_id = ?', projectId, outsiderId),
      ).toBe(1)
    })

    it('does not let a different user accept someone else\u2019s invitation', async () => {
      const invitationId = seedInvitation(t.raw, projectId, ownerId, outsiderId)

      const res = await supertest(app)
        .post(`/api/collaboration/invitations/${invitationId}/accept`)
        .set(authHeader(memberId))

      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(
        readColumn<string>(t.raw, 'SELECT status FROM project_invitations WHERE id = ?', invitationId),
      ).toBe('pending')
      expect(
        countRows(t.raw, 'project_members', 'project_id = ? AND user_id = ?', projectId, memberId),
      ).toBe(1) // unchanged: only the original membership
    })

    it('returns 404 for a nonexistent invitation and 400 for a bad id', async () => {
      const notFound = await supertest(app)
        .post('/api/collaboration/invitations/999999/accept')
        .set(authHeader(outsiderId))
      expect(notFound.status).toBe(404)

      const badId = await supertest(app)
        .post('/api/collaboration/invitations/abc/accept')
        .set(authHeader(outsiderId))
      expect(badId.status).toBe(400)
    })
  })

  describe('POST /invitations/:id/reject', () => {
    it('lets the invitee reject, marking the invitation rejected without membership', async () => {
      const invitationId = seedInvitation(t.raw, projectId, ownerId, outsiderId)

      const res = await supertest(app)
        .post(`/api/collaboration/invitations/${invitationId}/reject`)
        .set(authHeader(outsiderId))

      expect(res.status).toBe(200)
      expect(
        readColumn<string>(t.raw, 'SELECT status FROM project_invitations WHERE id = ?', invitationId),
      ).toBe('rejected')
      expect(
        countRows(t.raw, 'project_members', 'project_id = ? AND user_id = ?', projectId, outsiderId),
      ).toBe(0)
    })

    it('does not let an unrelated user reject the invitation', async () => {
      const invitationId = seedInvitation(t.raw, projectId, ownerId, outsiderId)
      const res = await supertest(app)
        .post(`/api/collaboration/invitations/${invitationId}/reject`)
        .set(authHeader(memberId))

      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(
        readColumn<string>(t.raw, 'SELECT status FROM project_invitations WHERE id = ?', invitationId),
      ).toBe('pending')
    })
  })

  describe('DELETE /projects/:projectId/members/:userId', () => {
    it('lets the owner remove a member and deletes the row', async () => {
      // The eviction only iterates the project's canvases, so seed one — otherwise
      // the loop body never runs and the assertion would be vacuous.
      seedCanvas(t.raw, projectId, 'Collab Canvas')

      const res = await supertest(app)
        .delete(`/api/collaboration/projects/${projectId}/members/${memberId}`)
        .set(authHeader(ownerId))

      expect(res.status).toBe(200)
      expect(
        countRows(t.raw, 'project_members', 'project_id = ? AND user_id = ?', projectId, memberId),
      ).toBe(0)
      // The removed member must be evicted from the project's live rooms.
      expect(kickUserFromRoom).toHaveBeenCalledWith(
        expect.any(Number),
        memberId,
        'removed',
      )
    })

    it('refuses removal by a non-owner', async () => {
      const otherMember = seedUser(t.raw, 'other@test.com', 'hash', 'Other')
      seedMember(t.raw, projectId, otherMember, 'editor')

      const res = await supertest(app)
        .delete(`/api/collaboration/projects/${projectId}/members/${otherMember}`)
        .set(authHeader(memberId))

      expect(res.status).toBe(403)
      expect(
        countRows(t.raw, 'project_members', 'project_id = ? AND user_id = ?', projectId, otherMember),
      ).toBe(1)
    })

    it('refuses removing the project owner', async () => {
      const res = await supertest(app)
        .delete(`/api/collaboration/projects/${projectId}/members/${ownerId}`)
        .set(authHeader(ownerId))
      expect(res.status).toBe(400)
      expect(
        countRows(t.raw, 'project_members', 'project_id = ? AND user_id = ?', projectId, ownerId),
      ).toBe(0) // owner is not a member row; must not be created or touched
    })
  })

  describe('PUT /projects/:projectId/members/:userId/role', () => {
    it('lets the owner change a member\u2019s role', async () => {
      seedCanvas(t.raw, projectId, 'Collab Canvas')

      const res = await supertest(app)
        .put(`/api/collaboration/projects/${projectId}/members/${memberId}/role`)
        .set(authHeader(ownerId))
        .send({ role: 'viewer' })

      expect(res.status).toBe(200)
      expect(
        readColumn<string>(
          t.raw,
          'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
          projectId,
          memberId,
        ),
      ).toBe('viewer')
      // The live room must be told about the demotion.
      expect(updateUserRole).toHaveBeenCalledWith(expect.any(Number), memberId, 'viewer')
    })

    it('rejects an invalid role and keeps the previous one', async () => {
      const res = await supertest(app)
        .put(`/api/collaboration/projects/${projectId}/members/${memberId}/role`)
        .set(authHeader(ownerId))
        .send({ role: 'superuser' })

      expect(res.status).toBe(400)
      expect(
        readColumn<string>(
          t.raw,
          'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
          projectId,
          memberId,
        ),
      ).toBe('editor')
    })

    it('refuses a role change by a non-owner', async () => {
      const res = await supertest(app)
        .put(`/api/collaboration/projects/${projectId}/members/${memberId}/role`)
        .set(authHeader(memberId))
        .send({ role: 'viewer' })

      expect(res.status).toBe(403)
      expect(
        readColumn<string>(
          t.raw,
          'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
          projectId,
          memberId,
        ),
      ).toBe('editor')
    })

    it('returns 404 for a role change targeting a non-member or a nonexistent project', async () => {
      const nonMember = await supertest(app)
        .put(`/api/collaboration/projects/${projectId}/members/${outsiderId}/role`)
        .set(authHeader(ownerId))
        .send({ role: 'viewer' })
      expect(nonMember.status).toBe(404)
      expect(nonMember.body.error).toContain('成员未找到')

      const noProject = await supertest(app)
        .put('/api/collaboration/projects/999999/members/1/role')
        .set(authHeader(ownerId))
        .send({ role: 'viewer' })
      expect(noProject.status).toBe(404)
      expect(noProject.body.error).toContain('项目未找到')

      // Neither case may fabricate a membership row.
      expect(countRows(t.raw, 'project_members', 'user_id = ?', outsiderId)).toBe(0)
    })
  })

  describe('DELETE /invitations/:id', () => {
    it('lets the owner revoke a pending invitation', async () => {
      const invitationId = seedInvitation(t.raw, projectId, ownerId, outsiderId)

      const res = await supertest(app)
        .delete(`/api/collaboration/invitations/${invitationId}`)
        .set(authHeader(ownerId))

      expect(res.status).toBe(200)
      expect(countRows(t.raw, 'project_invitations', 'id = ?', invitationId)).toBe(0)
    })

    it('refuses revocation by someone who is neither inviter nor owner', async () => {
      const invitationId = seedInvitation(t.raw, projectId, ownerId, outsiderId)

      const res = await supertest(app)
        .delete(`/api/collaboration/invitations/${invitationId}`)
        .set(authHeader(memberId))

      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(countRows(t.raw, 'project_invitations', 'id = ?', invitationId)).toBe(1)
    })

    it('returns 404 for a nonexistent invitation and 400 for a bad id', async () => {
      const notFound = await supertest(app)
        .delete('/api/collaboration/invitations/999999')
        .set(authHeader(ownerId))
      expect(notFound.status).toBe(404)

      const badId = await supertest(app)
        .delete('/api/collaboration/invitations/abc')
        .set(authHeader(ownerId))
      expect(badId.status).toBe(400)
    })
  })
})
