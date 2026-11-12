import { useMemo, useState } from 'react'
import {
  ChevronDown,
  FileText,
  FolderClosed,
  FolderPlus,
  Image as ImageIcon,
  MoreHorizontal,
  PanelLeftClose,
  Plus,
  Search,
  Trash2,
} from 'lucide-react'
import type { ManuscriptFolder, ManuscriptSummary } from '@/services/api'
import { NotebookFolderTree, collectSubtreeIds } from './NotebookFolderTree'

interface NotebookSidebarProps {
  manuscripts: ManuscriptSummary[]
  folders: ManuscriptFolder[]
  activeId?: number
  query: string
  loading: boolean
  onSearch: (query: string) => void
  onCreate: () => void
  onOpen: (id: number) => void
  onCollapse: () => void
  /** 收纳：新建手稿夹；parentId 非空时建子文件夹 */
  onAddFolder: (name: string, parentId?: number | null) => void
  /** 删除文件夹（子文件夹会上移到上一层） */
  onDeleteFolder: (id: number) => void
  /** 收纳：把手稿移入某个夹（null = 未归档） */
  onMoveToFolder: (id: number, folderId: number | null) => void
  onDelete: (id: number) => void
}

/**
 * 时间戳来自后端（秒级 epoch 或 ISO 串都见过），这里统一成"多久之前"。
 * 列表里精确到秒没有意义，反而是噪音。
 */
export function formatRelativeTime(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return ''
  const numeric = typeof value === 'number' ? value : Number(value)
  const ms = Number.isFinite(numeric)
    ? (numeric < 1e12 ? numeric * 1000 : numeric)
    : Date.parse(String(value))
  if (!Number.isFinite(ms) || ms <= 0) return ''

  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 172_800_000) return '昨天'

  const date = new Date(ms)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return sameYear
    ? `${date.getMonth() + 1} 月 ${date.getDate()} 日`
    : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

/**
 * 笔记本左侧栏。
 *
 * 结构：搜索 → 新建 → 文件夹（可建/可筛）→ 手稿列表（可移动/可删）。
 * 折叠由父级控制（宽度动画在父级），这里只负责"收起"按钮，避免两处各存一份状态。
 */
export function NotebookSidebar({
  manuscripts,
  folders,
  activeId,
  query,
  loading,
  onSearch,
  onCreate,
  onOpen,
  onCollapse,
  onAddFolder,
  onDeleteFolder,
  onMoveToFolder,
  onDelete,
}: NotebookSidebarProps) {
  const [folderFilter, setFolderFilter] = useState<number | null>(null)
  const [menuFor, setMenuFor] = useState<number | null>(null)

  // 选中父文件夹时，它下面（所有层级）的手稿都要列出来
  const visible = useMemo(() => {
    if (folderFilter === null) return manuscripts
    const ids = collectSubtreeIds(folders, folderFilter)
    return manuscripts.filter((m) => m.folderId !== null && m.folderId !== undefined && ids.has(m.folderId))
  }, [manuscripts, folders, folderFilter])

  const handleAddFolder = (parentId: number | null) => {
    const parentName = parentId === null ? null : folders.find((f) => f.id === parentId)?.name
    const name = window.prompt(parentName ? `在「${parentName}」下新建子文件夹` : '新文件夹名称')?.trim()
    if (name) onAddFolder(name, parentId)
  }

  const handleDeleteFolder = (id: number) => {
    const target = folders.find((f) => f.id === id)
    if (!window.confirm(`删除文件夹「${target?.name || ''}」？里面的手稿会变成未归档，子文件夹会上移一层。`)) return
    onDeleteFolder(id)
    if (folderFilter === id) setFolderFilter(null)
  }

  return (
    <div className="flex h-full flex-col bg-white dark:bg-zinc-900">
      {/* 头部：标题 + 收起 */}
      <div className="flex h-14 shrink-0 items-center gap-2 px-4">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600/10 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400">
          <FileText size={15} />
        </span>
        <span className="text-[15px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">笔记本</span>
        <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          {manuscripts.length}
        </span>
        <button
          type="button"
          onClick={onCollapse}
          title="收起侧栏"
          aria-label="收起侧栏"
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <PanelLeftClose size={16} />
        </button>
      </div>

      {/* 搜索 */}
      <div className="px-3">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            value={query}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="搜索标题或正文"
            className="w-full rounded-lg border border-transparent bg-zinc-100/80 py-1.5 pl-8 pr-2.5 text-[13px] text-zinc-800 outline-none transition placeholder:text-zinc-400 focus:border-blue-300 focus:bg-white focus:ring-2 focus:ring-blue-500/10 dark:bg-zinc-800/70 dark:text-zinc-100 dark:focus:border-blue-700 dark:focus:bg-zinc-900"
          />
        </div>
      </div>

      {/* 新建 */}
      <div className="px-3 pt-2.5">
        <button
          type="button"
          onClick={onCreate}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-blue-600 py-2 text-[13px] font-medium text-white shadow-sm transition hover:bg-blue-700 active:scale-[0.99] dark:hover:bg-blue-500"
        >
          <Plus size={15} />
          新建手稿
        </button>
      </div>

      {/* 文件夹：固定高度的树形列表，超出就滚动 */}
      <div className="px-3 pt-3">
        <div className="flex items-center gap-1">
          <span className="px-1 py-1 text-[11px] font-medium uppercase tracking-wider text-zinc-400">
            文件夹
          </span>
          <button
            type="button"
            onClick={() => handleAddFolder(null)}
            title="新建文件夹"
            aria-label="新建文件夹"
            className="ml-auto flex h-6 w-6 items-center justify-center rounded text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <FolderPlus size={13} />
          </button>
        </div>

        <NotebookFolderTree
          folders={folders}
          manuscripts={manuscripts}
          selectedId={folderFilter}
          onSelect={setFolderFilter}
          onCreate={(parentId) => handleAddFolder(parentId)}
          onDelete={handleDeleteFolder}
        />
      </div>

      {/* 列表 */}
      <div className="notebook-scroll mt-2 flex-1 overflow-y-auto border-t border-zinc-100 px-2 pb-3 pt-1.5 dark:border-zinc-800">
        {loading && (
          <div className="space-y-1 px-1">
            {[0, 1, 2].map((key) => (
              <div key={key} className="animate-pulse rounded-lg px-2 py-2.5">
                <div className="h-3 w-2/3 rounded bg-zinc-100 dark:bg-zinc-800" />
                <div className="mt-2 h-2.5 w-full rounded bg-zinc-100 dark:bg-zinc-800" />
              </div>
            ))}
          </div>
        )}

        {!loading && visible.length === 0 && (
          <div className="flex flex-col items-center px-4 py-10 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500">
              <FileText size={20} />
            </div>
            <p className="mt-3 text-[13px] font-medium text-zinc-700 dark:text-zinc-200">
              {query ? '没有匹配的手稿' : '还没有手稿'}
            </p>
            <p className="mt-1 text-[12px] leading-5 text-zinc-400">
              {query ? '换个关键词试试' : '新建一篇，随手写点东西'}
            </p>
            {!query && (
              <button
                type="button"
                onClick={onCreate}
                className="mt-3 rounded-md border border-zinc-200 px-2.5 py-1 text-[12px] text-zinc-600 transition hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                新建手稿
              </button>
            )}
          </div>
        )}

        {visible.map((item) => {
          const isActive = activeId === item.id
          const menuOpen = menuFor === item.id
          return (
            <div key={item.id} className="group relative mb-0.5">
              <button
                type="button"
                onClick={() => onOpen(item.id)}
                className={`relative w-full rounded-lg px-3 py-2.5 pr-8 text-left transition ${
                  isActive ? 'bg-blue-50 dark:bg-blue-500/10' : 'hover:bg-zinc-100/80 dark:hover:bg-zinc-800/60'
                }`}
              >
                {isActive && (
                  <span className="absolute left-0 top-2.5 bottom-2.5 w-[3px] rounded-full bg-blue-500" aria-hidden="true" />
                )}
                <div className="flex items-baseline gap-2">
                  <span
                    className={`min-w-0 flex-1 truncate text-[13.5px] font-medium ${
                      isActive ? 'text-blue-700 dark:text-blue-300' : 'text-zinc-800 dark:text-zinc-100'
                    }`}
                  >
                    {item.title || '未命名手稿'}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-zinc-400 transition group-hover:opacity-0 dark:text-zinc-500">
                    {formatRelativeTime(item.updatedAt)}
                  </span>
                </div>
                <div className="mt-1 flex items-start gap-1.5">
                  <p className="line-clamp-2 min-w-0 flex-1 text-[12px] leading-5 text-zinc-500 dark:text-zinc-400">
                    {item.previewText || '空白手稿'}
                  </p>
                  {item.imageCount > 0 && (
                    <span className="mt-0.5 flex shrink-0 items-center gap-0.5 rounded bg-zinc-100 px-1 py-0.5 text-[10px] tabular-nums text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                      <ImageIcon size={10} />
                      {item.imageCount}
                    </span>
                  )}
                </div>
              </button>

              <button
                type="button"
                onClick={() => setMenuFor((current) => (current === item.id ? null : item.id))}
                title="更多操作"
                aria-label="更多操作"
                className={`absolute right-1.5 top-2 flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 transition hover:bg-zinc-200/70 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-100 ${
                  menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
                }`}
              >
                <MoreHorizontal size={14} />
              </button>

              {menuOpen && (
                <div
                  data-testid="notebook-item-menu"
                  className="mx-1 mb-1 rounded-lg border border-zinc-200/80 bg-white p-2 shadow-sm dark:border-zinc-700 dark:bg-zinc-800/60"
                >
                  <p className="px-1 pb-1 text-[10.5px] font-medium uppercase tracking-wider text-zinc-400">移动到</p>
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        onMoveToFolder(item.id, null)
                        setMenuFor(null)
                      }}
                      className={`rounded px-1.5 py-0.5 text-[11.5px] transition ${
                        item.folderId === null
                          ? 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-100'
                          : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700'
                      }`}
                    >
                      未归档
                    </button>
                    {folders.map((folder) => (
                      <button
                        key={folder.id}
                        type="button"
                        onClick={() => {
                          onMoveToFolder(item.id, folder.id)
                          setMenuFor(null)
                        }}
                        className={`max-w-full truncate rounded px-1.5 py-0.5 text-[11.5px] transition ${
                          item.folderId === folder.id
                            ? 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-100'
                            : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700'
                        }`}
                      >
                        {folder.name}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuFor(null)
                      onDelete(item.id)
                    }}
                    className="mt-2 flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-[11.5px] text-red-600 transition hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
                  >
                    <Trash2 size={12} />
                    删除这篇
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
