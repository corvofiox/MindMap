import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { db } from '../database/connection.js'
import { users } from '../database/schema.js'
import { eq } from 'drizzle-orm'
import { getValidatedEnv } from '../utils/env.js'
import { logError } from '../utils/logger.js'

export interface AuthRequest extends Request {
  user?: {
    id: number
    email: string
    nickname: string | null
    avatar: string | null
  }
}

export async function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    // B7: 仅接受 Authorization 头携带 JWT。query ?token= 会泄漏到访问日志/
    // Referer，且 REST 场景无此必要（WebSocket 的 ?token= 走独立鉴权路径）。
    const token = req.headers.authorization?.replace('Bearer ', '')

    if (!token) {
      return res.status(401).json({ success: false, error: '未提供令牌' })
    }

    const env = getValidatedEnv()
    let decoded
    
    try {
      decoded = jwt.verify(token, env.JWT_SECRET) as {
        userId: number
      }
    } catch (jwtError) {
      if (jwtError instanceof jwt.TokenExpiredError) {
        return res.status(401).json({ success: false, error: '令牌已过期' })
      } else if (jwtError instanceof jwt.JsonWebTokenError) {
        return res.status(401).json({ success: false, error: '无效的令牌签名' })
      } else {
        logError('JWT verification error', jwtError)
        return res.status(401).json({ success: false, error: '令牌格式错误' })
      }
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, decoded.userId),
    })

    if (!user) {
      return res.status(401).json({ success: false, error: '用户不存在，令牌无效' })
    }

    req.user = {
      id: user.id,
      email: user.email,
      nickname: user.nickname,
      avatar: user.avatar,
    }

    next()
  } catch (error) {
    logError('Authentication error', error)
    return res.status(401).json({ success: false, error: '认证失败，请重新登录' })
  }
}

export function optionalAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '')

  if (!token) {
    return next()
  }

  authenticate(req, res, next)
}
