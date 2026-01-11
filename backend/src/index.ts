import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'path'

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


const app = express()
const server = createServer(app)

const PORT = parseInt(process.env.PORT || '3000', 10)
const WS_PORT = parseInt(process.env.WS_PORT || '3001', 10)



// Middleware
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true)
    // Allow localhost on any port
    if (origin.startsWith('http://localhost:')) {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
  },
  credentials: true,
}))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// API routes
app.use('/api/auth', authRouter)
app.use('/api/users', userRouter)
app.use('/api/projects', projectRouter)
app.use('/api/canvases', canvasRouter)
app.use('/api/logs', logRouter)
app.use('/api/upload', uploadRouter)
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')))

// Error handling
app.use(errorHandler)

// Start servers
async function start() {
  try {
    // HTTP server
    server.listen(PORT, () => {
      console.log(`HTTP Server running on port ${PORT}`)
    })

    // WebSocket server
    const wsServer = new WebSocketServer({ port: WS_PORT })
    setupWebSocket(wsServer)
    console.log(`WebSocket Server running on port ${WS_PORT}`)

    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`)
  } catch (error) {
    console.error('Failed to start server:', error)
    process.exit(1)
  }
}

start()
