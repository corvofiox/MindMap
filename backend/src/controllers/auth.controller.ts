import { Router } from 'express'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { db } from '../database/connection.js'
import { users } from '../database/schema.js'
import { eq } from 'drizzle-orm'
import { asyncHandler } from '../middleware/error.middleware.js'
import { getValidatedEnv } from '../utils/env.js'
import { authLimiter } from '../middleware/rateLimit.middleware.js'

export const authRouter = Router()

// B6: 邮箱格式校验（宽松但可过滤明显非法输入）
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_PASSWORD_LENGTH = 6

// Register
authRouter.post('/register', authLimiter(), asyncHandler(async (req, res) => {
  const { email, password, nickname } = req.body

  // B6: 类型校验——email/password 传对象等非字符串会直接 500
  if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
    return res.status(400).json({
      success: false,
      error: '邮箱和密码不能为空',
    })
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({
      success: false,
      error: `密码长度不能少于${MIN_PASSWORD_LENGTH}个字符`,
    })
  }

  // #6: 统一 trim 后校验/查重/存储——注册与登录使用同一规范化结果，
  // 避免"注册存了带空格邮箱、登录查不到"或反之的账号分裂问题。
  const normalizedEmail = email.trim()

  if (!EMAIL_PATTERN.test(normalizedEmail)) {
    return res.status(400).json({
      success: false,
      error: '邮箱格式不正确',
    })
  }

  // Check if user exists
  const existingUsers = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizedEmail))
  const existingUser = existingUsers[0]

  if (existingUser) {
    return res.status(400).json({
      success: false,
      error: '该邮箱已被注册',
    })
  }

  // Hash password
  const hashedPassword = await bcrypt.hash(password, 10)

  // R4 #9: nickname trim 后存储——避免首尾空格入库（显示与各处校验不一致）。
  const rawNickname = typeof nickname === 'string' ? nickname.trim() : ''

  // Create user
  const result = await db
    .insert(users)
    .values({
      email: normalizedEmail,
      password: hashedPassword,
      nickname: rawNickname ? rawNickname : null,
    })
    .returning()

  const newUser = result[0]

  // Generate token
  const env = getValidatedEnv()
  const token = jwt.sign(
    { userId: newUser.id },
    env.JWT_SECRET,
    {
      expiresIn: env.JWT_EXPIRES_IN || '7d',
    } as jwt.SignOptions
  )

  res.json({
    success: true,
    data: {
      user: {
        id: newUser.id,
        email: newUser.email,
        nickname: newUser.nickname,
        avatar: newUser.avatar,
        created_at: newUser.createdAt,
        updated_at: newUser.updatedAt,
      },
      token,
    },
  })
}))

// Login
authRouter.post('/login', authLimiter(), asyncHandler(async (req, res) => {
  const { email, password } = req.body

  if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({
      success: false,
      error: '邮箱和密码不能为空',
    })
  }

  // #6: 查询前与注册同样 trim，保证"注册存 trim 后邮箱、登录按 trim 后查询"一致
  const normalizedEmail = email.trim()

  // Find user
  const usersList = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizedEmail))
  const user = usersList[0]

  if (!user || !user.password) {
    return res.status(401).json({
      success: false,
      error: '用户名或密码错误',
    })
  }

  // Verify password
  const isValid = await bcrypt.compare(password, user.password)

  if (!isValid) {
    return res.status(401).json({
      success: false,
      error: '用户名或密码错误',
    })
  }

  // Generate token
  const env = getValidatedEnv()
  const token = jwt.sign(
    { userId: user.id },
    env.JWT_SECRET,
    {
      expiresIn: env.JWT_EXPIRES_IN || '7d',
    } as jwt.SignOptions
  )

  res.json({
    success: true,
    data: {
      user: {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
        avatar: user.avatar,
        created_at: user.createdAt,
        updated_at: user.updatedAt,
      },
      token,
    },
  })
}))

// Logout
authRouter.post('/logout', asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: { message: 'Logged out successfully' },
  })
}))

// Refresh token
authRouter.post('/refresh', authLimiter(), asyncHandler(async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '')

  if (!token) {
    return res.status(401).json({
      success: false,
      error: '未提供令牌',
    })
  }

  try {
    const env = getValidatedEnv()
    const decoded = jwt.verify(token, env.JWT_SECRET!) as { userId: number }

    const usersList = await db
      .select()
      .from(users)
      .where(eq(users.id, decoded.userId))
    const user = usersList[0]

    if (!user) {
      return res.status(401).json({
        success: false,
        error: '无效的令牌',
      })
    }

    const newToken = jwt.sign(
      { userId: user.id },
      env.JWT_SECRET,
      {
        expiresIn: env.JWT_EXPIRES_IN || '7d',
      } as jwt.SignOptions
    )

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          nickname: user.nickname,
          avatar: user.avatar,
          created_at: user.createdAt,
          updated_at: user.updatedAt,
        },
        token: newToken,
      },
    })
  } catch (error) {
    res.status(401).json({
      success: false,
      error: '无效的令牌',
    })
  }
}))
