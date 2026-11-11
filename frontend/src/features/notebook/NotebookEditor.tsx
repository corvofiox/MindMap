import type { ReactNode, RefObject } from 'react'
import { BookOpen, Plus } from 'lucide-react'
import type { Manuscript } from '@/services/api'
import type { SaveState } from '@/store/useNotebookStore'
import { formatRelativeTime } from './NotebookSidebar'

interface NotebookEditorProps {
  active: Manuscript | null
  titleDraft: string
  editorRef: RefObject<HTMLDivElement>
  saveState: SaveState
  stats: { chars: number; images: number }
  onCreate: () => void
  /** 格式工具栏（由页面注入，便于复用命令逻辑与选区状态） */
  toolbar?: ReactNode
  onTitleChange: (value: string) => void
  onTitleBlur: () => void
  onContentInput: () => void
  onPaste: (event: React.ClipboardEvent<HTMLDivElement>) => void
  onBlur: () => void
  onRetrySave: () => void
}

function SaveIndicator({
  state,
  onRetry,
}: {
  state: SaveState
  onRetry: () => void
}) {
  if (state === 'idle') return null

  if (state === 'error') {
    return (
      <button
        type="button"
        onClick={onRetry}
        className="flex items-center gap-1.5 rounded-full bg-red-50 px-2 py-0.5 text-[11.5px] font-medium text-red-600 transition hover:bg-red-100 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
        保存失败，重试
      </button>
    )
  }

  const meta = {
    dirty: { text: '未保存', dot: 'bg-amber-400', tone: 'text-amber-600 dark:text-amber-400' },
    saving: { text: '保存中', dot: 'bg-blue-500 animate-pulse', tone: 'text-zinc-500 dark:text-zinc-400' },
    saved: { text: '已保存', dot: 'bg-emerald-500', tone: 'text-emerald-600 dark:text-emerald-400' },
  }[state]

  return (
    <span className={`flex items-center gap-1.5 text-[11.5px] font-medium ${meta.tone}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      {meta.text}
    </span>
  )
}

function MetaDot() {
  return <span className="h-0.5 w-0.5 rounded-full bg-zinc-300 dark:bg-zinc-600" aria-hidden="true" />
}

/**
 * 中间的文档区。
 *
 * 设计取向：像一张放在桌面上的纸——单独的白底卡片、宽松的页边距、
 * 标题与元信息在卡片顶部，正文是唯一的焦点。操作按钮一律不在纸张里
 * （它们在顶部工具栏），避免"写到一半手滑退出/删除"。
 */
export function NotebookEditor({
  active,
  titleDraft,
  editorRef,
  saveState,
  stats,
  onCreate,
  toolbar,
  onTitleChange,
  onTitleBlur,
  onContentInput,
  onPaste,
  onBlur,
  onRetrySave,
}: NotebookEditorProps) {
  if (!active) {
    return (
      <main className="flex flex-1 items-center justify-center bg-zinc-50/70 p-6 dark:bg-zinc-950">
        <div className="text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-zinc-400 shadow-sm ring-1 ring-zinc-200/80 dark:bg-zinc-900 dark:text-zinc-500 dark:ring-zinc-800">
            <BookOpen size={22} />
          </div>
          <h2 className="mt-4 text-[15px] font-semibold text-zinc-800 dark:text-zinc-100">还没有打开的手稿</h2>
          <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">从左侧选一篇，或新建一篇开始记录</p>
          <button
            type="button"
            onClick={onCreate}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-[13px] font-medium text-white shadow-sm transition hover:bg-blue-700 active:scale-[0.99]"
          >
            <Plus size={15} />
            新建手稿
          </button>
        </div>
      </main>
    )
  }

  return (
    <main className="notebook-scroll flex-1 overflow-y-auto bg-zinc-50/70 dark:bg-zinc-950">
      <div className="mx-auto w-full max-w-[880px] px-5 pb-16 pt-4 lg:px-8">
        {toolbar}
        <article
          key={active.id}
          className="notebook-paper rounded-2xl border border-zinc-200/80 bg-white shadow-[0_1px_2px_rgba(24,24,27,0.04),0_12px_32px_-20px_rgba(24,24,27,0.18)] dark:border-zinc-800 dark:bg-zinc-900"
        >
          <div className="px-7 pt-8 pb-5 lg:px-12 lg:pt-10">
            <input
              value={titleDraft}
              onChange={(event) => onTitleChange(event.target.value)}
              onBlur={onTitleBlur}
              placeholder="手稿标题"
              spellCheck={false}
              className="w-full bg-transparent text-[26px] font-semibold leading-tight tracking-[-0.02em] text-zinc-900 outline-none placeholder:text-zinc-300 lg:text-[30px] dark:text-zinc-50 dark:placeholder:text-zinc-600"
            />

            <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[11.5px] text-zinc-400 dark:text-zinc-500">
              <span>{formatRelativeTime(active.updatedAt) || '刚刚创建'}</span>
              <MetaDot />
              <span className="tabular-nums">{stats.chars} 字</span>
              {stats.images > 0 && (
                <>
                  <MetaDot />
                  <span className="tabular-nums">{stats.images} 张图</span>
                </>
              )}
              <span className="ml-0.5">
                <SaveIndicator state={saveState} onRetry={onRetrySave} />
              </span>
            </div>
          </div>

          <div className="mx-7 h-px bg-gradient-to-r from-transparent via-zinc-200/90 to-transparent lg:mx-12 dark:via-zinc-800" />

          <div className="px-7 pb-12 pt-6 lg:px-12">
            <div
              ref={editorRef}
              contentEditable
              suppressContentEditableWarning
              spellCheck={false}
              data-testid="manuscript-editor"
              data-placeholder="开始输入… 支持直接粘贴网页内容或图片"
              onInput={onContentInput}
              onPaste={onPaste}
              onBlur={onBlur}
              className="notebook-prose min-h-[52vh]"
            />
          </div>
        </article>

        <p className="mt-4 text-center text-[11px] text-zinc-400 dark:text-zinc-600">
          内容会自动保存 · 支持直接粘贴网页内容与图片
        </p>
      </div>
    </main>
  )
}
