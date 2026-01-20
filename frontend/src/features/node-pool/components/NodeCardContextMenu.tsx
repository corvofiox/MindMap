import { createPortal } from 'react-dom'
import { useState, useCallback } from 'react'
import {
  Edit2,
  Trash2,
  Folder,
  Copy,
} from 'lucide-react'
import { useNodePoolStore } from '../stores/useNodePoolStore'
import { useUIStore } from '@/store/useUIStore'
import { useContextMenu, MenuItem, MenuDivider } from '../hooks/useContextMenu'
import { Z_INDEX } from '@/constants'
import type { NodeCard } from '@/types'

interface NodeCardContextMenuProps {
  card: NodeCard
  position: { x: number; y: number }
  onClose: () => void
  onRename?: () => void
  onMoveToFolder?: (folderId: number | null) => void
}

export function NodeCardContextMenu({ card, position, onClose, onRename, onMoveToFolder }: NodeCardContextMenuProps) {
  const { removeCard } = useNodePoolStore()
  const { addToast, setDragGhost } = useUIStore()
  const { isPositioned, finalPosition, menuRef } = useContextMenu({ initialPosition: position, onClose })
  const [moveMenuOpen, setMoveMenuOpen] = useState(false)

  const folders = useNodePoolStore((state) => Array.from(state.foldersMap.values()).sort((a, b) => a.sortOrder - b.sortOrder))

  const handleRename = useCallback(() => {
    onRename?.()
    onClose()
  }, [onRename, onClose])

  const handleDelete = useCallback(async () => {
    try {
      await removeCard(card.id)
      addToast({ type: 'success', title: '删除成功', message: '节点已从节点池删除' })
    } catch (error) {
      addToast({ type: 'error', title: '删除失败', message: error instanceof Error ? error.message : '未知错误' })
    }
    onClose()
  }, [card.id, removeCard, addToast, onClose])

  const handleCopyToCanvas = useCallback(() => {
    setDragGhost(card, { x: finalPosition.x, y: finalPosition.y })
    const customEvent = new CustomEvent('canvasDrop', {
      detail: { card },
    })
    document.dispatchEvent(customEvent)
    onClose()
  }, [card, setDragGhost, finalPosition, onClose])

  const handleMoveToFolder = useCallback((folderId: number | null) => {
    onMoveToFolder?.(folderId)
    setMoveMenuOpen(false)
    onClose()
  }, [onMoveToFolder, onClose])

  return createPortal(
    <>
      <div className="fixed inset-0" style={{ zIndex: Z_INDEX.NODE_POOL_CONTEXT_MASK }} onClick={onClose} />

      <div
        ref={menuRef}
        className="fixed bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 min-w-[160px]"
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
          icon={Copy}
          label="复制到画布"
          onClick={handleCopyToCanvas}
        />
        <MenuDivider />
        <button
          onClick={(e) => {
            e.stopPropagation()
            setMoveMenuOpen(!moveMenuOpen)
          }}
          className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
        >
          <div className="flex items-center gap-2">
            <Folder className="w-3 h-3" />
            移动到
          </div>
          <span className="text-gray-400">›</span>
        </button>

        {moveMenuOpen && (
          <div className="border-t border-gray-200 dark:border-gray-700">
            <MenuItem
              icon={Folder}
              label="根目录"
              onClick={() => handleMoveToFolder(null)}
            />
            {folders.map((folder) => (
              <MenuItem
                key={folder.id}
                icon={Folder}
                label={folder.name}
                onClick={() => handleMoveToFolder(folder.id)}
              />
            ))}
          </div>
        )}

        <MenuItem
          icon={Edit2}
          label="重命名"
          onClick={handleRename}
        />
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
