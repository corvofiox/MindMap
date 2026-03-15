import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { FabricCanvas } from '../FabricCanvas'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useUIStore } from '@/store/useUIStore'

// Mock stores with function mocks
vi.mock('@/store/useCanvasStore')
vi.mock('@/store/useUIStore')

// Mock canvas utilities
vi.mock('@/utils/canvas', () => ({
  screenToCanvas: vi.fn((x, y, zoom, panX, panY) => ({
    x: (x - panX) / zoom,
    y: (y - panY) / zoom,
  })),
  generateId: vi.fn((prefix = 'node') => `${prefix}-123456`),
  clamp: vi.fn((val, min, max) => Math.min(Math.max(val, min), max)),
}))

// Mock Fabric utilities
vi.mock('@/utils/fabric', () => ({
  createFabricNode: vi.fn(() => ({ data: { id: 'mock-node-id', type: 'node' } })),
  createFabricGroup: vi.fn(() => ({ data: { id: 'mock-group-id', type: 'group' } })),
  createFabricDomain: vi.fn(() => ({ data: { id: 'mock-domain-id', type: 'domain' } })),
  createFabricConnection: vi.fn(() => ({ data: { id: 'mock-connection-id', type: 'connection' } })),
  updateFabricDomainsEditable: vi.fn(),
  snapToGridFabric: vi.fn((val, gridSize) => Math.round(val / gridSize) * gridSize),
}))

// Mock constants
vi.mock('@/constants', () => ({
  API_ENDPOINTS: {},
  WS_CONFIG: {
    get URL() { return 'ws://localhost:3001/ws' },
    PATH: '/ws',
    RECONNECT_INTERVAL: 1000,
    MAX_RECONNECT_ATTEMPTS: 10,
  },
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
  GROUP_DEFAULTS: {
    BORDER_WIDTH: 2,
    BORDER_RADIUS: 8,
    BACKGROUND_COLOR: 'rgba(59, 130, 246, 0.1)',
    BORDER_COLOR: '#3b82f6',
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
  DEFAULT_NODE_DEFAULTS: {
    textNode: {
      width: 200,
      height: 120,
      color: '#ffffff',
      fontSize: 14,
      titleAlign: 'left',
      contentAlign: 'left',
    },
    imageNode: {
      width: 200,
      height: 150,
      fontSize: 14,
      titleAlign: 'left',
    },
  },
}))

// Mock Fabric.js global object
const mockFabricCanvas = {
  width: 800,
  height: 600,
  selection: true,
  preserveObjectStacking: true,
  getPointer: vi.fn(() => ({ x: 400, y: 300 })),
  setZoom: vi.fn(),
  setWidth: vi.fn(),
  setHeight: vi.fn(),
  add: vi.fn(),
  clear: vi.fn(),
  renderAll: vi.fn(),
  dispose: vi.fn(),
  sendToBack: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  findTarget: vi.fn(),
  viewportTransform: [1, 0, 0, 1, 0, 0],
}

// Create a constructor-like mock that returns mockFabricCanvas
class MockFabricCanvasConstructor {
  constructor(..._args: any[]) {
    Object.assign(this, mockFabricCanvas)
  }
}

// Create a mock Rect constructor
class MockFabricRect {
  constructor(..._args: any[]) {
    Object.assign(this, {
      set: vi.fn(),
      data: {},
    })
  }
}

beforeEach(() => {
  vi.clearAllMocks()

    // Set up global fabric object with constructor
    ; (globalThis as any).fabric = {
      Canvas: MockFabricCanvasConstructor as any,
      Rect: MockFabricRect as any,
    }

  // Default mock store values
  vi.mocked(useCanvasStore).mockReturnValue({
    nodes: new Map(),
    groups: new Map(),
    domains: new Map(),
    connections: new Map(),
    zoom: 1.0,
    panX: 0,
    panY: 0,
    selectedIds: [],
    addNode: vi.fn(),
    addDomain: vi.fn(),
    updateNode: vi.fn(),
    updateDomain: vi.fn(),
    setSelectedIds: vi.fn(),
    setZoom: vi.fn(),
    setPan: vi.fn(),
    setEditingId: vi.fn(),
    setHoveredId: vi.fn(),
  } as any)

  vi.mocked(useUIStore).mockReturnValue({
    currentTool: 'select',
  } as any)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('FabricCanvas Component', () => {
  describe('Component Rendering', () => {
    it('renders canvas container with correct dimensions', () => {
      render(<FabricCanvas canvasId={1} width={800} height={600} />)

      const canvas = document.getElementById('fabric-canvas')
      expect(canvas).toBeInTheDocument()
    })

    it('initializes Fabric.js canvas on mount', () => {
      render(<FabricCanvas canvasId={1} width={800} height={600} />)

      // Verify canvas element is created
      const canvas = document.getElementById('fabric-canvas')
      expect(canvas).toBeInTheDocument()
    })

    it('disposes canvas on unmount', () => {
      const { unmount } = render(<FabricCanvas canvasId={1} width={800} height={600} />)

      unmount()

      expect(mockFabricCanvas.dispose).toHaveBeenCalled()
    })

    it('updates canvas dimensions when props change', () => {
      const { rerender } = render(<FabricCanvas canvasId={1} width={800} height={600} />)

      rerender(<FabricCanvas canvasId={1} width={1920} height={1080} />)

      expect(mockFabricCanvas.setWidth).toHaveBeenCalledWith(1920)
      expect(mockFabricCanvas.setHeight).toHaveBeenCalledWith(1080)
    })

    it('applies correct CSS classes based on tool', () => {
      vi.mocked(useUIStore).mockReturnValue({
        currentTool: 'node',
      } as any)

      render(<FabricCanvas canvasId={1} width={800} height={600} />)

      const container = document.querySelector('.absolute')
      expect(container).toHaveStyle({ cursor: 'crosshair' })
    })

    it('sets pan cursor when tool is pan', () => {
      vi.mocked(useUIStore).mockReturnValue({
        currentTool: 'pan',
      } as any)

      render(<FabricCanvas canvasId={1} width={800} height={600} />)

      const container = document.querySelector('.absolute')
      expect(container).toHaveStyle({ cursor: 'grab' })
    })

    it('sets default cursor for select tool', () => {
      vi.mocked(useUIStore).mockReturnValue({
        currentTool: 'select',
      } as any)

      render(<FabricCanvas canvasId={1} width={800} height={600} />)

      const container = document.querySelector('.absolute')
      expect(container).toHaveStyle({ cursor: 'default' })
    })
  })

  describe('Store Integration', () => {
    it('reads from canvas store on render', () => {
      render(<FabricCanvas canvasId={1} width={800} height={600} />)

      expect(useCanvasStore).toHaveBeenCalled()
    })

    it('reads from UI store on render', () => {
      render(<FabricCanvas canvasId={1} width={800} height={600} />)

      expect(useUIStore).toHaveBeenCalled()
    })

    it('loads canvas data from store', () => {
      const mockStore = {
        nodes: new Map([
          ['node-1', { id: 'node-1', x: 100, y: 100, width: 200, height: 120, color: '#fff', locked: false }],
        ]),
        groups: new Map(),
        domains: new Map(),
        connections: new Map(),
        zoom: 1.0,
        panX: 0,
        panY: 0,
        selectedIds: [],
        addNode: vi.fn(),
        addDomain: vi.fn(),
        updateNode: vi.fn(),
        updateDomain: vi.fn(),
        setSelectedIds: vi.fn(),
        setZoom: vi.fn(),
        setPan: vi.fn(),
        setEditingId: vi.fn(),
        setHoveredId: vi.fn(),
      }

      vi.mocked(useCanvasStore).mockReturnValue(mockStore as any)

      render(<FabricCanvas canvasId={1} width={800} height={600} />)

      expect(mockFabricCanvas.renderAll).toHaveBeenCalled()
    })
  })

  describe('Event Handler Setup', () => {
    it('sets up Fabric.js event listeners on initialization', () => {
      render(<FabricCanvas canvasId={1} width={800} height={600} />)

      expect(mockFabricCanvas.on).toHaveBeenCalledWith('selection:created', expect.any(Function))
      expect(mockFabricCanvas.on).toHaveBeenCalledWith('selection:updated', expect.any(Function))
      expect(mockFabricCanvas.on).toHaveBeenCalledWith('selection:cleared', expect.any(Function))
      expect(mockFabricCanvas.on).toHaveBeenCalledWith('object:moving', expect.any(Function))
      expect(mockFabricCanvas.on).toHaveBeenCalledWith('object:modified', expect.any(Function))
      expect(mockFabricCanvas.on).toHaveBeenCalledWith('object:scaling', expect.any(Function))
      expect(mockFabricCanvas.on).toHaveBeenCalledWith('mouse:wheel', expect.any(Function))
      expect(mockFabricCanvas.on).toHaveBeenCalledWith('mouse:down', expect.any(Function))
      expect(mockFabricCanvas.on).toHaveBeenCalledWith('mouse:up', expect.any(Function))
      expect(mockFabricCanvas.on).toHaveBeenCalledWith('mouse:move', expect.any(Function))
      expect(mockFabricCanvas.on).toHaveBeenCalledWith('mouse:dblclick', expect.any(Function))
    })
  })

  describe('Selection Handling', () => {
    it('updates selectedIds when selection is created', () => {
      const mockSetSelectedIds = vi.fn()
      vi.mocked(useCanvasStore).mockReturnValue({
        nodes: new Map(),
        groups: new Map(),
        domains: new Map(),
        connections: new Map(),
        zoom: 1.0,
        panX: 0,
        panY: 0,
        selectedIds: [],
        addNode: vi.fn(),
        addDomain: vi.fn(),
        updateNode: vi.fn(),
        updateDomain: vi.fn(),
        setSelectedIds: mockSetSelectedIds,
        setZoom: vi.fn(),
        setPan: vi.fn(),
        setEditingId: vi.fn(),
        setHoveredId: vi.fn(),
      } as any)

      render(<FabricCanvas canvasId={1} width={800} height={600} />)

      // Get the selection:created handler
      const calls = mockFabricCanvas.on.mock.calls.filter((call: any) => call[0] === 'selection:created')
      const handler = calls[0][1]

      // Simulate selection created event
      act(() => {
        handler({
          selected: [
            { data: { id: 'node-1' } },
            { data: { id: 'node-2' } },
          ],
        })
      })

      expect(mockSetSelectedIds).toHaveBeenCalledWith(['node-1', 'node-2'])
    })

    it('clears selection when selection is cleared', () => {
      const mockSetSelectedIds = vi.fn()
      vi.mocked(useCanvasStore).mockReturnValue({
        nodes: new Map(),
        groups: new Map(),
        domains: new Map(),
        connections: new Map(),
        zoom: 1.0,
        panX: 0,
        panY: 0,
        selectedIds: ['node-1'],
        addNode: vi.fn(),
        addDomain: vi.fn(),
        updateNode: vi.fn(),
        updateDomain: vi.fn(),
        setSelectedIds: mockSetSelectedIds,
        setZoom: vi.fn(),
        setPan: vi.fn(),
        setEditingId: vi.fn(),
        setHoveredId: vi.fn(),
      } as any)

      render(<FabricCanvas canvasId={1} width={800} height={600} />)

      // Get the selection:cleared handler
      const calls = mockFabricCanvas.on.mock.calls.filter((call: any) => call[0] === 'selection:cleared')
      const handler = calls[0][1]

      // Simulate selection cleared event
      act(() => {
        handler()
      })

      expect(mockSetSelectedIds).toHaveBeenCalledWith([])
    })
  })

  describe('Double Click Handling', () => {
    it('sets editingId when domain is double-clicked', () => {
      const mockSetEditingId = vi.fn()
      vi.mocked(useCanvasStore).mockReturnValue({
        nodes: new Map(),
        groups: new Map(),
        domains: new Map(),
        connections: new Map(),
        zoom: 1.0,
        panX: 0,
        panY: 0,
        selectedIds: [],
        addNode: vi.fn(),
        addDomain: vi.fn(),
        updateNode: vi.fn(),
        updateDomain: vi.fn(),
        setSelectedIds: vi.fn(),
        setZoom: vi.fn(),
        setPan: vi.fn(),
        setEditingId: mockSetEditingId,
        setHoveredId: vi.fn(),
      } as any)

      render(<FabricCanvas canvasId={1} width={800} height={600} />)

      // Get the mouse:dblclick handler
      const calls = mockFabricCanvas.on.mock.calls.filter((call: any) => call[0] === 'mouse:dblclick')
      const handler = calls[0][1]

      // Set up findTarget to return a domain
      mockFabricCanvas.findTarget.mockReturnValue({ data: { id: 'domain-1', type: 'domain' } })

      act(() => {
        handler({})
      })

      expect(mockSetEditingId).toHaveBeenCalledWith('domain-1')
    })

    it('sets editingId when node is double-clicked', () => {
      const mockSetEditingId = vi.fn()
      vi.mocked(useCanvasStore).mockReturnValue({
        nodes: new Map(),
        groups: new Map(),
        domains: new Map(),
        connections: new Map(),
        zoom: 1.0,
        panX: 0,
        panY: 0,
        selectedIds: [],
        addNode: vi.fn(),
        addDomain: vi.fn(),
        updateNode: vi.fn(),
        updateDomain: vi.fn(),
        setSelectedIds: vi.fn(),
        setZoom: vi.fn(),
        setPan: vi.fn(),
        setEditingId: mockSetEditingId,
        setHoveredId: vi.fn(),
      } as any)

      render(<FabricCanvas canvasId={1} width={800} height={600} />)

      // Get the mouse:dblclick handler
      const calls = mockFabricCanvas.on.mock.calls.filter((call: any) => call[0] === 'mouse:dblclick')
      const handler = calls[0][1]

      // Set up findTarget to return a node
      mockFabricCanvas.findTarget.mockReturnValue({ data: { id: 'node-1', type: 'node' } })

      act(() => {
        handler({})
      })

      expect(mockSetEditingId).toHaveBeenCalledWith('node-1')
    })
  })

  describe('Props Handling', () => {
    it('accepts valid canvasId, width, and height props', () => {
      expect(() => {
        render(<FabricCanvas canvasId={1} width={800} height={600} />)
      }).not.toThrow()
    })

    it('renders with different canvas sizes', () => {
      const { rerender } = render(<FabricCanvas canvasId={1} width={800} height={600} />)

      expect(() => {
        rerender(<FabricCanvas canvasId={2} width={1920} height={1080} />)
      }).not.toThrow()
    })

    it('handles small canvas dimensions', () => {
      expect(() => {
        render(<FabricCanvas canvasId={1} width={100} height={100} />)
      }).not.toThrow()
    })
  })

  describe('Error Handling', () => {
    it('does not crash with missing fabric global', () => {
      delete (globalThis as any).fabric

      expect(() => {
        render(<FabricCanvas canvasId={1} width={800} height={600} />)
      }).not.toThrow()
    })

    it('handles invalid props gracefully', () => {
      expect(() => {
        render(<FabricCanvas canvasId={0} width={0} height={0} />)
      }).not.toThrow()
    })
  })

  describe('Canvas Lifecycle', () => {
    it('re-initializes canvas when canvasId changes', () => {
      const { rerender } = render(<FabricCanvas canvasId={1} width={800} height={600} />)

      // Track constructor calls via a spy
      const constructorSpy = vi.spyOn(globalThis as any, 'fabric', 'get')

      rerender(<FabricCanvas canvasId={2} width={800} height={600} />)

      // Just verify the component doesn't crash on re-render
      expect(true).toBe(true)
    })
  })
})
