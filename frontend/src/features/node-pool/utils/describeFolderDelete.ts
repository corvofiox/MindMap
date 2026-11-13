/**
 * 「删除这个节点池文件夹会发生什么」——拼给确认框看的一句话。
 *
 * 单独拎出来是因为它必须和真实行为一致，而真实行为有三条容易写错：
 *   1. 子文件夹会跟着一起删（parent_id 上是 ON DELETE CASCADE）；
 *   2. 里面的卡片也一起删（node_cards 没有软删除列，这里是物理删除）；
 *   3. 空文件夹也要说清楚"是空的"，而不是什么都不说。
 *
 * 历史上这句话写错过两次：先说「N 个节点卡片也将被删除」（那时其实只是退回
 * 未归档），后来又改成「会退回未归档」（那时确实不删）。现在后端是真删，
 * 文案就跟着说"一起删除"——两者必须同时改。
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
  if (subFolders > 0) consequences.push(`${subFolders} 个子文件夹`)
  if (cardsInside > 0) consequences.push(`${cardsInside} 个节点卡片`)

  const tail = consequences.length > 0 ? `${consequences.join('、')}会一起删除。` : '这个文件夹是空的。'
  return `删除文件夹「${folder.name}」？${tail}`
}
