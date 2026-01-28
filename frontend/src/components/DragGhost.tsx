import { useEffect, useCallback, useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useUIStore } from '@/store/useUIStore'
import { Z_INDEX } from '@/constants'
import type { Node, NodeCard } from '@/types'

export function DragGhost() {
  const { dragGhostCard, dragGhostPosition, setDragGhost, draggingNodeFromCanvas, canvasDragGhostPosition, isOverNodePool, draggingCardFromPool, isOverCanvas, poolDragGhostPosition } = useUIStore()
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const [isActive, setIsActive] = useState(false)
  const cleanupRef = useRef<(() => void) | null>(null)
  const [draggingCardFromPoolLocal, setDraggingCardFromPoolLocal] = useState<NodeCard | null>(null)
  const [draggingCardPoolPosition, setDraggingCardPoolPosition] = useState<{ x: number; y: number } | null>(null)

  const cleanup = useCallback(() => {
    setIsActive(false)
    setPosition(null)
    setDragGhost(null, null)
    if (cleanupRef.current) {
      cleanupRef.current()
      cleanupRef.current = null
    }
  }, [setDragGhost])

  const handleMouseMove = useCallback((e: MouseEvent) => {
    setPosition({ x: e.clientX, y: e.clientY })
  }, [])

  const handleClick = useCallback((e: MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()

    if (!dragGhostCard) {
      cleanup()
      return
    }

    const canvasContainer = document.querySelector('[data-canvas-container]') as HTMLElement
    if (canvasContainer) {
      const rect = canvasContainer.getBoundingClientRect()
      if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
        const customEvent = new CustomEvent('canvasDrop', {
          detail: {
            card: dragGhostCard,
            clientX: e.clientX,
            clientY: e.clientY,
          },
        })
        document.dispatchEvent(customEvent)
        cleanup()
      } else {
        cleanup()
      }
    } else {
      cleanup()
    }
  }, [dragGhostCard, cleanup])

  const handleContextMenu = useCallback((e: MouseEvent) => {
    e.preventDefault()
    cleanup()
  }, [cleanup])

  const handleEscape = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      cleanup()
    }
  }, [cleanup])

  useEffect(() => {
    if (!dragGhostCard || !dragGhostPosition) {
      cleanup()
      return
    }

    setIsActive(true)
    setPosition({ x: dragGhostPosition.x, y: dragGhostPosition.y })

    const onMouseMove = handleMouseMove
    const onClick = handleClick
    const onContextMenu = handleContextMenu
    const onKeyDown = handleEscape

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('click', onClick, { capture: true })
    document.addEventListener('contextmenu', onContextMenu, { capture: true })
    document.addEventListener('keydown', onKeyDown)

    cleanupRef.current = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('click', onClick, { capture: true })
      document.removeEventListener('contextmenu', onContextMenu, { capture: true })
      document.removeEventListener('keydown', onKeyDown)
    }

    return () => {
      cleanup()
    }
  }, [dragGhostCard, dragGhostPosition, handleMouseMove, handleClick, handleContextMenu, handleEscape, cleanup])

  // 监听从节点池拖拽的事件
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
      setDraggingCardFromPoolLocal(null)
      setDraggingCardPoolPosition(null)
    }

    document.addEventListener('nodePoolDragStart', handleNodePoolDragStart)
    document.addEventListener('mousemove', handleNodePoolDragMove)
    document.addEventListener('nodePoolDragEnd', handleNodePoolDragEnd)

    return () => {
      document.removeEventListener('nodePoolDragStart', handleNodePoolDragStart)
      document.removeEventListener('mousemove', handleNodePoolDragMove)
      document.removeEventListener('nodePoolDragEnd', handleNodePoolDragEnd)
    }
  }, [draggingCardFromPoolLocal])

  // 处理从节点池拖拽但尚未进入画布时的幽灵效果（节点池内样式 - 与从画布拖拽到节点池的样式一致）
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
    const nodeWidth = 160 // 节点池卡片宽度 - 与从画布拖拽到节点池的样式一致
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
              {nodeData.title || draggingCardFromPoolLocal.name || '未命名节点'}
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
                {nodeData.content || ''}
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
              {nodeData.title || draggingCardFromPool.name || '图片节点'}
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
                {nodeData.content || draggingCardFromPool.description || (
                  <span style={{ color: '#9ca3af' }}>双击添加内容</span>
                )}
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
    const nodeWidth = 160 // 节点池卡片宽度
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
              {node.title || '未命名节点'}
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
                {node.content || ''}
              </div>
            )}
          </div>
        </div>
      </div>,
      document.body
    )
  }

  // 当从节点池拖拽进入画布区域时，不显示原有的节点池样式幽灵
  if (!dragGhostCard || !isActive || !position || (draggingCardFromPool && isOverCanvas)) return null

  let nodeData
  try {
    nodeData = JSON.parse(dragGhostCard.content)
  } catch {
    nodeData = {
      type: 'text',
      title: dragGhostCard.name || '未知节点',
      content: dragGhostCard.content || '',
      imageUrl: null,
      width: 200,
      height: 120,
      color: '#ffffff',
      fontSize: 14,
    }
  }

  const displayPosition = position
  const isImageNode = nodeData.type === 'image' && nodeData.imageUrl
  const nodeWidth = nodeData.width || 200
  const nodeHeight = nodeData.height || (isImageNode ? nodeWidth * 0.75 : 120)
  const nodeColor = nodeData.color || '#ffffff'
  const fontSize = nodeData.fontSize || 14

  return createPortal(
    <>
      <div
        className="fixed pointer-events-none"
        style={{
          left: displayPosition.x,
          top: displayPosition.y,
          transform: 'translate(-50%, -50%)',
          zIndex: Z_INDEX.DRAG_GHOST,
        }}
      >
        <div
          className="rounded-xl shadow-xl border border-gray-200 overflow-hidden"
          style={{
            width: nodeWidth,
            height: nodeHeight,
            backgroundColor: nodeColor,
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
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
              {nodeData.title || dragGhostCard.name || '图片节点'}
            </div>
          </div>

          <div className="flex-1 overflow-hidden">
            {isImageNode ? (
              <div className="w-full h-full flex items-center justify-center bg-gray-50 dark:bg-gray-800/50">
                {nodeData.imageUrl ? (
                  <img
                    src={nodeData.imageUrl}
                    alt={nodeData.title}
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <div className="flex items-center justify-center text-gray-400">
                    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                  </div>
                )}
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
                {nodeData.content || dragGhostCard.description || (
                  <span style={{ color: '#9ca3af' }}>双击添加内容</span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <div
        className="fixed inset-0 bg-blue-500/3 pointer-events-none"
        style={{ cursor: 'crosshair', zIndex: Z_INDEX.DRAG_GHOST - 1 }}
      />
    </>,
    document.body
  )
}
