/**
 * 拖拽排序计算的契约。
 *
 * 这一层被画布列表、手稿列表、节点池三处共用，所以边界条件必须钉死：
 * 拖到自己身上、目标不存在、老数据 sortOrder 全是 0、跨分组拖拽，
 * 每一种都不能写出"顺序看起来变了但库没变"或反之的结果。
 */
import { describe, it, expect } from 'vitest'
import { computeReorder, resolveDropPosition, type SortableItem } from '@/features/drag-sort/reorder'

const item = (id: number, sortOrder: number): SortableItem => ({ id, sortOrder })

describe('computeReorder', () => {
  it('把 A 拖到 C 上方：A 紧挨到 C 前面', () => {
    const items = [item(1, 10), item(2, 20), item(3, 30)]
    const updates = computeReorder(items, 1, 3, 'before')

    // 期望顺序 [2, 1, 3]：1 紧挨在 3 前面
    const result = new Map(updates.map((u) => [u.id, u.sortOrder]))
    expect(result.get(2)).toBe(0)
    expect(result.get(1)).toBe(10)
    expect(result.get(3)).toBe(20)
  })

  it('原地拖到「下一个条目的上方」不改变顺序（只会做一次重编号，之后幂等）', () => {
    // 1 已经在 2 前面，把 1 拖到 2 的上方 —— 顺序不变
    const items = [item(1, 10), item(2, 20)]
    const updates = computeReorder(items, 1, 2, 'before')

    // 顺序没变，所以两个 id 都在，且 1 仍排在 2 前面
    const result = new Map(updates.map((u) => [u.id, u.sortOrder]))
    expect(result.get(1)!).toBeLessThan(result.get(2)!)

    // 应用之后再拖一次，就没有可写的了
    const applied = items.map((entry) => {
      const update = updates.find((u) => u.id === entry.id)
      return update ? { ...entry, sortOrder: update.sortOrder } : entry
    })
    expect(computeReorder(applied, 1, 2, 'before')).toEqual([])
  })

  it('把 A 拖到 C 后面：A 到末尾', () => {
    const items = [item(1, 10), item(2, 20), item(3, 30)]
    const updates = computeReorder(items, 1, 3, 'after')

    const toMap = (list: typeof updates) => new Map(list.map((u) => [u.id, u.sortOrder]))
    const result = toMap(updates)
    expect(result.get(1)).toBeGreaterThan(result.get(3)!)
    expect(updates).toHaveLength(3)
  })

  it('往回拖（往后拖之后又拖回来）能恢复原序', () => {
    const items = [item(1, 10), item(2, 20), item(3, 30)]
    const movedForward = computeReorder(items, 1, 3, 'after')

    // 用新顺序再拖回去
    const afterForward = items.map((entry) => {
      const update = movedForward.find((u) => u.id === entry.id)
      return update ? { ...entry, sortOrder: update.sortOrder } : entry
    })
    const movedBack = computeReorder(afterForward, 1, 2, 'before')

    const finalOrder = afterForward
      .map((entry) => {
        const update = movedBack.find((u) => u.id === entry.id)
        return update ? { ...entry, sortOrder: update.sortOrder } : entry
      })
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((entry) => entry.id)

    expect(finalOrder).toEqual([1, 2, 3])
  })

  it('拖到自己身上：不做任何更新（避免无意义的写库）', () => {
    const items = [item(1, 10), item(2, 20)]
    expect(computeReorder(items, 2, 2, 'before')).toEqual([])
    expect(computeReorder(items, 2, 2, 'after')).toEqual([])
  })

  it('目标不存在：把条目追加到末尾，而不是整批失败', () => {
    const items = [item(1, 10), item(2, 20)]
    const updates = computeReorder(items, 1, 999, 'before')
    const result = new Map(updates.map((u) => [u.id, u.sortOrder]))
    expect(result.get(1)).toBeGreaterThan(result.get(2)!)
  })

  it('老数据 sortOrder 全是 0 也能正确换位（不能靠 sortOrder 判断是否变化）', () => {
    const items = [item(1, 0), item(2, 0), item(3, 0)]
    const updates = computeReorder(items, 3, 1, 'before')

    const result = new Map(updates.map((u) => [u.id, u.sortOrder]))
    expect(result.get(3)).toBeLessThan(result.get(1)!)
    expect(updates.length).toBeGreaterThan(0)
  })

  it('只返回真正变了的条目：已经是最新顺序时为空', () => {
    const items = [item(1, 0), item(2, 10), item(3, 20)]
    // 把 2 拖到 3 前面 —— 位置没变
    const updates = computeReorder(items, 2, 3, 'before')
    expect(updates).toEqual([])
  })

  it('被拖条目不在列表里（跨分组）：按目标位置插入', () => {
    const items = [item(1, 10), item(2, 20)]
    const updates = computeReorder(items, 99, 2, 'before')
    const result = new Map(updates.map((u) => [u.id, u.sortOrder]))
    expect(result.get(99)).toBeLessThan(result.get(2)!)
  })

  it('结果是幂等的：同一操作跑两次，第二次没有更新', () => {
    const items = [item(1, 10), item(2, 20), item(3, 30)]
    const first = computeReorder(items, 1, 3, 'before')
    const applied = items.map((entry) => {
      const update = first.find((u) => u.id === entry.id)
      return update ? { ...entry, sortOrder: update.sortOrder } : entry
    })
    expect(computeReorder(applied, 1, 3, 'before')).toEqual([])
  })
})

describe('resolveDropPosition', () => {
  const rect = { top: 100, height: 40 }

  it('落在上半部分 → 插到前面', () => {
    expect(resolveDropPosition(rect, 110)).toBe('before')
  })

  it('落在下半部分 → 插到后面', () => {
    expect(resolveDropPosition(rect, 130)).toBe('after')
  })

  it('正好在中线按"后面"处理（避免抖动）', () => {
    expect(resolveDropPosition(rect, 120)).toBe('after')
  })
})
