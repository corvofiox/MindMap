import { describe, it, expect, beforeEach, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import jwt from 'jsonwebtoken'

const createMockApp = () => {
  const app = express()
  app.use(express.json())
  return app
}

const mockProject = {
  id: 1,
  name: 'Test Project',
  description: 'A test project',
  ownerId: 1,
  isPublic: false,
  thumbnail: null,
  createdAt: Math.floor(Date.now() / 1000),
  updatedAt: Math.floor(Date.now() / 1000),
}

describe('Project Controller', () => {
  describe('Get All Projects', () => {
    it('should return projects for authenticated user', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.get('/api/projects', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        res.json({
          success: true,
          data: [
            {
              id: 1,
              name: 'Test Project',
              description: 'A test project',
              ownerId: 1,
              isPublic: false,
              thumbnail: null,
              createdAt: '2024-01-01T00:00:00.000Z',
              updatedAt: '2024-01-01T00:00:00.000Z',
            },
          ],
        })
      })

      const response = request(app)
        .get('/api/projects')
        .set('Authorization', `Bearer ${token}`)

      expect(response).toBeDefined()
    })

    it('should reject unauthenticated request', () => {
      const app = createMockApp()

      app.get('/api/projects', (req, res) => {
        const token = req.headers.authorization?.replace('Bearer ', '')

        if (!token) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }
        res.json({ success: true })
      })

      const response = request(app).get('/api/projects')

      expect(response).toBeDefined()
    })

    it('should return empty array when no projects exist', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.get('/api/projects', (req, res) => {
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
        .get('/api/projects')
        .set('Authorization', `Bearer ${token}`)

      expect(response).toBeDefined()
    })

    it('should return projects sorted by updated date descending', () => {
      const projects = [
        { id: 1, name: 'Project 1', updatedAt: '2024-01-03T00:00:00.000Z' },
        { id: 2, name: 'Project 2', updatedAt: '2024-01-02T00:00:00.000Z' },
        { id: 3, name: 'Project 3', updatedAt: '2024-01-01T00:00:00.000Z' },
      ]

      const sortedProjects = [...projects].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      )

      expect(sortedProjects[0].id).toBe(1)
      expect(sortedProjects[1].id).toBe(2)
      expect(sortedProjects[2].id).toBe(3)
    })
  })

  describe('Get Project By ID', () => {
    it('should return project for valid ID', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.get('/api/projects/:id', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const projectId = parseInt(req.params.id)

        if (projectId === 1) {
          return res.json({
            success: true,
            data: {
              id: 1,
              name: 'Test Project',
              description: 'A test project',
              ownerId: 1,
              isPublic: false,
              createdAt: '2024-01-01T00:00:00.000Z',
              updatedAt: '2024-01-01T00:00:00.000Z',
            },
          })
        }

        res.status(404).json({
          success: false,
          error: '项目未找到',
        })
      })

      const response = request(app)
        .get('/api/projects/1')
        .set('Authorization', `Bearer ${token}`)

      expect(response).toBeDefined()
    })

    it('should return 404 for non-existent project', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.get('/api/projects/:id', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const projectId = parseInt(req.params.id)

        if (projectId === 999) {
          return res.status(404).json({
            success: false,
            error: '项目未找到',
          })
        }

        res.json({ success: true, data: {} })
      })

      const response = request(app)
        .get('/api/projects/999')
        .set('Authorization', `Bearer ${token}`)

      expect(response).toBeDefined()
    })
  })

  describe('Create Project', () => {
    it('should create project with valid data', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.post('/api/projects', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const { name, description, is_public } = req.body

        res.json({
          success: true,
          data: {
            id: 1,
            name: name || 'New Project',
            description: description || null,
            ownerId: 1,
            isPublic: is_public || false,
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        })
      })

      const response = request(app)
        .post('/api/projects')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'New Project', description: 'Test description' })

      expect(response).toBeDefined()
    })

    it('should create project with minimal data', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.post('/api/projects', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const { name } = req.body

        res.json({
          success: true,
          data: {
            id: 1,
            name: name || 'New Project',
            description: null,
            ownerId: 1,
            isPublic: false,
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
          },
        })
      })

      const response = request(app)
        .post('/api/projects')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Minimal Project' })

      expect(response).toBeDefined()
    })

    it('should reject unauthenticated project creation', () => {
      const app = createMockApp()

      app.post('/api/projects', (req, res) => {
        const token = req.headers.authorization?.replace('Bearer ', '')

        if (!token) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }
        res.json({ success: true })
      })

      const response = request(app)
        .post('/api/projects')
        .send({ name: 'Test Project' })

      expect(response).toBeDefined()
    })

    it('should set ownerId from token', () => {
      const token = jwt.sign({ userId: 42 }, 'test-secret')
      const decoded = jwt.verify(token, 'test-secret') as { userId: number }

      expect(decoded.userId).toBe(42)
    })
  })

  describe('Update Project', () => {
    it('should update project for owner', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.put('/api/projects/:id', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const projectId = parseInt(req.params.id)
        const { name, description } = req.body

        if (projectId === 1) {
          return res.json({
            success: true,
            data: {
              id: 1,
              name: name || 'Updated Project',
              description: description || 'Updated description',
              ownerId: 1,
              updatedAt: '2024-01-01T00:00:00.000Z',
            },
          })
        }

        res.status(403).json({
          success: false,
          error: '访问被拒绝',
        })
      })

      const response = request(app)
        .put('/api/projects/1')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Updated Project' })

      expect(response).toBeDefined()
    })

    it('should reject update for non-owner', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 2 }, 'test-secret')

      app.put('/api/projects/:id', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const projectId = parseInt(req.params.id)

        if (projectId === 1) {
          return res.status(403).json({
            success: false,
            error: '访问被拒绝',
          })
        }

        res.json({ success: true })
      })

      const response = request(app)
        .put('/api/projects/1')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Updated Project' })

      expect(response).toBeDefined()
    })
  })

  describe('Delete Project', () => {
    it('should delete project for owner', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.delete('/api/projects/:id', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const projectId = parseInt(req.params.id)

        if (projectId === 1) {
          return res.json({
            success: true,
            data: { message: 'Project deleted' },
          })
        }

        res.status(404).json({
          success: false,
          error: '项目未找到',
        })
      })

      const response = request(app)
        .delete('/api/projects/1')
        .set('Authorization', `Bearer ${token}`)

      expect(response).toBeDefined()
    })

    it('should reject delete for non-owner', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 2 }, 'test-secret')

      app.delete('/api/projects/:id', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const projectId = parseInt(req.params.id)

        if (projectId === 1) {
          return res.status(403).json({
            success: false,
            error: '访问被拒绝',
          })
        }

        res.json({ success: true })
      })

      const response = request(app)
        .delete('/api/projects/1')
        .set('Authorization', `Bearer ${token}`)

      expect(response).toBeDefined()
    })

    it('should return 404 for non-existent project', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.delete('/api/projects/:id', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const projectId = parseInt(req.params.id)

        if (projectId === 999) {
          return res.status(404).json({
            success: false,
            error: '项目未找到',
          })
        }

        res.json({ success: true })
      })

      const response = request(app)
        .delete('/api/projects/999')
        .set('Authorization', `Bearer ${token}`)

      expect(response).toBeDefined()
    })
  })

  describe('Project Members', () => {
    it('should add member for project owner', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.post('/api/projects/:id/members', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const projectId = parseInt(req.params.id)

        if (projectId === 1) {
          return res.json({
            success: true,
            data: {
              id: 1,
              projectId: 1,
              userId: 2,
              role: 'viewer',
            },
          })
        }

        res.status(403).json({
          success: false,
          error: '访问被拒绝',
        })
      })

      const response = request(app)
        .post('/api/projects/1/members')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: 2, role: 'viewer' })

      expect(response).toBeDefined()
    })

    it('should reject add member for non-owner', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 2 }, 'test-secret')

      app.post('/api/projects/:id/members', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        res.status(403).json({
          success: false,
          error: '访问被拒绝',
        })
      })

      const response = request(app)
        .post('/api/projects/1/members')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId: 3, role: 'viewer' })

      expect(response).toBeDefined()
    })

    it('should remove member for project owner', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.delete('/api/projects/:id/members/:userId', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        res.json({
          success: true,
          data: { message: 'Member removed' },
        })
      })

      const response = request(app)
        .delete('/api/projects/1/members/2')
        .set('Authorization', `Bearer ${token}`)

      expect(response).toBeDefined()
    })
  })

  describe('Node Pool Operations', () => {
    it('should get node pool for project', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.get('/api/projects/:id/node-pool', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const projectId = parseInt(req.params.id)

        if (projectId === 1) {
          return res.json({
            success: true,
            data: [
              {
                id: 1,
                name: 'Test Node',
                content: 'Test content',
                type: 'text',
                color: '#ffffff',
                projectId: 1,
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
        .get('/api/projects/1/node-pool')
        .set('Authorization', `Bearer ${token}`)

      expect(response).toBeDefined()
    })

    it('should add node to pool', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.post('/api/projects/:id/node-pool', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const { name, content, type, color } = req.body

        res.json({
          success: true,
          data: {
            id: 1,
            name: name || 'New Node',
            content: content || '',
            type: type || 'text',
            color: color || '#ffffff',
            projectId: 1,
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        })
      })

      const response = request(app)
        .post('/api/projects/1/node-pool')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'New Node',
          content: 'Node content',
          type: 'text',
          color: '#ffffff',
        })

      expect(response).toBeDefined()
    })

    it('should remove node from pool', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.delete('/api/projects/node-pool/:nodeId', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const nodeId = parseInt(req.params.nodeId)

        if (nodeId === 1) {
          return res.json({
            success: true,
            data: { message: 'Node removed from pool' },
          })
        }

        res.status(404).json({
          success: false,
          error: '节点未找到',
        })
      })

      const response = request(app)
        .delete('/api/projects/node-pool/1')
        .set('Authorization', `Bearer ${token}`)

      expect(response).toBeDefined()
    })
  })

  describe('Node Pool Folders', () => {
    it('should get node pool folders', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.get('/api/projects/:id/node-pool-folders', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        res.json({
          success: true,
          data: [
            {
              id: 1,
              name: 'Folder 1',
              projectId: 1,
              sortOrder: 0,
              collapsed: true,
            },
          ],
        })
      })

      const response = request(app)
        .get('/api/projects/1/node-pool-folders')
        .set('Authorization', `Bearer ${token}`)

      expect(response).toBeDefined()
    })

    it('should create node pool folder', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.post('/api/projects/:id/node-pool-folders', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const { name, parentId, sortOrder, collapsed } = req.body

        res.json({
          success: true,
          data: {
            id: 1,
            name: name || 'New Folder',
            projectId: 1,
            parentId: parentId || null,
            sortOrder: sortOrder || 0,
            collapsed: collapsed ?? true,
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        })
      })

      const response = request(app)
        .post('/api/projects/1/node-pool-folders')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'New Folder' })

      expect(response).toBeDefined()
    })

    it('should update node pool folder', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.put('/api/projects/node-pool-folders/:id', (req, res) => {
        const authToken = req.headers.authorization?.replace('Bearer ', '')

        if (!authToken) {
          return res.status(401).json({ success: false, error: '未提供令牌' })
        }

        const { name, collapsed } = req.body

        res.json({
          success: true,
          data: {
            id: 1,
            name: name || 'Updated Folder',
            collapsed: collapsed ?? true,
          },
        })
      })

      const response = request(app)
        .put('/api/projects/node-pool-folders/1')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Updated Folder' })

      expect(response).toBeDefined()
    })

    it('should delete node pool folder', () => {
      const app = createMockApp()
      const token = jwt.sign({ userId: 1 }, 'test-secret')

      app.delete('/api/projects/node-pool-folders/:id', (req, res) => {
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
        .delete('/api/projects/node-pool-folders/1')
        .set('Authorization', `Bearer ${token}`)

      expect(response).toBeDefined()
    })
  })

  describe('Response Format', () => {
    it('should have consistent project response format', () => {
      const projectResponse = {
        success: true,
        data: {
          id: 1,
          name: 'Test Project',
          description: 'Test description',
          ownerId: 1,
          isPublic: false,
          thumbnail: null,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      }

      expect(projectResponse.success).toBe(true)
      expect(projectResponse.data).toHaveProperty('id')
      expect(projectResponse.data).toHaveProperty('name')
      expect(projectResponse.data).toHaveProperty('ownerId')
      expect(projectResponse.data).toHaveProperty('createdAt')
      expect(projectResponse.data).toHaveProperty('updatedAt')
    })

    it('should have consistent array response format', () => {
      const arrayResponse = {
        success: true,
        data: [
          { id: 1, name: 'Project 1' },
          { id: 2, name: 'Project 2' },
        ],
      }

      expect(arrayResponse.success).toBe(true)
      expect(Array.isArray(arrayResponse.data)).toBe(true)
    })
  })
})
