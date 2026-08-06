/**
 * NodeCardItem Component
 *
 * Renders a node card in the node pool.
 * Can be dragged to canvas (to use).
 */

import { useState, useCallback, memo, useRef, useEffect } from 'react'
import { Trash2, FileText, Image as ImageIcon } from 'lucide-react'
import { clsx } from 'clsx'
import type { NodeCardItemProps } from '../types/node-pool'
import { containsHTML, safeHTML } from '@/utils/sanitizeHTML'
import { Z_INDEX } from '@/constants'
import { useNodePoolStore } from '../stores/useNodePoolStore'
import { useUIStore } from '@/store/useUIStore'

// 转义正则特殊字符，防止搜索关键词含特殊字符时 new RegExp 抛 SyntaxError（D3）
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function SearchHighlighter({ text, query }: { text: string; query: string }) {
  if (!query.trim() || !text.toLowerCase().includes(query.toLowerCase())) {
    return <span>{containsHTML(text) ? <span dangerouslySetInnerHTML={{ __html: safeHTML(text) }} /> : text}</span>
  }

  const parts = text.split(new RegExp(`(${escapeRegExp(query)})`, 'gi'))
  return (
    <span>
      {parts.map((part, index) => {
        const isMatch = part.toLowerCase() === query.toLowerCase()
        const uniqueKey = `${index}-${isMatch ? 'match' : 'text'}`
        return isMatch ? (
          <span key={uniqueKey} className="bg-yellow-200 dark:bg-yellow-800 font-semibold rounded px-0.5">{containsHTML(part) ? <span dangerouslySetInnerHTML={{ __html: safeHTML(part) }} /> : part}</span>
        ) : (
          <span key={uniqueKey}>{containsHTML(part) ? <span dangerouslySetInnerHTML={{ __html: safeHTML(part) }} /> : part}</span>
        )
      })}
    </span>
  )
}

type DropTarget =
  | { type: 'canvas'; clientX: number; clientY: number }
  | { type: 'folder'; folderId: number }
  | { type: 'pool-root' }
  | { type: 'none' }

/**
 * Compute the actual drop target from the current pointer position.
 * Recomputes DOM rects at mouseup time so sidebar/window changes between
 * mousemove and mouseup do not cause incorrect drops.
 */
function computeDropTarget(clientX: number, clientY: number): DropTarget {
  // Folders take priority (they live inside the node pool panel).
  const folderElements = document.querySelectorAll('[data-folder-id]')
  for (const el of folderElements) {
    const rect = el.getBoundingClientRect()
    if (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      const folderId = el.getAttribute('data-folder-id')
      if (folderId) {
        const parsedId = parseInt(folderId, 10)
        if (!isNaN(parsedId)) {
          return { type: 'folder', folderId: parsedId }
        }
      }
    }
  }

  const canvasElement = document.querySelector('[data-canvas-container]')
  const nodePoolElement = document.querySelector('[data-node-pool="true"]')

  if (canvasElement) {
    const rect = canvasElement.getBoundingClientRect()
    const isOverCanvas =
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom

    if (isOverCanvas) {
      // If the node pool panel overlaps the canvas area, prefer the pool.
      if (nodePoolElement) {
        const poolRect = nodePoolElement.getBoundingClientRect()
        const isOverPool =
          clientX >= poolRect.left &&
          clientX <= poolRect.right &&
          clientY >= poolRect.top &&
          clientY <= poolRect.bottom
        if (isOverPool) {
          return { type: 'pool-root' }
        }
      }
      return { type: 'canvas', clientX, clientY }
    }
  }

  if (nodePoolElement) {
    const poolRect = nodePoolElement.getBoundingClientRect()
    const isOverPool =
      clientX >= poolRect.left &&
      clientX <= poolRect.right &&
      clientY >= poolRect.top &&
      clientY <= poolRect.bottom
    if (isOverPool) {
      return { type: 'pool-root' }
    }
  }

  return { type: 'none' }
}

/**
 * Node card item component with drag and drop support
 */
export const NodeCardItem = memo(function NodeCardItem({
  card,
  onUse: _onUse,
  onRemove,
  onSaveName,
  onContextMenu,
  showPreview = false,
  onTogglePreview,
  searchQuery = '',
}: NodeCardItemProps & { searchQuery?: string }) {
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(card.name)
  const [previewPosition, setPreviewPosition] = useState({ top: 0 })
  const cardRef = useRef<HTMLDivElement>(null)
  const mouseDownPos = useRef<{ x: number; y: number } | null>(null)
  const hasMoved = useRef(false)

  // 拖拽状态
  const [isDragging, setIsDragging] = useState(false)
  const isDraggingRef = useRef(false)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  const [dragSession, setDragSession] = useState(0) // 用于强制 useEffect 重新执行

  // 同步 isDragging 到 ref
  useEffect(() => {
    isDraggingRef.current = isDragging
  }, [isDragging])

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

  // 处理鼠标按下 - 开始拖拽
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // 只处理左键
    if (e.button !== 0) return

    // 如果正在编辑，不处理拖拽
    if (isEditing) return

    // 如果点击的是按钮、输入框或链接，不处理拖拽
    const target = e.target as HTMLElement
    if (target.closest('button') || target.closest('input') || target.closest('a')) {
      return
    }

    // 禁止拖拽正在处理中的卡片；pending 的临时卡片可以拖拽，drop 时会取消创建操作。
    const poolState = useNodePoolStore.getState()
    if (poolState.processingCardIds.has(card.id)) {
      return
    }

    mouseDownPos.current = { x: e.clientX, y: e.clientY }
    hasMoved.current = false
    dragStartRef.current = { x: e.clientX, y: e.clientY }

    // 设置拖拽状态
    const { setDraggingCardFromPool } = useUIStore.getState()
    setDraggingCardFromPool(card)

    // 强制 useEffect 重新执行以添加事件监听器
    setDragSession(prev => prev + 1)
  }, [card, isEditing])

  // 全局鼠标移动处理 - 检测拖拽和画布区域
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return

      const dx = Math.abs(e.clientX - dragStartRef.current.x)
      const dy = Math.abs(e.clientY - dragStartRef.current.y)

      // 如果移动距离超过阈值，开始拖拽
      if (!isDraggingRef.current && (dx > 5 || dy > 5)) {
        setIsDragging(true)
        isDraggingRef.current = true
        hasMoved.current = true

        // 关闭预览
        if (showPreview && onTogglePreview) {
          onTogglePreview(null)
        }

        // 触发全局拖拽开始事件，用于显示虚拟卡片
        const dragStartEvent = new CustomEvent('nodePoolDragStart', {
          detail: {
            card: card,
            clientX: e.clientX,
            clientY: e.clientY,
          },
        })
        document.dispatchEvent(dragStartEvent)
      }

      if (isDraggingRef.current) {
        const canvasElement = document.querySelector('[data-canvas-container]')
        const nodePoolElement = document.querySelector('[data-node-pool="true"]')

        // 检测是否悬停在文件夹上
        const folderElements = document.querySelectorAll('[data-folder-id]')
        let foundFolderId: number | null = null
        for (const el of folderElements) {
          const rect = el.getBoundingClientRect()
          if (e.clientX >= rect.left && e.clientX <= rect.right &&
            e.clientY >= rect.top && e.clientY <= rect.bottom) {
            const folderId = el.getAttribute('data-folder-id')
            if (folderId) {
              const parsedId = parseInt(folderId, 10)
              if (!isNaN(parsedId)) {
                foundFolderId = parsedId
                break
              }
            }
          }
        }
        const { setOverFolderId } = useUIStore.getState()
        setOverFolderId(foundFolderId)

        if (canvasElement) {
          const rect = canvasElement.getBoundingClientRect()
          const isOver = e.clientX >= rect.left && e.clientX <= rect.right &&
            e.clientY >= rect.top && e.clientY <= rect.bottom

          const { setIsOverCanvas, setPoolDragGhostPosition, isOverCanvas } = useUIStore.getState()

          let isActuallyOverCanvas = isOver

          if (nodePoolElement) {
            const poolRect = nodePoolElement.getBoundingClientRect()
            const isOverPool = e.clientX >= poolRect.left && e.clientX <= poolRect.right &&
              e.clientY >= poolRect.top && e.clientY <= poolRect.bottom
            if (isOverPool) {
              isActuallyOverCanvas = false
            }
          }

          // 如果悬停在文件夹上，不在画布上
          if (foundFolderId !== null) {
            isActuallyOverCanvas = false
          }

          if (isActuallyOverCanvas !== isOverCanvas) {
            setIsOverCanvas(isActuallyOverCanvas)
          }

          if (isActuallyOverCanvas) {
            setPoolDragGhostPosition({ x: e.clientX, y: e.clientY })
          } else {
            setPoolDragGhostPosition(null)
          }
        }
      }
    }

    const handleMouseUp = async (e: MouseEvent) => {
      if (!dragStartRef.current) return

      const cleanup = () => {
        const { setDraggingCardFromPool, setOverFolderId, setIsOverCanvas, setPoolDragGhostPosition } = useUIStore.getState()
        setDraggingCardFromPool(null)
        setOverFolderId(null)
        setIsOverCanvas(false)
        setPoolDragGhostPosition(null)

        const dragEndEvent = new CustomEvent('nodePoolDragEnd')
        document.dispatchEvent(dragEndEvent)

        setIsDragging(false)
        isDraggingRef.current = false
        dragStartRef.current = null
        mouseDownPos.current = null
        hasMoved.current = false
      }

      if (isDraggingRef.current) {
        const { addToast } = useUIStore.getState()
        const dropTarget = computeDropTarget(e.clientX, e.clientY)

        if (dropTarget.type === 'canvas') {
          // 统一通过 canvasDrop 事件交给 CanvasPage 处理，避免重复维护 pool → canvas 逻辑
          const customEvent = new CustomEvent('canvasDrop', {
            detail: { card, clientX: e.clientX, clientY: e.clientY },
          })
          document.dispatchEvent(customEvent)

          cleanup()
        } else if (dropTarget.type === 'folder') {
          if (dropTarget.folderId !== card.folderId) {
            const { updateCard } = useNodePoolStore.getState()
            try {
              await updateCard(card.id, { folderId: dropTarget.folderId })
              addToast({ type: 'success', title: '移动成功', message: '卡片已移动到文件夹' })
            } catch (error) {
              addToast({ type: 'error', title: '移动失败', message: '无法移动卡片到文件夹' })
            }
          }
          cleanup()
        } else if (dropTarget.type === 'pool-root') {
          if (card.folderId !== null) {
            const { updateCard } = useNodePoolStore.getState()
            try {
              await updateCard(card.id, { folderId: null })
              addToast({ type: 'success', title: '移出成功', message: '卡片已移出到根目录' })
            } catch (error) {
              addToast({ type: 'error', title: '移出失败', message: '无法将卡片移出文件夹' })
            }
          }
          cleanup()
        } else {
          cleanup()
        }
      } else {
        // 没有拖拽，处理点击
        if (!hasMoved.current) {
          if (cardRef.current) {
            const rect = cardRef.current.getBoundingClientRect()
            setPreviewPosition({ top: rect.top })
          }

          if (onTogglePreview) {
            onTogglePreview(showPreview ? null : card.id)
          }
        }

        cleanup()
      }
    }

    if (dragStartRef.current) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [card, showPreview, onTogglePreview, dragSession])

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

  const parseCardContent = useCallback(() => {
    try {
      const nodeData = JSON.parse(card.content)
      return {
        type: nodeData.type || card.type || 'text',
        title: nodeData.title || card.name,
        content: nodeData.content || '',
        imageUrl: card.thumbnail || nodeData.imageUrl || null,
        color: nodeData.color || card.color,
      }
    } catch {
      return {
        type: card.type || 'text',
        title: card.name,
        content: card.content,
        imageUrl: card.thumbnail || null,
        color: card.color,
      }
    }
  }, [card])

  const contentData = parseCardContent()

  return (
    <>
      {/* Card */}
      <div
        ref={cardRef}
        style={{
          backgroundColor: card.color || '#ffffff',
          opacity: isDragging ? 0 : 1,
          visibility: isDragging ? 'hidden' : 'visible',
        }}
        className={clsx(
          'p-4 rounded-lg border hover:border-blue-400 dark:hover:border-blue-500 cursor-pointer group relative transition-all duration-200 hover:shadow-md'
        )}
        onContextMenu={(e) => onContextMenu?.(e, card)}
        onMouseDown={handleMouseDown}
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
                <h4 className="text-sm font-medium text-gray-800 truncate">
                  <SearchHighlighter text={card.name} query={searchQuery} />
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
            className="fixed pointer-events-auto"
            style={{
              right: '288px',
              top: previewPosition.top,
              transform: 'translateY(-50%)',
              zIndex: Z_INDEX.CONTEXT_MENU,
            }}
          >
            <div
              className="bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 p-4 w-80"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-800 dark:text-white truncate flex-1">
                  {containsHTML(contentData.title) ? (
                    <span dangerouslySetInnerHTML={{ __html: safeHTML(contentData.title) }} />
                  ) : (
                    contentData.title
                  )}
                </h3>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onTogglePreview?.(null)
                  }}
                  className="ml-2 p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
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
                <div className="text-sm text-gray-600 dark:text-gray-400 break-words max-h-48 overflow-y-auto prose prose-sm dark:prose-invert max-w-none">
                  {containsHTML(contentData.content) ? (
                    <div dangerouslySetInnerHTML={{ __html: safeHTML(contentData.content) }} />
                  ) : (
                    <div className="whitespace-pre-wrap">{contentData.content}</div>
                  )}
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
    </>
  )
})

export type { NodeCardItemProps }
