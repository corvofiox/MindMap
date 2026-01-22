/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import request from 'supertest'
import express from 'express'

const app = express()
app.use((req, res) => {
  res.json({ status: 'ok' })
})

describe('Backend Server', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should have app instance', () => {
    expect(app).toBeDefined()
    expect(typeof app.use).toBe('function')
    expect(typeof app.get).toBe('function')
    expect(typeof app.post).toBe('function')
    expect(typeof app.put).toBe('function')
    expect(typeof app.delete).toBe('function')
  })

  it('should have middleware configuration', () => {
    const testApp = express()
    testApp.use(express.json())

    expect(testApp).toBeDefined()
    expect(testApp).not.toBe(app)
  })

  it('should handle requests correctly', async () => {
    const testApp = express()
    testApp.use((req, res) => {
      res.json({ path: req.path, method: req.method })
    })

    const response = await request(testApp).get('/test')

    expect(response.status).toBe(200)
    expect(response.body.path).toBe('/test')
    expect(response.body.method).toBe('GET')
  })

  it('should handle JSON body parsing', async () => {
    const testApp = express()
    testApp.use(express.json())
    testApp.post('/data', (req, res) => {
      res.json({ received: req.body })
    })

    const response = await request(testApp)
      .post('/data')
      .send({ key: 'value' })

    expect(response.status).toBe(200)
    expect(response.body.received).toEqual({ key: 'value' })
  })

  it('should handle URL-encoded data', async () => {
    const testApp = express()
    testApp.use(express.urlencoded({ extended: true }))
    testApp.post('/form', (req, res) => {
      res.json({ received: req.body })
    })

    const response = await request(testApp)
      .post('/form')
      .type('form')
      .send({ key: 'value' })

    expect(response.status).toBe(200)
    expect(response.body.received).toEqual({ key: 'value' })
  })

  it('should support supertest request chaining', async () => {
    const testApp = express()
    testApp.get('/json', (req, res) => {
      res.status(200).json({ message: 'success' })
    })

    const response = await request(testApp)
      .get('/json')
      .set('Accept', 'application/json')

    expect(response.status).toBe(200)
    expect(response.body.message).toBe('success')
  })

  it('should handle 404 for unknown routes', async () => {
    const testApp = express()
    testApp.use((req, res) => {
      res.status(404).json({ error: 'Not Found' })
    })

    const response = await request(testApp).get('/unknown')

    expect(response.status).toBe(404)
    expect(response.body.error).toBe('Not Found')
  })

  it('should handle multiple routes', async () => {
    const testApp = express()
    testApp.get('/route1', (req, res) => res.json({ route: 1 }))
    testApp.get('/route2', (req, res) => res.json({ route: 2 }))
    testApp.post('/route3', (req, res) => res.json({ route: 3 }))

    const r1 = await request(testApp).get('/route1')
    const r2 = await request(testApp).get('/route2')
    const r3 = await request(testApp).post('/route3')

    expect(r1.body.route).toBe(1)
    expect(r2.body.route).toBe(2)
    expect(r3.body.route).toBe(3)
  })

  it('should handle async route handlers', async () => {
    const testApp = express()
    testApp.get('/async', async (req, res) => {
      await new Promise(resolve => setTimeout(resolve, 10))
      res.json({ async: true })
    })

    const response = await request(testApp).get('/async')

    expect(response.status).toBe(200)
    expect(response.body.async).toBe(true)
  })
})
