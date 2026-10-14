/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
/**
 * getClientIp rightmost-entry semantics (websocket/index.ts:513-529).
 *
 * The function is module-private; it is exercised through the REAL connection
 * path (setupWebSocket → handleConnection) and observed through the only thing
 * the resolved IP feeds: the per-IP connection throttle (100/min, shared
 * bucket). Whoever's identity ends up as the bucket key is the clientIp.
 *
 * Unlike websocket.test.ts, utils/env is NOT mocked here — isTrustProxyEnabled
 * reads process.env.TRUST_PROXY live, and these tests toggle it for real.
 * jsonwebtoken is real too: tokens are signed with the secret the real
 * getValidatedEnv() hands to the verifier. Assertions are written inline in
 * each test (test-quality-guard scans block bodies for literal expects).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import jwt from 'jsonwebtoken'

// getValidatedEnv() requires JWT_SECRET, JWT_EXPIRES_IN, PORT, WS_PORT,
// DB_FILE and ALLOWED_ORIGINS (getEnv defaults to required); the auth
// try/catch would otherwise surface the env error as 'Invalid token'.
// NODE_ENV is provided by vitest itself.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'getclientip-test-secret'
process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '1h'
process.env.PORT = process.env.PORT ?? '3097'
process.env.WS_PORT = process.env.WS_PORT ?? '3197'
process.env.DB_FILE = process.env.DB_FILE ?? ':memory:'
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173'
const TEST_SECRET = process.env.JWT_SECRET

vi.mock('../database/connection.js', () => ({
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
vi.mock('../utils/logger.js', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}))

import { setupWebSocket } from '../websocket/index.js'

const TOKEN = jwt.sign({ userId: 1 }, TEST_SECRET, { expiresIn: '1h' })
const THROTTLE_REASON = 'Too many connection attempts. Please try again later.'

let mockWss: { on: any; clients: Set<unknown>; close: any }

function getConnectionHandler(): (ws: any, req: any) => Promise<void> {
  const registration = mockWss.on.mock.calls.find((call: any[]) => call[0] === 'connection')
  expect(registration).toBeDefined()
  return registration[1]
}

function createMockWs() {
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

function makeRequest(canvasId: number, remoteAddress: string, xff?: string) {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }
  if (xff !== undefined) headers['x-forwarded-for'] = xff
  return {
    url: `ws://localhost:3001?canvasId=${canvasId}`,
    headers,
    socket: { remoteAddress },
  }
}

async function connect(canvasId: number, remoteAddress: string, xff?: string) {
  const ws = createMockWs()
  await getConnectionHandler()(ws, makeRequest(canvasId, remoteAddress, xff))
  return ws
}

describe('getClientIp semantics via the per-IP connection throttle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.TRUST_PROXY
    mockWss = { on: vi.fn(), clients: new Set(), close: vi.fn() }
    setupWebSocket(mockWss as unknown as WebSocketServer)
  })

  afterEach(() => {
    delete process.env.TRUST_PROXY
  })

  afterAll(() => {
    // Stop the heartbeat/flush intervals registered by setupWebSocket
    const closeRegistration = mockWss.on.mock.calls.find((call: any[]) => call[0] === 'close')
    if (closeRegistration) closeRegistration[1]()
  })

  it('ignores X-Forwarded-For by default (TRUST_PROXY unset): the bucket key is socket.remoteAddress, so a spoofed header cannot share or evade a bucket', async () => {
    // 100 connections from the SAME real address, each claiming a DIFFERENT
    // spoofed proxy chain. If the header were trusted they would spread over
    // 100 distinct buckets — instead they all land in one remoteAddress bucket.
    for (let i = 0; i < 100; i++) {
      const ws = await connect(300, '10.0.0.7', `10.9.${i}.1, 1.2.3.4`)
      // fully accepted: no close at all (not throttled, not auth-rejected)
      expect(ws.close).not.toHaveBeenCalled()
    }

    // The 101st connection from that address throttles even though its spoofed
    // header has never been seen before — header novelty cannot evade the bucket.
    const throttled = await connect(300, '10.0.0.7', 'never-seen.example, 1.2.3.4')
    expect(throttled.close).toHaveBeenCalledWith(1008, THROTTLE_REASON)

    // A new real address presenting the SAME header as earlier connections is
    // accepted: header content never keyed a bucket of its own.
    const fresh = await connect(300, '10.9.9.9', '10.9.0.1, 1.2.3.4')
    expect(fresh.close).not.toHaveBeenCalled()
  })

  it('with TRUST_PROXY enabled, the RIGHTMOST X-Forwarded-For entry is the client', async () => {
    process.env.TRUST_PROXY = 'true'

    // 100 connections from distinct real sockets, every chain ending in the
    // same proxy-reported client 9.9.9.9. One bucket → all accepted so far.
    for (let i = 0; i < 100; i++) {
      const remote = `10.2.${i >> 8}.${i & 255}`
      const ws = await connect(301, remote, `${remote}, 9.9.9.9`)
      expect(ws.close).not.toHaveBeenCalled()
    }

    // The 101st connection for client 9.9.9.9 — from yet another socket —
    // is throttled: the rightmost header entry, not the socket, keyed the bucket.
    const throttled = await connect(301, '10.2.9.200', '10.2.9.200, 9.9.9.9')
    expect(throttled.close).toHaveBeenCalledWith(1008, THROTTLE_REASON)

    // A chain resolving to a DIFFERENT rightmost client has its own bucket.
    const other = await connect(301, '10.2.9.201', '10.2.9.201, 8.8.8.8')
    expect(other.close).not.toHaveBeenCalled()
  })

  it('with TRUST_PROXY enabled, a single-value X-Forwarded-For is used as-is', async () => {
    process.env.TRUST_PROXY = 'true'

    for (let i = 0; i < 100; i++) {
      const remote = `10.3.${i >> 8}.${i & 255}`
      const ws = await connect(302, remote, '5.6.7.8')
      expect(ws.close).not.toHaveBeenCalled()
    }

    const throttled = await connect(302, '10.3.9.200', '5.6.7.8')
    expect(throttled.close).toHaveBeenCalledWith(1008, THROTTLE_REASON)
  })

  it('normalizes IPv4-mapped IPv6 (::ffff:) identically in the header and the socket address', async () => {
    process.env.TRUST_PROXY = 'true'

    for (let i = 0; i < 100; i++) {
      const remote = `10.4.${i >> 8}.${i & 255}`
      const ws = await connect(303, remote, '::ffff:6.6.6.6')
      expect(ws.close).not.toHaveBeenCalled()
    }

    // The plain form maps to the SAME normalized bucket.
    const throttled = await connect(303, '10.4.9.200', '6.6.6.6')
    expect(throttled.close).toHaveBeenCalledWith(1008, THROTTLE_REASON)
  })
})
