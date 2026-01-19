import rateLimit from 'express-rate-limit';
const RATE_LIMIT_CONFIG = {
    windowMs: 15 * 60 * 1000,
    max: 100,
    authWindowMs: 15 * 60 * 1000,
    authMax: 5,
    wsMax: 10,
    wsWindowMs: 60 * 1000,
};
export const createApiLimiter = () => rateLimit({
    windowMs: RATE_LIMIT_CONFIG.windowMs,
    max: RATE_LIMIT_CONFIG.max,
    message: '请求过于频繁，请稍后再试',
    standardHeaders: true,
    legacyHeaders: false,
});
export const createAuthLimiter = () => rateLimit({
    windowMs: RATE_LIMIT_CONFIG.authWindowMs,
    max: RATE_LIMIT_CONFIG.authMax,
    message: '登录尝试过多，请稍后再试',
    standardHeaders: true,
    legacyHeaders: false,
});
export { createApiLimiter as apiLimiter, createAuthLimiter as authLimiter };
