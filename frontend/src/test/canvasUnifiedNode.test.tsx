/**
 * 统一节点的"入口"契约。
 *
 * 数据模型早就合成一个节点了（正文里可以放文字也能放图片），但画布上一度还留着
 * 两个工具：「节点」和「图片」。结果就是用户新建出来的仍是两种节点，看起来根本
 * 没合并。这里从入口把这件事钉死：
 *   - 画布工具栏里不允许再出现"图片"工具；
 *   - 插入图片的入口应该在节点正文的富文本工具条上（图片是正文的一部分）。
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CanvasToolbar } from '@/components/canvas/CanvasToolbar'
import { RichTextToolbar } from '@/features/rich-text/RichTextToolbar'
import { EMPTY_EDITOR_STATE } from '@/features/rich-text/editorCommands'

describe('统一节点入口', () => {
  it('画布工具栏里没有独立的"图片"工具', () => {
    render(<CanvasToolbar onSave={async () => true} />)

    // 节点工具仍在
    expect(screen.getByTitle(/节点 \(N\)/)).toBeTruthy()
    // 不该再有一个"图片 (I)"的工具按钮
    expect(screen.queryByTitle(/图片 \(I\)/)).toBeNull()
    expect(screen.queryByRole('button', { name: '图片' })).toBeNull()
  })

  it('正文富文本工具条提供"插入图片"入口，并回调出去', () => {
    const onInsertImage = vi.fn()
    render(
      <RichTextToolbar
        variant="floating"
        visible
        position={{ x: 10, y: 10 }}
        state={EMPTY_EDITOR_STATE}
        onCommand={() => {}}
        onInsertImage={onInsertImage}
        onClose={() => {}}
      />,
    )

    fireEvent.click(screen.getByTitle(/插入图片/))
    expect(onInsertImage).toHaveBeenCalledTimes(1)
  })

  it('没传 onInsertImage 时不渲染该按钮（避免空按钮）', () => {
    render(
      <RichTextToolbar
        variant="floating"
        visible
        position={{ x: 10, y: 10 }}
        state={EMPTY_EDITOR_STATE}
        onCommand={() => {}}
        onClose={() => {}}
      />,
    )

    expect(screen.queryByTitle(/插入图片/)).toBeNull()
  })
})
