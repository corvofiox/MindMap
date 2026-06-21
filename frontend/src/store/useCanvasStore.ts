import { create } from 'zustand'
import type { Node, NodeGroup, Domain, Connection } from '@/types'
import { CANVAS_DEFAULTS } from '@/constants'
import { logger } from '@/utils/logger'
import { useAuthStore } from '@/store/useAuthStore'

/**
 * Yjs binding injection point.
 *
 * When set (during collaborative sessions), every store mutation is mirrored
 * into the Y.Doc inside a LOCAL_ORIGIN transaction so peers receive the change.
 * When null (single-user mode), the store behaves exactly as before.
 *
 * The binding is intentionally typed loosely to avoid a circular import
 * between this store and services/yjsBinding.
 */
type YjsBindingHandle = {
  /** Apply a before/after snapshot diff to the doc inside LOCAL_ORIGIN. */
  applyDiff: (before: MapsSnapshot, after: MapsSnapshot) => void
  /** True when the binding is currently applying remote changes to the store
   *  (suppresses Yjs echo-back to avoid feedback loops). */
  isApplyingRemoteChanges: boolean
  /** Temporarily suppress Yjs sync (for initial data loading). */
  suppressSync: (fn: () => void) => void
  /** Mark a node as being interacted with (defers remote position updates
   *  to prevent tug-of-war on LWW fields during concurrent drags). */
  startInteraction: (nodeId: string, field?: string) => void
  /** End an interaction and flush any deferred position updates. */
  endInteraction: (nodeId: string) => void
  /** Re-register observers on current Y.Map instances (after STEP2 sync). */
  reconnectObservers: () => void
  /** Copy all entities from the Zustand store into the Y.Doc (initial sync). */
  syncLocalStateToYDoc: () => void
  /** Copy entities present in the Y.Doc but missing from the store back into
   *  the store (doc → store). Called after STEP2 sync so server-only entities
   *  appear in the UI.
   *  @param options.skipRemoval If true, entities present locally but missing
   *    from the doc are NOT removed. Use on the very first sync so API-loaded
   *    data for a brand-new canvas is not wiped.
   *  @param options.skipExistingUpdates If true or a Set of entity IDs,
   *    existing local entities are NOT refreshed from the doc. Use for IDs
   *    edited locally while the handshake was in flight so they are not
   *    overwritten by the server snapshot.
   *  @returns true if the doc was empty but the local store had entities and
   *    the function already mirrored local state back into the doc; callers
   *    should skip a follow-up syncLocalStateToYDoc() call. */
  syncYDocToLocalState: (options?: { skipRemoval?: boolean; skipExistingUpdates?: boolean | Set<string> }) => boolean
  /** Tear down the binding (unobserve Yjs collections). */
  destroy: () => void
}
let yjsBinding: YjsBindingHandle | null = null

export function setYjsBinding(binding: YjsBindingHandle | null): void {
  // Multi-tab guard: if a binding already exists for a different canvas,
  // destroy the old one before replacing it. Without this, two tabs open on
  // different canvases would share the same module-level binding, causing
  // cross-canvas data pollution via the Y.Doc observer.
  if (binding && yjsBinding && yjsBinding !== binding) {
    logger.warn(
      '[yjs-binding] replacing existing binding — previous binding destroyed ' +
      'to prevent multi-tab cross-canvas data pollution',
    )
    yjsBinding.destroy()
  }
  yjsBinding = binding
}

export function getYjsBinding(): YjsBindingHandle | null {
  return yjsBinding
}

/**
 * Snapshot the four entity maps before a mutation so we can diff afterwards
 * and write only the delta into the Y.Doc (saves bandwidth and preserves
 * CRDT field-level merge semantics for concurrent edits).
 */
type MapsSnapshot = {
  nodes: Map<string, Node>
  groups: Map<string, NodeGroup>
  domains: Map<string, Domain>
  connections: Map<string, Connection>
}

/**
 * Capture a snapshot of the four entity maps for Yjs diffing. Returns null in
 * single-user mode (no yjsBinding) to avoid the O(n) copy cost on every
 * mutation — syncDiffToYDoc tolerates null and is a no-op in that case.
 */
function captureSnapshot(state: MapsSnapshot): MapsSnapshot | null {
  if (!yjsBinding) return null
  // During remote updates, syncDiffToYDoc returns immediately anyway (guarded
  // by isApplyingRemoteChanges), so skip the O(n) clone entirely.
  if (yjsBinding.isApplyingRemoteChanges) return null
  return {
    nodes: new Map(state.nodes),
    groups: new Map(state.groups),
    domains: new Map(state.domains),
    connections: new Map(state.connections),
  }
}

/**
 * Compare before/after snapshots and forward the diff to the Yjs binding.
 * No-op when yjsBinding is null (single-user mode), when before is null
 * (captureSnapshot skipped the copy), or when the binding is currently
 * applying remote changes (prevents feedback loops).
 */
function syncDiffToYDoc(before: MapsSnapshot | null, after: MapsSnapshot): void {
  if (!before) return
  if (!yjsBinding) return
  if (yjsBinding.isApplyingRemoteChanges) return
  yjsBinding.applyDiff(before, after)
}

/**
 * Holds in-flight async side-effect promises for history commands.
 * Kept outside of Zustand state to avoid storing non-serializable Promises.
 */
const commandEffectPromises = new Map<number, Promise<void>>()

let nextCommandId = 0
let isHistoryNavigating = false

interface Command {
  /** Unique command ID; assigned by executeCommand if omitted. */
  id?: number
  type: string
  timestamp: number
  userId?: number
  execute: () => Partial<CanvasState>
  undo: () => Partial<CanvasState>
  /** Optional async side effect that runs after the synchronous execute(). */
  afterExecute?: () => Promise<void>
  /** Optional async side effect that runs after the synchronous undo(). */
  afterUndo?: () => Promise<void>
}

function getCurrentUserId(): number | null {
  return useAuthStore.getState().user?.id ?? null
}

interface HistoryState {
  commands: Command[]
  currentIndex: number
  maxHistorySize: number
  maxHistoryDays: number
}

interface CanvasState {
  // Canvas data
  nodes: Map<string, Node>
  groups: Map<string, NodeGroup>
  domains: Map<string, Domain>
  connections: Map<string, Connection>

  // View state
  zoom: number
  panX: number
  panY: number

  // Selection state
  selectedIds: string[]
  hoveredId: string | null

  // Editing state
  editingId: string | null

  // Canvas state
  canvasId: number | null
  canvasName: string | null
  isDirty: boolean
  isLoading: boolean

  // Bulk-load marker. Incremented every time setCanvasData replaces the
  // entity maps (e.g. API load or cache restore). Subscribers can compare
  // this version against the previous state to distinguish bulk loads from
  // incremental local mutations.
  bulkLoadVersion: number

  // History state
  history: HistoryState

  // Actions
  setCanvasId: (id: number | null) => void
  setCanvasName: (name: string | null) => void

  // Node actions
  addNode: (node: Node) => void
  updateNode: (id: string, updates: Partial<Node>) => void
  updateNodeWithoutHistory: (id: string, updates: Partial<Node>, markDirty?: boolean) => void
  updateNodeWithOriginal: (id: string, updates: Partial<Node>, originalValues: Partial<Node>) => void
  removeNode: (id: string) => void
  duplicateNode: (id: string) => void

  // Node Pool actions
  moveNodeToPool: (nodeId: string, nodeData: Node, afterExecute?: () => Promise<void>, afterUndo?: () => Promise<void>) => number | undefined
  moveNodeFromPool: (node: Node, afterExecute?: () => Promise<void>, afterUndo?: () => Promise<void>) => number | undefined

  // Group actions
  addGroup: (group: NodeGroup) => void
  updateGroup: (id: string, updates: Partial<NodeGroup>) => void
  updateGroupWithoutHistory: (id: string, updates: Partial<NodeGroup>, markDirty?: boolean) => void
  removeGroup: (id: string) => void

  // Domain actions
  addDomain: (domain: Domain) => void
  updateDomain: (id: string, updates: Partial<Domain>) => void
  updateDomainWithoutHistory: (id: string, updates: Partial<Domain>, markDirty?: boolean) => void
  removeDomain: (id: string) => void

  // Connection actions
  addConnection: (connection: Connection) => void
  updateConnection: (id: string, updates: Partial<Connection>) => void
  updateConnectionWithoutHistory: (id: string, updates: Partial<Connection>, markDirty?: boolean) => void
  removeConnection: (id: string) => void

  // Bend point actions
  addConnectionBendPoint: (connectionId: string, bendPointId: string, x: number, y: number, insertIndex?: number) => void
  updateConnectionBendPoint: (connectionId: string, bendPointId: string, x: number, y: number) => void
  removeConnectionBendPoint: (connectionId: string, bendPointId: string) => void

  // Selection actions
  setSelectedIds: (ids: string[]) => void
  addToSelection: (id: string) => void
  removeFromSelection: (id: string) => void
  clearSelection: () => void

  // View actions
  setZoom: (zoom: number) => void
  setPan: (x: number, y: number) => void
  resetView: () => void
  fitViewToContent: (containerWidth: number, containerHeight: number, padding?: number) => void

  // Edit state
  setEditingId: (id: string | null) => void
  setHoveredId: (id: string | null) => void

  // Dirty state
  setDirty: (dirty: boolean) => void

  // Undo/Redo actions
  executeCommand: (command: Command, skipHistory?: boolean, markDirty?: boolean) => number
  executeCommandWithoutHistory: (command: Command) => number
  undo: () => Promise<void>
  redo: () => Promise<void>
  canUndo: () => boolean
  canRedo: () => boolean
  clearHistory: () => void
  /** Wait for the async side effect of a specific history command to complete. */
  waitForCommandEffect: (commandId: number) => Promise<void>

  // Bulk actions
  setCanvasData: (data: {
    nodes?: Node[]
    groups?: NodeGroup[]
    domains?: Domain[]
    connections?: Connection[]
  }) => void
  clearCanvas: () => void
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  // Initial state
  nodes: new Map(),
  groups: new Map(),
  domains: new Map(),
  connections: new Map(),

  zoom: CANVAS_DEFAULTS.DEFAULT_ZOOM,
  panX: 0,
  panY: 0,

  selectedIds: [],
  hoveredId: null,
  editingId: null,

  canvasId: null,
  canvasName: null,
  isDirty: false,
  isLoading: false,
  bulkLoadVersion: 0,

  history: {
    commands: [],
    currentIndex: -1,
    maxHistorySize: 100,
    maxHistoryDays: 7,
  },

  // Canvas ID
  setCanvasId: (id) => set({ canvasId: id }),
  setCanvasName: (name) => set({ canvasName: name }),

  // Node actions
  addNode: (node) =>
    get().executeCommand({
      type: 'addNode',
      timestamp: Date.now(),
      execute: () => {
        const state = get()
        const nodes = new Map(state.nodes)
        nodes.set(node.id, node)
        return { nodes, isDirty: true }
      },
      undo: () => {
        const state = get()
        const nodes = new Map(state.nodes)
        nodes.delete(node.id)
        return { nodes, isDirty: true }
      },
    }),

  updateNode: (id, updates) => {
    const state = get()
    const node = state.nodes.get(id)
    if (!node) return

    const originalValues = Object.keys(updates).reduce((acc, key) => {
      return { ...acc, [key]: (node as Node)[key as keyof Node] }
    }, {} as Record<string, unknown>)

    get().executeCommand({
      type: 'updateNode',
      timestamp: Date.now(),
      execute: () => {
        const nodes = new Map(get().nodes)
        const node = nodes.get(id)
        if (node) {
          const updatedNode = { ...node, ...updates }
          nodes.set(id, updatedNode)
          return { nodes, isDirty: true }
        }
        return {}
      },
      undo: () => {
        const nodes = new Map(get().nodes)
        const node = nodes.get(id)
        if (node) {
          nodes.set(id, { ...node, ...originalValues })
          return { nodes, isDirty: true }
        }
        return {}
      },
    })
  },

  updateNodeWithoutHistory: (id, updates, markDirty = true) => {
    const beforeSnapshot = captureSnapshot(get())
    set((state) => {
      const currentNodes = new Map(state.nodes)
      const currentNode = currentNodes.get(id)
      if (currentNode) {
        currentNodes.set(id, { ...currentNode, ...updates })
        return markDirty ? { nodes: currentNodes, isDirty: true } : { nodes: currentNodes }
      }
      return {}
    })
    syncDiffToYDoc(beforeSnapshot, get())
  },

  updateNodeWithOriginal: (id, updates, originalValues) => {
    get().executeCommand({
      type: 'updateNode',
      timestamp: Date.now(),
      execute: () => {
        const nodes = new Map(get().nodes)
        const node = nodes.get(id)
        if (node) {
          nodes.set(id, { ...node, ...updates })
          return { nodes, isDirty: true }
        }
        return {}
      },
      undo: () => {
        const nodes = new Map(get().nodes)
        const node = nodes.get(id)
        if (node) {
          nodes.set(id, { ...node, ...originalValues })
          return { nodes, isDirty: true }
        }
        return {}
      },
    })
  },

  removeNode: (id) => {
    const state = get()
    const node = state.nodes.get(id)
    if (!node) return

    const removedConnections: Connection[] = []
    for (const [, conn] of state.connections) {
      if (conn.fromNodeId === id || conn.toNodeId === id) {
        removedConnections.push(conn)
      }
    }

    get().executeCommand({
      type: 'removeNode',
      timestamp: Date.now(),
      execute: () => {
        const state = get()
        const nodes = new Map(state.nodes)
        nodes.delete(id)
        const connections = new Map(state.connections)
        for (const conn of removedConnections) {
          connections.delete(conn.id)
        }
        return { nodes, connections, isDirty: true }
      },
      undo: () => {
        const state = get()
        const nodes = new Map(state.nodes)
        const connections = new Map(state.connections)
        nodes.set(id, node)
        for (const conn of removedConnections) {
          connections.set(conn.id, conn)
        }
        return { nodes, connections, isDirty: true }
      },
    })
  },

  duplicateNode: (id) => {
    const state = get()
    const node = state.nodes.get(id)
    if (!node) return

    const newNode: Node = {
      ...node,
      id: `${node.id}-copy-${Date.now()}`,
      x: node.x + 20,
      y: node.y + 20,
    }
    get().addNode(newNode)
    get().setSelectedIds([newNode.id])
  },

  // Group actions
  addGroup: (group) =>
    get().executeCommand({
      type: 'addGroup',
      timestamp: Date.now(),
      execute: () => {
        const state = get()
        const groups = new Map(state.groups)
        groups.set(group.id, group)
        return { groups, isDirty: true }
      },
      undo: () => {
        const state = get()
        const groups = new Map(state.groups)
        groups.delete(group.id)
        return { groups, isDirty: true }
      },
    }),

  updateGroup: (id, updates) => {
    const state = get()
    const group = state.groups.get(id)
    if (!group) {
      return
    }

    const originalValues = Object.keys(updates).reduce((acc, key) => {
      return { ...acc, [key]: (group as NodeGroup)[key as keyof NodeGroup] }
    }, {} as Record<string, unknown>)

    get().executeCommand({
      type: 'updateGroup',
      timestamp: Date.now(),
      execute: () => {
        const currentState = get()
        const groups = new Map(currentState.groups)
        const currentGroup = groups.get(id)
        if (currentGroup) {
          const updatedGroup = { ...currentGroup, ...updates }
          groups.set(id, updatedGroup)
          return { groups, isDirty: true }
        }
        return {}
      },
      undo: () => {
        const currentState = get()
        const groups = new Map(currentState.groups)
        const currentGroup = groups.get(id)
        if (currentGroup) {
          const restoredGroup = { ...currentGroup, ...originalValues }
          groups.set(id, restoredGroup)
          return { groups, isDirty: true }
        }
        return {}
      },
    })
  },

  updateGroupWithoutHistory: (id, updates, markDirty = true) => {
    const beforeSnapshot = captureSnapshot(get())
    set((state) => {
      const groups = new Map(state.groups)
      const group = groups.get(id)
      if (group) {
        groups.set(id, { ...group, ...updates })
        return markDirty ? { groups, isDirty: true } : { groups }
      }
      return {}
    })
    syncDiffToYDoc(beforeSnapshot, get())
  },

  removeGroup: (id) => {
    const state = get()
    const group = state.groups.get(id)
    if (!group) {
      return
    }

    get().executeCommand({
      type: 'removeGroup',
      timestamp: Date.now(),
      execute: () => {
        const groups = new Map(state.groups)
        groups.delete(id)
        const selectedIds = state.selectedIds.filter(sid => sid !== id)
        return { groups, selectedIds, isDirty: true }
      },
      undo: () => {
        const groups = new Map(state.groups)
        groups.set(id, group)
        return { groups, isDirty: true }
      },
    })
  },

  // Domain actions
  addDomain: (domain) =>
    get().executeCommand({
      type: 'addDomain',
      timestamp: Date.now(),
      execute: () => {
        const state = get()
        const domains = new Map(state.domains)
        domains.set(domain.id, domain)
        return { domains, isDirty: true }
      },
      undo: () => {
        const state = get()
        const domains = new Map(state.domains)
        domains.delete(domain.id)
        return { domains, isDirty: true }
      },
    }),

  updateDomain: (id, updates) => {
    const state = get()
    const domain = state.domains.get(id)
    if (!domain) return

    const originalValues = Object.keys(updates).reduce((acc, key) => {
      return { ...acc, [key]: (domain as Domain)[key as keyof Domain] }
    }, {} as Record<string, unknown>)

    get().executeCommand({
      type: 'updateDomain',
      timestamp: Date.now(),
      execute: () => {
        const state = get()
        const domains = new Map(state.domains)
        const domain = domains.get(id)
        if (domain) {
          domains.set(id, { ...domain, ...updates })
          return { domains, isDirty: true }
        }
        return {}
      },
      undo: () => {
        const state = get()
        const domains = new Map(state.domains)
        const domain = domains.get(id)
        if (domain) {
          domains.set(id, { ...domain, ...originalValues })
          return { domains, isDirty: true }
        }
        return {}
      },
    })
  },

  updateDomainWithoutHistory: (id, updates, markDirty = true) => {
    const beforeSnapshot = captureSnapshot(get())
    set((state) => {
      const domains = new Map(state.domains)
      const domain = domains.get(id)
      if (domain) {
        domains.set(id, { ...domain, ...updates })
        return markDirty ? { domains, isDirty: true } : { domains }
      }
      return {}
    })
    syncDiffToYDoc(beforeSnapshot, get())
  },

  removeDomain: (id) => {
    const state = get()
    const domain = state.domains.get(id)
    if (!domain) return

    get().executeCommand({
      type: 'removeDomain',
      timestamp: Date.now(),
      execute: () => {
        const state = get()
        const domains = new Map(state.domains)
        domains.delete(id)
        return { domains, isDirty: true }
      },
      undo: () => {
        const state = get()
        const domains = new Map(state.domains)
        domains.set(id, domain)
        return { domains, isDirty: true }
      },
    })
  },

  // Connection actions
  addConnection: (connection) =>
    get().executeCommand({
      type: 'addConnection',
      timestamp: Date.now(),
      execute: () => {
        const state = get()
        const connections = new Map(state.connections)
        connections.set(connection.id, connection)
        return { connections, isDirty: true }
      },
      undo: () => {
        const state = get()
        const connections = new Map(state.connections)
        connections.delete(connection.id)
        return { connections, isDirty: true }
      },
    }),

  updateConnection: (id, updates) => {
    const state = get()
    const connection = state.connections.get(id)
    if (!connection) return

    const originalValues = Object.keys(updates).reduce((acc, key) => {
      return { ...acc, [key]: (connection as Connection)[key as keyof Connection] }
    }, {} as Record<string, unknown>)

    get().executeCommand({
      type: 'updateConnection',
      timestamp: Date.now(),
      execute: () => {
        const state = get()
        const connections = new Map(state.connections)
        const connection = connections.get(id)
        if (connection) {
          connections.set(id, { ...connection, ...updates })
          return { connections, isDirty: true }
        }
        return {}
      },
      undo: () => {
        const state = get()
        const connections = new Map(state.connections)
        const connection = connections.get(id)
        if (connection) {
          connections.set(id, { ...connection, ...originalValues })
          return { connections, isDirty: true }
        }
        return {}
      },
    })
  },

  updateConnectionWithoutHistory: (id, updates, markDirty = true) => {
    const beforeSnapshot = captureSnapshot(get())
    set((state) => {
      const connections = new Map(state.connections)
      const connection = connections.get(id)
      if (connection) {
        connections.set(id, { ...connection, ...updates })
        return markDirty ? { connections, isDirty: true } : { connections }
      }
      return {}
    })
    syncDiffToYDoc(beforeSnapshot, get())
  },

  removeConnection: (id) => {
    const state = get()
    const connection = state.connections.get(id)
    if (!connection) return

    get().executeCommand({
      type: 'removeConnection',
      timestamp: Date.now(),
      execute: () => {
        const state = get()
        const connections = new Map(state.connections)
        connections.delete(id)
        return { connections, isDirty: true }
      },
      undo: () => {
        const state = get()
        const connections = new Map(state.connections)
        connections.set(id, connection)
        return { connections, isDirty: true }
      },
    })
  },

  addConnectionBendPoint: (connectionId, bendPointId, x, y, insertIndex = undefined) => {
    const state = get()
    const connection = state.connections.get(connectionId)
    if (!connection) return

    const newBendPoint = { id: bendPointId, x, y }
    const existingBendPoints = connection.bendPoints || []

    get().executeCommand({
      type: 'addConnectionBendPoint',
      timestamp: Date.now(),
      execute: () => {
        const state = get()
        const connections = new Map(state.connections)
        const conn = connections.get(connectionId)
        if (conn) {
          let newBendPoints
          if (insertIndex !== undefined && insertIndex >= 0 && insertIndex <= existingBendPoints.length) {
            newBendPoints = [
              ...existingBendPoints.slice(0, insertIndex),
              newBendPoint,
              ...existingBendPoints.slice(insertIndex)
            ]
          } else {
            newBendPoints = [...existingBendPoints, newBendPoint]
          }

          connections.set(connectionId, {
            ...conn,
            bendPoints: newBendPoints,
          })
        }
        return { connections, isDirty: true }
      },
      undo: () => {
        const state = get()
        const connections = new Map(state.connections)
        const conn = connections.get(connectionId)
        if (conn) {
          connections.set(connectionId, {
            ...conn,
            bendPoints: existingBendPoints,
          })
        }
        return { connections, isDirty: true }
      },
    })
  },

  updateConnectionBendPoint: (connectionId, bendPointId, x, y) => {
    const state = get()
    const connection = state.connections.get(connectionId)
    if (!connection || !connection.bendPoints) return

    const bendPoint = connection.bendPoints.find(bp => bp.id === bendPointId)
    if (!bendPoint) return

    const originalX = bendPoint.x
    const originalY = bendPoint.y

    get().executeCommand({
      type: 'updateConnectionBendPoint',
      timestamp: Date.now(),
      execute: () => {
        const state = get()
        const connections = new Map(state.connections)
        const conn = connections.get(connectionId)
        if (conn && conn.bendPoints) {
          connections.set(connectionId, {
            ...conn,
            bendPoints: conn.bendPoints.map(bp =>
              bp.id === bendPointId ? { ...bp, x, y } : bp
            ),
          })
        }
        return { connections, isDirty: true }
      },
      undo: () => {
        const state = get()
        const connections = new Map(state.connections)
        const conn = connections.get(connectionId)
        if (conn && conn.bendPoints) {
          connections.set(connectionId, {
            ...conn,
            bendPoints: conn.bendPoints.map(bp =>
              bp.id === bendPointId ? { ...bp, x: originalX, y: originalY } : bp
            ),
          })
        }
        return { connections, isDirty: true }
      },
    })
  },

  removeConnectionBendPoint: (connectionId, bendPointId) => {
    const state = get()
    const connection = state.connections.get(connectionId)
    if (!connection || !connection.bendPoints) return

    const bendPoint = connection.bendPoints.find(bp => bp.id === bendPointId)
    if (!bendPoint) return

    const existingBendPoints = connection.bendPoints

    get().executeCommand({
      type: 'removeConnectionBendPoint',
      timestamp: Date.now(),
      execute: () => {
        const state = get()
        const connections = new Map(state.connections)
        const conn = connections.get(connectionId)
        if (conn && conn.bendPoints) {
          connections.set(connectionId, {
            ...conn,
            bendPoints: conn.bendPoints.filter(bp => bp.id !== bendPointId),
          })
        }
        return { connections, isDirty: true }
      },
      undo: () => {
        const state = get()
        const connections = new Map(state.connections)
        const conn = connections.get(connectionId)
        if (conn) {
          connections.set(connectionId, {
            ...conn,
            bendPoints: existingBendPoints,
          })
        }
        return { connections, isDirty: true }
      },
    })
  },

  // Selection actions
  setSelectedIds: (ids) => set({ selectedIds: ids }),
  addToSelection: (id) =>
    set((state) => ({
      selectedIds: state.selectedIds.includes(id)
        ? state.selectedIds
        : [...state.selectedIds, id],
    })),
  removeFromSelection: (id) =>
    set((state) => ({
      selectedIds: state.selectedIds.filter((sid) => sid !== id),
    })),
  clearSelection: () => set({ selectedIds: [] }),

  // View actions
  setZoom: (zoom) => set({ zoom }),
  setPan: (x, y) => set({ panX: x, panY: y }),
  resetView: () =>
    set({
      zoom: CANVAS_DEFAULTS.DEFAULT_ZOOM,
      panX: 0,
      panY: 0,
    }),
  fitViewToContent: (containerWidth, containerHeight, padding = 100) => {
    const state = get()
    const { nodes, groups, domains } = state

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity

    const allElements = [...Array.from(nodes.values()), ...Array.from(groups.values()), ...Array.from(domains.values())]

    if (allElements.length === 0) {
      return
    }

    allElements.forEach((el) => {
      const right = el.x + (el.width || 0)
      const bottom = el.y + (el.height || 0)
      minX = Math.min(minX, el.x)
      minY = Math.min(minY, el.y)
      maxX = Math.max(maxX, right)
      maxY = Math.max(maxY, bottom)
    })

    const contentWidth = maxX - minX + padding * 2
    const contentHeight = maxY - minY + padding * 2
    const contentCenterX = (minX + maxX) / 2
    const contentCenterY = (minY + maxY) / 2

    const scaleX = containerWidth / contentWidth
    const scaleY = containerHeight / contentHeight
    const newZoom = Math.min(scaleX, scaleY, CANVAS_DEFAULTS.MAX_ZOOM)
    const clampedZoom = Math.max(newZoom, CANVAS_DEFAULTS.MIN_ZOOM)

    const newPanX = containerWidth / 2 - contentCenterX * clampedZoom
    const newPanY = containerHeight / 2 - contentCenterY * clampedZoom

    set({ zoom: clampedZoom, panX: newPanX, panY: newPanY })
  },

  // Edit state
  setEditingId: (id) => set({ editingId: id }),
  setHoveredId: (id) => set({ hoveredId: id }),

  // Dirty state
  setDirty: (dirty) => {
    set({ isDirty: dirty })
  },

moveNodeToPool: (nodeId: string, nodeData: Node, afterExecute?: () => Promise<void>, afterUndo?: () => Promise<void>) => {
    const state = get()
    const node = state.nodes.get(nodeId)
    if (!node) return undefined

    // 收集与该节点相关的连接
    const removedConnections: Connection[] = []
    for (const [, conn] of state.connections) {
      if (conn.fromNodeId === nodeId || conn.toNodeId === nodeId) {
        removedConnections.push(conn)
      }
    }

    return get().executeCommand({
      type: 'moveNodeToPool',
      timestamp: Date.now(),
      execute: () => {
        const state = get()
        const nodes = new Map(state.nodes)
        nodes.delete(nodeId)
        const connections = new Map(state.connections)
        for (const conn of removedConnections) {
          connections.delete(conn.id)
        }
        return { nodes, connections, selectedIds: [], isDirty: true }
      },
      undo: () => {
        const state = get()
        const nodes = new Map(state.nodes)
        const connections = new Map(state.connections)
        nodes.set(nodeId, nodeData)
        for (const conn of removedConnections) {
          connections.set(conn.id, conn)
        }
        return { nodes, connections, isDirty: true }
      },
      afterExecute,
      afterUndo,
    })
  },

  moveNodeFromPool: (node: Node, afterExecute?: () => Promise<void>, afterUndo?: () => Promise<void>) => {
    return get().executeCommand({
      type: 'moveNodeFromPool',
      timestamp: Date.now(),
      execute: () => {
        const state = get()
        const nodes = new Map(state.nodes)
        nodes.set(node.id, node)
        return { nodes, selectedIds: [node.id], isDirty: true }
      },
      undo: () => {
        const state = get()
        const nodes = new Map(state.nodes)
        nodes.delete(node.id)
        return { nodes, selectedIds: [], isDirty: true }
      },
      afterExecute,
      afterUndo,
    })
  },

  // Undo/Redo actions
  executeCommand: (command, skipHistory = false, markDirty = true) => {
    const currentUserId = getCurrentUserId()
    const commandWithUser = { ...command, id: command.id ?? ++nextCommandId, userId: currentUserId ?? undefined }
    // When the Yjs binding is applying remote changes, force skipHistory so
    // remote operations never enter the local undo stack.
    const effectiveSkipHistory = skipHistory || (yjsBinding?.isApplyingRemoteChanges ?? false)
    // Capture before-snapshot once so both branches can diff into Yjs.
    const beforeSnapshot = captureSnapshot(get())

    if (effectiveSkipHistory) {
      const commandResult = commandWithUser.execute()
      set(markDirty ? { ...commandResult, isDirty: true } : commandResult)
      syncDiffToYDoc(beforeSnapshot, get())
      return commandWithUser.id
    }

    set((state) => {
      const newCommands = state.history.commands.slice(0, state.history.currentIndex + 1)

      if (newCommands.length >= state.history.maxHistorySize) {
        newCommands.shift()
      }

      const now = Date.now()
      const maxAge = state.history.maxHistoryDays * 24 * 60 * 60 * 1000
      while (newCommands.length > 0 && now - newCommands[0].timestamp > maxAge) {
        newCommands.shift()
      }

      newCommands.push(commandWithUser)
      const commandResult = commandWithUser.execute()

      return {
        ...commandResult,
        history: {
          ...state.history,
          commands: newCommands,
          currentIndex: newCommands.length - 1,
        },
        ...(markDirty ? { isDirty: true } : {}),
      }
    })
    syncDiffToYDoc(beforeSnapshot, get())

    if (commandWithUser.afterExecute) {
      const promise = commandWithUser
        .afterExecute()
        .catch((error) => {
          logger.error('[executeCommand] afterExecute failed', { commandType: commandWithUser.type, error })
        })
        .finally(() => {
          commandEffectPromises.delete(commandWithUser.id)
        })
      commandEffectPromises.set(commandWithUser.id, promise)
    }

    return commandWithUser.id
  },

  executeCommandWithoutHistory: (command) => {
    const currentUserId = getCurrentUserId()
    const commandWithUser = { ...command, id: command.id ?? ++nextCommandId, userId: currentUserId ?? undefined }
    const beforeSnapshot = captureSnapshot(get())
    const commandResult = commandWithUser.execute()
    set({ ...commandResult, isDirty: true })
    syncDiffToYDoc(beforeSnapshot, get())
    return commandWithUser.id
  },

  undo: async () => {
    if (isHistoryNavigating) return
    isHistoryNavigating = true
    try {
      const state = get()
      const currentUserId = getCurrentUserId()

      let targetIndex = state.history.currentIndex
      while (targetIndex >= 0) {
        const cmd = state.history.commands[targetIndex]
        if (cmd.userId === currentUserId || cmd.userId === undefined) {
          break
        }
        targetIndex--
      }

      if (targetIndex < 0) return

      const command = state.history.commands[targetIndex]

      // Wait for any in-flight execute side effect before undoing so the undo
      // callback can observe the fully committed state (e.g. real card ID).
      const pendingPromise = commandEffectPromises.get(command.id)
      if (pendingPromise) {
        try {
          await pendingPromise
        } catch {
          // Error already logged by executeCommand; continue with undo.
        }
      }

      const beforeSnapshot = captureSnapshot(get())
      const commandResult = command.undo()

      set((state) => ({
        ...commandResult,
        history: {
          ...state.history,
          currentIndex: targetIndex - 1,
        },
        isDirty: true,
      }))
      syncDiffToYDoc(beforeSnapshot, get())

      if (command.afterUndo) {
        const promise = command
          .afterUndo()
          .catch((error) => {
            logger.error('[undo] afterUndo failed', { commandType: command.type, error })
          })
          .finally(() => {
            commandEffectPromises.delete(command.id)
          })
        commandEffectPromises.set(command.id, promise)
      }
    } finally {
      isHistoryNavigating = false
    }
  },

  redo: async () => {
    if (isHistoryNavigating) return
    isHistoryNavigating = true
    try {
      const state = get()
      const currentUserId = getCurrentUserId()

      let targetIndex = state.history.currentIndex + 1
      while (targetIndex < state.history.commands.length) {
        const cmd = state.history.commands[targetIndex]
        if (cmd.userId === currentUserId || cmd.userId === undefined) {
          break
        }
        targetIndex++
      }

      if (targetIndex >= state.history.commands.length) return

      const command = state.history.commands[targetIndex]

      // Wait for any in-flight undo side effect before redoing so the redo
      // callback can observe the fully committed state.
      const pendingPromise = commandEffectPromises.get(command.id)
      if (pendingPromise) {
        try {
          await pendingPromise
        } catch {
          // Error already logged by undo; continue with redo.
        }
      }

      const beforeSnapshot = captureSnapshot(get())
      const commandResult = command.execute()

      set((state) => ({
        ...commandResult,
        history: {
          ...state.history,
          currentIndex: targetIndex,
        },
        isDirty: true,
      }))
      syncDiffToYDoc(beforeSnapshot, get())

      if (command.afterExecute) {
        const promise = command
          .afterExecute()
          .catch((error) => {
            logger.error('[redo] afterExecute failed', { commandType: command.type, error })
          })
          .finally(() => {
            commandEffectPromises.delete(command.id)
          })
        commandEffectPromises.set(command.id, promise)
      }
    } finally {
      isHistoryNavigating = false
    }
  },

  canUndo: () => {
    const state = get()
    const currentUserId = getCurrentUserId()

    for (let i = state.history.currentIndex; i >= 0; i--) {
      const cmd = state.history.commands[i]
      if (cmd.userId === currentUserId || cmd.userId === undefined) {
        return true
      }
    }
    return false
  },

  canRedo: () => {
    const state = get()
    const currentUserId = getCurrentUserId()

    for (let i = state.history.currentIndex + 1; i < state.history.commands.length; i++) {
      const cmd = state.history.commands[i]
      if (cmd.userId === currentUserId || cmd.userId === undefined) {
        return true
      }
    }
    return false
  },

  clearHistory: () =>
    set((state) => {
      const currentUserId = getCurrentUserId()
      const filteredCommands = state.history.commands.filter(
        cmd => cmd.userId !== currentUserId && cmd.userId !== undefined
      )

      return {
        history: {
          ...state.history,
          commands: filteredCommands,
          currentIndex: filteredCommands.length - 1,
        },
      }
    }),

  waitForCommandEffect: async (commandId: number) => {
    const promise = commandEffectPromises.get(commandId)
    if (promise) {
      try {
        await promise
      } catch {
        // Error already logged by the effect originator.
      }
    }
  },

  // Bulk actions
  setCanvasData: (data) => {
    const before = captureSnapshot(get())
    set((state) => {
      const currentUserId = getCurrentUserId()
      const ownCommands = state.history.commands.filter(
        cmd => cmd.userId === currentUserId || cmd.userId === undefined
      )
      return {
        nodes: data.nodes ? new Map(data.nodes.map((n) => [n.id, n])) : state.nodes,
        groups: data.groups ? new Map(data.groups.map((g) => [g.id, g])) : state.groups,
        domains: data.domains ? new Map(data.domains.map((d) => [d.id, d])) : state.domains,
        connections: data.connections
          ? new Map(data.connections.map((c) => [c.id, {
            ...c,
            fromPort: c.fromPort || 'right',
            toPort: c.toPort || 'left'
          }]))
          : state.connections,
        history: {
          ...state.history,
          commands: ownCommands,
          currentIndex: ownCommands.length - 1,
        },
        // Bump the bulk-load marker so subscribers can tell that the entire
        // entity map was replaced (e.g. after API/cache load) rather than
        // incrementally mutated by the user.
        bulkLoadVersion: state.bulkLoadVersion + 1,
      }
    })
    syncDiffToYDoc(before, get())
  },

  clearCanvas: () => {
    set({
      nodes: new Map(),
      groups: new Map(),
      domains: new Map(),
      connections: new Map(),
      selectedIds: [],
      hoveredId: null,
      editingId: null,
      isDirty: false,
    })
    // clearCanvas is a local state reset — it must NOT broadcast empty state
    // to peers. All callers use it before loading new canvas data or when
    // navigating away from a deleted canvas; in neither case should the empty
    // store propagate to the Y.Doc.
  },
}))
