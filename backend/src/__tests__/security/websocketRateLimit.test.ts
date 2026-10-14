/**
 * websocketRateLimit — REAL implementation, driven through the real connection path.
 *
 * Replaces the deleted version of this file, which imported no project code and
 * asserted on locally-declared constants (`MAX_CONNECTIONS_PER_MINUTE = 10`,
 * a local `Map` counter). It was pure fiction: it could not fail no matter what
 * `checkWsRateLimit` in `websocket/index.ts` did.
 *
 * `checkWsRateLimit(ip)` is module-private, so this file exercises it the only
 * honest way: it registers the REAL `setupWebSocket` connection handler and
 * invokes it with real JWT-authenticated requests backed by a real in-memory
 * database, then observes the accept/reject outcome. Because the limit is
 * checked before authentication, the outcome is unambiguous — the 101st
 * connection from one IP within a minute is closed with the throttle reason and
 * receives the structured `connection_throttled` error frame.
 *
 * Each test uses its own IP and its own canvas so the module-level
 * `wsConnectionRates` / `canvasRooms` maps cannot leak state between tests.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import jwt from 'jsonwebtoken'

vi.mock('../../utils/logger.js', () => ({ log: vi.fn(), logError: vi.fn() }))

vi.mock('../../database/connection.js', async () => {
  const { installDbMock } = await import('../helpers/integration-harness.js')
  return installDbMock()
})

import {
  createTestDatabase,
  seedCanvas,
  seedProject,
  seedUser,
  setTestEnv,
  type TestDatabase,
} from '../helpers/integration-harness.js'

setTestEnv()

const { setupWebSocket } = await import('../../websocket/index.js')

/** The close reason the real limiter produces (must match websocket/index.ts). */
const THROTTLE_REASON = 'Too many connection attempts. Please try again later.'
const MAX_CONNECTIONS_PER_MINUTE = 100

interface WsRequest {
  url: string
  headers: Record<string, string>
  socket: { remoteAddress: string }
}

interface MockSocket {
  readyState: number
  on: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  ping: ReturnType<typeof vi.fn>
  terminate: ReturnType<typeof vi.fn>
  userId?: number
  canvasId?: number
  userRole?: string
}

type ConnectionHandler = (ws: WebSocket, req: WsRequest) => Promise<void>

function createMockSocket(): MockSocket {
  return {
    readyState: 1,
    on: vi.fn(),
    off: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    ping: vi.fn(),
    terminate: vi.fn(),
  }
}

describe('websocket connection rate limit (real setupWebSocket path)', () => {
  let t: TestDatabase
  let ownerId: number
  let projectId: number
  let wss: { on: ReturnType<typeof vi.fn>; clients: Set<unknown>; close: ReturnType<typeof vi.fn> }
  let handleConnection: ConnectionHandler

  beforeAll(() => {
    t = createTestDatabase()
    ownerId = seedUser(t.raw, 'ws-owner@test.com', 'hash', 'WsOwner')
    projectId = seedProject(t.raw, ownerId, 'WS Project', { isCollaborative: true })

    wss = { on: vi.fn(), clients: new Set(), close: vi.fn() }
    // The REAL setupWebSocket registers the REAL handleConnection.
    setupWebSocket(wss as unknown as WebSocketServer)

    const registration = wss.on.mock.calls.find((call) => call[0] === 'connection')
    if (!registration) throw new Error('setupWebSocket did not register a connection handler')
    handleConnection = registration[1] as ConnectionHandler
  })

  afterAll(() => {
    // Invoke the real 'close' registration so the heartbeat / flush intervals stop.
    const closeRegistration = wss.on.mock.calls.find((call) => call[0] === 'close')
    if (closeRegistration) (closeRegistration[1] as () => void)()
  })

  /** One real connection attempt from `ip` to `canvasId`, authenticated as owner. */
  async function connect(canvasId: number, ip: string): Promise<MockSocket> {
    const ws = createMockSocket()
    const token = jwt.sign({ userId: ownerId }, process.env.JWT_SECRET as string, {
      expiresIn: '1h',
    })
    const req: WsRequest = {
      url: `ws://localhost:3001?canvasId=${canvasId}`,
      headers: { authorization: `Bearer ${token}`, host: 'localhost:3001' },
      socket: { remoteAddress: ip },
    }
    await handleConnection(ws as unknown as WebSocket, req)
    return ws
  }

  function wasThrottled(ws: MockSocket): boolean {
    return ws.close.mock.calls.some(
      (call) => call[0] === 1008 && call[1] === THROTTLE_REASON,
    )
  }

  it('accepts 100 connections from one IP and throttles the 101st', async () => {
    const canvasId = seedCanvas(t.raw, projectId, 'Throttle Canvas')
    const ip = '10.0.0.1'

    const accepted: MockSocket[] = []
    for (let i = 0; i < MAX_CONNECTIONS_PER_MINUTE; i++) {
      accepted.push(await connect(canvasId, ip))
    }

    // Every one of the first 100 really got through authentication.
    expect(accepted.every((ws) => ws.userId === ownerId)).toBe(true)
    expect(accepted.some(wasThrottled)).toBe(false)

    const blocked = await connect(canvasId, ip)

    expect(blocked.userId).toBeUndefined()
    expect(wasThrottled(blocked)).toBe(true)

    // The client is told the rejection is retryable via a structured frame.
    const errorFrame = blocked.send.mock.calls
      .map((call) => call[0])
      .find((data) => typeof data === 'string' && data.includes('connection_throttled'))
    expect(errorFrame).toBeDefined()
    expect(JSON.parse(errorFrame as string)).toEqual({
      type: 'error',
      code: 'connection_throttled',
      message: THROTTLE_REASON,
    })
  }, 60_000)

  it('does not throttle a different IP after one IP saturates the window', async () => {
    const canvasId = seedCanvas(t.raw, projectId, 'Isolation Canvas')

    for (let i = 0; i < MAX_CONNECTIONS_PER_MINUTE; i++) {
      await connect(canvasId, '10.0.0.2')
    }
    const saturated = await connect(canvasId, '10.0.0.2')
    expect(wasThrottled(saturated)).toBe(true)

    // A different client IP has its own counter.
    const other = await connect(canvasId, '10.0.0.3')
    expect(wasThrottled(other)).toBe(false)
    expect(other.userId).toBe(ownerId)
  }, 60_000)

  it('allows the same IP again once the one-minute window has elapsed', async () => {
    const canvasId = seedCanvas(t.raw, projectId, 'Window Canvas')
    const ip = '10.0.0.4'

    // Fake only Date: checkWsRateLimit reads Date.now(), and faking timers would
    // interfere with the interval-driven heartbeat/flush loops.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const base = Date.now()
      for (let i = 0; i < MAX_CONNECTIONS_PER_MINUTE; i++) {
        await connect(canvasId, ip)
      }
      expect(wasThrottled(await connect(canvasId, ip))).toBe(true)

      vi.setSystemTime(base + 61_000)

      const allowed = await connect(canvasId, ip)
      expect(wasThrottled(allowed)).toBe(false)
      expect(allowed.userId).toBe(ownerId)
    } finally {
      vi.useRealTimers()
    }
  }, 60_000)
})
