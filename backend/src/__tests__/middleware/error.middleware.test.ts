/**
 * error.middleware — REAL `asyncHandler` + `errorHandler`.
 *
 * These two were previously uncovered while `middleware.test.ts` (deleted)
 * asserted `toBeDefined()` on unawaited fake responses. The tests below mount
 * the real pair on a real app and assert the actual status code and body shape,
 * including the multer mapping and the production 5xx message scrub.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import supertest from 'supertest'
import express from 'express'
import { asyncHandler, errorHandler, type AppError } from '../../middleware/error.middleware.js'

vi.mock('../../utils/logger.js', () => ({ log: vi.fn(), logError: vi.fn() }))

import { logError } from '../../utils/logger.js'

/** App whose single route is wrapped in the real asyncHandler. */
function buildHandlerApp(
  handler: (req: express.Request, res: express.Response) => Promise<void>,
): express.Express {
  const app = express()
  app.use(express.json())
  app.get('/boom', asyncHandler(handler))
  app.use(errorHandler)
  return app
}

describe('error.middleware (real module)', () => {
  const originalNodeEnv = process.env.NODE_ENV

  beforeEach(() => {
    delete process.env.NODE_ENV
  })

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = originalNodeEnv
    }
  })

  describe('asyncHandler', () => {
    it('forwards a rejected promise to the error handler with a 500', async () => {
      const app = buildHandlerApp(async () => {
        throw new Error('kaboom')
      })

      const res = await supertest(app).get('/boom')

      expect(res.status).toBe(500)
      expect(res.body.success).toBe(false)
      expect(res.body.error).toBe('kaboom')
      expect(logError).toHaveBeenCalled()
    })

    it('forwards a rejected promise with a custom statusCode', async () => {
      const app = buildHandlerApp(async () => {
        const err: AppError = new Error('项目不存在')
        err.statusCode = 404
        throw err
      })

      const res = await supertest(app).get('/boom')

      expect(res.status).toBe(404)
      expect(res.body).toEqual({ success: false, error: '项目不存在' })
    })

    it('lets a successful handler respond normally', async () => {
      const app = buildHandlerApp(async (_req, res) => {
        res.json({ success: true, data: 'ok' })
      })

      const res = await supertest(app).get('/boom')

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ success: true, data: 'ok' })
    })

    it('catches an async rejection that happens after an await', async () => {
      const app = buildHandlerApp(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        throw new Error('late failure')
      })

      const res = await supertest(app).get('/boom')

      expect(res.status).toBe(500)
      expect(res.body.error).toBe('late failure')
    })
  })

  describe('errorHandler', () => {
    it('uses a 500 default and the error message when no statusCode is set', async () => {
      const app = express()
      app.get('/e', (_req, _res, next) => next(new Error('plain failure')))
      app.use(errorHandler)

      const res = await supertest(app).get('/e')

      expect(res.status).toBe(500)
      expect(res.body).toEqual({ success: false, error: 'plain failure' })
    })

    it('prefers statusCode over status', async () => {
      const app = express()
      app.get('/e', (_req, _res, next) => {
        const err = new Error('teapot') as AppError & { status: number }
        err.statusCode = 418
        err.status = 400
        next(err)
      })
      app.use(errorHandler)

      const res = await supertest(app).get('/e')

      expect(res.status).toBe(418)
    })

    it('maps a multer LIMIT_FILE_SIZE error to 413 with its own message', async () => {
      const app = express()
      app.get('/e', (_req, _res, next) => {
        const err = new Error('File too large') as Error & { code: string }
        err.code = 'LIMIT_FILE_SIZE'
        next(err)
      })
      app.use(errorHandler)

      const res = await supertest(app).get('/e')

      expect(res.status).toBe(413)
      expect(res.body).toEqual({ success: false, error: '文件大小超出限制' })
    })

    it('maps other multer LIMIT_* errors to 400', async () => {
      const app = express()
      app.get('/e', (_req, _res, next) => {
        const err = new Error('Unexpected field') as Error & { code: string }
        err.code = 'LIMIT_UNEXPECTED_FILE'
        next(err)
      })
      app.use(errorHandler)

      const res = await supertest(app).get('/e')

      expect(res.status).toBe(400)
      expect(res.body).toEqual({
        success: false,
        error: '上传请求不符合要求（文件数量或字段超出限制）',
      })
    })

    it('scrubs a 5xx message in production', async () => {
      process.env.NODE_ENV = 'production'
      const app = express()
      app.get('/e', (_req, _res, next) => next(new Error('SQLITE_ERROR: no such table')))
      app.use(errorHandler)

      const res = await supertest(app).get('/e')

      expect(res.status).toBe(500)
      expect(res.body).toEqual({ success: false, error: '服务器内部错误' })
    })

    it('keeps a 4xx business message in production', async () => {
      process.env.NODE_ENV = 'production'
      const app = express()
      app.get('/e', (_req, _res, next) => {
        const err: AppError = new Error('画布不存在')
        err.statusCode = 404
        next(err)
      })
      app.use(errorHandler)

      const res = await supertest(app).get('/e')

      expect(res.status).toBe(404)
      expect(res.body).toEqual({ success: false, error: '画布不存在' })
    })

    it('includes the stack only in development', async () => {
      const devApp = express()
      devApp.get('/e', (_req, _res, next) => next(new Error('dev failure')))
      devApp.use(errorHandler)

      process.env.NODE_ENV = 'development'
      const dev = await supertest(devApp).get('/e')
      expect(dev.status).toBe(500)
      expect(typeof dev.body.stack).toBe('string')

      process.env.NODE_ENV = 'production'
      const prod = await supertest(devApp).get('/e')
      expect(prod.body.stack).toBeUndefined()
    })
  })
})
