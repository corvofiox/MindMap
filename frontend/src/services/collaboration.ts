import { useCanvasStore } from '@/store/useCanvasStore'
import { useAuthStore } from '@/store/useAuthStore'
import { getEditingState } from '@/hooks/useCollabEditing'
import { logger } from '@/utils/logger'
import { saveCanvasNodesData } from '@/services/api'
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

interface ConflictResolutionResult {
  value: unknown
  strategy: 'local' | 'remote' | 'merged' | 'conflict'
  reason: string
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
  private lastSyncedVersions = new Map<string, number>()
  private isSyncing = false
  private conflictResolutionLog: ConflictResolutionResult[] = []
  private recentPositionChanges = new Map<string, number>()
  private recentNodeUpdates = new Map<string, Map<string, number>>()

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
    if (this.canvasId && !this.isDestroyed) {
      this.saveCurrentCanvasData()
    }

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
    this.lastSyncedVersions.clear()
    this.conflictResolutionLog = []
    this.recentPositionChanges.clear()
    this.recentNodeUpdates.clear()
  }

  private async saveCurrentCanvasData() {
    if (!this.canvasId) return

    try {
      const syncedData = await this.syncBeforeSave()
      if (!syncedData) return

      await saveCanvasNodesData(this.canvasId, {
        nodes: syncedData.nodes,
        groups: syncedData.groups,
        domains: syncedData.domains,
        connections: syncedData.connections,
      })
      logger.info('Collaboration data merged and saved')
    } catch (error) {
      logger.error('Failed to save collaboration data', error)
    }
  }

  private async handleForceSave(projectId: number) {
    logger.info('Received force-save notification for project', projectId)
    await this.saveCurrentCanvasData()
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
    if (this.isDestroyed) return
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    const store = useCanvasStore.getState()

    const hasLocalData = store.nodes.size > 0 || store.groups.size > 0 || store.domains.size > 0 || store.connections.size > 0
    const hasRemoteData = message.nodes.length > 0 || message.groups.length > 0 || message.domains.length > 0 || message.connections.length > 0

    if (hasLocalData && !hasRemoteData) {
      this.saveCurrentCanvasData()
      return
    }

    try {
      if (hasLocalData && hasRemoteData) {
        const mergedNodes = this.mergeNodes(
          Array.from(store.nodes.values()),
          message.nodes
        )
        const mergedGroups = this.mergeEntityMaps(
          Array.from(store.groups.values()),
          message.groups,
          (g) => g.id,
          (g) => g.name
        )
        const mergedDomains = this.mergeEntityMaps(
          Array.from(store.domains.values()),
          message.domains,
          (d) => d.id,
          (d) => d.name
        )
        const mergedConnections = this.mergeConnectionsWithVersion(
          Array.from(store.connections.values()),
          message.connections
        )

        this.isSyncing = true
        store.setCanvasData({
          nodes: mergedNodes,
          groups: mergedGroups,
          domains: mergedDomains,
          connections: mergedConnections
        })
        this.isSyncing = false
        return
      }

      message.nodes.forEach(node => {
        this.lastSyncedVersions.set(node.id, node._version || 0)
      })

      this.isSyncing = true
      store.setCanvasData({
        nodes: message.nodes,
        groups: message.groups,
        domains: message.domains,
        connections: message.connections
      })
      this.isSyncing = false
    } catch {
      this.isSyncing = true
      store.setCanvasData({
        nodes: message.nodes,
        groups: message.groups,
        domains: message.domains,
        connections: message.connections
      })
      this.isSyncing = false
    }
  }

  private mergeEntityMaps<T>(
    local: T[],
    remote: T[],
    getId: (item: T) => string,
    getTimestamp: (item: T) => number | string | undefined
  ): T[] {
    const merged = new Map<string, T>()

    local.forEach((item) => {
      merged.set(getId(item), item)
    })

    remote.forEach((remoteItem) => {
      const id = getId(remoteItem)
      const localItem = merged.get(id)

      if (!localItem) {
        merged.set(id, remoteItem)
      } else {
        const localTime = getTimestamp(localItem)
        const remoteTime = getTimestamp(remoteItem)

        const localMs = typeof localTime === 'string' ? new Date(localTime).getTime() : localTime || 0
        const remoteMs = typeof remoteTime === 'string' ? new Date(remoteTime).getTime() : remoteTime || 0

        if (remoteMs > localMs) {
          merged.set(id, remoteItem)
        }
      }
    })

    return Array.from(merged.values())
  }

  private mergeNodes(localNodes: Node[], remoteNodes: Node[]): Node[] {
    const merged = new Map<string, Node>()

    localNodes.forEach((node) => {
      merged.set(node.id, node)
    })

    remoteNodes.forEach((remoteNode) => {
      const id = remoteNode.id
      const localNode = merged.get(id)

      if (!localNode) {
        merged.set(id, remoteNode)
        this.lastSyncedVersions.set(id, remoteNode._version || 0)
        return
      }

      const localVersion = localNode._version || 0
      const remoteVersion = remoteNode._version || 0
      const lastSyncedVersion = this.lastSyncedVersions.get(id) || 0

      const hasLocalPendingChanges = this.hasPendingChanges(id)
      const conflictType = this.detectConflictType(localVersion, remoteVersion, lastSyncedVersion, hasLocalPendingChanges)

      const mergedNode = this.resolveNodeConflict(localNode, remoteNode, conflictType, lastSyncedVersion)
      merged.set(id, mergedNode)

      this.lastSyncedVersions.set(id, remoteVersion)
    })

    return Array.from(merged.values())
  }

  private detectConflictType(
    localVersion: number,
    remoteVersion: number,
    lastSyncedVersion: number,
    hasLocalPendingChanges: boolean
  ): 'no_conflict' | 'sequential_remote' | 'sequential_local' | 'concurrent' | 'diverged' {
    if (remoteVersion === localVersion && localVersion === lastSyncedVersion) {
      if (hasLocalPendingChanges) {
        return 'concurrent'
      }
      return 'no_conflict'
    }

    if (remoteVersion > localVersion) {
      if (localVersion > lastSyncedVersion && hasLocalPendingChanges) {
        return 'diverged'
      }
      if (!hasLocalPendingChanges) {
        return 'sequential_remote'
      }
      return 'diverged'
    }

    if (localVersion > remoteVersion && remoteVersion === lastSyncedVersion) {
      return 'sequential_local'
    }

    if (remoteVersion === localVersion && hasLocalPendingChanges) {
      return 'concurrent'
    }

    if (remoteVersion > lastSyncedVersion && localVersion > lastSyncedVersion && remoteVersion !== localVersion) {
      return 'diverged'
    }

    return 'no_conflict'
  }

  private resolveNodeConflict(
    local: Node,
    remote: Node,
    conflictType: 'no_conflict' | 'sequential_remote' | 'sequential_local' | 'concurrent' | 'diverged',
    lastSyncedVersion: number
  ): Node {
    let result: Node

    switch (conflictType) {
      case 'no_conflict':
        result = { ...remote }
        break

      case 'sequential_remote':
        result = { ...remote }
        break

      case 'sequential_local':
        result = { ...local }
        break

      case 'concurrent':
      case 'diverged':
        return this.mergeNodeFieldsWithConflictResolution(local, remote, lastSyncedVersion, conflictType === 'diverged')

      default:
        result = { ...remote }
    }

    result._version = Math.max(local._version || 0, remote._version || 0) + 1
    return result
  }

  private mergeNodeFieldsWithConflictResolution(
    local: Node,
    remote: Node,
    lastSyncedVersion: number,
    isDiverged: boolean
  ): Node {
    const result: Node = { ...local }
    const pendingChanges = this.pendingNodeChanges.get(local.id)
    const editingState = this.getEditingState()
    const isEditingThisNode = editingState.nodeId === local.id

    const fieldGroups = {
      content: ['title', 'content'] as const,
      position: ['x', 'y', 'width', 'height'] as const,
      style: ['color', 'fontSize', 'textAlign', 'titleAlign', 'contentAlign', 'collapsedTitleAlign'] as const,
      state: ['collapsed', 'locked', 'expandedHeight'] as const,
      media: ['type', 'imageUrl', 'aspectRatio'] as const,
    }

    Object.entries(fieldGroups).forEach(([group, fields]) => {
      fields.forEach((field) => {
        const localVal = local[field as keyof Node]
        const remoteVal = remote[field as keyof Node]

        if (remoteVal === undefined || remoteVal === localVal) {
          return
        }

        const resolution = this.resolveFieldConflict(
          local.id,
          field,
          localVal,
          remoteVal,
          group as keyof typeof fieldGroups,
          pendingChanges,
          isEditingThisNode && editingState.field === field,
          isDiverged,
          isEditingThisNode
        )

        if (resolution.strategy !== 'local') {
          (result as unknown as Record<string, unknown>)[field] = resolution.value
        }

        this.conflictResolutionLog.push(resolution)
      })
    })

    result._version = Math.max(local._version || 0, remote._version || 0) + 1

    return result
  }

  private resolveFieldConflict(
    nodeId: string,
    field: string,
    localValue: unknown,
    remoteValue: unknown,
    fieldGroup: 'content' | 'position' | 'style' | 'state' | 'media',
    pendingChanges: PendingNodeChanges | undefined,
    isCurrentlyEditing: boolean,
    isDiverged: boolean,
    isEditingThisNode: boolean
  ): ConflictResolutionResult {
    const pendingChange = pendingChanges?.changes.get(field)
    const hasLocalChange = pendingChange !== undefined

    // 当用户正在编辑该节点的任何 content 字段时，保留所有 content 字段的本地值
    if (fieldGroup === 'content' && isEditingThisNode) {
      return {
        value: localValue,
        strategy: 'local',
        reason: 'User is currently editing this node'
      }
    }

    if (hasLocalChange && fieldGroup === 'content') {
      return {
        value: localValue,
        strategy: 'local',
        reason: 'Local has pending changes for this content field'
      }
    }

    if (fieldGroup === 'position') {
      if (hasLocalChange) {
        const localTime = pendingChange.timestamp
        const now = Date.now()
        const timeDiff = now - localTime

        if (timeDiff < 5000) {
          return {
            value: localValue,
            strategy: 'local',
            reason: 'Recent local position change (within 5s)'
          }
        }
      }
      return {
        value: remoteValue,
        strategy: 'remote',
        reason: 'Position changes use latest remote'
      }
    }

    if (fieldGroup === 'style') {
      if (hasLocalChange) {
        return {
          value: localValue,
          strategy: 'local',
          reason: 'Local style change pending'
        }
      }
      return {
        value: remoteValue,
        strategy: 'remote',
        reason: 'Style changes use latest remote'
      }
    }

    if (fieldGroup === 'state') {
      if (field === 'collapsed' || field === 'locked') {
        if (hasLocalChange) {
          return {
            value: localValue,
            strategy: 'local',
            reason: 'State change by local user takes priority'
          }
        }
      }
      return {
        value: remoteValue,
        strategy: 'remote',
        reason: 'State changes use latest remote'
      }
    }

    if (fieldGroup === 'media') {
      return {
        value: remoteValue,
        strategy: 'remote',
        reason: 'Media properties always use remote'
      }
    }

    return {
      value: remoteValue,
      strategy: 'remote',
      reason: 'Default: accept remote'
    }
  }

  private hasPendingChanges(nodeId: string): boolean {
    const pending = this.pendingNodeChanges.get(nodeId)
    return pending !== undefined && pending.changes.size > 0
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

  private hasPendingConnectionChanges(connectionId: string): boolean {
    const pending = this.pendingConnectionChanges.get(connectionId)
    return pending !== undefined && pending.changes.size > 0
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

  getConflictResolutionLog(): ConflictResolutionResult[] {
    return [...this.conflictResolutionLog]
  }

  clearConflictResolutionLog(): void {
    this.conflictResolutionLog = []
  }

  private getEditingState(): { nodeId: string | null; field: 'title' | 'content' | null } {
    const state = getEditingState()
    return { nodeId: state.nodeId, field: state.field }
  }

  private mergeConnectionsWithVersion(
    localConnections: Connection[],
    remoteConnections: Connection[]
  ): Connection[] {
    const merged = new Map<string, Connection>()

    localConnections.forEach((conn) => {
      merged.set(conn.id, conn)
    })

    remoteConnections.forEach((remoteConn) => {
      const id = remoteConn.id
      const localConn = merged.get(id)

      if (!localConn) {
        merged.set(id, remoteConn)
        return
      }

      const hasPending = this.hasPendingConnectionChanges(id)
      const mergedConn = this.mergeConnectionFields(localConn, remoteConn, hasPending)
      merged.set(id, mergedConn)
    })

    return Array.from(merged.values())
  }

  private mergeConnectionFields(local: Connection, remote: Connection, hasPendingChanges: boolean): Connection {
    if (!hasPendingChanges) {
      return { ...remote }
    }

    const result: Connection = { ...local }
    const pending = this.pendingConnectionChanges.get(local.id)

    const geometryFields: (keyof Pick<Connection, 'fromPort' | 'toPort' | 'type' | 'style' | 'color' | 'width' | 'arrowType' | 'direction' | 'label' | 'bendPoints'>)[] = [
      'fromPort', 'toPort', 'type', 'style', 'color', 'width', 'arrowType', 'direction', 'label', 'bendPoints'
    ]

    geometryFields.forEach((field) => {
      const remoteVal = remote[field]
      if (remoteVal === undefined) return
      const localVal = local[field]

      if (JSON.stringify(remoteVal) === JSON.stringify(localVal)) return

      const localChange = pending?.changes.get(field)
      if (localChange) {
        return
      }

      (result as unknown as Record<string, unknown>)[field] = remoteVal
    })

    return result
  }

  private requestSync() {
    if (this.isDestroyed || this.isIntentionallyClosed) return
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
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

  async syncBeforeSave(): Promise<{
    nodes: Node[]
    groups: NodeGroup[]
    domains: Domain[]
    connections: Connection[]
  } | null> {
    if (!this.canvasId) return null

    try {
      const response = await fetch(`/api/canvases/detail/${this.canvasId}`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('mindmap_token')}`,
        },
      })

      if (!response.ok) return null

      const result = await response.json()
      const canvas = result.data

      if (!canvas || !canvas.yjsData) {
        return null
      }

      const binaryString = atob(canvas.yjsData)
      const utf8Bytes = new Uint8Array(binaryString.length)
      for (let i = 0; i < binaryString.length; i++) {
        utf8Bytes[i] = binaryString.charCodeAt(i)
      }
      const jsonString = new TextDecoder().decode(utf8Bytes)
      const remoteData = JSON.parse(jsonString)

      const remoteNodes: Node[] = remoteData.nodes || []
      const remoteGroups: NodeGroup[] = remoteData.groups || []
      const remoteDomains: Domain[] = remoteData.domains || []
      const remoteConnections: Connection[] = remoteData.connections || []

      const store = useCanvasStore.getState()
      const localNodes = Array.from(store.nodes.values())
      const localGroups = Array.from(store.groups.values())
      const localDomains = Array.from(store.domains.values())
      const localConnections = Array.from(store.connections.values())

      // 保存前同步：优先保留本地数据，特别是有 pending changes 的节点
      const mergedNodes = this.mergeNodesForSave(localNodes, remoteNodes)
      const mergedGroups = this.mergeEntityMaps(
        localGroups,
        remoteGroups,
        (g) => g.id,
        (g) => g.name
      )
      const mergedDomains = this.mergeEntityMaps(
        localDomains,
        remoteDomains,
        (d) => d.id,
        (d) => d.name
      )
      const mergedConnections = this.mergeConnectionsWithVersion(localConnections, remoteConnections)

      return {
        nodes: mergedNodes,
        groups: mergedGroups,
        domains: mergedDomains,
        connections: mergedConnections,
      }
    } catch {
      return null
    }
  }

  // 专用于保存前的合并：逐字段三向合并，利用 pendingChanges 精确保护本地修改
  private mergeNodesForSave(localNodes: Node[], remoteNodes: Node[]): Node[] {
    const merged = new Map<string, Node>()

    localNodes.forEach((node) => {
      merged.set(node.id, node)
    })

    remoteNodes.forEach((remoteNode) => {
      const id = remoteNode.id
      const localNode = merged.get(id)

      if (!localNode) {
        merged.set(id, remoteNode)
        return
      }

      const hasPendingChanges = this.hasPendingChanges(id)
      const editingState = this.getEditingState()
      const isEditingThisNode = editingState.nodeId === id
      const localVersion = localNode._version || 0
      const remoteVersion = remoteNode._version || 0
      const lastSyncedVersion = this.lastSyncedVersions.get(id) || 0

      // 如果没有任何冲突迹象，直接接受远程（远程更新了而我们没改过）
      if (!hasPendingChanges && !isEditingThisNode && remoteVersion > localVersion) {
        merged.set(id, { ...remoteNode })
        this.lastSyncedVersions.set(id, remoteVersion)
        return
      }

      // 有本地修改或正在编辑 — 使用逐字段合并（和 sync 路径一致）
      // pendingNodeChanges 记录了哪些字段被本地修改过
      // 没被修改的字段接受远程，被修改的字段保留本地
      const conflictType = this.detectConflictType(
        localVersion, remoteVersion, lastSyncedVersion, hasPendingChanges
      )

      if (conflictType === 'sequential_remote') {
        merged.set(id, { ...remoteNode })
      } else if (conflictType === 'sequential_local') {
        merged.set(id, { ...localNode })
      } else {
        const mergedNode = this.mergeNodeFieldsWithConflictResolution(
          localNode, remoteNode, lastSyncedVersion, conflictType === 'diverged'
        )
        merged.set(id, mergedNode)
      }

      this.lastSyncedVersions.set(id, Math.max(localVersion, remoteVersion))
    })

    return Array.from(merged.values())
  }
}

export const collabService = new CollaborationService()
export type { CollabUser, CursorData }
