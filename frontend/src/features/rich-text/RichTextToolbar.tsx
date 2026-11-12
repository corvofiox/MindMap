import { useEffect, useRef, useState } from 'react'
import {
  Bold,
  Heading1,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  List,
  ListOrdered,
  Palette,
  Pilcrow,
  Quote,
  RemoveFormatting,
  Strikethrough,
  Underline,
  X,
} from 'lucide-react'
import { Z_INDEX } from '@/constants'
import './rich-text.css'
import type { BlockFormat, EditorState, RichTextCommand } from './editorCommands'

const TEXT_COLORS = [
  '#000000', '#4b5563', '#dc2626', '#ea580c', '#d97706', '#65a30d',
  '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#db2777', '#ffffff',
]

const BLOCKS: { id: BlockFormat; label: string; icon: typeof Pilcrow; value: string }[] = [
  { id: 'p', label: '正文', icon: Pilcrow, value: 'p' },
  { id: 'h1', label: '标题 1', icon: Heading1, value: 'h1' },
  { id: 'h2', label: '标题 2', icon: Heading2, value: 'h2' },
  { id: 'h3', label: '标题 3', icon: Heading3, value: 'h3' },
  { id: 'blockquote', label: '引用', icon: Quote, value: 'blockquote' },
]

interface RichTextToolbarProps {
  state: EditorState
  onCommand: (command: RichTextCommand, value?: string) => void
  /**
   * floating：画布节点上的悬浮条（fixed + 阴影 + 关闭按钮）
   * docked：笔记本顶部的吸顶条（sticky + 背景模糊）
   */
  variant?: 'floating' | 'docked'
  visible?: boolean
  position?: { x: number; y: number }
  onInsertImage?: () => void
  onClose?: () => void
}

/**
 * 富文本工具栏——画布与笔记本共用同一个组件，只有形态不同。
 *
 * 统一之后两处的按钮集合、激活态、颜色逻辑完全一致：以前画布没有标题/列表，
 * 笔记本没有颜色，同一个"编辑器"在不同页面能力不同，属于割裂。
 */
export function RichTextToolbar({
  state,
  onCommand,
  variant = 'docked',
  visible = true,
  position,
  onInsertImage,
  onClose,
}: RichTextToolbarProps) {
  const [colorOpen, setColorOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const floating = variant === 'floating'

  useEffect(() => {
    if (!colorOpen) return
    const close = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setColorOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [colorOpen])

  if (floating && !visible) return null

  const buttonClass = (active: boolean, extra = '') =>
    `flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
      active
        ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-300'
        : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-100'
    } ${extra}`

  const wrapperClass = floating
    ? 'fixed flex items-center gap-0.5 rounded-lg border border-zinc-200 bg-white p-1 shadow-xl dark:border-zinc-700 dark:bg-zinc-800'
    : 'sticky top-0 z-10 flex flex-wrap items-center gap-0.5 rounded-xl border border-zinc-200/80 bg-white/90 px-1.5 py-1 shadow-sm backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-900/90'

  return (
    <div
      ref={rootRef}
      data-rich-text-toolbar="true"
      data-variant={variant}
      className={wrapperClass}
      style={
        floating && position
          ? { left: position.x, top: position.y, transform: 'translateX(-50%)', zIndex: Z_INDEX.RICH_TEXT_TOOLBAR }
          : undefined
      }
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => event.stopPropagation()}
    >
      {BLOCKS.map(({ id, label, icon: Icon, value }) => (
        <button
          key={id}
          type="button"
          tabIndex={-1}
          title={label}
          aria-label={label}
          aria-pressed={state.block === id}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onCommand('formatBlock', value)}
          className={buttonClass(state.block === id)}
        >
          <Icon size={14} />
        </button>
      ))}

      <span className="mx-0.5 h-5 w-px bg-zinc-200 dark:bg-zinc-700" aria-hidden="true" />

      <button
        type="button"
        tabIndex={-1}
        title="加粗 (Ctrl+B)"
        aria-label="加粗 (Ctrl+B)"
        aria-pressed={state.bold}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onCommand('bold')}
        className={buttonClass(state.bold, 'font-bold')}
      >
        <Bold size={14} />
      </button>
      <button
        type="button"
        tabIndex={-1}
        title="斜体 (Ctrl+I)"
        aria-label="斜体 (Ctrl+I)"
        aria-pressed={state.italic}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onCommand('italic')}
        className={buttonClass(state.italic, 'italic')}
      >
        <Italic size={14} />
      </button>
      <button
        type="button"
        tabIndex={-1}
        title="下划线 (Ctrl+U)"
        aria-label="下划线 (Ctrl+U)"
        aria-pressed={state.underline}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onCommand('underline')}
        className={buttonClass(state.underline, 'underline')}
      >
        <Underline size={14} />
      </button>
      <button
        type="button"
        tabIndex={-1}
        title="删除线"
        aria-label="删除线"
        aria-pressed={state.strikeThrough}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onCommand('strikeThrough')}
        className={buttonClass(state.strikeThrough, 'line-through')}
      >
        <Strikethrough size={14} />
      </button>

      <span className="mx-0.5 h-5 w-px bg-zinc-200 dark:bg-zinc-700" aria-hidden="true" />

      <button
        type="button"
        tabIndex={-1}
        title="无序列表"
        aria-label="无序列表"
        aria-pressed={state.unorderedList}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onCommand('insertUnorderedList')}
        className={buttonClass(state.unorderedList)}
      >
        <List size={14} />
      </button>
      <button
        type="button"
        tabIndex={-1}
        title="有序列表"
        aria-label="有序列表"
        aria-pressed={state.orderedList}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onCommand('insertOrderedList')}
        className={buttonClass(state.orderedList)}
      >
        <ListOrdered size={14} />
      </button>

      {/* 颜色：两处都支持，画布原来就有，笔记本这次补齐 */}
      <div className="relative">
        <button
          type="button"
          tabIndex={-1}
          title="文字颜色"
          aria-label="文字颜色"
          aria-pressed={state.color !== null}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setColorOpen((open) => !open)}
          className={buttonClass(state.color !== null)}
        >
          <Palette size={14} />
        </button>

        {colorOpen && (
          <div
            className={`absolute z-10 w-44 rounded-lg border border-zinc-200 bg-white p-2 shadow-xl dark:border-zinc-700 dark:bg-zinc-800 ${
              floating ? 'bottom-full left-0 mb-1' : 'top-full left-0 mt-1'
            }`}
            style={{ zIndex: Z_INDEX.RICH_TEXT_POPOVER }}
            onMouseDown={(event) => event.preventDefault()}
          >
            <div className="flex flex-wrap gap-1.5">
              {TEXT_COLORS.map((color) => {
                const active = state.color?.toLowerCase() === color.toLowerCase()
                return (
                  <button
                    key={color}
                    type="button"
                    tabIndex={-1}
                    title={color}
                    aria-label={`颜色 ${color}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      onCommand('foreColor', color)
                      setColorOpen(false)
                    }}
                    className={`h-6 w-6 rounded border-2 transition ${
                      active ? 'border-blue-500 ring-2 ring-blue-200' : 'border-zinc-200 hover:border-blue-400'
                    }`}
                    style={{ backgroundColor: color }}
                  />
                )
              })}
            </div>
            <div className="mt-1.5 flex items-center justify-between">
              <button
                type="button"
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onCommand('removeForeColor')
                  setColorOpen(false)
                }}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-600 transition hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700"
              >
                <RemoveFormatting size={11} />
                移除颜色
              </button>
              <button
                type="button"
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onCommand('removeFormat')
                  setColorOpen(false)
                }}
                className="rounded px-1.5 py-0.5 text-[11px] text-zinc-500 transition hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-700"
              >
                清除格式
              </button>
            </div>
          </div>
        )}
      </div>

      {onInsertImage && (
        <button
          type="button"
          tabIndex={-1}
          title="插入图片"
          aria-label="插入图片"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onInsertImage}
          className={buttonClass(false)}
        >
          <ImagePlus size={14} />
        </button>
      )}

      {floating && onClose && (
        <>
          <span className="mx-0.5 h-5 w-px bg-zinc-200 dark:bg-zinc-700" aria-hidden="true" />
          <button
            type="button"
            tabIndex={-1}
            title="关闭"
            aria-label="关闭"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-red-500 transition hover:bg-red-50 dark:hover:bg-red-500/10"
          >
            <X size={14} />
          </button>
        </>
      )}

      {!floating && (
        <span className="ml-auto hidden pr-1 text-[11px] text-zinc-400 sm:block dark:text-zinc-500">
          也可以直接粘贴网页内容或图片
        </span>
      )}
    </div>
  )
}
