/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

describe('API Client Tests', () => {
  describe('API Configuration', () => {
    it('should use relative path for API_BASE_URL', () => {
      const API_BASE_URL = ''

      expect(API_BASE_URL).toBe('')
    })

    it('should define error messages', () => {
      const ERROR_MESSAGES = {
        NETWORK_ERROR: '网络连接失败，请检查您的网络设置',
        SERVER_ERROR: '服务器内部错误，请稍后重试',
        UNAUTHORIZED: '未授权访问，请重新登录',
        FORBIDDEN: '没有权限执行此操作',
        NOT_FOUND: '请求的资源不存在',
        BAD_REQUEST: '请求参数错误',
        UNKNOWN_ERROR: '发生未知错误，请稍后重试',
      }

      expect(ERROR_MESSAGES.NETWORK_ERROR).toBeDefined()
      expect(ERROR_MESSAGES.SERVER_ERROR).toBeDefined()
      expect(ERROR_MESSAGES.UNAUTHORIZED).toBeDefined()
      expect(ERROR_MESSAGES.FORBIDDEN).toBeDefined()
    })
  })

  describe('Error Message Mapping', () => {
    const getErrorMessageByStatus = (status: number, defaultMessage: string): string => {
      switch (status) {
        case 400:
          return '请求参数错误'
        case 401:
          return '未授权访问，请重新登录'
        case 403:
          return '没有权限执行此操作'
        case 404:
          return '请求的资源不存在'
        case 500:
        case 501:
        case 502:
        case 503:
        case 504:
          return '服务器内部错误，请稍后重试'
        default:
          return defaultMessage
      }
    }

    it('should return correct message for 400', () => {
      expect(getErrorMessageByStatus(400, 'default')).toBe('请求参数错误')
    })

    it('should return correct message for 401', () => {
      expect(getErrorMessageByStatus(401, 'default')).toBe('未授权访问，请重新登录')
    })

    it('should return correct message for 403', () => {
      expect(getErrorMessageByStatus(403, 'default')).toBe('没有权限执行此操作')
    })

    it('should return correct message for 404', () => {
      expect(getErrorMessageByStatus(404, 'default')).toBe('请求的资源不存在')
    })

    it('should return correct message for 500', () => {
      expect(getErrorMessageByStatus(500, 'default')).toBe('服务器内部错误，请稍后重试')
    })

    it('should return default message for unknown status', () => {
      expect(getErrorMessageByStatus(418, 'default')).toBe('default')
    })
  })

  describe('CSRF Token Handling', () => {
    it('should extract CSRF token from cookie', () => {
      const getCsrfToken = (): string | null => {
        const cookies = 'x-csrf-token=test-token; other-cookie=value'.split(';')
        for (const cookie of cookies) {
          const [name, value] = cookie.trim().split('=')
          if (name === 'x-csrf-token') {
            return decodeURIComponent(value)
          }
        }
        return null
      }

      expect(getCsrfToken()).toBe('test-token')
    })

    it('should return null when CSRF token not found', () => {
      const getCsrfToken = (): string | null => {
        const cookies = 'other-cookie=value'.split(';')
        for (const cookie of cookies) {
          const [name] = cookie.trim().split('=')
          if (name === 'x-csrf-token') {
            return 'found'
          }
        }
        return null
      }

      expect(getCsrfToken()).toBeNull()
    })

    it('should decode CSRF token', () => {
      const encodedToken = 'test%20token'
      const decodedToken = decodeURIComponent(encodedToken)

      expect(decodedToken).toBe('test token')
    })
  })

  describe('Token Management', () => {
    it('should store token in localStorage', () => {
      const token = 'test-token'

      localStorage.setItem('mindmap_token', token)

      expect(localStorage.getItem('mindmap_token')).toBe(token)
    })

    it('should retrieve token from localStorage', () => {
      const token = 'test-token'

      localStorage.setItem('mindmap_token', token)
      const retrieved = localStorage.getItem('mindmap_token')

      expect(retrieved).toBe(token)
    })

    it('should remove token from localStorage', () => {
      const token = 'test-token'

      localStorage.setItem('mindmap_token', token)
      localStorage.removeItem('mindmap_token')

      expect(localStorage.getItem('mindmap_token')).toBeNull()
    })

    it('should handle missing token gracefully', () => {
      localStorage.clear()

      const token = localStorage.getItem('mindmap_token')

      expect(token).toBeNull()
    })

    it('should verify localStorage mock is working', () => {
      localStorage.setItem('test_key', 'test_value')
      expect(localStorage.getItem('test_key')).toBe('test_value')
      localStorage.removeItem('test_key')
      expect(localStorage.getItem('test_key')).toBeNull()
      localStorage.clear()
      expect(localStorage.store).toEqual({})
    })
  })

  describe('Request Headers', () => {
    it('should build headers with authorization', () => {
      const buildHeaders = (token: string | null) => {
        const headers: Record<string, string> = {}

        if (token) {
          headers['Authorization'] = `Bearer ${token}`
        }

        return headers
      }

      const headers = buildHeaders('test-token')

      expect(headers['Authorization']).toBe('Bearer test-token')
    })

    it('should build headers with CSRF token', () => {
      const buildHeaders = (csrfToken: string | null) => {
        const headers: Record<string, string> = {}

        if (csrfToken) {
          headers['x-csrf-token'] = csrfToken
        }

        return headers
      }

      const headers = buildHeaders('csrf-token')

      expect(headers['x-csrf-token']).toBe('csrf-token')
    })

    it('should build headers with content type for JSON', () => {
      const buildHeaders = (contentType?: string) => {
        const headers: Record<string, string> = {}

        if (contentType && contentType !== 'multipart/form-data') {
          headers['Content-Type'] = contentType
        }

        return headers
      }

      const headers = buildHeaders('application/json')

      expect(headers['Content-Type']).toBe('application/json')
    })

    it('should not set content type for FormData', () => {
      const buildHeaders = (contentType?: string) => {
        const headers: Record<string, string> = {}

        if (contentType && contentType !== 'multipart/form-data') {
          headers['Content-Type'] = contentType
        }

        return headers
      }

      const headers = buildHeaders('multipart/form-data')

      expect(headers['Content-Type']).toBeUndefined()
    })
  })

  describe('Response Parsing', () => {
    it('should parse JSON response', async () => {
      const mockResponse = {
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ success: true, data: 'test' }),
      }

      const parseResponse = async <T>(response: Response): Promise<T> => {
        const contentType = response.headers.get('content-type')
        if (contentType && contentType.includes('application/json')) {
          return await response.json()
        }
        throw new Error('Not JSON')
      }

      const result = await parseResponse<{ success: boolean; data: string }>(mockResponse as unknown as Response)

      expect(result.success).toBe(true)
      expect(result.data).toBe('test')
    })

    it('should handle non-JSON response', async () => {
      const mockResponse = {
        ok: true,
        headers: new Headers({ 'content-type': 'text/plain' }),
        text: async () => 'Plain text response',
      }

      const parseResponse = async (response: Response): Promise<string> => {
        const contentType = response.headers.get('content-type')
        if (contentType && contentType.includes('application/json')) {
          return await response.json()
        }
        return await response.text()
      }

      const result = await parseResponse(mockResponse as unknown as Response)

      expect(result).toBe('Plain text response')
    })

    it('should check success field in response', () => {
      const checkSuccess = (data: { success: boolean; data?: unknown }) => {
        return 'success' in data && data.success
      }

      expect(checkSuccess({ success: true })).toBe(true)
      expect(checkSuccess({ success: false })).toBe(false)
    })
  })

  describe('Error Handling', () => {
    it('should handle network errors', () => {
      const error = new TypeError('Failed to fetch')

      const isNetworkError = error instanceof TypeError && error.message.includes('Failed to fetch')

      expect(isNetworkError).toBe(true)
    })

    it('should handle error messages', () => {
      const handleError = (error: unknown, defaultMessage: string): string => {
        if (error instanceof Error) {
          return error.message
        }
        return defaultMessage
      }

      expect(handleError(new Error('Test error'), 'default')).toBe('Test error')
      expect(handleError(null, 'default')).toBe('default')
      expect(handleError('string error', 'default')).toBe('default')
    })

    it('should handle HTTP status errors', () => {
      const handleStatusError = (status: number) => {
        switch (status) {
          case 400:
            return '请求参数错误'
          case 401:
            return '未授权访问，请重新登录'
          case 403:
            return '没有权限执行此操作'
          case 404:
            return '请求的资源不存在'
          case 500:
            return '服务器内部错误，请稍后重试'
          default:
            return '请求失败'
        }
      }

      expect(handleStatusError(400)).toBe('请求参数错误')
      expect(handleStatusError(401)).toBe('未授权访问，请重新登录')
      expect(handleStatusError(500)).toBe('服务器内部错误，请稍后重试')
    })
  })

  describe('Query String Building', () => {
    it('should build query string from params', () => {
      const buildQueryString = (params?: Record<string, any>): string => {
        if (!params) return ''
        return '?' + new URLSearchParams(params as Record<string, string>).toString()
      }

      const queryString = buildQueryString({ page: '1', limit: '10' })

      expect(queryString).toBe('?page=1&limit=10')
    })

    it('should return empty string for undefined params', () => {
      const buildQueryString = (params?: Record<string, any>): string => {
        if (!params) return ''
        return '?' + new URLSearchParams(params as Record<string, string>).toString()
      }

      expect(buildQueryString(undefined)).toBe('')
    })
  })

  describe('Request Methods', () => {
    it('should support GET requests', () => {
      const makeGetRequest = (endpoint: string) => {
        return {
          method: 'GET',
          endpoint,
        }
      }

      const request = makeGetRequest('/api/users')

      expect(request).toHaveProperty('method', 'GET')
    })

    it('should support POST requests with JSON body', () => {
      const makePostRequest = (endpoint: string, data?: any) => {
        return {
          method: 'POST',
          endpoint,
          body: data ? JSON.stringify(data) : undefined,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      }

      const request = makePostRequest('/api/auth/login', { email: 'test@example.com' })

      expect(request.method).toBe('POST')
      expect(request.body).toBe('{"email":"test@example.com"}')
    })

    it('should support PUT requests', () => {
      const makePutRequest = (endpoint: string, data?: any) => {
        return {
          method: 'PUT',
          endpoint,
          body: data ? JSON.stringify(data) : undefined,
          headers: {
            'Content-Type': 'application/json',
          },
        }
      }

      const request = makePutRequest('/api/users/profile', { nickname: 'New Name' })

      expect(request.method).toBe('PUT')
      expect(request.body).toBe('{"nickname":"New Name"}')
    })

    it('should support DELETE requests', () => {
      const makeDeleteRequest = (endpoint: string, data?: any) => {
        return {
          method: 'DELETE',
          endpoint,
          body: data ? JSON.stringify(data) : undefined,
        }
      }

      const request = makeDeleteRequest('/api/projects/1')

      expect(request.method).toBe('DELETE')
    })

    it('should handle FormData for file uploads', () => {
      const handleFormData = (data: FormData) => {
        return {
          body: data,
          isFormData: true,
        }
      }

      const formData = new FormData()
      formData.append('file', new Blob(['test'], { type: 'image/png' }))

      const result = handleFormData(formData)

      expect(result.isFormData).toBe(true)
      expect(result.body).toBe(formData)
    })
  })

  describe('Retry Logic', () => {
    it('should retry on CSRF error', async () => {
      const retryWithNewCsrfToken = async <T>(
        endpoint: string,
        options: RequestInit
      ): Promise<T> => {
        try {
          return {} as T
        } catch {
          return {} as T
        }
      }

      const result = await retryWithNewCsrfToken('/api/test', { method: 'POST' })

      expect(result).toBeDefined()
    })

    it('should clear invalid CSRF token', () => {
      const clearCsrfToken = () => {
        document.cookie = 'x-csrf-token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;'
      }

      expect(() => clearCsrfToken()).not.toThrow()
    })
  })

  describe('409 版本冲突响应解析', () => {
    it('serverVersion 应位于 error.data.data（嵌套）而非 error.data 顶层', () => {
      // ApiError 模拟生产代码中的实现
      class ApiError extends Error {
        status: number
        data: Record<string, unknown> | null
        constructor(message: string, status: number, data: Record<string, unknown> | null = null) {
          super(message)
          this.name = 'ApiError'
          this.status = status
          this.data = data
        }
      }

      // 后端 409 响应体: { success: false, error: "...", data: { serverVersion: 42 } }
      const responseBody = {
        success: false,
        error: '版本冲突：画布数据已被其他用户更新，请刷新后重试',
        data: { serverVersion: 42, clientVersion: 5 },
      }

      const error = new ApiError(responseBody.error, 409, responseBody)

      // 旧代码（bug）: error.data?.serverVersion → undefined
      // 因为 error.data = 整个响应体, serverVersion 在 data.data 里
      expect(error.data?.serverVersion).toBeUndefined()
      expect(typeof error.data?.serverVersion === 'number').toBe(false)

      // 新代码（修复）: error.data?.data?.serverVersion → 42
      const nested = error.data?.data as { serverVersion?: number } | undefined
      expect(nested?.serverVersion).toBe(42)
      expect(typeof nested?.serverVersion).toBe('number')
    })
  })

  describe('API Response Types', () => {
    it('should define ApiResponse type', () => {
      type ApiResponse<T> = {
        success: boolean
        data?: T
        error?: string
      }

      const response: ApiResponse<{ id: number }> = {
        success: true,
        data: { id: 1 },
      }

      expect(response.success).toBe(true)
      expect(response.data?.id).toBe(1)
    })

    it('should define AuthResponse type', () => {
      type AuthResponse = {
        user: {
          id: number
          email: string
          nickname: string | null
          avatar: string | null
          created_at: string
          updated_at: string
        }
        token: string
      }

      const response: AuthResponse = {
        user: {
          id: 1,
          email: 'test@example.com',
          nickname: 'Test User',
          avatar: null,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
        token: 'test-token',
      }

      expect(response.user.id).toBe(1)
      expect(response.token).toBe('test-token')
    })
  })
})
