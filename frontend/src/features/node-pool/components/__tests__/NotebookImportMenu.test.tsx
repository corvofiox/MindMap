/**
 * 节点池侧的「从笔记本导入」。
 *
 * 关注四件事：文件夹默认收起（可展开/收起）、层级缩进、悬停预览、点击导入。
 * 收起是这次返工的重点——手稿多、文件夹还嵌套时，全展开会把菜单撑成一面墙。
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

const padOf = (testId: string) =>
  Number((document.querySelector(`[data-testid="${testId}"]`) as HTMLElement)?.style.paddingLeft.replace('px', '') ?? -1)

async function openMenu() {
  render(<NotebookImportMenu onImported={() => {}} />)
  fireEvent.click(screen.getByLabelText('从笔记本导入'))
  await screen.findByTestId('notebook-import-menu')
  await waitFor(() => expect(screen.getByTestId('import-folder-1')).toBeTruthy())
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('从笔记本导入', () => {
  it('文件夹默认收起：只显示文件夹与未归档手稿', async () => {
    await openMenu()

    // 只看到顶层文件夹；嵌套文件夹与其中的手稿都随父级一起收起
    expect(screen.getByTestId('import-folder-1')).toBeTruthy()
    expect(screen.queryByTestId('import-folder-2')).toBeNull()
    expect(screen.queryByText('设计稿')).toBeNull()
    // 未归档始终展示
    expect(screen.getByText('散记')).toBeTruthy()
  })

  it('展开文件夹后按层级列出其中的手稿，再点收起', async () => {
    await openMenu()
    fireEvent.click(screen.getByTestId('import-folder-1'))

    expect(await screen.findByText('设计稿')).toBeTruthy()
    // 文件夹 depth 0 → 10px，手稿 depth 1 → 22px；子文件夹 depth 1 → 22px
    expect(padOf('import-folder-1')).toBe(10)
    expect(padOf('import-manuscript-11')).toBe(22)
    expect(padOf('import-folder-2')).toBe(22)

    fireEvent.click(screen.getByTestId('import-folder-1'))
    await waitFor(() => expect(screen.queryByText('设计稿')).toBeNull())
  })

  it('悬停手稿显示预览，移开消失', async () => {
    await openMenu()
    fireEvent.click(screen.getByTestId('import-folder-1'))

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
    await screen.findByTestId('notebook-import-menu')

    fireEvent.click(screen.getByTestId('import-folder-1'))
    fireEvent.click(await screen.findByText('设计稿'))

    await waitFor(() => expect(api.manuscriptToNodeCard).toHaveBeenCalledWith(11))
    expect(onImported).toHaveBeenCalled()
  })
})
