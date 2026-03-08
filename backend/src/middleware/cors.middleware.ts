import cors from 'cors'
import type { EnvVars } from '../utils/env.js'

/**
 * CORS Configuration Middleware
 * Provides flexible cross-origin resource sharing settings
 */

export const createCorsMiddleware = (env: EnvVars) => {
  // 解析允许的来源
  let cachedAllowedOrigins: string[] | null = null

  const parseAllowedOrigins = (): string[] => {
    // 使用缓存避免重复解析
    if (cachedAllowedOrigins) return cachedAllowedOrigins

    const allowed = env.ALLOWED_ORIGINS?.trim()
    let origins: string[] = []

    if (!allowed) {
      // 提供合理的默认配置
      origins = env.NODE_ENV === 'development'
        ? ['http://localhost:*', 'http://127.0.0.1:*']
        : []
    } else {
      origins = allowed === '*' ? ['*'] : allowed.split(',').map(o => o.trim())
    }

    // 缓存解析结果
    cachedAllowedOrigins = origins
    return origins
  }

  const isDevEnv = env.NODE_ENV === 'development'

  return cors({
    origin: (origin, callback) => {
      if (!origin) {
        // 允许没有origin的请求（如移动应用、curl）
        return callback(null, true)
      }

      const allowedOrigins = parseAllowedOrigins()

      // 如果设置了通配符，允许所有来源
      if (allowedOrigins.includes('*')) {
        return callback(null, true)
      }

      // 开发环境：允许所有 localhost 端口访问
      if (isDevEnv && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
        return callback(null, true)
      }

      // 检查来源是否在允许列表中
      if (allowedOrigins.includes(origin)) {
        return callback(null, true)
      }

      // 记录CORS拒绝日志
      const errorMsg = `Origin ${origin} not allowed by CORS`
      console.warn(errorMsg)

      // 返回详细的错误信息
      return callback(new Error(errorMsg))
    },
    credentials: true,
    // 明确允许的HTTP方法
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
    // 明确允许的请求头
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization', 'x-csrf-token'],
    // 允许暴露的响应头
    exposedHeaders: ['X-CSRF-Token'],
    // 设置预检请求缓存时间
    maxAge: 86400 // 24小时
  })
}
