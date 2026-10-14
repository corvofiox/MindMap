/**
 * FolderItem 真实行为测试
 *
 * 不 mock 被测组件:FolderItem / NodeCardItem / useUIStore / useNodePoolStore 全部真实渲染。
 * 只把 UI 反馈(addToast)换成 spy(AccessTokensPanel.test.tsx 的既有做法)。
 *
 * 覆盖的真实逻辑:
 *  - 折叠态:collapsed 决定内容区是否渲染;有/无内容时展开箭头的有无;Folder/FolderOpen 图标切换
 *  - 计数徽标 = cards.length;缩进 paddingLeft = level*16+8
 *  - 空文件夹提示
 *  - 嵌套:children 渲染成 level+1 的子 FolderItem,并透传回调
 *  - 头部点击 → onToggle(folder.id);编辑态点击不触发 onToggle
 *  - 右键 → onContextMenu(event, folder)
 *  - 拖拽悬停高亮:useUIStore.overFolderId === folder.id → ring/bg class + 文字蓝色
 *  - 重命名(editingFolderId===folder.id):进入编辑时同步 folder.name、输入框自动聚焦全选;
 *    空名拒绝保存(不 onSaveEdit 也不 onCancelEdit);名称未变只 onCancelEdit;
 *    名称变更 onSaveEdit(folderId, trim 后);保存失败走 logger.error 且不抛出;
 *    Enter 保存 / Escape 取消(handleCancelEdit 复原 editName)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Mock } from 'vitest'
// Production loads the logger via a DYNAMIC import inside the catch (import('@/utils/logger')) —
// without vi.mock that resolves to a second module instance and the spy below never sees
// the call. Mock the module so both the static spy and the dynamic import share one instance.
vi.mock('@/utils/logger', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }))
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import type { NodeCard, NodePoolFolder } from '@/types'
import { FolderItem } from '../FolderItem'
import { useUIStore } from '@/store/useUIStore'
import { logger } from '@/utils/logger'

function makeFolder(overrides: Partial<NodePoolFolder> = {}): NodePoolFolder {
  return {
    id: 10,
    userId: 1,
    name: '文件夹A',
    parentId: null,
    sortOrder: 0,
    collapsed: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeCard(overrides: Partial<NodeCard> = {}): NodeCard {
  return {
    id: 1,
    userId: 1,
    name: '卡1',
    content: '{"title":"卡1"}',
    type: 'text',
    color: '#fff',
    tags: null,
    useCount: 0,
    createdBy: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    folderId: 10,
    description: null,
    thumbnail: null,
    sortOrder: 0,
    ...overrides,
  }
}

interface TestHandlers {
  onToggle: Mock
  onContextMenu: Mock
  onCardContextMenu: Mock
  onTogglePreview: Mock
  onStartEdit: Mock
  onSaveEdit: Mock
  onCancelEdit: Mock
  onUseCard: Mock
  onRemoveCard: Mock
  onSaveCardName: Mock
    /** Set by renderFolder so tests can detach between renders. */
    unmount: () => void
}

function renderFolder(
  folder: NodePoolFolder,
  options: {
    cards?: NodeCard[]
    children?: NodePoolFolder[]
    level?: number
    searchQuery?: string
    editingFolderId?: number | null
    previewCardId?: number | null
  } = {},
): TestHandlers {
  const handlers: Omit<TestHandlers, 'unmount'> = {
    onToggle: vi.fn(),
    onContextMenu: vi.fn(),
    onCardContextMenu: vi.fn(),
    onTogglePreview: vi.fn(),
    onStartEdit: vi.fn(),
    onSaveEdit: vi.fn(),
    onCancelEdit: vi.fn(),
    onUseCard: vi.fn(),
    onRemoveCard: vi.fn(),
    onSaveCardName: vi.fn(),
  }
  const { unmount } = render(
    <FolderItem
      folder={folder}
      cards={options.cards ?? []}
      children={options.children ?? []}
      level={options.level}
      searchQuery={options.searchQuery}
      onToggle={handlers.onToggle}
      onContextMenu={handlers.onContextMenu}
      onCardContextMenu={handlers.onCardContextMenu}
      previewCardId={options.previewCardId}
      onTogglePreview={handlers.onTogglePreview}
      onStartEdit={handlers.onStartEdit}
      onSaveEdit={handlers.onSaveEdit}
      onCancelEdit={handlers.onCancelEdit}
      editingFolderId={options.editingFolderId}
      onUseCard={handlers.onUseCard}
      onRemoveCard={handlers.onRemoveCard}
      onSaveCardName={handlers.onSaveCardName}
    />,
  )
  // Expose unmount so tests can detach between renders (cleanup() alone is
  // not enough when a test renders twice).
  return { ...handlers, unmount }
}

function header(): HTMLElement {
  const el = document.querySelector('[data-folder-id="10"]')
  if (!el) throw new Error('folder header not found')
  return el as HTMLElement
}

function nameSpan(): HTMLElement {
  const el = header().querySelector('span')
  if (!el) throw new Error('folder name span not found')
  return el as HTMLElement
}

function editInput(): HTMLInputElement {
  const el = document.querySelector('input[type="text"]')
  if (!el) throw new Error('edit input not found')
  return el as HTMLInputElement
}

/** lucide 图标渲染为 <svg class="lucide lucide-<kebab-name> ...">,按类名 token 计数。 */
function svgCount(className: string): number {
  return Array.from(document.querySelectorAll('svg')).filter((el) => el.classList.contains(className)).length
}

beforeEach(() => {
  vi.resetAllMocks()
  useUIStore.setState({ addToast: vi.fn(), overFolderId: null })
})

afterEach(() => {
  cleanup()
})

describe('展示与折叠', () => {
  it('展开状态渲染内容区与文件夹名/计数', () => {
    renderFolder(makeFolder(), { cards: [makeCard({ id: 1, name: '卡1' }), makeCard({ id: 2, name: '卡2' })] })

    expect(nameSpan().textContent).toBe('文件夹A')
    expect(header().getAttribute('data-folder-id')).toBe('10')
    expect(screen.getByText('2')).toBeInTheDocument()
    // card.name 与 content.title 都渲染 '卡1'（预览解析 + 标题），getByText 会撞多元素
    expect(screen.getAllByText('卡1').length).toBeGreaterThan(0)
    expect(screen.getAllByText('卡2').length).toBeGreaterThan(0)
  })

  it('collapsed=true 时不渲染卡片区', () => {
    renderFolder(makeFolder({ collapsed: true }), { cards: [makeCard({ id: 1 })] })

    expect(screen.queryByText('卡1')).toBeNull()
    expect(screen.getByText('文件夹A')).toBeInTheDocument()
    expect(svgCount('lucide-chevron-down')).toBe(0)
    expect(svgCount('lucide-chevron-right')).toBe(1)
  })

  it('展开时是 FolderOpen 图标,折叠时是 Folder 图标', () => {
    const { unmount } = renderFolder(makeFolder({ collapsed: false }), { cards: [makeCard()] })
    expect(svgCount('lucide-folder-open')).toBe(1)
    expect(svgCount('lucide-folder')).toBe(0)
    unmount()

    renderFolder(makeFolder({ collapsed: true }))
    expect(svgCount('lucide-folder-open')).toBe(0)
    expect(svgCount('lucide-folder')).toBe(1)
  })

  it('既无卡片也无子文件夹时不显示展开箭头', () => {
    renderFolder(makeFolder({ collapsed: false }), { cards: [], children: [] })

    expect(svgCount('lucide-chevron-down')).toBe(0)
    expect(svgCount('lucide-chevron-right')).toBe(0)
    expect(screen.getByText('空文件夹')).toBeInTheDocument()
  })

  it('空文件夹提示只属于真正的空文件夹:折叠不渲染;有子的父不提示;空的子提示自己的', () => {
    const { unmount } = renderFolder(makeFolder({ collapsed: true }))
    expect(screen.queryByText('空文件夹')).toBeNull()
    unmount()

    renderFolder(makeFolder({ collapsed: false }), { children: [makeFolder({ id: 11, name: '子' })] })
    expect(screen.getByText('子')).toBeInTheDocument()
    // The empty CHILD (cards=[] by design for nested items) shows ITS OWN empty
    // message; the parent — which has a child — shows none of its own.
    const emptyMessages = screen.getAllByText('空文件夹')
    expect(emptyMessages).toHaveLength(1)
    expect(emptyMessages[0].closest('[data-folder-id]')?.getAttribute('data-folder-id')).toBe('11')
  })

  it('level 决定缩进:level*16+8 px', () => {
    const { unmount } = renderFolder(makeFolder(), { level: 2 })
    expect(header().style.paddingLeft).toBe('40px')
    unmount()

    renderFolder(makeFolder())
    expect(header().style.paddingLeft).toBe('8px')
  })

  it('计数徽标来自 cards.length(与折叠无关)', () => {
    renderFolder(makeFolder({ collapsed: true }), { cards: [makeCard({ id: 1 }), makeCard({ id: 2 }), makeCard({ id: 3 })] })

    expect(screen.getByText('3')).toBeInTheDocument()
  })
})

describe('交互回调', () => {
  it('点击头部调用 onToggle(folder.id)', () => {
    const h = renderFolder(makeFolder(), { cards: [makeCard()] })

    fireEvent.click(header())

    expect(h.onToggle).toHaveBeenCalledTimes(1)
    expect(h.onToggle).toHaveBeenCalledWith(10)
  })

  it('右键头部调用 onContextMenu 并带上 folder', () => {
    const h = renderFolder(makeFolder())

    fireEvent.contextMenu(header())

    expect(h.onContextMenu).toHaveBeenCalledTimes(1)
    expect((h.onContextMenu.mock.calls[0] as [unknown, NodePoolFolder])[1].id).toBe(10)
  })

  it('编辑态点击头部不触发 onToggle', () => {
    const h = renderFolder(makeFolder(), { editingFolderId: 10 })

    fireEvent.click(editInput())

    expect(h.onToggle).not.toHaveBeenCalled()
  })

  it('卡片的右键/删除走透传回调', () => {
    const h = renderFolder(makeFolder(), { cards: [makeCard({ id: 5, name: '卡5' })] })

    fireEvent.click(screen.getByTitle('删除'))
    expect(h.onRemoveCard).toHaveBeenCalledWith(5)

    fireEvent.contextMenu(document.querySelector('div[style*="background-color"]') as Element)
    expect(h.onCardContextMenu).toHaveBeenCalledTimes(1)
    expect((h.onCardContextMenu.mock.calls[0] as [unknown, NodeCard])[1].id).toBe(5)
  })

  it('拖拽悬停高亮:overFolderId 命中时加 ring/blue class,未命中时不加', () => {
    renderFolder(makeFolder())

    expect(nameSpan().className).toContain('text-gray-700')
    expect(header().className).not.toContain('ring-2')

    // Zustand updates are not synchronous to the DOM — act() flushes the re-render.
    act(() => useUIStore.setState({ overFolderId: 10 }))

    expect(header().className).toContain('ring-2')
    expect(nameSpan().className).toContain('text-blue-700')
    expect(svgCount('text-blue-600')).toBeGreaterThan(0)

    act(() => useUIStore.setState({ overFolderId: 999 }))

    expect(header().className).not.toContain('ring-2')
    expect(nameSpan().className).toContain('text-gray-700')
  })

  it('内容区也带 data-folder-id(可作拖拽落点)', () => {
    renderFolder(makeFolder(), { cards: [makeCard()] })

    expect(document.querySelectorAll('[data-folder-id="10"]').length).toBe(2)
  })
})

describe('嵌套子文件夹', () => {
  it('children 渲染为 level+1 的 FolderItem,并把回调继续下传', () => {
    const child = makeFolder({ id: 11, name: '子文件夹', parentId: 10 })
    const h = renderFolder(makeFolder(), { children: [child] })

    const childHeader = document.querySelector('[data-folder-id="11"]') as HTMLElement
    expect(childHeader).not.toBeNull()
    expect(childHeader.style.paddingLeft).toBe('24px')
    expect(screen.getByText('子文件夹')).toBeInTheDocument()

    fireEvent.click(childHeader)
    expect(h.onToggle).toHaveBeenCalledWith(11)

    fireEvent.contextMenu(childHeader)
    expect(h.onContextMenu).toHaveBeenCalledTimes(1)
  })

  it('孙子文件夹用 child.children 继续展开(两层深度)', () => {
    const grand = makeFolder({ id: 12, name: '孙', parentId: 11 })
    renderFolder(makeFolder(), { children: [makeFolder({ id: 11, name: '子', children: [grand] })] })

    const grandHeader = document.querySelector('[data-folder-id="12"]') as HTMLElement
    expect(grandHeader).not.toBeNull()
    expect(grandHeader.style.paddingLeft).toBe('40px')
  })

  it('父文件夹折叠时子文件夹不渲染', () => {
    renderFolder(makeFolder({ collapsed: true }), { children: [makeFolder({ id: 11, name: '子' })] })

    expect(document.querySelector('[data-folder-id="11"]')).toBeNull()
  })
})

describe('重命名编辑态', () => {
  it('进入编辑时渲染输入框、同步 folder.name 并自动聚焦全选', () => {
    renderFolder(makeFolder({ name: '原始名' }), { editingFolderId: 10 })

    const input = editInput()
    expect(input.value).toBe('原始名')
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe('原始名'.length)
    expect(screen.queryByText('原始名')).toBeNull()
  })

  it('editingFolderId 指向别的文件夹时不进入编辑', () => {
    renderFolder(makeFolder(), { editingFolderId: 777 })

    expect(document.querySelector('input[type="text"]')).toBeNull()
    expect(screen.getByText('文件夹A')).toBeInTheDocument()
  })

  it('点击保存:名称有变化时提交 trim 后的值', () => {
    const h = renderFolder(makeFolder(), { editingFolderId: 10 })
    fireEvent.change(editInput(), { target: { value: '  新名字  ' } })

    fireEvent.click(screen.getByTitle('保存'))

    expect(h.onSaveEdit).toHaveBeenCalledTimes(1)
    expect(h.onSaveEdit).toHaveBeenCalledWith(10, '新名字')
    expect(h.onCancelEdit).not.toHaveBeenCalled()
  })

  it('Enter 提交,Escape 取消', () => {
    const h = renderFolder(makeFolder(), { editingFolderId: 10 })
    fireEvent.change(editInput(), { target: { value: '改名' } })

    fireEvent.keyDown(editInput(), { key: 'Enter' })
    expect(h.onSaveEdit).toHaveBeenCalledWith(10, '改名')

    fireEvent.keyDown(editInput(), { key: 'Escape' })
    expect(h.onCancelEdit).toHaveBeenCalledTimes(1)
  })

  it('其他按键既不保存也不取消', () => {
    const h = renderFolder(makeFolder(), { editingFolderId: 10 })

    fireEvent.keyDown(editInput(), { key: 'a' })

    expect(h.onSaveEdit).not.toHaveBeenCalled()
    expect(h.onCancelEdit).not.toHaveBeenCalled()
  })

  it('空名字(纯空格)拒绝保存:不调 onSaveEdit,也不调 onCancelEdit', () => {
    const h = renderFolder(makeFolder(), { editingFolderId: 10 })
    fireEvent.change(editInput(), { target: { value: '   ' } })

    fireEvent.click(screen.getByTitle('保存'))
    fireEvent.keyDown(editInput(), { key: 'Enter' })

    expect(h.onSaveEdit).not.toHaveBeenCalled()
    expect(h.onCancelEdit).not.toHaveBeenCalled()
  })

  it('名称未变化时只 onCancelEdit(不发保存请求)', () => {
    const h = renderFolder(makeFolder({ name: '文件夹A' }), { editingFolderId: 10 })

    fireEvent.click(screen.getByTitle('保存'))

    expect(h.onSaveEdit).not.toHaveBeenCalled()
    expect(h.onCancelEdit).toHaveBeenCalledTimes(1)
  })

  it('点击取消:复原输入框内容并调用 onCancelEdit', () => {
    const h = renderFolder(makeFolder({ name: '原始名' }), { editingFolderId: 10 })
    fireEvent.change(editInput(), { target: { value: '脏数据' } })

    fireEvent.click(screen.getByTitle('取消'))

    expect(editInput().value).toBe('原始名')
    expect(h.onCancelEdit).toHaveBeenCalledTimes(1)
    expect(h.onSaveEdit).not.toHaveBeenCalled()
  })

  it('保存失败:走 logger.error,不向上抛异常', async () => {
    const h = renderFolder(makeFolder(), { editingFolderId: 10 })
    h.onSaveEdit.mockRejectedValue(new Error('服务器拒绝'))
    fireEvent.change(editInput(), { target: { value: '坏名字' } })

    fireEvent.click(screen.getByTitle('保存'))

    await waitFor(() => expect(logger.error).toHaveBeenCalledWith('Failed to save folder name', expect.any(Error)))
  })

  it('编辑态头部点击不会误触发 onToggle(输入框在另一个容器里)', () => {
    const h = renderFolder(makeFolder(), { editingFolderId: 10 })

    fireEvent.click(editInput())

    expect(h.onToggle).not.toHaveBeenCalled()
  })
})

describe('搜索关键词透传', () => {
  it('folder 名不走高亮(仅卡片名高亮),但查询会传给卡片', () => {
    renderFolder(makeFolder({ name: '文件夹A' }), {
      cards: [makeCard({ id: 1, name: '卡1' })],
      searchQuery: '卡',
    })

    expect(screen.getByText('文件夹A')).toBeInTheDocument()
    const hits = Array.from(document.querySelectorAll('.bg-yellow-200')).map((el) => el.textContent)
    expect(hits).toEqual(['卡'])
  })
})
