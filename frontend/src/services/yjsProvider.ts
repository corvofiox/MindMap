/**
 * Self-hosted Yjs WebSocket provider (client side).
 *
 * Speaks the same wire protocol as backend/src/websocket/index.ts:
 *   - Binary frames: standard y-websocket envelope [varUint messageType, payload]
 *       messageType 0 = SYNC (sub-types STEP1/STEP2/UPDATE via syncProtocol)
 *       messageType 1 = AWARENESS (binary awareness update)
 *   - Text frames: business JSON (cursor, ping/pong, kicked, user-join/leave, room-state, user-role-changed)
 *
 * Responsibilities:
 *   - Maintain a Y.Doc and an Awareness instance.
 *   - Run the sync handshake (send STEP1 on connect, apply STEP2 reply).
 *   - Forward local doc updates to the server as UPDATE messages.
 *   - Forward local awareness updates to the server.
 *   - Reconnect with exponential backoff + jitter.
 *   - Surface business events (kicked, user list, role change) to subscribers.
 *   - Application-layer heartbeat (browser can't answer ws.ping natively).
 */
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import { getExistingRoot } from './yjs-schema'
import { logger } from '@/utils/logger'

/**
 * Origin tag applied by readSyncMessage when applying remote sync frames to
 * the local Y.Doc. Using a Symbol instead of the provider instance (this)
 * avoids accidentally skipping updates that originate from other code paths
 * that happen to pass the provider as origin.
 */
export const REMOTE_ORIGIN = Symbol('yjs-provider-remote')

export type CanvasActiveUser = {
  userId: number
  email: string
  nickname: string | null
  avatar: string | null
  role: 'owner' | 'editor' | 'viewer'
  joinedAt: number
}

export type KickedReason = 'removed' | string

interface MindMapProviderOptions {
  /** WebSocket URL root (e.g. ws://host:3001 or wss://host/ws). */
  urlRoot: string
  /** JWT auth token. Used as fallback if tokenGetter is not provided. */
  token: string
  /** Called on each reconnect to read the latest token. Prevents auth
   *  failures on long sessions where the token may have been refreshed
   *  by the API client after the provider was constructed. */
  tokenGetter?: () => string | null
  /** Optional: tab-level session id for logging/debugging only. */
  sessionId?: string
  /** Role of the local user; viewer blocks local doc mutations. */
  role: 'owner' | 'editor' | 'viewer'
  /** Local user id; used to detect whether room events involve other users. */
  userId?: number | null
}

const APP_HEARTBEAT_INTERVAL_MS = 25000
const MAX_RECONNECT_ATTEMPTS = 10
const MAX_RECONNECT_DELAY_MS = 30000
const RECONNECT_BASE_DELAY_MS = 2000

/**
 * R1 加固：跨 provider 生命周期的"协作证据"记录（canvasId → 是否曾见过其他协作者）。
 *
 * 前端在页面卸载/切换画布时用该证据决定是否发送 REST 全量快照：本会话见过其他
 * 用户或收到过远端编辑广播，说明 REST 快照可能过期（会覆盖他人编辑），必须跳过。
 * 证据需要跨 provider 存活，因为 React 卸载时 useCollaboration 的 cleanup 先于
 * CanvasPage 的 beforeunload/pagehide 兜底逻辑运行（provider 已被销毁）。
 *
 * 语义为"本次打开画布会话"级：新 provider 构造时清除旧证据（再次打开该画布视为
 * 新会话，单用户编辑应恢复 REST 快照兜底）。
 */
const collaborationEvidence = new Map<number, boolean>()

export function recordCollaborationEvidence(canvasId: number): void {
  collaborationEvidence.set(canvasId, true)
}

export function hasCollaborationEvidenceForCanvas(canvasId: number): boolean {
  return collaborationEvidence.get(canvasId) ?? false
}

/**
 * 清除指定画布的协作证据（"新会话"语义）。
 *
 * 由 CanvasPage 在进入画布的数据加载 effect 中调用：canvasId 变化或组件重新
 * 挂载 = 新的画布会话，上一会话的协作证据不再适用（恢复单用户 REST 快照兜底）。
 *
 * 注意：不要在 MindMapYjsProvider 构造时清除——同画布的 provider 重建
 * （如项目角色异步加载完成后 useCollaboration 的 effect 重跑）不是新会话，
 * 误清会让"断开后关闭标签页"场景失去客户端证据防线。
 */
export function clearCollaborationEvidence(canvasId: number): void {
  collaborationEvidence.delete(canvasId)
}

/**
 * 本地删除声明（canvasId → 各集合被本地用户删除的实体 ID）。
 *
 * 用途（R1 幽灵复活修复）：服务端 snapshotMissingDocEntities 无法区分
 * "客户端主动删除了实体 B"（合法，快照是更新版）与"B 是他人离线期间新增的"
 * （快照过期）——两者都表现为"doc 有 B、快照无 B"。若一律 upsertOnly，
 * 单用户离线删除会永久丢失（重载时 DB 优先于本地缓存，删除被"复活"）。
 *
 * 客户端在本地删除实体时记录其 ID，REST 快照一并发送；服务端比对时把声明
 * 删除的实体视为"客户端知情且主动删除"→ 允许全量合并执行删除。未声明的
 * 缺失实体仍视为过期快照 → upsertOnly 保护他人编辑。
 *
 * 记录点：yjsBinding.applyDiff 的 remove 分支（仅本地 mutation 触发，已排除
 * 远端应用与 bulk 加载）。新会话（CanvasPage 数据加载 effect）时清除。
 */
export type DeletionCollection = 'nodes' | 'groups' | 'domains' | 'connections'

const localDeletions = new Map<number, { nodes: Set<string>; groups: Set<string>; domains: Set<string>; connections: Set<string> }>()

function deletionSets(canvasId: number): { nodes: Set<string>; groups: Set<string>; domains: Set<string>; connections: Set<string> } {
  let entry = localDeletions.get(canvasId)
  if (!entry) {
    entry = { nodes: new Set(), groups: new Set(), domains: new Set(), connections: new Set() }
    localDeletions.set(canvasId, entry)
  }
  return entry
}

export function recordLocalDeletion(canvasId: number, collection: DeletionCollection, id: string): void {
  deletionSets(canvasId)[collection].add(id)
}

/** 查询某实体是否已被本地声明删除（供重连同步时排除幽灵复活）。 */
export function isLocalDeletion(canvasId: number, collection: DeletionCollection, id: string): boolean {
  if (typeof canvasId !== 'number') return false
  const entry = localDeletions.get(canvasId)
  if (!entry) return false
  return entry[collection].has(id)
}

/** 移除单条删除声明（服务端已确认应用后调用，防止 localDeletions 只增不减）。 */
export function removeLocalDeletion(canvasId: number, collection: DeletionCollection, id: string): void {
  if (typeof canvasId !== 'number') return
  const entry = localDeletions.get(canvasId)
  if (!entry) return
  entry[collection].delete(id)
}

/** 序列化为 REST 快照附带的 deletedIds 载荷（数组形式）。 */
export function getLocalDeletions(canvasId: number): {
  nodes?: string[]
  groups?: string[]
  domains?: string[]
  connections?: string[]
} {
  const entry = localDeletions.get(canvasId)
  if (!entry) return {}
  const out: { nodes?: string[]; groups?: string[]; domains?: string[]; connections?: string[] } = {}
  if (entry.nodes.size > 0) out.nodes = Array.from(entry.nodes)
  if (entry.groups.size > 0) out.groups = Array.from(entry.groups)
  if (entry.domains.size > 0) out.domains = Array.from(entry.domains)
  if (entry.connections.size > 0) out.connections = Array.from(entry.connections)
  return out
}

export function clearLocalDeletions(canvasId: number): void {
  localDeletions.delete(canvasId)
}

/**
 * Derive the WebSocket URL root from the current page location.
 * Dev: Vite proxies /ws → ws://localhost:3001. Prod: same origin /ws path.
 * Returns e.g. "ws://localhost:5173/ws" or "wss://app.example.com/ws".
 */
export function defaultWsUrlRoot(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws`
}

export class MindMapYjsProvider {
  readonly doc: Y.Doc
  readonly awareness: awarenessProtocol.Awareness
  readonly canvasId: number
  readonly sessionId: string

  private ws: WebSocket | null = null
  private readonly options: MindMapProviderOptions
  private isIntentionallyClosed = false
  private reconnectAttempts = 0
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null
  private appHeartbeatTimer: ReturnType<typeof setInterval> | null = null
  private visibilityHandler: (() => void) | null = null

  // Event subscribers
  private syncedListeners = new Set<() => void>()
  private kickedListeners = new Set<(reason: KickedReason) => void>()
  private userChangeListeners = new Set<(users: CanvasActiveUser[]) => void>()
  private roleChangeListeners = new Set<(userId: number, role: 'editor' | 'viewer') => void>()
  private statusListeners = new Set<(connected: boolean) => void>()

  private pendingUpdates: Uint8Array[] = []
  private static readonly MAX_PENDING_UPDATE_BYTES = 1_000_000 // ~1MB

  /**
   * R1: 本 provider 会话内是否收到过其他客户端的编辑广播（UPDATE 消息）。
   * 服务端只对非发送者 origin 的 doc update 广播 UPDATE，因此收到 UPDATE 即
   * 证明有其他客户端在编辑（STEP2 是服务端快照，不算）。
   */
  private receivedRemoteEdits = false
  /**
   * R1: 本 provider 会话内是否在房间事件中见过其他用户。
   */
  private sawPeerUser = false

  /**
   * Saves awareness state (cursor/selection/editingId) per canvasId during
   * disconnect, so it can be restored on reconnect. Prevents the 'invisible
   * cursor' gap where remote users don't see the reconnecting user's cursor
   * until they physically move their mouse.
   *
   * Uses sessionStorage (per-tab, per-origin) instead of a static Map to
   * avoid cross-tab contamination: when two tabs both disconnect for the
   * same canvas, each tab's state is stored in its own sessionStorage and
   * can't be accidentally read by the other tab.
   *
   * sessionStorage survives in-page navigation (canvas switching) but is
   * dropped when the tab is closed, matching the desired lifecycle.
   */
  private static readonly AWARENESS_KEY_PREFIX = 'mindmap_awareness_'

  private activeUsers: CanvasActiveUser[] = []
  private isSynced = false

  constructor(canvasId: number, options: MindMapProviderOptions) {
    this.canvasId = canvasId
    this.options = options
    // 注意：这里不清除协作证据。同画布的 provider 重建（如角色异步加载完成
    // 触发的 effect 重跑）不是新会话，清除会让"断开后关闭标签页"场景失去
    // 客户端证据防线。新会话语义由 clearCollaborationEvidence 承担
    // （CanvasPage 数据加载 effect 中调用）。
    this.sessionId =
      options.sessionId ||
      (typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`)
    this.doc = new Y.Doc()
    // Keep the client doc empty before the initial sync handshake. Creating
    // root Y.Maps here would give them this client's CRDT origin; the server
    // would then see that origin in the STEP1 state vector and skip sending
    // its own root maps, leaving the client with an empty parallel structure.
    this.awareness = new awarenessProtocol.Awareness(this.doc)
    this.wireLocalDocUpdates()
    this.wireLocalAwareness()
  }

  /** Begin the connection. Safe to call once. */
  connect(): void {
    this.isIntentionallyClosed = false
    // Prevent any deferred awareness flush from a previous connection window
    // from firing on this fresh connection.
    if (this.awarenessThrottleTimer) {
      clearTimeout(this.awarenessThrottleTimer)
      this.awarenessThrottleTimer = null
    }
    this.openSocket()
  }

  /** Tear down everything; suppress reconnect. */
  disconnect(): void {
    this.isIntentionallyClosed = true
    this.clearReconnect()
    this.stopHeartbeat()
    // Prevent any deferred awareness flush from firing after disconnect.
    if (this.awarenessThrottleTimer) {
      clearTimeout(this.awarenessThrottleTimer)
      this.awarenessThrottleTimer = null
    }
    // Save the local awareness state (cursor/selection/editingId) before
    // destroying the Y.Doc, so it can be restored after reconnect sync and
    // re-broadcast to peers immediately — prevents the 'invisible cursor' gap
    // where remote users don't see the reconnecting user's cursor until they
    // move their mouse.
    // Uses sessionStorage (per-tab) to avoid cross-tab contamination that a
    // static Map would cause when two tabs both edit the same canvas.
    const state = this.awareness.getLocalState()
    if (state) {
      try {
        sessionStorage.setItem(
          `${MindMapYjsProvider.AWARENESS_KEY_PREFIX}${this.canvasId}`,
          JSON.stringify(state),
        )
      } catch {
        // sessionStorage may throw (private browsing, storage full)
      }
    }
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler)
      this.visibilityHandler = null
    }
    // Broadcast null awareness so peers drop our cursor immediately.
    try {
      awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], this)
    } catch {
      // best-effort
    }
    if (this.ws) {
      try {
        this.ws.onclose = null
        this.ws.close()
      } catch {
        // ignore
      }
      this.ws = null
    }
    this.awareness.destroy()
    this.doc.destroy()
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  getActiveUsers(): CanvasActiveUser[] {
    return this.activeUsers
  }

  /**
   * 订阅 awareness 状态变化（远端 cursor/selection/user 字段，本地写入也会触发）。
   *
   * 回调收到 clientID → 状态的完整快照（y-protocols Awareness.getStates()），
   * clientID 是连接级随机数而非业务 userId；调用方需把含 user.id 的条目
   * 映射为业务键并过滤本地用户。返回取消订阅函数。
   */
  onAwarenessChange(fn: (states: Map<number, Record<string, unknown>>) => void): () => void {
    const handler = () => {
      fn(this.awareness.getStates())
    }
    this.awareness.on('change', handler)
    return () => {
      this.awareness.off('change', handler)
    }
  }

  /** 当前 awareness 快照（clientID → 状态，与 AwarenessState 同构）。 */
  getAwarenessStates(): Map<number, Record<string, unknown>> {
    return this.awareness.getStates()
  }

  /** Whether the initial sync handshake completed (STEP2 received & applied). */
  getIsSynced(): boolean {
    return this.isSynced
  }

  /** Current user role; can change at runtime via setRole(). */
  getRole(): 'owner' | 'editor' | 'viewer' {
    return this.options.role
  }

  private markSawPeer(): void {
    if (this.sawPeerUser) return
    this.sawPeerUser = true
    recordCollaborationEvidence(this.canvasId)
  }

  /**
   * R1: 本会话是否存在"与其他协作者共处/共编辑"的证据。
   * 综合实时标志与模块级记录（跨 provider 销毁存活）。
   * 用于决定页面卸载/切换画布时是否发送 REST 全量快照：
   * 有证据说明快照可能过期，发送会覆盖他人编辑，必须跳过。
   */
  hasCollaborationEvidence(): boolean {
    return this.receivedRemoteEdits || this.sawPeerUser || hasCollaborationEvidenceForCanvas(this.canvasId)
  }

  // ---- Event subscription API ----

  onSynced(fn: () => void): () => void {
    this.syncedListeners.add(fn)
    return () => this.syncedListeners.delete(fn)
  }

  onKicked(fn: (reason: KickedReason) => void): () => void {
    this.kickedListeners.add(fn)
    return () => this.kickedListeners.delete(fn)
  }

  onUserChange(fn: (users: CanvasActiveUser[]) => void): () => void {
    this.userChangeListeners.add(fn)
    return () => this.userChangeListeners.delete(fn)
  }

  onRoleChange(fn: (userId: number, role: 'editor' | 'viewer') => void): () => void {
    this.roleChangeListeners.add(fn)
    return () => this.roleChangeListeners.delete(fn)
  }

  onStatusChange(fn: (connected: boolean) => void): () => void {
    this.statusListeners.add(fn)
    return () => this.statusListeners.delete(fn)
  }

  // ---- Connection plumbing ----

  private openSocket() {
    const token = this.options.tokenGetter ? this.options.tokenGetter() : this.options.token
    if (!token) {
      this.scheduleReconnect()
      return
    }
    const url = `${this.options.urlRoot}?canvasId=${this.canvasId}&token=${encodeURIComponent(
      token,
    )}`
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'
    } catch (err) {
      logger.warn('[yjs-provider] WebSocket construction failed', err)
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.reconnectAttempts = 0
      // Reset isSynced so that the onSynced callback fires again after the
      // reconnection handshake completes. Without this, a reconnect after a
      // transient dropout would leave isSynced === true and skip the callback,
      // so subscribers would never learn that the doc was re-synchronized —
      // potentially missing remote changes that arrived while we were
      // disconnected.
      this.isSynced = false
      this.startHeartbeat()
      this.statusListeners.forEach((fn) => fn(true))
      // Kick off sync: send STEP1 with our current state vector.
      this.sendSyncStep1()
    }

    ws.onmessage = (event) => this.handleMessage(event)

    ws.onclose = (event) => {
      this.statusListeners.forEach((fn) => fn(false))
      this.stopHeartbeat()
      // Close code 1008 (Policy Violation) is a deterministic server rejection
      // (e.g. "Not a collaborative project") — retrying can never succeed, so
      // stop reconnect scheduling entirely instead of burning ~17 min of
      // exponential backoff. Mirrors the kicked-message handling above.
      if (event.code === 1008) {
        this.isIntentionallyClosed = true
        this.clearReconnect()
        return
      }
      if (!this.isIntentionallyClosed) {
        this.scheduleReconnect()
      }
    }

    ws.onerror = () => {
      // onclose will follow; nothing else to do here.
    }
  }

  private handleMessage(event: MessageEvent) {
    const data = event.data
    if (data instanceof ArrayBuffer) {
      this.handleBinary(new Uint8Array(data))
      return
    }
    // Text frame: business JSON
    if (typeof data !== 'string') return
    let message: { type?: string; [k: string]: unknown }
    try {
      message = JSON.parse(data)
    } catch {
      return
    }
    switch (message.type) {
      case 'room-state':
        if (Array.isArray(message.users)) {
          this.activeUsers = message.users as CanvasActiveUser[]
          // R1: room-state 是服务端按 userId 去重的在线用户列表（不含自己），
          // 非空即存在其他用户。
          if (this.activeUsers.some((u) => u.userId !== this.options.userId)) {
            this.markSawPeer()
          }
          this.userChangeListeners.forEach((fn) => fn(this.activeUsers))
        }
        break
      case 'user-join':
        if (message.user) {
          const user = message.user as CanvasActiveUser
          // user-join 广播会给房间内所有连接，包括同一用户的其他标签页，
          // 因此需要排除本地用户自己。
          if (user.userId !== this.options.userId) {
            this.markSawPeer()
          }
          if (!this.activeUsers.some((u) => u.userId === user.userId)) {
            this.activeUsers = [...this.activeUsers, user]
            this.userChangeListeners.forEach((fn) => fn(this.activeUsers))
          }
        }
        break
      case 'user-leave': {
        const user = message.user as CanvasActiveUser | undefined
        if (user) {
          this.activeUsers = this.activeUsers.filter((u) => u.userId !== user.userId)
          this.userChangeListeners.forEach((fn) => fn(this.activeUsers))
        }
        break
      }
      case 'user-role-changed': {
        const userId = message.userId as number | undefined
        const role = message.role as 'editor' | 'viewer' | undefined
        if (typeof userId === 'number' && (role === 'editor' || role === 'viewer')) {
          this.activeUsers = this.activeUsers.map((u) =>
            u.userId === userId ? { ...u, role } : u,
          )
          this.userChangeListeners.forEach((fn) => fn(this.activeUsers))
          this.roleChangeListeners.forEach((fn) => fn(userId, role))
        }
        break
      }
      case 'kicked':
        this.isIntentionallyClosed = true
        this.stopHeartbeat()
        this.clearReconnect()
        // Broadcast null awareness so peers drop our cursor immediately,
        // then close the socket so isConnected() returns false and the host
        // page stops treating us as online (which would skip REST saves).
        try {
          awarenessProtocol.removeAwarenessStates(
            this.awareness,
            [this.doc.clientID],
            this,
          )
        } catch {
          // best-effort
        }
        try {
          this.ws?.close()
        } catch {
          // ignore
        }
        this.kickedListeners.forEach((fn) => fn((message.reason as string) || 'removed'))
        break
      case 'pong':
        // Application-layer heartbeat reply; no state to update.
        break
      default:
        break
    }
  }

  private handleBinary(data: Uint8Array) {
    if (data.length === 0) return
    const decoder = decoding.createDecoder(data)
    const messageType = decoding.readVarUint(decoder)

    if (messageType === 0) {
      // SYNC: STEP2 (server reply) or UPDATE (broadcast) or STEP1 (server
      // asking for our state). Only STEP2 marks the initial sync handshake
      // as complete. Treating a peer UPDATE that arrives before STEP2 as
      // "synced" would reconnect observers on the empty doc's Y.Maps; when
      // STEP2 later replaces those top-level maps, the store would stop
      // receiving remote changes.
      let subType: number
      try {
        subType = decoding.peekVarUint(decoder)
      } catch (err) {
        logger.warn('[yjs-provider] malformed sync message header', err)
        return
      }
      // R1: 收到 UPDATE 广播 = 有其他客户端在编辑（服务端只对非发送者 origin
      // 的 doc update 广播 UPDATE）。这是"本画布存在其他协作者"的最直接证据。
      if (subType === syncProtocol.messageYjsUpdate) {
        this.receivedRemoteEdits = true
        recordCollaborationEvidence(this.canvasId)
      }
      const isStep2 = subType === syncProtocol.messageYjsSyncStep2
      const encoder = encoding.createEncoder()
      // Wrap the readSyncMessage reply in the outer SYNC envelope. The server
      // distinguishes SYNC(0) from AWARENESS(1) by the first varUint, so a
      // bare STEP2 reply would be mis-parsed as awareness and dropped.
      encoding.writeVarUint(encoder, 0)
      try {
        syncProtocol.readSyncMessage(decoder, encoder, this.doc, REMOTE_ORIGIN)
      } catch (err) {
        logger.warn('[yjs-provider] failed to apply sync message', err)
        // If a sync message fails to apply, do not set isSynced — the doc
        // may be in an inconsistent state and needs re-sync.
        return
      }
      const replyLen = encoding.length(encoder)
      if (replyLen > 1) {
        // Server may also request STEP1 from us; send the reply. The encoder
        // already includes the outer SYNC envelope, so replyLen > 1 means
        // there is actual sub-protocol content.
        this.sendRaw(encoding.toUint8Array(encoder))
      }
      if (!this.isSynced && isStep2) {
        this.isSynced = true
        // R4 #4（C18）：对账前先确认删除 update 已送达。若本次同步前存在离线
        // 缓冲（pendingUpdates 非空），flushPendingUpdates 刚把删除 update 发出，
        // 服务端尚未应用。此时本地 doc 中实体已不存在（本地删除 op 在 CRDT 合并
        // 中保留），立即 reconcile 会把声明误删 → 下次 REST 快照不再携带删除声明
        // → 服务端全量合并时实体幽灵复活。仅当无待发送缓冲（删除 update 均已
        // 送达）时才执行对账；离线场景的声明保留至下次干净重连再清理。
        const hadPendingUpdates = this.pendingUpdates.length > 0
        this.flushPendingUpdates()
        if (!hadPendingUpdates) {
          // C18: 对账本地删除声明（服务端已应用的删除从 localDeletions 移除）
          this.reconcileLocalDeletions()
        }
        this.sendLocalAwareness()
        this.syncedListeners.forEach((fn) => fn())
      }
    } else if (messageType === 1) {
      // AWARENESS
      try {
        const update = decoding.readVarUint8Array(decoder)
        awarenessProtocol.applyAwarenessUpdate(this.awareness, update, this)
      } catch (err) {
        logger.warn('[yjs-provider] failed to apply awareness update', err)
      }
    }
  }

  /**
   * C18: STEP2 同步完成后对账 localDeletions。
   *
   * STEP2 是服务端权威状态：若某个被本地声明删除的实体在 STEP2 后仍存在于
   * doc（服务端还持有它，说明删除更新尚未到达服务端），保留声明供后续
   * REST 快照携带；若实体已不存在于 doc（服务端已应用该删除），则删除声明
   * 已确认，从 localDeletions 移除，避免只增不减。
   */
  private reconcileLocalDeletions(): void {
    const root = getExistingRoot(this.doc)
    if (!root) return
    const entry = localDeletions.get(this.canvasId)
    if (!entry) return
    const collections: Array<[DeletionCollection, Set<string>, unknown]> = [
      ['nodes', entry.nodes, root.nodes],
      ['groups', entry.groups, root.groups],
      ['domains', entry.domains, root.domains],
      ['connections', entry.connections, root.connections],
    ]
    for (const [collection, set, ymap] of collections) {
      if (!ymap) continue
      for (const id of Array.from(set)) {
        if (!(ymap as Y.Map<unknown>).has(id)) {
          removeLocalDeletion(this.canvasId, collection, id)
        }
      }
    }
  }

  // ---- Outgoing Yjs messages ----

  private sendSyncStep1() {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, 0) // SYNC
    syncProtocol.writeSyncStep1(encoder, this.doc)
    this.sendRaw(encoding.toUint8Array(encoder))
  }

  private wireLocalDocUpdates() {
    // Always register the update listener, but check the role dynamically
    // inside the handler. This allows the listener to start forwarding updates
    // when the user's role is upgraded from viewer to editor at runtime
    // (without requiring a reconnect), while continuing to block viewer-origin
    // writes if the role is later downgraded.
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      // Defense-in-depth: viewers should never send document mutations.
      // The server enforces this server-side, but blocking at the source
      // prevents the local Y.Doc from silently diverging from server state.
      if (this.options.role === 'viewer') return
      // Forward every local-origin update to the server. Remote-origin updates
      // (applied via readSyncMessage) have origin === REMOTE_ORIGIN and should
      // NOT be re-broadcast (the server already has them).
      if (origin === REMOTE_ORIGIN) return
      if (!this.isConnected()) {
        // Buffer local updates so they can be replayed after reconnect.
        this.pendingUpdates.push(update)
        // Enforce max queue size — compact all pending updates into a single
        // efficient update when the byte limit is exceeded. Y.mergeUpdates()
        // is lossless: the combined update is semantically equivalent to
        // applying each update in order, but typically much smaller because
        // overlapping changes are collapsed. This avoids the permanent data
        // loss that would result from dropping entries.
        const totalBytes = this.pendingUpdates.reduce((sum, u) => sum + u.byteLength, 0)
        if (totalBytes > MindMapYjsProvider.MAX_PENDING_UPDATE_BYTES) {
          const merged = Y.mergeUpdates(this.pendingUpdates)
          logger.warn(
            `[yjs-provider] compacted ${this.pendingUpdates.length} pending updates ` +
              `(${totalBytes} bytes → ${merged.byteLength} bytes)`,
          )
          this.pendingUpdates = [merged]
        }
        return
      }
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, 0) // SYNC
      syncProtocol.writeUpdate(encoder, update)
      this.sendRaw(encoding.toUint8Array(encoder))
    })
  }

  private lastAwarenessSend = 0
  private awarenessThrottleTimer: ReturnType<typeof setTimeout> | null = null
  /** True when an awareness update arrived inside the throttle window and
   *  may not have been reflected by the scheduled flush. Checked after the
   *  deferred flush fires so the latest state is always sent. */
  private awarenessPendingFlush = false

  private wireLocalAwareness() {
    const MIN_MS = 30
    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === this) return
      if (!this.isConnected()) return

      const now = Date.now()
      const elapsed = now - this.lastAwarenessSend
      if (elapsed < MIN_MS) {
        // Defer to avoid flooding the server rate limiter (AWARE_RATE_LIMIT=200 msg/s)
        this.awarenessPendingFlush = true
        if (this.awarenessThrottleTimer) return // already scheduled
        this.awarenessThrottleTimer = setTimeout(() => {
          this.awarenessThrottleTimer = null
          this.lastAwarenessSend = Date.now()
          // C17: flushAwareness 编码的是调度时刻的最新 awareness 状态，
          // 窗口期内到达的更新已包含在内，无需二次 flush（此前会冗余双发）。
          this.awarenessPendingFlush = false
          this.flushAwareness()
        }, MIN_MS - elapsed)
        return
      }

      // An update arrived after the throttle window; send immediately and
      // cancel any pending deferred flush so the same state is not sent twice.
      if (this.awarenessThrottleTimer) {
        clearTimeout(this.awarenessThrottleTimer)
        this.awarenessThrottleTimer = null
      }
      this.awarenessPendingFlush = false
      this.lastAwarenessSend = now
      const changedClients = added.concat(updated, removed)
      const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients)
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, 1) // AWARENESS
      encoding.writeVarUint8Array(encoder, update)
      this.sendRaw(encoding.toUint8Array(encoder))
    })
  }

  private flushAwareness() {
    // Always send for the local client: if a state exists it is broadcast;
    // if null/undefined a removal update is generated so peers drop the
    // cursor immediately.
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, 1)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
    )
    this.sendRaw(encoding.toUint8Array(encoder))
  }

  /**
   * Replay all buffered pending updates that accumulated while disconnected.
   * Called after the STEP1/STEP2 sync handshake completes on reconnect, and
   * by the pagehide/beforeunload path (R1) to push offline edits out on the
   * live socket before the tab goes away.
   * The Yjs doc already merged the server state via readSyncMessage, so
   * broadcasting these updates merges the local offline edits on top.
   *
   * Viewers must not flush offline mutations: if the local role was downgraded
   * to viewer while disconnected, replaying queued editor updates would violate
   * the read-only contract and be rejected by the server anyway.
   *
   * All pending updates are merged into a single UPDATE message before sending.
   * This avoids flooding the server SYNC rate limiter with many small messages
   * after a long offline period. Y.mergeUpdates is lossless: the merged update
   * is semantically equivalent to applying each queued update in order.
   *
   * Safe to call when nothing is pending (no-op). When disconnected it is
   * also a no-op — the buffered updates are kept for the reconnect replay.
   */
  flushPendingUpdates(): void {
    if (this.pendingUpdates.length === 0) return
    if (!this.isConnected()) return
    if (this.options.role === 'viewer') {
      // C5: 不静默丢弃离线缓冲。降级为 viewer 时保留 pendingUpdates（本地
      // Y.Doc 仍包含这些编辑），待角色恢复 editor 后由下一次
      // flushPendingUpdates（STEP2 重连或页面卸载兜底）重新发送；同时告警，
      // 避免用户离线编辑在无提示的情况下丢失。
      logger.warn(
        `[yjs-provider] role downgraded to viewer with ${this.pendingUpdates.length} pending update(s); ` +
        'offline edits are retained locally and will be flushed once edit permission is restored',
      )
      return
    }
    const merged = Y.mergeUpdates(this.pendingUpdates)
    this.pendingUpdates = []
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, 0) // SYNC
    syncProtocol.writeUpdate(encoder, merged)
    this.sendRaw(encoding.toUint8Array(encoder))
  }

  /** Re-broadcast the local user's awareness state to all peers.
   *  Called after reconnection sync completes so other users see our
   *  cursor/selection state again without the user having to move it. */
  private sendLocalAwareness() {
    this.flushAwareness()
  }

  private sendRaw(data: Uint8Array) {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(data)
    } catch (err) {
      logger.warn('[yjs-provider] send failed', err)
    }
  }

  /** Public helper: update the local cursor / selection / editing state. */
  setLocalAwarenessField(field: string, value: unknown) {
    const allowedFields = ['cursor', 'selection', 'editingId', 'user']
    if (!allowedFields.includes(field)) {
      logger.warn('[yjs-provider] rejected unknown awareness field', { field })
      return
    }
    this.awareness.setLocalStateField(field, value)
  }

  /** Public helper: clear the local awareness state (e.g. on blur). */
  clearLocalAwareness() {
    this.awareness.setLocalState(null)
  }

  /**
   * Update the local user's role at runtime. Called when the server broadcasts
   * a user-role-changed event for the local user. The wireLocalDocUpdates
   * handler checks this.options.role dynamically, so viewer→editor and
   * editor→viewer transitions take effect without a reconnect.
   */
  setRole(role: 'owner' | 'editor' | 'viewer'): void {
    this.options.role = role
  }

  // ---- Reconnect ----

  private scheduleReconnect() {
    if (this.isIntentionallyClosed) return
    // After exhausting fast retries, continue at the max delay indefinitely
    // so a transient server outage doesn't permanently disconnect the tab.
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts = MAX_RECONNECT_ATTEMPTS
    } else {
      this.reconnectAttempts += 1
    }
    const base = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** (this.reconnectAttempts - 1),
      MAX_RECONNECT_DELAY_MS,
    )
    const jitter = 0.75 + Math.random() * 0.5 // 0.75..1.25
    const delay = Math.floor(base * jitter)
    this.clearReconnect()
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null
      this.openSocket()
    }, delay)
  }

  private clearReconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
  }

  // ---- Heartbeat ----

  private startHeartbeat() {
    this.stopHeartbeat()
    this.appHeartbeatTimer = setInterval(() => this.sendAppPing(), APP_HEARTBEAT_INTERVAL_MS)
    // Refresh on tab refocus: the OS may have paused timers during background.
    if (!this.visibilityHandler) {
      this.visibilityHandler = () => {
        if (document.visibilityState === 'visible') this.sendAppPing()
      }
      document.addEventListener('visibilitychange', this.visibilityHandler)
    }
  }

  private stopHeartbeat() {
    if (this.appHeartbeatTimer) {
      clearInterval(this.appHeartbeatTimer)
      this.appHeartbeatTimer = null
    }
  }

  private sendAppPing() {
    if (!this.isConnected()) return
    try {
      this.ws?.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }))
    } catch {
      // ignore
    }
  }
}
