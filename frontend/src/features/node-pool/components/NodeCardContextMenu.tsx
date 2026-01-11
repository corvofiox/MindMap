import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import {
  Edit2,
  Trash2,
  Folder,
  Copy,
} from 'lucide-react'
import { useNodePoolStore } from '../stores/useNodePoolStore'
import { useUIStore } from '@/store/useUIStore'
import { useCanvasStore } from '@/store/useCanvasStore'
import type { NodeCard } from '@/types'

interface NodeCardContextMenuProps {
  card: NodeCard
  position: { x: number; y: number }
  onClose: () => void
  onRename?: () => void
  onMoveToFolder?: (folderId: number | null) => void
}

export function NodeCardContextMenu({ card, position, onClose, onRename, onMoveToFolder }: NodeCardContextMenuProps) {
  const { updateCard, removeCard } = useNodePoolStore()
  const { addToast, setDragGhost } = useUIStore()
  const { addNode } = useCanvasStore()
  const menuRef = useRef<HTMLDivElement>(null)
  const [adjustedPosition, setAdjustedPosition] = useState(position)
  const [moveMenuOpen, setMoveMenuOpen] = useState(false)

  const folders = useNodePoolStore((state) => Array.from(state.foldersMap.values()).sort((a, b) => a.sortOrder - b.sortOrder))

  useEffect(() => {
    const adjustPosition = () => {
      if (!menuRef.current) return

      const rect = menuRef.current.getBoundingClientRect()
      const padding = 10
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight

      let x = position.x
      let y = position.y

      if (x + rect.width > viewportWidth - padding) {
        x = viewportWidth - rect.width - padding
      }
      if (x < padding) {
        x = padding
      }

      if (y + rect.height > viewportHeight - padding) {
        y = viewportHeight - rect.height - padding
      }
      if (y < padding) {
        y = padding
      }

      setAdjustedPosition({ x, y })
    }

    const timeoutId = setTimeout(adjustPosition, 0)
    return () => clearTimeout(timeoutId)
  }, [position, moveMenuOpen])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as unknown as globalThis.Node)) {
        onClose()
      }
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])

  const handleRename = () => {
    onRename?.()
    onClose()
  }

  const handleDelete = async () => {
    try {
      await removeCard(card.id)
      addToast({ type: 'success', title: '删除成功', message: '节点已从节点池删除' })
    } catch (error) {
      addToast({ type: 'error', title: '删除失败', message: error instanceof Error ? error.message : '未知错误' })
    }
    onClose()
  }

  const handleCopyToCanvas = () => {
    setDragGhost(card, { x: position.x, y: position.y })
    onClose()
  }

  const handleMoveToFolder = (folderId: number | null) => {
    onMoveToFolder?.(folderId)
    setMoveMenuOpen(false)
    onClose()
  }

  const MenuItem = ({
    icon: Icon,
    label,
    onClick,
    shortcut,
    disabled = false,
    danger = false,
    rightElement,
  }: {
    icon: typeof Edit2
    label: string
    onClick: () => void
    shortcut?: string
    disabled?: boolean
    danger?: boolean
    rightElement?: React.ReactNode
  }) => (
    <button
      className={`
        w-full flex items-center gap-2 px-3 py-2 text-sm rounded
        ${disabled
          ? 'opacity-40 cursor-not-allowed'
          : danger
            ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30'
            : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
        }
      `}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon className="w-3 h-3" />
      {label}
      {shortcut && (
        <span className="text-xs text-gray-400 dark:text-gray-500">{shortcut}</span>
      )}
      {rightElement}
    </button>
  )

  const MenuDivider = () => <div className="h-px bg-gray-200 dark:border-gray-700 border-t border-gray-200 dark:border-gray-700 my-1" />

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />

      <div
        ref={menuRef}
        className="fixed z-50 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 min-w-[160px]"
        style={{
          left: adjustedPosition.x,
          top: adjustedPosition.y,
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
