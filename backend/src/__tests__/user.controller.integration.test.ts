/**
 * User controller integration tests.
 *
 * These exercise the REAL `userRouter` mounted on a real Express app against a
 * real in-memory SQLite database. The previous version of this file defined its
 * own inline Express routes, called supertest without `await`, and asserted
 * `expect(response).toBeDefined()` — it imported nothing from `../controllers/`,
 * so a broken controller could not fail it. Every assertion below reads an
 * actual HTTP response or an actual database row.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
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

// The websocket layer is not under test and importing it opens real sockets.
vi.mock('../websocket/index.js', () => ({
  getCanvasActiveUsers: vi.fn(() => []),
  closeRoom: vi.fn(),
  kickUserFromRoom: vi.fn(),
  updateUserRole: vi.fn(),
  shouldUpsertOnlyForSnapshot: vi.fn(() => false),
}))

// Account deletion reaches into the in-memory Yjs registry; the DB is the
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
  seedFolder,
  seedMember,
  seedProject,
  seedUser,
  setTestEnv,
  type TestDatabase,
} from './helpers/integration-harness.js'

setTestEnv()

const { userRouter } = await import('../controllers/user.controller.js')

const PASSWORD = 'correct-password-123'
const NEW_PASSWORD = 'brand-new-password-456'

/** Insert a node-pool folder and return its id. */
function seedNodePoolFolder(
  t: TestDatabase,
  userId: number,
  name = 'Folder',
  parentId: number | null = null,
  sortOrder = 0,
): number {
  const now = Math.floor(Date.now() / 1000)
  return Number(
    t.raw
      .prepare(
        'INSERT INTO node_pool_folders (user_id, name, parent_id, sort_order, collapsed, created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(userId, name, parentId, sortOrder, 0, now).lastInsertRowid,
  )
}

/** Insert a node-pool card and return its id. */
function seedNodeCard(
  t: TestDatabase,
  userId: number,
  name = 'Node',
  opts: { content?: string; folderId?: number | null; useCount?: number; sortOrder?: number } = {},
): number {
  const now = Math.floor(Date.now() / 1000)
  return Number(
    t.raw
      .prepare(
        'INSERT INTO node_cards (user_id, name, content, type, color, use_count, created_by, folder_id, sort_order, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        userId,
        name,
        opts.content ?? 'content',
        'text',
        '#ffffff',
        opts.useCount ?? 0,
        userId,
        opts.folderId ?? null,
        opts.sortOrder ?? 0,
        now,
      ).lastInsertRowid,
  )
}

describe('user.controller (integration, real router + real DB)', () => {
  let app: express.Express
  let t: TestDatabase
  let userId: number
  let otherId: number

  beforeEach(async () => {
    t = createTestDatabase()
    app = buildApp('/api/users', userRouter)

    userId = seedUser(t.raw, 'me@test.com', await bcrypt.hash(PASSWORD, 10), 'Me')
    otherId = seedUser(t.raw, 'other@test.com', await bcrypt.hash(PASSWORD, 10), 'Other')
  })

  describe('GET /profile', () => {
    it('returns the caller profile without the password', async () => {
      const res = await supertest(app).get('/api/users/profile').set(authHeader(userId))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.id).toBe(userId)
      expect(res.body.data.email).toBe('me@test.com')
      expect(res.body.data.nickname).toBe('Me')
      expect(res.body.data).not.toHaveProperty('password')
      expect(JSON.stringify(res.body)).not.toContain('$2b$')
    })

    it('returns 401 without a token', async () => {
      const res = await supertest(app).get('/api/users/profile')

      expect(res.status).toBe(401)
      expect(res.body.success).toBe(false)
    })

    it('returns 401 for a token whose user was deleted', async () => {
      const ghostId = seedUser(t.raw, 'ghost@test.com', 'hash')
      t.raw.prepare('DELETE FROM users WHERE id = ?').run(ghostId)

      const res = await supertest(app).get('/api/users/profile').set(authHeader(ghostId))

      expect(res.status).toBe(401)
      expect(res.body.success).toBe(false)
    })

    it('returns 401 for a token signed with the wrong secret', async () => {
      const badToken = jwt.sign({ userId }, 'a-different-secret', { expiresIn: '1h' })

      const res = await supertest(app)
        .get('/api/users/profile')
        .set('Authorization', `Bearer ${badToken}`)

      expect(res.status).toBe(401)
      expect(res.body.success).toBe(false)
    })
  })

  describe('PUT /profile', () => {
    it('updates the nickname and persists it', async () => {
      const res = await supertest(app)
        .put('/api/users/profile')
        .set(authHeader(userId))
        .send({ nickname: 'Renamed' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.nickname).toBe('Renamed')
      expect(readColumn<string>(t.raw, 'SELECT nickname FROM users WHERE id = ?', userId)).toBe(
        'Renamed',
      )
    })

    it('updates the avatar and persists it', async () => {
      const res = await supertest(app)
        .put('/api/users/profile')
        .set(authHeader(userId))
        .send({ avatar: 'https://example.com/a.png' })

      expect(res.status).toBe(200)
      expect(
        readColumn<string>(t.raw, 'SELECT avatar FROM users WHERE id = ?', userId),
      ).toBe('https://example.com/a.png')
    })

    it('leaves omitted fields untouched', async () => {
      // Regression guard for the B8 bug: `nickname || null` used to clear every
      // field the request did not mention.
      t.raw
        .prepare('UPDATE users SET avatar = ? WHERE id = ?')
        .run('https://example.com/keep.png', userId)

      await supertest(app)
        .put('/api/users/profile')
        .set(authHeader(userId))
        .send({ nickname: 'OnlyNick' })

      expect(readColumn<string>(t.raw, 'SELECT avatar FROM users WHERE id = ?', userId)).toBe(
        'https://example.com/keep.png',
      )
      expect(readColumn<string>(t.raw, 'SELECT nickname FROM users WHERE id = ?', userId)).toBe(
        'OnlyNick',
      )
    })

    it('clears a field when it is explicitly null', async () => {
      await supertest(app)
        .put('/api/users/profile')
        .set(authHeader(userId))
        .send({ nickname: 'Temp' })
      await supertest(app).put('/api/users/profile').set(authHeader(userId)).send({ nickname: null })

      expect(
        readColumn<string | null>(t.raw, 'SELECT nickname FROM users WHERE id = ?', userId),
      ).toBeNull()
    })

    it('never lets the caller edit another user', async () => {
      await supertest(app)
        .put('/api/users/profile')
        .set(authHeader(userId))
        .send({ nickname: 'MineOnly' })

      expect(readColumn<string>(t.raw, 'SELECT nickname FROM users WHERE id = ?', otherId)).toBe('Other')
    })

    it('rejects an unauthenticated update and writes nothing', async () => {
      const res = await supertest(app).put('/api/users/profile').send({ nickname: 'Anon' })

      expect(res.status).toBe(401)
      expect(readColumn<string>(t.raw, 'SELECT nickname FROM users WHERE id = ?', userId)).toBe('Me')
    })
  })

  describe('POST /avatar', () => {
    it('points the caller at the file upload endpoint', async () => {
      const res = await supertest(app).post('/api/users/avatar').set(authHeader(userId))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(false)
      expect(res.body.error).toContain('/api/files/upload')
    })

    it('rejects an unauthenticated call with 401', async () => {
      const res = await supertest(app).post('/api/users/avatar')

      expect(res.status).toBe(401)
    })
  })

  describe('PUT /password', () => {
    it('changes the stored hash so the old password no longer verifies', async () => {
      const before = readColumn<string>(t.raw, 'SELECT password FROM users WHERE id = ?', userId)
      expect(await bcrypt.compare(PASSWORD, before as string)).toBe(true)

      const res = await supertest(app)
        .put('/api/users/password')
        .set(authHeader(userId))
        .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)

      const after = readColumn<string>(t.raw, 'SELECT password FROM users WHERE id = ?', userId)
      expect(after).not.toBe(before)
      expect(await bcrypt.compare(NEW_PASSWORD, after as string)).toBe(true)
      expect(await bcrypt.compare(PASSWORD, after as string)).toBe(false)
    })

    it('rejects a wrong current password with 401 and keeps the hash', async () => {
      const before = readColumn<string>(t.raw, 'SELECT password FROM users WHERE id = ?', userId)

      const res = await supertest(app)
        .put('/api/users/password')
        .set(authHeader(userId))
        .send({ currentPassword: 'not-the-password', newPassword: NEW_PASSWORD })

      expect(res.status).toBe(401)
      expect(res.body.success).toBe(false)
      expect(readColumn<string>(t.raw, 'SELECT password FROM users WHERE id = ?', userId)).toBe(before)
    })

    it('returns 400 when the current password is missing', async () => {
      const before = readColumn<string>(t.raw, 'SELECT password FROM users WHERE id = ?', userId)
      const res = await supertest(app)
        .put('/api/users/password')
        .set(authHeader(userId))
        .send({ newPassword: NEW_PASSWORD })

      expect(res.status).toBe(400)
      expect(readColumn<string>(t.raw, 'SELECT password FROM users WHERE id = ?', userId)).toBe(before)
    })

    it('returns 400 when the new password is missing', async () => {
      const res = await supertest(app)
        .put('/api/users/password')
        .set(authHeader(userId))
        .send({ currentPassword: PASSWORD })

      expect(res.status).toBe(400)
    })

    it('returns 400 when the new password is too short', async () => {
      const before = readColumn<string>(t.raw, 'SELECT password FROM users WHERE id = ?', userId)
      const res = await supertest(app)
        .put('/api/users/password')
        .set(authHeader(userId))
        .send({ currentPassword: PASSWORD, newPassword: 'short' })

      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
      expect(readColumn<string>(t.raw, 'SELECT password FROM users WHERE id = ?', userId)).toBe(before)
    })

    it('rejects an unauthenticated change and keeps the hash', async () => {
      const before = readColumn<string>(t.raw, 'SELECT password FROM users WHERE id = ?', userId)
      const res = await supertest(app)
        .put('/api/users/password')
        .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })

      expect(res.status).toBe(401)
      expect(readColumn<string>(t.raw, 'SELECT password FROM users WHERE id = ?', userId)).toBe(before)
    })
  })

  describe('DELETE /account', () => {
    it('deletes the account and its owned data', async () => {
      const projectId = seedProject(t.raw, userId, 'Owned')
      seedCanvas(t.raw, projectId, 'C')
      seedFolder(t.raw, projectId, 'F')
      seedMember(t.raw, projectId, otherId, 'editor')
      seedNodePoolFolder(t, userId, 'NPF')
      seedNodeCard(t, userId, 'NC')
      t.raw
        .prepare('INSERT INTO settings (user_id, key, value, category) VALUES (?,?,?,?)')
        .run(userId, 'node_defaults', '{}', 'node')

      const res = await supertest(app)
        .delete('/api/users/account')
        .set(authHeader(userId))
        .send({ confirmation: 'DELETE', password: PASSWORD })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.message).toBe('Account deleted successfully')

      expect(countRows(t.raw, 'users', 'id = ?', userId)).toBe(0)
      expect(countRows(t.raw, 'projects', 'owner_id = ?', userId)).toBe(0)
      expect(countRows(t.raw, 'canvases', 'project_id = ?', projectId)).toBe(0)
      expect(countRows(t.raw, 'folders', 'project_id = ?', projectId)).toBe(0)
      expect(countRows(t.raw, 'node_cards', 'user_id = ?', userId)).toBe(0)
      expect(countRows(t.raw, 'node_pool_folders', 'user_id = ?', userId)).toBe(0)
      expect(countRows(t.raw, 'settings', 'user_id = ?', userId)).toBe(0)
      // The other account survives.
      expect(countRows(t.raw, 'users', 'id = ?', otherId)).toBe(1)
    })

    it('detaches projects from groups the user owns instead of cascading them away', async () => {
      const groupId = Number(
        t.raw
          .prepare('INSERT INTO groups (name, owner_id, invite_code) VALUES (?,?,?)')
          .run('G', userId, 'INV-1').lastInsertRowid,
      )
      const projectId = seedProject(t.raw, userId, 'Grouped')
      t.raw.prepare('UPDATE projects SET group_id = ? WHERE id = ?').run(groupId, projectId)

      const res = await supertest(app)
        .delete('/api/users/account')
        .set(authHeader(userId))
        .send({ confirmation: 'DELETE', password: PASSWORD })

      expect(res.status).toBe(200)
      expect(countRows(t.raw, 'groups', 'id = ?', groupId)).toBe(0)
      expect(countRows(t.raw, 'projects', 'id = ?', projectId)).toBe(0)
    })

    it('returns 400 without the DELETE confirmation and keeps the account', async () => {
      const res = await supertest(app)
        .delete('/api/users/account')
        .set(authHeader(userId))
        .send({ password: PASSWORD })

      expect(res.status).toBe(400)
      expect(countRows(t.raw, 'users', 'id = ?', userId)).toBe(1)
    })

    it('returns 400 for a wrong confirmation text', async () => {
      const res = await supertest(app)
        .delete('/api/users/account')
        .set(authHeader(userId))
        .send({ confirmation: 'WRONG', password: PASSWORD })

      expect(res.status).toBe(400)
      expect(countRows(t.raw, 'users', 'id = ?', userId)).toBe(1)
    })

    it('returns 400 when the password is missing', async () => {
      const res = await supertest(app)
        .delete('/api/users/account')
        .set(authHeader(userId))
        .send({ confirmation: 'DELETE' })

      expect(res.status).toBe(400)
      expect(countRows(t.raw, 'users', 'id = ?', userId)).toBe(1)
    })

    it('returns 401 for a wrong password and keeps the account', async () => {
      const res = await supertest(app)
        .delete('/api/users/account')
        .set(authHeader(userId))
        .send({ confirmation: 'DELETE', password: 'wrong-password' })

      expect(res.status).toBe(401)
      expect(countRows(t.raw, 'users', 'id = ?', userId)).toBe(1)
    })

    it('rejects an unauthenticated delete', async () => {
      const res = await supertest(app)
        .delete('/api/users/account')
        .send({ confirmation: 'DELETE', password: PASSWORD })

      expect(res.status).toBe(401)
      expect(countRows(t.raw, 'users', 'id = ?', userId)).toBe(1)
    })
  })

  describe('GET /settings/node-defaults', () => {
    it('returns the shared defaults when the user has no override', async () => {
      const res = await supertest(app)
        .get('/api/users/settings/node-defaults')
        .set(authHeader(userId))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.textNode.width).toBe(200)
      expect(res.body.data.textNode.height).toBe(160)
      expect(res.body.data.imageNode.fontSize).toBe(14)
    })

    it('merges a stored override over the shared defaults', async () => {
      t.raw
        .prepare('INSERT INTO settings (user_id, key, value, category) VALUES (?,?,?,?)')
        .run(userId, 'node_defaults', JSON.stringify({ textNode: { width: 320 } }), 'node')

      const res = await supertest(app)
        .get('/api/users/settings/node-defaults')
        .set(authHeader(userId))

      expect(res.status).toBe(200)
      expect(res.body.data.textNode.width).toBe(320)
      // Untouched keys keep the shared default.
      expect(res.body.data.textNode.height).toBe(160)
    })

    it('falls back to the defaults when the stored value is corrupt JSON', async () => {
      t.raw
        .prepare('INSERT INTO settings (user_id, key, value, category) VALUES (?,?,?,?)')
        .run(userId, 'node_defaults', '{not json', 'node')

      const res = await supertest(app)
        .get('/api/users/settings/node-defaults')
        .set(authHeader(userId))

      expect(res.status).toBe(200)
      expect(res.body.data.textNode.width).toBe(200)
    })

    it('does not leak another user settings', async () => {
      t.raw
        .prepare('INSERT INTO settings (user_id, key, value, category) VALUES (?,?,?,?)')
        .run(otherId, 'node_defaults', JSON.stringify({ textNode: { width: 999 } }), 'node')

      const res = await supertest(app)
        .get('/api/users/settings/node-defaults')
        .set(authHeader(userId))

      expect(res.status).toBe(200)
      expect(res.body.data.textNode.width).toBe(200)
    })

    it('rejects an unauthenticated request with 401', async () => {
      const res = await supertest(app).get('/api/users/settings/node-defaults')

      expect(res.status).toBe(401)
    })
  })

  describe('PUT /settings/node-defaults', () => {
    const validBody = {
      textNode: { width: 250, height: 180, fontSize: 16 },
      imageNode: { width: 220, height: 150, fontSize: 12 },
    }

    it('stores the settings and returns the normalized numbers', async () => {
      const res = await supertest(app)
        .put('/api/users/settings/node-defaults')
        .set(authHeader(userId))
        .send(validBody)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.textNode.width).toBe(250)

      const stored = readColumn<string>(
        t.raw,
        'SELECT value FROM settings WHERE user_id = ? AND key = ?',
        userId,
        'node_defaults',
      )
      expect(typeof stored).toBe('string')
      expect(stored).toContain('250')
      const parsed = JSON.parse(stored as string) as { textNode: { width: number } }
      expect(parsed.textNode.width).toBe(250)
    })

    it('normalizes numeric strings to numbers before storing', async () => {
      const res = await supertest(app)
        .put('/api/users/settings/node-defaults')
        .set(authHeader(userId))
        .send({
          textNode: { width: '300', height: '200', fontSize: '20' },
          imageNode: { width: '210', height: '170', fontSize: '15' },
        })

      expect(res.status).toBe(200)
      const parsed = JSON.parse(
        readColumn<string>(
          t.raw,
          'SELECT value FROM settings WHERE user_id = ? AND key = ?',
          userId,
          'node_defaults',
        ) as string,
      ) as { textNode: { width: number } }
      expect(parsed.textNode.width).toBe(300)
    })

    it('updates an existing settings row instead of inserting a second one', async () => {
      await supertest(app)
        .put('/api/users/settings/node-defaults')
        .set(authHeader(userId))
        .send(validBody)
      await supertest(app)
        .put('/api/users/settings/node-defaults')
        .set(authHeader(userId))
        .send({ ...validBody, textNode: { width: 400, height: 180, fontSize: 16 } })

      expect(countRows(t.raw, 'settings', 'user_id = ? AND key = ?', userId, 'node_defaults')).toBe(1)
      const parsed = JSON.parse(
        readColumn<string>(
          t.raw,
          'SELECT value FROM settings WHERE user_id = ? AND key = ?',
          userId,
          'node_defaults',
        ) as string,
      ) as { textNode: { width: number } }
      expect(parsed.textNode.width).toBe(400)
    })

    it('returns 400 when textNode or imageNode is missing', async () => {
      const res = await supertest(app)
        .put('/api/users/settings/node-defaults')
        .set(authHeader(userId))
        .send({ textNode: validBody.textNode })

      expect(res.status).toBe(400)
      expect(countRows(t.raw, 'settings', 'user_id = ?', userId)).toBe(0)
    })

    it('returns 400 for a width below the minimum', async () => {
      const res = await supertest(app)
        .put('/api/users/settings/node-defaults')
        .set(authHeader(userId))
        .send({ ...validBody, textNode: { width: 10, height: 180, fontSize: 16 } })

      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
      expect(countRows(t.raw, 'settings', 'user_id = ?', userId)).toBe(0)
    })

    it('returns 400 for a fontSize above the maximum', async () => {
      const res = await supertest(app)
        .put('/api/users/settings/node-defaults')
        .set(authHeader(userId))
        .send({ ...validBody, imageNode: { width: 220, height: 150, fontSize: 999 } })

      expect(res.status).toBe(400)
    })

    it('returns 400 for a non-numeric width', async () => {
      const res = await supertest(app)
        .put('/api/users/settings/node-defaults')
        .set(authHeader(userId))
        .send({ ...validBody, textNode: { width: 'wide', height: 180, fontSize: 16 } })

      expect(res.status).toBe(400)
    })

    it('returns 400 for a non-numeric fontSize', async () => {
      const res = await supertest(app)
        .put('/api/users/settings/node-defaults')
        .set(authHeader(userId))
        .send({ ...validBody, textNode: { width: 250, height: 180, fontSize: 'big' } })

      expect(res.status).toBe(400)
    })

    it('returns 400 for a blank fontSize string', async () => {
      const res = await supertest(app)
        .put('/api/users/settings/node-defaults')
        .set(authHeader(userId))
        .send({ ...validBody, imageNode: { width: 220, height: 150, fontSize: '   ' } })

      expect(res.status).toBe(400)
    })

    it('rejects an unauthenticated update and writes nothing', async () => {
      const res = await supertest(app).put('/api/users/settings/node-defaults').send(validBody)

      expect(res.status).toBe(401)
      expect(countRows(t.raw, 'settings', 'user_id = ?', userId)).toBe(0)
    })
  })

  describe('GET /search', () => {
    it('finds users by email substring', async () => {
      const res = await supertest(app).get('/api/users/search?q=other').set(authHeader(userId))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data).toHaveLength(1)
      expect(res.body.data[0].email).toBe('other@test.com')
      expect(res.body.data[0]).not.toHaveProperty('password')
    })

    it('finds users by nickname substring', async () => {
      const res = await supertest(app).get('/api/users/search?q=Oth').set(authHeader(userId))

      expect(res.status).toBe(200)
      expect(res.body.data.map((u: { id: number }) => u.id)).toEqual([otherId])
    })

    it('returns an empty array for a blank query', async () => {
      const res = await supertest(app).get('/api/users/search?q=').set(authHeader(userId))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data).toEqual([])
    })

    it('returns an empty array when nothing matches', async () => {
      const res = await supertest(app).get('/api/users/search?q=zzz-no-such').set(authHeader(userId))

      expect(res.status).toBe(200)
      expect(res.body.data).toEqual([])
    })

    it('rejects an unauthenticated search with 401', async () => {
      const res = await supertest(app).get('/api/users/search?q=other')

      expect(res.status).toBe(401)
    })
  })

  describe('node pool — GET /node-pool', () => {
    it('returns only the caller nodes, ordered by useCount desc', async () => {
      const low = seedNodeCard(t, userId, 'Low', { useCount: 1 })
      const high = seedNodeCard(t, userId, 'High', { useCount: 9 })
      seedNodeCard(t, otherId, 'Theirs', { useCount: 100 })

      const res = await supertest(app).get('/api/users/node-pool').set(authHeader(userId))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data).toHaveLength(2)
      expect(res.body.data.map((n: { id: number }) => n.id)).toEqual([high, low])
    })

    it('returns an empty array for a user with no nodes', async () => {
      const res = await supertest(app).get('/api/users/node-pool').set(authHeader(userId))

      expect(res.status).toBe(200)
      expect(res.body.data).toEqual([])
    })

    it('rejects an unauthenticated request with 401', async () => {
      const res = await supertest(app).get('/api/users/node-pool')

      expect(res.status).toBe(401)
    })
  })

  describe('node pool — POST /node-pool', () => {
    it('creates a node owned by the caller and persists it', async () => {
      const res = await supertest(app)
        .post('/api/users/node-pool')
        .set(authHeader(userId))
        .send({ name: 'Card', content: '{"a":1}', type: 'image', color: '#123456' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.name).toBe('Card')
      expect(countRows(t.raw, 'node_cards', 'user_id = ?', userId)).toBe(1)
      expect(readColumn<string>(t.raw, 'SELECT name FROM node_cards WHERE user_id = ?', userId)).toBe(
        'Card',
      )
      expect(readColumn<string>(t.raw, 'SELECT type FROM node_cards WHERE user_id = ?', userId)).toBe(
        'image',
      )
      expect(readColumn<string>(t.raw, 'SELECT color FROM node_cards WHERE user_id = ?', userId)).toBe(
        '#123456',
      )
    })

    it('defaults type and color', async () => {
      await supertest(app)
        .post('/api/users/node-pool')
        .set(authHeader(userId))
        .send({ name: 'Bare', content: 'c' })

      expect(readColumn<string>(t.raw, 'SELECT type FROM node_cards WHERE user_id = ?', userId)).toBe(
        'text',
      )
      expect(readColumn<string>(t.raw, 'SELECT color FROM node_cards WHERE user_id = ?', userId)).toBe(
        '#ffffff',
      )
    })

    it('attaches the node to an owned folder', async () => {
      const folderId = seedNodePoolFolder(t, userId, 'F')

      const res = await supertest(app)
        .post('/api/users/node-pool')
        .set(authHeader(userId))
        .send({ name: 'InFolder', content: 'c', folderId })

      expect(res.status).toBe(200)
      expect(
        readColumn<number>(t.raw, 'SELECT folder_id FROM node_cards WHERE user_id = ?', userId),
      ).toBe(folderId)
    })

    it('refuses to attach a node to another user folder', async () => {
      const theirs = seedNodePoolFolder(t, otherId, 'Theirs')

      const res = await supertest(app)
        .post('/api/users/node-pool')
        .set(authHeader(userId))
        .send({ name: 'Sneaky', content: 'c', folderId: theirs })

      expect(res.status).toBe(400)
      expect(countRows(t.raw, 'node_cards', 'user_id = ?', userId)).toBe(0)
    })

    it('returns 400 when name or content is missing', async () => {
      const res = await supertest(app)
        .post('/api/users/node-pool')
        .set(authHeader(userId))
        .send({ name: 'NoContent' })

      expect(res.status).toBe(400)
      expect(countRows(t.raw, 'node_cards')).toBe(0)
    })

    it('returns 400 for a blank name', async () => {
      const res = await supertest(app)
        .post('/api/users/node-pool')
        .set(authHeader(userId))
        .send({ name: '   ', content: 'c' })

      expect(res.status).toBe(400)
      expect(countRows(t.raw, 'node_cards')).toBe(0)
    })

    it('returns 400 for a name longer than 200 characters', async () => {
      const res = await supertest(app)
        .post('/api/users/node-pool')
        .set(authHeader(userId))
        .send({ name: 'a'.repeat(201), content: 'c' })

      expect(res.status).toBe(400)
      expect(countRows(t.raw, 'node_cards')).toBe(0)
    })

    it('returns 400 for content longer than 5000 characters', async () => {
      const res = await supertest(app)
        .post('/api/users/node-pool')
        .set(authHeader(userId))
        .send({ name: 'Big', content: 'c'.repeat(5001) })

      expect(res.status).toBe(400)
      expect(countRows(t.raw, 'node_cards')).toBe(0)
    })

    it('returns 400 for a non-numeric folderId', async () => {
      const res = await supertest(app)
        .post('/api/users/node-pool')
        .set(authHeader(userId))
        .send({ name: 'Bad', content: 'c', folderId: 'not-a-number' })

      expect(res.status).toBe(400)
      expect(countRows(t.raw, 'node_cards')).toBe(0)
    })

    it('rejects an unauthenticated create and writes nothing', async () => {
      const res = await supertest(app)
        .post('/api/users/node-pool')
        .send({ name: 'Anon', content: 'c' })

      expect(res.status).toBe(401)
      expect(countRows(t.raw, 'node_cards')).toBe(0)
    })
  })

  describe('node pool — PUT /node-pool/:id', () => {
    it('renames the caller node and persists it', async () => {
      const nodeId = seedNodeCard(t, userId, 'Before')

      const res = await supertest(app)
        .put(`/api/users/node-pool/${nodeId}`)
        .set(authHeader(userId))
        .send({ name: 'After', description: 'D', sortOrder: 5 })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(readColumn<string>(t.raw, 'SELECT name FROM node_cards WHERE id = ?', nodeId)).toBe('After')
      expect(readColumn<string>(t.raw, 'SELECT description FROM node_cards WHERE id = ?', nodeId)).toBe(
        'D',
      )
      expect(readColumn<number>(t.raw, 'SELECT sort_order FROM node_cards WHERE id = ?', nodeId)).toBe(5)
    })

    it('moves the node into an owned folder', async () => {
      const nodeId = seedNodeCard(t, userId, 'Mover')
      const folderId = seedNodePoolFolder(t, userId, 'Target')

      await supertest(app)
        .put(`/api/users/node-pool/${nodeId}`)
        .set(authHeader(userId))
        .send({ folderId })

      expect(readColumn<number>(t.raw, 'SELECT folder_id FROM node_cards WHERE id = ?', nodeId)).toBe(
        folderId,
      )
    })

    it('returns 403 for another user node and leaves it unchanged', async () => {
      const nodeId = seedNodeCard(t, otherId, 'Theirs')

      const res = await supertest(app)
        .put(`/api/users/node-pool/${nodeId}`)
        .set(authHeader(userId))
        .send({ name: 'Stolen' })

      expect(res.status).toBe(403)
      expect(readColumn<string>(t.raw, 'SELECT name FROM node_cards WHERE id = ?', nodeId)).toBe(
        'Theirs',
      )
    })

    it('returns 404 for a node that does not exist', async () => {
      const res = await supertest(app)
        .put('/api/users/node-pool/999999')
        .set(authHeader(userId))
        .send({ name: 'Ghost' })

      expect(res.status).toBe(404)
    })

    it('returns 400 for a non-numeric node id', async () => {
      const res = await supertest(app)
        .put('/api/users/node-pool/abc')
        .set(authHeader(userId))
        .send({ name: 'X' })

      expect(res.status).toBe(400)
    })

    it('returns 400 for a blank name', async () => {
      const nodeId = seedNodeCard(t, userId, 'Keep')

      const res = await supertest(app)
        .put(`/api/users/node-pool/${nodeId}`)
        .set(authHeader(userId))
        .send({ name: '  ' })

      expect(res.status).toBe(400)
      expect(readColumn<string>(t.raw, 'SELECT name FROM node_cards WHERE id = ?', nodeId)).toBe('Keep')
    })

    it('returns 400 when moving into another user folder', async () => {
      const nodeId = seedNodeCard(t, userId, 'Mine')
      const theirs = seedNodePoolFolder(t, otherId, 'Theirs')

      const res = await supertest(app)
        .put(`/api/users/node-pool/${nodeId}`)
        .set(authHeader(userId))
        .send({ folderId: theirs })

      expect(res.status).toBe(400)
      expect(
        readColumn<number | null>(t.raw, 'SELECT folder_id FROM node_cards WHERE id = ?', nodeId),
      ).toBeNull()
    })

    it('returns 400 when moving into a folder that does not exist', async () => {
      const nodeId = seedNodeCard(t, userId, 'Mine')

      const res = await supertest(app)
        .put(`/api/users/node-pool/${nodeId}`)
        .set(authHeader(userId))
        .send({ folderId: 999999 })

      expect(res.status).toBe(400)
      expect(
        readColumn<number | null>(t.raw, 'SELECT folder_id FROM node_cards WHERE id = ?', nodeId),
      ).toBeNull()
    })

    it('returns 400 for a non-numeric folderId', async () => {
      const nodeId = seedNodeCard(t, userId, 'Mine')

      const res = await supertest(app)
        .put(`/api/users/node-pool/${nodeId}`)
        .set(authHeader(userId))
        .send({ folderId: 'not-a-number' })

      expect(res.status).toBe(400)
    })

    it('detaches the node from its folder with an explicit null', async () => {
      const folderId = seedNodePoolFolder(t, userId, 'Home')
      const nodeId = seedNodeCard(t, userId, 'Attached', { folderId })

      await supertest(app)
        .put(`/api/users/node-pool/${nodeId}`)
        .set(authHeader(userId))
        .send({ folderId: null })

      expect(
        readColumn<number | null>(t.raw, 'SELECT folder_id FROM node_cards WHERE id = ?', nodeId),
      ).toBeNull()
    })

    it('rejects an unauthenticated update and leaves the row unchanged', async () => {
      const nodeId = seedNodeCard(t, userId, 'Safe')

      const res = await supertest(app).put(`/api/users/node-pool/${nodeId}`).send({ name: 'Anon' })

      expect(res.status).toBe(401)
      expect(readColumn<string>(t.raw, 'SELECT name FROM node_cards WHERE id = ?', nodeId)).toBe('Safe')
    })
  })

  describe('node pool — DELETE /node-pool/:id', () => {
    it('deletes the caller node', async () => {
      const nodeId = seedNodeCard(t, userId, 'Doomed')

      const res = await supertest(app)
        .delete(`/api/users/node-pool/${nodeId}`)
        .set(authHeader(userId))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(countRows(t.raw, 'node_cards', 'id = ?', nodeId)).toBe(0)
    })

    it('returns 403 for another user node and keeps the row', async () => {
      const nodeId = seedNodeCard(t, otherId, 'Theirs')

      const res = await supertest(app)
        .delete(`/api/users/node-pool/${nodeId}`)
        .set(authHeader(userId))

      expect(res.status).toBe(403)
      expect(countRows(t.raw, 'node_cards', 'id = ?', nodeId)).toBe(1)
    })

    it('returns 404 for a node that does not exist', async () => {
      const res = await supertest(app)
        .delete('/api/users/node-pool/999999')
        .set(authHeader(userId))

      expect(res.status).toBe(404)
    })

    it('returns 400 for a non-numeric node id', async () => {
      const res = await supertest(app).delete('/api/users/node-pool/nope').set(authHeader(userId))

      expect(res.status).toBe(400)
    })

    it('rejects an unauthenticated delete and keeps the row', async () => {
      const nodeId = seedNodeCard(t, userId, 'Safe')

      const res = await supertest(app).delete(`/api/users/node-pool/${nodeId}`)

      expect(res.status).toBe(401)
      expect(countRows(t.raw, 'node_cards', 'id = ?', nodeId)).toBe(1)
    })
  })

  describe('node pool — POST /node-pool/:id/increment-use', () => {
    it('increments useCount and persists it', async () => {
      const nodeId = seedNodeCard(t, userId, 'Counted', { useCount: 3 })

      const res = await supertest(app)
        .post(`/api/users/node-pool/${nodeId}/increment-use`)
        .set(authHeader(userId))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.useCount).toBe(4)
      expect(readColumn<number>(t.raw, 'SELECT use_count FROM node_cards WHERE id = ?', nodeId)).toBe(4)
    })

    it('returns 403 for another user node and does not increment it', async () => {
      const nodeId = seedNodeCard(t, otherId, 'Theirs', { useCount: 2 })

      const res = await supertest(app)
        .post(`/api/users/node-pool/${nodeId}/increment-use`)
        .set(authHeader(userId))

      expect(res.status).toBe(403)
      expect(readColumn<number>(t.raw, 'SELECT use_count FROM node_cards WHERE id = ?', nodeId)).toBe(2)
    })

    it('returns 404 for a node that does not exist', async () => {
      const res = await supertest(app)
        .post('/api/users/node-pool/999999/increment-use')
        .set(authHeader(userId))

      expect(res.status).toBe(404)
    })

    it('returns 400 for a non-numeric node id', async () => {
      const res = await supertest(app)
        .post('/api/users/node-pool/abc/increment-use')
        .set(authHeader(userId))

      expect(res.status).toBe(400)
    })

    it('rejects an unauthenticated call', async () => {
      const nodeId = seedNodeCard(t, userId, 'Counted', { useCount: 1 })

      const res = await supertest(app).post(`/api/users/node-pool/${nodeId}/increment-use`)

      expect(res.status).toBe(401)
      expect(readColumn<number>(t.raw, 'SELECT use_count FROM node_cards WHERE id = ?', nodeId)).toBe(1)
    })
  })

  describe('node pool folders — GET /node-pool-folders', () => {
    it('returns only the caller folders, ordered by sortOrder', async () => {
      const second = seedNodePoolFolder(t, userId, 'Second', null, 2)
      const first = seedNodePoolFolder(t, userId, 'First', null, 1)
      seedNodePoolFolder(t, otherId, 'Theirs', null, 0)

      const res = await supertest(app).get('/api/users/node-pool-folders').set(authHeader(userId))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.map((f: { id: number }) => f.id)).toEqual([first, second])
    })

    it('rejects an unauthenticated request with 401', async () => {
      const res = await supertest(app).get('/api/users/node-pool-folders')

      expect(res.status).toBe(401)
    })
  })

  describe('node pool folders — POST /node-pool-folders', () => {
    it('creates a root folder owned by the caller', async () => {
      const res = await supertest(app)
        .post('/api/users/node-pool-folders')
        .set(authHeader(userId))
        .send({ name: 'New Folder' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.name).toBe('New Folder')
      expect(countRows(t.raw, 'node_pool_folders', 'user_id = ?', userId)).toBe(1)
      expect(
        readColumn<number | null>(
          t.raw,
          'SELECT parent_id FROM node_pool_folders WHERE user_id = ?',
          userId,
        ),
      ).toBeNull()
      expect(
        readColumn<number>(t.raw, 'SELECT collapsed FROM node_pool_folders WHERE user_id = ?', userId),
      ).toBe(1)
    })

    it('creates a nested folder under an owned parent', async () => {
      const parentId = seedNodePoolFolder(t, userId, 'Parent')

      const res = await supertest(app)
        .post('/api/users/node-pool-folders')
        .set(authHeader(userId))
        .send({ name: 'Child', parentId, collapsed: false })

      expect(res.status).toBe(200)
      expect(
        readColumn<number>(
          t.raw,
          'SELECT parent_id FROM node_pool_folders WHERE name = ?',
          'Child',
        ),
      ).toBe(parentId)
    })

    it('returns 404 for an unknown parent folder', async () => {
      const res = await supertest(app)
        .post('/api/users/node-pool-folders')
        .set(authHeader(userId))
        .send({ name: 'Orphan', parentId: 999999 })

      expect(res.status).toBe(404)
      expect(countRows(t.raw, 'node_pool_folders', 'name = ?', 'Orphan')).toBe(0)
    })

    it('returns 403 when the parent belongs to another user', async () => {
      const theirs = seedNodePoolFolder(t, otherId, 'Theirs')

      const res = await supertest(app)
        .post('/api/users/node-pool-folders')
        .set(authHeader(userId))
        .send({ name: 'Stolen', parentId: theirs })

      expect(res.status).toBe(403)
      expect(countRows(t.raw, 'node_pool_folders', 'name = ?', 'Stolen')).toBe(0)
    })

    it('returns 400 for a non-numeric parentId', async () => {
      const res = await supertest(app)
        .post('/api/users/node-pool-folders')
        .set(authHeader(userId))
        .send({ name: 'Bad', parentId: 'not-a-number' })

      expect(res.status).toBe(400)
    })

    it('rejects an unauthenticated create and writes nothing', async () => {
      const res = await supertest(app)
        .post('/api/users/node-pool-folders')
        .send({ name: 'Anon' })

      expect(res.status).toBe(401)
      expect(countRows(t.raw, 'node_pool_folders')).toBe(0)
    })
  })

  describe('node pool folders — PUT /node-pool-folders/:id', () => {
    it('renames the caller folder and persists it', async () => {
      const folderId = seedNodePoolFolder(t, userId, 'Old')

      const res = await supertest(app)
        .put(`/api/users/node-pool-folders/${folderId}`)
        .set(authHeader(userId))
        .send({ name: 'Renamed', collapsed: false })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(
        readColumn<string>(t.raw, 'SELECT name FROM node_pool_folders WHERE id = ?', folderId),
      ).toBe('Renamed')
      expect(
        readColumn<number>(t.raw, 'SELECT collapsed FROM node_pool_folders WHERE id = ?', folderId),
      ).toBe(0)
    })

    it('moves a folder under an owned parent', async () => {
      const folderId = seedNodePoolFolder(t, userId, 'Mover')
      const parentId = seedNodePoolFolder(t, userId, 'Target')

      const res = await supertest(app)
        .put(`/api/users/node-pool-folders/${folderId}`)
        .set(authHeader(userId))
        .send({ parentId })

      expect(res.status).toBe(200)
      expect(
        readColumn<number>(t.raw, 'SELECT parent_id FROM node_pool_folders WHERE id = ?', folderId),
      ).toBe(parentId)
    })

    it('moves a folder back to the root with an explicit null', async () => {
      const parentId = seedNodePoolFolder(t, userId, 'Parent')
      const folderId = seedNodePoolFolder(t, userId, 'Child', parentId)

      await supertest(app)
        .put(`/api/users/node-pool-folders/${folderId}`)
        .set(authHeader(userId))
        .send({ parentId: null })

      expect(
        readColumn<number | null>(
          t.raw,
          'SELECT parent_id FROM node_pool_folders WHERE id = ?',
          folderId,
        ),
      ).toBeNull()
    })

    it('returns 403 for another user folder and leaves it unchanged', async () => {
      const folderId = seedNodePoolFolder(t, otherId, 'Theirs')

      const res = await supertest(app)
        .put(`/api/users/node-pool-folders/${folderId}`)
        .set(authHeader(userId))
        .send({ name: 'Stolen' })

      expect(res.status).toBe(403)
      expect(
        readColumn<string>(t.raw, 'SELECT name FROM node_pool_folders WHERE id = ?', folderId),
      ).toBe('Theirs')
    })

    it('returns 404 for a folder that does not exist', async () => {
      const res = await supertest(app)
        .put('/api/users/node-pool-folders/999999')
        .set(authHeader(userId))
        .send({ name: 'Ghost' })

      expect(res.status).toBe(404)
    })

    it('returns 400 for a non-numeric folder id', async () => {
      const res = await supertest(app)
        .put('/api/users/node-pool-folders/abc')
        .set(authHeader(userId))
        .send({ name: 'X' })

      expect(res.status).toBe(400)
    })

    it('returns 400 when the parent is the folder itself', async () => {
      const folderId = seedNodePoolFolder(t, userId, 'Self')

      const res = await supertest(app)
        .put(`/api/users/node-pool-folders/${folderId}`)
        .set(authHeader(userId))
        .send({ parentId: folderId })

      expect(res.status).toBe(400)
      expect(
        readColumn<number | null>(
          t.raw,
          'SELECT parent_id FROM node_pool_folders WHERE id = ?',
          folderId,
        ),
      ).toBeNull()
    })

    it('returns 400 when moving a folder under its own descendant (cycle guard)', async () => {
      const parentId = seedNodePoolFolder(t, userId, 'Parent')
      const childId = seedNodePoolFolder(t, userId, 'Child', parentId)

      const res = await supertest(app)
        .put(`/api/users/node-pool-folders/${parentId}`)
        .set(authHeader(userId))
        .send({ parentId: childId })

      expect(res.status).toBe(400)
      expect(
        readColumn<number | null>(
          t.raw,
          'SELECT parent_id FROM node_pool_folders WHERE id = ?',
          parentId,
        ),
      ).toBeNull()
    })

    it('returns 404 for an unknown parent folder', async () => {
      const folderId = seedNodePoolFolder(t, userId, 'Mover')

      const res = await supertest(app)
        .put(`/api/users/node-pool-folders/${folderId}`)
        .set(authHeader(userId))
        .send({ parentId: 999999 })

      expect(res.status).toBe(404)
    })

    it('returns 400 for a non-numeric parentId', async () => {
      const folderId = seedNodePoolFolder(t, userId, 'Mover')

      const res = await supertest(app)
        .put(`/api/users/node-pool-folders/${folderId}`)
        .set(authHeader(userId))
        .send({ parentId: 'not-a-number' })

      expect(res.status).toBe(400)
      expect(
        readColumn<number | null>(
          t.raw,
          'SELECT parent_id FROM node_pool_folders WHERE id = ?',
          folderId,
        ),
      ).toBeNull()
    })

    it('returns 403 when the target parent belongs to another user', async () => {
      const folderId = seedNodePoolFolder(t, userId, 'Mine')
      const theirs = seedNodePoolFolder(t, otherId, 'Theirs')

      const res = await supertest(app)
        .put(`/api/users/node-pool-folders/${folderId}`)
        .set(authHeader(userId))
        .send({ parentId: theirs })

      expect(res.status).toBe(403)
    })

    it('rejects an unauthenticated update and leaves the row unchanged', async () => {
      const folderId = seedNodePoolFolder(t, userId, 'Safe')

      const res = await supertest(app)
        .put(`/api/users/node-pool-folders/${folderId}`)
        .send({ name: 'Anon' })

      expect(res.status).toBe(401)
      expect(
        readColumn<string>(t.raw, 'SELECT name FROM node_pool_folders WHERE id = ?', folderId),
      ).toBe('Safe')
    })
  })

  describe('node pool folders — DELETE /node-pool-folders/:id', () => {
    it('deletes the caller folder and cascades to subfolders', async () => {
      const parentId = seedNodePoolFolder(t, userId, 'Parent')
      const childId = seedNodePoolFolder(t, userId, 'Child', parentId)

      const res = await supertest(app)
        .delete(`/api/users/node-pool-folders/${parentId}`)
        .set(authHeader(userId))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(countRows(t.raw, 'node_pool_folders', 'id = ?', parentId)).toBe(0)
      expect(countRows(t.raw, 'node_pool_folders', 'id = ?', childId)).toBe(0)
    })

    it('moves cards in the deleted folder back to the root', async () => {
      const folderId = seedNodePoolFolder(t, userId, 'Doomed')
      const nodeId = seedNodeCard(t, userId, 'Card', { folderId })

      await supertest(app)
        .delete(`/api/users/node-pool-folders/${folderId}`)
        .set(authHeader(userId))

      expect(countRows(t.raw, 'node_pool_folders', 'id = ?', folderId)).toBe(0)
      expect(countRows(t.raw, 'node_cards', 'id = ?', nodeId)).toBe(1)
      expect(
        readColumn<number | null>(t.raw, 'SELECT folder_id FROM node_cards WHERE id = ?', nodeId),
      ).toBeNull()
    })

    it('returns 403 for another user folder and keeps it', async () => {
      const folderId = seedNodePoolFolder(t, otherId, 'Theirs')

      const res = await supertest(app)
        .delete(`/api/users/node-pool-folders/${folderId}`)
        .set(authHeader(userId))

      expect(res.status).toBe(403)
      expect(countRows(t.raw, 'node_pool_folders', 'id = ?', folderId)).toBe(1)
    })

    it('returns 404 for a folder that does not exist', async () => {
      const res = await supertest(app)
        .delete('/api/users/node-pool-folders/999999')
        .set(authHeader(userId))

      expect(res.status).toBe(404)
    })

    it('returns 400 for a non-numeric folder id', async () => {
      const res = await supertest(app).delete('/api/users/node-pool-folders/nope').set(authHeader(userId))

      expect(res.status).toBe(400)
    })

    it('rejects an unauthenticated delete and keeps the folder', async () => {
      const folderId = seedNodePoolFolder(t, userId, 'Safe')

      const res = await supertest(app).delete(`/api/users/node-pool-folders/${folderId}`)

      expect(res.status).toBe(401)
      expect(countRows(t.raw, 'node_pool_folders', 'id = ?', folderId)).toBe(1)
    })
  })
})
