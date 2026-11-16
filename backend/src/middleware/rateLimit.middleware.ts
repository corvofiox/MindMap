import rateLimit, { ipKeyGenerator } from 'express-rate-limit'

/**
 * Rate limiting configuration
 * Adjust these values based on your application's needs
 */
const RATE_LIMIT_CONFIG = {
  // General API rate limit: 1000 requests per 15 minutes (relaxed for development)
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000,

  // Auth endpoints (login, register): Stricter limits (relaxed for development)
  authWindowMs: 15 * 60 * 1000, // 15 minutes
  authMax: 100, // 100 attempts per 15 minutes (relaxed for development)

  // WebSocket connections: Limit connections per IP (relaxed for development)
  wsMax: 100,
  wsWindowMs: 60 * 1000, // 1 minute
} as const

/**
 * Create API rate limiter for general endpoints
 */
export const createApiLimiter = () => rateLimit({
  windowMs: RATE_LIMIT_CONFIG.windowMs,
  max: RATE_LIMIT_CONFIG.max,
  message: '请求过于频繁，请稍后再试',
  standardHeaders: true,
  legacyHeaders: false,
})

/**
 * Create rate limiter for authentication endpoints (login, register)
 */
export const createAuthLimiter = () => rateLimit({
  windowMs: RATE_LIMIT_CONFIG.authWindowMs,
  max: RATE_LIMIT_CONFIG.authMax,
  message: '登录尝试过多，请稍后再试',
  standardHeaders: true,
  legacyHeaders: false,
})

export { createApiLimiter as apiLimiter, createAuthLimiter as authLimiter }

/**
 * Rate limiter for the MCP endpoint, keyed by **token owner** rather than IP.
 *
 * The global limiter is IP-scoped, which is wrong for agents in two ways: behind a
 * reverse proxy every agent shares one bucket (so one busy agent 429s everybody), and
 * a single agent can starve the shared bucket for the browser UI. Keying on the
 * authenticated user fixes both. The window is shorter and the ceiling higher than the
 * API limiter because one agent turn legitimately makes tens of calls.
 *
 * Answers with a JSON-RPC error body: an MCP client parses JSON-RPC, and the default
 * string message would arrive as `text/html`.
 */
export const createMcpLimiter = () =>
  rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const user = (req as unknown as { mcpUser?: { id?: number } }).mcpUser
      // 未带令牌时按来源 IP 兜底。ipKeyGenerator 会把 IPv6 归一到 /56：
      // 直接用 req.ip 的话，一个 IPv6 客户端换地址就能刷满每个新桶（绕过限流），
      // 新版 express-rate-limit 也会为此打出一条 ValidationError。
      return user?.id ? `mcp-user:${user.id}` : `mcp-ip:${ipKeyGenerator(req.ip ?? '')}`
    },
    handler: (_req, res) => {
      res.status(429).json({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32000,
          message: '请求过于频繁：MCP 每个账号每分钟最多 300 次工具调用。',
          data: { code: 'E_LIMIT', retryAfterSeconds: 60 },
        },
      })
    },
  })

/**
 * Creation limiter for personal access tokens.
 *
 * Minting a token is a credential operation; the global 1000/15min bucket is far too
 * generous for it (25 tokens per account means one burst can fill the quota).
 */
export const createTokenLimiter = () =>
  rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    message: '创建访问令牌过于频繁，请稍后再试',
    standardHeaders: true,
    legacyHeaders: false,
    // Integration tests mint a token per case from the same loopback IP; without this
    // they would exhaust a real security control and start failing for the wrong
    // reason. The control is still exercised in production and by an explicit unit
    // test that instantiates the limiter directly.
    skip: () => process.env.NODE_ENV === 'test',
  })



