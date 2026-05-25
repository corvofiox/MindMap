import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { db } from '../database/connection.js'
import { canvases, projects, projectMembers, users } from '../database/schema.js'
import { eq, and } from 'drizzle-orm'
import { getValidatedEnv } from '../utils/env.js'
import { log, logError } from '../utils/logger.js'

// Type-safe property accessors for database records that may have
// either camelCase or snake_case property names due to Drizzle ORM inconsistencies
function getCanvasProjectId(canvas: Record<string, unknown>): number | undefined {
  if ('projectId' in canvas && typeof canvas.projectId === 'number') {
    return canvas.projectId
  }
  if ('project_id' in canvas && typeof canvas.project_id === 'number') {
    return canvas.project_id
  }
  return undefined
}

function getProjectOwnerId(project: Record<string, unknown>): number | undefined {
  if ('ownerId' in project && typeof project.ownerId === 'number') {
    return project.ownerId
  }
  if ('owner_id' in project && typeof project.owner_id === 'number') {
    return project.owner_id
  }
  return undefined
}
import {
  loadCanvasStateFromDb,
  getSyncData,
  persistCanvasState,
  applyAddNode,
  applyUpdateNode,
  applyRemoveNode,
  applyAddGroup,
  applyUpdateGroup,
  applyRemoveGroup,
  applyAddDomain,
  applyUpdateDomain,
  applyRemoveDomain,
  applyAddConnection,
  applyUpdateConnection,
  applyRemoveConnection,
  removeCanvasState,
  flushPendingPersist,
  getCanvasState,
  isCanvasStatePersisted,
  startPeriodicCanvasFlush,
  stopPeriodicCanvasFlush,
  incrementStateGeneration,
  getStateGeneration,
} from './canvas-state.js'

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
  isAlive?: boolean
  lastPong?: number
}

interface CanvasRoom {
  id: number
  clients: Set<WebSocketWithUserData>
  activeUsers: Map<number, CanvasActiveUser>
  userConnectionCounts: Map<number, number>
}

interface CollabMessage {
  type: 'operation'
  operation: string
  data: unknown
  timestamp: number
  senderId: number
  seq?: number
}

interface SyncMessage {
  type: 'sync'
  nodes: unknown[]
  groups: unknown[]
  domains: unknown[]
  connections: unknown[]
  version: number
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

const HEARTBEAT_INTERVAL_MS = 30000
const HEARTBEAT_TIMEOUT_MS = 60000

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
    log('WebSocket rate limit exceeded', { ip })
    return false
  }

  rateData.count++
  return true
}

export function setupWebSocket(wss: WebSocketServer) {
  wss.on('connection', handleConnection)

  startPeriodicCanvasFlush()

  const heartbeatIntervalId = setInterval(() => {
    const now = Date.now()

    for (const [ip, rateData] of wsConnectionRates.entries()) {
      if (now > rateData.resetTime) {
        wsConnectionRates.delete(ip)
      }
    }

    for (const [canvasId, room] of canvasRooms.entries()) {
      if (room.clients.size === 0) {
        flushPendingPersist(canvasId)
        // Always remove the room so it doesn't leak
        canvasRooms.delete(canvasId)
        if (!isCanvasStatePersisted(canvasId)) {
          const gen = getStateGeneration(canvasId)
          persistCanvasState(canvasId).then((success) => {
            // 防止竞态：新连接可能在异步持久化期间创建了新的 CanvasData
            if (getStateGeneration(canvasId) !== gen) return
            if (success || isCanvasStatePersisted(canvasId)) {
              removeCanvasState(canvasId)
            }
          })
        } else {
          removeCanvasState(canvasId)
        }
    continue
      }

      for (const client of Array.from(room.clients)) {
        try {
          if (client.lastPong === undefined || (now - client.lastPong) > HEARTBEAT_TIMEOUT_MS) {
            handleClientDisconnect(client, room, true)
            continue
          }
          client.isAlive = false
          client.ping()
        } catch (error) {
          logError('Heartbeat error for client', {
            userId: client.userId,
            canvasId: client.canvasId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
  }, HEARTBEAT_INTERVAL_MS)

  wss.on('close', () => {
    clearInterval(heartbeatIntervalId)
    stopPeriodicCanvasFlush()
  })
}

export function broadcastVersionUpdate(canvasId: number, version: number): void {
  const room = canvasRooms.get(canvasId)
  if (!room) return

  broadcastToRoom(room, {
    type: 'version-update',
    version,
  }, null)
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

  const canvasProjectId = getCanvasProjectId(canvas as Record<string, unknown>)

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

  const projectOwnerId = getProjectOwnerId(project as Record<string, unknown>)

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
  ws.isAlive = true
  ws.lastPong = Date.now()

  let room = canvasRooms.get(canvasId)
  if (!room) {
    room = {
      id: canvasId,
      clients: new Set(),
      activeUsers: new Map(),
      userConnectionCounts: new Map(),
    }
    canvasRooms.set(canvasId, room)
    // 递增世代计数，防止旧异步回调误删新创建的 CanvasData
    incrementStateGeneration(canvasId)
  }

  room.clients.add(ws)
  room.activeUsers.set(userId, userInfo)

  const currentCount = room.userConnectionCounts.get(userId) || 0
  room.userConnectionCounts.set(userId, currentCount + 1)

  // Load canvas state from DB if not already in memory
  await loadCanvasStateFromDb(canvasId)

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

  ws.on('pong', () => {
    ws.isAlive = true
    ws.lastPong = Date.now()
  })

  ws.on('close', () => {
    handleClientDisconnect(ws, room!)
  })

  ws.on('error', (error) => {
    logError('WebSocket connection error', {
      userId: ws.userId,
      canvasId: ws.canvasId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
    handleClientDisconnect(ws, room!, true)
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

function handleClientDisconnect(ws: WebSocketWithUserData, room: CanvasRoom, shouldTerminate = false) {
  if (!room) return

  const wasInRoom = room.clients.delete(ws)
  if (!wasInRoom) return

  if (ws.userId) {
    const currentCount = (room.userConnectionCounts.get(ws.userId) || 1) - 1
    if (currentCount <= 0) {
      room.userConnectionCounts.delete(ws.userId)
      room.activeUsers.delete(ws.userId)

      if (ws.userInfo) {
        broadcastToRoom(room, {
          type: 'user-leave',
          user: ws.userInfo,
        } as UserJoinMessage, null)
      }
    } else {
      room.userConnectionCounts.set(ws.userId, currentCount)
    }
  }

  if (room.clients.size === 0) {
    flushPendingPersist(room.id)
    // Always remove the room so it doesn't leak, even if persist hasn't completed yet.
    // The canvas state stays in memory and will be flushed by the periodic persist.
    canvasRooms.delete(room.id)
    const gen = getStateGeneration(room.id)
    persistCanvasState(room.id).then((success) => {
      // 防止竞态：新连接可能在异步持久化期间创建了新的 CanvasData
      if (getStateGeneration(room.id) !== gen) return
      if (success || isCanvasStatePersisted(room.id)) {
        removeCanvasState(room.id)
      }
    })
  }

  if (shouldTerminate && ws.readyState === 1) {
    ws.terminate()
  }
}

function handleOperation(ws: WebSocketWithUserData, room: CanvasRoom, message: CollabMessage) {
  // Only editors and owners can modify
  if (ws.userRole === 'viewer') {
    return
  }

  const canvasId = room.id
  let applied = false

  try {
    switch (message.operation) {
      case 'add-node':
        applied = applyAddNode(canvasId, message.data)
        break
      case 'update-node': {
        const { id, updates } = message.data as { id: string; updates: unknown }
        applied = applyUpdateNode(canvasId, id, updates)
        break
      }
      case 'remove-node': {
        const { id } = message.data as { id: string }
        applied = applyRemoveNode(canvasId, id)
        break
      }
      case 'add-group':
        applied = applyAddGroup(canvasId, message.data)
        break
      case 'update-group': {
        const { id, updates } = message.data as { id: string; updates: unknown }
        applied = applyUpdateGroup(canvasId, id, updates)
        break
      }
      case 'remove-group': {
        const { id } = message.data as { id: string }
        applied = applyRemoveGroup(canvasId, id)
        break
      }
      case 'add-domain':
        applied = applyAddDomain(canvasId, message.data)
        break
      case 'update-domain': {
        const { id, updates } = message.data as { id: string; updates: unknown }
        applied = applyUpdateDomain(canvasId, id, updates)
        break
      }
      case 'remove-domain': {
        const { id } = message.data as { id: string }
        applied = applyRemoveDomain(canvasId, id)
        break
      }
      case 'add-connection':
        applied = applyAddConnection(canvasId, message.data)
        break
      case 'update-connection': {
        const { id, updates } = message.data as { id: string; updates: unknown }
        applied = applyUpdateConnection(canvasId, id, updates)
        break
      }
      case 'remove-connection': {
        const { id } = message.data as { id: string }
        applied = applyRemoveConnection(canvasId, id)
        break
      }
      default:
        break
    }
  } catch (error) {
    logError('Failed to apply operation', {
      canvasId,
      operation: message.operation,
      error: error instanceof Error ? error.message : String(error),
    })
    return
  }

  if (applied) {
    broadcastToRoom(room, message, ws)
    broadcastVersionUpdate(canvasId, getCanvasState(canvasId)!.version)

    // 向发送方回 ACK 确认操作已处理
    if (typeof message.seq === 'number' && ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'ack',
        seq: message.seq,
      }))
    }
  }
}

function handleCursor(ws: WebSocketWithUserData, room: CanvasRoom, message: CursorMessage) {
  broadcastToRoom(room, message, ws)
}

async function handleSyncRequest(ws: WebSocketWithUserData, room: CanvasRoom) {
  try {
    const syncData = getSyncData(room.id)

    ws.send(JSON.stringify({
      type: 'sync',
      nodes: syncData.nodes,
      groups: syncData.groups,
      domains: syncData.domains,
      connections: syncData.connections,
      version: syncData.version,
    } as SyncMessage))
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
