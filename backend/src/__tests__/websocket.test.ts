/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { setupWebSocket } from '../websocket/index.js'
import { db } from '../database/connection'
import jwt from 'jsonwebtoken'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as awarenessProtocol from 'y-protocols/awareness'

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
      projectMembers: {
        findFirst: vi.fn().mockResolvedValue({ id: 1, projectId: 1, userId: 1, role: 'editor' }),
      },
      users: {
        findFirst: vi.fn().mockResolvedValue({ id: 1, email: 'test@test.com', nickname: 'tester', avatar: null }),
      },
    },
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
  },
}))

// Mock logger
vi.mock('../utils/logger', () => ({
  logError: vi.fn(),
  log: vi.fn(),
}))

// Mock jsonwebtoken — default: a valid token for userId 1
vi.mock('jsonwebtoken', () => ({
  default: {
    verify: vi.fn(() => ({ userId: 1 })),
  },
}))

// Mock environment
vi.mock('../utils/env', () => ({
  getValidatedEnv: () => ({
    JWT_SECRET: 'test-secret',
    WS_PORT: 3001,
  }),
  // TRUST_PROXY unset → getClientIp uses socket.remoteAddress (tests set it)
  isTrustProxyEnabled: () => false,
}))

// The REAL setupWebSocket registers `wss.on('connection', handleConnection)`.
// `mockWss.on` records that registration so each test can pull the actual
// connection handler and exercise the real auth / authorization / room logic.
// (No vi.doMock stub: previously the stub never registered the handler, which
// made every `mockWss.on.mock.calls.find(...)` return undefined and skipped
// the whole assertion block — 22 tests ran with 0 assertions.)
let mockWss: any

beforeEach(() => {
  vi.clearAllMocks()

  // Re-establish default implementations explicitly so each test is
  // independent of once/throw overrides left by earlier tests.
  ;(jwt as any).verify.mockReturnValue({ userId: 1 })
  ;(db.query.canvases.findFirst as any).mockResolvedValue({ id: 1, projectId: 1, yjsData: null })
  ;(db.query.projects.findFirst as any).mockResolvedValue({ id: 1, ownerId: 1, isCollaborative: true })
  ;(db.query.projectMembers.findFirst as any).mockResolvedValue({ id: 1, projectId: 1, userId: 1, role: 'editor' })
  ;(db.query.users.findFirst as any).mockResolvedValue({ id: 1, email: 'test@test.com', nickname: 'tester', avatar: null })

  mockWss = {
    on: vi.fn(),
    clients: new Set(),
    close: vi.fn(),
  }
  // Real registration — the connection handler below is the production one.
  setupWebSocket(mockWss as unknown as WebSocketServer)
})

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getConnectionHandler(): (ws: any, req: any) => Promise<void> {
  const registration = mockWss.on.mock.calls.find((call: any) => call[0] === 'connection')
  expect(registration).toBeDefined()
  return registration[1]
}

function makeRequest(canvasId: number, ip: string, headers: Record<string, string> = {}) {
  return {
    url: `ws://localhost:3001?canvasId=${canvasId}`,
    headers: {
      authorization: 'Bearer valid-token',
      'x-forwarded-for': ip,
      ...headers,
    },
    socket: { remoteAddress: ip },
  }
}

function createMockWs(overrides: Record<string, unknown> = {}) {
  return {
    readyState: 1,
    on: vi.fn(),
    off: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    ping: vi.fn(),
    terminate: vi.fn(),
    ...overrides,
  }
}

/** Run the real connection handler with a fresh mock socket. */
async function connect(canvasId: number, ip: string, overrides: Record<string, unknown> = {}) {
  const ws = createMockWs(overrides)
  await getConnectionHandler()(ws, makeRequest(canvasId, ip))
  return ws
}

/** The real per-connection message handler is the LAST 'message' registration. */
function getMessageHandler(ws: any): (data: Buffer, isBinary: boolean) => void {
  const registrations = ws.on.mock.calls.filter((call: any) => call[0] === 'message')
  expect(registrations.length).toBeGreaterThan(0)
  return registrations[registrations.length - 1][1]
}

/** The real disconnect handler is the LAST 'close' registration. */
function getCloseHandler(ws: any): () => void {
  const registrations = ws.on.mock.calls.filter((call: any) => call[0] === 'close')
  expect(registrations.length).toBeGreaterThan(0)
  return registrations[registrations.length - 1][1]
}

/** Encode a Yjs sync-protocol frame: [messageType varUint, subType?, payload...]. */
function encodeSyncFrame(messageType: number, subType: number | null, payload?: Uint8Array): Buffer {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageType)
  if (subType !== null) {
    encoding.writeVarUint(encoder, subType)
  }
  encoding.writeVarUint8Array(encoder, payload ?? new Uint8Array(0))
  return Buffer.from(encoding.toUint8Array(encoder))
}

/** A small Yjs doc update that touches the shared 'nodes' map. */
function makeNodesUpdate(text: string): Uint8Array {
  const doc = new Y.Doc()
  doc.getMap('nodes').set('n1', { text })
  return Y.encodeStateAsUpdate(doc)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebSocket Server', () => {
  describe('Connection Handling', () => {
    it('should accept WebSocket connection', async () => {
      const ws = await connect(1, '127.0.0.1')

      expect(ws.userId).toBe(1)
      expect(ws.canvasId).toBe(1)
      expect(ws.close).not.toHaveBeenCalled()
      // A successful join sends the room-state message (after doc load)
      expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"type":"room-state"'))
    })

    it('should reject connection without auth header', async () => {
      const ws = createMockWs()
      await getConnectionHandler()(ws, {
        url: 'ws://localhost:3001?canvasId=1',
        headers: {},
        socket: { remoteAddress: '127.0.0.2' },
      })

      expect(ws.close).toHaveBeenCalledWith(1008, 'Missing authentication')
      expect(ws.userId).toBeUndefined()
    })

    it('should reject connection with invalid token', async () => {
      ;(jwt as any).verify.mockImplementationOnce(() => {
        throw new Error('jwt expired')
      })
      const ws = await connect(1, '127.0.0.3')

      expect(ws.close).toHaveBeenCalledWith(1008, 'Invalid token')
    })

    it('should reject connection to a non-collaborative (private) project', async () => {
      ;(db.query.projects.findFirst as any).mockResolvedValueOnce({
        id: 1,
        ownerId: 1,
        isCollaborative: false,
      })
      const ws = await connect(1, '127.0.0.4')

      expect(ws.close).toHaveBeenCalledWith(1008, 'Not a collaborative project')
    })

    it('should enforce rate limiting', async () => {
      const ip = '127.0.0.50'
      // The per-IP window allows 100 connections/minute — saturate it.
      for (let i = 0; i < 100; i++) {
        await connect(1, ip)
      }

      // The 101st connection from the same IP is rejected
      const rejected = await connect(1, ip)
      expect(rejected.close).toHaveBeenCalledWith(1008, 'Too many connection attempts. Please try again later.')
    })

    it('should reset rate limit after window expires', async () => {
      vi.useFakeTimers()
      try {
        const ip = '127.0.0.60'
        for (let i = 0; i < 100; i++) {
          await connect(1, ip)
        }
        const rejected = await connect(1, ip)
        expect(rejected.close).toHaveBeenCalledWith(1008, 'Too many connection attempts. Please try again later.')

        // Advance past the 60s window — the entry expires and the IP is allowed again
        await vi.advanceTimersByTimeAsync(60_001)
        const accepted = await connect(1, ip)
        expect(accepted.close).not.toHaveBeenCalledWith(1008, 'Too many connection attempts. Please try again later.')
        expect(accepted.userId).toBe(1)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('Room Management', () => {
    it('should create room for new canvas ID', async () => {
      const ws = await connect(100, '127.0.0.70')

      expect(ws.userId).toBe(1)
      expect(ws.canvasId).toBe(100)
      expect(ws.close).not.toHaveBeenCalled()
      const roomStateCall = ws.send.mock.calls.find(
        (call: any) => typeof call[0] === 'string' && call[0].includes('"type":"room-state"')
      )
      expect(roomStateCall).toBeDefined()
    })

    it('should load existing Yjs document for existing room', async () => {
      await connect(101, '127.0.0.71')

      // loadCanvasStateFromDb reads the canvas row (connection lookup + doc load)
      expect(db.query.canvases.findFirst).toHaveBeenCalled()

      // A second connection reuses the loaded doc and joins the existing room
      const ws2 = await connect(101, '127.0.0.72')
      expect(ws2.canvasId).toBe(101)
      expect(ws2.close).not.toHaveBeenCalled()
    })

    it('should save document periodically', async () => {
      const ws = await connect(102, '127.0.0.73')

      // Apply a real Yjs update so the in-memory doc becomes dirty — the
      // update listener schedules a debounced persist (100ms)
      getMessageHandler(ws)(encodeSyncFrame(0, 1, makeNodesUpdate('hello')), true)

      await vi.waitFor(
        () => {
          expect(db.update).toHaveBeenCalled()
        },
        { timeout: 2000 }
      )
    })
  })

  describe('Message Handling', () => {
    it('should handle SYNC messages', async () => {
      const ws = await connect(103, '127.0.0.74')

      // SYNC STEP1 with an empty state vector = "send me the full doc state"
      // (an empty state vector encodes as [0]: varUint size 0)
      getMessageHandler(ws)(encodeSyncFrame(0, 0, new Uint8Array([0])), true)

      // The server replies with a binary STEP2 frame
      expect(ws.send).toHaveBeenCalledWith(expect.any(Buffer), { binary: true })
    })

    it('should handle AWARENESS messages', async () => {
      const ws = await connect(104, '127.0.0.75')

      const awareness = new awarenessProtocol.Awareness(new Y.Doc())
      awareness.setLocalState({ user: { id: 1, name: 'tester' }, cursor: null })
      const update = awarenessProtocol.encodeAwarenessUpdate(awareness, [awareness.clientID])
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, 1) // AWARENESS
      encoding.writeVarUint8Array(encoder, update)
      getMessageHandler(ws)(Buffer.from(encoding.toUint8Array(encoder)), true)

      // The sender's awareness clientID is bound to the connection
      expect(ws.awarenessClientIds).toContain(awareness.clientID)
    })

    it('should broadcast Yjs updates to other clients in the room', async () => {
      const ws1 = await connect(105, '127.0.0.76')
      const ws2 = await connect(105, '127.0.0.77')
      ws2.send.mockClear()

      // Client 1 sends a SYNC STEP2 (update) — it must be broadcast to client 2
      getMessageHandler(ws1)(encodeSyncFrame(0, 1, makeNodesUpdate('broadcast-me')), true)

      expect(ws2.send).toHaveBeenCalledWith(expect.any(Buffer), { binary: true })
      // The sender itself is excluded from the broadcast
      expect(ws1.send).not.toHaveBeenCalledWith(expect.any(Buffer), { binary: true })
    })

    it('should ignore unknown message types', async () => {
      const ws = await connect(106, '127.0.0.78')
      ws.send.mockClear()

      getMessageHandler(ws)(Buffer.from(new Uint8Array([99])), true)

      expect(ws.send).not.toHaveBeenCalled()
      expect(ws.close).not.toHaveBeenCalled()
    })
  })

  describe('Disconnection', () => {
    it('should remove client from room on disconnect', async () => {
      const ws1 = await connect(107, '127.0.0.79')
      ;(jwt as any).verify.mockReturnValue({ userId: 2 })
      const ws2 = await connect(107, '127.0.0.80')
      ws2.send.mockClear()

      getCloseHandler(ws1)()

      // The remaining client is notified that the other user left the room
      expect(ws2.send).toHaveBeenCalledWith(expect.stringContaining('"type":"user-leave"'))
    })

    it('should save document before room cleanup', async () => {
      const ws = await connect(108, '127.0.0.81')

      // Dirty the in-memory doc so teardown must persist it
      getMessageHandler(ws)(encodeSyncFrame(0, 1, makeNodesUpdate('dirty')), true)

      // Disconnect the only client — room teardown flushes the dirty doc
      getCloseHandler(ws)()

      await vi.waitFor(
        () => {
          expect(db.update).toHaveBeenCalled()
        },
        { timeout: 2000 }
      )
    })
  })

  describe('Error Handling', () => {
    it('should handle malformed messages', async () => {
      const ws = await connect(109, '127.0.0.82')
      ws.send.mockClear()

      // SYNC frame with no sub-protocol payload — must not crash or send
      getMessageHandler(ws)(Buffer.from(new Uint8Array([0])), true)

      expect(ws.send).not.toHaveBeenCalled()
      expect(ws.close).not.toHaveBeenCalled()
    })

    it('should handle database errors during connection', async () => {
      ;(db.query.canvases.findFirst as any).mockRejectedValueOnce(new Error('db down'))
      const ws = await connect(110, '127.0.0.83')

      expect(ws.close).toHaveBeenCalledWith(1011, 'Internal server error')
    })

    it('should handle Yjs document load errors', async () => {
      // Connection's canvas lookup succeeds, but the doc load (2nd findFirst) fails
      ;(db.query.canvases.findFirst as any).mockResolvedValueOnce({ id: 1, projectId: 1, yjsData: null })
      ;(db.query.canvases.findFirst as any).mockRejectedValueOnce(new Error('corrupt yjs update'))
      const ws = await connect(111, '127.0.0.84')

      expect(ws.close).toHaveBeenCalledWith(1011, 'Internal server error')
    })
  })

  describe('Periodic Cleanup', () => {
    it('should clean empty rooms periodically', async () => {
      const ws = await connect(112, '127.0.0.85')
      const callsBefore = (db.query.canvases.findFirst as any).mock.calls.length

      // Disconnect the only client — the empty room is torn down (state removed)
      getCloseHandler(ws)()

      // A reconnect creates a fresh room and reloads the doc from db —
      // only possible if the previous empty room/state was actually cleaned
      const ws2 = await connect(112, '127.0.0.86')
      expect(ws2.canvasId).toBe(112)
      expect(ws2.close).not.toHaveBeenCalled()
      expect((db.query.canvases.findFirst as any).mock.calls.length).toBeGreaterThan(callsBefore + 1)
    })

    it('should clean expired rate limit entries', async () => {
      vi.useFakeTimers()
      try {
        const ip = '127.0.0.90'
        for (let i = 0; i < 100; i++) {
          await connect(1, ip)
        }
        const rejected = await connect(1, ip)
        expect(rejected.close).toHaveBeenCalledWith(1008, 'Too many connection attempts. Please try again later.')

        // The heartbeat prune loop removes entries past their window
        await vi.advanceTimersByTimeAsync(60_001)
        const accepted = await connect(1, ip)
        expect(accepted.close).not.toHaveBeenCalled()
        expect(accepted.userId).toBe(1)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('Security', () => {
    it('should verify canvas ownership', async () => {
      // A user who is neither the project owner nor a member is denied
      ;(jwt as any).verify.mockReturnValue({ userId: 2 })
      ;(db.query.projectMembers.findFirst as any).mockResolvedValueOnce(null)
      const ws = await connect(113, '127.0.0.91')

      expect(ws.close).toHaveBeenCalledWith(1008, 'Access denied')
    })

    it('should verify project membership', async () => {
      // A non-owner who is a project member is granted access
      ;(jwt as any).verify.mockReturnValue({ userId: 2 })
      const ws = await connect(114, '127.0.0.92')

      expect(ws.userId).toBe(2)
      expect(ws.canvasId).toBe(114)
      expect(ws.close).not.toHaveBeenCalled()
    })
  })
})
