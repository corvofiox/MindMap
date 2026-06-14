import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { batchToOperations, queueToBatch } from '../services/collaboration'
import type {
  BatchOperations,
  FieldChange,
  PendingNodeChanges,
  PendingConnectionChanges,
  PendingGroupChanges,
  PendingDomainChanges,
} from '../services/collab-utils'
import { clearPendingForBatch, clearPendingForSingleOperation } from '../services/collab-utils'
// 测试中使用简化数据，避免导入全部实体类型
type AnyBatch = Record<string, unknown>

interface BatchCollabMessage {
  type: 'batch-operation'
  operations: Array<{ operation: string; data: unknown }>
  timestamp: number
  senderId: number
  seq: number
}

interface QueuedOperation {
  operation: string
  data: unknown
  timestamp: number
}

interface CollabMessage {
  type: 'operation'
  operation: string
  data: unknown
  timestamp: number
  senderId: number
}

class MockCollaborationService {
  private ws: WebSocket | null = null
  private isIntentionallyClosed = false
  private userId: number | null = 1
  private offlineQueue: QueuedOperation[] = []
  private maxQueueSize = 100
  private sentMessages: CollabMessage[] = []
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
  private isApplyingRemoteUpdate = false
  private unackedOps = new Map<number, QueuedOperation>()
  private opSeq = 0
  private emptySyncRetryCount = 0
  private readonly MAX_EMPTY_SYNC_RETRIES = 3

  connect(shouldConnect: boolean = true) {
    if (shouldConnect) {
      this.ws = {
        readyState: WebSocket.OPEN, send: (msg: string) => {
          this.sentMessages.push(JSON.parse(msg))
        }
      } as unknown as WebSocket
    } else {
      this.ws = null
    }
  }

  disconnect() {
    this.isIntentionallyClosed = true
    this.isApplyingRemoteUpdate = false
    this.ws = null
    this.offlineQueue = []
    this.pendingNodeChanges.clear()
    this.pendingConnectionChanges.clear()
    this.pendingGroupChanges.clear()
    this.pendingDomainChanges.clear()
    this.pendingRemoves.nodeIds.clear()
    this.pendingRemoves.groupIds.clear()
    this.pendingRemoves.domainIds.clear()
    this.pendingRemoves.connectionIds.clear()
    this.unackedOps.clear()
  }

  cleanupWebSocket() {
    this.isApplyingRemoteUpdate = false
    if (this.unackedOps.size > 0) {
      for (const [seq, op] of this.unackedOps) {
        if (this.offlineQueue.length < this.maxQueueSize) {
          this.offlineQueue.push(op)
        }
      }
      this.unackedOps.clear()
    }
    this.ws = null
  }

  handleAck(seq: number): void {
    const op = this.unackedOps.get(seq)
    if (op) {
      if (op.operation === 'batch-operation') {
        clearPendingForBatch(
          op.data as BatchOperations,
          op.timestamp,
          this.pendingNodeChanges,
          this.pendingGroupChanges,
          this.pendingDomainChanges,
          this.pendingConnectionChanges,
        )
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
  }

  handleNak(seq: number): void {
    // Intentionally do NOT clear pending*Changes on NAK
    this.unackedOps.delete(seq)
  }

  handleSync(): void {
    // Simulate sync that preserves pending changes (does NOT clear them)
    this.emptySyncRetryCount = 0
  }

  sendBatch(batch: BatchOperations): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const timestamp = Date.now()
    const seq = ++this.opSeq
    this.unackedOps.set(seq, { operation: 'batch-operation', data: batch, timestamp })
    const message: BatchCollabMessage = {
      type: 'batch-operation',
      operations: batchToOperations(batch),
      timestamp,
      senderId: this.userId || 0,
      seq,
    }
    this.ws.send(JSON.stringify(message))
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  sendOperation(operation: string, data: unknown) {
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
      // 与真实 service 对称：单操作路径下追踪 remove，避免 NAK→resync 时
      // 被删实体从服务端最新状态复活。
      const d = data as { id: string }
      if (d?.id) {
        const entityType = operation.split('-')[1] as 'node' | 'group' | 'domain' | 'connection'
        this.trackPendingRemove(entityType, d.id)
      }
    }

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

    // Mirror the real service: track single ops as unacked so handleAck can
    // prune their pending entries (the path-B single-operation ACK fix).
    const seq = ++this.opSeq
    this.unackedOps.set(seq, { operation, data, timestamp })
    this.lastSingleOpSeq = seq

    this.ws.send(JSON.stringify(message))
  }

  // Most recently assigned single-op seq, exposed for tests that drive the
  // single-operation ACK path without manually probing opSeq internals.
  private lastSingleOpSeq = 0
  getLastSingleOpSeq(): number {
    return this.lastSingleOpSeq
  }

  flushOfflineQueue() {
    if (this.offlineQueue.length === 0) return

    const queue = [...this.offlineQueue]
    this.offlineQueue = []

    for (const item of queue) {
      this.sendOperation(item.operation, item.data)
    }
  }

  getQueueLength(): number {
    return this.offlineQueue.length
  }

  getSentMessages(): CollabMessage[] {
    return this.sentMessages
  }

  clearSentMessages() {
    this.sentMessages = []
  }

  trackLocalChange(nodeId: string, field: string, newValue: unknown): void {
    let pending = this.pendingNodeChanges.get(nodeId)
    if (!pending) {
      pending = { nodeId, changes: new Map() }
      this.pendingNodeChanges.set(nodeId, pending)
    }
    pending.changes.set(field, { field, newValue, timestamp: Date.now() })
  }

  trackLocalGroupChange(groupId: string, field: string, newValue: unknown): void {
    let pending = this.pendingGroupChanges.get(groupId)
    if (!pending) {
      pending = { groupId, changes: new Map() }
      this.pendingGroupChanges.set(groupId, pending)
    }
    pending.changes.set(field, { field, newValue, timestamp: Date.now() })
  }

  trackLocalDomainChange(domainId: string, field: string, newValue: unknown): void {
    let pending = this.pendingDomainChanges.get(domainId)
    if (!pending) {
      pending = { domainId, changes: new Map() }
      this.pendingDomainChanges.set(domainId, pending)
    }
    pending.changes.set(field, { field, newValue, timestamp: Date.now() })
  }

  trackLocalConnectionChange(connectionId: string, field: string, newValue: unknown): void {
    let pending = this.pendingConnectionChanges.get(connectionId)
    if (!pending) {
      pending = { connectionId, changes: new Map() }
      this.pendingConnectionChanges.set(connectionId, pending)
    }
    pending.changes.set(field, { field, newValue, timestamp: Date.now() })
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

  hasPendingRemove(entityType: 'node' | 'group' | 'domain' | 'connection', id: string): boolean {
    switch (entityType) {
      case 'node':
        return this.pendingRemoves.nodeIds.has(id)
      case 'group':
        return this.pendingRemoves.groupIds.has(id)
      case 'domain':
        return this.pendingRemoves.domainIds.has(id)
      case 'connection':
        return this.pendingRemoves.connectionIds.has(id)
    }
  }

  getPendingRemoveCount(entityType: 'node' | 'group' | 'domain' | 'connection'): number {
    switch (entityType) {
      case 'node':
        return this.pendingRemoves.nodeIds.size
      case 'group':
        return this.pendingRemoves.groupIds.size
      case 'domain':
        return this.pendingRemoves.domainIds.size
      case 'connection':
        return this.pendingRemoves.connectionIds.size
    }
  }

  getPendingNodeChangeValue(nodeId: string, field: string): unknown | undefined {
    return this.pendingNodeChanges.get(nodeId)?.changes.get(field)?.newValue
  }

  getPendingGroupChangeValue(groupId: string, field: string): unknown | undefined {
    return this.pendingGroupChanges.get(groupId)?.changes.get(field)?.newValue
  }

  getPendingDomainChangeValue(domainId: string, field: string): unknown | undefined {
    return this.pendingDomainChanges.get(domainId)?.changes.get(field)?.newValue
  }

  getPendingConnectionChangeValue(connectionId: string, field: string): unknown | undefined {
    return this.pendingConnectionChanges.get(connectionId)?.changes.get(field)?.newValue
  }

  hasPendingNodeChange(nodeId: string): boolean {
    return this.pendingNodeChanges.has(nodeId)
  }

  hasPendingGroupChange(groupId: string): boolean {
    return this.pendingGroupChanges.has(groupId)
  }

  hasPendingDomainChange(domainId: string): boolean {
    return this.pendingDomainChanges.has(domainId)
  }

  hasPendingConnectionChange(connectionId: string): boolean {
    return this.pendingConnectionChanges.has(connectionId)
  }

  getPendingNodeChangeCount(): number {
    return this.pendingNodeChanges.size
  }

  getPendingGroupChangeCount(): number {
    return this.pendingGroupChanges.size
  }

  getPendingDomainChangeCount(): number {
    return this.pendingDomainChanges.size
  }

  getPendingConnectionChangeCount(): number {
    return this.pendingConnectionChanges.size
  }

  getPendingNodeFields(nodeId: string): string[] {
    const pending = this.pendingNodeChanges.get(nodeId)
    return pending ? Array.from(pending.changes.keys()) : []
  }

  getIsApplyingRemoteUpdate(): boolean {
    return this.isApplyingRemoteUpdate
  }

  setIsApplyingRemoteUpdate(val: boolean): void {
    this.isApplyingRemoteUpdate = val
  }

  getPendingChangeTimestamp(nodeId: string, field: string): number | undefined {
    return this.pendingNodeChanges.get(nodeId)?.changes.get(field)?.timestamp
  }

  getUnackedOpCount(): number {
    return this.unackedOps.size
  }

  setEmptySyncRetryCount(n: number): void {
    this.emptySyncRetryCount = n
  }

  getEmptySyncRetryCount(): number {
    return this.emptySyncRetryCount
  }

  getMaxEmptySyncRetries(): number {
    return this.MAX_EMPTY_SYNC_RETRIES
  }
}

describe('CollaborationService Offline Queue', () => {
  let service: MockCollaborationService

  beforeEach(() => {
    service = new MockCollaborationService()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('sendOperation', () => {
    it('should send operation immediately when connected', () => {
      service.connect(true)

      service.sendOperation('add-node', { id: 'node-1', text: 'Test' })

      expect(service.isConnected()).toBe(true)
      expect(service.getSentMessages()).toHaveLength(1)
      expect(service.getSentMessages()[0].operation).toBe('add-node')
    })

    it('should queue operation when disconnected', () => {
      service.connect(false)

      service.sendOperation('add-node', { id: 'node-1', text: 'Test' })

      expect(service.isConnected()).toBe(false)
      expect(service.getQueueLength()).toBe(1)
      expect(service.getSentMessages()).toHaveLength(0)
    })

    it('should queue multiple operations when disconnected', () => {
      service.connect(false)

      service.sendOperation('add-node', { id: 'node-1' })
      service.sendOperation('update-node', { id: 'node-1', updates: { text: 'Updated' } })
      service.sendOperation('remove-node', { id: 'node-1' })

      expect(service.getQueueLength()).toBe(3)
    })
  })

  describe('flushOfflineQueue', () => {
    it('should send queued operations after reconnect', () => {
      service.connect(false)

      service.sendOperation('add-node', { id: 'node-1' })
      service.sendOperation('update-node', { id: 'node-1', updates: { text: 'Test' } })

      expect(service.getQueueLength()).toBe(2)

      service.connect(true)
      service.flushOfflineQueue()

      expect(service.getQueueLength()).toBe(0)
      expect(service.getSentMessages()).toHaveLength(2)
    })

    it('should preserve operation order', () => {
      service.connect(false)

      service.sendOperation('add-node', { id: 'node-1' })
      service.sendOperation('add-node', { id: 'node-2' })
      service.sendOperation('remove-node', { id: 'node-1' })

      service.connect(true)
      service.flushOfflineQueue()

      const messages = service.getSentMessages()
      expect(messages[0].operation).toBe('add-node')
      expect((messages[0].data as { id: string }).id).toBe('node-1')
      expect(messages[1].operation).toBe('add-node')
      expect((messages[1].data as { id: string }).id).toBe('node-2')
      expect(messages[2].operation).toBe('remove-node')
    })

    it('should do nothing when queue is empty', () => {
      service.connect(true)

      service.flushOfflineQueue()

      expect(service.getSentMessages()).toHaveLength(0)
    })
  })

  describe('queue size limit', () => {
    it('should limit queue size to maxQueueSize', () => {
      service.connect(false)

      for (let i = 0; i < 150; i++) {
        service.sendOperation('add-node', { id: `node-${i}` })
      }

      expect(service.getQueueLength()).toBe(100)
    })
  })

  describe('disconnect', () => {
    it('should clear queue and reset isApplyingRemoteUpdate on intentional disconnect', () => {
      service.connect(false)

      service.sendOperation('add-node', { id: 'node-1' })
      expect(service.getQueueLength()).toBe(1)

      service.setIsApplyingRemoteUpdate(true)
      service.disconnect()

      expect(service.getQueueLength()).toBe(0)
      expect(service.getIsApplyingRemoteUpdate()).toBe(false)
    })
  })
})

describe('sendOperation 本地变更追踪', () => {
  let service: MockCollaborationService

  beforeEach(() => {
    service = new MockCollaborationService()
    service.connect(true)
  })

  it('update-node 应追踪到 pendingNodeChanges', () => {
    service.sendOperation('update-node', { id: 'n1', updates: { text: 'new text', x: 100 } })

    expect(service.hasPendingNodeChange('n1')).toBe(true)
    expect(service.getPendingNodeChangeValue('n1', 'text')).toBe('new text')
    expect(service.getPendingNodeChangeValue('n1', 'x')).toBe(100)
    expect(service.getPendingNodeChangeCount()).toBe(1)
  })

  it('update-group 应追踪到 pendingGroupChanges', () => {
    service.sendOperation('update-group', { id: 'g1', updates: { name: 'renamed' } })

    expect(service.hasPendingGroupChange('g1')).toBe(true)
    expect(service.getPendingGroupChangeValue('g1', 'name')).toBe('renamed')
  })

  it('update-domain 应追踪到 pendingDomainChanges', () => {
    service.sendOperation('update-domain', { id: 'd1', updates: { label: 'domain-x' } })

    expect(service.hasPendingDomainChange('d1')).toBe(true)
    expect(service.getPendingDomainChangeValue('d1', 'label')).toBe('domain-x')
  })

  it('update-connection 应追踪到 pendingConnectionChanges', () => {
    service.sendOperation('update-connection', { id: 'c1', updates: { color: '#ff0' } })

    expect(service.hasPendingConnectionChange('c1')).toBe(true)
    expect(service.getPendingConnectionChangeValue('c1', 'color')).toBe('#ff0')
  })

  it('非 update 操作不应追踪本地变更', () => {
    service.sendOperation('add-node', { id: 'n1', text: 'new' })
    service.sendOperation('remove-node', { id: 'n2' })
    service.sendOperation('add-group', { id: 'g1' })
    service.sendOperation('add-domain', { id: 'd1' })
    service.sendOperation('add-connection', { id: 'c1' })

    expect(service.getPendingNodeChangeCount()).toBe(0)
    expect(service.getPendingGroupChangeCount()).toBe(0)
    expect(service.getPendingDomainChangeCount()).toBe(0)
    expect(service.getPendingConnectionChangeCount()).toBe(0)
  })

  it('同字段多次追踪应覆盖值', () => {
    service.sendOperation('update-node', { id: 'n1', updates: { text: 'v1' } })
    service.sendOperation('update-node', { id: 'n1', updates: { text: 'v2' } })

    expect(service.getPendingNodeChangeValue('n1', 'text')).toBe('v2')
    expect(service.getPendingNodeChangeCount()).toBe(1)
  })

  it('多字段更新应全部追踪', () => {
    service.sendOperation('update-node', {
      id: 'n1',
      updates: { text: 'hello', x: 200, y: 300, width: 400 }
    })

    const fields = service.getPendingNodeFields('n1')
    expect(fields).toContain('text')
    expect(fields).toContain('x')
    expect(fields).toContain('y')
    expect(fields).toContain('width')
    expect(fields).toHaveLength(4)
  })

  it('noop: updates 为空对象不应报错也不应追踪', () => {
    service.sendOperation('update-node', { id: 'n1', updates: {} })

    expect(service.hasPendingNodeChange('n1')).toBe(false)
  })

  it('noop: 缺省 updates 字段不应报错', () => {
    service.sendOperation('update-node', { id: 'n1' })

    expect(service.hasPendingNodeChange('n1')).toBe(false)
  })
})

describe('sendOperation 追踪 — remove-* 路径', () => {
  // 单操作 remove 路径必须把删除记入 pendingRemoves，与 batch 路径
  // （useCollaboration subscribe → trackPendingRemove）对称。否则
  // NAK→resync 周期中 handleSync 不会重新应用删除，被删实体会从
  // 服务端最新状态"复活"。
  let service: MockCollaborationService

  beforeEach(() => {
    service = new MockCollaborationService()
    service.connect(true)
  })

  it('remove-node 应追踪到 pendingRemoves.nodeIds', () => {
    service.sendOperation('remove-node', { id: 'n1' })

    expect(service.hasPendingRemove('node', 'n1')).toBe(true)
    expect(service.getPendingRemoveCount('node')).toBe(1)
    // remove 不应进入 pendingNodeChanges（那是 update 路径的集合）
    expect(service.hasPendingNodeChange('n1')).toBe(false)
  })

  it('remove-group 应追踪到 pendingRemoves.groupIds', () => {
    service.sendOperation('remove-group', { id: 'g1' })

    expect(service.hasPendingRemove('group', 'g1')).toBe(true)
    expect(service.getPendingRemoveCount('group')).toBe(1)
  })

  it('remove-domain 应追踪到 pendingRemoves.domainIds', () => {
    service.sendOperation('remove-domain', { id: 'd1' })

    expect(service.hasPendingRemove('domain', 'd1')).toBe(true)
    expect(service.getPendingRemoveCount('domain')).toBe(1)
  })

  it('remove-connection 应追踪到 pendingRemoves.connectionIds', () => {
    service.sendOperation('remove-connection', { id: 'c1' })

    expect(service.hasPendingRemove('connection', 'c1')).toBe(true)
    expect(service.getPendingRemoveCount('connection')).toBe(1)
  })

  it('同一实体多次 remove 应幂等（Set 去重）', () => {
    service.sendOperation('remove-node', { id: 'n1' })
    service.sendOperation('remove-node', { id: 'n1' })

    expect(service.hasPendingRemove('node', 'n1')).toBe(true)
    expect(service.getPendingRemoveCount('node')).toBe(1)
  })

  it('remove 与 update 同实体应分别记录到不同集合', () => {
    service.sendOperation('update-node', { id: 'n1', updates: { title: 'v1' } })
    service.sendOperation('remove-node', { id: 'n1' })

    expect(service.hasPendingNodeChange('n1')).toBe(true)
    expect(service.hasPendingRemove('node', 'n1')).toBe(true)
  })

  it('noop: remove 缺省 id 不应报错也不应追踪', () => {
    service.sendOperation('remove-node', {})

    expect(service.getPendingRemoveCount('node')).toBe(0)
  })
})

describe('sendOperation 追踪 — 离线场景', () => {
  let service: MockCollaborationService

  beforeEach(() => {
    service = new MockCollaborationService()
  })

  it('离线时 sendOperation 仍应追踪本地变更 (pending 不依赖 WS)', () => {
    service.connect(false)

    service.sendOperation('update-node', { id: 'n1', updates: { text: 'offline edit' } })

    expect(service.getPendingNodeChangeValue('n1', 'text')).toBe('offline edit')
    expect(service.isConnected()).toBe(false)
  })

  it('离线入队 + 重连后 pending 与发送一致', () => {
    service.connect(false)
    service.sendOperation('update-node', { id: 'n1', updates: { text: 'queued' } })
    expect(service.getQueueLength()).toBe(1)

    service.connect(true)
    service.flushOfflineQueue()
    expect(service.getQueueLength()).toBe(0)
    expect(service.getSentMessages()).toHaveLength(1)
    // sendOperation 在 connect(true) 后的 flushOfflineQueue 中被调用，
    // 重连后刷新队列时也会追踪 pending
    expect(service.getPendingNodeChangeValue('n1', 'text')).toBe('queued')
  })
})

describe('ACK 清除 pending (clearPendingForBatch)', () => {
  let service: MockCollaborationService

  beforeEach(() => {
    service = new MockCollaborationService()
    service.connect(true)
  })

  it('ACK batch 后应清除该批次的 pending 字段，保留未包含的节点', () => {
    service.sendOperation('update-node', { id: 'n1', updates: { title: 'v1' } })
    service.sendOperation('update-node', { id: 'n2', updates: { title: 'v2' } })
    expect(service.getPendingNodeChangeCount()).toBe(2)

    const batch: BatchOperations = {
      updatedNodes: [{ id: 'n1', updates: { title: 'v1' } }],
    }
    const seq = 1
    service['unackedOps'].set(seq, { operation: 'batch-operation', data: batch, timestamp: Date.now() })
    service.handleAck(seq)

    expect(service.hasPendingNodeChange('n1')).toBe(false)
    expect(service.hasPendingNodeChange('n2')).toBe(true)
    expect(service.getPendingNodeChangeValue('n2', 'title')).toBe('v2')
  })

  it('ACK 后新追踪的变更 (晚于时间戳) 应存活', () => {
    vi.useFakeTimers()
    // t1: title tracked at time 1000
    vi.setSystemTime(1000)
    service.sendOperation('update-node', { id: 'n1', updates: { title: 'old' } })

    // batchTs = 2000, the ACK cutoff
    vi.setSystemTime(2000)
    const batchTs = Date.now()

    // t3: color tracked at time 3000 (AFTER batchTs)
    vi.setSystemTime(3000)
    service.sendOperation('update-node', { id: 'n1', updates: { color: 'red' } })

    const batch: BatchOperations = {
      updatedNodes: [{ id: 'n1', updates: { title: 'old', color: 'red' } }],
    }
    const seq = 1
    service['unackedOps'].set(seq, { operation: 'batch-operation', data: batch, timestamp: batchTs })
    service.handleAck(seq)

    // title tracked at 1000 <= 2000 → cleared
    // color tracked at 3000 > 2000 → survives
    expect(service.hasPendingNodeChange('n1')).toBe(true)
    expect(service.getPendingNodeChangeValue('n1', 'color')).toBe('red')
    expect(service.getPendingNodeChangeValue('n1', 'title')).toBeUndefined()
    vi.useRealTimers()
  })

  it('ACK 清除后 pending node 如无剩余字段应整条删除', () => {
    service.sendOperation('update-node', { id: 'n1', updates: { title: 'only' } })

    const batch: BatchOperations = {
      updatedNodes: [{ id: 'n1', updates: { title: 'only' } }],
    }
    const seq = 1
    service['unackedOps'].set(seq, { operation: 'batch-operation', data: batch, timestamp: Date.now() })
    service.handleAck(seq)

    expect(service.hasPendingNodeChange('n1')).toBe(false)
  })

  it('NAK 不应清除 pending 变更', () => {
    service.sendOperation('update-node', { id: 'n1', updates: { title: 'v1' } })
    expect(service.hasPendingNodeChange('n1')).toBe(true)

    service.handleNak(1)

    // NAK must NOT clear pending — the upcoming sync will replay them
    expect(service.hasPendingNodeChange('n1')).toBe(true)
    expect(service.getPendingNodeChangeValue('n1', 'title')).toBe('v1')
  })

  it('单操作 ACK 应清除该操作的 pending 字段（修复路径 B 不清除的回归）', () => {
    // Path B (NodeItem input timer) sends single 'update-node' operations via
    // sendOperation. Before the fix, ACKs for these were ignored when clearing
    // pending — only batch ACKs cleared — so stale pending entries lingered
    // and could be replayed over newer edits on the next sync. The single-op
    // ACK must prune the confirmed field using the same cutoff rule as batches.
    service.sendOperation('update-node', { id: 'n1', updates: { title: 'hello' } })
    expect(service.hasPendingNodeChange('n1')).toBe(true)
    expect(service.getPendingNodeChangeValue('n1', 'title')).toBe('hello')

    const seq = service.getLastSingleOpSeq()
    service.handleAck(seq)

    // The confirmed field is pruned, the pending entry is removed entirely
    // (no remaining fields).
    expect(service.hasPendingNodeChange('n1')).toBe(false)
  })

  it('单操作 ACK 不应清除晚于该操作的新 pending 写入', () => {
    vi.useFakeTimers()
    // First edit at t=1000, sent as a single op.
    vi.setSystemTime(1000)
    service.sendOperation('update-node', { id: 'n1', updates: { title: 'old' } })
    const firstSeq = service.getLastSingleOpSeq()

    // A second edit at t=3000 to a DIFFERENT field, after the first op was
    // already in flight. The first op's ACK (cutoff = its own timestamp 1000)
    // must NOT prune 'color' (timestamp 3000 > 1000).
    vi.setSystemTime(3000)
    service.sendOperation('update-node', { id: 'n1', updates: { color: 'red' } })

    // ACK for the first op arrives.
    service.handleAck(firstSeq)

    expect(service.getPendingNodeChangeValue('n1', 'title')).toBeUndefined()
    expect(service.getPendingNodeChangeValue('n1', 'color')).toBe('red')
    vi.useRealTimers()
  })
})

describe('isApplyingRemoteUpdate 防御性复位', () => {
  let service: MockCollaborationService

  beforeEach(() => {
    service = new MockCollaborationService()
  })

  it('cleanupWebSocket 应复位 isApplyingRemoteUpdate', () => {
    service.setIsApplyingRemoteUpdate(true)
    service.cleanupWebSocket()
    expect(service.getIsApplyingRemoteUpdate()).toBe(false)
  })

  it('disconnect 应复位 isApplyingRemoteUpdate', () => {
    service.setIsApplyingRemoteUpdate(true)
    service.disconnect()
    expect(service.getIsApplyingRemoteUpdate()).toBe(false)
  })

  it('首次连接时 isApplyingRemoteUpdate 为 false', () => {
    expect(service.getIsApplyingRemoteUpdate()).toBe(false)
  })

  it('cleanupWebSocket 应将未确认的操作移入离线队列', () => {
    service.connect(true)
    const op = { operation: 'update-node', data: { id: 'n1', updates: { text: 'x' } }, timestamp: Date.now() }
    service['unackedOps'].set(1, op)
    expect(service.getUnackedOpCount()).toBe(1)

    service.cleanupWebSocket()

    expect(service.getUnackedOpCount()).toBe(0)
    expect(service.getQueueLength()).toBe(1)
  })
})

describe('handleSync — pending 存活保护', () => {
  let service: MockCollaborationService

  beforeEach(() => {
    service = new MockCollaborationService()
    service.connect(true)
  })

  it('handleSync 后 pending 变更不应被清除', () => {
    service.sendOperation('update-node', { id: 'n1', updates: { text: 'survive!' } })

    service.handleSync()

    expect(service.hasPendingNodeChange('n1')).toBe(true)
    expect(service.getPendingNodeChangeValue('n1', 'text')).toBe('survive!')
  })

  it('handleSync 后多实体 pending 均存活', () => {
    service.sendOperation('update-node', { id: 'n1', updates: { text: 'node' } })
    service.sendOperation('update-group', { id: 'g1', updates: { name: 'group' } })
    service.sendOperation('update-domain', { id: 'd1', updates: { label: 'domain' } })
    service.sendOperation('update-connection', { id: 'c1', updates: { color: '#000' } })

    service.handleSync()

    expect(service.getPendingNodeChangeCount()).toBe(1)
    expect(service.getPendingGroupChangeCount()).toBe(1)
    expect(service.getPendingDomainChangeCount()).toBe(1)
    expect(service.getPendingConnectionChangeCount()).toBe(1)
  })
})

describe('emptySyncRetry — 空同步保护', () => {
  let service: MockCollaborationService

  beforeEach(() => {
    service = new MockCollaborationService()
    service.connect(true)
  })

  it('达到最大重试次数后 localHasData 应跳过同步 (模拟)', () => {
    service.setEmptySyncRetryCount(service.getMaxEmptySyncRetries())
    const retries = service.getEmptySyncRetryCount()

    // After max retries exhausted, handleSync should reset counter
    // (real logic: refuse to apply empty sync; here we verify the reset)
    service.handleSync()
    expect(service.getEmptySyncRetryCount()).toBe(0)
  })
})

type ConflictType = 'no_conflict' | 'sequential_remote' | 'sequential_local' | 'concurrent' | 'diverged'

function detectConflictType(
  localVersion: number,
  remoteVersion: number,
  lastSyncedVersion: number,
  hasLocalPendingChanges: boolean
): ConflictType {
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

describe('detectConflictType - Truth Table Tests', () => {
  describe('when all versions are equal (L === R === S)', () => {
    it('should return no_conflict when no pending changes', () => {
      expect(detectConflictType(5, 5, 5, false)).toBe('no_conflict')
    })

    it('should return concurrent when has pending changes', () => {
      expect(detectConflictType(5, 5, 5, true)).toBe('concurrent')
    })
  })

  describe('when remoteVersion > localVersion', () => {
    it('should return sequential_remote when localVersion === lastSyncedVersion and no pending changes', () => {
      expect(detectConflictType(5, 7, 5, false)).toBe('sequential_remote')
    })

    it('should return diverged when localVersion === lastSyncedVersion and has pending changes', () => {
      expect(detectConflictType(5, 7, 5, true)).toBe('diverged')
    })

    it('should return sequential_remote when localVersion > lastSyncedVersion and no pending changes', () => {
      expect(detectConflictType(6, 7, 5, false)).toBe('sequential_remote')
    })

    it('should return diverged when localVersion > lastSyncedVersion and has pending changes', () => {
      expect(detectConflictType(6, 7, 5, true)).toBe('diverged')
    })
  })

  describe('when localVersion > remoteVersion', () => {
    it('should return sequential_local when remoteVersion === lastSyncedVersion', () => {
      expect(detectConflictType(7, 5, 5, false)).toBe('sequential_local')
    })

    it('should return diverged when remoteVersion > lastSyncedVersion', () => {
      expect(detectConflictType(7, 6, 5, false)).toBe('diverged')
      expect(detectConflictType(7, 6, 5, true)).toBe('diverged')
    })
  })

  describe('when localVersion === remoteVersion > lastSyncedVersion', () => {
    it('should return concurrent when has pending changes', () => {
      expect(detectConflictType(6, 6, 5, true)).toBe('concurrent')
    })

    it('should return no_conflict when no pending changes', () => {
      expect(detectConflictType(6, 6, 5, false)).toBe('no_conflict')
    })
  })

  describe('edge cases', () => {
    it('should handle version 0 correctly', () => {
      expect(detectConflictType(0, 0, 0, false)).toBe('no_conflict')
      expect(detectConflictType(0, 0, 0, true)).toBe('concurrent')
    })

    it('should handle large version differences', () => {
      expect(detectConflictType(5, 100, 5, false)).toBe('sequential_remote')
      expect(detectConflictType(100, 5, 5, false)).toBe('sequential_local')
    })

    it('should return diverged for complex divergence scenarios', () => {
      expect(detectConflictType(6, 7, 5, true)).toBe('diverged')
      expect(detectConflictType(7, 6, 5, false)).toBe('diverged')
    })
  })
})

// ===========================================================
// Batch Operations Tests (batchToOperations / queueToBatch / sendBatch)
// ===========================================================

describe('batchToOperations', () => {
  it('should convert addedNodes to add-node operations', () => {
    const batch = {
      addedNodes: [{ id: 'n1', text: 'Hello' }, { id: 'n2', text: 'World' }],
    }
    const ops = batchToOperations(batch as unknown as BatchOperations)
    expect(ops).toHaveLength(2)
    expect(ops[0]).toEqual({ operation: 'add-node', data: { id: 'n1', text: 'Hello' } })
    expect(ops[1]).toEqual({ operation: 'add-node', data: { id: 'n2', text: 'World' } })
  })

  it('should maintain order: add → update → remove within same entity type', () => {
    const batch = {
      addedNodes: [{ id: 'n1' }],
      updatedNodes: [{ id: 'n1', updates: { text: 'new' } }],
      removedNodeIds: ['n2'],
    }
    const ops = batchToOperations(batch as unknown as BatchOperations)
    expect(ops).toHaveLength(3)
    expect(ops[0].operation).toBe('add-node')
    expect(ops[1].operation).toBe('update-node')
    expect(ops[2].operation).toBe('remove-node')
  })

  it('should handle mixed entity types (nodes → groups → domains → connections)', () => {
    const batch = {
      addedNodes: [{ id: 'n1' }],
      addedGroups: [{ id: 'g1' }],
      addedDomains: [{ id: 'd1' }],
      addedConnections: [{ id: 'c1' }],
    }
    const ops = batchToOperations(batch as unknown as BatchOperations)
    expect(ops).toHaveLength(4)
    expect(ops[0].operation).toBe('add-node')
    expect(ops[1].operation).toBe('add-group')
    expect(ops[2].operation).toBe('add-domain')
    expect(ops[3].operation).toBe('add-connection')
  })

  it('should return empty array for empty batch', () => {
    const ops = batchToOperations({})
    expect(ops).toHaveLength(0)
  })

  it('should handle add + remove of same node (add before remove)', () => {
    const batch = {
      addedNodes: [{ id: 'n1', text: 'tmp' }],
      removedNodeIds: ['n1'],
    }
    const ops = batchToOperations(batch as unknown as BatchOperations)
    expect(ops).toHaveLength(2)
    expect(ops[0].operation).toBe('add-node')
    expect(ops[1].operation).toBe('remove-node')
  })

  it('should handle all 12 operation types', () => {
    const batch = {
      addedNodes: [{ id: 'n1' }],
      updatedNodes: [{ id: 'n1', updates: { text: 'x' } }],
      removedNodeIds: ['n2'],
      addedGroups: [{ id: 'g1' }],
      updatedGroups: [{ id: 'g1', updates: { name: 'x' } }],
      removedGroupIds: ['g2'],
      addedDomains: [{ id: 'd1' }],
      updatedDomains: [{ id: 'd1', updates: { label: 'x' } }],
      removedDomainIds: ['d2'],
      addedConnections: [{ id: 'c1' }],
      updatedConnections: [{ id: 'c1', updates: {} }],
      removedConnectionIds: ['c2'],
    }
    const ops = batchToOperations(batch as unknown as BatchOperations)
    expect(ops).toHaveLength(12)
  })
})

describe('queueToBatch', () => {
  it('should combine individual operations into a single BatchOperations', () => {
    const queue = [
      { operation: 'add-node', data: { id: 'n1', text: 'A' }, timestamp: 0 },
      { operation: 'update-node', data: { id: 'n1', updates: { text: 'B' } }, timestamp: 0 },
      { operation: 'remove-node', data: { id: 'n2' }, timestamp: 0 },
    ]
    const batch = queueToBatch(queue)
    expect(batch.addedNodes).toHaveLength(1)
    expect(batch.addedNodes![0].id).toBe('n1')
    expect(batch.updatedNodes).toHaveLength(1)
    expect(batch.removedNodeIds).toHaveLength(1)
  })

  it('should expand batch-operation entries', () => {
    const inner = {
      addedNodes: [{ id: 'n1', text: 'inner' }],
      updatedNodes: [{ id: 'n2', updates: { text: 'updated' } }],
    }
    const queue = [
      { operation: 'batch-operation', data: inner as unknown as BatchOperations, timestamp: 0 },
      { operation: 'remove-node', data: { id: 'n3' }, timestamp: 0 },
    ]
    const batch = queueToBatch(queue)
    expect(batch.addedNodes).toHaveLength(1)
    expect(batch.addedNodes![0].id).toBe('n1')
    expect(batch.updatedNodes).toHaveLength(1)
    expect(batch.removedNodeIds).toHaveLength(1)
    expect(batch.removedNodeIds![0]).toBe('n3')
  })

  it('should handle nested batch-operation with mixed entity types', () => {
    const inner = {
      addedNodes: [{ id: 'n1' }],
      addedGroups: [{ id: 'g1' }],
      removedConnectionIds: ['c1'],
    }
    const queue = [
      { operation: 'batch-operation', data: inner as unknown as BatchOperations, timestamp: 0 },
      { operation: 'add-domain', data: { id: 'd1' }, timestamp: 0 },
    ]
    const batch = queueToBatch(queue)
    expect(batch.addedNodes).toHaveLength(1)
    expect(batch.addedGroups).toHaveLength(1)
    expect(batch.removedConnectionIds).toHaveLength(1)
    expect(batch.addedDomains).toHaveLength(1)
  })

  it('should return empty BatchOperations fields as undefined for empty arrays', () => {
    const queue = [{ operation: 'add-node', data: { id: 'n1' }, timestamp: 0 }]
    const batch = queueToBatch(queue)
    expect(batch.addedNodes).toBeDefined()
    expect(batch.updatedNodes).toBeUndefined()
    expect(batch.removedNodeIds).toBeUndefined()
  })
})

describe('sendBatch', () => {
  it('should not send empty batch', () => {
    const ops = batchToOperations({})
    expect(ops).toHaveLength(0)
  })

  it('should preserve batch structure when queuing offline', () => {
    // 模拟 sendBatch 离线路径：将整个 batch 作为 batch-operation 入队
    const batch = {
      addedNodes: [{ id: 'n1' }],
      removedNodeIds: ['n2'],
    }
    const offlineQueue: Array<{ operation: string; data: unknown; timestamp: number }> = []

    // 离线：保留 batch 结构
    offlineQueue.push({
      operation: 'batch-operation',
      data: batch,
      timestamp: Date.now(),
    })

    expect(offlineQueue).toHaveLength(1)
    expect(offlineQueue[0].operation).toBe('batch-operation')

    // 验证重连后 queueToBatch 可正确展开
    const result = queueToBatch(offlineQueue)
    expect(result.addedNodes).toHaveLength(1)
    expect(result.addedNodes![0].id).toBe('n1')
    expect(result.removedNodeIds).toHaveLength(1)
    expect(result.removedNodeIds![0]).toBe('n2')
  })
})
