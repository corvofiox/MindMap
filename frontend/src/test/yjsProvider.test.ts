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

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED
    if (this.onclose) {
      this.onclose(new CloseEvent('close') as CloseEvent)
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
