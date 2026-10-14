/**
 * useContextMenu 真实行为测试(hooks/useContextMenu.tsx)
 *
 * 该 hook 无 DOM 挂载点,所以按本仓库既有风格(useCollaboration.test.tsx 的 Probe)
 * 用一个探针组件把 menuRef 绑到真实 div 上 —— 否则 menuRef.current 恒为 null,
 * adjustPosition 永远提前返回,位置逻辑根本没被执行。
 *
 * 覆盖:
 *  - 首帧未定位(isPositioned=false)且 finalPosition = 初始坐标
 *  - 菜单在视口内:一帧后定位,坐标不变
 *  - 右边溢出 → 贴到 viewportWidth - menuWidth - padding
 *  - 下边溢出 → 贴到 viewportHeight - menuHeight - padding
 *  - 菜单大于视口 → 收敛到 padding(10)下限
 *  - document mousedown 在菜单外 → onClose;在菜单内 → 不触发
 *  - Escape keydown → onClose;其他键不触发
 *  - 卸载后监听器移除(点击不再调用 onClose)
 *  - MenuDivider 渲染出分隔线
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { useContextMenu, MenuDivider } from '../useContextMenu'

type Rect = { left: number; top: number; width: number; height: number }

const realGetBoundingClientRect = Element.prototype.getBoundingClientRect
let menuRect: Rect = { left: 0, top: 0, width: 0, height: 0 }

interface ProbeProps {
  initialPosition: { x: number; y: number }
  onClose: () => void
}

function MenuProbe({ initialPosition, onClose }: ProbeProps) {
  const { isPositioned, finalPosition, menuRef } = useContextMenu({ initialPosition, onClose })
  return (
    <div
      ref={menuRef}
      data-testid="menu"
      data-positioned={String(isPositioned)}
      data-x={finalPosition.x}
      data-y={finalPosition.y}
    >
      菜单项
    </div>
  )
}

function menu() {
  return screen.getByTestId('menu')
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height })
}

beforeEach(() => {
  menuRect = { left: 0, top: 0, width: 0, height: 0 }
  Element.prototype.getBoundingClientRect = function patched(this: Element): DOMRect {
    return {
      left: menuRect.left,
      top: menuRect.top,
      width: menuRect.width,
      height: menuRect.height,
      right: menuRect.left + menuRect.width,
      bottom: menuRect.top + menuRect.height,
      x: menuRect.left,
      y: menuRect.top,
      toJSON: () => ({}),
    } as DOMRect
  }
})

afterEach(() => {
  cleanup()
  Element.prototype.getBoundingClientRect = realGetBoundingClientRect
  vi.restoreAllMocks()
})

describe('useContextMenu 定位', () => {
  it('首帧未定位,finalPosition 等于初始坐标', () => {
    setViewport(1000, 800)
    menuRect = { left: 0, top: 0, width: 120, height: 80 }

    render(<MenuProbe initialPosition={{ x: 200, y: 300 }} onClose={vi.fn()} />)

    expect(menu().dataset.positioned).toBe('false')
    expect(menu().dataset.x).toBe('200')
    expect(menu().dataset.y).toBe('300')
  })

  it('菜单完全在视口内:一帧后定位且坐标不变', async () => {
    setViewport(1000, 800)
    menuRect = { left: 0, top: 0, width: 120, height: 80 }

    render(<MenuProbe initialPosition={{ x: 200, y: 300 }} onClose={vi.fn()} />)
    await waitFor(() => expect(menu().dataset.positioned).toBe('true'))

    expect(menu().dataset.x).toBe('200')
    expect(menu().dataset.y).toBe('300')
  })

  it('右侧溢出:贴到 innerWidth - menuWidth - 10 并夹住下限', async () => {
    setViewport(1000, 800)
    menuRect = { left: 0, top: 0, width: 120, height: 80 }

    render(<MenuProbe initialPosition={{ x: 950, y: 10 }} onClose={vi.fn()} />)
    await waitFor(() => expect(menu().dataset.positioned).toBe('true'))

    expect(menu().dataset.x).toBe('870')
    expect(menu().dataset.y).toBe('10')
  })

  it('底部溢出:贴到 innerHeight - menuHeight - 10', async () => {
    setViewport(1000, 800)
    menuRect = { left: 0, top: 0, width: 120, height: 300 }

    render(<MenuProbe initialPosition={{ x: 10, y: 700 }} onClose={vi.fn()} />)
    await waitFor(() => expect(menu().dataset.positioned).toBe('true'))

    expect(menu().dataset.x).toBe('10')
    expect(menu().dataset.y).toBe('490')
  })

  it('菜单大于视口:两个轴都收敛到 padding=10 下限', async () => {
    setViewport(400, 300)
    menuRect = { left: 0, top: 0, width: 500, height: 400 }

    render(<MenuProbe initialPosition={{ x: 395, y: 295 }} onClose={vi.fn()} />)
    await waitFor(() => expect(menu().dataset.positioned).toBe('true'))

    expect(menu().dataset.x).toBe('10')
    expect(menu().dataset.y).toBe('10')
  })

  it('负坐标不触发夹取(只有溢出轴会被调整)', async () => {
    setViewport(1000, 800)
    menuRect = { left: 0, top: 0, width: 50, height: 50 }

    render(<MenuProbe initialPosition={{ x: -30, y: -40 }} onClose={vi.fn()} />)
    await waitFor(() => expect(menu().dataset.positioned).toBe('true'))

    expect(menu().dataset.x).toBe('-30')
    expect(menu().dataset.y).toBe('-40')
  })
})

describe('useContextMenu 关闭时机', () => {
  it('菜单外部 mousedown 调用 onClose', async () => {
    setViewport(1000, 800)
    const onClose = vi.fn()
    render(<MenuProbe initialPosition={{ x: 100, y: 100 }} onClose={onClose} />)
    await waitFor(() => expect(menu().dataset.positioned).toBe('true'))

    fireEvent.mouseDown(document.body)

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('菜单内部 mousedown 不调用 onClose', async () => {
    setViewport(1000, 800)
    const onClose = vi.fn()
    render(<MenuProbe initialPosition={{ x: 100, y: 100 }} onClose={onClose} />)
    await waitFor(() => expect(menu().dataset.positioned).toBe('true'))

    fireEvent.mouseDown(screen.getByText('菜单项'))

    expect(onClose).not.toHaveBeenCalled()
  })

  it('Escape 调用 onClose,其他键不调用', () => {
    const onClose = vi.fn()
    render(<MenuProbe initialPosition={{ x: 100, y: 100 }} onClose={onClose} />)

    fireEvent.keyDown(document, { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('卸载后监听器被移除(外部点击不再调用 onClose)', async () => {
    setViewport(1000, 800)
    const onClose = vi.fn()
    render(<MenuProbe initialPosition={{ x: 100, y: 100 }} onClose={onClose} />)
    await waitFor(() => expect(menu().dataset.positioned).toBe('true'))

    cleanup()
    fireEvent.mouseDown(document.body)
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('MenuDivider', () => {
  it('渲染为带边框的分隔 div', () => {
    const { container } = render(<MenuDivider />)
    const divider = container.querySelector('div')

    expect(divider).not.toBeNull()
    expect(divider!.className).toContain('h-px')
    expect(divider!.className).toContain('border-t')
    expect(divider!.childElementCount).toBe(0)
  })
})
