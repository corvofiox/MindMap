import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { db } from '../database/connection.js'
import { canvases, projects, projectMembers, users } from '../database/schema.js'
import { eq, and } from 'drizzle-orm'
import { getValidatedEnv } from '../utils/env.js'
import { log, logError } from '../utils/logger.js'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'

// Per-connection rate limits for WebSocket messages. SYNC messages are
// CPU-heavy (Y.applyUpdate + N-way broadcast); AWARENESS is high-frequency
// cursor/selection; text frames are low-frequency business JSON.
const SYNC_RATE_LIMIT = 50   // per second
const AWARE_RATE_LIMIT = 200 // per second
const TEXT_RATE_LIMIT = 10   // per second

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
  persistCanvasState,
  removeCanvasState,
  flushPendingPersist,
  isCanvasStatePersisted,
  startPeriodicCanvasFlush,
  stopPeriodicCanvasFlush,
  incrementStateGeneration,
  getStateGeneration,
  getCanvasDoc,
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
  // 应用层 pong 时间戳（前端主动发 ping/pong，弥补浏览器无法响应 ws.ping）
  lastAppPong?: number
  /** Per-connection awareness client ids, kept so we can clean them up on disconnect. */
  awarenessClientIds?: number[]
  /** Per-connection sliding-window rate-limit timestamps. */
  syncTimestamps?: number[]
  awarenessTimestamps?: number[]
  textTimestamps?: number[]
}

export interface CanvasRoom {
  id: number
  clients: Set<WebSocketWithUserData>
  activeUsers: Map<number, CanvasActiveUser>
  userConnectionCounts: Map<number, number>
  /** Shared Yjs awareness state for this canvas room. */
  awareness: awarenessProtocol.Awareness
  /**
   * True once this room has ever hosted more than one distinct user.
   * Kept on the room so a stale REST snapshot arriving after the last user
   * leaves can still be treated as a potential overwrite of peer edits.
   */
  everCollaborative?: boolean
}

/**
 * 测试专用：注入受控的 room 状态，用于验证 kickUserFromRoom / updateUserRole
 * 的真实行为（send kicked 消息、terminate、广播）。下划线前缀表明仅供测试使用。
 * 生产代码不应调用。
 */
export function _setRoomForTesting(canvasId: number, room: CanvasRoom | null): void {
  if (room) {
    canvasRooms.set(canvasId, room)
  } else {
    canvasRooms.delete(canvasId)
  }
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

/** Per-room broadcast handler + its owning doc id (stored as extra fields). */
type RoomWithBroadcast = CanvasRoom & {
  _broadcastHandler?: (u: Uint8Array, o: unknown) => void
  _docId?: number
}

const canvasRooms = new Map<number, CanvasRoom>()

/**
 * R1 加固：REST 全量快照 vs WS 并发编辑的 TOCTOU 窗口。
 *
 * POST /data 的 upsertOnly 判定（getCanvasActiveUsers）与 mergeJsonSnapshotIntoCanvas
 * 之间存在异步窗口：判定时房间还有活跃用户（走 upsertOnly），merge 前房间恰好拆除
 * （如最后一个客户端断开），判定结果就过期了——此时一个来自断线客户端的过期全量快照
 * 会被当作"无协作"而允许删除对端编辑。
 *
 * 记录每个房间拆除的时刻；若该画布曾经有过多人协作（everCollaborative），拆除后的一
 * 段宽限期内仍按 upsertOnly 处理 POST /data，兜住"最后离开者携带过期快照"的窗口。
 * 纯单用户画布不受影响（快照删除是真实操作，兜底保存必须正常全量合并）。
 */
const POST_COLLAB_UPSERT_GRACE_MS = 15_000
/** 拆除记录保留时间：宽限期之外这些记录已无用途，定期清理防止内存无界增长。 */
const TEARDOWN_RECORD_TTL_MS = POST_COLLAB_UPSERT_GRACE_MS * 2
/** 画布 id 集合：该画布的某个房间曾经同时存在过多个不同用户。只增不减（保守）。 */
const collaborativeCanvasIds = new Set<number>()
/** canvasId → 最近一次房间拆除时刻（epoch ms）。 */
const roomTeardownTimes = new Map<number, number>()

/**
 * 定期清理 roomTeardownTimes / collaborativeCanvasIds：
 * 两者只在"拆除后宽限期"内有意义（shouldUpsertOnlyForSnapshot 仅在
 * teardown 时间新鲜时读取），超过 TTL 的条目直接丢弃，使内存占用有界。
 */
export function pruneRoomTeardownRecords(now: number = Date.now()): void {
  for (const [canvasId, teardownAt] of roomTeardownTimes) {
    if (now - teardownAt > TEARDOWN_RECORD_TTL_MS) {
      roomTeardownTimes.delete(canvasId)
    }
  }
  for (const canvasId of collaborativeCanvasIds) {
    const teardownAt = roomTeardownTimes.get(canvasId)
    if (teardownAt === undefined || now - teardownAt > TEARDOWN_RECORD_TTL_MS) {
      collaborativeCanvasIds.delete(canvasId)
    }
  }
}

export function shouldUpsertOnlyForSnapshot(canvasId: number): boolean {
  if (getCanvasActiveUsers(canvasId).length > 0) return true
  if (!collaborativeCanvasIds.has(canvasId)) return false
  const teardownAt = roomTeardownTimes.get(canvasId)
  if (teardownAt === undefined) return false
  return Date.now() - teardownAt < POST_COLLAB_UPSERT_GRACE_MS
}

/** 测试专用：注入房间拆除记录，用于验证宽限期判定（下划线前缀仅供测试使用）。 */
export function _recordRoomTeardownForTesting(canvasId: number, everCollaborative: boolean): void {
  if (everCollaborative) collaborativeCanvasIds.add(canvasId)
  roomTeardownTimes.set(canvasId, Date.now())
}

/**
 * Register a single doc 'update' → broadcast handler on the room, ONCE.
 * Subsequent connections reuse it. The handler excludes the sender by reading
 * the transaction origin (the sender's ws instance). This prevents the
 * O(N)-handlers problem where N connections each register their own handler.
 */
function ensureRoomBroadcastHandler(room: CanvasRoom, doc: Y.Doc | undefined) {
  const rw = room as RoomWithBroadcast
  if (rw._broadcastHandler || !doc) return
  const handler = (update: Uint8Array, origin: unknown) => {
    broadcastYjsUpdate(room, update, (origin as WebSocketWithUserData | null) ?? null)
  }
  doc.on('update', handler)
  rw._broadcastHandler = handler
  rw._docId = room.id
}

/** Detach the room-level broadcast handler (called when room empties). */
function detachRoomBroadcastHandler(room: CanvasRoom) {
  const rw = room as RoomWithBroadcast
  if (rw._broadcastHandler && rw._docId !== undefined) {
    const doc = getCanvasDoc(rw._docId)
    doc?.off('update', rw._broadcastHandler)
    rw._broadcastHandler = undefined
    rw._docId = undefined
  }
}

const wsConnectionRates = new Map<string, { count: number; resetTime: number }>()
const WS_MAX_CONNECTIONS_PER_MINUTE = 100
const WS_WINDOW_MS = 60 * 1000
const WS_MAX_MESSAGE_BYTES = 5 * 1024 * 1024

// P2: 心跳采用双保险——ws 原生 ping/pong + 应用层 ping/pong。
// 浏览器 WebSocket 不暴露 ping API，依赖 OS 自动回 pong；设备休眠/切后台时
// 原生 pong 可能延迟。前端每 25s 主动发应用层 ping，此处收到后更新 lastAppPong。
// 超时拉长到 120s 容忍短暂休眠，且要求两个通道都超时才判死（避免误杀健康连接）。
const HEARTBEAT_INTERVAL_MS = 30000
const HEARTBEAT_TIMEOUT_MS = 120000

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

    // 定期清理过期的房间拆除记录，防止 roomTeardownTimes / collaborativeCanvasIds 无界增长。
    pruneRoomTeardownRecords(now)

    for (const [ip, rateData] of wsConnectionRates.entries()) {
      if (now > rateData.resetTime) {
        wsConnectionRates.delete(ip)
      }
    }

    for (const [canvasId, room] of canvasRooms.entries()) {
      if (room.clients.size === 0) {
        teardownEmptyRoom(canvasId, room)
        continue
      }

      for (const client of Array.from(room.clients)) {
        try {
          // P2 双保险：ws 原生 pong 与应用层 pong 两个通道，任一仍在超时窗口内
          // 即视为连接存活。避免浏览器在休眠/切后台时因 OS 层 pong 延迟被误杀。
          const nativeStale = client.lastPong === undefined || (now - client.lastPong) > HEARTBEAT_TIMEOUT_MS
          const appStale = client.lastAppPong === undefined || (now - client.lastAppPong) > HEARTBEAT_TIMEOUT_MS
          if (nativeStale && appStale) {
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

/**
 * Tear down an empty room: flush pending persist, detach the room-level
 * broadcast handler, remove the room from the map, destroy shared awareness,
 * and trigger generation-guarded doc cleanup.
 *
 * Single source of truth for the 5-step teardown used by both the heartbeat
 * callback (when a room empties out between connections) and
 * handleClientDisconnect (when the last client leaves). Keeps the two paths
 * in sync so future changes don't have to be applied in two places.
 */
function teardownEmptyRoom(canvasId: number, room: CanvasRoom): void {
  flushPendingPersist(canvasId)
  detachRoomBroadcastHandler(room)
  canvasRooms.delete(canvasId)
  // R1: 记录拆除时刻与协作历史，供 shouldUpsertOnlyForSnapshot 的宽限期判定使用。
  if (room.everCollaborative) {
    collaborativeCanvasIds.add(canvasId)
  }
  roomTeardownTimes.set(canvasId, Date.now())
  // Awareness may be absent in unit tests that inject a minimal room.
  try {
    room.awareness?.destroy()
  } catch {
    // best-effort
  }
  cleanupEmptyRoom(canvasId)
}

/**
 * Tear down a room's in-memory doc once every client has left.
 * Generation-guarded so a late persist callback cannot wipe a freshly recreated doc.
 * Even if persist fails, the state is removed after a short delay to avoid a
 * permanent memory leak; the periodic flush will have had one more chance by then.
 */
function cleanupEmptyRoom(canvasId: number): void {
  if (!isCanvasStatePersisted(canvasId)) {
    const gen = getStateGeneration(canvasId)
    persistCanvasState(canvasId).then((success) => {
      if (getStateGeneration(canvasId) !== gen) return
      if (success || isCanvasStatePersisted(canvasId)) {
        removeCanvasState(canvasId)
      } else {
        // Persist failed and doc is still dirty. Schedule a final cleanup so
        // the state (and its Y.Doc) doesn't leak forever. If a new client
        // connects before this fires, cancel the pending timeout.
        // The periodic flush gets one more chance in the meantime.
        log('cleanupEmptyRoom: persist failed, scheduling delayed state removal', { canvasId })
        const existingTimeout = cleanupTimeouts.get(canvasId)
        if (existingTimeout) clearTimeout(existingTimeout)
        cleanupTimeouts.set(canvasId, setTimeout(() => {
          cleanupTimeouts.delete(canvasId)
          if (getStateGeneration(canvasId) === gen) {
            removeCanvasState(canvasId)
          }
        }, 5000))
      }
    })
  } else {
    removeCanvasState(canvasId)
  }
}

// Track pending delayed-cleanup timeouts so they can be cancelled if a new
// client reconnects before the timer fires.
const cleanupTimeouts = new Map<number, ReturnType<typeof setTimeout>>()

export function getCanvasActiveUsers(canvasId: number): CanvasActiveUser[] {
  const room = canvasRooms.get(canvasId)
  if (!room) return []
  return Array.from(room.activeUsers.values())
}

/**
 * Get active users for each canvas room that has connected users.
 * NOTE: projectId parameter is kept for API compatibility but currently
 * unused — this function returns data for ALL canvases regardless of
 * project. If per-project filtering is needed, add a canvasId→projectId
 * lookup table.
 */
export function getProjectActiveUsers(projectId: number): Map<number, CanvasActiveUser[]> {
  const result = new Map<number, CanvasActiveUser[]>()
  if (!projectId) return result
  for (const [canvasId, room] of canvasRooms.entries()) {
    if (room.activeUsers.size > 0) {
      result.set(canvasId, Array.from(room.activeUsers.values()))
    }
  }
  return result
}

/**
 * P3: 踢出某画布内指定用户的所有 WS 连接（owner 移除成员后调用）。
 * 先发送 kicked 通知让前端提示用户并跳转，再调用 handleClientDisconnect(..., true)
 * 触发引用计数清理 + ws.terminate()（复用现有断连逻辑，正确广播 user-leave）。
 */
export function kickUserFromRoom(canvasId: number, userId: number, reason: string = 'removed'): void {
  const room = canvasRooms.get(canvasId)
  if (!room) return

  for (const client of Array.from(room.clients)) {
    if (client.userId === userId) {
      try {
        if (client.readyState === 1) {
          client.send(JSON.stringify({ type: 'kicked', reason }))
        }
      } catch {
        // send 失败不阻塞，继续走 close
      }
      handleClientDisconnect(client, room, true)
    }
  }
}

/**
 * 关闭整个画布房间：向所有连接的客户端发送 `kicked` 通知后断开连接。
 * 用于画布或所属项目被删除时，避免已连接客户端继续往已删画布发更新。
 */
export function closeRoom(canvasId: number, reason: string = 'canvas-deleted'): void {
  const room = canvasRooms.get(canvasId)
  if (!room) return

  for (const client of Array.from(room.clients)) {
    try {
      if (client.readyState === 1) {
        client.send(JSON.stringify({ type: 'kicked', reason }))
      }
    } catch {
      // send 失败不阻塞，继续走 close
    }
    handleClientDisconnect(client, room, true)
  }
}

/**
 * P3: 更新某画布内指定用户的在线角色（owner 调整成员角色后调用）。
 * 同步更新 ws.userRole（handleOperation 的权限判定依据）与 room.activeUsers，
 * 并广播 user-role-changed 让其他客户端刷新用户列表 UI。
 */
export function updateUserRole(canvasId: number, userId: number, newRole: 'editor' | 'viewer'): void {
  const room = canvasRooms.get(canvasId)
  if (!room) return

  const userInfo = room.activeUsers.get(userId)
  if (userInfo) {
    userInfo.role = newRole
    room.activeUsers.set(userId, userInfo)
  }

  for (const client of Array.from(room.clients)) {
    if (client.userId === userId) {
      client.userRole = newRole
    }
  }

  broadcastToRoom(room, {
    type: 'user-role-changed',
    userId,
    role: newRole,
  }, null)
}

function normalizeClientIp(ip: string): string {
  if (ip.startsWith('::ffff:')) {
    return ip.slice(7)
  }
  return ip
}

function getClientIp(req: { socket: { remoteAddress?: string }; headers: { 'x-forwarded-for'?: string | string[] } }): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded) {
    const first = forwarded.split(',')[0].trim()
    if (first) return normalizeClientIp(first)
  }
  return normalizeClientIp(req.socket.remoteAddress || 'unknown')
}

async function handleConnection(ws: WebSocketWithUserData, req: any) {
  const clientIp = getClientIp(req)

  // Buffer early messages before async setup completes.
  // ws (EventEmitter) silently drops messages when no 'message' listener is registered.
  // Since this function is async with multiple awaits, the client may send messages
  // (e.g. a Yjs SYNC STEP1) before we reach ws.on('message', ...) — those would be lost.
  const earlyMessages: Array<{ isBinary: boolean; data: Buffer }> = []
  const earlyMessageListener = (data: Buffer, isBinary: boolean) => {
    earlyMessages.push({ isBinary, data })
  }
  ws.on('message', earlyMessageListener)

  // Also register pong/close/error early to avoid missing these events during async setup
  const earlyPongHandler = () => {
    ws.isAlive = true
    ws.lastPong = Date.now()
  }
  ws.on('pong', earlyPongHandler)

  let earlyClose = false
  const earlyCloseHandler = () => { earlyClose = true }
  ws.on('close', earlyCloseHandler)

  const earlyErrorHandler = (error: Error) => {
    logError('WebSocket connection error during setup', {
      error: error instanceof Error ? error.message : String(error),
    })
    earlyClose = true
  }
  ws.on('error', earlyErrorHandler)

  // Helper to clean up early listeners when connection is rejected during setup
  const cleanupEarlyListeners = () => {
    ws.off('message', earlyMessageListener)
    ws.off('pong', earlyPongHandler)
    ws.off('close', earlyCloseHandler)
    ws.off('error', earlyErrorHandler)
  }

  try {
  if (!checkWsRateLimit(clientIp)) {
    cleanupEarlyListeners()
    ws.close(1008, 'Too many connection attempts. Please try again later.')
    return
  }

  const url = new URL(req.url || '', `http://${req.headers.host}`)
  const canvasIdParam = url.searchParams.get('canvasId')
  const tokenParam = url.searchParams.get('token')

  if (!canvasIdParam) {
    cleanupEarlyListeners()
    ws.close(1008, 'Missing canvasId')
    return
  }

  const canvasId = parseInt(canvasIdParam, 10)
  if (isNaN(canvasId)) {
    cleanupEarlyListeners()
    ws.close(1008, 'Invalid canvas ID format')
    return
  }

  // Supports three transport mechanisms (ordered by security preference):
  // 1. Authorization: Bearer header (standard, preferred)
  // 2. Sec-WebSocket-Protocol header (used by browser WebSocket API)
  // 3. URL query parameter ?token=... (fallback, accepted for compatibility
  //    but not recommended — tokens in URLs can leak via server logs/Referer)
  const authHeader = req.headers.authorization?.replace('Bearer ', '')
    || (req.headers['sec-websocket-protocol'] as string)
    || tokenParam
  if (!authHeader) {
    cleanupEarlyListeners()
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
    cleanupEarlyListeners()
    ws.close(1008, 'Invalid token')
    return
  }

  if (!userId) {
    cleanupEarlyListeners()
    ws.close(1008, 'Authentication required')
    return
  }

  // Check if client disconnected during async auth
  if (earlyClose) {
    cleanupEarlyListeners()
    return
  }

  const canvas = await db.query.canvases.findFirst({
    where: eq(canvases.id, canvasId),
  })

  if (!canvas) {
    cleanupEarlyListeners()
    ws.close(1008, 'Canvas not found')
    return
  }

  const canvasProjectId = getCanvasProjectId(canvas as Record<string, unknown>)

  if (!canvasProjectId) {
    cleanupEarlyListeners()
    ws.close(1008, 'Canvas has no project')
    return
  }

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, canvasProjectId),
  })

  if (!project) {
    cleanupEarlyListeners()
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
    cleanupEarlyListeners()
    ws.close(1008, 'Access denied')
    return
  }

  const userRole = isOwner ? 'owner' : (member?.role || 'viewer')

  const userRecord = await db.query.users.findFirst({
    where: eq(users.id, userId),
  })

  if (!userRecord) {
    cleanupEarlyListeners()
    ws.close(1008, 'User not found')
    return
  }

  // Check if client disconnected during async DB queries
  if (earlyClose) {
    cleanupEarlyListeners()
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
  // P2 dual-path heartbeat: initialize app-layer pong alongside native pong so
  // the first heartbeat cycle doesn't see it as undefined + stale → false positive.
  ws.lastAppPong = Date.now()

  let room = canvasRooms.get(canvasId)
  if (!room) {
    // Cancel any pending delayed-cleanup timeout — a new client reconnected
    // before the timer fired.
    const pendingCleanup = cleanupTimeouts.get(canvasId)
    if (pendingCleanup) {
      clearTimeout(pendingCleanup)
      cleanupTimeouts.delete(canvasId)
    }
    room = {
      id: canvasId,
      clients: new Set(),
      activeUsers: new Map(),
      userConnectionCounts: new Map(),
      awareness: new awarenessProtocol.Awareness(new Y.Doc()),
    }
    canvasRooms.set(canvasId, room)
    // 递增世代计数，防止旧异步回调误删新创建的 CanvasData
    incrementStateGeneration(canvasId)
  }

  room.clients.add(ws)
  room.activeUsers.set(userId, userInfo)

  const currentCount = room.userConnectionCounts.get(userId) || 0
  room.userConnectionCounts.set(userId, currentCount + 1)

  // R1: 一旦房间同时存在多个不同用户，标记该房间为"多人协作过"。
  // 用不同用户数（而非连接数）判断：同一用户的多标签页不算协作。
  if (room.userConnectionCounts.size > 1) {
    room.everCollaborative = true
  }

  // Load the authoritative Yjs doc from DB.
  await loadCanvasStateFromDb(canvasId)

  // Register the doc's broadcast handler ONCE per room (not per connection).
  // The handler uses the transaction origin (the sender's ws instance) to
  // exclude the sender from the broadcast, so a single handler serves all N
  // clients. Without this, N connections would register N handlers and each
  // update would be broadcast N times (O(N) redundant traffic).
  const doc = getCanvasDoc(canvasId)
  ensureRoomBroadcastHandler(room!, doc)

  // Check if client disconnected during async state loading
  if (earlyClose) {
    cleanupEarlyListeners()
    handleClientDisconnect(ws, room)
    return
  }

  broadcastToRoom(room, {
    type: 'user-join',
    user: userInfo,
  } as UserJoinMessage, ws)

  const existingUsers = Array.from(room.activeUsers.values()).filter(u => u.userId !== userId)
  ws.send(JSON.stringify({
    type: 'room-state',
    users: existingUsers,
  }))

  // Replace early message listener with the real one
  ws.off('message', earlyMessageListener)
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    handleMessage(ws, room!, data, isBinary)
  })

  // Replace early close listener with the real one
  ws.off('close', earlyCloseHandler)
  ws.on('close', () => {
    handleClientDisconnect(ws, room!)
  })

  // Replace early error listener with the real one
  ws.off('error', earlyErrorHandler)
  ws.on('error', (error) => {
    logError('WebSocket connection error', {
      userId: ws.userId,
      canvasId: ws.canvasId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
    handleClientDisconnect(ws, room!, true)
  })

  // Process buffered early messages (e.g. Yjs SYNC STEP1 sent right after connect)
  for (const { isBinary, data } of earlyMessages) {
    handleMessage(ws, room!, data, isBinary)
  }

  } catch (error) {
    // If any unexpected error occurs during setup, clean up
    logError('Unexpected error during WebSocket connection setup', {
      error: error instanceof Error ? error.message : String(error),
    })
    cleanupEarlyListeners()
    // If the ws was already added to a room before the error, detach it so
    // the room's client set and reference counts don't leak. The room variable
    // is assigned inside the try block; check it via canvasRooms lookup.
    if (ws.canvasId !== undefined) {
      const room = canvasRooms.get(ws.canvasId)
      if (room && room.clients.has(ws)) {
        handleClientDisconnect(ws, room)
      }
    }
    if (ws.readyState === 1) {
      ws.close(1011, 'Internal server error')
    }
  }
}

/**
 * Message dispatcher. Text frames carry business JSON (cursor/ping/kicked/etc.),
 * binary frames carry Yjs sync protocol bytes.
 */
function handleMessage(ws: WebSocketWithUserData, room: CanvasRoom, data: Buffer, isBinary: boolean) {
  // Per-connection rate limit with separate windows for SYNC (doc edits)
  // and AWARENESS (cursor movements). Text messages share one window.
  // SYNC messages are CPU-heavy (Y.applyUpdate + N-way broadcast).
  //
  // The category is determined first. Binary frames default to the SYNC
  // window; if the leading varUint cannot be decoded the frame is still
  // counted as SYNC so malformed frames cannot bypass the rate limit.
  let cat: 'sync' | 'awareness' | 'text' = isBinary ? 'sync' : 'text'
  if (isBinary && data.length > 0) {
    try {
      // Yjs envelope: first varUint is the message type (0=SYNC, 1=AWARENESS).
      // Use decoding.readVarUint so multi-byte varUints are handled correctly.
      const messageType = decoding.readVarUint(decoding.createDecoder(data))
      if (messageType === 1) cat = 'awareness'
    } catch {
      // Keep cat='sync' so malformed binary frames are rate-limited instead of
      // dropped silently. The actual frame will be rejected later in handling.
    }
  }

  try {
    const now = Date.now()
    const limit = cat === 'sync' ? SYNC_RATE_LIMIT : cat === 'awareness' ? AWARE_RATE_LIMIT : TEXT_RATE_LIMIT
    const window: number[] =
      cat === 'sync'
        ? (ws.syncTimestamps ??= [])
        : cat === 'awareness'
          ? (ws.awarenessTimestamps ??= [])
          : (ws.textTimestamps ??= [])
    while (window.length > 0 && window[0] < now - 1000) window.shift()
    if (window.length >= limit) {
      ws.send(JSON.stringify({ type: 'error', message: 'rate limited' }))
      ws.close(1008, 'rate limited')
      return
    }
    window.push(now)
  } catch {
    // rate-limit bookkeeping must never throw; log and drop the frame.
    log('WebSocket rate-limit bookkeeping error, dropping frame', {
      userId: ws.userId,
      canvasId: ws.canvasId,
      isBinary,
      length: data.length,
    })
    return
  }

  try {
    if (data.length > WS_MAX_MESSAGE_BYTES) {
      logError('WebSocket message exceeds size limit, dropping', {
        userId: ws.userId,
        canvasId: ws.canvasId,
        size: data.length,
        limit: WS_MAX_MESSAGE_BYTES,
      })
      return
    }
    if (isBinary && data.length > 0) {
      const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      handleYjsBinaryMessage(ws, room, view)
      return
    }

    const text = data.toString()
    if (!text) return
    const message = JSON.parse(text)

    switch (message.type) {
      case 'cursor':
        handleCursor(ws, room, message as CursorMessage)
        break
      case 'ping':
        // P2: 应用层心跳——浏览器无法响应 ws.ping，前端主动发 ping，此处回 pong
        // 并更新 lastAppPong，作为双保险心跳判定的第二通道。
        ws.lastAppPong = Date.now()
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }))
        }
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

/**
 * Parse a Yjs sync-protocol binary frame (y-websocket compatible).
 *
 * 标准信封：[varUint messageType, payload...]
 *   messageType 0 = SYNC：内部再用 syncProtocol 的标准格式 [varUint subType, ...]
 *     subType 0 = STEP1（客户端发 state vector，服务端回 STEP2）
 *     subType 1 = STEP2（客户端发 update，服务端 apply）
 *     subType 2 = UPDATE（等价于 STEP2，y-websocket 对客户端更新的标记）
 *   messageType 1 = AWARENESS：awareness 二进制 update
 *
 * 用 syncProtocol.readSyncMessage 一次性处理 STEP1/STEP2/UPDATE，它会按需写入 encoder 作为回复。
 * STEP2/UPDATE 是写操作：viewer 角色在 apply 前拦截（CRDT 不可撤销）。
 */
function handleYjsBinaryMessage(ws: WebSocketWithUserData, room: CanvasRoom, data: Uint8Array) {
  const doc = getCanvasDoc(room.id)
  if (!doc) return
  if (data.length === 0) return

  const decoder = decoding.createDecoder(data)
  const messageType = decoding.readVarUint(decoder)
  // Bytes after the messageType varUint — reused for both the permission peek
  // and the actual syncProtocol call (each gets a fresh decoder view over them).
  const remaining = decoding.readTailAsUint8Array(decoder)

  if (messageType === 0) {
    // SYNC：readSyncMessage 把读+apply 耦合，一旦调用无法回滚（CRDT 不可撤销），
    // 所以必须先 peek subType 判断角色，对 viewer 的写操作在 apply 前拦截。
    const peekDecoder = decoding.createDecoder(remaining)
    const subType = decoding.readVarUint(peekDecoder)

    // viewer 权限拦截：STEP2(1)/UPDATE(2) 是写操作，STEP1(0) 是读操作（请求状态）。
    if (ws.userRole === 'viewer' && subType !== syncProtocol.messageYjsSyncStep1) {
      log('Viewer SYNC write blocked before apply', {
        userId: ws.userId,
        canvasId: ws.canvasId,
        subType,
      })
      return
    }

    // 权限通过，用全新 decoder 从 subType 开始交给 syncProtocol 处理。
    const syncDecoder = decoding.createDecoder(remaining)
    const encoder = encoding.createEncoder()
    // 必须先写外层 SYNC 信封（messageType 0），客户端 handleBinary 依赖它区分
    // SYNC(0)/AWARENESS(1)。readSyncMessage 只写 sub-protocol 内容（subType +
    // payload），不包含外层信封。漏写会导致 STEP2 回复被客户端误判为 AWARENESS，
    // applyAwarenessUpdate 解析二进制 Yjs update 为 JSON 时抛出 SyntaxError，
    // isSynced 永远不为 true，后续本地编辑全部堆积在 pendingUpdates 无法发送。
    encoding.writeVarUint(encoder, 0) // SYNC envelope
    syncProtocol.readSyncMessage(syncDecoder, encoder, doc, ws as unknown)

    // 若 encoder 有回复内容（STEP1 的回复是 STEP2），发回客户端。
    // encoder 至少包含 1 byte 的 SYNC 信封，所以 reply > 1 表示有 sub-protocol 内容。
    const reply = encoding.length(encoder)
    if (reply > 1) {
      sendRaw(ws, encoding.toUint8Array(encoder))
    }
  } else if (messageType === 1) {
    // AWARENESS：二进制 update。记录该连接对应的 awareness clientID，
    // 断连时用于清理（removeAwarenessStates）。
    // 注意：上面已经用 readTailAsUint8Array(decoder) 把 payload 读到 remaining，
    // 所以 awareness update 必须从 remaining 读取，不能再用已耗尽的 decoder。
    try {
      const awarenessDecoder = decoding.createDecoder(remaining)
      const update = decoding.readVarUint8Array(awarenessDecoder)
      // awareness update 格式：[length, [clientID, clock, state], ...]
      // 累积所有涉及的 clientID，断连时一次性清理，避免多 clientID 场景下残留状态。
      const newClientIds = extractAllAwarenessClientIds(update)
      const existing = new Set(ws.awarenessClientIds ?? [])
      for (const id of newClientIds) {
        existing.add(id)
      }
      ws.awarenessClientIds = Array.from(existing)
      awarenessProtocol.applyAwarenessUpdate(room.awareness, update, ws)
      // 转发给房间内其他客户端。
      const wrapped = encoding.createEncoder()
      encoding.writeVarUint(wrapped, 1)
      encoding.writeVarUint8Array(wrapped, update)
      broadcastYjsBinary(room, encoding.toUint8Array(wrapped), ws)
    } catch (error) {
      logError('Failed to apply awareness update', {
        canvasId: room.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

/**
 * Extract all awareness clientIDs from a y-protocols awareness update.
 * Format: [varUint numStates, varUint clientID, varUint clock, varUint stateLength, ...stateBytes]*
 * Returns an empty array if parsing fails.
 */
function extractAllAwarenessClientIds(update: Uint8Array): number[] {
  try {
    const dec = decoding.createDecoder(update)
    const numStates = decoding.readVarUint(dec)
    const clientIds: number[] = []
    for (let i = 0; i < numStates; i++) {
      clientIds.push(decoding.readVarUint(dec))
      // Skip clock and state bytes to reach the next state entry.
      decoding.readVarUint(dec) // clock
      const stateLength = decoding.readVarUint(dec)
      if (stateLength > 0) {
        decoding.readUint8Array(dec, stateLength)
      }
    }
    return clientIds
  } catch {
    return []
  }
}

/**
 * 把 doc 'update' 事件产生的 update 广播给房间内除来源外的所有客户端。
 * update 用标准信封包裹：[varUint 0(SYNC), varUint 2(UPDATE), update bytes]。
 */
function broadcastYjsUpdate(room: CanvasRoom, update: Uint8Array, excludeClient: WebSocketWithUserData | null) {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0) // SYNC
  syncProtocol.writeUpdate(encoder, update)
  const wrapped = encoding.toUint8Array(encoder)
  broadcastYjsBinary(room, wrapped, excludeClient)
}

/** Broadcast a raw Yjs binary frame to every client except the sender. */
function broadcastYjsBinary(room: CanvasRoom, data: Uint8Array, excludeClient: WebSocketWithUserData | null) {
  for (const client of room.clients) {
    if (client !== excludeClient && client.readyState === 1) {
      sendRaw(client, data)
    }
  }
}

function sendRaw(ws: WebSocketWithUserData, data: Uint8Array) {
  if (ws.readyState !== 1) return
  try {
    // Convert Uint8Array to Buffer explicitly — ws.send(Uint8Array) can silently
    // send 0 bytes in some Node.js/ws versions because the internal getBuffer()
    // may not handle Uint8Array views correctly when the underlying ArrayBuffer
    // is larger than the view (lib0's encoder reuses a growable buffer).
    // Buffer.from(Uint8Array) copies the viewed bytes into a new Buffer, avoiding
    // shared-memory hazards if the encoder later reuses its growable buffer.
    const buf = Buffer.from(data)
    ws.send(buf, { binary: true })
  } catch (error) {
    logError('Failed to send Yjs binary frame', {
      userId: ws.userId,
      canvasId: ws.canvasId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function handleCursor(ws: WebSocketWithUserData, room: CanvasRoom, message: CursorMessage) {
  broadcastToRoom(room, message, ws)
}

function handleClientDisconnect(ws: WebSocketWithUserData, room: CanvasRoom, shouldTerminate = false) {
  if (!room) return

  const wasInRoom = room.clients.delete(ws)
  if (!wasInRoom) return

  // Note: broadcast handler is now room-level (ensureRoomBroadcastHandler),
  // so there's no per-ws update handler to detach here.

  // 从共享 awareness 中移除该客户端，其他客户端将不再渲染它的光标
  try {
    const clientIds = ws.awarenessClientIds ?? []
    if (clientIds.length > 0) {
      awarenessProtocol.removeAwarenessStates(
        room.awareness,
        clientIds,
        ws as unknown,
      )
      // Broadcast the awareness removal so other clients immediately drop the
      // disconnected user's cursor, instead of waiting for the 30s timeout.
      const removedUpdate = awarenessProtocol.encodeAwarenessUpdate(
        room.awareness,
        clientIds,
      )
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, 1) // AWARENESS
      encoding.writeVarUint8Array(encoder, removedUpdate)
      broadcastYjsBinary(room, encoding.toUint8Array(encoder), null)
    }
  } catch {
    // Best-effort cleanup.
  }

  if (ws.userId) {
    const prevCount = room.userConnectionCounts.get(ws.userId) ?? 0
    const currentCount = prevCount - 1
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
    teardownEmptyRoom(room.id, room)
  }

  if (shouldTerminate && ws.readyState === 1) {
    ws.terminate()
  }
}


function broadcastToRoom(room: CanvasRoom, message: unknown, excludeClient: WebSocketWithUserData | null) {
  const messageStr = JSON.stringify(message)

  for (const client of room.clients) {
    if (client !== excludeClient && client.readyState === 1) {
      // Per-client try/catch: a single broken socket must not prevent the
      // broadcast from reaching the rest of the room (user-join/leave, kicked).
      try {
        client.send(messageStr)
      } catch (error) {
        logError('Failed to broadcast to a client (others still notified)', {
          userId: client.userId,
          canvasId: client.canvasId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
}
