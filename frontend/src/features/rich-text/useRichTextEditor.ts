import { useCallback, useEffect, useRef, useState } from 'react'
import {
  EMPTY_EDITOR_STATE,
  applyCommand,
  isSelectionInside,
  queryEditorState,
  type EditorState,
  type RichTextCommand,
} from './editorCommands'

interface UseRichTextEditorOptions {
  /**
   * 返回当前正在编辑的元素。给了就只在选区落在这个元素内时刷新状态，
   * 避免点到侧栏/其他输入框时工具栏乱跳。
   *
   * 注意：调用方通常写成内联箭头函数，每次渲染都是新引用。所以这里存进 ref，
   * 不把它算进 useCallback 依赖——否则 refresh 引用每帧都变，调用方的
   * useEffect([refresh]) 会陷入"刷新→setState→重渲染→再注册"的死循环。
   */
  getEditor?: () => HTMLElement | null
}

function isSameState(a: EditorState, b: EditorState): boolean {
  return a.bold === b.bold
    && a.italic === b.italic
    && a.underline === b.underline
    && a.strikeThrough === b.strikeThrough
    && a.unorderedList === b.unorderedList
    && a.orderedList === b.orderedList
    && a.block === b.block
    && a.color === b.color
}

/**
 * 富文本编辑器的状态与命令——画布节点、笔记本正文共用。
 *
 * 只做三件事：跟踪激活态、执行命令、插入 HTML。工具栏长什么样由
 * RichTextToolbar 决定，两处渲染成不同形态（悬浮 / 吸顶）但行为完全一致。
 */
export function useRichTextEditor({ getEditor }: UseRichTextEditorOptions = {}) {
  const [state, setState] = useState<EditorState>(EMPTY_EDITOR_STATE)
  const getEditorRef = useRef(getEditor)
  getEditorRef.current = getEditor

  const refresh = useCallback(() => {
    const read = getEditorRef.current
    const editor = read ? read() : null
    // 没给 getEditor 时（画布只在编辑态显示工具栏）不做归属判断
    if (read && !isSelectionInside(editor)) return
    const next = queryEditorState()
    // 内容没变就不 setState：避免"监听 selectionchange → 重渲染"的抖动
    setState((previous) => (isSameState(previous, next) ? previous : next))
  }, [])

  useEffect(() => {
    document.addEventListener('selectionchange', refresh)

    const onMouseUp = () => window.setTimeout(refresh, 0)
    const onKeyUp = (event: KeyboardEvent) => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        window.setTimeout(refresh, 0)
      }
    }
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('keyup', onKeyUp)
    return () => {
      document.removeEventListener('selectionchange', refresh)
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('keyup', onKeyUp)
    }
  }, [refresh])

  const run = useCallback((command: RichTextCommand, value?: string): boolean => {
    const read = getEditorRef.current
    const editor = read ? read() : null
    const ok = applyCommand(command, value, editor)
    // 命令执行后立刻刷新，别等 selectionchange（它有时不触发）
    window.setTimeout(refresh, 0)
    return ok
  }, [refresh])

  return { state, refresh, run }
}
