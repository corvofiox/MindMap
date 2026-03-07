import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
      this.ws = { readyState: WebSocket.OPEN, send: (msg: string) => {
        this.sentMessages.push(JSON.parse(msg))
      }} as unknown as WebSocket
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
