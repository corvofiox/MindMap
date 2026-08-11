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
  /** Replace the entire Y.Doc content with imported entities in a single
   *  LOCAL_ORIGIN transaction. */
  importIntoDoc: (data: {
    nodes: Node[]
    groups: NodeGroup[]
    domains: Domain[]
    connections: Connection[]
  }) => boolean
  /** Copy all entities from the Zustand store into the Y.Doc (initial sync). */
  syncLocalStateToYDoc: () => void
  /** M4: 握手窗口内本地编辑过的实体整字段写回 doc（即使 doc 中已存在）。 */
  syncLocalEditsToYDoc: (ids: Set<string>) => void
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

/** C19: 等待命令副作用完成的最大时长，防止 afterExecute/afterUndo 永不
 *  resolve（如底层 API 挂起）时 undo/redo 永久卡死。 */
const COMMAND_EFFECT_TIMEOUT_MS = 8000

async function waitForCommandEffectWithTimeout(commandId: number): Promise<void> {
  const promise = commandEffectPromises.get(commandId)
  if (!promise) return
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      logger.warn(
        `[undo/redo] waiting for command effect #${commandId} timed out after ${COMMAND_EFFECT_TIMEOUT_MS}ms; continuing`,
      )
      resolve()
    }, COMMAND_EFFECT_TIMEOUT_MS)
  })
  try {
    await Promise.race([promise, timeout])
  } catch {
    // Error already logged by the effect originator; continue.
  } finally {
    if (timer) clearTimeout(timer)
  }
}

interface Command {
  /** Unique command ID; assigned by executeCommand if omitted. */
  id?: number
  type: string
  timestamp: number
  userId?: number
  /**
   * M5: 命令归属的画布 ID（执行时 store.canvasId 的快照）。undo/redo 时与
   * 当前画布比对，防止切画布后历史残留（如 clearCanvas 路径）跨画布执行
   * 旧命令污染新画布。null 表示执行时尚未加载画布（初始会话），此类命令
   * 不受归属校验限制。
   */
  canvasId?: number | null
  execute: () => Partial<CanvasState>
  undo: () => Partial<CanvasState>
  /** Optional async side effect that runs after the synchronous execute(). */
  afterExecute?: () => Promise<void>
  /** Optional async side effect that runs after the synchronous undo(). */
  afterUndo?: () => Promise<void>
  /**
   * R8: 纯本地顺序操作标记(如置顶/置底——仅重排 Map 顺序,不持久化、
   * 不同步 Yjs)。undo/redo 分支识别后不置 dirty,避免触发冗余自动保存。
   */
  pureOrderChange?: boolean
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
  /** M6: 批量删除实体（合并为单条 undo 历史命令）。 */
  deleteEntitiesByIds: (ids: string[]) => void

  // Connection actions
  addConnection: (connection: Connection) => void
  updateConnection: (id: string, updates: Partial<Connection>) => void
  updateConnectionWithoutHistory: (id: string, updates: Partial<Connection>, markDirty?: boolean) => void
  removeConnection: (id: string) => void

  // Bend point actions
  addConnectionBendPoint: (connectionId: string, bendPointId: string, x: number, y: number, insertIndex?: number) => void
  updateConnectionBendPoint: (connectionId: string, bendPointId: string, x: number, y: number) => void
  updateConnectionBendPointWithoutHistory: (connectionId: string, bendPointId: string, x: number, y: number, markDirty?: boolean) => void
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
  setCanvasData: (
    data: {
      nodes?: Node[]
      groups?: NodeGroup[]
      domains?: Domain[]
      connections?: Connection[]
    },
    viewState?: { zoom: number; panX: number; panY: number },
  ) => void
  importCanvasData: (
    data: {
      nodes: Node[]
      groups: NodeGroup[]
      domains: Domain[]
      connections: Connection[]
    },
    viewState?: { zoom: number; panX: number; panY: number },
  ) => boolean
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

  // M6: 批量删除选中实体——一次手势/一次按键对多个实体各调 removeXxx 会
  // 产生 N 条历史记录，撤销粒度破碎且容易打满历史上限。这里把整批删除
  // 合并为单条命令：execute 删除全部实体（含被删节点附带的连接），undo
  // 整体恢复。
  deleteEntitiesByIds: (ids: string[]) => {
    const state = get()
    const idSet = new Set(ids)
    const removedNodes = new Map<string, Node>()
    const removedGroups = new Map<string, NodeGroup>()
    const removedDomains = new Map<string, Domain>()
    const removedConnections = new Map<string, Connection>()

    // 收集被删节点附带的连接（与 removeNode 的语义一致），以及被直接选中的连接。
    for (const [connId, conn] of state.connections) {
      if (
        idSet.has(connId) ||
        idSet.has(conn.fromNodeId) ||
        idSet.has(conn.toNodeId)
      ) {
        removedConnections.set(connId, conn)
      }
    }
    for (const id of ids) {
      const node = state.nodes.get(id)
      if (node) removedNodes.set(id, node)
      const group = state.groups.get(id)
      if (group) removedGroups.set(id, group)
      const domain = state.domains.get(id)
      if (domain) removedDomains.set(id, domain)
    }

    if (
      removedNodes.size + removedGroups.size + removedDomains.size + removedConnections.size === 0
    ) {
      return
    }

    get().executeCommand({
      type: 'deleteEntities',
      timestamp: Date.now(),
      execute: () => {
        const s = get()
        const nodes = new Map(s.nodes)
        const groups = new Map(s.groups)
        const domains = new Map(s.domains)
        const connections = new Map(s.connections)
        for (const id of removedNodes.keys()) nodes.delete(id)
        for (const id of removedGroups.keys()) groups.delete(id)
        for (const id of removedDomains.keys()) domains.delete(id)
        for (const id of removedConnections.keys()) connections.delete(id)
        return {
          nodes,
          groups,
          domains,
          connections,
          selectedIds: s.selectedIds.filter((sid) => !idSet.has(sid)),
          isDirty: true,
        }
      },
      undo: () => {
        const s = get()
        const nodes = new Map(s.nodes)
        const groups = new Map(s.groups)
        const domains = new Map(s.domains)
        const connections = new Map(s.connections)
        for (const [id, node] of removedNodes) nodes.set(id, node)
        for (const [id, group] of removedGroups) groups.set(id, group)
        for (const [id, domain] of removedDomains) domains.set(id, domain)
        for (const [id, conn] of removedConnections) connections.set(id, conn)
        return { nodes, groups, domains, connections, isDirty: true }
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

  // M3: 拖动 bend point 过程中的高频更新——不逐帧入历史（一次手势 60+ 条
  // 记录会打满 maxHistorySize=100），由 CanvasPage 在 mouseup 时提交一条
  // 合并命令（execute 幂等重放最终值，undo 恢复拖动前原值）。
  updateConnectionBendPointWithoutHistory: (connectionId, bendPointId, x, y, markDirty = true) => {
    const beforeSnapshot = captureSnapshot(get())
    set((state) => {
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
      return markDirty ? { connections, isDirty: true } : { connections }
    })
    syncDiffToYDoc(beforeSnapshot, get())
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
    // M5: 记录命令归属画布，供 undo/redo 跨画布校验。
    const commandWithUser = { ...command, id: command.id ?? ++nextCommandId, userId: currentUserId ?? undefined, canvasId: get().canvasId }
    // When the Yjs binding is applying remote changes, force skipHistory so
    // remote operations never enter the local undo stack.
    const effectiveSkipHistory = skipHistory || (yjsBinding?.isApplyingRemoteChanges ?? false)
    // Capture before-snapshot once so both branches can diff into Yjs.
    const beforeSnapshot = captureSnapshot(get())

    if (effectiveSkipHistory) {
      const commandResult = commandWithUser.execute()
      // C22: 空结果（如节点不存在时 execute 返回 {}）不应置 dirty
      const hasChanges = Object.keys(commandResult).length > 0
      set(markDirty && hasChanges ? { ...commandResult, isDirty: true } : commandResult)
      syncDiffToYDoc(beforeSnapshot, get())
      return commandWithUser.id
    }

    const commandResult = commandWithUser.execute()
    // C22: 空结果（如节点不存在时 execute 返回 {}）不 push 命令、不置
    // dirty、不执行 afterExecute——与 skipHistory 分支保持一致。
    const hasChanges = Object.keys(commandResult).length > 0
    if (!hasChanges) {
      set({ ...commandResult })
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
    // C22: 空结果不置 dirty（与 executeCommand skipHistory 分支保持一致）
    const hasChanges = Object.keys(commandResult).length > 0
    set(hasChanges ? { ...commandResult, isDirty: true } : commandResult)
    syncDiffToYDoc(beforeSnapshot, get())
    return commandWithUser.id
  },

  undo: async () => {
    if (isHistoryNavigating) return
    isHistoryNavigating = true
    try {
      const state = get()
      const currentUserId = getCurrentUserId()

      const currentCanvasId = state.canvasId
      let targetIndex = state.history.currentIndex
      while (targetIndex >= 0) {
        const cmd = state.history.commands[targetIndex]
        // M5: 跳过属于其他画布的历史命令，防止 clearCanvas 后残留的旧画布
        // 命令被跨画布执行（redo 污染新画布 / undo 误删新画布内容）。
        if (cmd.canvasId !== undefined && cmd.canvasId !== currentCanvasId) {
          targetIndex--
          continue
        }
        if (cmd.userId === currentUserId || cmd.userId === undefined) {
          break
        }
        targetIndex--
      }

      if (targetIndex < 0) return

      const command = state.history.commands[targetIndex]

      // Wait for any in-flight execute side effect before undoing so the undo
      // callback can observe the fully committed state (e.g. real card ID).
      // C19: 带超时兜底，避免副作用永不完成时 undo 卡死。
      // 注意：仅当存在 pending promise 时才 await——无副作用时保持同步
      // 执行，否则 undo() 会多出一次微任务，破坏同步调用的测试语义。
      const pendingEffect = commandEffectPromises.get(command.id)
      if (pendingEffect) {
        await waitForCommandEffectWithTimeout(command.id)
      }

      const beforeSnapshot = captureSnapshot(get())
      const commandResult = command.undo()

      // R7-fix: 空结果(如节点已不存在)不置 dirty——与 C22 execute 路径一致,
      // 避免置顶/置底等无内容变化的命令 undo 后触发冗余自动保存。
      // R8-fix: pureOrderChange 命令(置顶/置底)的 undo 仅恢复本地顺序,
      // 同样不置 dirty。
      const hasChanges = Object.keys(commandResult).length > 0
      const isPureOrder = command.pureOrderChange === true
      set((state) => ({
        ...commandResult,
        history: {
          ...state.history,
          currentIndex: targetIndex - 1,
        },
        isDirty: hasChanges && !isPureOrder ? true : state.isDirty,
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

      const currentCanvasId = state.canvasId
      let targetIndex = state.history.currentIndex + 1
      while (targetIndex < state.history.commands.length) {
        const cmd = state.history.commands[targetIndex]
        // M5: 跨画布校验（与 undo 一致）。
        if (cmd.canvasId !== undefined && cmd.canvasId !== currentCanvasId) {
          targetIndex++
          continue
        }
        if (cmd.userId === currentUserId || cmd.userId === undefined) {
          break
        }
        targetIndex++
      }

      if (targetIndex >= state.history.commands.length) return

      const command = state.history.commands[targetIndex]

      // Wait for any in-flight undo side effect before redoing so the redo
      // callback can observe the fully committed state.
      // C19: 带超时兜底；仅当存在 pending promise 时才 await（保持同步语义）。
      const pendingEffect = commandEffectPromises.get(command.id)
      if (pendingEffect) {
        await waitForCommandEffectWithTimeout(command.id)
      }

      const beforeSnapshot = captureSnapshot(get())
      const commandResult = command.execute()

      // R7-fix: 空结果不置 dirty(与 undo 分支一致)
      // R8-fix: pureOrderChange 命令的 redo 同样不置 dirty
      const hasChanges = Object.keys(commandResult).length > 0
      const isPureOrder = command.pureOrderChange === true
      set((state) => ({
        ...commandResult,
        history: {
          ...state.history,
          currentIndex: targetIndex,
        },
        isDirty: hasChanges && !isPureOrder ? true : state.isDirty,
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

    const currentCanvasId = get().canvasId
    for (let i = state.history.currentIndex; i >= 0; i--) {
      const cmd = state.history.commands[i]
      // M5: 跨画布历史命令不计入可撤销范围。
      if (cmd.canvasId !== undefined && cmd.canvasId !== currentCanvasId) continue
      if (cmd.userId === currentUserId || cmd.userId === undefined) {
        return true
      }
    }
    return false
  },

  canRedo: () => {
    const state = get()
    const currentUserId = getCurrentUserId()
    const currentCanvasId = state.canvasId

    for (let i = state.history.currentIndex + 1; i < state.history.commands.length; i++) {
      const cmd = state.history.commands[i]
      // M5: 跨画布历史命令不计入可重做范围。
      if (cmd.canvasId !== undefined && cmd.canvasId !== currentCanvasId) continue
      if (cmd.userId === currentUserId || cmd.userId === undefined) {
        return true
      }
    }
    return false
  },

  clearHistory: () =>
    set((state) => ({
      history: {
        ...state.history,
        commands: [],
        currentIndex: -1,
      },
    })),

  waitForCommandEffect: async (commandId: number) => {
    await waitForCommandEffectWithTimeout(commandId)
  },

  // Bulk actions
  setCanvasData: (data, viewState) => {
    const before = captureSnapshot(get())
    set((state) => {
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
        // Bulk load replaces the entire canvas content; clear transient UI
        // states that may point to entities that no longer exist.
        selectedIds: [],
        hoveredId: null,
        editingId: null,
        // C1: 整包加载 = 新画布会话，清空 undo/redo 历史，防止 Ctrl+Z 执行
        // 上一张画布的旧命令（误删节点 / redo 污染新画布 Y.Doc）。
        history: {
          ...state.history,
          commands: [],
          currentIndex: -1,
        },
        // Bump the bulk-load marker so subscribers can tell that the entire
        // entity map was replaced (e.g. after API/cache load) rather than
        // incrementally mutated by the user.
        bulkLoadVersion: state.bulkLoadVersion + 1,
        ...(viewState
          ? { zoom: viewState.zoom, panX: viewState.panX, panY: viewState.panY }
          : {}),
      }
    })
    syncDiffToYDoc(before, get())
  },

  importCanvasData: (data, viewState) => {
    const binding = getYjsBinding()
    if (binding) {
      // In collaboration mode we replace the shared Y.Doc atomically and then
      // update the local store. suppressSync prevents setCanvasData from
      // re-diffing the same change back into the Y.Doc (the doc is already the
      // authoritative source of truth for this import).
      const written = binding.importIntoDoc(data)
      if (!written) return false
      binding.suppressSync(() => {
        get().setCanvasData(data, viewState)
      })
      return true
    }
    // Single-user mode: just replace local state and let the caller save.
    get().setCanvasData(data, viewState)
    return true
  },

  clearCanvas: () => {
    set((state) => ({
      nodes: new Map(),
      groups: new Map(),
      domains: new Map(),
      connections: new Map(),
      selectedIds: [],
      hoveredId: null,
      editingId: null,
      isDirty: false,
      // M5: 清空 undo/redo 历史——clearCanvas 用于切画布/删除画布等
      // 会话重置场景，残留的旧画布命令会让 redo 把上一张画布的节点
      // 写进新画布（store 349-353 的 addNode execute 无条件 nodes.set）。
      // setCanvasData 已有同等清理（1305-1309），这里补齐 clearCanvas 路径。
      history: {
        ...state.history,
        commands: [],
        currentIndex: -1,
      },
    }))
    // clearCanvas is a local state reset — it must NOT broadcast empty state
    // to peers. All callers use it before loading new canvas data or when
    // navigating away from a deleted canvas; in neither case should the empty
    // store propagate to the Y.Doc.
  },
}))
