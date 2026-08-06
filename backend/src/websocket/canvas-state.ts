/**
 * Yjs-backed canvas state manager.
 *
 * Each open canvas has a single Y.Doc held in memory by the server. Clients
 * never send operation payloads; they send Yjs binary updates over the
 * WebSocket and the server applies them to its authoritative doc, then
 * broadcasts the update to every other client in the room.
 *
 * Persistence:
 *   - The doc is encoded via Y.encodeStateAsUpdate and stored base64 in the
 *     `yjs_update` column (see yjs-schema.ts).
 *   - Writes are debounced (100ms) and additionally flushed every 1s by a
 *     periodic timer, plus on graceful shutdown.
 *
 * Concurrency safety:
 *   - A per-canvas generation counter (incremented when a room is created)
 *     prevents stale async persist callbacks from clobbering a freshly-loaded
 *     doc after the room is torn down.
 */
import * as Y from 'yjs'
import { db } from '../database/connection.js'
import { canvases } from '../database/schema.js'
import { eq } from 'drizzle-orm'
import { log, logError } from '../utils/logger.js'
import {
  ensureRoot,
  decodeBase64ToDoc,
  jsonSnapshotToDoc,
  encodeDocToBase64,
  docToJsonSnapshot,
  writeEntityToYMap,
} from './yjs-schema.js'

export interface YjsCanvasState {
  doc: Y.Doc
  loaded: boolean
  /**
   * Monotonic counter bumped on every accepted doc update. Compared against
   * `lastPersistedUpdateCount` to decide whether the in-memory doc is ahead
   * of the persisted snapshot.
   */
  lastSeenUpdateCount: number
  lastPersistedUpdateCount: number
  isPersisting: boolean
  /**
   * Set when persistCanvasState exhausts its retries. Surfaced to clients so
   * they can warn that recent in-memory changes have NOT been saved to DB.
   */
  persistError: { message: string; attempts: number } | null
  /** Bound update listener used to detect dirty state and broadcast. */
  updateListener: (update: Uint8Array, origin: unknown) => void
  /**
   * 最近一次活动时间（load/merge/update 都会刷新），用于 A13 空闲回收：
   * 长时间无活动且已完全持久化的状态会被移除，防止纯 REST 场景内存无限增长。
   */
  lastActivityAt: number
}

const canvasStates = new Map<number, YjsCanvasState>()
const loadingPromises = new Map<number, Promise<YjsCanvasState>>()
const pendingPersists: Promise<boolean>[] = []
const persistPromises = new Map<number, Promise<boolean>>()

// Generation counter: bumped each time a room is created, used to prevent a
// stale async persist callback from deleting a freshly-loaded doc.
const stateGenerations = new Map<number, number>()

function trackPersist(promise: Promise<boolean>): Promise<boolean> {
  pendingPersists.push(promise)
  const cleanup = () => {
    const idx = pendingPersists.indexOf(promise)
    if (idx !== -1) pendingPersists.splice(idx, 1)
  }
  promise.then(cleanup, cleanup)
  return promise
}

// Periodic flush: ensure all dirty canvas docs are persisted to DB regularly.
const PERIODIC_FLUSH_INTERVAL_MS = 1000
let periodicFlushTimer: ReturnType<typeof setInterval> | null = null

export function startPeriodicCanvasFlush(): void {
  if (periodicFlushTimer) return
  periodicFlushTimer = setInterval(() => {
    flushAllCanvasStates()
  }, PERIODIC_FLUSH_INTERVAL_MS)
  log('Periodic canvas state flush started', { intervalMs: PERIODIC_FLUSH_INTERVAL_MS })
}

export function stopPeriodicCanvasFlush(): void {
  if (periodicFlushTimer) {
    clearInterval(periodicFlushTimer)
    periodicFlushTimer = null
    log('Periodic canvas state flush stopped')
  }
}

export async function flushAllCanvasStates(): Promise<void> {
  if (pendingPersists.length > 0) {
    await Promise.allSettled(pendingPersists)
  }

  const canvasIds = Array.from(canvasStates.keys())
  if (canvasIds.length === 0) return

  const results = canvasIds.map((canvasId) => persistCanvasState(canvasId))
  await Promise.allSettled(results)

  if (canvasIds.length > 0) {
    log('Flushed all canvas docs', { count: canvasIds.length })
  }
}

export function getCanvasStatesSnapshot(): Map<number, YjsCanvasState> {
  return new Map(canvasStates)
}

export function getCanvasState(canvasId: number): YjsCanvasState | undefined {
  return canvasStates.get(canvasId)
}

export function getCanvasDoc(canvasId: number): Y.Doc | undefined {
  return canvasStates.get(canvasId)?.doc
}

export function isCanvasStatePersisted(canvasId: number): boolean {
  const state = canvasStates.get(canvasId)
  if (!state) return false
  return state.lastSeenUpdateCount <= state.lastPersistedUpdateCount
}

/**
 * Create an empty Yjs state container for a canvas (does NOT load from DB).
 * Used internally by loadCanvasStateFromDb.
 */
function createCanvasState(canvasId: number): YjsCanvasState {
  const doc = new Y.Doc()
  ensureRoot(doc)
  const state: YjsCanvasState = {
    doc,
    loaded: false,
    lastSeenUpdateCount: 0,
    lastPersistedUpdateCount: 0,
    isPersisting: false,
    persistError: null,
    lastActivityAt: Date.now(),
    updateListener: (_update, _origin) => {
      // Mark dirty: any update advances the high-water counter.
      const s = canvasStates.get(canvasId)
      if (!s) return
      s.lastSeenUpdateCount++
      s.lastActivityAt = Date.now()
      schedulePersistCanvasState(canvasId)
    },
  }
  // Note: broadcasting is wired up by the WS layer (websocket/index.ts) so this
  // file stays free of room/socket concerns. The listener here only tracks dirtiness.
  doc.on('update', state.updateListener)
  canvasStates.set(canvasId, state)
  ensureIdleReclaimTimer()
  return state
}

export function incrementStateGeneration(canvasId: number): number {
  const gen = (stateGenerations.get(canvasId) || 0) + 1
  stateGenerations.set(canvasId, gen)
  return gen
}

export function getStateGeneration(canvasId: number): number {
  return stateGenerations.get(canvasId) || 0
}

export function removeCanvasState(canvasId: number): void {
  const existing = canvasStates.get(canvasId)
  if (existing) {
    existing.doc.off('update', existing.updateListener)
    existing.doc.destroy()
  }
  canvasStates.delete(canvasId)
  loadingPromises.delete(canvasId)
  persistPromises.delete(canvasId)
  stateGenerations.delete(canvasId)
  const timeout = persistTimeouts.get(canvasId)
  if (timeout) {
    clearTimeout(timeout)
    persistTimeouts.delete(canvasId)
  }
}

// A13: 空闲回收——WS 房间拆除时会调用 removeCanvasState，但纯 REST 路径
// （loadCanvasStateFromDb 由 POST /data、PUT yjsData 触发）没有 teardown，
// canvasStates 会无限增长。定期清扫满足以下全部条件的状态：
//   1. 已完全持久化（内存 doc 不领先于 DB）
//   2. 无持久化错误（有错误时保留内存状态，避免丢弃未落盘数据）
//   3. 空闲超过阈值（load/merge/update 都会刷新 lastActivityAt）
//   4. 无活跃 WS 房间（有活跃用户时不回收，避免破坏房间广播监听）
// 动态导入 websocket/index.js 查询房间状态（静态导入会形成循环依赖）；
// 导入失败时保守跳过该画布（不回收）。
const IDLE_STATE_RECLAIM_MS = 5 * 60 * 1000
let idleReclaimTimer: ReturnType<typeof setInterval> | null = null

async function reclaimIdleCanvasStates(): Promise<void> {
  const now = Date.now()
  for (const [canvasId, state] of Array.from(canvasStates.entries())) {
    if (state.persistError) continue
    if (state.isPersisting) continue
    if (state.lastSeenUpdateCount > state.lastPersistedUpdateCount) continue
    if (now - state.lastActivityAt < IDLE_STATE_RECLAIM_MS) continue

    let roomActive = true
    try {
      const wsModule = await import('../websocket/index.js')
      // #5: await import 是异步的，期间该画布可能收到新 update（变 dirty）、
      // 开始持久化或已被替换——二次复检全部回收条件，任一不满足即放弃回收，
      // 避免把刚产生新编辑（尚未落盘）的活跃 doc 从内存中清掉。
      const fresh = canvasStates.get(canvasId)
      if (!fresh || fresh !== state) continue
      if (fresh.persistError || fresh.isPersisting) continue
      if (fresh.lastSeenUpdateCount > fresh.lastPersistedUpdateCount) continue
      if (Date.now() - fresh.lastActivityAt < IDLE_STATE_RECLAIM_MS) continue
      roomActive = wsModule.getCanvasActiveUsers(canvasId).length > 0
    } catch {
      // 导入失败：保守不回收
    }
    if (roomActive) continue

    log('Reclaiming idle canvas state', { canvasId, idleMs: now - state.lastActivityAt })
    removeCanvasState(canvasId)
  }

  // 全部清空后停掉定时器，避免空转
  if (canvasStates.size === 0 && idleReclaimTimer) {
    clearInterval(idleReclaimTimer)
    idleReclaimTimer = null
  }
}

function ensureIdleReclaimTimer(): void {
  if (idleReclaimTimer) return
  idleReclaimTimer = setInterval(() => {
    reclaimIdleCanvasStates().catch((err) => {
      logError('Idle canvas state reclaim failed', err)
    })
  }, IDLE_STATE_RECLAIM_MS)
  // 不阻止进程退出（测试/短生命周期进程场景）
  if (typeof idleReclaimTimer.unref === 'function') {
    idleReclaimTimer.unref()
  }
}

/**
 * Load a canvas doc from DB. Reads the authoritative `yjs_update` column;
 * falls back to the legacy `yjs_data` JSON snapshot (then writes the converted
 * doc back to `yjs_update`) for canvases not yet touched by the migration.
 */
export async function loadCanvasStateFromDb(canvasId: number): Promise<YjsCanvasState> {
  const existing = canvasStates.get(canvasId)
  if (existing?.loaded) {
    return existing
  }

  const inProgress = loadingPromises.get(canvasId)
  if (inProgress) {
    return inProgress
  }

  const loadPromise = (async (): Promise<YjsCanvasState> => {
    const state = canvasStates.get(canvasId) ?? createCanvasState(canvasId)

    try {
      const canvas = await db.query.canvases.findFirst({
        where: eq(canvases.id, canvasId),
      })
      if (!canvas) {
        state.loaded = true
        return state
      }

      const yjsUpdateBase64 = canvas.yjsUpdate
      const yjsDataBase64 = canvas.yjsData

      let doc: Y.Doc | null = null
      if (yjsUpdateBase64) {
        doc = decodeBase64ToDoc(yjsUpdateBase64)
      }
      if (!doc && yjsDataBase64) {
        // Legacy path: convert JSON snapshot into a fresh Yjs doc.
        try {
          const json = Buffer.from(yjsDataBase64, 'base64').toString('utf-8')
          const parsed = JSON.parse(json) as {
            nodes?: unknown[]
            groups?: unknown[]
            domains?: unknown[]
            connections?: unknown[]
          }
          doc = jsonSnapshotToDoc(parsed)
          // Persist the converted doc so future loads skip this branch.
          const converted = encodeDocToBase64(doc)
          await db
            .update(canvases)
            .set({ yjsUpdate: converted, updatedAt: Date.now() })
            .where(eq(canvases.id, canvasId))
        } catch (err) {
          logError('Failed to convert legacy yjs_data to Yjs doc', {
            canvasId,
            error: err instanceof Error ? err.message : String(err),
          })
          doc = null
        }
      }

      if (doc) {
        // Swap into the existing state container without losing listeners.
        state.doc.off('update', state.updateListener)
        state.doc.destroy()
        state.doc = doc
        ensureRoot(doc)
        doc.on('update', state.updateListener)
        // A freshly loaded doc matches its persisted snapshot exactly.
        state.lastSeenUpdateCount = 0
        state.lastPersistedUpdateCount = 0
        log('Canvas doc loaded from DB', { canvasId })
      }
      state.loaded = true
    } catch (error) {
      logError('Failed to load canvas state from DB', {
        canvasId,
        error: error instanceof Error ? error.message : String(error),
      })
      // B14: DB 读失败必须向调用方抛错（WS 连接被拒绝、REST 请求返回 500），
      // 而不是返回一个空 doc 让连接继续——空 doc 一旦被客户端编辑并 persist，
      // 就会覆盖数据库中的真实数据。loadCanvasStateFromDb 的所有调用方
      // （WS 握手、applyUpdateToCanvas、mergeJsonSnapshotIntoCanvas）都以
      // 抛错为失败信号。失败时不标记 loaded，下次调用会重新尝试加载；
      // 空 state 的 dirty 计数为 0，periodic flush 不会把它写入数据库。
      throw new Error(
        `Failed to load canvas state for canvas ${canvasId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    } finally {
      loadingPromises.delete(canvasId)
    }

    return state
  })()

  loadingPromises.set(canvasId, loadPromise)
  return loadPromise
}

const MAX_PERSIST_RETRIES = 3
const PERSIST_RETRY_DELAYS = [100, 200, 500]

export async function persistCanvasState(canvasId: number): Promise<boolean> {
  const state = canvasStates.get(canvasId)
  if (!state) return false

  if (state.isPersisting) return false
  if (state.lastSeenUpdateCount <= state.lastPersistedUpdateCount) return false

  state.isPersisting = true

  const persistPromise = (async (): Promise<boolean> => {
    try {
      let lastError: unknown = null

      for (let attempt = 0; attempt <= MAX_PERSIST_RETRIES; attempt++) {
        try {
          // Guard: the doc may have been destroyed by a concurrent
          // removeCanvasState (e.g. room torn down while persist runs).
          // Re-read the state from the map; if gone, abort without writing.
          const currentState = canvasStates.get(canvasId)
          if (!currentState) {
            return false
          }
          // Snapshot the dirty counter BEFORE encoding so we don't mark a newer
          // state persisted if a concurrent update arrives mid-write.
          const snapshotCount = currentState.lastSeenUpdateCount
          let base64: string
          try {
            base64 = encodeDocToBase64(currentState.doc)
          } catch (encodeErr) {
            // Doc was destroyed mid-persist — abort without corrupting the DB.
            logError('Yjs doc destroyed during persist, aborting', {
              canvasId,
              error: encodeErr instanceof Error ? encodeErr.message : String(encodeErr),
            })
            return false
          }

          if (!base64 || base64.length < 4) {
            // Empty/invalid encoding — refuse to overwrite the DB row.
            logError('Refusing to persist empty/corrupt Yjs update', { canvasId })
            return false
          }

          await db
            .update(canvases)
            .set({
              yjsUpdate: base64,
              // 毫秒级：与缩略图乐观锁（clientVersion）精度一致，避免把版本
              // 倒退回秒级导致并发 PUT 全部通过 lte 检查。
              updatedAt: Date.now(),
            })
            .where(eq(canvases.id, canvasId))

          if (currentState.lastSeenUpdateCount === snapshotCount) {
            currentState.lastPersistedUpdateCount = snapshotCount
            if (currentState.persistError) {
              currentState.persistError = null
            }
          }

          log('Canvas doc persisted', { canvasId, updateCount: snapshotCount, attempt })
          return true
        } catch (error) {
          lastError = error
          if (attempt < MAX_PERSIST_RETRIES) {
            const currentState = canvasStates.get(canvasId)
            if (!currentState) return false
            await new Promise((resolve) => setTimeout(resolve, PERSIST_RETRY_DELAYS[attempt]))
          }
        }
      }

      const errorMessage = lastError instanceof Error ? lastError.message : String(lastError)
      const failedState = canvasStates.get(canvasId)
      if (failedState) {
        failedState.persistError = {
          message: errorMessage,
          attempts: MAX_PERSIST_RETRIES,
        }
      }
      logError('Failed to persist canvas doc after retries', {
        canvasId,
        attempts: MAX_PERSIST_RETRIES,
        error: errorMessage,
      })
      return false
    } finally {
      const currentState = canvasStates.get(canvasId)
      if (currentState) {
        currentState.isPersisting = false
      }
      persistPromises.delete(canvasId)
    }
  })()

  persistPromises.set(canvasId, persistPromise)
  return trackPersist(persistPromise)
}

// Debounced persistence
const persistTimeouts = new Map<number, ReturnType<typeof setTimeout>>()
const PERSIST_DELAY_MS = 100

export function schedulePersistCanvasState(canvasId: number): void {
  const existing = persistTimeouts.get(canvasId)
  if (existing) {
    clearTimeout(existing)
  }

  const timeout = setTimeout(async () => {
    persistTimeouts.delete(canvasId)
    await persistCanvasState(canvasId)
    const state = canvasStates.get(canvasId)
    if (state && state.lastSeenUpdateCount > state.lastPersistedUpdateCount) {
      schedulePersistCanvasState(canvasId)
    }
  }, PERSIST_DELAY_MS)

  persistTimeouts.set(canvasId, timeout)
}

export function flushPendingPersist(canvasId: number): void {
  const existing = persistTimeouts.get(canvasId)
  if (existing) {
    clearTimeout(existing)
    persistTimeouts.delete(canvasId)
  }
}

/**
 * Apply a remote Yjs update to a canvas doc (used by the REST POST /data
 * endpoint when a single-user client uploads a fresh snapshot).
 * Returns true on success.
 */
export async function applyUpdateToCanvas(canvasId: number, update: Uint8Array): Promise<boolean> {
  const state = await loadCanvasStateFromDb(canvasId)
  try {
    Y.applyUpdate(state.doc, update)
    return true
  } catch (err) {
    logError('Failed to apply Yjs update to canvas', {
      canvasId,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/**
 * Merge a legacy JSON snapshot into the canvas doc (used by the REST POST /data
 * endpoint for backward compatibility with single-user clients that still send
 * JSON). The client sends a COMPLETE snapshot, so this is a replace operation:
 * entities present in the snapshot are added/updated, entities absent from the
 * snapshot but present in the doc are deleted. We cannot use Y.applyUpdate with
 * a temporary doc because two docs produce independent root Y.Map objects.
 */
export async function mergeJsonSnapshotIntoCanvas(
  canvasId: number,
  snapshot: {
    nodes?: unknown[]
    groups?: unknown[]
    domains?: unknown[]
    connections?: unknown[]
  },
  upsertOnly: boolean = false,  // NEW parameter
  // R4 #11: 客户端声明删除的实体（删除声明）。upsertOnly 模式下这些删除
  // 仍会执行——删除声明是"知情且主动删除"的明确信号，不应被保护逻辑吞掉
  // （否则"快照全空 + 删除声明"等场景下客户端明确删除的实体复活）；
  // 未声明的缺失实体继续受 upsertOnly 保护（可能是他人编辑）。
  deletedIds?: {
    nodes?: string[]
    groups?: string[]
    domains?: string[]
    connections?: string[]
  },
): Promise<boolean> {
  const state = await loadCanvasStateFromDb(canvasId)
  try {
    const collections = ensureRoot(state.doc)
    const syncCollection = (
      target: Y.Map<Y.Map<unknown>>,
      items: unknown[] | undefined,
      declaredDeletedIds: string[] | undefined,
    ) => {
      if (!Array.isArray(items)) return
      // Build the set of ids present in the incoming snapshot.
      const incomingIds = new Set<string>()
      for (const item of items) {
        if (!item || typeof item !== 'object') continue
        const record = item as Record<string, unknown>
        const id = record.id
        if (typeof id !== 'string') continue
        incomingIds.add(id)
        const existing = target.get(id)
        if (existing) {
          // Field-level merge into the existing entity Y.Map.
          writeEntityToYMap(existing, record)
        } else {
          const ymap = new Y.Map<unknown>()
          writeEntityToYMap(ymap, record)
          target.set(id, ymap)
        }
      }
      // Delete entities that are in the doc but NOT in the incoming snapshot.
      // Skip deletion in upsertOnly mode (used when active WS room exists —
      // stale REST snapshots must not delete peer edits).
      if (!upsertOnly) {
        for (const existingId of Array.from(target.keys())) {
          if (!incomingIds.has(existingId)) {
            target.delete(existingId)
          }
        }
      } else if (declaredDeletedIds && declaredDeletedIds.length > 0) {
        // R4 #11: upsertOnly 模式下仅删除客户端显式声明删除的实体。
        const declared = new Set(declaredDeletedIds)
        for (const existingId of Array.from(target.keys())) {
          if (!incomingIds.has(existingId) && declared.has(existingId)) {
            target.delete(existingId)
          }
        }
      }
    }
    state.doc.transact(() => {
      syncCollection(collections.nodes, snapshot.nodes, deletedIds?.nodes)
      syncCollection(collections.groups, snapshot.groups, deletedIds?.groups)
      syncCollection(collections.domains, snapshot.domains, deletedIds?.domains)
      syncCollection(collections.connections, snapshot.connections, deletedIds?.connections)
    })
    return true
  } catch (err) {
    logError('Failed to merge JSON snapshot into canvas doc', {
      canvasId,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/**
 * R1 加固：判定 REST 快照是否缺失 doc 中的实体（过期快照的直接判据）。
 *
 * 全量合并的唯一危险动作是删除"doc 中存在但快照中没有"的实体——那可能是
 * 其他协作者在客户端离线期间的编辑。因此直接比较各集合的实体 ID：
 * - 快照（某集合提供了数组时）缺失 doc 中存在的实体 → 全量合并会删除它们
 *   → 必须 upsertOnly（保守：可能是过期快照）；
 * - 快照覆盖 doc 全部实体 → 全量合并不会删除任何 doc 实体 → 安全。
 *
 * 已知限制（无法消除的语义歧义）：
 * "doc 有 B、快照无 B"有两种相反解释——① 客户端主动删除了 B（合法，快照是
 * 更新版）；② B 是他人离线期间新增的（快照过期）。为消除歧义，客户端在本地
 * 删除实体时记录声明（deletedIds），随快照附带：声明删除的实体视为"知情且
 * 主动删除"→ 不参与缺失判定 → 全量合并会正确执行删除；未声明的缺失实体仍
 * 视为过期快照 → upsertOnly 保护他人编辑。旧客户端不附带 deletedIds → 维持
 * 保守行为（宁可不删除，不让过期快照误删他人编辑）。
 *
 * 字段级覆盖（R2）是 REST 快照（全量 LWW）与 Yjs CRDT 合并语义的固有差异：
 * 实体存在但字段值过期的快照仍会覆盖 doc 中的新字段值。本判定只保护实体级
 * 增删，不保护字段级更新；活跃房间/宽限期由 shouldUpsertOnlyForSnapshot 兜住，
 * 其余窗口（>15s、非重叠会话）下字段覆盖可能发生——已知限制，未根治。
 *
 * 与 mergeJsonSnapshotIntoCanvas 语义对齐：请求中未提供的集合（undefined）
 * 不会触发删除，不参与比较。
 */
export function snapshotMissingDocEntities(
  canvasId: number,
  snapshot: {
    nodes?: unknown[]
    groups?: unknown[]
    domains?: unknown[]
    connections?: unknown[]
  },
  deletedIds?: {
    nodes?: string[]
    groups?: string[]
    domains?: string[]
    connections?: string[]
  },
): boolean {
  const state = canvasStates.get(canvasId)
  if (!state) return false
  const collections = ensureRoot(state.doc)

  const snapshotIds = (items: unknown[] | undefined): Set<string> => {
    const ids = new Set<string>()
    if (!Array.isArray(items)) return ids
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const id = (item as Record<string, unknown>).id
      if (typeof id === 'string') ids.add(id)
    }
    return ids
  }

  const pairs: Array<[Y.Map<Y.Map<unknown>>, unknown[] | undefined, Set<string> | undefined]> = [
    [collections.nodes, snapshot.nodes, deletedIds ? new Set(deletedIds.nodes ?? []) : undefined],
    [collections.groups, snapshot.groups, deletedIds ? new Set(deletedIds.groups ?? []) : undefined],
    [collections.domains, snapshot.domains, deletedIds ? new Set(deletedIds.domains ?? []) : undefined],
    [collections.connections, snapshot.connections, deletedIds ? new Set(deletedIds.connections ?? []) : undefined],
  ]

  const providedPairs = pairs.filter(([, items]) => Array.isArray(items))
  if (providedPairs.length === 0) return false

  // B1: 显式清空判定——客户端提供的所有集合均为空数组、且无任何删除声明时，
  // 视为"清空画布"的明确意图，允许全量合并执行删除（否则空快照会被误判为
  // 过期快照而 upsertOnly，清空永远不生效）。仅单用户场景生效：活跃房间/
  // 协作宽限期由 shouldUpsertOnlyForSnapshot 兜底，仍会走 upsertOnly。
  const allProvidedEmpty = providedPairs.every(([, items]) => (items as unknown[]).length === 0)
  const deletionDeclared =
    (deletedIds?.nodes && deletedIds.nodes.length > 0) ||
    (deletedIds?.groups && deletedIds.groups.length > 0) ||
    (deletedIds?.domains && deletedIds.domains.length > 0) ||
    (deletedIds?.connections && deletedIds.connections.length > 0)
  if (allProvidedEmpty && !deletionDeclared) return false

  return pairs.some(([target, items, clientDeleted]) => {
    // 未提供的集合不会触发删除（与 syncCollection 的 Array.isArray 守卫一致）。
    if (!Array.isArray(items)) return false
    const ids = snapshotIds(items)
    for (const existingId of Array.from(target.keys())) {
      // 客户端声明主动删除的实体不算缺失：全量合并会正确执行该删除。
      if (clientDeleted?.has(existingId)) continue
      if (!ids.has(existingId)) return true
    }
    return false
  })
}

/**
 * Serialize a canvas doc to the legacy JSON snapshot shape, used by REST GET
 * endpoints and AI prompt builders.
 */
export function getCanvasJsonSnapshot(canvasId: number): {
  nodes: Record<string, unknown>[]
  groups: Record<string, unknown>[]
  domains: Record<string, unknown>[]
  connections: Record<string, unknown>[]
} {
  const state = canvasStates.get(canvasId)
  if (!state) {
    return { nodes: [], groups: [], domains: [], connections: [] }
  }
  return docToJsonSnapshot(state.doc)
}

/**
 * Encode a canvas doc as base64 Yjs update. Used when a REST client requests
 * the raw binary form (e.g. provider bootstrap).
 */
export function getCanvasYjsUpdateBase64(canvasId: number): string | null {
  const state = canvasStates.get(canvasId)
  if (!state) return null
  return encodeDocToBase64(state.doc)
}
