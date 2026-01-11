import { useEffect, useRef, useState } from 'react'
import type { Node, NodeGroup, Domain } from '@/types'

interface CanvasMinimapProps {
  nodes: Map<string, Node>
  groups: Map<string, NodeGroup>
  domains: Map<string, Domain>
  zoom: number
  panX: number
  panY: number
  containerWidth: number
  containerHeight: number
  nodePoolOpen: boolean
  secondaryToolbarOpen: boolean
  onViewportChange: (panX: number, panY: number) => void
}

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export function CanvasMinimap({
  nodes,
  groups,
  domains,
  zoom,
  panX,
  panY,
  containerWidth,
  containerHeight,
  nodePoolOpen,
  secondaryToolbarOpen,
  onViewportChange,
}: CanvasMinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [contentBounds, setContentBounds] = useState<Bounds>({ x: -500, y: -500, width: 1000, height: 1000 })
  const [minimapSize, setMinimapSize] = useState({ width: 200, height: 150 })
  const [scale, setScale] = useState(0.2)

  // Calculate content bounds based on all elements
  useEffect(() => {
    const allElements = [
      ...Array.from(nodes.values()),
      ...Array.from(groups.values()),
      ...Array.from(domains.values()),
    ]

    // Define minimum bounds for better visual when nodes are tightly distributed
    const MIN_BOUNDS_WIDTH = 3000
    const MIN_BOUNDS_HEIGHT = 3000

    if (allElements.length === 0) {
      setContentBounds({ x: -MIN_BOUNDS_WIDTH / 2, y: -MIN_BOUNDS_HEIGHT / 2, width: MIN_BOUNDS_WIDTH, height: MIN_BOUNDS_HEIGHT })
      return
    }

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity

    allElements.forEach((el) => {
      const right = el.x + (el.width || 0)
      const bottom = el.y + (el.height || 0)
      minX = Math.min(minX, el.x)
      minY = Math.min(minY, el.y)
      maxX = Math.max(maxX, right)
      maxY = Math.max(maxY, bottom)
    })

    // Add padding
    const padding = 100
    const actualWidth = maxX - minX + padding * 2
    const actualHeight = maxY - minY + padding * 2
    const actualX = minX - padding
    const actualY = minY - padding

    // Use minimum bounds if actual bounds are smaller
    const bounds: Bounds = {
      x: actualX,
      y: actualY,
      width: Math.max(actualWidth, MIN_BOUNDS_WIDTH),
      height: Math.max(actualHeight, MIN_BOUNDS_HEIGHT),
    }

    // Center the bounds if using minimum bounds
    if (actualWidth < MIN_BOUNDS_WIDTH) {
      bounds.x = actualX + (actualWidth - MIN_BOUNDS_WIDTH) / 2
    }
    if (actualHeight < MIN_BOUNDS_HEIGHT) {
      bounds.y = actualY + (actualHeight - MIN_BOUNDS_HEIGHT) / 2
    }

    setContentBounds(bounds)

    // Calculate minimap size to maintain aspect ratio
    const maxMinimapWidth = 220
    const maxMinimapHeight = 165
    const aspectRatio = bounds.width / bounds.height

    let width = maxMinimapWidth
    let height = maxMinimapWidth / aspectRatio

    if (height > maxMinimapHeight) {
      height = maxMinimapHeight
      width = maxMinimapHeight * aspectRatio
    }

    setMinimapSize({ width, height })
  }, [nodes, groups, domains])

  // Draw minimap
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Calculate scale to fit content bounds in minimap
    const scaleX = minimapSize.width / contentBounds.width
    const scaleY = minimapSize.height / contentBounds.height
    const newScale = Math.min(scaleX, scaleY)
    setScale(newScale)

    // Calculate center offset to center content in minimap
    // Use newScale for both to maintain aspect ratio
    const offsetX = (minimapSize.width - contentBounds.width * newScale) / 2
    const offsetY = (minimapSize.height - contentBounds.height * newScale) / 2

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // Draw background
    ctx.fillStyle = '#f3f4f6'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    // Save context for translation
    ctx.save()

    // Draw domains
    ctx.fillStyle = 'rgba(156, 163, 175, 0.3)'
    ctx.strokeStyle = '#9ca3af'
    ctx.lineWidth = 1
    Array.from(domains.values()).forEach((domain) => {
      const x = (domain.x - contentBounds.x) * newScale + offsetX
      const y = (domain.y - contentBounds.y) * newScale + offsetY
      const w = domain.width * newScale
      const h = domain.height * newScale
      ctx.fillRect(x, y, w, h)
      ctx.strokeRect(x, y, w, h)
    })

    // Draw groups
    ctx.fillStyle = 'rgba(59, 130, 246, 0.2)'
    ctx.strokeStyle = '#3b82f6'
    ctx.lineWidth = 1
    Array.from(groups.values()).forEach((group) => {
      const x = (group.x - contentBounds.x) * newScale + offsetX
      const y = (group.y - contentBounds.y) * newScale + offsetY
      const w = group.width * newScale
      const h = group.height * newScale
      ctx.fillRect(x, y, w, h)
      ctx.strokeRect(x, y, w, h)
    })

    // Draw nodes
    ctx.fillStyle = '#ffffff'
    ctx.strokeStyle = '#374151'
    ctx.lineWidth = 0.5
    const nodePositions = Array.from(nodes.values()).map((node) => {
      const x = (node.x - contentBounds.x) * newScale + offsetX
      const y = (node.y - contentBounds.y) * newScale + offsetY
      const w = Math.max(node.width * newScale, 3)
      const h = Math.max(node.height * newScale, 2)
      ctx.fillRect(x, y, w, h)
      ctx.strokeRect(x, y, w, h)
      return { id: node.id, canvasX: node.x, canvasY: node.y, minimapX: x, minimapY: y }
    })

    // Restore context
    ctx.restore()

    // Calculate viewport rectangle
    // The canvas uses transform: translate(panX, panY) scale(zoom) with transform-origin: 0 0
    // For screen coordinates (screenX, screenY) and canvas coordinates (canvasX, canvasY):
    //   screenX = canvasX * zoom + panX
    //   screenY = canvasY * zoom + panY
    // Reverse: canvasX = (screenX - panX) / zoom
    const viewportLeft = (0 - panX) / zoom
    const viewportTop = (0 - panY) / zoom
    const viewportRight = (containerWidth - panX) / zoom
    const viewportBottom = (containerHeight - panY) / zoom

    // Convert to minimap coordinates (relative to minimap origin)
    // Use newScale to match node scaling
    const vpX = (viewportLeft - contentBounds.x) * newScale + offsetX
    const vpY = (viewportTop - contentBounds.y) * newScale + offsetY
    const vpW = (viewportRight - viewportLeft) * newScale
    const vpH = (viewportBottom - viewportTop) * newScale

    // Draw viewport rectangle (on top of content)
    ctx.strokeStyle = '#3b82f6'
    ctx.lineWidth = 2
    ctx.strokeRect(vpX, vpY, vpW, vpH)

    // Draw viewport semi-transparent fill
    ctx.fillStyle = 'rgba(59, 130, 246, 0.15)'
    ctx.fillRect(vpX, vpY, vpW, vpH)
  }, [nodes, groups, domains, contentBounds, minimapSize, scale, panX, panY, zoom, containerWidth, containerHeight])

  // Handle mouse events for dragging viewport
  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true)
    setDragStart({ x: e.clientX, y: e.clientY })
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return

    const dx = e.clientX - dragStart.x
    const dy = e.clientY - dragStart.y

    // Convert minimap pixel delta to canvas pan delta
    // dx is in minimap pixels, scale is the minimap scale factor
    // To convert to canvas coordinates: dx / scale
    // Then apply zoom to get screen coordinates: (dx / scale) * zoom
    const newPanX = panX - (dx / scale) * zoom
    const newPanY = panY - (dy / scale) * zoom

    onViewportChange(newPanX, newPanY)

    setDragStart({ x: e.clientX, y: e.clientY })
  }

  const handleMouseUp = () => {
    setIsDragging(false)
  }

  const handleMouseLeave = () => {
    setIsDragging(false)
  }

  // Click to jump to position
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation() // Prevent event from bubbling to canvas container

    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left - 4 // Subtract margin
    const y = e.clientY - rect.top - 4

    // Recalculate scale and offset (same as in draw)
    const scaleX = minimapSize.width / contentBounds.width
    const scaleY = minimapSize.height / contentBounds.height
    const newScale = Math.min(scaleX, scaleY)
    const offsetX = (minimapSize.width - contentBounds.width * newScale) / 2
    const offsetY = (minimapSize.height - contentBounds.height * newScale) / 2

    // Convert minimap position to canvas position
    const canvasX = (x - offsetX) / newScale + contentBounds.x
    const canvasY = (y - offsetY) / newScale + contentBounds.y

    // Center the viewport on the clicked position
    const newPanX = -canvasX * zoom + containerWidth / 2
    const newPanY = -canvasY * zoom + containerHeight / 2

    onViewportChange(newPanX, newPanY)
  }

  return (
    <div
      className="minimap bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 overflow-hidden transition-all duration-200"
      style={{
        position: 'absolute',
        top: secondaryToolbarOpen ? '64px' : '16px',
        left: 'auto',
        right: '16px',
        width: `${minimapSize.width + 8}px`,
        height: `${minimapSize.height + 8}px`,
        zIndex: 50,
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <canvas
        ref={canvasRef}
        width={minimapSize.width}
        height={minimapSize.height}
        className="cursor-crosshair"
        style={{
          margin: 4,
          display: 'block',
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
      />
    </div>
  )
}
