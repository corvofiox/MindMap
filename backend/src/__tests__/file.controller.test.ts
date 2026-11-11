/**
 * file.controller — content-addressed image storage (`/api/files`).
 *
 * Pinned behaviours (each maps to a decision in docs/requirements-notebook.md §14/§18):
 *   - upload writes bytes to disk and returns a SHORT URL, never a base64 data URL
 *     (the whole point of the refactor: documents must stay small);
 *   - identical bytes dedupe to one row, so the same picture in two documents is
 *     stored once and GC's mark-and-sweep stays correct;
 *   - the magic-byte sniffer still refuses a payload that only claims to be an
 *     image (A5 XSS vector), shared with the legacy /api/upload path;
 *   - reads are a capability URL keyed by sha256 (no bearer token, because
 *     <img src> cannot send one), immutable and ETag-able;
 *   - unknown / malformed hashes are 404, never a filesystem path leak.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import supertest from 'supertest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('../utils/logger.js', () => ({ log: vi.fn(), logError: vi.fn() }))

vi.mock('../database/connection.js', async () => {
  const { installDbMock } = await import('./helpers/integration-harness.js')
  return installDbMock()
})

process.env.JWT_SECRET = process.env.JWT_SECRET || 'file-test-jwt-secret'
process.env.JWT_EXPIRES_IN = '1h'
process.env.PORT = '3096'
process.env.WS_PORT = '3196'
process.env.DB_FILE = ':memory:'
process.env.ALLOWED_ORIGINS = 'http://localhost:5173'
process.env.NODE_ENV = 'test'

const { fileRouter } = await import('../controllers/file.controller.js')
const { createTestDatabase, seedUser, buildApp } = await import('./helpers/integration-harness.js')
const jwt = (await import('jsonwebtoken')).default

/** Minimal valid image bodies — only the signature bytes are sniffed. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02])
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x01, 0x00])])
/** PNG whose bytes are unique per test, so row state never leaks between cases. */
const pngWith = (tag: string) => Buffer.concat([PNG, Buffer.from(tag)])
const gifWith = (tag: string) => Buffer.concat([GIF, Buffer.from(tag)])
/** HTML/script pretending to be an image. */
const EVIL = Buffer.from('<script>alert("xss")</script>')

let app: ReturnType<typeof buildApp>
let token: string
let tokenB: string
let testDb: ReturnType<typeof createTestDatabase>
let uploadDir: string

beforeAll(() => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-files-'))
  process.env.UPLOAD_DIR = uploadDir

  testDb = createTestDatabase()
  const userA = seedUser(testDb.raw, 'a@test.com', 'hash', 'A')
  const userB = seedUser(testDb.raw, 'b@test.com', 'hash', 'B')
  token = jwt.sign({ userId: userA }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
  tokenB = jwt.sign({ userId: userB }, process.env.JWT_SECRET as string, { expiresIn: '1h' })

  app = buildApp('/api/files', fileRouter)
})

afterAll(() => {
  fs.rmSync(uploadDir, { recursive: true, force: true })
})

const auth = (bearer = token) => ({ Authorization: `Bearer ${bearer}` })

function upload(buffer: Buffer, filename = 'a.png', contentType = 'image/png', bearer = token) {
  return supertest(app)
    .post('/api/files')
    .set(auth(bearer))
    .attach('image', buffer, { filename, contentType })
}

describe('POST /api/files', () => {
  it('stores the bytes and returns a short capability URL, not a data URL', async () => {
    const bytes = pngWith('store')
    const res = await upload(bytes)

    expect(res.status).toBe(201)
    expect(res.body.success).toBe(true)
    const { url, id, size, mimetype, deduped } = res.body.data
    expect(url).toMatch(/^\/api\/files\/[a-f0-9]{64}$/)
    expect(typeof id).toBe('number')
    expect(size).toBe(bytes.length)
    expect(mimetype).toBe('image/png')
    expect(deduped).toBe(false)
    // 关键：绝不返回 base64
    expect(JSON.stringify(res.body)).not.toContain('data:image')

    // 字节真的落盘了，而且文件名是内容寻址的
    const sha = url.split('/').pop() as string
    expect(fs.existsSync(path.join(uploadDir, `${sha.slice(0, 32)}.png`))).toBe(true)
  })

  it('dedupes identical bytes to the same row and URL', async () => {
    const bytes = pngWith('dedupe')
    const first = await upload(bytes, 'one.png')
    const second = await upload(bytes, 'two-different-name.png')

    expect(second.status).toBe(200)
    expect(second.body.data.deduped).toBe(true)
    expect(second.body.data.id).toBe(first.body.data.id)
    expect(second.body.data.url).toBe(first.body.data.url)

    const rows = testDb.raw
      .prepare('SELECT COUNT(*) AS n FROM files WHERE sha256 = ?')
      .get(first.body.data.sha256) as { n: number }
    expect(rows.n).toBe(1)
  })

  it('dedupes across accounts (content-addressed, documented trade-off)', async () => {
    const bytes = pngWith('cross-account')
    const a = await upload(bytes)
    const b = await upload(bytes, 'b.png', 'image/png', tokenB)

    expect(b.body.data.id).toBe(a.body.data.id)
    expect(b.body.data.deduped).toBe(true)
  })

  it('rejects an HTML payload that only claims to be image/png', async () => {
    const res = await upload(EVIL, 'evil.png', 'image/png')

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('仅支持')
  })

  it('rejects a non-image mimetype', async () => {
    const res = await upload(Buffer.from('hello'), 'note.txt', 'text/plain')

    expect(res.status).toBe(400)
    expect(res.body.success).toBe(false)
  })

  it('requires authentication', async () => {
    const res = await supertest(app)
      .post('/api/files')
      .attach('image', PNG, { filename: 'a.png', contentType: 'image/png' })

    expect(res.status).toBe(401)
  })

  it('rejects a request with no file attached', async () => {
    const res = await supertest(app).post('/api/files').set(auth())

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('未上传')
  })
})

describe('GET /api/files/:sha', () => {
  it('serves the exact bytes with an immutable cache policy and ETag', async () => {
    const bytes = gifWith('serve')
    const up = await upload(bytes)
    const url = up.body.data.url as string

    const res = await supertest(app).get(url)

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('image/gif')
    expect(Number(res.headers['content-length'])).toBe(bytes.length)
    expect(Buffer.compare(res.body as Buffer, bytes)).toBe(0)
    expect(res.headers['cache-control']).toContain('immutable')
    expect(res.headers.etag).toBeTruthy()
      })

  it('answers 304 when the client already has the bytes', async () => {
    const up = await upload(gifWith('etag'))
    const url = up.body.data.url as string

    const first = await supertest(app).get(url)
    const etag = first.headers.etag as string
    const second = await supertest(app).get(url).set('If-None-Match', etag)

    expect(second.status).toBe(304)
  })

  it('does not require a token (an <img src> cannot send one)', async () => {
    const up = await upload(pngWith('no-token'))
    const res = await supertest(app).get(up.body.data.url as string)

    expect(res.status).toBe(200)
  })

  it('404s for an unknown hash and for a malformed one', async () => {
    const unknown = 'a'.repeat(64)
    expect((await supertest(app).get(`/api/files/${unknown}`)).status).toBe(404)
    expect((await supertest(app).get('/api/files/deadbeef')).status).toBe(404)
    expect((await supertest(app).get('/api/files/..%2F..%2Fetc%2Fpasswd')).status).toBe(404)
  })
})
