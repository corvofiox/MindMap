/**
 * 节点池面板的头部。
 *
 * 这里钉住两条被返工过的约束：
 *   1. 「节点池」标题与「从笔记本导入」必须在同一行（曾经被拆成两行，按钮掉到标题下面）；
 *   2. 面板关着时整块只是被平移出视口，不能卸载——否则抽屉开合会丢状态。
 * 顺带验证导入完成后会重新拉一次节点池数据。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

vi.mock('@/services/api', async () => {
  const actual = await vi.importActual<typeof import('@/services/api')>('@/services/api')
  return {
    ...actual,
    getNodePool: vi.fn(async () => []),
    getNodePoolFolders: vi.fn(async () => []),
    getManuscripts: vi.fn(async () => [
      { id: 5, folderId: null, title: '待导入的手稿', previewText: '正文摘要', imageCount: 0, createdAt: 0, updatedAt: 0 },
    ]),
    getManuscriptFolders: vi.fn(async () => []),
    manuscriptToNodeCard: vi.fn(async () => ({ id: 12, name: '待导入的手稿' })),
    createNodePoolFolder: vi.fn(),
    toNodeCard: vi.fn(),
  }
})

const api = await import('@/services/api')
const { NodePoolPanel } = await import('@/features/node-pool/components/NodePoolPanel')
const { useNodePoolStore } = await import('@/features/node-pool/stores/useNodePoolStore')

beforeEach(() => {
  vi.clearAllMocks()
  useNodePoolStore.setState({
    cardsMap: new Map(),
    foldersMap: new Map(),
    pendingCardIds: new Set(),
    loading: false,
    error: null,
  } as never)
})

describe('节点池面板头部', () => {
  it('标题与「从笔记本导入」在同一行，顺序是 标题 → 导入 → 文件夹 → 加号', () => {
    render(<NodePoolPanel open />)

    const title = screen.getByRole('heading', { name: '节点池' })
    const importTrigger = screen.getByText('从笔记本导入')
    const newFolder = screen.getByTitle('新建文件夹')
    const addNode = screen.getByTitle('添加选中节点到池')

    // 三者同属一个头部容器，且这个容器的直接子元素只有"标题"和"右侧动作组"两块
    const header = title.parentElement as HTMLElement
    expect(header.children).toHaveLength(2)
    expect(header.children[0]).toBe(title)

    const actions = header.children[1] as HTMLElement
    expect(actions.contains(importTrigger)).toBe(true)
    expect(actions.contains(newFolder)).toBe(true)
    expect(actions.contains(addNode)).toBe(true)

    // 从左到右：导入 → 新建文件夹 → 添加节点
    expect(
      importTrigger.compareDocumentPosition(newFolder) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(newFolder.compareDocumentPosition(addNode) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('导入按钮与标题共用同一行高度（不是被挤到下一行）', () => {
    render(<NodePoolPanel open />)

    const title = screen.getByRole('heading', { name: '节点池' })
    const header = title.parentElement as HTMLElement
    // 头部是单行（h-12）+ 两端对齐；拆成两行时这里会变成 flex-col 或出现第二个子块
    expect(header.className).toContain('h-12')
    expect(header.className).toContain('justify-between')
    expect(header.className).not.toContain('flex-col')
  })

  it('面板关着时依旧挂载（只是平移出视口），开合不丢状态', () => {
    useNodePoolStore.setState({ cardsMap: new Map() } as never)
    render(<NodePoolPanel open={false} />)

    const panel = document.querySelector('[data-node-pool="true"]') as HTMLElement
    expect(panel).not.toBeNull()
    expect(panel.className).toContain('translate-x-full')
  })

  it('从笔记本导入：列出手稿、点一下转成卡片并刷新节点池', async () => {
    render(<NodePoolPanel open />)
    fireEvent.click(screen.getByText('从笔记本导入'))

    const menu = await screen.findByTestId('notebook-import-menu')
    const row = await within(menu).findByTestId('import-manuscript-5')
    expect(within(row).getByText('待导入的手稿')).toBeTruthy()

    fireEvent.click(row)

    await waitFor(() => expect(api.manuscriptToNodeCard).toHaveBeenCalledWith(5))
    // 导入成功后重新拉数据，新卡片才会出现在池子里
    await waitFor(() => expect(api.getNodePool).toHaveBeenCalled())
    // 菜单关掉，不会挡住操作
    await waitFor(() => expect(screen.queryByTestId('notebook-import-menu')).toBeNull())
  })

  it('笔记本没有手稿时给出明确的空态', async () => {
    vi.mocked(api.getManuscripts).mockResolvedValueOnce([])
    render(<NodePoolPanel open />)
    fireEvent.click(screen.getByText('从笔记本导入'))

    const menu = await screen.findByTestId('notebook-import-menu')
    expect(await within(menu).findByText('笔记本里还没有手稿')).toBeTruthy()
  })
})
