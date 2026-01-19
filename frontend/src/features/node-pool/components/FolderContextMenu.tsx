import { createPortal } from 'react-dom'
import { useCallback } from 'react'
import {
  Edit2,
  Trash2,
} from 'lucide-react'
import { useNodePoolStore } from '../stores/useNodePoolStore'
import { useUIStore } from '@/store/useUIStore'
import { useContextMenu, MenuItem, MenuDivider } from '../hooks/useContextMenu'
import type { NodePoolFolder } from '@/types'

interface FolderContextMenuProps {
  folder: NodePoolFolder
  position: { x: number; y: number }
  onClose: () => void
  onRename?: () => void
}

export function FolderContextMenu({ folder, position, onClose, onRename }: FolderContextMenuProps) {
  const { removeFolder } = useNodePoolStore()
  const { addToast } = useUIStore()
  const { isPositioned, finalPosition, menuRef } = useContextMenu({ initialPosition: position, onClose })

  const handleRename = useCallback(() => {
    onRename?.()
    onClose()
  }, [onRename, onClose])

  const handleDelete = useCallback(async () => {
    const cardsMap = useNodePoolStore.getState().cardsMap
    const foldersMap = useNodePoolStore.getState().foldersMap

    const countCardsInFolderTree = (folderId: number): number => {
      let count = Array.from(cardsMap.values()).filter((c) => c.folderId === folderId).length
      const children = Array.from(foldersMap.values()).filter((f) => f.parentId === folderId)
      for (const child of children) {
        count += countCardsInFolderTree(child.id)
      }
      return count
    }

    const cardCount = countCardsInFolderTree(folder.id)

    if (cardCount > 0) {
      const confirmMessage = `确定要删除文件夹"${folder.name}"吗？文件夹内的 ${cardCount} 个节点卡片也将被删除。此操作不可恢复。`
      if (!confirm(confirmMessage)) {
        return
      }
    }

    try {
      await removeFolder(folder.id)
      addToast({ type: 'success', title: '删除成功', message: '文件夹已删除' })
    } catch (error) {
      addToast({ type: 'error', title: '删除失败', message: error instanceof Error ? error.message : '未知错误' })
    }
    onClose()
  }, [folder, removeFolder, addToast, onClose])

  return createPortal(
    <>
      <div className="fixed inset-0 z-[75]" onClick={onClose} />

      <div
        ref={menuRef}
        className="fixed z-[80] bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 min-w-[120px]"
        style={{
          left: finalPosition.x,
          top: finalPosition.y,
          opacity: isPositioned ? 1 : 0,
          pointerEvents: isPositioned ? 'auto' : 'none',
          transition: 'opacity 0.1s ease-out',
        }}
      >
        <MenuItem
          icon={Edit2}
          label="重命名"
          onClick={handleRename}
        />
        <MenuDivider />
        <MenuItem
          icon={Trash2}
          label="删除"
          onClick={handleDelete}
          danger
        />
      </div>
    </>,
    document.body
  )
}
