/**
 * Personal access token management.
 *
 * Lets a signed-in user mint, list and revoke the tokens that external agents use
 * to reach the MCP endpoint. These routes are for the *web UI* (JWT + CSRF), not
 * for agents — an agent authenticates with the token itself at `/mcp`.
 *
 * Security invariants:
 *   - The plaintext token is returned exactly once, by POST, and never stored.
 *   - Listing never exposes the hash, only a display prefix.
 *   - Every route is scoped to the calling user, so one account can neither see
 *     nor revoke another's tokens.
 */
import { Router } from 'express'
import { db } from '../database/connection.js'
import { personalAccessTokens } from '../database/schema.js'
import { and, desc, eq } from 'drizzle-orm'
import { authenticate, type AuthRequest } from '../middleware/auth.middleware.js'
import { asyncHandler } from '../middleware/error.middleware.js'
import { generateToken } from '../utils/personalToken.js'

const router = Router()

router.use(authenticate)

/** Cap on tokens per user, so the table cannot grow without bound. */
const MAX_TOKENS_PER_USER = 25

/** Longest accepted label. */
const MAX_NAME_LENGTH = 60

/**
 * List the caller's tokens (metadata only — never the secret).
 *
 * `revokedAt` is included so the UI can show history rather than deleting rows,
 * which keeps an audit trail of which credential existed when.
 */
router.get(
  '/',
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id
    if (!userId) {
      return res.status(401).json({ success: false, error: '未认证' })
    }

    const rows = await db
      .select({
        id: personalAccessTokens.id,
        name: personalAccessTokens.name,
        tokenPrefix: personalAccessTokens.tokenPrefix,
        lastUsedAt: personalAccessTokens.lastUsedAt,
        expiresAt: personalAccessTokens.expiresAt,
        createdAt: personalAccessTokens.createdAt,
        revokedAt: personalAccessTokens.revokedAt,
      })
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.userId, userId))
      .orderBy(desc(personalAccessTokens.createdAt))

    return res.json({
      success: true,
      data: {
        tokens: rows.map((row) => ({
          id: row.id,
          name: row.name,
          tokenPrefix: row.tokenPrefix,
          lastUsedAt: row.lastUsedAt ?? null,
          expiresAt: row.expiresAt ?? null,
          createdAt: row.createdAt ?? null,
          revokedAt: row.revokedAt ?? null,
          revoked: row.revokedAt !== null && row.revokedAt !== undefined,
        })),
      },
    })
  }),
)

/**
 * Create a token. The plaintext is in the response body and nowhere else.
 *
 * `expiresInDays` is optional; when omitted the token does not expire, which is
 * the sensible default for a long-lived local agent integration.
 */
router.post(
  '/',
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id
    if (!userId) {
      return res.status(401).json({ success: false, error: '未认证' })
    }

    const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    const name = rawName || '未命名令牌'
    if (name.length > MAX_NAME_LENGTH) {
      return res
        .status(400)
        .json({ success: false, error: `令牌名称不能超过 ${MAX_NAME_LENGTH} 个字符` })
    }

    // Validate expiry before touching the DB: a bad value must not create a row.
    let expiresAt: number | null = null
    const rawExpires = req.body?.expiresInDays
    if (rawExpires !== undefined && rawExpires !== null && rawExpires !== '') {
      const days = Number(rawExpires)
      if (!Number.isFinite(days) || days <= 0 || days > 3650) {
        return res
          .status(400)
          .json({ success: false, error: '有效期必须是 0 到 3650 之间的天数' })
      }
      expiresAt = Math.floor(Date.now() / 1000) + Math.floor(days * 86400)
    }

    // Count only live tokens against the cap, so revoked ones do not block creation.
    const existing = await db
      .select({ id: personalAccessTokens.id, revokedAt: personalAccessTokens.revokedAt })
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.userId, userId))
    const activeCount = existing.filter(
      (row) => row.revokedAt === null || row.revokedAt === undefined,
    ).length
    if (activeCount >= MAX_TOKENS_PER_USER) {
      return res.status(400).json({
        success: false,
        error: `最多只能有 ${MAX_TOKENS_PER_USER} 个有效令牌，请先撤销不再使用的令牌`,
      })
    }

    const token = generateToken()
    const [created] = await db
      .insert(personalAccessTokens)
      .values({
        userId,
        name,
        tokenHash: token.hash,
        tokenPrefix: token.display,
        expiresAt,
      })
      .returning({ id: personalAccessTokens.id, createdAt: personalAccessTokens.createdAt })

    return res.status(201).json({
      success: true,
      data: {
        id: created?.id,
        name,
        // Shown once. The UI must warn that it cannot be retrieved again.
        token: token.plaintext,
        tokenPrefix: token.display,
        expiresAt,
        createdAt: created?.createdAt ?? null,
      },
    })
  }),
)

/**
 * Revoke a token.
 *
 * Sets `revokedAt` rather than deleting, so the record survives for auditing; the
 * MCP middleware rejects any token carrying it. Idempotent-ish: revoking an
 * already-revoked token succeeds without rewriting the timestamp.
 */
router.delete(
  '/:id',
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id
    const tokenId = parseInt(req.params.id, 10)
    if (!userId) {
      return res.status(401).json({ success: false, error: '未认证' })
    }
    if (isNaN(tokenId)) {
      return res.status(400).json({ success: false, error: '无效的令牌 ID' })
    }

    // Scoped by userId so a guessed id cannot revoke someone else's token.
    const row = await db.query.personalAccessTokens.findFirst({
      where: and(
        eq(personalAccessTokens.id, tokenId),
        eq(personalAccessTokens.userId, userId),
      ),
    })
    if (!row) {
      return res.status(404).json({ success: false, error: '令牌不存在' })
    }

    if (row.revokedAt === null || row.revokedAt === undefined) {
      await db
        .update(personalAccessTokens)
        .set({ revokedAt: Math.floor(Date.now() / 1000) })
        .where(eq(personalAccessTokens.id, tokenId))
    }

    return res.json({ success: true })
  }),
)

export { router as tokenRouter }
