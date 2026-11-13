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
const { useUIStore } = await import('@/store/useUIStore')

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
    expect(scope.queryByText('从节点池导入')).toBeNull()
    // 删除入口只允许在左侧抽屉里，正文/纸张不允许出现
    expect(scope.queryByText('删除')).toBeNull()
    expect(scope.queryByLabelText('删除手稿')).toBeNull()

    const header = document.querySelector('header')
    expect(header).not.toBeNull()
    expect(within(header as HTMLElement).queryByLabelText('删除手稿')).toBeNull()
    expect(within(header as HTMLElement).getByLabelText('设置')).toBeTruthy()
    expect(within(header as HTMLElement).getByLabelText('账号菜单')).toBeTruthy()

    // 页面级动作在顶部工具栏；删除只在左侧抽屉里
    expect(screen.getByText('送入节点池')).toBeTruthy()
    expect(screen.getByText('思维导图')).toBeTruthy()
  })

  it('设置与账号入口在顶栏最右侧', () => {
    renderPage()

    const settingsButton = screen.getByLabelText('设置')
    const accountButton = screen.getByLabelText('账号菜单')
    expect(settingsButton).toBeTruthy()
    expect(accountButton).toBeTruthy()

    // 点设置 → 打开设置弹窗（笔记本不在 MainLayout 里，弹窗要自己挂）
    fireEvent.click(settingsButton)
    expect(useUIStore.getState().settingsOpen).toBe(true)

    // 账号菜单里的"账号设置"
    fireEvent.click(accountButton)
    fireEvent.click(screen.getByText('账号设置'))
    expect(useUIStore.getState().accountSettingsOpen).toBe(true)
  })
})

describe('左栏收纳动作', () => {
  it('列表项可以移动到文件夹：菜单两级展开，先点「移动到」再选文件夹', async () => {
    // 页面挂载会真的拉一次文件夹列表，这里让它返回「素材」，
    // 否则 store 里的种子会被这次拉取覆盖（也就测不到菜单了）。
    vi.mocked(api.getManuscriptFolders).mockResolvedValueOnce([
      { id: 7, userId: 1, name: '素材', parentId: null, sortOrder: 0, collapsed: false, createdAt: 0 },
    ])
    renderPage()

    await screen.findByText('素材')
    fireEvent.click(screen.getAllByLabelText('更多操作')[0])

    const menu = await screen.findByTestId('notebook-item-menu')
    // 一级菜单只有两个条目
    expect(within(menu).getByText('移动到')).toBeTruthy()
    expect(within(menu).getByText('删除')).toBeTruthy()

    // 二级菜单才列文件夹
    expect(screen.queryByTestId('notebook-move-menu')).toBeNull()
    fireEvent.click(within(menu).getByText('移动到'))
    const moveMenu = await screen.findByTestId('notebook-move-menu')
    fireEvent.click(within(moveMenu).getByText('素材'))

    await waitFor(() => expect(api.updateManuscript).toHaveBeenCalledWith(1, { folderId: 7 }))
  })

  it('列表项可以删除（删的不是当前这篇时不跳转）', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderPage()

    fireEvent.click(screen.getAllByLabelText('更多操作')[0])
    const menu = await screen.findByTestId('notebook-item-menu')
    fireEvent.click(within(menu).getByText('删除'))

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
    // 与画布共用同一个富文本工具栏组件，docked 形态吸顶在纸张上方
    const toolbar = document.querySelector('[data-rich-text-toolbar="true"][data-variant="docked"]')
    expect(toolbar).not.toBeNull()
  })

  it('没有打开手稿时不显示', () => {
    useNotebookStore.setState({ active: null })
    renderPage()
    expect(document.querySelector('[data-rich-text-toolbar="true"]')).toBeNull()
  })

  it('点「加粗」会在编辑器上执行 bold 命令', () => {
    const execCommand = vi.fn().mockReturnValue(true)
    ;(document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand
    renderPage()

    fireEvent.click(screen.getByLabelText('加粗 (Ctrl+B)'))

    expect(execCommand).toHaveBeenCalledWith('bold', false)
  })

  it('点「标题 2」执行 formatBlock H2', () => {
    const execCommand = vi.fn().mockReturnValue(true)
    ;(document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand
    renderPage()

    fireEvent.click(screen.getByLabelText('标题 2'))

    // 统一命令层使用 "<h2>" 形式：Chrome 认裸标签，Firefox 只认带尖括号的
    expect(execCommand).toHaveBeenCalledWith('formatBlock', false, '<h2>')
  })
})

describe('新建手稿的落点', () => {
  it('选中文件夹后新建手稿，会带 folderId 建在该文件夹里', async () => {
    vi.mocked(api.getManuscriptFolders).mockResolvedValueOnce([
      { id: 7, userId: 1, name: '素材', parentId: null, sortOrder: 0, collapsed: false, createdAt: 0 },
    ])
    vi.mocked(api.createManuscript).mockResolvedValueOnce({
      id: 42,
      folderId: 7,
      title: '未命名手稿',
      previewText: '',
      imageCount: 0,
      createdAt: 0,
      updatedAt: 0,
      contentHtml: '',
      sourceCardId: null,
    } as never)
    renderPage()

    // 选中「素材」文件夹，再点新建
    fireEvent.click(await screen.findByText('素材'))
    fireEvent.click(screen.getAllByText('新建手稿')[0])

    await waitFor(() => expect(api.createManuscript).toHaveBeenCalled())
    expect(vi.mocked(api.createManuscript).mock.calls[0][0]).toMatchObject({ folderId: 7 })
  })

  it('未选文件夹时新建，落点是未归档', async () => {
    vi.mocked(api.createManuscript).mockResolvedValueOnce({
      id: 43,
      folderId: null,
      title: '未命名手稿',
      previewText: '',
      imageCount: 0,
      createdAt: 0,
      updatedAt: 0,
      contentHtml: '',
      sourceCardId: null,
    } as never)
    renderPage()

    fireEvent.click(screen.getAllByText('新建手稿')[0])

    await waitFor(() => expect(api.createManuscript).toHaveBeenCalled())
    expect(vi.mocked(api.createManuscript).mock.calls[0][0]).toMatchObject({ folderId: null })
  })
})

describe('移动到子菜单的鼠标路径', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  it('鼠标从「移动到」移到子菜单不会被中途关掉', async () => {
    vi.mocked(api.getManuscriptFolders).mockResolvedValueOnce([
      { id: 7, userId: 1, name: '素材', parentId: null, sortOrder: 0, collapsed: false, createdAt: 0 },
    ])
    renderPage()

    await screen.findByText('素材')
    fireEvent.click(screen.getAllByLabelText('更多操作')[0])
    const moveItem = (await screen.findByText('移动到')).parentElement as HTMLElement

    // 悬停到「移动到」→ 子菜单出现
    fireEvent.mouseEnter(moveItem)
    const submenu = await screen.findByTestId('notebook-move-menu')

    // 离开「移动到」→ 立刻判定的话就会关闭；这里给 180ms 缓冲
    fireEvent.mouseLeave(moveItem)
    await sleep(90)
    expect(screen.queryByTestId('notebook-move-menu')).not.toBeNull()

    // 进入子菜单 → 缓冲被取消，停留一会也不该关
    fireEvent.mouseEnter(submenu)
    await sleep(260)
    expect(screen.queryByTestId('notebook-move-menu')).not.toBeNull()

    // 真正离开子菜单后才会关
    fireEvent.mouseLeave(submenu)
    await waitFor(() => expect(screen.queryByTestId('notebook-move-menu')).toBeNull(), { timeout: 1200 })
  })
})

describe('未归档的筛选与落点', () => {
  it('点「未归档」只列出未归档手稿', async () => {
    vi.mocked(api.getManuscriptFolders).mockResolvedValueOnce([
      { id: 7, userId: 1, name: '素材', parentId: null, sortOrder: 0, collapsed: false, createdAt: 0 },
    ])
    vi.mocked(api.getManuscripts).mockResolvedValueOnce([
      { id: 1, folderId: null, title: '未归一篇', previewText: '', imageCount: 0, createdAt: 0, updatedAt: 0 },
      { id: 2, folderId: 7, title: '文件夹里的', previewText: '', imageCount: 0, createdAt: 0, updatedAt: 0 },
    ])
    renderPage()

    await screen.findByText('素材')
    expect(screen.getByText('文件夹里的')).toBeTruthy()

    fireEvent.click(screen.getByText('未归档'))

    expect(screen.getByText('未归一篇')).toBeTruthy()
    expect(screen.queryByText('文件夹里的')).toBeNull()
  })

  it('在「未归档」下新建手稿，落点仍是未归档（不会被上一个文件夹带走）', async () => {
    vi.mocked(api.getManuscriptFolders).mockResolvedValueOnce([
      { id: 7, userId: 1, name: '素材', parentId: null, sortOrder: 0, collapsed: false, createdAt: 0 },
    ])
    vi.mocked(api.createManuscript).mockResolvedValueOnce({
      id: 44,
      folderId: null,
      title: '未命名手稿',
      previewText: '',
      imageCount: 0,
      createdAt: 0,
      updatedAt: 0,
      contentHtml: '',
      sourceCardId: null,
    } as never)
    renderPage()

    await screen.findByText('素材')
    fireEvent.click(screen.getByText('素材'))
    fireEvent.click(screen.getByText('未归档'))
    fireEvent.click(screen.getAllByText('新建手稿')[0])

    await waitFor(() => expect(api.createManuscript).toHaveBeenCalled())
    expect(vi.mocked(api.createManuscript).mock.calls[0][0]).toMatchObject({ folderId: null })
  })
})

describe('删除文件夹：级联删子树，手稿退回未归档', () => {
  const seedTree = () => {
    vi.mocked(api.getManuscriptFolders).mockResolvedValueOnce([
      { id: 7, userId: 1, name: '素材', parentId: null, sortOrder: 0, collapsed: false, createdAt: 0 },
      { id: 8, userId: 1, name: '配色', parentId: 7, sortOrder: 0, collapsed: false, createdAt: 0 },
    ])
    vi.mocked(api.getManuscripts).mockResolvedValueOnce([
      { id: 1, folderId: 8, title: '深层手稿', previewText: '', imageCount: 0, createdAt: 0, updatedAt: 0 },
    ])
  }

  it('确认框把后果说准：子文件夹一起删，手稿退回未归档（以前写成"上移一层"）', async () => {
    seedTree()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderPage()

    await screen.findByText('配色')
    fireEvent.click(screen.getByLabelText('删除文件夹 素材'))

    expect(confirmSpy).toHaveBeenCalled()
    const question = String(confirmSpy.mock.calls[0][0])
    expect(question).toContain('删除文件夹「素材」')
    expect(question).toContain('1 个子文件夹会一起删除')
    expect(question).toContain('1 篇手稿会退回「未归档」')
    expect(question).not.toContain('上移')

    await waitFor(() => expect(api.deleteManuscriptFolder).toHaveBeenCalledWith(7))
    confirmSpy.mockRestore()
  })

  it('取消确认就不删', async () => {
    seedTree()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderPage()

    await screen.findByText('配色')
    fireEvent.click(screen.getByLabelText('删除文件夹 素材'))

    expect(confirmSpy).toHaveBeenCalled()
    expect(api.deleteManuscriptFolder).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('选中项落在被删的子树里时，选中回落到「全部手稿」', async () => {
    seedTree()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderPage()

    // 先选中子文件夹「配色」，再删它的父级「素材」
    fireEvent.click(await screen.findByText('配色'))
    expect(document.querySelector('[data-folder-row="8"]')?.className).toContain('bg-blue-50')

    fireEvent.click(screen.getByLabelText('删除文件夹 素材'))

    await waitFor(() =>
      expect(document.querySelector('[data-folder-row="all"]')?.className).toContain('bg-blue-50'),
    )
    confirmSpy.mockRestore()
  })
})

describe('笔记本侧的「从节点池导入」', () => {  it('按节点池文件夹分组展示卡片，文件夹默认收起', async () => {
    const { useNodePoolStore } = await import('@/features/node-pool/stores/useNodePoolStore')
    useNodePoolStore.setState({
      foldersMap: new Map([
        [3, { id: 3, userId: 1, name: '灵感', parentId: null, sortOrder: 0, collapsed: false, createdAt: '' }],
      ]),
      cardsMap: new Map([
        [11, { id: 11, userId: 1, name: '卡片一', content: '', type: 'text', color: '#fff', folderId: 3, createdAt: '', updatedAt: '' }],
        [12, { id: 12, userId: 1, name: '未归档卡片', content: '', type: 'text', color: '#fff', folderId: null, createdAt: '', updatedAt: '' }],
      ]),
    } as never)

    renderPage()
    fireEvent.click(screen.getByText('从节点池导入'))

    // 文件夹行出现，里面的卡片默认收起
    expect(await screen.findByTestId('pool-folder-3')).toBeTruthy()
    expect(screen.queryByTestId('pool-card-11')).toBeNull()
    // 未归档卡片始终展示
    expect(screen.getByTestId('pool-card-12')).toBeTruthy()

    // 展开后出现文件夹内的卡片
    fireEvent.click(screen.getByTestId('pool-folder-3'))
    expect(await screen.findByTestId('pool-card-11')).toBeTruthy()
  })
})