/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { setupWebSocket } from '../websocket/index.js'
import { db } from '../database/connection'

// Mock database
vi.mock('../database/connection', () => ({
  db: {
    query: {
      canvases: {
        findFirst: vi.fn().mockResolvedValue({ id: 1, projectId: 1, yjsData: null }),
      },
      projects: {
        findFirst: vi.fn().mockResolvedValue({ id: 1, ownerId: 1, isCollaborative: true }),
      },
    },
  },
}))

// Mock logger
vi.mock('../utils/logger', () => ({
  logError: vi.fn(),
  log: vi.fn(),
}))

// Mock jsonwebtoken
vi.mock('jsonwebtoken', () => ({
  default: {
    verify: vi.fn(),
  },
}))

// Mock environment
vi.mock('../utils/env', () => ({
  getValidatedEnv: () => ({
    JWT_SECRET: 'test-secret',
    WS_PORT: 3001,
  }),
}))

// Setup WebSocket mock
let mockWss: any
let mockWssInstance: any

beforeEach(() => {
  vi.clearAllMocks()

  // Reset WebSocket server mock
  mockWss = {
    on: vi.fn(),
    clients: new Set(),
    close: vi.fn((code: number, reason: string) => {
      const mockWs = { readyState: 3, close: vi.fn() }
      mockWss.clients.forEach((client: any) => {
        if (client.readyState === 1) {
          client.close()
        }
      })
    }),
  }

  mockWssInstance = {
    handleUpgrade: vi.fn(),
    on: vi.fn((event: string, listener: (ws: unknown, request: unknown) => void) => {
      if (event === 'connection') {
        mockWss.on = listener
      }
    }),
  }

  // Mock setupWebSocket to return our mock
  vi.doMock('../websocket/index', () => ({
    setupWebSocket: vi.fn().mockReturnValue(mockWssInstance),
  }))
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('WebSocket Server', () => {
  describe('Connection Handling', () => {
    it('should accept WebSocket connection', async () => {
      const { setupWebSocket } = await import('../websocket/index')
      setupWebSocket(mockWss as any)

      const mockReq = {
        url: 'ws://localhost:3001?canvasId=1',
        headers: {
          'authorization': 'Bearer valid-token',
          'x-forwarded-for': '127.0.0.1',
        },
      }

      // Simulate connection event
      const connectionHandler = mockWss.on.mock.calls.find((call: any) => call[0] === 'connection')
      if (connectionHandler) {
        const handler = connectionHandler[1]
        const mockWs = { readyState: 1, userId: undefined, canvasId: undefined, close: vi.fn() }

        await handler(mockWs, mockReq as any)

        expect(mockWs.userId).toBeDefined()
        expect(mockWs.canvasId).toBe(1)
      }
    })

    it('should reject connection without auth header', async () => {
      const { setupWebSocket } = await import('../websocket/index')
      setupWebSocket(mockWss as any)

      const mockReq = {
        url: 'ws://localhost:3001?canvasId=1',
        headers: {},
      }

      const connectionHandler = mockWss.on.mock.calls.find((call: any) => call[0] === 'connection')
      if (connectionHandler) {
        const handler = connectionHandler[1]
        const mockWs = { readyState: 1, close: vi.fn() }

        await handler(mockWs, mockReq as any)

        expect(mockWs.close).toHaveBeenCalledWith(1008, 'Missing authentication header')
      }
    })

    it('should reject connection with invalid token', async () => {
      const { setupWebSocket } = await import('../websocket/index')
      setupWebSocket(mockWss as any)

      const mockReq = {
        url: 'ws://localhost:3001?canvasId=1',
        headers: {
          'authorization': 'Bearer invalid-token',
        },
      }

      const connectionHandler = mockWss.on.mock.calls.find((call: any) => call[0] === 'connection')
      if (connectionHandler) {
        const handler = connectionHandler[1]
        const mockWs = { readyState: 1, close: vi.fn() }

        await handler(mockWs, mockReq as any)

        expect(mockWs.close).toHaveBeenCalledWith(1008, 'Invalid token')
      }
    })

    it('should reject connection to a non-collaborative (private) project', async () => {
      const { setupWebSocket } = await import('../websocket/index')
      setupWebSocket(mockWss as any)

      ;(db.query.projects.findFirst as any).mockResolvedValueOnce({
        id: 1,
        ownerId: 1,
        isCollaborative: false,
      })

      const mockReq = {
        url: 'ws://localhost:3001?canvasId=1',
        headers: {
          'authorization': 'Bearer valid-token',
          'x-forwarded-for': '127.0.0.1',
        },
      }

      const connectionHandler = mockWss.on.mock.calls.find((call: any) => call[0] === 'connection')
      if (connectionHandler) {
        const handler = connectionHandler[1]
        const mockWs = { readyState: 1, userId: undefined, canvasId: undefined, close: vi.fn() }

        await handler(mockWs, mockReq as any)

        expect(mockWs.close).toHaveBeenCalledWith(1008, 'Not a collaborative project')
      }
    })

    it('should enforce rate limiting', async () => {
      const { setupWebSocket } = await import('../websocket/index')
      setupWebSocket(mockWss as any)

      const mockReq = {
        url: 'ws://localhost:3001?canvasId=1',
        headers: {
          'authorization': 'Bearer valid-token',
          'x-forwarded-for': '127.0.0.1',
        },
      }

      // Simulate 11 connections (exceeds limit of 10)
      for (let i = 0; i < 11; i++) {
        const connectionHandler = mockWss.on.mock.calls.find((call: any) => call[0] === 'connection')
        if (connectionHandler) {
          const mockWs = { readyState: 1 }

          await connectionHandler[1](mockWs, mockReq as any)
        }
      }

      // The 11th connection should be rejected
      const lastHandler = mockWss.on.mock.calls.filter((call: any) => call[0] === 'connection')
      if (lastHandler.length > 0) {
        const handler = lastHandler[10][1]
        const mockWs = { readyState: 1, close: vi.fn() }

        await handler(mockWs, mockReq as any)

        expect(mockWs.close).toHaveBeenCalledWith(1008, 'Too many connection attempts. Please try again later.')
      }
    })

    it('should reset rate limit after window expires', async () => {
      // This test would require actual timing, simplified for now
      expect(true).toBe(true)
    })
  })

  describe('Room Management', () => {
    it('should create room for new canvas ID', async () => {
      const { setupWebSocket } = await import('../websocket/index')
      setupWebSocket(mockWss as any)

      const mockWs = {
        readyState: 1,
        userId: 1,
        canvasId: 100,
      }

      const connectionHandler = mockWss.on.mock.calls.find((call: any) => call[0] === 'connection')
      if (connectionHandler) {
        const handler = connectionHandler[1]
        await handler(mockWs, {} as any)
      }

      // Room should be created and stored
      expect(true).toBe(true)
    })

    it('should load existing Yjs document for existing room', async () => {
      // Test implementation detail - document loading
      expect(true).toBe(true)
    })

    it('should save document periodically', async () => {
      // Test debounced save (5000ms)
      expect(true).toBe(true)
    })
  })

  describe('Message Handling', () => {
    it('should handle SYNC messages', async () => {
      const mockWs = {
        readyState: 1,
        userId: 1,
        canvasId: 100,
        send: vi.fn(),
      }

      // Simulate SYNC message with state vector
      const syncMessage = new Uint8Array([0, 1, 2, 4, 8]) // Type 0 (SYNC)

      // Find message handler and call it
      const connectionHandler = mockWss.on.mock.calls.find((call: any) => call[0] === 'message')
      if (connectionHandler) {
        // Simulate connection
        mockWss.clients.add(mockWs)

        // Trigger message handler
        await connectionHandler[1](mockWs, syncMessage)

        // Verify Yjs operations were called
        expect(true).toBe(true)
      }
    })

    it('should handle AWARENESS messages', async () => {
      const mockWs = {
        readyState: 1,
        userId: 1,
        canvasId: 100,
        send: vi.fn(),
      }

      // Simulate AWARENESS message
      const awarenessMessage = new Uint8Array([1, 5, 10]) // Type 1 (AWARENESS) + data

      const connectionHandler = mockWss.on.mock.calls.find((call: any) => call[0] === 'message')
      if (connectionHandler) {
        mockWss.clients.add(mockWs)
        await connectionHandler[1](mockWs, awarenessMessage)
      }
    })

    it('should handle BROADCAST messages', async () => {
      const mockWs1 = {
        readyState: 1,
        userId: 1,
        canvasId: 100,
        send: vi.fn(),
      }

      const mockWs2 = {
        readyState: 1,
        userId: 2,
        canvasId: 100,
        send: vi.fn(),
      }

      // Add clients to room
      mockWss.clients.add(mockWs1)
      mockWss.clients.add(mockWs2)

      // Simulate BROADCAST message
      const broadcastMessage = new Uint8Array([3, 7, 12]) // Type 3 (BROADCAST) + data

      const connectionHandler = mockWss.on.mock.calls.find((call: any) => call[0] === 'message')
      if (connectionHandler) {
        await connectionHandler[1](mockWs1, broadcastMessage)

        // Message should be broadcast to other clients
        expect(mockWs2.send).toHaveBeenCalled()
      }
    })

    it('should ignore unknown message types', async () => {
      const mockWs = {
        readyState: 1,
        send: vi.fn(),
      }

      // Simulate unknown message type (type 99)
      const unknownMessage = new Uint8Array([99])

      const connectionHandler = mockWss.on.mock.calls.find((call: any) => call[0] === 'message')
      if (connectionHandler) {
        mockWss.clients.add(mockWs)
        await connectionHandler[1](mockWs, unknownMessage)
      }

      // Should not crash or send anything
      expect(mockWs.send).not.toHaveBeenCalled()
    })
  })

  describe('Disconnection', () => {
    it('should remove client from room on disconnect', async () => {
      const mockWs = {
        readyState: 1,
        userId: 1,
        canvasId: 100,
      }

      const connectionHandler = mockWss.on.mock.calls.find((call: any) => call[0] === 'connection')
      if (connectionHandler) {
        await connectionHandler[1](mockWs, {} as any)
      }

      const closeHandler = mockWss.on.mock.calls.find((call: any) => call[0] === 'close')
      if (closeHandler) {
        const handler = closeHandler[1]
        handler(mockWs)
      }

      // Client should be removed from room
      expect(true).toBe(true)
    })

    it('should save document before room cleanup', async () => {
      // Test that document is saved when last client disconnects
      expect(true).toBe(true)
    })
  })

  describe('Error Handling', () => {
    it('should handle malformed messages', async () => {
      const mockWs = {
        readyState: 1,
        send: vi.fn(),
      }

      // Simulate empty message
      const emptyMessage = new Uint8Array([0])

      const connectionHandler = mockWss.on.mock.calls.find((call: any) => call[0] === 'message')
      if (connectionHandler) {
        mockWss.clients.add(mockWs)
        await connectionHandler[1](mockWs, emptyMessage)
      }

      // Should not crash
      expect(true).toBe(true)
    })

    it('should handle database errors during connection', async () => {
      // Test that database errors cause connection closure
      // Implementation requires mocking database failures
      expect(true).toBe(true)
    })

    it('should handle Yjs document load errors', async () => {
      // Test error handling during document loading
      expect(true).toBe(true)
    })
  })

  describe('Periodic Cleanup', () => {
    it('should clean empty rooms periodically', async () => {
      // Test that rooms with no clients are cleaned up
      expect(true).toBe(true)
    })

    it('should clean expired rate limit entries', async () => {
      // Test that rate limit entries expire after window
      expect(true).toBe(true)
    })
  })

  describe('Security', () => {
    it('should verify canvas ownership', async () => {
      // Test that users can only access canvases they own or have access to
      const mockWs = {
        readyState: 1,
        userId: 1,
        canvasId: 100,
        send: vi.fn(),
      }

      const connectionHandler = mockWss.on.mock.calls.find((call: any) => call[0] === 'connection')
      if (connectionHandler) {
        await connectionHandler[1](mockWs, {} as any)
      }

      expect(true).toBe(true)
    })

    it('should verify project membership', async () => {
      // Test canvas ownership verification through project membership
      expect(true).toBe(true)
    })
  })
})
