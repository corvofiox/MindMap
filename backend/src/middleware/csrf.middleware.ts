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
    // 如果用户已认证，使用用户ID作为会话标识符
    if (authReq.user?.id) {
      return authReq.user.id.toString();
    }
    // 否则使用IP地址
    return req.ip || 'default';
  },
  cookieName: 'x-csrf-token',
  cookieOptions: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    httpOnly: false,
    maxAge: 86400 // 24 hours
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
