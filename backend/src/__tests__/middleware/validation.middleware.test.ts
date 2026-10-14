/**
 * validation.middleware — REAL module.
 *
 * Replaces the deleted `__tests__/middleware.test.ts`, which never imported the
 * real validators: it hand-rolled its own checks and asserted `toBeDefined()` on
 * unawaited supertest objects. Here the real `validateBody` / `validateQuery` /
 * `validateParams` are mounted on real routes, so the assertions fail if the
 * middleware's contract (parsed value written back to the request, `{success:false,
 * details}` on rejection) changes.
 */
import { describe, it, expect } from 'vitest'
import supertest from 'supertest'
import express from 'express'
import { z } from 'zod'
import { buildApp } from '../helpers/integration-harness.js'
import {
  validateBody,
  validateParams,
  validateQuery,
} from '../../middleware/validation.middleware.js'

const createBodySchema = z.object({
  name: z.string().min(1),
  count: z.coerce.number().int().positive(),
  nickname: z.string().optional().default('anonymous'),
})

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive(),
  search: z.string().optional(),
})

const idParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
})

/** App with one real route per validator, echoing the parsed request parts. */
function buildValidationApp(): express.Express {
  const router = express.Router()

  router.post('/body', validateBody(createBodySchema), (req, res) => {
    res.json({ success: true, body: req.body })
  })

  router.get('/query', validateQuery(listQuerySchema), (req, res) => {
    res.json({ success: true, query: req.query })
  })

  router.get('/params/:id', validateParams(idParamsSchema), (req, res) => {
    res.json({ success: true, params: req.params })
  })

  router.post(
    '/explode',
    validateBody(
      z.object({ name: z.string() }).transform(() => {
        throw new Error('transformer blew up')
      }),
    ),
    (req, res) => {
      res.json({ success: true, body: req.body })
    },
  )

  return buildApp('/api', router)
}

describe('validation.middleware (real module)', () => {
  const app = buildValidationApp()

  describe('validateBody', () => {
    it('passes valid input through and writes the parsed value to req.body', async () => {
      const res = await supertest(app)
        .post('/api/body')
        .send({ name: 'Alpha', count: '7' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      // Coercion ran (string → number) and the default was applied.
      expect(res.body.body).toEqual({ name: 'Alpha', count: 7, nickname: 'anonymous' })
      expect(typeof res.body.body.count).toBe('number')
    })

    it('strips unknown keys, so req.body is the parsed schema output', async () => {
      const res = await supertest(app)
        .post('/api/body')
        .send({ name: 'Alpha', count: 1, isAdmin: true, injected: 'x' })

      expect(res.status).toBe(200)
      expect(res.body.body).not.toHaveProperty('isAdmin')
      expect(res.body.body).not.toHaveProperty('injected')
    })

    it('rejects invalid input with 400 and a details array', async () => {
      const res = await supertest(app).post('/api/body').send({ name: '', count: -3 })

      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
      expect(res.body.error).toBe('验证错误')
      expect(Array.isArray(res.body.details)).toBe(true)
      expect(res.body.details.length).toBeGreaterThanOrEqual(2)
      const paths = res.body.details.map((d: { path: (string | number)[] }) => d.path.join('.'))
      expect(paths).toContain('name')
      expect(paths).toContain('count')
      expect(res.body.details[0]).toHaveProperty('message')
    })

    it('rejects a completely missing body', async () => {
      const res = await supertest(app).post('/api/body').send({})

      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
      expect(res.body.details.length).toBeGreaterThan(0)
    })

    it('forwards non-Zod errors to the error handler instead of answering 400', async () => {
      const res = await supertest(app).post('/api/explode').send({ name: 'ok' })

      expect(res.status).toBe(500)
      expect(res.body.success).toBe(false)
      expect(res.body.error).toBe('transformer blew up')
    })
  })

  describe('validateQuery', () => {
    it('passes valid query params through and coerces them', async () => {
      const res = await supertest(app).get('/api/query?page=2&search=abc')

      expect(res.status).toBe(200)
      expect(res.body.query).toEqual({ page: 2, search: 'abc' })
      expect(typeof res.body.query.page).toBe('number')
    })

    it('rejects a non-numeric page with 400 and details', async () => {
      const res = await supertest(app).get('/api/query?page=abc')

      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
      expect(res.body.error).toBe('验证错误')
      expect(res.body.details.some((d: { path: string[] }) => d.path[0] === 'page')).toBe(true)
    })

    it('rejects a missing required query param', async () => {
      const res = await supertest(app).get('/api/query')

      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
    })
  })

  describe('validateParams', () => {
    it('passes valid route params through and coerces them', async () => {
      const res = await supertest(app).get('/api/params/42')

      expect(res.status).toBe(200)
      expect(res.body.params).toEqual({ id: 42 })
      expect(typeof res.body.params.id).toBe('number')
    })

    it('rejects a non-numeric route param with 400 and details', async () => {
      const res = await supertest(app).get('/api/params/not-a-number')

      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
      expect(res.body.error).toBe('验证错误')
      expect(res.body.details.some((d: { path: string[] }) => d.path[0] === 'id')).toBe(true)
    })
  })
})
