/**
 * 节点池面板的排序挡位（手动 / 名称 / 创建时间）。
 *
 * 这一段钉住两个曾经出过问题的行为：
 *   1. 排序按钮必须真的改变列表顺序。此前 useNodePoolSort 的返回值被丢弃，
 *      按钮只会变高亮、列表纹丝不动。
 *   2. 「手动」必须是一个真实存在的挡位，并且是默认挡位。否则用户拖完顺序，
 *      列表仍按创建时间排，看起来就是"拖拽没生效"。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { NodeCard, NodePoolFolder } from '@/types'
import { NodePoolPanel } from '../NodePoolPanel'
import { useNodePoolStore } from '../../stores/useNodePoolStore'
import { useUIStore } from '@/store/useUIStore'

vi.mock('@/services/api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getNodePool: vi.fn().mockResolvedValue([]),
    getNodePoolFolders: vi.fn().mockResolvedValue([]),
    addToNodePool: vi.fn(),
    updateNodeCard: vi.fn(),
    removeFromNodePool: vi.fn(),
    createNodePoolFolder: vi.fn(),
    updateNodePoolFolder: vi.fn(),
    deleteNodePoolFolder: vi.fn(),
  }
})

function makeCard(overrides: Partial<NodeCard> = {}): NodeCard {
  return {
    id: 1,
    userId: 1,
    name: '卡片',
    content: '{"title":"卡片"}',
    type: 'text',
    color: '#ffffff',
    tags: null,
    useCount: 0,
    createdBy: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    folderId: null,
    description: null,
    thumbnail: null,
    sortOrder: 0,
    ...overrides,
  }
}

/**
 * 读出界面上卡片名字的顺序（按 DOM 顺序）。
 *
 * 卡片里除了名字还有"添加于 …"和删除按钮，直接取 textContent 会把它们拼进来。
 * 名字是卡片里唯一的 h4，按它取最稳。
 */
function cardNamesInOrder(): string[] {
  return Array.from(document.querySelectorAll('[data-pool-card-id]')).map((el) => {
    const heading = el.querySelector('h4')
    return (heading?.textContent || el.textContent || '').trim()
  })
}

beforeEach(() => {
  useNodePoolStore.setState({
    cardsMap: new Map(),
    foldersMap: new Map(),
    pendingCardIds: new Set(),
    isLoading: false,
    error: null,
  })
  useUIStore.setState({ addToast: vi.fn() })
})

afterEach(() => {
  cleanup()
  Element.prototype.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
    toJSON: () => ({}),
  }) as DOMRect
})

describe('节点池排序挡位', () => {
  it('默认是「手动」：按 sortOrder 排，而不是按创建时间', () => {
    // 创建时间与 sortOrder 故意相反：若默认按创建时间排，顺序会被翻转
    useNodePoolStore.setState({
      cardsMap: new Map<number, NodeCard>([
        [1, makeCard({ id: 1, name: '甲', sortOrder: 30, createdAt: '2026-01-01T00:00:00.000Z' })],
        [2, makeCard({ id: 2, name: '乙', sortOrder: 10, createdAt: '2026-03-01T00:00:00.000Z' })],
        [3, makeCard({ id: 3, name: '丙', sortOrder: 20, createdAt: '2026-02-01T00:00:00.000Z' })],
      ]),
    })

    render(<NodePoolPanel open />)

    // 默认手动 → 乙(10) 丙(20) 甲(30)
    expect(cardNamesInOrder()).toEqual(['乙', '丙', '甲'])
    // 默认挡位按钮必须是「手动」
    const manualBtn = screen.getByText('手动').closest('button')!
    expect(manualBtn.className).toContain('bg-blue-100')
  })

  it('点「名称」按名字升序重排，再点一次变降序，点「手动」回到 sortOrder', () => {
    useNodePoolStore.setState({
      cardsMap: new Map<number, NodeCard>([
        [1, makeCard({ id: 1, name: 'b', sortOrder: 0 })],
        [2, makeCard({ id: 2, name: 'c', sortOrder: 10 })],
        [3, makeCard({ id: 3, name: 'a', sortOrder: 20 })],
      ]),
    })

    render(<NodePoolPanel open />)

    expect(cardNamesInOrder()).toEqual(['b', 'c', 'a'])

    // 第一次点「名称」→ 升序
    fireEvent.click(screen.getByText('名称'))
    expect(cardNamesInOrder()).toEqual(['a', 'b', 'c'])

    // 再点一次 → 降序
    fireEvent.click(screen.getByText('名称'))
    expect(cardNamesInOrder()).toEqual(['c', 'b', 'a'])

    // 点「手动」→ 回到 sortOrder 顺序
    fireEvent.click(screen.getByText('手动'))
    expect(cardNamesInOrder()).toEqual(['b', 'c', 'a'])
  })

  it('「手动」挡位重复点击不会翻成降序（它没有升降可言）', () => {
    useNodePoolStore.setState({
      cardsMap: new Map<number, NodeCard>([
        [1, makeCard({ id: 1, name: 'a', sortOrder: 0 })],
        [2, makeCard({ id: 2, name: 'b', sortOrder: 10 })],
      ]),
    })

    render(<NodePoolPanel open />)
    const before = cardNamesInOrder()

    fireEvent.click(screen.getByText('手动'))
    expect(cardNamesInOrder()).toEqual(before)
  })

  it('点「创建时间」按时间升序', () => {
    useNodePoolStore.setState({
      cardsMap: new Map<number, NodeCard>([
        [1, makeCard({ id: 1, name: '晚', sortOrder: 0, createdAt: '2026-03-01T00:00:00.000Z' })],
        [2, makeCard({ id: 2, name: '早', sortOrder: 10, createdAt: '2026-01-01T00:00:00.000Z' })],
      ]),
    })

    render(<NodePoolPanel open />)
    fireEvent.click(screen.getByText('创建时间'))

    expect(cardNamesInOrder()).toEqual(['早', '晚'])
  })

  it('文件夹里的卡片也参与排序（不是只排根级）', () => {
    const folder: NodePoolFolder = {
      id: 9, userId: 1, name: '夹', parentId: null, sortOrder: 0,
      collapsed: false, createdAt: '2026-01-01T00:00:00.000Z',
    }
    useNodePoolStore.setState({
      cardsMap: new Map<number, NodeCard>([
        [1, makeCard({ id: 1, name: 'z', folderId: 9, sortOrder: 0 })],
        [2, makeCard({ id: 2, name: 'a', folderId: 9, sortOrder: 10 })],
      ]),
      foldersMap: new Map([[9, folder]]),
    })

    render(<NodePoolPanel open />)
    // 手动顺序：z 在前
    expect(cardNamesInOrder()).toEqual(['z', 'a'])

    fireEvent.click(screen.getByText('名称'))
    // 名称升序：a 在前
    expect(cardNamesInOrder()).toEqual(['a', 'z'])
  })
})
