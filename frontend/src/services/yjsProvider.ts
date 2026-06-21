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
}

const APP_HEARTBEAT_INTERVAL_MS = 25000
const MAX_RECONNECT_ATTEMPTS = 10
const MAX_RECONNECT_DELAY_MS = 30000
const RECONNECT_BASE_DELAY_MS = 2000

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

  /** Whether the initial sync handshake completed (STEP2 received & applied). */
  getIsSynced(): boolean {
    return this.isSynced
  }

  /** Current user role; can change at runtime via setRole(). */
  getRole(): 'owner' | 'editor' | 'viewer' {
    return this.options.role
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

    ws.onclose = () => {
      this.statusListeners.forEach((fn) => fn(false))
      this.stopHeartbeat()
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
          this.userChangeListeners.forEach((fn) => fn(this.activeUsers))
        }
        break
      case 'user-join':
        if (message.user) {
          const user = message.user as CanvasActiveUser
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
        this.flushPendingUpdates()
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
          this.flushAwareness()
          // If another update arrived while we were throttled, the deferred
          // flush may have sent stale state (e.g. null followed by non-null).
          // Flush once more to ensure peers see the latest cursor/selection.
          if (this.awarenessPendingFlush) {
            this.awarenessPendingFlush = false
            this.lastAwarenessSend = Date.now()
            this.flushAwareness()
          }
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

  /** Replay all buffered pending updates that accumulated while disconnected.
   *  Called after the STEP1/STEP2 sync handshake completes on reconnect.
   *  The Yjs doc already merged the server state via readSyncMessage, so
   *  broadcasting these updates merges the local offline edits on top.
   *
   *  Viewers must not flush offline mutations: if the local role was downgraded
   *  to viewer while disconnected, replaying queued editor updates would violate
   *  the read-only contract and be rejected by the server anyway.
   *
   *  All pending updates are merged into a single UPDATE message before sending.
   *  This avoids flooding the server SYNC rate limiter with many small messages
   *  after a long offline period. Y.mergeUpdates is lossless: the merged update
   *  is semantically equivalent to applying each queued update in order. */
  private flushPendingUpdates() {
    if (this.pendingUpdates.length === 0) return
    if (this.options.role === 'viewer') {
      this.pendingUpdates = []
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
