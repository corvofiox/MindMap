/* eslint-disable @typescript-eslint/no-explicit-any */
// CanvasMinimap 的「实际占位上报」回归测试。
//
// 背景（2026-09-23）：协作头像栏原本停在小地图**左侧**，横向偏移按小地图**最大宽度**
// 预留；小地图实际偏窄时头像显得远离它（用户反馈"孤悬海外"）。现改为停在小地图**正下方**，
// 纵向起点必须取小地图的**实际**外框高度 —— 因此 CanvasMinimap 需要把真实占位上报道 store。
// 本文件钉住这条上报链路，避免有人改用常量（那会在小地图偏小时再次把头像推远）。

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { CanvasMinimap } from '@/components/canvas/CanvasMinimap'
import { useUIStore } from '@/store/useUIStore'
import {
  MINIMAP_FRAME_PADDING_PX,
  MINIMAP_MAX_CONTENT_HEIGHT_PX,
  MINIMAP_TOP_PX,
  MINIMAP_TOP_WITH_TOOLBAR_PX,
} from '@/utils/panelOffset'
import type { Node } from '@/types'

// jsdom 没有 canvas 2d 上下文，CanvasMinimap 内部已 guard（getContext 返回 null 时跳过绘制），
// 这里不 mock 也能跑；绘制不是本测试的验证对象。
const makeNode = (x: number, y: number, width: number, height: number): Node =>
  ({ id: `n-${x}-${y}`, x, y, width, height }) as unknown as Node

const renderMinimap = (overrides: Partial<Parameters<typeof CanvasMinimap>[0]> = {}) => {
  const props = {
    nodes: new Map<string, Node>(),
    groups: new Map(),
    domains: new Map(),
    connections: new Map(),
    zoom: 1,
    panX: 0,
    panY: 0,
    containerWidth: 1200,
    containerHeight: 800,
    nodePoolOpen: false,
    aiSidebarOpen: false,
    secondaryToolbarOpen: false,
    onViewportChange: vi.fn(),
    ...overrides,
  } as Parameters<typeof CanvasMinimap>[0]
  return render(<CanvasMinimap {...props} />)
}

describe('CanvasMinimap 上报实际占位（供协作头像栏贴到其下方）', () => {
  beforeEach(() => {
    // 从"可疑的默认值"出发，确保断言依赖的是组件上报而不是 store 初始值
    useUIStore.setState({ minimapFrame: { top: 0, height: 0 } })
  })

  it('上报的 top 是常量位置，height 随内容宽高比变化（不是上限常量）', () => {
    // 宽扁内容 → 小地图高度会被压到上限以下
    const wideNodes = new Map<string, Node>([
      ['wide', makeNode(0, 0, 10000, 200)],
    ])
    renderMinimap({ nodes: wideNodes })

    const frame = useUIStore.getState().minimapFrame
    expect(frame.top).toBe(MINIMAP_TOP_PX)

    const maxFrameHeight = MINIMAP_MAX_CONTENT_HEIGHT_PX + MINIMAP_FRAME_PADDING_PX * 2
    expect(frame.height).toBeGreaterThan(0)
    // 关键：必须小于上限 —— 若有人改回用上限常量，这条会失败
    expect(frame.height).toBeLessThan(maxFrameHeight)
  })

  it('空画布（用最小 bounds 的方形区域）接近上限高度', () => {
    renderMinimap()

    const frame = useUIStore.getState().minimapFrame
    expect(frame.top).toBe(MINIMAP_TOP_PX)
    expect(frame.height).toBe(MINIMAP_MAX_CONTENT_HEIGHT_PX + MINIMAP_FRAME_PADDING_PX * 2)
  })

  it('次级工具栏展开时 top 下移', () => {
    renderMinimap({ secondaryToolbarOpen: true })

    expect(useUIStore.getState().minimapFrame.top).toBe(MINIMAP_TOP_WITH_TOOLBAR_PX)
  })
})
