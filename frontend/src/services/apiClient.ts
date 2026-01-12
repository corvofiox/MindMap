import type { ApiResponse } from '@/types'
import { useUIStore } from '@/store/useUIStore'

// API配置
export const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000'

// 常见错误信息
export const ERROR_MESSAGES = {
  NETWORK_ERROR: '网络连接失败，请检查您的网络设置',
  SERVER_ERROR: '服务器内部错误，请稍后重试',
  UNAUTHORIZED: '未授权访问，请重新登录',
  FORBIDDEN: '没有权限执行此操作',
  NOT_FOUND: '请求的资源不存在',
  BAD_REQUEST: '请求参数错误',
  UNKNOWN_ERROR: '发生未知错误，请稍后重试'
}

// 根据HTTP状态码获取对应的错误信息
export const getErrorMessageByStatus = (status: number, defaultMessage: string): string => {
  switch (status) {
    case 400:
      return ERROR_MESSAGES.BAD_REQUEST
    case 401:
      return ERROR_MESSAGES.UNAUTHORIZED
    case 403:
      return ERROR_MESSAGES.FORBIDDEN
    case 404:
      return ERROR_MESSAGES.NOT_FOUND
    case 500:
    case 501:
    case 502:
    case 503:
    case 504:
      return ERROR_MESSAGES.SERVER_ERROR
    default:
      return defaultMessage
  }
}

// API客户端类
export class ApiClient {
  private token: string | null = null
  private baseUrl: string

  constructor(baseUrl: string = API_BASE_URL) {
    this.baseUrl = baseUrl
    this.loadToken()
  }

  // 从localStorage加载token
  private loadToken(): void {
    this.token = localStorage.getItem('mindmap_token')
  }

  // 设置token
  setToken(token: string | null): void {
    this.token = token
    if (token) {
      localStorage.setItem('mindmap_token', token)
    } else {
      localStorage.removeItem('mindmap_token')
    }
  }

  // 获取token
  getToken(): string | null {
    return this.token
  }

  // 显示错误提示
  private showErrorToast(message: string): void {
    const addErrorToast = useUIStore.getState().addErrorToast
    addErrorToast(message, '操作失败')
  }



  // 构建请求头
  private buildHeaders(contentType: string = 'application/json'): HeadersInit {
    const headers: HeadersInit = {}

    // 添加认证token
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`
    }

    // 添加Content-Type（FormData不需要）
    if (contentType && contentType !== 'multipart/form-data') {
      headers['Content-Type'] = contentType
    }

    return headers
  }

  // 解析响应
  private async parseResponse<T>(response: Response): Promise<ApiResponse<T>> {
    // 检查响应是否为JSON
    const contentType = response.headers.get('content-type')
    if (contentType && contentType.includes('application/json')) {
      try {
        return await response.json()
      } catch {
        throw new Error('服务器返回格式错误')
      }
    }

    // 非JSON响应
    const text = await response.text()
    throw new Error(text || '服务器返回错误')
  }

  // 处理错误
  private handleError(error: unknown, defaultMessage: string): string {
    let errorMessage: string

    if (error instanceof Error) {
      errorMessage = error.message
    } else {
      errorMessage = defaultMessage
    }

    return errorMessage
  }

  // 通用请求方法
  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    try {
      // 确定Content-Type
      let contentType = options.headers?.['Content-Type'] as string
      // 如果是FormData且没有设置Content-Type，则不指定（浏览器会自动处理）
      if (options.body instanceof FormData && !contentType) {
        contentType = 'multipart/form-data'
      }

      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        ...options,
        headers: {
          ...this.buildHeaders(contentType),
          ...options.headers,
        },
      })

      // 检查响应状态
      if (!response.ok) {
        // 尝试解析服务器返回的错误信息
        let errorMessage: string
        try {
          const errorData = await this.parseResponse<any>(response)
          if (errorData && errorData.error) {
            errorMessage = errorData.error
          } else {
            errorMessage = getErrorMessageByStatus(response.status, '请求失败')
          }
        } catch {
          // 如果无法解析响应，使用默认的状态信息
          errorMessage = getErrorMessageByStatus(response.status, '请求失败')
        }
        throw new Error(errorMessage)
      }

      // 解析响应
      const data = await this.parseResponse<T>(response)

      // 检查业务状态
      if ('success' in data && !data.success) {
        throw new Error(data.error || '请求失败')
      }

      return data.data as T
    } catch (error) {
      // 处理网络错误
      if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
        throw new Error(this.handleError(new Error(ERROR_MESSAGES.NETWORK_ERROR), ERROR_MESSAGES.NETWORK_ERROR))
      }

      // 处理其他错误
      throw new Error(this.handleError(error, ERROR_MESSAGES.UNKNOWN_ERROR))
    }
  }

  // GET请求
  async get<T>(endpoint: string, params?: Record<string, any>): Promise<T> {
    // 构建查询参数
    const queryString = params
      ? '?' + new URLSearchParams(params as Record<string, string>).toString()
      : ''

    return this.request<T>(`${endpoint}${queryString}`, {
      method: 'GET',
    })
  }

  // POST请求
  async post<T>(endpoint: string, data?: any, contentType?: string): Promise<T> {
    const options: RequestInit = {
      method: 'POST',
    }

    // 添加请求体
    if (data) {
      if (data instanceof FormData) {
        options.body = data
        // FormData不需要手动设置Content-Type，浏览器会自动添加包含boundary的正确头
      } else {
        options.body = JSON.stringify(data)
      }
    }

    // 如果指定了contentType，添加到请求头
    if (contentType) {
      options.headers = {
        'Content-Type': contentType
      }
    }

    return this.request<T>(endpoint, options)
  }

  // PUT请求
  async put<T>(endpoint: string, data?: any, contentType?: string): Promise<T> {
    const options: RequestInit = {
      method: 'PUT',
      headers: contentType ? { 'Content-Type': contentType } : {}
    }

    // 添加请求体
    if (data) {
      if (data instanceof FormData || contentType === 'application/octet-stream') {
        options.body = data
      } else {
        options.body = JSON.stringify(data)
      }
    }

    return this.request<T>(endpoint, options)
  }

  // DELETE请求
  async delete<T>(endpoint: string, data?: any): Promise<T> {
    const options: RequestInit = {
      method: 'DELETE',
    }

    // 添加请求体（可选）
    if (data) {
      options.body = JSON.stringify(data)
    }

    return this.request<T>(endpoint, options)
  }
}

// 创建单例实例
export const apiClient = new ApiClient()

