import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasStore } from '../store/useCanvasStore'
import type { Node, NodeGroup, Domain, Connection } from '../types'
import { compareNodeZIndex, nextZIndexAbove, NODE_Z_STEP } from '@shared/z-order'

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

    it('should apply viewState and clear transient UI states on bulk load', () => {
      useCanvasStore.getState().addNode(createTestNode('n1'))
      useCanvasStore.getState().setSelectedIds(['n1'])
      useCanvasStore.getState().setHoveredId('n1')
      useCanvasStore.getState().setEditingId('n1')

      useCanvasStore.getState().setCanvasData(
        { nodes: [createTestNode('n2')], groups: [], domains: [], connections: [] },
        { zoom: 1.5, panX: 100, panY: 200 },
      )

      const state = useCanvasStore.getState()
      expect(state.nodes.size).toBe(1)
      expect(state.nodes.has('n2')).toBe(true)
      expect(state.selectedIds).toEqual([])
      expect(state.hoveredId).toBeNull()
      expect(state.editingId).toBeNull()
      expect(state.zoom).toBe(1.5)
      expect(state.panX).toBe(100)
      expect(state.panY).toBe(200)
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

    it('should import canvas data in single-user mode', () => {
      const nodes = [createTestNode('n1')]
      const groups: NodeGroup[] = []
      const domains: Domain[] = []
      const connections: Connection[] = []

      const result = useCanvasStore.getState().importCanvasData(
        { nodes, groups, domains, connections },
        { zoom: 1.2, panX: 50, panY: 60 },
      )

      expect(result).toBe(true)
      const state = useCanvasStore.getState()
      expect(state.nodes.size).toBe(1)
      expect(state.nodes.has('n1')).toBe(true)
      expect(state.zoom).toBe(1.2)
      expect(state.panX).toBe(50)
      expect(state.panY).toBe(60)
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

  describe('M5: clearCanvas history reset + canvasId ownership', () => {
    it('clearCanvas clears undo/redo history', () => {
      const store = useCanvasStore.getState()
      store.addNode(createTestNode('n1'))
      store.addNode(createTestNode('n2'))
      expect(useCanvasStore.getState().history.commands.length).toBe(2)

      store.clearCanvas()

      const state = useCanvasStore.getState()
      expect(state.history.commands.length).toBe(0)
      expect(state.history.currentIndex).toBe(-1)
    })

    it('undo skips commands stamped for a different canvasId', async () => {
      useCanvasStore.setState({ canvasId: 1 })
      useCanvasStore.getState().addNode(createTestNode('n1'))
      useCanvasStore.setState({ canvasId: 2 })
      useCanvasStore.getState().clearCanvas()
      expect(useCanvasStore.getState().history.commands.length).toBe(0)

      // 新画布下执行一条命令，再切到第三个画布尝试 undo——命令属于
      // canvasId=2，当前 canvasId=3 → 归属校验跳过，节点不得被误删。
      useCanvasStore.getState().addNode(createTestNode('n2'))
      useCanvasStore.setState({ canvasId: 3 })
      await useCanvasStore.getState().undo()
      expect(useCanvasStore.getState().nodes.has('n2')).toBe(true)

      // 切回 canvasId=2 后可正常 undo
      useCanvasStore.setState({ canvasId: 2 })
      await useCanvasStore.getState().undo()
      expect(useCanvasStore.getState().nodes.has('n2')).toBe(false)
    })
  })

  describe('M6: deleteEntitiesByIds batch delete', () => {
    it('removes nodes, attached connections and other entities in a single history command', async () => {
      const store = useCanvasStore.getState()
      store.addNode(createTestNode('n1'))
      store.addNode(createTestNode('n2'))
      store.addConnection({ id: 'c1', fromNodeId: 'n1', toNodeId: 'n2' } as unknown as Connection)
      const before = useCanvasStore.getState().history.commands.length // 3

      useCanvasStore.getState().deleteEntitiesByIds(['n1', 'c1'])

      let state = useCanvasStore.getState()
      expect(state.nodes.has('n1')).toBe(false)
      expect(state.connections.has('c1')).toBe(false)
      expect(state.nodes.has('n2')).toBe(true)
      // 整批删除只产生一条历史命令
      expect(state.history.commands.length).toBe(before + 1)

      await useCanvasStore.getState().undo()
      state = useCanvasStore.getState()
      expect(state.nodes.has('n1')).toBe(true)
      expect(state.connections.has('c1')).toBe(true)
    })

    it('deleteEntitiesByIds on empty selection is a no-op', () => {
      useCanvasStore.getState().deleteEntitiesByIds([])
      expect(useCanvasStore.getState().history.commands.length).toBe(0)
    })
  })

  describe('organizeConnections（优化连线，工具栏按钮 + O 快捷键共用）', () => {
    function makeConn(id: string, from: string, to: string, overrides?: Partial<Connection>): Connection {
      return {
        id,
        fromNodeId: from,
        toNodeId: to,
        fromPort: 'right',
        toPort: 'left',
        type: 'straight',
        style: 'solid',
        color: '#3b82f6',
        width: 2,
        arrowType: 'end',
        direction: 'directed',
        ...overrides,
      } as Connection
    }

    it('按相对方位更新端口且整批只产生一条历史命令', () => {
      const store = useCanvasStore.getState()
      // A(100,100) B 在 A 正右方 (500,100)：right→left 已最优。
      store.addNode(createTestNode('a', { x: 100, y: 100 }))
      store.addNode(createTestNode('b', { x: 500, y: 100 }))
      // C 在 A 正下方 (100,500)：最优 bottom→top。
      store.addNode(createTestNode('c', { x: 100, y: 500 }))
      store.addConnection(makeConn('c1', 'a', 'b')) // 已最优
      store.addConnection(makeConn('c2', 'a', 'c', { fromPort: 'right', toPort: 'left' })) // 需调整
      const before = useCanvasStore.getState().history.commands.length // 3

      const result = useCanvasStore.getState().organizeConnections()

      expect(result.organized).toBe(1)
      expect(result.skippedBendPoints).toBe(0)
      const state = useCanvasStore.getState()
      // c1 不动；c2 调整为 bottom→top。
      expect(state.connections.get('c1')?.fromPort).toBe('right')
      expect(state.connections.get('c2')?.fromPort).toBe('bottom')
      expect(state.connections.get('c2')?.toPort).toBe('top')
      // 整批一条历史命令（M6 先例）。
      expect(state.history.commands.length).toBe(before + 1)

      // 一次撤销恢复全部旧端口。
      useCanvasStore.getState().undo()
      const undone = useCanvasStore.getState().connections.get('c2')
      expect(undone?.fromPort).toBe('right')
      expect(undone?.toPort).toBe('left')
    })

    it('带弯折点的连线跳过不碰并在结果中报告', () => {
      const store = useCanvasStore.getState()
      // A 正上方有 B：无弯折点连线会被调为 top→bottom。
      store.addNode(createTestNode('a', { x: 100, y: 100 }))
      store.addNode(createTestNode('b', { x: 100, y: -300 }))
      store.addConnection(makeConn('free1', 'a', 'b', { fromPort: 'right', toPort: 'left' }))
      store.addConnection(
        makeConn('bent1', 'a', 'b', {
          fromPort: 'right',
          toPort: 'left',
          bendPoints: [{ id: 'bp1', x: 300, y: 50 }],
        }),
      )

      const result = useCanvasStore.getState().organizeConnections()

      expect(result.organized).toBe(1)
      expect(result.skippedBendPoints).toBe(1)
      const state = useCanvasStore.getState()
      // 弯折点连线保持原样——手工定制不被优化覆盖。
      expect(state.connections.get('bent1')?.fromPort).toBe('right')
      expect(state.connections.get('bent1')?.toPort).toBe('left')
      // 无弯折点的照常调整。
      expect(state.connections.get('free1')?.fromPort).toBe('top')
    })

    it('全部已最优时不产生历史命令', () => {
      const store = useCanvasStore.getState()
      store.addNode(createTestNode('a', { x: 100, y: 100 }))
      store.addNode(createTestNode('b', { x: 500, y: 100 }))
      store.addConnection(makeConn('c1', 'a', 'b')) // right→left 已最优
      const before = useCanvasStore.getState().history.commands.length

      const result = useCanvasStore.getState().organizeConnections()

      expect(result.organized).toBe(0)
      expect(useCanvasStore.getState().history.commands.length).toBe(before)
    })

    it('悬空连线（端点节点缺失）被静默跳过', () => {
      const store = useCanvasStore.getState()
      store.addNode(createTestNode('a', { x: 100, y: 100 }))
      store.addConnection(makeConn('ghost', 'a', 'missing-node', { fromPort: 'right', toPort: 'left' }))

      const result = useCanvasStore.getState().organizeConnections()

      expect(result.organized).toBe(0)
      expect(useCanvasStore.getState().connections.get('ghost')?.fromPort).toBe('right')
    })
  })

describe('统一节点（老形态在入口处折算）', () => {
    const SHA = 'f'.repeat(64)

    it('addNode 收到老形态：type/imageUrl/aspectRatio 折成 content/cover', () => {
      useCanvasStore.getState().addNode(
        createTestNode('legacy', {
          type: 'image',
          imageUrl: `/api/files/${SHA}`,
          aspectRatio: 1.5,
          content: '',
        }),
      )

      const node = useCanvasStore.getState().nodes.get('legacy')!
      expect(node.type).toBeUndefined()
      expect(node.imageUrl).toBeUndefined()
      expect(node.aspectRatio).toBeUndefined()
      expect(node.content).toBe(`<img src="/api/files/${SHA}" alt="">`)
      expect(node.cover).toBe(`/api/files/${SHA}`)
    })

    it('远端更新（updateNodeWithoutHistory）也会归一化', () => {
      const store = useCanvasStore.getState()
      store.addNode(createTestNode('n1', { content: '<p>已有正文</p>' }))

      store.updateNodeWithoutHistory('n1', {
        type: 'image',
        imageUrl: `/api/files/${SHA}`,
      })

      const node = useCanvasStore.getState().nodes.get('n1')!
      expect(node.type).toBeUndefined()
      expect(node.imageUrl).toBeUndefined()
      expect(node.content).toBe('<p>已有正文</p>')
      expect(node.cover).toBe(`/api/files/${SHA}`)
    })
  })
  describe('节点层序 (zIndex)', () => {
    const zOf = (id: string) => useCanvasStore.getState().nodes.get(id)?.zIndex
    const sortedIds = () =>
      [...useCanvasStore.getState().nodes.values()].sort(compareNodeZIndex).map((n) => n.id)

    it('新建节点依次叠加在最上层', () => {
      const store = useCanvasStore.getState()
      store.addNode(createTestNode('a'))
      store.addNode(createTestNode('b'))

      const za = zOf('a')
      const zb = zOf('b')
      expect(za).toBe(NODE_Z_STEP)
      expect(zb).toBeGreaterThan(za as number)
      expect(sortedIds()).toEqual(['a', 'b'])
    })

    it('显式传入的层序原样保留', () => {
      useCanvasStore.getState().addNode(createTestNode('a', { zIndex: 42 }))
      expect(zOf('a')).toBe(42)
    })

    it('从卡片池拖入的节点同样落在最上层', () => {
      const store = useCanvasStore.getState()
      store.addNode(createTestNode('a'))
      store.moveNodeFromPool(createTestNode('pooled'))

      expect(zOf('pooled')).toBeGreaterThan(zOf('a') as number)
      expect(sortedIds()).toEqual(['a', 'pooled'])
    })

    it('复制出的节点压在原节点之上', () => {
      const store = useCanvasStore.getState()
      store.addNode(createTestNode('a'))
      store.addNode(createTestNode('b'))
      store.duplicateNode('a')

      const copy = [...useCanvasStore.getState().nodes.values()].find((n) =>
        n.id.startsWith('a-copy-'),
      )
      expect(copy).toBeDefined()
      expect(copy?.zIndex).toBeGreaterThan(zOf('b') as number)
      expect(sortedIds().at(-1)).toBe(copy?.id)
    })

    it('bringNodeToFront / sendNodeToBack 改变层序，对不存在的节点安全无操作', () => {
      const store = useCanvasStore.getState()
      store.addNode(createTestNode('a'))
      store.addNode(createTestNode('b'))
      store.addNode(createTestNode('c'))

      useCanvasStore.getState().bringNodeToFront('a')
      expect(sortedIds()).toEqual(['b', 'c', 'a'])

      useCanvasStore.getState().sendNodeToBack('c')
      expect(sortedIds()).toEqual(['c', 'b', 'a'])

      // 不存在的节点：不改状态、不写历史（菜单可能对已删除的节点触发）
      const historyBefore = useCanvasStore.getState().history.commands.length
      useCanvasStore.getState().bringNodeToFront('ghost')
      expect(useCanvasStore.getState().history.commands.length).toBe(historyBefore)
      expect(sortedIds()).toEqual(['c', 'b', 'a'])
    })

    it('置顶写入 zIndex：会置 dirty、可撤销、可重做', async () => {
      const store = useCanvasStore.getState()
      store.addNode(createTestNode('a'))
      store.addNode(createTestNode('b'))
      const originalZ = zOf('a')
      const historyBefore = useCanvasStore.getState().history.commands.length

      // 清掉 addNode 造成的 dirty，单独观察这次层序变更
      useCanvasStore.setState({ isDirty: false })
      store.updateNode('a', { zIndex: nextZIndexAbove(useCanvasStore.getState().nodes.values()) })

      expect(zOf('a')).toBeGreaterThan(zOf('b') as number)
      expect(sortedIds()).toEqual(['b', 'a'])
      // 层序是普通字段：必须进历史、必须置 dirty（旧实现刻意两者都不做）
      expect(useCanvasStore.getState().history.commands.length).toBe(historyBefore + 1)
      expect(useCanvasStore.getState().isDirty).toBe(true)

      await useCanvasStore.getState().undo()
      expect(zOf('a')).toBe(originalZ)
      expect(sortedIds()).toEqual(['a', 'b'])

      await useCanvasStore.getState().redo()
      expect(zOf('a')).toBeGreaterThan(zOf('b') as number)
    })

    it('撤销新增后重做，节点沿用最初的层序而不是重新取最大值', async () => {
      const store = useCanvasStore.getState()
      store.addNode(createTestNode('a'))
      store.addNode(createTestNode('b'))
      const originalZ = zOf('b')

      await useCanvasStore.getState().undo() // 移除 b

      // 模拟协作者在此期间插入了一个层序很高的节点（不进本地历史）
      useCanvasStore.setState((state) => {
        const nodes = new Map(state.nodes)
        nodes.set('remote', createTestNode('remote', { zIndex: 9000 }))
        return { nodes }
      })

      await useCanvasStore.getState().redo()

      // 若重做时重新计算 max+STEP，b 会变成 10000；正确行为是还原 2000 量级
      expect(zOf('b')).toBe(originalZ)
      expect(zOf('b')).toBeLessThan(zOf('remote') as number)
    })

    it('旧画布缺省层序的节点保持原有相对顺序', () => {
      // 直接注入没有任何 zIndex 的节点，模拟升级前的存量画布
      useCanvasStore.setState({
        nodes: new Map([
          ['legacy-1', createTestNode('legacy-1')],
          ['legacy-2', createTestNode('legacy-2')],
        ]),
      })
      expect(sortedIds()).toEqual(['legacy-1', 'legacy-2'])

      useCanvasStore.getState().addNode(createTestNode('fresh'))
      // 新节点一定在旧节点之上
      expect(sortedIds()).toEqual(['legacy-1', 'legacy-2', 'fresh'])
    })
  })
})
