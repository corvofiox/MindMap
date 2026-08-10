import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasStore } from '../store/useCanvasStore'
import { executeToolCall, getToolsForAI } from '../services/aiTools'
import type { Node } from '../types'

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

function resetStore() {
  // 与 useCanvasStore.test.ts 相同的初始状态
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
}

describe('AI tools (aiTools.ts)', () => {
  beforeEach(() => {
    resetStore()
  })

  it('createNode 缺少 title 时返回失败且不创建节点', async () => {
    const result = await executeToolCall('createNode', { x: 10, y: 10 })
    expect(result.success).toBe(false)
    expect(result.error).toContain('缺少节点标题')
    expect(useCanvasStore.getState().nodes.size).toBe(0)
  })

  it('createNode 成功后返回 nodeId', async () => {
    const result = await executeToolCall('createNode', { title: 'Hello' })
    expect(result.success).toBe(true)
    const data = result.data as { nodeId: string }
    expect(data.nodeId).toMatch(/^node-/)
    expect(useCanvasStore.getState().nodes.has(data.nodeId)).toBe(true)
  })

  it('updateNode 不存在节点时返回失败(不再静默成功)', async () => {
    const result = await executeToolCall('updateNode', { nodeId: 'n-missing', title: 'X' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('节点不存在')
  })

  it('createConnection 引用不存在节点时返回失败', async () => {
    const created = await executeToolCall('createNode', { title: 'A' })
    const nodeId = (created.data as { nodeId: string }).nodeId
    const result = await executeToolCall('createConnection', {
      fromNodeId: nodeId,
      toNodeId: 'n-missing',
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('节点不存在')
  })

  it('searchNodes 标题命中与无命中', async () => {
    await executeToolCall('createNode', { title: 'Alpha Plan', content: 'details here' })
    const hit = await executeToolCall('searchNodes', { query: 'alpha' })
    expect(hit.success).toBe(true)
    const matches = (hit.data as { matches: Array<{ title: string; match: string; snippet: string }> }).matches
    expect(matches.length).toBe(1)
    expect(matches[0].title).toBe('Alpha Plan')
    expect(matches[0].match).toBe('title')
    expect(matches[0].snippet.length).toBeGreaterThan(0)

    const miss = await executeToolCall('searchNodes', { query: 'zzz-not-exist' })
    expect(miss.success).toBe(true)
    expect((miss.data as { matches: unknown[] }).matches).toEqual([])
  })

  it('searchNodes 按 content 范围匹配', async () => {
    await executeToolCall('createNode', { title: 'Alpha Plan', content: 'Quarterly roadmap' })
    const result = await executeToolCall('searchNodes', { query: 'roadmap', scope: 'content' })
    expect(result.success).toBe(true)
    const matches = (result.data as { matches: Array<{ match: string }> }).matches
    expect(matches.length).toBe(1)
    expect(matches[0].match).toBe('content')
  })

  it('batchUpdateNodes 部分节点不存在时跳过并记录', async () => {
    const a = await executeToolCall('createNode', { title: 'A' })
    const b = await executeToolCall('createNode', { title: 'B' })
    const idA = (a.data as { nodeId: string }).nodeId
    const idB = (b.data as { nodeId: string }).nodeId

    const result = await executeToolCall('batchUpdateNodes', {
      nodeIds: [idA, idB, 'n-missing'],
      title: 'Renamed',
      color: '#ff0000',
    })
    expect(result.success).toBe(true)
    const data = result.data as { updated: number; skipped: string[] }
    expect(data.updated).toBe(2)
    expect(data.skipped).toEqual(['n-missing'])
    expect(useCanvasStore.getState().nodes.get(idA)?.title).toBe('Renamed')
    expect(useCanvasStore.getState().nodes.get(idB)?.title).toBe('Renamed')
  })

  it('batchUpdateNodes 全部节点不存在时返回失败', async () => {
    const result = await executeToolCall('batchUpdateNodes', { nodeIds: ['n-x', 'n-y'], title: 'X' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('所有节点均不存在')
  })

  it('undo/redo 工具可撤销与重做,无历史时返回错误', async () => {
    const created = await executeToolCall('createNode', { title: 'A' })
    const nodeId = (created.data as { nodeId: string }).nodeId
    expect(useCanvasStore.getState().nodes.has(nodeId)).toBe(true)

    const undo = await executeToolCall('undo', {})
    expect(undo.success).toBe(true)
    expect(useCanvasStore.getState().nodes.has(nodeId)).toBe(false)

    const redo = await executeToolCall('redo', {})
    expect(redo.success).toBe(true)
    expect(useCanvasStore.getState().nodes.has(nodeId)).toBe(true)

    const redoAgain = await executeToolCall('redo', {})
    expect(redoAgain.success).toBe(false)
    expect(redoAgain.error).toContain('没有可重做的操作')
  })

  it('getToolsForAI: ID 参数进 required,nullable 字段输出 anyOf', () => {
    const tools = getToolsForAI(false)
    const updateNodeTool = tools.find((t) => t.function.name === 'updateNode')
    expect(updateNodeTool).toBeDefined()
    const params = updateNodeTool!.function.parameters
    expect(params.required).toContain('nodeId')
    const props = params.properties as Record<string, Record<string, unknown>>
    // nullable 字段输出 anyOf
    expect(Array.isArray(props.title.anyOf)).toBe(true)
    const anyOf = props.title.anyOf as Array<Record<string, unknown>>
    expect(anyOf[0].type).toBe('string')
    expect(anyOf[1].type).toBe('null')
    // description 保留在外层
    expect(props.title.description).toBe('新的节点标题')
    // 非 nullable 字段保持原结构
    expect(props.nodeId.anyOf).toBeUndefined()
    expect(props.nodeId.type).toBe('string')
  })
})
