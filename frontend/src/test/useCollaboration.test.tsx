/**
 * useCollaboration awareness 渲染节流测试(M-1 性能回归)
 *
 * 回归背景: sendCursor 每次 pointermove 调用 setLocalAwarenessField('cursor'),
 * y-protocols 对本地写入也同步 emit 'change' → buildAwarenessMap 无条件
 * setState(新 Map) → CanvasPage 每次鼠标移动全量重渲染(即使 solo 模式)。
 *
 * 修复: buildAwarenessMap 与旧 state 逐项比较(键集合 + 值引用),无实质变化
 * 时返回 prev 跳过 setState(React eager bailout → 0 次渲染)。
 *
 * 测试断言:
 *  1. 连续本地 cursor 写入(同内容)不触发任何额外重渲染;
 *  2. 远端 awareness 更新仍触发恰好 1 次重渲染(协作覆盖层需要),
 *     之后本地写入依旧 0 次渲染。
 *
 * 测试环境注意: React 18.3 在 jsdom/act 下,状态变更渲染提交后的首个同值
 * dispatch 会走 render 阶段而非 eager bailout(比生产环境多 1 次渲染的调度
 * 伪影;生产环境渲染提交后 fiber lanes 干净,eager bailout 恒生效)。测试用
 * 一次"预热"dispatch 吸收该伪影后再计数,保证断言确定且仍具判别力
 * (修复缺失时每次本地写入都 setState 新 Map,5 次写入 = 5 次渲染)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as awarenessProtocol from 'y-protocols/awareness'
import { useCollaboration, getActiveYjsProvider } from '@/hooks/useCollaboration'
import { useAuthStore } from '@/store/useAuthStore'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useProjectsStore } from '@/store/useProjectsStore'
import { apiClient } from '@/services/apiClient'
import type { User } from '@/types'

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

  send(data: ArrayBuffer | Uint8Array | string) {
    this.sent.push(data)
  }

  receiveBinary(data: Uint8Array) {
    if (this.onmessage) {
      this.onmessage(
        new MessageEvent('message', {
          data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        }),
      )
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

  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() {
    return true
  }
}

const ME: User = {
  id: 1,
  email: 'me@test.com',
  nickname: null,
  avatar: null,
  createdAt: '',
  updatedAt: '',
}

function sendRemoteAwareness(remote: awarenessProtocol.Awareness) {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 1) // AWARENESS envelope
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(remote, [remote.doc.clientID]),
  )
  MockWebSocket.last().receiveBinary(encoding.toUint8Array(encoder))
}

describe('useCollaboration awareness 渲染节流(M-1)', () => {
  let OriginalWebSocket: typeof WebSocket
  let renderCount = 0

  function Probe() {
    const { awarenessStates } = useCollaboration({ canvasId: 1, enabled: true })
    renderCount++
    return <div data-testid="awareness-size">{awarenessStates.size}</div>
  }

  beforeEach(() => {
    OriginalWebSocket = global.WebSocket
    global.WebSocket = MockWebSocket as unknown as typeof WebSocket
    MockWebSocket.reset()
    renderCount = 0
    useAuthStore.setState({ user: ME, isAuthenticated: true, isHydrated: true })
    apiClient.setToken('test-token')
    useProjectsStore.setState({ currentMemberRole: 'editor' })
    useCanvasStore.setState({ canvasId: 1 })
  })

  afterEach(() => {
    cleanup()
    global.WebSocket = OriginalWebSocket
    MockWebSocket.reset()
    apiClient.setToken(null)
    useAuthStore.setState({ user: null })
    useCanvasStore.setState({ canvasId: null })
    useProjectsStore.setState({ currentMemberRole: null })
  })

  it('本地 cursor awareness 更新不触发额外重渲染(同内容跳过 setState)', () => {
    const { getByTestId } = render(<Probe />)
    const provider = getActiveYjsProvider(1)
    expect(provider).not.toBeNull()
    // 不等 WS open:awareness 'change' 事件本地同步触发,与连接状态无关

    // 预热:吸收 jsdom/act 下"状态变更渲染提交后首个同值 dispatch 多渲染 1 次"的
    // 调度伪影(生产环境无此行为),此后同内容写入必须 0 次渲染
    act(() => {
      provider!.setLocalAwarenessField('cursor', { x: -1, y: -1 })
    })
    const baseline = renderCount

    // 模拟 pointermove 连续驱动 sendCursor 的本地写入(自身 clientID 被过滤,
    // 映射结果与旧 state 逐项一致 → 跳过 setState,渲染次数零增长)
    for (let i = 0; i < 5; i++) {
      act(() => {
        provider!.setLocalAwarenessField('cursor', { x: i * 10, y: i * 10 })
      })
    }
    expect(renderCount).toBe(baseline)
    // 自身条目被过滤:覆盖层无远端用户
    expect(getByTestId('awareness-size').textContent).toBe('0')
  })

  it('远端 awareness 更新触发恰好 1 次重渲染,之后本地更新依旧 0 次', () => {
    const { getByTestId } = render(<Probe />)
    const provider = getActiveYjsProvider(1)
    expect(provider).not.toBeNull()

    // 预热(同上)
    act(() => {
      provider!.setLocalAwarenessField('cursor', { x: -1, y: -1 })
    })
    const baseline = renderCount

    // 远端用户广播 user + cursor → 映射新增条目 → 必须恰好重渲染 1 次
    const remote = new awarenessProtocol.Awareness(new Y.Doc())
    remote.setLocalState({
      user: { id: 2, name: 'Alice', color: '#f97316', avatar: null },
      cursor: { x: 10, y: 20 },
    })
    act(() => {
      sendRemoteAwareness(remote)
    })
    expect(renderCount).toBe(baseline + 1)
    expect(getByTestId('awareness-size').textContent).toBe('1')

    // 远端条目就位后再次预热(吸收远端渲染提交后的同类伪影),再断言本地写入 0 次渲染
    act(() => {
      provider!.setLocalAwarenessField('cursor', { x: -2, y: -2 })
    })
    const afterRemote = renderCount
    for (let i = 0; i < 3; i++) {
      act(() => {
        provider!.setLocalAwarenessField('cursor', { x: i * 100, y: i * 100 })
      })
    }
    expect(renderCount).toBe(afterRemote)
  })
})
