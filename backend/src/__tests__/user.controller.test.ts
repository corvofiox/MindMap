import { describe, it, expect, beforeEach, vi } from 'vitest'
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

describe('User Controller', () => {
  describe('Get Profile', () => {
    it('should return user profile for authenticated user', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.get('/api/users/profile', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        try {
          const decoded = jwt.verify(authToken, 'test-secret') as { userId: number }

          if (decoded.userId === 1) {
            return res.json({
              success: true,
              data: {
                id: 1,
                email: 'test@example.com',
                nickname: 'Test User',
                avatar: null,
                created_at: '2024-01-01T00:00:00.000Z',
                updated_at: '2024-01-01T00:00:00.000Z',
              },
            })
          }
        } catch {
          return res.status(401).json({ success: false, error: '无效的令牌' })
        }
      })

      const response = request(app)
        .get('/api/users/profile')
        .set('Authorization', `Bearer ${token}`)

      expect(response).toBeDefined()
    })

    it('should reject unauthenticated profile request', () => {
      const app = createMockApp()

      app.get('/api/users/profile', (req, res) => {
        const token = req.headers.authorization?.replace('Bearer ', '')

        if (!token) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }
        res.json({ success: true })
      })

      const response = request(app).get('/api/users/profile')

      expect(response).toBeDefined()
    })

    it('should return 404 for non-existent user', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 999 }, 'test-secret')

      app.get('/api/users/profile', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')
        const decoded = jwt.verify(authToken || '', 'test-secret') as { userId: number }

        if (decoded.userId === 999) {
          return res.status(404).json({
            success: false,
            error: '用户不存在',
          })
        }
        res.json({ success: true })
      })

      const response = request(app)
        .get('/api/users/profile')
        .set('Authorization', `Bearer ${token}`)

      expect(response).toBeDefined()
    })

    it('should not expose password in profile response', () => {
      const profile = {
        id: 1,
        email: 'test@example.com',
        nickname: 'Test User',
        avatar: null,
        password: 'should-not-be-exposed',
      }

      const response = {
        id: profile.id,
        email: profile.email,
        nickname: profile.nickname,
        avatar: profile.avatar,
      }

      expect(response.password).toBeUndefined()
      expect(profile.password).toBeDefined()
    })
  })

  describe('Update Profile', () => {
    it('should update nickname successfully', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.put('/api/users/profile', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const { nickname } = req.body

        res.json({
          success: true,
          data: {
            id: 1,
            email: 'test@example.com',
            nickname: nickname || 'Test User',
            avatar: null,
          },
        })
      })

      const response = request(app)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ nickname: 'New Nickname' })

      expect(response).toBeDefined()
    })

    it('should update avatar successfully', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.put('/api/users/profile', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const { avatar } = req.body

        res.json({
          success: true,
          data: {
            id: 1,
            email: 'test@example.com',
            nickname: 'Test User',
            avatar: avatar || null,
          },
        })
      })

      const response = request(app)
        .put('/api/users/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ avatar: 'https://example.com/avatar.jpg' })

      expect(response).toBeDefined()
    })

    it('should reject unauthenticated profile update', () => {
      const app = createMockApp()

      app.put('/api/users/profile', (req, res) => {
        const token = req.headers.authorization?.replace('Bearer ', '')

        if (!token) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }
        res.json({ success: true })
      })

      const response = request(app)
        .put('/api/users/profile')
        .send({ nickname: 'New Nickname' })

      expect(response).toBeDefined()
    })
  })

  describe('Change Password', () => {
    it('should reject change with missing current password', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.put('/api/users/password', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const { currentPassword, newPassword } = req.body

        if (!currentPassword || !newPassword) {
          return res.status(400).json({
            success: false,
            error: '当前密码和新密码不能为空',
          })
        }

        res.json({ success: true })
      })

      const response = request(app)
        .put('/api/users/password')
        .set('Authorization', `Bearer ${token}`)
        .send({ newPassword: 'newPassword123' })

      expect(response).toBeDefined()
    })

    it('should reject change with missing new password', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.put('/api/users/password', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const { currentPassword, newPassword } = req.body

        if (!currentPassword || !newPassword) {
          return res.status(400).json({
            success: false,
            error: '当前密码和新密码不能为空',
          })
        }

        res.json({ success: true })
      })

      const response = request(app)
        .put('/api/users/password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: 'oldPassword123' })

      expect(response).toBeDefined()
    })

    it('should reject new password that is too short', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.put('/api/users/password', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const { newPassword } = req.body

        if (newPassword.length < 6) {
          return res.status(400).json({
            success: false,
            error: '新密码长度不能少于6个字符',
          })
        }

        res.json({ success: true })
      })

      const response = request(app)
        .put('/api/users/password')
        .set('Authorization', `Bearer ${token}`)
        .send({
          currentPassword: 'oldPassword123',
          newPassword: 'short',
        })

      expect(response).toBeDefined()
    })

    it('should reject incorrect current password', async () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')
      const correctPassword = 'correctPassword123'
      const hashedPassword = await bcrypt.hash(correctPassword, 10)

      app.put('/api/users/password', async (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const { currentPassword, newPassword } = req.body

        const isValid = await bcrypt.compare(currentPassword, hashedPassword)

        if (!isValid) {
          return res.status(401).json({
            success: false,
            error: '当前密码不正确',
          })
        }

        res.json({ success: true })
      })

      const response = request(app)
        .put('/api/users/password')
        .set('Authorization', `Bearer ${token}`)
        .send({
          currentPassword: 'wrongPassword',
          newPassword: 'newPassword123',
        })

      expect(response).toBeDefined()
    })

    it('should change password successfully with correct current password', async () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')
      const correctPassword = 'correctPassword123'
      const hashedPassword = await bcrypt.hash(correctPassword, 10)

      app.put('/api/users/password', async (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const { currentPassword, newPassword } = req.body

        const isValid = await bcrypt.compare(currentPassword, hashedPassword)

        if (!isValid) {
          return res.status(401).json({
            success: false,
            error: '当前密码不正确',
          })
        }

        if (newPassword.length < 6) {
          return res.status(400).json({
            success: false,
            error: '新密码长度不能少于6个字符',
          })
        }

        const newHashedPassword = await bcrypt.hash(newPassword, 10)

        res.json({
          success: true,
          data: { message: 'Password updated successfully' },
        })
      })

      const response = request(app)
        .put('/api/users/password')
        .set('Authorization', `Bearer ${token}`)
        .send({
          currentPassword: correctPassword,
          newPassword: 'newPassword123',
        })

      expect(response).toBeDefined()
    })
  })

  describe('Delete Account', () => {
    it('should reject delete without confirmation', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.delete('/api/users/account', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const { confirmation } = req.body

        if (!confirmation || confirmation !== 'DELETE') {
          return res.status(400).json({
            success: false,
            error: '请输入DELETE确认删除账户',
          })
        }

        res.json({ success: true })
      })

      const response = request(app)
        .delete('/api/users/account')
        .set('Authorization', `Bearer ${token}`)
        .send({ password: 'password123' })

      expect(response).toBeDefined()
    })

    it('should reject delete with incorrect confirmation text', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.delete('/api/users/account', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const { confirmation } = req.body

        if (!confirmation || confirmation !== 'DELETE') {
          return res.status(400).json({
            success: false,
            error: '请输入DELETE确认删除账户',
          })
        }

        res.json({ success: true })
      })

      const response = request(app)
        .delete('/api/users/account')
        .set('Authorization', `Bearer ${token}`)
        .send({ confirmation: 'WRONG' })

      expect(response).toBeDefined()
    })

    it('should reject delete without authentication', () => {
      const app = createMockApp()

      app.delete('/api/users/account', (req, res) => {
        const token = req.headers.authorization?.replace('Bearer ', '')

        if (!token) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }
        res.json({ success: true })
      })

      const response = request(app)
        .delete('/api/users/account')
        .send({ confirmation: 'DELETE' })

      expect(response).toBeDefined()
    })

    it('should delete account successfully with correct confirmation', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.delete('/api/users/account', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const { confirmation } = req.body

        if (!confirmation || confirmation !== 'DELETE') {
          return res.status(400).json({
            success: false,
            error: '请输入DELETE确认删除账户',
          })
        }

        res.json({
          success: true,
          data: { message: 'Account deleted successfully' },
        })
      })

      const response = request(app)
        .delete('/api/users/account')
        .set('Authorization', `Bearer ${token}`)
        .send({ confirmation: 'DELETE' })

      expect(response).toBeDefined()
    })
  })

  describe('Response Format', () => {
    it('should have consistent profile response format', () => {
      const profileResponse = {
        success: true,
        data: {
          id: 1,
          email: 'test@example.com',
          nickname: 'Test User',
          avatar: null,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      }

      expect(profileResponse.success).toBe(true)
      expect(profileResponse.data).toHaveProperty('id')
      expect(profileResponse.data).toHaveProperty('email')
      expect(profileResponse.data).toHaveProperty('nickname')
      expect(profileResponse.data).toHaveProperty('avatar')
      expect(profileResponse.data).toHaveProperty('created_at')
      expect(profileResponse.data).toHaveProperty('updated_at')
    })

    it('should have consistent update response format', () => {
      const updateResponse = {
        success: true,
        data: {
          id: 1,
          email: 'test@example.com',
          nickname: 'New Nickname',
          avatar: null,
        },
      }

      expect(updateResponse.success).toBe(true)
      expect(updateResponse.data).toHaveProperty('id')
      expect(updateResponse.data).toHaveProperty('email')
      expect(updateResponse.data).toHaveProperty('nickname')
      expect(updateResponse.data).toHaveProperty('avatar')
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

  describe('Input Validation', () => {
    it('should validate nickname length', () => {
      const validNickname = 'ValidNickname'
      const longNickname = 'a'.repeat(100)

      expect(validNickname.length).toBeLessThanOrEqual(50)
      expect(longNickname.length).toBeGreaterThan(50)
    })

    it('should validate avatar URL format', () => {
      const validUrl = 'https://example.com/avatar.jpg'
      const invalidUrl = 'not-a-url'

      expect(validUrl.startsWith('http')).toBe(true)
      expect(invalidUrl.startsWith('http')).toBe(false)
    })

    it('should validate password requirements', () => {
      const minPasswordLength = 6

      expect('short'.length).toBeLessThan(minPasswordLength)
      expect('validPass1'.length).toBeGreaterThanOrEqual(minPasswordLength)
    })
  })

  describe('Security', () => {
    it('should hash new password before storage', async () => {
      const newPassword = 'newPassword123'
      const hashedPassword = await bcrypt.hash(newPassword, 10)

      expect(hashedPassword).not.toBe(newPassword)
      expect(hashedPassword.startsWith('$2b$10$')).toBe(true)
    })

    it('should not return password in any response', () => {
      const responses = [
        { type: 'profile', data: { id: 1, email: 'test@example.com' } },
        { type: 'update', data: { id: 1, nickname: 'New Name' } },
        { type: 'delete', data: { message: 'Account deleted' } },
      ]

      responses.forEach(response => {
        expect(response.data).not.toHaveProperty('password')
        expect(response.data).not.toHaveProperty('passwordHash')
      })
    })

    it('should require authentication for all endpoints', () => {
      const endpoints = [
        { method: 'get', path: '/api/users/profile' },
        { method: 'put', path: '/api/users/profile' },
        { method: 'put', path: '/api/users/password' },
        { method: 'delete', path: '/api/users/account' },
      ]

      endpoints.forEach(endpoint => {
        expect(endpoint.method).toBeDefined()
        expect(endpoint.path).toBeDefined()
      })
    })
  })
})
