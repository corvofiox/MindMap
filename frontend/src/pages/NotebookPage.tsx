import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ChevronDown,
  ChevronRight,
  LayoutGrid,
  LogOut,
  PanelLeft,
  Settings,
  Upload,
  User as UserIcon,
} from 'lucide-react'
import { useNotebookStore } from '@/store/useNotebookStore'
import { useNodePoolStore } from '@/features/node-pool/stores/useNodePoolStore'
import { useUIStore } from '@/store/useUIStore'
import { useAuthStore } from '@/store/useAuthStore'
import { DropdownMenu } from '@/components/ui/DropdownMenu'
import { SettingsDialog } from '@/components/ui/SettingsDialog'
import { AccountSettingsDialog } from '@/components/ui/AccountSettingsDialog'
import { sanitizeHTML } from '@/utils/sanitizeHTML'
import { NotebookSidebar } from '@/features/notebook/NotebookSidebar'
import type { FolderSelection } from '@/features/notebook/NotebookFolderTree'
import { NotebookEditor } from '@/features/notebook/NotebookEditor'
import { RichTextToolbar } from '@/features/rich-text/RichTextToolbar'
import {
  ImportMenuPreview,
  ImportMenuRow,
  ImportMenuShell,
} from '@/features/import-menu/ImportMenu'
import { parseCardNodeData } from '@/features/node-pool/utils/createNodeFromCard'
import { insertHtmlAtCaret as insertHtmlIntoEditor } from '@/features/rich-text/editorCommands'
import { useRichTextEditor } from '@/features/rich-text/useRichTextEditor'
import { uploadFile } from '@/services/api'
import type { NodeCard } from '@/types'
import { buildFolderTree, collectSubtreeIds } from '@/features/notebook/NotebookFolderTree'
import { ImportMenuFolderRow } from '@/features/import-menu/ImportMenu'
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
 *   - 顶部工具栏只放"页面级动作"（导入 / 送入节点池 / 思维导图）与最右侧的设置、账号；
 *   - 删除手稿只从左侧抽屉的"更多操作 → 删除"走，顶栏不提供删除；
 *   - 纸张（.notebook-paper）里只有标题、元信息与正文，不放任何破坏性操作；
 *   - 左栏可收纳，状态记在 localStorage，刷新后保持。
 */
export function NotebookPage() {
  const navigate = useNavigate()
  const { id: routeId } = useParams<{ id?: string }>()
  const { addToast } = useUIStore()
  const { user, logout } = useAuthStore()

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
    removeFolder,
    sendToPool,
    restoreFromCard,
  } = useNotebookStore()

  const { cardsMap, foldersMap, loadNodePool } = useNodePoolStore()

  const [titleDraft, setTitleDraft] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [cardPreview, setCardPreview] = useState<{ card: NodeCard; top: number; left: number } | null>(null)
  const [expandedPoolFolders, setExpandedPoolFolders] = useState<Set<number>>(new Set())
  const [stats, setStats] = useState({ chars: 0, images: 0 })
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  // 选中的文件夹由页面持有：侧栏用它筛选，新建手稿也用它决定落点
  const [folderSelection, setFolderSelection] = useState<FolderSelection>('all')
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
    // 在某个文件夹下点"新建手稿"，就应该建在那个文件夹里（之前固定建到未归档）
    const targetFolder = typeof folderSelection === 'number' ? folderSelection : null
    const manuscript = await create(targetFolder)
    if (manuscript) navigate(`/notebook/${manuscript.id}`)
  }

  const handleLogout = async () => {
    await logout()
    navigate('/login')
  }

  /** 删除手稿只有一条路径：左侧抽屉里那篇的「更多操作 → 删除」。 */

  /** 删文件夹：整棵子树连手稿一起删；正在编辑的那篇若在其中，退出编辑区。 */
  const handleDeleteFolder = async (id: number) => {
    const subtree = collectSubtreeIds(folders, id)
    const activeInside = active?.folderId !== null && active?.folderId !== undefined && subtree.has(active.folderId)
    await removeFolder(id)
    if (activeInside) {
      navigate('/notebook')
      addToast({ type: 'info', title: '手稿已随文件夹删除', message: '正在编辑的这篇在被删的文件夹里' })
    }
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
      // 刚送过去的卡片要立刻能在「从节点池导入」里看到，否则菜单还停在旧快照上
      void loadNodePool()
      addToast({
        type: 'success',
        title: '已送入节点池',
        message: `卡片「${card.name}」已创建，可在思维导图里拖到画布上`,
      })
    } else {
      addToast({ type: 'error', title: '送入失败', message: '请稍后重试' })
    }
  }

  const toggleImportMenu = () => {
    const next = !importOpen
    setImportOpen(next)
    if (!next) setCardPreview(null)
    // 每次打开都对齐一次服务端：节点池可能在别处（画布/另一标签页）变过
    else void loadNodePool()
  }

  const handleRestore = async (cardId: number) => {
    setImportOpen(false)
    const manuscript = await restoreFromCard(cardId)
    if (manuscript) {
      addToast({ type: 'success', title: '已还原为手稿', message: `「${manuscript.title}」已加入笔记本` })
      navigate(`/notebook/${manuscript.id}`)
    }
  }

  const handleContentInput = useCallback(() => {
    if (!editorRef.current) return
    const html = editorRef.current.innerHTML
    setStats(computeStats(html))
    scheduleSave({ contentHtml: html })
  }, [scheduleSave])

  /**
   * 粘贴采集与插图共用同一段插入逻辑（来自富文本模块），
   * 保证画布与笔记本的插入语义一致。
   */
  const insertHtmlAtCaret = useCallback((markup: string) => {
    const editor = editorRef.current
    if (!editor) return
    insertHtmlIntoEditor(editor, markup)
    handleContentInput()
  }, [handleContentInput])

  // 富文本状态与命令：与画布节点共用同一个 hook
  const { state: editorState, refresh: refreshEditorState, run: runFormatCommand } = useRichTextEditor({
    getEditor: () => editorRef.current,
  })

  /** 命令执行后要落盘（自动保存），所以包一层；激活态由 hook 内部刷新。 */
  const applyFormat = useCallback((command: Parameters<typeof runFormatCommand>[0], value?: string) => {
    runFormatCommand(command, value)
    handleContentInput()
  }, [runFormatCommand, handleContentInput])

  // 切换手稿后编辑器内容被替换，激活态要跟着重置
  useEffect(() => {
    refreshEditorState()
  }, [active?.id, refreshEditorState])

  const handleImagePicked = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const uploaded = await uploadFile(file)
      insertHtmlAtCaret(`<img src="${uploaded.url}" data-file-id="${uploaded.id}" alt="">`)
    } catch (error) {
      addToast({
        type: 'error',
        title: '插入图片失败',
        message: error instanceof Error ? error.message : '请稍后重试',
      })
    }
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
    insertHtmlAtCaret(safe)
  }

  const cards = useMemo(() => Array.from(cardsMap.values()), [cardsMap])
  const poolFolders = useMemo(() => Array.from(foldersMap.values()), [foldersMap])

  /**
   * 节点池卡片分组：和「从笔记本导入」同一套结构——文件夹默认收起、
   * 展开才露出里面的卡片，未归档放最后。
   */
  const importRows = useMemo(() => {
    const byFolder = new Map<number | null, NodeCard[]>()
    for (const card of cards) {
      const key = card.folderId ?? null
      const list = byFolder.get(key) ?? []
      list.push(card)
      byFolder.set(key, list)
    }

    type Row =
      | { kind: 'folder'; id: number; label: string; depth: number; count: number }
      | { kind: 'card'; card: NodeCard; depth: number }

    const out: Row[] = []
    const walk = (nodes: ReturnType<typeof buildFolderTree>, depth: number) => {
      for (const node of nodes) {
        out.push({ kind: 'folder', id: node.folder.id, label: node.folder.name, depth, count: node.count })
        if (!expandedPoolFolders.has(node.folder.id)) continue
        for (const card of byFolder.get(node.folder.id) ?? []) out.push({ kind: 'card', card, depth: depth + 1 })
        walk(node.children, depth + 1)
      }
    }
    walk(buildFolderTree(poolFolders, cards), 0)
    for (const card of byFolder.get(null) ?? []) out.push({ kind: 'card', card, depth: 0 })
    return out
  }, [cards, poolFolders, expandedPoolFolders])

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
              onClick={toggleImportMenu}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-50"
            >
              <Upload size={14} />
              <span>从节点池导入</span>
              <ChevronDown size={12} className={`transition-transform ${importOpen ? 'rotate-180' : ''}`} />
            </button>

            <ImportMenuShell
              open={importOpen}
              onClose={() => { setImportOpen(false); setCardPreview(null) }}
              title="从节点池导入"
              meta={`${cards.length} 张`}
              testId="notebook-pool-import-menu"
            >
              {cards.length === 0 && (
                <p className="px-2 py-6 text-center text-[12px] text-zinc-400">节点池还是空的</p>
              )}
              {importRows.map((row) =>
                row.kind === 'folder' ? (
                  <ImportMenuFolderRow
                    key={`pool-folder-${row.id}`}
                    testId={`pool-folder-${row.id}`}
                    name={row.label}
                    count={row.count}
                    depth={row.depth}
                    open={expandedPoolFolders.has(row.id)}
                    onToggle={() =>
                      setExpandedPoolFolders((previous) => {
                        const next = new Set(previous)
                        if (next.has(row.id)) next.delete(row.id)
                        else next.add(row.id)
                        return next
                      })
                    }
                  />
                ) : (
                  <ImportMenuRow
                    key={`pool-card-${row.card.id}`}
                    testId={`pool-card-${row.card.id}`}
                    label={row.card.name}
                    badge={(row.card.name || '未').slice(0, 1)}
                    depth={row.depth}
                    meta={row.card.thumbnail ? '有图' : undefined}
                    onClick={() => { void handleRestore(row.card.id) }}
                    onHover={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect()
                      setCardPreview({
                        card: row.card,
                        left: Math.max(8, rect.left - 296),
                        top: Math.max(8, Math.min(rect.top - 8, window.innerHeight - 220)),
                      })
                    }}
                    onLeave={() => setCardPreview(null)}
                  />
                ),
              )}
            </ImportMenuShell>

            {cardPreview && (
              <ImportMenuPreview
                testId="notebook-pool-import-preview"
                top={cardPreview.top}
                left={cardPreview.left}
                title={cardPreview.card.name}
                lines={(() => {
                  const data = parseCardNodeData(cardPreview.card)
                  const raw = String(data.content || '')
                  const holder = document.createElement('div')
                  holder.innerHTML = raw
                  return (holder.textContent || '').trim() || cardPreview.card.description || ''
                })()}
                hint="点击即可还原为手稿"
              />
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

          <span className="mx-0.5 h-5 w-px bg-zinc-200 dark:bg-zinc-800" aria-hidden="true" />

          <button
            type="button"
            onClick={() => navigate('/projects')}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-50"
          >
            <LayoutGrid size={14} />
            思维导图
          </button>

          <span className="mx-0.5 h-5 w-px bg-zinc-200 dark:bg-zinc-800" aria-hidden="true" />

          {/* 设置与账号：与思维导图页保持同一套入口位置（最右侧） */}
          <button
            type="button"
            onClick={() => useUIStore.getState().setSettingsOpen(true)}
            title="设置"
            aria-label="设置"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
          >
            <Settings size={16} />
          </button>

          <DropdownMenu
            trigger={
              <button
                type="button"
                aria-label="账号菜单"
                title="账号菜单"
                className="ml-0.5 flex h-8 w-8 items-center justify-center rounded-full"
              >
                {user?.avatar ? (
                  <img
                    src={user.avatar}
                    alt={user.nickname || user.email || '用户'}
                    className="h-8 w-8 rounded-full object-cover transition hover:ring-2 hover:ring-blue-500"
                  />
                ) : (
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-500 text-[13px] font-medium text-white transition hover:ring-2 hover:ring-blue-500">
                    {(user?.nickname || user?.email || 'U').charAt(0).toUpperCase()}
                  </span>
                )}
              </button>
            }
            items={[
              { label: '账号设置', action: () => useUIStore.getState().setAccountSettingsOpen(true), icon: UserIcon },
              { divider: true },
              { label: '退出登录', action: handleLogout, icon: LogOut },
            ]}
          />
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
              folderSelection={folderSelection}
              onSelectFolder={setFolderSelection}
              onSearch={(value) => { void load({ q: value }) }}
              onCreate={() => { void handleCreate() }}
              onOpen={(id) => navigate(`/notebook/${id}`)}
              onCollapse={toggleSidebar}
              onAddFolder={(name, parentId) => { void addFolder(name, parentId) }}
              onDeleteFolder={(id) => { void handleDeleteFolder(id) }}
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
          toolbar={active ? (
            <RichTextToolbar
              variant="docked"
              state={editorState}
              onCommand={applyFormat}
              onInsertImage={() => imageInputRef.current?.click()}
            />
          ) : null}
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

      {/* 插入图片：隐藏的文件选择器，由工具栏的图片按钮触发 */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(event) => { void handleImagePicked(event) }}
      />

      {/* 笔记本不在 MainLayout 里，设置/账号弹窗要自己挂一份 */}
      <SettingsDialog />
      <AccountSettingsDialog />
    </div>
  )
}
