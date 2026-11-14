import { useCallback, useMemo, useState } from 'react'
import { ChevronDown, Upload } from 'lucide-react'
import { getManuscriptFolders, getManuscripts, manuscriptToNodeCard } from '@/services/api'
import type { ManuscriptFolder, ManuscriptSummary } from '@/services/api'
import { useUIStore } from '@/store/useUIStore'
import { useNotebookStore } from '@/store/useNotebookStore'
import { buildFolderTree } from '@/features/notebook/NotebookFolderTree'
import {
  ImportMenuFolderRow,
  ImportMenuPreview,
  ImportMenuRow,
  ImportMenuShell,
} from '@/features/import-menu/ImportMenu'

interface NotebookImportMenuProps {
  /** 导入成功后的回调（通常用来刷新节点池） */
  onImported: () => void
}

interface ManuscriptRow {
  kind: 'manuscript'
  id: number
  label: string
  depth: number
  imageCount: number
  previewText: string
}

interface FolderRow {
  kind: 'folder'
  id: number
  label: string
  depth: number
  count: number
}

type Row = ManuscriptRow | FolderRow

/**
 * 节点池里的「从笔记本导入」。
 *
 * 与笔记本页的「从节点池导入」互为反向；两者共用同一套菜单外壳与行样式
 * （features/import-menu），避免同一个动作在两处长成两个样子。
 *
 * 文件夹默认收起：手稿可能几十篇、文件夹还带嵌套，全展开会把菜单撑成一面墙。
 * 收起时文件夹行仍显示"含子孙"的篇数，想看内容再点开。
 */
export function NotebookImportMenu({ onImported }: NotebookImportMenuProps) {
  const { addToast } = useUIStore()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [manuscripts, setManuscripts] = useState<ManuscriptSummary[]>([])
  const [folders, setFolders] = useState<ManuscriptFolder[]>([])
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [busyId, setBusyId] = useState<number | null>(null)
  const [preview, setPreview] = useState<{ row: ManuscriptRow; top: number; left: number } | null>(null)

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

  const rows = useMemo<Row[]>(() => {
    const byFolder = new Map<number | null, ManuscriptSummary[]>()
    for (const item of manuscripts) {
      const key = item.folderId ?? null
      const list = byFolder.get(key) ?? []
      list.push(item)
      byFolder.set(key, list)
    }
    const sortItems = (list: ManuscriptSummary[] = []) =>
      list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))

    const toRow = (item: ManuscriptSummary, depth: number): ManuscriptRow => ({
      kind: 'manuscript',
      id: item.id,
      label: item.title || '未命名手稿',
      depth,
      imageCount: item.imageCount,
      previewText: item.previewText,
    })

    const out: Row[] = []
    const walk = (nodes: ReturnType<typeof buildFolderTree>, depth: number) => {
      for (const node of nodes) {
        out.push({
          kind: 'folder',
          id: node.folder.id,
          label: node.folder.name,
          depth,
          count: node.count,
        })
        // 收起时不展开内容；子文件夹也一并隐藏，保持一行是一个分组
        if (!expanded.has(node.folder.id)) continue
        for (const item of sortItems(byFolder.get(node.folder.id))) {
          out.push(toRow(item, depth + 1))
        }
        walk(node.children, depth + 1)
      }
    }

    walk(buildFolderTree(folders, manuscripts), 0)

    // 未归档始终展示（没有文件夹可收起）
    for (const item of sortItems(byFolder.get(null))) {
      out.push(toRow(item, 0))
    }
    return out
  }, [folders, manuscripts, expanded])

  const handleImport = async (id: number) => {
    if (busyId !== null) return
    setBusyId(id)
    try {
      const card = await manuscriptToNodeCard(id)
      // 移动语义：服务端建好卡片就把那篇手稿软删了。笔记本 store 可能还留着
      // 旧快照，本地同步抹掉，免得切过去看到一个点开就 404 的条目。
      useNotebookStore.getState().forget(id)
      addToast({
        type: 'success',
        title: '已移入节点池',
        message: `「${card?.name || '手稿'}」已从笔记本移出，可拖到画布上`,
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

  const showPreview = (event: React.MouseEvent<HTMLButtonElement>, row: ManuscriptRow) => {
    const rect = event.currentTarget.getBoundingClientRect()
    // 节点池在屏幕右侧，预览放左边；夹在视口内
    setPreview({
      row,
      left: Math.max(8, rect.left - 296),
      top: Math.max(8, Math.min(rect.top - 8, window.innerHeight - 220)),
    })
  }

  return (
    <div className="relative">
      {/* 与笔记本页的「从节点池导入」同款：图标 + 文字 + 下指箭头 */}
      <button
        type="button"
        onClick={toggle}
        aria-label="从笔记本导入"
        aria-expanded={open}
        title="从笔记本导入"
        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-50"
      >
        <Upload size={14} />
        <span>从笔记本导入</span>
        <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      <ImportMenuShell
        open={open}
        onClose={() => { setOpen(false); setPreview(null) }}
        title="从笔记本导入"
        meta={`${manuscripts.length} 篇`}
        testId="notebook-import-menu"
      >
        {loading && (
          <p className="px-2 py-6 text-center text-[12px] text-zinc-400">加载中…</p>
        )}
        {!loading && rows.length === 0 && (
          <p className="px-2 py-6 text-center text-[12px] text-zinc-400">笔记本里还没有手稿</p>
        )}
        {!loading && rows.map((row) =>
          row.kind === 'folder' ? (
              <ImportMenuFolderRow
                key={`folder-${row.id}`}
                testId={`import-folder-${row.id}`}
                name={row.label}
                count={row.count}
                depth={row.depth}
                open={expanded.has(row.id)}
                onToggle={() =>
                  setExpanded((previous) => {
                    const next = new Set(previous)
                    if (next.has(row.id)) next.delete(row.id)
                    else next.add(row.id)
                    return next
                  })
                }
              />
            ) : (
              <ImportMenuRow
                key={`manuscript-${row.id}`}
                testId={`import-manuscript-${row.id}`}
                label={row.label}
                badge={(row.label || '未').slice(0, 1)}
                depth={row.depth}
                meta={row.imageCount > 0 ? `${row.imageCount} 图` : undefined}
                disabled={busyId === row.id}
                onClick={() => { void handleImport(row.id) }}
                onHover={(event) => showPreview(event, row)}
                onLeave={() => setPreview(null)}
              />
            ),
        )}
      </ImportMenuShell>

      {preview && (
        <ImportMenuPreview
          testId="notebook-import-preview"
          top={preview.top}
          left={preview.left}
          title={preview.row.label}
          lines={preview.row.previewText}
          hint={`${preview.row.imageCount > 0 ? `${preview.row.imageCount} 张图 · ` : ''}点击转为卡片：手稿会从笔记本移过来`}
        />
      )}
    </div>
  )
}
