import type { Node, NodeGroup, Domain, Connection } from '@/types'
import { NODE_DEFAULTS, GROUP_DEFAULTS } from '@/constants'
import { logger } from './logger.js'

// Get fabric from global scope with type safety
const fabric = (globalThis as unknown as { fabric?: any }).fabric

// Ensure fabric is loaded
if (!fabric) {
  logger.error('Fabric.js is not loaded')
}

/**
 * Create a Fabric.js rect for a node
 */
export function createFabricNode(node: Node): any | null {
  if (!fabric) return null
  
  const rect = new fabric.Rect({
    left: node.x,
    top: node.y,
    width: node.width,
    height: node.height,
    fill: node.color,
    selectable: true,
    data: {
      id: node.id,
      type: 'node',
    },
  })

  // Add text if content exists
  if (node.content) {
    const text = new fabric.Text(node.content, {
      fontSize: node.fontSize,
      fill: '#333',
      textAlign: node.textAlign,
      selectable: false,
      data: {
        parentId: node.id,
        type: 'node-text',
      },
    })

    // Group rect and text
    const group = new fabric.Group([rect, text], {
      left: node.x,
      top: node.y,
      selectable: true,
      data: {
        id: node.id,
        type: 'node',
      },
    })

    return group
  }

  return rect
}

/**
 * Create a Fabric.js group for node groups
 */
export function createFabricGroup(group: NodeGroup): any | null {
  if (!fabric) return null
  
  const border = new fabric.Rect({
    left: group.x,
    top: group.y,
    width: group.width,
    height: group.height,
    fill: group.backgroundColor,
    stroke: group.backgroundColor,
    strokeWidth: group.borderWidth,
    rx: group.borderRadius,
    ry: group.borderRadius,
    selectable: true,
    data: {
      id: group.id,
      type: 'group',
    },
  })

  // Add title text
  if (group.name) {
    const title = new fabric.Text(group.name, {
      fontSize: 14,
      fontWeight: 'bold',
      fill: group.backgroundColor,
      selectable: false,
      left: group.x + 10,
      top: group.y + 5,
      data: {
        parentId: group.id,
        type: 'group-title',
      },
    })

    return new fabric.Group([border, title], {
      left: group.x,
      top: group.y,
      selectable: true,
      data: {
        id: group.id,
        type: 'group',
      },
    })
  }

  return border
}

/**
 * Create a Fabric.js rect for a domain
 */
export function createFabricDomain(domain: Domain, isEditable: boolean = false): any | null {
  if (!fabric) return null
  
  const domainRect = new fabric.Rect({
    left: domain.x,
    top: domain.y,
    width: domain.width,
    height: domain.height,
    fill: domain.backgroundColor,
    selectable: isEditable,
    evented: isEditable,
    hasControls: isEditable,
    hasBorders: isEditable,
    rx: 0,
    ry: 0,
    data: {
      id: domain.id,
      type: 'domain',
    },
  })

  // 添加标题文本
  if (domain.titleVisible && domain.name) {
    const titleText = new fabric.Text(domain.name, {
      fontSize: domain.titleFontSize ?? 14,
      fontWeight: 'bold',
      fill: domain.titleColor ?? '#9ca3af',
      selectable: false,
      evented: false,
      left: 0,
      top: -20,
      data: {
        parentId: domain.id,
        type: 'domain-title',
      },
    })

    return new fabric.Group([domainRect, titleText], {
      left: domain.x,
      top: domain.titleVisible ? domain.y - 20 : domain.y,
      selectable: isEditable,
      evented: isEditable,
      hasControls: isEditable,
      hasBorders: isEditable,
      data: {
        id: domain.id,
        type: 'domain',
      },
    })
  }

  return domainRect
}

/**
 * Create a Fabric.js line for a connection
 */
export function createFabricConnection(connection: Connection, nodes: Map<string, Node>): any | null {
  if (!fabric) return null
  
  const fromNode = nodes.get(connection.fromNodeId)
  const toNode = nodes.get(connection.toNodeId)

  if (!fromNode || !toNode) return null

  const fromCenter = {
    x: fromNode.x + fromNode.width / 2,
    y: fromNode.y + fromNode.height / 2,
  }
  const toCenter = {
    x: toNode.x + toNode.width / 2,
    y: toNode.y + toNode.height / 2,
  }

  // For straight lines
  if (connection.type === 'straight') {
    const line = new fabric.Line([fromCenter.x, fromCenter.y, toCenter.x, toCenter.y], {
      stroke: connection.color,
      strokeWidth: connection.width,
      selectable: false,
      evented: false,
      data: {
        id: connection.id,
        type: 'connection',
      },
    })

    if (connection.style === 'dashed') {
      line.set({ strokeDashArray: [5, 5] })
    } else if (connection.style === 'dotted') {
      line.set({ strokeDashArray: [2, 2] })
    }

    return line
  }

  // For curve and step connections, use Path
  const path = createConnectionPath(fromNode, toNode, connection)
  const fabricPath = new fabric.Path(path, {
    stroke: connection.color,
    strokeWidth: connection.width,
    fill: '',
    selectable: false,
    evented: false,
    data: {
      id: connection.id,
      type: 'connection',
    },
  })

  if (connection.style === 'dashed') {
    fabricPath.set({ strokeDashArray: [5, 5] })
  } else if (connection.style === 'dotted') {
    fabricPath.set({ strokeDashArray: [2, 2] })
  }

  return fabricPath
}

/**
 * Create SVG path string for connection
 */
function createConnectionPath(
  from: Node,
  to: Node,
  connection: Connection
): string {
  const fromCenter = {
    x: from.x + from.width / 2,
    y: from.y + from.height / 2,
  }
  const toCenter = {
    x: to.x + to.width / 2,
    y: to.y + to.height / 2,
  }

  switch (connection.type) {
    case 'curve': {
      const dx = Math.abs(toCenter.x - fromCenter.x)
      const controlOffset = Math.min(dx * 0.5, 100)
      return `M ${fromCenter.x} ${fromCenter.y} C ${fromCenter.x + controlOffset} ${fromCenter.y}, ${toCenter.x - controlOffset} ${toCenter.y}, ${toCenter.x} ${toCenter.y}`
    }

    case 'step': {
      const midX = (fromCenter.x + toCenter.x) / 2
      return `M ${fromCenter.x} ${fromCenter.y} L ${midX} ${fromCenter.y} L ${midX} ${toCenter.y} L ${toCenter.x} ${toCenter.y}`
    }

    default:
      return `M ${fromCenter.x} ${fromCenter.y} L ${toCenter.x} ${toCenter.y}`
  }
}

/**
 * Convert Fabric object to Node
 */
export function fabricObjectToNode(obj: any): Node | null {
  const data = obj.data
  if (!data || data.type !== 'node') return null

  return {
    id: data.id,
    x: obj.left ?? 0,
    y: obj.top ?? 0,
    width: obj.width ?? NODE_DEFAULTS.WIDTH,
    height: obj.height ?? NODE_DEFAULTS.HEIGHT,
    title: '',
    content: '',
    color: obj.fill ?? NODE_DEFAULTS.COLOR,
    fontSize: NODE_DEFAULTS.FONT_SIZE,
    textAlign: NODE_DEFAULTS.TEXT_ALIGN,
    collapsed: false,
    locked: !obj.selectable,
  }
}

/**
 * Convert Fabric object to Group
 */
export function fabricObjectToGroup(obj: any): NodeGroup | null {
  const data = obj.data
  if (!data || data.type !== 'group') return null

  const rect = (obj as any).getObjects ? (obj as any).getObjects()[0] : obj

  return {
    id: data.id,
    name: '',
    x: obj.left ?? 0,
    y: obj.top ?? 0,
    width: obj.width ?? 200,
    height: obj.height ?? 200,
    borderColor: rect.stroke ?? GROUP_DEFAULTS.BORDER_COLOR,
    backgroundColor: rect.fill ?? GROUP_DEFAULTS.BACKGROUND_COLOR,
    borderWidth: rect.strokeWidth ?? GROUP_DEFAULTS.BORDER_WIDTH,
    borderRadius: rect.rx ?? GROUP_DEFAULTS.BORDER_RADIUS,
    nodeIds: [],
    collapsed: false,
  }
}

/**
 * Get canvas objects by type
 */
export function getObjectsByType(
  canvas: any,
  type: string
): any[] {
  return canvas.getObjects().filter(obj => {
    const data = obj.data
    return data && data.type === type
  })
}

/**
 * Clear all canvas objects
 */
export function clearCanvas(canvas: any): void {
  canvas.clear()
}

/**
 * Add grid background to canvas
 */
export function addGridBackground(
  canvas: any,
  gridSize: number = 20,
  dotSize: number = 1,
  color: string = 'rgba(0, 0, 0, 0.1)'
): void {
  if (!fabric) return
  
  const gridObjects: any[] = []

  for (let x = 0; x < (canvas.width ?? 0); x += gridSize) {
    for (let y = 0; y < (canvas.height ?? 0); y += gridSize) {
      const dot = new fabric.Circle({
        left: x,
        top: y,
        radius: dotSize,
        fill: color,
        selectable: false,
        evented: false,
      })
      gridObjects.push(dot)
    }
  }

  canvas.add(...gridObjects)
  canvas.sendToBack(...gridObjects)
}

/**
 * 更新域的编辑状态
 */
export function updateFabricDomainsEditable(canvas: any, editable: boolean): void {
  const domains = getObjectsByType(canvas, 'domain')
  domains.forEach(obj => {
    obj.set({
      selectable: editable,
      evented: editable,
      hasControls: editable,
      hasBorders: editable,
    })
  })
  canvas.renderAll()
}

/**
 * 获取域对象
 */
export function getFabricDomain(canvas: any, domainId: string): any | null {
  const objects = canvas.getObjects()
  return objects.find(obj => {
    const data = obj.data
    return data?.id === domainId && data?.type === 'domain'
  }) || null
}

/**
 * 对齐到网格
 */
export function snapToGridFabric(value: number, gridSize: number): number {
  return Math.round(value / gridSize) * gridSize
}

/**
 * 对齐域到网格
 */
export function snapDomainToGrid(domain: Domain, gridSize: number = 20): Domain {
  return {
    ...domain,
    x: snapToGridFabric(domain.x, gridSize),
    y: snapToGridFabric(domain.y, gridSize),
    width: Math.max(snapToGridFabric(domain.width, gridSize), 40),
    height: Math.max(snapToGridFabric(domain.height, gridSize), 40),
  }
}