/**
 * 笔记本格式工具栏。
 *
 * 背景：正文一直支持富文本渲染（h2/列表/引用都有样式），但编辑时没有任何
 * 格式化入口，用户只能敲纯文本。这个工具栏补上入口，并保证：
 *   - 块级格式（正文/标题1-3/引用）走 formatBlock；
 *   - 行内格式走 execCommand 的标准命令；
 *   - 按钮按下时不抢焦点（否则选区丢失，命令打空）。
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  NotebookFormatToolbar,
  type BlockFormat,
  type InlineFormats,
} from '@/features/notebook/NotebookFormatToolbar'

const EMPTY: InlineFormats = {
  bold: false,
  italic: false,
  underline: false,
  strikeThrough: false,
  insertUnorderedList: false,
  insertOrderedList: false,
}

function renderToolbar(overrides: Partial<{ block: BlockFormat; formats: InlineFormats }> = {}) {
  const onCommand = vi.fn()
  const onInsertImage = vi.fn()
  render(
    <NotebookFormatToolbar
      block={overrides.block ?? 'p'}
      formats={overrides.formats ?? EMPTY}
      onCommand={onCommand}
      onInsertImage={onInsertImage}
    />,
  )
  return { onCommand, onInsertImage }
}

describe('笔记本格式工具栏', () => {
  it('渲染常用格式入口', () => {
    renderToolbar()

    for (const label of ['正文', '标题 1', '标题 2', '标题 3', '引用', '加粗 (Ctrl+B)', '斜体 (Ctrl+I)', '无序列表', '有序列表', '插入图片']) {
      expect(screen.getByLabelText(label), label).toBeTruthy()
    }
  })

  it('行内格式发出标准命令', () => {
    const { onCommand } = renderToolbar()

    fireEvent.click(screen.getByLabelText('加粗 (Ctrl+B)'))
    expect(onCommand).toHaveBeenCalledWith('bold')

    fireEvent.click(screen.getByLabelText('斜体 (Ctrl+I)'))
    expect(onCommand).toHaveBeenCalledWith('italic')
  })

  it('块级格式走 formatBlock', () => {
    const { onCommand } = renderToolbar()

    fireEvent.click(screen.getByLabelText('标题 2'))
    expect(onCommand).toHaveBeenCalledWith('formatBlock', 'H2')

    fireEvent.click(screen.getByLabelText('引用'))
    expect(onCommand).toHaveBeenCalledWith('formatBlock', 'BLOCKQUOTE')
  })

  it('列表与插入图片各自回调', () => {
    const { onCommand, onInsertImage } = renderToolbar()

    fireEvent.click(screen.getByLabelText('无序列表'))
    expect(onCommand).toHaveBeenCalledWith('insertUnorderedList')

    fireEvent.click(screen.getByLabelText('有序列表'))
    expect(onCommand).toHaveBeenCalledWith('insertOrderedList')

    fireEvent.click(screen.getByLabelText('插入图片'))
    expect(onInsertImage).toHaveBeenCalledTimes(1)
  })

  it('按当前选区回显激活态', () => {
    renderToolbar({ block: 'h2', formats: { ...EMPTY, bold: true, insertUnorderedList: true } })

    expect(screen.getByLabelText('加粗 (Ctrl+B)').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByLabelText('无序列表').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByLabelText('标题 2').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByLabelText('标题 1').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByLabelText('斜体 (Ctrl+I)').getAttribute('aria-pressed')).toBe('false')
  })

  it('按下按钮不抢焦点（mousedown 默认行为被阻止）', () => {
    renderToolbar()
    const bold = screen.getByLabelText('加粗 (Ctrl+B)')

    const event = fireEvent.mouseDown(bold)
    // fireEvent 返回 false 表示默认行为被 preventDefault 了
    expect(event).toBe(false)
  })
})
