import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasStore } from '../store/useCanvasStore'
import type { Node, NodeGroup, Domain, Connection } from '../types'

function createTestNode(id: string, overrides?: Partial<Node>): Node {
  return {
    id,
    x: 100,
    y: 100,
    width: 200,
    height: 160,
    title: `Node ${id}`,
    content: `Content ${id}`,
    fontSize: 14,
    textAlign: 'left',
    collapsed: false,
    locked: false,
    ...overrides,
  }
}

describe('useCanvasStore', () => {
  beforeEach(() => {
    // Reset store to initial state before each test
    useCanvasStore.setState({
      nodes: new Map(),
      groups: new Map(),
      domains: new Map(),
      connections: new Map(),
      selectedIds: [],
      hoveredId: null,
      editingId: null,
      canvasId: null,
      canvasName: null,
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
    })
  })

  describe('Node operations', () => {
    it('should add a node', () => {
      const node = createTestNode('n1')
      useCanvasStore.getState().addNode(node)
      const state = useCanvasStore.getState()
      expect(state.nodes.has('n1')).toBe(true)
      expect(state.nodes.get('n1')?.title).toBe('Node n1')
      expect(state.isDirty).toBe(true)
    })

    it('should update a node', () => {
      const node = createTestNode('n1')
      useCanvasStore.getState().addNode(node)
      useCanvasStore.getState().updateNode('n1', { title: 'Updated Title', x: 200 })
      const updated = useCanvasStore.getState().nodes.get('n1')
      expect(updated?.title).toBe('Updated Title')
      expect(updated?.x).toBe(200)
    })

    it('should remove a node', () => {
      const node = createTestNode('n1')
      useCanvasStore.getState().addNode(node)
      useCanvasStore.getState().removeNode('n1')
      expect(useCanvasStore.getState().nodes.has('n1')).toBe(false)
    })

    it('should update node without history (no undo)', () => {
      const node = createTestNode('n1')
      useCanvasStore.getState().addNode(node)
      useCanvasStore.getState().updateNodeWithoutHistory('n1', { x: 999 })
      const updated = useCanvasStore.getState().nodes.get('n1')
      expect(updated?.x).toBe(999)
    })
  })

  describe('Undo/Redo', () => {
    it('should undo last addNode', () => {
      const node = createTestNode('n1')
      useCanvasStore.getState().addNode(node)
      expect(useCanvasStore.getState().nodes.has('n1')).toBe(true)

      useCanvasStore.getState().undo()
      expect(useCanvasStore.getState().nodes.has('n1')).toBe(false)
    })

    it('should redo after undo', () => {
      const node = createTestNode('n1')
      useCanvasStore.getState().addNode(node)
      useCanvasStore.getState().undo()
      expect(useCanvasStore.getState().nodes.has('n1')).toBe(false)

      useCanvasStore.getState().redo()
      expect(useCanvasStore.getState().nodes.has('n1')).toBe(true)
    })

    it('should track canUndo / canRedo state', () => {
      expect(useCanvasStore.getState().canUndo()).toBe(false)
      expect(useCanvasStore.getState().canRedo()).toBe(false)

      useCanvasStore.getState().addNode(createTestNode('n1'))
      expect(useCanvasStore.getState().canUndo()).toBe(true)
      expect(useCanvasStore.getState().canRedo()).toBe(false)

      useCanvasStore.getState().undo()
      expect(useCanvasStore.getState().canUndo()).toBe(false)
      expect(useCanvasStore.getState().canRedo()).toBe(true)
    })

    it('should undo updateNode', () => {
      const node = createTestNode('n1', { x: 100 })
      useCanvasStore.getState().addNode(node)
      useCanvasStore.getState().updateNode('n1', { x: 500 })

      expect(useCanvasStore.getState().nodes.get('n1')?.x).toBe(500)

      useCanvasStore.getState().undo()
      expect(useCanvasStore.getState().nodes.get('n1')?.x).toBe(100)
    })

    it('should undo removeNode', () => {
      const node = createTestNode('n1')
      useCanvasStore.getState().addNode(node)
      useCanvasStore.getState().removeNode('n1')
      expect(useCanvasStore.getState().nodes.has('n1')).toBe(false)

      useCanvasStore.getState().undo()
      expect(useCanvasStore.getState().nodes.has('n1')).toBe(true)
    })
  })

  describe('Selection', () => {
    it('should select nodes', () => {
      useCanvasStore.getState().setSelectedIds(['n1', 'n2'])
      expect(useCanvasStore.getState().selectedIds).toEqual(['n1', 'n2'])
    })

    it('should add to selection', () => {
      useCanvasStore.getState().setSelectedIds(['n1'])
      useCanvasStore.getState().addToSelection('n2')
      expect(useCanvasStore.getState().selectedIds).toEqual(['n1', 'n2'])
    })

    it('should remove from selection', () => {
      useCanvasStore.getState().setSelectedIds(['n1', 'n2', 'n3'])
      useCanvasStore.getState().removeFromSelection('n2')
      expect(useCanvasStore.getState().selectedIds).toEqual(['n1', 'n3'])
    })

    it('should clear selection', () => {
      useCanvasStore.getState().setSelectedIds(['n1', 'n2'])
      useCanvasStore.getState().clearSelection()
      expect(useCanvasStore.getState().selectedIds).toEqual([])
    })
  })

  describe('View operations', () => {
    it('should set zoom', () => {
      useCanvasStore.getState().setZoom(1.5)
      expect(useCanvasStore.getState().zoom).toBe(1.5)
    })

    it('should set pan', () => {
      useCanvasStore.getState().setPan(100, 200)
      expect(useCanvasStore.getState().panX).toBe(100)
      expect(useCanvasStore.getState().panY).toBe(200)
    })

    it('should reset view', () => {
      useCanvasStore.getState().setZoom(2)
      useCanvasStore.getState().setPan(300, 400)
      useCanvasStore.getState().resetView()
      expect(useCanvasStore.getState().zoom).toBe(1)
      expect(useCanvasStore.getState().panX).toBe(0)
      expect(useCanvasStore.getState().panY).toBe(0)
    })
  })

  describe('Canvas data', () => {
    it('should set canvas ID and name', () => {
      useCanvasStore.getState().setCanvasId(42)
      useCanvasStore.getState().setCanvasName('My Canvas')
      expect(useCanvasStore.getState().canvasId).toBe(42)
      expect(useCanvasStore.getState().canvasName).toBe('My Canvas')
    })

    it('should set bulk canvas data', () => {
      const nodes = [createTestNode('n1'), createTestNode('n2')]
      const groups: NodeGroup[] = []
      const domains: Domain[] = []
      const connections: Connection[] = []

      useCanvasStore.getState().setCanvasData({ nodes, groups, domains, connections })

      const state = useCanvasStore.getState()
      expect(state.nodes.size).toBe(2)
      expect(state.nodes.has('n1')).toBe(true)
      expect(state.nodes.has('n2')).toBe(true)
    })

    it('should clear canvas', () => {
      useCanvasStore.getState().addNode(createTestNode('n1'))
      useCanvasStore.getState().setSelectedIds(['n1'])
      useCanvasStore.getState().setDirty(true)

      useCanvasStore.getState().clearCanvas()

      const state = useCanvasStore.getState()
      expect(state.nodes.size).toBe(0)
      expect(state.selectedIds).toEqual([])
      expect(state.isDirty).toBe(false)
    })
  })

  describe('Dirty state', () => {
    it('should track dirty state', () => {
      useCanvasStore.getState().setDirty(true)
      expect(useCanvasStore.getState().isDirty).toBe(true)
      useCanvasStore.getState().setDirty(false)
      expect(useCanvasStore.getState().isDirty).toBe(false)
    })
  })

  describe('History limit', () => {
    it('should not exceed max history size (100 commands)', () => {
      const store = useCanvasStore.getState()
      for (let i = 0; i < 110; i++) {
        store.addNode(createTestNode(`n${i}`))
      }
      const state = useCanvasStore.getState()
      expect(state.history.commands.length).toBeLessThanOrEqual(state.history.maxHistorySize)
    })
  })
})
