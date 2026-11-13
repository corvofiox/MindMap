/**
 * 节点池「删除文件夹」的确认文案。
 *
 * 回归背景（2026-11-13 真机实操）：池侧以前只在子树里有卡片时才 confirm，
 * 空文件夹点一下就直接删；文案还写着「N 个节点卡片也将被删除」，
 * 而真实行为是卡片退回未归档、活得好好的。两头都必须和实际情况一致。
 */
import { describe, it, expect } from 'vitest'
import { describeFolderDelete } from '../describeFolderDelete'
import type { NodeCard, NodePoolFolder } from '@/types'

const folder = (id: number, name: string, parentId: number | null = null): NodePoolFolder =>
  ({ id, name, parentId, userId: 1, sortOrder: 0, collapsed: false, createdAt: '' }) as unknown as NodePoolFolder

const card = (id: number, folderId: number | null): NodeCard =>
  ({ id, name: `卡片 ${id}`, folderId, userId: 1, content: '', createdAt: '', updatedAt: '' }) as unknown as NodeCard

describe('节点池删文件夹的确认文案', () => {
  it('空文件夹：直接说它是空的', () => {
    const message = describeFolderDelete(folder(1, '空箱'), [folder(1, '空箱')], [])
    expect(message).toBe('删除文件夹「空箱」？这个文件夹是空的。')
  })

  it('有子孙文件夹与卡片：数量说对，且明说卡片只是退回未归档', () => {
    const folders = [
      folder(1, '父级'),
      folder(2, '子级', 1),
      folder(3, '孙级', 2),
      folder(9, '旁系'),
    ]
    const cards = [card(100, 3), card(101, 3), card(200, 9)]

    const message = describeFolderDelete(folder(1, '父级'), folders, cards)

    expect(message).toContain('删除文件夹「父级」')
    expect(message).toContain('2 个子文件夹会一起删除')
    expect(message).toContain('2 个节点卡片会退回「未归档」（不会删除）')
    // 原来的错误说法（卡片会被删）不能再出现
    expect(message).not.toContain('将被删除')
  })

  it('只有卡片没有子文件夹：只提卡片，不提子文件夹', () => {
    const folders = [folder(1, '单层')]
    const message = describeFolderDelete(folder(1, '单层'), folders, [card(100, 1), card(101, null)])
    expect(message).toContain('1 个节点卡片会退回「未归档」')
    expect(message).not.toContain('子文件夹')
  })

  it('数据脏了（父子互相指）也不会死循环', () => {
    const a = { id: 1, name: 'A', parentId: 2 } as unknown as NodePoolFolder
    const b = { id: 2, name: 'B', parentId: 1 } as unknown as NodePoolFolder
    const message = describeFolderDelete(a, [a, b], [card(1, 2)])
    expect(message).toContain('删除文件夹「A」')
    expect(message).toContain('1 个子文件夹会一起删除')
  })
})
