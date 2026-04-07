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
import { useProjectsStore } from '@/store/useProjectsStore'
import { useCanvasStore } from '@/store/useCanvasStore'

function SearchHighlighter({ text, query }: { text: string; query: string }) {
  if (!query.trim() || !text.toLowerCase().includes(query.toLowerCase())) {
    return <span>{containsHTML(text) ? <span dangerouslySetInnerHTML={{ __html: safeHTML(text) }} /> : text}</span>
  }

  const parts = text.split(new RegExp(`(${query})`, 'gi'))
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

  // 卡片可见性状态（用于管理删除标记）
  const [isVisible, setIsVisible] = useState(true)

  // 监听 _markedForDeletion 状态变化
  useEffect(() => {
    const checkDeletionStatus = () => {
      const tempCard = useNodePoolStore.getState().temporaryCards.get(card.id)
      const isMarkedForDeletion = tempCard?.card._markedForDeletion === true

      if (isMarkedForDeletion && isVisible) {
        setIsVisible(false)
      } else if (!isMarkedForDeletion && !isVisible) {
        const store = useNodePoolStore.getState()
        if (store.cardsMap.has(card.id)) {
          setIsVisible(true)
        }
      }
    }

    checkDeletionStatus()

    const interval = setInterval(() => {
      checkDeletionStatus()
    }, 50)

    return () => clearInterval(interval)
  }, [card.id, isVisible])

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
        const { setDraggingCardFromPool, setOverFolderId } = useUIStore.getState()
        setDraggingCardFromPool(null)
        setOverFolderId(null)

        const dragEndEvent = new CustomEvent('nodePoolDragEnd')
        document.dispatchEvent(dragEndEvent)

        setIsDragging(false)
        isDraggingRef.current = false
        dragStartRef.current = null
        mouseDownPos.current = null
        hasMoved.current = false
      }

      if (isDraggingRef.current) {
        const { isOverCanvas, addToast } = useUIStore.getState()

        if (isOverCanvas) {
          // 在画布区域释放，添加节点到画布
          const { currentProject } = useProjectsStore.getState()
          const { moveNodeFromPool } = useCanvasStore.getState()

          if (currentProject) {
            try {
              const nodeData = JSON.parse(card.content)
              const canvasRect = document.querySelector('[data-canvas-container]')?.getBoundingClientRect()
              const { zoom, panX, panY } = useCanvasStore.getState()

              const mouseInCanvasX = canvasRect ? e.clientX - canvasRect.left : e.clientX
              const mouseInCanvasY = canvasRect ? e.clientY - canvasRect.top : e.clientY

              const canvasX = (mouseInCanvasX - panX) / zoom
              const canvasY = (mouseInCanvasY - panY) / zoom

              const nodeWidth = nodeData.width || 200
              const nodeHeight = nodeData.height || 120

              const nodeX = canvasX - nodeWidth / 2
              const nodeY = canvasY - nodeHeight / 2

              const newNode = {
                id: `node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                x: nodeX,
                y: nodeY,
                width: nodeWidth,
                height: nodeHeight,
                title: nodeData.title || card.name,
                content: nodeData.content || '',
                type: nodeData.type || card.type || 'text',
                color: nodeData.color || card.color,
                fontSize: nodeData.fontSize || 14,
                locked: false,
                zIndex: 1,
                textAlign: nodeData.textAlign || 'left',
                collapsed: nodeData.collapsed || false,
                ...(nodeData.type === 'image' && { imageUrl: nodeData.imageUrl || card.thumbnail }),
              }

              moveNodeFromPool(
                newNode,
                async () => {
                  const { cardsMap, removeCard, temporaryCards, operationQueue } = useNodePoolStore.getState()

                  // 首先尝试直接移除当前卡片（处理临时卡片的情况）
                  const cardToRemove = cardsMap.get(card.id) || temporaryCards.get(card.id)?.card
                  if (cardToRemove) {
                    await removeCard(card.id)
                    return
                  }

                  // 如果直接移除失败（临时卡片可能已被替换），检查 temporaryCards 映射
                  const tempCardInfo = temporaryCards.get(card.id)
                  if (tempCardInfo?.realCardId) {
                    // 临时卡片已被替换为真实卡片，使用真实ID移除
                    await removeCard(tempCardInfo.realCardId)
                    return
                  }

                  // 检查 operationQueue 中是否有该临时卡片的操作记录
                  for (const [, op] of operationQueue) {
                    if (op.cardId === card.id && op.realCardId) {
                      await removeCard(op.realCardId)
                      return
                    }
                  }

                  // 最后尝试通过内容匹配查找卡片
                  for (const [cardId, poolCard] of cardsMap) {
                    try {
                      const cardNodeData = JSON.parse(poolCard.content)
                      if (cardNodeData.id === newNode.id) {
                        await removeCard(cardId)
                        break
                      }
                    } catch {
                      // JSON parse error - ignore invalid content
                    }
                  }
                },
                async () => {
                  const { addCard } = useNodePoolStore.getState()
                  await addCard({
                    name: card.name,
                    content: JSON.stringify(newNode),
                    type: card.type,
                    color: card.color,
                    tags: card.tags,
                    sortOrder: card.sortOrder,
                    folderId: card.folderId,
                    thumbnail: card.thumbnail,
                  })
                }
              )

              addToast({ type: 'success', title: '节点已添加', message: '节点已添加到画布' })
            } catch (error) {
              addToast({ type: 'error', title: '添加失败', message: '无法解析节点数据' })
            }
          }

          cleanup()
        } else {
          // 不在画布上释放，检查是否在文件夹上释放
          const folderElements = document.querySelectorAll('[data-folder-id]')
          let targetFolderId: number | null = null

          for (const el of folderElements) {
            const rect = el.getBoundingClientRect()
            if (e.clientX >= rect.left && e.clientX <= rect.right &&
              e.clientY >= rect.top && e.clientY <= rect.bottom) {
              const folderId = el.getAttribute('data-folder-id')
              if (folderId) {
                const parsedId = parseInt(folderId, 10)
                if (!isNaN(parsedId)) {
                  targetFolderId = parsedId
                  break
                }
              }
            }
          }

          // 检测是否在节点池根目录空白区域
          const nodePoolElement = document.querySelector('[data-node-pool="true"]')
          let isOverNodePoolRoot = false

          if (nodePoolElement && targetFolderId === null) {
            const poolRect = nodePoolElement.getBoundingClientRect()
            const isOverPool = e.clientX >= poolRect.left && e.clientX <= poolRect.right &&
              e.clientY >= poolRect.top && e.clientY <= poolRect.bottom

            if (isOverPool) {
              isOverNodePoolRoot = true
            }
          }

          if (targetFolderId !== null && targetFolderId !== card.folderId) {
            // 移动到文件夹
            const { updateCard } = useNodePoolStore.getState()
            try {
              await updateCard(card.id, { folderId: targetFolderId })
              addToast({ type: 'success', title: '移动成功', message: '卡片已移动到文件夹' })
            } catch (error) {
              addToast({ type: 'error', title: '移动失败', message: '无法移动卡片到文件夹' })
            }
          } else if (isOverNodePoolRoot && card.folderId !== null) {
            // 从文件夹移出到根目录
            const { updateCard } = useNodePoolStore.getState()
            try {
              await updateCard(card.id, { folderId: null })
              addToast({ type: 'success', title: '移出成功', message: '卡片已移出到根目录' })
            } catch (error) {
              addToast({ type: 'error', title: '移出失败', message: '无法将卡片移出文件夹' })
            }
          }

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

  // 如果卡片不可见，不渲染内容
  if (!isVisible) {
    return null
  }

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
