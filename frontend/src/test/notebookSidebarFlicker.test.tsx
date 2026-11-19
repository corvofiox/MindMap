/**
 * 搜索键入时列表不许跳。
 *
 * 这组断言直接钉住那次的症状：搜索框每改一次关键词都会走 load()，如果骨架屏
 * 跟着 loading 走，它会插在列表上方、把整列往下推 158px——敲字时看起来就是
 * "狂闪"。所以契约是：
 *   - 首屏（还没加载过）才铺骨架屏；
 *   - 加载过一次之后，重新取数据期间保留旧行，不插任何占位块；
 *   - 搜索输入有防抖，连续敲字只发一次请求。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { NotebookSidebar } from '@/features/notebook/NotebookSidebar'
import type { ManuscriptSummary } from '@/services/api'

const ROWS: ManuscriptSummary[] = [
  { id: 1, folderId: null, title: '发版回归手稿', previewText: '', imageCount: 0, createdAt: 0, updatedAt: 0 },
  { id: 2, folderId: null, title: '第二篇', previewText: '', imageCount: 0, createdAt: 0, updatedAt: 0 },
]

function renderSidebar(overrides: Partial<Parameters<typeof NotebookSidebar>[0]> = {}) {
  const props = {
    manuscripts: ROWS,
    folders: [],
    activeId: undefined,
    query: '',
    loading: false,
    loaded: true,
    counts: null,
    hasMore: false,
    loadingMore: false,
    onLoadMore: vi.fn(),
    folderSelection: 'unfiled' as const,
    onSelectFolder: vi.fn(),
    onSearch: vi.fn(),
    onCreate: vi.fn(),
    onOpen: vi.fn(),
    onCollapse: vi.fn(),
    onAddFolder: vi.fn(),
    onDeleteFolder: vi.fn(),
    onMoveToFolder: vi.fn(),
    onReorder: vi.fn(),
    onReorderFolder: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  }
  render(<NotebookSidebar {...props} />)
  return props
}

const skeleton = () => screen.queryByTestId('notebook-list-skeleton')

describe('笔记本左栏：重新取数据时不闪', () => {
  beforeEach(() => vi.clearAllMocks())

  it('首屏才铺骨架屏', () => {
    renderSidebar({ loading: true, loaded: false, manuscripts: [] })
    expect(skeleton()).not.toBeNull()
  })

  it('加载过一次之后，刷新期间不插骨架屏（旧行原位留着）', () => {
    renderSidebar({ loading: true, loaded: true })
    expect(skeleton()).toBeNull()
    // 旧行必须还在，否则同样是"塌下去"
    expect(screen.getByText('发版回归手稿')).toBeTruthy()
    expect(screen.getByText('第二篇')).toBeTruthy()
  })

  it('搜索没结果时，空态是替换而不是先塌一下', () => {
    renderSidebar({ loading: true, loaded: true, query: '不存在的词', manuscripts: [] })
    expect(skeleton()).toBeNull()
    expect(screen.getByText('没有匹配的手稿')).toBeTruthy()
  })
})

describe('笔记本左栏：搜索去抖', () => {  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  it('连续敲 4 个字符只发一次请求，且发的是最后一次的词', () => {
    const props = renderSidebar()
    const input = screen.getByPlaceholderText('搜索标题或正文') as HTMLInputElement

    for (const value of ['发', '发版', '发版回', '发版回归']) {
      fireEvent.change(input, { target: { value } })
    }
    expect(props.onSearch).not.toHaveBeenCalled()
    // 受控输入要立刻回显用户敲的字，不能等请求回来
    expect(input.value).toBe('发版回归')

    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(props.onSearch).toHaveBeenCalledTimes(1)
    expect(props.onSearch).toHaveBeenCalledWith('发版回归')
    vi.useRealTimers()
  })
})

describe('笔记本左栏：滚到底自动加载', () => {
  let fire: ((entries: { isIntersecting: boolean }[]) => void) | null = null

  const stubObserver = () => {
    fire = null
    class FakeObserver {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        fire = cb
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver as never)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    stubObserver()
  })

  it('哨兵进入视口就取下一页', async () => {
    const props = renderSidebar({ hasMore: true })
    await waitFor(() => expect(fire).not.toBeNull())

    act(() => {
      fire?.([{ isIntersecting: true }])
    })

    expect(props.onLoadMore).toHaveBeenCalled()
  })

  it('没有下一页时不挂观察器', async () => {
    const props = renderSidebar({ hasMore: false })
    expect(document.querySelector('[data-testid="notebook-load-sentinel"]')).toBeNull()
    act(() => {
      fire?.([{ isIntersecting: true }])
    })
    expect(props.onLoadMore).not.toHaveBeenCalled()
  })

  it('正在取下一页时不重复触发', async () => {
    const props = renderSidebar({ hasMore: true, loadingMore: true })
    act(() => {
      fire?.([{ isIntersecting: true }])
    })
    expect(props.onLoadMore).not.toHaveBeenCalled()
  })
})

describe('笔记本左栏：徽标计数', () => {
  it('用服务端计数，不数已加载的行', () => {
    renderSidebar({
      counts: { total: 1947, unfiled: 5, byFolder: { '7': 1928 } },
      folders: [
        { id: 7, userId: 1, name: '大夹子', parentId: null, sortOrder: 0, collapsed: false, createdAt: 0 },
      ],
      // 列表只有一页 200 条，计数不能来自它
      manuscripts: ROWS,
    })

    expect(screen.getByText('1928')).toBeTruthy()
    expect(screen.getByText('5')).toBeTruthy()
  })
})
