import { db, scheduleSave } from '../database/connection.js'
import { canvases } from '../database/schema.js'
import { eq } from 'drizzle-orm'
import { log, logError } from '../utils/logger.js'

export interface CanvasData {
  nodes: Map<string, unknown>
  groups: Map<string, unknown>
  domains: Map<string, unknown>
  connections: Map<string, unknown>
  version: number
  lastModified: number
  loaded: boolean
  lastPersistedVersion: number
  isPersisting: boolean
  /**
   * Set when persistCanvasState exhausts its retries. Cleared on the next
   * successful persist. Surfaced to clients via version-update so they can
   * warn the user that recent in-memory changes have NOT been saved to DB.
   * If the server process crashes between now and the next successful
   * persist, those changes are lost.
   */
  persistError: { message: string; attempts: number } | null
}

const canvasStates = new Map<number, CanvasData>()
const loadingPromises = new Map<number, Promise<CanvasData>>()
const pendingPersists: Promise<boolean>[] = []
const persistPromises = new Map<number, Promise<boolean>>()

// 世代计数器：每次新连接创建 room 时递增，用于防止旧异步回调误删新状态
const stateGenerations = new Map<number, number>()

function trackPersist(promise: Promise<boolean>): Promise<boolean> {
  pendingPersists.push(promise)
  promise.then(
    () => {
      const idx = pendingPersists.indexOf(promise)
      if (idx !== -1) pendingPersists.splice(idx, 1)
    },
    () => {
      const idx = pendingPersists.indexOf(promise)
      if (idx !== -1) pendingPersists.splice(idx, 1)
    }
  )
  return promise
}

// Periodic flush: ensure all dirty canvas states are persisted to DB regularly
const PERIODIC_FLUSH_INTERVAL_MS = 2000
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
    log('Flushed all canvas states', { count: canvasIds.length })
  }
}

export function getCanvasStatesSnapshot(): Map<number, CanvasData> {
  return new Map(canvasStates)
}

export function getCanvasState(canvasId: number): CanvasData | undefined {
  return canvasStates.get(canvasId)
}

export function isCanvasStatePersisted(canvasId: number): boolean {
  const state = canvasStates.get(canvasId)
  if (!state) return false
  return state.version === state.lastPersistedVersion
}

export function ensureCanvasState(canvasId: number): CanvasData {
  let state = canvasStates.get(canvasId)
  if (!state) {
    state = {
      nodes: new Map(),
      groups: new Map(),
      domains: new Map(),
      connections: new Map(),
      version: 0,
      lastModified: Date.now(),
      loaded: false,
      lastPersistedVersion: 0,
      isPersisting: false,
      persistError: null,
    }
    canvasStates.set(canvasId, state)
  }
  return state
}

/**
 * Ensure canvas state is loaded from DB before applying operations.
 * This prevents the race condition where ensureCanvasState creates an empty state
 * and operations are applied to it before loadCanvasStateFromDb completes.
 */
export async function ensureCanvasStateLoaded(canvasId: number): Promise<CanvasData> {
  const state = canvasStates.get(canvasId)
  if (state?.loaded) {
    return state
  }
  // State doesn't exist or hasn't been loaded yet — wait for DB load
  return loadCanvasStateFromDb(canvasId)
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
  canvasStates.delete(canvasId)
  loadingPromises.delete(canvasId)
  persistPromises.delete(canvasId)
  stateGenerations.delete(canvasId)
  const existing = persistTimeouts.get(canvasId)
  if (existing) {
    clearTimeout(existing)
    persistTimeouts.delete(canvasId)
  }
}

export async function loadCanvasStateFromDb(canvasId: number): Promise<CanvasData> {
  const existing = canvasStates.get(canvasId)
  if (existing?.loaded) {
    return existing
  }

  const inProgress = loadingPromises.get(canvasId)
  if (inProgress) {
    return inProgress
  }

  const loadPromise = (async () => {
    const state = ensureCanvasState(canvasId)

    try {
      const canvas = await db.query.canvases.findFirst({
        where: eq(canvases.id, canvasId),
      })

      if (canvas && (canvas as any).yjsData && !state.loaded) {
        const base64Data = (canvas as any).yjsData
        const jsonString = Buffer.from(base64Data, 'base64').toString('utf-8')
        const data = JSON.parse(jsonString)

        for (const n of data.nodes || []) {
          state.nodes.set(n.id, n)
        }
        for (const g of data.groups || []) {
          state.groups.set(g.id, g)
        }
        for (const d of data.domains || []) {
          state.domains.set(d.id, d)
        }
        for (const c of data.connections || []) {
          state.connections.set(c.id, c)
        }
        state.version = Math.max(state.version, data.version || 0)
        state.lastModified = Date.now()
        log('Canvas state loaded from DB', { canvasId, version: state.version })
      }
      state.loaded = true
    } catch (error) {
      logError('Failed to load canvas state from DB', {
        canvasId,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      loadingPromises.delete(canvasId)
    }

    return state
  })()

  loadingPromises.set(canvasId, loadPromise)
  return loadPromise
}

const MAX_PERSIST_RETRIES = 3
const PERSIST_RETRY_DELAYS = [200, 500, 1000]

export async function persistCanvasState(canvasId: number): Promise<boolean> {
  const state = canvasStates.get(canvasId)
  if (!state) return false

  if (state.isPersisting) return false
  if (state.version === state.lastPersistedVersion) return false

  state.isPersisting = true

  const persistPromise = (async (): Promise<boolean> => {
    try {
      let lastError: unknown = null

      for (let attempt = 0; attempt <= MAX_PERSIST_RETRIES; attempt++) {
        try {
          // 每次尝试使用当前最新版本号，避免重试时版本号滞后于实际数据
          const currentVersion = state.version
          const data = {
            nodes: Array.from(state.nodes.values()),
            groups: Array.from(state.groups.values()),
            domains: Array.from(state.domains.values()),
            connections: Array.from(state.connections.values()),
            version: currentVersion,
          }

          const jsonString = JSON.stringify(data)
          const base64Data = Buffer.from(jsonString, 'utf-8').toString('base64')

          await db
            .update(canvases)
            .set({
              yjsData: base64Data,
              updatedAt: Math.floor(Date.now() / 1000),
            })
            .where(eq(canvases.id, canvasId))

          const currentState = canvasStates.get(canvasId)
          if (currentState && currentState.version === currentVersion) {
            currentState.lastPersistedVersion = currentVersion
            // Successful persist — clear any previous persist error
            if (currentState.persistError) {
              currentState.persistError = null
            }
          }

          scheduleSave()
          log('Canvas state persisted', { canvasId, version: currentVersion, attempt })
          return true
        } catch (error) {
          lastError = error
          if (attempt < MAX_PERSIST_RETRIES) {
            // 重试前重新检查状态是否仍有效
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
      logError('Failed to persist canvas state after retries', {
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
const PERSIST_DELAY_MS = 200

export function schedulePersistCanvasState(canvasId: number): void {
  const existing = persistTimeouts.get(canvasId)
  if (existing) {
    clearTimeout(existing)
  }

  const timeout = setTimeout(async () => {
    persistTimeouts.delete(canvasId)
    await persistCanvasState(canvasId)
    // After persist attempt, schedule another if there are still unpersisted changes
    // Handles: isPersisting was true, new operations came in during persist, etc.
    const state = canvasStates.get(canvasId)
    if (state && state.version !== state.lastPersistedVersion) {
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

// Apply operations to server state
export async function applyAddNode(canvasId: number, node: any): Promise<boolean> {
  const state = await ensureCanvasStateLoaded(canvasId)
  if (state.nodes.has(node.id)) {
    return false
  }
  state.nodes.set(node.id, node)
  state.version++
  state.lastModified = Date.now()
  schedulePersistCanvasState(canvasId)
  return true
}

export async function applyUpdateNode(canvasId: number, nodeId: string, updates: any, clientVersion?: number): Promise<boolean> {
  const state = await ensureCanvasStateLoaded(canvasId)
  if (typeof clientVersion === 'number' && state.version > clientVersion) {
    return false
  }
  const existing = state.nodes.get(nodeId)
  if (!existing) {
    return false
  }
  if (updates && Object.keys(updates).some(k => (existing as Record<string, unknown>)[k] !== (updates as Record<string, unknown>)[k])) {
    const updated = { ...(existing as object), ...updates }
    state.nodes.set(nodeId, updated)
    state.version++
    state.lastModified = Date.now()
    schedulePersistCanvasState(canvasId)
    return true
  }
  return false
}

export async function applyRemoveNode(canvasId: number, nodeId: string): Promise<boolean> {
  const state = await ensureCanvasStateLoaded(canvasId)
  const existed = state.nodes.delete(nodeId)
  if (!existed) return false

  // Also remove connections that reference this node
  for (const [connId, conn] of state.connections) {
    const c = conn as any
    if (c.fromNodeId === nodeId || c.toNodeId === nodeId) {
      state.connections.delete(connId)
    }
  }

  state.version++
  state.lastModified = Date.now()
  schedulePersistCanvasState(canvasId)
  return true
}

export async function applyAddGroup(canvasId: number, group: any): Promise<boolean> {
  const state = await ensureCanvasStateLoaded(canvasId)
  if (state.groups.has(group.id)) {
    return false
  }
  state.groups.set(group.id, group)
  state.version++
  state.lastModified = Date.now()
  schedulePersistCanvasState(canvasId)
  return true
}

export async function applyUpdateGroup(canvasId: number, groupId: string, updates: any, clientVersion?: number): Promise<boolean> {
  const state = await ensureCanvasStateLoaded(canvasId)
  if (typeof clientVersion === 'number' && state.version > clientVersion) {
    return false
  }
  const existing = state.groups.get(groupId)
  if (!existing) return false
  if (updates && Object.keys(updates).some(k => (existing as Record<string, unknown>)[k] !== (updates as Record<string, unknown>)[k])) {
    const updated = { ...(existing as object), ...updates }
    state.groups.set(groupId, updated)
    state.version++
    state.lastModified = Date.now()
    schedulePersistCanvasState(canvasId)
    return true
  }
  return false
}

export async function applyRemoveGroup(canvasId: number, groupId: string): Promise<boolean> {
  const state = await ensureCanvasStateLoaded(canvasId)
  const existed = state.groups.delete(groupId)
  if (!existed) return false
  state.version++
  state.lastModified = Date.now()
  schedulePersistCanvasState(canvasId)
  return true
}

export async function applyAddDomain(canvasId: number, domain: any): Promise<boolean> {
  const state = await ensureCanvasStateLoaded(canvasId)
  if (state.domains.has(domain.id)) {
    return false
  }
  state.domains.set(domain.id, domain)
  state.version++
  state.lastModified = Date.now()
  schedulePersistCanvasState(canvasId)
  return true
}

export async function applyUpdateDomain(canvasId: number, domainId: string, updates: any, clientVersion?: number): Promise<boolean> {
  const state = await ensureCanvasStateLoaded(canvasId)
  if (typeof clientVersion === 'number' && state.version > clientVersion) {
    return false
  }
  const existing = state.domains.get(domainId)
  if (!existing) return false
  if (updates && Object.keys(updates).some(k => (existing as Record<string, unknown>)[k] !== (updates as Record<string, unknown>)[k])) {
    const updated = { ...(existing as object), ...updates }
    state.domains.set(domainId, updated)
    state.version++
    state.lastModified = Date.now()
    schedulePersistCanvasState(canvasId)
    return true
  }
  return false
}

export async function applyRemoveDomain(canvasId: number, domainId: string): Promise<boolean> {
  const state = await ensureCanvasStateLoaded(canvasId)
  const existed = state.domains.delete(domainId)
  if (!existed) return false
  state.version++
  state.lastModified = Date.now()
  schedulePersistCanvasState(canvasId)
  return true
}

export async function applyAddConnection(canvasId: number, connection: any): Promise<boolean> {
  const state = await ensureCanvasStateLoaded(canvasId)
  if (state.connections.has(connection.id)) {
    return false
  }
  state.connections.set(connection.id, connection)
  state.version++
  state.lastModified = Date.now()
  schedulePersistCanvasState(canvasId)
  return true
}

export async function applyUpdateConnection(canvasId: number, connectionId: string, updates: any, clientVersion?: number): Promise<boolean> {
  const state = await ensureCanvasStateLoaded(canvasId)
  if (typeof clientVersion === 'number' && state.version > clientVersion) {
    return false
  }
  const existing = state.connections.get(connectionId)
  if (!existing) return false
  if (updates && Object.keys(updates).some(k => (existing as Record<string, unknown>)[k] !== (updates as Record<string, unknown>)[k])) {
    const updated = { ...(existing as object), ...updates }
    state.connections.set(connectionId, updated)
    state.version++
    state.lastModified = Date.now()
    schedulePersistCanvasState(canvasId)
    return true
  }
  return false
}

export async function applyRemoveConnection(canvasId: number, connectionId: string): Promise<boolean> {
  const state = await ensureCanvasStateLoaded(canvasId)
  const existed = state.connections.delete(connectionId)
  if (!existed) return false
  state.version++
  state.lastModified = Date.now()
  schedulePersistCanvasState(canvasId)
  return true
}

export function getSyncData(canvasId: number): {
  nodes: unknown[]
  groups: unknown[]
  domains: unknown[]
  connections: unknown[]
  version: number
} {
  const state = canvasStates.get(canvasId)
  if (!state) {
    return { nodes: [], groups: [], domains: [], connections: [], version: 0 }
  }
  return {
    nodes: Array.from(state.nodes.values()),
    groups: Array.from(state.groups.values()),
    domains: Array.from(state.domains.values()),
    connections: Array.from(state.connections.values()),
    version: state.version,
  }
}

/**
 * 批量应用一组操作，所有操作共享同一个版本检查，整体只递增一次版本号。
 * 用于客户端发送 batch-operation 消息的场景，避免逐个操作因版本递增导致 NAK。
 *
 * 无回滚机制：循环内各操作（Map set/delete、对象展开、Object.keys 浅比较）均不抛异常，
 * 版本号仅在全部操作应用成功后递增，单操作 handler 也遵循同一模式。
 * 外层 try-catch 兜底仅用于 VM 级异常（OOM 等）。
 */
export async function applyBatchOperations(
  canvasId: number,
  operations: Array<{ operation: string; data: unknown }>,
  clientVersion?: number
): Promise<boolean> {
  if (!operations || operations.length === 0) return false

  const state = await ensureCanvasStateLoaded(canvasId)

  // 异步加载 state 后再次比较版本，防止 TOCTOU 竞态条件
  if (typeof clientVersion === 'number' && state.version > clientVersion) {
    return false
  }

  let anyApplied = false

  for (const op of operations) {
    let applied = false
    switch (op.operation) {
      case 'add-node': {
        const node = op.data as { id: string }
        if (!state.nodes.has(node.id)) {
          state.nodes.set(node.id, node)
          applied = true
        }
        break
      }
      case 'update-node': {
        const { id, updates } = op.data as { id: string; updates: unknown }
        const existing = state.nodes.get(id)
        if (existing) {
          if (updates && typeof updates === 'object' && Object.keys(updates).some(k => (existing as Record<string, unknown>)[k] !== (updates as Record<string, unknown>)[k])) {
            const updated = { ...(existing as object), ...(updates as object) }
            state.nodes.set(id, updated)
            applied = true
          }
        }
        break
      }
      case 'remove-node': {
        const { id } = op.data as { id: string }
        if (state.nodes.delete(id)) {
          // Also clean up orphaned connections
          for (const [connId, conn] of state.connections) {
            const c = conn as { fromNodeId?: string; toNodeId?: string }
            if (c.fromNodeId === id || c.toNodeId === id) {
              state.connections.delete(connId)
            }
          }
          applied = true
        }
        break
      }
      case 'add-group': {
        const group = op.data as { id: string }
        if (!state.groups.has(group.id)) {
          state.groups.set(group.id, group)
          applied = true
        }
        break
      }
      case 'update-group': {
        const { id, updates } = op.data as { id: string; updates: unknown }
        const existing = state.groups.get(id)
        if (existing) {
          if (updates && typeof updates === 'object' && Object.keys(updates).some(k => (existing as Record<string, unknown>)[k] !== (updates as Record<string, unknown>)[k])) {
            const updated = { ...(existing as object), ...(updates as object) }
            state.groups.set(id, updated)
            applied = true
          }
        }
        break
      }
      case 'remove-group': {
        const { id } = op.data as { id: string }
        if (state.groups.delete(id)) {
          applied = true
        }
        break
      }
      case 'add-domain': {
        const domain = op.data as { id: string }
        if (!state.domains.has(domain.id)) {
          state.domains.set(domain.id, domain)
          applied = true
        }
        break
      }
      case 'update-domain': {
        const { id, updates } = op.data as { id: string; updates: unknown }
        const existing = state.domains.get(id)
        if (existing) {
          if (updates && typeof updates === 'object' && Object.keys(updates).some(k => (existing as Record<string, unknown>)[k] !== (updates as Record<string, unknown>)[k])) {
            const updated = { ...(existing as object), ...(updates as object) }
            state.domains.set(id, updated)
            applied = true
          }
        }
        break
      }
      case 'remove-domain': {
        const { id } = op.data as { id: string }
        if (state.domains.delete(id)) {
          applied = true
        }
        break
      }
      case 'add-connection': {
        const connection = op.data as { id: string }
        if (!state.connections.has(connection.id)) {
          state.connections.set(connection.id, connection)
          applied = true
        }
        break
      }
      case 'update-connection': {
        const { id, updates } = op.data as { id: string; updates: unknown }
        const existing = state.connections.get(id)
        if (existing) {
          if (updates && typeof updates === 'object' && Object.keys(updates).some(k => (existing as Record<string, unknown>)[k] !== (updates as Record<string, unknown>)[k])) {
            const updated = { ...(existing as object), ...(updates as object) }
            state.connections.set(id, updated)
            applied = true
          }
        }
        break
      }
      case 'remove-connection': {
        const { id } = op.data as { id: string }
        if (state.connections.delete(id)) {
          applied = true
        }
        break
      }
    }
    if (applied) {
      anyApplied = true
    }
  }

  if (anyApplied) {
    state.version++
    state.lastModified = Date.now()
    schedulePersistCanvasState(canvasId)
  }

  return anyApplied
}
