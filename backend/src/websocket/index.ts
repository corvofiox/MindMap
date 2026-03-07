import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { db } from '../database/connection.js'
import { canvases, projects, projectMembers, users } from '../database/schema.js'
import { eq, and } from 'drizzle-orm'
import { getValidatedEnv } from '../utils/env.js'
import { logError } from '../utils/logger.js'

interface CanvasActiveUser {
  userId: number
  email: string
  nickname: string | null
  avatar: string | null
  role: 'owner' | 'editor' | 'viewer'
  joinedAt: number
}

interface WebSocketWithUserData extends WebSocket {
  userId?: number | null
  canvasId?: number
  userRole?: 'owner' | 'editor' | 'viewer'
  userInfo?: CanvasActiveUser
}

interface CanvasRoom {
  id: number
  clients: Set<WebSocketWithUserData>
  activeUsers: Map<number, CanvasActiveUser>
}

interface CollabMessage {
  type: 'operation'
  operation: string
  data: unknown
  timestamp: number
  senderId: number
}

interface SyncMessage {
  type: 'sync'
  nodes: unknown[]
  groups: unknown[]
  domains: unknown[]
  connections: unknown[]
}

interface UserJoinMessage {
  type: 'user-join' | 'user-leave'
  user: CanvasActiveUser
}

interface CursorMessage {
  type: 'cursor'
  userId: number
  x: number
  y: number
}

const canvasRooms = new Map<number, CanvasRoom>()

const wsConnectionRates = new Map<string, { count: number; resetTime: number }>()
const WS_MAX_CONNECTIONS_PER_MINUTE = 100
const WS_WINDOW_MS = 60 * 1000

function checkWsRateLimit(ip: string): boolean {
  const now = Date.now()
  const rateData = wsConnectionRates.get(ip)

  if (!rateData || now > rateData.resetTime) {
    wsConnectionRates.set(ip, {
      count: 1,
      resetTime: now + WS_WINDOW_MS,
    })
    return true
  }

  if (rateData.count >= WS_MAX_CONNECTIONS_PER_MINUTE) {
    console.warn(`WebSocket rate limit exceeded for IP: ${ip}`)
    return false
  }

  rateData.count++
  return true
}

export function setupWebSocket(wss: WebSocketServer) {
  wss.on('connection', handleConnection)

  setInterval(() => {
    const now = Date.now()

    for (const [ip, rateData] of wsConnectionRates.entries()) {
      if (now > rateData.resetTime) {
        wsConnectionRates.delete(ip)
      }
    }

    for (const [canvasId, room] of canvasRooms.entries()) {
      if (room.clients.size === 0) {
        canvasRooms.delete(canvasId)
      }
    }
  }, 60000)
}

export function getCanvasActiveUsers(canvasId: number): CanvasActiveUser[] {
  const room = canvasRooms.get(canvasId)
  if (!room) return []
  return Array.from(room.activeUsers.values())
}

export function getProjectActiveUsers(_projectId: number): Map<number, CanvasActiveUser[]> {
  const result = new Map<number, CanvasActiveUser[]>()
  for (const [canvasId, room] of canvasRooms.entries()) {
    if (room.activeUsers.size > 0) {
      result.set(canvasId, Array.from(room.activeUsers.values()))
    }
  }
  return result
}

async function handleConnection(ws: WebSocketWithUserData, req: any) {
  const clientIp = (req.socket.remoteAddress || (req.headers['x-forwarded-for'] as string) || 'unknown')

  if (!checkWsRateLimit(clientIp)) {
    ws.close(1008, 'Too many connection attempts. Please try again later.')
    return
  }

  const url = new URL(req.url || '', `http://${req.headers.host}`)
  const canvasIdParam = url.searchParams.get('canvasId')
  const tokenParam = url.searchParams.get('token')

  if (!canvasIdParam) {
    ws.close(1008, 'Missing canvasId')
    return
  }

  const canvasId = parseInt(canvasIdParam, 10)
  if (isNaN(canvasId)) {
    ws.close(1008, 'Invalid canvas ID format')
    return
  }

  const authHeader = req.headers.authorization?.replace('Bearer ', '') || tokenParam
  if (!authHeader) {
    ws.close(1008, 'Missing authentication')
    return
  }

  let userId: number | null = null
  try {
    const jwt = (await import('jsonwebtoken')).default
    const env = getValidatedEnv()
    const decoded = jwt.verify(authHeader, env.JWT_SECRET) as { userId: number }
    userId = decoded.userId
  } catch {
    ws.close(1008, 'Invalid token')
    return
  }

  if (!userId) {
    ws.close(1008, 'Authentication required')
    return
  }

  const canvas = await db.query.canvases.findFirst({
    where: eq(canvases.id, canvasId),
  })

  if (!canvas) {
    ws.close(1008, 'Canvas not found')
    return
  }

  const canvasProjectId = (canvas as any).project_id ?? canvas.projectId

  if (!canvasProjectId) {
    ws.close(1008, 'Canvas has no project')
    return
  }

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, canvasProjectId),
  })

  if (!project) {
    ws.close(1008, 'Project not found')
    return
  }

  const projectOwnerId = (project as any).owner_id ?? project.ownerId

  const isOwner = projectOwnerId === userId

  const member = await db.query.projectMembers.findFirst({
    where: and(
      eq(projectMembers.projectId, canvasProjectId),
      eq(projectMembers.userId, userId)
    ),
  })

  const isMember = member && member.id !== undefined

  if (!isOwner && !isMember) {
    ws.close(1008, 'Access denied')
    return
  }

  const userRole = isOwner ? 'owner' : (member?.role || 'viewer')

  const userRecord = await db.query.users.findFirst({
    where: eq(users.id, userId),
  })

  if (!userRecord) {
    ws.close(1008, 'User not found')
    return
  }

  const userInfo: CanvasActiveUser = {
    userId,
    email: userRecord.email,
    nickname: userRecord.nickname,
    avatar: userRecord.avatar,
    role: userRole as 'owner' | 'editor' | 'viewer',
    joinedAt: Date.now(),
  }

  ws.userId = userId
  ws.canvasId = canvasId
  ws.userRole = userRole as 'owner' | 'editor' | 'viewer'
  ws.userInfo = userInfo

  let room = canvasRooms.get(canvasId)
  if (!room) {
    room = {
      id: canvasId,
      clients: new Set(),
      activeUsers: new Map(),
    }
    canvasRooms.set(canvasId, room)
  }

  room.clients.add(ws)
  room.activeUsers.set(userId, userInfo)

  broadcastToRoom(room, {
    type: 'user-join',
    user: userInfo,
  } as UserJoinMessage, ws)

  const existingUsers = Array.from(room.activeUsers.values()).filter(u => u.userId !== userId)
  ws.send(JSON.stringify({
    type: 'room-state',
    users: existingUsers,
  }))

  ws.on('message', (data: Buffer) => {
    handleMessage(ws, room!, data)
  })

  ws.on('close', () => {
    room!.clients.delete(ws)
    room!.activeUsers.delete(ws.userId!)

    broadcastToRoom(room!, {
      type: 'user-leave',
      user: userInfo,
    } as UserJoinMessage, null)

    if (room!.clients.size === 0) {
      canvasRooms.delete(canvasId)
    }
  })

  ws.on('error', (error) => {
    logError('WebSocket connection error', {
      userId: ws.userId,
      canvasId: ws.canvasId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
  })
}

function handleMessage(ws: WebSocketWithUserData, room: CanvasRoom, data: Buffer) {
  try {
    const message = JSON.parse(data.toString())

    switch (message.type) {
      case 'operation':
        handleOperation(ws, room, message as CollabMessage)
        break
      case 'cursor':
        handleCursor(ws, room, message as CursorMessage)
        break
      case 'sync-request':
        handleSyncRequest(ws, room)
        break
      default:
        break
    }
  } catch (error) {
    logError('WebSocket message handling error', {
      userId: ws.userId,
      canvasId: ws.canvasId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function handleOperation(ws: WebSocketWithUserData, room: CanvasRoom, message: CollabMessage) {
  broadcastToRoom(room, message, ws)
}

function handleCursor(ws: WebSocketWithUserData, room: CanvasRoom, message: CursorMessage) {
  broadcastToRoom(room, message, ws)
}

async function handleSyncRequest(ws: WebSocketWithUserData, room: CanvasRoom) {
  try {
    const canvas = await db.query.canvases.findFirst({
      where: eq(canvases.id, room.id),
    })

    if (canvas && (canvas as any).yjsData) {
      const base64Data = (canvas as any).yjsData
      const jsonString = Buffer.from(base64Data, 'base64').toString('utf-8')
      const data = JSON.parse(jsonString)

      ws.send(JSON.stringify({
        type: 'sync',
        nodes: data.nodes || [],
        groups: data.groups || [],
        domains: data.domains || [],
        connections: data.connections || [],
      } as SyncMessage))
    } else {
      ws.send(JSON.stringify({
        type: 'sync',
        nodes: [],
        groups: [],
        domains: [],
        connections: [],
      } as SyncMessage))
    }
  } catch (error) {
    logError('Failed to sync canvas data', {
      canvasId: room.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function broadcastToRoom(room: CanvasRoom, message: unknown, excludeClient: WebSocketWithUserData | null) {
  const messageStr = JSON.stringify(message)

  for (const client of room.clients) {
    if (client !== excludeClient && client.readyState === 1) {
      client.send(messageStr)
    }
  }
}
