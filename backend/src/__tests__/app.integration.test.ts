/**
 * Application-level integration tests.
 *
 * Replaces `app.test.ts`, whose 9 tests built throwaway Express apps and asserted
 * that Express parses JSON / routes requests — i.e. it tested the framework, not
 * this application, and never imported `src/index.ts` or any real route.
 *
 * This file instead mounts the REAL routers behind the same middleware ordering
 * `index.ts` uses, so it verifies the actual API surface: health, the public CSRF
 * endpoint, the JSON 404 for unknown API paths, the response envelope, and that
 * protected routes reject unauthenticated callers.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import express from 'express'
import cookieParser from 'cookie-parser'

vi.mock('../utils/logger.js', () => ({ log: vi.fn(), logError: vi.fn() }))

vi.mock('../middleware/rateLimit.middleware.js', () => ({
  apiLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  authLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}))

vi.mock('../database/connection.js', async () => {
  const { installDbMock } = await import('./helpers/integration-harness.js')
  return installDbMock()
})

vi.mock('../websocket/index.js', () => ({
  getCanvasActiveUsers: vi.fn(() => []),
  closeRoom: vi.fn(),
  kickUserFromRoom: vi.fn(),
  shouldUpsertOnlyForSnapshot: vi.fn(() => false),
}))

import { createTestDatabase, setTestEnv, seedUser, authHeader } from './helpers/integration-harness.js'

setTestEnv()

const { authRouter } = await import('../controllers/auth.controller.js')
const { userRouter } = await import('../controllers/user.controller.js')
const { projectRouter } = await import('../controllers/project.controller.js')
const { tokenRouter } = await import('../controllers/token.controller.js')
const { getCsrfTokenRoute } = await import('../middleware/csrf.middleware.js')
const { errorHandler, asyncHandler } = await import('../middleware/error.middleware.js')

/**
 * Mirror index.ts's routing shape closely enough to test the real surface:
 * a public health endpoint, the public CSRF route, the protected API routers,
 * the JSON 404 for unmatched /api paths, and the shared error handler.
 */
function buildApp(): express.Express {
  const app = express()
  app.use(cookieParser())
  app.use(express.json())

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'mindmap-backend',
      version: process.env.APP_VERSION?.trim() || 'dev',
    })
  })

  app.get('/api/csrf-token', getCsrfTokenRoute)
  app.use('/api/auth', authRouter)
  app.use('/api/users', userRouter)
  app.use('/api/projects', projectRouter)
  app.use('/api/tokens', tokenRouter)

  // B16: unmatched /api/* must be JSON 404, not the SPA HTML fallback.
  app.use('/api', (_req, res) => {
    res.status(404).json({ success: false, error: '接口不存在' })
  })

  app.use(errorHandler)
  return app
}

describe('application integration', () => {
  let app: express.Express

  beforeEach(() => {
    createTestDatabase()
    app = buildApp()
  })

  describe('GET /health', () => {
    it('reports ok with a version and a timestamp', async () => {
      const res = await supertest(app).get('/health')
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('ok')
      expect(res.body.service).toBe('mindmap-backend')
      expect(typeof res.body.timestamp).toBe('string')
      expect(Number.isNaN(Date.parse(res.body.timestamp))).toBe(false)
    })

    it('reports APP_VERSION when the build injected one, else "dev"', async () => {
      const previous = process.env.APP_VERSION
      process.env.APP_VERSION = 'v9.9.9-test'
      const injected = await supertest(buildApp()).get('/health')
      expect(injected.body.version).toBe('v9.9.9-test')

      delete process.env.APP_VERSION
      const fallback = await supertest(buildApp()).get('/health')
      expect(fallback.body.version).toBe('dev')

      if (previous === undefined) delete process.env.APP_VERSION
      else process.env.APP_VERSION = previous
    })
  })

  describe('GET /api/csrf-token', () => {
    it('is public and returns a token in the success envelope', async () => {
      const res = await supertest(app).get('/api/csrf-token')
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(typeof res.body.token).toBe('string')
      expect(res.body.token.length).toBeGreaterThan(0)
    })

    it('issues the token as a cookie so the browser can echo it back', async () => {
      const res = await supertest(app).get('/api/csrf-token')
      const setCookie = res.headers['set-cookie']
      expect(setCookie).toBeDefined()
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie]
      const csrfCookie = cookies.find((c: string) => c.startsWith('x-csrf-token='))
      expect(csrfCookie, 'a x-csrf-token cookie must be set').toBeDefined()
      // The cookie value must match the token in the body, otherwise the
      // double-submit check could never succeed.
      const cookieValue = (csrfCookie as string).split(';')[0].split('=').slice(1).join('=')
      expect(decodeURIComponent(cookieValue)).toBe(res.body.token)
    })
  })

  describe('unknown /api routes', () => {
    it('returns a JSON 404 rather than an HTML fallback', async () => {
      const res = await supertest(app).get('/api/definitely-not-a-route')
      expect(res.status).toBe(404)
      expect(res.body).toEqual({ success: false, error: '接口不存在' })
      // Must not be the SPA shell.
      expect(res.text).not.toContain('<!DOCTYPE html>')
    })
  })

  describe('authentication is enforced across the real routers', () => {
    it.each([
      ['/api/users/profile', 'get'],
      ['/api/projects', 'get'],
      ['/api/tokens', 'get'],
    ])('%s rejects an unauthenticated %s with 401', async (endpoint, method) => {
      const res = await (supertest(app) as unknown as Record<string, (p: string) => supertest.Test>)[
        method
      ](endpoint)
      expect(res.status).toBe(401)
      expect(res.body.success).toBe(false)
    })

    it('accepts an authenticated request to a protected route', async () => {
      const userId = seedUser(createTestDatabase().raw, 'app@test.com', 'hash', 'App')
      const res = await supertest(app).get('/api/users/profile').set(authHeader(userId))
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
    })
  })

  describe('response envelope consistency', () => {
    it('every error response carries success:false and an error string', async () => {
      const responses = await Promise.all([
        supertest(app).get('/api/users/profile'),
        supertest(app).get('/api/projects'),
        supertest(app).get('/api/tokens'),
        supertest(app).get('/api/nope'),
      ])
      for (const res of responses) {
        expect(res.body.success).toBe(false)
        expect(typeof res.body.error).toBe('string')
        expect(res.body.error.length).toBeGreaterThan(0)
      }
    })
  })

  describe('error handler (integration surface only)', () => {
    // The error middleware's own branches (statusCode precedence, multer 413/400,
    // prod scrubbing, dev stack) are covered exhaustively in
    // middleware/error.middleware.test.ts. Only the app-level integration
    // property that file cannot assert is kept here: a thrown async error must
    // surface as JSON, never as an HTML/JS stack.
    it('turns a thrown async error into a JSON error response, not an HTML stack', async () => {
      const failing = express()
      failing.use(express.json())
      failing.get(
        '/boom',
        asyncHandler(async () => {
          throw Object.assign(new Error('exploded'), { statusCode: 418 })
        }),
      )
      failing.use(errorHandler)

      const res = await supertest(failing).get('/boom')
      expect(res.status).toBe(418)
      expect(res.body.success).toBe(false)
      expect(res.body.error).toBe('exploded')
      expect(res.text).not.toContain('at Object.')
    })

    it('asyncHandler forwards a rejected promise to next()', async () => {
      const forwarded: unknown[] = []
      const handler = asyncHandler(async () => {
        throw new Error('forwarded')
      })
      const fakeNext = (err?: unknown) => {
        forwarded.push(err)
      }
      await handler({} as express.Request, {} as express.Response, fakeNext as express.NextFunction)

      expect(forwarded).toHaveLength(1)
      expect((forwarded[0] as Error).message).toBe('forwarded')
    })
  })
})
