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
  seq?: number
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

interface FieldChange {
  field: string
  newValue: unknown
  timestamp: number
}

interface PendingNodeChanges {
  nodeId: string
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

  // 操作确认机制：追踪已发送但未确认的操作
  private opSeq = 0
  private unackedOps = new Map<number, QueuedOperation>()
  private readonly ACK_TIMEOUT_MS = 5000
  private ackTimeoutId: ReturnType<typeof setTimeout> | null = null

  private getOfflineQueueKey(): string {
    return `collab_offline_queue_${this.canvasId}`
  }

  private persistOfflineQueue(): void {
    if (!this.canvasId) return
    try {
      if (this.offlineQueue.length > 0) {
        localStorage.setItem(this.getOfflineQueueKey(), JSON.stringify(this.offlineQueue))
      } else {
        localStorage.removeItem(this.getOfflineQueueKey())
      }
    } catch (e) {
      logger.warn('Failed to persist offline queue to localStorage', e)
    }
  }

  private restoreOfflineQueue(): void {
    if (!this.canvasId) return
    try {
      const stored = localStorage.getItem(this.getOfflineQueueKey())
      if (stored) {
        const restored: unknown = JSON.parse(stored)
        if (Array.isArray(restored)) {
          this.offlineQueue = restored as QueuedOperation[]
        }
      }
    } catch (e) {
      logger.warn('Failed to restore offline queue from localStorage', e)
      localStorage.removeItem(this.getOfflineQueueKey())
    }
  }

  private pendingNodeChanges = new Map<string, PendingNodeChanges>()
  private pendingConnectionChanges = new Map<string, PendingConnectionChanges>()
  isApplyingRemoteUpdate = false

  // Server version tracking
  private serverVersion = 0
  // User interaction protection - when user is actively interacting with canvas,
  // remote updates for the same element are deferred
  private activeUserInteractions = new Map<string, { field: string | null; startTime: number }>()
  private deferredOperations: Array<{ operation: string; data: unknown; timestamp: number }> = []
  private interactionCheckInterval: ReturnType<typeof setInterval> | null = null
  private readonly INTERACTION_TIMEOUT_MS = 500

  connect(canvasId: number) {
    this.isDestroyed = false

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
        this.restoreOfflineQueue()
        this.requestSync()
        this.flushOfflineQueue()
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

      this.ws.onerror = (_event) => {
        logger.warn('WebSocket connection error', { canvasId: this.canvasId })
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
    this.stopInteractionCheckInterval()

    // 将未确认的操作移入离线队列，以便重连时刷新
    if (this.unackedOps.size > 0) {
      const moved: number[] = []
      for (const [seq, op] of this.unackedOps) {
        if (this.offlineQueue.length < this.maxQueueSize) {
          this.offlineQueue.push(op)
          moved.push(seq)
        } else {
          logger.warn('Offline queue full, unacked operation dropped', { seq, operation: op.operation })
        }
      }
      for (const seq of moved) {
        this.unackedOps.delete(seq)
      }
      this.persistOfflineQueue()
    }
    if (this.ackTimeoutId) {
      clearTimeout(this.ackTimeoutId)
      this.ackTimeoutId = null
    }

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
    this.pendingNodeChanges.clear()
    this.pendingConnectionChanges.clear()
    this.serverVersion = 0
    this.activeUserInteractions.clear()
    this.deferredOperations = []
    this.unackedOps.clear()
    if (this.ackTimeoutId) {
      clearTimeout(this.ackTimeoutId)
      this.ackTimeoutId = null
    }
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
        case 'version-update':
          this.serverVersion = message.version
          break
        case 'ack':
          this.handleAck(message.seq)
          break
      }
    } catch {
      // Failed to parse message - silently ignore
    }
  }

  private handleOperation(message: CollabMessage) {
    if (message.senderId === this.userId) return
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

    const store = useCanvasStore.getState()

    // Always trust server state during sync
    // But preserve nodes that user is currently editing
    const editingState = getEditingState()
    const editingNodeId = editingState.nodeId

    try {
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

      // Convert connections array to Map
      const newConnections = new Map<string, Connection>()
      for (const conn of message.connections) {
        newConnections.set(conn.id, conn)
      }

      // Re-apply only the specific fields with pending local changes,
      // instead of overwriting the entire node (which would lose remote updates)
      for (const [nodeId, pending] of this.pendingNodeChanges) {
        const serverNode = newNodes.get(nodeId)
        if (serverNode) {
          for (const [field, change] of pending.changes) {
            (serverNode as unknown as Record<string, unknown>)[field] = change.newValue
          }
        } else {
          const localNode = store.nodes.get(nodeId)
          if (localNode) {
            newNodes.set(nodeId, { ...localNode })
          }
        }
      }

      // Re-apply pending connection changes
      for (const [connectionId, pending] of this.pendingConnectionChanges) {
        const serverConn = newConnections.get(connectionId)
        if (serverConn) {
          for (const [field, change] of pending.changes) {
            (serverConn as unknown as Record<string, unknown>)[field] = change.newValue
          }
        } else {
          const localConn = store.connections.get(connectionId)
          if (localConn) {
            newConnections.set(connectionId, { ...localConn })
          }
        }
      }

      // Rebroadcast pending changes to room before clearing
      const pendingNodes = new Map(this.pendingNodeChanges)
      const pendingConns = new Map(this.pendingConnectionChanges)

      this.isApplyingRemoteUpdate = true
      try {
        store.setCanvasData({
          nodes: Array.from(newNodes.values()),
          groups: message.groups,
          domains: message.domains,
          connections: Array.from(newConnections.values()),
        })
      } finally {
        this.isApplyingRemoteUpdate = false
      }

      // 将 pending 变更批量回放：每个节点/连接的所有字段合并为单次 sendOperation
      // 避免逐字段回放导致服务端版本号人为膨胀
      for (const [, pending] of pendingNodes) {
        const combinedUpdates: Record<string, unknown> = {}
        for (const [, change] of pending.changes) {
          combinedUpdates[change.field] = change.newValue
        }
        if (Object.keys(combinedUpdates).length > 0) {
          this.sendOperation('update-node', { id: pending.nodeId, updates: combinedUpdates })
        }
      }
      for (const [, pending] of pendingConns) {
        const combinedUpdates: Record<string, unknown> = {}
        for (const [, change] of pending.changes) {
          combinedUpdates[change.field] = change.newValue
        }
        if (Object.keys(combinedUpdates).length > 0) {
          this.sendOperation('update-connection', { id: pending.connectionId, updates: combinedUpdates })
        }
      }
      this.pendingNodeChanges.clear()
      this.pendingConnectionChanges.clear()

      this.serverVersion = message.version

      logger.info('Synced with server state', { version: message.version, nodes: message.nodes.length })
    } catch (error) {
      logger.error('Failed to handle sync', error)
    }
  }

  private handleAck(seq: number): void {
    this.unackedOps.delete(seq)
    if (this.unackedOps.size === 0 && this.ackTimeoutId) {
      clearTimeout(this.ackTimeoutId)
      this.ackTimeoutId = null
    }
  }

  private scheduleAckTimeout(): void {
    if (this.ackTimeoutId) return
    this.ackTimeoutId = setTimeout(() => {
      this.ackTimeoutId = null
      if (this.unackedOps.size > 0) {
        // 超时未确认的操作移入离线队列，等待重连时刷新
        const moved: number[] = []
        for (const [seq, op] of this.unackedOps) {
          if (this.offlineQueue.length < this.maxQueueSize) {
            this.offlineQueue.push(op)
            moved.push(seq)
          } else {
            logger.warn('ACK timeout: offline queue full, operation dropped', { seq, operation: op.operation })
          }
        }
        for (const seq of moved) {
          this.unackedOps.delete(seq)
        }
        this.persistOfflineQueue()
        logger.warn('Operation ACK timeout, moved to offline queue', { count: moved.length })
      }
    }, this.ACK_TIMEOUT_MS)
  }

  trackLocalConnectionChange(connectionId: string, field: string, newValue: unknown): void {

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
      newValue,
      timestamp: Date.now()
    })
  }

  trackLocalChange(nodeId: string, field: string, newValue: unknown): void {

    let pending = this.pendingNodeChanges.get(nodeId)

    if (!pending) {
      pending = {
        nodeId,
        changes: new Map()
      }
      this.pendingNodeChanges.set(nodeId, pending)
    }

    pending.changes.set(field, {
      field,
      newValue,
      timestamp: Date.now()
    })
  }

  requestSync(): boolean {
    if (this.isDestroyed || this.isIntentionallyClosed) return false
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'sync-request' }))
      return true
    }
    return false
  }

  sendOperation(operation: string, data: unknown) {
    if (this.isDestroyed || this.isIntentionallyClosed) return

    const timestamp = Date.now()
    const seq = ++this.opSeq

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this.offlineQueue.length < this.maxQueueSize) {
        this.offlineQueue.push({ operation, data, timestamp })
        this.persistOfflineQueue()
      }
      return
    }

    const message: CollabMessage = {
      type: 'operation',
      operation,
      data,
      timestamp,
      senderId: this.userId || 0,
      seq,
    }

    // 追踪未确认操作
    this.unackedOps.set(seq, { operation, data, timestamp })
    this.scheduleAckTimeout()

    this.ws.send(JSON.stringify(message))
  }

  private flushOfflineQueue() {
    if (this.offlineQueue.length === 0 || this.isFlushingQueue || this.isDestroyed || this.isIntentionallyClosed) return

    this.isFlushingQueue = true
    const queue = [...this.offlineQueue]
    this.offlineQueue = []

    try {
      for (let i = 0; i < queue.length; i++) {
        if (this.isDestroyed || this.isIntentionallyClosed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
          this.offlineQueue.unshift(...queue.slice(i))
          break
        }
        try {
          this.sendOperation(queue[i].operation, queue[i].data)
        } catch {
          // If send fails, put remaining items back in queue
          this.offlineQueue.unshift(...queue.slice(i))
          break
        }
      }
    } finally {
      this.isFlushingQueue = false
      this.persistOfflineQueue()
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

  setServerVersion(version: number): void {
    this.serverVersion = version
  }
}

export const collabService = new CollaborationService()
export type { CollabUser, CursorData }
