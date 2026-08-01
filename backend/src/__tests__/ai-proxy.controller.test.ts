/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { encryptApiKey, decryptApiKey } from '../utils/aiCrypto.js'

process.env.JWT_SECRET = 'test-secret-for-ai-crypto'
process.env.JWT_EXPIRES_IN = '7d'
process.env.PORT = '3999'
process.env.WS_PORT = '3998'
process.env.DB_FILE = ':memory:'
process.env.ALLOWED_ORIGINS = 'http://localhost:5173'
process.env.NODE_ENV = 'test'

// Mock database connection
const mockFindFirst = vi.fn()
const mockFindMany = vi.fn()
const mockInsertValues = vi.fn()
const mockUpdateSetFn = vi.fn()
const mockUpdateWhereFn = vi.fn()
const mockDeleteWhere = vi.fn()

vi.mock('../database/connection.js', () => ({
  db: {
    query: {
      aiProviderKeys: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
        findMany: (...args: unknown[]) => mockFindMany(...args),
      },
    },
    insert: () => ({ values: mockInsertValues }),
    update: () => ({ set: (data: unknown) => ({ where: (...args: unknown[]) => mockUpdateSetFn(data, ...args) }) }),
    delete: () => ({ where: mockDeleteWhere }),
  },
}))

// Mock auth middleware: always authenticate as user 1
vi.mock('../middleware/auth.middleware.js', () => ({
  authenticate: (req: any, _res: any, next: () => void) => {
    req.user = { id: 1, email: 'test@test.com', nickname: 'test', avatar: null }
    next()
  },
}))

import { aiProxyRouter } from '../controllers/ai-proxy.controller.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/ai', aiProxyRouter)
  return app
}

describe('AI Crypto Utils', () => {
  it('should encrypt and decrypt API key round trip', () => {
    const key = 'sk-test-1234567890'
    const encrypted = encryptApiKey(key)
    expect(encrypted).not.toContain(key)
    expect(decryptApiKey(encrypted)).toBe(key)
  })

  it('should produce different ciphertext for same plaintext (random IV)', () => {
    const key = 'sk-same-key'
    expect(encryptApiKey(key)).not.toBe(encryptApiKey(key))
  })

  it('should throw on tampered payload', () => {
    const encrypted = encryptApiKey('sk-secret')
    const [iv, tag, data] = encrypted.split('.')
    const tampered = `${iv}.${tag}.${Buffer.from('tampered').toString('base64')}`
    expect(() => decryptApiKey(tampered)).toThrow()
  })

  it('should throw on invalid payload format', () => {
    expect(() => decryptApiKey('not-a-valid-payload')).toThrow()
  })

  it('should prefer AI_KEY_SECRET when present (independent from JWT_SECRET)', () => {
    const previousAiKeySecret = process.env.AI_KEY_SECRET
    try {
      // 用独立密钥加密
      process.env.AI_KEY_SECRET = 'independent-ai-secret'
      const encrypted = encryptApiKey('sk-independent')
      // 解密必须成功
      expect(decryptApiKey(encrypted)).toBe('sk-independent')

      // 验证与 JWT_SECRET 派生的密钥不兼容（证明独立性）
      delete process.env.AI_KEY_SECRET
      expect(() => decryptApiKey(encrypted)).toThrow()
    } finally {
      if (previousAiKeySecret === undefined) {
        delete process.env.AI_KEY_SECRET
      } else {
        process.env.AI_KEY_SECRET = previousAiKeySecret
      }
    }
  })

  it('should fall back to JWT_SECRET when AI_KEY_SECRET is absent', () => {
    const previousAiKeySecret = process.env.AI_KEY_SECRET
    try {
      delete process.env.AI_KEY_SECRET
      const encrypted = encryptApiKey('sk-fallback')
      expect(decryptApiKey(encrypted)).toBe('sk-fallback')
    } finally {
      if (previousAiKeySecret === undefined) {
        delete process.env.AI_KEY_SECRET
      } else {
        process.env.AI_KEY_SECRET = previousAiKeySecret
      }
    }
  })
})

describe('AI Proxy Controller', () => {
  const app = createApp()
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    mockFindFirst.mockResolvedValue(null)
    mockFindMany.mockResolvedValue([])
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('GET /providers', () => {
    it('should return configured status for all providers', async () => {
      mockFindMany.mockResolvedValue([{ providerId: 'deepseek', baseUrl: null }])
      const res = await request(app).get('/api/ai/providers')
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      const deepseek = res.body.data.find((p: any) => p.providerId === 'deepseek')
      expect(deepseek.configured).toBe(true)
      // 无密钥要求的提供商（ollama）始终视为已配置
      const ollama = res.body.data.find((p: any) => p.providerId === 'ollama')
      expect(ollama.configured).toBe(true)
      const moonshot = res.body.data.find((p: any) => p.providerId === 'moonshot')
      expect(moonshot.configured).toBe(false)
    })
  })

  describe('POST /providers', () => {
    it('should reject unknown provider', async () => {
      const res = await request(app).post('/api/ai/providers').send({ providerId: 'unknown', apiKey: 'sk-x' })
      expect(res.status).toBe(400)
    })

    it('should reject empty api key', async () => {
      const res = await request(app).post('/api/ai/providers').send({ providerId: 'deepseek', apiKey: '' })
      expect(res.status).toBe(400)
    })

    it('should insert encrypted key for new provider', async () => {
      const res = await request(app).post('/api/ai/providers').send({ providerId: 'deepseek', apiKey: 'sk-secret-key' })
      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(mockInsertValues).toHaveBeenCalled()
      const insertArg = mockInsertValues.mock.calls[0][0]
      expect(insertArg.providerId).toBe('deepseek')
      // 密钥必须加密存储，不能明文入库
      expect(insertArg.apiKeyEncrypted).not.toContain('sk-secret-key')
      expect(insertArg.apiKeyEncrypted).toContain('.')
    })

    it('should update existing provider key', async () => {
      mockFindFirst.mockResolvedValue({ id: 5, userId: 1, providerId: 'deepseek' })
      const res = await request(app).post('/api/ai/providers').send({ providerId: 'deepseek', apiKey: 'sk-new' })
      expect(res.status).toBe(200)
      expect(mockUpdateSetFn).toHaveBeenCalled()
      const setArg = mockUpdateSetFn.mock.calls[0][0]
      expect(setArg.apiKeyEncrypted).not.toContain('sk-new')
    })

    it('should reject non-local http base url (SSRF protection)', async () => {
      const res = await request(app).post('/api/ai/providers').send({
        providerId: 'deepseek',
        apiKey: 'sk-x',
        baseUrl: 'http://192.168.1.10:3000',
      })
      expect(res.status).toBe(400)
    })

    it('should allow https base url', async () => {
      mockFindFirst.mockResolvedValue(null)
      const res = await request(app).post('/api/ai/providers').send({
        providerId: 'custom',
        apiKey: 'sk-x',
        baseUrl: 'https://example.com/v1',
      })
      expect(res.status).toBe(200)
    })
  })

  describe('DELETE /providers/:providerId', () => {
    it('should delete key', async () => {
      const res = await request(app).delete('/api/ai/providers/deepseek')
      expect(res.status).toBe(200)
      expect(mockDeleteWhere).toHaveBeenCalled()
    })

    it('should reject unknown provider', async () => {
      const res = await request(app).delete('/api/ai/providers/nope')
      expect(res.status).toBe(400)
    })
  })

  describe('POST /models', () => {
    it('should reject invalid urlPath', async () => {
      const res = await request(app).post('/api/ai/models').send({ providerId: 'deepseek', urlPath: 'not-a-path' })
      expect(res.status).toBe(400)
    })

    it('should reject missing stored key for key-required provider', async () => {
      mockFindFirst.mockResolvedValue(null)
      const res = await request(app).post('/api/ai/models').send({ providerId: 'deepseek', urlPath: '/models' })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('未配置')
    })

    it('should fetch models through proxy with stored key', async () => {
      const encrypted = encryptApiKey('sk-stored')
      mockFindFirst.mockResolvedValue({ providerId: 'deepseek', apiKeyEncrypted: encrypted, baseUrl: null })
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: 'deepseek-chat' }] }),
      })
      const res = await request(app).post('/api/ai/models').send({ providerId: 'deepseek', urlPath: '/models' })
      expect(res.status).toBe(200)
      expect(res.body.data.data[0].id).toBe('deepseek-chat')
      // 上游请求必须携带存储的密钥
      const fetchCall = fetchMock.mock.calls[0]
      expect(fetchCall[0]).toBe('https://api.deepseek.com/models')
      expect(fetchCall[1].headers['Authorization']).toBe('Bearer sk-stored')
    })

    it('should return 502 when upstream fails', async () => {
      const encrypted = encryptApiKey('sk-stored')
      mockFindFirst.mockResolvedValue({ providerId: 'deepseek', apiKeyEncrypted: encrypted, baseUrl: null })
      fetchMock.mockResolvedValue({ ok: false, text: async () => 'rate limited' })
      const res = await request(app).post('/api/ai/models').send({ providerId: 'deepseek', urlPath: '/models' })
      expect(res.status).toBe(502)
      expect(res.body.error).toContain('rate limited')
    })
  })

  describe('POST /chat', () => {
    const chatBody = {
      providerId: 'deepseek',
      urlPath: '/chat/completions',
      body: { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], stream: true },
    }

    it('should reject missing stored key', async () => {
      mockFindFirst.mockResolvedValue(null)
      const res = await request(app).post('/api/ai/chat').send(chatBody)
      expect(res.status).toBe(400)
    })

    it('should reject invalid body', async () => {
      const encrypted = encryptApiKey('sk-stored')
      mockFindFirst.mockResolvedValue({ providerId: 'deepseek', apiKeyEncrypted: encrypted, baseUrl: null })
      const res = await request(app).post('/api/ai/chat').send({ providerId: 'deepseek', urlPath: '/chat/completions', body: 'not-object' })
      expect(res.status).toBe(400)
    })

    it('should stream SSE passthrough for OpenAI-compatible providers', async () => {
      const encrypted = encryptApiKey('sk-stored')
      mockFindFirst.mockResolvedValue({ providerId: 'deepseek', apiKeyEncrypted: encrypted, baseUrl: null })
      const upstreamBody = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n')
          )
          controller.close()
        },
      })
      fetchMock.mockResolvedValue({
        ok: true,
        body: upstreamBody,
      })
      const res = await request(app).post('/api/ai/chat').send(chatBody)
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toContain('text/event-stream')
      expect(res.text).toContain('hello')
      expect(res.text).toContain('[DONE]')
    })

    it('should convert Ollama NDJSON to OpenAI SSE format', async () => {
      const upstreamBody = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode(JSON.stringify({
            model: 'qwen',
            message: { role: 'assistant', content: 'hi' },
            done: false,
          }) + '\n'))
          controller.enqueue(encoder.encode(JSON.stringify({
            model: 'qwen',
            message: { role: 'assistant', content: '' },
            done: true,
          }) + '\n'))
          controller.close()
        },
      })
      fetchMock.mockResolvedValue({
        ok: true,
        body: upstreamBody,
      })
      const res = await request(app).post('/api/ai/chat').send({
        providerId: 'ollama',
        urlPath: '/api/chat',
        body: { model: 'qwen', messages: [{ role: 'user', content: 'hi' }], stream: true },
      })
      expect(res.status).toBe(200)
      expect(res.text).toContain('data: {"choices":[{"delta":{"content":"hi"}}]}')
      expect(res.text).toContain('data: [DONE]')
    })

    it('should return 502 when upstream fails', async () => {
      const encrypted = encryptApiKey('sk-stored')
      mockFindFirst.mockResolvedValue({ providerId: 'deepseek', apiKeyEncrypted: encrypted, baseUrl: null })
      fetchMock.mockResolvedValue({ ok: false, text: async () => 'invalid api key' })
      const res = await request(app).post('/api/ai/chat').send(chatBody)
      expect(res.status).toBe(502)
      expect(res.body.error).toContain('invalid api key')
    })

    it('should return actionable error when stored key cannot be decrypted', async () => {
      mockFindFirst.mockResolvedValue({ providerId: 'deepseek', apiKeyEncrypted: 'corrupted-payload', baseUrl: null })
      const res = await request(app).post('/api/ai/chat').send(chatBody)
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('重新输入密钥')
    })

    it('should reject http base url for non-local hosts', async () => {
      const encrypted = encryptApiKey('sk-stored')
      mockFindFirst.mockResolvedValue({ providerId: 'deepseek', apiKeyEncrypted: encrypted, baseUrl: null })
      const res = await request(app).post('/api/ai/chat').send({
        ...chatBody,
        baseUrl: 'http://10.0.0.5:8080',
      })
      expect(res.status).toBe(400)
    })

    it('should allow IPv6 loopback base url for ollama', async () => {
      const encoder = new TextEncoder()
      fetchMock.mockResolvedValue({
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(JSON.stringify({
              model: 'qwen',
              message: { role: 'assistant', content: 'hi' },
              done: false,
            }) + '\n'))
            controller.enqueue(encoder.encode(JSON.stringify({
              model: 'qwen',
              message: { role: 'assistant', content: '' },
              done: true,
            }) + '\n'))
            controller.close()
          },
        }),
      })
      const res = await request(app).post('/api/ai/chat').send({
        providerId: 'ollama',
        urlPath: '/api/chat',
        baseUrl: 'http://[::1]:11434',
        body: { model: 'qwen', messages: [{ role: 'user', content: 'hi' }], stream: true },
      })
      expect(res.status).toBe(200)
      expect(res.text).toContain('hi')
    })

    it('should pass through raw JSON for ollama non-stream requests', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ message: { content: 'non-stream reply' } }),
        body: null,
      })
      const res = await request(app).post('/api/ai/chat').send({
        providerId: 'ollama',
        urlPath: '/api/chat',
        body: { model: 'qwen', messages: [{ role: 'user', content: 'hi' }], stream: false },
      })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ success: true, data: { message: { content: 'non-stream reply' } } })
    })
  })
})
