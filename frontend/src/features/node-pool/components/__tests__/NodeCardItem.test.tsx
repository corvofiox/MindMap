/**
 * NodeCardItem 真实行为测试
 *
 * 只 mock 网络层(@/services/api)——组件本体、useNodePoolStore、useUIStore、
 * sanitizeHTML 全部走真实实现。UI 反馈(addToast)按本仓库既有做法
 * (AccessTokensPanel.test.tsx)替换成 spy。
 *
 * 覆盖的真实逻辑:
 *  - parseCardContent:JSON 内容优先于卡片字段、thumbnail 优先于内容里的 imageUrl、
 *    内容缺 type/title 的回退、畸形 JSON 回退
 *  - SearchHighlighter:命中拆分高亮、正则特殊字符查询不抛错(D3)、HTML 名称 sanitize
 *  - 由解析结果驱动的预览(标题/正文/图片/类型标签/关闭按钮)
 *  - 指针拖拽 → 落点判定(画布 / 文件夹 / 池根目录 / 空白):5px 阈值、文件夹优先、
 *    池与画布重叠时池优先、同文件夹内不重复发请求、processingCardIds 拦截、右键不拖、
 *    落在按钮上不拖
 *  - 拖拽期间 useUIStore(draggingCardFromPool / isOverCanvas / poolDragGhostPosition /
 *    overFolderId)写入与松手复位;nodePoolDragStart / nodePoolDragEnd / canvasDrop 事件
 *  - 无位移点击 → 预览开关;showPreview 时点外/Escape 关闭
 *  - 删除按钮 → onRemove;右键 → onContextMenu;color 内联样式;description 渲染
 *
 * 未覆盖(说明):组件内 `isEditing` 重命名输入框无法从外部置为 true ——
 * `setIsEditing(true)` 在本组件与 NodePoolPanel/FolderItem 调用链中从未被调用,
 * `editingCardId` prop 被 FolderItem 解构后丢弃,属不可达分支。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import type { NodeCard } from '@/types'
import * as api from '@/services/api'
import { NodeCardItem } from '../NodeCardItem'
import { useNodePoolStore } from '../../stores/useNodePoolStore'
import { useUIStore } from '@/store/useUIStore'

vi.mock('@/services/api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getNodePool: vi.fn(),
    getNodePoolFolders: vi.fn(),
    addToNodePool: vi.fn(),
    updateNodeCard: vi.fn(),
    removeFromNodePool: vi.fn(),
    createNodePoolFolder: vi.fn(),
    updateNodePoolFolder: vi.fn(),
    deleteNodePoolFolder: vi.fn(),
  }
})

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>

type Rect = { left: number; top: number; width: number; height: number }

const realGetBoundingClientRect = Element.prototype.getBoundingClientRect
const rectByKey = new Map<string, Rect>()

function setRect(key: string, rect: Rect) {
  rectByKey.set(key, rect)
}

function makeCard(overrides: Partial<NodeCard> = {}): NodeCard {
  return {
    id: 1,
    userId: 1,
    name: '卡片名',
    content: '{"title":"内容标题","content":"内容正文"}',
    type: 'text',
    color: '#fff',
    tags: null,
    useCount: 0,
    createdBy: 1,
    createdAt: '2026-01-02T03:04:05.000Z',
    folderId: null,
    description: null,
    thumbnail: null,
    sortOrder: 0,
    ...overrides,
  }
}

interface TestProps {
  onUse: (card: NodeCard) => void
  onRemove: (id: number) => void
  onSaveName: (id: number, name: string) => void
  onContextMenu: (e: React.MouseEvent, card: NodeCard) => void
  showPreview: boolean
  onTogglePreview: (id: number | null) => void
  searchQuery: string
}

interface HarnessEnv {
  canvas?: boolean
  pool?: boolean
  folder?: number | null
}

/** 渲染卡片 + 落点占位元素(画布容器 / 池面板 / 文件夹行)。 */
function renderCard(card: NodeCard, overrides: Partial<TestProps> = {}, env: HarnessEnv = {}) {
  const props: TestProps = {
    onUse: vi.fn(),
    onRemove: vi.fn(),
    onSaveName: vi.fn(),
    onContextMenu: vi.fn(),
    showPreview: false,
    onTogglePreview: vi.fn(),
    searchQuery: '',
    ...overrides,
  }

  return render(
    <>
      <NodeCardItem
        card={card}
        onUse={props.onUse}
        onRemove={props.onRemove}
        onSaveName={props.onSaveName}
        onContextMenu={props.onContextMenu}
        showPreview={props.showPreview}
        onTogglePreview={props.onTogglePreview}
        searchQuery={props.searchQuery}
      />
      {env.canvas && <div data-canvas-container data-rect="canvas" />}
      {env.pool && <div data-node-pool="true" data-rect="pool" />}
      {typeof env.folder === 'number' && <div data-folder-id={env.folder} data-rect={`folder-${env.folder}`} />}
    </>,
  )
}

/** 卡片根节点(组件里唯一带 inline background-color 的 div)。 */
function cardRoot(): HTMLElement {
  const el = document.querySelector('div[style*="background-color"]')
  if (!el) throw new Error('card root element not found')
  return el as HTMLElement
}

function previewCloseButton(): HTMLElement {
  const el = document.querySelector('.fixed button')
  if (!el) throw new Error('preview close button not found')
  return el as HTMLElement
}

function highlightedSegments(): string[] {
  return Array.from(document.querySelectorAll('.bg-yellow-200')).map((el) => el.textContent ?? '')
}

function press(x = 100, y = 100, button = 0) {
  fireEvent.mouseDown(cardRoot(), { clientX: x, clientY: y, button })
}

function move(x: number, y: number) {
  fireEvent.mouseMove(document, { clientX: x, clientY: y })
}

function release(x: number, y: number) {
  fireEvent.mouseUp(document, { clientX: x, clientY: y })
}

/** 完整拖拽:按下 → 移动超阈值 → 在指定坐标松开。 */
function dragTo(x: number, y: number) {
  press(100, 100)
  move(x, y)
  release(x, y)
}

/** 收集某类自定义事件的 detail。 */
function listen(eventType: string): Array<Record<string, unknown>> {
  const seen: Array<Record<string, unknown>> = []
  const listener = (e: Event) => seen.push((e as CustomEvent).detail as Record<string, unknown>)
  document.addEventListener(eventType, listener)
  return seen
}

beforeEach(() => {
  vi.resetAllMocks()
  rectByKey.clear()
  useNodePoolStore.setState({
    cardsMap: new Map<number, NodeCard>(),
    foldersMap: new Map(),
    dragState: { active: null, over: null },
    isLoading: false,
    error: null,
    pendingCardIds: new Set<number>(),
    operationQueue: new Map(),
    temporaryCards: new Map(),
    processingOperations: new Set<string>(),
    processingCardIds: new Set<number>(),
    pendingUpdates: new Map<number, Partial<NodeCard>>(),
  })
  useUIStore.setState({
    addToast: vi.fn(),
    draggingCardFromPool: null,
    isOverCanvas: false,
    poolDragGhostPosition: null,
    overFolderId: null,
  })
  Element.prototype.getBoundingClientRect = function patched(this: Element): DOMRect {
    const key = this.getAttribute('data-rect')
    const r = (key && rectByKey.get(key)) || { left: 0, top: 0, width: 0, height: 0 }
    return {
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      right: r.left + r.width,
      bottom: r.top + r.height,
      x: r.left,
      y: r.top,
      toJSON: () => ({}),
    } as DOMRect
  }
})

afterEach(() => {
  cleanup()
  Element.prototype.getBoundingClientRect = realGetBoundingClientRect
})

describe('卡片内容解析(parseCardContent → 预览渲染)', () => {
  it('合法 JSON 内容:预览标题/正文取内容里的值,类型标签来自内容', () => {
    renderCard(makeCard({ content: '{"title":"来自内容","content":"来自正文","type":"text"}' }), { showPreview: true })

    expect(screen.getByText('来自内容')).toBeInTheDocument()
    expect(screen.getByText('来自正文')).toBeInTheDocument()
    expect(screen.getByText('类型: text')).toBeInTheDocument()
  })

  it('内容 type=image 且带 imageUrl:预览渲染 img,类型标签为 image', () => {
    renderCard(makeCard({ content: '{"title":"图卡","imageUrl":"https://cdn.test/a.png","type":"image"}' }), { showPreview: true })

    const img = screen.getByRole('img', { name: '图卡' }) as HTMLImageElement
    expect(img.getAttribute('src')).toBe('https://cdn.test/a.png')
    expect(screen.getByText('类型: image')).toBeInTheDocument()
  })

  it('卡片 thumbnail 优先于内容里的 imageUrl', () => {
    renderCard(
      makeCard({
        thumbnail: 'https://cdn.test/thumb.png',
        content: '{"title":"T","imageUrl":"https://cdn.test/origin.png","type":"image"}',
      }),
      { showPreview: true },
    )

    expect((screen.getByRole('img', { name: 'T' }) as HTMLImageElement).getAttribute('src')).toBe(
      'https://cdn.test/thumb.png',
    )
  })

  it('内容缺 type 时回退到 card.type', () => {
    renderCard(makeCard({ type: 'image', content: '{"title":"只有标题"}' }), { showPreview: true })

    expect(screen.getByText('类型: image')).toBeInTheDocument()
  })

  it('内容缺 title 时回退到 card.name', () => {
    renderCard(makeCard({ name: '卡片名', content: '{"content":"只有正文"}' }), { showPreview: true })

    expect(document.querySelector('h3')?.textContent).toBe('卡片名')
    expect(screen.getByText('只有正文')).toBeInTheDocument()
  })

  it('畸形 JSON 内容:原文当正文展示,类型回退 card.type', () => {
    renderCard(makeCard({ content: '这不是 JSON' }), { showPreview: true })

    expect(screen.getByText('这不是 JSON')).toBeInTheDocument()
    expect(screen.getByText('类型: text')).toBeInTheDocument()
  })

  it('正文为空时不渲染正文块', () => {
    renderCard(makeCard({ content: '{"title":"只有标题"}' }), { showPreview: true })

    expect(screen.getByText('只有标题')).toBeInTheDocument()
    expect(cardRoot().querySelector('.whitespace-pre-wrap')).toBeNull()
  })

  it('无图片时不渲染 img', () => {
    renderCard(makeCard({ content: '{"title":"T","content":"C"}' }), { showPreview: true })

    expect(screen.queryByRole('img')).toBeNull()
  })

  it('预览未打开时不渲染内容标题与类型标签', () => {
    renderCard(makeCard(), { showPreview: false })

    expect(screen.queryByText('内容标题')).toBeNull()
    expect(screen.queryByText(/类型:/)).toBeNull()
    expect(document.querySelector('h3')).toBeNull()
  })

  it('预览关闭按钮调用 onTogglePreview(null)', () => {
    const onTogglePreview = vi.fn()
    renderCard(makeCard(), { showPreview: true, onTogglePreview })

    fireEvent.click(previewCloseButton())

    expect(onTogglePreview).toHaveBeenCalledTimes(1)
    expect(onTogglePreview).toHaveBeenCalledWith(null)
  })

  it('背景色取 card.color', () => {
    renderCard(makeCard({ color: '#ff0000' }))

    expect(cardRoot().style.backgroundColor).toBe('rgb(255, 0, 0)')
  })

  it('card.color 为空串时回退白色', () => {
    renderCard(makeCard({ color: '' }))

    expect(cardRoot().style.backgroundColor).toBe('rgb(255, 255, 255)')
  })

  it('删除按钮调用 onRemove(卡片 id)', () => {
    const onRemove = vi.fn()
    renderCard(makeCard({ id: 42 }), { onRemove })

    fireEvent.click(screen.getByTitle('删除'))

    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onRemove).toHaveBeenCalledWith(42)
  })

  it('右键调用 onContextMenu 并带上卡片对象', () => {
    const onContextMenu = vi.fn()
    renderCard(makeCard({ id: 7 }), { onContextMenu })

    fireEvent.contextMenu(cardRoot())

    expect(onContextMenu).toHaveBeenCalledTimes(1)
    expect((onContextMenu.mock.calls[0] as [unknown, NodeCard])[1].id).toBe(7)
  })

  it('添加时间按本地日期渲染', () => {
    renderCard(makeCard({ createdAt: '2026-01-02T03:04:05.000Z' }))

    expect(screen.getByText(`添加于 ${new Date('2026-01-02T03:04:05.000Z').toLocaleDateString()}`)).toBeInTheDocument()
  })

  it('description 存在时渲染摘要,为空时不渲染', () => {
    const { unmount } = renderCard(makeCard({ description: '这是描述' }))
    expect(screen.getByText('这是描述')).toBeInTheDocument()
    unmount()

    renderCard(makeCard({ description: null }))
    expect(screen.queryByText('这是描述')).toBeNull()
  })

  it('预览底部也显示添加日期(两处日期一致)', () => {
    renderCard(makeCard({ createdAt: '2026-01-02T03:04:05.000Z' }), { showPreview: true })

    const label = `添加于 ${new Date('2026-01-02T03:04:05.000Z').toLocaleDateString()}`
    expect(screen.getAllByText(label).length).toBe(2)
  })
})

describe('搜索高亮(SearchHighlighter)', () => {
  it('命中片段被拆进独立高亮 span(大小写不敏感)', () => {
    renderCard(makeCard({ name: 'AlphaBeta' }), { searchQuery: 'beta' })

    expect(highlightedSegments()).toEqual(['Beta'])
    expect(cardRoot().textContent).toContain('Alpha')
  })

  it('多处命中全部高亮', () => {
    renderCard(makeCard({ name: 'aba' }), { searchQuery: 'a' })

    expect(highlightedSegments()).toEqual(['a', 'a'])
  })

  it('无命中时不产生高亮,文本原样保留', () => {
    renderCard(makeCard({ name: '卡片名' }), { searchQuery: 'zzz' })

    expect(highlightedSegments()).toEqual([])
    expect(screen.getByText('卡片名')).toBeInTheDocument()
  })

  it('查询含正则特殊字符不抛错并按字面量匹配(D3)', () => {
    expect(() => {
      renderCard(makeCard({ name: 'c++ 笔记' }), { searchQuery: '++' })
    }).not.toThrow()

    expect(highlightedSegments()).toEqual(['++'])
  })

  it('查询含括号时按字面量匹配', () => {
    renderCard(makeCard({ name: '函数(foo)' }), { searchQuery: '(foo)' })

    expect(highlightedSegments()).toEqual(['(foo)'])
  })

  it('纯空白查询不高亮', () => {
    renderCard(makeCard({ name: '卡片名' }), { searchQuery: '   ' })

    expect(highlightedSegments()).toEqual([])
    expect(screen.getByText('卡片名')).toBeInTheDocument()
  })

  it('HTML 名称 sanitize 后渲染:script 不进入 DOM,合法标签保留(修复前混合输入会整体降级)', () => {
    renderCard(makeCard({ name: '<strong>粗</strong><script>alert(1)</script>' }))

    expect(document.querySelector('script')).toBeNull()
    // The <strong> SURVIVES: the pre-fix sanitizer threw on the mixed input
    // (double-removeChild on the detached script) and safeHTML degraded the
    // whole string to plain text, losing legitimate formatting.
    expect(document.querySelector('strong')?.textContent).toBe('粗')
    // The script element's text remains as inert plain text.
    expect(document.body.textContent).toContain('alert(1)')
  })

  it('命中片段所在的 HTML 名称同样被 sanitize', () => {
    renderCard(makeCard({ name: '<script>alert(1)</script>x' }), { searchQuery: 'alert' })

    expect(document.querySelector('script')).toBeNull()
    expect(highlightedSegments()).toEqual(['alert'])
    expect(cardRoot().textContent).toContain('(1)')
  })

  it('预览标题里的 HTML 也被 sanitize', () => {
    renderCard(
      makeCard({ content: '{"title":"<b>粗标题</b><script>alert(2)</script>","content":"x"}' }),
      { showPreview: true },
    )

    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('h3 b')?.textContent).toBe('粗标题')
  })
})

describe('指针拖拽与落点判定', () => {
  const CANVAS: Rect = { left: 400, top: 0, width: 600, height: 800 }
  const POOL: Rect = { left: 0, top: 0, width: 380, height: 800 }

  beforeEach(() => {
    setRect('canvas', CANVAS)
    setRect('pool', POOL)
  })

  it('拖到画布内:派发 canvasDrop(带卡片与坐标),松手复位 UI 状态', () => {
    const drops = listen('canvasDrop')

    renderCard(makeCard({ id: 3 }), {}, { canvas: true })
    dragTo(500, 300)

    expect(drops).toEqual([
      { card: expect.objectContaining({ id: 3 }), clientX: 500, clientY: 300 },
    ])
    expect(useUIStore.getState().draggingCardFromPool).toBeNull()
    expect(useUIStore.getState().isOverCanvas).toBe(false)
    expect(useUIStore.getState().poolDragGhostPosition).toBeNull()
    expect(mockApi.updateNodeCard).not.toHaveBeenCalled()
  })

  it('拖拽中写入 isOverCanvas 与 ghost 位置,松手后清空', () => {
    renderCard(makeCard(), {}, { canvas: true })

    press(100, 100)
    expect(useUIStore.getState().draggingCardFromPool?.id).toBe(1)

    move(500, 300)
    expect(useUIStore.getState().isOverCanvas).toBe(true)
    expect(useUIStore.getState().poolDragGhostPosition).toEqual({ x: 500, y: 300 })

    release(500, 300)
    expect(useUIStore.getState().isOverCanvas).toBe(false)
    expect(useUIStore.getState().poolDragGhostPosition).toBeNull()
    expect(useUIStore.getState().draggingCardFromPool).toBeNull()
  })

  it('位移未超阈值不进入拖拽:松手按点击处理(打开预览)', () => {
    const onTogglePreview = vi.fn()
    renderCard(makeCard({ id: 8 }), { onTogglePreview }, { canvas: true })

    press(100, 100)
    move(104, 100)
    release(104, 100)

    expect(onTogglePreview).toHaveBeenCalledWith(8)
    expect(useUIStore.getState().draggingCardFromPool).toBeNull()
    expect(useUIStore.getState().isOverCanvas).toBe(false)
  })

  it('按下即松手(零位移)也按点击处理:toggle 传 id', () => {
    const onTogglePreview = vi.fn()
    renderCard(makeCard({ id: 12 }), { onTogglePreview })

    press(70, 70)
    release(70, 70)

    expect(onTogglePreview).toHaveBeenCalledWith(12)
  })

  it('已打开预览时点击卡片 → toggle 传 null(关闭)', () => {
    const onTogglePreview = vi.fn()
    renderCard(makeCard({ id: 13 }), { showPreview: true, onTogglePreview })

    press(70, 70)
    release(70, 70)

    expect(onTogglePreview).toHaveBeenCalledWith(null)
  })

  it('落到文件夹上:调用 updateCard(卡片 id, {folderId}) 并弹成功 toast', async () => {
    setRect('folder-77', { left: 600, top: 200, width: 200, height: 40 })
    useNodePoolStore.getState().setCards([makeCard({ id: 3, folderId: null })])
    mockApi.updateNodeCard.mockResolvedValue(makeCard({ id: 3, folderId: 77 }))

    renderCard(useNodePoolStore.getState().getCard(3)!, {}, { canvas: true, folder: 77 })
    dragTo(650, 220)

    await waitFor(() => expect(mockApi.updateNodeCard).toHaveBeenCalledWith(3, { folderId: 77 }))
    // The release handler clears the hover state the moment the drop begins
    // (production L298-300) — null is the CORRECT post-drop value.
    expect(useUIStore.getState().overFolderId).toBeNull()
    expect(useUIStore.getState().addToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', title: '移动成功' }),
    )
    expect(useNodePoolStore.getState().getCard(3)?.folderId).toBe(77)
  })

  it('移动悬停文件夹时画布高亮被压回 false 且 ghost 清空', () => {
    setRect('folder-77', { left: 600, top: 200, width: 200, height: 40 })
    renderCard(makeCard({ id: 3 }), {}, { canvas: true, folder: 77 })

    press(100, 100)
    move(650, 220)

    expect(useUIStore.getState().overFolderId).toBe(77)
    expect(useUIStore.getState().isOverCanvas).toBe(false)
    expect(useUIStore.getState().poolDragGhostPosition).toBeNull()
  })

  it('文件夹 id 非数字时忽略该落点(不按文件夹处理)', () => {
    const el = document.createElement('div')
    el.setAttribute('data-folder-id', 'abc')
    el.setAttribute('data-rect', 'bad-folder')
    document.body.appendChild(el)
    setRect('bad-folder', { left: 600, top: 200, width: 200, height: 40 })

    renderCard(makeCard({ id: 3 }), {}, { canvas: true })
    press(100, 100)
    move(650, 220)

    expect(useUIStore.getState().overFolderId).toBeNull()
    el.remove()
  })

  it('已在该文件夹内再拖回去:不发 updateCard、不弹 toast', async () => {
    setRect('folder-77', { left: 600, top: 200, width: 200, height: 40 })
    renderCard(makeCard({ id: 3, folderId: 77 }), {}, { canvas: true, folder: 77 })

    dragTo(650, 220)
    await waitFor(() => expect(useUIStore.getState().draggingCardFromPool).toBeNull())

    expect(mockApi.updateNodeCard).not.toHaveBeenCalled()
    expect(useUIStore.getState().addToast).not.toHaveBeenCalled()
  })

  it('移入文件夹失败:弹错误 toast', async () => {
    setRect('folder-77', { left: 600, top: 200, width: 200, height: 40 })
    useNodePoolStore.getState().setCards([makeCard({ id: 3, folderId: null })])
    mockApi.updateNodeCard.mockRejectedValue(new Error('网络错误'))

    renderCard(useNodePoolStore.getState().getCard(3)!, {}, { canvas: true, folder: 77 })
    dragTo(650, 220)

    await waitFor(() => expect(useUIStore.getState().addToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: '移动失败' }),
    ))
  })

  it('落到池根目录:清空 folderId 并弹移出成功 toast', async () => {
    mockApi.updateNodeCard.mockResolvedValue(makeCard({ id: 4, folderId: null }))
    // updateCard is a no-op for cards absent from the store's cardsMap — seed it.
    useNodePoolStore.getState().setCards([makeCard({ id: 4, folderId: 77 })])

    renderCard(makeCard({ id: 4, folderId: 77 }), {}, { canvas: true, pool: true })
    dragTo(200, 300)

    await waitFor(() => expect(mockApi.updateNodeCard).toHaveBeenCalledWith(4, { folderId: null }))
    expect(useUIStore.getState().addToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', title: '移出成功' }),
    )
  })

  it('移出失败:弹错误 toast', async () => {
    mockApi.updateNodeCard.mockRejectedValue(new Error('网络错误'))
    // Seed the store: updateCard is a no-op for cards absent from cardsMap.
    useNodePoolStore.getState().setCards([makeCard({ id: 4, folderId: 77 })])

    renderCard(makeCard({ id: 4, folderId: 77 }), {}, { pool: true })
    dragTo(200, 300)

    await waitFor(() => expect(useUIStore.getState().addToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: '移出失败' }),
    ))
  })

  it('池面板与画布重叠时优先池(坐标虽在画布矩形内)', async () => {
    setRect('canvas', { left: 0, top: 0, width: 1000, height: 800 })
    mockApi.updateNodeCard.mockResolvedValue(makeCard({ id: 4, folderId: null }))
    // updateCard is a no-op for cards absent from the store's cardsMap — seed it.
    useNodePoolStore.getState().setCards([makeCard({ id: 4, folderId: 77 })])

    renderCard(makeCard({ id: 4, folderId: 77 }), {}, { canvas: true, pool: true })
    dragTo(200, 300)

    await waitFor(() => expect(mockApi.updateNodeCard).toHaveBeenCalledWith(4, { folderId: null }))
    expect(useUIStore.getState().isOverCanvas).toBe(false)
  })

  it('已在根目录再落池根:不发 updateCard', async () => {
    renderCard(makeCard({ id: 4, folderId: null }), {}, { pool: true })

    dragTo(200, 300)
    await waitFor(() => expect(useUIStore.getState().draggingCardFromPool).toBeNull())

    expect(mockApi.updateNodeCard).not.toHaveBeenCalled()
  })

  it('落在空白区域:不派发 canvasDrop、不改文件夹', async () => {
    const drops = listen('canvasDrop')

    renderCard(makeCard({ id: 5 }), {}, { canvas: true, pool: true })
    dragTo(5000, 5000)

    await waitFor(() => expect(useUIStore.getState().draggingCardFromPool).toBeNull())
    expect(drops).toEqual([])
    expect(mockApi.updateNodeCard).not.toHaveBeenCalled()
  })

  it('没有画布容器元素时拖拽不算落到画布', async () => {
    const drops = listen('canvasDrop')

    renderCard(makeCard({ id: 5 }), {}, { pool: false })
    dragTo(500, 300)

    await waitFor(() => expect(useUIStore.getState().draggingCardFromPool).toBeNull())
    expect(drops).toEqual([])
  })

  it('拖拽中无画布容器时不写 isOverCanvas/ghost', () => {
    renderCard(makeCard(), {}, {})

    press(100, 100)
    move(500, 300)

    expect(useUIStore.getState().isOverCanvas).toBe(false)
    expect(useUIStore.getState().poolDragGhostPosition).toBeNull()
  })

  it('越过阈值时派发 nodePoolDragStart(带卡片与坐标)', () => {
    const starts = listen('nodePoolDragStart')

    renderCard(makeCard({ id: 6 }))
    dragTo(300, 300)

    expect(starts).toEqual([
      { card: expect.objectContaining({ id: 6 }), clientX: 300, clientY: 300 },
    ])
  })

  it('松手时派发 nodePoolDragEnd', () => {
    const ends = listen('nodePoolDragEnd')

    renderCard(makeCard())
    dragTo(300, 300)

    expect(ends.length).toBe(1)
  })

  it('processingCardIds 中的卡片不可拖拽:不写 UI 状态、不切预览', () => {
    const onTogglePreview = vi.fn()
    useNodePoolStore.setState({ processingCardIds: new Set([1]) })

    renderCard(makeCard({ id: 1 }), { onTogglePreview })
    press(100, 100)
    move(400, 100)
    release(400, 100)

    expect(useUIStore.getState().draggingCardFromPool).toBeNull()
    expect(onTogglePreview).not.toHaveBeenCalled()
  })

  it('右键按下不启动拖拽,松手也不触发预览', () => {
    const onTogglePreview = vi.fn()
    renderCard(makeCard(), { onTogglePreview })

    press(100, 100, 2)
    move(400, 100)
    release(400, 100)

    expect(useUIStore.getState().draggingCardFromPool).toBeNull()
    expect(onTogglePreview).not.toHaveBeenCalled()
  })

  it('在删除按钮上按下不启动拖拽', () => {
    renderCard(makeCard())

    fireEvent.mouseDown(screen.getByTitle('删除'), { clientX: 100, clientY: 100, button: 0 })
    move(400, 100)

    expect(useUIStore.getState().draggingCardFromPool).toBeNull()
    expect(useUIStore.getState().isOverCanvas).toBe(false)
  })

  it('拖拽开始会关闭已打开的预览', () => {
    const onTogglePreview = vi.fn()
    renderCard(makeCard({ id: 9 }), { showPreview: true, onTogglePreview })

    press(100, 100)
    move(200, 200)

    expect(onTogglePreview).toHaveBeenCalledWith(null)
  })

  it('拖拽期间卡片本体隐藏(opacity 0 / visibility hidden)', () => {
    renderCard(makeCard(), {}, { canvas: true })

    press(100, 100)
    move(500, 300)

    expect(cardRoot().style.opacity).toBe('0')
    expect(cardRoot().style.visibility).toBe('hidden')

    release(500, 300)
    expect(cardRoot().style.opacity).toBe('1')
    expect(cardRoot().style.visibility).toBe('visible')
  })

  it('未拖拽时卡片可见', () => {
    renderCard(makeCard())

    expect(cardRoot().style.opacity).toBe('1')
    expect(cardRoot().style.visibility).toBe('visible')
  })
})

describe('预览的退出路径', () => {
  it('showPreview 时点击卡片外部 → onTogglePreview(null)', () => {
    const onTogglePreview = vi.fn()
    renderCard(makeCard(), { showPreview: true, onTogglePreview })

    fireEvent.mouseDown(document.body)

    expect(onTogglePreview).toHaveBeenCalledWith(null)
  })

  it('showPreview 时按 Escape → onTogglePreview(null)', () => {
    const onTogglePreview = vi.fn()
    renderCard(makeCard(), { showPreview: true, onTogglePreview })

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onTogglePreview).toHaveBeenCalledWith(null)
  })

  it('showPreview 时点卡片自身不触发关闭', () => {
    const onTogglePreview = vi.fn()
    renderCard(makeCard(), { showPreview: true, onTogglePreview })

    fireEvent.mouseDown(cardRoot())

    expect(onTogglePreview).not.toHaveBeenCalled()
  })

  it('未打开预览时外部点击/Escape 不触发回调', () => {
    const onTogglePreview = vi.fn()
    renderCard(makeCard(), { showPreview: false, onTogglePreview })

    fireEvent.mouseDown(document.body)
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onTogglePreview).not.toHaveBeenCalled()
  })

  it('未提供 onTogglePreview 时外部点击不抛错', () => {
    renderCard(makeCard({ id: 20 }), { showPreview: true, onTogglePreview: undefined })

    expect(() => {
      fireEvent.mouseDown(document.body)
      fireEvent.keyDown(document, { key: 'Escape' })
    }).not.toThrow()
  })
})
