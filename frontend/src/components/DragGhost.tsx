import { useEffect, useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { useUIStore } from '@/store/useUIStore'
import { Z_INDEX } from '@/constants'
import { stripHTML } from '@/utils/sanitizeHTML'
import type { Node, NodeCard } from '@/types'

export function DragGhost() {
  const { draggingNodeFromCanvas, canvasDragGhostPosition, isOverNodePool, draggingCardFromPool, isOverCanvas, poolDragGhostPosition } = useUIStore()
  const [draggingCardFromPoolLocal, setDraggingCardFromPoolLocal] = useState<NodeCard | null>(null)
  const [draggingCardPoolPosition, setDraggingCardPoolPosition] = useState<{ x: number; y: number } | null>(null)

  const clearPoolDragState = useCallback(() => {
    setDraggingCardFromPoolLocal(null)
    setDraggingCardPoolPosition(null)
    const { setDraggingCardFromPool, setIsOverCanvas, setPoolDragGhostPosition, setOverFolderId } = useUIStore.getState()
    setDraggingCardFromPool(null)
    setIsOverCanvas(false)
    setPoolDragGhostPosition(null)
    setOverFolderId(null)
  }, [])

  useEffect(() => {
    const handleNodePoolDragStart = (e: Event) => {
      const customEvent = e as CustomEvent<{ card: NodeCard; clientX: number; clientY: number }>
      const { card, clientX, clientY } = customEvent.detail
      setDraggingCardFromPoolLocal(card)
      setDraggingCardPoolPosition({ x: clientX, y: clientY })
    }

    const handleNodePoolDragMove = (e: MouseEvent) => {
      if (draggingCardFromPoolLocal) {
        setDraggingCardPoolPosition({ x: e.clientX, y: e.clientY })
      }
    }

    const handleNodePoolDragEnd = () => {
      clearPoolDragState()
    }

    const handleMouseUp = () => {
      if (draggingCardFromPoolLocal) {
        clearPoolDragState()
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && draggingCardFromPoolLocal) {
        clearPoolDragState()
      }
    }

    document.addEventListener('nodePoolDragStart', handleNodePoolDragStart)
    document.addEventListener('mousemove', handleNodePoolDragMove)
    document.addEventListener('nodePoolDragEnd', handleNodePoolDragEnd)
    document.addEventListener('mouseup', handleMouseUp)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('nodePoolDragStart', handleNodePoolDragStart)
      document.removeEventListener('mousemove', handleNodePoolDragMove)
      document.removeEventListener('nodePoolDragEnd', handleNodePoolDragEnd)
      document.removeEventListener('mouseup', handleMouseUp)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [draggingCardFromPoolLocal, clearPoolDragState])

  // 处理从节点池拖拽但尚未进入画布时的幽灵效果（节点池内样式）
  if (draggingCardFromPoolLocal && !isOverCanvas && draggingCardPoolPosition) {
    let nodeData
    try {
      nodeData = JSON.parse(draggingCardFromPoolLocal.content)
    } catch {
      nodeData = {
        type: draggingCardFromPoolLocal.type || 'text',
        title: draggingCardFromPoolLocal.name || '未知节点',
        content: draggingCardFromPoolLocal.content || '',
        imageUrl: draggingCardFromPoolLocal.thumbnail || null,
        color: draggingCardFromPoolLocal.color || '#ffffff',
        fontSize: 14,
      }
    }

    const isImageNode = nodeData.type === 'image' && (nodeData.imageUrl || draggingCardFromPoolLocal.thumbnail)
    const nodeWidth = 160
    const nodeHeight = isImageNode ? 100 : 80
    const nodeColor = nodeData.color || draggingCardFromPoolLocal.color || '#ffffff'
    const fontSize = nodeData.fontSize || 14

    return createPortal(
      <div
        className="fixed pointer-events-none"
        style={{
          left: draggingCardPoolPosition.x,
          top: draggingCardPoolPosition.y,
          transform: 'translate(-50%, -50%)',
          zIndex: Z_INDEX.DRAG_GHOST,
        }}
      >
        <div
          className="rounded-lg shadow-xl border-2 border-blue-400 overflow-hidden"
          style={{
            width: nodeWidth,
            height: nodeHeight,
            backgroundColor: nodeColor,
            boxShadow: '0 8px 24px rgba(59, 130, 246, 0.3)',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            className="flex-shrink-0 px-3 py-2 border-b border-gray-100 dark:border-gray-700/50 bg-white/50"
            style={{ minHeight: '28px' }}
          >
            <div
              className="font-semibold truncate"
              style={{
                fontSize: fontSize,
                color: '#111827',
              }}
            >
              {stripHTML(nodeData.title || draggingCardFromPoolLocal.name || '未知节点')}
            </div>
          </div>

          <div className="flex-1 overflow-hidden p-2">
            {isImageNode ? (
              <div className="w-full h-full flex items-center justify-center bg-gray-50 dark:bg-gray-800/50 rounded">
                <img
                  src={nodeData.imageUrl || draggingCardFromPoolLocal.thumbnail}
                  alt={nodeData.title}
                  className="w-full h-full object-cover rounded"
                />
              </div>
            ) : (
              <div
                className="text-xs text-gray-500 line-clamp-2"
                style={{
                  fontSize: fontSize - 2,
                  lineHeight: '1.4',
                }}
              >
                {stripHTML(nodeData.content || '')}
              </div>
            )}
          </div>
        </div>
      </div>,
      document.body
    )
  }

  // 处理从节点池拖拽到画布的幽灵效果（画布样式）
  if (draggingCardFromPool && isOverCanvas && poolDragGhostPosition) {
    let nodeData
    try {
      nodeData = JSON.parse(draggingCardFromPool.content)
    } catch {
      nodeData = {
        type: draggingCardFromPool.type || 'text',
        title: draggingCardFromPool.name || '未知节点',
        content: draggingCardFromPool.content || '',
        imageUrl: draggingCardFromPool.thumbnail || null,
        width: 200,
        height: 120,
        color: draggingCardFromPool.color || '#ffffff',
        fontSize: 14,
      }
    }

    const isImageNode = nodeData.type === 'image' && (nodeData.imageUrl || draggingCardFromPool.thumbnail)
    const nodeWidth = nodeData.width || 200
    const nodeHeight = nodeData.height || (isImageNode ? nodeWidth * 0.75 : 120)
    const nodeColor = nodeData.color || draggingCardFromPool.color || '#ffffff'
    const fontSize = nodeData.fontSize || 14

    return createPortal(
      <div
        className="fixed pointer-events-none"
        style={{
          left: poolDragGhostPosition.x,
          top: poolDragGhostPosition.y,
          transform: 'translate(-50%, -50%)',
          zIndex: Z_INDEX.DRAG_GHOST,
        }}
      >
        <div
          className="rounded-xl shadow-xl border-2 border-blue-400 overflow-hidden"
          style={{
            width: nodeWidth,
            height: nodeHeight,
            backgroundColor: nodeColor,
            boxShadow: '0 8px 24px rgba(59, 130, 246, 0.3)',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            className="flex-shrink-0 px-4 py-2.5 border-b border-gray-100 dark:border-gray-700/50"
            style={{ minHeight: '36px' }}
          >
            <div
              className="font-semibold"
              style={{
                fontSize: fontSize + 2,
                color: '#111827',
                minHeight: '24px',
              }}
            >
              {stripHTML(nodeData.title || draggingCardFromPool.name || '图片节点')}
            </div>
          </div>

          <div className="flex-1 overflow-hidden">
            {isImageNode ? (
              <div className="w-full h-full flex items-center justify-center bg-gray-50 dark:bg-gray-800/50">
                <img
                  src={nodeData.imageUrl || draggingCardFromPool.thumbnail}
                  alt={nodeData.title}
                  className="w-full h-full object-contain"
                />
              </div>
            ) : (
              <div
                className="p-4 overflow-auto"
                style={{
                  fontSize: fontSize,
                  color: '#4b5563',
                  minHeight: '40px',
                  lineHeight: '1.6',
                }}
              >
                {stripHTML(nodeData.content || draggingCardFromPool.description || '双击添加内容')}
              </div>
            )}
          </div>
        </div>
      </div>,
      document.body
    )
  }

  // 处理从画布拖拽节点到节点池的幽灵效果
  if (draggingNodeFromCanvas && isOverNodePool && canvasDragGhostPosition) {
    const node = draggingNodeFromCanvas.nodeData as Node
    const isImageNode = node.type === 'image' && node.imageUrl
    const nodeWidth = 160
    const nodeHeight = isImageNode ? 100 : 80
    const nodeColor = node.color || '#ffffff'
    const fontSize = node.fontSize || 14

    return createPortal(
      <div
        className="fixed pointer-events-none"
        style={{
          left: canvasDragGhostPosition.x,
          top: canvasDragGhostPosition.y,
          transform: 'translate(-50%, -50%)',
          zIndex: Z_INDEX.DRAG_GHOST,
        }}
      >
        <div
          className="rounded-lg shadow-xl border-2 border-blue-400 overflow-hidden"
          style={{
            width: nodeWidth,
            height: nodeHeight,
            backgroundColor: nodeColor,
            boxShadow: '0 8px 24px rgba(59, 130, 246, 0.3)',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            className="flex-shrink-0 px-3 py-2 border-b border-gray-100 dark:border-gray-700/50 bg-white/50"
            style={{ minHeight: '28px' }}
          >
            <div
              className="font-semibold truncate"
              style={{
                fontSize: fontSize,
                color: '#111827',
              }}
            >
              {stripHTML(node.title || '未命名节点')}
            </div>
          </div>

          <div className="flex-1 overflow-hidden p-2">
            {isImageNode ? (
              <div className="w-full h-full flex items-center justify-center bg-gray-50 dark:bg-gray-800/50 rounded">
                <img
                  src={node.imageUrl}
                  alt={node.title}
                  className="w-full h-full object-cover rounded"
                />
              </div>
            ) : (
              <div
                className="text-xs text-gray-500 line-clamp-2"
                style={{
                  fontSize: fontSize - 2,
                  lineHeight: '1.4',
                }}
              >
                {stripHTML(node.content || '')}
              </div>
            )}
          </div>
        </div>
      </div>,
      document.body
    )
  }

  return null
}
