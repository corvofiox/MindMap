/**
 * Orphaned image GC — mark → quarantine → sweep (docs/requirements-notebook.md §18).
 *
 * ## Why mark-and-sweep instead of refcounting
 *
 * A file reference lives *inside* user-editable HTML and CRDT documents
 * (`<img src="/api/files/<sha>">`), not in a foreign key. Every write path —
 * typing, undo/redo, a peer's diff, a card import — can drop a reference without
 * any "delete" call to hook. Refcounts therefore drift, and the failure mode is
 * asymmetric: one missed decrement leaks a file, one double decrement deletes a
 * picture that is still on screen. So we never trust writers; we recompute the
 * live set from the documents themselves.
 *
 * ## Three phases
 *
 *   mark       referenced-by-nobody AND older than `graceHours` → set orphaned_at
 *   quarantine orphaned_at older than `retainDays` AND still unreferenced →
 *              move the bytes to `<UPLOAD_DIR>/.trash/`, set deleted_at
 *   sweep      deleted_at older than `trashDays` → unlink + delete row
 *
 * Every phase is idempotent and re-runnable. `--dry-run` writes nothing.
 *
 * ## Safety valves
 *
 *   - water line: only files created before `T0 - graceHours` are candidates, so
 *     an image uploaded (or inserted) *during* the scan can never be swept;
 *   - second look: candidates are re-checked against the live set right before
 *     quarantining;
 *   - hard cap: abort if a run would touch more than `maxDelete` files or
 *     `maxBytes` — a suspiciously large batch usually means a scan source was
 *     missed, and stopping is cheaper than restoring pictures;
 *   - fail closed: if any document cannot be parsed, the whole run aborts
 *     ("contains unknown references") rather than deleting live images.
 */
import fs from 'fs'
import path from 'path'
import { and, eq, isNull, lt, isNotNull } from 'drizzle-orm'
import { db, getSqlite } from './connection.js'
import { canvases, nodeCards, files } from './schema.js'
import { decodeBase64ToDoc, ensureRoot, ymapToObject } from '../websocket/yjs-schema.js'
import { log, logError } from '../utils/logger.js'
import { pathToFileURL } from 'url'

export interface GcOptions {
  /** 建库后多久内不动（小时），默认 24 */
  graceHours?: number
  /** 标记为孤儿后保留多久（天），默认 7 */
  retainDays?: number
  /** 进回收站后保留多久（天），默认 7 */
  trashDays?: number
  /** 单次最多处理多少文件，默认 500 */
  maxDelete?: number
  /** 单次最多处理多少字节，默认 1 GiB */
  maxBytes?: number
  dryRun?: boolean
  /** 跳过某阶段用，默认三阶段都跑 */
  phases?: Array<'mark' | 'quarantine' | 'sweep'>
  sqlite?: RawSqlite
}

export interface GcReport {
  scanned: number
  live: number
  orphaned: number
  quarantined: number
  deleted: number
  bytes: number
  aborted?: string
}

type RawSqlite = {
  exec: (sql: string) => unknown
  prepare: (sql: string) => {
    get: (...args: unknown[]) => unknown
    all: (...args: unknown[]) => unknown[]
    run: (...args: unknown[]) => unknown
  }
}

let activeSqlite: RawSqlite | null = null

function rawSqlite(): RawSqlite {
  const handle = activeSqlite
    ?? (db as unknown as { $client?: RawSqlite }).$client
    ?? (getSqlite() as unknown as RawSqlite | null)
  if (!handle) throw new Error('sqlite handle unavailable')
  return handle
}

export function storageRoot(): string {
  return path.resolve(process.env.UPLOAD_DIR || './uploads')
}

function trashRoot(): string {
  return path.join(storageRoot(), '.trash')
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

const FILE_REF = /\/api\/files\/([a-f0-9]{64})/g

/** Every sha256 referenced by an arbitrary HTML/JSON string. */
export function extractFileRefs(text: string | null | undefined, into: Set<string> = new Set()): Set<string> {
  if (!text) return into
  for (const match of text.matchAll(FILE_REF)) into.add(match[1])
  return into
}

export function ensureGcTables(): void {
  const sqlite = rawSqlite()
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS gc_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      scanned INTEGER NOT NULL DEFAULT 0,
      orphaned INTEGER NOT NULL DEFAULT 0,
      quarantined INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      aborted TEXT
    )
  `)
}

/**
 * Collect every sha256 that some live document still points at.
 *
 * Any parse failure throws: we must never treat an unreadable document as
 * "references nothing", because that would mark its images as orphans.
 */
export async function collectLiveRefs(sqliteOverride?: RawSqlite): Promise<Set<string>> {
  const live = new Set<string>()

  const canvasRows = await db.select({ id: canvases.id, yjsUpdate: canvases.yjsUpdate }).from(canvases)
  for (const row of canvasRows) {
    if (!row.yjsUpdate) continue
    let doc
    try {
      doc = decodeBase64ToDoc(row.yjsUpdate)
    } catch (error) {
      throw new Error(`canvas ${row.id} undecodable: ${(error as Error).message}`)
    }
    if (!doc) throw new Error(`canvas ${row.id} undecodable: empty document`)
    const collections = ensureRoot(doc)
    for (const ymap of collections.nodes.values()) {
      const obj = ymapToObject(ymap) as Record<string, unknown>
      extractFileRefs(typeof obj.content === 'string' ? obj.content : '', live)
      extractFileRefs(typeof obj.cover === 'string' ? obj.cover : '', live)
    }
  }

  const cardRows = await db.select({ id: nodeCards.id, content: nodeCards.content }).from(nodeCards)
  for (const row of cardRows) {
    try {
      JSON.parse(row.content)
    } catch (error) {
      throw new Error(`card ${row.id} undecodable: ${(error as Error).message}`)
    }
    extractFileRefs(row.content, live)
  }

  // manuscripts 表在笔记本功能落地后才有；存在就必须一并扫描，否则手稿里的图
  // 会被当成孤儿。表不存在时静默跳过（P5 之前）。
  const sqlite = sqliteOverride ?? activeSqlite ?? rawSqlite()
  const hasManuscripts = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='manuscripts'")
    .get() as { name?: string } | undefined
  if (hasManuscripts?.name) {
    const rows = sqlite
      .prepare('SELECT id, content_html FROM manuscripts WHERE deleted_at IS NULL')
      .all() as Array<{ id: number; content_html: string }>
    for (const row of rows) extractFileRefs(row.content_html, live)
  }

  return live
}

/** Claim the GC mutex; returns the run id, or null when another run is active. */
function beginRun(sqlite: RawSqlite): number | null {
  const running = sqlite
    .prepare('SELECT id FROM gc_runs WHERE finished_at IS NULL LIMIT 1')
    .get() as { id?: number } | undefined
  if (running?.id) return null
  const info = sqlite
    .prepare('INSERT INTO gc_runs (started_at) VALUES (?)')
    .run(nowSeconds()) as { lastInsertRowid?: number | bigint }
  return Number(info.lastInsertRowid ?? 0)
}

function finishRun(sqlite: RawSqlite, runId: number, report: GcReport): void {
  sqlite
    .prepare(
      `UPDATE gc_runs
          SET finished_at = ?, scanned = ?, orphaned = ?, quarantined = ?, deleted = ?, bytes = ?, aborted = ?
        WHERE id = ?`,
    )
    .run(
      nowSeconds(),
      report.scanned,
      report.orphaned,
      report.quarantined,
      report.deleted,
      report.bytes,
      report.aborted ?? null,
      runId,
    )
}

/**
 * Run the GC. Safe to call repeatedly; a concurrent run is rejected via gc_runs.
 */
export async function runFileGc(options: GcOptions = {}): Promise<GcReport> {
  const {
    graceHours = Number(process.env.GC_GRACE_HOURS ?? 24),
    retainDays = Number(process.env.GC_RETAIN_DAYS ?? 7),
    trashDays = Number(process.env.GC_TRASH_DAYS ?? 7),
    maxDelete = Number(process.env.GC_MAX_FILES ?? 500),
    maxBytes = Number(process.env.GC_MAX_BYTES ?? 1024 * 1024 * 1024),
    dryRun = false,
    phases = ['mark', 'quarantine', 'sweep'],
  } = options

  activeSqlite = options.sqlite ?? null
  const report: GcReport = { scanned: 0, live: 0, orphaned: 0, quarantined: 0, deleted: 0, bytes: 0 }

  const sqlite = rawSqlite()
  if (!dryRun) ensureGcTables()

  const runId = dryRun ? null : beginRun(sqlite)
  if (!dryRun && runId === null) {
    log('File GC skipped: another run is still active')
    return { ...report, aborted: 'another run active' }
  }

  const t0 = nowSeconds()
  const watermark = t0 - graceHours * 3600

  try {
    const live = await collectLiveRefs(sqlite)
    report.live = live.size
    const all = await db.select().from(files)
    report.scanned = all.length

    // ---- mark ----
    if (phases.includes('mark')) {
      const candidates = all.filter(
        (file) =>
          file.sha256 &&
          file.deletedAt === null &&
          file.orphanedAt === null &&
          !live.has(file.sha256) &&
          Number(file.createdAt ?? 0) < watermark,
      )
      report.orphaned = candidates.length
      if (!dryRun) {
        for (const file of candidates) {
          await db.update(files).set({ orphanedAt: t0 }).where(eq(files.id, file.id))
        }
      }
    }

    // ---- quarantine ----
    if (phases.includes('quarantine')) {
      const retainBefore = t0 - retainDays * 86400
      const marked = await db
        .select()
        .from(files)
        .where(and(isNotNull(files.orphanedAt), lt(files.orphanedAt, retainBefore), isNull(files.deletedAt)))

      // Second look: re-check the specific candidates against the live set we
      // just computed (a reference may have appeared since the mark phase).
      const toQuarantine = marked.filter((file) => !file.sha256 || !live.has(file.sha256))

      if (toQuarantine.length > maxDelete) {
        report.aborted = `quarantine candidates ${toQuarantine.length} exceed cap ${maxDelete}`
        logError('File GC aborted: quarantine batch too large', { candidates: toQuarantine.length })
      } else {
        for (const file of toQuarantine) {
          report.quarantined += 1
          if (dryRun) continue
          const from = path.join(storageRoot(), file.path)
          const to = path.join(trashRoot(), file.path)
          try {
            await fs.promises.mkdir(trashRoot(), { recursive: true })
            if (fs.existsSync(from)) await fs.promises.rename(from, to)
            await db.update(files).set({ deletedAt: t0 }).where(eq(files.id, file.id))
          } catch (error) {
            logError('File GC quarantine failed', { id: file.id, error: (error as Error).message })
          }
        }
      }
    }

    // ---- sweep ----
    if (phases.includes('sweep')) {
      const sweepBefore = t0 - trashDays * 86400
      const expired = await db
        .select()
        .from(files)
        .where(and(isNotNull(files.deletedAt), lt(files.deletedAt, sweepBefore)))

      let bytes = 0
      for (const file of expired) {
        if (report.deleted >= maxDelete || bytes + file.size > maxBytes) {
          report.aborted = `sweep cap reached (${report.deleted} files / ${bytes} bytes)`
          break
        }
        report.deleted += 1
        bytes += file.size
        if (dryRun) continue
        const target = path.join(trashRoot(), file.path)
        try {
          if (fs.existsSync(target)) await fs.promises.unlink(target)
          await db.delete(files).where(eq(files.id, file.id))
        } catch (error) {
          logError('File GC sweep failed', { id: file.id, error: (error as Error).message })
        }
      }
      report.bytes = bytes
    }
  } catch (error) {
    // Fail closed: an unparsable document means "unknown references everywhere".
    report.aborted = (error as Error).message
    logError('File GC aborted', report.aborted)
  } finally {
    if (!dryRun && runId !== null) finishRun(sqlite, runId, report)
  }

  log('File GC finished', { ...report, dryRun })
  return report
}

// 直接执行：
//   tsx src/database/gc-files.ts --dry-run        只统计
//   tsx src/database/gc-files.ts                  真跑三阶段
//   tsx src/database/gc-files.ts --mark           只跑某一阶段（可重复传）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // 建表交给 initDatabase（它会跑 runMigrations）；只 initializeDb 只会打开连接，
  // 空库上会因为缺表直接报错。
  const { initDatabase } = await import('./init.js')
  const { initializeDb } = await import('./connection.js')
  await initializeDb()
  initDatabase()

  const dryRun = process.argv.includes('--dry-run')
  const requested = (['mark', 'quarantine', 'sweep'] as const).filter((phase) =>
    process.argv.includes(`--${phase}`),
  )
  const report = await runFileGc({
    dryRun,
    ...(requested.length > 0 ? { phases: [...requested] } : {}),
  })
  console.log(JSON.stringify({ dryRun, ...report }, null, 2))
  process.exit(0)
}