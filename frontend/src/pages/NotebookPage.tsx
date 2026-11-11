import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { FileText, LayoutGrid, Plus, Search, Trash2, Upload } from 'lucide-react'
import { useNotebookStore } from '@/store/useNotebookStore'
import { useNodePoolStore } from '@/features/node-pool/stores/useNodePoolStore'
import { useUIStore } from '@/store/useUIStore'
import { sanitizeHTML } from '@/utils/sanitizeHTML'

const AUTOSAVE_DELAY = 800

/**
 * 笔记本工作台：左侧手稿列表 + 中间编辑区（docs §8）。
 *
 * 这一页刻意不复用画布的 shell（侧栏项目树 / 节点池面板）——手稿是"打开就写"
 * 的地方，混进画布的工具条只会制造干扰。顶部只保留两个入口：思维导图、从节点池
 * 导入。
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
    sendToPool,
    restoreFromCard,
  } = useNotebookStore()

  const { cardsMap, loadNodePool } = useNodePoolStore()

  const [titleDraft, setTitleDraft] = useState('')
  const [importOpen, setImportOpen] = useState(false)
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
      if (editorRef.current) editorRef.current.innerHTML = ''
      return
    }
    setTitleDraft(active.title)
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

    if (editorRef.current) scheduleSave({ contentHtml: editorRef.current.innerHTML })
  }

  const cards = useMemo(() => Array.from(cardsMap.values()).slice(0, 50), [cardsMap])
  const saveLabel = saveState === 'saving'
    ? '保存中…'
    : saveState === 'saved'
      ? '已保存'
      : saveState === 'error'
        ? '保存失败，点这里重试'
        : saveState === 'dirty'
          ? '未保存'
          : ''

  return (
    <div className="h-screen w-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      {/* 顶部：模态切换 + 搜索 + 新建 */}
      <header className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <span className="font-semibold text-gray-800 dark:text-gray-100 flex items-center gap-2">
          <FileText size={18} /> 笔记本
        </span>

        <div className="relative flex-1 max-w-sm">
          <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={query}
            onChange={(e) => { void load({ q: e.target.value }) }}
            placeholder="搜索标题或正文"
            className="w-full pl-8 pr-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-800 dark:text-gray-100"
          />
        </div>

        <button
          onClick={handleCreate}
          className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-1"
        >
          <Plus size={15} /> 新建手稿
        </button>

        <div className="relative">
          <button
            onClick={() => setImportOpen((v) => !v)}
            className="px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-1"
          >
            <Upload size={15} /> 从节点池导入
          </button>
          {importOpen && (
            <div className="absolute right-0 mt-1 w-72 max-h-80 overflow-auto rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 shadow-lg z-50">
              {cards.length === 0 && (
                <p className="px-3 py-2 text-sm text-gray-500">节点池还是空的</p>
              )}
              {cards.map((card) => (
                <button
                  key={card.id}
                  onClick={() => { void handleRestore(card.id) }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 truncate"
                  title={card.name}
                >
                  {card.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={() => navigate('/projects')}
          className="ml-auto px-3 py-1.5 text-sm rounded-md border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-1"
        >
          <LayoutGrid size={15} /> 思维导图
        </button>
      </header>

      <div className="flex-1 flex min-h-0">
        {/* 左：手稿列表 */}
        <aside className="w-72 shrink-0 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-y-auto">
          {loading && <p className="px-4 py-3 text-sm text-gray-500">加载中…</p>}
          {!loading && manuscripts.length === 0 && (
            <p className="px-4 py-6 text-sm text-gray-500">
              还没有手稿。点右上角「新建手稿」开始记录。
            </p>
          )}
          {manuscripts.map((item) => (
            <button
              key={item.id}
              onClick={() => navigate(`/notebook/${item.id}`)}
              className={`w-full text-left px-4 py-3 border-b border-gray-100 dark:border-gray-700/60 hover:bg-gray-50 dark:hover:bg-gray-700/50 ${
                active?.id === item.id ? 'bg-blue-50 dark:bg-blue-900/20' : ''
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span className="flex-1 truncate text-sm font-medium text-gray-800 dark:text-gray-100">
                  {item.title || '未命名手稿'}
                </span>
                {item.imageCount > 0 && (
                  <span className="text-[10px] text-gray-400">{item.imageCount} 图</span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 truncate">
                {item.previewText || '空白手稿'}
              </p>
            </button>
          ))}
          {folders.length > 0 && (
            <div className="px-4 py-3 text-xs text-gray-400">
              文件夹：{folders.map((f) => f.name).join('、')}
            </div>
          )}
        </aside>

        {/* 右：编辑区 */}
        <main className="flex-1 min-w-0 overflow-y-auto">
          {!active ? (
            <div className="h-full flex items-center justify-center text-sm text-gray-400">
              选择左侧手稿，或新建一篇
            </div>
          ) : (
            <div className="max-w-3xl mx-auto px-8 py-8">
              <div className="flex items-center gap-2">
                <input
                  value={titleDraft}
                  onChange={(e) => {
                    setTitleDraft(e.target.value)
                    scheduleSave({ title: e.target.value })
                  }}
                  onBlur={flushSave}
                  placeholder="手稿标题"
                  className="flex-1 text-2xl font-semibold bg-transparent outline-none text-gray-900 dark:text-gray-50"
                />
                <button
                  onClick={handleSendToPool}
                  className="px-3 py-1.5 text-sm rounded-md bg-emerald-600 text-white hover:bg-emerald-700 whitespace-nowrap"
                >
                  送入节点池
                </button>
                <button
                  onClick={handleDelete}
                  title="删除手稿"
                  className="p-1.5 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                >
                  <Trash2 size={16} />
                </button>
              </div>

              <div
                ref={editorRef}
                contentEditable
                suppressContentEditableWarning
                data-testid="manuscript-editor"
                onInput={() => {
                  if (editorRef.current) scheduleSave({ contentHtml: editorRef.current.innerHTML })
                }}
                onPaste={handlePaste}
                onBlur={flushSave}
                className="mt-6 min-h-[60vh] outline-none text-[15px] leading-7 text-gray-800 dark:text-gray-100 [&_img]:max-w-full [&_img]:rounded-md"
              />

              <div className="mt-4 h-5 text-xs text-gray-400">
                {saveState === 'error' ? (
                  <button className="text-red-500" onClick={flushSave}>{saveLabel}</button>
                ) : (
                  saveLabel
                )}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
