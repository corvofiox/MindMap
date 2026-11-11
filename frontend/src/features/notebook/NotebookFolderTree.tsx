import { useMemo, useState } from 'react'
import { ChevronRight, FolderClosed, FolderPlus, FolderTree, Trash2 } from 'lucide-react'
import type { ManuscriptFolder, ManuscriptSummary } from '@/services/api'

export interface FolderNode {
  folder: ManuscriptFolder
  children: FolderNode[]
  /** 含所有子孙文件夹里的手稿数 */
  count: number
}

/**
 * 把扁平文件夹列表折成树。
 *
 * 容错：父节点不存在（被删了/数据不干净）时把它当根节点，不要让它从界面上
 * 消失——用户看不到自己的文件夹比看到层级错乱更糟。
 */
export function buildFolderTree(
  folders: ManuscriptFolder[],
  manuscripts: ManuscriptSummary[] = [],
): FolderNode[] {
  const ids = new Set(folders.map((folder) => folder.id))
  const byParent = new Map<number | null, ManuscriptFolder[]>()
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

  const build = (parent: number | null): FolderNode[] =>
    (byParent.get(parent) ?? [])
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
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
  selectedId: number | null
  onSelect: (id: number | null) => void
  onCreate: (parentId: number | null) => void
  onDelete: (id: number) => void
}

/**
 * 文件夹面板。
 *
 * 固定高度的窗口 + 竖向树形列表：文件夹多了就在这一块里滚动，不会把下面的
 * 手稿列表顶走；子文件夹按缩进展开，层级一眼能看出来。
 */
export function NotebookFolderTree({
  folders,
  manuscripts,
  selectedId,
  onSelect,
  onCreate,
  onDelete,
}: NotebookFolderTreeProps) {
  const tree = useMemo(() => buildFolderTree(folders, manuscripts), [folders, manuscripts])
  const total = manuscripts.length
  const unfiled = manuscripts.filter((item) => item.folderId === null || item.folderId === undefined).length
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())

  const toggle = (id: number) => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const rowClass = (active: boolean) =>
    `group flex h-8 w-full items-center gap-1 rounded-md pr-1 text-left transition ${
      active
        ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300'
        : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800/70'
    }`

  const renderNode = (node: FolderNode, depth: number) => {
    const hasChildren = node.children.length > 0
    const isCollapsed = collapsed.has(node.folder.id)
    const active = selectedId === node.folder.id

    return (
      <div key={node.folder.id} role="treeitem" aria-expanded={hasChildren ? !isCollapsed : undefined}>
        <div
          className={rowClass(active)}
          style={{ paddingLeft: 4 + depth * 14 }}
          onClick={() => onSelect(active ? null : node.folder.id)}
          data-folder-row={node.folder.id}
          data-depth={depth}
          title={node.folder.name}
        >
          <button
            type="button"
            aria-label={isCollapsed ? `展开 ${node.folder.name}` : `折叠 ${node.folder.name}`}
            onClick={(event) => {
              event.stopPropagation()
              if (hasChildren) toggle(node.folder.id)
            }}
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-400 transition hover:text-zinc-700 dark:hover:text-zinc-100 ${
              hasChildren ? '' : 'invisible'
            }`}
            tabIndex={hasChildren ? 0 : -1}
          >
            <ChevronRight size={12} className={`transition-transform ${isCollapsed ? '' : 'rotate-90'}`} />
          </button>

          <FolderClosed size={13} className="shrink-0 text-zinc-400" />
          <span className="min-w-0 flex-1 truncate text-[12.5px]">{node.folder.name}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-zinc-400">{node.count}</span>

          <button
            type="button"
            title="新建子文件夹"
            aria-label={`在 ${node.folder.name} 下新建子文件夹`}
            onClick={(event) => {
              event.stopPropagation()
              onCreate(node.folder.id)
            }}
            className="ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-400 opacity-0 transition hover:bg-white hover:text-zinc-700 group-hover:opacity-100 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
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
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-400 opacity-0 transition hover:bg-white hover:text-red-600 group-hover:opacity-100 dark:hover:bg-zinc-700 dark:hover:text-red-400"
          >
            <Trash2 size={12} />
          </button>
        </div>

        {hasChildren && !isCollapsed && node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    )
  }

  return (
    <div
      role="tree"
      aria-label="文件夹"
      data-testid="folder-tree"
      className="notebook-scroll mt-1 h-48 overflow-y-auto rounded-lg border border-zinc-200/80 bg-zinc-50/40 p-1 dark:border-zinc-800 dark:bg-zinc-900/40"
    >
      <div
        className={rowClass(selectedId === null)}
        onClick={() => onSelect(null)}
        data-folder-row="all"
        data-depth="0"
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-zinc-400">
          <FolderTree size={12} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">全部手稿</span>
        <span className="shrink-0 pr-1 text-[11px] tabular-nums text-zinc-400">{total}</span>
      </div>

      <div
        className={`${rowClass(false)} cursor-default`}
        data-folder-row="unfiled"
        data-depth="0"
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-zinc-400">
          <FolderClosed size={12} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px]">未归档</span>
        <span className="shrink-0 pr-1 text-[11px] tabular-nums text-zinc-400">{unfiled}</span>
      </div>

      <div className="my-1 h-px bg-zinc-200/80 dark:bg-zinc-800" aria-hidden="true" />

      {tree.length === 0 ? (
        <p className="px-2 py-3 text-[11.5px] leading-5 text-zinc-400">
          还没有文件夹。点右上角 + 新建，或把鼠标移到文件夹上用 ⧉ 建子文件夹。
        </p>
      ) : (
        tree.map((node) => renderNode(node, 0))
      )}
    </div>
  )
}
