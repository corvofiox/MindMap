import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useProjectsStore } from '@/store/useProjectsStore'
import { useAuthStore } from '@/store/useAuthStore'
import { useUIStore } from '@/store/useUIStore'
import { useNodePoolStore } from '@/features/node-pool/stores/useNodePoolStore'
import { CanvasToolbar } from '@/components/canvas/CanvasToolbar'
import { CanvasGrid } from '@/components/canvas/CanvasGrid'
import { CanvasMinimap } from '@/components/canvas/CanvasMinimap'
import { ZoomControls } from '@/components/canvas/ZoomControls'
import { NodeItem } from '@/components/canvas/NodeItem'
import { NodeContextMenu } from '@/components/canvas/NodeContextMenu'
import { NodeStylePanel } from '@/components/canvas/NodeStylePanel'
import { ConnectionStylePanel } from '@/components/canvas/ConnectionStylePanel'
import { DomainContextMenu } from '@/components/canvas/DomainContextMenu'
import { DomainStylePanel } from '@/components/canvas/DomainStylePanel'
import { ContextMenuWrapper } from '@/components/ContextMenuWrapper'
import { RichTextToolbar } from '@/components/canvas/RichTextToolbar'
import { ConnectionLine } from '@/components/canvas/ConnectionLine'
import { CONNECTION_DEFAULTS, Z_INDEX } from '@/constants'
import { generateId, colorToHex, hexToRgba } from '@/utils/canvas'
import { saveToCache, loadFromCache } from '@/utils/nodeCache'
import { saveCanvasNodesData, loadCanvasNodesData } from '@/services/api'
import type { Node, Connection, Canvas, NodeCard } from '@/types'
import html2canvas from 'html2canvas-pro'

const AUTO_SAVE_INTERVAL = 5000
const CACHE_SAVE_DELAY = 500

// Thumbnail generation constants
const THUMBNAIL = {
  WIDTH: 320,
  HEIGHT: 180,
  BACKGROUND_COLOR: '#f8fafc',
  QUALITY: 0.8,
  PADDING: 40,
  DEBOUNCE_DELAY: 300,
} as const

const ENDPOINT_CIRCLE_STYLE = {
  border: '2px solid #3b82f6',
  boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
} as const

const ENDPOINT_HIT_AREA_STYLE = {
  position: 'absolute',
  width: 24,
  height: 24,
  cursor: 'crosshair',
  pointerEvents: 'all',
  zIndex: Z_INDEX.BEND_POINT,
} as const

const ENDPOINT_VISIBLE_CIRCLE_STYLE = {
  position: 'absolute',
  left: 4,
  top: 4,
  width: 16,
  height: 16,
  borderRadius: '50%',
  ...ENDPOINT_CIRCLE_STYLE,
} as const

const ENDPOINT_CONTAINER_STYLE = {
  position: 'absolute',
  left: 0,
  top: 0,
  width: 0,
  height: 0,
} as const

// Helper function to check if in default selection mode (no tool selected or select tool)
function isDefaultSelectionTool(tool: string): boolean {
  return tool === 'select'
}

// Helper function to calculate port position on a node
function getPortPosition(node: Node, port: 'top' | 'right' | 'bottom' | 'left') {
  switch (port) {
    case 'top':
      return { x: node.x + node.width / 2, y: node.y }
    case 'right':
      return { x: node.x + node.width, y: node.y + node.height / 2 }
    case 'bottom':
      return { x: node.x + node.width / 2, y: node.y + node.height }
    case 'left':
      return { x: node.x, y: node.y + node.height / 2 }
  }
}

function getConnectionPort(conn: Connection, endpointType: 'start' | 'end'): 'top' | 'right' | 'bottom' | 'left' {
  if (endpointType === 'start') {
    return conn.fromPort || 'right'
  } else {
    return conn.toPort || 'left'
  }
}

// Helper function to find the best port based on mouse position
function findBestPort(node: Node, mouseX: number, mouseY: number): 'top' | 'right' | 'bottom' | 'left' {
  const centerX = node.x + node.width / 2
  const centerY = node.y + node.height / 2

  const dx = mouseX - centerX
  const dy = mouseY - centerY

  const angle = Math.atan2(dy, dx)
  const degrees = angle * (180 / Math.PI)

  if (degrees >= -45 && degrees < 45) return 'right'
  if (degrees >= 45 && degrees < 135) return 'bottom'
  if (degrees >= 135 || degrees < -135) return 'left'
  return 'top'
}

// Helper function to calculate orthogonal path with bend points
function getOrthogonalPath(
  fromX: number, fromY: number,
  toX: number, toY: number,
  bendPoints: { x: number; y: number }[]
): { x: number; y: number }[] {
  return [
    { x: fromX, y: fromY },
    ...bendPoints,
    { x: toX, y: toY }
  ]
}

// Helper function to convert points to SVG path string
function pointsToPath(points: { x: number; y: number }[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
}

// Helper function to calculate optimal bend point position
function calculateOptimalBendPoint(
  fromX: number, fromY: number,
  toX: number, toY: number
): { x: number; y: number } {
  const dx = toX - fromX
  const dy = toY - fromY

  const distance = Math.sqrt(dx * dx + dy * dy)
  if (distance < 100) {
    return { x: (fromX + toX) / 2, y: fromY }
  }

  return { x: fromX + dx / 3, y: fromY }
}

// Helper function to calculate distance from point to line segment
function pointToLineSegmentDistance(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number
): number {
  const A = px - x1
  const B = py - y1
  const C = x2 - x1
  const D = y2 - y1

  const dot = A * C + B * D
  const lenSq = C * C + D * D

  if (lenSq === 0) return Math.sqrt(A * A + B * B)

  let param = -1
  if (lenSq !== 0) param = dot / lenSq

  let xx, yy
  if (param < 0) {
    xx = x1
    yy = y1
  } else if (param > 1) {
    xx = x2
    yy = y2
  } else {
    xx = x1 + param * C
    yy = y1 + param * D
  }

  const dx = px - xx
  const dy = py - yy

  return Math.sqrt(dx * dx + dy * dy)
}

// Helper function to find the correct insert index for a new bend point
function findBendPointInsertIndex(
  clickX: number, clickY: number,
  fromX: number, fromY: number,
  toX: number, toY: number,
  bendPoints: { x: number; y: number }[]
): number {
  if (bendPoints.length === 0) return 0

  // Build all points including endpoints
  const allPoints = [
    { x: fromX, y: fromY },
    ...bendPoints,
    { x: toX, y: toY }
  ]

  // Find which line segment is closest to the click point
  let minDistance = Infinity
  let insertIndex = 0

  for (let i = 0; i < allPoints.length - 1; i++) {
    const p1 = allPoints[i]
    const p2 = allPoints[i + 1]
    const distance = pointToLineSegmentDistance(clickX, clickY, p1.x, p1.y, p2.x, p2.y)

    if (distance < minDistance) {
      minDistance = distance
      insertIndex = i
    }
  }

  return insertIndex
}

// Helper function to calculate the midpoint along a path
function getLabelPosition(
  connType: string,
  fromX: number, fromY: number,
  toX: number, toY: number,
  bendPoints: { x: number; y: number }[]
): { x: number; y: number } {
  if (connType === 'straight') {
    return { x: (fromX + toX) / 2, y: (fromY + toY) / 2 }
  }

  if (connType === 'curve' && bendPoints.length > 0) {
    const points = [{ x: fromX, y: fromY }, ...bendPoints, { x: toX, y: toY }]
    return getCatmullRomMidpoint(points)
  }

  if (connType === 'orthogonal' && bendPoints.length > 0) {
    const points = [{ x: fromX, y: fromY }, ...bendPoints, { x: toX, y: toY }]
    return getPolylineMidpoint(points)
  }

  if (connType === 'curve') {
    const midX = (fromX + toX) / 2
    const midY = (fromY + toY) / 2
    const dx = toX - fromX
    const dy = toY - fromY
    const controlX = midX - dy * 0.2
    const controlY = midY + dx * 0.2
    return getQuadraticBezierMidpoint(fromX, fromY, controlX, controlY, toX, toY)
  }

  if (connType === 'step') {
    const midX = (fromX + toX) / 2
    const points = [
      { x: fromX, y: fromY },
      { x: midX, y: fromY },
      { x: midX, y: toY },
      { x: toX, y: toY }
    ]
    return getPolylineMidpoint(points)
  }

  return { x: (fromX + toX) / 2, y: (fromY + toY) / 2 }
}

// Get midpoint of a quadratic bezier curve
function getQuadraticBezierMidpoint(x1: number, y1: number, cx: number, cy: number, x2: number, y2: number): { x: number; y: number } {
  const t = 0.5
  const mt = 1 - t
  const mt2 = mt * mt
  const t2 = t * t
  const x = mt2 * x1 + 2 * mt * t * cx + t2 * x2
  const y = mt2 * y1 + 2 * mt * t * cy + t2 * y2
  return { x, y }
}

// Get midpoint of a polyline path
function getPolylineMidpoint(points: { x: number; y: number }[]): { x: number; y: number } {
  if (points.length < 2) return points[0] || { x: 0, y: 0 }

  let totalLength = 0
  const segmentLengths: number[] = []

  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1].x - points[i].x
    const dy = points[i + 1].y - points[i].y
    const length = Math.sqrt(dx * dx + dy * dy)
    segmentLengths.push(length)
    totalLength += length
  }

  const midLength = totalLength / 2
  let currentLength = 0

  for (let i = 0; i < segmentLengths.length; i++) {
    if (currentLength + segmentLengths[i] >= midLength) {
      const t = (midLength - currentLength) / segmentLengths[i]
      return {
        x: points[i].x + (points[i + 1].x - points[i].x) * t,
        y: points[i].y + (points[i + 1].y - points[i].y) * t
      }
    }
    currentLength += segmentLengths[i]
  }

  return points[points.length - 1]
}

// Get midpoint of a Catmull-Rom spline
function getCatmullRomMidpoint(points: { x: number; y: number }[]): { x: number; y: number } {
  if (points.length < 2) return points[0] || { x: 0, y: 0 }

  let totalLength = 0
  const segmentLengths: number[] = []

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[Math.min(points.length - 1, i + 2)]

    const cp1x = p1.x + (p2.x - p0.x) / 6
    const cp1y = p1.y + (p2.y - p0.y) / 6
    const cp2x = p2.x - (p3.x - p1.x) / 6
    const cp2y = p2.y - (p3.y - p1.y) / 6

    const length = getCubicBezierLength(p1.x, p1.y, cp1x, cp1y, cp2x, cp2y, p2.x, p2.y)
    segmentLengths.push(length)
    totalLength += length
  }

  const midLength = totalLength / 2
  let currentLength = 0

  for (let i = 0; i < segmentLengths.length; i++) {
    if (currentLength + segmentLengths[i] >= midLength) {
      const p0 = points[Math.max(0, i - 1)]
      const p1 = points[i]
      const p2 = points[i + 1]
      const p3 = points[Math.min(points.length - 1, i + 2)]

      const cp1x = p1.x + (p2.x - p0.x) / 6
      const cp1y = p1.y + (p2.y - p0.y) / 6
      const cp2x = p2.x - (p3.x - p1.x) / 6
      const cp2y = p2.y - (p3.y - p1.y) / 6

      const t = (midLength - currentLength) / segmentLengths[i]
      return getCubicBezierPoint(t, p1.x, p1.y, cp1x, cp1y, cp2x, cp2y, p2.x, p2.y)
    }
    currentLength += segmentLengths[i]
  }

  return points[points.length - 1]
}

// Get length of a cubic bezier curve
function getCubicBezierLength(x1: number, y1: number, cx1: number, cy1: number, cx2: number, cy2: number, x2: number, y2: number): number {
  const steps = 20
  let length = 0
  let prevX = x1, prevY = y1

  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const point = getCubicBezierPoint(t, x1, y1, cx1, cy1, cx2, cy2, x2, y2)
    const dx = point.x - prevX
    const dy = point.y - prevY
    length += Math.sqrt(dx * dx + dy * dy)
    prevX = point.x
    prevY = point.y
  }

  return length
}

// Get point on a cubic bezier curve at parameter t
function getCubicBezierPoint(
  t: number,
  x1: number, y1: number,
  cx1: number, cy1: number,
  cx2: number, cy2: number,
  x2: number, y2: number
): { x: number; y: number } {
  const mt = 1 - t
  const mt2 = mt * mt
  const mt3 = mt2 * mt
  const t2 = t * t
  const t3 = t2 * t

  const x = mt3 * x1 + 3 * mt2 * t * cx1 + 3 * mt * t2 * cx2 + t3 * x2
  const y = mt3 * y1 + 3 * mt2 * t * cy1 + 3 * mt * t2 * cy2 + t3 * y2

  return { x, y }
}

function isNodeInGroup(node: Node, groupX: number, groupY: number, groupWidth: number, groupHeight: number): boolean {
  const overlapX = Math.max(0, Math.min(node.x + node.width, groupX + groupWidth) - Math.max(node.x, groupX))
  const overlapY = Math.max(0, Math.min(node.y + node.height, groupY + groupHeight) - Math.max(node.y, groupY))
  const overlapArea = overlapX * overlapY
  const nodeArea = node.width * node.height
  return overlapArea > nodeArea * 0.5
}

function isDomainOverlapping(
  x: number,
  y: number,
  width: number,
  height: number,
  existingDomains: Map<string, { x: number; y: number; width: number; height: number; id: string }>,
  excludeId?: string
): boolean {
  for (const domain of existingDomains.values()) {
    if (excludeId && domain.id === excludeId) continue

    const overlapX = Math.max(0, Math.min(x + width, domain.x + domain.width) - Math.max(x, domain.x))
    const overlapY = Math.max(0, Math.min(y + height, domain.y + domain.height) - Math.max(y, domain.y))
    const overlapArea = overlapX * overlapY

    if (overlapArea > 0) {
      return true
    }
  }
  return false
}

function getActualNodePosition(
  node: Node,
  draggingPos: { x: number; y: number } | undefined,
  isDraggingGroup: boolean,
  draggingGroupId: string | undefined,
  initialGroupNodeIds: Set<string>,
  groupDragOffset: { x: number; y: number } | undefined
): Node {
  let actualNode = draggingPos ? { ...node, x: draggingPos.x, y: draggingPos.y } : node

  const groupOffset = (isDraggingGroup && draggingGroupId && initialGroupNodeIds.has(node.id)) ? groupDragOffset : undefined
  if (groupOffset) {
    actualNode = { ...actualNode, x: actualNode.x + groupOffset.x, y: actualNode.y + groupOffset.y }
  }

  return actualNode
}

function findNearestPort(
  nodes: Map<string, Node>,
  mouseX: number,
  mouseY: number,
  excludeNodeId?: string,
  snapThreshold: number = 30
): { nodeId: string; port: 'top' | 'right' | 'bottom' | 'left'; position: { x: number; y: number } } | null {
  let nearest: { nodeId: string; port: 'top' | 'right' | 'bottom' | 'left'; position: { x: number; y: number }; distance: number } | null = null

  for (const [nodeId, node] of nodes.entries()) {
    if (excludeNodeId && nodeId === excludeNodeId) continue

    const ports: ('top' | 'right' | 'bottom' | 'left')[] = ['top', 'right', 'bottom', 'left']
    for (const port of ports) {
      const portPosition = getPortPosition(node, port)
      const distance = Math.sqrt(
        Math.pow(mouseX - portPosition.x, 2) + Math.pow(mouseY - portPosition.y, 2)
      )

      if (distance <= snapThreshold) {
        if (!nearest || distance < nearest.distance) {
          nearest = { nodeId, port, position: portPosition, distance }
        }
      }
    }
  }

  return nearest ? { nodeId: nearest.nodeId, port: nearest.port, position: nearest.position } : null
}

// Helper function to collect canvas data for saving/generating thumbnails
function collectCanvasData(state: ReturnType<typeof useCanvasStore.getState>) {
  return {
    nodes: Array.from(state.nodes.values()),
    groups: Array.from(state.groups.values()),
    domains: Array.from(state.domains.values()),
    connections: Array.from(state.connections.values()),
  }
}

// Helper function to check if canvas has content
function hasCanvasContent(nodes: any[], domains: any[]): boolean {
  return nodes.length > 0 || domains.length > 0
}

// Helper function to calculate bounding box of canvas elements
function calculateBoundingBox(elements: Array<{ x: number; y: number; width?: number; height?: number }>) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  elements.forEach((el) => {
    minX = Math.min(minX, el.x)
    minY = Math.min(minY, el.y)
    maxX = Math.max(maxX, el.x + (el.width || 0))
    maxY = Math.max(maxY, el.y + (el.height || 0))
  })

  return { minX, minY, maxX, maxY, contentWidth: maxX - minX, contentHeight: maxY - minY }
}

export function CanvasPage() {
  const { canvasId } = useParams<{ canvasId: string }>()
  const navigate = useNavigate()
  const containerRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [isSpacePressed, setIsSpacePressed] = useState(false)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  const [containerReady, setContainerReady] = useState(false)
  const lastSaveTimeRef = useRef<number>(0)

  const dragStartRef = useRef({ x: 0, y: 0 })
  const groupContextMenuStartRef = useRef({ x: 0, y: 0 })
  const domainContextMenuStartRef = useRef({ x: 0, y: 0 })
  const panStartRef = useRef({ x: 0, y: 0 })
  const cacheTimeoutRef = useRef<ReturnType<typeof setTimeout>>()
  const dbSaveTimeoutRef = useRef<ReturnType<typeof setTimeout>>()
  const mouseDownOnContentRef = useRef(false) // Track if mouse down was on content
  const hasInitializedCameraRef = useRef(false) // Track if camera has been initialized
  const justFinishedConnectionRef = useRef(false) // Track if just finished creating a connection
  const justFinishedBoxSelectingRef = useRef(false) // Track if just finished box selection
  const justFinishedEndpointDraggingRef = useRef(false) // Track if just finished dragging endpoint
  const justFinishedBendPointDraggingRef = useRef(false) // Track if just finished dragging bend point

  // Connection creation state
  const [isCreatingConnection, setIsCreatingConnection] = useState(false)
  const [connectionStartNodeId, setConnectionStartNodeId] = useState<string | null>(null)
  const [connectionStartPort, setConnectionStartPort] = useState<'top' | 'right' | 'bottom' | 'left' | null>(null)
  const [connectionEndPosition, setConnectionEndPosition] = useState({ x: 0, y: 0 })

  // Connection endpoint editing state
  const [isEditingConnectionEndpoint] = useState(false)
  const [editingConnectionId] = useState<string | null>(null)
  const [editingEndpoint] = useState<'start' | 'end' | null>(null)
  const [editingEndpointPosition, setEditingEndpointPosition] = useState({ x: 0, y: 0 })

  // Connection endpoint dragging state
  const [isDraggingConnectionEndpoint, setIsDraggingConnectionEndpoint] = useState(false)
  const [draggingConnectionId, setDraggingConnectionId] = useState<string | null>(null)
  const [draggingEndpoint, setDraggingEndpoint] = useState<'start' | 'end' | null>(null)

  // Bend point dragging state
  const [isDraggingBendPoint, setIsDraggingBendPoint] = useState(false)
  const [draggingBendPointId, setDraggingBendPointId] = useState<string | null>(null)
  const [dragBendPointStart, setDragBendPointStart] = useState({ x: 0, y: 0 })

  // Bend point context menu state
  const [bendPointContextMenu, setBendPointContextMenu] = useState<{ x: number; y: number; connectionId: string; bendPointId: string } | null>(null)

  // Hovered bend point state
  const [hoveredBendPoint, setHoveredBendPoint] = useState<{ connectionId: string; bendPointId: string } | null>(null)

  // Snapping state for connection creation and endpoint dragging
  const [snappedPort, setSnappedPort] = useState<{ nodeId: string; port: 'top' | 'right' | 'bottom' | 'left'; position: { x: number; y: number } } | null>(null)

  // Node dragging state for real-time connection updates
  const [draggingNodePositions, setDraggingNodePositions] = useState<Map<string, { x: number; y: number }>>(new Map())

  // Group creation state
  const [isCreatingGroup, setIsCreatingGroup] = useState(false)
  const [groupStartPos, setGroupStartPos] = useState({ x: 0, y: 0 })
  const [groupEndPos, setGroupEndPos] = useState({ x: 0, y: 0 })

  // Group dragging state
  const [isDraggingGroup, setIsDraggingGroup] = useState(false)
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null)
  const [groupDragStart, setGroupDragStart] = useState({ x: 0, y: 0 })
  const [groupInitialPositions, setGroupInitialPositions] = useState<Map<string, { x: number; y: number }>>(new Map())
  const [initialGroupNodeIds, setInitialGroupNodeIds] = useState<Set<string>>(new Set())
  const [groupDragInitialGroupPos, setGroupDragInitialGroupPos] = useState<{ x: number; y: number } | null>(null)
  const [groupDragOffset, setGroupDragOffset] = useState({ x: 0, y: 0 })

  // Group resizing state
  const [isResizingGroup, setIsResizingGroup] = useState(false)
  const [resizingGroupId, setResizingGroupId] = useState<string | null>(null)
  const [resizeHandle, setResizeHandle] = useState<'nw' | 'ne' | 'sw' | 'se' | null>(null)
  const [resizeStart, setResizeStart] = useState({ x: 0, y: 0 })
  const [resizeInitialGroup, setResizeInitialGroup] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const [resizeInitialNodePositions, setResizeInitialNodePositions] = useState<Map<string, { x: number; y: number; width: number; height: number }>>(new Map())

  // Group context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; groupId: string } | null>(null)

  // Connection context menu state
  const [connectionContextMenu, setConnectionContextMenu] = useState<{ x: number; y: number; connectionId: string; clickX?: number; clickY?: number } | null>(null)

  // Domain context menu state
  const [domainContextMenu, setDomainContextMenu] = useState<{ x: number; y: number; domainId: string } | null>(null)

  // Node context menu state
  const [nodeContextMenu, setNodeContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null)

  // Domain creation state (box selection style)
  const [isCreatingDomain, setIsCreatingDomain] = useState(false)
  const [domainBoxStart, setDomainBoxStart] = useState({ x: 0, y: 0 })
  const [domainBoxEnd, setDomainBoxEnd] = useState({ x: 0, y: 0 })

  // Local state for editing group name
  const [editingGroupName, setEditingGroupName] = useState('')

  // Box selection state
  const [isBoxSelecting, setIsBoxSelecting] = useState(false)
  const [boxSelectionStart, setBoxSelectionStart] = useState({ x: 0, y: 0 })
  const [boxSelectionEnd, setBoxSelectionEnd] = useState({ x: 0, y: 0 })

  // Connection label editing dialog state
  const [editingConnectionLabel, setEditingConnectionLabel] = useState<{
    connectionId: string
    label: string
  } | null>(null)

  // Cursor state
  const [customCursor, setCustomCursor] = useState<string | null>(null)

  // Rich text toolbar state
  const [richTextToolbarVisible, setRichTextToolbarVisible] = useState(false)
  const [richTextToolbarPosition, setRichTextToolbarPosition] = useState({ x: 0, y: 0 })

  // Save/restore selection for rich text editing
  const savedSelectionRef = useRef<Range | null>(null)

  // Helper to close all context menus
  const closeAllContextMenus = useCallback(() => {
    setContextMenu(null)
    setConnectionContextMenu(null)
    setDomainContextMenu(null)
    setNodeContextMenu(null)
    setBendPointContextMenu(null)
  }, [])


  const {
    nodes,
    groups,
    domains,
    connections,
    zoom,
    panX,
    panY,
    selectedIds,
    editingId,
    isDirty,
    setCanvasId,
    setCanvasData,
    setZoom,
    setPan,
    setEditingId,
    setSelectedIds,
    addToSelection,
    removeFromSelection,
    clearCanvas,
    addNode,
    addDomain,
    addGroup,
    updateGroup,
    updateGroupWithoutHistory,
    removeGroup,
    addConnection,
    removeConnection,
    updateConnection,
    setDirty,
    undo,
    redo,
    canUndo,
    canRedo,
  } = useCanvasStore()

  const {
    currentTool,
    dragMode,
    nodePoolOpen,
    stylePanelOpen,
    sidebarOpen,
    minimapVisible,
    domainEditMode,
    setDomainEditMode,
    setCurrentTool,
    toggleGrid,
    setSelectedType,
    isLoading,
    setLoading,
    connectionType,
    connectionDirection,
    connectionStyle,
    closeStylePanel,
    openStylePanel,
    addToast,
  } = useUIStore()

  // Refs to store latest values for global event listeners
  const panXRef = useRef(panX)
  const panYRef = useRef(panY)
  const zoomRef = useRef(zoom)

  // Update refs when values change
  useEffect(() => {
    panXRef.current = panX
    panYRef.current = panY
    zoomRef.current = zoom
  }, [panX, panY, zoom])

  // Handle canvas drop event from node pool (copy to canvas)
  useEffect(() => {
    const handleCanvasDrop = async (e: CustomEvent) => {
      const { card } = e.detail
      if (!card || !containerRef.current) return

      const rect = containerRef.current.getBoundingClientRect()

      // 计算视图中央的屏幕坐标
      const screenCenterX = rect.width / 2
      const screenCenterY = rect.height / 2

      // 将屏幕坐标转换为画布坐标
      const canvasCenterX = (screenCenterX - panX) / zoom
      const canvasCenterY = (screenCenterY - panY) / zoom

      try {
        const nodeData = JSON.parse(card.content)
        const newNode = {
          ...nodeData,
          id: `${nodeData.id}-pool-${Date.now()}`,
          x: canvasCenterX - (nodeData.width || 200) / 2,
          y: canvasCenterY - (nodeData.height || 120) / 2,
        }
        addNode(newNode)
        addToast({ type: 'success', title: '复制成功', message: '节点已复制到画布中央' })
      } catch (error) {
        addToast({ type: 'error', title: '复制失败', message: '无法解析节点数据' })
      }
    }

    document.addEventListener('canvasDrop', handleCanvasDrop as EventListener)

    return () => {
      document.removeEventListener('canvasDrop', handleCanvasDrop as EventListener)
    }
  }, [addNode, addToast, panX, panY, zoom])

  const { loadProjects, restoreCurrentProject, canvases, updateCanvas: updateCanvasInStore } = useProjectsStore()

  const stableLoadProjects = useCallback(loadProjects, [])
  const stableRestoreCurrentProject = useCallback(restoreCurrentProject, [])

  // 恢复项目状态（只在组件挂载时执行一次）
  useEffect(() => {
    const initProject = async () => {
      await loadProjects()
      await restoreCurrentProject()
    }
    initProject()
  }, [])

  // 检查当前画布是否已被删除，同时处理临时ID的情况
  useEffect(() => {
    if (!canvasId) return

    const id = parseInt(canvasId)
    if (isNaN(id)) return

    // 检查当前画布是否还在画布列表中
    const canvasExists = canvases.some(c => c.id === id)

    // 检查是否有临时画布正在替换为真实画布
    const hasTemporaryCanvas = canvases.some(c => c.id < 0)

    // 如果画布已被删除且没有临时画布正在处理，重定向到项目列表
    // 临时ID（负数）被允许存在，因为它们会被真实ID替换
    if (!canvasExists && !hasTemporaryCanvas && canvases.length >= 0) {
      // 清空画布状态
      clearCanvas()
      setCanvasId(null)
      // 重定向到项目列表
      navigate('/projects', { replace: true })
    }

    // 如果当前是临时ID，检查是否已经被真实ID替换
    if (id < 0) {
      const realCanvas = canvases.find(c => c.tempId === id && c.id > 0)
      if (realCanvas) {
        // 更新URL为真实ID
        navigate(`/canvas/${realCanvas.id}`, { replace: true })
      }
    }
  }, [canvasId, canvases, navigate, clearCanvas, setCanvasId])

  // Load canvas data on mount
  useEffect(() => {
    if (!canvasId) return

    const id = parseInt(canvasId)
    if (isNaN(id)) return

    // Reset camera initialization flag when canvas changes
    hasInitializedCameraRef.current = false

    // Reset last save time when canvas changes
    lastSaveTimeRef.current = 0

    const loadFromDatabase = async () => {
      // Update store canvasId so thumbnail generation works correctly
      setCanvasId(id)

      try {
        setLoading(true)

        // 如果是临时ID，不尝试从数据库加载数据
        if (id < 0) {
          // 清空画布，准备一个新的画布
          clearCanvas()
          setDirty(false)
          return
        }

        // Ensure projects are loaded first to get correct context
        if (useProjectsStore.getState().projects.length === 0) {
          await stableLoadProjects()
          await stableRestoreCurrentProject()
        }

        const dbData = await loadCanvasNodesData(id)

        const hasData = dbData && (
          (dbData.nodes && dbData.nodes.length > 0) ||
          (dbData.groups && dbData.groups.length > 0) ||
          (dbData.domains && dbData.domains.length > 0) ||
          (dbData.connections && dbData.connections.length > 0)
        )

        if (hasData) {
          // Found data in DB
          clearCanvas()
          setCanvasData(dbData)
          setDirty(false)
          saveToCache(id, dbData)
        } else {
          // No data in DB, try cache
          const cachedData = loadFromCache(id)
          if (cachedData) {
            clearCanvas()
            setCanvasData(cachedData)
            setDirty(false)
          } else {
            // No data anywhere
            clearCanvas()
          }
        }
      } catch (error) {
        // DB load failed, fallback to cache
        const cachedData = loadFromCache(id)
        if (cachedData) {
          clearCanvas()
          setCanvasData(cachedData)
          setDirty(false)
        } else {
          clearCanvas()
        }
      } finally {
        setLoading(false)
      }
    }

    loadFromDatabase()

    return () => {
      clearTimeout(cacheTimeoutRef.current)
      clearTimeout(dbSaveTimeoutRef.current)
    }
  }, [canvasId])

  // Center camera on content when canvas data is loaded (only on first load)
  useEffect(() => {
    // Only proceed if canvas is ready
    if (!canvasId) return

    const id = parseInt(canvasId)
    if (isNaN(id)) return

    // Only center camera on first load of this specific canvas
    if (hasInitializedCameraRef.current) return

    // Wait for container size to be truly ready
    if (!containerReady || containerSize.width === 0 || containerSize.height === 0) return

    // Add a small delay to ensure container size is stable and rendering has settled
    const timer = setTimeout(() => {
      // Check again after delay
      const currentNodes = useCanvasStore.getState().nodes
      const currentGroups = useCanvasStore.getState().groups
      const currentDomains = useCanvasStore.getState().domains

      // Calculate content bounds
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity

      currentNodes.forEach((node) => {
        minX = Math.min(minX, node.x)
        minY = Math.min(minY, node.y)
        maxX = Math.max(maxX, node.x + node.width)
        maxY = Math.max(maxY, node.y + node.height)
      })

      currentGroups.forEach((group) => {
        minX = Math.min(minX, group.x)
        minY = Math.min(minY, group.y)
        maxX = Math.max(maxX, group.x + group.width)
        maxY = Math.max(maxY, group.y + group.height)
      })

      currentDomains.forEach((domain) => {
        minX = Math.min(minX, domain.x)
        minY = Math.min(minY, domain.y)
        maxX = Math.max(maxX, domain.x + domain.width)
        maxY = Math.max(maxY, domain.y + domain.height)
      })

      let contentCenterX = 0
      let contentCenterY = 0

      if (minX === Infinity || minY === Infinity) {
        // Empty canvas - center on origin
        contentCenterX = 0
        contentCenterY = 0
      } else {
        contentCenterX = (minX + maxX) / 2
        contentCenterY = (minY + maxY) / 2
      }

      // Set camera to center on content
      const newPanX = containerSize.width / 2 - contentCenterX * zoom
      const newPanY = containerSize.height / 2 - contentCenterY * zoom

      setPan(newPanX, newPanY)
      hasInitializedCameraRef.current = true
    }, 100)

    return () => clearTimeout(timer)
  }, [canvasId, containerReady, containerSize.width, containerSize.height, setPan, zoom])

  const generateThumbnail = useCallback(async (canvasId: number) => {
    if (!containerRef.current) {
      return
    }

    try {
      // Get latest state from store to ensure we have current data
      const currentStore = useCanvasStore.getState()

      // CRITICAL: Check if we're still on the same canvas before generating thumbnail
      // If the user has switched to a different canvas, don't generate the thumbnail
      // to avoid updating the wrong canvas's thumbnail
      if (currentStore.canvasId !== canvasId) {
        return
      }

      const currentNodes = currentStore.nodes
      const currentGroups = currentStore.groups
      const currentDomains = currentStore.domains
      const currentConnections = currentStore.connections

      // Create thumbnail canvas with constants
      const thumbnailCanvas = document.createElement('canvas')
      thumbnailCanvas.width = THUMBNAIL.WIDTH
      thumbnailCanvas.height = THUMBNAIL.HEIGHT
      const ctx = thumbnailCanvas.getContext('2d')
      if (!ctx) {
        return
      }

      // Fill background with constant color
      ctx.fillStyle = THUMBNAIL.BACKGROUND_COLOR
      ctx.fillRect(0, 0, thumbnailCanvas.width, thumbnailCanvas.height)

      const allElements = [...currentNodes.values(), ...currentGroups.values(), ...currentDomains.values()]

      // Handle empty canvas - still save the blank thumbnail
      if (allElements.length === 0) {
        const thumbnailDataUrl = thumbnailCanvas.toDataURL('image/jpeg', THUMBNAIL.QUALITY)
        try {
          await updateCanvasInStore(canvasId, { thumbnail: thumbnailDataUrl }, true)
        } catch (error) {
          // Silently fail for thumbnail generation errors
        }
        return
      }

      // Calculate bounding box using helper function
      const { minX, minY, maxX, maxY, contentWidth, contentHeight } = calculateBoundingBox(allElements)

      // Create a temporary container to render the canvas content
      const contentElement = containerRef.current.querySelector('[data-canvas-content]') as HTMLElement
      if (!contentElement) {
        return
      }

      // Clone the content element
      const clonedContent = contentElement.cloneNode(true) as HTMLElement

      // Create a wrapper div with proper dimensions
      const wrapper = document.createElement('div')
      wrapper.style.position = 'absolute'
      wrapper.style.left = '-9999px'
      wrapper.style.width = `${contentWidth + THUMBNAIL.PADDING * 2}px`
      wrapper.style.height = `${contentHeight + THUMBNAIL.PADDING * 2}px`
      wrapper.style.backgroundColor = THUMBNAIL.BACKGROUND_COLOR
      wrapper.style.overflow = 'hidden'

      // Setup cloned content
      clonedContent.style.position = 'absolute'
      clonedContent.style.transform = 'none'
      clonedContent.style.transformOrigin = '0 0'
      clonedContent.style.left = '0px'
      clonedContent.style.top = '0px'

      // Adjust children positions
      const children = Array.from(clonedContent.children) as HTMLElement[]
      children.forEach(child => {
        const childLeft = parseFloat(child.style.left) || 0
        const childTop = parseFloat(child.style.top) || 0
        child.style.left = `${childLeft - minX + THUMBNAIL.PADDING}px`
        child.style.top = `${childTop - minY + THUMBNAIL.PADDING}px`
      })

      wrapper.appendChild(clonedContent)
      document.body.appendChild(wrapper)

      try {
        // Capture the rendered content
        const canvasElement = await html2canvas(wrapper, {
          backgroundColor: THUMBNAIL.BACKGROUND_COLOR,
          scale: 1,
          logging: false,
          useCORS: true,
          allowTaint: true,
        })

        // Calculate scale to fit thumbnail (0.95 to leave small margin)
        const scale = Math.min(
          THUMBNAIL.WIDTH / canvasElement.width,
          THUMBNAIL.HEIGHT / canvasElement.height
        ) * 0.95

        const x = (THUMBNAIL.WIDTH - canvasElement.width * scale) / 2
        const y = (THUMBNAIL.HEIGHT - canvasElement.height * scale) / 2

        ctx.drawImage(canvasElement, x, y, canvasElement.width * scale, canvasElement.height * scale)

        // Draw connections manually
        if (currentConnections.size > 0) {
          ctx.save()
          ctx.translate(x, y)
          ctx.scale(scale, scale)

          currentConnections.forEach((conn) => {
            const fromNode = currentNodes.get(conn.fromNodeId)
            const toNode = currentNodes.get(conn.toNodeId)
            if (!fromNode || !toNode) return

            // Calculate positions in thumbnail coordinates
            const fromX = fromNode.x - minX + THUMBNAIL.PADDING
            const fromY = fromNode.y - minY + THUMBNAIL.PADDING
            const toX = toNode.x - minX + THUMBNAIL.PADDING
            const toY = toNode.y - minY + THUMBNAIL.PADDING

            // Get port positions
            const fromPort = getConnectionPort(conn, 'start')
            const toPort = getConnectionPort(conn, 'end')
            const fromPos = getPortPosition(fromNode, fromPort)
            const toPos = getPortPosition(toNode, toPort)

            // Adjust port positions for thumbnail
            const startX = fromPos.x - minX + THUMBNAIL.PADDING
            const startY = fromPos.y - minY + THUMBNAIL.PADDING
            const endX = toPos.x - minX + THUMBNAIL.PADDING
            const endY = toPos.y - minY + THUMBNAIL.PADDING

            // Set line style
            ctx.strokeStyle = conn.color
            ctx.lineWidth = conn.width
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

            // Draw connection based on type
            ctx.beginPath()
            if (conn.type === 'straight') {
              ctx.moveTo(startX, startY)
              ctx.lineTo(endX, endY)
            } else if (conn.type === 'curve') {
              const midX = (startX + endX) / 2
              const midY = (startY + endY) / 2
              const dx = endX - startX
              const dy = endY - startY
              const controlX = midX - dy * 0.2
              const controlY = midY + dx * 0.2
              ctx.quadraticCurveTo(controlX, controlY, endX, endY)
            } else if (conn.type === 'step') {
              const midX = (startX + endX) / 2
              ctx.moveTo(startX, startY)
              ctx.lineTo(midX, startY)
              ctx.lineTo(midX, endY)
              ctx.lineTo(endX, endY)
            }
            ctx.stroke()

            // Draw arrows
            if (conn.arrowType !== 'none') {
              const drawArrow = (fromX: number, fromY: number, toX: number, toY: number) => {
                const angle = Math.atan2(toY - fromY, toX - fromX)
                const arrowLength = 10
                const arrowWidth = 5

                ctx.beginPath()
                ctx.moveTo(toX, toY)
                ctx.lineTo(
                  toX - arrowLength * Math.cos(angle - Math.PI / 6),
                  toY - arrowLength * Math.sin(angle - Math.PI / 6)
                )
                ctx.lineTo(
                  toX - arrowLength * Math.cos(angle + Math.PI / 6),
                  toY - arrowLength * Math.sin(angle + Math.PI / 6)
                )
                ctx.closePath()
                ctx.fillStyle = conn.color
                ctx.fill()
              }

              if (conn.arrowType === 'end' || conn.arrowType === 'both') {
                drawArrow(startX, startY, endX, endY)
              }
              if (conn.arrowType === 'start' || conn.arrowType === 'both') {
                drawArrow(endX, endY, startX, startY)
              }
            }
          })

          ctx.restore()
        }

        const thumbnailDataUrl = thumbnailCanvas.toDataURL('image/jpeg', THUMBNAIL.QUALITY)

        try {
          await updateCanvasInStore(canvasId, { thumbnail: thumbnailDataUrl }, true)
        } catch (error) {
          // Silently fail for thumbnail generation errors
        }
      } finally {
        // Clean up the temporary wrapper
        document.body.removeChild(wrapper)
      }
    } catch (error) {
      // Log thumbnail generation errors for debugging
      console.error('Thumbnail generation error:', error)
    }
  }, [])

  // Debounced thumbnail generation to avoid excessive updates
  const thumbnailTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const triggerThumbnailGeneration = useCallback((canvasId: number) => {
    if (thumbnailTimeoutRef.current) {
      clearTimeout(thumbnailTimeoutRef.current)
    }
    thumbnailTimeoutRef.current = setTimeout(() => {
      generateThumbnail(canvasId)
    }, THUMBNAIL.DEBOUNCE_DELAY)
  }, [generateThumbnail])

  // Log canvas page lifecycle
  useEffect(() => {
    return () => {
      // Cleanup thumbnail timeout
      if (thumbnailTimeoutRef.current) {
        clearTimeout(thumbnailTimeoutRef.current)
      }
    }
  }, [canvasId])

  // Auto-save to localStorage (debounced)
  useEffect(() => {
    if (!canvasId || !isDirty) return

    const id = parseInt(canvasId)

    if (cacheTimeoutRef.current) {
      clearTimeout(cacheTimeoutRef.current)
    }

    cacheTimeoutRef.current = setTimeout(() => {
      const state = useCanvasStore.getState()
      const { nodes, groups, domains, connections } = collectCanvasData(state)
      saveToCache(id, { nodes, groups, domains, connections })
    }, CACHE_SAVE_DELAY)
  }, [canvasId, isDirty, nodes, groups, domains, connections])

  // Periodic save to database
  useEffect(() => {
    if (!canvasId) return

    const id = parseInt(canvasId)

    const saveToDatabase = async () => {
      const currentState = useCanvasStore.getState()
      const currentIsDirty = currentState.isDirty
      const currentLastSaveTime = lastSaveTimeRef.current

      if (!currentIsDirty) {
        dbSaveTimeoutRef.current = setTimeout(saveToDatabase, AUTO_SAVE_INTERVAL)
        return
      }

      const now = Date.now()
      if (now - currentLastSaveTime < AUTO_SAVE_INTERVAL) {
        dbSaveTimeoutRef.current = setTimeout(saveToDatabase, AUTO_SAVE_INTERVAL)
        return
      }

      try {
        const { nodes, groups, domains, connections } = collectCanvasData(currentState)

        await saveCanvasNodesData(id, { nodes, groups, domains, connections })

        lastSaveTimeRef.current = now
        setDirty(false)

        // Generate thumbnail after successful auto-save
        if (hasCanvasContent(nodes, domains)) {
          await triggerThumbnailGeneration(id)
        }
      } catch (error) {
        // Error handled by toast
      }

      dbSaveTimeoutRef.current = setTimeout(saveToDatabase, AUTO_SAVE_INTERVAL)
    }

    dbSaveTimeoutRef.current = setTimeout(saveToDatabase, AUTO_SAVE_INTERVAL)

    return () => {
      if (dbSaveTimeoutRef.current) {
        clearTimeout(dbSaveTimeoutRef.current)
      }
    }
  }, [canvasId, setDirty])

  // Handle space key for panning
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        setIsSpacePressed(true)
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setIsSpacePressed(false)
        setIsDragging(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [])

  // Manual save function
  const handleManualSave = useCallback(async () => {
    if (!canvasId) {
      return
    }

    const id = parseInt(canvasId)
    if (isNaN(id)) {
      return
    }

    const currentState = useCanvasStore.getState()
    const { nodes, groups, domains, connections } = collectCanvasData(currentState)

    await saveCanvasNodesData(id, { nodes, groups, domains, connections })

    const now = Date.now()
    lastSaveTimeRef.current = now
    setDirty(false)

    // Generate thumbnail immediately when manually saving
    if (hasCanvasContent(nodes, domains)) {
      await generateThumbnail(id)
    }
  }, [canvasId, setDirty, generateThumbnail])

  // Handle page refresh/close - save data immediately before unloading
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!canvasId) return

      const id = parseInt(canvasId)
      if (isNaN(id)) return

      const state = useCanvasStore.getState()

      if (state.isDirty) {
        e.preventDefault()
        e.returnValue = ''

        const { nodes, groups, domains, connections } = collectCanvasData(state)

        try {
          saveToCache(id, { nodes, groups, domains, connections })
        } catch (error) {
          // Silently fail for cache save errors
        }

        try {
          const token = localStorage.getItem('mindmap_token')

          fetch(`/api/canvases/${id}/data`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({ nodes, groups, domains, connections }),
            keepalive: true,
          }).catch(() => {
            // Silently fail for fetch errors
          })
        } catch (error) {
          // Silently fail for fetch errors
        }

        // Generate thumbnail when page is being unloaded
        if (hasCanvasContent(nodes, domains)) {
          triggerThumbnailGeneration(id)
        }
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      // Generate thumbnail on component unmount (when navigating away)
      if (canvasId) {
        const id = parseInt(canvasId)
        if (!isNaN(id)) {
          const state = useCanvasStore.getState()
          const { nodes, domains } = collectCanvasData(state)

          if (hasCanvasContent(nodes, domains)) {
            triggerThumbnailGeneration(id)
          }
        }
      }

      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [canvasId, triggerThumbnailGeneration])

  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        const width = containerRef.current.clientWidth
        const height = containerRef.current.clientHeight
        setContainerSize({ width, height })
        if (width > 0 && height > 0) {
          setContainerReady(true)
        }
      }
    }

    let retryCount = 0
    const maxRetries = 10

    const attemptMeasurement = () => {
      updateSize()

      if (!containerRef.current || (containerRef.current && (containerRef.current.clientWidth === 0 || containerRef.current.clientHeight === 0))) {
        if (retryCount < maxRetries) {
          retryCount++
          setTimeout(attemptMeasurement, 100)
        }
      }
    }

    attemptMeasurement()

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        requestAnimationFrame(updateSize)
      }
    })

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current)
    }

    window.addEventListener('resize', updateSize)

    return () => {
      window.removeEventListener('resize', updateSize)
      resizeObserver.disconnect()
    }
  }, [])

  // Update container size when sidebar state changes
  useEffect(() => {
    const timer = setTimeout(() => {
      if (containerRef.current) {
        setContainerSize({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        })
      }
    }, 250)

    return () => clearTimeout(timer)
  }, [nodePoolOpen, sidebarOpen])

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle shortcuts when typing in input fields
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return
      }

      // Tool shortcuts
      if (e.key === 'v' || e.key === 'V') {
        setCurrentTool('select')
      } else if (e.key === 'n' || e.key === 'N') {
        setCurrentTool('node')
      } else if (e.key === 'r' || e.key === 'R') {
        setCurrentTool('domain')
      } else if (e.key === 'l' || e.key === 'L') {
        setCurrentTool('connection')
      } else if (e.key === 'g' || e.key === 'G') {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault()
          if (selectedIds.length > 0) {
            const selectedNodes = selectedIds.map(id => nodes.get(id)).filter(Boolean)
            if (selectedNodes.length > 0) {
              let minX = Infinity
              let minY = Infinity
              let maxX = -Infinity
              let maxY = -Infinity

              selectedNodes.forEach(node => {
                minX = Math.min(minX, node.x)
                minY = Math.min(minY, node.y)
                maxX = Math.max(maxX, node.x + node.width)
                maxY = Math.max(maxY, node.y + node.height)
              })

              const newGroup = {
                id: generateId('group'),
                name: `组 ${groups.size + 1}`,
                x: minX - 10,
                y: minY - 10,
                width: maxX - minX + 20,
                height: maxY - minY + 20,
                borderColor: '#3b82f6',
                backgroundColor: 'rgba(59, 130, 246, 0.1)',
                borderWidth: 2,
                borderRadius: 8,
                nodeIds: selectedIds,
                collapsed: false,
              }
              addGroup(newGroup)
            }
          }
        } else {
          setCurrentTool('group')
        }
      } else if (e.key === 'h' || e.key === 'H') {
        toggleGrid()
      } else if (e.key === 'Escape') {
        // 退出域编辑模式
        if (domainEditMode) {
          setDomainEditMode(false)
        }
        setCurrentTool('select')
        setEditingId(null)
        setIsCreatingConnection(false)
        setConnectionStartNodeId(null)
      }

      if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault()
        setZoom(1)
        setPan(0, 0)
      } else if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        setZoom(Math.min(zoom + 0.1, 5))
      } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault()
        setZoom(Math.max(zoom - 0.1, 0.1))
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [zoom, setCurrentTool, setZoom, setPan, toggleGrid, setEditingId, nodes, groups, selectedIds, addGroup])

  // Handle click outside to end group name editing
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (editingId) {
        const target = e.target as HTMLElement
        if (target.tagName !== 'INPUT') {
          const group = groups.get(editingId)
          if (group && editingGroupName !== group.name) {
            updateGroupWithoutHistory(editingId, { name: editingGroupName })
          }
          setEditingId(null)
        }
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [editingId, editingGroupName, groups, updateGroup, setEditingId])

  // Handle connection start event from NodeItem
  useEffect(() => {
    const handleConnectionStart = (e: Event) => {
      const customEvent = e as CustomEvent<{ nodeId: string; mouseX: number; mouseY: number }>
      const { nodeId, mouseX, mouseY } = customEvent.detail

      if (justFinishedConnectionRef.current) {
        return
      }

      const node = nodes.get(nodeId)
      if (node) {
        setIsCreatingConnection(true)
        setConnectionStartNodeId(nodeId)

        const rect = containerRef.current?.getBoundingClientRect()
        if (rect) {
          const canvasMouseX = (mouseX - rect.left - panX) / zoom
          const canvasMouseY = (mouseY - rect.top - panY) / zoom
          const bestPort = findBestPort(node, canvasMouseX, canvasMouseY)
          setConnectionStartPort(bestPort)

          const portPosition = getPortPosition(node, bestPort)
          setConnectionEndPosition(portPosition)
        }
      }
    }

    window.addEventListener('connectionStart', handleConnectionStart)
    return () => {
      window.removeEventListener('connectionStart', handleConnectionStart)
    }
  }, [nodes, panX, panY, zoom])

  // Handle mouse down for drag panning and connection creation
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect()
    const mouseX = rect ? e.clientX - rect.left : 0
    const mouseY = rect ? e.clientY - rect.top : 0
    const canvasX = (mouseX - panX) / zoom
    const canvasY = (mouseY - panY) / zoom

    mouseDownOnContentRef.current = false
    justFinishedConnectionRef.current = false
    justFinishedBoxSelectingRef.current = false
    justFinishedEndpointDraggingRef.current = false

    const target = e.target as HTMLElement
    const clickedOnNode = target.closest('.node-item')
    const clickedOnGroup = target.closest('[data-group-id]')
    const clickedOnDomain = target.closest('[data-domain-id]')
    const clickedOnInteractive = target.closest('button') || target.closest('[role="button"]') || target.closest('input') || target.closest('textarea')
    // Check if clicking on SVG connection endpoint circles (both visible circles and invisible hit circles)
    const fill = target.getAttribute('fill')
    const r = target.getAttribute('r')

    // Also check if click position is near any endpoint of selected connections
    let clickedNearEndpoint = false
    let clickedEndpointConnId: string | null = null
    let clickedEndpointType: 'start' | 'end' | null = null

    // Optimize: Only check selected connections first (most common case)
    // If target is a line, also check that specific connection to handle async state updates
    const targetConnId = target.tagName === 'line' || target.tagName === 'path'
      ? (target as HTMLElement).getAttribute('data-connection-id')
      : null

    const connectionsToCheck = targetConnId
      ? [connections.get(targetConnId)].filter(Boolean)
      : Array.from(connections.values()).filter(conn => selectedIds.includes(conn.id))

    for (const conn of connectionsToCheck) {
      if (!conn) continue

      const fromNode = nodes.get(conn.fromNodeId)
      const toNode = nodes.get(conn.toNodeId)
      if (!fromNode || !toNode) continue

      const fromPos = getPortPosition(fromNode, getConnectionPort(conn, 'start'))
      const toPos = getPortPosition(toNode, getConnectionPort(conn, 'end'))

      const distFromStart = Math.sqrt((canvasX - fromPos.x) ** 2 + (canvasY - fromPos.y) ** 2)
      const distFromEnd = Math.sqrt((canvasX - toPos.x) ** 2 + (canvasY - toPos.y) ** 2)

      if (distFromStart <= 15) {
        clickedNearEndpoint = true
        clickedEndpointConnId = conn.id
        clickedEndpointType = 'start'
        break
      } else if (distFromEnd <= 15) {
        clickedNearEndpoint = true
        clickedEndpointConnId = conn.id
        clickedEndpointType = 'end'
        break
      }
    }

    const clickedOnConnectionEndpoint =
      target.tagName === 'circle' &&
      ((fill === 'none' && target.getAttribute('stroke') === '#3b82f6' && r === '8') || // Visible endpoint circle
        (fill?.startsWith('rgba') && r === '12')) || // Invisible hit circle (fallback if stopPropagation fails)
      clickedNearEndpoint

    // Handle endpoint dragging (even if connection is not yet selected)
    if (clickedNearEndpoint && clickedEndpointConnId && clickedEndpointType) {
      e.preventDefault()
      e.stopPropagation()

      // First, select the connection if it's not already selected
      if (!selectedIds.includes(clickedEndpointConnId)) {
        setSelectedIds([clickedEndpointConnId])
        setSelectedType('connection')
        openStylePanel()
      }

      setIsDraggingConnectionEndpoint(true)
      setDraggingConnectionId(clickedEndpointConnId)
      setDraggingEndpoint(clickedEndpointType)

      const conn = connections.get(clickedEndpointConnId)
      if (conn) {
        const node = clickedEndpointType === 'start'
          ? nodes.get(conn.fromNodeId)
          : nodes.get(conn.toNodeId)
        if (node) {
          const port = getConnectionPort(conn, clickedEndpointType)
          const pos = getPortPosition(node, port)
          setEditingEndpointPosition(pos)
        }
      }
      return
    }

    // Clear editing state if clicking on empty canvas or non-node element
    if (editingId && !clickedOnNode && !clickedOnInteractive && !clickedOnConnectionEndpoint) {
      setEditingId(null)
    }

    // Right click (button 2) - pan canvas
    if (e.button === 2) {
      e.preventDefault()
      setIsDragging(true)
      dragStartRef.current = { x: e.clientX, y: e.clientY }
      panStartRef.current = { x: panX, y: panY }
      return
    }

    // Middle click (button 1) or space+click - pan canvas
    if (e.button === 1 || (e.button === 0 && isSpacePressed)) {
      e.preventDefault()
      setIsDragging(true)
      dragStartRef.current = { x: e.clientX, y: e.clientY }
      panStartRef.current = { x: panX, y: panY }
      return
    }

    // Left click (button 0) with pan tool - pan canvas
    if (e.button === 0 && currentTool === 'pan') {
      e.preventDefault()
      setIsDragging(true)
      dragStartRef.current = { x: e.clientX, y: e.clientY }
      panStartRef.current = { x: panX, y: panY }
      return
    }

    // Left click with group tool - create group
    if (currentTool === 'group' && e.button === 0 && !clickedOnGroup) {
      e.preventDefault()
      const rect = containerRef.current?.getBoundingClientRect()
      if (rect) {
        const mouseX = e.clientX - rect.left
        const mouseY = e.clientY - rect.top
        const canvasX = (mouseX - panX) / zoom
        const canvasY = (mouseY - panY) / zoom
        setIsCreatingGroup(true)
        setGroupStartPos({ x: canvasX, y: canvasY })
        setGroupEndPos({ x: canvasX, y: canvasY })
      }
      return
    }

    // Left click with default selection tool and not on interactive elements - box selection
    if (e.button === 0 && isDefaultSelectionTool(currentTool) && !clickedOnNode && !clickedOnGroup && !clickedOnInteractive && !clickedOnConnectionEndpoint) {
      e.preventDefault()
      const rect = containerRef.current?.getBoundingClientRect()
      if (rect) {
        const mouseX = e.clientX - rect.left
        const mouseY = e.clientY - rect.top
        const canvasX = (mouseX - panX) / zoom
        const canvasY = (mouseY - panY) / zoom
        setIsBoxSelecting(true)
        setBoxSelectionStart({ x: canvasX, y: canvasY })
        setBoxSelectionEnd({ x: canvasX, y: canvasY })
        // Clear selection when starting box selection (unless shift/ctrl/meta is held)
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
          setSelectedIds([])
        }
      }
      return
    }

    // Domain tool - start domain box selection
    if (e.button === 0 && currentTool === 'domain' && !clickedOnNode && !clickedOnGroup && !clickedOnInteractive && !clickedOnConnectionEndpoint) {
      e.preventDefault()
      const rect = containerRef.current?.getBoundingClientRect()
      if (rect) {
        const mouseX = e.clientX - rect.left
        const mouseY = e.clientY - rect.top
        const canvasX = (mouseX - panX) / zoom
        const canvasY = (mouseY - panY) / zoom
        setIsCreatingDomain(true)
        setDomainBoxStart({ x: canvasX, y: canvasY })
        setDomainBoxEnd({ x: canvasX, y: canvasY })
      }
      return
    }
  }, [isSpacePressed, currentTool, panX, panY, zoom, setSelectedIds, editingId, setEditingId])

  // Handle mouse move for drag panning and connection creation
  const handleMouseMove = useCallback(async (e: React.MouseEvent) => {
    if (isDragging) {
      const dx = e.clientX - dragStartRef.current.x
      const dy = e.clientY - dragStartRef.current.y
      setPan(panStartRef.current.x + dx, panStartRef.current.y + dy)
    } else if (isBoxSelecting && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top
      const canvasX = (mouseX - panX) / zoom
      const canvasY = (mouseY - panY) / zoom
      setBoxSelectionEnd({ x: canvasX, y: canvasY })
    } else if (isCreatingDomain && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top
      const canvasX = (mouseX - panX) / zoom
      const canvasY = (mouseY - panY) / zoom
      setDomainBoxEnd({ x: canvasX, y: canvasY })
    } else if (isDraggingGroup && draggingGroupId && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top
      const canvasX = (mouseX - panX) / zoom
      const canvasY = (mouseY - panY) / zoom

      const dx = canvasX - groupDragStart.x
      const dy = canvasY - groupDragStart.y

      // Only update local offset state, not the store
      setGroupDragOffset({ x: dx, y: dy })
    } else if (isResizingGroup && resizingGroupId && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top
      const canvasX = (mouseX - panX) / zoom
      const canvasY = (mouseY - panY) / zoom

      const group = groups.get(resizingGroupId)
      if (group && resizeInitialGroup) {
        const dx = canvasX - resizeStart.x
        const dy = canvasY - resizeStart.y

        let newX = resizeInitialGroup.x
        let newY = resizeInitialGroup.y
        let newWidth = resizeInitialGroup.width
        let newHeight = resizeInitialGroup.height

        switch (resizeHandle) {
          case 'se':
            newWidth = Math.max(100, resizeInitialGroup.width + dx)
            newHeight = Math.max(100, resizeInitialGroup.height + dy)
            break
          case 'sw':
            newX = resizeInitialGroup.x + dx
            newWidth = Math.max(100, resizeInitialGroup.width - dx)
            newHeight = Math.max(100, resizeInitialGroup.height + dy)
            break
          case 'ne':
            newY = resizeInitialGroup.y + dy
            newWidth = Math.max(100, resizeInitialGroup.width + dx)
            newHeight = Math.max(100, resizeInitialGroup.height - dy)
            break
          case 'nw':
            newX = resizeInitialGroup.x + dx
            newY = resizeInitialGroup.y + dy
            newWidth = Math.max(100, resizeInitialGroup.width - dx)
            newHeight = Math.max(100, resizeInitialGroup.height - dy)
            break
        }

        const scaleX = newWidth / resizeInitialGroup.width
        const scaleY = newHeight / resizeInitialGroup.height

        updateGroup(resizingGroupId, {
          x: newX,
          y: newY,
          width: newWidth,
          height: newHeight,
        })

        group.nodeIds.forEach(nodeId => {
          const node = nodes.get(nodeId)
          const nodeInitialPos = resizeInitialNodePositions.get(nodeId)
          if (node && nodeInitialPos) {
            const { updateNode } = useCanvasStore.getState()
            updateNode(nodeId, {
              x: nodeInitialPos.x,
              y: nodeInitialPos.y,
              width: nodeInitialPos.width,
              height: nodeInitialPos.height,
            })
          }
        })
      }
    } else if (isCreatingGroup && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top
      const canvasX = (mouseX - panX) / zoom
      const canvasY = (mouseY - panY) / zoom
      setGroupEndPos({ x: canvasX, y: canvasY })
    } else if (isCreatingConnection && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top
      const canvasMouseX = (mouseX - panX) / zoom
      const canvasMouseY = (mouseY - panY) / zoom

      const nearest = findNearestPort(nodes, canvasMouseX, canvasMouseY, connectionStartNodeId || undefined)
      if (nearest) {
        setSnappedPort(nearest)
        setConnectionEndPosition(nearest.position)
      } else {
        setSnappedPort(null)
        setConnectionEndPosition({
          x: canvasMouseX,
          y: canvasMouseY,
        })
      }
    } else if (isDraggingConnectionEndpoint && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top
      const canvasMouseX = (mouseX - panX) / zoom
      const canvasMouseY = (mouseY - panY) / zoom

      const connection = connections.get(draggingConnectionId || '')
      const excludeNodeId = draggingEndpoint === 'start' ? connection?.toNodeId : connection?.fromNodeId
      const nearest = findNearestPort(nodes, canvasMouseX, canvasMouseY, excludeNodeId)
      if (nearest) {
        setSnappedPort(nearest)
        setEditingEndpointPosition(nearest.position)
      } else {
        setSnappedPort(null)
        setEditingEndpointPosition({
          x: canvasMouseX,
          y: canvasMouseY,
        })
      }
    } else if (isDraggingBendPoint && draggingBendPointId && draggingConnectionId && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top
      const canvasX = (mouseX - panX) / zoom
      const canvasY = (mouseY - panY) / zoom

      const { updateConnectionBendPoint } = useCanvasStore.getState()
      updateConnectionBendPoint(draggingConnectionId, draggingBendPointId, canvasX, canvasY)
    }

    // Check if mouse is near any endpoint of selected connections to update cursor
    if (containerRef.current && !isDragging && !isBoxSelecting && !isCreatingConnection && !isDraggingConnectionEndpoint && !isResizingGroup && !isCreatingGroup && !isDraggingGroup && !isDraggingBendPoint) {
      const rect = containerRef.current.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top
      const canvasX = (mouseX - panX) / zoom
      const canvasY = (mouseY - panY) / zoom

      let isNearEndpoint = false
      for (const conn of connections.values()) {
        if (selectedIds.includes(conn.id)) {
          const fromNode = nodes.get(conn.fromNodeId)
          const toNode = nodes.get(conn.toNodeId)
          if (fromNode && toNode) {
            const fromPos = getPortPosition(fromNode, getConnectionPort(conn, 'start'))
            const toPos = getPortPosition(toNode, getConnectionPort(conn, 'end'))

            const distFromStart = Math.sqrt((canvasX - fromPos.x) ** 2 + (canvasY - fromPos.y) ** 2)
            const distFromEnd = Math.sqrt((canvasX - toPos.x) ** 2 + (canvasY - toPos.y) ** 2)

            if (distFromStart <= 15 || distFromEnd <= 15) {
              isNearEndpoint = true
              break
            }
          }
        }
      }

      setCustomCursor(isNearEndpoint ? 'crosshair' : null)
    }
  }, [isDragging, isBoxSelecting, isCreatingDomain, isCreatingConnection, isDraggingConnectionEndpoint, isDraggingBendPoint, isResizingGroup, isCreatingGroup, panX, panY, zoom, setPan, nodes, connectionStartNodeId, draggingConnectionId, draggingEndpoint, draggingBendPointId, connections, isDraggingGroup, draggingGroupId, groups, groupDragStart, groupInitialPositions, initialGroupNodeIds, groupDragInitialGroupPos, resizeHandle, resizeStart, resizeInitialGroup, resizeInitialNodePositions, updateGroup, resizingGroupId, currentTool, selectedIds, customCursor, setCustomCursor])

  // Handle mouse up
  const handleMouseUp = useCallback(async (e: React.MouseEvent) => {
    setIsDragging(false)

    if (isBoxSelecting) {
      setIsBoxSelecting(false)

      // Calculate selection box
      const minX = Math.min(boxSelectionStart.x, boxSelectionEnd.x)
      const minY = Math.min(boxSelectionStart.y, boxSelectionEnd.y)
      const maxX = Math.max(boxSelectionStart.x, boxSelectionEnd.x)
      const maxY = Math.max(boxSelectionStart.y, boxSelectionEnd.y)

      // Ignore very small selections (likely just clicks)
      if (maxX - minX < 5 && maxY - minY < 5) {
        setBoxSelectionStart({ x: 0, y: 0 })
        setBoxSelectionEnd({ x: 0, y: 0 })
        return
      }

      // Find all nodes and groups that intersect with the selection box
      const newSelections: string[] = []

      // Check nodes
      nodes.forEach((node) => {
        // Check if node intersects with selection box
        const nodeIntersects = !(
          node.x > maxX ||
          node.x + node.width < minX ||
          node.y > maxY ||
          node.y + node.height < minY
        )

        if (nodeIntersects) {
          newSelections.push(node.id)
        }
      })

      // Check groups
      groups.forEach((group) => {
        // Check if group intersects with selection box
        const groupIntersects = !(
          group.x > maxX ||
          group.x + group.width < minX ||
          group.y > maxY ||
          group.y + group.height < minY
        )

        if (groupIntersects) {
          newSelections.push(group.id)
        }
      })

      // Update selection
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        // Add to existing selection
        newSelections.forEach(id => addToSelection(id))
      } else {
        // Replace selection
        setSelectedIds(newSelections)
      }

      setBoxSelectionStart({ x: 0, y: 0 })
      setBoxSelectionEnd({ x: 0, y: 0 })

      // Mark that we just finished box selection
      justFinishedBoxSelectingRef.current = true
      setTimeout(() => {
        justFinishedBoxSelectingRef.current = false
      }, 100)

      return
    }

    // Domain creation (box selection style)
    if (isCreatingDomain) {
      setIsCreatingDomain(false)

      // Calculate domain box
      const minX = Math.min(domainBoxStart.x, domainBoxEnd.x)
      const minY = Math.min(domainBoxStart.y, domainBoxEnd.y)
      const maxX = Math.max(domainBoxStart.x, domainBoxEnd.x)
      const maxY = Math.max(domainBoxStart.y, domainBoxEnd.y)
      const width = maxX - minX
      const height = maxY - minY

      // Snap to grid (20px)
      const GRID_SIZE = 20
      const snappedX = Math.round(minX / GRID_SIZE) * GRID_SIZE
      const snappedY = Math.round(minY / GRID_SIZE) * GRID_SIZE
      const snappedWidth = Math.max(Math.round(width / GRID_SIZE) * GRID_SIZE, 40)
      const snappedHeight = Math.max(Math.round(height / GRID_SIZE) * GRID_SIZE, 40)

      // Ignore very small domains
      if (snappedWidth >= 40 && snappedHeight >= 40) {
        if (isDomainOverlapping(snappedX, snappedY, snappedWidth, snappedHeight, domains)) {
          addToast({
            type: 'error',
            title: '无法创建域',
            message: '域不能与其他域重叠',
            duration: 3000,
          })
          setDomainBoxStart({ x: 0, y: 0 })
          setDomainBoxEnd({ x: 0, y: 0 })
          return
        }

        const newDomain = {
          id: generateId('domain'),
          name: `域 ${domains.size + 1}`,
          x: snappedX,
          y: snappedY,
          width: snappedWidth,
          height: snappedHeight,
          backgroundColor: 'rgba(156, 163, 175, 0.2)',
          borderColor: '#9ca3af',
          borderWidth: 1,
          titleVisible: true,
        }
        addDomain(newDomain)
        // 自动切换回选择工具，避免连续创建
        setCurrentTool('select')
      }

      setDomainBoxStart({ x: 0, y: 0 })
      setDomainBoxEnd({ x: 0, y: 0 })
      return
    }

    if (isDraggingGroup) {
      // Execute command first, then clear states
      const currentDraggingGroupId = draggingGroupId
      const currentGroupDragInitialGroupPos = groupDragInitialGroupPos
      const currentGroupDragOffset = groupDragOffset
      const currentInitialGroupNodeIds = initialGroupNodeIds
      const currentGroupInitialPositions = groupInitialPositions

      setIsDraggingGroup(false)
      setDraggingGroupId(null)
      setGroupDragStart({ x: 0, y: 0 })
      setGroupInitialPositions(new Map())
      setInitialGroupNodeIds(new Set())
      setGroupDragInitialGroupPos(null)

      if (currentDraggingGroupId && currentGroupDragInitialGroupPos) {
        const { executeCommand } = useCanvasStore.getState()

        // Calculate final positions using offset
        const newGroupPos = {
          x: currentGroupDragInitialGroupPos.x + currentGroupDragOffset.x,
          y: currentGroupDragInitialGroupPos.y + currentGroupDragOffset.y,
        }

        const newNodePositions = new Map<string, { x: number; y: number }>()
        currentInitialGroupNodeIds.forEach(nodeId => {
          const nodeInitialPos = currentGroupInitialPositions.get(nodeId)
          if (nodeInitialPos) {
            newNodePositions.set(nodeId, {
              x: nodeInitialPos.x + currentGroupDragOffset.x,
              y: nodeInitialPos.y + currentGroupDragOffset.y,
            })
          }
        })

        const group = groups.get(currentDraggingGroupId)
        if (group) {
          const nodeIds = Array.from(nodes.values())
            .filter(node => isNodeInGroup(node, newGroupPos.x, newGroupPos.y, group.width, group.height))
            .map(node => node.id)

          executeCommand({
            type: 'updateGroup',
            timestamp: Date.now(),
            execute: () => {
              const state = useCanvasStore.getState()
              const groups = new Map(state.groups)
              const nodes = new Map(state.nodes)
              const group = groups.get(currentDraggingGroupId)
              if (group) {
                const updatedGroup = { ...group, x: newGroupPos.x, y: newGroupPos.y, nodeIds }
                groups.set(currentDraggingGroupId, updatedGroup)
                newNodePositions.forEach((pos, nodeId) => {
                  const node = nodes.get(nodeId)
                  if (node) {
                    nodes.set(nodeId, { ...node, x: pos.x, y: pos.y })
                  }
                })
                return { groups, nodes, isDirty: true }
              }
              return {}
            },
            undo: () => {
              const state = useCanvasStore.getState()
              const groups = new Map(state.groups)
              const nodes = new Map(state.nodes)
              const group = groups.get(currentDraggingGroupId)
              if (group) {
                const restoredGroup = { ...group, x: currentGroupDragInitialGroupPos.x, y: currentGroupDragInitialGroupPos.y, nodeIds: Array.from(currentInitialGroupNodeIds) }
                groups.set(currentDraggingGroupId, restoredGroup)
                currentInitialGroupNodeIds.forEach(nodeId => {
                  const nodeInitialPos = currentGroupInitialPositions.get(nodeId)
                  if (nodeInitialPos) {
                    const node = nodes.get(nodeId)
                    if (node) {
                      nodes.set(nodeId, { ...node, x: nodeInitialPos.x, y: nodeInitialPos.y })
                    }
                  }
                })
                return { groups, nodes, isDirty: true }
              }
              return {}
            },
          })

          // Reset offset after store is updated
          setTimeout(() => {
            setGroupDragOffset({ x: 0, y: 0 })
          }, 0)
        }
      } else {
        setGroupDragOffset({ x: 0, y: 0 })
      }
      return
    }

    if (isResizingGroup) {
      setIsResizingGroup(false)
      setResizingGroupId(null)
      setResizeHandle(null)
      setResizeStart({ x: 0, y: 0 })
      setResizeInitialGroup(null)
      setResizeInitialNodePositions(new Map())

      if (resizingGroupId) {
        const group = groups.get(resizingGroupId)
        if (group) {
          const nodeIds = Array.from(nodes.values())
            .filter(node => isNodeInGroup(node, group.x, group.y, group.width, group.height))
            .map(node => node.id)
          updateGroup(resizingGroupId, { nodeIds })
        }
      }
      return
    }

    if (isCreatingGroup) {
      const minX = Math.min(groupStartPos.x, groupEndPos.x)
      const minY = Math.min(groupStartPos.y, groupEndPos.y)
      const maxX = Math.max(groupStartPos.x, groupEndPos.x)
      const maxY = Math.max(groupStartPos.y, groupEndPos.y)
      const width = maxX - minX
      const height = maxY - minY

      if (width > 10 && height > 10) {
        const nodeIds = Array.from(nodes.values())
          .filter(node => isNodeInGroup(node, minX, minY, width, height))
          .map(node => node.id)

        // 允许创建空组（即使没有选中节点）
        const newGroup = {
          id: generateId('group'),
          name: `组 ${groups.size + 1}`,
          x: minX,
          y: minY,
          width,
          height,
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          borderWidth: 2,
          borderRadius: 8,
          nodeIds,
          collapsed: false,
        }
        addGroup(newGroup)
        // 自动切换回选择工具，避免连续创建
        setCurrentTool('select')
      }

      setIsCreatingGroup(false)
      setGroupStartPos({ x: 0, y: 0 })
      setGroupEndPos({ x: 0, y: 0 })
      return
    }

    if (isCreatingConnection && connectionStartNodeId && connectionStartPort) {
      if (snappedPort && snappedPort.nodeId !== connectionStartNodeId) {
        const existingConnection = Array.from(connections.values()).find(
          conn =>
            (conn.fromNodeId === connectionStartNodeId && conn.toNodeId === snappedPort.nodeId) ||
            (conn.fromNodeId === snappedPort.nodeId && conn.toNodeId === connectionStartNodeId)
        )

        if (existingConnection) {
          updateConnection(existingConnection.id, {
            fromNodeId: connectionStartNodeId,
            fromPort: connectionStartPort,
            toNodeId: snappedPort.nodeId,
            toPort: snappedPort.port,
            style: connectionStyle,
            arrowType: connectionDirection === 'bidirectional' ? 'both' : connectionDirection === 'undirected' ? 'none' : 'end',
            direction: connectionDirection,
          })
        } else {
          const newConnection: Connection = {
            id: generateId('connection'),
            fromNodeId: connectionStartNodeId,
            toNodeId: snappedPort.nodeId,
            fromPort: connectionStartPort,
            toPort: snappedPort.port,
            type: connectionType,
            style: connectionStyle,
            color: CONNECTION_DEFAULTS.COLOR,
            width: CONNECTION_DEFAULTS.WIDTH,
            arrowType: connectionDirection === 'bidirectional' ? 'both' : connectionDirection === 'undirected' ? 'none' : 'end',
            direction: connectionDirection,
          }
          addConnection(newConnection)
        }
      } else {
        const target = e.target as HTMLElement
        const clickedOnNode = target.closest('.node-item')
        const nodeId = clickedOnNode?.getAttribute('data-node-id')

        if (nodeId && nodeId !== connectionStartNodeId) {
          const toNode = nodes.get(nodeId)
          if (toNode) {
            const rect = containerRef.current?.getBoundingClientRect()
            let toPort: 'top' | 'right' | 'bottom' | 'left' = 'top'
            if (rect) {
              const canvasMouseX = (e.clientX - rect.left - panX) / zoom
              const canvasMouseY = (e.clientY - rect.top - panY) / zoom
              toPort = findBestPort(toNode, canvasMouseX, canvasMouseY)
            }

            const existingConnection = Array.from(connections.values()).find(
              conn =>
                (conn.fromNodeId === connectionStartNodeId && conn.toNodeId === nodeId) ||
                (conn.fromNodeId === nodeId && conn.toNodeId === connectionStartNodeId)
            )

            if (existingConnection) {
              updateConnection(existingConnection.id, {
                fromNodeId: connectionStartNodeId,
                fromPort: connectionStartPort,
                toNodeId: nodeId,
                toPort: toPort,
                style: connectionStyle,
                arrowType: connectionDirection === 'bidirectional' ? 'both' : connectionDirection === 'undirected' ? 'none' : 'end',
                direction: connectionDirection,
              })
            } else {
              const newConnection: Connection = {
                id: generateId('connection'),
                fromNodeId: connectionStartNodeId,
                toNodeId: nodeId,
                fromPort: connectionStartPort,
                toPort: toPort,
                type: connectionType,
                style: connectionStyle,
                color: CONNECTION_DEFAULTS.COLOR,
                width: CONNECTION_DEFAULTS.WIDTH,
                arrowType: connectionDirection === 'bidirectional' ? 'both' : connectionDirection === 'undirected' ? 'none' : 'end',
                direction: connectionDirection,
              }
              addConnection(newConnection)
            }
          }
        }
      }

      setIsCreatingConnection(false)
      setConnectionStartNodeId(null)
      setConnectionStartPort(null)
      setSnappedPort(null)
      justFinishedConnectionRef.current = true
      setTimeout(() => {
        justFinishedConnectionRef.current = false
      }, 100)
      return
    }

    if (isDraggingConnectionEndpoint && draggingConnectionId && draggingEndpoint) {
      const connection = connections.get(draggingConnectionId)
      if (!connection) {
        setIsDraggingConnectionEndpoint(false)
        setDraggingConnectionId(null)
        setDraggingEndpoint(null)
        setSnappedPort(null)
        return
      }

      let newFromNodeId = connection.fromNodeId
      let newFromPort = connection.fromPort
      let newToNodeId = connection.toNodeId
      let newToPort = connection.toPort

      if (snappedPort) {
        if (draggingEndpoint === 'start') {
          newFromNodeId = snappedPort.nodeId
          newFromPort = snappedPort.port
        } else {
          newToNodeId = snappedPort.nodeId
          newToPort = snappedPort.port
        }
      } else {
        const target = e.target as HTMLElement
        const clickedOnNode = target.closest('.node-item')
        const nodeId = clickedOnNode?.getAttribute('data-node-id')

        if (nodeId) {
          const node = nodes.get(nodeId)
          if (node) {
            const rect = containerRef.current?.getBoundingClientRect()
            let newPort: 'top' | 'right' | 'bottom' | 'left' = 'top'
            if (rect) {
              const canvasMouseX = (e.clientX - rect.left - panX) / zoom
              const canvasMouseY = (e.clientY - rect.top - panY) / zoom
              newPort = findBestPort(node, canvasMouseX, canvasMouseY)
            }

            if (draggingEndpoint === 'start') {
              newFromNodeId = nodeId
              newFromPort = newPort
            } else {
              newToNodeId = nodeId
              newToPort = newPort
            }
          }
        }
      }

      const existingConnection = Array.from(connections.values()).find(
        conn =>
          conn.id !== draggingConnectionId &&
          ((conn.fromNodeId === newFromNodeId && conn.toNodeId === newToNodeId) ||
            (conn.fromNodeId === newToNodeId && conn.toNodeId === newFromNodeId))
      )

      if (existingConnection) {
        updateConnection(existingConnection.id, {
          fromNodeId: newFromNodeId,
          fromPort: newFromPort,
          toNodeId: newToNodeId,
          toPort: newToPort,
        })
        removeConnection(draggingConnectionId)
        setSelectedIds([existingConnection.id])
        setSelectedType('connection')
      } else {
        updateConnection(draggingConnectionId, {
          fromNodeId: newFromNodeId,
          fromPort: newFromPort,
          toNodeId: newToNodeId,
          toPort: newToPort,
        })
        setSelectedIds([draggingConnectionId])
        setSelectedType('connection')
      }

      setIsDraggingConnectionEndpoint(false)
      setDraggingConnectionId(null)
      setDraggingEndpoint(null)
      setSnappedPort(null)
      justFinishedEndpointDraggingRef.current = true
      setTimeout(() => {
        justFinishedEndpointDraggingRef.current = false
      }, 0)
    }

    if (isDraggingBendPoint) {
      setIsDraggingBendPoint(false)
      setDraggingBendPointId(null)
      setDraggingConnectionId(null)
      justFinishedBendPointDraggingRef.current = true
      setTimeout(() => {
        justFinishedBendPointDraggingRef.current = false
      }, 0)
    }
  }, [isDragging, isDraggingGroup, isCreatingGroup, groupStartPos, groupEndPos, groupDragStart, groupInitialPositions, initialGroupNodeIds, groupDragInitialGroupPos, draggingGroupId, groupDragOffset, nodes, groups, updateGroup, addGroup, isCreatingConnection, connectionStartNodeId, connectionStartPort, isDraggingConnectionEndpoint, draggingConnectionId, draggingEndpoint, connections, panX, panY, zoom, containerRef, updateConnection, findBestPort, snappedPort, addConnection, removeConnection, isBoxSelecting, boxSelectionStart, boxSelectionEnd, addToSelection, isCreatingDomain, domainBoxStart, domainBoxEnd, domains, addDomain, isDraggingBendPoint, draggingBendPointId, setSelectedIds, setSelectedType, connectionType])

  // Handle connection click
  const handleConnectionClick = useCallback((e: React.MouseEvent, connectionId: string) => {
    if (isDraggingBendPoint || isDraggingConnectionEndpoint) return
    e.stopPropagation()
    closeAllContextMenus()
    setSelectedIds([connectionId])
    setSelectedType('connection')
  }, [isDraggingBendPoint, isDraggingConnectionEndpoint, setSelectedIds, setSelectedType, closeAllContextMenus])

  // Handle connection context menu
  const handleConnectionContextMenu = useCallback((e: React.MouseEvent, connectionId: string) => {
    e.preventDefault()
    e.stopPropagation()
    const rect = containerRef.current?.getBoundingClientRect()
    const clickX = rect ? (e.clientX - rect.left - panX) / zoom : 0
    const clickY = rect ? (e.clientY - rect.top - panY) / zoom : 0
    setContextMenu(null)
    setDomainContextMenu(null)
    setNodeContextMenu(null)
    setConnectionContextMenu({
      x: e.clientX,
      y: e.clientY,
      connectionId,
      clickX,
      clickY,
    })
  }, [containerRef, panX, panY, zoom])

  // Handle node context menu
  const handleNodeContextMenu = useCallback((x: number, y: number, nodeId: string) => {
    setContextMenu(null)
    setConnectionContextMenu(null)
    setDomainContextMenu(null)
    setNodeContextMenu({
      x,
      y,
      nodeId,
    })
  }, [])

  // Handle connection double click
  const handleConnectionDoubleClick = useCallback((e: React.MouseEvent, connectionId: string) => {
    e.preventDefault()
    e.stopPropagation()
    const connection = connections.get(connectionId)
    if (connection) {
      setEditingConnectionLabel({
        connectionId,
        label: connection.label || '',
      })
    }
  }, [connections, setEditingConnectionLabel])

  // Handle canvas click
  const handleCanvasClick = useCallback((e: React.MouseEvent) => {
    // Don't handle click when using pan tool or just finished dragging
    if (currentTool === 'pan' || isDragging) return

    // Don't handle click if just finished box selection
    if (justFinishedBoxSelectingRef.current) return

    // Don't handle click if just finished dragging connection endpoint
    if (justFinishedEndpointDraggingRef.current) return

    // Don't handle click if just finished dragging bend point
    if (justFinishedBendPointDraggingRef.current) return

    // Prevent double-firing
    if (e.detail > 1) return

    // Close context menus when clicking on canvas
    if (contextMenu || connectionContextMenu || domainContextMenu || nodeContextMenu) {
      setContextMenu(null)
      setConnectionContextMenu(null)
      setDomainContextMenu(null)
      setNodeContextMenu(null)
    }

    // Check if clicking on an existing node
    const target = e.target as HTMLElement
    const clickedOnNode = target.closest('.node-item')
    if (clickedOnNode && !isCreatingConnection) {
      return
    }

    // Check if clicking on a group
    const clickedOnGroup = target.closest('[data-group-id]')
    if (clickedOnGroup) {
      return
    }

    // Check if clicking on other interactive elements
    if (target.closest('button') || target.closest('canvas') || target.closest('[role="button"]')) {
      return
    }

    // Close style panel when clicking on canvas (not on node)
    if (stylePanelOpen) {
      closeStylePanel()
    }

    // Don't handle click when creating a group
    if (currentTool === 'group') return

    // Clear selection when clicking on empty canvas with default selection tool
    if (isDefaultSelectionTool(currentTool)) {
      setSelectedIds([])
      setSelectedType(null)
      if (stylePanelOpen) {
        closeStylePanel()
      }
      return
    }

    const rect = e.currentTarget.getBoundingClientRect()
    const clickX = e.clientX - rect.left
    const clickY = e.clientY - rect.top

    // Convert screen coordinates to canvas coordinates
    const x = (clickX - panX) / zoom
    const y = (clickY - panY) / zoom

    const snappedX = dragMode === 'grid' ? Math.round(x / 20) * 20 : x
    const snappedY = dragMode === 'grid' ? Math.round(y / 20) * 20 : y

    if (currentTool === 'node') {
      const nodeWidth = 200
      const nodeHeight = 120
      const newNode = {
        id: generateId('node'),
        x: snappedX - nodeWidth / 2,
        y: snappedY - nodeHeight / 2,
        width: nodeWidth,
        height: nodeHeight,
        title: '新节点',
        content: '',
        color: '#ffffff',
        fontSize: 14,
        textAlign: 'left' as const,
        collapsed: false,
        locked: false,
      }

      addNode(newNode)

      setCurrentTool('select')
    } else if (currentTool === 'image') {
      const nodeWidth = 200
      const nodeHeight = 150
      const newNode: Node = {
        id: generateId('node'),
        x: snappedX - nodeWidth / 2,
        y: snappedY - nodeHeight / 2,
        width: nodeWidth,
        height: nodeHeight,
        title: '图片节点',
        content: '',
        color: '#ffffff',
        fontSize: 14,
        textAlign: 'left' as const,
        collapsed: false,
        locked: false,
        type: 'image',
      }

      addNode(newNode)

      setCurrentTool('select')
    }
  }, [isEditingConnectionEndpoint, editingConnectionId, editingEndpoint, connections, updateConnection, nodes, panX, panY, zoom, containerRef, currentTool, isDragging, setSelectedIds, dragMode, addNode, setCurrentTool, findBestPort, stylePanelOpen, closeStylePanel])

  // Handle mouse wheel for zooming and panning
  const handleWheel = (e: React.WheelEvent) => {
    // If hovering over a node and not holding any modifier keys, 
    // allow the default scroll behavior for node content instead of zooming the canvas
    const isOverNode = (e.target as HTMLElement).closest('.node-item')
    if (isOverNode && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      return
    }

    if (e.shiftKey) {
      e.preventDefault()
      setPan(panX - e.deltaY, panY)
    } else if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      setPan(panX, panY - e.deltaY)
    } else {
      e.preventDefault()
      const delta = e.deltaY * -0.001
      const newZoom = Math.min(Math.max(zoom + delta, 0.1), 5)

      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) {
        setZoom(newZoom)
        return
      }

      const centerX = rect.width / 2
      const centerY = rect.height / 2

      const canvasX = (centerX - panX) / zoom
      const canvasY = (centerY - panY) / zoom

      const newPanX = centerX - canvasX * newZoom
      const newPanY = centerY - canvasY * newZoom

      setZoom(newZoom)
      setPan(newPanX, newPanY)
    }
  }

  // Handle drop from node pool to canvas
  const handleCanvasDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const cardData = e.dataTransfer.getData('application/nodepool-card')
    if (!cardData || !containerRef.current) return

    try {
      const card = JSON.parse(cardData) as NodeCard
      const rect = containerRef.current.getBoundingClientRect()

      // Calculate drop position in canvas coordinates
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top
      const canvasX = (mouseX - panX) / zoom
      const canvasY = (mouseY - panY) / zoom

      // Parse node data from card content
      const nodeData = JSON.parse(card.content)
      const newNode = {
        ...nodeData,
        id: `${nodeData.id}-pool-${Date.now()}`,
        x: canvasX - (nodeData.width || 200) / 2,
        y: canvasY - (nodeData.height || 120) / 2,
      }
      addNode(newNode)

      // Remove from both stores immediately as it's "consumed"
      const { removeFromNodePool } = useProjectsStore.getState()
      const { removeCard } = useNodePoolStore.getState()
      await Promise.all([
        removeFromNodePool(card.id),
        removeCard(card.id)
      ])
      addToast({ type: 'success', title: '节点已取出', message: '卡片已从池中取出到画布' })
    } catch (error) {
      // Error handled by toast
    }
  }

  // Handle keyboard shortcuts for node operations
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement).contentEditable === 'true'
      ) {
        return
      }

      const { editingId } = useCanvasStore.getState()
      if (editingId !== null) {
        return
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length > 0) {
        const { removeNode, removeConnection, nodes, connections } = useCanvasStore.getState()
        selectedIds.forEach((id) => {
          if (nodes.has(id)) {
            removeNode(id)
          } else if (connections.has(id)) {
            removeConnection(id)
          }
        })
        setSelectedIds([])
      }

      if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault()
        if (canUndo()) {
          undo()
        }
      }

      if (((e.key === 'y' || e.key === 'Y') && (e.ctrlKey || e.metaKey)) ||
        ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && e.shiftKey)) {
        e.preventDefault()
        if (canRedo()) {
          redo()
        }
      }

      if ((e.key === 'd' || e.key === 'D') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        const { duplicateNode } = useCanvasStore.getState()
        if (selectedIds.length === 1) {
          duplicateNode(selectedIds[0])
        }
      }

      if ((e.key === 'c' || e.key === 'C') && (e.ctrlKey || e.metaKey)) {
        const nodesToCopy = selectedIds.map((id) => nodes.get(id)).filter(Boolean)
        sessionStorage.setItem('clipboard_nodes', JSON.stringify(nodesToCopy))
      }

      if ((e.key === 'v' || e.key === 'V') && (e.ctrlKey || e.metaKey)) {
        const clipboard = sessionStorage.getItem('clipboard_nodes')
        if (clipboard) {
          try {
            const nodesToPaste = JSON.parse(clipboard) as Node[]
            nodesToPaste.forEach((node) => {
              const newNode = {
                ...node,
                id: generateId('node'),
                x: node.x + 20,
                y: node.y + 20,
              }
              addNode(newNode)
            })
          } catch (e) {
            // Silently fail
          }
        }
      }

      // Select all nodes
      if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        setSelectedIds(Array.from(nodes.keys()))
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedIds, nodes, addNode, setSelectedIds, undo, redo, canUndo, canRedo])

  // Close context menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (e.button === 0) {
        // Find the context menu element
        const contextMenuElement = document.querySelector('.fixed.bg-white.dark\\:bg-gray-800.border.border-gray-200.dark\\:border-gray-700.rounded-lg.shadow-lg.py-1.z-50')
        // Check if the click is outside the context menu
        if (contextMenuElement && !contextMenuElement.contains(e.target as unknown as globalThis.Node)) {
          setContextMenu(null)
          setConnectionContextMenu(null)
          setDomainContextMenu(null)
          setNodeContextMenu(null)
        }
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Listen for node drag events to update connections in real-time
  useEffect(() => {
    const handleNodeDragStart = (e: Event) => {
      const customEvent = e as CustomEvent<{ nodeId: string; x: number; y: number }>
      const { nodeId, x, y } = customEvent.detail
      setDraggingNodePositions(prev => new Map(prev).set(nodeId, { x, y }))
    }

    const handleNodeDragMove = (e: Event) => {
      const customEvent = e as CustomEvent<{ nodeId: string; x: number; y: number }>
      const { nodeId, x, y } = customEvent.detail
      setDraggingNodePositions(prev => new Map(prev).set(nodeId, { x, y }))
    }

    const handleNodeDragEnd = (e: Event) => {
      const customEvent = e as CustomEvent<{ nodeId: string }>
      const { nodeId } = customEvent.detail
      setDraggingNodePositions(prev => {
        const newMap = new Map(prev)
        newMap.delete(nodeId)
        return newMap
      })
    }

    window.addEventListener('nodeDragStart', handleNodeDragStart as EventListener)
    window.addEventListener('nodeDragMove', handleNodeDragMove as EventListener)
    window.addEventListener('nodeDragEnd', handleNodeDragEnd as EventListener)

    return () => {
      window.removeEventListener('nodeDragStart', handleNodeDragStart as EventListener)
      window.removeEventListener('nodeDragMove', handleNodeDragMove as EventListener)
      window.removeEventListener('nodeDragEnd', handleNodeDragEnd as EventListener)
    }
  }, [])

  // Show/hide rich text toolbar based on editing state
  useEffect(() => {
    if (editingId && containerRef.current) {
      const node = nodes.get(editingId)
      if (node) {
        const rect = containerRef.current.getBoundingClientRect()
        const nodeX = node.x * zoom + panX
        const nodeY = node.y * zoom + panY + node.height * zoom
        setRichTextToolbarPosition({
          x: rect.left + nodeX + (node.width * zoom) / 2,
          y: rect.top + nodeY,
        })
        setRichTextToolbarVisible(true)
      }
    } else {
      setRichTextToolbarVisible(false)
    }
  }, [editingId, nodes, zoom, panX, panY])

  // 验证画布ID有效性
  const validCanvasId = canvasId ? parseInt(canvasId) : null
  const isCanvasValid = validCanvasId !== null && !isNaN(validCanvasId)

  // 如果没有有效的画布ID，显示提示界面
  if (!isCanvasValid) {
    return (
      <div className="h-full flex items-center justify-center bg-gray-100 dark:bg-gray-900">
        <div className="text-center p-8 bg-white dark:bg-gray-800 rounded-lg shadow-lg">
          <div className="mb-4">
            <svg
              className="mx-auto h-16 w-16 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 13h6m-3-3v6m-9 1V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
              />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-200 mb-2">
            请先选择一个画布
          </h2>
          <p className="text-gray-600 dark:text-gray-400 mb-6">
            您需要从左侧项目栏中选择一个画布才能开始编辑
          </p>
          <div className="flex justify-center gap-4">
            <button
              onClick={() => window.location.href = '/projects'}
              className="px-6 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors"
            >
              前往项目列表
            </button>
            <button
              onClick={() => window.history.back()}
              className="px-6 py-2 bg-gray-300 hover:bg-gray-400 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 rounded-lg transition-colors"
            >
              返回上一页
            </button>
          </div>
        </div>
      </div>
    )
  }


  return (
    <div className="h-full flex flex-col bg-gray-100 dark:bg-gray-900">
      {/* Loading overlay for canvas switching */}
      {isLoading && (
        <div className="fixed inset-0 flex items-center justify-center bg-gray-100/50 dark:bg-gray-900/50 backdrop-blur-sm z-[9999]">
          <div className="text-center bg-white dark:bg-gray-800 p-6 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700">
            <div className="inline-block animate-spin rounded-full h-10 w-10 border-4 border-gray-300 border-t-blue-500 mb-3" />
            <p className="text-sm font-medium text-gray-600 dark:text-gray-400">正在加载画布...</p>
          </div>
        </div>
      )}

      {/* Canvas Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <CanvasToolbar onSave={handleManualSave} />
      </div>

      {/* Zoom Controls */}
      <ZoomControls />

      {/* Canvas Container */}
      <div
        ref={containerRef}
        className="flex-1 relative overflow-hidden"
        data-canvas-container="true"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleCanvasClick}
        onContextMenu={(e) => {
          // 只阻止画布区域的右键菜单，允许节点池等侧边栏的右键菜单正常显示
          const target = e.target as HTMLElement
          if (!target.closest('[data-node-pool]') && !target.closest('.node-pool')) {
            e.preventDefault()
          }
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleCanvasDrop}
        style={{
          cursor: customCursor || (isCreatingConnection ? 'crosshair' : isCreatingGroup ? 'crosshair' : isDragging ? 'grabbing' : isDefaultSelectionTool(currentTool) || currentTool === 'pan' || isSpacePressed ? 'grab' : currentTool === 'node' || currentTool === 'image' ? 'pointer' : currentTool === 'domain' ? 'cell' : currentTool === 'connection' ? 'crosshair' : currentTool === 'group' ? 'crosshair' : 'default'),
          userSelect: isDragging || currentTool === 'pan' ? 'none' : undefined,
        }}
      >
        <CanvasGrid zoom={zoom} panX={panX} panY={panY} />

        {containerReady && minimapVisible && (
          <CanvasMinimap
            nodes={nodes}
            groups={groups}
            domains={domains}
            zoom={zoom}
            panX={panX}
            panY={panY}
            containerWidth={containerSize.width}
            containerHeight={containerSize.height}
            nodePoolOpen={nodePoolOpen}
            secondaryToolbarOpen={currentTool === 'connection'}
            onViewportChange={setPan}
          />
        )}

        <div
          className="absolute"
          data-canvas-content="true"
          style={{
            left: 0,
            top: 0,
            transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
            transformOrigin: '0 0',
          }}
          onMouseDown={() => {
            mouseDownOnContentRef.current = true
          }}
          onClick={(e) => {
            // SVG content click handler
          }}
        >
          {Array.from(domains.values()).map((domain) => (
            <div
              key={domain.id}
              className="absolute border"
              data-domain-id={domain.id}
              onMouseDown={(e) => {
                if (e.button === 2) {
                  domainContextMenuStartRef.current = { x: e.clientX, y: e.clientY }
                  return
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()

                const dx = e.clientX - domainContextMenuStartRef.current.x
                const dy = e.clientY - domainContextMenuStartRef.current.y
                if (Math.hypot(dx, dy) > 5) return

                setContextMenu(null)
                setConnectionContextMenu(null)
                setNodeContextMenu(null)
                setDomainContextMenu({
                  x: e.clientX,
                  y: e.clientY,
                  domainId: domain.id,
                })
              }}
              onClick={(e) => {
                if (currentTool === 'select') {
                  // Check if this is a box selection by measuring the distance moved
                  const dx = boxSelectionEnd.x - boxSelectionStart.x
                  const dy = boxSelectionEnd.y - boxSelectionStart.y
                  const isBoxSelection = Math.hypot(dx, dy) > 5

                  if (!isBoxSelection && !justFinishedBoxSelectingRef.current) {
                    // This is a regular click, select the domain
                    e.stopPropagation()
                    closeAllContextMenus()
                    setSelectedIds([domain.id])
                    setSelectedType('domain')
                  }
                  // If it's a box selection, don't stop propagation to allow handleMouseUp to process it
                }
              }}
              style={{
                left: domain.x,
                top: domain.y,
                width: domain.width,
                height: domain.height,
                backgroundColor: domain.backgroundColor,
                zIndex: Z_INDEX.DOMAIN,
              }}
            >
              {domain.titleVisible && domain.name && (
                <span
                  className="absolute top-2 left-1/2 -translate-x-1/2 font-black pointer-events-none"
                  style={{
                    color: 'rgba(30, 41, 59, 0.3)',
                    fontSize: `${Math.max(domain.width, domain.height) * (domain.titleScale || 0.08)}px`,
                  }}
                >
                  {domain.name}
                </span>
              )}
            </div>
          ))}

          {Array.from(groups.values()).map((group) => {
            const isSelected = selectedIds.includes(group.id)
            // Calculate position with offset if dragging
            const displayX = isDraggingGroup && draggingGroupId === group.id ? groupDragInitialGroupPos!.x + groupDragOffset.x : group.x
            const displayY = isDraggingGroup && draggingGroupId === group.id ? groupDragInitialGroupPos!.y + groupDragOffset.y : group.y

            return (
              <div
                key={group.id}
                className="absolute border cursor-move"
                data-group-id={group.id}
                style={{
                  left: displayX,
                  top: displayY,
                  width: group.width,
                  height: group.height,
                  backgroundColor: group.backgroundColor,
                  borderColor: group.backgroundColor,
                  borderWidth: group.borderWidth,
                  borderRadius: group.borderRadius,
                  zIndex: Z_INDEX.GROUP,
                }}
                onMouseDown={(e) => {
                  if (e.button === 2) {
                    groupContextMenuStartRef.current = { x: e.clientX, y: e.clientY }
                    return
                  }

                  e.stopPropagation()

                  // Only allow left mouse button for dragging and selection
                  if (e.button !== 0) return

                  if (editingId === group.id) {
                    return
                  }

                  if (isDefaultSelectionTool(currentTool)) {
                    closeAllContextMenus()
                    if (e.ctrlKey || e.metaKey) {
                      if (selectedIds.includes(group.id)) {
                        removeFromSelection(group.id)
                      } else {
                        addToSelection(group.id)
                      }
                    } else if (!selectedIds.includes(group.id)) {
                      setSelectedIds([group.id])
                      setSelectedType(null)
                    }
                  }

                  const rect = containerRef.current?.getBoundingClientRect()
                  if (rect) {
                    const mouseX = e.clientX - rect.left
                    const mouseY = e.clientY - rect.top
                    const canvasX = (mouseX - panX) / zoom
                    const canvasY = (mouseY - panY) / zoom
                    setIsDraggingGroup(true)
                    setDraggingGroupId(group.id)
                    setGroupDragStart({ x: canvasX, y: canvasY })
                    setGroupDragInitialGroupPos({ x: group.x, y: group.y })

                    const initialPositions = new Map<string, { x: number; y: number }>()
                    initialPositions.set(group.id, { x: group.x, y: group.y })
                    nodes.forEach((node, nodeId) => {
                      initialPositions.set(nodeId, { x: node.x, y: node.y })
                    })
                    setGroupInitialPositions(initialPositions)

                    const initialNodeIds = new Set<string>()
                    nodes.forEach((node, nodeId) => {
                      if (isNodeInGroup(node, group.x, group.y, group.width, group.height)) {
                        initialNodeIds.add(nodeId)
                      }
                    })
                    setInitialGroupNodeIds(initialNodeIds)
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()

                  const dx = e.clientX - groupContextMenuStartRef.current.x
                  const dy = e.clientY - groupContextMenuStartRef.current.y
                  if (Math.hypot(dx, dy) > 5) return

                  setContextMenu({
                    x: e.clientX,
                    y: e.clientY,
                    groupId: group.id,
                  })
                }}
              >
                {isSelected && (
                  <div
                    className="absolute inset-0 pointer-events-none"
                    style={{ backgroundColor: 'rgba(0, 0, 0, 0.08)' }}
                  />
                )}
                <div
                  className="absolute -top-[35px] left-0 flex items-center gap-1 select-none"
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()

                    const dx = e.clientX - groupContextMenuStartRef.current.x
                    const dy = e.clientY - groupContextMenuStartRef.current.y
                    if (Math.hypot(dx, dy) > 5) return

                    setContextMenu({
                      x: e.clientX,
                      y: e.clientY,
                      groupId: group.id,
                    })
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    setEditingGroupName(group.name)
                    setEditingId(group.id)
                  }}
                >
                  {editingId === group.id ? (
                    <input
                      type="text"
                      value={editingGroupName}
                      onChange={(e) => {
                        e.stopPropagation()
                        setEditingGroupName(e.target.value)
                      }}
                      onBlur={(e) => {
                        e.stopPropagation()
                        if (editingGroupName !== group.name) {
                          updateGroupWithoutHistory(group.id, { name: editingGroupName })
                        }
                        setEditingId(null)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.stopPropagation()
                          if (editingGroupName !== group.name) {
                            updateGroupWithoutHistory(group.id, { name: editingGroupName })
                          }
                          setEditingId(null)
                        } else if (e.key === 'Escape') {
                          e.stopPropagation()
                          setEditingId(null)
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                      autoFocus
                      size={Math.max(3, editingGroupName.length)}
                      style={{ width: `${Math.max(40, editingGroupName.length * 8 + 20)}px`, maxWidth: '300px' }}
                      className="bg-blue-500/20 dark:bg-blue-500/20 text-gray-900 dark:text-white px-2 py-1 rounded-lg text-sm font-medium outline-none shadow-sm border border-blue-500/30"
                    />
                  ) : (
                    <span className="bg-blue-500/20 dark:bg-blue-500/20 text-gray-900 dark:text-white px-2 py-1 rounded-lg text-sm font-medium shadow-sm whitespace-nowrap inline-block border border-blue-500/30">
                      {group.name}
                    </span>
                  )}
                </div>

                {/* Resize handles */}
                <div
                  className="absolute w-2 h-2 bg-blue-500 rounded-full cursor-nwse-resize hover:bg-blue-600"
                  style={{
                    left: -4,
                    top: -4,
                    zIndex: Z_INDEX.GROUP,
                  }}
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    const rect = containerRef.current?.getBoundingClientRect()
                    if (rect) {
                      const mouseX = e.clientX - rect.left
                      const mouseY = e.clientY - rect.top
                      const canvasX = (mouseX - panX) / zoom
                      const canvasY = (mouseY - panY) / zoom
                      setIsResizingGroup(true)
                      setResizingGroupId(group.id)
                      setResizeHandle('nw')
                      setResizeStart({ x: canvasX, y: canvasY })
                      setResizeInitialGroup({ x: group.x, y: group.y, width: group.width, height: group.height })

                      const initialPositions = new Map<string, { x: number; y: number; width: number; height: number }>()
                      group.nodeIds.forEach(nodeId => {
                        const node = nodes.get(nodeId)
                        if (node) {
                          initialPositions.set(nodeId, { x: node.x, y: node.y, width: node.width, height: node.height })
                        }
                      })
                      setResizeInitialNodePositions(initialPositions)
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setContextMenu({
                      x: e.clientX,
                      y: e.clientY,
                      groupId: group.id,
                    })
                  }}
                />

                <div
                  className="absolute w-2 h-2 bg-blue-500 rounded-full cursor-nesw-resize hover:bg-blue-600"
                  style={{
                    right: -4,
                    top: -4,
                    zIndex: Z_INDEX.GROUP,
                  }}
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    const rect = containerRef.current?.getBoundingClientRect()
                    if (rect) {
                      const mouseX = e.clientX - rect.left
                      const mouseY = e.clientY - rect.top
                      const canvasX = (mouseX - panX) / zoom
                      const canvasY = (mouseY - panY) / zoom
                      setIsResizingGroup(true)
                      setResizingGroupId(group.id)
                      setResizeHandle('ne')
                      setResizeStart({ x: canvasX, y: canvasY })
                      setResizeInitialGroup({ x: group.x, y: group.y, width: group.width, height: group.height })

                      const initialPositions = new Map<string, { x: number; y: number; width: number; height: number }>()
                      group.nodeIds.forEach(nodeId => {
                        const node = nodes.get(nodeId)
                        if (node) {
                          initialPositions.set(nodeId, { x: node.x, y: node.y, width: node.width, height: node.height })
                        }
                      })
                      setResizeInitialNodePositions(initialPositions)
                    }
                  }}
                />

                <div
                  className="absolute w-2 h-2 bg-blue-500 rounded-full cursor-nesw-resize hover:bg-blue-600"
                  style={{
                    left: -4,
                    bottom: -4,
                    zIndex: Z_INDEX.GROUP,
                  }}
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    const rect = containerRef.current?.getBoundingClientRect()
                    if (rect) {
                      const mouseX = e.clientX - rect.left
                      const mouseY = e.clientY - rect.top
                      const canvasX = (mouseX - panX) / zoom
                      const canvasY = (mouseY - panY) / zoom
                      setIsResizingGroup(true)
                      setResizingGroupId(group.id)
                      setResizeHandle('sw')
                      setResizeStart({ x: canvasX, y: canvasY })
                      setResizeInitialGroup({ x: group.x, y: group.y, width: group.width, height: group.height })

                      const initialPositions = new Map<string, { x: number; y: number; width: number; height: number }>()
                      group.nodeIds.forEach(nodeId => {
                        const node = nodes.get(nodeId)
                        if (node) {
                          initialPositions.set(nodeId, { x: node.x, y: node.y, width: node.width, height: node.height })
                        }
                      })
                      setResizeInitialNodePositions(initialPositions)
                    }
                  }}
                />

                <div
                  className="absolute w-2 h-2 bg-blue-500 rounded-full cursor-nwse-resize hover:bg-blue-600"
                  style={{
                    right: -4,
                    bottom: -4,
                    zIndex: Z_INDEX.GROUP,
                  }}
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    const rect = containerRef.current?.getBoundingClientRect()
                    if (rect) {
                      const mouseX = e.clientX - rect.left
                      const mouseY = e.clientY - rect.top
                      const canvasX = (mouseX - panX) / zoom
                      const canvasY = (mouseY - panY) / zoom
                      setIsResizingGroup(true)
                      setResizingGroupId(group.id)
                      setResizeHandle('se')
                      setResizeStart({ x: canvasX, y: canvasY })
                      setResizeInitialGroup({ x: group.x, y: group.y, width: group.width, height: group.height })

                      const initialPositions = new Map<string, { x: number; y: number; width: number; height: number }>()
                      group.nodeIds.forEach(nodeId => {
                        const node = nodes.get(nodeId)
                        if (node) {
                          initialPositions.set(nodeId, { x: node.x, y: node.y, width: node.width, height: node.height })
                        }
                      })
                      setResizeInitialNodePositions(initialPositions)
                    }
                  }}
                />
              </div>
            )
          })}

          {isCreatingGroup && (
            <div
              className="absolute border-2 border-blue-500 bg-blue-100 bg-opacity-20 pointer-events-none"
              style={{
                left: Math.min(groupStartPos.x, groupEndPos.x),
                top: Math.min(groupStartPos.y, groupEndPos.y),
                width: Math.abs(groupEndPos.x - groupStartPos.x),
                height: Math.abs(groupEndPos.y - groupStartPos.y),
              }}
            />
          )}

          {/* Render connections */}
          <svg
            className="absolute inset-0"
            style={{ overflow: 'visible', zIndex: Z_INDEX.CONNECTION }}
          >
            <defs>
              {/* Connection shadow filter */}
              <filter id="connectionShadow" x="-50%" y="-50%" width="200%" height="200%">
                <feDropShadow dx="0" dy="1" stdDeviation="2" floodColor="#000000" floodOpacity="0.1" />
              </filter>

              {/* Gradient for connection rings */}
              <linearGradient id="connectionRingGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#60A5FA" stopOpacity="0.95" />
                <stop offset="100%" stopColor="#3B82F6" stopOpacity="0.95" />
              </linearGradient>

              {/* Subtle glow for selected connections */}
              <filter id="connectionGlow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="1.5" result="coloredBlur" />
                <feMerge>
                  <feMergeNode in="coloredBlur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>

              {/* Arrow markers */}
              <marker
                id="arrowhead"
                markerWidth="10"
                markerHeight="7"
                refX="9"
                refY="3.5"
                orient="auto"
              >
                <path d="M0,0 L10,3.5 L0,7 L3,3.5 Z" fill="context-stroke" />
              </marker>
              <marker
                id="arrowhead-selected"
                markerWidth="10"
                markerHeight="7"
                refX="9"
                refY="3.5"
                orient="auto"
              >
                <path d="M0,0 L10,3.5 L0,7 L3,3.5 Z" fill="#3b82f6" />
              </marker>
              <marker
                id="arrowhead-reverse"
                markerWidth="10"
                markerHeight="7"
                refX="9"
                refY="3.5"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,3.5 L0,7 L3,3.5 Z" fill="context-stroke" />
              </marker>
              <marker
                id="arrowhead-reverse-selected"
                markerWidth="10"
                markerHeight="7"
                refX="9"
                refY="3.5"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,3.5 L0,7 L3,3.5 Z" fill="#3b82f6" />
              </marker>
            </defs>
            {Array.from(connections.values()).map((conn) => {
              const fromNode = nodes.get(conn.fromNodeId)
              const toNode = nodes.get(conn.toNodeId)
              if (!fromNode || !toNode) return null

              const fromDraggingPos = draggingNodePositions.get(conn.fromNodeId)
              const toDraggingPos = draggingNodePositions.get(conn.toNodeId)

              const actualFromNode = getActualNodePosition(fromNode, fromDraggingPos, isDraggingGroup, draggingGroupId, initialGroupNodeIds, groupDragOffset)
              const actualToNode = getActualNodePosition(toNode, toDraggingPos, isDraggingGroup, draggingGroupId, initialGroupNodeIds, groupDragOffset)

              const fromPosition = getPortPosition(actualFromNode, getConnectionPort(conn, 'start'))
              const toPosition = getPortPosition(actualToNode, getConnectionPort(conn, 'end'))
              const fromX = fromPosition.x
              const fromY = fromPosition.y
              const toX = toPosition.x
              const toY = toPosition.y

              const lineColor = conn.color

              // Disable transition during dragging for better performance
              const disableTransition = isDragging || isDraggingGroup || isDraggingBendPoint

              return (
                <g key={conn.id}>
                  {conn.arrowType !== 'none' && (
                    <defs>
                      {conn.arrowType === 'end' || conn.arrowType === 'both' ? (
                        <marker
                          id={`arrowhead-${conn.id}`}
                          markerWidth="10"
                          markerHeight="7"
                          refX="9"
                          refY="3.5"
                          orient="auto"
                        >
                          <path d="M0,0 L10,3.5 L0,7 L3,3.5 Z" fill={conn.color} />
                        </marker>
                      ) : null}
                      {conn.arrowType === 'start' || conn.arrowType === 'both' ? (
                        <marker
                          id={`arrowhead-reverse-${conn.id}`}
                          markerWidth="10"
                          markerHeight="7"
                          refX="9"
                          refY="3.5"
                          orient="auto-start-reverse"
                        >
                          <path d="M0,0 L10,3.5 L0,7 L3,3.5 Z" fill={conn.color} />
                        </marker>
                      ) : null}
                    </defs>
                  )}
                  <ConnectionLine
                    conn={conn}
                    fromX={fromX}
                    fromY={fromY}
                    toX={toX}
                    toY={toY}
                    disableTransition={disableTransition}
                    onClick={handleConnectionClick}
                    onContextMenu={handleConnectionContextMenu}
                    onDoubleClick={handleConnectionDoubleClick}
                  />
                  {conn.label && (() => {
                    const labelPos = getLabelPosition(conn.type, fromX, fromY, toX, toY, conn.bendPoints || [])
                    return (
                      <text
                        x={labelPos.x}
                        y={labelPos.y - 5}
                        textAnchor="middle"
                        fontSize={11}
                        fontWeight="500"
                        fill="#64748b"
                        style={{
                          pointerEvents: 'none',
                          textShadow: '0 1px 3px rgba(255,255,255,0.9)',
                        }}
                      >
                        {conn.label}
                      </text>
                    )
                  })()}
                </g>
              )
            })}
            {/* Connection creation preview */}
            {isCreatingConnection && connectionStartNodeId && (
              <>
                {(() => {
                  const fromNode = nodes.get(connectionStartNodeId)
                  if (!fromNode || !connectionStartPort) return null
                  const fromPosition = getPortPosition(fromNode, connectionStartPort)
                  return (
                    <line
                      x1={fromPosition.x}
                      y1={fromPosition.y}
                      x2={connectionEndPosition.x}
                      y2={connectionEndPosition.y}
                      stroke={CONNECTION_DEFAULTS.COLOR}
                      strokeWidth={CONNECTION_DEFAULTS.WIDTH}
                      strokeDasharray="5,5"
                      markerEnd="url(#arrowhead-selected)"
                    />
                  )
                })()}

                {snappedPort && (
                  <circle
                    cx={snappedPort.position.x}
                    cy={snappedPort.position.y}
                    r={10}
                    fill="none"
                    stroke="#4A90E2"
                    strokeWidth={2}
                  />
                )}
              </>
            )}

            {/* Connection endpoint dragging preview */}
            {isDraggingConnectionEndpoint && draggingConnectionId && draggingEndpoint && (
              <>
                {(() => {
                  const connection = connections.get(draggingConnectionId)
                  if (!connection) return null

                  const fromNode = nodes.get(connection.fromNodeId)
                  const toNode = nodes.get(connection.toNodeId)
                  if (!fromNode || !toNode) return null

                  const fromPosition = getPortPosition(fromNode, connection.fromPort || 'right')
                  const toPosition = getPortPosition(toNode, connection.toPort || 'left')

                  if (draggingEndpoint === 'start') {
                    return (
                      <line
                        x1={editingEndpointPosition.x}
                        y1={editingEndpointPosition.y}
                        x2={toPosition.x}
                        y2={toPosition.y}
                        stroke={CONNECTION_DEFAULTS.COLOR}
                        strokeWidth={CONNECTION_DEFAULTS.WIDTH}
                        strokeDasharray="5,5"
                        markerEnd="url(#arrowhead-selected)"
                      />
                    )
                  } else {
                    return (
                      <line
                        x1={fromPosition.x}
                        y1={fromPosition.y}
                        x2={editingEndpointPosition.x}
                        y2={editingEndpointPosition.y}
                        stroke={CONNECTION_DEFAULTS.COLOR}
                        strokeWidth={CONNECTION_DEFAULTS.WIDTH}
                        strokeDasharray="5,5"
                        markerEnd="url(#arrowhead-selected)"
                      />
                    )
                  }
                })()}

                {snappedPort && (
                  <circle
                    cx={snappedPort.position.x}
                    cy={snappedPort.position.y}
                    r={10}
                    fill="none"
                    stroke="#3b82f6"
                    strokeWidth={2}
                  />
                )}
              </>
            )}
          </svg>

          {/* Render endpoint circles for selected connections (rendered outside SVG to avoid boundary box issues) */}
          {Array.from(connections.values())
            .filter(conn => selectedIds.includes(conn.id))
            .map((conn) => {
              const fromNode = nodes.get(conn.fromNodeId)
              const toNode = nodes.get(conn.toNodeId)
              if (!fromNode || !toNode) return null

              const fromDraggingPos = draggingNodePositions.get(conn.fromNodeId)
              const toDraggingPos = draggingNodePositions.get(conn.toNodeId)

              const actualFromNode = getActualNodePosition(fromNode, fromDraggingPos, isDraggingGroup, draggingGroupId, initialGroupNodeIds, groupDragOffset)
              const actualToNode = getActualNodePosition(toNode, toDraggingPos, isDraggingGroup, draggingGroupId, initialGroupNodeIds, groupDragOffset)

              const fromPosition = getPortPosition(actualFromNode, getConnectionPort(conn, 'start'))
              const toPosition = getPortPosition(actualToNode, getConnectionPort(conn, 'end'))

              return (
                <div key={`endpoint-${conn.id}`} style={ENDPOINT_CONTAINER_STYLE}>
                  {/* Start endpoint */}
                  <div
                    style={{
                      ...ENDPOINT_HIT_AREA_STYLE,
                      left: fromPosition.x - 12,
                      top: fromPosition.y - 12,
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setIsDraggingConnectionEndpoint(true)
                      setDraggingConnectionId(conn.id)
                      setDraggingEndpoint('start')
                      const pos = getPortPosition(actualFromNode, getConnectionPort(conn, 'start'))
                      setEditingEndpointPosition(pos)
                    }}
                  >
                    {/* Visible start endpoint circle */}
                    <div style={ENDPOINT_VISIBLE_CIRCLE_STYLE} />
                  </div>
                  {/* End endpoint */}
                  <div
                    style={{
                      ...ENDPOINT_HIT_AREA_STYLE,
                      left: toPosition.x - 12,
                      top: toPosition.y - 12,
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setIsDraggingConnectionEndpoint(true)
                      setDraggingConnectionId(conn.id)
                      setDraggingEndpoint('end')
                      const pos = getPortPosition(actualToNode, getConnectionPort(conn, 'end'))
                      setEditingEndpointPosition(pos)
                    }}
                  >
                    {/* Visible end endpoint circle */}
                    <div style={ENDPOINT_VISIBLE_CIRCLE_STYLE} />
                  </div>
                </div>
              )
            })}

          {/* Render bend points for orthogonal and curve connections */}
          {Array.from(connections.values())
            .filter(conn => (conn.type === 'orthogonal' || conn.type === 'curve') && selectedIds.includes(conn.id) && conn.bendPoints && conn.bendPoints.length > 0)
            .map((conn) => {
              const fromNode = nodes.get(conn.fromNodeId)
              const toNode = nodes.get(conn.toNodeId)
              if (!fromNode || !toNode) return null

              const fromDraggingPos = draggingNodePositions.get(conn.fromNodeId)
              const toDraggingPos = draggingNodePositions.get(conn.toNodeId)

              const actualFromNode = getActualNodePosition(fromNode, fromDraggingPos, isDraggingGroup, draggingGroupId, initialGroupNodeIds, groupDragOffset)
              const actualToNode = getActualNodePosition(toNode, toDraggingPos, isDraggingGroup, draggingGroupId, initialGroupNodeIds, groupDragOffset)

              const bendPoints = conn.bendPoints || []

              return (
                <div key={`bendpoints-${conn.id}`}>
                  {bendPoints.map((bendPoint) => {
                    const isHovered = hoveredBendPoint?.connectionId === conn.id && hoveredBendPoint?.bendPointId === bendPoint.id
                    const isDragging = isDraggingBendPoint && draggingBendPointId === bendPoint.id

                    return (
                      <div
                        key={bendPoint.id}
                        style={{
                          position: 'absolute',
                          left: bendPoint.x - (isHovered ? 14 : 12),
                          top: bendPoint.y - (isHovered ? 14 : 12),
                          width: (isHovered ? 28 : 24),
                          height: (isHovered ? 28 : 24),
                          cursor: 'move',
                          pointerEvents: 'all',
                          zIndex: Z_INDEX.BEND_POINT,
                          transition: 'all 0.15s ease',
                        }}
                        onMouseEnter={() => {
                          setHoveredBendPoint({ connectionId: conn.id, bendPointId: bendPoint.id })
                        }}
                        onMouseLeave={() => {
                          setHoveredBendPoint(null)
                        }}
                        onMouseDown={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          if (!selectedIds.includes(conn.id)) {
                            setSelectedIds([conn.id])
                            setSelectedType('connection')
                          }
                          closeAllContextMenus()
                          setIsDraggingBendPoint(true)
                          setDraggingBendPointId(bendPoint.id)
                          setDraggingConnectionId(conn.id)
                          setDragBendPointStart({ x: e.clientX, y: e.clientY })
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setBendPointContextMenu({
                            x: e.clientX,
                            y: e.clientY,
                            connectionId: conn.id,
                            bendPointId: bendPoint.id,
                          })
                        }}
                      >
                        {/* Visible bend point circle */}
                        <div
                          style={{
                            position: 'absolute',
                            left: isHovered ? 6 : 4,
                            top: isHovered ? 6 : 4,
                            width: isHovered ? 16 : 16,
                            height: isHovered ? 16 : 16,
                            borderRadius: '50%',
                            border: `2px solid ${isHovered ? '#2563eb' : '#3b82f6'}`,
                            backgroundColor: isDragging ? '#eff6ff' : 'white',
                            boxShadow: isHovered
                              ? '0 2px 8px rgba(37, 99, 235, 0.3), 0 0 0 3px rgba(59, 130, 246, 0.2)'
                              : '0 1px 3px rgba(0,0,0,0.1)',
                            transition: 'all 0.15s ease',
                          }}
                        />
                      </div>
                    )
                  })}
                </div>
              )
            })}

          {/* Render nodes */}
          {Array.from(nodes.values()).map((node) => {
            // Check if this node is in the currently dragging group
            let nodeGroupDragOffset: { x: number; y: number } | undefined = undefined
            if (isDraggingGroup && draggingGroupId) {
              const group = groups.get(draggingGroupId)
              if (group && initialGroupNodeIds.has(node.id)) {
                nodeGroupDragOffset = groupDragOffset
              }
            }

            return (
              <NodeItem
                key={node.id}
                node={node}
                isSelected={selectedIds.includes(node.id)}
                zoom={zoom}
                groupDragOffset={nodeGroupDragOffset}
                onNodeContextMenuOpen={handleNodeContextMenu}
                onMouseDown={closeAllContextMenus}
              />
            )
          })}

          {/* Box selection rectangle - rendered on top of everything */}
          {isBoxSelecting && (
            <div
              className="absolute border-2 border-blue-500 bg-blue-500 bg-opacity-10 pointer-events-none"
              style={{
                left: Math.min(boxSelectionStart.x, boxSelectionEnd.x),
                top: Math.min(boxSelectionStart.y, boxSelectionEnd.y),
                width: Math.abs(boxSelectionEnd.x - boxSelectionStart.x),
                height: Math.abs(boxSelectionEnd.y - boxSelectionStart.y),
                zIndex: Z_INDEX.NODE,
              }}
            />
          )}

          {/* Domain creation rectangle - box selection style */}
          {isCreatingDomain && (
            <div
              className="absolute border-2 border-dashed border-blue-500 bg-blue-500 bg-opacity-10 pointer-events-none"
              style={{
                left: Math.min(domainBoxStart.x, domainBoxEnd.x),
                top: Math.min(domainBoxStart.y, domainBoxEnd.y),
                width: Math.abs(domainBoxEnd.x - domainBoxStart.x),
                height: Math.abs(domainBoxEnd.y - domainBoxStart.y),
                zIndex: Z_INDEX.NODE,
              }}
            />
          )}
        </div>
      </div>

      {/* Node Style Panel */}
      <NodeStylePanel />

      {/* Connection Style Panel */}
      <ConnectionStylePanel />

      {/* Domain Style Panel */}
      <DomainStylePanel />

      {/* Group Context Menu */}
      {contextMenu && (
        <ContextMenuWrapper
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
        >
          <button
            className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
            onClick={() => {
              const group = groups.get(contextMenu.groupId)
              if (group) {
                const newName = prompt('请输入组名称:', group.name)
                if (newName) {
                  updateGroup(contextMenu.groupId, { name: newName })
                }
              }
              setContextMenu(null)
            }}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            重命名
          </button>
          <label className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2 cursor-pointer">
            <input
              type="color"
              className="sr-only"
              defaultValue={(() => {
                const group = groups.get(contextMenu.groupId)
                return group ? colorToHex(group.backgroundColor) : '#3b82f6'
              })()}
              onInput={(e) => {
                const group = groups.get(contextMenu.groupId)
                if (group) {
                  const alphaMatch = group.backgroundColor.match(/rgba?\(\d+,\s*\d+,\s*\d+,\s*([\d.]+)\)/)
                  const alpha = alphaMatch ? parseFloat(alphaMatch[1]) : 0.1
                  const newColor = hexToRgba(e.currentTarget.value, alpha)
                  updateGroup(contextMenu.groupId, { backgroundColor: newColor })
                }
              }}
            />
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            更改背景颜色
          </label>
          <div className="border-t border-gray-200 dark:border-gray-700 my-1" />
          <button
            className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2 text-red-600 dark:text-red-400"
            onClick={(e) => {
              e.stopPropagation()
              if (contextMenu?.groupId) {
                const group = groups.get(contextMenu.groupId)
                if (group && confirm('确定要删除这个组吗？')) {
                  removeGroup(contextMenu.groupId)
                }
              }
              setContextMenu(null)
            }}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            删除
          </button>
        </ContextMenuWrapper>
      )}

      {/* Connection Context Menu */}
      {connectionContextMenu && (
        <ContextMenuWrapper
          x={connectionContextMenu.x}
          y={connectionContextMenu.y}
          onClose={() => setConnectionContextMenu(null)}
        >
          {/* Edit Label */}
          <button
            className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
            onClick={() => {
              const connection = connections.get(connectionContextMenu.connectionId)
              if (connection) {
                const newLabel = prompt('请输入说明文字:', connection.label || '')
                if (newLabel !== null) {
                  updateConnection(connectionContextMenu.connectionId, {
                    label: newLabel || undefined,
                  })
                }
              }
              setConnectionContextMenu(null)
            }}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            编辑说明文字
          </button>

          {/* Advanced Style */}
          <button
            className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
            onClick={() => {
              const connection = connections.get(connectionContextMenu.connectionId)
              if (connection) {
                setSelectedIds([connectionContextMenu.connectionId])
                setSelectedType('connection')
                openStylePanel()
              }
              setConnectionContextMenu(null)
            }}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            高级样式...
          </button>

          {/* Color Picker */}
          <label className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2 cursor-pointer">
            <input
              type="color"
              className="w-6 h-6 rounded cursor-pointer"
              defaultValue={(() => {
                const connection = connections.get(connectionContextMenu.connectionId)
                return connection?.color || CONNECTION_DEFAULTS.COLOR
              })()}
              onChange={(e) => {
                updateConnection(connectionContextMenu.connectionId, { color: e.target.value })
                setConnectionContextMenu(null)
              }}
            />
            改变颜色
          </label>

          {/* Add Bend Point - only for orthogonal and curve connections */}
          {(() => {
            const connection = connections.get(connectionContextMenu.connectionId)
            if (connection?.type === 'orthogonal' || connection?.type === 'curve') {
              return (
                <button
                  className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
                  onClick={() => {
                    const connection = connections.get(connectionContextMenu.connectionId)
                    if (connection) {
                      const { addConnectionBendPoint } = useCanvasStore.getState()
                      let newBendPointX, newBendPointY, insertIndex

                      // Use click position if available, otherwise calculate optimal position
                      if (connectionContextMenu.clickX !== undefined && connectionContextMenu.clickY !== undefined) {
                        newBendPointX = connectionContextMenu.clickX
                        newBendPointY = connectionContextMenu.clickY

                        // Calculate insert index based on existing bend points
                        const fromNode = nodes.get(connection.fromNodeId)
                        const toNode = nodes.get(connection.toNodeId)
                        if (fromNode && toNode) {
                          const fromPos = getPortPosition(fromNode, getConnectionPort(connection, 'start'))
                          const toPos = getPortPosition(toNode, getConnectionPort(connection, 'end'))
                          insertIndex = findBendPointInsertIndex(
                            newBendPointX,
                            newBendPointY,
                            fromPos.x,
                            fromPos.y,
                            toPos.x,
                            toPos.y,
                            connection.bendPoints || []
                          )
                        }
                      } else {
                        const fromNode = nodes.get(connection.fromNodeId)
                        const toNode = nodes.get(connection.toNodeId)
                        if (fromNode && toNode) {
                          const fromPos = getPortPosition(fromNode, getConnectionPort(connection, 'start'))
                          const toPos = getPortPosition(toNode, getConnectionPort(connection, 'end'))
                          const optimalPos = calculateOptimalBendPoint(fromPos.x, fromPos.y, toPos.x, toPos.y)
                          newBendPointX = optimalPos.x
                          newBendPointY = optimalPos.y

                          // Calculate insert index for optimal position
                          insertIndex = findBendPointInsertIndex(
                            newBendPointX,
                            newBendPointY,
                            fromPos.x,
                            fromPos.y,
                            toPos.x,
                            toPos.y,
                            connection.bendPoints || []
                          )
                        } else {
                          return
                        }
                      }

                      const newBendPointId = `${connection.id}-bend-${Date.now()}`
                      addConnectionBendPoint(connectionContextMenu.connectionId, newBendPointId, newBendPointX, newBendPointY, insertIndex)
                    }
                    setConnectionContextMenu(null)
                  }}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                  </svg>
                  添加弯折点
                </button>
              )
            }
            return null
          })()}

          <div className="border-t border-gray-200 dark:border-gray-700 my-1" />

          {/* Delete Connection */}
          <button
            className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2 text-red-600 dark:text-red-400"
            onClick={(e) => {
              e.stopPropagation()
              if (connectionContextMenu?.connectionId) {
                if (confirm('确定要删除这条连线吗？')) {
                  removeConnection(connectionContextMenu.connectionId)
                }
              }
              setConnectionContextMenu(null)
            }}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            删除连线
          </button>
        </ContextMenuWrapper>
      )}

      {/* Bend Point Context Menu */}
      {bendPointContextMenu && (
        <ContextMenuWrapper
          x={bendPointContextMenu.x}
          y={bendPointContextMenu.y}
          onClose={() => setBendPointContextMenu(null)}
        >
          {/* Delete Bend Point */}
          <button
            className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2 text-red-600 dark:text-red-400"
            onClick={(e) => {
              e.stopPropagation()
              const { removeConnectionBendPoint } = useCanvasStore.getState()
              removeConnectionBendPoint(bendPointContextMenu.connectionId, bendPointContextMenu.bendPointId)
              setBendPointContextMenu(null)
            }}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            删除弯折点
          </button>
        </ContextMenuWrapper>
      )}

      {/* Domain Context Menu */}
      {domainContextMenu && (
        <DomainContextMenu
          domainId={domainContextMenu.domainId}
          position={{ x: domainContextMenu.x, y: domainContextMenu.y }}
          onClose={() => setDomainContextMenu(null)}
        />
      )}

      {/* Node Context Menu */}
      {nodeContextMenu && (
        <NodeContextMenu
          nodeId={nodeContextMenu.nodeId}
          position={{ x: nodeContextMenu.x, y: nodeContextMenu.y }}
          onClose={() => setNodeContextMenu(null)}
        />
      )}

      {/* Connection Label Edit Dialog */}
      {editingConnectionLabel && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center" style={{ zIndex: Z_INDEX.DIALOG }}>
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-6 w-80">
            <h3 className="text-lg font-medium mb-4 text-gray-900 dark:text-white">
              编辑说明文字
            </h3>
            <input
              type="text"
              value={editingConnectionLabel.label}
              onChange={(e) => {
                e.stopPropagation()
                setEditingConnectionLabel({
                  ...editingConnectionLabel,
                  label: e.target.value,
                })
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.stopPropagation()
                  updateConnection(editingConnectionLabel.connectionId, {
                    label: editingConnectionLabel.label || undefined,
                  })
                  setEditingConnectionLabel(null)
                } else if (e.key === 'Escape') {
                  e.stopPropagation()
                  setEditingConnectionLabel(null)
                }
              }}
              onClick={(e) => e.stopPropagation()}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setEditingConnectionLabel(null)
                }}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-md hover:bg-gray-200 dark:hover:bg-gray-600"
              >
                取消
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  updateConnection(editingConnectionLabel.connectionId, {
                    label: editingConnectionLabel.label || undefined,
                  })
                  setEditingConnectionLabel(null)
                }}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rich Text Toolbar */}
      <RichTextToolbar
        visible={richTextToolbarVisible}
        position={richTextToolbarPosition}
        onCommand={(command, value) => {
          if (editingId) {
            const nodeElement = document.querySelector(`[data-node-id="${editingId}"]`)
            if (nodeElement) {
              const contentEditable = nodeElement.querySelector('[contenteditable="true"]') as HTMLElement
              if (contentEditable) {
                contentEditable.focus()
                if (savedSelectionRef.current) {
                  const selection = window.getSelection()
                  if (selection) {
                    selection.removeAllRanges()
                    selection.addRange(savedSelectionRef.current)
                  }
                }
              }
            }
          }
          if (!['fontSize', 'justifyLeft', 'justifyCenter', 'justifyRight'].includes(command)) {
            document.execCommand(command, false, value)
          }
        }}
        onClose={() => setRichTextToolbarVisible(false)}
        onFocus={() => {
          if (editingId) {
            const nodeElement = document.querySelector(`[data-node-id="${editingId}"]`)
            if (nodeElement) {
              const contentEditable = nodeElement.querySelector('[contenteditable="true"]') as HTMLElement
              if (contentEditable) {
                const selection = window.getSelection()
                if (selection && selection.rangeCount > 0) {
                  savedSelectionRef.current = selection.getRangeAt(0).cloneRange()
                }
                contentEditable.focus()
              }
            }
          }
        }}
      />
    </div>
  )
}
