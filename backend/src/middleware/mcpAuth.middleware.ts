/**
 * Authentication for the MCP HTTP endpoint.
 *
 * Accepts a personal access token (`mmp_…`) in the `Authorization: Bearer` header
 * and resolves it to the owning user, so every MCP tool call runs with that
 * account's permissions. Deliberately separate from `authenticate`
 * (middleware/auth.middleware.ts), which verifies short-lived JWTs: keeping the
 * two apart means an agent credential can never be minted or replayed as a
 * browser session, and the two can be revoked independently.
 *
 * CSRF does not apply: this endpoint is not driven by a browser cookie, and the
 * token is an explicit header credential that a cross-site form cannot set.
 *
 * Failures answer with a **JSON-RPC error body** (not `{success:false}`): an MCP
 * client parses JSON-RPC, and a bare REST envelope makes it report "cannot parse
 * response" instead of "bad credentials". The HTTP status stays 401 so ordinary HTTP
 * tooling still sees it, and `WWW-Authenticate` tells an OAuth-aware client what kind
 * of credential is expected.
 */
import type { Request, Response, NextFunction } from 'express'
import { db } from '../database/connection.js'
import { personalAccessTokens, users } from '../database/schema.js'
import { eq } from 'drizzle-orm'
import { hashToken, looksLikeToken } from '../utils/personalToken.js'
import { logError } from '../utils/logger.js'

export interface McpAuthRequest extends Request {
  mcpUser?: {
    id: number
    email: string
    nickname: string | null
  }
  /** Row id of the token used, so last-used tracking needs no second lookup. */
  mcpTokenId?: number
  /** Human label of the token, copied into the audit trail. */
  mcpTokenName?: string
}

/** Minimum seconds between two `last_used_at` writes for the same token. */
const LAST_USED_THROTTLE_SECONDS = 60

function unauthorized(res: Response, message: string): void {
  res
    .status(401)
    .set('WWW-Authenticate', 'Bearer realm="mindmap-mcp"')
    .json({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32001,
        message,
        data: { code: 'E_FORBIDDEN', hint: '请在网页「账号设置 → 访问令牌」重新生成一个令牌。' },
      },
    })
}

/** Resolve a bearer token to a user, or null when invalid/expired/revoked. */
export async function resolveTokenUser(
  bearer: string | undefined,
): Promise<{
  id: number
  email: string
  nickname: string | null
  tokenId: number
  tokenName: string
} | null> {
  if (!bearer || !looksLikeToken(bearer)) return null

  const hash = hashToken(bearer)
  const row = await db.query.personalAccessTokens.findFirst({
    where: eq(personalAccessTokens.tokenHash, hash),
  })
  if (!row) return null

  // Revoked and expired tokens are rejected identically to unknown ones: the
  // caller learns only "invalid token", never which condition failed.
  if (row.revokedAt) return null
  const nowSec = Math.floor(Date.now() / 1000)
  if (row.expiresAt !== null && row.expiresAt !== undefined && row.expiresAt <= nowSec) {
    return null
  }

  const user = await db.query.users.findFirst({ where: eq(users.id, row.userId) })
  if (!user) return null

  // Best-effort last-used stamp. Throttled: this used to run on every request,
  // including `tools/list` and 405s, which turned every read into a synchronous
  // SQLite write (and an fsync) for no benefit. A failure here must never fail the
  // request — the comment always claimed that, but an uncaught throw inside the old
  // code path surfaced as a 500 on a perfectly valid token.
  try {
    const lastUsed = Number(row.lastUsedAt ?? 0)
    if (nowSec - lastUsed >= LAST_USED_THROTTLE_SECONDS) {
      db.update(personalAccessTokens)
        .set({ lastUsedAt: nowSec })
        .where(eq(personalAccessTokens.id, row.id))
        .run()
    }
  } catch (error) {
    logError('Failed to stamp MCP token last-used', {
      tokenId: row.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  return {
    id: user.id,
    email: user.email,
    nickname: user.nickname,
    tokenId: Number(row.id),
    tokenName: (row.name as string) ?? '',
  }
}

export async function authenticateMcp(
  req: McpAuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const header = req.headers.authorization ?? ''
    // Strict prefix: `Authorization: mmp_...` (no scheme) used to be accepted, which
    // is not what any HTTP client or proxy expects.
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    const bearer = match ? match[1].trim() : ''
    const user = await resolveTokenUser(bearer)
    if (!user) {
      unauthorized(res, '无效或已撤销的访问令牌')
      return
    }
    req.mcpUser = { id: user.id, email: user.email, nickname: user.nickname }
    req.mcpTokenId = user.tokenId
    req.mcpTokenName = user.tokenName
    next()
  } catch (error) {
    logError('MCP token authentication error', error)
    res.status(500).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: '认证服务异常，请稍后重试', data: { code: 'E_INTERNAL' } },
    })
  }
}
