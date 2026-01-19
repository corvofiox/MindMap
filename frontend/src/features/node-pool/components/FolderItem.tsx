/**
 * FolderItem Component
 *
 * Renders a folder in the node pool.
 * Supports nested folders and drag and drop.
 */

import { memo, useState, useCallback, useRef, useEffect } from 'react'
import {
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Check,
  X,
} from 'lucide-react'
import { clsx } from 'clsx'
import type { FolderItemProps } from '../types/node-pool'
import { NodeCardItem } from './NodeCardItem'

/**
 * Folder item component with drag and drop support
 */
export const FolderItem = memo(function FolderItem({
  folder,
  level = 0,
  cards,
  children,
  searchQuery = '',
  onToggle,
  onContextMenu,
  onCardContextMenu,
  previewCardId,
  onTogglePreview,
  onDrop,
  onDragOver,
  onDragLeave,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  editingFolderId = null,
  onUseCard,
  onRemoveCard,
  onSaveCardName,
  editingCardId,
}: FolderItemProps) {
  const [isLocalDragOver, setIsLocalDragOver] = useState(false)
  const [editName, setEditName] = useState(folder.name)
  const inputRef = useRef<HTMLInputElement>(null)

  const isEditing = editingFolderId === folder.id

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  useEffect(() => {
    if (isEditing) {
      setEditName(folder.name)
    }
  }, [isEditing, folder.name])

  const handleToggle = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!isEditing) {
      onToggle?.(folder.id)
    }
  }

  const handleStartEdit = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setEditName(folder.name)
    onStartEdit?.(folder)
  }

  const handleSaveEdit = async () => {
    if (!editName.trim()) {
      return
    }

    if (editName === folder.name) {
      onCancelEdit?.()
      return
    }

    try {
      await onSaveEdit?.(folder.id, editName.trim())
    } catch (error) {
      console.error('Failed to save folder name:', error)
    }
  }

  const handleCancelEdit = () => {
    setEditName(folder.name)
    onCancelEdit?.()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSaveEdit()
    } else if (e.key === 'Escape') {
      handleCancelEdit()
    }
  }

  const handleFolderDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsLocalDragOver(true)
    onDragOver?.(e, folder)
  }, [folder, onDragOver])

  const handleFolderDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsLocalDragOver(false)
    onDragLeave?.(e, folder)
  }, [folder, onDragLeave])

  const handleFolderDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsLocalDragOver(false)
    onDrop?.(e, folder)
  }, [folder, onDrop])

  const isCollapsed = folder.collapsed

  return (
    <>
      {isEditing ? (
        <div
          style={{ paddingLeft: `${level * 16 + 8}px` }}
          className="flex items-center gap-1 px-2 py-1.5 rounded bg-blue-50 dark:bg-blue-900/30"
        >
          <Folder className="w-4 h-4 text-gray-400 flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 text-sm bg-transparent border-b border-blue-500 outline-none text-gray-700 dark:text-gray-300 px-1"
          />
          <button
            onClick={handleSaveEdit}
            className="p-1 rounded hover:bg-green-100 dark:hover:bg-green-900/30 text-green-600 dark:text-green-400"
            title="保存"
          >
            <Check className="w-3 h-3" />
          </button>
          <button
            onClick={handleCancelEdit}
            className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400"
            title="取消"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ) : (
        <div
          style={{ paddingLeft: `${level * 16 + 8}px` }}
          className={clsx(
            'flex items-center gap-1 px-2 py-2.5 rounded-lg cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 transition-all duration-200',
            isLocalDragOver && 'bg-blue-100 dark:bg-blue-900/40 ring-2 ring-blue-500 ring-opacity-50 scale-[1.02] shadow-sm'
          )}
          onClick={handleToggle}
          onContextMenu={(e) => onContextMenu?.(e, folder)}
          onDragOver={handleFolderDragOver}
          onDragLeave={handleFolderDragLeave}
          onDrop={handleFolderDrop}
        >
          <ExpandCollapseIndicator isCollapsed={isCollapsed} hasContent={children.length > 0 || cards.length > 0} />
          <FolderIcon isCollapsed={isCollapsed} isLocalDragOver={isLocalDragOver} />
          <span className={clsx('text-sm font-medium flex-1 truncate', isLocalDragOver ? 'text-blue-700 dark:text-blue-300' : 'text-gray-700 dark:text-gray-300')}>
            {folder.name}
          </span>
          <span className={clsx('text-xs', isLocalDragOver ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400')}>
            {cards.length}
          </span>
        </div>
      )}

      {/* Folder contents (when expanded) */}
      {!isCollapsed && (
        <div
          className={clsx(
            'ml-4 pl-2 border-l border-gray-200 dark:border-gray-700 my-2 space-y-2 rounded-lg transition-all duration-200',
            isLocalDragOver && 'bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700 border-l-2'
          )}
          onDragOver={handleFolderDragOver}
          onDragLeave={handleFolderDragLeave}
          onDrop={handleFolderDrop}
        >
          {/* Cards in this folder */}
          {cards.map((card) => (
            <div key={card.id} className="py-1">
              <NodeCardItem
                card={card}
                isDragging={false}
                isDragOver={false}
                dragOverPosition={null}
                onUse={onUseCard || (() => {})}
                onRemove={onRemoveCard || (() => {})}
                onSaveName={onSaveCardName || (() => Promise.resolve())}
                onContextMenu={onCardContextMenu}
                showPreview={previewCardId === card.id}
                onTogglePreview={onTogglePreview}
                searchQuery={searchQuery}
              />
            </div>
          ))}

          {/* Nested folders */}
          {children.map((child) => (
            <FolderItem
              key={child.id}
              folder={child}
              level={level + 1}
              cards={[]} // Cards will be passed from parent
              children={child.children || []}
              searchQuery={searchQuery}
              isDragOver={false}
              dragOverPosition={null}
              onToggle={onToggle}
              onContextMenu={onContextMenu}
              onCardContextMenu={onCardContextMenu}
              previewCardId={previewCardId}
              onTogglePreview={onTogglePreview}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onStartEdit={onStartEdit}
              onSaveEdit={onSaveEdit}
              onCancelEdit={onCancelEdit}
              editingFolderId={editingFolderId}
              onUseCard={onUseCard}
              onRemoveCard={onRemoveCard}
              onSaveCardName={onSaveCardName}
              editingCardId={editingCardId}
            />
          ))}

          {/* Empty folder message */}
          {cards.length === 0 && children.length === 0 && (
            <div className="text-center py-4 text-sm text-gray-400">
              空文件夹
            </div>
          )}
        </div>
      )}
    </>
  )
})

function ExpandCollapseIndicator({ isCollapsed, hasContent }: { isCollapsed: boolean; hasContent: boolean }) {
  if (!hasContent) return null
  return isCollapsed ? (
    <ChevronRight className="w-3.5 h-3.5 text-gray-500" />
  ) : (
    <ChevronDown className="w-3.5 h-3.5 text-gray-500" />
  )
}

function FolderIcon({ isCollapsed, isLocalDragOver }: { isCollapsed: boolean; isLocalDragOver: boolean }) {
  return isCollapsed ? (
    <Folder className={clsx('w-4 h-4', isLocalDragOver ? 'text-blue-500' : 'text-gray-400 dark:text-gray-500')} />
  ) : (
    <FolderOpen className={clsx('w-4 h-4', isLocalDragOver ? 'text-blue-600' : 'text-blue-500')} />
  )
}

export type { FolderItemProps }
