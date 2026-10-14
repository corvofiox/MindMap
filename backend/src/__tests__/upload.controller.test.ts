/**
 * upload.controller — real module tests.
 *
 * Two security-relevant behaviours live here and both are pinned:
 *   1. The mimetype whitelist (fileFilter) rejects non-image mimetypes with 400.
 *   2. The magic-byte sniffer (A5) rejects a file whose CONTENT does not match a
 *      supported image signature — a client can lie about `Content-Type`, so an
 *      image/svg+xml body containing HTML/script must be refused.
 *
 * Requests are multipart (multer parses them), authenticated with a real user row
 * in the in-memory database.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import supertest from 'supertest'
import express from 'express'
import cookieParser from 'cookie-parser'

vi.mock('../utils/logger.js', () => ({ log: vi.fn(), logError: vi.fn() }))

vi.mock('../database/connection.js', async () => {
  const { installDbMock } = await import('./helpers/integration-harness.js')
  return installDbMock()
})

process.env.JWT_SECRET = process.env.JWT_SECRET || 'upload-test-jwt-secret'
process.env.JWT_EXPIRES_IN = '1h'
process.env.PORT = '3095'
process.env.WS_PORT = '3195'
process.env.DB_FILE = ':memory:'
process.env.ALLOWED_ORIGINS = 'http://localhost:5173'
process.env.NODE_ENV = 'test' // keep the dev-only logging quiet

const { uploadRouter } = await import('../controllers/upload.controller.js')
const { createTestDatabase, seedUser } = await import('./helpers/integration-harness.js')
const jwt = (await import('jsonwebtoken')).default

let app: express.Express
let token: string

/** Minimal valid image bodies (just the signatures, which is what's sniffed). */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x01, 0x00])])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.from('WEBP')])
/** An HTML/script payload pretending to be an image. */
const EVIL = Buffer.from('<script>alert("xss")</script>')

beforeAll(() => {
  const t = createTestDatabase()
  const userId = seedUser(t.raw, 'upload@test.com', 'hash', 'Uploader')
  token = jwt.sign({ userId }, process.env.JWT_SECRET as string, { expiresIn: '1h' })

  const mounted = express()
  mounted.use(cookieParser())
  mounted.use(express.json())
  mounted.use('/api/upload', uploadRouter)
  mounted.use(
    (err: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err.statusCode || 500).json({ success: false, error: err.message || 'error' })
    },
  )
  app = mounted
})

const auth = () => ({ Authorization: `Bearer ${token}` })

/** Attach a buffer as the multipart `image` field. */
function attach(request: supertest.Test, buffer: Buffer, filename: string, mimetype: string) {
  return request.attach('image', buffer, { filename, contentType: mimetype })
}

describe('upload.controller (real module)', () => {
  it('accepts a real PNG and returns a data URL using the SNIFFED mimetype', async () => {
    const res = await attach(
      supertest(app).post('/api/upload').set(auth()),
      PNG,
      'pixel.png',
      'image/png',
    )

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.mimetype).toBe('image/png')
    expect(res.body.data.url).toMatch(/^data:image\/png;base64,/)
    expect(res.body.data.size).toBe(PNG.length)
    expect(res.body.data.filename).toMatch(/\.png$/)
  })

  it.each([
    ['JPEG', JPEG, 'image/jpeg', 'photo.jpg'],
    ['GIF', GIF, 'image/gif', 'anim.gif'],
    ['WebP', WEBP, 'image/webp', 'pic.webp'],
  ])('accepts %s content', async (_label, body, mimetype, filename) => {
    const res = await attach(supertest(app).post('/api/upload').set(auth()), body, filename, mimetype)
    expect(res.status).toBe(200)
    expect(res.body.data.mimetype).toBe(mimetype)
  })

  it('rejects a mimetype outside the image whitelist (400, before sniffing)', async () => {
    const res = await attach(
      supertest(app).post('/api/upload').set(auth()),
      Buffer.from('plain text'),
      'notes.txt',
      'text/plain',
    )
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('PNG/JPEG/GIF/WebP')
  })

  it('rejects SVG declared as image/svg+xml (XSS vector)', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    const res = await attach(
      supertest(app).post('/api/upload').set(auth()),
      svg,
      'evil.svg',
      'image/svg+xml',
    )
    expect(res.status).toBe(400)
  })

  it('rejects content whose bytes match NO image signature, even with an image mimetype', async () => {
    const res = await attach(
      supertest(app).post('/api/upload').set(auth()),
      EVIL,
      'evil.png',
      'image/png',
    )
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('PNG/JPEG/GIF/WebP')
    // Nothing about the payload may be reflected back as a usable URL.
    expect(res.body.data?.url).toBeUndefined()
  })

  it('rejects an upload with no file at all', async () => {
    const res = await supertest(app).post('/api/upload').set(auth())
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('未上传任何文件')
  })

  it('requires authentication', async () => {
    const res = await attach(supertest(app).post('/api/upload'), PNG, 'pixel.png', 'image/png')
    expect(res.status).toBe(401)
  })
})
