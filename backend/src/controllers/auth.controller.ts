import { Router } from 'express'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { db, saveDatabase } from '../database/connection.js'
import { users } from '../database/schema.js'
import { eq } from 'drizzle-orm'
import { asyncHandler } from '../middleware/error.middleware.js'

export const authRouter = Router()

// Register
authRouter.post('/register', asyncHandler(async (req, res) => {
  const { email, password, nickname } = req.body

  // Validate input
  if (!email || !password) {
    return res.status(400).json({
      success: false,
      error: 'Email and password are required',
    })
  }

  // Check if user exists
  const existingUsers = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
  const existingUser = existingUsers[0]

  if (existingUser) {
    return res.status(400).json({
      success: false,
      error: 'Email already registered',
    })
  }

  // Hash password
  const hashedPassword = await bcrypt.hash(password, 10)

  // Create user
  const result = await db
    .insert(users)
    .values({
      email,
      password: hashedPassword,
      nickname: nickname || null,
    })
    .returning()

  const newUser = result[0]

  // Generate token
  const token = (jwt as any).sign(
    { userId: newUser.id },
    process.env.JWT_SECRET || 'your-secret-key',
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  )

  // Save database immediately
  await saveDatabase()

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
authRouter.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body

  // Find user
  const usersList = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
  const user = usersList[0]

  if (!user || !user.password) {
    return res.status(401).json({
      success: false,
      error: 'Invalid credentials',
    })
  }

  // Verify password
  const isValid = await bcrypt.compare(password, user.password)

  if (!isValid) {
    return res.status(401).json({
      success: false,
      error: 'Invalid credentials',
    })
  }

  // Generate token
  const token = (jwt as any).sign(
    { userId: user.id },
    process.env.JWT_SECRET || 'your-secret-key',
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
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
authRouter.post('/refresh', asyncHandler(async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '')

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'No token provided',
    })
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key') as {
      userId: number
    }

    const usersList = await db
      .select()
      .from(users)
      .where(eq(users.id, decoded.userId))
    const user = usersList[0]

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid token',
      })
    }

    const newToken = (jwt as any).sign(
      { userId: user.id },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
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
    return res.status(401).json({
      success: false,
      error: 'Invalid token',
    })
  }
}))
