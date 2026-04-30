import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useUIStore } from '@/store/useUIStore'
import { useAuthStore } from '@/store/useAuthStore'
import { useProjectsStore } from '@/store/useProjectsStore'
import { CANVAS_DEFAULTS, NODE_DEFAULTS, NODE_COLORS } from '@/constants'
import type { Node, Connection, NodeGroup, Domain } from '@/types'

const mockNodes: Node[] = [
  {
    id: 'node-1',
    title: 'Root Node',
    content: 'This is a root node',
    x: 400,
    y: 300,
    width: 200,
    height: 160,
    fontSize: 14,
    textAlign: 'left',
    collapsed: false,
    locked: false,
  },
  {
    id: 'node-2',
    title: 'Child Node',
    content: 'This is a child node',
    x: 700,
    y: 300,
    width: 200,
    height: 160,
    fontSize: 14,
    textAlign: 'left',
    collapsed: false,
    locked: false,
  },
]

const mockConnections: Connection[] = [
  {
    id: 'conn-1',
    fromNodeId: 'node-1',
    toNodeId: 'node-2',
    fromPort: 'right',
    toPort: 'left',
    type: 'curve',
    style: 'solid',
    color: '#3b82f6',
    width: 2,
    arrowType: 'end',
    direction: 'directed',
  },
]

const mockGroups: NodeGroup[] = [
  {
    id: 'group-1',
    name: 'Test Group',
    x: 350,
    y: 250,
    width: 600,
    height: 260,
    borderColor: '#3b82f6',
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    borderWidth: 2,
    borderRadius: 8,
    nodeIds: ['node-1', 'node-2'],
    collapsed: false,
  },
]

const mockDomains: Domain[] = [
  {
    id: 'domain-1',
    name: 'Test Domain',
    x: 300,
    y: 200,
    width: 700,
    height: 360,
    backgroundColor: 'rgba(156, 163, 175, 0.2)',
    titleVisible: true,
    titleColor: '#6b7280',
  },
]

const createMockStore = () => ({
  nodes: new Map(mockNodes.map((n) => [n.id, n])),
  connections: new Map(mockConnections.map((c) => [c.id, c])),
  groups: new Map(mockGroups.map((g) => [g.id, g])),
  domains: new Map(mockDomains.map((d) => [d.id, d])),
  selectedIds: ['node-1'],
  hoveredId: null,
  editingId: null,
  canvasId: 1,
  canvasName: 'Test Canvas',
  isDirty: false,
  isLoading: false,
  zoom: 1,
  panX: 0,
  panY: 0,
  history: {
    commands: [],
    currentIndex: -1,
    maxHistorySize: 100,
    maxHistoryDays: 7,
  },
  setCanvasId: vi.fn(),
  setCanvasName: vi.fn(),
  addNode: vi.fn(),
  updateNode: vi.fn(),
  updateNodeWithoutHistory: vi.fn(),
  updateNodeWithOriginal: vi.fn(),
  removeNode: vi.fn(),
  addGroup: vi.fn(),
  updateGroup: vi.fn(),
  updateGroupWithoutHistory: vi.fn(),
  removeGroup: vi.fn(),
  addDomain: vi.fn(),
  updateDomain: vi.fn(),
  removeDomain: vi.fn(),
  addConnection: vi.fn(),
  updateConnection: vi.fn(),
  removeConnection: vi.fn(),
  addConnectionBendPoint: vi.fn(),
  updateConnectionBendPoint: vi.fn(),
  removeConnectionBendPoint: vi.fn(),
  setSelectedIds: vi.fn(),
  addToSelection: vi.fn(),
  removeFromSelection: vi.fn(),
  clearSelection: vi.fn(),
  setZoom: vi.fn(),
  setPan: vi.fn(),
  resetView: vi.fn(),
  fitViewToContent: vi.fn(),
  setEditingId: vi.fn(),
  setHoveredId: vi.fn(),
  setDirty: vi.fn(),
  executeCommand: vi.fn(),
  executeCommandWithoutHistory: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
  canUndo: () => false,
  canRedo: () => false,
  clearHistory: vi.fn(),
  setCanvasData: vi.fn(),
  clearCanvas: vi.fn(),
  duplicateNode: vi.fn(),
  moveNodeToPool: vi.fn(),
  moveNodeFromPool: vi.fn(),
})

vi.mock('@/store/useCanvasStore')
vi.mock('@/store/useUIStore')
vi.mock('@/store/useAuthStore')
vi.mock('@/store/useProjectsStore')
vi.mock('@/features/node-pool/stores/useNodePoolStore')
vi.mock('@/hooks/useCollaboration')
vi.mock('@/utils/canvas')
vi.mock('@/utils/fabric')
vi.mock('@/utils/nodeCache')
vi.mock('@/services/api')
vi.mock('@/services/collaboration')
vi.mock('@/constants')
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useParams: () => ({ canvasId: '1' }),
    useNavigate: () => vi.fn(),
  }
})

const mockedUseCanvasStore = vi.mocked(useCanvasStore) as any
const mockedUseUIStore = vi.mocked(useUIStore)
const mockedUseAuthStore = vi.mocked(useAuthStore)
const mockedUseProjectsStore = vi.mocked(useProjectsStore)

describe('CanvasPage Data Model', () => {
  beforeEach(() => {
    mockedUseCanvasStore.mockReturnValue(createMockStore())
    mockedUseUIStore.mockReturnValue({
      darkMode: false,
      sidebarOpen: false,
      nodePoolOpen: false,
      gridEnabled: true,
      snapToGrid: true,
      dragMode: 'free',
      rightPanelWidth: 320,
      rightPanelOpen: false,
      stylePanelType: null,
      stylePanelNodeId: null,
      stylePanelConnectionId: null,
      toast: null,
      toasts: [],
      contextMenu: null,
      selectedConnectionId: null,
      isConnectionSelected: false,
      setDarkMode: vi.fn(),
      toggleDarkMode: vi.fn(),
      openSidebar: vi.fn(),
      closeSidebar: vi.fn(),
      toggleSidebar: vi.fn(),
      openNodePool: vi.fn(),
      closeNodePool: vi.fn(),
      toggleNodePool: vi.fn(),
      setGridEnabled: vi.fn(),
      setSnapToGrid: vi.fn(),
      setDragMode: vi.fn(),
      openRightPanel: vi.fn(),
      closeRightPanel: vi.fn(),
      toggleRightPanel: vi.fn(),
      setRightPanelWidth: vi.fn(),
      setStylePanelType: vi.fn(),
      setStylePanelNodeId: vi.fn(),
      setStylePanelConnectionId: vi.fn(),
      showStylePanel: vi.fn(),
      hideStylePanel: vi.fn(),
      addToast: vi.fn(),
      dismissToast: vi.fn(),
      clearToasts: vi.fn(),
      updateToastProgress: vi.fn(),
      showContextMenu: vi.fn(),
      hideContextMenu: vi.fn(),
      showDomainContextMenu: vi.fn(),
      hideDomainContextMenu: vi.fn(),
      setSelectedConnectionId: vi.fn(),
      setIsConnectionSelected: vi.fn(),
      contextMenuPosition: null,
      contextMenuTargetId: null,
      contextMenuTargetType: null,
      connectionContextMenuPosition: null,
      connectionContextMenuTargetId: null,
      domainContextMenuPosition: null,
      domainContextMenuTargetId: null,
      nodeDefaults: {
        textNode: { width: 200, height: 160, fontSize: 14, titleAlign: 'left', collapsedTitleAlign: 'left', contentAlign: 'left', color: '#ffffff' },
        imageNode: { width: 200, height: 160, fontSize: 14, titleAlign: 'left', collapsedTitleAlign: 'left' },
      },
      setNodeDefaults: vi.fn(),
      resetNodeDefaults: vi.fn(),
    } as any)
    mockedUseAuthStore.mockReturnValue({
      user: { id: 1, email: 'test@test.com', nickname: 'Tester', avatar: null, createdAt: '', updatedAt: '' },
      token: 'mock-token',
      isLoading: false,
      error: null,
    } as any)
    mockedUseProjectsStore.mockReturnValue({
      loadProjects: vi.fn(),
      projects: [],
      folders: [],
      canvases: [],
      currentProject: null,
      currentCanvas: null,
    } as any)
  })

  it('should have correct canvas state from store mock', () => {
    const state = mockedUseCanvasStore()
    expect(state.nodes.size).toBe(2)
    expect(state.nodes.has('node-1')).toBe(true)
    expect(state.nodes.has('node-2')).toBe(true)
    expect(state.connections.size).toBe(1)
    expect(state.groups.size).toBe(1)
    expect(state.domains.size).toBe(1)
    expect(state.canvasId).toBe(1)
    expect(state.canvasName).toBe('Test Canvas')
    expect(state.selectedIds).toEqual(['node-1'])
  })

  it('should have nodes with correct properties', () => {
    const state = mockedUseCanvasStore()
    const node1 = state.nodes.get('node-1')
    expect(node1?.title).toBe('Root Node')
    expect(node1?.content).toBe('This is a root node')
    expect(node1?.x).toBe(400)
    expect(node1?.y).toBe(300)
    expect(node1?.width).toBe(200)
    expect(node1?.height).toBe(160)
  })

  it('should have connections with correct properties', () => {
    const state = mockedUseCanvasStore()
    const conn = state.connections.get('conn-1')
    expect(conn?.fromNodeId).toBe('node-1')
    expect(conn?.toNodeId).toBe('node-2')
    expect(conn?.type).toBe('curve')
    expect(conn?.arrowType).toBe('end')
  })

  it('should have correct view state', () => {
    const state = mockedUseCanvasStore()
    expect(state.zoom).toBe(1)
    expect(state.panX).toBe(0)
    expect(state.panY).toBe(0)
    expect(state.isDirty).toBe(false)
    expect(state.isLoading).toBe(false)
  })

  it('should invoke setSelectedIds action', () => {
    const state = mockedUseCanvasStore()
    state.setSelectedIds(['node-1', 'node-2'])
    expect(state.setSelectedIds).toHaveBeenCalledWith(['node-1', 'node-2'])
  })

  it('should invoke addNode action', () => {
    const state = mockedUseCanvasStore()
    const newNode: Node = {
      id: 'node-3',
      title: 'New Node',
      content: 'New content',
      x: 0, y: 0, width: 200, height: 160,
      fontSize: 14, textAlign: 'left',
      collapsed: false, locked: false,
    }
    state.addNode(newNode)
    expect(state.addNode).toHaveBeenCalledWith(newNode)
  })
})
