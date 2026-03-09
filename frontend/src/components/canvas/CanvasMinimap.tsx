import { useEffect, useRef, useState, useCallback } from 'react'
import { Z_INDEX } from '@/constants'
import type { Node, NodeGroup, Domain, Connection } from '@/types'

interface CanvasMinimapProps {
  nodes: Map<string, Node>
  groups: Map<string, NodeGroup>
  domains: Map<string, Domain>
  connections: Map<string, Connection>
  zoom: number
  panX: number
  panY: number
  containerWidth: number
  containerHeight: number
  nodePoolOpen: boolean
  aiSidebarOpen: boolean
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
  connections,
  zoom,
  panX,
  panY,
  containerWidth,
  containerHeight,
  nodePoolOpen,
  aiSidebarOpen,
  secondaryToolbarOpen,
  onViewportChange,
}: CanvasMinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [contentBounds, setContentBounds] = useState<Bounds>({ x: -500, y: -500, width: 1000, height: 1000 })
  const [minimapSize, setMinimapSize] = useState({ width: 200, height: 150 })
  const scaleRef = useRef(0.2)

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
      const bounds = { x: -MIN_BOUNDS_WIDTH / 2, y: -MIN_BOUNDS_HEIGHT / 2, width: MIN_BOUNDS_WIDTH, height: MIN_BOUNDS_HEIGHT }
      setContentBounds(bounds)

      // 空画布时也计算 minimapSize
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

  // Helper function to get node center point
  const getNodeCenter = useCallback((node: Node): { x: number; y: number } => {
    return {
      x: node.x + node.width / 2,
      y: node.y + node.height / 2,
    }
  }, [])

  // Helper function to get port position
  const getPortPosition = useCallback((node: Node, port: 'top' | 'right' | 'bottom' | 'left'): { x: number; y: number } => {
    const center = getNodeCenter(node)

    switch (port) {
      case 'top':
        return { x: center.x, y: node.y }
      case 'right':
        return { x: node.x + node.width, y: center.y }
      case 'bottom':
        return { x: center.x, y: node.y + node.height }
      case 'left':
        return { x: node.x, y: center.y }
      default:
        return center
    }
  }, [getNodeCenter])

  // Helper function to draw a connection path
  const drawConnection = useCallback((
    ctx: CanvasRenderingContext2D,
    connection: Connection,
    fromNode: Node,
    toNode: Node,
    scale: number,
    offsetX: number,
    offsetY: number
  ) => {
    const fromPos = getPortPosition(fromNode, connection.fromPort)
    const toPos = getPortPosition(toNode, connection.toPort)

    const x1 = (fromPos.x - contentBounds.x) * scale + offsetX
    const y1 = (fromPos.y - contentBounds.y) * scale + offsetY
    const x2 = (toPos.x - contentBounds.x) * scale + offsetX
    const y2 = (toPos.y - contentBounds.y) * scale + offsetY

    // Set line style
    ctx.strokeStyle = connection.color || '#6b7280'
    ctx.lineWidth = Math.max(connection.width * scale, 1)

    // Set dash pattern
    if (connection.style === 'dashed') {
      ctx.setLineDash([5 * scale, 3 * scale])
    } else if (connection.style === 'dotted') {
      ctx.setLineDash([2 * scale, 2 * scale])
    } else {
      ctx.setLineDash([])
    }

    ctx.beginPath()

    // Handle bend points
    if (connection.bendPoints && connection.bendPoints.length > 0) {
      ctx.moveTo(x1, y1)
      connection.bendPoints.forEach((point) => {
        const bx = (point.x - contentBounds.x) * scale + offsetX
        const by = (point.y - contentBounds.y) * scale + offsetY
        ctx.lineTo(bx, by)
      })
      ctx.lineTo(x2, y2)
    } else {
      // Draw based on connection type
      switch (connection.type) {
        case 'curve': {
          const midX = (x1 + x2) / 2
          ctx.moveTo(x1, y1)
          ctx.bezierCurveTo(midX, y1, midX, y2, x2, y2)
          break
        }
        case 'step': {
          const midY = (y1 + y2) / 2
          ctx.moveTo(x1, y1)
          ctx.lineTo(x1, midY)
          ctx.lineTo(x2, midY)
          ctx.lineTo(x2, y2)
          break
        }
        case 'straight':
        default:
          ctx.moveTo(x1, y1)
          ctx.lineTo(x2, y2)
          break
      }
    }

    ctx.stroke()
    ctx.setLineDash([])

    // Draw arrowheads based on arrowType
    if (connection.arrowType !== 'none') {
      const arrowSize = 6 * scale
      const drawArrow = (x: number, y: number, angle: number) => {
        ctx.save()
        ctx.translate(x, y)
        ctx.rotate(angle)
        ctx.beginPath()
        ctx.moveTo(-arrowSize, -arrowSize / 2)
        ctx.lineTo(0, 0)
        ctx.lineTo(-arrowSize, arrowSize / 2)
        ctx.stroke()
        ctx.restore()
      }

      // Calculate angle for end arrow
      let endAngle = Math.atan2(y2 - y1, x2 - x1)
      if (connection.bendPoints && connection.bendPoints.length > 0) {
        const lastPoint = connection.bendPoints[connection.bendPoints.length - 1]
        const lastX = (lastPoint.x - contentBounds.x) * scale + offsetX
        const lastY = (lastPoint.y - contentBounds.y) * scale + offsetY
        endAngle = Math.atan2(y2 - lastY, x2 - lastX)
      }

      // Draw end arrow
      if (connection.arrowType === 'end' || connection.arrowType === 'both') {
        drawArrow(x2, y2, endAngle)
      }
      // Draw start arrow
      if (connection.arrowType === 'start' || connection.arrowType === 'both') {
        drawArrow(x1, y1, endAngle + Math.PI)
      }
    }
  }, [contentBounds, getPortPosition])

  // Draw minimap
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Set Canvas dimensions
    const targetWidth = Math.max(1, Math.floor(minimapSize.width))
    const targetHeight = Math.max(1, Math.floor(minimapSize.height))

    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth
      canvas.height = targetHeight
    }

    // Calculate scale to fit content bounds in minimap
    const scaleX = targetWidth / contentBounds.width
    const scaleY = targetHeight / contentBounds.height
    const newScale = Math.min(scaleX, scaleY)

    scaleRef.current = newScale

    // Calculate center offset to center content in minimap
    const offsetX = (targetWidth - contentBounds.width * newScale) / 2
    const offsetY = (targetHeight - contentBounds.height * newScale) / 2

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

    // Draw connections first (so they appear behind nodes)
    Array.from(connections.values()).forEach((connection) => {
      const fromNode = nodes.get(connection.fromNodeId)
      const toNode = nodes.get(connection.toNodeId)
      if (fromNode && toNode) {
        drawConnection(ctx, connection, fromNode, toNode, newScale, offsetX, offsetY)
      }
    })

    // Draw nodes with color support
    Array.from(nodes.values()).forEach((node) => {
      const x = (node.x - contentBounds.x) * newScale + offsetX
      const y = (node.y - contentBounds.y) * newScale + offsetY
      const w = Math.max(node.width * newScale, 4)
      const h = Math.max(node.height * newScale, 3)

      // Use node color if available, otherwise default to white
      ctx.fillStyle = node.color || '#ffffff'
      ctx.fillRect(x, y, w, h)

      // Draw border - darker version of fill color or default gray
      if (node.collapsed) {
        ctx.strokeStyle = '#1f2937'
        ctx.lineWidth = 1.5
      } else {
        ctx.strokeStyle = '#374151'
        ctx.lineWidth = 0.5
      }
      ctx.strokeRect(x, y, w, h)

      // Draw small indicator for collapsed nodes
      if (node.collapsed) {
        ctx.fillStyle = '#1f2937'
        ctx.fillRect(x + 2, y + 2, Math.max(w - 4, 2), 2)
      }
    })

    // Restore context
    ctx.restore()

    // Skip drawing viewport if container dimensions are invalid
    // This ensures we don't draw with incorrect fallback values
    if (containerWidth <= 0 || containerHeight <= 0) {
      return
    }

    // 计算右侧侧边栏占用的宽度（以像素为单位）
    const sidebarWidth = aiSidebarOpen ? 320 : nodePoolOpen ? 288 : 0
    // 将侧边栏宽度转换为画布坐标系的宽度
    const sidebarCanvasWidth = sidebarWidth / zoom

    // Calculate viewport rectangle using actual container dimensions
    // 考虑右侧侧边栏占用的可视区域
    const viewportLeft = (0 - panX) / zoom
    const viewportTop = (0 - panY) / zoom
    const viewportRight = (containerWidth - panX) / zoom - sidebarCanvasWidth
    const viewportBottom = (containerHeight - panY) / zoom

    const viewportRectWidth = viewportRight - viewportLeft
    const viewportRectHeight = viewportBottom - viewportTop

    // Skip drawing if viewport dimensions are invalid (NaN, Infinity, negative, or zero)
    if (
      !isFinite(viewportRectWidth) ||
      !isFinite(viewportRectHeight) ||
      viewportRectWidth <= 0 ||
      viewportRectHeight <= 0
    ) {
      return
    }

    // Convert to minimap coordinates
    const vpX = (viewportLeft - contentBounds.x) * newScale + offsetX
    const vpY = (viewportTop - contentBounds.y) * newScale + offsetY
    const vpW = viewportRectWidth * newScale
    const vpH = viewportRectHeight * newScale

    // Draw viewport rectangle
    ctx.strokeStyle = '#3b82f6'
    ctx.lineWidth = 2
    ctx.strokeRect(vpX, vpY, vpW, vpH)

    // Draw viewport semi-transparent fill
    ctx.fillStyle = 'rgba(59, 130, 246, 0.15)'
    ctx.fillRect(vpX, vpY, vpW, vpH)
  }, [nodes, groups, domains, connections, contentBounds, minimapSize, panX, panY, zoom, containerWidth, containerHeight, nodePoolOpen, aiSidebarOpen, drawConnection])

  // Handle mouse events for dragging viewport
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
    setDragStart({ x: e.clientX, y: e.clientY })
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return
    e.preventDefault()
    e.stopPropagation()

    const dx = e.clientX - dragStart.x
    const dy = e.clientY - dragStart.y

    // Convert minimap pixel delta to canvas pan delta
    // The scale is minimap scale, zoom is canvas zoom
    // Minimap pixel -> Canvas pixel: dx / scale
    // Canvas pixel -> Screen pixel: (dx / scale) * zoom
    // Pan is in screen coordinates, so we need to negate the movement
    const newPanX = panX - (dx / scaleRef.current) * zoom
    const newPanY = panY - (dy / scaleRef.current) * zoom

    onViewportChange(newPanX, newPanY)

    setDragStart({ x: e.clientX, y: e.clientY })
  }

  const handleMouseUp = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }

  const handleMouseLeave = (e: React.MouseEvent) => {
    if (isDragging) {
      e.preventDefault()
      e.stopPropagation()
    }
    setIsDragging(false)
  }

  // Click to jump to position
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    // Don't trigger click if we were dragging
    if (isDragging) return

    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left - 4 // Subtract margin
    const y = e.clientY - rect.top - 4

    // Recalculate scale and offset
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

  // 计算右侧偏移量
  const getRightOffset = () => {
    if (aiSidebarOpen) return '20.5rem' // 320px + 16px margin
    if (nodePoolOpen) return '18.25rem' // 288px + 16px margin
    return '16px'
  }

  return (
    <div
      className="minimap bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 overflow-hidden transition-all duration-200"
      style={{
        position: 'absolute',
        top: secondaryToolbarOpen ? '64px' : '16px',
        left: 'auto',
        right: getRightOffset(),
        width: `${minimapSize.width + 8}px`,
        height: `${minimapSize.height + 8}px`,
        zIndex: Z_INDEX.ZOOM_CONTROLS,
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <canvas
        ref={canvasRef}
        width={Math.max(1, Math.floor(minimapSize.width))}
        height={Math.max(1, Math.floor(minimapSize.height))}
        className={`${isDragging ? 'cursor-grabbing' : 'cursor-crosshair'}`}
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
