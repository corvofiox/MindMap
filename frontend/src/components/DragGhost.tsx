import { useEffect, useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { useUIStore } from '@/store/useUIStore'
import { Z_INDEX } from '@/constants'
import { stripHTML } from '@/utils/sanitizeHTML'
import { describeGhostContent } from '@/features/drag-sort/ghostContent'
import type { Node, NodeCard } from '@/types'

/** 从卡片里取出影子需要的那几个字段（卡片 content 是节点的 JSON 快照）。 */
function ghostFromCard(card: NodeCard) {
  let data: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(card.content) as unknown
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>
  } catch {
    // 不是 JSON：整串当正文
    return describeGhostContent({
      content: card.content,
      cover: card.thumbnail,
    })
  }

  const asString = (value: unknown) => (typeof value === 'string' ? value : null)
  return describeGhostContent({
    content: asString(data.content),
    cover: asString(data.cover) ?? card.thumbnail,
    imageUrl: asString(data.imageUrl),
  })
}

/** 从画布节点取出影子的内容（节点已经是统一形态）。 */
function ghostFromNode(node: Node) {
  return describeGhostContent({
    content: node.content,
    cover: node.cover,
    imageUrl: node.imageUrl,
  })
}

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
    let nodeData: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(draggingCardFromPoolLocal.content) as unknown
      if (parsed && typeof parsed === 'object') nodeData = parsed as Record<string, unknown>
    } catch {
      nodeData = {}
    }
    const ghost = ghostFromCard(draggingCardFromPoolLocal)
    const nodeWidth = 160
    const nodeHeight = ghost.isImageOnly ? 100 : 80
    const nodeColor = (typeof nodeData.color === 'string' ? nodeData.color : null)
      || draggingCardFromPoolLocal.color
      || '#ffffff'
    const fontSize = typeof nodeData.fontSize === 'number' ? nodeData.fontSize : 14

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
              {stripHTML(draggingCardFromPoolLocal.name || '未知节点')}
            </div>
          </div>

          <div className="flex-1 overflow-hidden p-2">
            {ghost.isImageOnly ? (
              <div className="w-full h-full flex items-center justify-center bg-gray-50 dark:bg-gray-800/50 rounded">
                <img
                  src={ghost.imageSrc ?? undefined}
                  alt={draggingCardFromPoolLocal.name}
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
                {ghost.text}
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
    let nodeData: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(draggingCardFromPool.content) as unknown
      if (parsed && typeof parsed === 'object') nodeData = parsed as Record<string, unknown>
    } catch {
      nodeData = {}
    }
    const ghost = ghostFromCard(draggingCardFromPool)
    const widthValue = typeof nodeData.width === 'number' ? nodeData.width : 200
    const heightValue = typeof nodeData.height === 'number' ? nodeData.height : null
    const nodeWidth = widthValue
    const nodeHeight = heightValue ?? (ghost.isImageOnly ? nodeWidth * 0.75 : 120)
    const nodeColor = (typeof nodeData.color === 'string' ? nodeData.color : null)
      || draggingCardFromPool.color
      || '#ffffff'
    const fontSize = typeof nodeData.fontSize === 'number' ? nodeData.fontSize : 14

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
              {stripHTML(draggingCardFromPool.name || '未命名节点')}
            </div>
          </div>

          <div className="flex-1 overflow-hidden">
            {ghost.isImageOnly ? (
              <div className="w-full h-full flex items-center justify-center bg-gray-50 dark:bg-gray-800/50">
                <img
                  src={ghost.imageSrc ?? undefined}
                  alt={draggingCardFromPool.name}
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
                {ghost.text || '双击添加内容'}
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
    const ghost = ghostFromNode(node)
    const nodeWidth = 160
    const nodeHeight = ghost.isImageOnly ? 100 : 80
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
            {ghost.isImageOnly ? (
              <div className="w-full h-full flex items-center justify-center bg-gray-50 dark:bg-gray-800/50 rounded">
                <img
                  src={ghost.imageSrc ?? undefined}
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
                {ghost.text}
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
