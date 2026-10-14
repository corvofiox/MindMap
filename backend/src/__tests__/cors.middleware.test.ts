/**
 * cors.middleware — real module tests.
 *
 * The origin allow-list is a security boundary (a cross-origin script must not be
 * able to read authenticated responses), so every branch of the origin decision
 * is pinned: no-origin requests, the wildcard, the dev-localhost allowance, the
 * exact allow-list, and the rejection path.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import supertest from 'supertest'
import express from 'express'
import type { EnvVars } from '../utils/env.js'

vi.mock('../utils/logger.js', () => ({ log: vi.fn(), logError: vi.fn() }))

import { createCorsMiddleware } from '../middleware/cors.middleware.js'

function appWith(env: Partial<EnvVars>) {
  const app = express()
  app.use(
    createCorsMiddleware({
      JWT_SECRET: 'x',
      NODE_ENV: 'test',
      ALLOWED_ORIGINS: '',
      ...env,
    }),
  )
  app.get('/ok', (_req, res) => res.json({ ok: true }))
  return app
}

describe('cors.middleware (real module)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('allows requests with no Origin header (curl, mobile apps)', async () => {
    const res = await supertest(appWith({ ALLOWED_ORIGINS: 'https://a.example' })).get('/ok')
    // No Origin => not a CORS request at all; the response must succeed.
    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('allows an origin on the allow-list and echoes it', async () => {
    const res = await supertest(appWith({ ALLOWED_ORIGINS: 'https://a.example' }))
      .get('/ok')
      .set('Origin', 'https://a.example')

    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe('https://a.example')
    expect(res.headers['access-control-allow-credentials']).toBe('true')
  })

  it('allows origins when ALLOWED_ORIGINS is the wildcard', async () => {
    const res = await supertest(appWith({ ALLOWED_ORIGINS: '*' }))
      .get('/ok')
      .set('Origin', 'https://anything.example')

    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe('https://anything.example')
  })

  it('rejects an origin not on the allow-list with a CORS error', async () => {
    const res = await supertest(appWith({ ALLOWED_ORIGINS: 'https://a.example' }))
      .get('/ok')
      .set('Origin', 'https://evil.example')

    // cors passes the error to Express, which responds 500 with the message.
    expect(res.status).toBe(500)
    expect(res.text).toContain('not allowed by CORS')
  })

  it('parses a comma-separated allow-list, trimming whitespace', async () => {
    const app = appWith({ ALLOWED_ORIGINS: ' https://a.example , https://b.example ' })

    const a = await supertest(app).get('/ok').set('Origin', 'https://a.example')
    expect(a.status).toBe(200)

    const b = await supertest(app).get('/ok').set('Origin', 'https://b.example')
    expect(b.status).toBe(200)

    const c = await supertest(app).get('/ok').set('Origin', 'https://c.example')
    expect(c.status).toBe(500)
  })

  describe('development mode', () => {
    it('allows any localhost/127.0.0.1 port when no allow-list is configured', async () => {
      const app = appWith({ NODE_ENV: 'development', ALLOWED_ORIGINS: undefined })

      for (const origin of ['http://localhost:5173', 'http://localhost:9999', 'http://127.0.0.1:3000']) {
        const res = await supertest(app).get('/ok').set('Origin', origin)
        expect(res.status, `origin=${origin}`).toBe(200)
      }
    })

    it('still rejects non-localhost origins in development without a list', async () => {
      const app = appWith({ NODE_ENV: 'development', ALLOWED_ORIGINS: undefined })
      const res = await supertest(app).get('/ok').set('Origin', 'https://evil.example')
      expect(res.status).toBe(500)
    })

    it('still allows localhost alongside an explicit list in development', async () => {
      // Order in cors.middleware.ts: the dev-localhost branch runs BEFORE the
      // allow-list check, so localhost is allowed on top of any explicit list.
      // Pin that stacking behaviour so it is a decision, not an accident.
      const app = appWith({ NODE_ENV: 'development', ALLOWED_ORIGINS: 'https://a.example' })

      const listed = await supertest(app).get('/ok').set('Origin', 'https://a.example')
      expect(listed.status).toBe(200)

      const localhost = await supertest(app).get('/ok').set('Origin', 'http://localhost:5173')
      expect(localhost.status).toBe(200)

      const other = await supertest(app).get('/ok').set('Origin', 'https://evil.example')
      expect(other.status).toBe(500)
    })
  })

  describe('preflight', () => {
    it('answers an OPTIONS preflight for a listed origin with the exposed headers', async () => {
      const res = await supertest(appWith({ ALLOWED_ORIGINS: 'https://a.example' }))
        .options('/ok')
        .set('Origin', 'https://a.example')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'x-csrf-token')

      expect(res.status).toBe(204)
      expect(res.headers['access-control-allow-origin']).toBe('https://a.example')
      expect(res.headers['access-control-allow-headers']).toContain('x-csrf-token')
      expect(res.headers['access-control-expose-headers']).toBe('X-CSRF-Token')
      expect(res.headers['access-control-max-age']).toBe('86400')
    })

    it('refuses a preflight from a non-listed origin', async () => {
      const res = await supertest(appWith({ ALLOWED_ORIGINS: 'https://a.example' }))
        .options('/ok')
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'POST')

      expect(res.status).toBe(500)
    })
  })
})
