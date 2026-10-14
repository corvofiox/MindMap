/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import {
  setupWebSocket,
  closeRoom,
  getCanvasActiveUsers,
  kickUserFromRoom,
  updateUserRole,
  _setRoomForTesting,
} from '../websocket/index.js'
import { getCanvasDoc, getCanvasJsonSnapshot } from '../websocket/canvas-state.js'
import { encodeDocToBase64 } from '../websocket/yjs-schema.js'
import { db } from '../database/connection'
import jwt from 'jsonwebtoken'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as awarenessProtocol from 'y-protocols/awareness'
import { logError } from '../utils/logger'

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

/**
 * An update exactly like a real collaborator sends: the client holds a copy of
 * the authoritative doc (received via initial STEP1/STEP2 sync), edits it
 * locally, and transmits only the diff against the server's state vector.
 * (Building an update from an INDEPENDENT fresh doc instead would re-set the
 * root['nodes'] key and lose the Yjs LWW race against the server's own map —
 * the content would integrate but stay invisible to getCanvasJsonSnapshot.)
 */
function makeSharedEditUpdate(canvasId: number, id: string, text: string): Uint8Array {
  const serverDoc = getCanvasDoc(canvasId)
  expect(serverDoc).toBeDefined()
  const clientDoc = new Y.Doc()
  Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(serverDoc!))
  const nodes = clientDoc.getMap('root').get('nodes') as Y.Map<unknown>
  const entity = new Y.Map<unknown>()
  entity.set('id', id)
  entity.set('text', text)
  nodes.set(id, entity)
  return Y.encodeStateAsUpdate(clientDoc, Y.encodeStateVector(serverDoc!))
}

/** Base64 of the whole authoritative doc — byte-identical iff untouched. */
function docBase64(canvasId: number): string {
  const doc = getCanvasDoc(canvasId)
  expect(doc).toBeDefined()
  return encodeDocToBase64(doc!)
}

/**
 * Hand-encode an awareness update in y-protocols' exact wire format:
 * [varUint numStates, (varUint clientID, varUint clock, varString JSON state)*].
 * Unlike `encodeAwarenessUpdate` (which needs matching meta entries on a real
 * Awareness instance), this lets tests transmit ARBITRARY clientIDs — which is
 * exactly what a malicious frame does when it claims someone else's identity.
 */
function encodeRawAwarenessUpdate(
  entries: { clientID: number; clock: number; state: unknown }[],
): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, entries.length)
  for (const entry of entries) {
    encoding.writeVarUint(encoder, entry.clientID)
    encoding.writeVarUint(encoder, entry.clock)
    encoding.writeVarString(encoder, JSON.stringify(entry.state))
  }
  return encoding.toUint8Array(encoder)
}

/** Wrap an awareness update in the Yjs envelope: [varUint 1, length-prefixed update]. */
function awarenessFrame(update: Uint8Array): Buffer {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 1) // AWARENESS message type
  encoding.writeVarUint8Array(encoder, update)
  return Buffer.from(encoding.toUint8Array(encoder))
}

function awarenessEntry(clientID: number, clock = 1) {
  return { clientID, clock, state: { user: { id: 1, name: 'tester' }, cursor: null } }
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

    it('should exchange the user list when a second distinct user joins', async () => {
      // First user (userId 1) joins and gets an empty room-state
      const ws1 = await connect(115, '127.0.0.100')
      const firstRoomState = ws1.send.mock.calls
        .map((call: any) => call[0])
        .find((s: any) => typeof s === 'string' && s.includes('"type":"room-state"'))
      expect(JSON.parse(firstRoomState).users).toEqual([])

      // Second distinct user (userId 2) joins
      ;(jwt as any).verify.mockReturnValue({ userId: 2 })
      ;(db.query.users.findFirst as any).mockResolvedValue({
        id: 2,
        email: 'peer@test.com',
        nickname: 'peer',
        avatar: null,
      })
      ;(db.query.projectMembers.findFirst as any).mockResolvedValue({
        id: 2,
        projectId: 1,
        userId: 2,
        role: 'editor',
      })
      const ws2 = await connect(115, '127.0.0.101')

      // The joiner receives the existing user in its room-state
      const joinerRoomState = ws2.send.mock.calls
        .map((call: any) => call[0])
        .find((s: any) => typeof s === 'string' && s.includes('"type":"room-state"'))
      expect(JSON.parse(joinerRoomState).users.map((u: any) => u.userId)).toEqual([1])

      // The already-present user is told a new user joined
      const joinNotice = ws1.send.mock.calls
        .map((call: any) => call[0])
        .find((s: any) => typeof s === 'string' && s.includes('"type":"user-join"'))
      expect(joinNotice).toBeDefined()
      expect(JSON.parse(joinNotice).user.userId).toBe(2)
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

  describe('Viewer write interception (SYNC STEP2 guard, websocket/index.ts:971-978)', () => {
    /**
     * Connect user 1 with a `viewer` role on the project's membership row.
     * The auth mock's default project is owned by userId 1 — an owner bypasses
     * the membership role entirely (userRole = 'owner'), so ownership is moved
     * to a third party for the membership row to be what decides the role.
     */
    function connectViewer(canvasId: number, ip: string) {
      ;(db.query.projects.findFirst as any).mockResolvedValue({
        id: 1,
        ownerId: 99,
        isCollaborative: true,
      })
      ;(db.query.projectMembers.findFirst as any).mockResolvedValue({
        id: 1,
        projectId: 1,
        userId: 1,
        role: 'viewer',
      })
      return connect(canvasId, ip)
    }

    it('drops a viewer SYNC STEP2 write before apply: doc untouched, no reply, no broadcast', async () => {
      const wsViewer = await connectViewer(210, '127.0.0.220')

      // A privileged peer shares the room and would receive any accepted write
      ;(db.query.projectMembers.findFirst as any).mockResolvedValue({
        id: 2,
        projectId: 1,
        userId: 2,
        role: 'editor',
      })
      ;(jwt as any).verify.mockReturnValue({ userId: 2 })
      const wsPeer = await connect(210, '127.0.0.221')
      wsViewer.send.mockClear()
      wsPeer.send.mockClear()

      expect(getCanvasJsonSnapshot(210).nodes).toEqual([])
      const bytesBefore = docBase64(210)

      // SYNC STEP2 carrying a Yjs update against the shared doc
      getMessageHandler(wsViewer)(
        encodeSyncFrame(0, 1, makeSharedEditUpdate(210, 'viewer-write', 'blocked')),
        true,
      )

      // The authoritative doc is NOT modified — the node never appears
      expect(getCanvasJsonSnapshot(210).nodes).toEqual([])
      expect(docBase64(210)).toBe(bytesBefore)
      // Lines 971-978 drop the frame SILENTLY: no error frame to the sender,
      // no reply, and no broadcast to the room. Match exactly that.
      expect(wsViewer.send).not.toHaveBeenCalled()
      expect(wsPeer.send).not.toHaveBeenCalled()
    })

    it('applies the same write from an editor — the guard is role-dependent, not a dead harness', async () => {
      // Same membership-driven role setup as the viewer, but role: 'editor'
      ;(db.query.projects.findFirst as any).mockResolvedValue({
        id: 1,
        ownerId: 99,
        isCollaborative: true,
      })
      const wsEditor = await connect(211, '127.0.0.222')

      getMessageHandler(wsEditor)(
        encodeSyncFrame(0, 1, makeSharedEditUpdate(211, 'editor-write', 'applied')),
        true,
      )

      const snapshot = getCanvasJsonSnapshot(211)
      expect(snapshot.nodes.map((n) => n.id)).toEqual(['editor-write'])
    })

    it('still answers a viewer SYNC STEP1 — read access is preserved', async () => {
      const ws = await connectViewer(212, '127.0.0.223')
      ws.send.mockClear()

      // STEP1 with an empty state vector = "send me the full doc state"
      getMessageHandler(ws)(encodeSyncFrame(0, 0, new Uint8Array([0])), true)

      expect(ws.send).toHaveBeenCalledWith(expect.any(Buffer), { binary: true })
    })

    it('blocks writes after updateUserRole demotes the connection to viewer mid-session', async () => {
      const ws = await connect(213, '127.0.0.224') // connects as editor (default mocks)

      updateUserRole(213, 1, 'viewer')
      expect((ws as { userRole?: string }).userRole).toBe('viewer')

      const bytesBefore = docBase64(213)
      await getMessageHandler(ws)(
        encodeSyncFrame(0, 1, makeSharedEditUpdate(213, 'after-demotion', 'x')),
        true,
      )

      expect(getCanvasJsonSnapshot(213).nodes).toEqual([])
      expect(docBase64(213)).toBe(bytesBefore)
    })

    it('stops writes from a user whose membership was revoked mid-session via the kick flow', async () => {
      const ws = await connect(214, '127.0.0.225') // connects as editor

      // Membership row deleted after connecting. The per-write guard reads only
      // ws.userRole (snapshotted at connect time), so the documented revocation
      // mechanism (websocket/index.ts P3, "owner 移除成员后调用") is what stops
      // the write path: kick the user's connections.
      ;(db.query.projectMembers.findFirst as any).mockResolvedValue(null)
      kickUserFromRoom(214, 1, 'removed')

      const kicked = ws.send.mock.calls
        .map((call) => call[0])
        .find((s) => typeof s === 'string' && s.includes('"type":"kicked"'))
      expect(typeof kicked).toBe('string')
      expect(JSON.parse(kicked as string)).toEqual({ type: 'kicked', reason: 'removed' })
      expect(ws.terminate).toHaveBeenCalled()
      expect(getCanvasActiveUsers(214)).toEqual([])
    })
  })

  describe('Write-path role revalidation (TTL, websocket/index.ts)', () => {
    /**
     * Role is snapshotted at connect and kept live by the REST layer pushing
     * updateUserRole/kickUserFromRoom. That covers every normal path, but
     * nothing enforced it: a direct DB change (or a future code path that
     * mutates project_members without kicking) let a revoked user keep writing.
     * Write frames now re-check the DB once the snapshot is older than the TTL.
     */
    function connectEditor(canvasId: number, ip: string) {
      ;(db.query.projects.findFirst as any).mockResolvedValue({
        id: 1,
        ownerId: 99,
        isCollaborative: true,
      })
      ;(db.query.projectMembers.findFirst as any).mockResolvedValue({
        id: 1,
        projectId: 1,
        userId: 1,
        role: 'editor',
      })
      ;(jwt as any).verify.mockReturnValue({ userId: 1 })
      return connect(canvasId, ip)
    }

    /** Age a connection's role snapshot past the revalidation TTL. */
    function expireRoleSnapshot(ws: ReturnType<typeof createMockWs>) {
      ;(ws as { roleCheckedAt?: number }).roleCheckedAt = Date.now() - 60_000
    }

    it('re-checks the DB on a write when the role snapshot is stale, and blocks after demotion', async () => {
      const ws = await connectEditor(215, '127.0.0.226')
      expireRoleSnapshot(ws)

      // The DB now says viewer — the connect-time 'editor' snapshot is stale.
      ;(db.query.projectMembers.findFirst as any).mockResolvedValue({
        id: 1,
        projectId: 1,
        userId: 1,
        role: 'viewer',
      })

      const bytesBefore = docBase64(215)
      // handleMessage returns a promise only on the revalidation path; await it
      // so the async DB check completes before asserting.
      await getMessageHandler(ws)(
        encodeSyncFrame(0, 1, makeSharedEditUpdate(215, 'stale-role-write', 'x')),
        true,
      )

      expect(getCanvasJsonSnapshot(215).nodes).toEqual([])
      expect(docBase64(215)).toBe(bytesBefore)
      // The connection's snapshot must be updated to the rechecked truth.
      expect((ws as { userRole?: string }).userRole).toBe('viewer')
    })

    it('allows the write when revalidation confirms the role is still editor', async () => {
      const ws = await connectEditor(216, '127.0.0.227')
      expireRoleSnapshot(ws)
      // DB unchanged (still editor) — revalidation must not block.
      const memberCallsBefore = (db.query.projectMembers.findFirst as any).mock.calls.length

      await getMessageHandler(ws)(
        encodeSyncFrame(0, 1, makeSharedEditUpdate(216, 'still-editor', 'ok')),
        true,
      )
      // The revalidation path applies the write after an await; give the
      // apply/broadcast chain a moment to settle (vi.waitFor polls without
      // depending on timer mode).
      await vi.waitFor(() => {
        expect(
          getCanvasJsonSnapshot(216).nodes.map((n) => n.id),
        ).toEqual(['still-editor'])
      })

      expect(getCanvasJsonSnapshot(216).nodes.map((n) => n.id)).toEqual(['still-editor'])
      // Revalidation actually happened (a fresh membership query), and the
      // snapshot was refreshed so the NEXT write within the TTL skips it.
      expect((db.query.projectMembers.findFirst as any).mock.calls.length).toBeGreaterThan(
        memberCallsBefore,
      )
      expect((ws as { roleCheckedAt?: number }).roleCheckedAt).toBeDefined()

      const callsNow = (db.query.projectMembers.findFirst as any).mock.calls.length
      await getMessageHandler(ws)(
        encodeSyncFrame(0, 1, makeSharedEditUpdate(216, 'still-editor-2', 'ok')),
        true,
      )
      expect(getCanvasJsonSnapshot(216).nodes.map((n) => n.id)).toEqual([
        'still-editor',
        'still-editor-2',
      ])
      // Second write within TTL: no further membership query.
      expect((db.query.projectMembers.findFirst as any).mock.calls.length).toBe(callsNow)
    })

    it('EVICTS the connection when revalidation finds the membership deleted', async () => {
      const ws = await connectEditor(217, '127.0.0.228')
      expireRoleSnapshot(ws)
      ;(db.query.projectMembers.findFirst as any).mockResolvedValue(null)

      await getMessageHandler(ws)(
        encodeSyncFrame(0, 1, makeSharedEditUpdate(217, 'revoked-write', 'x')),
        true,
      )

      // Refused, doc untouched.
      expect(getCanvasJsonSnapshot(217).nodes).toEqual([])
      // Evicted via the same path the REST layer uses.
      const kicked = ws.send.mock.calls
        .map((call) => call[0])
        .find((s) => typeof s === 'string' && s.includes('"type":"kicked"'))
      expect(typeof kicked).toBe('string')
      expect(JSON.parse(kicked as string)).toEqual({ type: 'kicked', reason: 'removed' })
      expect(getCanvasActiveUsers(217)).toEqual([])
    })

    it('demotion via updateUserRole does NOT trigger a redundant re-query within the TTL', async () => {
      const ws = await connectEditor(218, '127.0.0.229')

      updateUserRole(218, 1, 'viewer')
      // updateUserRole stamps the snapshot as verified — the REST layer just
      // wrote the role, so the next write must NOT re-query.
      const callsBefore = (db.query.projectMembers.findFirst as any).mock.calls.length
      await getMessageHandler(ws)(
        encodeSyncFrame(0, 1, makeSharedEditUpdate(218, 'post-demotion', 'x')),
        true,
      )
      expect(getCanvasJsonSnapshot(218).nodes).toEqual([])
      expect((db.query.projectMembers.findFirst as any).mock.calls.length).toBe(callsBefore)
    })

    it('keeps the last known role when the DB errors during revalidation (no silent data divergence)', async () => {
      const ws = await connectEditor(219, '127.0.0.230')
      expireRoleSnapshot(ws)
      ;(db.query.projectMembers.findFirst as any).mockRejectedValue(new Error('db down'))

      // Must not throw, must not evict, and the write proceeds under the last
      // known (verified-at-connect) role — silently dropping Yjs updates would
      // diverge the client's doc from the server's.
      await getMessageHandler(ws)(
        encodeSyncFrame(0, 1, makeSharedEditUpdate(219, 'db-error-write', 'ok')),
        true,
      )
      // The apply lands after the failing revalidation settles; wait for it.
      await vi.waitFor(() => {
        expect(getCanvasActiveUsers(219).length).toBeGreaterThan(0)
      })

      await vi.waitFor(() => {
        expect(getCanvasJsonSnapshot(219).nodes.map((n) => n.id)).toEqual(['db-error-write'])
      })
      expect(getCanvasActiveUsers(219).length).toBeGreaterThan(0)
    })

    it('read frames (STEP1) never trigger revalidation, even with a stale snapshot', async () => {
      const ws = await connectEditor(220, '127.0.0.231')
      expireRoleSnapshot(ws)
      const callsBefore = (db.query.projectMembers.findFirst as any).mock.calls.length

      getMessageHandler(ws)(encodeSyncFrame(0, 0, new Uint8Array([0])), true)

      expect(ws.send).toHaveBeenCalledWith(expect.any(Buffer), { binary: true })
      expect((db.query.projectMembers.findFirst as any).mock.calls.length).toBe(callsBefore)
    })

    it('refuses writes when the PROJECT row is gone — without evicting the connection (websocket/index.ts:1029)', async () => {
      const ws = await connectEditor(244, '127.0.0.265')
      expireRoleSnapshot(ws)
      ;(db.query.projects.findFirst as any).mockResolvedValue(null)
      const projectCallsBefore = (db.query.projects.findFirst as any).mock.calls.length

      await getMessageHandler(ws)(
        encodeSyncFrame(0, 1, makeSharedEditUpdate(244, 'project-gone-write', 'x')),
        true,
      )

      // The write is refused — the authoritative doc is untouched
      expect(getCanvasJsonSnapshot(244).nodes).toEqual([])
      // Revalidation actually reached the project lookup
      expect((db.query.projects.findFirst as any).mock.calls.length).toBeGreaterThan(projectCallsBefore)
      // NOT evicted — contrast with the membership-deleted branch, which kicks:
      // a vanished project row is not proof the user lost access, so the
      // connection stays open (the room teardown path closes it instead).
      const kicked = ws.send.mock.calls
        .map((call) => call[0])
        .find((s) => typeof s === 'string' && s.includes('"type":"kicked"'))
      expect(kicked).toBeUndefined()
      expect(ws.terminate).not.toHaveBeenCalled()
      expect(getCanvasActiveUsers(244).map((u) => u.userId)).toEqual([1])

      // The connection stays usable once the project row exists again: the
      // refused check did not stamp the snapshot, so the next write re-checks.
      ;(db.query.projects.findFirst as any).mockResolvedValue({
        id: 1,
        ownerId: 99,
        isCollaborative: true,
      })
      await getMessageHandler(ws)(
        encodeSyncFrame(0, 1, makeSharedEditUpdate(244, 'project-back-write', 'ok')),
        true,
      )
      await vi.waitFor(() => {
        expect(getCanvasJsonSnapshot(244).nodes.map((n) => n.id)).toEqual(['project-back-write'])
      })
    })

    it('shares one in-flight revalidation between concurrent write frames — no duplicate DB queries (websocket/index.ts:1015)', async () => {
      const ws = await connectEditor(245, '127.0.0.266')
      expireRoleSnapshot(ws)

      // Slow the project lookup so both frames provably overlap inside the
      // revalidation window (the second frame arrives before the first check
      // has resolved).
      ;(db.query.projects.findFirst as any).mockImplementationOnce(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ id: 1, ownerId: 99, isCollaborative: true }), 10),
          ),
      )
      const projectCallsBefore = (db.query.projects.findFirst as any).mock.calls.length
      const memberCallsBefore = (db.query.projectMembers.findFirst as any).mock.calls.length

      // Two write frames sent back-to-back WITHOUT awaiting the first
      const handler = getMessageHandler(ws) as unknown as (
        data: Buffer,
        isBinary: boolean,
      ) => Promise<void>
      const first = handler(encodeSyncFrame(0, 1, makeSharedEditUpdate(245, 'burst-1', 'a')), true)
      const second = handler(encodeSyncFrame(0, 1, makeSharedEditUpdate(245, 'burst-2', 'b')), true)
      await Promise.all([first, second])
      await vi.waitFor(() => {
        expect(getCanvasJsonSnapshot(245).nodes.map((n) => n.id)).toEqual(['burst-1', 'burst-2'])
      })

      // Both writes applied, but only ONE shared revalidation ran:
      // exactly one project query and one member query for the pair.
      expect((db.query.projects.findFirst as any).mock.calls.length).toBe(projectCallsBefore + 1)
      expect((db.query.projectMembers.findFirst as any).mock.calls.length).toBe(memberCallsBefore + 1)
    })
  })

  describe('Heartbeat loop (websocket/index.ts:291-330)', () => {
    const TICK_MS = 30_000 // HEARTBEAT_INTERVAL_MS
    const TIMEOUT_MS = 120_000 // HEARTBEAT_TIMEOUT_MS

    /**
     * Re-run setupWebSocket under the CURRENT (fake) timer set. The beforeEach
     * registration created its heartbeat interval on the REAL clock, which
     * never fires during fake-timer advancement; the interval created here
     * runs on the fake clock and drives the real loop.
     */
    function setupUnderFakeTimers() {
      mockWss = { on: vi.fn(), clients: new Set(), close: vi.fn() }
      setupWebSocket(mockWss as unknown as WebSocketServer)
    }

    /** Simulate an OS/browser client: every server ping is answered by a pong. */
    function answerNativePings(ws: ReturnType<typeof createMockWs>) {
      ws.ping.mockImplementation(() => {
        const pongListeners = ws.on.mock.calls.filter((call: any[]) => call[0] === 'pong')
        for (const listener of pongListeners) {
          ;(listener[1] as () => void)()
        }
      })
    }

    it('disconnects a client that never answers pings once both channels go stale', async () => {
      vi.useFakeTimers()
      try {
        setupUnderFakeTimers()
        // ping() is a silent noop → no native pong, no app ping → never fresh
        const ws = await connect(220, '127.0.0.240')

        // Ticks at 30/60/90/120s survive (strictly `>` threshold); the 150s
        // tick finds BOTH lastPong and lastAppPong past the window → killed.
        await vi.advanceTimersByTimeAsync(TIMEOUT_MS + TICK_MS)

        expect(ws.terminate).toHaveBeenCalled()
        expect(getCanvasActiveUsers(220)).toEqual([])
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps a client that answers native pings connected', async () => {
      vi.useFakeTimers()
      try {
        setupUnderFakeTimers()
        const ws = createMockWs()
        answerNativePings(ws)
        await getConnectionHandler()(ws, makeRequest(221, '127.0.0.241'))
        expect((ws as { userId?: number }).userId).toBe(1)

        await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 5 * TICK_MS)

        expect(ws.terminate).not.toHaveBeenCalled()
        expect(ws.close).not.toHaveBeenCalled()
        expect(getCanvasActiveUsers(221).map((u) => u.userId)).toEqual([1])
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps a client alive via the app-level ping channel alone', async () => {
      vi.useFakeTimers()
      try {
        setupUnderFakeTimers()
        const ws = await connect(222, '127.0.0.242')

        // The app channel alone satisfies the heartbeat: native lastPong goes
        // stale, but each tick is preceded by a {"type":"ping"} text frame that
        // refreshes lastAppPong (and is answered with a pong frame).
        for (let i = 0; i < 5; i++) {
          ws.send.mockClear()
          getMessageHandler(ws)(Buffer.from(JSON.stringify({ type: 'ping' })), false)
          const pong = ws.send.mock.calls
            .map((call) => call[0])
            .find((s) => typeof s === 'string' && s.includes('"type":"pong"'))
          expect(typeof pong).toBe('string')
          await vi.advanceTimersByTimeAsync(TICK_MS)
        }

        expect(ws.terminate).not.toHaveBeenCalled()
        expect(getCanvasActiveUsers(222).map((u) => u.userId)).toEqual([1])
      } finally {
        vi.useRealTimers()
      }
    })

    it('tears down an EMPTY room at the next heartbeat tick and allows a fresh handshake', async () => {
      vi.useFakeTimers()
      try {
        setupUnderFakeTimers()
        const awareness = new awarenessProtocol.Awareness(new Y.Doc())
        const destroySpy = vi.spyOn(awareness, 'destroy')
        _setRoomForTesting(223, {
          id: 223,
          clients: new Set(),
          activeUsers: new Map(),
          userConnectionCounts: new Map(),
          awareness,
        })

        await vi.advanceTimersByTimeAsync(TICK_MS)

        // teardownEmptyRoom ran: shared awareness destroyed, room removed.
        expect(destroySpy).toHaveBeenCalled()
        expect(getCanvasActiveUsers(223)).toEqual([])

        // A subsequent join does a fresh handshake into a newly created room.
        const ws = await connect(223, '127.0.0.243')
        expect(ws.close).not.toHaveBeenCalled()
        expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"type":"room-state"'))
        expect(getCanvasActiveUsers(223).map((u) => u.userId)).toEqual([1])
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('closeRoom (real module execution)', () => {
    it('kicks every client, terminates the sockets and removes the room', async () => {
      const ws1 = await connect(224, '127.0.0.244')
      ;(jwt as any).verify.mockReturnValue({ userId: 2 })
      const ws2 = await connect(224, '127.0.0.245')

      closeRoom(224, 'test')

      for (const ws of [ws1, ws2]) {
        const kicked = ws.send.mock.calls
          .map((call) => call[0])
          .find((s) => typeof s === 'string' && s.includes('"type":"kicked"'))
        expect(typeof kicked).toBe('string')
        expect(JSON.parse(kicked as string)).toEqual({ type: 'kicked', reason: 'test' })
        expect(ws.terminate).toHaveBeenCalled()
      }
      expect(getCanvasActiveUsers(224)).toEqual([])

      // The room is gone: a subsequent join goes through the fresh-handshake path
      ;(jwt as any).verify.mockReturnValue({ userId: 1 })
      const ws3 = await connect(224, '127.0.0.246')
      expect(ws3.close).not.toHaveBeenCalled()
      expect(ws3.send).toHaveBeenCalledWith(expect.stringContaining('"type":"room-state"'))
      expect(getCanvasActiveUsers(224).map((u) => u.userId)).toEqual([1])
    })

    it('does nothing for a canvas that has no room', () => {
      expect(() => closeRoom(987654, 'test')).not.toThrow()
      expect(getCanvasActiveUsers(987654)).toEqual([])
    })
  })

  describe('Awareness anti-hijack guards (websocket/index.ts:1198-1237)', () => {
    const range = (start: number, count: number) => Array.from({ length: count }, (_, i) => start + i)
    const bindingOf = (ws: ReturnType<typeof createMockWs>) =>
      (ws as { awarenessClientIds?: number[] }).awarenessClientIds

    it('drops a single frame carrying more than 64 clientIDs (silent: no bind, no broadcast, no close)', async () => {
      const ws = await connect(230, '127.0.0.250')
      const peer = await connect(230, '127.0.0.251')
      ws.send.mockClear()
      peer.send.mockClear()

      // MAX_AWARENESS_CLIENT_IDS_PER_FRAME (64) + 1, all new ids
      const update = encodeRawAwarenessUpdate(range(900_000, 65).map((id) => awarenessEntry(id)))
      getMessageHandler(ws)(awarenessFrame(update), true)

      // The whole frame is dropped: nothing bound on the connection
      expect(bindingOf(ws)).toBeUndefined()
      // Nothing applied/broadcast into the room, and the connection is untouched
      expect(peer.send).not.toHaveBeenCalled()
      expect(ws.send).not.toHaveBeenCalled()
      expect(ws.close).not.toHaveBeenCalled()
    })

    it('accepts a frame with exactly 64 clientIDs — the cap is the documented constant, not a dead harness', async () => {
      const ws = await connect(231, '127.0.0.252')
      const peer = await connect(231, '127.0.0.253')
      ws.send.mockClear()
      peer.send.mockClear()

      const ids = range(901_000, 64)
      const update = encodeRawAwarenessUpdate(ids.map((id) => awarenessEntry(id)))
      getMessageHandler(ws)(awarenessFrame(update), true)

      expect([...(bindingOf(ws) ?? [])].sort((a, b) => a - b)).toEqual(ids)
      // The accepted update is applied and re-broadcast to the room
      expect(peer.send).toHaveBeenCalledWith(expect.any(Buffer), { binary: true })
    })

    it('rejects a frame that claims a clientID already bound to ANOTHER connection', async () => {
      const ws1 = await connect(232, '127.0.0.254')
      const claimed = 902_000
      getMessageHandler(ws1)(
        awarenessFrame(encodeRawAwarenessUpdate([awarenessEntry(claimed)])),
        true,
      )
      expect(bindingOf(ws1)).toEqual([claimed])

      // A second user's connection tries to claim the first user's clientID
      ;(jwt as any).verify.mockReturnValue({ userId: 2 })
      const ws2 = await connect(232, '127.0.0.255')
      ws1.send.mockClear()

      getMessageHandler(ws2)(
        awarenessFrame(
          encodeRawAwarenessUpdate([{ clientID: claimed, clock: 2, state: { user: { id: 2, name: 'hijacker' } } }]),
        ),
        true,
      )

      // Silent rejection: nothing bound on the hijacker's connection,
      // nothing broadcast to the room, connection left open.
      expect(bindingOf(ws2)).toBeUndefined()
      expect(ws1.send).not.toHaveBeenCalled()
      expect(ws2.close).not.toHaveBeenCalled()

      // The same connection can still bind a fresh clientID of its own —
      // proving the rejection was the identity guard, not a broken channel.
      getMessageHandler(ws2)(
        awarenessFrame(encodeRawAwarenessUpdate([awarenessEntry(902_001)])),
        true,
      )
      expect(bindingOf(ws2)).toEqual([902_001])
    })

    it('caps the cumulative clientIDs per connection at 64: overflowing frames rejected, binding unchanged', async () => {
      const ws = await connect(233, '127.0.0.256')
      const peer = await connect(233, '127.0.0.257')

      // 60 ids accepted
      getMessageHandler(ws)(
        awarenessFrame(encodeRawAwarenessUpdate(range(903_000, 60).map((id) => awarenessEntry(id)))),
        true,
      )
      expect(bindingOf(ws)?.length).toBe(60)

      // +5 NEW ids → 65 cumulative > 64 → the whole frame is dropped
      peer.send.mockClear()
      getMessageHandler(ws)(
        awarenessFrame(encodeRawAwarenessUpdate(range(903_100, 5).map((id) => awarenessEntry(id)))),
        true,
      )
      expect(bindingOf(ws)?.length).toBe(60)
      expect(peer.send).not.toHaveBeenCalled()

      // +4 new ids → exactly 64 cumulative → accepted
      getMessageHandler(ws)(
        awarenessFrame(encodeRawAwarenessUpdate(range(903_200, 4).map((id) => awarenessEntry(id)))),
        true,
      )
      expect(bindingOf(ws)?.length).toBe(64)

      // The cap is PER-CONNECTION, not global: a fresh connection can still
      // bind one of the ids this connection never successfully claimed.
      ;(jwt as any).verify.mockReturnValue({ userId: 2 })
      const ws2 = await connect(233, '127.0.0.258')
      getMessageHandler(ws2)(
        awarenessFrame(encodeRawAwarenessUpdate([awarenessEntry(903_101)])),
        true,
      )
      expect(bindingOf(ws2)).toEqual([903_101])
    })
  })

  describe('Per-connection message rate limits and frame size cap (websocket/index.ts:24-26,249,881-942)', () => {
    it('drops SYNC frames beyond 50/s with a structured rate_limited error frame and close', async () => {
      const ws = await connect(240, '127.0.0.260')
      ws.send.mockClear()

      const step1 = encodeSyncFrame(0, 0, new Uint8Array([0]))
      for (let i = 0; i < 50; i++) {
        getMessageHandler(ws)(step1, true)
      }
      // SYNC_RATE_LIMIT = 50: every frame inside the window is answered
      const binaryReplies = ws.send.mock.calls.filter((call) => typeof call[0] !== 'string')
      expect(binaryReplies.length).toBe(50)

      // The 51st frame in the same window is refused, not processed
      getMessageHandler(ws)(step1, true)
      expect(ws.send.mock.calls.filter((call) => typeof call[0] !== 'string').length).toBe(50)
      const errorFrame = ws.send.mock.calls.map((call) => call[0]).find((s) => typeof s === 'string')
      expect(JSON.parse(errorFrame as string)).toEqual({
        type: 'error',
        code: 'rate_limited',
        message: 'rate limited',
      })
      expect(ws.close).toHaveBeenCalledWith(1008, 'rate limited')
    })

    it('drops AWARENESS frames beyond 200/s', async () => {
      const ws = await connect(241, '127.0.0.261')
      ws.send.mockClear()

      // Reuse ONE clientID across all frames so the per-connection clientID
      // cap (64) is not what stops the flood — the awareness window is.
      const update = awarenessFrame(encodeRawAwarenessUpdate([awarenessEntry(910_000)]))
      for (let i = 0; i < 200; i++) {
        getMessageHandler(ws)(update, true)
      }
      // All 200 inside the window were processed (no error frames)
      expect(ws.send).not.toHaveBeenCalled()
      expect((ws as { awarenessClientIds?: number[] }).awarenessClientIds).toEqual([910_000])

      // The 201st is refused
      getMessageHandler(ws)(update, true)
      const errorFrame = ws.send.mock.calls.map((call) => call[0]).find((s) => typeof s === 'string')
      expect(JSON.parse(errorFrame as string)).toEqual({
        type: 'error',
        code: 'rate_limited',
        message: 'rate limited',
      })
      expect(ws.close).toHaveBeenCalledWith(1008, 'rate limited')
    })

    it('drops TEXT frames beyond 30/s', async () => {
      const ws = await connect(242, '127.0.0.262')
      ws.send.mockClear()

      const ping = Buffer.from(JSON.stringify({ type: 'ping' }))
      for (let i = 0; i < 30; i++) {
        getMessageHandler(ws)(ping, false)
      }
      // TEXT_RATE_LIMIT = 30: each ping inside the window is answered with a pong
      const pongs = ws.send.mock.calls
        .map((call) => call[0])
        .filter((s) => typeof s === 'string' && (s as string).includes('"type":"pong"'))
      expect(pongs.length).toBe(30)

      // The 31st is refused with the structured code
      getMessageHandler(ws)(ping, false)
      const pongsAfter = ws.send.mock.calls
        .map((call) => call[0])
        .filter((s) => typeof s === 'string' && (s as string).includes('"type":"pong"'))
      expect(pongsAfter.length).toBe(30)
      const errorFrame = ws.send.mock.calls
        .map((call) => call[0])
        .find((s) => typeof s === 'string' && (s as string).includes('"code":"rate_limited"'))
      expect(typeof errorFrame).toBe('string')
      expect(ws.close).toHaveBeenCalledWith(1008, 'rate limited')
    })

    it('silently drops a binary frame larger than 5MB: no close, no reply, doc untouched — and the connection stays usable', async () => {
      const ws = await connect(243, '127.0.0.263')
      const peer = await connect(243, '127.0.0.264')
      ws.send.mockClear()
      peer.send.mockClear()
      const bytesBefore = docBase64(243)

      // WS_MAX_MESSAGE_BYTES = 5MB; the envelope + length prefix push the frame past it
      const frame = encodeSyncFrame(0, 1, new Uint8Array(5 * 1024 * 1024))
      expect(frame.length).toBeGreaterThan(5 * 1024 * 1024)
      getMessageHandler(ws)(frame, true)

      expect(logError).toHaveBeenCalledWith(
        'WebSocket message exceeds size limit, dropping',
        expect.objectContaining({ canvasId: 243 }),
      )
      expect(docBase64(243)).toBe(bytesBefore)
      expect(peer.send).not.toHaveBeenCalled()
      expect(ws.send).not.toHaveBeenCalled()
      expect(ws.close).not.toHaveBeenCalled()

      // A normal-sized write on the same connection still applies afterwards
      getMessageHandler(ws)(encodeSyncFrame(0, 1, makeSharedEditUpdate(243, 'after-oversize', 'ok')), true)
      await vi.waitFor(() => {
        expect(getCanvasJsonSnapshot(243).nodes.map((n) => n.id)).toEqual(['after-oversize'])
      })
    })
  })

  describe('Cursor text-frame broadcast (websocket/index.ts:955-956,1349)', () => {
    it('relays a cursor frame to every OTHER connection in the room and never echoes it to the sender', async () => {
      const sender = await connect(301, '127.0.0.301')
      const peerA = await connect(301, '127.0.0.302')
      const peerB = await connect(301, '127.0.0.303')
      sender.send.mockClear()
      peerA.send.mockClear()
      peerB.send.mockClear()

      const cursor = Buffer.from(JSON.stringify({ type: 'cursor', userId: 1, x: 120, y: 80 }))
      getMessageHandler(sender)(cursor, false)

      const cursorFrames = (client: (typeof peerA)) =>
        client.send.mock.calls
          .map((call: any[]) => call[0])
          .filter((s: unknown) => typeof s === 'string' && (s as string).includes('"type":"cursor"'))
          .map((s: string) => JSON.parse(s))
      // Both roommates receive the exact cursor payload, sender is excluded.
      expect(cursorFrames(peerA)).toEqual([{ type: 'cursor', userId: 1, x: 120, y: 80 }])
      expect(cursorFrames(peerB)).toEqual([{ type: 'cursor', userId: 1, x: 120, y: 80 }])
      expect(cursorFrames(sender)).toEqual([])
      // A cursor relay is informational: nobody gets rate-limited or closed for it.
      expect(sender.close).not.toHaveBeenCalled()
      expect(peerA.close).not.toHaveBeenCalled()
      expect(peerB.close).not.toHaveBeenCalled()
    })
  })

  describe('Retryable error-code contract (frontend yjsProvider RETRYABLE_ERROR_CODES)', () => {
    // frontend/src/services/yjsProvider.ts decides "retry vs permanent" by EXACT
    // string match on the error frame's `code` (['rate_limited','connection_throttled',
    // 'auth_retryable']). Renaming the backend strings silently turns every
    // recoverable 1008 into a permanent rejection and kills auto-reconnect.
    // ('connection_throttled' is pinned in websocketRateLimit.test.ts,
    // 'rate_limited' in the rate-limit suite above.)
    function errorFrameOf(ws: ReturnType<typeof createMockWs>): Record<string, unknown> {
      const raw = ws.send.mock.calls.map((call) => call[0]).find((s) => typeof s === 'string')
      expect(typeof raw).toBe('string')
      return JSON.parse(raw as string)
    }

    it('sends code "auth_retryable" (exact string) when the token is missing', async () => {
      const ws = createMockWs()
      await getConnectionHandler()(ws, {
        url: 'ws://localhost:3001?canvasId=1',
        headers: {},
        socket: { remoteAddress: '127.0.0.270' },
      })

      expect(errorFrameOf(ws)).toEqual({
        type: 'error',
        code: 'auth_retryable',
        message: 'Missing authentication',
      })
      expect(ws.close).toHaveBeenCalledWith(1008, 'Missing authentication')
    })

    it('sends code "auth_retryable" (exact string) when the token is invalid', async () => {
      ;(jwt as any).verify.mockImplementationOnce(() => {
        throw new Error('jwt expired')
      })
      const ws = await connect(246, '127.0.0.271')

      expect(errorFrameOf(ws).code).toBe('auth_retryable')
      expect(ws.close).toHaveBeenCalledWith(1008, 'Invalid token')
    })
  })
})
