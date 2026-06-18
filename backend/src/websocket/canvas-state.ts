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
import { db, scheduleSave } from '../database/connection.js'
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
    updateListener: (_update, _origin) => {
      // Mark dirty: any update advances the high-water counter.
      const s = canvasStates.get(canvasId)
      if (!s) return
      s.lastSeenUpdateCount++
      schedulePersistCanvasState(canvasId)
    },
  }
  // Note: broadcasting is wired up by the WS layer (websocket/index.ts) so this
  // file stays free of room/socket concerns. The listener here only tracks dirtiness.
  doc.on('update', state.updateListener)
  canvasStates.set(canvasId, state)
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
            .set({ yjsUpdate: converted, updatedAt: Math.floor(Date.now() / 1000) })
            .where(eq(canvases.id, canvasId))
          scheduleSave()
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
      // Do NOT mark as loaded on failure so the next call retries the load
      // instead of returning a permanently empty doc that could overwrite
      // the real data if the user starts editing.
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
              updatedAt: Math.floor(Date.now() / 1000),
            })
            .where(eq(canvases.id, canvasId))

          if (currentState.lastSeenUpdateCount === snapshotCount) {
            currentState.lastPersistedUpdateCount = snapshotCount
            if (currentState.persistError) {
              currentState.persistError = null
            }
          }

          scheduleSave()
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
): Promise<boolean> {
  const state = await loadCanvasStateFromDb(canvasId)
  try {
    const collections = ensureRoot(state.doc)
    const syncCollection = (
      target: Y.Map<Y.Map<unknown>>,
      items: unknown[] | undefined,
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
      }
    }
    state.doc.transact(() => {
      syncCollection(collections.nodes, snapshot.nodes)
      syncCollection(collections.groups, snapshot.groups)
      syncCollection(collections.domains, snapshot.domains)
      syncCollection(collections.connections, snapshot.connections)
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
