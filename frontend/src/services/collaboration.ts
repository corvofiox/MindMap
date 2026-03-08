import { useCanvasStore } from '@/store/useCanvasStore'
import { useAuthStore } from '@/store/useAuthStore'
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

  connect(canvasId: number) {
    const token = localStorage.getItem('mindmap_token')
    if (!token) return

    this.canvasId = canvasId
    this.isIntentionallyClosed = false
    this.disconnect()

    const user = useAuthStore.getState().user
    this.userId = user?.id || null

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    const wsUrl = `${protocol}//${host}/ws?canvasId=${canvasId}&token=${encodeURIComponent(token)}`

    try {
      this.ws = new WebSocket(wsUrl)

      this.ws.onopen = () => {
        this.reconnectAttempts = 0
        this.reconnectDelay = 2000
        this.requestSync()
        this.flushOfflineQueue()
      }

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data)
      }

      this.ws.onclose = () => {
        if (!this.isIntentionallyClosed && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.scheduleReconnect(canvasId)
        }
      }

      this.ws.onerror = () => {
        // WebSocket error - silently handle
      }
    } catch {
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.scheduleReconnect(canvasId)
      }
    }
  }

  private scheduleReconnect(canvasId: number) {
    this.reconnectAttempts++

    this.reconnectTimeout = setTimeout(() => {
      this.connect(canvasId)
    }, this.reconnectDelay)
  }

  disconnect() {
    this.isIntentionallyClosed = true
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.cursors.clear()
    this.users = []
    this.offlineQueue = []
    this.canvasId = null
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
      }
    } catch {
      // Failed to parse message - silently ignore
    }
  }

  private handleOperation(message: CollabMessage) {
    if (message.senderId === this.userId) return

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

  private handleSync(message: { nodes: Node[]; groups: NodeGroup[]; domains: Domain[]; connections: Connection[] }) {
    const store = useCanvasStore.getState()

    // Check if we already have data loaded
    const hasLocalData = store.nodes.size > 0 || store.groups.size > 0 || store.domains.size > 0 || store.connections.size > 0
    const hasRemoteData = message.nodes.length > 0 || message.groups.length > 0 || message.domains.length > 0 || message.connections.length > 0

    // If we have local data but remote is empty, don't overwrite
    // This can happen when:
    // 1. We just loaded data from DB/API
    // 2. WebSocket connects and sends sync-request
    // 3. Server returns empty data (e.g., data not yet saved to DB)
    if (hasLocalData && !hasRemoteData) {
      return
    }

    // If both have data, we need to merge (for now, prefer the one with more nodes)
    if (hasLocalData && hasRemoteData) {
      if (store.nodes.size >= message.nodes.length) {
        return
      }
    }

    store.setCanvasData({
      nodes: message.nodes,
      groups: message.groups,
      domains: message.domains,
      connections: message.connections
    })
  }

  private requestSync() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'sync-request' }))
    }
  }

  sendOperation(operation: string, data: unknown) {
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
    if (this.offlineQueue.length === 0) return

    const queue = [...this.offlineQueue]
    this.offlineQueue = []

    for (const item of queue) {
      this.sendOperation(item.operation, item.data)
    }
  }

  sendCursor(x: number, y: number) {
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
}

export const collabService = new CollaborationService()
export type { CollabUser, CursorData }
