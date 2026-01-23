import rateLimit from 'express-rate-limit'

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


