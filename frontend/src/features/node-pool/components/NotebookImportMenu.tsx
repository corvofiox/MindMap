import { useCallback, useMemo, useState } from 'react'
import { BookOpen, ChevronRight, FolderClosed, Image as ImageIcon } from 'lucide-react'
import { getManuscriptFolders, getManuscripts, manuscriptToNodeCard } from '@/services/api'
import type { ManuscriptFolder, ManuscriptSummary } from '@/services/api'
import { useUIStore } from '@/store/useUIStore'
import { buildFolderTree } from '@/features/notebook/NotebookFolderTree'

interface NotebookImportMenuProps {
  /** 导入成功后的回调（通常用来刷新节点池） */
  onImported: () => void
}

interface Row {
  kind: 'folder' | 'manuscript'
  id: number
  label: string
  depth: number
  imageCount?: number
  previewText?: string
}

/**
 * 节点池里的「从笔记本导入」。
 *
 * 与笔记本页的「从节点池导入」互为反向：那边把卡片还原成手稿，这边把手稿
 * 转成卡片。菜单按文件夹层级展示手稿，悬停出预览——否则一长串同名手稿
 * 根本分不清要导哪一篇。
 */
export function NotebookImportMenu({ onImported }: NotebookImportMenuProps) {
  const { addToast } = useUIStore()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [manuscripts, setManuscripts] = useState<ManuscriptSummary[]>([])
  const [folders, setFolders] = useState<ManuscriptFolder[]>([])
  const [busyId, setBusyId] = useState<number | null>(null)
  const [preview, setPreview] = useState<{ row: Row; top: number; left: number } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [list, folderList] = await Promise.all([getManuscripts(), getManuscriptFolders()])
      setManuscripts(list)
      setFolders(folderList)
    } catch (error) {
      addToast({
        type: 'error',
        title: '读取笔记本失败',
        message: error instanceof Error ? error.message : '请稍后重试',
      })
    } finally {
      setLoading(false)
    }
  }, [addToast])

  const toggle = () => {
    const next = !open
    setOpen(next)
    setPreview(null)
    if (next) void load()
  }

  // 文件夹树 → 扁平的行，手稿挂在所属文件夹下面，"未归档"放最后
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    const byFolder = new Map<number | null, ManuscriptSummary[]>()
    for (const item of manuscripts) {
      const key = item.folderId ?? null
      const list = byFolder.get(key) ?? []
      list.push(item)
      byFolder.set(key, list)
    }
    const sortItems = (list: ManuscriptSummary[] = []) =>
      list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))

    const walk = (nodes: ReturnType<typeof buildFolderTree>, depth: number) => {
      for (const node of nodes) {
        out.push({ kind: 'folder', id: node.folder.id, label: node.folder.name, depth })
        for (const item of sortItems(byFolder.get(node.folder.id))) {
          out.push({
            kind: 'manuscript',
            id: item.id,
            label: item.title || '未命名手稿',
            depth: depth + 1,
            imageCount: item.imageCount,
            previewText: item.previewText,
          })
        }
        walk(node.children, depth + 1)
      }
    }

    walk(buildFolderTree(folders, manuscripts), 0)

    for (const item of sortItems(byFolder.get(null))) {
      out.push({
        kind: 'manuscript',
        id: item.id,
        label: item.title || '未命名手稿',
        depth: 0,
        imageCount: item.imageCount,
        previewText: item.previewText,
      })
    }
    return out
  }, [folders, manuscripts])

  const handleImport = async (id: number) => {
    if (busyId !== null) return
    setBusyId(id)
    try {
      const card = await manuscriptToNodeCard(id)
      addToast({
        type: 'success',
        title: '已导入节点池',
        message: `卡片「${card?.name || '手稿'}」已加入，可拖到画布上`,
      })
      setOpen(false)
      setPreview(null)
      onImported()
    } catch (error) {
      addToast({
        type: 'error',
        title: '导入失败',
        message: error instanceof Error ? error.message : '请稍后重试',
      })
    } finally {
      setBusyId(null)
    }
  }

  const showPreview = (event: React.MouseEvent<HTMLButtonElement>, row: Row) => {
    if (row.kind !== 'manuscript') return
    const rect = event.currentTarget.getBoundingClientRect()
    // 节点池在屏幕右侧，预览放左边；夹在视口内
    const left = Math.max(8, rect.left - 288)
    const top = Math.max(8, Math.min(rect.top - 8, window.innerHeight - 220))
    setPreview({ row, top, left })
  }

  return (
    <div className="relative">
      <button
        onClick={toggle}
        className={`p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 ${
          open ? 'text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400'
        }`}
        title="从笔记本导入"
        aria-label="从笔记本导入"
        aria-expanded={open}
      >
        <BookOpen className="w-4 h-4" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onMouseDown={() => { setOpen(false); setPreview(null) }} aria-hidden="true" />
          <div
            data-testid="notebook-import-menu"
            className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-gray-200 bg-white p-1 shadow-xl dark:border-gray-700 dark:bg-gray-800"
          >
            <div className="flex items-center justify-between px-2 py-1">
              <span className="text-[11px] font-medium uppercase tracking-wider text-gray-400">从笔记本导入</span>
              <span className="text-[11px] text-gray-400">{manuscripts.length} 篇</span>
            </div>

            <div className="max-h-80 overflow-y-auto">
              {loading && <p className="px-2 py-4 text-center text-xs text-gray-400">加载中…</p>}
              {!loading && rows.length === 0 && (
                <p className="px-2 py-4 text-center text-xs text-gray-400">笔记本里还没有手稿</p>
              )}

              {rows.map((row) => {
                if (row.kind === 'folder') {
                  return (
                    <div
                      key={`folder-${row.id}`}
                      className="flex items-center gap-1.5 px-2 py-1 text-[11.5px] text-gray-400"
                      style={{ paddingLeft: 8 + row.depth * 12 }}
                    >
                      <FolderClosed className="h-3 w-3 shrink-0" />
                      <span className="truncate">{row.label}</span>
                    </div>
                  )
                }

                return (
                  <button
                    key={`manuscript-${row.id}`}
                    onClick={() => { void handleImport(row.id) }}
                    onMouseEnter={(event) => showPreview(event, row)}
                    onMouseLeave={() => setPreview(null)}
                    disabled={busyId === row.id}
                    className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left transition hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-700"
                    style={{ paddingLeft: 8 + row.depth * 12 }}
                  >
                    <ChevronRight className="h-3 w-3 shrink-0 text-gray-300" />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-gray-700 dark:text-gray-200">
                      {row.label}
                    </span>
                    {(row.imageCount ?? 0) > 0 && (
                      <span className="flex shrink-0 items-center gap-0.5 text-[10px] text-gray-400">
                        <ImageIcon className="h-2.5 w-2.5" />
                        {row.imageCount}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          {/* 悬浮预览：在菜单左侧，避免被右侧边界裁掉 */}
          {preview && (
            <div
              data-testid="notebook-import-preview"
              className="fixed z-[60] w-72 rounded-lg border border-gray-200 bg-white p-3 shadow-xl dark:border-gray-700 dark:bg-gray-800"
              style={{ top: preview.top, left: preview.left }}
            >
              <p className="truncate text-sm font-semibold text-gray-800 dark:text-white">{preview.row.label}</p>
              <p className="mt-1 line-clamp-4 text-xs leading-5 text-gray-500 dark:text-gray-400">
                {preview.row.previewText || '空白手稿'}
              </p>
              <p className="mt-2 text-[11px] text-gray-400">
                {(preview.row.imageCount ?? 0) > 0 ? `${preview.row.imageCount} 张图 · ` : ''}
                点击即可导入节点池
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
