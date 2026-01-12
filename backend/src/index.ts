import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

// 获取当前文件路径
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 加载.env文件，确保路径正确
dotenv.config({ path: path.resolve(__dirname, '../../.env') })

import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'

import { authRouter } from './controllers/auth.controller.js'
import { userRouter } from './controllers/user.controller.js'
import { projectRouter } from './controllers/project.controller.js'
import { canvasRouter } from './controllers/canvas.controller.js'
import { logRouter } from './controllers/log.routes.js'
import { uploadRouter } from './controllers/upload.controller.js'
import { setupWebSocket } from './websocket/index.js'
import { errorHandler } from './middleware/error.middleware.js'
import { initDatabase } from './database/init.js'

const app = express()
const server = createServer(app)

const PORT = parseInt(process.env.PORT || '3000', 10)
const WS_PORT = parseInt(process.env.WS_PORT || '3001', 10)



// Middleware
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true)
    
    // Get allowed origins from environment variable
    const allowedOrigins = process.env.ALLOWED_ORIGINS 
      ? process.env.ALLOWED_ORIGINS.split(',') 
      : []
    
    // Allow localhost on any port (for development)
    if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
      callback(null, true)
    } 
    // Allow allowed origins from environment variable (for production)
    else if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
  },
  credentials: true,
}))
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

// API routes
app.use('/api/auth', authRouter)
app.use('/api/users', userRouter)
app.use('/api/projects', projectRouter)
app.use('/api/canvases', canvasRouter)
app.use('/api/logs', logRouter)
app.use('/api/upload', uploadRouter)

// 静态文件服务
const frontendDistPath = path.join(__dirname, '../../frontend/dist')
app.use(express.static(frontendDistPath))

// 所有未匹配的请求指向index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendDistPath, 'index.html'))
})

// Error handling
app.use(errorHandler)

// Start servers
async function start() {
  try {
    // Initialize database and uploads directory
    console.log('Initializing application...')
    await initDatabase()
    console.log('Application initialization complete')

    // HTTP server - 监听0.0.0.0以允许外部访问
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`HTTP Server running on port ${PORT}`)
    })

    // WebSocket server - 监听0.0.0.0以允许外部访问
    const wsServer = new WebSocketServer({ port: WS_PORT, host: '0.0.0.0' })
    setupWebSocket(wsServer)
    console.log(`WebSocket Server running on port ${WS_PORT}`)

    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`)
    console.log(`Application ready at http://localhost:${PORT}`)
    console.log(`CORS configured with ALLOWED_ORIGINS: ${process.env.ALLOWED_ORIGINS || 'localhost'}`)
  } catch (error) {
    console.error('Failed to start server:', error)
    process.exit(1)
  }
}

start()
