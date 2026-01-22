import { useEffect, useCallback, useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useUIStore } from '@/store/useUIStore'
import { Z_INDEX } from '@/constants'

export function DragGhost() {
  const { dragGhostCard, dragGhostPosition, setDragGhost } = useUIStore()
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const [isActive, setIsActive] = useState(false)
  const cleanupRef = useRef<(() => void) | null>(null)

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

  if (!dragGhostCard || !isActive || !position) return null

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
