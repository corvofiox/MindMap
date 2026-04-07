// Web Worker for thumbnail generation
// Completely offloads thumbnail rendering from the main thread

interface Node {
  id: string
  x: number
  y: number
  width: number
  height: number
  title: string
  content: string
  color?: string
  fontSize: number
  textAlign: 'left' | 'center' | 'right'
  collapsed: boolean
  type?: 'text' | 'image'
  imageUrl?: string
  aspectRatio?: number
}

interface Connection {
  id: string
  fromNodeId: string
  toNodeId: string
  type: 'straight' | 'curve' | 'step'
  color: string
  width: number
  style: 'solid' | 'dashed' | 'dotted'
  arrowType: 'none' | 'end' | 'start' | 'both'
  fromPort?: 'top' | 'right' | 'bottom' | 'left'
  toPort?: 'top' | 'right' | 'bottom' | 'left'
  bendPoints?: Array<{ x: number; y: number }>
}

interface NodeGroup {
  id: string
  name: string
  x: number
  y: number
  width: number
  height: number
  backgroundColor?: string
  borderColor?: string
  borderWidth?: number
  borderRadius?: number
}

interface Domain {
  id: string
  name: string
  x: number
  y: number
  width: number
  height: number
  backgroundColor?: string
  borderColor?: string
  borderWidth?: number
  titleVisible?: boolean
  titleScale?: number
}

interface ThumbnailRequest {
  type: 'generateThumbnail'
  id: string
  nodes: Node[]
  connections: Connection[]
  groups: NodeGroup[]
  domains: Domain[]
  targetWidth: number
  targetHeight: number
  quality: number
  backgroundColor: string
  padding: number
}

interface ThumbnailResponse {
  id: string
  type: 'thumbnailResult' | 'thumbnailError'
  data: string | null
  error?: string
}

// Calculate bounding box for all elements (only nodes and groups, not domains)
function calculateBoundingBox(
  nodes: Node[],
  groups: NodeGroup[]
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  // Only use nodes and groups for bounding box calculation
  // Domains are background elements and should not affect the scale
  const allElements = [
    ...nodes.map(n => ({ x: n.x, y: n.y, width: n.width, height: n.height })),
    ...groups.map(g => ({ x: g.x, y: g.y, width: g.width, height: g.height })),
  ]

  if (allElements.length === 0) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  allElements.forEach(el => {
    minX = Math.min(minX, el.x)
    minY = Math.min(minY, el.y)
    maxX = Math.max(maxX, el.x + el.width)
    maxY = Math.max(maxY, el.y + el.height)
  })

  return { minX, minY, maxX, maxY }
}

// Get port position for a node
function getPortPosition(
  node: Node,
  port: 'top' | 'right' | 'bottom' | 'left'
): { x: number; y: number } {
  switch (port) {
    case 'top':
      return { x: node.x + node.width / 2, y: node.y }
    case 'right':
      return { x: node.x + node.width, y: node.y + node.height / 2 }
    case 'bottom':
      return { x: node.x + node.width / 2, y: node.y + node.height }
    case 'left':
      return { x: node.x, y: node.y + node.height / 2 }
    default:
      return { x: node.x + node.width / 2, y: node.y + node.height / 2 }
  }
}

// Calculate curve control points
function calculateCurveControlPoints(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  fromPort: string,
  toPort: string
): { cp1x: number; cp1y: number; cp2x: number; cp2y: number } {
  const dx = Math.abs(toX - fromX)
  const dy = Math.abs(toY - fromY)
  const dist = Math.sqrt(dx * dx + dy * dy)

  // Adjust control point offset based on distance and port directions
  const offset = Math.min(dist * 0.5, 100)

  let cp1x = fromX
  let cp1y = fromY
  let cp2x = toX
  let cp2y = toY

  // Adjust control points based on port direction
  if (fromPort === 'right') {
    cp1x = fromX + offset
  } else if (fromPort === 'left') {
    cp1x = fromX - offset
  } else if (fromPort === 'bottom') {
    cp1y = fromY + offset
  } else if (fromPort === 'top') {
    cp1y = fromY - offset
  }

  if (toPort === 'right') {
    cp2x = toX + offset
  } else if (toPort === 'left') {
    cp2x = toX - offset
  } else if (toPort === 'bottom') {
    cp2y = toY + offset
  } else if (toPort === 'top') {
    cp2y = toY - offset
  }

  return { cp1x, cp1y, cp2x, cp2y }
}

// Get step path points
function getStepPath(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  bendPoints: Array<{ x: number; y: number }>,
  fromPort: string,
  toPort: string
): Array<{ x: number; y: number }> {
  if (bendPoints.length > 0) {
    return [{ x: fromX, y: fromY }, ...bendPoints, { x: toX, y: toY }]
  }

  const points: Array<{ x: number; y: number }> = [{ x: fromX, y: fromY }]

  // Calculate intermediate points for step connection
  const midX = (fromX + toX) / 2

  if (fromPort === 'right' || fromPort === 'left') {
    points.push({ x: midX, y: fromY })
    points.push({ x: midX, y: toY })
  } else {
    const midY = (fromY + toY) / 2
    points.push({ x: fromX, y: midY })
    points.push({ x: toX, y: midY })
  }

  points.push({ x: toX, y: toY })
  return points
}

// Convert points to SVG path data
function pointsToPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return ''
  return points.map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`)).join(' ')
}

// Get connection port direction
function getConnectionPort(conn: Connection, end: 'start' | 'end'): 'top' | 'right' | 'bottom' | 'left' {
  if (end === 'start') {
    return conn.fromPort || 'right'
  } else {
    return conn.toPort || 'left'
  }
}

// Draw rounded rectangle
function drawRoundedRect(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + width - radius, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius)
  ctx.lineTo(x + width, y + height - radius)
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height)
  ctx.lineTo(x + radius, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius)
  ctx.lineTo(x, y + radius)
  ctx.quadraticCurveTo(x, y, x + radius, y)
  ctx.closePath()
}

// Draw arrow head
function drawArrowHead(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  length: number,
  color: string
) {
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(
    x - length * Math.cos(angle - Math.PI / 6),
    y - length * Math.sin(angle - Math.PI / 6)
  )
  ctx.lineTo(
    x - length * Math.cos(angle + Math.PI / 6),
    y - length * Math.sin(angle + Math.PI / 6)
  )
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
}

// Generate thumbnail
async function generateThumbnail(
  request: ThumbnailRequest
): Promise<string | null> {
  const {
    nodes,
    connections,
    groups,
    domains,
    targetWidth,
    targetHeight,
    quality,
    backgroundColor,
    padding,
  } = request

  const bounds = calculateBoundingBox(nodes, groups)
  if (!bounds) {
    const canvas = new OffscreenCanvas(targetWidth, targetHeight)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    ctx.fillStyle = backgroundColor
    ctx.fillRect(0, 0, targetWidth, targetHeight)

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
    const reader = new FileReader()
    const dataUrl = await new Promise<string>((resolve, reject) => {
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
    return dataUrl
  }

  const { minX, minY, maxX, maxY } = bounds
  const contentWidth = maxX - minX + padding * 2
  const contentHeight = maxY - minY + padding * 2

  // Create main canvas
  const canvas = new OffscreenCanvas(targetWidth, targetHeight)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  // Fill background
  ctx.fillStyle = backgroundColor
  ctx.fillRect(0, 0, targetWidth, targetHeight)

  // Calculate scale to fit content
  const scale = Math.min(
    (targetWidth - padding * 2) / contentWidth,
    (targetHeight - padding * 2) / contentHeight
  ) * 0.95

  const offsetX = (targetWidth - contentWidth * scale) / 2
  const offsetY = (targetHeight - contentHeight * scale) / 2

  ctx.save()
  ctx.translate(offsetX, offsetY)
  ctx.scale(scale, scale)

  domains.forEach(domain => {
    const x = domain.x - minX + padding
    const y = domain.y - minY + padding

    // Draw domain background
    ctx.fillStyle = domain.backgroundColor || 'rgba(59, 130, 246, 0.05)'
    ctx.fillRect(x, y, domain.width, domain.height)

    // Draw domain border
    ctx.strokeStyle = domain.borderColor || '#3b82f6'
    ctx.lineWidth = domain.borderWidth || 2
    ctx.strokeRect(x, y, domain.width, domain.height)

    // Draw domain title
    if (domain.titleVisible !== false && domain.name) {
      const fontSize = Math.max(domain.width, domain.height) * (domain.titleScale || 0.08)
      ctx.font = `bold ${fontSize}px sans-serif`
      ctx.fillStyle = 'rgba(30, 41, 59, 0.3)'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(domain.name, x + domain.width / 2, y + 20)
    }
  })

  groups.forEach(group => {
    const x = group.x - minX + padding
    const y = group.y - minY + padding
    const radius = group.borderRadius || 8

    // Draw group background
    ctx.fillStyle = group.backgroundColor || 'rgba(59, 130, 246, 0.1)'
    drawRoundedRect(ctx, x, y, group.width, group.height, radius)
    ctx.fill()

    // Draw group border
    ctx.strokeStyle = group.borderColor || '#3b82f6'
    ctx.lineWidth = group.borderWidth || 2
    drawRoundedRect(ctx, x, y, group.width, group.height, radius)
    ctx.stroke()

    // Draw group name with higher contrast
    ctx.font = 'bold 14px sans-serif'
    ctx.fillStyle = '#000000'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText(group.name, x + 8, y - 20)
  })

  connections.forEach(conn => {
    const fromNode = nodes.find(n => n.id === conn.fromNodeId)
    const toNode = nodes.find(n => n.id === conn.toNodeId)
    if (!fromNode || !toNode) return

    // Get port directions
    const fromPort = getConnectionPort(conn, 'start')
    const toPort = getConnectionPort(conn, 'end')

    // Get port positions on the node edges
    const fromPos = getPortPosition(fromNode, fromPort)
    const toPos = getPortPosition(toNode, toPort)

    // Adjust positions for thumbnail
    const startX = fromPos.x - minX + padding
    const startY = fromPos.y - minY + padding
    const endX = toPos.x - minX + padding
    const endY = toPos.y - minY + padding

    // Set line style with higher contrast
    ctx.strokeStyle = conn.color || '#374151'  // Darker gray for better contrast
    ctx.lineWidth = Math.max(conn.width || 2, 3)  // Thicker lines
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    // Set dash pattern
    if (conn.style === 'dashed') {
      ctx.setLineDash([6, 4])
    } else if (conn.style === 'dotted') {
      ctx.setLineDash([3, 3])
    } else {
      ctx.setLineDash([])
    }

    // Prepare bend points
    const bendPoints = conn.bendPoints?.map(bp => ({
      x: bp.x - minX + padding,
      y: bp.y - minY + padding
    })) || []

    // Draw connection
    ctx.beginPath()

    let pathPoints: Array<{ x: number; y: number }> = []

    if (conn.type === 'straight') {
      if (bendPoints.length > 0) {
        pathPoints = [{ x: startX, y: startY }, ...bendPoints, { x: endX, y: endY }]
        ctx.moveTo(startX, startY)
        bendPoints.forEach(bp => ctx.lineTo(bp.x, bp.y))
        ctx.lineTo(endX, endY)
      } else {
        ctx.moveTo(startX, startY)
        ctx.lineTo(endX, endY)
        pathPoints = [{ x: startX, y: startY }, { x: endX, y: endY }]
      }
    } else if (conn.type === 'curve') {
      if (bendPoints.length > 0) {
        pathPoints = [{ x: startX, y: startY }, ...bendPoints, { x: endX, y: endY }]
        ctx.moveTo(startX, startY)
        // Use quadratic curves for bend points
        for (let i = 0; i < bendPoints.length; i++) {
          const bp = bendPoints[i]
          if (i === bendPoints.length - 1) {
            ctx.quadraticCurveTo(bp.x, bp.y, endX, endY)
          } else {
            ctx.lineTo(bp.x, bp.y)
          }
        }
      } else {
        // Use proper curve control points based on port directions
        const { cp1x, cp1y, cp2x, cp2y } = calculateCurveControlPoints(
          startX, startY, endX, endY, fromPort, toPort
        )
        ctx.moveTo(startX, startY)
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, endX, endY)
        pathPoints = [{ x: startX, y: startY }, { x: endX, y: endY }]
      }
    } else if (conn.type === 'step') {
      // Use proper step path based on port directions
      pathPoints = getStepPath(startX, startY, endX, endY, bendPoints, fromPort, toPort)
      ctx.moveTo(startX, startY)
      for (let i = 1; i < pathPoints.length; i++) {
        ctx.lineTo(pathPoints[i].x, pathPoints[i].y)
      }
    }

    ctx.stroke()

    // Draw arrows
    if (conn.arrowType !== 'none' && pathPoints.length >= 2) {
      if (conn.arrowType === 'end' || conn.arrowType === 'both') {
        const last = pathPoints[pathPoints.length - 1]
        const secondLast = pathPoints[pathPoints.length - 2]
        const angle = Math.atan2(last.y - secondLast.y, last.x - secondLast.x)
        drawArrowHead(ctx, last.x, last.y, angle, 10, conn.color || '#6b7280')
      }
      if (conn.arrowType === 'start' || conn.arrowType === 'both') {
        const first = pathPoints[0]
        const second = pathPoints[1]
        const angle = Math.atan2(first.y - second.y, first.x - second.x)
        drawArrowHead(ctx, first.x, first.y, angle, 10, conn.color || '#6b7280')
      }
    }
  })

  nodes.forEach(node => {
    const x = node.x - minX + padding
    const y = node.y - minY + padding

    // Draw node background
    ctx.fillStyle = node.color || '#ffffff'
    drawRoundedRect(ctx, x, y, node.width, node.height, 4)
    ctx.fill()

    // Draw node border with higher contrast
    ctx.strokeStyle = '#9ca3af'  // Darker gray for better contrast
    ctx.lineWidth = 2  // Thicker border
    drawRoundedRect(ctx, x, y, node.width, node.height, 4)
    ctx.stroke()

    // Draw node title
    if (node.title) {
      // Use larger font size for better readability in thumbnail
      const fontSize = Math.max(node.fontSize || 14, 16)
      ctx.font = `bold ${fontSize}px sans-serif`
      ctx.fillStyle = '#000000'  // Pure black for maximum contrast
      ctx.textAlign = node.textAlign || 'left'
      ctx.textBaseline = 'top'

      const textX = node.textAlign === 'center' ? x + node.width / 2 :
        node.textAlign === 'right' ? x + node.width - 8 :
          x + 8

      // Truncate title if too long
      const maxWidth = node.width - 16
      let displayTitle = node.title
      let titleWidth = ctx.measureText(displayTitle).width
      let titleIterations = 0
      const maxTitleIterations = 100 // Prevent infinite loop
      while (titleWidth > maxWidth && displayTitle.length > 3 && titleIterations < maxTitleIterations) {
        displayTitle = displayTitle.slice(0, -2) + '...'
        titleWidth = ctx.measureText(displayTitle).width
        titleIterations++
      }

      ctx.fillText(displayTitle, textX, y + 8, maxWidth)
    }

    // Draw node content (if not collapsed)
    if (!node.collapsed && node.content) {
      // Use larger font size for better readability
      const fontSize = Math.max(node.fontSize || 12, 14)
      ctx.font = `${fontSize}px sans-serif`
      ctx.fillStyle = '#374151'  // Darker gray for better contrast
      ctx.textAlign = node.textAlign || 'left'

      const textX = node.textAlign === 'center' ? x + node.width / 2 :
        node.textAlign === 'right' ? x + node.width - 8 :
          x + 8

      // Strip HTML tags and truncate
      const plainContent = node.content.replace(/<[^>]*>/g, '')
      const maxWidth = node.width - 16
      let displayContent = plainContent
      let contentWidth = ctx.measureText(displayContent).width
      let iterations = 0
      const maxIterations = 100 // Prevent infinite loop
      while (contentWidth > maxWidth && displayContent.length > 3 && iterations < maxIterations) {
        displayContent = displayContent.slice(0, -2) + '...'
        contentWidth = ctx.measureText(displayContent).width
        iterations++
      }

      ctx.fillText(displayContent, textX, y + 28, maxWidth)
    }
  })

  ctx.restore()

  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })

  try {
    const reader = new FileReader()
    const dataUrl = await new Promise<string>((resolve, reject) => {
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(new Error('FileReader error'))
      reader.readAsDataURL(blob)
    })
    return dataUrl
  } catch (error) {
    console.error('[Worker] Failed to convert blob to data URL:', error)
    return null
  }
}

// Worker message handler
self.onmessage = async (event: MessageEvent<ThumbnailRequest>) => {
  const request = event.data

  try {
    switch (request.type) {
      case 'generateThumbnail': {
        const dataUrl = await generateThumbnail(request)

        const response: ThumbnailResponse = {
          id: request.id,
          type: 'thumbnailResult',
          data: dataUrl,
        }
        self.postMessage(response)
        break
      }

      default:
        self.postMessage({
          id: request.id,
          type: 'thumbnailError',
          data: null,
          error: `Unknown request type: ${request.type}`,
        } as ThumbnailResponse)
    }
  } catch (error) {
    console.error(`[Worker] Thumbnail generation failed: ${request.id}`, error)
    const response: ThumbnailResponse = {
      id: request.id,
      type: 'thumbnailError',
      data: null,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
    self.postMessage(response)
  }
}

export { }
