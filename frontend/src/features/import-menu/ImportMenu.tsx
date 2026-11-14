import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'

/**
 * 「导入菜单」的共用外壳与行样式。
 *
 * 笔记本页的「从节点池导入」和节点池里的「从笔记本导入」是互为反向的两个动作，
 * 长得却完全不一样（一个圆角卡片列表、一个带箭头和文件夹图标）。这里把外壳、
 * 行、悬浮预览抽出来，两处只提供数据，视觉与交互自然保持一致。
 */

interface ImportMenuShellProps {
  open: boolean
  onClose: () => void
  title: string
  meta?: ReactNode
  children: ReactNode
  testId: string
}

export function ImportMenuShell({ open, onClose, title, meta, children, testId }: ImportMenuShellProps) {
  const panelRef = useRef<HTMLDivElement | null>(null)

  /**
   * 点面板外面就关掉。
   *
   * 不能只靠下面那层遮罩：笔记本页的页头带 `backdrop-blur`，而 backdrop-filter
   * 会让 `position: fixed` 的后代以页头自身为包含块——遮罩实际只盖住页头那条
   * 56px 的横条，点正文区域完全关不掉菜单，菜单会一直挂在右上角挡住顶栏按钮。
   * 所以再挂一个文档级监听，把真正的"点外面"兜住。
   */
  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (target && panelRef.current?.contains(target)) return
      onClose()
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      <div className="fixed inset-0 z-30" onMouseDown={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        data-testid={testId}
        className="absolute right-0 z-40 mt-1.5 w-72 overflow-hidden rounded-xl border border-zinc-200/80 bg-white shadow-xl shadow-zinc-900/5 dark:border-zinc-800 dark:bg-zinc-900 dark:shadow-black/40"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
          <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">{title}</span>
          {meta !== undefined && meta !== null && (
            <span className="text-[11px] tabular-nums text-zinc-400">{meta}</span>
          )}
        </div>
        <div className="notebook-scroll max-h-80 overflow-y-auto p-1">{children}</div>
      </div>
    </>
  )
}

interface ImportMenuRowProps {
  label: string
  /** 左侧方形徽标里的字（通常取标题首字） */
  badge: string
  meta?: ReactNode
  depth?: number
  disabled?: boolean
  onClick: () => void
  onHover?: (event: React.MouseEvent<HTMLButtonElement>) => void
  onLeave?: () => void
  testId?: string
}

export function ImportMenuRow({
  label,
  badge,
  meta,
  depth = 0,
  disabled,
  onClick,
  onHover,
  onLeave,
  testId,
}: ImportMenuRowProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      disabled={disabled}
      className="flex w-full items-center gap-2 rounded-lg py-2 pr-2.5 text-left transition hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
      style={{ paddingLeft: 10 + depth * 12 }}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-[11px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
        {badge}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-zinc-700 dark:text-zinc-200">{label}</span>
      {meta !== undefined && meta !== null && (
        <span className="shrink-0 text-[10.5px] tabular-nums text-zinc-400">{meta}</span>
      )}
    </button>
  )
}

interface ImportMenuFolderRowProps {
  name: string
  count: number
  open: boolean
  depth: number
  onToggle: () => void
  testId?: string
}

/** 文件夹分组行：与手稿行同一套左右留白与圆角，只是左侧是可折叠的箭头 + 文件夹图标 */
export function ImportMenuFolderRow({ name, count, open, depth, onToggle, testId }: ImportMenuFolderRowProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onToggle}
      aria-expanded={open}
      className="flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2.5 text-left transition hover:bg-zinc-100 dark:hover:bg-zinc-800"
      style={{ paddingLeft: 10 + depth * 12 }}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center">
        <svg
          className={`h-3 w-3 text-zinc-400 transition-transform ${open ? 'rotate-90' : ''}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path d="m9 18 6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-zinc-600 dark:text-zinc-300">{name}</span>
      <span className="shrink-0 text-[10.5px] tabular-nums text-zinc-400">{count}</span>
    </button>
  )
}

interface ImportMenuPreviewProps {
  top: number
  left: number
  title: string
  lines: string
  hint: string
  testId?: string
}

/**
 * 悬浮预览：固定定位在菜单左侧，夹在视口内。
 *
 * 必须走 portal：节点池面板自身带 `transform`（开合动画），会让内部的
 * `position: fixed` 以面板为参照，坐标全错、预览跑到屏幕外——这就是
 * "节点池这边没有悬浮预览"的原因。挂到 body 上就不受祖先变换影响。
 */
export function ImportMenuPreview({ top, left, title, lines, hint, testId }: ImportMenuPreviewProps) {
  return createPortal(
    <div
      data-testid={testId}
      className="fixed z-[60] w-72 rounded-xl border border-zinc-200/80 bg-white p-3 shadow-xl shadow-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-800 dark:shadow-black/50"
      style={{ top, left }}
    >
      <p className="truncate text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">{title}</p>
      <p className="mt-1 line-clamp-4 text-[11.5px] leading-5 text-zinc-500 dark:text-zinc-400">
        {lines || '空白内容'}
      </p>
      <p className="mt-2 text-[10.5px] text-zinc-400">{hint}</p>
    </div>,
    document.body,
  )
}
