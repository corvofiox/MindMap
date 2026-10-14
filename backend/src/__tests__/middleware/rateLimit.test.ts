/**
 * rateLimit.middleware — REAL module.
 *
 * Replaces the deleted `__tests__/security/rateLimit.test.ts`, which
 * reimplemented rate limiting locally (a counter middleware it wrote itself)
 * and asserted on its own counter. It never touched `express-rate-limit` or
 * `rateLimit.middleware.ts`, so it could not detect any change to the real
 * limiter — including its limit, window or message.
 *
 * Here the real `apiLimiter` / `authLimiter` / `createApiLimiter` factories are
 * mounted on a real app and driven with N+1 real requests. Each factory call
 * returns a fresh limiter with its own store, so every test starts clean.
 */
import { describe, it, expect } from 'vitest'
import supertest from 'supertest'
import express from 'express'
import {
  apiLimiter,
  authLimiter,
  createApiLimiter,
} from '../../middleware/rateLimit.middleware.js'

/**
 * App with one real limiter in front of a counting route.
 * The limiter instance is passed in so each test can supply a fresh one.
 */
function buildLimitedApp(
  limiter: express.RequestHandler,
  messageProbe?: { hits: number },
): express.Express {
  const app = express()
  app.use(express.json())
  app.use('/api/limited', limiter, (_req, res) => {
    if (messageProbe) messageProbe.hits++
    res.json({ success: true })
  })
  return app
}

/** Fire `count` requests through a persistent agent and return their statuses. */
async function fire(app: express.Express, count: number): Promise<number[]> {
  const agent = supertest.agent(app)
  const statuses: number[] = []
  for (let i = 0; i < count; i++) {
    const res = await agent.get('/api/limited')
    statuses.push(res.status)
  }
  return statuses
}

describe('rateLimit.middleware (real module)', () => {
  describe('createApiLimiter (aliased as apiLimiter)', () => {
    it('allows the first 1000 requests and answers 429 on the 1001st', async () => {
      const app = buildLimitedApp(apiLimiter())

      const statuses = await fire(app, 1001)

      const allowed = statuses.slice(0, 1000)
      expect(allowed.every((s) => s === 200)).toBe(true)
      expect(statuses[1000]).toBe(429)
      // No request beyond the limit slips through.
      expect(statuses.filter((s) => s === 429)).toHaveLength(1)
    }, 120_000)

    it('exposes the real limit through the standard RateLimit headers', async () => {
      const app = buildLimitedApp(apiLimiter())

      const res = await supertest(app).get('/api/limited')

      expect(res.status).toBe(200)
      expect(res.headers['ratelimit-limit']).toBe('1000')
      expect(res.headers['ratelimit-remaining']).toBe('999')
      expect(res.headers['ratelimit-policy']).toBe('1000;w=900')
      // legacyHeaders: false — the old X-RateLimit-* names must be gone.
      expect(res.headers['x-ratelimit-limit']).toBeUndefined()
    })

    it('is a factory: two instances keep independent counters', async () => {
      const first = buildLimitedApp(createApiLimiter())
      const second = buildLimitedApp(createApiLimiter())

      const firstRes = await supertest(first).get('/api/limited')
      const secondRes = await supertest(second).get('/api/limited')

      expect(firstRes.headers['ratelimit-remaining']).toBe('999')
      expect(secondRes.headers['ratelimit-remaining']).toBe('999')
    })
  })

  describe('createAuthLimiter (aliased as authLimiter)', () => {
    it('allows the first 100 requests and rejects the 101st with the auth message', async () => {
      const probe = { hits: 0 }
      const app = buildLimitedApp(authLimiter(), probe)

      const agent = supertest.agent(app)
      const statuses: number[] = []
      for (let i = 0; i < 101; i++) {
        const res = await agent.get('/api/limited')
        statuses.push(res.status)
      }

      expect(statuses.slice(0, 100).every((s) => s === 200)).toBe(true)
      expect(statuses[100]).toBe(429)
      // The handler ran exactly 100 times — the limiter really short-circuited.
      expect(probe.hits).toBe(100)

      const blocked = await agent.get('/api/limited')
      expect(blocked.status).toBe(429)
      expect(blocked.text).toBe('登录尝试过多，请稍后再试')
    }, 60_000)

    it('uses the stricter auth limit and its own 15-minute window', async () => {
      const app = buildLimitedApp(authLimiter())

      const res = await supertest(app).get('/api/limited')

      expect(res.headers['ratelimit-limit']).toBe('100')
      expect(res.headers['ratelimit-policy']).toBe('100;w=900')
    })
  })

  describe('blocked response', () => {
    it('returns 429 with the general API message once the limit is hit', async () => {
      const app = buildLimitedApp(apiLimiter())
      const agent = supertest.agent(app)

      for (let i = 0; i < 1000; i++) {
        await agent.get('/api/limited')
      }
      const blocked = await agent.get('/api/limited')

      expect(blocked.status).toBe(429)
      expect(blocked.text).toBe('请求过于频繁，请稍后再试')
    }, 120_000)
  })
})
