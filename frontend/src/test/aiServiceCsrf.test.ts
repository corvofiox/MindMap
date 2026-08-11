/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
// CSRF-FIX2 回归测试：原生 fetch 的 CSRF 403 自愈（fetchWithCsrfRetry）——
// 403 invalid csrf token 时：清 cookie → 重新获取 token → 用新 token 重试一次。
// 覆盖两条调用路径：fetchModels（普通 JSON）与 sendStreamChatMessage（SSE 流式）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  fetchModels,
  sendStreamChatMessage,
  type AIProvider,
  type AIModel,
  type AIConfig,
} from '../services/aiService'
import { apiClient } from '../services/apiClient.js'

// 模拟 apiClient：getCsrfTokenFromServer 会"刷新" token，getAuthHeaders 随之返回新 token
const state = vi.hoisted(() => ({ csrfToken: 'stale-token' }))
vi.mock('../services/apiClient.js', () => ({
  apiClient: {
    ensureCsrfToken: vi.fn().mockResolvedValue(undefined),
    getCsrfTokenFromServer: vi.fn().mockImplementation(async () => {
      state.csrfToken = 'fresh-token'
      return { token: 'fresh-token' }
    }),
    getAuthHeaders: vi.fn(() => ({ 'x-csrf-token': state.csrfToken })),
  },
}))

const provider: AIProvider = {
  id: 'custom',
  name: 'Custom',
  description: '',
  baseUrl: 'https://api.example.com',
  apiKeyRequired: false,
  modelsEndpoint: '/v1/models',
  chatEndpoint: '/v1/chat/completions',
  parseModels: (data: unknown) => data as AIModel[],
  parseChatResponse: () => ({ content: '' }),
}

function mockResponse(status: number, body: unknown) {
  const json = () => Promise.resolve(body)
  return {
    status,
    ok: status >= 200 && status < 300,
    json,
    clone: () => ({ json }),
  } as unknown as Response
}

// jsdom 无 ReadableStream 全局，用等价的 reader mock 模拟 SSE 响应流
function mockSseStream(chunks: string[]) {
  const encoder = new TextEncoder()
  const queue = chunks.map((c) => encoder.encode(c))
  return {
    getReader: () => ({
      read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
        const value = queue.shift()
        return value === undefined ? { done: true } : { done: false, value }
      },
    }),
  }
}

function mockSseResponse(chunks: string[]) {
  return {
    status: 200,
    ok: true,
    json: () => Promise.resolve({}),
    clone: () => ({ json: () => Promise.resolve({}) }),
    body: mockSseStream(chunks),
  } as unknown as Response
}

// headers 可能是对象字面量或 Headers 实例（重试分支现返回 Headers 实例），统一归一为普通对象再断言
function headerEntries(headersInit: unknown): Record<string, string> {
  return Object.fromEntries(new Headers(headersInit as HeadersInit).entries())
}

// 拦截 document.cookie 的写入（jsdom 的 cookie 是 Document.prototype 上的访问器，
// 在实例上 defineProperty 遮蔽即可捕获清除行执行）
function mockDocumentCookieSetter() {
  const setter = vi.fn()
  const original = Object.getOwnPropertyDescriptor(document, 'cookie')
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    enumerable: true,
    get: () => '',
    set: (value: string) => setter(value),
  })
  return {
    setter,
    restore: () => {
      if (original) {
        Object.defineProperty(document, 'cookie', original)
      } else {
        delete (document as unknown as Record<string, unknown>).cookie
      }
    },
  }
}

describe('CSRF-FIX2: 原生 fetch 的 CSRF 403 自愈', () => {
  beforeEach(() => {
    state.csrfToken = 'stale-token'
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetchModels：403 invalid csrf token → 清 cookie → 重新获取 → 重试一次成功', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(403, { success: false, error: 'invalid csrf token' }))
      .mockResolvedValueOnce(mockResponse(200, { success: true, data: [{ id: 'm1', name: 'Model 1' }] }))
    vi.stubGlobal('fetch', fetchMock)
    const cookieMock = mockDocumentCookieSetter()

    try {
      const models = await fetchModels(provider, 'dummy-key')

      expect(fetchMock).toHaveBeenCalledTimes(2)
      // 首次请求携带旧 token（锁定"首调旧 token → 403 → 换新 token 重试"的完整行为）
      const firstHeaders = headerEntries((fetchMock.mock.calls[0][1] as any).headers)
      expect(firstHeaders['x-csrf-token']).toBe('stale-token')
      // 重试请求应携带新 token
      const retryHeaders = headerEntries((fetchMock.mock.calls[1][1] as any).headers)
      expect(retryHeaders['x-csrf-token']).toBe('fresh-token')
      // 403 后执行了 cookie 清除行（x-csrf-token= 过期写）——删掉该行此断言会红
      expect(cookieMock.setter).toHaveBeenCalledTimes(1)
      expect(cookieMock.setter.mock.calls[0][0]).toContain('x-csrf-token=')
      expect(cookieMock.setter.mock.calls[0][0]).toContain('expires=Thu, 01 Jan 1970')
      // 顺序：清 cookie → 重新获取 token → 重试请求
      const refetchOrder = (
        apiClient.getCsrfTokenFromServer as unknown as { mock: { invocationCallOrder: number[] } }
      ).mock.invocationCallOrder[0]
      expect(cookieMock.setter.mock.invocationCallOrder[0]).toBeLessThan(refetchOrder)
      expect(refetchOrder).toBeLessThan(fetchMock.mock.invocationCallOrder[1])
      expect(apiClient.getCsrfTokenFromServer).toHaveBeenCalledTimes(1)
      expect(models).toEqual([{ id: 'm1', name: 'Model 1' }])
    } finally {
      cookieMock.restore()
    }
  })

  it('sendStreamChatMessage：SSE 流首次 403 → 重试保留 Accept: text/event-stream 且重试响应流可消费', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(403, { success: false, error: 'invalid csrf token' }))
      .mockResolvedValueOnce(
        mockSseResponse([
          'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
          'data: [DONE]\n\n',
        ])
      )
    vi.stubGlobal('fetch', fetchMock)

    const onContentChunk = vi.fn()
    const onComplete = vi.fn()
    const config: AIConfig = { provider: 'custom', baseUrl: '', model: 'test-model' }

    await sendStreamChatMessage(
      'custom',
      config,
      [{ role: 'user', content: 'hi' }],
      { onContentChunk, onComplete },
      false
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    // 首次请求已带 SSE 头
    const firstHeaders = headerEntries((fetchMock.mock.calls[0][1] as any).headers)
    expect(firstHeaders['accept']).toBe('text/event-stream')
    // 重试请求保留 'Accept: text/event-stream'（Headers API 归一后键为小写）+ 新 token
    const retryHeaders = headerEntries((fetchMock.mock.calls[1][1] as any).headers)
    expect(retryHeaders['accept']).toBe('text/event-stream')
    expect(retryHeaders['x-csrf-token']).toBe('fresh-token')
    // 重试后的响应体可通过 getReader 正常消费（若重试返回的是首调 403 响应，
    // body 为 null 会抛"无法获取响应流"或读不到内容）
    expect(onContentChunk.mock.calls.map((c) => c[0])).toEqual(['你', '好'])
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('fetchModels：连续两次 CSRF 403 只重试一次，随后抛出原始错误', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(403, { success: false, error: 'invalid csrf token' }))
      .mockResolvedValueOnce(mockResponse(403, { success: false, error: 'invalid csrf token' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchModels(provider, 'dummy-key')).rejects.toThrow('invalid csrf token')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fetchModels：非 CSRF 的 403（如权限错误）不重试', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(403, { success: false, error: '没有权限执行此操作' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchModels(provider, 'dummy-key')).rejects.toThrow('没有权限执行此操作')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
