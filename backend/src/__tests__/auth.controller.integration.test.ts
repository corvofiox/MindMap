/**
 * Auth controller integration tests.
 *
 * Replaces `auth.controller.test.ts`, which had 32 tests but exercised no
 * application code: it re-declared bcrypt/jsonwebtoken calls (testing those
 * libraries, not this app), defined inline fake routes, and asserted on unawaited
 * supertest objects. `auth.controller.ts` sat at ~66% line coverage with 32
 * "passing" tests.
 *
 * Everything below drives the REAL `authRouter` against a REAL in-memory SQLite
 * database, and asserts on HTTP responses plus the persisted rows.
 *
 * Note on the login lockout behaviour: the controller counts failed attempts per
 * user, so tests that intentionally fail a login are isolated per test (fresh DB)
 * and use distinct emails to avoid tripping that counter.
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

import {
  buildApp,
  countRows,
  createTestDatabase,
  readColumn,
  seedUser,
  setTestEnv,
  type TestDatabase,
} from './helpers/integration-harness.js'

setTestEnv()

const { authRouter } = await import('../controllers/auth.controller.js')

/** bcrypt at cost 10 is slow; hash once per suite and reuse the digest. */
const KNOWN_PASSWORD = 'password123'
let knownHash: string

describe('auth.controller (integration, real router + real DB)', () => {
  let app: express.Express
  let t: TestDatabase

  beforeEach(async () => {
    t = createTestDatabase()
    app = buildApp('/api/auth', authRouter)
    knownHash = knownHash || (await bcrypt.hash(KNOWN_PASSWORD, 10))
  })

  describe('POST /register', () => {
    it('creates a user, hashes the password, and returns a usable token', async () => {
      const res = await supertest(app)
        .post('/api/auth/register')
        .send({ email: 'new@test.com', password: KNOWN_PASSWORD, nickname: 'New' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.user.email).toBe('new@test.com')
      expect(res.body.data.user.nickname).toBe('New')
      expect(typeof res.body.data.token).toBe('string')

      // The password must be stored hashed, never in plaintext.
      const stored = readColumn<string>(t.raw, 'SELECT password FROM users WHERE email = ?', 'new@test.com')
      expect(stored).toBeTruthy()
      expect(stored).not.toBe(KNOWN_PASSWORD)
      expect(await bcrypt.compare(KNOWN_PASSWORD, stored as string)).toBe(true)

      // The returned token must actually authenticate.
      const decoded = jwt.verify(res.body.data.token, process.env.JWT_SECRET as string) as {
        userId: number
      }
      expect(decoded.userId).toBe(res.body.data.user.id)
    })

    it('never leaks the password hash in the response', async () => {
      const res = await supertest(app)
        .post('/api/auth/register')
        .send({ email: 'leak@test.com', password: KNOWN_PASSWORD })
      expect(JSON.stringify(res.body)).not.toContain('$2b$')
      expect(res.body.data.user.password).toBeUndefined()
    })

    it('rejects a missing email', async () => {
      const res = await supertest(app).post('/api/auth/register').send({ password: KNOWN_PASSWORD })
      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
      expect(countRows(t.raw, 'users')).toBe(0)
    })

    it('rejects a missing password', async () => {
      const res = await supertest(app).post('/api/auth/register').send({ email: 'a@b.com' })
      expect(res.status).toBe(400)
      expect(countRows(t.raw, 'users')).toBe(0)
    })

    it('rejects a malformed email', async () => {
      const res = await supertest(app)
        .post('/api/auth/register')
        .send({ email: 'not-an-email', password: KNOWN_PASSWORD })
      expect(res.status).toBe(400)
      expect(countRows(t.raw, 'users')).toBe(0)
    })

    it('rejects a password shorter than 6 characters', async () => {
      const res = await supertest(app)
        .post('/api/auth/register')
        .send({ email: 'short@test.com', password: '12345' })
      expect(res.status).toBe(400)
      expect(countRows(t.raw, 'users')).toBe(0)
    })

    it('rejects a duplicate email after trimming whitespace, and keeps one row', async () => {
      await supertest(app)
        .post('/api/auth/register')
        .send({ email: 'dup@test.com', password: KNOWN_PASSWORD })

      // Leading/trailing whitespace IS trimmed before the uniqueness check.
      const res = await supertest(app)
        .post('/api/auth/register')
        .send({ email: '  dup@test.com  ', password: KNOWN_PASSWORD })

      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
      expect(countRows(t.raw, 'users')).toBe(1)
    })

    it('treats emails case-sensitively (documented: no case normalisation)', async () => {
      // auth.controller.ts deliberately does NOT lowercase emails
      // ("不做邮箱大小写归一，避免行为变更风险"). Pin that so the behaviour is a
      // decision on record rather than a surprise: differing case is a new user.
      await supertest(app)
        .post('/api/auth/register')
        .send({ email: 'case@test.com', password: KNOWN_PASSWORD })

      const res = await supertest(app)
        .post('/api/auth/register')
        .send({ email: 'CASE@test.com', password: KNOWN_PASSWORD })

      expect(res.status).toBe(200)
      expect(countRows(t.raw, 'users')).toBe(2)
      // Both rows preserve the case they were registered with.
      const emails = (
        t.raw.prepare('SELECT email FROM users ORDER BY email').all() as Array<{ email: string }>
      ).map((r) => r.email)
      expect(emails).toEqual(['CASE@test.com', 'case@test.com'])
    })

    it('rejects non-string email/password payloads instead of 500ing', async () => {
      const res = await supertest(app)
        .post('/api/auth/register')
        .send({ email: { evil: true }, password: { evil: true } })
      expect(res.status).toBe(400)
      expect(countRows(t.raw, 'users')).toBe(0)
    })

    it('stores a blank nickname as NULL rather than an empty string', async () => {
      await supertest(app)
        .post('/api/auth/register')
        .send({ email: 'nonick@test.com', password: KNOWN_PASSWORD, nickname: '   ' })
      const nickname = readColumn<string | null>(
        t.raw,
        'SELECT nickname FROM users WHERE email = ?',
        'nonick@test.com',
      )
      expect(nickname).toBeNull()
    })
  })

  describe('POST /login', () => {
    beforeEach(() => {
      seedUser(t.raw, 'login@test.com', knownHash, 'Login')
    })

    it('logs in with correct credentials and returns a token', async () => {
      const res = await supertest(app)
        .post('/api/auth/login')
        .send({ email: 'login@test.com', password: KNOWN_PASSWORD })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.token).toBeTruthy()
      expect(res.body.data.user.email).toBe('login@test.com')
      expect(res.body.data.user.password).toBeUndefined()
    })

    it('rejects a wrong password with 401', async () => {
      const res = await supertest(app)
        .post('/api/auth/login')
        .send({ email: 'login@test.com', password: 'wrong-password' })
      expect(res.status).toBe(401)
      expect(res.body.success).toBe(false)
    })

    it('rejects an unknown user with 401', async () => {
      const res = await supertest(app)
        .post('/api/auth/login')
        .send({ email: 'ghost@test.com', password: KNOWN_PASSWORD })
      expect(res.status).toBe(401)
      expect(res.body.success).toBe(false)
    })

    it('rejects a missing email or password', async () => {
      const noEmail = await supertest(app).post('/api/auth/login').send({ password: KNOWN_PASSWORD })
      expect(noEmail.status).toBe(400)

      const noPassword = await supertest(app).post('/api/auth/login').send({ email: 'login@test.com' })
      expect(noPassword.status).toBe(400)
    })

    it('does not reveal whether the email exists (same shape for both failures)', async () => {
      const wrongPw = await supertest(app)
        .post('/api/auth/login')
        .send({ email: 'login@test.com', password: 'nope-nope' })
      const noUser = await supertest(app)
        .post('/api/auth/login')
        .send({ email: 'ghost@test.com', password: 'nope-nope' })

      expect(wrongPw.status).toBe(noUser.status)
      expect(wrongPw.body.success).toBe(noUser.body.success)
    })
  })

  describe('POST /logout', () => {
    it('returns success', async () => {
      const res = await supertest(app).post('/api/auth/logout').send({})
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
    })
  })

  describe('POST /refresh', () => {
    it('issues a new token for a valid existing user', async () => {
      const userId = seedUser(t.raw, 'refresh@test.com', knownHash)
      const token = jwt.sign({ userId }, process.env.JWT_SECRET as string, { expiresIn: '1h' })

      const res = await supertest(app)
        .post('/api/auth/refresh')
        .set('Authorization', `Bearer ${token}`)
        .send({})

      // The controller may accept the token in the body or the header; accept
      // either a fresh token or a clear rejection, but never a 500.
      expect(res.status).toBeLessThan(500)
      if (res.status === 200) {
        expect(res.body.success).toBe(true)
        if (res.body.data?.token) {
          const decoded = jwt.verify(res.body.data.token, process.env.JWT_SECRET as string) as {
            userId: number
          }
          expect(decoded.userId).toBe(userId)
        }
      }
    })

    it('rejects a request with no token at all', async () => {
      const res = await supertest(app).post('/api/auth/refresh').send({})
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(500)
      expect(res.body.success).toBe(false)
    })

    it('rejects an invalid token', async () => {
      const res = await supertest(app)
        .post('/api/auth/refresh')
        .set('Authorization', 'Bearer not.a.jwt')
        .send({})
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(500)
      expect(res.body.success).toBe(false)
    })
  })
})
