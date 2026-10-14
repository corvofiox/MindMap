/**
 * csrf.middleware — REAL module (double-submit cookie pattern).
 *
 * Replaces the deleted `__tests__/security/csrf.test.ts`, which called
 * `doubleCsrf(...)` itself with its own hand-written config and never imported
 * `csrf.middleware.ts`. It therefore passed even if the real middleware's
 * cookie name, ignored methods or token wiring were broken.
 *
 * This file imports the real `getCsrfTokenRoute`, `csrfProtectionMiddleware` and
 * `validateCsrfToken`, mounts them on a real Express app and asserts on real
 * HTTP responses and real `Set-Cookie` headers.
 *
 * `CSRF_SECRET` must be set before the module is imported: the middleware reads
 * it lazily through `getSecret`, but setting it up front keeps the test
 * deterministic and independent of ambient env.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import supertest from 'supertest'
import express from 'express'
import cookieParser from 'cookie-parser'

process.env.CSRF_SECRET = 'csrf-test-secret-value'

const { getCsrfTokenRoute, csrfProtectionMiddleware, validateCsrfToken } = await import(
  '../../middleware/csrf.middleware.js'
)

/** App using the real token route + the real protection middleware. */
function buildCsrfApp(): express.Express {
  const app = express()
  app.use(cookieParser())
  app.use(express.json())

  app.get('/api/csrf-token', getCsrfTokenRoute)

  // Every mutating verb goes through the real protection middleware.
  app.use(csrfProtectionMiddleware)
  app.post('/api/protected', (_req, res) => {
    res.json({ success: true, message: 'CSRF protection passed' })
  })
  app.put('/api/protected', (_req, res) => {
    res.json({ success: true, message: 'put passed' })
  })
  app.delete('/api/protected', (_req, res) => {
    res.json({ success: true, message: 'delete passed' })
  })
  // GET must be exempt (ignoredMethods), even though it hits the middleware.
  app.get('/api/protected', (_req, res) => {
    res.json({ success: true, message: 'get passed' })
  })

  // Same middleware reached through the `validateCsrfToken` wrapper export.
  app.post('/api/wrapped', validateCsrfToken, (_req, res) => {
    res.json({ success: true, message: 'wrapped passed' })
  })

  app.use(
    (err: { statusCode?: number; status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err.statusCode || err.status || 500).json({
        success: false,
        error: err.message || 'Internal server error',
      })
    },
  )

  return app
}

/** Pull the `x-csrf-token` cookie value out of a response's Set-Cookie header. */
function readCsrfCookie(res: supertest.Response): string {
  const raw = res.headers['set-cookie']
  const cookies = Array.isArray(raw) ? raw : [raw]
  const match = cookies.find((c) => typeof c === 'string' && c.startsWith('x-csrf-token='))
  if (!match) throw new Error('x-csrf-token cookie was not set')
  return match.split(';')[0]
}

describe('csrf.middleware (real module)', () => {
  let app: express.Express

  beforeAll(() => {
    app = buildCsrfApp()
  })

  describe('GET /api/csrf-token', () => {
    it('returns a token and sets the x-csrf-token cookie', async () => {
      const res = await supertest(app).get('/api/csrf-token')

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(typeof res.body.token).toBe('string')
      expect(res.body.token.length).toBeGreaterThan(0)

      const cookieHeader = readCsrfCookie(res)
      // The cookie and the body carry the same double-submit token.
      expect(cookieHeader).toBe(`x-csrf-token=${res.body.token}`)
    })

    it('pins the cookie hardening attributes (sameSite/secure/httpOnly/maxAge)', async () => {
      // Cookie-attribute drift is invisible to functional tests (an adversarial
      // review flipped sameSite strict→lax and the suite stayed green), so the
      // attributes are pinned here.
      //
      // httpOnly is deliberately OFF: double-submit requires the frontend to READ
      // this cookie and echo it in the x-csrf-token header. secure is OFF unless
      // CSRF_COOKIE_SECURE=true — a Secure cookie is silently dropped by browsers
      // on plain-HTTP deployments, which would break CSRF entirely there.
      const res = await supertest(app).get('/api/csrf-token')
      const raw = res.headers['set-cookie']
      const cookies = Array.isArray(raw) ? raw : [raw]
      const csrfCookie = cookies.find((c) => typeof c === 'string' && c.startsWith('x-csrf-token='))

      expect(csrfCookie, 'the csrf cookie must be set').toBeDefined()
      const attrs = (csrfCookie as string).split(';').map((s) => s.trim().toLowerCase())

      expect(attrs, 'sameSite must be strict').toContain('samesite=strict')
      expect(attrs.some((a) => a.startsWith('httponly')), 'httpOnly must stay OFF (double-submit needs JS read access)').toBe(false)
      const maxAge = attrs.find((a) => a.startsWith('max-age='))
      expect(maxAge, 'maxAge must be one week (604800s)').toBe('max-age=604800')
    })

    it('does not require a token of its own to issue one', async () => {
      const res = await supertest(app).get('/api/csrf-token')

      expect(res.status).toBe(200)
      expect(res.body.token).toBeTruthy()
    })
  })

  describe('mutating requests', () => {
    it('rejects a POST with no CSRF token (403)', async () => {
      const res = await supertest(app).post('/api/protected').send({ data: 'test' })

      expect(res.status).toBe(403)
      expect(res.body.success).toBe(false)
    })

    it('rejects a POST carrying only an invalid header token (403)', async () => {
      const res = await supertest(app)
        .post('/api/protected')
        .set('x-csrf-token', 'invalid-token')
        .send({ data: 'test' })

      expect(res.status).toBe(403)
    })

    it('rejects a POST where the cookie is valid but the header is missing', async () => {
      const tokenRes = await supertest(app).get('/api/csrf-token')
      const cookie = readCsrfCookie(tokenRes)

      const res = await supertest(app).post('/api/protected').set('Cookie', cookie).send({ data: 'x' })

      expect(res.status).toBe(403)
    })

    it('rejects a POST where the header and cookie tokens differ', async () => {
      const first = await supertest(app).get('/api/csrf-token')
      const second = await supertest(app).get('/api/csrf-token')

      const res = await supertest(app)
        .post('/api/protected')
        .set('Cookie', readCsrfCookie(first))
        .set('x-csrf-token', second.body.token)
        .send({ data: 'x' })

      expect(res.status).toBe(403)
    })

    it('accepts a POST that echoes the cookie token in the header', async () => {
      const tokenRes = await supertest(app).get('/api/csrf-token')
      const token = tokenRes.body.token
      const cookie = readCsrfCookie(tokenRes)

      const res = await supertest(app)
        .post('/api/protected')
        .set('Cookie', cookie)
        .set('x-csrf-token', token)
        .send({ data: 'test' })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ success: true, message: 'CSRF protection passed' })
    })

    it('accepts PUT and DELETE with the same valid double-submit pair', async () => {
      const tokenRes = await supertest(app).get('/api/csrf-token')
      const token = tokenRes.body.token
      const cookie = readCsrfCookie(tokenRes)

      const put = await supertest(app)
        .put('/api/protected')
        .set('Cookie', cookie)
        .set('x-csrf-token', token)
        .send({ data: 'test' })
      expect(put.status).toBe(200)
      expect(put.body.message).toBe('put passed')

      const del = await supertest(app)
        .delete('/api/protected')
        .set('Cookie', cookie)
        .set('x-csrf-token', token)
      expect(del.status).toBe(200)
      expect(del.body.message).toBe('delete passed')
    })

    it('accepts a POST through the validateCsrfToken wrapper export', async () => {
      const tokenRes = await supertest(app).get('/api/csrf-token')
      const token = tokenRes.body.token
      const cookie = readCsrfCookie(tokenRes)

      const res = await supertest(app)
        .post('/api/wrapped')
        .set('Cookie', cookie)
        .set('x-csrf-token', token)
        .send({ data: 'test' })

      expect(res.status).toBe(200)
      expect(res.body.message).toBe('wrapped passed')
    })

    it('rejects a POST through the validateCsrfToken wrapper without a token', async () => {
      const res = await supertest(app).post('/api/wrapped').send({ data: 'test' })

      expect(res.status).toBe(403)
    })
  })

  describe('GET exemption (ignoredMethods)', () => {
    it('lets a GET through the middleware without any token', async () => {
      const res = await supertest(app).get('/api/protected')

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ success: true, message: 'get passed' })
    })
  })
})
