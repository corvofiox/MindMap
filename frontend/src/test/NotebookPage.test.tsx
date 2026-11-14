/**
 * NotebookPage —— 笔记本工作台的界面契约。
 *
 * 重点在「粘贴采集」：网页复制的 HTML 必须保留结构（图片/加粗），
 * 同时经过 sanitizeHTML（script 与非法 src 被剥掉）。其余是列表渲染、
 * 点击打开与"送入节点池"的接线。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

vi.mock('@/services/api', async () => {
  const actual = await vi.importActual<typeof import('@/services/api')>('@/services/api')
  return {
    ...actual,
    // 挂载时页面会真的拉一次列表，这里返回与 seed 一致的一条，否则 seed 会被覆盖
    getManuscripts: vi.fn(async () => [
      { id: 1, folderId: null, title: '第一篇', previewText: '预览一', imageCount: 0, createdAt: 0, updatedAt: 0 },
    ]),
    getManuscript: vi.fn(),
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
    deleteManuscript: vi.fn(),
    manuscriptToNodeCard: vi.fn(async () => ({ id: 1, name: '卡片' })),
    nodeCardToManuscript: vi.fn(),
    getManuscriptFolders: vi.fn(async () => []),
    createManuscriptFolder: vi.fn(async (name: string) => ({ id: 9, name, parentId: null, sortOrder: 0, createdAt: 0 })),
    getNodePool: vi.fn(async () => []),
  }
})

const api = await import('@/services/api')
const { NotebookPage } = await import('@/pages/NotebookPage')
const { useNotebookStore } = await import('@/store/useNotebookStore')
const { useUIStore } = await import('@/store/useUIStore')
const { useNodePoolStore } = await import('@/features/node-pool/stores/useNodePoolStore')

const SHA = 'd'.repeat(64)

function seedActive(contentHtml = '<p>正文</p>') {
  useNotebookStore.setState({
    manuscripts: [
      {
        id: 1,
        folderId: null,
        title: '第一篇',
        previewText: '预览一',
        imageCount: 0,
        createdAt: 0,
        updatedAt: 0,
      },
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
      contentHtml,
      sourceCardId: null,
    },
    loading: false,
    saveState: 'idle',
    error: null,
    query: '',
  })
}

function renderPage(path = '/notebook/1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/notebook" element={<NotebookPage />} />
        <Route path="/notebook/:id" element={<NotebookPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  seedActive()
})

describe('列表与标题', () => {
  it('左侧列出标题与预览', () => {
    renderPage()
    expect(screen.getByText('第一篇')).toBeTruthy()
    expect(screen.getByText('预览一')).toBeTruthy()
  })

  it('编辑器初始内容来自 contentHtml', () => {
    renderPage()
    const editor = screen.getByTestId('manuscript-editor')
    expect(editor.innerHTML).toContain('正文')
  })
})

describe('粘贴采集', () => {
  it('保留 HTML 结构（图片/加粗），剥掉 script 与非法 src', () => {
    renderPage()
    const editor = screen.getByTestId('manuscript-editor')

    const html = [
      '<p><b>重点</b></p>',
      `<img src="/api/files/${SHA}">`,
      '<img src="https://evil.example/track.png">',
      '<script>alert(1)</script>',
    ].join('')

    fireEvent.paste(editor, {
      clipboardData: {
        getData: (type: string) => (type === 'text/html' ? html : '重点'),
      },
    })

    expect(editor.innerHTML).toContain('<b>重点</b>')
    expect(editor.innerHTML).toContain(`/api/files/${SHA}`)
    expect(editor.innerHTML).not.toContain('script')
    expect(editor.innerHTML).not.toContain('evil.example')
  })

  it('剪贴板里只有纯文本时按段落插入', () => {
    renderPage()
    const editor = screen.getByTestId('manuscript-editor')

    fireEvent.paste(editor, {
      clipboardData: { getData: (type: string) => (type === 'text/plain' ? '纯文本段落' : '') },
    })

    expect(editor.innerHTML).toContain('纯文本段落')
  })
})

describe('动作接线', () => {
  it('「送入节点池」调用转换接口、提示已移入，并把这篇从列表里去掉', async () => {
    renderPage()
    const button = screen.getByText('送入节点池')

    fireEvent.click(button)

    await waitFor(() => expect(api.manuscriptToNodeCard).toHaveBeenCalled())
    expect(vi.mocked(api.manuscriptToNodeCard).mock.calls[0][0]).toBe(1)
    // toast 由 App 层的 ToastContainer 渲染，这里断言 store 里确实产生了提示
    const toasts = useUIStore.getState().toasts
    expect(toasts.some((t) => String(t.title).includes('已移入节点池'))).toBe(true)
    // 移动语义：服务端已软删这篇，界面上不能还留着
    expect(useNotebookStore.getState().manuscripts.some((item) => item.id === 1)).toBe(false)
    expect(useNotebookStore.getState().active).toBeNull()
  })

  it('标题输入会触发防抖保存', async () => {
    renderPage()
    const input = screen.getByPlaceholderText('手稿标题') as HTMLInputElement

    fireEvent.change(input, { target: { value: '改后的标题' } })
    fireEvent.blur(input)

    await waitFor(() => expect(api.updateManuscript).toHaveBeenCalled())
    expect(vi.mocked(api.updateManuscript).mock.calls[0][0]).toBe(1)
    expect(vi.mocked(api.updateManuscript).mock.calls[0][1]).toMatchObject({ title: '改后的标题' })
  })

  it('「从节点池导入」把卡片转成手稿后刷新节点池（卡片已被服务端删掉）', async () => {
    useNodePoolStore.setState({
      cardsMap: new Map([
        [
          5,
          {
            id: 5,
            userId: 1,
            createdBy: 1,
            name: '待搬的卡片',
            content: JSON.stringify({ title: '待搬的卡片', content: '<p>卡片正文</p>' }),
            type: 'text' as const,
            color: '#ffffff',
            tags: null,
            useCount: 0,
            folderId: null,
            description: null,
            sourceManuscriptId: null,
            sourceKind: null,
            thumbnail: null,
            sortOrder: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      ]),
    })
    vi.mocked(api.nodeCardToManuscript).mockResolvedValue({
      id: 2,
      folderId: null,
      title: '待搬的卡片',
      previewText: '卡片正文',
      imageCount: 0,
      createdAt: 0,
      updatedAt: 0,
      contentHtml: '<p>卡片正文</p>',
      sourceCardId: 5,
    })

    renderPage()

    fireEvent.click(screen.getByText('从节点池导入'))
    const cardRow = await screen.findByTestId('pool-card-5')
    // 打开菜单本身也会拉一次池子，所以基准取在卡片已经渲染之后
    const before = vi.mocked(api.getNodePool).mock.calls.length

    fireEvent.click(cardRow)

    await waitFor(() => expect(api.nodeCardToManuscript).toHaveBeenCalledWith(5))
    // 池子里已经没有这张卡了，本地列表必须重新对齐
    await waitFor(() => expect(vi.mocked(api.getNodePool).mock.calls.length).toBeGreaterThan(before))
    expect(useUIStore.getState().toasts.some((t) => String(t.title).includes('已转为手稿'))).toBe(true)
  })
})
