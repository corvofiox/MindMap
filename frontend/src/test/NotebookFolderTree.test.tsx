/**
 * 文件夹面板：固定高度窗口 + 竖排树 + 嵌套。
 *
 * 返工点是"文件夹挤成一排胶囊、看不出层级、多了会把列表顶走"，
 * 所以这里钉住：容器是固定高度且可滚动、子文件夹按缩进渲染、能折叠、
 * 选中父文件夹时其子文件夹里的手稿也要出现。
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  NotebookFolderTree,
  buildFolderTree,
  collectSubtreeIds,
} from '@/features/notebook/NotebookFolderTree'
import type { ManuscriptFolder, ManuscriptSummary } from '@/services/api'

const folder = (id: number, name: string, parentId: number | null = null, sortOrder = 0): ManuscriptFolder => ({
  id,
  userId: 1,
  name,
  parentId,
  sortOrder,
  collapsed: false,
  createdAt: 0,
})

const manuscript = (id: number, title: string, folderId: number | null): ManuscriptSummary => ({
  id,
  folderId,
  title,
  previewText: '',
  imageCount: 0,
  createdAt: 0,
  updatedAt: 0,
})

const FOLDERS = [folder(1, '项目', null, 0), folder(2, '设计', 1, 0), folder(3, '研究', 2, 0), folder(4, '素材', null, 1)]
const MANUSCRIPTS = [manuscript(10, '总纲', 1), manuscript(11, '配色', 2), manuscript(12, '访谈', 3), manuscript(13, '散记', null)]

function renderTree(overrides: Partial<React.ComponentProps<typeof NotebookFolderTree>> = {}) {
  const props = {
    folders: FOLDERS,
    manuscripts: MANUSCRIPTS,
    selectedId: null as number | null,
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  }
  render(<NotebookFolderTree {...props} />)
  return props
}

describe('buildFolderTree', () => {
  it('按 parentId 折成树，并统计含子孙的手稿数', () => {
    const tree = buildFolderTree(FOLDERS, MANUSCRIPTS)

    expect(tree.map((node) => node.folder.name)).toEqual(['项目', '素材'])
    expect(tree[0].children.map((node) => node.folder.name)).toEqual(['设计'])
    expect(tree[0].children[0].children.map((node) => node.folder.name)).toEqual(['研究'])

    // 项目 = 总纲(1) + 设计子树(配色+访谈=2) = 3
    expect(tree[0].count).toBe(3)
    expect(tree[0].children[0].count).toBe(2)
    expect(tree[0].children[0].children[0].count).toBe(1)
  })

  it('父节点丢失时把孤儿当根，不让文件夹消失', () => {
    const tree = buildFolderTree([folder(9, '孤儿', 999)], [])
    expect(tree.map((node) => node.folder.name)).toEqual(['孤儿'])
  })
})

describe('collectSubtreeIds', () => {
  it('包含自身与所有子孙', () => {
    expect(Array.from(collectSubtreeIds(FOLDERS, 1)).sort()).toEqual([1, 2, 3])
    expect(Array.from(collectSubtreeIds(FOLDERS, 3))).toEqual([3])
  })
})

describe('NotebookFolderTree', () => {
  it('固定高度 + 可滚动的窗口', () => {
    renderTree()
    const scroll = screen.getByTestId('folder-scroll')
    expect(scroll.className).toContain('max-h-[240px]')
    expect(scroll.className).toContain('overflow-y-auto')
  })

  it('子文件夹按层级缩进渲染', () => {
    renderTree()
    const rows = Array.from(document.querySelectorAll('[data-folder-row]'))
    const depthOf = (name: string) =>
      Number(rows.find((row) => (row.textContent || '').includes(name))?.getAttribute('data-depth'))

    expect(depthOf('项目')).toBe(0)
    expect(depthOf('设计')).toBe(1)
    expect(depthOf('研究')).toBe(2)
    expect(depthOf('素材')).toBe(0)
  })

  it('折叠父文件夹后子项隐藏，再点展开恢复', () => {
    renderTree()

    fireEvent.click(screen.getByLabelText('折叠 项目'))
    expect(screen.queryByText('设计')).toBeNull()

    fireEvent.click(screen.getByLabelText('展开 项目'))
    expect(screen.getByText('设计')).toBeTruthy()
  })

  it('点文件夹行触发筛选，点「全部手稿」回到不筛选', () => {
    const props = renderTree()

    fireEvent.click(screen.getByText('设计'))
    expect(props.onSelect).toHaveBeenCalledWith(2)

    fireEvent.click(screen.getByText('全部手稿'))
    expect(props.onSelect).toHaveBeenCalledWith(null)
  })

  it('行内 + 新建的是子文件夹（带上 parentId）', () => {
    const props = renderTree()

    fireEvent.click(screen.getByLabelText('在 项目 下新建子文件夹'))
    expect(props.onCreate).toHaveBeenCalledWith(1)
  })

  it('行内删除会带出文件夹 id', () => {
    const props = renderTree()

    fireEvent.click(screen.getByLabelText('删除文件夹 素材'))
    expect(props.onDelete).toHaveBeenCalledWith(4)
  })

  it('空状态给出可执行提示', () => {
    renderTree({ folders: [], manuscripts: [] })
    expect(screen.getByText(/还没有文件夹/)).toBeTruthy()
  })
})
