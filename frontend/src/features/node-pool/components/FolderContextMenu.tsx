import { createPortal } from 'react-dom'
import { useCallback } from 'react'
import {
  Edit2,
  Trash2,
} from 'lucide-react'
import { useNodePoolStore } from '../stores/useNodePoolStore'
import { useUIStore } from '@/store/useUIStore'
import { useContextMenu, MenuItem, MenuDivider } from '../hooks/useContextMenu'
import { describeFolderDelete } from '../utils/describeFolderDelete'
import { Z_INDEX } from '@/constants'
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

    // 删文件夹必须每次都问一次：以前只在这个子树里有卡片时才 confirm，
    // 空文件夹（或只含空子文件夹）点一下就直接没了；而且文案说卡片"将被删除"，
    // 实际只是退回未归档。
    const question = describeFolderDelete(folder, foldersMap.values(), cardsMap.values())
    if (!confirm(question)) {
      // 取消也要收起菜单：留着不关的话，下一次右键会先被遮罩吃掉，
      // 用户点到的是上一次的菜单项（实测踩过：取消后菜单还挂在屏幕上）
      onClose()
      return
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
      <div className="fixed inset-0" style={{ zIndex: Z_INDEX.NODE_POOL_CONTEXT_MASK }} onClick={onClose} />

      <div
        ref={menuRef}
        className="fixed bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 min-w-[120px]"
        style={{
          left: finalPosition.x,
          top: finalPosition.y,
          opacity: isPositioned ? 1 : 0,
          pointerEvents: isPositioned ? 'auto' : 'none',
          transition: 'opacity 0.1s ease-out',
          zIndex: Z_INDEX.CONTEXT_MENU,
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
