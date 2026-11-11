/**
 * One-shot migration: legacy nodes → unified nodes (+ images to content-addressed files).
 *
 * See docs/requirements-notebook.md §17. Three moving parts:
 *
 *   M2  every base64 `data:` image inside a node's `content` / `imageUrl` (and
 *       inside node-pool cards) becomes a file row + disk file, and the
 *       reference is replaced by `/api/files/<sha256>`;
 *   M1  `type` / `imageUrl` / `aspectRatio` are folded into `content` / `cover`
 *       and then deleted from the entity;
 *   M3  (cards) the JSON blob in `node_cards.content` gets the same treatment.
 *
 * M2 runs before M1 on purpose: doing it the other way would force the rewrite
 * logic to handle two flavours of `<img>` in one pass.
 *
 * Safety:
 *   - `canvas_yjs_backup` keeps the original `yjs_update` of every canvas the
 *     first time it is rewritten (INSERT OR IGNORE), so a bad run can be undone.
 *   - `--dry-run` counts only; nothing is written.
 *   - A canvas that fails to decode is logged and skipped, never "fixed" by
 *     guessing. The run is idempotent: already-migrated entities no longer carry
 *     legacy fields, so a second pass is a no-op.
 *
 * Runs from index.ts before the HTTP/WS listeners start, so no live Y.Doc is
 * being edited while documents are rewritten.
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import * as Y from 'yjs'
import { eq } from 'drizzle-orm'
import { db, getSqlite } from './connection.js'
import { canvases, nodeCards, projects, files } from './schema.js'
import { decodeBase64ToDoc, encodeDocToBase64, ensureRoot, ymapToObject } from '../websocket/yjs-schema.js'
import { extractFirstImageUrl, normalizeNode } from 'mindmap-shared'
import { log, logError } from '../utils/logger.js'
import { extensionForMime, sniffImageMime } from '../utils/image-bytes.js'
import { pathToFileURL } from 'url'

export interface MigrationOptions {
  dryRun?: boolean
  /** 测试注入的裸连接；生产走 connection.ts 的 getSqlite() */
  sqlite?: RawSqlite
  /** Only canonicalise what is already a URL; skip base64 extraction. */
  keepDataUrls?: boolean
}

export interface MigrationReport {
  canvases: number
  nodes: number
  cards: number
  imagesExtracted: number
  imagesReused: number
  skipped: number
}

/** `data:image/png;base64,....` — grouping keeps mime and payload apart. */
const DATA_IMAGE = /data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=\s]+)/gi

function storageRoot(): string {
  return path.resolve(process.env.UPLOAD_DIR || './uploads')
}

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

/**
 * Raw better-sqlite3 handle behind the drizzle instance.
 *
 * 之前这里走 connection.ts 的 `getSqlite()`，但集成测试替换 connection 模块时只
 * 提供 `db`（`getSqlite()` 返回 null），账本表与备份表就静默不存在——幂等和回滚
 * 测试会退化成空断言。`db.$client` 在生产与测试里都指向真实连接。
 */
type RawSqlite = {
  exec: (sql: string) => unknown
  prepare: (sql: string) => {
    get: (...args: unknown[]) => unknown
    all: (...args: unknown[]) => unknown[]
    run: (...args: unknown[]) => unknown
  }
}

/**
 * 当前生效的裸连接。
 *
 * 生产由 `getSqlite()` 提供；集成测试里 connection 模块被替换成只提供 `db` 的
 * mock，`getSqlite()` 返回 null，账本/备份表会静默不存在（幂等与回滚测试就退化
 * 成空断言）。两个入口都接受 `options.sqlite` 显式注入，测试据此拿到真实连接。
 */
let activeSqlite: RawSqlite | null = null

function rawSqlite(): RawSqlite {
  const handle = activeSqlite
    ?? (db as unknown as { $client?: RawSqlite }).$client
    ?? (getSqlite() as unknown as RawSqlite | null)
  if (!handle) throw new Error('sqlite handle unavailable')
  return handle
}

function tableExists(sqlite: RawSqlite, name: string): boolean {
  const row = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name) as { name?: string } | undefined
  return Boolean(row?.name)
}

/** Create the migration bookkeeping + backup tables (idempotent). */
export function ensureMigrationTables(): void {
  const sqlite = rawSqlite()
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS applied_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS canvas_yjs_backup (
      canvas_id INTEGER PRIMARY KEY,
      yjs_update TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
}

function isMigrated(name: string): boolean {
  const sqlite = rawSqlite()
  const row = sqlite.prepare('SELECT name FROM applied_migrations WHERE name = ?').get(name) as
    | { name?: string }
    | undefined
  return Boolean(row?.name)
}

function markMigrated(name: string): void {
  const sqlite = rawSqlite()
  sqlite
    .prepare('INSERT OR REPLACE INTO applied_migrations (name, applied_at) VALUES (?, ?)')
    .run(name, Date.now())
}

function backupCanvas(canvasId: number, yjsUpdate: string): void {
  const sqlite = rawSqlite()
  sqlite
    .prepare('INSERT OR IGNORE INTO canvas_yjs_backup (canvas_id, yjs_update, created_at) VALUES (?, ?, ?)')
    .run(canvasId, yjsUpdate, Date.now())
}

interface ImageStore {
  /** Replace every base64 image in the string with a `/api/files/<sha>` URL. */
  rewrite: (html: string) => Promise<string>
  stats: { extracted: number; reused: number }
}

/**
 * Build the image rewriter for one owner. Files are content-addressed, so the
 * same picture referenced from three nodes is stored (and counted) once.
 */
function createImageStore(uploaderId: number, dryRun: boolean): ImageStore {
  const stats = { extracted: 0, reused: 0 }
  const root = storageRoot()

  async function store(payload: Buffer, mime: string): Promise<string> {
    const hash = sha256(payload)
    const existing = await db.query.files.findFirst({ where: eq(files.sha256, hash) })
    if (existing) {
      stats.reused += 1
      return `/api/files/${hash}`
    }
    stats.extracted += 1
    if (dryRun) return `/api/files/${hash}`

    const fileName = `${hash.slice(0, 32)}.${extensionForMime(mime)}`
    await fs.promises.mkdir(root, { recursive: true })
    await fs.promises.writeFile(path.join(root, fileName), payload)
    await db.insert(files).values({
      filename: fileName,
      path: fileName,
      size: payload.length,
      mimeType: mime,
      uploaderId,
      projectId: null,
      sha256: hash,
      status: 'ready',
    })
    return `/api/files/${hash}`
  }

  async function rewrite(html: string): Promise<string> {
    if (!html || !html.includes('data:image')) return html

    const matches = Array.from(html.matchAll(DATA_IMAGE))
    if (matches.length === 0) return html

    let out = html
    for (const match of matches) {
      const [whole, declaredMime, base64Payload] = match
      const payload = Buffer.from(base64Payload.replace(/\s+/g, ''), 'base64')
      const realMime = sniffImageMime(payload) || declaredMime
      const url = await store(payload, realMime)
      out = out.split(whole).join(url)
    }
    return out
  }

  return { rewrite, stats }
}

/**
 * Fold one entity's legacy fields into the unified shape and rewrite its images.
 * Returns the number of legacy fields touched (0 means "already unified").
 */
async function migrateEntity(
  obj: Record<string, unknown>,
  images: ImageStore,
  keepDataUrls: boolean,
): Promise<{ changed: boolean; entity: Record<string, unknown> }> {
  const hasLegacy =
    obj.type !== undefined || obj.imageUrl !== undefined || obj.aspectRatio !== undefined
  const content = typeof obj.content === 'string' ? obj.content : ''
  const legacyImage = typeof obj.imageUrl === 'string' ? obj.imageUrl : ''
  const hasDataImage = content.includes('data:image') || legacyImage.includes('data:image')

  if (!hasLegacy && !hasDataImage) return { changed: false, entity: obj }

  let nextContent = content
  if (hasDataImage && !keepDataUrls) {
    nextContent = await images.rewrite(nextContent)
    if (legacyImage.includes('data:image')) {
      // The legacy single-image field: materialise it, then normalizeNode will
      // fold the resulting URL into content/cover like any other image.
      const rewritten = await images.rewrite(`<img src="${legacyImage}" alt="">`)
      const url = extractFirstImageUrl(rewritten)
      if (url) obj = { ...obj, imageUrl: url }
    }
  }

  // normalizeNode 负责把 legacy imageUrl 折成 content/cover 并删除已废弃字段
  const normalized = normalizeNode({ ...obj, content: nextContent })
  return { changed: true, entity: normalized as unknown as Record<string, unknown> }
}

const MIGRATION_NAME = '202611-node-unify'

/**
 * Run the migration. Safe to call on every boot: a recorded run short-circuits,
 * and a partially applied run simply re-processes the entities that still carry
 * legacy fields.
 */
export async function migrateNodesToUnified(options: MigrationOptions = {}): Promise<MigrationReport> {
  const { dryRun = false, keepDataUrls = false } = options
  activeSqlite = options.sqlite ?? null
  const report: MigrationReport = {
    canvases: 0,
    nodes: 0,
    cards: 0,
    imagesExtracted: 0,
    imagesReused: 0,
    skipped: 0,
  }

  if (!dryRun) {
    ensureMigrationTables()
    if (isMigrated(MIGRATION_NAME)) {
      log('Node unification migration already applied, skipping')
      return report
    }
  }

  // ---- canvases ---------------------------------------------------------
  const canvasRows = await db
    .select({
      id: canvases.id,
      yjsUpdate: canvases.yjsUpdate,
      ownerId: projects.ownerId,
    })
    .from(canvases)
    .leftJoin(projects, eq(canvases.projectId, projects.id))

  for (const row of canvasRows) {
    if (!row.yjsUpdate) continue
    report.canvases += 1

    try {
      const doc = decodeBase64ToDoc(row.yjsUpdate)
      if (!doc) {
        report.skipped += 1
        logError('Node unify: canvas doc undecodable, skipped', { canvasId: row.id })
        continue
      }

      const collections = ensureRoot(doc)
      const images = createImageStore(row.ownerId ?? 1, dryRun)
      let touched = 0

      const entries = Array.from(collections.nodes.entries())
      for (const [nodeId, ymap] of entries) {
        const obj = ymapToObject(ymap) as Record<string, unknown>
        const { changed, entity } = await migrateEntity(obj, images, keepDataUrls)
        if (!changed) continue

        touched += 1
        report.nodes += 1
        if (dryRun) continue

        doc.transact(() => {
          for (const key of ['type', 'imageUrl', 'aspectRatio']) {
            if (ymap.has(key)) ymap.delete(key)
          }
          for (const [key, value] of Object.entries(entity)) {
            if (key === 'id') continue
            if (value === undefined) continue
            ymap.set(key, value)
          }
        }, 'node-unify-migration')
      }

      report.imagesExtracted += images.stats.extracted
      report.imagesReused += images.stats.reused

      if (!dryRun && touched > 0) {
        backupCanvas(row.id, row.yjsUpdate)
        await db
          .update(canvases)
          .set({ yjsUpdate: encodeDocToBase64(doc), updatedAt: Date.now() })
          .where(eq(canvases.id, row.id))
      }

      if (report.canvases % 50 === 0) {
        log('Node unify progress', { canvases: report.canvases, nodes: report.nodes })
      }
    } catch (error) {
      report.skipped += 1
      logError('Node unify: canvas failed, skipped', {
        canvasId: row.id,
        error: (error as Error).message,
      })
    }
  }

  // ---- node-pool cards --------------------------------------------------
  const cardRows = await db
    .select({ id: nodeCards.id, content: nodeCards.content, userId: nodeCards.userId })
    .from(nodeCards)

  for (const row of cardRows) {
    if (!row.content) continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(row.content) as Record<string, unknown>
      if (!parsed || typeof parsed !== 'object') continue
    } catch {
      continue
    }

    const images = createImageStore(row.userId, dryRun)
    try {
      const { changed, entity } = await migrateEntity(parsed, images, keepDataUrls)
      report.imagesExtracted += images.stats.extracted
      report.imagesReused += images.stats.reused
      if (!changed) continue

      report.cards += 1
      if (dryRun) continue
      await db
        .update(nodeCards)
        .set({ content: JSON.stringify(entity) })
        .where(eq(nodeCards.id, row.id))
    } catch (error) {
      report.skipped += 1
      logError('Node unify: card failed, skipped', {
        cardId: row.id,
        error: (error as Error).message,
      })
    }
  }

  if (!dryRun) markMigrated(MIGRATION_NAME)

  log('Node unification migration finished', { ...report, dryRun })
  return report
}

/**
 * Manual rollback helper: restore every backed-up canvas document.
 * Files created by the migration are intentionally left on disk — the restored
 * documents reference them by hash again, so deleting them would break images.
 */
export async function rollbackNodeUnify(options: { sqlite?: RawSqlite } = {}): Promise<number> {
  activeSqlite = options.sqlite ?? null
  const sqlite = rawSqlite()
  if (!tableExists(sqlite, 'canvas_yjs_backup')) return 0

  const rows = sqlite
    .prepare('SELECT canvas_id, yjs_update FROM canvas_yjs_backup')
    .all() as Array<{ canvas_id: number; yjs_update: string }>

  let restored = 0
  for (const row of rows) {
    await db
      .update(canvases)
      .set({ yjsUpdate: row.yjs_update, updatedAt: Date.now() })
      .where(eq(canvases.id, row.canvas_id))
    restored += 1
  }

  sqlite.prepare("DELETE FROM applied_migrations WHERE name = ?").run(MIGRATION_NAME)
  log('Node unification rollback finished', { restored })
  return restored
}

// Allow direct execution:
//   tsx src/database/migrate-node-unify.ts --dry-run
//   tsx src/database/migrate-node-unify.ts            (真的写)
//   tsx src/database/migrate-node-unify.ts --rollback (还原备份)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // 建表交给 initDatabase（它会跑 runMigrations）；只 initializeDb 只会打开连接，
  // 空库上会因为缺表直接报错。
  const { initDatabase } = await import('./init.js')
  const { initializeDb } = await import('./connection.js')
  await initializeDb()
  initDatabase()

  if (process.argv.includes('--rollback')) {
    const restored = await rollbackNodeUnify()
    console.log(`rollback: ${restored} canvases restored`)
    process.exit(0)
  }

  const dryRun = process.argv.includes('--dry-run')
  const report = await migrateNodesToUnified({ dryRun })
  console.log(JSON.stringify({ dryRun, ...report }, null, 2))
  process.exit(0)
}