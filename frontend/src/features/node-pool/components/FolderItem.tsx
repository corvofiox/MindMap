/**
 * FolderItem Component
 *
 * Renders a folder in the node pool.
 * Supports nested folders and drag and drop.
 */

import { memo, useState, useRef, useEffect } from 'react'
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
import { useUIStore } from '@/store/useUIStore'
import {
  encodeFolderDragId,
  parseFolderDragId,
  resolveDropPosition,
  type DropPosition,
} from '@/features/drag-sort/reorder'

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
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  editingFolderId = null,
  onUseCard,
  onRemoveCard,
  onSaveCardName,
  editingCardId,
  onReorderFolder,
}: FolderItemProps) {
  const [editName, setEditName] = useState(folder.name)
  const inputRef = useRef<HTMLInputElement>(null)
  const overFolderId = useUIStore(state => state.overFolderId)
  const [dropHint, setDropHint] = useState<DropPosition | null>(null)
  // 拖拽源用 ref 兜底：合成的 DragEvent 里 dataTransfer 可能读不到值
  const draggedFolderIdRef = useRef<number | null>(null)

  const isOverThisFolder = overFolderId === folder.id

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
      import('@/utils/logger').then(({ logger }) => {
        logger.error('Failed to save folder name', error)
      })
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

  const isCollapsed = folder.collapsed

  /**
   * 落点判定：只认"文件夹拖到文件夹上"。
   *
   * 卡片走的是 mousedown 拖拽（NodeCardItem 那套），根本不会产生 dragstart，
   * 所以这里不会抢卡片的活；把卡片拖到文件夹上仍是"移动归属"。
   */
  const handleDragOverFolder = (event: React.DragEvent<HTMLDivElement>) => {
    if (isEditing) return
    const fromTransfer = parseFolderDragId(event.dataTransfer.getData('text/plain'))
    const active = fromTransfer ?? draggedFolderIdRef.current
    if (active === null || active === folder.id) return
    if (!onReorderFolder) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    setDropHint(resolveDropPosition(event.currentTarget.getBoundingClientRect(), event.clientY))
  }

  const handleDropOnFolder = (event: React.DragEvent<HTMLDivElement>) => {
    const fromTransfer = parseFolderDragId(event.dataTransfer.getData('text/plain'))
    const active = fromTransfer ?? draggedFolderIdRef.current
    setDropHint(null)
    draggedFolderIdRef.current = null
    if (active === null || active === folder.id || !onReorderFolder) return
    event.preventDefault()
    event.stopPropagation()
    const position = resolveDropPosition(event.currentTarget.getBoundingClientRect(), event.clientY)
    onReorderFolder(active, folder.id, position)
  }

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
          data-folder-id={folder.id}
          style={{ paddingLeft: `${level * 16 + 8}px` }}
          className={clsx(
            'relative flex items-center gap-1 px-2 py-2.5 rounded-lg cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 transition-all duration-200',
            isOverThisFolder && 'bg-blue-100 dark:bg-blue-900/40 ring-2 ring-blue-500 ring-opacity-50 scale-[1.02] shadow-sm'
          )}
          onClick={handleToggle}
          onContextMenu={(e) => onContextMenu?.(e, folder)}
          draggable={!!onReorderFolder && !isEditing}
          onDragStart={(event) => {
            if (!onReorderFolder || isEditing) return
            draggedFolderIdRef.current = folder.id
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', encodeFolderDragId(folder.id))
          }}
          onDragEnd={() => {
            draggedFolderIdRef.current = null
            setDropHint(null)
          }}
          onDragOver={handleDragOverFolder}
          onDragLeave={() => setDropHint(null)}
          onDrop={handleDropOnFolder}
        >
          {dropHint === 'before' && (
            <span className="pointer-events-none absolute inset-x-1 -top-px z-10 h-0.5 rounded-full bg-blue-500" aria-hidden="true" />
          )}
          <ExpandCollapseIndicator isCollapsed={isCollapsed} hasContent={children.length > 0 || cards.length > 0} />
          <FolderIcon isCollapsed={isCollapsed} isOverThisFolder={isOverThisFolder} />
          <span className={clsx('text-sm font-medium flex-1 truncate', isOverThisFolder ? 'text-blue-700 dark:text-blue-300' : 'text-gray-700 dark:text-gray-300')}>
            {folder.name}
          </span>
          <span className={clsx('text-xs', isOverThisFolder ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400')}>
            {cards.length}
          </span>
          {dropHint === 'after' && (
            <span className="pointer-events-none absolute inset-x-1 -bottom-px z-10 h-0.5 rounded-full bg-blue-500" aria-hidden="true" />
          )}
        </div>
      )}

      {/* Folder contents (when expanded) */}
      {!isCollapsed && (
        <div
          data-folder-id={folder.id}
          className={clsx(
            'ml-4 pl-2 border-l border-gray-200 dark:border-gray-700 my-2 space-y-2 rounded-lg transition-all duration-200',
            isOverThisFolder && 'bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700 border-l-2'
          )}
        >
          {/* Cards in this folder */}
          {cards.map((card) => (
            <div key={card.id} className="py-1">
              <NodeCardItem
                card={card}
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
              cards={[]}
              children={child.children || []}
              searchQuery={searchQuery}
              onToggle={onToggle}
              onContextMenu={onContextMenu}
              onCardContextMenu={onCardContextMenu}
              previewCardId={previewCardId}
              onTogglePreview={onTogglePreview}
              onStartEdit={onStartEdit}
              onSaveEdit={onSaveEdit}
              onCancelEdit={onCancelEdit}
              editingFolderId={editingFolderId}
              onUseCard={onUseCard}
              onRemoveCard={onRemoveCard}
              onSaveCardName={onSaveCardName}
              editingCardId={editingCardId}
              onReorderFolder={onReorderFolder}
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

function FolderIcon({ isCollapsed, isOverThisFolder }: { isCollapsed: boolean; isOverThisFolder: boolean }) {
  return isCollapsed ? (
    <Folder className={clsx('w-4 h-4', isOverThisFolder ? 'text-blue-500' : 'text-gray-400 dark:text-gray-500')} />
  ) : (
    <FolderOpen className={clsx('w-4 h-4', isOverThisFolder ? 'text-blue-600' : 'text-blue-500')} />
  )
}

export type { FolderItemProps }
