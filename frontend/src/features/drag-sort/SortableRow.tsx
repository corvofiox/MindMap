/**
 * 可拖拽排序的行容器——画布列表、手稿列表、节点池卡片共用。
 *
 * 只做三件事：
 *   1. 告诉浏览器"这一行可以拖"；
 *   2. 拖到别的行上方/下方时给出落点指示线；
 *   3. 松手时把"谁拖到谁前面/后面"报给调用方，由调用方决定写库顺序。
 *
 * 排序计算不在组件里（见 reorder.ts）：三处共用同一份算法，才能保证
 * "笔记本能拖、节点池拖了没反应"这种割裂不会再出现。
 */
import { useRef, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'
import { resolveDropPosition, type DropPosition } from './reorder'

export interface SortableRowProps {
  /** 这一行的稳定标识 */
  rowId: number
  disabled?: boolean
  /** 拖到本行时回调；position 表示插到前后 */
  onDropRow?: (draggedId: number, position: DropPosition) => void
  children: ReactNode
  className?: string
  /** 额外透传（如 data-folder-row） */
  dataAttributes?: Record<string, string>
}

/**
 * 单行。
 *
 * 拖拽源 id 记在 ref 里而不是只依赖 `dataTransfer.getData('text/plain')`：
 * 部分环境（含合成事件的测试）里 dataTransfer 拿不到值，只靠它会导致
 * "拖 A 落 B 却把 B 自己挪走"这种静默错乱。
 */
export function SortableRow({
  rowId,
  disabled = false,
  onDropRow,
  children,
  className,
  dataAttributes,
}: SortableRowProps) {
  const [dropHint, setDropHint] = useState<DropPosition | null>(null)
  const draggedIdRef = useRef<number | null>(null)

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (disabled || !onDropRow) return
    // 必须 preventDefault 才会触发 drop
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropHint(resolveDropPosition(event.currentTarget.getBoundingClientRect(), event.clientY))
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (disabled || !onDropRow) return
    event.preventDefault()
    event.stopPropagation()

    const raw = event.dataTransfer.getData('text/plain')
    const fromPayload = raw ? Number(raw) : NaN
    const draggedId = Number.isFinite(fromPayload) ? fromPayload : draggedIdRef.current
    const position = resolveDropPosition(event.currentTarget.getBoundingClientRect(), event.clientY)
    setDropHint(null)
    draggedIdRef.current = null

    if (draggedId !== null && Number.isFinite(draggedId) && draggedId !== rowId) {
      onDropRow(draggedId, position)
    }
  }

  return (
    <div
      className={clsx('relative', className)}
      draggable={!disabled}
      data-drag-row="true"
      data-row-id={rowId}
      data-drop-hint={dropHint ?? undefined}
      onDragStart={(event) => {
        if (disabled) return
        draggedIdRef.current = rowId
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', String(rowId))
      }}
      onDragEnd={() => {
        draggedIdRef.current = null
        setDropHint(null)
      }}
      onDragOver={handleDragOver}
      onDragLeave={() => setDropHint(null)}
      onDrop={handleDrop}
      {...(dataAttributes ?? {})}
    >
      {dropHint === 'before' && (
        <span
          className="pointer-events-none absolute inset-x-1 -top-px z-10 h-0.5 rounded-full bg-blue-500"
          aria-hidden="true"
        />
      )}
      {children}
      {dropHint === 'after' && (
        <span
          className="pointer-events-none absolute inset-x-1 -bottom-px z-10 h-0.5 rounded-full bg-blue-500"
          aria-hidden="true"
        />
      )}
    </div>
  )
}
