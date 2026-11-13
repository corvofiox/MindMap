/**
 * 富文本命令层（画布与笔记本共用）。
 *
 * 这一层是两处"同一套编辑能力"的唯一落点，命令到浏览器的映射错了，
 * 工具栏看起来正常但编辑没反应——所以逐条钉住实际下发的 execCommand 参数。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  applyCommand,
  insertHtmlAtCaret,
  isSelectionInside,
  queryEditorState,
} from '@/features/rich-text/editorCommands'

type ExecCommand = (command: string, showUI?: boolean, value?: string) => boolean

let execCommand: ReturnType<typeof vi.fn>
let originalExecCommand: unknown

beforeEach(() => {
  execCommand = vi.fn<ExecCommand>(() => true)
  originalExecCommand = (document as unknown as { execCommand?: unknown }).execCommand
  ;(document as unknown as { execCommand: unknown }).execCommand = execCommand
  window.getSelection()?.removeAllRanges()
})

afterEach(() => {
  ;(document as unknown as { execCommand?: unknown }).execCommand = originalExecCommand
  document.body.innerHTML = ''
})

function makeEditor(html = ''): HTMLDivElement {
  const editor = document.createElement('div')
  editor.contentEditable = 'true'
  editor.innerHTML = html
  document.body.appendChild(editor)
  return editor
}

/** 把光标放到某个文本节点里（offset 默认末尾） */
function placeCaret(node: Node, offset?: number) {
  const range = document.createRange()
  range.setStart(node, offset ?? (node.textContent ?? '').length)
  range.collapse(true)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

describe('命令到 execCommand 的映射', () => {
  it('块级格式传 "<h2>" 形式（Chrome 认裸标签，Firefox 只认尖括号）', () => {
    applyCommand('formatBlock', 'h2')
    expect(execCommand).toHaveBeenLastCalledWith('formatBlock', false, '<h2>')

    applyCommand('formatBlock')
    expect(execCommand).toHaveBeenLastCalledWith('formatBlock', false, '<p>')
  })

  it('列表与清除格式走原生命令', () => {
    applyCommand('insertUnorderedList')
    expect(execCommand).toHaveBeenLastCalledWith('insertUnorderedList', false)

    applyCommand('insertOrderedList')
    expect(execCommand).toHaveBeenLastCalledWith('insertOrderedList', false)

    applyCommand('removeFormat')
    expect(execCommand).toHaveBeenLastCalledWith('removeFormat', false)
  })

  it('行内格式与颜色交给 richTextCommands 处理（它管 span 包裹与嵌套）', () => {
    applyCommand('bold')
    expect(execCommand).toHaveBeenLastCalledWith('bold', false)

    applyCommand('italic')
    expect(execCommand).toHaveBeenLastCalledWith('italic', false)

    applyCommand('foreColor', '#2563eb')
    expect(execCommand).toHaveBeenLastCalledWith('foreColor', false, '#2563eb')
  })

  it('传入编辑器时先把焦点给它（多编辑器页面上不会打错对象）', () => {
    const editor = makeEditor()
    const focus = vi.spyOn(editor, 'focus')

    applyCommand('bold', undefined, editor)

    expect(focus).toHaveBeenCalled()
    expect(execCommand).toHaveBeenLastCalledWith('bold', false)
  })

  it('未知命令返回 false，不下发任何 execCommand', () => {
    expect(applyCommand('no_such_command' as never)).toBe(false)
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('浏览器不支持 execCommand 时返回 false 而不抛错', () => {
    execCommand.mockImplementation(() => { throw new Error('not supported') })
    expect(applyCommand('insertUnorderedList')).toBe(false)
  })
})

describe('状态读取', () => {
  it('没有选区时给出空状态，不抛错', () => {
    const state = queryEditorState()
    expect(state.bold).toBe(false)
    expect(state.block).toBe('p')
    expect(state.color).toBeNull()
  })
})

describe('在光标处插入 HTML', () => {
  it('没有光标时整段追加到末尾', () => {
    const editor = makeEditor('<p>已有</p>')
    window.getSelection()?.removeAllRanges()

    insertHtmlAtCaret(editor, '<img src="/api/files/abc">')

    expect(editor.querySelector('img')?.getAttribute('src')).toBe('/api/files/abc')
    expect(editor.textContent).toBe('已有')
  })

  it('有光标时插在光标处，而不是整段贴到末尾', () => {
    const editor = makeEditor('abcd')
    placeCaret(editor.firstChild as Text, 2)

    insertHtmlAtCaret(editor, '<b>X</b>')

    expect(editor.innerHTML).toBe('ab<b>X</b>cd')
  })

  it('光标在编辑器外时不抢编辑器内容（仍按追加处理）', () => {
    const editor = makeEditor('<p>正文</p>')
    const outside = document.createElement('div')
    outside.textContent = '外面'
    document.body.appendChild(outside)
    placeCaret(outside.firstChild as Text)

    insertHtmlAtCaret(editor, '<b>Y</b>')

    expect(editor.querySelector('b')?.textContent).toBe('Y')
    expect(outside.textContent).toBe('外面')
  })
})

describe('选区归属判断', () => {
  it('没有编辑器时恒为 false', () => {
    expect(isSelectionInside(null)).toBe(false)
    expect(isSelectionInside(undefined)).toBe(false)
  })

  it('选区在编辑器内为 true，在外部为 false', () => {
    const editor = makeEditor('abc')
    placeCaret(editor.firstChild as Text, 1)
    expect(isSelectionInside(editor)).toBe(true)

    const outside = document.createElement('p')
    outside.textContent = '外面'
    document.body.appendChild(outside)
    placeCaret(outside.firstChild as Text, 1)
    expect(isSelectionInside(editor)).toBe(false)
  })
})
