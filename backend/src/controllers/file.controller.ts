/**
 * File storage API — the canonical home for images referenced by nodes,
 * node-pool cards and manuscripts.
 *
 * ## Why this exists
 *
 * `/api/upload` returns a base64 `data:` URL, and that URL used to be written
 * straight into `node.imageUrl` / card content. Once images live *inside* rich
 * text (`<img>` in `node.content`), a 2 MB picture becomes ~2.7 MB of text that
 * every Yjs diff, undo snapshot, full save and peer sync has to carry.
 *
 * So: bytes go to disk, documents carry a short URL.
 *
 * ## URL shape: capability URL, not authenticated
 *
 * Reads are `GET /api/files/:sha256`. They are deliberately NOT behind the
 * bearer-token middleware: `<img src>` cannot send an Authorization header, and
 * the auth middleware rejects `?token=` on purpose (B7: tokens leak into logs
 * and Referer). The sha256 hash is the capability: 64 hex chars, unguessable,
 * never enumerated by any listing endpoint. Uploads stay authenticated + CSRF.
 *
 * ## Dedupe
 *
 * Content-addressed by sha256, globally. Uploading the same bytes twice returns
 * the same file row (and the same URL), so a picture pasted into two documents
 * is stored once. GC only deletes a row when *no* document references it, which
 * makes the shared row safe.
 */
import { Router } from 'express'
import type { Request, Response } from 'express'
import multer from 'multer'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { eq } from 'drizzle-orm'
import { db } from '../database/connection.js'
import { files } from '../database/schema.js'
import { authenticate } from '../middleware/auth.middleware.js'
import { log, logError } from '../utils/logger.js'
import {
  MAX_IMAGE_BYTES,
  UNSUPPORTED_IMAGE_MESSAGE,
  extensionForMime,
  sniffImageMime,
} from '../utils/image-bytes.js'
import type { AuthRequest } from '../middleware/auth.middleware.js'

const router = Router()

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true)
      return
    }
    const err = new Error(UNSUPPORTED_IMAGE_MESSAGE) as Error & { statusCode?: number }
    err.statusCode = 400
    cb(err)
  },
})

/** Absolute storage root. Mirrors UPLOAD_DIR used by the legacy upload path. */
export function storageRoot(): string {
  return path.resolve(process.env.UPLOAD_DIR || './uploads')
}

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

const SHA_PATTERN = /^[a-f0-9]{64}$/

interface StoredFile {
  id: number
  sha256: string
  url: string
  filename: string
  mimetype: string
  size: number
  deduped: boolean
}

/**
 * Upload one image. Returns the canonical descriptor; identical bytes yield the
 * same row (`deduped: true`).
 */
async function storeImage(params: {
  buffer: Buffer
  originalName: string
  uploaderId: number
}): Promise<StoredFile> {
  const { buffer, originalName, uploaderId } = params
  const mime = sniffImageMime(buffer)
  if (!mime) {
    const err = new Error(UNSUPPORTED_IMAGE_MESSAGE) as Error & { statusCode?: number }
    err.statusCode = 400
    throw err
  }

  const hash = sha256(buffer)
  const ext = extensionForMime(mime)
  const storedName = `${hash.slice(0, 32)}.${ext}`
  const root = storageRoot()
  const absolute = path.join(root, storedName)

  const existing = await db.query.files.findFirst({ where: eq(files.sha256, hash) })
  if (existing && fs.existsSync(path.join(root, existing.path))) {
    return {
      id: existing.id,
      sha256: hash,
      url: `/api/files/${hash}`,
      filename: originalName,
      mimetype: existing.mimeType,
      size: existing.size,
      deduped: true,
    }
  }

  await fs.promises.mkdir(root, { recursive: true })
  // Write to a temp name first: a process crash mid-write must never leave a
  // truncated file that a later "dedupe hit" would happily serve.
  const tempPath = `${absolute}.${process.pid}.${Date.now()}.tmp`
  await fs.promises.writeFile(tempPath, buffer)
  await fs.promises.rename(tempPath, absolute)

  if (existing) {
    // Row survived but the bytes did not (disk wiped / manual delete) — heal it.
    await db.update(files).set({ size: buffer.length, mimeType: mime }).where(eq(files.id, existing.id))
    return {
      id: existing.id,
      sha256: hash,
      url: `/api/files/${hash}`,
      filename: originalName,
      mimetype: mime,
      size: buffer.length,
      deduped: true,
    }
  }

  const inserted = await db
    .insert(files)
    .values({
      filename: originalName.slice(0, 255),
      path: storedName,
      size: buffer.length,
      mimeType: mime,
      uploaderId,
      projectId: null,
      sha256: hash,
      status: 'ready',
    })
    .returning({ id: files.id })

  const id = inserted[0]?.id
  if (typeof id !== 'number') throw new Error('文件记录写入失败')

  return {
    id,
    sha256: hash,
    url: `/api/files/${hash}`,
    filename: originalName,
    mimetype: mime,
    size: buffer.length,
    deduped: false,
  }
}

// Upload — authenticated; CSRF is applied at the mount point in index.ts, the
// same way every other write router in this project gets it.
router.post(
  '/',
  authenticate,
  upload.single('image'),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, error: '未上传任何文件' })
      }
      if (!req.user) {
        return res.status(401).json({ success: false, error: '未提供令牌' })
      }

      const stored = await storeImage({
        buffer: req.file.buffer,
        originalName: req.file.originalname,
        uploaderId: req.user.id,
      })

      log('File stored', { id: stored.id, size: stored.size, deduped: stored.deduped })
      return res.status(stored.deduped ? 200 : 201).json({
        success: true,
        data: {
          id: stored.id,
          sha256: stored.sha256,
          url: stored.url,
          filename: stored.filename,
          mimetype: stored.mimetype,
          size: stored.size,
          deduped: stored.deduped,
        },
      })
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode ?? 500
      if (status >= 500) logError('File store failed', error)
      return res.status(status).json({
        success: false,
        error: error instanceof Error ? error.message : '上传失败',
      })
    }
  },
)

// Read — capability URL keyed by sha256; no auth (see the header comment).
router.get('/:sha', async (req: Request, res: Response) => {
  const sha = String(req.params.sha || '')
  if (!SHA_PATTERN.test(sha)) {
    return res.status(404).json({ success: false, error: '文件不存在' })
  }

  const row = await db.query.files.findFirst({ where: eq(files.sha256, sha) })
  if (!row) {
    return res.status(404).json({ success: false, error: '文件不存在' })
  }

  const absolute = path.join(storageRoot(), row.path)
  if (!fs.existsSync(absolute)) {
    logError('File row exists but bytes are missing', { id: row.id, path: row.path })
    return res.status(404).json({ success: false, error: '文件不存在' })
  }

  const etag = `"${sha}"`
  res.setHeader('ETag', etag)
  // Content-addressed: the bytes for a given URL never change.
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end()
  }

  res.setHeader('Content-Type', row.mimeType)
  res.setHeader('Content-Length', String(row.size))
  res.setHeader('X-Content-Type-Options', 'nosniff')
  const stream = fs.createReadStream(absolute)
  stream.on('error', (err) => {
    logError('File stream failed', err)
    if (!res.headersSent) res.status(500).json({ success: false, error: '读取失败' })
    else res.end()
  })
  stream.pipe(res)
})

export const fileRouter = router
export { storeImage }
