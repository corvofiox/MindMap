/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Personal access token tests.
 *
 * Covers the two halves of the credential: the hashing primitives, and the
 * middleware that turns a bearer token into a user. The security-relevant cases
 * are that plaintext is never recoverable from the stored hash, and that revoked
 * and expired tokens are rejected exactly like unknown ones.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../utils/logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}))

/** Rows the mocked DB will return, keyed by the query it should satisfy. */
const state: {
  tokenRow: any | null
  userRow: any | null
  updates: Array<Record<string, unknown>>
  dbError: Error | null
} = { tokenRow: null, userRow: null, updates: [], dbError: null }

vi.mock('../database/connection', () => ({
  db: {
    query: {
      personalAccessTokens: {
        findFirst: vi.fn(async () => {
          if (state.dbError) throw state.dbError
          return state.tokenRow
        }),
      },
      users: {
        findFirst: vi.fn(async () => {
          if (state.dbError) throw state.dbError
          return state.userRow
        }),
      },
    },
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        state.updates.push(values)
        return { where: vi.fn(() => ({ run: vi.fn(() => undefined) })) }
      }),
    })),
  },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => true),
  and: vi.fn(() => true),
  sql: vi.fn(),
}))

import type { Response, NextFunction } from 'express'
import {
  TOKEN_PREFIX,
  generateToken,
  hashToken,
  looksLikeToken,
} from '../utils/personalToken.js'
import {
  authenticateMcp,
  resolveTokenUser,
  type McpAuthRequest,
} from '../middleware/mcpAuth.middleware.js'
import { logError } from '../utils/logger.js'

const NOW_SEC = Math.floor(Date.now() / 1000)

function validRow(overrides: Record<string, unknown> = {}) {
  const token = generateToken()
  return {
    plaintext: token.plaintext,
    row: {
      id: 1,
      userId: 42,
      name: 'agent',
      tokenHash: token.hash,
      tokenPrefix: token.display,
      lastUsedAt: null,
      expiresAt: null,
      createdAt: NOW_SEC,
      revokedAt: null,
      ...overrides,
    },
  }
}

describe('personalToken primitives', () => {
  it('generates a prefixed, high-entropy token and a matching hash', () => {
    const t = generateToken()
    expect(t.plaintext.startsWith(TOKEN_PREFIX)).toBe(true)
    // 32 random bytes as hex.
    expect(t.plaintext.slice(TOKEN_PREFIX.length)).toHaveLength(64)
    expect(t.hash).toBe(hashToken(t.plaintext))
    // The display prefix must not leak the whole secret.
    expect(t.display.length).toBeLessThan(t.plaintext.length)
    expect(t.plaintext.startsWith(t.display.replace('…', ''))).toBe(true)
  })

  it('never produces the same token twice', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) seen.add(generateToken().plaintext)
    expect(seen.size).toBe(200)
  })

  it('hashes deterministically and irreversibly', () => {
    const t = generateToken()
    expect(hashToken(t.plaintext)).toBe(hashToken(t.plaintext))
    // A SHA-256 hex digest is 64 chars and must not contain the plaintext.
    expect(t.hash).toHaveLength(64)
    expect(t.hash).not.toContain(t.plaintext)
  })

  it('looksLikeToken accepts only our prefix with a body', () => {
    expect(looksLikeToken(generateToken().plaintext)).toBe(true)
    expect(looksLikeToken(TOKEN_PREFIX)).toBe(false)
    expect(looksLikeToken('')).toBe(false)
    expect(looksLikeToken('some-jwt.token.value')).toBe(false)
    expect(looksLikeToken('Bearer mmp_abc')).toBe(false)
  })
})

describe('resolveTokenUser', () => {
  beforeEach(() => {
    state.tokenRow = null
    state.userRow = null
    state.updates = []
    state.dbError = null
  })

  it('resolves a valid token to its user and stamps last-used', async () => {
    const { plaintext, row } = validRow()
    state.tokenRow = row
    state.userRow = { id: 42, email: 'a@b.c', nickname: 'A' }

    const user = await resolveTokenUser(plaintext)
    expect(user).toEqual({ id: 42, email: 'a@b.c', nickname: 'A' })
    expect(state.updates).toHaveLength(1)
    expect(state.updates[0].lastUsedAt).toBeGreaterThan(0)
  })

  it('rejects a malformed / non-prefixed token without touching the DB', async () => {
    const { row } = validRow()
    state.tokenRow = row
    state.userRow = { id: 42, email: 'a@b.c', nickname: null }

    expect(await resolveTokenUser(undefined)).toBeNull()
    expect(await resolveTokenUser('')).toBeNull()
    expect(await resolveTokenUser('not-a-token')).toBeNull()
    expect(await resolveTokenUser('Bearer mmp_x')).toBeNull()
    expect(state.updates).toHaveLength(0)
  })

  it('rejects a token whose hash is not in the database', async () => {
    state.tokenRow = null
    state.userRow = { id: 42, email: 'a@b.c', nickname: null }
    expect(await resolveTokenUser(generateToken().plaintext)).toBeNull()
  })

  it('rejects a revoked token even though its hash exists', async () => {
    const { plaintext, row } = validRow({ revokedAt: NOW_SEC - 10 })
    state.tokenRow = row
    state.userRow = { id: 42, email: 'a@b.c', nickname: null }
    expect(await resolveTokenUser(plaintext)).toBeNull()
  })

  it('rejects an expired token', async () => {
    const { plaintext, row } = validRow({ expiresAt: NOW_SEC - 1 })
    state.tokenRow = row
    state.userRow = { id: 42, email: 'a@b.c', nickname: null }
    expect(await resolveTokenUser(plaintext)).toBeNull()
  })

  it('accepts a token that expires in the future', async () => {
    const { plaintext, row } = validRow({ expiresAt: NOW_SEC + 3600 })
    state.tokenRow = row
    state.userRow = { id: 42, email: 'a@b.c', nickname: null }
    expect(await resolveTokenUser(plaintext)).not.toBeNull()
  })

  it('rejects a token whose owning user no longer exists', async () => {
    const { plaintext, row } = validRow()
    state.tokenRow = row
    state.userRow = null
    expect(await resolveTokenUser(plaintext)).toBeNull()
  })
})

/**
 * Minimal Express response double: records the status and body the middleware
 * writes. Only the surface `authenticateMcp` touches is implemented.
 */
interface CapturedResponse {
  statusCode: number | null
  body: unknown
  status: (code: number) => CapturedResponse
  json: (payload: unknown) => CapturedResponse
}

function makeResponse(): CapturedResponse {
  const res: CapturedResponse = {
    statusCode: null,
    body: undefined,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(payload: unknown) {
      res.body = payload
      return res
    },
  }
  return res
}

/** Build a request stub carrying only the Authorization header. */
function makeRequest(authorization?: string): McpAuthRequest {
  return {
    headers: authorization === undefined ? {} : { authorization },
  } as unknown as McpAuthRequest
}

describe('authenticateMcp middleware', () => {
  beforeEach(() => {
    state.tokenRow = null
    state.userRow = null
    state.updates = []
    state.dbError = null
    vi.mocked(logError).mockClear()
  })

  it('calls next() and attaches req.mcpUser for a valid bearer token', async () => {
    const { plaintext, row } = validRow()
    state.tokenRow = row
    state.userRow = { id: 42, email: 'agent@test.com', nickname: 'Agent' }

    const req = makeRequest(`Bearer ${plaintext}`)
    const res = makeResponse()
    let nextCalls = 0
    const next: NextFunction = () => {
      nextCalls++
    }

    await authenticateMcp(req, res as unknown as Response, next)

    expect(nextCalls).toBe(1)
    expect(res.statusCode).toBeNull()
    expect(res.body).toBeUndefined()
    expect(req.mcpUser).toEqual({ id: 42, email: 'agent@test.com', nickname: 'Agent' })
    // The successful path stamps last-used.
    expect(state.updates).toHaveLength(1)
  })

  it('accepts a lowercase "bearer" prefix', async () => {
    const { plaintext, row } = validRow()
    state.tokenRow = row
    state.userRow = { id: 42, email: 'a@b.c', nickname: null }

    const req = makeRequest(`bearer ${plaintext}`)
    const res = makeResponse()
    let nextCalls = 0

    await authenticateMcp(req, res as unknown as Response, () => {
      nextCalls++
    })

    expect(nextCalls).toBe(1)
    expect(req.mcpUser?.id).toBe(42)
  })

  it('responds 401 with the full middleware contract for every invalid credential', async () => {
    // Consolidates five former cases. Each is re-proven at the HTTP layer by
    // mcp-http.test.ts; what only the MIDDLEWARE unit can assert is the Express
    // contract: next() must not run and req.mcpUser must stay unset.
    const revoked = validRow({ revokedAt: NOW_SEC - 5 })
    const expired = validRow({ expiresAt: NOW_SEC - 5 })
    const cases: Array<{ label: string; token?: string; setup?: () => void }> = [
      { label: 'no Authorization header' },
      { label: 'token without the mmp_ prefix', token: 'Bearer not-a-token' },
      {
        label: 'unknown mmp_ token',
        token: `Bearer ${generateToken().plaintext}`,
        setup: () => {
          state.tokenRow = null
        },
      },
      {
        label: 'revoked token',
        token: `Bearer ${revoked.plaintext}`,
        setup: () => {
          state.tokenRow = revoked.row
          state.userRow = { id: 42, email: 'a@b.c', nickname: null }
        },
      },
      {
        label: 'expired token',
        token: `Bearer ${expired.plaintext}`,
        setup: () => {
          state.tokenRow = expired.row
          state.userRow = { id: 42, email: 'a@b.c', nickname: null }
        },
      },
    ]

    for (const c of cases) {
      state.tokenRow = null
      state.userRow = null
      c.setup?.()

      const req = makeRequest(c.token)
      const res = makeResponse()
      let nextCalls = 0

      await authenticateMcp(req as unknown as McpAuthRequest, res as unknown as Response, () => {
        nextCalls++
      })

      expect(res.statusCode, `case=${c.label}`).toBe(401)
      expect(res.body, `case=${c.label}`).toEqual({ success: false, error: '无效或已撤销的访问令牌' })
      expect(req.mcpUser, `case=${c.label}`).toBeUndefined()
      expect(nextCalls, `case=${c.label}`).toBe(0)
    }
  })

  it('responds 500 and logs when the database throws', async () => {
    state.dbError = new Error('SQLITE_BUSY: database is locked')

    const req = makeRequest(`Bearer ${generateToken().plaintext}`)
    const res = makeResponse()
    let nextCalls = 0

    await authenticateMcp(req, res as unknown as Response, () => {
      nextCalls++
    })

    expect(res.statusCode).toBe(500)
    expect(res.body).toEqual({ success: false, error: '认证服务异常，请稍后重试' })
    expect(nextCalls).toBe(0)
    expect(req.mcpUser).toBeUndefined()
    expect(vi.mocked(logError)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logError).mock.calls[0][0]).toBe('MCP token authentication error')
  })

  it('never leaks the bearer token or its hash in the error body', async () => {
    state.dbError = new Error('boom')
    const plaintext = generateToken().plaintext

    const req = makeRequest(`Bearer ${plaintext}`)
    const res = makeResponse()

    await authenticateMcp(req, res as unknown as Response, () => undefined)

    const serialized = JSON.stringify(res.body)
    expect(serialized).not.toContain(plaintext)
    expect(serialized).not.toContain(hashToken(plaintext))
  })
})
