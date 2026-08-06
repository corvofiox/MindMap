import { doubleCsrf } from 'csrf-csrf'
import { NextFunction, Request, Response } from 'express'
import type { AuthRequest } from './auth.middleware.js'

// CSRF configuration
const getSecret = () => {
  const secret = process.env.CSRF_SECRET;
  // 生产环境必须设置CSRF密钥
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('CSRF_SECRET is required in production environment');
  }
  return secret || 'default-csrf-secret-change-in-production';
};

const { doubleCsrfProtection, generateCsrfToken } = doubleCsrf({
  getSecret,
  getSessionIdentifier: (req) => {
    const authReq = req as AuthRequest;
    // R4 #6（注释修正）：CSRF 中间件挂在 authenticate 之前运行（见 index.ts
    // 路由挂载顺序），校验时 authReq.user 永远不会被填充——session identifier
    // 实际上始终使用 IP 地址（已认证与未认证请求一致），下方 user.id 分支是
    // 防御性保留，实际不会走到。双重提交校验只要求"取 token 与校验 token 时
    // 标识一致"，单用户/单浏览器场景下 IP 标识已满足该要求，登录与否不改变
    // 标识，因此不会出现登录后 token 失效的问题。
    if (authReq.user?.id) {
      return authReq.user.id.toString();
    }
    return req.ip || 'default';
  },
  cookieName: 'x-csrf-token',
  cookieOptions: {
    // #1: secure 由显式环境变量 CSRF_COOKIE_SECURE=true 控制（默认不设，
    // 兼容 HTTP 直曝部署）。不再由 NODE_ENV 直接决定——NODE_ENV=production
    // 但服务仍以 HTTP 直曝时，Secure cookie 会被浏览器静默拒绝，CSRF token
    // 反而不可用；HTTPS 部署需显式设置 CSRF_COOKIE_SECURE=true 开启。
    secure: process.env.CSRF_COOKIE_SECURE === 'true',
    sameSite: 'strict',
    httpOnly: false,
    maxAge: 604800
  },
  size: 64,
  ignoredMethods: ['GET', 'HEAD', 'OPTIONS']
})

// Middleware to apply CSRF protection
export const csrfProtectionMiddleware = doubleCsrfProtection

// Route to get CSRF token
export const getCsrfTokenRoute = (req: Request, res: Response, next: NextFunction) => {
  try {
    // Generate and return CSRF token
    const token = generateCsrfToken(req, res)
    res.json({ success: true, token })
  } catch (error) {
    next(error)
  }
}

// Helper to validate CSRF token
export const validateCsrfToken = (req: Request, res: Response, next: NextFunction) => {
  try {
    doubleCsrfProtection(req, res, next)
  } catch (error) {
    next(error)
  }
}
