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
import { apiLimiter } from './middleware/rateLimit.middleware.js'
import { csrfProtectionMiddleware, getCsrfTokenRoute } from './middleware/csrf.middleware.js'
import { setupWebSocket } from './websocket/index.js'
import { errorHandler } from './middleware/error.middleware.js'
import { initDatabase } from './database/init.js'
import { initializeDb } from './database/connection.js'
import { getValidatedEnv } from './utils/env.js'

const app = express()
const server = createServer(app)

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

// 静态文件服务
const frontendDistPath = path.join(__dirname, '../../frontend/dist')
app.use(express.static(frontendDistPath))

// 所有未匹配的请求指向index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendDistPath, 'index.html'))
})

// Error handling
app.use(errorHandler)

const isProduction = env.NODE_ENV === 'production'

// Start servers
async function start() {
  try {
    // Initialize database
    console.log('Initializing application...')
    await initDatabase()

    // Initialize db instance for controllers
    console.log('Initializing database connection...')
    await initializeDb()

    console.log('Application initialization complete')

    // HTTP server - 监听0.0.0.0以允许外部访问
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`HTTP Server running on port ${PORT}`)
    })

    // WebSocket server configuration
    // 生产环境：WebSocket 绑定到 HTTP Server（共享端口）
    // 开发环境：WebSocket 使用独立端口
    let wsServer: WebSocketServer

    if (isProduction) {
      // 生产环境：WebSocket 绑定到 HTTP Server，共享端口，只处理 /ws 路径
      wsServer = new WebSocketServer({
        server,
        path: '/ws'
      })
      console.log(`WebSocket Server sharing port with HTTP Server (${PORT}) at path /ws`)
    } else {
      // 开发环境：WebSocket 使用独立端口
      wsServer = new WebSocketServer({ port: WS_PORT, host: '0.0.0.0' })
      console.log(`WebSocket Server running on port ${WS_PORT}`)
    }

    setupWebSocket(wsServer)

    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`)
    console.log(`Application ready at http://localhost:${PORT}`)
    console.log(`CORS configured with ALLOWED_ORIGINS: ${process.env.ALLOWED_ORIGINS || 'localhost'}`)
  } catch (error) {
    console.error('Failed to start server:', error)
    process.exit(1)
  }
}

start()
