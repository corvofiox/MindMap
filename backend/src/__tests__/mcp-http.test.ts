/**
 * MCP Streamable HTTP transport tests.
 *
 * `http.ts` had 0% coverage. It is the network edge of the whole MCP feature, so
 * these tests drive the REAL `mcpRouter` over real HTTP (supertest against a real
 * Express app) with real personal access tokens in a real in-memory database.
 *
 * The transport runs in stateless JSON mode: one POST carries exactly one JSON-RPC
 * call and yields exactly one JSON body. That is asserted end to end, including
 * the SDK's Accept/Content-Type requirements, so a client-visible regression in
 * the wiring (wrong headers, SSE mode, session handling) fails here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import type express from 'express'
import type Database from 'better-sqlite3'

vi.mock('../utils/logger.js', () => ({ log: vi.fn(), logError: vi.fn() }))

vi.mock('../database/connection.js', async () => {
  const { installDbMock } = await import('./helpers/integration-harness.js')
  return installDbMock()
})

// The websocket layer is not under test here; importing it opens real sockets.
vi.mock('../websocket/index.js', () => ({
  getCanvasActiveUsers: vi.fn(() => []),
  closeRoom: vi.fn(),
  kickUserFromRoom: vi.fn(),
  shouldUpsertOnlyForSnapshot: vi.fn(() => false),
}))

import {
  buildApp,
  countRows,
  createTestDatabase,
  seedUser,
  setTestEnv,
  type TestDatabase,
} from './helpers/integration-harness.js'

setTestEnv()

const { mcpRouter } = await import('../mcp/http.js')
const { MCP_SERVER_NAME } = await import('../mcp/server.js')
const { generateToken } = await import('../utils/personalToken.js')

/** The 23 tools exposed by tools.ts, used to pin the advertised set. */
const EXPECTED_TOOL_COUNT = 23

const NOW_SEC = () => Math.floor(Date.now() / 1000)

/** Persist a PAT row (hash only) and return its plaintext. */
function seedToken(
  raw: Database.Database,
  userId: number,
  opts: { expiresAt?: number | null; revokedAt?: number | null } = {},
): string {
  const token = generateToken()
  raw
    .prepare(
      `INSERT INTO personal_access_tokens
         (user_id, name, token_hash, token_prefix, last_used_at, expires_at, created_at, revoked_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      userId,
      'agent',
      token.hash,
      token.display,
      null,
      opts.expiresAt ?? null,
      NOW_SEC(),
      opts.revokedAt ?? null,
    )
  return token.plaintext
}

/** Standard Streamable-HTTP headers: the SDK requires both accepted media types. */
const MCP_HEADERS = {
  Accept: 'application/json, text/event-stream',
  'Content-Type': 'application/json',
}

describe('mcp/http.ts (integration, real router + real DB)', () => {
  let app: express.Express
  let t: TestDatabase
  let userId: number

  beforeEach(() => {
    t = createTestDatabase()
    app = buildApp('/mcp', mcpRouter)
    userId = seedUser(t.raw, 'agent-owner@test.com', 'hash', 'Owner')
  })

  describe('POST / — authentication', () => {
    it('returns 401 without an Authorization header', async () => {
      const res = await supertest(app)
        .post('/mcp')
        .set(MCP_HEADERS)
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })

      expect(res.status).toBe(401)
      expect(res.body.success).toBe(false)
      expect(res.body.error).toContain('无效或已撤销')
    })

    it('returns 401 for a garbage mmp_ token that is not in the database', async () => {
      const res = await supertest(app)
        .post('/mcp')
        .set(MCP_HEADERS)
        .set('Authorization', `Bearer mmp_${'0'.repeat(64)}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })

      expect(res.status).toBe(401)
      expect(res.body.success).toBe(false)
    })

    it('returns 401 for a token that does not carry the mmp_ prefix', async () => {
      const res = await supertest(app)
        .post('/mcp')
        .set(MCP_HEADERS)
        .set('Authorization', 'Bearer some-jwt.value.here')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })

      expect(res.status).toBe(401)
      expect(res.body.success).toBe(false)
    })

    it('returns 401 for a revoked token', async () => {
      const token = seedToken(t.raw, userId, { revokedAt: NOW_SEC() - 60 })

      const res = await supertest(app)
        .post('/mcp')
        .set(MCP_HEADERS)
        .set('Authorization', `Bearer ${token}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })

      expect(res.status).toBe(401)
      expect(res.body.success).toBe(false)
    })

    it('returns 401 for an expired token', async () => {
      const token = seedToken(t.raw, userId, { expiresAt: NOW_SEC() - 1 })

      const res = await supertest(app)
        .post('/mcp')
        .set(MCP_HEADERS)
        .set('Authorization', `Bearer ${token}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })

      expect(res.status).toBe(401)
    })

    it('returns 401 for a token whose owning user no longer exists', async () => {
      const token = seedToken(t.raw, userId)
      // The FK would normally cascade; simulate a dangling credential row.
      t.raw.pragma('foreign_keys = OFF')
      t.raw.prepare('DELETE FROM users WHERE id = ?').run(userId)
      t.raw.pragma('foreign_keys = ON')
      expect(countRows(t.raw, 'personal_access_tokens')).toBe(1)

      const res = await supertest(app)
        .post('/mcp')
        .set(MCP_HEADERS)
        .set('Authorization', `Bearer ${token}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })

      expect(res.status).toBe(401)
    })

    it('accepts a token that expires in the future', async () => {
      const token = seedToken(t.raw, userId, { expiresAt: NOW_SEC() + 3600 })

      const res = await supertest(app)
        .post('/mcp')
        .set(MCP_HEADERS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        })

      expect(res.status).toBe(200)
      expect(res.body.result.serverInfo.name).toBe(MCP_SERVER_NAME)
    })
  })

  describe('POST / — JSON-RPC', () => {
    let token: string

    beforeEach(() => {
      token = seedToken(t.raw, userId)
    })

    it('answers initialize with the real server identity and protocol version', async () => {
      const res = await supertest(app)
        .post('/mcp')
        .set(MCP_HEADERS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '1.0.0' },
          },
        })

      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toContain('application/json')
      expect(res.body.jsonrpc).toBe('2.0')
      expect(res.body.id).toBe(1)
      expect(res.body.result.serverInfo.name).toBe(MCP_SERVER_NAME)
      expect(res.body.result.serverInfo.name).toBe('mindmap')
      expect(typeof res.body.result.serverInfo.version).toBe('string')
      expect(res.body.result.protocolVersion).toBe('2025-06-18')
      expect(res.body.result.capabilities.tools).toBeDefined()
      // Stateless mode issues no session id.
      expect(res.headers['mcp-session-id']).toBeUndefined()
    })

    it('lists all 23 tools with schemas over the wire', async () => {
      const res = await supertest(app)
        .post('/mcp')
        .set(MCP_HEADERS)
        .set('Authorization', `Bearer ${token}`)
        .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })

      expect(res.status).toBe(200)
      expect(res.body.id).toBe(2)
      const names = res.body.result.tools.map((tool: { name: string }) => tool.name)
      expect(names).toHaveLength(EXPECTED_TOOL_COUNT)
      for (const expected of [
        'listCanvases',
        'getCanvasData',
        'createNode',
        'generateGraphFromJSON',
        'undo',
        'redo',
      ]) {
        expect(names).toContain(expected)
      }
      for (const tool of res.body.result.tools) {
        expect(tool.inputSchema.type).toBe('object')
      }
    })

    it('marks the token as used on a successful call', async () => {
      await supertest(app)
        .post('/mcp')
        .set(MCP_HEADERS)
        .set('Authorization', `Bearer ${token}`)
        .send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })

      const lastUsedAt = t.raw
        .prepare('SELECT last_used_at FROM personal_access_tokens WHERE user_id = ?')
        .get(userId) as { last_used_at: number | null }
      expect(lastUsedAt.last_used_at).toBeGreaterThan(0)
    })

    it('rejects a POST that does not accept text/event-stream with 406', async () => {
      const res = await supertest(app)
        .post('/mcp')
        .set('Accept', 'application/json')
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${token}`)
        .send({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} })

      expect(res.status).toBe(406)
      expect(res.body.error.code).toBe(-32000)
    })

    it('rejects a non-JSON Content-Type with 415', async () => {
      const res = await supertest(app)
        .post('/mcp')
        .set(MCP_HEADERS)
        .set('Content-Type', 'text/plain')
        .set('Authorization', `Bearer ${token}`)
        .send('{"jsonrpc":"2.0","id":5,"method":"tools/list","params":{}}')

      expect(res.status).toBe(415)
      expect(res.body.error.code).toBe(-32000)
    })

    it('returns a JSON-RPC error for an unknown method', async () => {
      const res = await supertest(app)
        .post('/mcp')
        .set(MCP_HEADERS)
        .set('Authorization', `Bearer ${token}`)
        .send({ jsonrpc: '2.0', id: 6, method: 'no/such-method', params: {} })

      expect(res.status).toBe(200)
      expect(res.body.error.code).toBe(-32601)
      expect(res.body.id).toBe(6)
    })

    it('returns 202 with an empty body for a notification (no id)', async () => {
      const res = await supertest(app)
        .post('/mcp')
        .set(MCP_HEADERS)
        .set('Authorization', `Bearer ${token}`)
        .send({ jsonrpc: '2.0', method: 'notifications/initialized' })

      expect(res.status).toBe(202)
      expect(res.text).toBe('')
    })
  })

  describe('GET / and DELETE / — unsupported in stateless mode', () => {
    let token: string

    beforeEach(() => {
      token = seedToken(t.raw, userId)
    })

    it('answers GET with 405 and a JSON-RPC error body', async () => {
      const res = await supertest(app)
        .get('/mcp')
        .set('Accept', 'text/event-stream')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(405)
      expect(res.headers['content-type']).toContain('application/json')
      expect(res.body.jsonrpc).toBe('2.0')
      expect(res.body.error.code).toBe(-32000)
      expect(res.body.error.message).toContain('无状态')
      expect(res.body.id).toBeNull()
    })

    it('answers DELETE with 405 and a JSON-RPC error body', async () => {
      const res = await supertest(app)
        .delete('/mcp')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(405)
      expect(res.body.jsonrpc).toBe('2.0')
      expect(res.body.error.code).toBe(-32000)
      expect(res.body.error.message).toContain('无状态')
      expect(res.body.id).toBeNull()
    })

    it('still authenticates before answering GET, so a bad token is 401 not 405', async () => {
      const res = await supertest(app).get('/mcp').set('Accept', 'text/event-stream')
      expect(res.status).toBe(401)
    })

    it('still authenticates before answering DELETE', async () => {
      const res = await supertest(app).delete('/mcp')
      expect(res.status).toBe(401)
    })
  })
})
