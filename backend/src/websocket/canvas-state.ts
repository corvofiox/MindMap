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
}

const canvasStates = new Map<number, CanvasData>()

export function getCanvasState(canvasId: number): CanvasData | undefined {
  return canvasStates.get(canvasId)
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
    }
    canvasStates.set(canvasId, state)
  }
  return state
}

export function removeCanvasState(canvasId: number): void {
  canvasStates.delete(canvasId)
}

export async function loadCanvasStateFromDb(canvasId: number): Promise<CanvasData> {
  const state = ensureCanvasState(canvasId)

  try {
    const canvas = await db.query.canvases.findFirst({
      where: eq(canvases.id, canvasId),
    })

    if (canvas && (canvas as any).yjsData) {
      const base64Data = (canvas as any).yjsData
      const jsonString = Buffer.from(base64Data, 'base64').toString('utf-8')
      const data = JSON.parse(jsonString)

      state.nodes = new Map((data.nodes || []).map((n: any) => [n.id, n]))
      state.groups = new Map((data.groups || []).map((g: any) => [g.id, g]))
      state.domains = new Map((data.domains || []).map((d: any) => [d.id, d]))
      state.connections = new Map((data.connections || []).map((c: any) => [c.id, c]))
      state.version = (data.version || 0)
      state.lastModified = Date.now()
    }
  } catch (error) {
    logError('Failed to load canvas state from DB', { canvasId, error: error instanceof Error ? error.message : String(error) })
  }

  return state
}

export async function persistCanvasState(canvasId: number): Promise<void> {
  const state = canvasStates.get(canvasId)
  if (!state) return

  try {
    const data = {
      nodes: Array.from(state.nodes.values()),
      groups: Array.from(state.groups.values()),
      domains: Array.from(state.domains.values()),
      connections: Array.from(state.connections.values()),
      version: state.version,
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

    scheduleSave()
    log('Canvas state persisted', { canvasId, version: state.version })
  } catch (error) {
    logError('Failed to persist canvas state', { canvasId, error: error instanceof Error ? error.message : String(error) })
  }
}

// Debounced persistence
const persistTimeouts = new Map<number, NodeJS.Timeout>()
const PERSIST_DELAY_MS = 2000

export function schedulePersistCanvasState(canvasId: number): void {
  const existing = persistTimeouts.get(canvasId)
  if (existing) {
    clearTimeout(existing)
  }

  const timeout = setTimeout(() => {
    persistTimeouts.delete(canvasId)
    persistCanvasState(canvasId).catch(() => {
      // Error already logged
    })
  }, PERSIST_DELAY_MS)

  persistTimeouts.set(canvasId, timeout)
}

// Apply operations to server state
export function applyAddNode(canvasId: number, node: any): boolean {
  const state = ensureCanvasState(canvasId)
  if (state.nodes.has(node.id)) {
    return false
  }
  state.nodes.set(node.id, node)
  state.version++
  state.lastModified = Date.now()
  schedulePersistCanvasState(canvasId)
  return true
}

export function applyUpdateNode(canvasId: number, nodeId: string, updates: any): boolean {
  const state = ensureCanvasState(canvasId)
  const existing = state.nodes.get(nodeId)
  if (!existing) {
    return false
  }
  state.nodes.set(nodeId, { ...(existing as object), ...updates })
  state.version++
  state.lastModified = Date.now()
  schedulePersistCanvasState(canvasId)
  return true
}

export function applyRemoveNode(canvasId: number, nodeId: string): boolean {
  const state = ensureCanvasState(canvasId)
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

export function applyAddGroup(canvasId: number, group: any): boolean {
  const state = ensureCanvasState(canvasId)
  if (state.groups.has(group.id)) {
    return false
  }
  state.groups.set(group.id, group)
  state.version++
  state.lastModified = Date.now()
  schedulePersistCanvasState(canvasId)
  return true
}

export function applyUpdateGroup(canvasId: number, groupId: string, updates: any): boolean {
  const state = ensureCanvasState(canvasId)
  const existing = state.groups.get(groupId)
  if (!existing) return false
  state.groups.set(groupId, { ...(existing as object), ...updates })
  state.version++
  state.lastModified = Date.now()
  schedulePersistCanvasState(canvasId)
  return true
}

export function applyRemoveGroup(canvasId: number, groupId: string): boolean {
  const state = ensureCanvasState(canvasId)
  const existed = state.groups.delete(groupId)
  if (!existed) return false
  state.version++
  state.lastModified = Date.now()
  schedulePersistCanvasState(canvasId)
  return true
}

export function applyAddDomain(canvasId: number, domain: any): boolean {
  const state = ensureCanvasState(canvasId)
  if (state.domains.has(domain.id)) {
    return false
  }
  state.domains.set(domain.id, domain)
  state.version++
  state.lastModified = Date.now()
  schedulePersistCanvasState(canvasId)
  return true
}

export function applyUpdateDomain(canvasId: number, domainId: string, updates: any): boolean {
  const state = ensureCanvasState(canvasId)
  const existing = state.domains.get(domainId)
  if (!existing) return false
  state.domains.set(domainId, { ...(existing as object), ...updates })
  state.version++
  state.lastModified = Date.now()
  schedulePersistCanvasState(canvasId)
  return true
}

export function applyRemoveDomain(canvasId: number, domainId: string): boolean {
  const state = ensureCanvasState(canvasId)
  const existed = state.domains.delete(domainId)
  if (!existed) return false
  state.version++
  state.lastModified = Date.now()
  schedulePersistCanvasState(canvasId)
  return true
}

export function applyAddConnection(canvasId: number, connection: any): boolean {
  const state = ensureCanvasState(canvasId)
  if (state.connections.has(connection.id)) {
    return false
  }
  state.connections.set(connection.id, connection)
  state.version++
  state.lastModified = Date.now()
  schedulePersistCanvasState(canvasId)
  return true
}

export function applyUpdateConnection(canvasId: number, connectionId: string, updates: any): boolean {
  const state = ensureCanvasState(canvasId)
  const existing = state.connections.get(connectionId)
  if (!existing) return false
  state.connections.set(connectionId, { ...(existing as object), ...updates })
  state.version++
  state.lastModified = Date.now()
  schedulePersistCanvasState(canvasId)
  return true
}

export function applyRemoveConnection(canvasId: number, connectionId: string): boolean {
  const state = ensureCanvasState(canvasId)
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
  const state = ensureCanvasState(canvasId)
  return {
    nodes: Array.from(state.nodes.values()),
    groups: Array.from(state.groups.values()),
    domains: Array.from(state.domains.values()),
    connections: Array.from(state.connections.values()),
    version: state.version,
  }
}
