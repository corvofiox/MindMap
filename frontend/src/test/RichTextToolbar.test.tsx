/**
 * 统一后的富文本工具栏。
 *
 * 背景：画布节点与笔记本正文原先各有一套工具栏——画布只有 B/I/U/S + 颜色，
 * 笔记本有标题/列表但没有颜色，同一个"编辑器"在不同页面能力不同。
 * 现在共用这一个组件，只有形态差异（floating / docked），按钮集合完全一致。
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RichTextToolbar } from '@/features/rich-text/RichTextToolbar'
import { EMPTY_EDITOR_STATE, type EditorState } from '@/features/rich-text/editorCommands'

function renderToolbar(overrides: Partial<{ state: EditorState; variant: 'floating' | 'docked' }> = {}) {
  const onCommand = vi.fn()
  const onInsertImage = vi.fn()
  const onClose = vi.fn()
  const utils = render(
    <RichTextToolbar
      variant={overrides.variant ?? 'docked'}
      state={overrides.state ?? EMPTY_EDITOR_STATE}
      onCommand={onCommand}
      onInsertImage={onInsertImage}
      onClose={onClose}
    />,
  )
  return { onCommand, onInsertImage, onClose, ...utils }
}

const ALL_LABELS = [
  '正文', '标题 1', '标题 2', '标题 3', '引用',
  '加粗 (Ctrl+B)', '斜体 (Ctrl+I)', '下划线 (Ctrl+U)', '删除线',
  '无序列表', '有序列表', '文字颜色', '插入图片',
]

describe('富文本工具栏（两处共用）', () => {
  it('docked 与 floating 两种形态渲染同一套按钮', () => {
    const { unmount } = renderToolbar({ variant: 'docked' })
    const dockedLabels = ALL_LABELS.filter((label) => screen.queryByLabelText(label))
    unmount()

    renderToolbar({ variant: 'floating' })
    const floatingLabels = ALL_LABELS.filter((label) => screen.queryByLabelText(label))

    expect(dockedLabels).toEqual(ALL_LABELS)
    expect(floatingLabels).toEqual(ALL_LABELS)
  })

  it('块级格式走 formatBlock，行内格式走标准命令', () => {
    const { onCommand } = renderToolbar()

    fireEvent.click(screen.getByLabelText('标题 2'))
    expect(onCommand).toHaveBeenCalledWith('formatBlock', 'h2')

    fireEvent.click(screen.getByLabelText('引用'))
    expect(onCommand).toHaveBeenCalledWith('formatBlock', 'blockquote')

    fireEvent.click(screen.getByLabelText('加粗 (Ctrl+B)'))
    expect(onCommand).toHaveBeenCalledWith('bold')

    fireEvent.click(screen.getByLabelText('无序列表'))
    expect(onCommand).toHaveBeenCalledWith('insertUnorderedList')
  })

  it('颜色面板：选色 / 移除颜色 / 清除格式', () => {
    const { onCommand } = renderToolbar()

    fireEvent.click(screen.getByLabelText('文字颜色'))
    fireEvent.click(screen.getByLabelText('颜色 #2563eb'))
    expect(onCommand).toHaveBeenCalledWith('foreColor', '#2563eb')

    fireEvent.click(screen.getByLabelText('文字颜色'))
    fireEvent.click(screen.getByText('移除颜色'))
    expect(onCommand).toHaveBeenCalledWith('removeForeColor')

    fireEvent.click(screen.getByLabelText('文字颜色'))
    fireEvent.click(screen.getByText('清除格式'))
    expect(onCommand).toHaveBeenCalledWith('removeFormat')
  })

  it('激活态按 state 回显', () => {
    renderToolbar({
      state: {
        ...EMPTY_EDITOR_STATE,
        bold: true,
        block: 'h2',
        unorderedList: true,
        color: '#2563eb',
      },
    })

    expect(screen.getByLabelText('加粗 (Ctrl+B)').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByLabelText('标题 2').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByLabelText('无序列表').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByLabelText('文字颜色').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByLabelText('标题 1').getAttribute('aria-pressed')).toBe('false')
  })

  it('floating 形态有关闭按钮，docked 形态没有', () => {
    const { unmount } = renderToolbar({ variant: 'floating' })
    fireEvent.click(screen.getByLabelText('关闭'))
    unmount()

    renderToolbar({ variant: 'docked' })
    expect(screen.queryByLabelText('关闭')).toBeNull()
  })

  it('按下按钮不抢焦点（mousedown 默认行为被阻止）', () => {
    renderToolbar()
    expect(fireEvent.mouseDown(screen.getByLabelText('加粗 (Ctrl+B)'))).toBe(false)
  })
})
