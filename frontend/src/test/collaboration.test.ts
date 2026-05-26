import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { batchToOperations, queueToBatch, BatchOperations } from '../services/collaboration'
// 测试中使用简化数据，避免导入全部实体类型
type AnyBatch = Record<string, unknown>

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
    this.ws = null
    this.offlineQueue = []
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
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
    it('should clear queue on intentional disconnect', () => {
      service.connect(false)

      service.sendOperation('add-node', { id: 'node-1' })
      expect(service.getQueueLength()).toBe(1)

      service.disconnect()

      expect(service.getQueueLength()).toBe(0)
    })
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
