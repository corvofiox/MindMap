/**
 * 节点池侧的「从笔记本导入」。
 *
 * 关注三件事：按文件夹层级展示手稿、悬停出预览、点击真正调用转换接口。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/services/api', () => ({
  getManuscripts: vi.fn(async () => [
    { id: 11, folderId: 1, title: '设计稿', previewText: '配色与间距的说明', imageCount: 2, createdAt: 0, updatedAt: 20 },
    { id: 12, folderId: null, title: '散记', previewText: '未归档的一篇', imageCount: 0, createdAt: 0, updatedAt: 10 },
  ]),
  getManuscriptFolders: vi.fn(async () => [
    { id: 1, userId: 1, name: '项目', parentId: null, sortOrder: 0, collapsed: false, createdAt: 0 },
    { id: 2, userId: 1, name: '设计', parentId: 1, sortOrder: 0, collapsed: false, createdAt: 0 },
  ]),
  manuscriptToNodeCard: vi.fn(async (id: number) => ({ id: 99, name: `卡片-${id}` })),
}))

const api = await import('@/services/api')
const { NotebookImportMenu } = await import('@/features/node-pool/components/NotebookImportMenu')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('从笔记本导入', () => {
  it('按文件夹层级列出手稿，未归档排在最后', async () => {
    render(<NotebookImportMenu onImported={() => {}} />)
    fireEvent.click(screen.getByLabelText('从笔记本导入'))

    const menu = await screen.findByTestId('notebook-import-menu')
    await waitFor(() => expect(menu.textContent).toContain('设计稿'))

    // 文件夹行 + 手稿行都在
    expect(menu.textContent).toContain('项目')
    expect(menu.textContent).toContain('设计')
    expect(menu.textContent).toContain('设计稿')
    expect(menu.textContent).toContain('散记')

    // 手稿缩进比它所属文件夹更深：用内联 paddingLeft 判断层级
    const rows = Array.from(menu.querySelectorAll('button, div[style*="padding-left"]'))
    const depthOf = (text: string) =>
      Number((rows.find((el) => (el.textContent || '').trim().startsWith(text)) as HTMLElement)
        ?.style.paddingLeft.replace('px', '') ?? -1)

    expect(depthOf('项目')).toBe(8)
    expect(depthOf('设计稿')).toBe(20)
    expect(depthOf('散记')).toBe(8)
  })

  it('悬停手稿显示预览，移开消失', async () => {
    render(<NotebookImportMenu onImported={() => {}} />)
    fireEvent.click(screen.getByLabelText('从笔记本导入'))

    const item = await screen.findByText('设计稿')
    fireEvent.mouseEnter(item.closest('button') as HTMLElement)

    const preview = await screen.findByTestId('notebook-import-preview')
    expect(preview.textContent).toContain('设计稿')
    expect(preview.textContent).toContain('配色与间距的说明')

    fireEvent.mouseLeave(item.closest('button') as HTMLElement)
    await waitFor(() => expect(screen.queryByTestId('notebook-import-preview')).toBeNull())
  })

  it('点击手稿调用转换接口并通知刷新', async () => {
    const onImported = vi.fn()
    render(<NotebookImportMenu onImported={onImported} />)
    fireEvent.click(screen.getByLabelText('从笔记本导入'))

    fireEvent.click(await screen.findByText('设计稿'))

    await waitFor(() => expect(api.manuscriptToNodeCard).toHaveBeenCalledWith(11))
    expect(onImported).toHaveBeenCalled()
  })
})
