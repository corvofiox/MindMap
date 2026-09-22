import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CollabConnectionBanner } from '@/components/canvas/CollabConnectionBanner'

// 回归：协作断线此前只在"用户点保存"/"被移出项目"时才提示，用户会毫无察觉地继续
// 编辑（静默断线）。这个常驻提示是让"掉线可见"的关键一环，必须钉住。
describe('CollabConnectionBanner（常驻协作连接状态提示）', () => {
  it('连接正常时不渲染任何内容（不打扰用户）', () => {
    const { container } = render(<CollabConnectionBanner state="connected" />)
    expect(container.firstChild).toBeNull()
  })

  it('正在重连时提示会自动恢复', () => {
    const { container } = render(<CollabConnectionBanner state="reconnecting" />)
    expect(container.querySelector('[data-collab-status="reconnecting"]')).not.toBeNull()
    expect(screen.getByText(/正在自动重连/)).not.toBeNull()
  })

  it('重连已停止时给出明确提示（需用户处理）', () => {
    const { container } = render(<CollabConnectionBanner state="stopped" />)
    expect(container.querySelector('[data-collab-status="stopped"]')).not.toBeNull()
    expect(screen.getByText(/自动重连已停止/)).not.toBeNull()
  })
})
