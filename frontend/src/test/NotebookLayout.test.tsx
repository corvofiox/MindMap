/**
 * 笔记本新版界面的契约：
 *   - 左栏可以收纳（收起 / 展开），状态落在 localStorage；
 *   - 页面级动作（送入节点池 / 删除）不许出现在纸张里；
 *   - 列表项的"更多操作"能移动文件夹、能删除；
 *   - 文件夹能新建。
 *
 * 这些断言直接对应"页面太简陋 / 动作挤在编辑区"的返工点，
 * 以后谁再把按钮塞回纸张、或把收纳去掉，会立刻红。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

vi.mock('@/services/api', async () => {
  const actual = await vi.importActual<typeof import('@/services/api')>('@/services/api')
  return {
    ...actual,
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
    deleteManuscript: vi.fn(async (id: number) => ({ id })),
    manuscriptToNodeCard: vi.fn(async () => ({ id: 1, name: '卡片' })),
    nodeCardToManuscript: vi.fn(),
    getManuscriptFolders: vi.fn(async () => []),
    createManuscriptFolder: vi.fn(async (data: { name: string; parentId?: number | null }) => ({
      id: 9,
      name: data.name,
      parentId: data.parentId ?? null,
      sortOrder: 0,
      createdAt: 0,
    })),
    deleteManuscriptFolder: vi.fn(async (id: number) => ({ id })),
    getNodePool: vi.fn(async () => []),
  }
})

const api = await import('@/services/api')
const { NotebookPage } = await import('@/pages/NotebookPage')
const { useNotebookStore } = await import('@/store/useNotebookStore')

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
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/notebook/1']}>
      <Routes>
        <Route path="/notebook" element={<NotebookPage />} />
        <Route path="/notebook/:id" element={<NotebookPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  seed()
})

afterEach(() => {
  localStorage.clear()
})

describe('左栏收纳', () => {
  it('可以收起与展开，且状态写进 localStorage', async () => {
    renderPage()
    const aside = document.querySelector('aside')
    expect(aside?.getAttribute('aria-hidden')).toBe('false')

    fireEvent.click(screen.getByLabelText('收起侧栏'))
    await waitFor(() => expect(document.querySelector('aside')?.getAttribute('aria-hidden')).toBe('true'))
    expect(localStorage.getItem('notebook:sidebar-collapsed')).toBe('1')

    fireEvent.click(screen.getByLabelText('展开侧栏'))
    await waitFor(() => expect(document.querySelector('aside')?.getAttribute('aria-hidden')).toBe('false'))
    expect(localStorage.getItem('notebook:sidebar-collapsed')).toBe('0')
  })

  it('刷新时沿用上次的收起状态', () => {
    localStorage.setItem('notebook:sidebar-collapsed', '1')
    renderPage()
    expect(document.querySelector('aside')?.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('动作位置', () => {
  it('纸张里没有任何页面级动作按钮', () => {
    renderPage()
    const editor = screen.getByTestId('manuscript-editor')
    const paper = editor.closest('article')
    expect(paper).not.toBeNull()

    const scope = within(paper as HTMLElement)
    expect(scope.queryByText('送入节点池')).toBeNull()
    expect(scope.queryByLabelText('删除手稿')).toBeNull()
    expect(scope.queryByText('从节点池导入')).toBeNull()

    // 它们应该在纸张之外（顶部工具栏）
    expect(screen.getByText('送入节点池')).toBeTruthy()
    expect(screen.getByLabelText('删除手稿')).toBeTruthy()
  })
})

describe('左栏收纳动作', () => {
  it('列表项可以移动到文件夹（调 updateManuscript 带 folderId）', async () => {
    // 页面挂载会真的拉一次文件夹列表，这里让它返回「素材」，
    // 否则 store 里的种子会被这次拉取覆盖（也就测不到菜单了）。
    vi.mocked(api.getManuscriptFolders).mockResolvedValueOnce([
      { id: 7, userId: 1, name: '素材', parentId: null, sortOrder: 0, collapsed: false, createdAt: 0 },
    ])
    renderPage()

    await screen.findByText('素材')
    fireEvent.click(screen.getAllByLabelText('更多操作')[0])
    const menu = await screen.findByTestId('notebook-item-menu')
    fireEvent.click(within(menu).getByText('素材'))

    await waitFor(() => expect(api.updateManuscript).toHaveBeenCalledWith(1, { folderId: 7 }))
  })

  it('列表项可以删除（删的不是当前这篇时不跳转）', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderPage()

    fireEvent.click(screen.getAllByLabelText('更多操作')[0])
    fireEvent.click(await screen.findByText('删除这篇'))

    await waitFor(() => expect(api.deleteManuscript).toHaveBeenCalledWith(1))
    confirmSpy.mockRestore()
  })

  it('可以新建文件夹', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('新想法')
    renderPage()

    fireEvent.click(screen.getByLabelText('新建文件夹'))

    await waitFor(() => expect(api.createManuscriptFolder).toHaveBeenCalledWith({ name: '新想法', parentId: null }))
    promptSpy.mockRestore()
  })
})

describe('编辑区工具栏', () => {
  it('打开手稿时显示格式工具栏', () => {
    renderPage()
    expect(screen.getByTestId('notebook-format-toolbar')).toBeTruthy()
  })

  it('没有打开手稿时不显示', () => {
    useNotebookStore.setState({ active: null })
    renderPage()
    expect(screen.queryByTestId('notebook-format-toolbar')).toBeNull()
  })

  it('点「加粗」会在编辑器上执行 bold 命令', () => {
    const execCommand = vi.fn().mockReturnValue(true)
    ;(document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand
    renderPage()

    fireEvent.click(screen.getByLabelText('加粗 (Ctrl+B)'))

    expect(execCommand).toHaveBeenCalledWith('bold', false, undefined)
  })

  it('点「标题 2」执行 formatBlock H2', () => {
    const execCommand = vi.fn().mockReturnValue(true)
    ;(document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand
    renderPage()

    fireEvent.click(screen.getByLabelText('标题 2'))

    expect(execCommand).toHaveBeenCalledWith('formatBlock', false, 'H2')
  })
})