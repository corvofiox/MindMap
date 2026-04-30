import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { db } from '../database/connection.js'
import { canvases, projects, projectMembers, users } from '../database/schema.js'
import { eq, and } from 'drizzle-orm'
import { getValidatedEnv } from '../utils/env.js'
import { log, logError } from '../utils/logger.js'
import {
  loadCanvasStateFromDb,
  getSyncData,
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
const WS_MAX_CONNECTIONS_PER_MIN