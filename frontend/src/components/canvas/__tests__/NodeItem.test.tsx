import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NodeItem } from '../NodeItem'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useUIStore } from '@/store/useUIStore'

// Mock stores（NodeItem 还从 useCanvasStore 导入 getYjsBinding，mock 必须提供，
// 否则模块命名空间 getter 会在拖拽路径上抛 "No export defined" 错）
vi.mock('@/store/useCanvasStore', () => ({
  useCanvasStore: vi.fn(),
  getYjsBinding: vi.fn(() => undefined),
}))

vi.mock('@/store/useUIStore', () => ({
  useUIStore: vi.fn(),
}))

// Mock utilities：moduleLoader 是真正的惰性加载机制，mock 掉避免动态 import。
// @/utils/canvas（纯数学）与 @/constants（纯数据）不再 mock——走真实模块，
// 测试断言的是真实常量与真实 snapToGrid 行为（mock 副本已与真实值漂移过一次）。
vi.mock('@/utils/moduleLoader', () => ({
  loadApiModule: vi.fn(),
}))

// store mock 的动作 fn 提到模块级，测试里直接断言它们的调用参数
let setSelectedIds: ReturnType<typeof vi.fn>
let setSelectedType: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()

  setSelectedIds = vi.fn()
  setSelectedType = vi.fn()

  // Default mock store values
  vi.mocked(useCanvasStore).mockReturnValue({
    nodes: new Map(),
    groups: new Map(),
    domains: new Map(),
    connections: [],
    zoom: 1.0,
    panX: 0,
    panY: 0,
    selectedIds: new Set(),
    updateNode: vi.fn(),
    deleteNode: vi.fn(),
    setSelectedIds,
    addToSelection: vi.fn(),
    removeFromSelection: vi.fn(),
    editingId: null,
    setEditingId: vi.fn(),
  } as any)

  vi.mocked(useUIStore).mockReturnValue({
    currentTool: 'select',
    setSelectedType,
    // useStoreField 对 undefined 字段会退回整个 store 对象（恒真），必须显式给值
    quickEditMode: false,
    draggingNodeFromCanvas: null,
    isOverNodePool: false,
  } as any)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('NodeItem Component', () => {
  const mockNode: any = {
    id: 'node-1',
    x: 100,
    y: 100,
    width: 200,
    height: 120,
    title: 'Test Node',
    content: 'Test Content',
    color: '#ffffff',
    fontSize: 14,
    textAlign: 'center' as const,
    collapsed: false,
    locked: false,
    type: 'text',
  }

  describe('Component Rendering', () => {
    it('渲染节点卡片：定位、尺寸、标题内容与选中态表现', () => {
      const { rerender } = render(<NodeItem node={mockNode} isSelected={false} zoom={1.0} />)

      const nodeElement = document.querySelector('[data-node-id="node-1"]') as HTMLElement
      expect(nodeElement).not.toBeNull()
      expect(screen.getByText('Test Node')).toBeInTheDocument()
      expect(screen.getByText('Test Content')).toBeInTheDocument()

      // 影子容器承载节点尺寸；外层 wrapper 定位到 node.x-16 / node.y-16（内边距补偿）
      expect(nodeElement.style.width).toBe('200px')
      expect(nodeElement.style.height).toBe('120px')
      const wrapper = nodeElement.parentElement as HTMLElement
      expect(wrapper.style.left).toBe('84px')
      expect(wrapper.style.top).toBe('84px')

      // 未选中：浅阴影，且不出现缩放手柄
      expect(nodeElement.style.boxShadow).toBe(
        '0 1px 3px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.04)'
      )
      expect(document.querySelectorAll('[data-resize]')).toHaveLength(0)

      // 选中：阴影加深 + 四角缩放手柄出现（用户可见的选中反馈）
      rerender(<NodeItem node={mockNode} isSelected={true} zoom={1.0} />)
      expect(nodeElement.style.boxShadow).toBe('0 4px 12px rgba(0, 0, 0, 0.15)')
      expect(document.querySelectorAll('[data-resize]').length).toBeGreaterThan(0)
    })
  })

  describe('Props Handling', () => {
    it('accepts valid node prop', () => {
      expect(() => {
        render(<NodeItem node={mockNode} isSelected={false} zoom={1.0} />)
      }).not.toThrow()
    })

    it('handles empty title and content', () => {
      const emptyNode = { ...mockNode, title: '', content: '' }

      expect(() => {
        render(<NodeItem node={emptyNode} isSelected={false} zoom={1.0} />)
      }).not.toThrow()
    })

    it('renders with collapsed state', () => {
      const collapsedNode = { ...mockNode, collapsed: true }

      expect(() => {
        render(<NodeItem node={collapsedNode} isSelected={false} zoom={1.0} />)
      }).not.toThrow()
    })

    it('renders with locked state', () => {
      const lockedNode = { ...mockNode, locked: true }

      expect(() => {
        render(<NodeItem node={lockedNode} isSelected={false} zoom={1.0} />)
      }).not.toThrow()
    })
  })

  describe('Event Handling', () => {
    // 注意：mousedown/contextmenu 处理器挂在 [data-node-id] 内层内容容器上，
    // 事件必须打在标题等子元素上靠冒泡触发，直接打在 [data-node-id] 上不会命中。

    it('select 工具下左键点击节点：选中节点并通知外层开始拖拽', () => {
      const onMouseDown = vi.fn()
      render(<NodeItem node={mockNode} isSelected={false} zoom={1.0} onMouseDown={onMouseDown} />)

      fireEvent.mouseDown(screen.getByText('Test Node'))

      expect(onMouseDown).toHaveBeenCalledTimes(1)
      expect(setSelectedIds).toHaveBeenCalledWith(['node-1'])
      expect(setSelectedType).toHaveBeenCalledWith('node')
    })

    it('原地右键（mousedown→contextmenu）打开节点上下文菜单并选中节点', () => {
      const onNodeContextMenuOpen = vi.fn()
      render(
        <NodeItem
          node={mockNode}
          isSelected={false}
          zoom={1.0}
          onNodeContextMenuOpen={onNodeContextMenuOpen}
        />
      )

      const title = screen.getByText('Test Node')
      // 右键按下记录起点，之后的 contextmenu 与起点距离 ≤5px 才被视为"原地右键"
      fireEvent.mouseDown(title, { button: 2, clientX: 30, clientY: 40 })
      fireEvent.contextMenu(title, { clientX: 30, clientY: 42 })

      // 菜单位置 = 鼠标位置 + 5px 偏移；未选中状态下右键同时选中节点
      expect(onNodeContextMenuOpen).toHaveBeenCalledWith(35, 47, 'node-1')
      expect(setSelectedIds).toHaveBeenCalledWith(['node-1'])
    })

    it('右键拖动超过阈值后不弹出菜单也不选中', () => {
      const onNodeContextMenuOpen = vi.fn()
      render(
        <NodeItem
          node={mockNode}
          isSelected={false}
          zoom={1.0}
          onNodeContextMenuOpen={onNodeContextMenuOpen}
        />
      )

      const title = screen.getByText('Test Node')
      fireEvent.mouseDown(title, { button: 2, clientX: 30, clientY: 40 })
      // dy=20 > 5px 阈值：判定为右键拖动（框选/平移手势），不得弹菜单
      fireEvent.contextMenu(title, { clientX: 30, clientY: 60 })

      expect(onNodeContextMenuOpen).not.toHaveBeenCalled()
      expect(setSelectedIds).not.toHaveBeenCalled()
    })
  })

  describe('Store Integration', () => {
    it('connection 工具下点击节点不产生选中（工具门控）', () => {
      vi.mocked(useUIStore).mockReturnValue({
        currentTool: 'connection',
        setSelectedType,
        quickEditMode: false,
        draggingNodeFromCanvas: null,
        isOverNodePool: false,
      } as any)
      const onMouseDown = vi.fn()
      render(<NodeItem node={mockNode} isSelected={false} zoom={1.0} onMouseDown={onMouseDown} />)

      fireEvent.mouseDown(screen.getByText('Test Node'))

      // 事件确实到达了节点（onMouseDown 已触发），但非选择工具下不得改选节点
      expect(onMouseDown).toHaveBeenCalledTimes(1)
      expect(setSelectedIds).not.toHaveBeenCalled()
      expect(setSelectedType).not.toHaveBeenCalled()
    })
  })

  describe('Error Handling', () => {
    it('does not crash with missing optional props', () => {
      expect(() => {
        render(<NodeItem node={mockNode} isSelected={false} zoom={1.0} />)
      }).not.toThrow()
    })

    it('handles null callbacks gracefully', () => {
      expect(() => {
        render(
          <NodeItem
            node={mockNode}
            isSelected={false}
            zoom={1.0}
            onDragStart={null}
            onDragEnd={null}
            onNodeContextMenuOpen={null}
          />
        )
      }).not.toThrow()
    })
  })

  describe('Different Node Types', () => {
    it('renders text node', () => {
      const textNode = { ...mockNode, type: 'text' }

      expect(() => {
        render(<NodeItem node={textNode} isSelected={false} zoom={1.0} />)
      }).not.toThrow()
    })

    it('renders image node', () => {
      const imageNode = { ...mockNode, type: 'image', imageUrl: 'test.jpg' }

      expect(() => {
        render(<NodeItem node={imageNode} isSelected={false} zoom={1.0} />)
      }).not.toThrow()
    })
  })
})
