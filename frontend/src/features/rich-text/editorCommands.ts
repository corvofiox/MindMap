/**
 * 富文本命令层——画布节点与笔记本正文共用的唯一入口。
 *
 * 以前两处各写一套：
 *   - 画布：utils/richTextCommands 的 execFormatCommand（自定义颜色处理），
 *     工具栏只有 B/I/U/S + 颜色；
 *   - 笔记本：页面里直接调 document.execCommand，工具栏有标题/列表但没有颜色。
 * 结果是"同一个编辑器，两种能力、两种激活态判断"，用户体感割裂。
 *
 * 现在统一在这里：
 *   - 能力集合取并集：行内格式 / 标题 / 引用 / 列表 / 颜色 / 清除格式 / 插图
 *   - 颜色沿用 richTextCommands 里处理过 span 与嵌套颜色的实现（那套比较靠谱）
 *   - 激活态判断也走同一份 queryEditorState
 */
import { execFormatCommand, queryCurrentColor, queryFormatState } from '@/utils/richTextCommands'

export type BlockFormat = 'p' | 'h1' | 'h2' | 'h3' | 'blockquote'

export type RichTextCommand =
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strikeThrough'
  | 'insertUnorderedList'
  | 'insertOrderedList'
  | 'formatBlock'
  | 'foreColor'
  | 'removeForeColor'
  | 'removeFormat'
  | 'insertText'

export interface EditorState {
  bold: boolean
  italic: boolean
  underline: boolean
  strikeThrough: boolean
  unorderedList: boolean
  orderedList: boolean
  block: BlockFormat
  /** 当前文字颜色（十六进制），没有显式颜色时为 null */
  color: string | null
}

export const EMPTY_EDITOR_STATE: EditorState = {
  bold: false,
  italic: false,
  underline: false,
  strikeThrough: false,
  unorderedList: false,
  orderedList: false,
  block: 'p',
  color: null,
}

export const BLOCK_OPTIONS: { id: BlockFormat; label: string }[] = [
  { id: 'p', label: '正文' },
  { id: 'h1', label: '标题 1' },
  { id: 'h2', label: '标题 2' },
  { id: 'h3', label: '标题 3' },
  { id: 'blockquote', label: '引用' },
]

function safeQueryState(command: string): boolean {
  try {
    return document.queryCommandState(command)
  } catch {
    return false
  }
}

function readBlockFormat(): BlockFormat {
  try {
    const raw = String(document.queryCommandValue('formatBlock') || '')
      .toLowerCase()
      .replace(/[<>]/g, '')
    if (raw === 'h1' || raw === 'h2' || raw === 'h3' || raw === 'blockquote') return raw
    return 'p'
  } catch {
    return 'p'
  }
}

/**
 * 读取当前选区的格式状态。
 * 行内格式优先用 queryFormatState（它能处理带 style 颜色的 span 这类 DOM），
 * 列表与块级格式用浏览器原生查询。
 */
export function queryEditorState(): EditorState {
  return {
    bold: queryFormatState('bold'),
    italic: queryFormatState('italic'),
    underline: queryFormatState('underline'),
    strikeThrough: queryFormatState('strikeThrough'),
    unorderedList: safeQueryState('insertUnorderedList'),
    orderedList: safeQueryState('insertOrderedList'),
    block: readBlockFormat(),
    color: queryCurrentColor(),
  }
}

/**
 * 执行一条格式命令。
 *
 * @param editor 目标编辑器；不传则用当前获得焦点的元素。传进来的好处是
 *   页面上有多个 contentEditable（笔记本的标题 + 正文、画布的多个节点）时
 *   不会打错对象。
 */
export function applyCommand(
  command: RichTextCommand,
  value?: string,
  editor?: HTMLElement | null,
): boolean {
  const target = editor ?? (document.activeElement as HTMLElement | null)
  if (target && typeof target.focus === 'function' && document.activeElement !== target) {
    target.focus()
  }

  try {
    switch (command) {
      case 'bold':
      case 'italic':
      case 'underline':
      case 'strikeThrough':
      case 'foreColor':
      case 'removeForeColor':
      case 'insertText':
        // 这几个走原有实现：颜色需要处理 span 包裹与嵌套，原生 execCommand 不够
        return execFormatCommand(command, value)

      case 'formatBlock':
        // 传入 "<h2>" 形式：Chrome 认裸标签，Firefox 只认带尖括号的
        return document.execCommand('formatBlock', false, `<${(value || 'p').toLowerCase()}>`)

      case 'insertUnorderedList':
      case 'insertOrderedList':
        return document.execCommand(command, false)

      case 'removeFormat':
        return document.execCommand('removeFormat', false)

      default:
        return false
    }
  } catch {
    // 极旧环境没有 execCommand，静默失败即可
    return false
  }
}

/**
 * 把 HTML 片段插到光标处；没有光标时追加到末尾。
 * 笔记本的粘贴采集与插图都走这里，画布节点插图也复用同一套语义。
 */
export function insertHtmlAtCaret(editor: HTMLElement, html: string): void {
  const holder = document.createElement('div')
  holder.innerHTML = html

  const selection = window.getSelection()
  const hasCaret = selection !== null
    && selection.rangeCount > 0
    && selection.anchorNode !== null
    && editor.contains(selection.anchorNode)

  if (hasCaret && selection !== null) {
    const range = selection.getRangeAt(0)
    range.deleteContents()
    const fragment = document.createDocumentFragment()
    while (holder.firstChild) fragment.appendChild(holder.firstChild)
    range.insertNode(fragment)
    range.collapse(false)
    return
  }

  editor.appendChild(holder)
}

/** 选区是否落在某个编辑器内——用来决定要不要刷新工具栏的激活态。 */
export function isSelectionInside(editor: HTMLElement | null | undefined): boolean {
  if (!editor) return false
  const selection = window.getSelection()
  return selection !== null
    && selection.rangeCount > 0
    && selection.anchorNode !== null
    && editor.contains(selection.anchorNode)
}
