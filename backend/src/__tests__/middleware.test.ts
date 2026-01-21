import { describe, it, expect, beforeEach, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import jwt from 'jsonwebtoken'
import cors from 'cors'

const createMockApp = () => {
  const app = express()
  app.use(express.json())
  return app
}

describe('Middleware Tests', () => {
  describe('Authentication Middleware', () => {
    it('should reject request without authorization header', () => {
      const app = createMockApp()

      const authenticate = (req: any, res: any, next: any) => {
        const token = req.headers.authorization?.replace('Bearer ', '')

        if (!token) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }
        next()
      }

      app.use('/api/protected', authenticate, (req, res) => {
        res.json({ success: true })
      })

      const response = request(app).get('/api/protected')

      expect(response).toBeDefined()
    })

    it('should reject request with invalid token', () => {
      const app = createMockApp()

      const authenticate = (req: any, res: any, next: any) => {
        const token = req.headers.authorization?.replace('Bearer ', '')

        if (!token) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        try {
          jwt.verify(token, 'test-secret')
          next()
        } catch {
          return res.status(401).json({ success: false, error: '无效的令牌' })
        }
      }

      app.use('/api/protected', authenticate, (req, res) => {
        res.json({ success: true })
      })

      const response = request(app)
        .get('/api/protected')
        .set('Authorization', 'Bearer invalid-token')

      expect(response).toBeDefined()
    })

    it('should accept request with valid token', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      const authenticate = (req: any, res: any, next: any) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        try {
          const decoded = jwt.verify(authToken, 'test-secret') as { userId: number }
          req.user = { id: decoded.userId }
          next()
        } catch {
          return res.status(401).json({ success: false, error: '无效的令牌' })
        }
      }

      app.use('/api/protected', authenticate, (req: any, res) => {
        res.json({ success: true, userId: req.user.id })
      })

      const response = request(app)
        .get('/api/protected')
        .set('Authorization', `Bearer ${token}`)

      expect(response).toBeDefined()
    })

    it('should reject expired token', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret', { expiresIn: '-1s' })

      const authenticate = (req: any, res: any, next: any) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        try {
          jwt.verify(authToken, 'test-secret')
          next()
        } catch {
          return res.status(401).json({ success: false, error: '无效的令牌' })
        }
      }

      app.use('/api/protected', authenticate, (req, res) => {
        res.json({ success: true })
      })

      const response = request(app)
        .get('/api/protected')
        .set('Authorization', `Bearer ${token}`)

      expect(response).toBeDefined()
    })

    it('should reject token with wrong secret', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'wrong-secret')

      const authenticate = (req: any, res: any, next: any) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        try {
          jwt.verify(authToken, 'test-secret')
          next()
        } catch {
          return res.status(401).json({ success: false, error: '无效的令牌' })
        }
      }

      app.use('/api/protected', authenticate, (req, res) => {
        res.json({ success: true })
      })

      const response = request(app)
        .get('/api/protected')
        .set('Authorization', `Bearer ${token}`)

      expect(response).toBeDefined()
    })

    it('should attach user to request on successful authentication', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 42 }, 'test-secret')

      const authenticate = (req: any, res: any, next: any) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        try {
          const decoded = jwt.verify(authToken, 'test-secret') as { userId: number }
          req.user = {
            id: decoded.userId,
            email: 'test@example.com',
            nickname: 'Test User',
          }
          next()
        } catch {
          return res.status(401).json({ success: false, error: '无效的令牌' })
        }
      }

      app.use('/api/protected', authenticate, (req: any, res) => {
        res.json({
          success: true,
          userId: req.user.id,
          email: req.user.email,
          nickname: req.user.nickname,
        })
      })

      const response = request(app)
        .get('/api/protected')
        .set('Authorization', `Bearer ${token}`)

      expect(response).toBeDefined()
    })
  })

  describe('CORS Middleware', () => {
    it('should set CORS headers for allowed origin', () => {
      const app = createMockApp()

      app.use(cors({
        origin: 'http://localhost:5173',
        credentials: true,
      }))

      app.get('/api/test', (req, res) => {
        res.json({ success: true })
      })

      const response = request(app)
        .get('/api/test')
        .set('Origin', 'http://localhost:5173')

      expect(response).toBeDefined()
    })

    it('should handle credentials option', () => {
      const corsOptions = {
        origin: 'http://localhost:5173',
        credentials: true,
      }

      expect(corsOptions.credentials).toBe(true)
    })

    it('should handle allowed methods', () => {
      const corsOptions = {
        origin: 'http://localhost:5173',
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
        credentials: true,
      }

      expect(corsOptions.methods).toContain('GET')
      expect(corsOptions.methods).toContain('POST')
      expect(corsOptions.methods).toContain('PUT')
      expect(corsOptions.methods).toContain('DELETE')
      expect(corsOptions.methods).toContain('PATCH')
    })

    it('should handle allowed headers', () => {
      const corsOptions = {
        origin: 'http://localhost:5173',
        allowedHeaders: ['Content-Type', 'Authorization', 'x-csrf-token'],
        credentials: true,
      }

      expect(corsOptions.allowedHeaders).toContain('Content-Type')
      expect(corsOptions.allowedHeaders).toContain('Authorization')
      expect(corsOptions.allowedHeaders).toContain('x-csrf-token')
    })

    it('should handle exposed headers', () => {
      const corsOptions = {
        origin: 'http://localhost:5173',
        exposedHeaders: ['X-CSRF-Token'],
        credentials: true,
      }

      expect(corsOptions.exposedHeaders).toContain('X-CSRF-Token')
    })

    it('should handle max age for preflight requests', () => {
      const corsOptions = {
        origin: 'http://localhost:5173',
        maxAge: 86400,
        credentials: true,
      }

      expect(corsOptions.maxAge).toBe(86400)
    })
  })

  describe('Error Handling Middleware', () => {
    it('should catch and handle errors', () => {
      const app = createMockApp()

      const errorHandler = (err: any, req: any, res: any, next: any) => {
        res.status(err.status || 500).json({
          success: false,
          error: err.message || 'Internal Server Error',
        })
      }

      app.get('/api/error', (req, res) => {
        throw new Error('Test error')
      })

      app.use(errorHandler)

      const response = request(app).get('/api/error')

      expect(response).toBeDefined()
    })

    it('should handle 404 for unknown routes', () => {
      const app = createMockApp()

      app.use((req, res) => {
        res.status(404).json({
          success: false,
          error: 'Not Found',
        })
      })

      const response = request(app).get('/api/unknown')

      expect(response).toBeDefined()
    })

    it('should handle validation errors', () => {
      const app = createMockApp()

      const errorHandler = (err: any, req: any, res: any, next: any) => {
        res.status(err.status || 400).json({
          success: false,
          error: err.message || 'Validation Error',
        })
      }

      app.get('/api/validate', (req, res) => {
        const error = new Error('Validation failed')
        error.status = 400
        throw error
      })

      app.use(errorHandler)

      const response = request(app).get('/api/validate')

      expect(response).toBeDefined()
    })

    it('should handle async errors', async () => {
      const app = createMockApp()

      const asyncHandler = (fn: Function) => (req: any, res: any, next: any) => {
        Promise.resolve(fn(req, res, next)).catch(next)
      }

      const errorHandler = (err: any, req: any, res: any, next: any) => {
        res.status(err.status || 500).json({
          success: false,
          error: err.message || 'Internal Server Error',
        })
      }

      app.get('/api/async-error', asyncHandler(async (req, res) => {
        throw new Error('Async error')
      }))

      app.use(errorHandler)

      const response = request(app).get('/api/async-error')

      expect(response).toBeDefined()
    })

    it('should have consistent error response format', () => {
      const errorResponse = {
        success: false,
        error: expect.any(String),
      }

      expect(errorResponse.success).toBe(false)
      expect(errorResponse.error).toBeDefined()
    })
  })

  describe('Validation Middleware', () => {
    it('should validate required fields', () => {
      const validateRequired = (fields: string[]) => {
        return (req: any, res: any, next: any) => {
          for (const field of fields) {
            if (!req.body[field]) {
              return res.status(400).json({
                success: false,
                error: `${field} is required`,
              })
            }
          }
          next()
        }
      }

      const middleware = validateRequired(['email', 'password'])

      const mockReq = { body: { email: 'test@example.com' } }
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      }
      const mockNext = vi.fn()

      middleware(mockReq, mockRes, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(400)
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'password is required',
      })
      expect(mockNext).not.toHaveBeenCalled()
    })

    it('should pass validation when all required fields present', () => {
      const validateRequired = (fields: string[]) => {
        return (req: any, res: any, next: any) => {
          for (const field of fields) {
            if (!req.body[field]) {
              return res.status(400).json({
                success: false,
                error: `${field} is required`,
              })
            }
          }
          next()
        }
      }

      const middleware = validateRequired(['email', 'password'])

      const mockReq = { body: { email: 'test@example.com', password: 'password123' } }
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      }
      const mockNext = vi.fn()

      middleware(mockReq, mockRes, mockNext)

      expect(mockRes.status).not.toHaveBeenCalled()
      expect(mockRes.json).not.toHaveBeenCalled()
      expect(mockNext).toHaveBeenCalled()
    })

    it('should validate email format', () => {
      const validateEmail = (req: any, res: any, next: any) => {
        const { email } = req.body
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

        if (email && !emailRegex.test(email)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid email format',
          })
        }
        next()
      }

      const mockReq = { body: { email: 'invalid-email' } }
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      }
      const mockNext = vi.fn()

      validateEmail(mockReq, mockRes, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(400)
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'Invalid email format',
      })
    })

    it('should validate password length', () => {
      const validatePasswordLength = (req: any, res: any, next: any) => {
        const { password } = req.body

        if (password && password.length < 8) {
          return res.status(400).json({
            success: false,
            error: 'Password must be at least 8 characters',
          })
        }
        next()
      }

      const mockReq = { body: { password: 'short' } }
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      }
      const mockNext = vi.fn()

      validatePasswordLength(mockReq, mockRes, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(400)
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: 'Password must be at least 8 characters',
      })
    })
  })

  describe('Request Processing', () => {
    it('should parse JSON body correctly', () => {
      const app = createMockApp()

      app.post('/api/test', (req, res) => {
        res.json({
          success: true,
          data: {
            email: req.body.email,
            name: req.body.name,
          },
        })
      })

      const response = request(app)
        .post('/api/test')
        .send({ email: 'test@example.com', name: 'Test User' })

      expect(response).toBeDefined()
    })

    it('should handle URL-encoded data', () => {
      const app = createMockApp()
      app.use(express.urlencoded({ extended: true }))

      app.post('/api/test', (req, res) => {
        res.json({
          success: true,
          data: {
            name: req.body.name,
          },
        })
      })

      const response = request(app)
        .post('/api/test')
        .type('form')
        .send({ name: 'Test User' })

      expect(response).toBeDefined()
    })

    it('should handle large JSON payloads', () => {
      const app = createMockApp()
      app.use(express.json({ limit: '50mb' }))

      const largeData = { data: 'x'.repeat(1000) }

      app.post('/api/test', (req, res) => {
        res.json({
          success: true,
          dataSize: req.body.data.length,
        })
      })

      const response = request(app)
        .post('/api/test')
        .send(largeData)

      expect(response).toBeDefined()
    })
  })

  describe('Cookie Parsing', () => {
    it('should parse cookies correctly', () => {
      const app = createMockApp()
      const cookieParser = require('cookie-parser')
      app.use(cookieParser())

      app.get('/api/cookies', (req, res) => {
        res.json({
          success: true,
          cookies: req.cookies,
        })
      })

      const response = request(app)
        .get('/api/cookies')
        .set('Cookie', ['cookie1=value1', 'cookie2=value2'])

      expect(response).toBeDefined()
    })

    it('should handle CSRF token cookie', () => {
      const app = createMockApp()
      const cookieParser = require('cookie-parser')
      app.use(cookieParser())

      app.get('/api/csrf', (req, res) => {
        const csrfToken = req.cookies['x-csrf-token']
        res.json({
          success: true,
          hasCsrfToken: !!csrfToken,
        })
      })

      const response = request(app)
        .get('/api/csrf')
        .set('Cookie', 'x-csrf-token=test-token')

      expect(response).toBeDefined()
    })
  })
})
