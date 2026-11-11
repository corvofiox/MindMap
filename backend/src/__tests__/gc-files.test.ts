/**
 * gc-files — 孤儿图片的三阶段清理。
 *
 * 重点钉住的是"不会误删活图"这一侧，因为它的故障不可逆：
 *   - 被画布 / 卡片 / 手稿引用的文件必须存活；
 *   - 宽限期内的新文件不动；
 *   - 任何文档解析失败 → 整轮中止（fail closed）；
 *   - dry-run 不写任何东西；
 *   - 三个阶段各自可重入。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('../utils/logger.js', () => ({ log: vi.fn(), logError: vi.fn() }))

vi.mock('../database/connection.js', async () => {
  const { installDbMock } = await import('./helpers/integration-harness.js')
  return installDbMock()
})

process.env.JWT_SECRET = process.env.JWT_SECRET || 'gc-test-jwt-secret'
process.env.DB_FILE = ':memory:'

const { createTestDatabase } = await import('./helpers/integration-harness.js')
const { jsonSnapshotToDoc, encodeDocToBase64 } = await import('../websocket/yjs-schema.js')
const { runFileGc, collectLiveRefs } = await import('../database/gc-files.js')

let testDb: ReturnType<typeof createTestDatabase>
let uploadDir: string
const DAY = 86400

function sha(seed: string): string {
  return seed.repeat(64).slice(0, 64)
}

function insertFile(options: {
  sha256: string
  createdAt?: number
  orphanedAt?: number | null
  deletedAt?: number | null
  withBytes?: boolean
}): number {
  const fileName = `${options.sha256.slice(0, 32)}.png`
  if (options.withBytes !== false) {
    fs.writeFileSync(path.join(uploadDir, fileName), Buffer.from('bytes'))
  }
  const info = testDb.raw
    .prepare(
      `INSERT INTO files (filename, path, size, mime_type, uploader_id, sha256, status, created_at, orphaned_at, deleted_at)
       VALUES (?, ?, 5, 'image/png', 1, ?, 'ready', ?, ?, ?)`,
    )
    .run(
      fileName,
      fileName,
      options.sha256,
      options.createdAt ?? Math.floor(Date.now() / 1000) - 30 * DAY,
      options.orphanedAt ?? null,
      options.deletedAt ?? null,
    )
  return Number(info.lastInsertRowid)
}

function insertCanvasReferencing(content: string): void {
  const doc = jsonSnapshotToDoc({ nodes: [{ id: 'n1', title: 'A', content }] })
  testDb.raw
    .prepare(`INSERT INTO canvases (name, project_id, yjs_update) VALUES ('c', 1, ?)`)
    .run(encodeDocToBase64(doc))
}

beforeEach(() => {
  testDb = createTestDatabase()
  testDb.raw.exec(`INSERT INTO users (id, email, password) VALUES (1, 'g@test.com', 'x')`)
  testDb.raw.exec(
    `INSERT INTO projects (id, name, owner_id, is_public, is_collaborative) VALUES (1, 'p', 1, 0, 0)`,
  )

  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-gc-'))
  process.env.UPLOAD_DIR = uploadDir
  testDb.raw.exec(`CREATE TABLE IF NOT EXISTS gc_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    scanned INTEGER NOT NULL DEFAULT 0,
    orphaned INTEGER NOT NULL DEFAULT 0,
    quarantined INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    aborted TEXT
  )`)
})

describe('collectLiveRefs', () => {
  it('画布正文与封面里的 /api/files/<sha> 都算引用', async () => {
    const a = sha('a')
    const b = sha('b')
    insertCanvasReferencing(`<img src="/api/files/${a}"><p>x</p>`)
    testDb.raw
      .prepare(
        `INSERT INTO node_cards (user_id, name, content, type) VALUES (1, 'k', ?, 'text')`,
      )
      .run(JSON.stringify({ title: 'k', cover: `/api/files/${b}` }))

    const live = await collectLiveRefs(testDb.raw as never)

    expect(live.has(a)).toBe(true)
    expect(live.has(b)).toBe(true)
  })

  it('文档解析失败时抛错（宁可中止，也不把图当孤儿）', async () => {
    testDb.raw
      .prepare(`INSERT INTO canvases (name, project_id, yjs_update) VALUES ('bad', 1, ?)`)
      .run('not-a-valid-base64-doc')

    await expect(collectLiveRefs()).rejects.toThrow(/undecodable/)
  })
})

describe('runFileGc', () => {
  it('被引用的文件不会被标记为孤儿，未引用的才会', async () => {
    const referenced = sha('c')
    const orphan = sha('d')
    insertCanvasReferencing(`<img src="/api/files/${referenced}">`)
    const referencedId = insertFile({ sha256: referenced })
    const orphanId = insertFile({ sha256: orphan })

    const report = await runFileGc({ sqlite: testDb.raw as never, phases: ['mark'] })

    expect(report.orphaned).toBe(1)
    const rows = testDb.raw
      .prepare('SELECT id, orphaned_at FROM files ORDER BY id')
      .all() as Array<{ id: number; orphaned_at: number | null }>
    expect(rows.find((r) => r.id === referencedId)?.orphaned_at).toBeNull()
    expect(rows.find((r) => r.id === orphanId)?.orphaned_at).not.toBeNull()
  })

  it('宽限期内的新文件不动（上传后还没插进正文的窗口）', async () => {
    const fresh = sha('e')
    insertFile({ sha256: fresh, createdAt: Math.floor(Date.now() / 1000) - 60 })

    const report = await runFileGc({ sqlite: testDb.raw as never, phases: ['mark'] })

    expect(report.orphaned).toBe(0)
    const row = testDb.raw.prepare('SELECT orphaned_at FROM files').get() as {
      orphaned_at: number | null
    }
    expect(row.orphaned_at).toBeNull()
  })

  it('dry-run 只统计，不写库也不移文件', async () => {
    const orphan = sha('f')
    insertFile({ sha256: orphan, withBytes: true })

    const report = await runFileGc({ sqlite: testDb.raw as never, dryRun: true })

    expect(report.orphaned).toBe(1)
    const row = testDb.raw.prepare('SELECT orphaned_at, deleted_at FROM files').get() as {
      orphaned_at: number | null
      deleted_at: number | null
    }
    expect(row.orphaned_at).toBeNull()
    expect(row.deleted_at).toBeNull()
    expect(fs.readdirSync(uploadDir).filter((f) => !f.startsWith('.'))).toHaveLength(1)
  })

  it('回收站阶段把字节移进 .trash 并打 deleted_at', async () => {
    const orphan = sha('1')
    const id = insertFile({
      sha256: orphan,
      orphanedAt: Math.floor(Date.now() / 1000) - 30 * DAY,
    })

    await runFileGc({ sqlite: testDb.raw as never, phases: ['quarantine'] })

    const row = testDb.raw.prepare('SELECT path, deleted_at FROM files WHERE id = ?').get(id) as {
      path: string
      deleted_at: number | null
    }
    expect(row.deleted_at).not.toBeNull()
    expect(fs.existsSync(path.join(uploadDir, row.path))).toBe(false)
    expect(fs.existsSync(path.join(uploadDir, '.trash', row.path))).toBe(true)
  })

  it('第二次复查时重新被引用的候选不会被隔离', async () => {
    const rescued = sha('2')
    const id = insertFile({ sha256: rescued, orphanedAt: Math.floor(Date.now() / 1000) - 30 * DAY })
    insertCanvasReferencing(`<img src="/api/files/${rescued}">`)

    await runFileGc({ sqlite: testDb.raw as never, phases: ['quarantine'] })

    const row = testDb.raw.prepare('SELECT deleted_at FROM files WHERE id = ?').get(id) as {
      deleted_at: number | null
    }
    expect(row.deleted_at).toBeNull()
  })

  it('清扫阶段删除过期行与磁盘文件', async () => {
    const gone = sha('3')
    insertFile({ sha256: gone, deletedAt: Math.floor(Date.now() / 1000) - 30 * DAY })

    const report = await runFileGc({ sqlite: testDb.raw as never, phases: ['sweep'] })

    expect(report.deleted).toBe(1)
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM files').get()).toEqual({ n: 0 })
  })

  it('文档损坏时整轮中止，什么都不删', async () => {
    const orphan = sha('4')
    const id = insertFile({ sha256: orphan, deletedAt: Math.floor(Date.now() / 1000) - 30 * DAY })
    testDb.raw
      .prepare(`INSERT INTO canvases (name, project_id, yjs_update) VALUES ('bad', 1, ?)`)
      .run('garbage')

    const report = await runFileGc({ sqlite: testDb.raw as never })

    expect(report.aborted).toMatch(/undecodable/)
    expect(report.deleted).toBe(0)
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM files WHERE id = ?').get(id)).toEqual({ n: 1 })
  })

  it('并发保护：已有未结束的 gc_run 时直接退出', async () => {
    testDb.raw
      .prepare('INSERT INTO gc_runs (started_at) VALUES (?)')
      .run(Math.floor(Date.now() / 1000))

    const report = await runFileGc({ sqlite: testDb.raw as never })

    expect(report.aborted).toBe('another run active')
    expect(report.scanned).toBe(0)
  })
})
