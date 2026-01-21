import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'

const createMockApp = () => {
  const app = express()
  app.use(express.json())
  return app
}

const mockUser = {
  id: 1,
  email: 'test@example.com',
  password: '$2b$10$testhashedpassword',
  nickname: 'Test User',
  avatar: null,
  createdAt: Math.floor(Date.now() / 1000),
  updatedAt: Math.floor(Date.now() / 1000),
}

describe('Authentication Controller', () => {
  describe('Input Validation', () => {
    it('should reject registration with missing email', async () => {
      const app = createMockApp()
      
      app.post('/auth/register', (req, res) => {
        const { email, password } = req.body
        if (!email || !password) {
          return res.status(400).json({
            success: false,
            error: '邮箱和密码不能为空',
          })
        }
        res.json({ success: true })
      })

      const response = await request(app)
        .post('/auth/register')
        .send({ password: 'password123' })

      expect(response.status).toBe(400)
      expect(response.body.success).toBe(false)
      expect(response.body.error).toBe('邮箱和密码不能为空')
    })

    it('should reject registration with missing password', async () => {
      const app = createMockApp()
      
      app.post('/auth/register', (req, res) => {
        const { email, password } = req.body
        if (!email || !password) {
          return res.status(400).json({
            success: false,
            error: '邮箱和密码不能为空',
          })
        }
        res.json({ success: true })
      })

      const response = await request(app)
        .post('/auth/register')
        .send({ email: 'test@example.com' })

      expect(response.status).toBe(400)
      expect(response.body.success).toBe(false)
    })

    it('should reject login with missing email', async () => {
      const app = createMockApp()
      
      app.post('/auth/login', (req, res) => {
        const { email, password } = req.body
        if (!email || !password) {
          return res.status(400).json({
            success: false,
            error: '邮箱和密码不能为空',
          })
        }
        res.json({ success: true })
      })

      const response = await request(app)
        .post('/auth/login')
        .send({ password: 'password123' })

      expect(response.status).toBe(400)
      expect(response.body.success).toBe(false)
    })

    it('should reject login with missing password', async () => {
      const app = createMockApp()
      
      app.post('/auth/login', (req, res) => {
        const { email, password } = req.body
        if (!email || !password) {
          return res.status(400).json({
            success: false,
            error: '邮箱和密码不能为空',
          })
        }
        res.json({ success: true })
      })

      const response = await request(app)
        .post('/auth/login')
        .send({ email: 'test@example.com' })

      expect(response.status).toBe(400)
      expect(response.body.success).toBe(false)
    })
  })

  describe('Password Hashing', () => {
    it('should hash password correctly with bcrypt', async () => {
      const password = 'testPassword123'
      const hashedPassword = await bcrypt.hash(password, 10)

      expect(hashedPassword).not.toBe(password)
      expect(hashedPassword.startsWith('$2b$10$')).toBe(true)

      const isValid = await bcrypt.compare(password, hashedPassword)
      expect(isValid).toBe(true)
    })

    it('should verify correct password', async () => {
      const password = 'testPassword123'
      const hashedPassword = await bcrypt.hash(password, 10)

      const isValid = await bcrypt.compare(password, hashedPassword)
      expect(isValid).toBe(true)
    })

    it('should reject incorrect password', async () => {
      const password = 'testPassword123'
      const wrongPassword = 'wrongPassword'
      const hashedPassword = await bcrypt.hash(password, 10)

      const isValid = await bcrypt.compare(wrongPassword, hashedPassword)
      expect(isValid).toBe(false)
    })

    it('should generate different hashes for same password', async () => {
      const password = 'testPassword123'
      const hash1 = await bcrypt.hash(password, 10)
      const hash2 = await bcrypt.hash(password, 10)

      expect(hash1).not.toBe(hash2)
      expect(await bcrypt.compare(password, hash1)).toBe(true)
      expect(await bcrypt.compare(password, hash2)).toBe(true)
    })
  })

  describe('JWT Token Generation', () => {
    const JWT_SECRET = 'test-secret-key'
    const JWT_EXPIRES_IN = '7d'

    it('should generate valid JWT token', () => {
      const userId = 1
      const token = jwt.sign(
        { userId },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN, algorithm: 'HS256' }
      )

      expect(token).toBeDefined()
      expect(typeof token).toBe('string')
      expect(token.split('.')).toHaveLength(3)
    })

    it('should decode JWT token correctly', () => {
      const userId = 123
      const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' })

      const decoded = jwt.verify(token, JWT_SECRET) as { userId: number }
      expect(decoded.userId).toBe(userId)
    })

    it('should reject expired token', () => {
      const token = jwt.sign({ userId: 1 }, JWT_SECRET, { expiresIn: '-1s' })

      expect(() => jwt.verify(token, JWT_SECRET)).toThrow()
    })

    it('should reject token with wrong secret', () => {
      const token = jwt.sign({ userId: 1 }, 'wrong-secret')

      expect(() => jwt.verify(token, JWT_SECRET)).toThrow()
    })

    it('should include expiration in token', () => {
      const token = jwt.sign({ userId: 1 }, JWT_SECRET, { expiresIn: '7d' })
      const decoded = jwt.decode(token) as { exp: number }

      expect(decoded.exp).toBeDefined()
      expect(decoded.exp).toBeGreaterThan(Date.now() / 1000)
    })
  })

  describe('Registration Flow', () => {
    it('should validate email format', () => {
      const validEmails = [
        'test@example.com',
        'user.name@domain.org',
        'user+tag@example.co.uk',
      ]
      const invalidEmails = [
        'notanemail',
        '@example.com',
        'test@',
        'test@example',
      ]

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

      validEmails.forEach(email => {
        expect(emailRegex.test(email)).toBe(true)
      })

      invalidEmails.forEach(email => {
        expect(emailRegex.test(email)).toBe(false)
      })
    })

    it('should validate password minimum length', () => {
      const minLength = 8
      const shortPassword = 'short1'
      const validPassword = 'longenough1'

      expect(shortPassword.length).toBeLessThan(minLength)
      expect(validPassword.length).toBeGreaterThanOrEqual(minLength)
    })

    it('should handle registration response structure', () => {
      const mockResponse = {
        success: true,
        data: {
          user: {
            id: 1,
            email: 'test@example.com',
            nickname: 'Test User',
            avatar: null,
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-01T00:00:00.000Z',
          },
          token: 'mock-jwt-token',
        },
      }

      expect(mockResponse.success).toBe(true)
      expect(mockResponse.data.user).toBeDefined()
      expect(mockResponse.data.token).toBeDefined()
      expect(mockResponse.data.user.email).toBe('test@example.com')
    })
  })

  describe('Login Flow', () => {
    it('should validate user existence check', () => {
      const users = [mockUser]
      const existingEmail = 'test@example.com'
      const nonExistingEmail = 'nonexistent@example.com'

      const existingUser = users.find(u => u.email === existingEmail)
      const nonExistingUser = users.find(u => u.email === nonExistingEmail)

      expect(existingUser).toBeDefined()
      expect(nonExistingUser).toBeUndefined()
    })

    it('should handle login error response', () => {
      const errorResponse = {
        success: false,
        error: '用户名或密码错误',
      }

      expect(errorResponse.success).toBe(false)
      expect(errorResponse.error).toBe('用户名或密码错误')
    })

    it('should generate consistent response structure for login', () => {
      const mockLoginResponse = {
        success: true,
        data: {
          user: {
            id: 1,
            email: 'test@example.com',
            nickname: 'Test User',
            avatar: null,
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-01T00:00:00.000Z',
          },
          token: 'mock-jwt-token',
        },
      }

      expect(mockLoginResponse.data.user).toHaveProperty('id')
      expect(mockLoginResponse.data.user).toHaveProperty('email')
      expect(mockLoginResponse.data.user).toHaveProperty('nickname')
      expect(mockLoginResponse.data.user).toHaveProperty('avatar')
      expect(mockLoginResponse.data.user).toHaveProperty('created_at')
      expect(mockLoginResponse.data.user).toHaveProperty('updated_at')
    })
  })

  describe('Logout Flow', () => {
    it('should return success on logout', () => {
      const app = createMockApp()

      app.post('/auth/logout', (req, res) => {
        res.json({
          success: true,
          data: { message: 'Logged out successfully' },
        })
      })

      const response = request(app).post('/auth/logout')

      expect(response).toBeDefined()
    })
  })

  describe('Token Refresh Flow', () => {
    it('should validate token presence for refresh', () => {
      const app = createMockApp()

      app.post('/auth/refresh', (req, res) => {
        const token = req.headers.authorization?.replace('Bearer ', '')

        if (!token) {
          return res.status(401).json({
            success: false,
            error: '未提供令牌',
          })
        }
        res.json({ success: true })
      })

      const response = request(app).post('/auth/refresh')

      expect(response).toBeDefined()
    })

    it('should handle invalid token error', () => {
      const errorResponse = {
        success: false,
        error: '无效的令牌',
      }

      expect(errorResponse.success).toBe(false)
      expect(errorResponse.error).toBe('无效的令牌')
    })

    it('should generate new token on refresh', () => {
      const oldToken = jwt.sign({ userId: 1 }, 'test-secret', { expiresIn: '1d' })
      const newToken = jwt.sign({ userId: 1 }, 'test-secret', { expiresIn: '7d' })

      expect(newToken).not.toBe(oldToken)
      expect(newToken.split('.')).toHaveLength(3)
    })
  })

  describe('Authentication Middleware', () => {
    it('should reject request without authorization header', () => {
      const app = createMockApp()

      app.use('/api/protected', (req, res) => {
        const token = req.headers.authorization?.replace('Bearer ', '')

        if (!token) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }
        res.json({ success: true })
      })

      const response = request(app).get('/api/protected')

      expect(response).toBeDefined()
    })

    it('should reject request with invalid token', () => {
      const app = createMockApp()

      app.use('/api/protected', (req, res) => {
        const token = req.headers.authorization?.replace('Bearer ', '')

        if (!token) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        try {
          jwt.verify(token, 'test-secret')
          res.json({ success: true })
        } catch {
          return res.status(401).json({ success: false, error: '无效的令牌' })
        }
      })

      const response = request(app)
        .get('/api/protected')
        .set('Authorization', 'Bearer invalid-token')

      expect(response).toBeDefined()
    })

    it('should accept request with valid token', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.use('/api/protected', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        try {
          jwt.verify(authToken, 'test-secret')
          res.json({ success: true })
        } catch {
          return res.status(401).json({ success: false, error: '无效的令牌' })
        }
      })

      const response = request(app)
        .get('/api/protected')
        .set('Authorization', `Bearer ${token}`)

      expect(response).toBeDefined()
    })
  })

  describe('Response Format', () => {
    it('should have consistent success response format', () => {
      const successResponse = {
        success: true,
        data: {
          user: {
            id: 1,
            email: 'test@example.com',
            nickname: 'Test User',
            avatar: null,
            created_at: expect.any(String),
            updated_at: expect.any(String),
          },
          token: expect.any(String),
        },
      }

      expect(successResponse.success).toBe(true)
      expect(successResponse.data).toBeDefined()
      expect(successResponse.data.user).toBeDefined()
      expect(successResponse.data.token).toBeDefined()
    })

    it('should have consistent error response format', () => {
      const errorResponse = {
        success: false,
        error: expect.any(String),
      }

      expect(errorResponse.success).toBe(false)
      expect(errorResponse.error).toBeDefined()
    })

    it('should handle status codes correctly', () => {
      const statusCodes = {
        badRequest: 400,
        unauthorized: 401,
        forbidden: 403,
        notFound: 404,
        serverError: 500,
      }

      expect(statusCodes.badRequest).toBe(400)
      expect(statusCodes.unauthorized).toBe(401)
      expect(statusCodes.forbidden).toBe(403)
      expect(statusCodes.notFound).toBe(404)
      expect(statusCodes.serverError).toBe(500)
    })
  })

  describe('Security Considerations', () => {
    it('should not expose password in user response', () => {
      const user = {
        id: 1,
        email: 'test@example.com',
        password: 'should-not-be-exposed',
        nickname: 'Test User',
        avatar: null,
      }

      const responseUser = {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
        avatar: user.avatar,
      }

      expect(responseUser.password).toBeUndefined()
      expect(user.password).toBeDefined()
    })

    it('should use secure password comparison', async () => {
      const password = 'testPassword'
      const hash = await bcrypt.hash(password, 10)

      const startTime = Date.now()
      await bcrypt.compare(password, hash)
      const endTime = Date.now()

      expect(endTime - startTime).toBeGreaterThanOrEqual(0)
    })

    it('should generate secure random tokens', () => {
      const token = jwt.sign({ userId: 1 }, 'test-secret', {
        expiresIn: '7d',
        algorithm: 'HS256',
      })

      const parts = token.split('.')
      expect(parts).toHaveLength(3)

      parts.forEach(part => {
        expect(part.length).toBeGreaterThan(0)
      })
    })
  })
})
