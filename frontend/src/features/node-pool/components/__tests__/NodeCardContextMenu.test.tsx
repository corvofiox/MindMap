/**
 * 卡片右键菜单：投放动作的文案必须与产品语义一致。
 *
 * 卡片 → 画布是**搬运**（拖过去就进画布、卡片从池里消失），所以菜单项不能写
 * 「复制到画布」——那会让人以为卡片还在池里。这里同时钉住行为：点击后派发的
 * `canvasDrop` 事件由画布侧按搬运处理（`moveNodeFromPool` + 移除卡片）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { NodeCard } from '@/types'
import { NodeCardContextMenu } from '../NodeCardContextMenu'

afterEach(() => cleanup())

const CARD: NodeCard = {
  id: 7,
  userId: 1,
  name: '待搬卡片',
  content: JSON.stringify({ title: '待搬卡片', content: '<p>正文</p>' }),
  type: 'text',
  color: '#ffffff',
  tags: null,
  createdBy: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  folderId: null,
  description: null,
  thumbnail: null,
  sortOrder: 0,
}

describe('NodeCardContextMenu · 移到画布', () => {
  it('文案是「移到画布」，不再出现「复制到画布」', () => {
    render(<NodeCardContextMenu card={CARD} position={{ x: 10, y: 10 }} onClose={vi.fn()} />)

    expect(screen.getByText('移到画布')).toBeTruthy()
    expect(screen.queryByText('复制到画布')).toBeNull()
  })

  it('点击后派发 canvasDrop（画布侧据此搬运卡片）并关闭菜单', () => {
    const onClose = vi.fn()
    const drops: CustomEvent[] = []
    const listener = (event: Event) => drops.push(event as CustomEvent)
    document.addEventListener('canvasDrop', listener)

    render(<NodeCardContextMenu card={CARD} position={{ x: 10, y: 10 }} onClose={onClose} />)
    fireEvent.click(screen.getByText('移到画布'))

    expect(drops).toHaveLength(1)
    expect((drops[0].detail as { card: NodeCard }).card.id).toBe(CARD.id)
    expect(onClose).toHaveBeenCalled()

    document.removeEventListener('canvasDrop', listener)
  })
})
