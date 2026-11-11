import {
  Bold,
  Heading1,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  List,
  ListOrdered,
  Pilcrow,
  Quote,
  Strikethrough,
  Underline,
} from 'lucide-react'

/** 当前选区所处的块级格式（正文 / 标题 / 引用）。 */
export type BlockFormat = 'p' | 'h1' | 'h2' | 'h3' | 'blockquote'

export interface InlineFormats {
  bold: boolean
  italic: boolean
  underline: boolean
  strikeThrough: boolean
  insertUnorderedList: boolean
  insertOrderedList: boolean
}

interface NotebookFormatToolbarProps {
  block: BlockFormat
  formats: InlineFormats
  onCommand: (command: string, value?: string) => void
  onInsertImage: () => void
}

const BLOCKS: { id: BlockFormat; label: string; icon: typeof Pilcrow; command: string }[] = [
  { id: 'p', label: '正文', icon: Pilcrow, command: 'P' },
  { id: 'h1', label: '标题 1', icon: Heading1, command: 'H1' },
  { id: 'h2', label: '标题 2', icon: Heading2, command: 'H2' },
  { id: 'h3', label: '标题 3', icon: Heading3, command: 'H3' },
  { id: 'blockquote', label: '引用', icon: Quote, command: 'BLOCKQUOTE' },
]

const MARKS: { id: keyof InlineFormats; label: string; icon: typeof Bold; command: string; className?: string }[] = [
  { id: 'bold', label: '加粗 (Ctrl+B)', icon: Bold, command: 'bold' },
  { id: 'italic', label: '斜体 (Ctrl+I)', icon: Italic, command: 'italic', className: 'italic' },
  { id: 'underline', label: '下划线 (Ctrl+U)', icon: Underline, command: 'underline', className: 'underline' },
  { id: 'strikeThrough', label: '删除线', icon: Strikethrough, command: 'strikeThrough', className: 'line-through' },
]

/**
 * 笔记本的格式工具栏。
 *
 * 放在纸张上方、跟随编辑区吸顶。所有按钮都阻止 mousedown 默认行为，
 * 否则点按钮会让 contentEditable 失焦、选区丢失，命令就打到空气里了。
 */
export function NotebookFormatToolbar({
  block,
  formats,
  onCommand,
  onInsertImage,
}: NotebookFormatToolbarProps) {
  const buttonClass = (active: boolean, extra = '') =>
    `flex h-8 w-8 items-center justify-center rounded-md transition ${
      active
        ? 'bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400'
        : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
    } ${extra}`

  return (
    <div
      className="sticky top-0 z-10 -mx-5 mb-4 flex flex-wrap items-center gap-1 rounded-xl border border-zinc-200/80 bg-white/90 px-2 py-1.5 shadow-sm backdrop-blur-md lg:-mx-8 dark:border-zinc-800 dark:bg-zinc-900/90"
      data-testid="notebook-format-toolbar"
      // 工具栏自身不可编辑，但要保持编辑器选区：按下时阻止默认行为
      onMouseDown={(event) => event.preventDefault()}
    >
      {BLOCKS.map(({ id, label, icon: Icon, command }) => (
        <button
          key={id}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={block === id}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onCommand('formatBlock', command)}
          className={buttonClass(block === id)}
        >
          <Icon size={15} />
        </button>
      ))}

      <span className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-700" aria-hidden="true" />

      {MARKS.map(({ id, label, icon: Icon, command, className }) => (
        <button
          key={id}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={formats[id]}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onCommand(command)}
          className={buttonClass(formats[id], className)}
        >
          <Icon size={15} />
        </button>
      ))}

      <span className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-700" aria-hidden="true" />

      <button
        type="button"
        title="无序列表"
        aria-label="无序列表"
        aria-pressed={formats.insertUnorderedList}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onCommand('insertUnorderedList')}
        className={buttonClass(formats.insertUnorderedList)}
      >
        <List size={15} />
      </button>
      <button
        type="button"
        title="有序列表"
        aria-label="有序列表"
        aria-pressed={formats.insertOrderedList}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onCommand('insertOrderedList')}
        className={buttonClass(formats.insertOrderedList)}
      >
        <ListOrdered size={15} />
      </button>

      <span className="mx-1 h-5 w-px bg-zinc-200 dark:bg-zinc-700" aria-hidden="true" />

      <button
        type="button"
        title="插入图片"
        aria-label="插入图片"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onInsertImage}
        className={buttonClass(false)}
      >
        <ImagePlus size={15} />
      </button>

      <span className="ml-auto hidden pr-1 text-[11px] text-zinc-400 sm:block dark:text-zinc-500">
        也可以直接粘贴网页内容或图片
      </span>
    </div>
  )
}
