/**
 * NodeCardItem Component
 *
 * Renders a node card in the node pool.
 * Can be dragged to the canvas (to use).
 */

import { useState, useCallback, memo, useRef, useEffect } from 'react'
import { Trash2, FileText, Image as ImageIcon } from 'lucide-react'
import { clsx } from 'clsx'
import type { NodeCard } from '@/types'
import type { NodeCardItemProps } from '../types/node-pool'

/**
 * Node card item component with drag and drop support
 */
export const NodeCardItem = memo(function NodeCardItem({
  card,
  isDragging,
  isDragOver,
  dragOverPosition,
  onUse,
  onRemove,
  onSaveName,
  onContextMenu,
  showPreview = false,
  onTogglePreview,
}: NodeCardItemProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(card.name)
  const [previewPosition, setPreviewPosition] = useState({ top: 0 })
  const cardRef = useRef<HTMLDivElement>(null)
  const mouseDownPos = useRef<{ x: number; y: number } | null>(null)
  const hasMoved = useRef(false)

  const handleSave = useCallback(async () => {
    if (editName.trim() && editName.trim() !== card.name) {
      await onSaveName(card.id, editName.trim())
    }
    setIsEditing(false)
    setEditName(card.name)
  }, [card.id, card.name, editName, onSaveName])

  const handleCancel = useCallback(() => {
    setIsEditing(false)
    setEditName(card.name)
  }, [card.name])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSave()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      handleCancel()
    }
  }, [handleSave, handleCancel])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    mouseDownPos.current = { x: e.clientX, y: e.clientY }
    hasMoved.current = false
  }, [])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!mouseDownPos.current) return
    
    const dx = Math.abs(e.clientX - mouseDownPos.current.x)
    const dy = Math.abs(e.clientY - mouseDownPos.current.y)
    
    if (dx > 5 || dy > 5) {
      hasMoved.current = true
    }
  }, [])

  const handleCardClick = useCallback((e: React.MouseEvent) => {
    if (isEditing || hasMoved.current) {
      return
    }

    const target = e.target as HTMLElement
    if (target.closest('button') || target.closest('input') || target.closest('a')) {
      return
    }

    if (cardRef.current) {
      const rect = cardRef.current.getBoundingClientRect()
      setPreviewPosition({ top: rect.top })
    }

    if (onTogglePreview) {
      onTogglePreview(showPreview ? null : card.id)
    }
  }, [isEditing, showPreview, card.id, onTogglePreview])

  const handleDragStart = useCallback((e: React.DragEvent) => {
    if (showPreview && onTogglePreview) {
      onTogglePreview(null)
    }
    e.dataTransfer.setData('application/nodepool-card', JSON.stringify(card))
    e.dataTransfer.effectAllowed = 'copy'
  }, [card, showPreview, onTogglePreview])

  const handleDragEnd = useCallback(() => {
    hasMoved.current = false
    mouseDownPos.current = null
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showPreview && onTogglePreview) {
        onTogglePreview(null)
      }
    }

    const handleClickOutside = (e: MouseEvent) => {
      if (showPreview && onTogglePreview && cardRef.current) {
        const target = e.target as Node
        if (!cardRef.current.contains(target)) {
          onTogglePreview(null)
        }
      }
    }

    if (showPreview) {
      document.addEventListener('keydown', handleKeyDown)
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showPreview, onTogglePreview])

  // Parse card content for display
  const parseCardContent = useCallback(() => {
    try {
      const nodeData = JSON.parse(card.content)
      return {
        type: nodeData.type || 'text',
        title: nodeData.title || card.name,
        content: nodeData.content || '',
        imageUrl: nodeData.imageUrl || null,
        color: nodeData.color || card.color,
      }
    } catch {
      return {
        type: 'text',
        title: card.name,
        content: card.content,
        imageUrl: null,
        color: card.color,
      }
    }
  }, [card])

  const contentData = parseCardContent()

  return (
    <>
      {/* Drop indicator - above */}
      {isDragOver && dragOverPosition === 'before' && (
        <div className="h-0.5 bg-blue-500 rounded -mt-1 mb-1" />
      )}

      {/* Card */}
      <div
        ref={cardRef}
        style={{ backgroundColor: card.color || '#ffffff' }}
        className={clsx(
          'p-4 rounded-lg border hover:border-blue-400 dark:hover:border-blue-500 cursor-pointer group relative transition-all duration-200 hover:shadow-md',
          isDragging && 'opacity-50 rotate-2 scale-105',
          isDragOver && dragOverPosition === 'inside' && 'ring-2 ring-blue-500'
        )}
        onClick={handleCardClick}
        onContextMenu={(e) => onContextMenu?.(e, card)}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        draggable
      >
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0 flex items-start gap-2">
            <div className={clsx(
              'mt-0.5 flex-shrink-0',
              contentData.type === 'image' ? 'text-purple-500 dark:text-purple-400' : 'text-blue-500 dark:text-blue-400'
            )}>
              {contentData.type === 'image' ? (
                <ImageIcon className="w-4 h-4" />
              ) : (
                <FileText className="w-4 h-4" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              {isEditing ? (
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={handleSave}
                  onKeyDown={handleKeyDown}
                  className="w-full px-1 py-0.5 text-sm bg-white dark:bg-gray-800 border border-blue-500 rounded outline-none"
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <h4 className="text-sm font-medium text-gray-800 dark:text-white truncate">
                  {card.name}
                </h4>
              )}
              {card.description && !isEditing && (
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 line-clamp-2">
                  {card.description}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={(e) => {
                e.stopPropagation()
                onRemove(card.id)
              }}
              className="p-1.5 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400 bg-white/50 dark:bg-gray-800/50 backdrop-blur-sm shadow-sm border border-red-200 dark:border-red-900/50"
              title="删除"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="mt-2 text-xs text-gray-400 dark:text-gray-500">
          添加于 {new Date(card.createdAt).toLocaleDateString()}
        </div>

        {/* Preview tooltip */}
        {showPreview && (
          <div
            className="fixed z-[80] pointer-events-auto"
            style={{
              right: '288px',
              top: previewPosition.top,
              transform: 'translateY(-50%)'
            }}
          >
            <div 
              className="bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 p-4 w-80"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-800 dark:text-white truncate flex-1">
                  {contentData.title}
                </h3>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onTogglePreview?.(null)
                  }}
                  className="ml-2 p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6 6 18"/>
                    <path d="m6 6 12 12"/>
                  </svg>
                </button>
              </div>
              
              {contentData.imageUrl && (
                <div className="mb-3 rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-900">
                  <img 
                    src={contentData.imageUrl} 
                    alt={contentData.title}
                    className="w-full max-h-64 object-contain"
                  />
                </div>
              )}
              
              {contentData.content && (
                <div className="text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                  {contentData.content}
                </div>
              )}
              
              <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
                <span>类型: {contentData.type}</span>
                <span>添加于 {new Date(card.createdAt).toLocaleDateString()}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Drop indicator - below */}
      {isDragOver && dragOverPosition === 'after' && (
        <div className="h-0.5 bg-blue-500 rounded -mb-1 mt-1" />
      )}
    </>
  )
})

export type { NodeCardItemProps }
