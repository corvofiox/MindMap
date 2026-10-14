/**
 * logger.controller — real module tests.
 *
 * The category whitelist here is security-relevant: it is what stops
 * `../../.env` or an absolute path from escaping the logs directory, so the
 * traversal attempts are asserted to be rejected rather than assumed.
 *
 * `LOGS_DIR` is resolved from `process.cwd()` at import time, so the suite runs
 * with a temp cwd to keep writes hermetic.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import express from 'express'
import cookieParser from 'cookie-parser'
import fs from 'fs'
import os from 'os'
import path from 'path'
import jwt from 'jsonwebtoken'

vi.mock('../utils/logger.js', () => ({ log: vi.fn(), logError: vi.fn() }))

// authenticate() resolves the user through `db`; the harness swaps in an
// in-memory database via this hoisted mock.
vi.mock('../database/connection.js', async () => {
  const { installDbMock } = await import('./helpers/integration-harness.js')
  return installDbMock()
})

let tmpDir: string
let originalCwd: string

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-logger-ctl-'))
  originalCwd = process.cwd()
  process.chdir(tmpDir)
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'logger-controller-test-secret'
  process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h'
  process.env.PORT = '3096'
  process.env.WS_PORT = '3196'
  process.env.DB_FILE = ':memory:'
  process.env.ALLOWED_ORIGINS = 'http://localhost:5173'
})

afterAll(() => {
  process.chdir(originalCwd)
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

let app: express.Express
let token: string
const LOGS_DIR = () => path.join(tmpDir, 'logs')

beforeEach(async () => {
  // LOGS_DIR is captured at module import time, so the cwd must be switched
  // BEFORE these imports — hence the dynamic imports here.
  const { createTestDatabase } = await import('./helpers/integration-harness.js')
  const { logRouter } = await import('../controllers/log.routes.js')
  const t = createTestDatabase()

  // authenticate resolves the user row; the token must reference a real one.
  const now = Math.floor(Date.now() / 1000)
  t.raw
    .prepare(
      'INSERT INTO users (email, password, nickname, created_at, updated_at) VALUES (?,?,?,?,?)',
    )
    .run('logger@test.com', 'hash', 'Logger', now, now)

  const mounted = express()
  mounted.use(cookieParser())
  // index.ts mounts everything behind a 10mb JSON parser (B15), which is what
  // makes the controller's own 100KB per-entry check reachable — body-parser's
  // 100kb default would 413 first. Mirror the production limit.
  mounted.use(express.json({ limit: '10mb' }))
  mounted.use('/api/logs', logRouter)
  mounted.use(
    (err: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err.statusCode || 500).json({ success: false, error: err.message || 'Internal server error' })
    },
  )
  app = mounted

  token = jwt.sign({ userId: 1 }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
})

const auth = () => ({ Authorization: `Bearer ${token}` })

describe('logger.controller (real module, isolated logs dir)', () => {
  describe('POST / writeLog', () => {
    it('writes a single log entry as JSON with defaults applied', async () => {
      const res = await supertest(app)
        .post('/api/logs')
        .set(auth())
        .send({ category: 'frontend', message: 'hello log' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)

      const file = path.join(LOGS_DIR(), 'frontend.log')
      expect(fs.existsSync(file)).toBe(true)
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8').trim())
      expect(parsed.message).toBe('hello log')
      expect(parsed.level).toBe('info')
      expect(typeof parsed.timestamp).toBe('string')
    })

    it('writes an array of entries as JSON lines', async () => {
      const res = await supertest(app)
        .post('/api/logs')
        .set(auth())
        .send({
          category: 'batch',
          logs: [
            { message: 'one', level: 'warn' },
            { message: 'two' },
          ],
        })

      expect(res.status).toBe(200)
      const lines = fs.readFileSync(path.join(LOGS_DIR(), 'batch.log'), 'utf8').trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]).message).toBe('one')
      expect(JSON.parse(lines[0]).level).toBe('warn')
      expect(JSON.parse(lines[1]).message).toBe('two')
    })

    it('falls back to the "general" category when none is given', async () => {
      const res = await supertest(app).post('/api/logs').set(auth()).send({ message: 'no category' })
      expect(res.status).toBe(200)
      expect(fs.existsSync(path.join(LOGS_DIR(), 'general.log'))).toBe(true)
    })

    it('rejects a category containing a path traversal (../../.env)', async () => {
      const res = await supertest(app)
        .post('/api/logs')
        .set(auth())
        .send({ category: '../../.env', message: 'evil' })
      expect(res.status).toBe(400)
      // Nothing may be written outside the logs dir.
      expect(fs.existsSync(path.join(tmpDir, '.env.log'))).toBe(false)
    })

    it('rejects an absolute-path category and an over-long category', async () => {
      const abs = await supertest(app)
        .post('/api/logs')
        .set(auth())
        .send({ category: '/etc/passwd', message: 'evil' })
      expect(abs.status).toBe(400)

      const long = await supertest(app)
        .post('/api/logs')
        .set(auth())
        .send({ category: 'a'.repeat(65), message: 'evil' })
      expect(long.status).toBe(400)
    })

    it('rejects non-object array elements instead of 500ing', async () => {
      const res = await supertest(app)
        .post('/api/logs')
        .set(auth())
        .send({ category: 'bad', logs: ['a string', 42, null] })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('对象')
    })

    it('rejects a single entry over the 100KB limit', async () => {
      const res = await supertest(app)
        .post('/api/logs')
        .set(auth())
        .send({ category: 'toobig', message: 'x'.repeat(101 * 1024) })
      expect(res.status).toBe(400)
      expect(fs.existsSync(path.join(LOGS_DIR(), 'toobig.log'))).toBe(false)
    })

    it('rejects an ARRAY batch containing any entry over the 100KB limit', async () => {
      const res = await supertest(app)
        .post('/api/logs')
        .set(auth())
        .send({
          category: 'toobig-array',
          logs: [{ message: 'small' }, { message: 'x'.repeat(101 * 1024) }],
        })
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('单条日志超过大小限制(100KB)')
      // The whole batch is refused — not even the small entry may land.
      expect(fs.existsSync(path.join(LOGS_DIR(), 'toobig-array.log'))).toBe(false)
    })

    it('still accepts a batch whose entries are all within the 100KB limit', async () => {
      const res = await supertest(app)
        .post('/api/logs')
        .set(auth())
        .send({
          category: 'near-limit',
          logs: [{ message: 'x'.repeat(90 * 1024) }, { message: 'tail' }],
        })
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      const lines = fs.readFileSync(path.join(LOGS_DIR(), 'near-limit.log'), 'utf8').trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]).message).toHaveLength(90 * 1024)
      expect(JSON.parse(lines[1]).message).toBe('tail')
    })
  })

  describe('GET /:category getLogs', () => {
    it('returns written entries as parsed JSON', async () => {
      await supertest(app).post('/api/logs').set(auth()).send({ category: 'read', message: 'entry-1' })

      const res = await supertest(app).get('/api/logs/read').set(auth())
      expect(res.status).toBe(200)
      expect(res.body.logs).toHaveLength(1)
      expect(res.body.logs[0].message).toBe('entry-1')
    })

    it('returns an empty list for a category that was never written', async () => {
      const res = await supertest(app).get('/api/logs/never-written').set(auth())
      expect(res.status).toBe(200)
      expect(res.body.logs).toEqual([])
    })

    it('rejects a traversal category on read', async () => {
      const res = await supertest(app).get('/api/logs/..%2F..%2F.env').set(auth())
      // The param arrives URL-decoded as "../../.env", which must fail the whitelist.
      expect([400, 404]).toContain(res.status)
    })
  })

  describe('DELETE /:category clearLogs', () => {
    it('removes the log file', async () => {
      await supertest(app).post('/api/logs').set(auth()).send({ category: 'clearme', message: 'x' })
      expect(fs.existsSync(path.join(LOGS_DIR(), 'clearme.log'))).toBe(true)

      const res = await supertest(app).delete('/api/logs/clearme').set(auth())
      expect(res.status).toBe(200)
      expect(fs.existsSync(path.join(LOGS_DIR(), 'clearme.log'))).toBe(false)
    })

    it('succeeds even when the file does not exist', async () => {
      const res = await supertest(app).delete('/api/logs/nothing-here').set(auth())
      expect(res.status).toBe(200)
    })
  })

  describe('authentication', () => {
    it('rejects all three operations without a token', async () => {
      const write = await supertest(app).post('/api/logs').send({ message: 'x' })
      expect(write.status).toBe(401)

      const read = await supertest(app).get('/api/logs/general')
      expect(read.status).toBe(401)

      const clear = await supertest(app).delete('/api/logs/general')
      expect(clear.status).toBe(401)
    })
  })
})
