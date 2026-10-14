/**
 * auth.middleware — REAL module, integration style.
 *
 * Replaces the deleted `__tests__/middleware.test.ts`, which imported no project
 * code at all: it defined its own inline `authenticate` fake, never awaited the
 * supertest call and asserted `expect(response).toBeDefined()`. All 26 of its
 * tests stayed green while the real middleware was broken.
 *
 * Everything below drives the real `authenticate` / `optionalAuth` mounted on a
 * real Express app, backed by a real in-memory SQLite database with real user
 * rows. Every assertion reads an actual HTTP response.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import express from 'express'
import jwt from 'jsonwebtoken'
import type { AuthRequest } from '../../middleware/auth.middleware.js'

vi.mock('../../utils/logger.js', () => ({ log: vi.fn(), logError: vi.fn() }))

vi.mock('../../database/connection.js', async () => {
  const { installDbMock } = await import('../helpers/integration-harness.js')
  return installDbMock()
})

import {
  authHeader,
  buildApp,
  createTestDatabase,
  seedUser,
  setTestEnv,
  signToken,
  type TestDatabase,
} from '../helpers/integration-harness.js'
import { logError } from '../../utils/logger.js'

setTestEnv()

const { authenticate, optionalAuth } = await import('../../middleware/auth.middleware.js')

/** Tiny app exposing the real middleware through real routes. */
function buildAuthApp(): express.Express {
  const router = express.Router()

  router.get('/protected', authenticate, (req, res) => {
    const authReq = req as AuthRequest
    res.json({ success: true, user: authReq.user ?? null })
  })

  router.get('/optional', optionalAuth, (req, res) => {
    const authReq = req as AuthRequest
    res.json({ success: true, user: authReq.user ?? null })
  })

  return buildApp('/api', router)
}

describe('auth.middleware (real module + real DB)', () => {
  let app: express.Express
  let t: TestDatabase

  beforeEach(() => {
    t = createTestDatabase()
    app = buildAuthApp()
  })

  describe('authenticate', () => {
    it('rejects a request with no Authorization header', async () => {
      const res = await supertest(app).get('/api/protected')

      expect(res.status).toBe(401)
      expect(res.body).toEqual({ success: false, error: '未提供令牌' })
    })

    it('rejects a malformed token', async () => {
      const res = await supertest(app)
        .get('/api/protected')
        .set('Authorization', 'Bearer not-a-real-jwt')

      expect(res.status).toBe(401)
      expect(res.body).toEqual({ success: false, error: '无效的令牌签名' })
    })

    it('rejects a token signed with the wrong secret', async () => {
      const userId = seedUser(t.raw, 'alice@test.com', 'hash', 'Alice')
      const foreignToken = jwt.sign({ userId }, 'a-completely-different-secret', {
        expiresIn: '1h',
      })

      const res = await supertest(app)
        .get('/api/protected')
        .set('Authorization', `Bearer ${foreignToken}`)

      expect(res.status).toBe(401)
      expect(res.body).toEqual({ success: false, error: '无效的令牌签名' })
    })

    it('rejects an expired token', async () => {
      const userId = seedUser(t.raw, 'alice@test.com', 'hash', 'Alice')

      const res = await supertest(app)
        .get('/api/protected')
        .set('Authorization', `Bearer ${signToken(userId, '-1s')}`)

      expect(res.status).toBe(401)
      expect(res.body).toEqual({ success: false, error: '令牌已过期' })
    })

    it('accepts a valid token and exposes the user on req.user', async () => {
      const userId = seedUser(t.raw, 'alice@test.com', 'hash', 'Alice')
      t.raw
        .prepare('UPDATE users SET avatar = ? WHERE id = ?')
        .run('https://cdn.test/avatar.png', userId)

      const res = await supertest(app).get('/api/protected').set(authHeader(userId))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.user).toEqual({
        id: userId,
        email: 'alice@test.com',
        nickname: 'Alice',
        avatar: 'https://cdn.test/avatar.png',
      })
      // Exactly the four documented fields — no password leak.
      expect(Object.keys(res.body.user).sort()).toEqual(['avatar', 'email', 'id', 'nickname'])
    })

    it('rejects a valid token whose user row no longer exists', async () => {
      const userId = seedUser(t.raw, 'ghost@test.com', 'hash', 'Ghost')
      const token = signToken(userId)
      t.raw.prepare('DELETE FROM users WHERE id = ?').run(userId)

      const res = await supertest(app)
        .get('/api/protected')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(401)
      expect(res.body).toEqual({ success: false, error: '用户不存在，令牌无效' })
    })

    it('returns 500 — not a misleading 401 — when the database query fails', async () => {
      const userId = seedUser(t.raw, 'dbfail@test.com', 'hash', 'DbFail')
      // A genuine SQLite failure: the table the middleware queries is gone.
      t.raw.exec('DROP TABLE users')

      const res = await supertest(app).get('/api/protected').set(authHeader(userId))

      expect(res.status).toBe(500)
      expect(res.body).toEqual({ success: false, error: '数据库错误，请稍后重试' })
      expect(logError).toHaveBeenCalled()
    })

    it('falls back to a 401 auth failure for non-SQLite errors', async () => {
      const userId = seedUser(t.raw, 'boom@test.com', 'hash', 'Boom')
      vi.spyOn(t.db.query.users, 'findFirst').mockImplementation(() => {
        throw new Error('unexpected, non-SQLite failure')
      })

      const res = await supertest(app).get('/api/protected').set(authHeader(userId))

      expect(res.status).toBe(401)
      expect(res.body).toEqual({ success: false, error: '认证失败，请重新登录' })
    })
  })

  describe('optionalAuth', () => {
    it('passes through without a token and leaves req.user unset', async () => {
      const res = await supertest(app).get('/api/optional')

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ success: true, user: null })
    })

    it('populates req.user when a valid token is present', async () => {
      const userId = seedUser(t.raw, 'bob@test.com', 'hash', 'Bob')

      const res = await supertest(app).get('/api/optional').set(authHeader(userId))

      expect(res.status).toBe(200)
      expect(res.body.user).toEqual({
        id: userId,
        email: 'bob@test.com',
        nickname: 'Bob',
        avatar: null,
      })
    })

    it('still rejects an invalid token (delegates to authenticate)', async () => {
      const res = await supertest(app)
        .get('/api/optional')
        .set('Authorization', 'Bearer garbage')

      expect(res.status).toBe(401)
      expect(res.body).toEqual({ success: false, error: '无效的令牌签名' })
    })
  })
})
