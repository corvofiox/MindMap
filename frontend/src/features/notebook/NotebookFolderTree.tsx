import { useMemo, useState } from 'react'
import { ChevronRight, Folder, FolderPlus, Inbox, LayoutGrid, Trash2 } from 'lucide-react'
import type { ManuscriptFolder, ManuscriptSummary } from '@/services/api'
import {
  byManualOrder,
  encodeFolderDragId,
  parseFolderDragId,
  resolveDropPosition,
  type DropPosition,
} from '@/features/drag-sort/reorder'

/** 左栏的选中项：全部 / 未归档 / 某个具体文件夹 */
export type FolderSelection = number | 'all' | 'unfiled'

/** 只要求树需要的四个字段：手稿文件夹与节点池文件夹都满足 */
export interface FolderLike {
  id: number
  name: string
  parentId: number | null
  sortOrder: number
}

interface CountableItem {
  folderId?: number | null
}

export interface FolderNode<F extends FolderLike = ManuscriptFolder> {
  folder: F
  children: FolderNode<F>[]
  /** 含所有子孙文件夹里的条目数 */
  count: number
}

/**
 * 把扁平文件夹列表折成树。
 *
 * 容错：父节点不存在（被删了/数据不干净）时把它当根节点，不要让它从界面上
 * 消失——用户看不到自己的文件夹比看到层级错乱更糟。
 */
export function buildFolderTree<F extends FolderLike>(
  folders: F[],
  manuscripts: CountableItem[] = [],
): FolderNode<F>[] {
  const ids = new Set(folders.map((folder) => folder.id))
  const byParent = new Map<number | null, F[]>()
  for (const folder of folders) {
    const parent = folder.parentId !== null && ids.has(folder.parentId) ? folder.parentId : null
    const list = byParent.get(parent) ?? []
    list.push(folder)
    byParent.set(parent, list)
  }

  const directCount = new Map<number, number>()
  for (const manuscript of manuscripts) {
    if (manuscript.folderId === null || manuscript.folderId === undefined) continue
    directCount.set(manuscript.folderId, (directCount.get(manuscript.folderId) ?? 0) + 1)
  }

  const build = (parent: number | null): FolderNode<F>[] =>
    (byParent.get(parent) ?? [])
      .slice()
      .sort((a, b) => byManualOrder(a, b) || a.name.localeCompare(b.name))
      .map((folder) => {
        const children = build(folder.id)
        const count = (directCount.get(folder.id) ?? 0) + children.reduce((sum, child) => sum + child.count, 0)
        return { folder, children, count }
      })

  return build(null)
}

/** 选中某个文件夹时，按"它 + 所有子孙"过滤手稿。 */
export function collectSubtreeIds(folders: ManuscriptFolder[], rootId: number): Set<number> {
  const ids = new Set<number>([rootId])
  let changed = true
  while (changed) {
    changed = false
    for (const folder of folders) {
      if (folder.parentId !== null && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id)
        changed = true
      }
    }
  }
  return ids
}

interface NotebookFolderTreeProps {
  folders: ManuscriptFolder[]
  manuscripts: ManuscriptSummary[]
  /** null = 全部手稿 */
  selectedId: FolderSelection
  onSelect: (selection: FolderSelection) => void
  onCreate: (parentId: number | null) => void
  onDelete: (id: number) => void
  /** 拖拽排序：把文件夹拖到另一个文件夹的前/后 */
  onReorder?: (movedId: number, targetId: number, position: 'before' | 'after') => void
}

/**
 * 文件夹面板。
 *
 * 迭代过一版很丑的：圆角外框 + 浅灰底 + 分隔线三层叠加，行高 46px，计数甩到
 * 最右边，滚动条还把行切开。现在的取向是"紧凑导航"：
 *   - 行高 28px、字号 13，计数紧跟在名字后面（视线不用横跨整行）
 *   - 没有外框，只有 hover / 选中时的淡底色，滚动条与内容之间留出空隙
 *   - 每行开头"箭头槽 + 文件夹图标"宽度固定：叶子节点的箭头槽留空但占位，
 *     保证所有图标的竖向对齐线完全一致
 *   - 高度用 max-h：文件夹少时不撑出一个空框，多了才滚动
 */
export function NotebookFolderTree({
  folders,
  manuscripts,
  selectedId,
  onSelect,
  onCreate,
  onDelete,
  onReorder,
}: NotebookFolderTreeProps) {
  const tree = useMemo(() => buildFolderTree(folders, manuscripts), [folders, manuscripts])
  const total = manuscripts.length
  const unfiled = manuscripts.filter((item) => item.folderId === null || item.folderId === undefined).length
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [dropHint, setDropHint] = useState<{ id: number; position: DropPosition } | null>(null)

  const toggle = (id: number) => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const rowClass = (active: boolean) =>
    `group/row relative flex h-[26px] w-full items-center gap-1.5 rounded-[5px] pl-1.5 pr-1 text-left transition-colors ${
      active
        ? 'bg-blue-50/70 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300'
        : 'text-zinc-600 hover:bg-zinc-100/70 dark:text-zinc-300 dark:hover:bg-zinc-800/60'
    }`

  const countClass = 'ml-1.5 shrink-0 text-[10.5px] tabular-nums text-zinc-400 dark:text-zinc-500'

  const renderNode = (node: FolderNode, depth: number) => {
    const hasChildren = node.children.length > 0
    const isCollapsed = collapsed.has(node.folder.id)
    const active = selectedId === node.folder.id

    return (
      <div key={node.folder.id} role="treeitem" aria-expanded={hasChildren ? !isCollapsed : undefined}>
        <div
          className={rowClass(active)}
          style={{ paddingLeft: 6 + depth * 16 }}
          onClick={() => onSelect(active ? 'all' : node.folder.id)}
          data-folder-row={node.folder.id}
          data-depth={depth}
          title={node.folder.name}
          draggable={!!onReorder}
          onDragStart={(event) => {
            if (!onReorder) return
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', encodeFolderDragId(node.folder.id))
          }}
          onDragEnd={() => setDropHint(null)}
          onDragOver={(event) => {
            if (!onReorder) return
            const dragged = parseFolderDragId(event.dataTransfer.getData('text/plain'))
            if (dragged === null || dragged === node.folder.id) return
            event.preventDefault()
            event.stopPropagation()
            event.dataTransfer.dropEffect = 'move'
            setDropHint({
              id: node.folder.id,
              position: resolveDropPosition(event.currentTarget.getBoundingClientRect(), event.clientY),
            })
          }}
          onDragLeave={() => setDropHint(null)}
          onDrop={(event) => {
            if (!onReorder) return
            const dragged = parseFolderDragId(event.dataTransfer.getData('text/plain'))
            setDropHint(null)
            if (dragged === null || dragged === node.folder.id) return
            event.preventDefault()
            event.stopPropagation()
            const position = resolveDropPosition(event.currentTarget.getBoundingClientRect(), event.clientY)
            onReorder(dragged, node.folder.id, position)
          }}
        >
          {dropHint?.id === node.folder.id && dropHint.position === 'before' && (
            <span className="pointer-events-none absolute inset-x-1 top-0 z-10 h-0.5 rounded-full bg-blue-500" aria-hidden="true" />
          )}
          {active && (
            <span className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full bg-blue-500" aria-hidden="true" />
          )}

          {/* 箭头槽：叶子节点也占位，保证文件夹图标同一竖线 */}
          <button
            type="button"
            aria-label={isCollapsed ? `展开 ${node.folder.name}` : `折叠 ${node.folder.name}`}
            onClick={(event) => {
              event.stopPropagation()
              if (hasChildren) toggle(node.folder.id)
            }}
            tabIndex={hasChildren ? 0 : -1}
            className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded text-zinc-400 transition hover:text-zinc-700 dark:hover:text-zinc-100 ${
              hasChildren ? '' : 'pointer-events-none opacity-0'
            }`}
          >
            <ChevronRight size={11} className={`transition-transform ${isCollapsed ? '' : 'rotate-90'}`} />
          </button>

          <Folder
            size={14}
            className={`shrink-0 ${active ? 'text-blue-500 dark:text-blue-400' : 'text-zinc-400 dark:text-zinc-500'}`}
          />

          <span className="min-w-0 truncate text-[13px] leading-none">{node.folder.name}</span>
          {node.count > 0 && <span className={countClass}>{node.count}</span>}

          <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover/row:opacity-100">
            <button
              type="button"
              title="新建子文件夹"
              aria-label={`在 ${node.folder.name} 下新建子文件夹`}
              onClick={(event) => {
                event.stopPropagation()
                onCreate(node.folder.id)
              }}
              className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 transition hover:bg-white hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
            >
              <FolderPlus size={12} />
            </button>
            <button
              type="button"
              title="删除文件夹"
              aria-label={`删除文件夹 ${node.folder.name}`}
              onClick={(event) => {
                event.stopPropagation()
                onDelete(node.folder.id)
              }}
              className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 transition hover:bg-white hover:text-red-600 dark:hover:bg-zinc-700 dark:hover:text-red-400"
            >
              <Trash2 size={12} />
            </button>
          </span>
          {dropHint?.id === node.folder.id && dropHint.position === 'after' && (
            <span className="pointer-events-none absolute inset-x-1 bottom-0 z-10 h-0.5 rounded-full bg-blue-500" aria-hidden="true" />
          )}
        </div>

        {/* 子级整体包一层并画一条缩进引导线：没有它，层级只是"稍微右移"，看不出来 */}
        {hasChildren && !isCollapsed && (
          <div className="relative">
            <span
              className="pointer-events-none absolute top-0 bottom-0 w-px bg-zinc-200/70 dark:bg-zinc-700/60"
              style={{ left: 6 + depth * 16 + 7 }}
              aria-hidden="true"
            />
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    )
  }

  const shortcut = (id: 'all' | 'unfiled', label: string, count: number, Icon: typeof LayoutGrid, active: boolean, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      data-folder-row={id}
      data-depth="0"
      className={rowClass(active)}
    >
      {active && (
        <span className="absolute left-0 top-1 bottom-1 w-[2px] rounded-full bg-blue-500" aria-hidden="true" />
      )}
      <span className="w-3.5 shrink-0" aria-hidden="true" />
      <Icon
        size={14}
        className={`shrink-0 ${active ? 'text-blue-500 dark:text-blue-400' : 'text-zinc-400 dark:text-zinc-500'}`}
      />
      <span className="min-w-0 truncate text-[13px] leading-none">{label}</span>
      <span className={countClass}>{count}</span>
    </button>
  )

  return (
    <div className="mt-1" data-testid="folder-tree" role="tree" aria-label="文件夹">
      <div className="space-y-0.5">
        {shortcut('all', '全部手稿', total, LayoutGrid, selectedId === 'all', () => onSelect('all'))}
        {shortcut('unfiled', '未归档', unfiled, Inbox, selectedId === 'unfiled', () => onSelect('unfiled'))}
      </div>

      <div className="my-1.5 h-px bg-zinc-100 dark:bg-zinc-800/80" aria-hidden="true" />

      {/* 文件夹少时按内容高度，多了才在这个窗口里滚动 */}
      <div
        className="folder-scroll max-h-[200px] overflow-y-auto pr-2"
        data-testid="folder-scroll"
      >
        {tree.length === 0 ? (
          <p className="px-1.5 py-1.5 text-[11.5px] leading-5 text-zinc-400">
            还没有文件夹，点右上角 + 新建一个。
          </p>
        ) : (
          tree.map((node) => renderNode(node, 0))
        )}
      </div>
    </div>
  )
}
