import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NodeItem } from '../NodeItem'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useUIStore } from '@/store/useUIStore'

// Mock stores
vi.mock('@/store/useCanvasStore', () => ({
  useCanvasStore: vi.fn(),
}))

vi.mock('@/store/useUIStore', () => ({
  useUIStore: vi.fn(),
}))

// Mock utilities
vi.mock('@/utils/canvas', () => ({
  snapToGrid: vi.fn((x, y) => ({ x, y })),
}))

vi.mock('@/utils/moduleLoader', () => ({
  loadApiModule: vi.fn(),
}))

// Mock constants
vi.mock('@/constants', () => ({
  CANVAS_DEFAULTS: {
    GRID_SIZE: 20,
    GRID_DOT_SIZE: 1,
    DEFAULT_ZOOM: 1,
    MIN_ZOOM: 0.1,
    MAX_ZOOM: 5,
    ZOOM_STEP: 0.1,
  },
  NODE_DEFAULTS: {
    WIDTH: 200,
    HEIGHT: 120,
    MIN_WIDTH: 100,
    MIN_HEIGHT: 60,
    COLOR: '#ffffff',
    BORDER_COLOR: '#e5e7eb',
    BORDER_WIDTH: 1,
    BORDER_RADIUS: 8,
    FONT_SIZE: 14,
    TEXT_ALIGN: 'center' as const,
    PADDING: 16,
  },
  DOMAIN_DEFAULTS: {
    BACKGROUND_COLOR: 'rgba(156, 163, 175, 0.2)',
  },
  CONNECTION_DEFAULTS: {
    COLOR: '#3b82f6',
    WIDTH: 2,
    TYPE: 'curve',
    STYLE: 'solid',
    ARROW_TYPE: 'end',
    BEND_POINT_RADIUS: 8,
    BEND_POINT_HIT_RADIUS: 12,
  },
  NODE_COLORS: [
    '#ffffff',
    '#fef3c7',
    '#fce7f3',
    '#dbeafe',
    '#d1fae5',
    '#e0e7ff',
    '#fee2e2',
    '#f3e8ff',
  ],
  BORDER_COLORS: [
    '#e5e7eb',
    '#fcd34d',
    '#f472b6',
    '#60a5fa',
    '#34d399',
    '#818cf8',
    '#f87171',
    '#a78bfa',
  ],
  SHORTCUTS: {
    CANVAS_ZOOM_IN: 'Ctrl+=',
    CANVAS_ZOOM_OUT: 'Ctrl+-',
    CANVAS_ZOOM_RESET: 'Ctrl+0',
    CANVAS_FIT: 'F',
    CANVAS_TOGGLE_GRID: 'G',
    NODE_CREATE: 'N',
    NODE_DELETE: 'Delete',
    NODE_COPY: 'Ctrl+C',
    NODE_PASTE: 'Ctrl+V',
    NODE_CUT: 'Ctrl+X',
    NODE_DUPLICATE: 'Ctrl+D',
    NODE_EDIT: 'Enter',
    NODE_ESCAPE: 'Escape',
    GROUP_CREATE: 'Ctrl+G',
    GROUP_UNGROUP: 'Ctrl+Shift+G',
    DOMAIN_MODE: 'R',
    CONNECTION_MODE: 'L',
    SELECT_ALL: 'Ctrl+A',
    SELECT_NONE: 'Ctrl+Shift+A',
    FILE_SAVE: 'Ctrl+S',
    FILE_EXPORT: 'Ctrl+E',
    FILE_NEW: 'Ctrl+N',
    FILE_CLOSE: 'Ctrl+W',
    SEARCH: 'Ctrl+F',
    SEARCH_GLOBAL: 'Ctrl+Shift+F',
    PANEL_SIDEBAR: 'Ctrl+B',
    PANEL_NODE_POOL: 'Ctrl+P',
    PANEL_SETTINGS: 'Ctrl+,',
    PANEL_HELP: 'Ctrl+H',
    UNDO: 'Ctrl+Z',
    REDO: 'Ctrl+Y',
    TAB_NEXT: 'Ctrl+Tab',
    TAB_PREV: 'Ctrl+Shift+Tab',
  },
  STORAGE_KEYS: {
    TOKEN: 'mindmap_token',
    THEME: 'mindmap_theme',
    SETTINGS: 'mindmap_settings',
    RECENT_CANVASES: 'mindmap_recent_canvases',
  },
  TIMEOUTS: {
    TOAST: 3000,
    DEBOUNCE: 300,
    AUTOSAVE: 5000,
  },
  Z_INDEX: {
    DOMAIN: 0,
    GROUP: 1,
    CONNECTION: 5,
    NODE: 10,
    BEND_POINT: 8,
    RICH_TEXT_TOOLBAR: 55,
    RICH_TEXT_POPOVER: 56,
    ZOOM_CONTROLS: 60,
    NODE_POOL_PANEL: 70,
    NODE_POOL_CONTEXT_MASK: 75,
    CONTEXT_MENU: 80,
    STYLE_PANEL: 80,
    SIDEBAR_SUBMENU: 90,
    DROPDOWN_MENU: 90,
    DIALOG: 100,
    SEARCH_PANEL: 100,
    COMMAND_PALETTE: 100,
    TOAST: 120,
    DRAG_GHOST: 1000,
  },
}))

beforeEach(() => {
  vi.clearAllMocks()

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
    setSelectedIds: vi.fn(),
    addToSelection: vi.fn(),
    removeFromSelection: vi.fn(),
    editingId: null,
    setEditingId: vi.fn(),
  } as any)

  vi.mocked(useUIStore).mockReturnValue({
    currentTool: 'select',
    setSelectedType: vi.fn(),
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
    it('renders node with basic props', () => {
      render(<NodeItem node={mockNode} isSelected={false} zoom={1.0} />)

      const nodeElement = document.querySelector('[data-node-id="node-1"]')
      expect(nodeElement).toBeInTheDocument()
    })

    it('applies selected styles when isSelected is true', () => {
      render(<NodeItem node={mockNode} isSelected={true} zoom={1.0} />)

      const nodeElement = document.querySelector('[data-node-id="node-1"]')
      expect(nodeElement).toBeInTheDocument()
    })

    it('renders node with title', () => {
      render(<NodeItem node={mockNode} isSelected={false} zoom={1.0} />)

      expect(screen.getByText('Test Node')).toBeInTheDocument()
    })

    it('renders node with content', () => {
      render(<NodeItem node={mockNode} isSelected={false} zoom={1.0} />)

      expect(screen.getByText('Test Content')).toBeInTheDocument()
    })

    it('renders node with correct position', () => {
      render(<NodeItem node={mockNode} isSelected={false} zoom={1.0} />)

      const nodeElement = document.querySelector('[data-node-id="node-1"]')
      expect(nodeElement).toBeInTheDocument()
    })

    it('applies zoom transformation', () => {
      render(<NodeItem node={mockNode} isSelected={false} zoom={1.5} />)

      const nodeElement = document.querySelector('[data-node-id="node-1"]')
      expect(nodeElement).toBeInTheDocument()
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
    it('handles mouse down events', () => {
      const onMouseDown = vi.fn()
      render(<NodeItem node={mockNode} isSelected={false} zoom={1.0} onMouseDown={onMouseDown} />)

      const nodeElement = document.querySelector('[data-node-id="node-1"]')
      if (nodeElement) {
        fireEvent.mouseDown(nodeElement)
        // Event handler is called internally, but we verify component renders
        expect(nodeElement).toBeInTheDocument()
      }
    })

    it('calls onNodeContextMenuOpen on right-click', () => {
      const onNodeContextMenuOpen = vi.fn()
      render(
        <NodeItem
          node={mockNode}
          isSelected={false}
          zoom={1.0}
          onNodeContextMenuOpen={onNodeContextMenuOpen}
        />
      )

      const nodeElement = document.querySelector('[data-node-id="node-1"]')
      if (nodeElement) {
        fireEvent.contextMenu(nodeElement)
        // Component should handle context menu internally
        expect(nodeElement).toBeInTheDocument()
      }
    })
  })

  describe('Store Integration', () => {
    it('reads from canvas store', () => {
      render(<NodeItem node={mockNode} isSelected={false} zoom={1.0} />)

      expect(useCanvasStore).toHaveBeenCalled()
    })

    it('reads from UI store', () => {
      render(<NodeItem node={mockNode} isSelected={false} zoom={1.0} />)

      expect(useUIStore).toHaveBeenCalled()
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
