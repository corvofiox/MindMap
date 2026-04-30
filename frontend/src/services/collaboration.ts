import { useCanvasStore } from '@/store/useCanvasStore'
import { useAuthStore } from '@/store/useAuthStore'
import { getEditingState } from '@/hooks/useCollabEditing'
import { logger } from '@/utils/logger'
import type { Node, NodeGroup, Domain, Connection } from '@/types'

interface CollabUser {
  userId: number
  email: string
  nickname: string | null
  avatar: string | null
  role: 'owner' | 'editor' | 'viewer'
  joinedAt: number
}

interface CollabMessage {
  type: 'operation'
  operation: string
  data: unknown
  timestamp: number
  senderId: number
}

interface CursorData {
  userId: number
  x: number
  y: number
  userName?: string
  color?: string
}

type OperationHandler = (data: unknown) => void

interface QueuedOperation {
  operation: string
  data: unknown
  timestamp: number
}

export type OperationType = 'create' | 'update' | 'delete' | 'move' | 'resize' | 'style' | 'content' | 'state'

const DEFAULT_POSITION_WINDOW_MS = 2000
const DEFAULT_NODE_FIELD_WINDOW_MS = 3000

interface FieldChange {
  field: string
  oldValue: unknown
  newValue: unknown
  operationType: OperationType
  timestamp: number
}

interface PendingNodeChanges {
  nodeId: string
  baseVersion: number
  changes: Map<string, FieldChange>
}

interface PendingConnectionChanges {
  connectionId: string
  changes: Map<string, FieldChange>
}

class CollaborationService {
  private ws: WebSocket | null = null
  private canvasId: number | null = null
  private isIntentionallyClosed = false
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 2000
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null
  private cleanupInterval: ReturnType<typeof setInterval> | null = null
  private userId: number | null = null

  private users: CollabUser[] = []
  private cursors = new Map<number, CursorData>()
  private operationHandlers = new Map<string, OperationHandler[]>()
  private cursorListeners: ((cursors: Map<number, CursorData>) => void)[] = []
  private userListeners: ((users: CollabUser[]) => void)[] = []

  private offlineQueue: QueuedOperation[] = []
  private maxQueueSize = 100
  private isFlushingQueue = false
  private isDestroyed = false

  private pendingNodeChanges = new Map<string, PendingNodeChanges>()
  private pendingConnectionChanges = new Map<string, PendingConnectionChanges>()
  private isSyncing = false
  private recentPositionChanges = new Map<string, number>()
  private recentNodeUpdates = new Map<string, Map<string, number>>()

  // Server version tracking
  private serverVersion = 0
  private isAwaitingSync = false

  // User interaction protection - when user is actively interacting with canvas,
  // remote updates for the same element are deferred
  private activeUserInteractions = new Map<string, { field: string | null; startTime: number }>()
  private deferredOperations: Array<{ operation: string; data: unknown; timestamp: number }> = []
  private interactionCheckInterval: ReturnType<typeof setInterval> | null = null
  private readonly INTERACTION_TIMEOUT_MS = 500

  connect(canvasId: number) {
    if (this.isDestroyed) return

    const token = localStorage.getItem('mindmap_token')
    if (!token) {
      logger.error('No auth token found, cannot establish WebSocket connection')
      return
    }

    this.canvasId = canvasId
    this.isIntentionallyClosed = false
    this.cleanupWebSocket()

    const user = useAuthStore.getState().user
    this.userId = user?.id || null

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    const wsUrl = `${protocol}//${host}/ws?canvasId=${canvasId}&token=${encodeURIComponent(token)}`

    try {
      this.ws = new WebSocket(wsUrl)

      this.ws.onopen = () => {
        if (this.isDestroyed || this.isIntentionallyClosed) {
          this.cleanupWebSocket()
          return
        }
        this.reconnectAttempts = 0
        this.reconnectDelay = 2000
        this.requestSync()
        this.flushOfflineQueue()
        this.startCleanupInterval()
        this.startInteractionCheckInterval()
      }

      this.ws.onmessage = (event) => {
        if (!this.isDestroyed) {
          this.handleMessage(event.data)
        }
      }

      this.ws.onclose = () => {
        if (!this.isDestroyed && !this.isIntentionallyClosed && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.scheduleReconnect(canvasId)
        }
      }

      this.ws.onerror = () => {
        // WebSocket error - silently handle
      }
    } catch {
      if (!this.isDestroyed && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.scheduleReconnect(canvasId)
      }
    }
  }

  // User interaction protection API
  startInteraction(nodeId: string, field: string | null = null): void {
    this.activeUserInteractions.set(nodeId, { field, startTime: Date.now() })
  }

  endInteraction(nodeId: string): void {
    this.activeUserInteractions.delete(nodeId)
    // Process deferred operations for this node
    this.processDeferredOperations(nodeId)
  }

  private isNodeBeingInteractedWith(nodeId: string, field?: string): boolean {
    const interaction = this.activeUserInteractions.get(nodeId)
    if (!interaction) return false

    // Check if interaction has timed out
    if (Date.now() - interaction.startTime > this.INTERACTION_TIMEOUT_MS) {
      this.activeUserInteractions.delete(nodeId)
      return false
    }

    // If field is specified, only block if interacting with same field
    if (field && interaction.field && field !== interaction.field) {
      return false
    }

    return true
  }

  private startInteractionCheckInterval(): void {
    if (this.interactionCheckInterval) return
    this.interactionCheckInterval = setInterval(() => {
      const now = Date.now()
      for (const [nodeId, interaction] of this.activeUserInteractions) {
        if (now - interaction.startTime > this.INTERACTION_TIMEOUT_MS) {
          this.activeUserInteractions.delete(nodeId)
          this.processDeferredOperations(nodeId)
        }
      }
    }, this.INTERACTION_TIMEOUT_MS)
  }

  private stopInteractionCheckInterval(): void {
    if (this.interactionCheckInterval) {
      clearInterval(this.interactionCheckInterval)
      this.interactionCheckInterval = null
    }
  }

  private processDeferredOperations(nodeId: string): void {
    const remainingDeferred: Array<{ operation: string; data: unknown; timestamp: number }> = []

    for (const op of this.deferredOperations) {
      const opNodeId = this.extractNodeIdFromOperation(op.operation, op.data)
      if (opNodeId === nodeId && !this.isNodeBeingInteractedWith(nodeId)) {
        // Apply the deferred operation now
        const handlers = this.operationHandlers.get(op.operation)
        if (handlers) {
          handlers.forEach(handler => handler(op.data))
        }
      } else {
        remainingDeferred.push(op)
      }
    }

    this.deferredOperations = remainingDeferred
  }

  private extractNodeIdFromOperation(operation: string, data: unknown): string | null {
    if (!data || typeof data !== 'object') return null
    const d = data as Record<string, unknown>
    if ('id' in d && typeof d.id === 'string') return d.id
    if ('nodeId' in d && typeof d.nodeId === 'string') return d.nodeId
    return null
  }

  private scheduleReconnect(canvasId: number) {
    this.reconnectAttempts++

    this.reconnectTimeout = setTimeout(() => {
      this.connect(canvasId)
    }, this.reconnectDelay)
  }

  private startCleanupInterval(): void {
    if (this.cleanupInterval) return
    this.cleanupInterval = setInterval(() => {
      this.cleanupRecentChanges()
    }, 10000)
  }

  private stopCleanupInterval(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
  }

  private cleanupWebSocket() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
    this.stopCleanupInterval()
    this.stopInteractionCheckInterval()
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onclose = null
      this.ws.onerror = null
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close()
      }
      this.ws = null
    }
  }

  disconnect() {
    this.isIntentionallyClosed = true
    this.isDestroyed = true
    this.cleanupWebSocket()
    this.cursors.clear()
    this.users = []
    this.offlineQueue = []
    this.canvasId = null
    this.operationHandlers.clear()
    this.cursorListeners = []
    this.userListeners = []
    this.isFlushingQueue = false
    this.isSyncing = false
    this.pendingNodeChanges.clear()
    this.pendingConnectionChanges.clear()
    this.recentPositionChanges.clear()
    this.recentNodeUpdates.clear()
    this.serverVersion = 0
    this.isAwaitingSync = false
    this.activeUserInteractions.clear()
    this.deferredOperations = []
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  private handleMessage(data: string) {
    try {
      const message = JSON.parse(data)

      switch (message.type) {
        case 'operation':
          this.handleOperation(message as CollabMessage)
          break
        case 'cursor':
          this.handleCursor(message as CursorData)
          break
        case 'room-state':
          this.handleRoomState(message.users)
          break
        case 'user-join':
          this.handleUserJoin(message.user)
          break
        case 'user-leave':
          this.handleUserLeave(message.user)
          break
        case 'sync':
          this.handleSync(message)
          break
        case 'force-save':
          this.handleForceSave(message.projectId)
          break
      }
    } catch {
      // Failed to parse message - silently ignore
    }
  }

  private handleOperation(message: CollabMessage) {
    if (message.senderId === this.userId) return

    // Check if user is currently interacting with the affected node
    const nodeId = this.extractNodeIdFromOperation(message.operation, message.data)
    if (nodeId && this.isNodeBeingInteractedWith(nodeId)) {
      // Defer this operation until interaction ends
      this.deferredOperations.push({
        operation: message.operation,
        data: message.data,
        timestamp: message.timestamp,
      })
      return
    }

    const handlers = this.operationHandlers.get(message.operation)
    if (handlers) {
      handlers.forEach(handler => handler(message.data))
    }
  }

  private handleCursor(cursor: CursorData) {
    if (cursor.userId === this.userId) return

    this.cursors.set(cursor.userId, cursor)
    this.cursorListeners.forEach(listener => listener(new Map(this.cursors)))
  }

  private handleRoomState(users: CollabUser[]) {
    this.users = users
    this.userListeners.forEach(listener => listener(this.users))
  }

  private handleUserJoin(user: CollabUser) {
    if (!this.users.find(u => u.userId === user.userId)) {
      this.users.push(user)
      this.userListeners.forEach(listener => listener(this.users))
    }
  }

  private handleUserLeave(user: CollabUser) {
    this.users = this.users.filter(u => u.userId !== user.userId)
    this.cursors.delete(user.userId)
    this.userListeners.forEach(listener => listener(this.users))
    this.cursorListeners.forEach(listener => listener(new Map(this.cursors)))
  }

  private handleSync(message: {
    nodes: Node[]
    groups: NodeGroup[]
    domains: Domain[]
    connections: Connection[]
    version: number
  }) {
    if (this.isDestroyed) return
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    this.isAwaitingSync = false

    const store = useCanvasStore.getState()

    // Always trust server state during sync
    // But preserve nodes that user is currently editing
    const editingState = getEditingState()
    const editingNodeId = editingState.nodeId

    try {
      this.isSyncing = true

      // Convert arrays to Maps
      const newNodes = new Map<string, Node>()
      for (const node of message.nodes) {
        // If user is editing this node, preserve local content changes
        if (editingNodeId === node.id && (editingState.field === 'title' || editingState.field === 'content')) {
          const localNode = store.nodes.get(node.id)
          if (localNode) {
            newNodes.set(node.id, {
              ...node,
              [editingState.field]: localNode[editingState.field],
            })
            continue
          }
        }
        newNodes.set(node.id, node)
      }

      store.setCanvasData({
        nodes: Array.from(newNodes.values()),
        groups: message.groups,
        domains: message.domains,
        connections: message.connections,
      })

      this.serverVersion = message.version
      this.isSyncing = false

      logger.info('Synced with server state', { version: message.version, nodes: message.nodes.length })
    } catch (error) {
      this.isSyncing = false
      logger.error('Failed to handle sync', error)
    }
  }

  private handleForceSave(_projectId: number) {
    // Server now handles persistence automatically
    // This is just a notification, no action needed
    logger.info('Received force-save notification')
  }

  trackLocalConnectionChange(connectionId: string, field: string, oldValue: unknown, newValue: unknown, operationType: OperationType): void {
    if (this.isSyncing) return

    let pending = this.pendingConnectionChanges.get(connectionId)

    if (!pending) {
      pending = {
        connectionId,
        changes: new Map()
      }
      this.pendingConnectionChanges.set(connectionId, pending)
    }

    pending.changes.set(field, {
      field,
      oldValue,
      newValue,
      operationType,
      timestamp: Date.now()
    })
  }

  trackLocalChange(nodeId: string, field: string, oldValue: unknown, newValue: unknown, operationType: OperationType): void {
    if (this.isSyncing) return

    let pending = this.pendingNodeChanges.get(nodeId)

    if (!pending) {
      const store = useCanvasStore.getState()
      const node = store.nodes.get(nodeId)
      pending = {
        nodeId,
        baseVersion: node?._version || 0,
        changes: new Map()
      }
      this.pendingNodeChanges.set(nodeId, pending)
    }

    pending.changes.set(field, {
      field,
      oldValue,
      newValue,
      operationType,
      timestamp: Date.now()
    })
  }

  clearPendingChanges(nodeId: string): void {
    this.pendingNodeChanges.delete(nodeId)
    this.pendingConnectionChanges.delete(nodeId)
  }

  trackPositionChange(nodeId: string): void {
    this.recentPositionChanges.set(nodeId, Date.now())
  }

  isRecentPositionChange(nodeId: string, windowMs: number = DEFAULT_POSITION_WINDOW_MS): boolean {
    const timestamp = this.recentPositionChanges.get(nodeId)
    if (!timestamp) return false
    return Date.now() - timestamp < windowMs
  }

  trackNodeFieldUpdate(nodeId: string, field: string): void {
    let fields = this.recentNodeUpdates.get(nodeId)
    if (!fields) {
      fields = new Map()
      this.recentNodeUpdates.set(nodeId, fields)
    }
    fields.set(field, Date.now())
  }

  isRecentNodeFieldUpdate(nodeId: string, field: string, windowMs: number = DEFAULT_NODE_FIELD_WINDOW_MS): boolean {
    const fields = this.recentNodeUpdates.get(nodeId)
    if (!fields) return false
    const timestamp = fields.get(field)
    if (!timestamp) return false
    return Date.now() - timestamp < windowMs
  }

  private cleanupRecentChanges(): void {
    const now = Date.now()
    const maxAge = Math.max(DEFAULT_POSITION_WINDOW_MS, DEFAULT_NODE_FIELD_WINDOW_MS)
    for (const [nodeId, timestamp] of this.recentPositionChanges) {
      if (now - timestamp > maxAge) {
        this.recentPositionChanges.delete(nodeId)
      }
    }
    for (const [nodeId, fields] of this.recentNodeUpdates) {
      for (const [field, timestamp] of fields) {
        if (now - timestamp > maxAge) {
          fields.delete(field)
        }
      }
      if (fields.size === 0) {
        this.recentNodeUpdates.delete(nodeId)
      }
    }
  }

  private requestSync() {
    if (this.isDestroyed || this.isIntentionallyClosed) return
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.isAwaitingSync = true
      this.ws.send(JSON.stringify({ type: 'sync-request' }))
    }
  }

  sendOperation(operation: string, data: unknown) {
    if (this.isDestroyed || this.isIntentionallyClosed) return

    const timestamp = Date.now()

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this.offlineQueue.length < this.maxQueueSize) {
        this.offlineQueue.push({ operation, data, timestamp })
      }
      return
    }

    const message: CollabMessage = {
      type: 'operation',
      operation,
      data,
      timestamp,
      senderId: this.userId || 0
    }

    this.ws.send(JSON.stringify(message))
  }

  private flushOfflineQueue() {
    if (this.offlineQueue.length === 0 || this.isFlushingQueue || this.isDestroyed || this.isIntentionallyClosed) return

    this.isFlushingQueue = true
    const queue = [...this.offlineQueue]
    this.offlineQueue = []

    try {
      for (const item of queue) {
        if (this.isDestroyed || this.isIntentionallyClosed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
          this.offlineQueue.unshift(...queue.slice(queue.indexOf(item)))
          break
        }
        this.sendOperation(item.operation, item.data)
      }
    } finally {
      this.isFlushingQueue = false
    }
  }

  sendCursor(x: number, y: number) {
    if (this.isDestroyed || this.isIntentionallyClosed) return
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    this.ws.send(JSON.stringify({
      type: 'cursor',
      userId: this.userId,
      x,
      y
    }))
  }

  onOperation(operation: string, handler: OperationHandler) {
    if (!this.operationHandlers.has(operation)) {
      this.operationHandlers.set(operation, [])
    }
    this.operationHandlers.get(operation)!.push(handler)
  }

  offOperation(operation: string, handler: OperationHandler) {
    const handlers = this.operationHandlers.get(operation)
    if (handlers) {
      const index = handlers.indexOf(handler)
      if (index > -1) {
        handlers.splice(index, 1)
      }
    }
  }

  onCursorChange(listener: (cursors: Map<number, CursorData>) => void) {
    this.cursorListeners.push(listener)
    listener(new Map(this.cursors))
  }

  offCursorChange(listener: (cursors: Map<number, CursorData>) => void) {
    const index = this.cursorListeners.indexOf(listener)
    if (index > -1) {
      this.cursorListeners.splice(index, 1)
    }
  }

  onUserChange(listener: (users: CollabUser[]) => void) {
    this.userListeners.push(listener)
    listener(this.users)
  }

  offUserChange(listener: (users: CollabUser[]) => void) {
    const index = this.userListeners.indexOf(listener)
    if (index > -1) {
      this.userListeners.splice(index, 1)
    }
  }

  getActiveUsers(): CollabUser[] {
    return this.users
  }

  getCursors(): Map<number, CursorData> {
    return new Map(this.cursors)
  }

  getServerVersion(): number {
    return this.serverVersion
  }
}

export const collabService = new CollaborationService()
export type { CollabUser, CursorData }
