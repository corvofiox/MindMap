import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

// 获取当前文件路径
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 加载.env文件，确保路径正确
dotenv.config({ path: path.resolve(__dirname, '..', '.env') })

import express from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import cookieParser from 'cookie-parser'

import { authRouter } from './controllers/auth.controller.js'
import { userRouter } from './controllers/user.controller.js'
import { projectRouter } from './controllers/project.controller.js'
import { canvasRouter } from './controllers/canvas.controller.js'
import { logRouter } from './controllers/log.routes.js'
import { uploadRouter } from './controllers/upload.controller.js'
import { collaborationRouter } from './controllers/collaboration.controller.js'
import { aiRouter } from './controllers/ai.controller.js'
import { aiProxyRouter } from './controllers/ai-proxy.controller.js'
import { apiLimiter } from './middleware/rateLimit.middleware.js'
import { csrfProtectionMiddleware, getCsrfTokenRoute } from './middleware/csrf.middleware.js'
import { setupWebSocket } from './websocket/index.js'
import { errorHandler } from './middleware/error.middleware.js'
import { initDatabase } from './database/init.js'
import { initializeDb, registerShutdownHandlers } from './database/connection.js'
import { migrateCanvasesToYjs } from './database/migrate-to-yjs.js'
import { getValidatedEnv, isTrustProxyEnabled } from './utils/env.js'
import { log, logError } from './utils/logger.js'

const app = express()
const server = createServer(app)

// A10: 仅在显式配置 TRUST_PROXY=true/1/yes 时才信任反向代理的
// X-Forwarded-For。服务直曝（默认）时该头完全由客户端控制——无条件信任
// 会让攻击者伪造任意 IP 绕过 express-rate-limit 的全局限速。
// #7: 判定逻辑抽到 utils/env.ts 的 isTrustProxyEnabled()，与 WebSocket 侧
// getClientIp 共用同一实现，避免两侧判定规则漂移。
if (isTrustProxyEnabled()) {
  app.set('trust proxy', 1)
}

const env = getValidatedEnv()
const PORT = parseInt(env.PORT || '3000', 10)
const WS_PORT = parseInt(env.WS_PORT || '3001', 10)

// Middleware
// CORS configuration
import { createCorsMiddleware } from './middleware/cors.middleware.js'
app.use(createCorsMiddleware(env))
app.use(cookieParser())
// B15: 收紧 JSON/urlencoded body 上限（50mb → 10mb），缩小大 body DoS 面
// R4 #2: 大画布保存端点（PUT /api/canvases/:id、POST /api/canvases/:id/data）
// 使用更高的 50mb 上限——画布快照（yjsData base64 / nodes 数组）可达数十 MB，
// 10mb 会让大画布保存静默 413（前端 catch 吞错导致数据丢失）。该中间件必须
// 挂在全局 10mb parser 之前（body-parser 解析成功后全局 parser 会跳过已解析
// 请求；超过 50mb 的请求在此抛 413）。其余端点保持 10mb 收紧 DoS 面。
const canvasLargeBodyJson = express.json({ limit: '50mb' })
app.use('/api/canvases', (req, res, next) => {
  if (
    (req.method === 'PUT' && /^\/\d+$/.test(req.path)) ||
    (req.method === 'POST' && /^\/\d+\/data$/.test(req.path))
  ) {
    return canvasLargeBodyJson(req, res, next)
  }
  next()
})
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'mindmap-backend',
    version: '1.0.0'
  })
})

// CSRF token endpoint (public, does not require authentication)
app.get('/api/csrf-token', apiLimiter(), getCsrfTokenRoute)

// API routes
// Auth routes (login/register) are exempt from CSRF for initial authentication
app.use('/api/auth', apiLimiter(), authRouter)
// Protected routes require CSRF token
app.use('/api/users', apiLimiter(), csrfProtectionMiddleware, userRouter)
app.use('/api/projects', apiLimiter(), csrfProtectionMiddleware, projectRouter)
app.use('/api/canvases', apiLimiter(), csrfProtectionMiddleware, canvasRouter)
// A1: /api/logs 单独挂载且必须带 apiLimiter（日志写入/读取/清空均可被滥用）。
// 注意：只能挂载一次——若在带限速版本之前还有一次裸挂载，Express 会先命中
// 裸挂载，限速永远不会生效（曾发生）。
app.use('/api/upload', apiLimiter(), csrfProtectionMiddleware, uploadRouter)
app.use('/api/collaboration', apiLimiter(), csrfProtectionMiddleware, collaborationRouter)
app.use('/api/ai', apiLimiter(), csrfProtectionMiddleware, aiProxyRouter)
app.use('/api/ai', apiLimiter(), csrfProtectionMiddleware, aiRouter)
// A1: /api/logs 同样受全局限速保护（日志写入/读取/清空均可被滥用）
app.use('/api/logs', apiLimiter(), logRouter)

// 静态文件服务
const frontendDistPath = path.join(__dirname, '../../frontend/dist')
app.use(express.static(frontendDistPath))

// B16: 未匹配的 /api/* 路径返回 JSON 404，而非 index.html
// （避免前端 SPA 兜底把未知 API 请求当作页面返回，掩盖接口拼写错误）
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: '接口不存在' })
})

// 所有未匹配的请求指向index.html
// 注意：WebSocket升级请求需要跳过，否则会被Express拦截
app.get('*', (req, res, next) => {
  // 跳过WebSocket升级请求
  if (req.headers.upgrade?.toLowerCase() === 'websocket') {
    return next()
  }
  res.sendFile(path.join(frontendDistPath, 'index.html'))
})

// Error handling
app.use(errorHandler)

const isProduction = env.NODE_ENV === 'production'

// Start servers
async function start() {
  try {
    await initDatabase()
    await initializeDb()
    registerShutdownHandlers()
    // Convert legacy JSON snapshots into Yjs binary updates (idempotent, safe
    // to run on every startup). Must run after the schema migration adds the
    // yjs_update column.
    await migrateCanvasesToYjs().catch((err) => {
      logError('Yjs data migration failed (non-fatal, will retry next start)', err)
    })

    // WebSocket server configuration
    // 生产环境：WebSocket 绑定到 HTTP Server（共享端口）
    // 开发环境：WebSocket 使用独立端口
    // 注意：必须在HTTP服务器启动之前创建WebSocket服务器
    let wsServer: WebSocketServer

    if (isProduction) {
      wsServer = new WebSocketServer({
        server,
        path: '/ws'
      })
      log('WebSocket Server sharing port with HTTP Server', { port: PORT, path: '/ws' })
    } else {
      const wsHttpServer = createServer()
      wsHttpServer.on('error', (err: Error) => {
        logError('WebSocket server error', err.message)
      })
      wsHttpServer.listen({ port: WS_PORT, host: '0.0.0.0', exclusive: false }, () => {
        log('WebSocket Server running', { port: WS_PORT })
      })
      wsServer = new WebSocketServer({ server: wsHttpServer })
    }

    setupWebSocket(wsServer)

    server.listen(PORT, '0.0.0.0', () => {
      log('HTTP Server started', {
        port: PORT,
        environment: process.env.NODE_ENV || 'development',
        corsOrigins: process.env.ALLOWED_ORIGINS || 'localhost'
      })
    })
  } catch (error) {
    logError('Failed to start server', error)
    process.exit(1)
  }
}

start()

