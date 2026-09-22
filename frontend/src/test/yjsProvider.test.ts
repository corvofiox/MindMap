/**
 * Unit tests for MindMapYjsProvider.
 *
 * Covers the critical SYNC message sub-type distinction:
 *   - Only STEP2 should mark the initial sync handshake complete.
 *   - Peer UPDATE messages must be applied but must NOT flip isSynced.
 *   - STEP1 requests must NOT flip isSynced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import {
  MindMapYjsProvider,
  clearCollaborationEvidence,
  clearLocalDeletions,
  getLocalDeletions,
  recordLocalDeletion,
} from '../services/yjsProvider'
import { ensureRoot } from '../services/yjs-schema'

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  url: string
  readyState = MockWebSocket.CONNECTING
  binaryType: BinaryType = 'arraybuffer'
  bufferedAmount = 0
  extensions = ''
  protocol = ''

  // Instance mirrors of the static ready-state constants so MockWebSocket
  // is structurally compatible with the DOM WebSocket interface.
  CONNECTING = MockWebSocket.CONNECTING
  OPEN = MockWebSocket.OPEN
  CLOSING = MockWebSocket.CLOSING
  CLOSED = MockWebSocket.CLOSED

  onopen: ((this: MockWebSocket, ev: Event) => void) | null = null
  onmessage: ((this: MockWebSocket, ev: MessageEvent) => void) | null = null
  onclose: ((this: MockWebSocket, ev: CloseEvent) => void) | null = null
  onerror: ((this: MockWebSocket, ev: Event) => void) | null = null

  sent: (ArrayBuffer | Uint8Array | string)[] = []

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
    // Open on the next tick so the caller has time to wire onopen/onmessage.
    setTimeout(() => this.simulateOpen(), 0)
  }

  static instances: MockWebSocket[] = []

  static reset() {
    MockWebSocket.instances = []
  }

  static last(): MockWebSocket {
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]
    if (!ws) throw new Error('No MockWebSocket instance created')
    return ws
  }

  private simulateOpen() {
    this.readyState = MockWebSocket.OPEN
    if (this.onopen) {
      this.onopen(new Event('open') as Event)
    }
  }

  send(data: ArrayBuffer | Uint8Array | string) { this.sent.push(data) }

  receiveBinary(data: Uint8Array) {
    if (this.onmessage) {
      this.onmessage(
        new MessageEvent('message', {
          data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        }),
      )
    }
  }

  receiveText(text: string) {
    if (this.onmessage) {
      this.onmessage(new MessageEvent('message', { data: text }))
    }
  }

  simulateClose(code = 0, reason = '') {
    this.readyState = MockWebSocket.CLOSED
    if (this.onclose) {
      this.onclose(new CloseEvent('close', { code, reason }) as CloseEvent)
    }
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
    this.simulateClose()
  }

  // EventTarget stubs so MockWebSocket is structurally compatible with
  // the DOM WebSocket interface.
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() {
    return true
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function createProvider(canvasId = 1, userId?: number | null): MindMapYjsProvider {
  return new MindMapYjsProvider(canvasId, {
    urlRoot: 'ws://localhost:3001/ws',
    token: 'test-token',
    role: 'editor',
    userId: userId ?? null,
  })
}

function buildStep2Message(sourceDoc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0) // SYNC envelope
  syncProtocol.writeSyncStep2(encoder, sourceDoc)
  return encoding.toUint8Array(encoder)
}

function buildUpdateMessage(sourceDoc: Y.Doc): Uint8Array {
  const update = Y.encodeStateAsUpdate(sourceDoc)
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0) // SYNC envelope
  syncProtocol.writeUpdate(encoder, update)
  return encoding.toUint8Array(encoder)
}

function buildStep1Message(sourceDoc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0) // SYNC envelope
  syncProtocol.writeSyncStep1(encoder, sourceDoc)
  return encoding.toUint8Array(encoder)
}

describe('MindMapYjsProvider', () => {
  let OriginalWebSocket: typeof WebSocket

  beforeEach(() => {
    OriginalWebSocket = global.WebSocket
    global.WebSocket = MockWebSocket as unknown as typeof WebSocket
    MockWebSocket.reset()
  })

  afterEach(() => {
    global.WebSocket = OriginalWebSocket
    MockWebSocket.reset()
  })

  it('does not mark synced when a peer UPDATE arrives before STEP2', async () => {
    const provider = createProvider()
    provider.connect()
    await tick()

    const remoteDoc = new Y.Doc()
    ensureRoot(remoteDoc)

    MockWebSocket.last().receiveBinary(buildUpdateMessage(remoteDoc))

    expect(provider.getIsSynced()).toBe(false)
    provider.disconnect()
  })

  it('marks synced and fires listener only when STEP2 arrives', async () => {
    const provider = createProvider()
    const syncedFn = vi.fn()
    provider.onSynced(syncedFn)
    provider.connect()
    await tick()

    const remoteDoc = new Y.Doc()
    ensureRoot(remoteDoc)

    MockWebSocket.last().receiveBinary(buildStep2Message(remoteDoc))

    expect(provider.getIsSynced()).toBe(true)
    expect(syncedFn).toHaveBeenCalledTimes(1)
    provider.disconnect()
  })

  it('does not mark synced on STEP1 request from server', async () => {
    const provider = createProvider()
    const syncedFn = vi.fn()
    provider.onSynced(syncedFn)
    provider.connect()
    await tick()

    const remoteDoc = new Y.Doc()
    ensureRoot(remoteDoc)

    const ws = MockWebSocket.last()
    ws.receiveBinary(buildStep1Message(remoteDoc))

    expect(provider.getIsSynced()).toBe(false)
    expect(syncedFn).not.toHaveBeenCalled()
    // Server asked for our state; provider should reply with STEP2.
    expect(ws.sent.length).toBeGreaterThan(0)
    const reply = ws.sent[ws.sent.length - 1]
    expect(typeof reply).not.toBe('string')
    const view = reply instanceof Uint8Array ? reply : new Uint8Array(reply as ArrayBuffer)
    const replyDecoder = decoding.createDecoder(view)
    expect(decoding.readVarUint(replyDecoder)).toBe(0) // SYNC envelope
    expect(decoding.readVarUint(replyDecoder)).toBe(syncProtocol.messageYjsSyncStep2)
    provider.disconnect()
  })

  it('does not refire synced listener on UPDATE after STEP2', async () => {
    const provider = createProvider()
    const syncedFn = vi.fn()
    provider.onSynced(syncedFn)
    provider.connect()
    await tick()

    const remoteDoc = new Y.Doc()
    ensureRoot(remoteDoc)

    const ws = MockWebSocket.last()
    ws.receiveBinary(buildStep2Message(remoteDoc))
    expect(provider.getIsSynced()).toBe(true)
    expect(syncedFn).toHaveBeenCalledTimes(1)

    syncedFn.mockClear()

    // A later UPDATE must not be mistaken for the initial handshake.
    ws.receiveBinary(buildUpdateMessage(remoteDoc))

    expect(provider.getIsSynced()).toBe(true)
    expect(syncedFn).not.toHaveBeenCalled()
    provider.disconnect()
  })

  it('resets isSynced on reconnect and completes handshake again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const provider = createProvider()
      const syncedFn = vi.fn()
      provider.onSynced(syncedFn)
      provider.connect()
      await vi.advanceTimersByTimeAsync(0)

      const remoteDoc = new Y.Doc()
      ensureRoot(remoteDoc)

      const ws = MockWebSocket.last()
      ws.receiveBinary(buildStep2Message(remoteDoc))
      expect(provider.getIsSynced()).toBe(true)
      expect(syncedFn).toHaveBeenCalledTimes(1)

      // Simulate disconnect and reconnect.
      ws.simulateClose()

      // The first reconnect delay is RECONNECT_BASE_DELAY_MS (2000 ms) with
      // 0.75..1.25 jitter, so advance well past the minimum.
      await vi.advanceTimersByTimeAsync(2500)

      const ws2 = MockWebSocket.last()
      expect(ws2).not.toBe(ws)
      expect(provider.getIsSynced()).toBe(false)

      ws2.receiveBinary(buildStep2Message(remoteDoc))
      expect(provider.getIsSynced()).toBe(true)
      expect(syncedFn).toHaveBeenCalledTimes(2)

      provider.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  // 回归：拖动节点时每个 mousemove 都会产生一次 doc 变更，逐帧直发会超过服务端
  // SYNC 限速（50 帧/秒）而被 close(1008)。合并窗口内只发一帧且语义无损。
  it('coalesces a burst of local edits into a single SYNC frame', async () => {
    const provider = createProvider()
    provider.connect()
    await tick()

    const ws = MockWebSocket.last()
    const before = ws.sent.length

    const nodes = provider.doc.getMap<Y.Map<unknown>>('nodes')
    nodes.set('n1', new Y.Map())
    nodes.set('n2', new Y.Map())
    nodes.set('n3', new Y.Map())

    // 合并窗口未到：不得逐帧直发
    expect(ws.sent.length).toBe(before)

    await new Promise((resolve) => setTimeout(resolve, 150))

    const frames = ws.sent.slice(before)
    expect(frames.length).toBe(1)

    // 合并帧语义等价：对端应用后包含全部三个变更
    const view = frames[0] as Uint8Array
    const decoder = decoding.createDecoder(view)
    expect(decoding.readVarUint(decoder)).toBe(0) // SYNC envelope
    expect(decoding.readVarUint(decoder)).toBe(syncProtocol.messageYjsUpdate)
    const peerDoc = new Y.Doc()
    Y.applyUpdate(peerDoc, decoding.readVarUint8Array(decoder))
    expect(Array.from(peerDoc.getMap('nodes').keys()).sort()).toEqual(['n1', 'n2', 'n3'])

    provider.disconnect()
  })

  // 回归：限速是瞬时故障，服务端先发 error 帧再 close(1008)，客户端必须重连，
  // 否则协作会静默永久断开（此前 1008 一律视为永久拒绝）。
  it('reconnects after a server rate-limit 1008 close', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const provider = createProvider()
      provider.connect()
      await vi.advanceTimersByTimeAsync(0)

      const ws = MockWebSocket.last()
      ws.receiveText(JSON.stringify({ type: 'error', message: 'rate limited' }))
      const instancesAfterClose = MockWebSocket.instances.length
      ws.simulateClose(1008)

      // 退避 2000ms（含 0.75..1.25 抖动）后必须新建连接
      await vi.advanceTimersByTimeAsync(2600)
      expect(MockWebSocket.instances.length).toBeGreaterThan(instancesAfterClose)

      provider.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  // 其他 1008（鉴权/权限拒绝）是永久性的，不能重连空转。
  it('does not reconnect on a non-rate-limit 1008 close', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const provider = createProvider()
      provider.connect()
      await vi.advanceTimersByTimeAsync(0)

      const ws = MockWebSocket.last()
      const instancesAfterClose = MockWebSocket.instances.length
      ws.simulateClose(1008)

      await vi.advanceTimersByTimeAsync(30000)
      expect(MockWebSocket.instances.length).toBe(instancesAfterClose)

      provider.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  // 限速判定的主依据是结构化 code，不依赖后端文案（文案改了也不能静默失效）。
  it('reconnects on the structured rate-limit code even if the text changed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const provider = createProvider()
      provider.connect()
      await vi.advanceTimersByTimeAsync(0)

      const ws = MockWebSocket.last()
      ws.receiveText(
        JSON.stringify({ type: 'error', code: 'rate_limited', message: '请求过于频繁' }),
      )
      const instancesAfterClose = MockWebSocket.instances.length
      ws.simulateClose(1008, 'rate limited')

      await vi.advanceTimersByTimeAsync(2600)
      expect(MockWebSocket.instances.length).toBeGreaterThan(instancesAfterClose)

      provider.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  // error 帧若在网络层丢失，close reason 是独立的兜底信号，不能退化成永久断连。
  it('reconnects from the close reason alone when the error frame never arrived', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const provider = createProvider()
      provider.connect()
      await vi.advanceTimersByTimeAsync(0)

      const ws = MockWebSocket.last()
      const instancesAfterClose = MockWebSocket.instances.length
      ws.simulateClose(1008, 'rate limited')

      await vi.advanceTimersByTimeAsync(2600)
      expect(MockWebSocket.instances.length).toBeGreaterThan(instancesAfterClose)

      provider.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  // 连接频率限速（Too many connection attempts）也是瞬时的：重连即可自愈。
  // 它此前被归入"永久拒绝"，一旦触发就是无提示的永久掉线。
  it('reconnects when the server reports a connection throttle (structured code)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const provider = createProvider()
      provider.connect()
      await vi.advanceTimersByTimeAsync(0)

      const ws = MockWebSocket.last()
      ws.receiveText(
        JSON.stringify({
          type: 'error',
          code: 'connection_throttled',
          message: 'Too many connection attempts. Please try again later.',
        }),
      )
      const instancesAfterClose = MockWebSocket.instances.length
      ws.simulateClose(1008, 'Too many connection attempts. Please try again later.')

      await vi.advanceTimersByTimeAsync(2600)
      expect(MockWebSocket.instances.length).toBeGreaterThan(instancesAfterClose)

      provider.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  // 鉴权类 1008（token 过期/未就绪）同样必须重连：每次重连都会用 tokenGetter
  // 取最新 token，否则刷新机制永远没机会生效。
  it('reconnects when the server reports a retryable auth failure', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const provider = createProvider()
      provider.connect()
      await vi.advanceTimersByTimeAsync(0)

      const ws = MockWebSocket.last()
      ws.receiveText(JSON.stringify({ type: 'error', code: 'auth_retryable', message: 'Invalid token' }))
      const instancesAfterClose = MockWebSocket.instances.length
      ws.simulateClose(1008, 'Invalid token')

      await vi.advanceTimersByTimeAsync(2600)
      expect(MockWebSocket.instances.length).toBeGreaterThan(instancesAfterClose)

      provider.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  // 没有 error 帧时，连接频率限速的 reason 也要能兜住建连（旧服务端）。
  it('reconnects from the connection-throttle close reason alone', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const provider = createProvider()
      provider.connect()
      await vi.advanceTimersByTimeAsync(0)

      const instancesAfterClose = MockWebSocket.instances.length
      MockWebSocket.last().simulateClose(1008, 'Too many connection attempts. Please try again later.')

      await vi.advanceTimersByTimeAsync(2600)
      expect(MockWebSocket.instances.length).toBeGreaterThan(instancesAfterClose)

      provider.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  // 真正永久的原因（画布不存在）必须**保持**不重连，别把退避烧在无望的重试上。
  it('stops reconnecting for a permanent 1008 (canvas not found)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const provider = createProvider()
      provider.connect()
      await vi.advanceTimersByTimeAsync(0)

      const instancesAfterClose = MockWebSocket.instances.length
      MockWebSocket.last().simulateClose(1008, 'Canvas not found')

      await vi.advanceTimersByTimeAsync(60000)
      expect(MockWebSocket.instances.length).toBe(instancesAfterClose)
      expect(provider.getConnectionState()).toBe('stopped')

      provider.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  // 半开连接：断网/休眠后 readyState 仍是 OPEN、onclose 不触发，客户端会一直
  // "以为自己在线"。心跳长期收不到 pong 时必须主动重连。
  it('forces a reconnect when the heartbeat goes unanswered (half-open)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const provider = createProvider()
      provider.connect()
      await vi.advanceTimersByTimeAsync(0)
      const instancesBefore = MockWebSocket.instances.length

      // 一次 pong 都不回：心跳每 25s 一次，75s 时 idle 已超 60s 阈值
      await vi.advanceTimersByTimeAsync(80000)

      expect(MockWebSocket.instances.length).toBeGreaterThan(instancesBefore)

      provider.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  // 反向保证：只要 pong 持续到达，就不能被判死（避免误杀健康连接）。
  it('keeps the connection alive while pongs keep arriving', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const provider = createProvider()
      provider.connect()
      await vi.advanceTimersByTimeAsync(0)
      const ws = MockWebSocket.last()
      const instancesBefore = MockWebSocket.instances.length

      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(20000)
        ws.receiveText(JSON.stringify({ type: 'pong' }))
      }

      expect(MockWebSocket.instances.length).toBe(instancesBefore)

      provider.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  // 状态三态供 UI 区分"正在重连"与"已停止"。
  it('exposes connection state as connected / reconnecting / stopped', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const provider = createProvider()
      expect(provider.getConnectionState()).toBe('reconnecting')

      provider.connect()
      await vi.advanceTimersByTimeAsync(0)
      expect(provider.getConnectionState()).toBe('connected')

      MockWebSocket.last().simulateClose(1006)
      expect(provider.getConnectionState()).toBe('reconnecting')

      provider.disconnect()
      expect(provider.getConnectionState()).toBe('stopped')
    } finally {
      vi.useRealTimers()
    }
  })

  // 固化原先"300 次连发"的端到端验证（原临时测试已删除，结论不能没有回归）。
  // 用虚拟时间驱动，结果确定且不拖慢测试套件。
  it('caps SYNC frames during a 300-edit burst and delivers every change', async () => {
    vi.useFakeTimers()
    try {
      const provider = createProvider()
      provider.connect()
      await vi.advanceTimersByTimeAsync(0) // 让 MockWebSocket 完成 open

      const ws = MockWebSocket.last()
      const before = ws.sent.length

      const nodes = provider.doc.getMap<Y.Map<unknown>>('nodes')
      // 每 3ms 一次变更，共 300 次 ≈ 虚拟时间 1 秒，模拟拖动节点
      for (let i = 0; i < 300; i++) {
        nodes.set(`n${i}`, new Y.Map())
        await vi.advanceTimersByTimeAsync(3)
      }
      await vi.advanceTimersByTimeAsync(120) // 等最后一个合并窗口落地

      const frames = ws.sent.slice(before)
      // 未合并时这里是 ~300 帧；合并后 1 秒内最多 ~20 帧（SYNC_COALESCE_MS = 50）
      expect(frames.length).toBeGreaterThan(0)
      expect(frames.length).toBeLessThanOrEqual(22)

      // 合并必须无损：对端应用完所有 SYNC 帧后必须拿到全部 300 个键
      const peerDoc = new Y.Doc()
      for (const frame of frames) {
        if (!(frame instanceof Uint8Array)) continue
        const decoder = decoding.createDecoder(frame)
        if (decoding.readVarUint(decoder) !== 0) continue // 只看 SYNC 帧
        if (decoding.readVarUint(decoder) !== syncProtocol.messageYjsUpdate) continue
        Y.applyUpdate(peerDoc, decoding.readVarUint8Array(decoder))
      }
      expect(peerDoc.getMap('nodes').size).toBe(300)

      provider.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('R1: collaboration evidence tracking', () => {
  let OriginalWebSocket: typeof WebSocket

  beforeEach(() => {
    OriginalWebSocket = global.WebSocket
    global.WebSocket = MockWebSocket as unknown as typeof WebSocket
    MockWebSocket.reset()
    // Evidence is session-scoped now (cleared explicitly, not on provider
    // construction), so tests must reset it to avoid cross-test pollution.
    clearCollaborationEvidence(1)
    clearCollaborationEvidence(7)
  })

  afterEach(() => {
    global.WebSocket = OriginalWebSocket
    MockWebSocket.reset()
  })

  it('marks evidence when a peer UPDATE broadcast arrives', async () => {
    const provider = createProvider()
    provider.connect()
    await tick()

    const remoteDoc = new Y.Doc()
    ensureRoot(remoteDoc)
    MockWebSocket.last().receiveBinary(buildUpdateMessage(remoteDoc))

    expect(provider.hasCollaborationEvidence()).toBe(true)
    provider.disconnect()
  })

  it('does not mark evidence on a plain STEP2 server snapshot', async () => {
    const provider = createProvider()
    provider.connect()
    await tick()

    const remoteDoc = new Y.Doc()
    ensureRoot(remoteDoc)
    MockWebSocket.last().receiveBinary(buildStep2Message(remoteDoc))

    expect(provider.hasCollaborationEvidence()).toBe(false)
    provider.disconnect()
  })

  it('marks evidence when room-state lists another user', async () => {
    const provider = createProvider(1, 1)
    provider.connect()
    await tick()

    MockWebSocket.last().receiveText(JSON.stringify({
      type: 'room-state',
      users: [{ userId: 2, email: 'peer@test.com', nickname: null, avatar: null, role: 'editor', joinedAt: 0 }],
    }))

    expect(provider.hasCollaborationEvidence()).toBe(true)
    provider.disconnect()
  })

  it('ignores user-join events from the local user (multi-tab)', async () => {
    const provider = createProvider(1, 1)
    provider.connect()
    await tick()

    MockWebSocket.last().receiveText(JSON.stringify({
      type: 'user-join',
      user: { userId: 1, email: 'me@test.com', nickname: null, avatar: null, role: 'editor', joinedAt: 0 },
    }))

    expect(provider.hasCollaborationEvidence()).toBe(false)
    provider.disconnect()
  })

  it('evidence survives provider destruction and is only reset by clearCollaborationEvidence', async () => {
    const provider = createProvider(7)
    provider.connect()
    await tick()

    const remoteDoc = new Y.Doc()
    ensureRoot(remoteDoc)
    MockWebSocket.last().receiveBinary(buildUpdateMessage(remoteDoc))
    expect(provider.hasCollaborationEvidence()).toBe(true)

    // Provider destroyed (e.g. canvas switch): module-level record persists.
    provider.disconnect()

    // Rebuilding the provider for the same canvas (e.g. project role loads
    // asynchronously and the useCollaboration effect re-runs) must NOT clear
    // the evidence — it is still the same editing session.
    const provider2 = createProvider(7)
    expect(provider2.hasCollaborationEvidence()).toBe(true)
    provider2.disconnect()

    // Entering the canvas as a NEW session explicitly clears the evidence.
    clearCollaborationEvidence(7)
    const provider3 = createProvider(7)
    expect(provider3.hasCollaborationEvidence()).toBe(false)
    provider3.disconnect()
  })

  it('flushPendingUpdates is a no-op while disconnected (keeps buffer for replay)', async () => {
    const provider = createProvider()
    provider.connect()
    await tick()

    // Simulate disconnect before any edit: buffer a local update while "offline".
    const ws = MockWebSocket.last()
    ws.simulateClose()

    const localDoc = new Y.Doc()
    ensureRoot(localDoc)
    localDoc.getMap('nodes').set('n1', new Y.Map())
    // Doc mutation is forwarded via the update listener into pendingUpdates.
    const captured = provider as unknown as { pendingUpdates: Uint8Array[] }
    const before = captured.pendingUpdates.length

    provider.flushPendingUpdates()

    // Not connected: must NOT drop the buffered update.
    expect(captured.pendingUpdates.length).toBe(before)
    provider.disconnect()
  })
})

describe('R1: local deletion declarations', () => {
  beforeEach(() => {
    clearLocalDeletions(1)
    clearLocalDeletions(7)
  })

  it('records, serializes and clears per-canvas deletion declarations', () => {
    recordLocalDeletion(7, 'nodes', 'n1')
    recordLocalDeletion(7, 'nodes', 'n2')
    recordLocalDeletion(7, 'connections', 'c1')

    const out = getLocalDeletions(7)
    expect(out.nodes).toEqual(['n1', 'n2'])
    expect(out.connections).toEqual(['c1'])
    // 空集合不出现在载荷中
    expect(out.groups).toBeUndefined()
    expect(out.domains).toBeUndefined()

    // 不同画布互不影响
    expect(getLocalDeletions(1)).toEqual({})

    clearLocalDeletions(7)
    expect(getLocalDeletions(7)).toEqual({})
  })

  it('is independent of collaboration evidence lifecycle', () => {
    recordLocalDeletion(1, 'groups', 'g1')
    clearCollaborationEvidence(1)
    // 证据清除不影响删除声明
    expect(getLocalDeletions(1)).toEqual({ groups: ['g1'] })
    clearLocalDeletions(1)
    expect(getLocalDeletions(1)).toEqual({})
  })
})

describe('Awareness: remote cursor/selection subscription', () => {
  let OriginalWebSocket: typeof WebSocket

  beforeEach(() => {
    OriginalWebSocket = global.WebSocket
    global.WebSocket = MockWebSocket as unknown as typeof WebSocket
    MockWebSocket.reset()
  })

  afterEach(() => {
    global.WebSocket = OriginalWebSocket
    MockWebSocket.reset()
  })

  function sendRemoteAwareness(remote: awarenessProtocol.Awareness) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, 1) // AWARENESS envelope
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(remote, [remote.doc.clientID]),
    )
    MockWebSocket.last().receiveBinary(encoding.toUint8Array(encoder))
  }

  it('fires onAwarenessChange and exposes remote awareness states', async () => {
    const provider = createProvider()
    const onChange = vi.fn()
    provider.onAwarenessChange(onChange)
    provider.connect()
    await tick()

    // 模拟远端用户广播 awareness（user + cursor + selection）
    const remote = new awarenessProtocol.Awareness(new Y.Doc())
    remote.setLocalState({
      user: { id: 2, name: 'Alice', color: '#f97316', avatar: null },
      cursor: { x: 10, y: 20 },
      selection: ['node-1'],
    })
    sendRemoteAwareness(remote)

    expect(onChange).toHaveBeenCalled()
    const states = provider.getAwarenessStates()
    const remoteEntry = Array.from(states.entries()).find(
      ([, s]) => (s as { user?: { id?: number } }).user?.id === 2,
    )
    expect(remoteEntry).toBeDefined()
    const [clientId, state] = remoteEntry as [number, Record<string, unknown>]
    expect(clientId).toBe(remote.doc.clientID)
    expect((state as { cursor?: { x: number; y: number } }).cursor).toEqual({ x: 10, y: 20 })
    expect((state as { selection?: string[] }).selection).toEqual(['node-1'])
    provider.disconnect()
  })

  it('stops delivering awareness changes after unsubscribe', async () => {
    const provider = createProvider()
    const onChange = vi.fn()
    provider.onAwarenessChange(onChange)()
    provider.connect()
    await tick()

    const remote = new awarenessProtocol.Awareness(new Y.Doc())
    remote.setLocalState({
      user: { id: 2, name: 'Alice', color: '#f97316', avatar: null },
      cursor: { x: 1, y: 2 },
    })
    sendRemoteAwareness(remote)

    expect(onChange).not.toHaveBeenCalled()
    provider.disconnect()
  })
})
