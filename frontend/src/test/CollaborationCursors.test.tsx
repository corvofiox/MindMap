/**
 * 协作覆盖层组件测试：awareness 状态 → 远端光标 / 远端选区 / 在线头像渲染。
 *
 * 覆盖验收点「awareness 状态变化后组件渲染远端光标」：
 *   - CollaborationCursors：远端光标（颜色 + 用户名标签）按 zoom/pan 变换、排除自身
 *   - RemoteSelection：远端选中节点的虚线框
 *   - UserAvatars：在线协作者头像列表
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import {
  CollaborationCursors,
  RemoteSelection,
  UserAvatars,
} from '@/components/canvas/CollaborationCursors'
import { useAuthStore } from '@/store/useAuthStore'
import { useUIStore } from '@/store/useUIStore'
import {
  MINIMAP_MAX_FRAME_HEIGHT_PX,
  MINIMAP_TOP_PX,
  OVERLAY_GAP_PX,
} from '@/utils/panelOffset'
import type { AwarenessState } from '@/types'

const selfUser = {
  id: 1,
  email: 'me@test.com',
  nickname: 'Me',
  avatar: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

const remoteState = (
  userId: number,
  name: string,
  color: string,
  extra: Partial<AwarenessState> = {},
): AwarenessState => ({
  user: { id: userId, name, color, avatar: null },
  ...extra,
})

beforeEach(() => {
  useAuthStore.setState({ user: selfUser })
  useUIStore.setState({ nodePoolOpen: true, aiSidebarOpen: false, minimapVisible: true })
})

afterEach(() => {
  cleanup()
  useAuthStore.setState({ user: null })
})

describe('CollaborationCursors', () => {
  it('renders remote cursor with user color and name label', () => {
    const cursors = new Map<number, AwarenessState>([
      [2, remoteState(2, 'Alice', '#f97316', { cursor: { x: 100, y: 200 } })],
    ])
    const { container } = render(
      <CollaborationCursors cursors={cursors} zoom={1} panX={0} panY={0} />,
    )
    const group = container.querySelector('[data-collab-cursor="2"]')
    expect(group).not.toBeNull()
    expect(group?.getAttribute('transform')).toBe('translate(100, 200)')
    // 用户名标签
    expect(screen.getByText('Alice')).not.toBeNull()
    // 光标颜色 = 用户颜色
    expect(group?.querySelector('path')?.getAttribute('fill')).toBe('#f97316')
  })

  it('transforms canvas coordinates by zoom and pan', () => {
    const cursors = new Map<number, AwarenessState>([
      [2, remoteState(2, 'Alice', '#f97316', { cursor: { x: 100, y: 200 } })],
    ])
    const { container } = render(
      <CollaborationCursors cursors={cursors} zoom={2} panX={50} panY={-30} />,
    )
    const group = container.querySelector('[data-collab-cursor="2"]')
    // screen = canvas * zoom + pan
    expect(group?.getAttribute('transform')).toBe('translate(250, 370)')
  })

  it('excludes the current user from remote cursors', () => {
    const cursors = new Map<number, AwarenessState>([
      [1, remoteState(1, 'Me', '#3b82f6', { cursor: { x: 0, y: 0 } })],
      [2, remoteState(2, 'Alice', '#f97316', { cursor: { x: 10, y: 10 } })],
    ])
    const { container } = render(
      <CollaborationCursors cursors={cursors} zoom={1} panX={0} panY={0} />,
    )
    expect(container.querySelector('[data-collab-cursor="1"]')).toBeNull()
    expect(container.querySelector('[data-collab-cursor="2"]')).not.toBeNull()
    expect(screen.queryByText('Me')).toBeNull()
  })

  it('renders nothing when no remote cursors exist', () => {
    const { container } = render(
      <CollaborationCursors cursors={new Map()} zoom={1} panX={0} panY={0} />,
    )
    expect(container.firstChild).toBeNull()
  })

  // 回归：<svg> 是替换元素,只有 absolute inset-0 时宽高会退回固有 300x150,
  // 远端光标在小矩形之外被 SVG 默认 overflow:hidden 裁掉而不可见。
  it('stretches the overlay svg to the full container so distant cursors are not clipped', () => {
    const cursors = new Map<number, AwarenessState>([
      [2, remoteState(2, 'Alice', '#f97316', { cursor: { x: 900, y: 700 } })],
    ])
    const { container } = render(
      <CollaborationCursors cursors={cursors} zoom={1} panX={0} panY={0} />,
    )
    const svg = container.querySelector('svg')
    expect(svg?.classList.contains('w-full')).toBe(true)
    expect(svg?.classList.contains('h-full')).toBe(true)
    expect(container.querySelector('[data-collab-cursor="2"]')?.getAttribute('transform')).toBe(
      'translate(900, 700)',
    )
  })
})

describe('RemoteSelection', () => {
  const nodes = new Map<string, { x: number; y: number; width: number; height: number }>([
    ['node-1', { x: 10, y: 20, width: 100, height: 50 }],
    ['node-2', { x: 200, y: 200, width: 40, height: 40 }],
  ])

  it('renders dashed rects for remotely selected nodes', () => {
    const selections = new Map<number, AwarenessState>([
      [2, remoteState(2, 'Alice', '#f97316', { selection: ['node-1', 'node-2'] })],
    ])
    const { container } = render(
      <RemoteSelection selections={selections} nodes={nodes} zoom={1} panX={0} panY={0} />,
    )
    const rect1 = container.querySelector('[data-collab-selection="node-1"]')
    const rect2 = container.querySelector('[data-collab-selection="node-2"]')
    expect(rect1).not.toBeNull()
    expect(rect1?.getAttribute('x')).toBe('10')
    expect(rect1?.getAttribute('y')).toBe('20')
    expect(rect1?.getAttribute('width')).toBe('100')
    expect(rect1?.getAttribute('height')).toBe('50')
    // 选区描边色 = 用户颜色
    expect(rect1?.getAttribute('stroke')).toBe('#f97316')
    expect(rect2).not.toBeNull()
  })

  it('skips selections referencing unknown nodes', () => {
    const selections = new Map<number, AwarenessState>([
      [2, remoteState(2, 'Alice', '#f97316', { selection: ['missing-node'] })],
    ])
    const { container } = render(
      <RemoteSelection selections={selections} nodes={nodes} zoom={1} panX={0} panY={0} />,
    )
    expect(container.querySelector('[data-collab-selection]')).toBeNull()
  })

  it('renders nothing when no remote selections exist', () => {
    const { container } = render(
      <RemoteSelection selections={new Map()} nodes={nodes} zoom={1} panX={0} panY={0} />,
    )
    expect(container.firstChild).toBeNull()
  })

  // 回归：同 CollaborationCursors,未撑满容器的 svg 会裁掉远处的远端选区虚线框。
  it('stretches the overlay svg to the full container so distant selection rects are not clipped', () => {
    const selections = new Map<number, AwarenessState>([
      [2, remoteState(2, 'Alice', '#f97316', { selection: ['node-2'] })],
    ])
    const { container } = render(
      <RemoteSelection selections={selections} nodes={nodes} zoom={1} panX={0} panY={0} />,
    )
    const svg = container.querySelector('svg')
    expect(svg?.classList.contains('w-full')).toBe(true)
    expect(svg?.classList.contains('h-full')).toBe(true)
  })
})

describe('UserAvatars', () => {
  it('renders online collaborator names with initial-letter avatar', () => {
    const users = [
      { id: 2, name: 'Alice', color: '#f97316', avatar: null },
      { id: 3, name: 'Bob', color: '#8b5cf6', avatar: 'https://example.com/bob.png' },
    ]
    const { container } = render(<UserAvatars users={users} />)
    expect(container.querySelector('[data-collab-avatars="true"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-collab-avatar]').length).toBe(2)
    expect(screen.getByText('Alice')).not.toBeNull()
    expect(screen.getByText('Bob')).not.toBeNull()
    // 无头像用户显示首字母
    expect(screen.getByText('A')).not.toBeNull()
    // 有头像用户显示 img
    expect(container.querySelector('img[alt="Bob"]')).not.toBeNull()
  })

  it('renders nothing for an empty user list', () => {
    const { container } = render(<UserAvatars users={[]} />)
    expect(container.firstChild).toBeNull()
  })

  // 回归：右侧面板(node pool z70 / AI sidebar z70)与小地图(z60, 右上角)都比协作
  // 覆盖层(z15)高，头像栏若不主动避让就会被盖住（默认两者都是开启的）。
  const alice = [{ id: 2, name: 'Alice', color: '#f97316', avatar: null }]

  it('avoids the right-side panels', () => {
    useUIStore.setState({ nodePoolOpen: true, aiSidebarOpen: false, minimapVisible: false })
    const first = render(<UserAvatars users={alice} />)
    const withNodePool = first.container.querySelector('[data-collab-avatars="true"]') as HTMLElement
    expect(withNodePool.style.right).toBe('18.25rem')
    first.unmount()

    useUIStore.setState({ nodePoolOpen: false, aiSidebarOpen: true, minimapVisible: false })
    const second = render(<UserAvatars users={alice} />)
    const withAiSidebar = second.container.querySelector('[data-collab-avatars="true"]') as HTMLElement
    expect(withAiSidebar.style.right).toBe('20.5rem')
  })

  // 变更（2026-09-23）：头像栏原在小地图**左侧**，横向偏移按"小地图最大宽度"预留；
  // 小地图实际偏窄时头像就离它很远（用户反馈"孤悬海外"）。现改为贴在小地图**正下方**，
  // 纵向起点取 CanvasMinimap 通过 store 上报的**实际**外框高度。
  it('sits directly below the minimap, using its reported frame height', () => {
    useUIStore.setState({
      nodePoolOpen: true,
      aiSidebarOpen: false,
      minimapVisible: true,
      minimapFrame: { top: MINIMAP_TOP_PX, height: 120 },
    })
    const { container } = render(<UserAvatars users={alice} />)
    const bar = container.querySelector('[data-collab-avatars="true"]') as HTMLElement
    // 横向：只避让右侧面板（与小地图右对齐），不再额外让出小地图宽度
    expect(bar.style.right).toBe('18.25rem')
    // 纵向：小地图 top + 实际高度 + 间隙
    expect(bar.style.top).toBe(`${MINIMAP_TOP_PX + 120 + OVERLAY_GAP_PX}px`)
  })

  it('falls back to the store default frame before the minimap reports its size', () => {
    useUIStore.setState({
      nodePoolOpen: false,
      aiSidebarOpen: false,
      minimapVisible: true,
      minimapFrame: { top: MINIMAP_TOP_PX, height: MINIMAP_MAX_FRAME_HEIGHT_PX },
    })
    const { container } = render(<UserAvatars users={alice} />)
    const bar = container.querySelector('[data-collab-avatars="true"]') as HTMLElement
    expect(bar.style.top).toBe(
      `${MINIMAP_TOP_PX + MINIMAP_MAX_FRAME_HEIGHT_PX + OVERLAY_GAP_PX}px`,
    )
  })

  it('needs no offset when no panel or minimap is open', () => {
    useUIStore.setState({ nodePoolOpen: false, aiSidebarOpen: false, minimapVisible: false })
    const { container } = render(<UserAvatars users={alice} />)
    const bar = container.querySelector('[data-collab-avatars="true"]') as HTMLElement
    expect(bar.style.right).toBe('1rem')
    expect(bar.style.top).toBe(`${MINIMAP_TOP_PX}px`)
  })
})
