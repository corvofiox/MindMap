/**
 * 拖拽排序的纯计算部分——画布、手稿、节点池三处共用。
 *
 * 只做一件事：给定"同一层级的现有顺序"和"把 A 拖到 B 前面/后面"，
 * 算出哪些条目需要新的 sortOrder。
 *
 * 为什么需要它：三处列表各有自己的拖拽事件，但"插到哪、谁该变成几"是同一道题。
 * 各写一遍必然出现"节点池能拖、笔记本拖了没反应"这种割裂。
 */

export type DropPosition = 'before' | 'after'

export interface SortableItem {
  id: number
  sortOrder: number
}

export interface ReorderUpdate {
  id: number
  sortOrder: number
}

/** 相邻两项的 sortOrder 间隔。留空隙是为了以后单点插入不必重排全表。 */
const STEP = 10

/**
 * 文件夹行拖拽载荷的前缀。
 *
 * 画布行/卡片行往 dataTransfer 里写的是纯数字 id，文件夹行要是也写纯数字，
 * 两边的 dragover 处理器就会互相把对方认成自己人——把画布拖到文件夹上会变成
 * "把文件夹挪走"。加前缀让两类拖拽在载荷层就分得清。
 */
export const FOLDER_DRAG_PREFIX = 'folder:'

export function encodeFolderDragId(id: number): string {
  return `${FOLDER_DRAG_PREFIX}${id}`
}

/** 解析文件夹拖拽载荷；不是文件夹就返回 null（调用方据此放行其他拖拽）。 */
export function parseFolderDragId(raw: string | null | undefined): number | null {
  if (!raw || !raw.startsWith(FOLDER_DRAG_PREFIX)) return null
  const id = Number(raw.slice(FOLDER_DRAG_PREFIX.length))
  return Number.isFinite(id) && id > 0 ? id : null
}

/**
 * 手动顺序比较器：sortOrder 升序，相等时保持原顺序。
 *
 * 老数据里一堆 sortOrder = 0，此时 Array.prototype.sort 的稳定性保证了
 * "没拖过的条目还是原来那样"，不会因为加了排序就整片重排。
 */
export function byManualOrder<T extends { sortOrder?: number | null }>(a: T, b: T): number {
  return (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
}

/**
 * 把 `movedId` 移到 `targetId` 的前面或后面，返回需要更新的条目。
 *
 * 规则：
 *   - 落在自己身上、或目标不存在 → 返回空数组（不做无意义的写库）；
 *   - 结果按新的先后顺序编号（10, 20, 30…），只返回真正变了的条目；
 *   - `movedId` 不在列表里时按"新增到最后"处理（跨分组拖拽时会用到）。
 */
export function computeReorder(
  items: SortableItem[],
  movedId: number,
  targetId: number,
  position: DropPosition,
): ReorderUpdate[] {
  if (movedId === targetId) return []

  const ordered = [...items].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
  const moved = ordered.find((item) => item.id === movedId)
  const rest = ordered.filter((item) => item.id !== movedId)

  // 目标不在列表里：既可能是脏数据，也可能是跨分组（此时由调用方负责改 folderId）
  const targetIndex = rest.findIndex((item) => item.id === targetId)
  if (targetIndex === -1) {
    if (!moved) return []
    // 没有目标就放到末尾
    const appended = [...rest, moved]
    return diff(ordered, appended)
  }

  const insertAt = position === 'before' ? targetIndex : targetIndex + 1
  const next = [...rest.slice(0, insertAt), moved ?? { id: movedId, sortOrder: 0 }, ...rest.slice(insertAt)]

  return diff(ordered, next)
}

/**
 * 比较"原顺序"和"新顺序"，只为位置变了的条目产出新 sortOrder。
 *
 * 用位置而不是真实 sortOrder 做比较：老数据里一堆 0，光看 sortOrder 会漏掉变化。
 */
function diff(before: SortableItem[], after: SortableItem[]): ReorderUpdate[] {
  const beforeIndex = new Map(before.map((item, index) => [item.id, index]))
  const updates: ReorderUpdate[] = []
  after.forEach((item, index) => {
    const previousIndex = beforeIndex.get(item.id)
    const nextOrder = index * STEP
    if (previousIndex !== index || item.sortOrder !== nextOrder) {
      updates.push({ id: item.id, sortOrder: nextOrder })
    }
  })
  return updates
}

/**
 * 从 HTML5 拖拽事件里判断"落在目标的上半还是下半"。
 *
 * 用垂直中线而不是简单的 hover 顺序：否则把条目往上拖到目标顶部时，
 * 用户以为插在前面，实际插到了后面。
 */
export function resolveDropPosition(rect: Pick<DOMRect, 'top' | 'height'>, clientY: number): DropPosition {
  const middle = rect.top + rect.height / 2
  return clientY < middle ? 'before' : 'after'
}
