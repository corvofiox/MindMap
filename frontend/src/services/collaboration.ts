import { useCanvasStore } from '@/store/useCanvasStore'
import { useAuthStore } from '@/store/useAuthStore'
import { getEditingState } from '@/hooks/useCollabEditing'
import { logger } from '@/utils/logger'
import type { Node, NodeGroup, Domain, Connection } from '@/types'
import type {
  FieldChange,
  PendingNodeChanges,
  PendingConnectionChanges,
  PendingGroupChanges,
  PendingDomainChanges,
  BatchOperations,
} from './collab-utils.js'
import {
  clearPendingForBatch,
  clearPendingForSingleOperation,
  clearPendingRemoves,
} from './collab-utils.js'

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
  clientVersion?: number
}

interface BatchCollabMessage {
  type: 'batch-operation'
  operations: Array<{
    operation: string
    data: unknown
  }>
  timestamp: number
  senderId: number
  seq: number
  clientVersion: number
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

/**
 * 将 BatchOperations 对象展开为有序操作数组。
 *
 * 顺序约定：add → update → remove（每种实体类型重复）。
 * 此顺序与后端 applyBatchOperations 的 for 循环处理顺序一致。
 * - 同时 add+remove：add 在前，结果正确（先创建再删除）
 * - 同时 add+update：add 在前，update 在后，确保新增节点拿到初始属性
 */
export function batchToOperations(batch: BatchOperations): Array<{ operation: string; data: unknown }> {
  const ops: Array<{ operation: string; data: unknown }> = []

  if (batch.addedNodes) {
    for (const node of batch.addedNodes) {
      ops.push({ operation: 'add-node', data: node })
    }
  }
  if (batch.updatedNodes) {
    for (const { id, updates } of batch.updatedNodes) {
      ops.push({ operation: 'update-node', data: { id, updates } })
    }
  }
  if (batch.removedNodeIds) {
    for (const id of batch.removedNodeIds) {
      ops.push({ operation: 'remove-node', data: { id } })
    }
  }
  if (batch.addedGroups) {
    for (const group of batch.addedGroups) {
      ops.push({ operation: 'add-group', data: group })
    }
  }
  if (batch.updatedGroups) {
    for (const { id, updates } of batch.updatedGroups) {
      ops.push({ operation: 'update-group', data: { id, updates } })
    }
  }
  if (batch.removedGroupIds) {
    for (const id of batch.removedGroupIds) {
      ops.push({ operation: 'remove-group', data: { id } })
    }
  }
  if (batch.addedDomains) {
    for (const domain of batch.addedDomains) {
      ops.push({ operation: 'add-domain', data: domain })
    }
  }
  if (batch.updatedDomains) {
    for (const { id, updates } of batch.updatedDomains) {
      ops.push({ operation: 'update-domain', data: { id, updates } })
    }
  }
  if (batch.removedDomainIds) {
    for (const id of batch.removedDomainIds) {
      ops.push({ operation: 'remove-domain', data: { id } })
    }
  }
  if (batch.addedConnections) {
    for (const conn of batch.addedConnections) {
      ops.push({ operation: 'add-connection', data: conn })
    }
  }
  if (batch.updatedConnections) {
    for (const { id, updates } of batch.updatedConnections) {
      ops.push({ operation: 'update-connection', data: { id, updates } })
    }
  }
  if (batch.removedConnectionIds) {
    for (const id of batch.removedConnectionIds) {
      ops.push({ operation: 'remove-connection', data: { id } })
    }
  }

  return ops
}

/**
 * 将离线队列中的单独操作转换为 BatchOperations 对象。
 * 支持展开嵌套的 batch-operation 条目（来自 ACK 超时回退）。
 */
export function queueToBatch(queue: QueuedOperation[]): BatchOperations {
  const addedNodes: Node[] = []
  const updatedNodes: { id: string; updates: Partial<Node> }[] = []
  const removedNodeIds: string[] = []
  const addedGroups: NodeGroup[] = []
  const updatedGroups: { id: string; updates: Partial<NodeGroup> }[] = []
  const removedGroupIds: string[] = []
  const addedDomains: Domain[] = []
  const updatedDomains: { id: string; updates: Partial<Domain> }[] = []
  const removedDomainIds: string[] = []
  const addedConnections: Connection[] = []
  const updatedConnections: { id: string; updates: Partial<Connection> }[] = []
  const removedConnectionIds: string[] = []

  for (const op of queue) {
    switch (op.operation) {
      case 'add-node':
        addedNodes.push(op.data as Node)
        break
      case 'update-node':
        updatedNodes.push(op.data as { id: string; updates: Partial<Node> })
        break
      case 'remove-node':
        removedNodeIds.push((op.data as { id: string }).id)
        break
      case 'add-group':
        addedGroups.push(op.data as NodeGroup)
        break
      case 'update-group':
        updatedGroups.push(op.data as { id: string; updates: Partial<NodeGroup> })
        break
      case 'remove-group':
        removedGroupIds.push((op.data as { id: string }).id)
        break
      case 'add-domain':
        addedDomains.push(op.data as Domain)
        break
      case 'update-domain':
        updatedDomains.push(op.data as { id: string; updates: Partial<Domain> })
        break
      case 'remove-domain':
        removedDomainIds.push((op.data as { id: string }).id)
        break
      case 'add-connection':
        addedConnections.push(op.data as Connection)
        break
      case 'update-connection':
        updatedConnections.push(op.data as { id: string; updates: Partial<Connection> })
        break
      case 'remove-connection':
        removedConnectionIds.push((op.data as { id: string }).id)
        break
      case 'batch-operation': {
        // 展开因 ACK 超时而落入离线队列的 batch，将其子操作归入对应数组
        const subOps = batchToOperations(op.data as BatchOperations)
        for (const sub of subOps) {
          switch (sub.operation) {
            case 'add-node':
              addedNodes.push(sub.data as Node)
              break
            case 'update-node':
              updatedNodes.push(sub.data as { id: string; updates: Partial<Node> })
              break
            case 'remove-node':
              removedNodeIds.push((sub.data as { id: string }).id)
              break
            case 'add-group':
              addedGroups.push(sub.data as NodeGroup)
              break
            case 'update-group':
              updatedGroups.push(sub.data as { id: string; updates: Partial<NodeGroup> })
              break
            case 'remove-group':
              removedGroupIds.push((sub.data as { id: string }).id)
              break
            case 'add-domain':
              addedDomains.push(sub.data as Domain)
              break
            case 'update-domain':
              updatedDomains.push(sub.data as { id: string; updates: Partial<Domain> })
              break
            case 'remove-domain':
              removedDomainIds.push((sub.data as { id: string }).id)
              break
            case 'add-connection':
              addedConnections.push(sub.data as Connection)
              break
            case 'update-connection':
              updatedConnections.push(sub.data as { id: string; updates: Partial<Connection> })
              break
            case 'remove-connection':
              removedConnectionIds.push((sub.data as { id: string }).id)
              break
          }
        }
        break
      }
    }
  }

  return {
    addedNodes: addedNodes.length > 0 ? addedNodes : undefined,
    updatedNodes: updatedNodes.length > 0 ? updatedNodes : undefined,
    removedNodeIds: removedNodeIds.length > 0 ? removedNodeIds : undefined,
    addedGroups: addedGroups.length > 0 ? addedGroups : undefined,
    updatedGroups: updatedGroups.length > 0 ? updatedGroups : undefined,
    removedGroupIds: removedGroupIds.length > 0 ? removedGroupIds : undefined,
    addedDomains: addedDomains.length > 0 ? addedDomains : undefined,
    updatedDomains: updatedDomains.length > 0 ? updatedDomains : undefined,
    removedDomainIds: removedDomainIds.length > 0 ? removedDomainIds : undefined,
    addedConnections: addedConnections.length > 0 ? addedConnections : undefined,
    updatedConnections: updatedConnections.length > 0 ? updatedConnections : undefined,
    removedConnectionIds: removedConnectionIds.length > 0 ? removedConnectionIds : undefined,
  }
}

class CollaborationService {
  private ws: WebSocket | null = null
  private canvasId: number | null = null
  private isIntentionallyClosed = false
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  // Exponential backoff with jitter to avoid a thundering-herd of reconnects
  // when many clients drop at once (e.g. server restart). The base delay
  // doubles on each failed attempt up to MAX_RECONNECT_DELAY_MS, and each
  // computed delay gets ±25% jitter so simultaneous disconnects spread out.
  private reconnectBaseDelay = 2000
  private readonly MAX_RECONNECT_DELAY_MS = 30000
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
  // Tab-unique session ID to prevent offline queue conflicts across tabs
  private sessionId: string

  // 操作确认机制：追踪已发送但未确认的操作
  private opSeq = 0
  private unackedOps = new Map<number, QueuedOperation>()
  private readonly ACK_TIMEOUT_MS = 5000
  private ackTimeoutId: ReturnType<typeof setTimeout> | null = null

  constructor() {
    this.sessionId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  }

  private getOfflineQueueKey(): string {
    return `collab_offline_queue_${this.canvasId}_${this.sessionId}`
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
  private pendingGroupChanges = new Map<string, PendingGroupChanges>()
  private pendingDomainChanges = new Map<string, PendingDomainChanges>()
  private pendingRemoves = {
    nodeIds: new Set<string>(),
    groupIds: new Set<string>(),
    domainIds: new Set<string>(),
    connectionIds: new Set<string>(),
  }
  isApplyingRemoteUpdate = false

  // Server version tracking
  private serverVersion = 0
  // Set when a sync-request is sent to the server, cleared when the matching
  // sync response lands (handleSync). While in flight, cleanupRecentChanges
  // must NOT drop pending entries — those changes are waiting to be replayed
  // against the fresh server state, and dropping them before the replay would
  // lose the edit permanently.
  private syncInFlight = false
  // User interaction protection - when user is actively interacting with canvas,
  // remote updates for the same element are deferred
  private activeUserInteractions = new Map<string, { field: string | null; startTime: number }>()
  private deferredOperations: Array<{ operation: string; data: unknown; timestamp: number }> = []
  private interactionCheckInterval: ReturnType<typeof setInterval> | null = null
  private cleanupInterval: ReturnType<typeof setInterval> | null = null
  private readonly INTERACTION_TIMEOUT_MS = 500

  connect(canvasId: number) {
    this.isDestroyed = false
    this.emptySyncRetryCount = 0

    const token = localStorage.getItem('mindmap_token')
    if (!token) {
      logger.error('No auth token found, cannot establish WebSocket connection')
      return
    }

    // Reset serverVersion when switching to a different canvas
    if (this.canvasId !== canvasId) {
      this.serverVersion = 0
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
        this.reconnectBaseDelay = 2000
        this.restoreOfflineQueue()
        this.requestSync()
        this.flushOfflineQueue()
        this.startInteractionCheckInterval()
        this.startCleanupInterval()
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

    // Exponential backoff capped at MAX_RECONNECT_DELAY_MS, with ±25% jitter
    // so that a fleet of clients disconnected by the same event (server
    // restart, network blip) don't all reconnect on the exact same tick and
    // stampede the server's sync-request path.
    const exponential = Math.min(
      this.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.MAX_RECONNECT_DELAY_MS,
    )
    const jitterFactor = 1 + (Math.random() * 0.5 - 0.25) // 0.75 .. 1.25
    const delay = Math.round(exponential * jitterFactor)

    this.reconnectTimeout = setTimeout(() => {
      this.connect(canvasId)
    }, delay)
  }

  private startCleanupInterval(): void {
    if (this.cleanupInterval) return
    this.cleanupInterval = setInterval(() => {
      this.cleanupRecentChanges()
    }, 10000)
  }

  private cleanupRecentChanges(): void {
    // Do NOT drop pending entries while we are waiting for either:
    //   (a) a sync response (syncInFlight) — those pending changes are about to
    //       be replayed against the fresh server state; dropping them now would
    //       lose the edit.
    //   (b) ACKs for in-flight operations (unackedOps.size > 0) — the server
    //       hasn't yet confirmed these edits; if a NAK comes back, the same
    //       replay path needs these pending entries intact.
    // In both cases, defer the cleanup to a later tick of this interval.
    if (this.syncInFlight || this.unackedOps.size > 0) {
      return
    }
    const cutoff = Date.now() - 30000
    for (const [id, change] of this.pendingNodeChanges) {
      if (change.changes.size === 0) {
        this.pendingNodeChanges.delete(id)
        continue
      }
      const latestTimestamp = Math.max(...Array.from(change.changes.values()).map(c => c.timestamp))
      if (latestTimestamp < cutoff) {
        this.pendingNodeChanges.delete(id)
      }
    }
    for (const [id, change] of this.pendingConnectionChanges) {
      if (change.changes.size === 0) {
        this.pendingConnectionChanges.delete(id)
        continue
      }
      const latestTimestamp = Math.max(...Array.from(change.changes.values()).map(c => c.timestamp))
      if (latestTimestamp < cutoff) {
        this.pendingConnectionChanges.delete(id)
      }
    }
    for (const [id, change] of this.pendingGroupChanges) {
      if (change.changes.size === 0) {
        this.pendingGroupChanges.delete(id)
        continue
      }
      const latestTimestamp = Math.max(...Array.from(change.changes.values()).map(c => c.timestamp))
      if (latestTimestamp < cutoff) {
        this.pendingGroupChanges.delete(id)
      }
    }
    for (const [id, change] of this.pendingDomainChanges) {
      if (change.changes.size === 0) {
        this.pendingDomainChanges.delete(id)
        continue
      }
      const latestTimestamp = Math.max(...Array.from(change.changes.values()).map(c => c.timestamp))
      if (latestTimestamp < cutoff) {
        this.pendingDomainChanges.delete(id)
      }
    }
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
    this.stopCleanupInterval()
    // Clear the sync-in-flight flag: the sync response will never arrive on a
    // closed socket, and a stuck flag would permanently disable pending cleanup.
    this.syncInFlight = false
    // Defensive reset of isApplyingRemoteUpdate. This can be reached from
    // both disconnect() and the ws.onclose handler; in the latter case the
    // normal try/finally in handleSync would have run, but a flag stuck
    // here would silently disable WS sending on the next connection.
    this.isApplyingRemoteUpdate = false

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
    this.emptySyncRetryCount = 0
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
    this.pendingGroupChanges.clear()
    this.pendingDomainChanges.clear()
    this.pendingRemoves.nodeIds.clear()
    this.pendingRemoves.groupIds.clear()
    this.pendingRemoves.domainIds.clear()
    this.pendingRemoves.connectionIds.clear()
    // Defensive reset: if a handleSync was interrupted before its
    // try/finally could clear the flag, the new connection would otherwise
    // skip echoing local changes back to the server.
    this.isApplyingRemoteUpdate = false
    this.syncInFlight = false
    // Preserve serverVersion to avoid 409 conflicts when saving via REST API
    // after disconnecting from collaboration mode
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
        case 'batch-operation':
          this.handleBatchOperation(message as BatchCollabMessage)
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
          if (message.persistError) {
            // Server failed to persist the latest in-memory state to DB after
            // exhausting its retries. Changes are still in server memory and
            // visible to collaborators, but if the server process crashes
            // before the next successful persist, those changes are lost.
            logger.warn('Server reported persist failure', {
              canvasId: this.canvasId,
              version: message.version,
              attempts: message.persistError.attempts,
              error: message.persistError.message,
            })
          }
          break
        case 'ack':
          this.handleAck(message.seq)
          break
        case 'nak':
          this.handleNak(message.seq, message.reason, message.serverVersion)
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

  private handleBatchOperation(message: BatchCollabMessage) {
    if (message.senderId === this.userId) return

    for (const op of message.operations) {
      const nodeId = this.extractNodeIdFromOperation(op.operation, op.data)
      if (nodeId && this.isNodeBeingInteractedWith(nodeId)) {
        this.deferredOperations.push({
          operation: op.operation,
          data: op.data,
          timestamp: message.timestamp,
        })
        continue
      }

      const handlers = this.operationHandlers.get(op.operation)
      if (handlers) {
        handlers.forEach(handler => handler(op.data))
      }
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

  private emptySyncRetryCount = 0
  private readonly MAX_EMPTY_SYNC_RETRIES = 3

  private handleSync(message: {
    nodes: Node[]
    groups: NodeGroup[]
    domains: Domain[]
    connections: Connection[]
    version: number
  }) {
    // The awaited sync has arrived — clear the in-flight flag so the cleanup
    // timer can resume dropping stale pending entries again.
    this.syncInFlight = false
    if (this.isDestroyed) return
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    const store = useCanvasStore.getState()

    // Guard against empty sync data that would wipe valid local state.
    // This can happen if the server's in-memory state was not yet loaded from DB
    // when the sync-request was processed (race condition in ensureCanvasState).
    // If local store has data but server returns version 0 with no entities,
    // skip this sync and request another one after a short delay.
    // Limit retries to prevent infinite loops for genuinely empty new canvases.
    const serverHasData = message.nodes.length > 0 || message.groups.length > 0 ||
      message.domains.length > 0 || message.connections.length > 0
    const localHasData = store.nodes.size > 0 || store.groups.size > 0 ||
      store.domains.size > 0 || store.connections.size > 0
    if (!serverHasData && localHasData && message.version === 0 && this.emptySyncRetryCount < this.MAX_EMPTY_SYNC_RETRIES) {
      this.emptySyncRetryCount++
      logger.warn('Received empty sync response while local state has data — retrying sync', {
        localNodes: store.nodes.size,
        serverVersion: message.version,
        retryCount: this.emptySyncRetryCount,
      })
      setTimeout(() => this.requestSync(), 500)
      return
    }
    // After max retries, if server STILL sends empty while local has data,
    // refuse to apply this sync — otherwise setCanvasData({nodes: []}) would
    // wipe the local state. Keep the local data and reset the counter so a
    // later (correct) sync can proceed.
    if (!serverHasData && localHasData && message.version === 0) {
      this.emptySyncRetryCount = 0
      logger.error('Server returned empty sync after max retries; preserving local data', {
        localNodes: store.nodes.size,
        localDomains: store.domains.size,
        localGroups: store.groups.size,
        localConnections: store.connections.size,
      })
      return
    }
    // Reset retry counter on successful sync
    this.emptySyncRetryCount = 0

    // Always trust server state during sync
    // But preserve nodes that user is currently editing
    const editingState = getEditingState()
    const editingNodeId = editingState.nodeId

    try {
      // Convert arrays to Maps
      const newNodes = new Map<string, Node>()
      for (const node of message.nodes) {
        // Preserve geometry of actively-dragged nodes to prevent visual
        // jumping during concurrent-drag NAK → sync cycles
        if (this.isNodeBeingInteractedWith(node.id)) {
          const localNode = store.nodes.get(node.id)
          if (localNode) {
            newNodes.set(node.id, {
              ...node,
              x: localNode.x,
              y: localNode.y,
              width: localNode.width,
              height: localNode.height,
            })
            continue
          }
        }
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

      const newGroups = new Map<string, NodeGroup>()
      for (const group of message.groups) {
        newGroups.set(group.id, group)
      }

      const newDomains = new Map<string, Domain>()
      for (const domain of message.domains) {
        newDomains.set(domain.id, domain)
      }

      const newConnections = new Map<string, Connection>()
      for (const conn of message.connections) {
        newConnections.set(conn.id, conn)
      }

      // Re-apply pending local changes for nodes
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

      // Re-apply pending local changes for groups
      for (const [groupId, pending] of this.pendingGroupChanges) {
        const serverGroup = newGroups.get(groupId)
        if (serverGroup) {
          for (const [field, change] of pending.changes) {
            (serverGroup as unknown as Record<string, unknown>)[field] = change.newValue
          }
        } else {
          const localGroup = store.groups.get(groupId)
          if (localGroup) {
            newGroups.set(groupId, { ...localGroup })
          }
        }
      }

      // Re-apply pending local changes for domains
      for (const [domainId, pending] of this.pendingDomainChanges) {
        const serverDomain = newDomains.get(domainId)
        if (serverDomain) {
          for (const [field, change] of pending.changes) {
            (serverDomain as unknown as Record<string, unknown>)[field] = change.newValue
          }
        } else {
          const localDomain = store.domains.get(domainId)
          if (localDomain) {
            newDomains.set(domainId, { ...localDomain })
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

      // [BUG 1 FIX] Preserve locally-added entities that are not yet on the server
      // This includes nodes/connections/groups/domains created via add-*
      // that were sent but not yet ACKed, or queued in offlineQueue
      for (const [nodeId, node] of store.nodes) {
        if (!newNodes.has(nodeId)) {
          newNodes.set(nodeId, { ...node })
        }
      }
      for (const [groupId, group] of store.groups) {
        if (!newGroups.has(groupId)) {
          newGroups.set(groupId, { ...group })
        }
      }
      for (const [domainId, domain] of store.domains) {
        if (!newDomains.has(domainId)) {
          newDomains.set(domainId, { ...domain })
        }
      }
      for (const [connId, conn] of store.connections) {
        if (!newConnections.has(connId)) {
          newConnections.set(connId, { ...conn })
        }
      }

      // Re-apply pending removes on top of merged server state so that
      // locally-deleted entities don't "resurrect" after a NAK→resync cycle
      for (const nodeId of this.pendingRemoves.nodeIds) {
        newNodes.delete(nodeId)
        for (const [connId, conn] of newConnections) {
          if (conn.fromNodeId === nodeId || conn.toNodeId === nodeId) {
            newConnections.delete(connId)
          }
        }
      }
      for (const groupId of this.pendingRemoves.groupIds) {
        newGroups.delete(groupId)
      }
      for (const domainId of this.pendingRemoves.domainIds) {
        newDomains.delete(domainId)
      }
      for (const connId of this.pendingRemoves.connectionIds) {
        newConnections.delete(connId)
      }

      // Snapshot pending changes for rebroadcast
      const pendingNodes = new Map(this.pendingNodeChanges)
      const pendingGroups = new Map(this.pendingGroupChanges)
      const pendingDomains = new Map(this.pendingDomainChanges)
      const pendingConns = new Map(this.pendingConnectionChanges)
      const pendingRemoveNodeIds = new Set(this.pendingRemoves.nodeIds)
      const pendingRemoveGroupIds = new Set(this.pendingRemoves.groupIds)
      const pendingRemoveDomainIds = new Set(this.pendingRemoves.domainIds)
      const pendingRemoveConnectionIds = new Set(this.pendingRemoves.connectionIds)

      this.isApplyingRemoteUpdate = true
      try {
        store.setCanvasData({
          nodes: Array.from(newNodes.values()),
          groups: Array.from(newGroups.values()),
          domains: Array.from(newDomains.values()),
          connections: Array.from(newConnections.values()),
        })
      } finally {
        this.isApplyingRemoteUpdate = false
      }

      // Update serverVersion BEFORE replay so replayed operations use the correct version
      this.serverVersion = message.version

      // Batch-replay pending changes as a single batch operation per entity
      const replyUpdatedNodes: { id: string; updates: Partial<{ id: string;[key: string]: unknown }> }[] = []
      const replyUpdatedGroups: { id: string; updates: Partial<{ id: string;[key: string]: unknown }> }[] = []
      const replyUpdatedDomains: { id: string; updates: Partial<{ id: string;[key: string]: unknown }> }[] = []
      const replyUpdatedConns: { id: string; updates: Partial<{ id: string;[key: string]: unknown }> }[] = []

      for (const [, pending] of pendingNodes) {
        const combinedUpdates: Record<string, unknown> = {}
        for (const [, change] of pending.changes) {
          combinedUpdates[change.field] = change.newValue
        }
        if (Object.keys(combinedUpdates).length > 0) {
          replyUpdatedNodes.push({ id: pending.nodeId, updates: combinedUpdates })
        }
      }
      for (const [, pending] of pendingGroups) {
        const combinedUpdates: Record<string, unknown> = {}
        for (const [, change] of pending.changes) {
          combinedUpdates[change.field] = change.newValue
        }
        if (Object.keys(combinedUpdates).length > 0) {
          replyUpdatedGroups.push({ id: pending.groupId, updates: combinedUpdates })
        }
      }
      for (const [, pending] of pendingDomains) {
        const combinedUpdates: Record<string, unknown> = {}
        for (const [, change] of pending.changes) {
          combinedUpdates[change.field] = change.newValue
        }
        if (Object.keys(combinedUpdates).length > 0) {
          replyUpdatedDomains.push({ id: pending.domainId, updates: combinedUpdates })
        }
      }
      for (const [, pending] of pendingConns) {
        const combinedUpdates: Record<string, unknown> = {}
        for (const [, change] of pending.changes) {
          combinedUpdates[change.field] = change.newValue
        }
        if (Object.keys(combinedUpdates).length > 0) {
          replyUpdatedConns.push({ id: pending.connectionId, updates: combinedUpdates })
        }
      }

      // 使用 sendBatch 将所有待回放变更合并为一条消息，避免版本冲突
      const replyUpdatedCount = replyUpdatedNodes.length + replyUpdatedGroups.length +
        replyUpdatedDomains.length + replyUpdatedConns.length
      const replyRemovedCount = pendingRemoveNodeIds.size + pendingRemoveGroupIds.size +
        pendingRemoveDomainIds.size + pendingRemoveConnectionIds.size
      if (replyUpdatedCount > 0 || replyRemovedCount > 0) {
        this.sendBatch({
          updatedNodes: replyUpdatedNodes.length > 0 ? replyUpdatedNodes : undefined,
          updatedGroups: replyUpdatedGroups.length > 0 ? replyUpdatedGroups : undefined,
          updatedDomains: replyUpdatedDomains.length > 0 ? replyUpdatedDomains : undefined,
          updatedConnections: replyUpdatedConns.length > 0 ? replyUpdatedConns : undefined,
          removedNodeIds: pendingRemoveNodeIds.size > 0 ? Array.from(pendingRemoveNodeIds) : undefined,
          removedGroupIds: pendingRemoveGroupIds.size > 0 ? Array.from(pendingRemoveGroupIds) : undefined,
          removedDomainIds: pendingRemoveDomainIds.size > 0 ? Array.from(pendingRemoveDomainIds) : undefined,
          removedConnectionIds: pendingRemoveConnectionIds.size > 0 ? Array.from(pendingRemoveConnectionIds) : undefined,
        })
      }
      // Do NOT clear pending*Changes here — the replay batch above will be
      // ACKed (or NAKed) on its own seq. We clear per-field on ACK so that
      // new local changes tracked AFTER the batch was sent are preserved.

      logger.info('Synced with server state', { version: message.version, nodes: message.nodes.length })
    } catch (error) {
      logger.error('Failed to handle sync', error)
    }
  }

  private handleAck(seq: number): void {
    const op = this.unackedOps.get(seq)
    if (op) {
      // ACK is the authoritative "server accepted this change" signal.
      // Prune the confirmed fields from pending*Changes using the same cutoff
      // rule as batches: only entries with timestamp <= op.timestamp are pruned,
      // so newer writes to the same field (made after this op was sent) survive.
      if (op.operation === 'batch-operation') {
        const batch = op.data as BatchOperations
        clearPendingForBatch(
          batch,
          op.timestamp,
          this.pendingNodeChanges,
          this.pendingGroupChanges,
          this.pendingDomainChanges,
          this.pendingConnectionChanges,
        )
        clearPendingRemoves(batch, this.pendingRemoves)
      } else {
        clearPendingForSingleOperation(
          op.operation,
          op.data,
          op.timestamp,
          this.pendingNodeChanges,
          this.pendingGroupChanges,
          this.pendingDomainChanges,
          this.pendingConnectionChanges,
        )
      }
    }
    this.unackedOps.delete(seq)
    if (this.unackedOps.size === 0 && this.ackTimeoutId) {
      clearTimeout(this.ackTimeoutId)
      this.ackTimeoutId = null
    }
  }

  private handleNak(seq: number, reason: string, serverVersion?: number): void {
    // 操作被服务器拒绝，从 unackedOps 移除（不再重试）
    // Note: we intentionally do NOT clear pending*Changes on NAK. On a
    // version-conflict, the upcoming sync will replay the pending changes
    // with the fresh server version. For other NAKs (unknown-id, etc.) the
    // merge path in handleSync will drop the orphan pending entries via
    // their normal cleanup, and the 30s cleanupRecentChanges is a safety net.
    this.unackedOps.delete(seq)
    if (this.unackedOps.size === 0 && this.ackTimeoutId) {
      clearTimeout(this.ackTimeoutId)
      this.ackTimeoutId = null
    }
    if (typeof serverVersion === 'number') {
      this.serverVersion = serverVersion
    }
    if (reason === 'version-conflict') {
      // 版本冲突：客户端状态落后于服务器，请求重新同步
      this.requestSync()
    }
    logger.warn('Operation rejected by server', { seq, reason, serverVersion })
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

  trackLocalGroupChange(groupId: string, field: string, newValue: unknown): void {
    let pending = this.pendingGroupChanges.get(groupId)
    if (!pending) {
      pending = {
        groupId,
        changes: new Map()
      }
      this.pendingGroupChanges.set(groupId, pending)
    }
    pending.changes.set(field, {
      field,
      newValue,
      timestamp: Date.now()
    })
  }

  trackLocalDomainChange(domainId: string, field: string, newValue: unknown): void {
    let pending = this.pendingDomainChanges.get(domainId)
    if (!pending) {
      pending = {
        domainId,
        changes: new Map()
      }
      this.pendingDomainChanges.set(domainId, pending)
    }
    pending.changes.set(field, {
      field,
      newValue,
      timestamp: Date.now()
    })
  }

  trackPendingRemove(entityType: 'node' | 'group' | 'domain' | 'connection', id: string): void {
    switch (entityType) {
      case 'node':
        this.pendingRemoves.nodeIds.add(id)
        break
      case 'group':
        this.pendingRemoves.groupIds.add(id)
        break
      case 'domain':
        this.pendingRemoves.domainIds.add(id)
        break
      case 'connection':
        this.pendingRemoves.connectionIds.add(id)
        break
    }
  }

  requestSync(): boolean {
    if (this.isDestroyed || this.isIntentionallyClosed) return false
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'sync-request' }))
      this.syncInFlight = true
      return true
    }
    return false
  }

  sendOperation(operation: string, data: unknown) {
    if (this.isDestroyed || this.isIntentionallyClosed) return

    // 追踪本地变更，确保 sync 待处理重放时不会丢失
    if (operation === 'update-node') {
      const d = data as { id: string; updates: Record<string, unknown> }
      if (d?.updates) {
        Object.keys(d.updates).forEach((field) => {
          this.trackLocalChange(d.id, field, d.updates[field])
        })
      }
    } else if (operation === 'update-group') {
      const d = data as { id: string; updates: Record<string, unknown> }
      if (d?.updates) {
        Object.keys(d.updates).forEach((field) => {
          this.trackLocalGroupChange(d.id, field, d.updates[field])
        })
      }
    } else if (operation === 'update-domain') {
      const d = data as { id: string; updates: Record<string, unknown> }
      if (d?.updates) {
        Object.keys(d.updates).forEach((field) => {
          this.trackLocalDomainChange(d.id, field, d.updates[field])
        })
      }
    } else if (operation === 'update-connection') {
      const d = data as { id: string; updates: Record<string, unknown> }
      if (d?.updates) {
        Object.keys(d.updates).forEach((field) => {
          this.trackLocalConnectionChange(d.id, field, d.updates[field])
        })
      }
    } else if (
      operation === 'remove-node' ||
      operation === 'remove-group' ||
      operation === 'remove-domain' ||
      operation === 'remove-connection'
    ) {
      // 单操作路径下追踪 remove：与 batch 路径（useCollaboration subscribe →
      // trackPendingRemove）对称。否则 NAK→resync 周期中 handleSync 不会
      // 重新应用删除，被删实体会从服务端最新状态"复活"。
      const d = data as { id: string }
      if (d?.id) {
        const entityType = operation.split('-')[1] as 'node' | 'group' | 'domain' | 'connection'
        this.trackPendingRemove(entityType, d.id)
      }
    }

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
      clientVersion: this.serverVersion,
    }

    // 追踪未确认操作
    this.unackedOps.set(seq, { operation, data, timestamp })
    this.scheduleAckTimeout()

    this.ws.send(JSON.stringify(message))
  }

  /**
   * 发送批量操作，所有操作共享同一个 clientVersion，
   * 避免循环发送单独操作时因服务端版本递增导致后续操作被 NAK 拒绝。
   */
  sendBatch(batch: BatchOperations) {
    if (this.isDestroyed || this.isIntentionallyClosed) return

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // 离线时保留 batch 结构，重连时 queueToBatch 可正确展开
      if (this.offlineQueue.length < this.maxQueueSize) {
        this.offlineQueue.push({
          operation: 'batch-operation',
          data: batch,
          timestamp: Date.now(),
        })
      }
      this.persistOfflineQueue()
      return
    }

    const timestamp = Date.now()
    const seq = ++this.opSeq
    const opEntries = batchToOperations(batch)

    if (opEntries.length === 0) return

    const message: BatchCollabMessage = {
      type: 'batch-operation',
      operations: opEntries,
      timestamp,
      senderId: this.userId || 0,
      seq,
      clientVersion: this.serverVersion,
    }

    this.unackedOps.set(seq, { operation: 'batch-operation', data: batch, timestamp })
    this.scheduleAckTimeout()

    this.ws.send(JSON.stringify(message))
  }

  private flushOfflineQueue() {
    if (this.offlineQueue.length === 0 || this.isFlushingQueue || this.isDestroyed || this.isIntentionallyClosed) return

    this.isFlushingQueue = true
    const queue = [...this.offlineQueue]
    this.offlineQueue = []

    try {
      if (this.isDestroyed || this.isIntentionallyClosed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.offlineQueue.unshift(...queue)
      } else {
        // 将离线队列中的操作合并为批量操作，避免版本冲突
        const batch = queueToBatch(queue)
        try {
          this.sendBatch(batch)
        } catch {
          // 如果发送失败，将操作放回队列
          this.offlineQueue.unshift(...queue)
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
