import { describe, it, expect, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import express from 'express'
import cookieParser from 'cookie-parser'
import initSqlJs from 'sql.js'
import { drizzle } from 'drizzle-orm/sql-js'
import type { SqlJsDatabase } from 'drizzle-orm/sql-js'
import * as schema from '../database/schema.js'
import { runMigrations } from '../database/migration.js'

// Set required env vars before any imports
process.env.JWT_SECRET = 'test-jwt-secret-key-for-integration-testing'
process.env.JWT_EXPIRES_IN = '1h'
process.env.PORT = '3099'
process.env.WS_PORT = '3199'
process.env.DB_FILE = ':memory:'
process.env.ALLOWED_ORIGINS = 'http://localhost:5173'

// Store for the test database instance
let _testDb: SqlJsDatabase<typeof schema> | null = null

// We need to mock before any imports, but also need the test to set the db.
// The approach: mock connection.js to export a plain getter/setter.
// Controllers import `db` from connection.js. Since ESM bindings are live,
// we can modify the module's db property.

// Mock database connection module with a mutable db export
vi.mock('../database/connection.js', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: Record<string, any> = {
    scheduleSave: vi.fn(),
    getSqlite: vi.fn(),
    getDb: vi.fn(),
    initializeDb: vi.fn(),
  }
  Object.defineProperty(mod, 'db', {
    get() { return _testDb },
    set(val: SqlJsDatabase<typeof schema>) { _testDb = val },
    enumerable: true,
    configurable: true,
  })
  return mod
})

// Mock rate limiter
vi.mock('../middleware/rateLimit.middleware.js', () => ({
  apiLimiter: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authLimiter: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))

// Static import - vi.mock is hoisted, so this will get the mocked module
import { authRouter } from '../controllers/auth.controller.js'

describe('Auth Controller Integration', () => {
  let app: express.Express

  beforeEach(async () => {
    // Create a fresh in-memory database for each test
    const SQL = await initSqlJs()
    const rawDb = new SQL.Database()
    rawDb.run('PRAGMA foreign_keys = ON')
    await runMigrations(rawDb)
    _testDb = drizzle(rawDb, { schema })

    // Set up Express app
    app = express()
    app.use(cookieParser())
    app.use(express.json())
    app.use('/api/auth', authRouter)
    // Add error handler (otherwise asyncHandler errors return empty 500 responses)
    app.use(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(err.statusCode || 500).json({
          success: false,
          error: err.message || 'Internal server error',
        })
      }
    )
  })

  describe('POST /api/auth/register', () => {
    it('should register a new user and return token', async () => {
      const res = await supertest(app)
        .post('/api/auth/register')
        .send({ email: 'newuser@test.com', password: 'password123', nickname: 'New User' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.user.email).toBe('newuser@test.com')
      expect(res.body.data.user.nickname).toBe('New User')
      expect(res.body.data.token).toBeDefined()
    })

    it('should reject registration without email', async () => {
      const res = await supertest(app)
        .post('/api/auth/register')
        .send({ password: 'password123' })

      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
    })

    it('should reject duplicate email', async () => {
      await supertest(app)
        .post('/api/auth/register')
        .send({ email: 'dup@test.com', password: 'password123' })

      const res = await supertest(app)
        .post('/api/auth/register')
        .send({ email: 'dup@test.com', password: 'password456' })

      expect(res.status).toBe(400)
      expect(res.body.success).toBe(false)
    })
  })

  describe('POST /api/auth/login', () => {
    beforeEach(async () => {
      await supertest(app)
        .post('/api/auth/register')
        .send({ email: 'loginuser@test.com', password: 'password123', nickname: 'Login User' })
    })

    it('should login with correct credentials', async () => {
      const res = await supertest(app)
        .post('/api/auth/login')
        .send({ email: 'loginuser@test.com', password: 'password123' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.user.email).toBe('loginuser@test.com')
      expect(res.body.data.token).toBeDefined()
    })

    it('should reject login with wrong password', async () => {
      const res = await supertest(app)
        .post('/api/auth/login')
        .send({ email: 'loginuser@test.com', password: 'wrongpassword' })

      expect(res.status).toBe(401)
      expect(res.body.success).toBe(false)
    })

    it('should reject login for non-existent user', async () => {
      const res = await supertest(app)
        .post('/api/auth/login')
        .send({ email: 'nonexistent@test.com', password: 'password123' })

      expect(res.status).toBe(401)
      expect(res.body.success).toBe(false)
    })
  })

  describe('POST /api/auth/logout', () => {
    it('should logout successfully', async () => {
      const res = await supertest(app)
        .post('/api/auth/logout')
        .send({})

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
    })
  })
})
