/**
 * One-shot data migration: convert the legacy `yjs_data` column
 * (JSON-base64 canvas snapshot) into a Yjs binary update stored in the new
 * `yjs_update` column.
 *
 * - Idempotent: canvases whose `yjs_update` is already non-empty are skipped.
 * - Non-destructive: the legacy `yjs_data` column is left untouched so the
 *   migration can be rolled back by re-reading it.
 * - Safe to run on an empty database (no-op) and on repeated startups.
 *
 * Invoked from `index.ts` after `initializeDb()`. Can also be run directly via
 * `tsx src/database/migrate-to-yjs.ts`.
 */
import { eq, isNull } from 'drizzle-orm'
import * as Y from 'yjs'
import { pathToFileURL } from 'url'
import { canvases } from './schema.js'
import { getDb } from './connection.js'
import { jsonSnapshotToDoc, encodeDocToBase64 } from '../websocket/yjs-schema.js'
import { log, logError } from '../utils/logger.js'

interface SnapshotShape {
  nodes?: unknown[]
  groups?: unknown[]
  domains?: unknown[]
  connections?: unknown[]
  // legacy canvases also embedded a global `version`; we drop it.
  version?: number
}

export function decodeLegacySnapshot(yjsData: string | null | undefined): SnapshotShape | null {
  if (!yjsData) return null
  try {
    const json = Buffer.from(yjsData, 'base64').toString('utf-8')
    const parsed = JSON.parse(json) as SnapshotShape
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch (err) {
    logError('Failed to decode legacy yjs_data snapshot', (err as Error).message)
    return null
  }
}

/**
 * Run the migration against the live drizzle/better-sqlite3 database.
 * Returns the number of canvases migrated.
 */
export async function migrateCanvasesToYjs(): Promise<number> {
  const db = getDb()
  let migrated = 0
  let skipped = 0
  let empty = 0

  // Select every canvas that has no yjs_update yet. We also pull yjs_data so we
  // can decide whether to convert it or simply seed an empty doc.
  const rows = await db
    .select({
      id: canvases.id,
      yjsData: canvases.yjsData,
      yjsUpdate: canvases.yjsUpdate,
    })
    .from(canvases)
    .where(isNull(canvases.yjsUpdate))

  for (const row of rows) {
    try {
      const snapshot = decodeLegacySnapshot(row.yjsData)
      // Always seed an authoritative Yjs doc, even for empty canvases, so that
      // downstream code can rely on yjs_update being populated once the
      // migration has touched a row.
      const doc = snapshot ? jsonSnapshotToDoc(snapshot) : new Y.Doc()
      const base64 = encodeDocToBase64(doc)

      if (base64.length === 0) {
        // An empty doc still encodes to a few bytes; treat length 0 as failure.
        empty += 1
        continue
      }

      await db
        .update(canvases)
        // B11: 用毫秒时间戳。与运行时持久化（persistCanvasState 写 Date.now()）
        // 和前端缩略图乐观锁（clientVersion）精度保持一致，避免把毫秒级版本
        // 倒退回秒级导致并发 PUT 的 lte 乐观锁检查全部通过。
        .set({ yjsUpdate: base64, updatedAt: Date.now() })
        .where(eq(canvases.id, row.id))

      migrated += 1
    } catch (err) {
      logError('Failed to migrate canvas to Yjs', { canvasId: row.id, error: (err as Error).message })
      skipped += 1
    }
  }

  log('Yjs migration summary', { total: rows.length, migrated, empty, skipped })
  return migrated
}

/**
 * Rollback helper (manual use only): for every canvas whose yjs_update is set
 * but yjs_data is null/empty, regenerate the legacy JSON snapshot from the Yjs
 * doc. Existing yjs_data is never overwritten.
 *
 * This is intentionally conservative — it only fills gaps, it does not undo
 * the new column. Use it as a safety net when reverting to the pre-Yjs code.
 */
export async function backfillLegacySnapshotFromYjs(): Promise<number> {
  const db = getDb()
  let backfilled = 0

  const rows = await db
    .select({ id: canvases.id, yjsData: canvases.yjsData, yjsUpdate: canvases.yjsUpdate })
    .from(canvases)

  for (const row of rows) {
    if (row.yjsData) continue
    if (!row.yjsUpdate) continue
    try {
      const bytes = Buffer.from(row.yjsUpdate, 'base64')
      if (bytes.length === 0) continue
      const doc = new Y.Doc()
      Y.applyUpdate(doc, new Uint8Array(bytes))
      // Lazily import to avoid a hard circular dependency at module load.
      const { docToJsonSnapshot } = await import('../websocket/yjs-schema.js')
      const snapshot = docToJsonSnapshot(doc)
      const base64 = Buffer.from(JSON.stringify(snapshot), 'utf-8').toString('base64')
      await db
        .update(canvases)
        .set({ yjsData: base64 })
        .where(eq(canvases.id, row.id))
      backfilled += 1
    } catch (err) {
      logError('Failed to backfill legacy snapshot', { canvasId: row.id, error: (err as Error).message })
    }
  }
  log('Legacy snapshot backfill summary', { backfilled })
  return backfilled
}

// Allow direct execution: `tsx src/database/migrate-to-yjs.ts`
// (also imports initializeDb to bootstrap the connection when run standalone)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { initializeDb } = await import('./connection.js')
  await initializeDb()
  const count = await migrateCanvasesToYjs()
  log('Standalone Yjs migration finished', { migrated: count })
  process.exit(0)
}
