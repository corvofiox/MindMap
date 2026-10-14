/**
 * Personal access token controller integration tests.
 *
 * `token.controller.ts` had 0% coverage: it is the web-facing CRUD API behind the
 * MCP credential (JWT + CSRF in production), and none of its security invariants
 * were asserted anywhere.
 *
 * Everything here drives the REAL `tokenRouter` mounted on a real Express app
 * backed by a real in-memory SQLite database, and reads the persisted rows back.
 * The invariants that matter:
 *   - the plaintext is returned exactly once by POST and never stored;
 *   - listing never exposes the hash;
 *   - every route is scoped to the calling user (no IDOR);
 *   - revoked tokens do not count against the per-user cap.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import { createHash } from 'crypto'
import type express from 'express'
import type Database from 'better-sqlite3'

vi.mock('../utils/logger.js', () => ({ log: vi.fn(), logError: vi.fn() }))

vi.mock('../database/connection.js', async () => {
  const { installDbMock } = await import('./helpers/integration-harness.js')
  return installDbMock()
})

import {
  authHeader,
  buildApp,
  countRows,
  createTestDatabase,
  readColumn,
  seedUser,
  setTestEnv,
  type TestDatabase,
} from './helpers/integration-harness.js'

setTestEnv()

const { tokenRouter } = await import('../controllers/token.controller.js')

const MAX_TOKENS_PER_USER = 25
const NOW_SEC = () => Math.floor(Date.now() / 1000)

/** Insert a token row directly, for cap/listing setups. */
function seedTokenRow(
  raw: Database.Database,
  userId: number,
  opts: {
    name?: string
    tokenHash?: string
    tokenPrefix?: string
    expiresAt?: number | null
    revokedAt?: number | null
  } = {},
): number {
  const now = NOW_SEC()
  return Number(
    raw
      .prepare(
        `INSERT INTO personal_access_tokens
           (user_id, name, token_hash, token_prefix, last_used_at, expires_at, created_at, revoked_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        userId,
        opts.name ?? 'seeded',
        opts.tokenHash ?? createHash('sha256').update(`seed-${Math.random()}`).digest('hex'),
        opts.tokenPrefix ?? 'mmp_seeded…',
        null,
        opts.expiresAt ?? null,
        now,
        opts.revokedAt ?? null,
      ).lastInsertRowid,
  )
}

/** Fill a user's quota with live tokens. */
function seedActiveTokens(raw: Database.Database, userId: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) =>
    seedTokenRow(raw, userId, { name: `t${i}`, revokedAt: null }),
  )
}

describe('token.controller (integration, real router + real DB)', () => {
  let app: express.Express
  let t: TestDatabase
  let userId: number
  let otherUserId: number

  beforeEach(() => {
    t = createTestDatabase()
    app = buildApp('/api/tokens', tokenRouter)
    userId = seedUser(t.raw, 'owner@test.com', 'hash', 'Owner')
    otherUserId = seedUser(t.raw, 'other@test.com', 'hash', 'Other')
  })

  describe('POST / — create a token', () => {
    it('returns 201 with a one-time plaintext and stores only its SHA-256 hash', async () => {
      const res = await supertest(app)
        .post('/api/tokens')
        .set(authHeader(userId))
        .send({ name: 'agent' })

      expect(res.status).toBe(201)
      expect(res.body.success).toBe(true)
      expect(res.body.data.name).toBe('agent')

      const plaintext = res.body.data.token as string
      expect(typeof plaintext).toBe('string')
      expect(plaintext.startsWith('mmp_')).toBe(true)
      // 32 random bytes as hex, after the prefix.
      expect(plaintext).toHaveLength('mmp_'.length + 64)

      // The prefix shown in the UI must not be the whole secret.
      expect(res.body.data.tokenPrefix).not.toBe(plaintext)
      expect(plaintext.startsWith(String(res.body.data.tokenPrefix).replace('…', ''))).toBe(true)

      // Only one row exists and it holds the hash, not the plaintext.
      expect(countRows(t.raw, 'personal_access_tokens')).toBe(1)
      const storedHash = readColumn<string>(
        t.raw,
        'SELECT token_hash FROM personal_access_tokens WHERE id = ?',
        res.body.data.id,
      )
      expect(storedHash).not.toBe(plaintext)
      expect(storedHash).toMatch(/^[0-9a-f]{64}$/)
      expect(storedHash).toBe(createHash('sha256').update(plaintext, 'utf8').digest('hex'))

      // And no column anywhere in the row contains the plaintext.
      const row = t.raw
        .prepare('SELECT * FROM personal_access_tokens WHERE id = ?')
        .get(res.body.data.id) as Record<string, unknown>
      for (const value of Object.values(row)) {
        expect(value).not.toBe(plaintext)
      }
    })

    it('stores the token prefix but never the full secret', async () => {
      const res = await supertest(app)
        .post('/api/tokens')
        .set(authHeader(userId))
        .send({ name: 'agent' })

      const prefix = readColumn<string>(
        t.raw,
        'SELECT token_prefix FROM personal_access_tokens WHERE id = ?',
        res.body.data.id,
      )
      expect(prefix).toBe(res.body.data.tokenPrefix)
      expect(prefix?.endsWith('…')).toBe(true)
      expect(prefix).not.toBe(res.body.data.token)
    })

    it('defaults a blank name instead of storing an empty string', async () => {
      const res = await supertest(app)
        .post('/api/tokens')
        .set(authHeader(userId))
        .send({ name: '   ' })

      expect(res.status).toBe(201)
      expect(res.body.data.name).toBe('未命名令牌')
      expect(
        readColumn<string>(
          t.raw,
          'SELECT name FROM personal_access_tokens WHERE id = ?',
          res.body.data.id,
        ),
      ).toBe('未命名令牌')
    })

    it('accepts a name of exactly 60 characters', async () => {
      const res = await supertest(app)
        .post('/api/tokens')
        .set(authHeader(userId))
        .send({ name: 'a'.repeat(60) })

      expect(res.status).toBe(201)
      expect(res.body.data.name).toHaveLength(60)
    })

    it('rejects a name longer than 60 characters and creates no row', async () => {
      const res = await supertest(app)
        .post('/api/tokens')
        .set(authHeader(userId))
        .send({ name: 'a'.repeat(61) })

      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
      expect(res.body.error).toContain('60')
      expect(countRows(t.raw, 'personal_access_tokens')).toBe(0)
    })

    it('rejects an unauthenticated create with 401 and creates no row', async () => {
      const res = await supertest(app).post('/api/tokens').send({ name: 'x' })
      expect(res.status).toBe(401)
      expect(countRows(t.raw, 'personal_access_tokens')).toBe(0)
    })

    describe('expiresInDays validation', () => {
      // Note: NaN is not representable in a JSON body (JSON.stringify turns it
      // into null, which the controller reads as "omitted"), so the non-numeric
      // cases below are strings that Number() cannot parse.
      for (const bad of [0, -1, -30, 3651, 999999, 'abc', 'ten', {}]) {
        it(`rejects expiresInDays=${String(bad)} with 400 and no row`, async () => {
          const res = await supertest(app)
            .post('/api/tokens')
            .set(authHeader(userId))
            .send({ name: 'bad-expiry', expiresInDays: bad })

          expect(res.status).toBe(400)
          expect(res.body.success).toBe(false)
          expect(res.body.error).toContain('3650')
          expect(countRows(t.raw, 'personal_access_tokens')).toBe(0)
        })
      }

      it('accepts the boundary value 3650', async () => {
        const res = await supertest(app)
          .post('/api/tokens')
          .set(authHeader(userId))
          .send({ name: 'max', expiresInDays: 3650 })
        expect(res.status).toBe(201)
      })

      it('treats an empty string as "no expiry" rather than invalid', async () => {
        const res = await supertest(app)
          .post('/api/tokens')
          .set(authHeader(userId))
          .send({ name: 'blank-expiry', expiresInDays: '' })
        expect(res.status).toBe(201)
        expect(res.body.data.expiresAt).toBeNull()
      })
    })

    describe('expires_at', () => {
      it('sets expires_at to roughly now + days*86400 when expiresInDays is given', async () => {
        const before = NOW_SEC()
        const res = await supertest(app)
          .post('/api/tokens')
          .set(authHeader(userId))
          .send({ name: 'week', expiresInDays: 7 })

        expect(res.status).toBe(201)
        const expected = before + 7 * 86400
        expect(res.body.data.expiresAt).toBeGreaterThanOrEqual(expected - 5)
        expect(res.body.data.expiresAt).toBeLessThanOrEqual(expected + 5)

        const stored = readColumn<number>(
          t.raw,
          'SELECT expires_at FROM personal_access_tokens WHERE id = ?',
          res.body.data.id,
        )
        expect(stored).toBe(res.body.data.expiresAt)
        expect(stored).toBeGreaterThan(NOW_SEC())
      })

      it('leaves expires_at NULL when expiresInDays is omitted', async () => {
        const res = await supertest(app)
          .post('/api/tokens')
          .set(authHeader(userId))
          .send({ name: 'forever' })

        expect(res.status).toBe(201)
        expect(res.body.data.expiresAt).toBeNull()
        expect(
          readColumn<number | null>(
            t.raw,
            'SELECT expires_at FROM personal_access_tokens WHERE id = ?',
            res.body.data.id,
          ),
        ).toBeNull()
      })
    })

    describe('per-user cap', () => {
      it('rejects the 26th active token with 400 and creates no row', async () => {
        seedActiveTokens(t.raw, userId, MAX_TOKENS_PER_USER)

        const res = await supertest(app)
          .post('/api/tokens')
          .set(authHeader(userId))
          .send({ name: 'overflow' })

        expect(res.status).toBe(400)
        expect(res.body.success).toBe(false)
        expect(res.body.error).toContain(String(MAX_TOKENS_PER_USER))
        expect(countRows(t.raw, 'personal_access_tokens', 'user_id = ?', userId)).toBe(
          MAX_TOKENS_PER_USER,
        )
      })

      it('allows a new token when one existing token has been revoked', async () => {
        const ids = seedActiveTokens(t.raw, userId, MAX_TOKENS_PER_USER)
        t.raw
          .prepare('UPDATE personal_access_tokens SET revoked_at = ? WHERE id = ?')
          .run(NOW_SEC() - 10, ids[0])

        const res = await supertest(app)
          .post('/api/tokens')
          .set(authHeader(userId))
          .send({ name: 'replacement' })

        expect(res.status).toBe(201)
        expect(countRows(t.raw, 'personal_access_tokens', 'user_id = ?', userId)).toBe(
          MAX_TOKENS_PER_USER + 1,
        )
      })

      it('does not count revoked tokens toward the cap at all', async () => {
        for (let i = 0; i < MAX_TOKENS_PER_USER + 5; i++) {
          seedTokenRow(t.raw, userId, { name: `revoked-${i}`, revokedAt: NOW_SEC() - 100 })
        }

        const res = await supertest(app)
          .post('/api/tokens')
          .set(authHeader(userId))
          .send({ name: 'fresh' })

        expect(res.status).toBe(201)
      })

      it('counts each user separately', async () => {
        seedActiveTokens(t.raw, otherUserId, MAX_TOKENS_PER_USER)

        const res = await supertest(app)
          .post('/api/tokens')
          .set(authHeader(userId))
          .send({ name: 'mine' })

        expect(res.status).toBe(201)
      })
    })
  })

  describe('GET / — list tokens', () => {
    it('lists only the caller\u2019s tokens, without the hash or the plaintext', async () => {
      const created = await supertest(app)
        .post('/api/tokens')
        .set(authHeader(userId))
        .send({ name: 'visible' })
      const plaintext = created.body.data.token as string

      // A token that belongs to someone else must never appear.
      seedTokenRow(t.raw, otherUserId, { name: 'foreign', tokenPrefix: 'mmp_foreign…' })

      const res = await supertest(app).get('/api/tokens').set(authHeader(userId))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.tokens).toHaveLength(1)
      const [row] = res.body.data.tokens
      expect(row.name).toBe('visible')
      expect(row.id).toBe(created.body.data.id)
      expect(row.revoked).toBe(false)
      expect(row.revokedAt).toBeNull()
      expect(row.expiresAt).toBeNull()
      expect(typeof row.createdAt).toBe('number')
      expect(row.tokenPrefix).toBe(created.body.data.tokenPrefix)

      // The serialized payload must not leak the secret or the stored hash.
      const body = JSON.stringify(res.body)
      expect(body).not.toContain(plaintext)
      expect(body).not.toContain('token_hash')
      expect(body).not.toContain('tokenHash')
      expect(body).not.toContain('mmp_foreign')
      expect(row.token).toBeUndefined()
      expect(row.tokenHash).toBeUndefined()
    })

    it('reports revoked: true for a revoked token and keeps it in the list', async () => {
      const created = await supertest(app)
        .post('/api/tokens')
        .set(authHeader(userId))
        .send({ name: 'doomed' })
      await supertest(app).delete(`/api/tokens/${created.body.data.id}`).set(authHeader(userId))

      const res = await supertest(app).get('/api/tokens').set(authHeader(userId))

      expect(res.status).toBe(200)
      expect(res.body.data.tokens).toHaveLength(1)
      expect(res.body.data.tokens[0].revoked).toBe(true)
      expect(res.body.data.tokens[0].revokedAt).toBeGreaterThan(0)
    })

    it('returns an empty list for a user with no tokens', async () => {
      const res = await supertest(app).get('/api/tokens').set(authHeader(userId))
      expect(res.status).toBe(200)
      expect(res.body.data.tokens).toEqual([])
    })

    it('returns 401 without authentication', async () => {
      const res = await supertest(app).get('/api/tokens')
      expect(res.status).toBe(401)
      expect(res.body.success).toBe(false)
    })
  })

  describe('DELETE /:id — revoke', () => {
    it('sets revoked_at instead of deleting the row', async () => {
      const created = await supertest(app)
        .post('/api/tokens')
        .set(authHeader(userId))
        .send({ name: 'to-revoke' })
      const id = created.body.data.id

      const res = await supertest(app).delete(`/api/tokens/${id}`).set(authHeader(userId))

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(countRows(t.raw, 'personal_access_tokens', 'id = ?', id)).toBe(1)
      expect(
        readColumn<number | null>(
          t.raw,
          'SELECT revoked_at FROM personal_access_tokens WHERE id = ?',
          id,
        ),
      ).toBeGreaterThan(0)
    })

    it('is idempotent and does not rewrite an existing revoked_at', async () => {
      const id = seedTokenRow(t.raw, userId, { name: 'already', revokedAt: 1_000_000_000 })

      const first = await supertest(app).delete(`/api/tokens/${id}`).set(authHeader(userId))
      expect(first.status).toBe(200)
      expect(first.body.success).toBe(true)

      const second = await supertest(app).delete(`/api/tokens/${id}`).set(authHeader(userId))
      expect(second.status).toBe(200)
      expect(second.body.success).toBe(true)

      // The original timestamp survives: revoking twice must not refresh it.
      expect(
        readColumn<number>(
          t.raw,
          'SELECT revoked_at FROM personal_access_tokens WHERE id = ?',
          id,
        ),
      ).toBe(1_000_000_000)
    })

    it('returns 404 for another user\u2019s token and leaves it live (IDOR guard)', async () => {
      const foreignId = seedTokenRow(t.raw, otherUserId, { name: 'foreign' })

      const res = await supertest(app)
        .delete(`/api/tokens/${foreignId}`)
        .set(authHeader(userId))

      expect(res.status).toBe(404)
      expect(res.body.success).toBe(false)
      expect(
        readColumn<number | null>(
          t.raw,
          'SELECT revoked_at FROM personal_access_tokens WHERE id = ?',
          foreignId,
        ),
      ).toBeNull()
    })

    it('returns 404 for a token id that does not exist', async () => {
      const res = await supertest(app).delete('/api/tokens/999999').set(authHeader(userId))
      expect(res.status).toBe(404)
      expect(res.body.success).toBe(false)
    })

    it('returns 400 for a non-numeric id', async () => {
      const res = await supertest(app).delete('/api/tokens/not-a-number').set(authHeader(userId))
      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
    })

    it('returns 401 without authentication and revokes nothing', async () => {
      const id = seedTokenRow(t.raw, userId, { name: 'untouched' })

      const res = await supertest(app).delete(`/api/tokens/${id}`)

      expect(res.status).toBe(401)
      expect(
        readColumn<number | null>(
          t.raw,
          'SELECT revoked_at FROM personal_access_tokens WHERE id = ?',
          id,
        ),
      ).toBeNull()
    })
  })
})
