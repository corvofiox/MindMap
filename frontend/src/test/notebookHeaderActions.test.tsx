/**
 * 笔记本顶栏的页面级动作。
 *
 * 这几条都是返工过的点，坏掉的话用户会立刻感觉到：
 *   - 「从节点池导入」「送入节点池」「思维导图」「设置」「账号」必须在同一条顶栏里，
 *     且从左到右就是这个顺序（早期版本把动作塞进了纸张，后来又挤到侧栏）；
 *   - 「送入节点池」只在打开了手稿时才出现；
 *   - 「思维导图」回的是项目列表 /projects（主页就是它，不是笔记本）；
 *   - 搜索框的输入真的会带 q 去查服务端，而不是只在本地过滤。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

vi.mock('@/services/api', async () => {
  const actual = await vi.importActual<typeof import('@/services/api')>('@/services/api')
  return {
    ...actual,
    getManuscripts: vi.fn(async () => [
      { id: 1, folderId: null, title: '第一篇', previewText: '预览一', imageCount: 0, createdAt: 0, updatedAt: 0 },
    ]),
    getManuscript: vi.fn(async (id: number) => ({
      id,
      folderId: null,
      title: '第一篇',
      previewText: '正文',
      imageCount: 0,
      createdAt: 0,
      updatedAt: 0,
      contentHtml: '<p>正文</p>',
      sourceCardId: null,
    })),
    createManuscript: vi.fn(),
    updateManuscript: vi.fn(async (id: number, patch: Record<string, unknown>) => ({
      id,
      folderId: null,
      title: 'T',
      previewText: '',
      imageCount: 0,
      createdAt: 0,
      updatedAt: 0,
      contentHtml: '',
      sourceCardId: null,
      ...patch,
    })),
    deleteManuscript: vi.fn(async (id: number) => ({ id })),
    manuscriptToNodeCard: vi.fn(async () => ({ id: 77, name: '第一篇' })),
    nodeCardToManuscript: vi.fn(),
    getManuscriptFolders: vi.fn(async () => []),
    createManuscriptFolder: vi.fn(),
    deleteManuscriptFolder: vi.fn(async (id: number) => ({ id })),
    getNodePool: vi.fn(async () => []),
  }
})

const api = await import('@/services/api')
const { NotebookPage } = await import('@/pages/NotebookPage')
const { useNotebookStore } = await import('@/store/useNotebookStore')
const { useUIStore } = await import('@/store/useUIStore')

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="location">{location.pathname}</span>
}

function renderPage(path = '/notebook/1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        {/* 探针挂在同一条路由里：测试要能看到动作之后跳去了哪 */}
        <Route path="/notebook" element={<><NotebookPage /><LocationProbe /></>} />
        <Route path="/notebook/:id" element={<><NotebookPage /><LocationProbe /></>} />
        <Route path="/projects" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  )
}

function seed() {
  useNotebookStore.setState({
    manuscripts: [
      { id: 1, folderId: null, title: '第一篇', previewText: '预览一', imageCount: 0, createdAt: 0, updatedAt: 0 },
    ],
    folders: [],
    active: {
      id: 1,
      folderId: null,
      title: '第一篇',
      previewText: '预览一',
      imageCount: 0,
      createdAt: 0,
      updatedAt: 0,
      contentHtml: '<p>正文</p>',
      sourceCardId: null,
    },
    loading: false,
    saveState: 'idle',
    error: null,
    query: '',
  })
  useUIStore.setState({ toasts: [] })
}

/** 顶栏里"页面级动作"的定位：按文案/aria-label 找按钮 */
function headerButton(text: string, label?: string): HTMLElement {
  const header = document.querySelector('header') as HTMLElement
  const scope = within(header)
  return label ? (scope.getByLabelText(label) as HTMLElement) : (scope.getByText(text) as HTMLElement)
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  seed()
})

describe('顶栏动作的排布', () => {
  it('五个入口同处一条顶栏，顺序是 导入 → 送入节点池 → 思维导图 → 设置 → 账号', () => {
    const view = renderPage()
    const header = document.querySelector('header') as HTMLElement

    const importBtn = headerButton('从节点池导入')
    const sendBtn = headerButton('送入节点池')
    const mindmapBtn = headerButton('思维导图')
    const settingsBtn = headerButton('设置', '设置')
    const accountBtn = headerButton('账号', '账号菜单')

    // 都在 header 里（不是纸张、不是侧栏）
    for (const node of [importBtn, sendBtn, mindmapBtn, settingsBtn, accountBtn]) {
      expect(header.contains(node)).toBe(true)
    }

    const order = [importBtn, sendBtn, mindmapBtn, settingsBtn, accountBtn]
    for (let i = 0; i < order.length - 1; i += 1) {
      expect(
        order[i].compareDocumentPosition(order[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${i} 号按钮应该排在 ${i + 1} 号之前`,
      ).toBeTruthy()
    }

    // 顶栏只有一条（没有把动作另起一行）
    expect(view.container.querySelectorAll('header')).toHaveLength(1)
  })

  it('没有打开手稿时不显示「送入节点池」', () => {
    useNotebookStore.setState({ active: null })
    renderPage('/notebook')

    const header = document.querySelector('header') as HTMLElement
    expect(within(header).queryByText('送入节点池')).toBeNull()
    // 导入与思维导图是恒在的
    expect(within(header).getByText('从节点池导入')).toBeTruthy()
    expect(within(header).getByText('思维导图')).toBeTruthy()
  })
})

describe('顶栏动作的行为', () => {
  it('「送入节点池」把当前手稿移走：调用转换接口、手稿从笔记本消失、回到列表', async () => {
    renderPage()
    fireEvent.click(headerButton('送入节点池'))

    await waitFor(() => expect(api.manuscriptToNodeCard).toHaveBeenCalledWith(1, null))

    const toasts = useUIStore.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0].title).toBe('已移入节点池')
    // 移动语义：这篇手稿已经不在笔记本里了（列表和当前打开都要清干净）
    expect(useNotebookStore.getState().manuscripts.map((item) => item.id)).not.toContain(1)
    expect(useNotebookStore.getState().active).toBeNull()
    // 停在 /notebook/1 会让页面回头去 open 一个已被删掉的手稿
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/notebook'))
  })

  it('「送入节点池」失败时弹错误提示，不静默', async () => {
    vi.mocked(api.manuscriptToNodeCard).mockResolvedValueOnce(null)
    renderPage()
    fireEvent.click(headerButton('送入节点池'))

    await waitFor(() => expect(useUIStore.getState().toasts).toHaveLength(1))
    expect(useUIStore.getState().toasts[0].type).toBe('error')
  })

  it('「思维导图」回到项目列表 /projects', async () => {
    renderPage()
    fireEvent.click(headerButton('思维导图'))

    expect((await screen.findByTestId('location')).textContent).toBe('/projects')
  })
})

describe('侧栏搜索', () => {
  it('输入关键词会带 q 去查服务端', async () => {
    renderPage()

    fireEvent.change(screen.getByPlaceholderText('搜索标题或正文'), { target: { value: '评审' } })

    await waitFor(() =>
      expect(api.getManuscripts).toHaveBeenLastCalledWith(expect.objectContaining({ q: '评审' })),
    )
    // 关键字也留在 store 里，清空后能恢复全量
    expect(useNotebookStore.getState().query).toBe('评审')
  })

  it('没有任何手稿时的空态文案区分"搜不到"与"还没写"', async () => {
    vi.mocked(api.getManuscripts).mockResolvedValue([])
    useNotebookStore.setState({ manuscripts: [] })
    renderPage()

    expect(await screen.findByText('还没有手稿')).toBeTruthy()
    expect(screen.getByText('新建一篇，随手写点东西')).toBeTruthy()
    expect(screen.queryByText('没有匹配的手稿')).toBeNull()
  })
})
