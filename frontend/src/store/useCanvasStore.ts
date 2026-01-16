import { create } from 'zustand'
import type { Node, NodeGroup, Domain, Connection } from '@/types'
import { CANVAS_DEFAULTS } from '@/constants'

interface Command {
  type: string
  timestamp: number
  execute: () => Partial<CanvasState>
  undo: () => Partial<CanvasState>
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

  // History state
  history: HistoryState

  // Actions
  setCanvasId: (id: number | null) => void
  setCanvasName: (name: string | null) => void

  // Node actions
  addNode: (node: Node) => void
  updateNode: (id: string, updates: Partial<Node>) => void
  updateNodeWithoutHistory: (id: string, updates: Partial<Node>) => void
  removeNode: (id: string) => void
  duplicateNode: (id: string) => void

  // Group actions
  addGroup: (group: NodeGroup) => void
  updateGroup: (id: string, updates: Partial<NodeGroup>) => void
  updateGroupWithoutHistory: (id: string, updates: Partial<NodeGroup>) => void
  removeGroup: (id: string) => void

  // Domain actions
  addDomain: (domain: Domain) => void
  updateDomain: (id: string, updates: Partial<Domain>) => void
  removeDomain: (id: string) => void

  // Connection actions
  addConnection: (connection: Connection) => void
  updateConnection: (id: string, updates: Partial<Connection>) => void
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

  // Edit state
  setEditingId: (id: string | null) => void
  setHoveredId: (id: string | null) => void

  // Dirty state
  setDirty: (dirty: boolean) => void

  // Undo/Redo actions
  executeCommand: (command: Command) => void
  undo: () => void
  redo: () => void
  canUndo: () => boolean
  canRedo: () => boolean
  clearHistory: () => void

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
      return { ...acc, [key]: (node as any)[key] }
    }, {})

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

  updateNodeWithoutHistory: (id, updates) => {
    set((state) => {
      const currentNodes = new Map(state.nodes)
      const currentNode = currentNodes.get(id)
      if (currentNode) {
        currentNodes.set(id, { ...currentNode, ...updates })
        return { nodes: currentNodes, isDirty: true }
      }
      return {}
    })
  },

  removeNode: (id) => {
    const state = get()
    const node = state.nodes.get(id)
    if (!node) return

    const removedConnections: Connection[] = []
    for (const [_, conn] of state.connections) {
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
      return { ...acc, [key]: (group as any)[key] }
    }, {})

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

  updateGroupWithoutHistory: (id, updates) => {
    set((state) => {
      const groups = new Map(state.groups)
      const group = groups.get(id)
      if (group) {
        groups.set(id, { ...group, ...updates })
        return { groups, isDirty: true }
      }
      return {}
    })
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
      return { ...acc, [key]: (domain as any)[key] }
    }, {})

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
      return { ...acc, [key]: (connection as any)[key] }
    }, {})

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

  // Edit state
  setEditingId: (id) => set({ editingId: id }),
  setHoveredId: (id) => set({ hoveredId: id }),

  // Dirty state
  setDirty: (dirty) => {
    set({ isDirty: dirty })
  },

  // Undo/Redo actions
  executeCommand: (command) =>
    set((state) => {
      const newCommands = state.history.commands.slice(0, state.history.currentIndex + 1)

      // Remove old commands if exceeding max size
      if (newCommands.length >= state.history.maxHistorySize) {
        newCommands.shift()
      }

      // Remove commands older than max days
      const now = Date.now()
      const maxAge = state.history.maxHistoryDays * 24 * 60 * 60 * 1000
      while (newCommands.length > 0 && now - newCommands[0].timestamp > maxAge) {
        newCommands.shift()
      }

      newCommands.push(command)
      const commandResult = command.execute()

      return {
        ...commandResult,
        history: {
          ...state.history,
          commands: newCommands,
          currentIndex: newCommands.length - 1,
        },
        isDirty: true,
      }
    }),

  undo: () => {
    const state = get()
    if (!state.canUndo()) return

    const command = state.history.commands[state.history.currentIndex]
    const commandResult = command.undo()

    set((state) => ({
      ...commandResult,
      history: {
        ...state.history,
        currentIndex: state.history.currentIndex - 1,
      },
      isDirty: true,
    }))
  },

  redo: () => {
    const state = get()
    if (!state.canRedo()) return

    const command = state.history.commands[state.history.currentIndex + 1]
    const commandResult = command.execute()

    set((state) => ({
      ...commandResult,
      history: {
        ...state.history,
        currentIndex: state.history.currentIndex + 1,
      },
      isDirty: true,
    }))
  },

  canUndo: () => {
    const state = get()
    return state.history.currentIndex >= 0
  },

  canRedo: () => {
    const state = get()
    return state.history.currentIndex < state.history.commands.length - 1
  },

  clearHistory: () =>
    set((state) => ({
      history: {
        ...state.history,
        commands: [],
        currentIndex: -1,
      },
    })),

  // Bulk actions
  setCanvasData: (data) =>
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
        history: {
          ...state.history,
          commands: [],
          currentIndex: -1,
        },
      }
    }),

  clearCanvas: () =>
    set({
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
      isDirty: false,
    }),
}))
