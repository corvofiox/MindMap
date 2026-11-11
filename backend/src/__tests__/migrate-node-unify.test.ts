/**
 * migrate-node-unify — the one-shot legacy→unified migration.
 *
 * Pinned behaviours (docs/requirements-notebook.md §17):
 *   - dry-run counts but writes nothing (no doc rewrite, no file, no rows);
 *   - base64 images become content-addressed file rows and are replaced by
 *     `/api/files/<sha>` inside the node content;
 *   - identical images dedupe to a single row;
 *   - `type` / `imageUrl` / `aspectRatio` are folded into `content` / `cover`
 *     and removed from the entity;
 *   - node-pool cards get the same treatment;
 *   - the run is idempotent, and `rollbackNodeUnify` restores the backed-up doc.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as Y from 'yjs'

vi.mock('../utils/logger.js', () => ({ log: vi.fn(), logError: vi.fn() }))

vi.mock('../database/connection.js', async () => {
  const { installDbMock } = await import('./helpers/integration-harness.js')
  return installDbMock()
})

process.env.JWT_SECRET = process.env.JWT_SECRET || 'migrate-test-jwt-secret'
process.env.DB_FILE = ':memory:'

const { createTestDatabase } = await import('./helpers/integration-harness.js')
const { jsonSnapshotToDoc, encodeDocToBase64, decodeBase64ToDoc, ensureRoot, ymapToObject } =
  await import('../websocket/yjs-schema.js')
const { migrateNodesToUnified, rollbackNodeUnify } = await import(
  '../database/migrate-node-unify.js'
)

let testDb: ReturnType<typeof createTestDatabase>
let uploadDir: string

/** 8-byte PNG signature + payload; the migration only sniffs the signature. */
function png(seed: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(seed),
  ])
}

function dataUrl(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString('base64')}`
}

function seedCanvas(nodes: Array<Record<string, unknown>>): number {
  const doc = jsonSnapshotToDoc({ nodes })
  const base64 = encodeDocToBase64(doc)
  const info = testDb.raw
    .prepare(
      `INSERT INTO canvases (name, project_id, yjs_update) VALUES ('c', 1, ?)`,
    )
    .run(base64)
  return Number(info.lastInsertRowid)
}

function readNodes(canvasId: number): Record<string, unknown>[] {
  const row = testDb.raw
    .prepare('SELECT yjs_update FROM canvases WHERE id = ?')
    .get(canvasId) as { yjs_update: string }
  const doc = decodeBase64ToDoc(row.yjs_update) as Y.Doc
  const collections = ensureRoot(doc)
  return Array.from(collections.nodes.values()).map((ymap) => ymapToObject(ymap))
}

beforeAll(() => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-unify-'))
  process.env.UPLOAD_DIR = uploadDir
})

beforeEach(() => {
  testDb = createTestDatabase()
  testDb.raw.exec(`INSERT INTO users (id, email, password) VALUES (1, 'u@test.com', 'x')`)
  testDb.raw.exec(
    `INSERT INTO projects (id, name, owner_id, is_public, is_collaborative) VALUES (1, 'p', 1, 0, 0)`,
  )
  // 迁移的账本/备份表由生产代码在启动时创建；测试里直接建，避免依赖 connection 单例。
  testDb.raw.exec(`
    CREATE TABLE IF NOT EXISTS applied_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `)
  testDb.raw.exec(`
    CREATE TABLE IF NOT EXISTS canvas_yjs_backup (
      canvas_id INTEGER PRIMARY KEY,
      yjs_update TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  testDb.raw.exec('DELETE FROM applied_migrations')
  testDb.raw.exec('DELETE FROM canvas_yjs_backup')
  fs.rmSync(uploadDir, { recursive: true, force: true })
  fs.mkdirSync(uploadDir, { recursive: true })
})

describe('migrateNodesToUnified', () => {
  it('dry-run 只统计，不改文档也不落文件', async () => {
    const canvasId = seedCanvas([
      { id: 'n1', title: 'A', type: 'image', imageUrl: dataUrl(png('dry')) },
    ])
    const before = testDb.raw.prepare('SELECT yjs_update FROM canvases WHERE id = ?').get(canvasId)

    const report = await migrateNodesToUnified({ dryRun: true, sqlite: testDb.raw as never })

    expect(report.nodes).toBe(1)
    expect(report.imagesExtracted).toBe(1)
    const after = testDb.raw.prepare('SELECT yjs_update FROM canvases WHERE id = ?').get(canvasId)
    expect(after).toEqual(before)
    expect(fs.readdirSync(uploadDir)).toHaveLength(0)
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM files').get()).toEqual({ n: 0 })
  })

  it('把 base64 图抽成文件，并把正文替换为 /api/files/<sha>', async () => {
    const image = png('extract')
    const canvasId = seedCanvas([
      { id: 'n1', title: 'A', content: `<p>看图</p><img src="${dataUrl(image)}">` },
    ])

    const report = await migrateNodesToUnified({ sqlite: testDb.raw as never })

    expect(report.nodes).toBe(1)
    expect(report.imagesExtracted).toBe(1)

    const nodes = readNodes(canvasId)
    const content = String(nodes[0].content)
    expect(content).not.toContain('data:image')
    expect(content).toMatch(/\/api\/files\/[a-f0-9]{64}/)
    expect(nodes[0].cover).toMatch(/^\/api\/files\/[a-f0-9]{64}$/)

    const rows = testDb.raw.prepare('SELECT sha256, path, mime_type, size FROM files').all() as Array<{
      sha256: string
      path: string
      mime_type: string
      size: number
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0].mime_type).toBe('image/png')
    expect(fs.existsSync(path.join(uploadDir, rows[0].path))).toBe(true)
    expect(content).toContain(rows[0].sha256)
  })

  it('相同图片只存一份（去重），两个节点指向同一 URL', async () => {
    const image = png('same-bytes')
    const canvasId = seedCanvas([
      { id: 'n1', title: 'A', content: `<img src="${dataUrl(image)}">` },
      { id: 'n2', title: 'B', content: `<img src="${dataUrl(image)}">` },
    ])

    const report = await migrateNodesToUnified({ sqlite: testDb.raw as never })

    expect(report.nodes).toBe(2)
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM files').get()).toEqual({ n: 1 })
    const nodes = readNodes(canvasId)
    const urls = nodes.map((n) => String(n.content).match(/\/api\/files\/[a-f0-9]{64}/)?.[0])
    expect(urls[0]).toBe(urls[1])
  })

  it('老图片节点：type/imageUrl/aspectRatio 折成 content/cover 后被删除', async () => {
    const sha = 'd'.repeat(64)
    const canvasId = seedCanvas([
      {
        id: 'n1',
        title: '图',
        type: 'image',
        imageUrl: `/api/files/${sha}`,
        aspectRatio: 1.5,
        width: 320,
      },
    ])

    await migrateNodesToUnified({ sqlite: testDb.raw as never })

    const node = readNodes(canvasId)[0]
    expect(node).not.toHaveProperty('type')
    expect(node).not.toHaveProperty('imageUrl')
    expect(node).not.toHaveProperty('aspectRatio')
    expect(node.content).toBe(`<img src="/api/files/${sha}" alt="">`)
    expect(node.cover).toBe(`/api/files/${sha}`)
    // 其他字段必须原样保留
    expect(node.title).toBe('图')
    expect(node.width).toBe(320)
  })

  it('节点池卡片走同一套规则', async () => {
    const image = png('card')
    testDb.raw
      .prepare(
        `INSERT INTO node_cards (user_id, name, content, type) VALUES (1, '卡片', ?, 'image')`,
      )
      .run(JSON.stringify({ title: '卡片', type: 'image', content: `<img src="${dataUrl(image)}">` }))

    const report = await migrateNodesToUnified({ sqlite: testDb.raw as never })

    expect(report.cards).toBe(1)
    const row = testDb.raw.prepare('SELECT content FROM node_cards').get() as { content: string }
    const parsed = JSON.parse(row.content)
    expect(parsed.content).not.toContain('data:image')
    expect(parsed.content).toMatch(/\/api\/files\/[a-f0-9]{64}/)
    expect(parsed.type).toBeUndefined()
  })

  it('幂等：第二次运行直接跳过，文档不再变化', async () => {
    const canvasId = seedCanvas([
      { id: 'n1', title: 'A', type: 'image', imageUrl: `/api/files/${'e'.repeat(64)}` },
    ])

    await migrateNodesToUnified({ sqlite: testDb.raw as never })
    const afterFirst = readNodes(canvasId)
    const second = await migrateNodesToUnified({ sqlite: testDb.raw as never })

    expect(second.nodes).toBe(0)
    expect(readNodes(canvasId)).toEqual(afterFirst)
  })

  it('回滚：从备份列还原文档并清掉迁移记录', async () => {
    const canvasId = seedCanvas([
      { id: 'n1', title: 'A', type: 'image', imageUrl: `/api/files/${'f'.repeat(64)}` },
    ])
    const original = testDb.raw
      .prepare('SELECT yjs_update FROM canvases WHERE id = ?')
      .get(canvasId) as { yjs_update: string }

    await migrateNodesToUnified({ sqlite: testDb.raw as never })
    expect(readNodes(canvasId)[0].type).toBeUndefined()

    const restored = await rollbackNodeUnify({ sqlite: testDb.raw as never })

    expect(restored).toBe(1)
    const now = testDb.raw.prepare('SELECT yjs_update FROM canvases WHERE id = ?').get(canvasId) as {
      yjs_update: string
    }
    expect(now.yjs_update).toBe(original.yjs_update)
    // 迁移记录被清掉，下一次启动会重新尝试
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM applied_migrations').get()).toEqual({ n: 0 })
  })
})
