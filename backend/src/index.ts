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
import { apiLimiter } from './middleware/rateLimit.middleware.js'
import { csrfProtectionMiddleware, getCsrfTokenRoute } from './middleware/csrf.middleware.js'
import { setupWebSocket } from './websocket/index.js'
import { errorHandler } from './middleware/error.middleware.js'
import { initDatabase } from './database/init.js'
import { initializeDb, registerShutdownHandlers } from './database/connection.js'
import { migrateCanvasesToYjs } from './database/migrate-to-yjs.js'
import { getValidatedEnv } from './utils/env.js'
import { log, logError } from './utils/logger.js'

const app = express()
const server = createServer(app)

// Trust the first proxy (e.g. nginx, cloudflare, k8s ingress) so that
// express-rate-limit can correctly derive the client IP from X-Forwarded-For.
app.set('trust proxy', 1)

const env = getValidatedEnv()
const PORT = parseInt(env.PORT || '3000', 10)
const WS_PORT = parseInt(env.WS_PORT || '3001', 10)

// Middleware
// CORS configuration
import { createCorsMiddleware } from './middleware/cors.middleware.js'
app.use(createCorsMiddleware(env))
app.use(cookieParser())
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ extended: true, limit: '50mb' }))

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
app.use('/api/logs', logRouter)
app.use('/api/upload', apiLimiter(), csrfProtectionMiddleware, uploadRouter)
app.use('/api/collaboration', apiLimiter(), csrfProtectionMiddleware, collaborationRouter)
app.use('/api/ai', apiLimiter(), csrfProtectionMiddleware, aiRouter)

// 静态文件服务
const frontendDistPath = path.join(__dirname, '../../frontend/dist')
app.use(express.static(frontendDistPath))

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

