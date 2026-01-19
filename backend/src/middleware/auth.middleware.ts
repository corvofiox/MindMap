import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { db } from '../database/connection.js'
import { users } from '../database/schema.js'
import { eq } from 'drizzle-orm'
import { getValidatedEnv } from '../utils/env.js'

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
    const token = req.headers.authorization?.replace('Bearer ', '')

    if (!token) {
      return res.status(401).json({ success: false, error: '未提供令牌' })
    }

    const env = getValidatedEnv()
    const decoded = jwt.verify(token, env.JWT_SECRET) as {
      userId: number
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, decoded.userId),
    })

    if (!user) {
      return res.status(401).json({ success: false, error: '无效的令牌' })
    }

    req.user = {
      id: user.id,
      email: user.email,
      nickname: user.nickname,
      avatar: user.avatar,
    }

    next()
  } catch (error) {
    return res.status(401).json({ success: false, error: '无效的令牌' })
  }
}

export function optionalAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '')

  if (!token) {
    return next()
  }

  authenticate(req, res, next)
}
