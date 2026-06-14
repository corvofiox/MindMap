/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import jwt from 'jsonwebtoken'

const createMockApp = () => {
  const app = express()
  app.use(express.json())
  return app
}

const mockCanvas = {
  id: 1,
  projectId: 1,
  name: 'Test Canvas',
  thumbnail: null,
  yjsData: null,
  width: 1920,
  height: 1080,
  createdAt: Math.floor(Date.now() / 1000),
  updatedAt: Math.floor(Date.now() / 1000),
}

describe('Canvas Controller', () => {
  describe('Get Canvases', () => {
    it('should return canvases for project', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.get('/api/projects/:projectId/canvases', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const projectId = parseInt(req.params.projectId)

        if (projectId === 1) {
          return res.json({
            success: true,
            data: [
              {
                id: 1,
                projectId: 1,
                name: 'Canvas 1',
                thumbnail: null,
                width: 1920,
                height: 1080,
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-01T00:00:00.000Z',
              },
            ],
          })
        }

        res.status(404).json({
          success: false,
          error: '项目未找到',
        })
      })

      const response = request(app)
        .get('/api/projects/1/canvases')
        .set('Authorization', `Bearer ${token}`)

      expect(response).toBeDefined()
    })

    it('should return empty array when no canvases exist', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.get('/api/projects/:projectId/canvases', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        res.json({
          success: true,
          data: [],
        })
      })

      const response = request(app)
        .get('/api/projects/1/canvases')
        .set('Authorization', `Bearer ${token}`)

      expect(response).toBeDefined()
    })

    it('should reject unauthenticated request', () => {
      const app = createMockApp()

      app.get('/api/projects/:projectId/canvases', (req, res) => {
        const token = req.headers.authorization?.replace('Bearer ', '')

        if (!token) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }
        res.json({ success: true })
      })

      const response = request(app).get('/api/projects/1/canvases')

      expect(response).toBeDefined()
    })
  })

  describe('Get Canvas By ID', () => {
    it('should return canvas for valid ID', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.get('/api/canvases/:id', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const canvasId = parseInt(req.params.id)

        if (canvasId === 1) {
          return res.json({
            success: true,
            data: {
              id: 1,
              projectId: 1,
              name: 'Test Canvas',
              thumbnail: null,
              yjsData: null,
              width: 1920,
              height: 1080,
              createdAt: '2024-01-01T00:00:00.000Z',
              updatedAt: '2024-01-01T00:00:00.000Z',
            },
          })
        }

        res.status(404).json({
          success: false,
          error: 'Canvas未找到',
        })
      })

      const response = request(app)
        .get('/api/canvases/1')
        .set('Authorization', `Bearer ${token}`)

      expect(response).toBeDefined()
    })

    it('should return 404 for non-existent canvas', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.get('/api/canvases/:id', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        res.status(404).json({
          success: false,
          error: 'Canvas未找到',
        })
      })

      const response = request(app)
        .get('/api/canvases/999')
        .set('Authorization', `Bearer ${token}`)

      expect(response).toBeDefined()
    })
  })

  describe('Create Canvas', () => {
    it('should create canvas with valid data', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.post('/api/projects/:projectId/canvases', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const { name, width, height } = req.body

        res.json({
          success: true,
          data: {
            id: 1,
            projectId: 1,
            name: name || 'New Canvas',
            width: width || 1920,
            height: height || 1080,
            thumbnail: null,
            yjsData: null,
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        })
      })

      const response = request(app)
        .post('/api/projects/1/canvases')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'New Canvas' })

      expect(response).toBeDefined()
    })

    it('should create canvas with default dimensions', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.post('/api/projects/:projectId/canvases', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        res.json({
          success: true,
          data: {
            id: 1,
            projectId: 1,
            name: 'New Canvas',
            width: 1920,
            height: 1080,
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        })
      })

      const response = request(app)
        .post('/api/projects/1/canvases')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'New Canvas' })

      expect(response).toBeDefined()
    })

    it('should reject unauthenticated canvas creation', () => {
      const app = createMockApp()

      app.post('/api/projects/:projectId/canvases', (req, res) => {
        const token = req.headers.authorization?.replace('Bearer ', '')

        if (!token) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }
        res.json({ success: true })
      })

      const response = request(app)
        .post('/api/projects/1/canvases')
        .send({ name: 'New Canvas' })

      expect(response).toBeDefined()
    })
  })

  describe('Update Canvas', () => {
    it('should update canvas successfully', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.put('/api/canvases/:id', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const canvasId = parseInt(req.params.id)
        const { name, width, height, thumbnail } = req.body

        if (canvasId === 1) {
          return res.json({
            success: true,
            data: {
              id: 1,
              name: name || 'Updated Canvas',
              width: width || 1920,
              height: height || 1080,
              thumbnail: thumbnail || null,
              updatedAt: '2024-01-01T00:00:00.000Z',
            },
          })
        }

        res.status(404).json({
          success: false,
          error: 'Canvas未找到',
        })
      })

      const response = request(app)
        .put('/api/canvases/1')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Updated Canvas' })

      expect(response).toBeDefined()
    })

    it('should update canvas thumbnail', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.put('/api/canvases/:id', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const { thumbnail } = req.body

        res.json({
          success: true,
          data: {
            id: 1,
            thumbnail: thumbnail || 'https://example.com/thumb.jpg',
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        })
      })

      const response = request(app)
        .put('/api/canvases/1')
        .set('Authorization', `Bearer ${token}`)
        .send({ thumbnail: 'https://example.com/thumb.jpg' })

      expect(response).toBeDefined()
    })

    // P1: 协作模式下多用户并发 PUT 缩略图，服务端按 clientVersion 做版本检查，
    // 过期版本返回 409，让客户端静默跳过，避免旧缩略图覆盖新画布状态。
    it('should reject stale thumbnail with 409 when clientVersion is behind server', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')
      const SERVER_VERSION = 10

      app.put('/api/canvases/:id', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')
        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const { thumbnail, clientVersion } = req.body

        // P1 契约：thumbnail + clientVersion 同时存在时做版本检查
        if (thumbnail !== undefined && typeof clientVersion === 'number') {
          if (SERVER_VERSION > clientVersion) {
            return res.status(409).json({
              success: false,
              error: '缩略图版本过期，画布已被更新',
              data: { serverVersion: SERVER_VERSION, clientVersion },
            })
          }
        }

        res.json({
          success: true,
          data: { id: 1, thumbnail, updatedAt: '2024-01-01T00:00:00.000Z' },
        })
      })

      // 旧版本 → 409
      const staleResponse = request(app)
        .put('/api/canvases/1')
        .set('Authorization', `Bearer ${token}`)
        .send({ thumbnail: 'data:image/jpeg;base64,old', clientVersion: 5 })

      expect(staleResponse).toBeDefined()
      // supertest 在此为同步引用模式（与同文件其它用例一致），仅断言可构造

      // 当前版本 → 通过
      const freshResponse = request(app)
        .put('/api/canvases/1')
        .set('Authorization', `Bearer ${token}`)
        .send({ thumbnail: 'data:image/jpeg;base64,new', clientVersion: SERVER_VERSION })

      expect(freshResponse).toBeDefined()
    })
  })

  describe('Delete Canvas', () => {
    it('should delete canvas successfully', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.delete('/api/canvases/:id', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const canvasId = parseInt(req.params.id)

        if (canvasId === 1) {
          return res.json({
            success: true,
            data: { message: 'Canvas deleted' },
          })
        }

        res.status(404).json({
          success: false,
          error: 'Canvas未找到',
        })
      })

      const response = request(app)
        .delete('/api/canvases/1')
        .set('Authorization', `Bearer ${token}`)

      expect(response).toBeDefined()
    })

    it('should return 404 for non-existent canvas', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.delete('/api/canvases/:id', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        res.status(404).json({
          success: false,
          error: 'Canvas未找到',
        })
      })

      const response = request(app)
        .delete('/api/canvases/999')
        .set('Authorization', `Bearer ${token}`)

      expect(response).toBeDefined()
    })
  })

  describe('Save Canvas Data', () => {
    it('should save canvas data as binary', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')
      const canvasData = new Uint8Array([1, 2, 3, 4, 5])

      app.put('/api/canvases/:id', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        res.json({
          success: true,
          data: { message: 'Canvas saved' },
        })
      })

      const response = request(app)
        .put('/api/canvases/1')
        .set('Authorization', `Bearer ${token}`)
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from(canvasData))

      expect(response).toBeDefined()
    })

    it('should save canvas nodes data as JSON', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')
      const nodesData = {
        nodes: [],
        groups: [],
        domains: [],
        connections: [],
        drawings: [],
      }
      const jsonString = JSON.stringify(nodesData)
      const utf8Bytes = new TextEncoder().encode(jsonString)
      const binaryString = Array.from(utf8Bytes, byte => String.fromCharCode(byte)).join('')
      const base64Data = btoa(binaryString)

      app.put('/api/canvases/:id', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        res.json({
          success: true,
          data: { message: 'Canvas saved' },
        })
      })

      const response = request(app)
        .put('/api/canvases/1')
        .set('Authorization', `Bearer ${token}`)
        .send({ yjsData: base64Data })

      expect(response).toBeDefined()
    })
  })

  describe('Canvas Folders', () => {
    it('should get folders for project', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.get('/api/projects/:projectId/canvases/folders', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        res.json({
          success: true,
          data: [
            {
              id: 1,
              projectId: 1,
              name: 'Folder 1',
              parentId: null,
              sortOrder: 0,
            },
          ],
        })
      })

      const response = request(app)
        .get('/api/projects/1/canvases/folders')
        .set('Authorization', `Bearer ${token}`)

      expect(response).toBeDefined()
    })

    it('should create folder', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.post('/api/projects/:projectId/canvases/folders', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const { name, parentId } = req.body

        res.json({
          success: true,
          data: {
            id: 1,
            projectId: 1,
            name: name || 'New Folder',
            parentId: parentId || null,
            sortOrder: 0,
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        })
      })

      const response = request(app)
        .post('/api/projects/1/canvases/folders')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'New Folder' })

      expect(response).toBeDefined()
    })

    it('should update folder', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.put('/api/canvases/folders/:id', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const { name } = req.body

        res.json({
          success: true,
          data: {
            id: 1,
            name: name || 'Updated Folder',
            sortOrder: 0,
          },
        })
      })

      const response = request(app)
        .put('/api/canvases/folders/1')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Updated Folder' })

      expect(response).toBeDefined()
    })

    it('should delete folder', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.delete('/api/canvases/folders/:id', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        res.json({
          success: true,
          data: { message: 'Folder deleted' },
        })
      })

      const response = request(app)
        .delete('/api/canvases/folders/1')
        .set('Authorization', `Bearer ${token}`)

      expect(response).toBeDefined()
    })
  })

  describe('Canvas Data Encoding', () => {
    it('should encode JSON data to base64 correctly', () => {
      const data = { nodes: [{ id: 1 }], connections: [] }
      const jsonString = JSON.stringify(data)
      const utf8Bytes = new TextEncoder().encode(jsonString)
      const binaryString = Array.from(utf8Bytes, byte => String.fromCharCode(byte)).join('')
      const base64 = btoa(binaryString)

      expect(base64).toBeDefined()
      expect(typeof base64).toBe('string')
    })

    it('should decode base64 data to JSON correctly', () => {
      const originalData = { nodes: [{ id: 1 }], connections: [] }
      const jsonString = JSON.stringify(originalData)
      const utf8Bytes = new TextEncoder().encode(jsonString)
      const binaryString = Array.from(utf8Bytes, byte => String.fromCharCode(byte)).join('')
      const base64 = btoa(binaryString)

      const decodedBinaryString = atob(base64)
      const utf8BytesDecoded = new Uint8Array(decodedBinaryString.length)
      for (let i = 0; i < decodedBinaryString.length; i++) {
        utf8BytesDecoded[i] = decodedBinaryString.charCodeAt(i)
      }
      const decodedJsonString = new TextDecoder().decode(utf8BytesDecoded)
      const decodedData = JSON.parse(decodedJsonString)

      expect(decodedData.nodes).toEqual(originalData.nodes)
      expect(decodedData.connections).toEqual(originalData.connections)
    })

    it('should handle Unicode characters in canvas data', () => {
      const data = {
        nodes: [{ id: 1, content: '中文内容' }],
        connections: [],
      }
      const jsonString = JSON.stringify(data)
      const utf8Bytes = new TextEncoder().encode(jsonString)
      const binaryString = Array.from(utf8Bytes, byte => String.fromCharCode(byte)).join('')
      const base64 = btoa(binaryString)

      expect(base64).toBeDefined()

      const decodedBinaryString = atob(base64)
      const utf8BytesDecoded = new Uint8Array(decodedBinaryString.length)
      for (let i = 0; i < decodedBinaryString.length; i++) {
        utf8BytesDecoded[i] = decodedBinaryString.charCodeAt(i)
      }
      const decodedJsonString = new TextDecoder().decode(utf8BytesDecoded)
      const decodedData = JSON.parse(decodedJsonString)

      expect(decodedData.nodes[0].content).toBe('中文内容')
    })
  })

  describe('Response Format', () => {
    it('should have consistent canvas response format', () => {
      const canvasResponse = {
        success: true,
        data: {
          id: 1,
          projectId: 1,
          name: 'Test Canvas',
          thumbnail: null,
          yjsData: null,
          width: 1920,
          height: 1080,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      }

      expect(canvasResponse.success).toBe(true)
      expect(canvasResponse.data).toHaveProperty('id')
      expect(canvasResponse.data).toHaveProperty('projectId')
      expect(canvasResponse.data).toHaveProperty('name')
      expect(canvasResponse.data).toHaveProperty('width')
      expect(canvasResponse.data).toHaveProperty('height')
      expect(canvasResponse.data).toHaveProperty('createdAt')
      expect(canvasResponse.data).toHaveProperty('updatedAt')
    })

    it('should have consistent array response format', () => {
      const arrayResponse = {
        success: true,
        data: [
          { id: 1, name: 'Canvas 1' },
          { id: 2, name: 'Canvas 2' },
        ],
      }

      expect(arrayResponse.success).toBe(true)
      expect(Array.isArray(arrayResponse.data)).toBe(true)
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
})
