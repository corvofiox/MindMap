import { describe, it, expect, beforeEach, vi } from 'vitest'
import request from 'supertest'
import express from 'express'

// Create a test app instance
const app = express()
app.use((req, res) => {
  res.json({ status: 'ok' })
})

describe('Backend Server', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should start server', async () => {
    await new Promise((resolve) => {
      app.listen(3000, '0.0.0.0', () => {
        resolve(undefined)
      })
    })

    expect(app.listen).toHaveBeenCalledWith(3000, '0.0.0.0')
  })

  it('should have app instance', () => {
    expect(app).toBeDefined()
  })
})
