/**
 * 「删除这个节点池文件夹会发生什么」——拼给确认框看的一句话。
 *
 * 单独拎出来是因为它必须和真实行为一致，而真实行为有三条容易写错：
 *   1. 子文件夹会跟着一起删（后端 manuscript 侧是 CASCADE，池这边 parentId 同样是 CASCADE）；
 *   2. 里面的卡片不会删，只是退回「未归档」（node_cards.folder_id 是 ON DELETE SET NULL）；
 *   3. 空文件夹也要说清楚"是空的"，而不是什么都不说。
 *
 * 以前这里写的是「文件夹内的 N 个节点卡片也将被删除」——卡片其实活得好好的，
 * 用户看到这句会以为内容没了。
 */
import type { NodeCard, NodePoolFolder } from '@/types'

export function describeFolderDelete(
  folder: Pick<NodePoolFolder, 'id' | 'name'>,
  folders: Iterable<Pick<NodePoolFolder, 'id' | 'parentId'>>,
  cards: Iterable<Pick<NodeCard, 'folderId'>>,
): string {
  const folderList = Array.from(folders)
  const subtree = new Set<number>([folder.id])
  let changed = true
  while (changed) {
    changed = false
    for (const item of folderList) {
      if (item.parentId !== null && subtree.has(item.parentId) && !subtree.has(item.id)) {
        subtree.add(item.id)
        changed = true
      }
    }
  }

  const subFolders = subtree.size - 1
  const cardsInside = Array.from(cards).filter(
    (card) => card.folderId !== null && card.folderId !== undefined && subtree.has(card.folderId),
  ).length

  const consequences: string[] = []
  if (subFolders > 0) consequences.push(`${subFolders} 个子文件夹会一起删除`)
  if (cardsInside > 0) consequences.push(`${cardsInside} 个节点卡片会退回「未归档」（不会删除）`)

  const tail = consequences.length > 0 ? `${consequences.join('，')}。` : '这个文件夹是空的。'
  return `删除文件夹「${folder.name}」？${tail}`
}
