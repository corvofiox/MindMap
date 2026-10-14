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
}

/** Resolve a bearer token to a user, or null when invalid/expired/revoked. */
export async function resolveTokenUser(
  bearer: string | undefined,
): Promise<{ id: number; email: string; nickname: string | null } | null> {
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

  // Best-effort last-used stamp; never fail the request over it.
  db.update(personalAccessTokens)
    .set({ lastUsedAt: nowSec })
    .where(eq(personalAccessTokens.id, row.id))
    .run()

  return { id: user.id, email: user.email, nickname: user.nickname }
}

export async function authenticateMcp(
  req: McpAuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim()
    const user = await resolveTokenUser(bearer)
    if (!user) {
      res.status(401).json({
        success: false,
        error: '无效或已撤销的访问令牌',
      })
      return
    }
    req.mcpUser = user
    next()
  } catch (error) {
    logError('MCP token authentication error', error)
    res.status(500).json({ success: false, error: '认证服务异常，请稍后重试' })
  }
}
