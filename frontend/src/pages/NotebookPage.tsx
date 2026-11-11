import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ChevronDown,
  ChevronRight,
  LayoutGrid,
  PanelLeft,
  Trash2,
  Upload,
} from 'lucide-react'
import { useNotebookStore } from '@/store/useNotebookStore'
import { useNodePoolStore } from '@/features/node-pool/stores/useNodePoolStore'
import { useUIStore } from '@/store/useUIStore'
import { sanitizeHTML } from '@/utils/sanitizeHTML'
import { NotebookSidebar } from '@/features/notebook/NotebookSidebar'
import { NotebookEditor } from '@/features/notebook/NotebookEditor'
import '@/features/notebook/notebook.css'

const AUTOSAVE_DELAY = 800
const SIDEBAR_STORAGE_KEY = 'notebook:sidebar-collapsed'

/** 字数与图片数：从 HTML 里算，避免依赖后端额外字段。 */
function computeStats(html: string): { chars: number; images: number } {
  if (!html) return { chars: 0, images: 0 }
  const holder = document.createElement('div')
  holder.innerHTML = html
  const chars = (holder.textContent || '').replace(/\s+/g, '').length
  return { chars, images: holder.querySelectorAll('img').length }
}

/**
 * 笔记本工作台：左侧手稿列表 + 中间编辑区（docs §8）。
 *
 * 这一页刻意不复用画布的 shell（侧栏项目树 / 节点池面板）——手稿是"打开就写"
 * 的地方，混进画布的工具条只会制造干扰。
 *
 * 布局约定：
 *   - 顶部工具栏只放"页面级动作"（导入 / 送入节点池 / 删除 / 思维导图）；
 *   - 纸张（.notebook-paper）里只有标题、元信息与正文，不放任何破坏性操作；
 *   - 左栏可收纳，状态记在 localStorage，刷新后保持。
 */
export function NotebookPage() {
  const navigate = useNavigate()
  const { id: routeId } = useParams<{ id?: string }>()
  const { addToast } = useUIStore()

  const {
    manuscripts,
    folders,
    active,
    loading,
    saveState,
    query,
    load,
    loadFolders,
    open,
    create,
    save,
    remove,
    moveToFolder,
    addFolder,
    sendToPool,
    restoreFromCard,
  } = useNotebookStore()

  const { cardsMap, loadNodePool } = useNodePoolStore()

  const [titleDraft, setTitleDraft] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [stats, setStats] = useState({ chars: 0, images: 0 })
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1'
    } catch {
      return false
    }
  })

  const editorRef = useRef<HTMLDivElement | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingHtml = useRef<string | null>(null)
  const pendingTitle = useRef<string | null>(null)

  // 首次进入：拉列表与文件夹
  useEffect(() => {
    void load()
    void loadFolders()
    void loadNodePool()
  }, [load, loadFolders, loadNodePool])

  // 路由/选中同步：URL 里有 id 就打开它
  useEffect(() => {
    if (!routeId) return
    const numeric = Number(routeId)
    if (!Number.isInteger(numeric) || numeric <= 0) return
    if (active?.id === numeric) return
    void open(numeric)
  }, [routeId, active?.id, open])

  // 切换手稿时重置草稿与编辑器内容（只在 id 变化时写 DOM，避免打断输入）
  useEffect(() => {
    if (!active) {
      setTitleDraft('')
      setStats({ chars: 0, images: 0 })
      if (editorRef.current) editorRef.current.innerHTML = ''
      return
    }
    setTitleDraft(active.title)
    setStats(computeStats(active.contentHtml || ''))
    if (editorRef.current) {
      editorRef.current.innerHTML = sanitizeHTML(active.contentHtml || '')
    }
  }, [active?.id])

  const flushSave = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const patch: { title?: string; contentHtml?: string } = {}
    if (pendingHtml.current !== null) {
      patch.contentHtml = pendingHtml.current
      pendingHtml.current = null
    }
    if (pendingTitle.current !== null) {
      patch.title = pendingTitle.current
      pendingTitle.current = null
    }
    if (Object.keys(patch).length === 0) return
    void save(patch)
  }, [save])

  const scheduleSave = useCallback(
    (patch: { title?: string; contentHtml?: string }) => {
      if (patch.contentHtml !== undefined) pendingHtml.current = patch.contentHtml
      if (patch.title !== undefined) pendingTitle.current = patch.title
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        const pending: { title?: string; contentHtml?: string } = {}
        if (pendingHtml.current !== null) {
          pending.contentHtml = pendingHtml.current
          pendingHtml.current = null
        }
        if (pendingTitle.current !== null) {
          pending.title = pendingTitle.current
          pendingTitle.current = null
        }
        if (Object.keys(pending).length === 0) return
        void save(pending)
      }, AUTOSAVE_DELAY)
    },
    [save],
  )

  // 卸载前把没落库的内容提交掉（浏览器关页的兜底；REST 有 keepalive 体积限制，
  // 这里只做常规保存，不追加大负载请求）
  useEffect(() => () => flushSave(), [flushSave])

  const toggleSidebar = useCallback(() => {
    setCollapsed((previous) => {
      const next = !previous
      try {
        localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? '1' : '0')
      } catch {
        // 隐私模式下 localStorage 可能不可写，纯 UI 偏好丢了不影响使用
      }
      return next
    })
  }, [])

  const handleCreate = async () => {
    const manuscript = await create()
    if (manuscript) navigate(`/notebook/${manuscript.id}`)
  }

  const handleDelete = async () => {
    if (!active) return
    if (!window.confirm(`删除手稿「${active.title || '未命名'}」？`)) return
    await remove(active.id)
    navigate('/notebook')
  }

  /** 列表里的删除：删的不是当前打开的那篇时不要跳走。 */
  const handleDeleteById = async (id: number) => {
    const target = manuscripts.find((item) => item.id === id)
    if (!window.confirm(`删除手稿「${target?.title || '未命名'}」？`)) return
    await remove(id)
    if (active?.id === id) navigate('/notebook')
  }

  const handleSendToPool = async () => {
    if (!active) return
    flushSave()
    const card = await sendToPool(active.id)
    if (card) {
      addToast({
        type: 'success',
        title: '已送入节点池',
        message: `卡片「${card.name}」已创建，可在思维导图里拖到画布上`,
      })
    } else {
      addToast({ type: 'error', title: '送入失败', message: '请稍后重试' })
    }
  }

  const handleRestore = async (cardId: number) => {
    setImportOpen(false)
    const manuscript = await restoreFromCard(cardId)
    if (manuscript) {
      addToast({ type: 'success', title: '已还原为手稿', message: `「${manuscript.title}」已加入笔记本` })
      navigate(`/notebook/${manuscript.id}`)
    }
  }

  const handleContentInput = () => {
    if (!editorRef.current) return
    const html = editorRef.current.innerHTML
    setStats(computeStats(html))
    scheduleSave({ contentHtml: html })
  }

  /**
   * 粘贴采集：网页上复制的内容带着 HTML（标题/加粗/链接/图片），
   * 直接按纯文本插入会把排版全丢掉。这里保留结构、统一过 sanitizeHTML。
   */
  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const html = event.clipboardData.getData('text/html')
    const text = event.clipboardData.getData('text/plain')
    if (!html && !text) return

    event.preventDefault()
    const safe = html ? sanitizeHTML(html) : sanitizeHTML(`<p>${text.replace(/</g, '&lt;')}</p>`)
    const holder = document.createElement('div')
    holder.innerHTML = safe

    const selection = window.getSelection()
    const hasCaret = selection !== null && selection.rangeCount > 0 && editorRef.current !== null
      && selection.anchorNode !== null && editorRef.current.contains(selection.anchorNode)

    if (hasCaret && selection !== null) {
      const range = selection.getRangeAt(0)
      range.deleteContents()
      const fragment = document.createDocumentFragment()
      while (holder.firstChild) fragment.appendChild(holder.firstChild)
      range.insertNode(fragment)
      range.collapse(false)
    } else if (editorRef.current) {
      // 没有光标（例如刚点开编辑器还没聚焦）：退化为追加到末尾，不能吞掉粘贴。
      editorRef.current.appendChild(holder)
    }

    handleContentInput()
  }

  const cards = useMemo(() => Array.from(cardsMap.values()).slice(0, 50), [cardsMap])

  return (
    <div className="flex h-screen w-screen flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      {/* 顶部工具栏：页面级动作都在这里，纸张里不放 */}
      <header className="z-20 flex h-14 shrink-0 items-center gap-2 border-b border-zinc-200/80 bg-white/85 px-3 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-900/85">
        {collapsed && (
          <button
            type="button"
            onClick={toggleSidebar}
            title="展开侧栏"
            aria-label="展开侧栏"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <PanelLeft size={16} />
          </button>
        )}

        <div className="flex min-w-0 items-center gap-1.5 text-[12.5px]">
          <span className="font-medium text-zinc-800 dark:text-zinc-100">笔记本</span>
          {active && (
            <>
              <ChevronRight size={13} className="text-zinc-300 dark:text-zinc-600" />
              <span className="truncate text-zinc-400 dark:text-zinc-500">
                {saveState === 'saving' ? '保存中…' : '编辑中'}
              </span>
            </>
          )}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          {/* 从节点池导入 */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setImportOpen((value) => !value)}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-50"
            >
              <Upload size={14} />
              <span className="hidden sm:inline">从节点池导入</span>
              <ChevronDown size={12} className={`hidden transition-transform sm:block ${importOpen ? 'rotate-180' : ''}`} />
            </button>

            {importOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setImportOpen(false)} aria-hidden="true" />
                <div className="absolute right-0 z-40 mt-1.5 w-72 overflow-hidden rounded-xl border border-zinc-200/80 bg-white shadow-xl shadow-zinc-900/5 dark:border-zinc-800 dark:bg-zinc-900 dark:shadow-black/40">
                  <div className="border-b border-zinc-100 px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:border-zinc-800">
                    节点池卡片
                  </div>
                  <div className="notebook-scroll max-h-80 overflow-y-auto p-1">
                    {cards.length === 0 && (
                      <p className="px-2.5 py-6 text-center text-[12.5px] text-zinc-400">节点池还是空的</p>
                    )}
                    {cards.map((card) => (
                      <button
                        key={card.id}
                        type="button"
                        onClick={() => { void handleRestore(card.id) }}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        title={card.name}
                      >
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-[11px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                          {(card.name || '未').slice(0, 1)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[12.5px] text-zinc-700 dark:text-zinc-200">
                          {card.name}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* 送入节点池：只在有文档时出现 */}
          {active && (
            <button
              type="button"
              onClick={() => { void handleSendToPool() }}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-[12.5px] font-medium text-white shadow-sm transition hover:bg-blue-700 active:scale-[0.99] dark:hover:bg-blue-500"
            >
              送入节点池
            </button>
          )}

          {/* 删除：图标按钮，红 hover，和主操作拉开距离 */}
          {active && (
            <button
              type="button"
              onClick={() => { void handleDelete() }}
              title="删除手稿"
              aria-label="删除手稿"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
            >
              <Trash2 size={15} />
            </button>
          )}

          <span className="mx-0.5 h-5 w-px bg-zinc-200 dark:bg-zinc-800" aria-hidden="true" />

          <button
            type="button"
            onClick={() => navigate('/projects')}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-50"
          >
            <LayoutGrid size={14} />
            思维导图
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 左栏：可收纳 */}
        <aside
          className={`shrink-0 overflow-hidden border-zinc-200/80 transition-[width] duration-300 ease-out dark:border-zinc-800 ${
            collapsed ? 'w-0' : 'w-[288px] border-r'
          }`}
          aria-hidden={collapsed}
        >
          <div className="h-full w-[288px]">
            <NotebookSidebar
              manuscripts={manuscripts}
              folders={folders}
              activeId={active?.id}
              query={query}
              loading={loading}
              onSearch={(value) => { void load({ q: value }) }}
              onCreate={() => { void handleCreate() }}
              onOpen={(id) => navigate(`/notebook/${id}`)}
              onCollapse={toggleSidebar}
              onAddFolder={(name) => { void addFolder(name) }}
              onMoveToFolder={(id, folderId) => { void moveToFolder(id, folderId) }}
              onDelete={(id) => { void handleDeleteById(id) }}
            />
          </div>
        </aside>

        <NotebookEditor
          active={active}
          titleDraft={titleDraft}
          editorRef={editorRef}
          saveState={saveState}
          stats={stats}
          onCreate={() => { void handleCreate() }}
          onTitleChange={(value) => {
            setTitleDraft(value)
            scheduleSave({ title: value })
          }}
          onTitleBlur={flushSave}
          onContentInput={handleContentInput}
          onPaste={handlePaste}
          onBlur={flushSave}
          onRetrySave={flushSave}
        />
      </div>
    </div>
  )
}
