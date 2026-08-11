import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { SearchPanel } from '../SearchPanel'
import { useUIStore } from '@/store/useUIStore'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useProjectsStore } from '@/store/useProjectsStore'
import type { Node, Canvas } from '@/types'

function makeNode(id: string, title: string, content = ''): Node {
  return {
    id,
    x: 100,
    y: 100,
    width: 200,
    height: 100,
    title,
    content,
    fontSize: 14,
    textAlign: 'left',
    collapsed: false,
    locked: false,
  }
}

function makeCanvas(id: number, name: string): Canvas {
  return {
    id,
    name,
    projectId: 1,
    folderId: null,
    thumbnail: null,
    sortOrder: 0,
    createdAt: '',
    updatedAt: '',
  }
}

function openPanel() {
  useUIStore.setState({ searchOpen: true })
  render(
    <MemoryRouter>
      <LocationProbe />
      <SearchPanel />
    </MemoryRouter>
  )
}

let capturedPath = ''
function LocationProbe() {
  capturedPath = useLocation().pathname
  return null
}

describe('SearchPanel 真实搜索', () => {
  beforeEach(() => {
    capturedPath = ''
    useUIStore.setState({ searchOpen: false })
    useCanvasStore.setState({ nodes: new Map(), zoom: 1, panX: 0, panY: 0, selectedIds: [] })
    useProjectsStore.setState({ canvases: [], currentProject: null, currentProjectId: null })
  })

  afterEach(() => {
    cleanup()
    useUIStore.setState({ searchOpen: false })
  })

  it('按画布名搜索返回结果,点击跳转到对应画布路由', () => {
    useProjectsStore.setState({
      canvases: [makeCanvas(5, '产品规划'), makeCanvas(6, '技术架构')],
    })
    openPanel()

    fireEvent.change(screen.getByPlaceholderText('Search across all canvases...'), {
      target: { value: '产品' },
    })

    expect(screen.getByText('产品规划')).toBeInTheDocument()
    expect(screen.queryByText('技术架构')).toBeNull()

    fireEvent.click(screen.getByText('产品规划'))
    expect(capturedPath).toBe('/canvas/5')
  })

  it('按节点标题/内容搜索返回结果,点击跳转并选中节点', () => {
    useCanvasStore.setState({
      nodes: new Map([
        ['n1', makeNode('n1', '需求分析', '包含核心需求列表')],
        ['n2', makeNode('n2', '架构设计', '')],
      ]),
      zoom: 2,
      panX: 10,
      panY: 10,
      selectedIds: [],
    })
    openPanel()

    fireEvent.change(screen.getByPlaceholderText('Search across all canvases...'), {
      target: { value: '需求' },
    })

    expect(screen.getByText('需求分析')).toBeInTheDocument()
    expect(screen.queryByText('架构设计')).toBeNull()

    fireEvent.click(screen.getByText('需求分析'))

    const state = useCanvasStore.getState()
    expect(state.selectedIds).toEqual(['n1'])
    expect(state.zoom).toBe(1)
    // 节点中心 (200,150),jsdom 无容器 → 回退 window 尺寸 → 平移居中
    expect(state.panX).toBe(window.innerWidth / 2 - 200)
    expect(state.panY).toBe(window.innerHeight / 2 - 150)
  })

  it('无匹配时显示空态', () => {
    useProjectsStore.setState({ canvases: [makeCanvas(5, '产品规划')] })
    openPanel()

    fireEvent.change(screen.getByPlaceholderText('Search across all canvases...'), {
      target: { value: '不存在的关键字' },
    })

    expect(screen.getByText('未找到匹配的画布或节点')).toBeInTheDocument()
  })

  it('搜索内容字段也能命中节点', () => {
    useCanvasStore.setState({
      nodes: new Map([['n1', makeNode('n1', '标题A', '正文里有关键词X')]]),
    })
    openPanel()

    fireEvent.change(screen.getByPlaceholderText('Search across all canvases...'), {
      target: { value: '关键词X' },
    })

    expect(screen.getByText('标题A')).toBeInTheDocument()
  })
})

describe('m-1 批量高亮协议', () => {
  beforeEach(() => {
    useUIStore.setState({ searchOpen: false })
    useCanvasStore.setState({ nodes: new Map(), zoom: 1, panX: 0, panY: 0, selectedIds: [] })
    useProjectsStore.setState({ canvases: [], currentProject: null, currentProjectId: null })
  })

  afterEach(() => {
    cleanup()
    useUIStore.setState({ searchOpen: false })
  })

  it('多结果匹配:单次事件携带全部匹配 nodeId(批量协议,不逐条覆盖)', () => {
    useCanvasStore.setState({
      nodes: new Map([
        ['n1', makeNode('n1', '需求分析', '')],
        ['n2', makeNode('n2', '需求评审', '')],
        ['n3', makeNode('n3', '架构设计', '')],
      ]),
    })
    const dispatched: Array<{ nodeId: string | null; nodeIds?: string[]; keywords: string[] }> = []
    const spy = (e: Event) => {
      dispatched.push((e as CustomEvent).detail)
    }
    window.addEventListener('nodeSearchHighlight', spy)
    openPanel()
    fireEvent.change(screen.getByPlaceholderText('Search across all canvases...'), {
      target: { value: '需求' },
    })
    // 批量事件:一次派发携带全部命中 id
    const batch = dispatched.find((d) => Array.isArray(d.nodeIds))
    expect(batch).toBeDefined()
    expect([...(batch?.nodeIds ?? [])].sort()).toEqual(['n1', 'n2'])
    window.removeEventListener('nodeSearchHighlight', spy)
  })

  it('查询词无匹配结果时派发清除事件(旧高亮不残留)', () => {
    useCanvasStore.setState({
      nodes: new Map([['n1', makeNode('n1', '需求分析', '')]]),
    })
    const dispatched: Array<{ nodeId: string | null; nodeIds?: string[] }> = []
    const spy = (e: Event) => {
      dispatched.push((e as CustomEvent).detail)
    }
    window.addEventListener('nodeSearchHighlight', spy)
    openPanel()
    // 先命中再输入无匹配词
    fireEvent.change(screen.getByPlaceholderText('Search across all canvases...'), {
      target: { value: '需求' },
    })
    fireEvent.change(screen.getByPlaceholderText('Search across all canvases...'), {
      target: { value: '不存在的词' },
    })
    const last = dispatched[dispatched.length - 1]
    expect(last.nodeId).toBeNull()
    expect(last.nodeIds).toBeUndefined()
    window.removeEventListener('nodeSearchHighlight', spy)
  })
})
