// apiClient 真实行为测试：全部断言打在 frontend/src/services/apiClient.ts 上。
// 只 mock 真正的边界（fetch / document.cookie），不重新实现被测逻辑。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  ApiClient,
  ApiError,
  ERROR_MESSAGES,
  getErrorMessageByStatus,
} from '../services/apiClient'

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function installFetch(handler: FetchHandler) {
  const mock = vi.fn<FetchHandler>(handler)
  vi.stubGlobal('fetch', mock)
  return mock
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain' },
  })
}

function requestHeaders(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>
}

function clearCookies(): void {
  for (const cookie of document.cookie.split(';')) {
    const name = cookie.split('=')[0].trim()
    if (name) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`
    }
  }
}

describe('apiClient', () => {
  beforeEach(() => {
    localStorage.clear()
    clearCookies()
    // 默认给一个有效 CSRF cookie，使非 GET 请求不触发额外的 /api/csrf-token 请求，
    // 让每个用例的 fetch 调用序列保持可预测。
    document.cookie = 'x-csrf-token=test; path=/'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    clearCookies()
  })

  describe('getErrorMessageByStatus', () => {
    it('把常见状态码映射为固定中文文案', () => {
      expect(getErrorMessageByStatus(400, '请求失败')).toBe('请求参数错误')
      expect(getErrorMessageByStatus(401, '请求失败')).toBe('未授权访问，请重新登录')
      expect(getErrorMessageByStatus(403, '请求失败')).toBe('没有权限执行此操作')
      expect(getErrorMessageByStatus(404, '请求的资源不存在'))
        .toBe(ERROR_MESSAGES.NOT_FOUND)
      expect(getErrorMessageByStatus(500, '请求失败')).toBe('服务器内部错误，请稍后重试')
    })

    it('501/502/503/504 与 500 同属服务器错误', () => {
      for (const status of [501, 502, 503, 504]) {
        expect(getErrorMessageByStatus(status, '请求失败')).toBe('服务器内部错误，请稍后重试')
      }
    })

    it('未映射的状态码原样返回 defaultMessage', () => {
      expect(getErrorMessageByStatus(418, '我是茶壶')).toBe('我是茶壶')
      expect(getErrorMessageByStatus(200, '兜底')).toBe('兜底')
    })
  })

  describe('请求头构造', () => {
    it('getAuthHeaders 同时带上 Bearer token、cookie 里的 CSRF token 与 JSON Content-Type', () => {
      document.cookie = 'x-csrf-token=abc%20def; path=/'
      const client = new ApiClient()
      client.setToken('jwt-1')

      const headers = client.getAuthHeaders() as Record<string, string>

      expect(headers['Authorization']).toBe('Bearer jwt-1')
      // cookie 值经 decodeURIComponent 解码
      expect(headers['x-csrf-token']).toBe('abc def')
      expect(headers['Content-Type']).toBe('application/json')
    })

    it('没有 token / 没有 cookie 时不写对应请求头', () => {
      clearCookies()
      const headers = new ApiClient().getAuthHeaders() as Record<string, string>

      expect(headers['Authorization']).toBeUndefined()
      expect(headers['x-csrf-token']).toBeUndefined()
    })

    it('multipart/form-data 不设置 Content-Type（交给浏览器补 boundary）', () => {
      const headers = new ApiClient().getAuthHeaders('multipart/form-data') as Record<string, string>

      expect(headers['Content-Type']).toBeUndefined()
    })

    it('实际请求使用构造出的请求头', async () => {
      document.cookie = 'x-csrf-token=csrf-live; path=/'
      const mock = installFetch(async () => jsonResponse(200, { success: true, data: 1 }))

      const client = new ApiClient()
      client.setToken('jwt-2')
      await client.get('/api/things')

      const headers = requestHeaders(mock.mock.calls[0][1])
      expect(headers['Authorization']).toBe('Bearer jwt-2')
      expect(headers['x-csrf-token']).toBe('csrf-live')
    })
  })

  describe('token 管理', () => {
    it('setToken 写入 localStorage，setToken(null) 清除', () => {
      const client = new ApiClient()

      client.setToken('token-a')
      expect(client.getToken()).toBe('token-a')
      expect(localStorage.getItem('mindmap_token')).toBe('token-a')

      client.setToken(null)
      expect(client.getToken()).toBeNull()
      expect(localStorage.getItem('mindmap_token')).toBeNull()
    })

    it('构造时从 localStorage 恢复已有 token', () => {
      localStorage.setItem('mindmap_token', 'persisted-token')

      expect(new ApiClient().getToken()).toBe('persisted-token')
    })
  })

  describe('查询字符串', () => {
    it('GET 把 params 序列化进 URL', async () => {
      const mock = installFetch(async () => jsonResponse(200, { success: true, data: [] }))

      await new ApiClient().get('/api/items', { page: '1', limit: '10' })

      expect(String(mock.mock.calls[0][0])).toBe('/api/items?page=1&limit=10')
    })

    it('GET 未传 params 时不追加问号', async () => {
      const mock = installFetch(async () => jsonResponse(200, { success: true, data: [] }))

      await new ApiClient().get('/api/items')

      expect(String(mock.mock.calls[0][0])).toBe('/api/items')
    })
  })

  describe('响应信封解包', () => {
    it('success:true 时只返回 data 字段', async () => {
      installFetch(async () => jsonResponse(200, { success: true, data: { id: 7 } }))

      await expect(new ApiClient().get('/api/x')).resolves.toEqual({ id: 7 })
    })

    it('HTTP 200 但 success:false 时抛出服务端 error 文案', async () => {
      installFetch(async () => jsonResponse(200, { success: false, error: '画布已被删除' }))

      await expect(new ApiClient().get('/api/x')).rejects.toThrow('画布已被删除')
    })

    it('响应体为字面量 null 时解析为 undefined 而不是抛 TypeError', async () => {
      installFetch(async () => jsonResponse(200, null))

      await expect(new ApiClient().get('/api/x')).resolves.toBeUndefined()
    })

    it('POST 把 body 序列化为 JSON 并带上 Content-Type', async () => {
      const mock = installFetch(async () => jsonResponse(200, { success: true, data: 1 }))

      await new ApiClient().post('/api/things', { name: 'a' })

      const init = mock.mock.calls[0][1]
      expect(init?.method).toBe('POST')
      expect(init?.body).toBe('{"name":"a"}')
      expect(requestHeaders(init)['Content-Type']).toBe('application/json')
    })

    it('FormData body 不手动设置 Content-Type', async () => {
      const mock = installFetch(async () => jsonResponse(200, { success: true, data: 1 }))
      const formData = new FormData()
      formData.append('file', new Blob(['x'], { type: 'text/plain' }))

      await new ApiClient().post('/api/upload', formData)

      expect(requestHeaders(mock.mock.calls[0][1])['Content-Type']).toBeUndefined()
    })
  })

  describe('错误映射', () => {
    it('404 且响应体没有 error 字段时回退到状态码文案', async () => {
      installFetch(async () => jsonResponse(404, { success: false }))

      const error = await new ApiClient().get('/api/x').catch((e: unknown) => e)

      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).status).toBe(404)
      expect((error as ApiError).message).toBe('请求的资源不存在')
    })

    it('服务端给了 error 字段时优先使用服务端文案', async () => {
      installFetch(async () => jsonResponse(400, { success: false, error: '邮箱已被注册' }))

      await expect(new ApiClient().post('/api/auth/register', {})).rejects.toThrow('邮箱已被注册')
    })

    it('非 JSON 错误响应回退到状态码文案', async () => {
      installFetch(async () => textResponse(500, 'Internal Server Error'))

      const error = await new ApiClient().get('/api/x').catch((e: unknown) => e)

      expect((error as ApiError).status).toBe(500)
      expect((error as ApiError).message).toBe('服务器内部错误，请稍后重试')
    })

    it('fetch 抛 TypeError(Failed to fetch) 时映射为网络错误文案', async () => {
      installFetch(async () => {
        throw new TypeError('Failed to fetch')
      })

      await expect(new ApiClient().get('/api/x')).rejects.toThrow(ERROR_MESSAGES.NETWORK_ERROR)
    })

    it('409 冲突：ApiError 保留完整响应体，serverVersion 位于 data.data 内', async () => {
      const body = {
        success: false,
        error: '版本冲突：画布数据已被其他用户更新，请刷新后重试',
        data: { serverVersion: 42, clientVersion: 5 },
      }
      installFetch(async () => jsonResponse(409, body))

      const error = (await new ApiClient()
        .put('/api/canvases/1', {})
        .catch((e: unknown) => e)) as ApiError

      expect(error).toBeInstanceOf(ApiError)
      expect(error.status).toBe(409)
      expect(error.message).toBe(body.error)
      // 完整响应体被保留；serverVersion 嵌在 data.data 里，而不是 data 顶层
      expect(error.data).toEqual(body)
      const nested = (error.data as { data?: { serverVersion?: number } }).data
      expect(nested?.serverVersion).toBe(42)
    })
  })

  describe('CSRF 403 自愈', () => {
    it('403 + CSRF 错误：清除旧 cookie、重新获取 token 并只重试一次', async () => {
      document.cookie = 'x-csrf-token=stale; path=/'
      const calls: Array<{ url: string; method: string; csrf: string | null }> = []
      let postCount = 0

      const mock = installFetch(async (input, init) => {
        const url = String(input)
        const method = (init?.method ?? 'GET').toUpperCase()
        calls.push({ url, method, csrf: requestHeaders(init)['x-csrf-token'] ?? null })

        if (url.includes('/api/csrf-token')) {
          // 真实服务端通过 Set-Cookie 下发新 token；jsdom 不会自动写 cookie，这里手动模拟
          document.cookie = 'x-csrf-token=fresh; path=/'
          return jsonResponse(200, { success: true, token: 'fresh' })
        }

        postCount += 1
        if (postCount === 1) {
          return jsonResponse(403, { success: false, error: 'CSRF token mismatch' })
        }
        return jsonResponse(200, { success: true, data: { ok: true } })
      })

      await expect(new ApiClient().post('/api/things', { a: 1 })).resolves.toEqual({ ok: true })

      // 原始 POST 一次 + 重试一次，共两次；不会无限递归
      expect(postCount).toBe(2)
      expect(mock).toHaveBeenCalledTimes(3)
      expect(calls[1].url).toBe('/api/csrf-token')
      expect(calls[1].method).toBe('GET')
      // 重试的请求带上了新 cookie 中的 token
      expect(calls[2].url).toBe('/api/things')
      expect(calls[2].csrf).toBe('fresh')
    })

    it('重试后仍是 CSRF 403 时不再递归，直接抛出 ApiError', async () => {
      document.cookie = 'x-csrf-token=stale; path=/'
      let postCount = 0

      installFetch(async (input) => {
        if (String(input).includes('/api/csrf-token')) {
          document.cookie = 'x-csrf-token=still-bad; path=/'
          return jsonResponse(200, { success: true, token: 'still-bad' })
        }
        postCount += 1
        return jsonResponse(403, { success: false, error: 'CSRF token invalid' })
      })

      const error = (await new ApiClient()
        .post('/api/things', { a: 1 })
        .catch((e: unknown) => e)) as ApiError

      expect(error).toBeInstanceOf(ApiError)
      expect(error.status).toBe(403)
      expect(postCount).toBe(2)
    })

    it('403 但错误信息与 CSRF 无关时不触发重试', async () => {
      document.cookie = 'x-csrf-token=ok; path=/'
      let postCount = 0

      installFetch(async () => {
        postCount += 1
        return jsonResponse(403, { success: false, error: '没有权限执行此操作' })
      })

      const error = (await new ApiClient()
        .post('/api/things', { a: 1 })
        .catch((e: unknown) => e)) as ApiError

      expect(error).toBeInstanceOf(ApiError)
      expect(error.message).toBe('没有权限执行此操作')
      expect(postCount).toBe(1)
    })
  })

  describe('CSRF token 获取', () => {
    it('getCsrfTokenFromServer 解包 { success, token } 信封', async () => {
      installFetch(async () => jsonResponse(200, { success: true, token: 'csrf-1' }))

      await expect(new ApiClient().getCsrfTokenFromServer()).resolves.toEqual({ token: 'csrf-1' })
    })

    it('响应缺少 token 字段时抛错', async () => {
      installFetch(async () => jsonResponse(200, { success: true }))

      await expect(new ApiClient().getCsrfTokenFromServer())
        .rejects.toThrow('Failed to get CSRF token')
    })

    it('ensureCsrfToken 仅在 cookie 缺失时请求 /api/csrf-token', async () => {
      clearCookies()
      const mock = installFetch(async () => jsonResponse(200, { success: true, token: 'fresh' }))

      await new ApiClient().ensureCsrfToken()

      expect(mock).toHaveBeenCalledTimes(1)
      expect(String(mock.mock.calls[0][0])).toBe('/api/csrf-token')
    })

    it('ensureCsrfToken 已有 cookie 时不发请求', async () => {
      const mock = installFetch(async () => jsonResponse(200, { success: true, token: 'x' }))

      await new ApiClient().ensureCsrfToken()

      expect(mock).not.toHaveBeenCalled()
    })

    it('非 GET 请求在缺少 CSRF cookie 时会自动先取 token', async () => {
      clearCookies()
      const urls: string[] = []

      installFetch(async (input) => {
        const url = String(input)
        urls.push(url)
        if (url.includes('/api/csrf-token')) {
          document.cookie = 'x-csrf-token=auto; path=/'
          return jsonResponse(200, { success: true, token: 'auto' })
        }
        return jsonResponse(200, { success: true, data: 'done' })
      })

      await expect(new ApiClient().post('/api/things', { a: 1 })).resolves.toBe('done')
      expect(urls).toEqual(['/api/csrf-token', '/api/things'])
    })

    it('GET 请求不会为了 CSRF 额外发一次请求', async () => {
      clearCookies()
      const mock = installFetch(async () => jsonResponse(200, { success: true, data: [] }))

      await new ApiClient().get('/api/items')

      expect(mock).toHaveBeenCalledTimes(1)
      expect(String(mock.mock.calls[0][0])).toBe('/api/items')
    })
  })
})
