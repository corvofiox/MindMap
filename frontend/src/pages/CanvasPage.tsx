import { useEffect, useLayoutEffect, useState, useRef, useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useCanvasStore, getYjsBinding } from '@/store/useCanvasStore'
import { useProjectsStore } from '@/store/useProjectsStore'
import { useUIStore } from '@/store/useUIStore'
import { useAuthStore } from '@/store/useAuthStore'
import { useNodePoolStore } from '@/features/node-pool/stores/useNodePoolStore'
import { useCollaboration } from '@/hooks/useCollaboration'
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
import { generateId, colorToHex, hexToRgba, calculateCurveControlPoints, getCurveThroughPoints, getStepPath, pointsToPath, calculateSmartPortPosition, buildConnectionInfoMap, getPortOffsetVector, type PortDirection, type ConnectionInfo } from '@/utils/canvas'
import { saveToCache, loadFromCache } from '@/utils/nodeCache'
import { execFormatCommand } from '@/utils/richTextCommands'
import { loadCanvasNodesData, apiClient } from '@/services/api'
import { ApiError } from '@/services/apiClient'
import { collabService } from '@/services/collaboration'
import type { Node, Connection } from '@/types'
import html2canvas from 'html2canvas-pro'

const AUTO_SAVE_INTERVAL = 5000
const CACHE_SAVE_DELAY = 500
const CANVAS_VIEW_STORAGE_KEY = 'mindmap_canvas_views'

/**
 * Resolve an optimistic-lock clientVersion from a Canvas's updatedAt field.
 *
 * `updatedAt` is always an ISO-8601 string (see shared types: Canvas.updatedAt:
 * string). Earlier code used `parseInt(updatedAt, 10)` for the non-numeric
 * branch, but `parseInt('2026-06-19T...')` stops at the first non-digit and
 * returns `2026`, which is truthy — so the `|| new Date(...).getTime() / 1000`
 * fallback was dead code and a wrong version (2026) was sent to the server.
 *
 * The real source of truth is the UNIX timestamp (seconds). Parse the ISO
 * string via Date; fall back to undefined (no lock) if it is missing/invalid.
 */
function resolveClientVersion(updatedAt: string | undefined): number | undefined {
  if (!updatedAt) return undefined
  const t = new Date(updatedAt).getTime()
  return Number.isFinite(t) ? Math.floor(t / 1000) : undefined
}

// Helper functions to save/load canvas view state from localStorage
const saveCanvasView = (canvasId: number, zoom: number, panX: number, panY: number) => {
  const views = JSON.parse(localStorage.getItem(CANVAS_VIEW_STORAGE_KEY) || '{}')
  views[canvasId] = { zoom, panX, panY, timestamp: Date.now() }
  localStorage.setItem(CANVAS_VIEW_STORAGE_KEY, JSON.stringify(views))
}

const loadCanvasView = (canvasId: number) => {
  const views = JSON.parse(localStorage.getItem(CANVAS_VIEW_STORAGE_KEY) || '{}')
  return views[canvasId] || null
}

// Thumbnail generation constants
const THUMBNAIL = {
  WIDTH: 640,  // Increased from 320 for better clarity
  HEIGHT: 360, // Increased from 180 for better clarity
  BACKGROUND_COLOR: '#f8fafc',
  QUALITY: 0.9, // Increased from 0.8 for better quality
  PADDING: 20,  // Decreased from 40 to maximize content area
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

// Calculate distributed port position when multiple connections share the same port
function getDistributedPortPosition(
  node: Node,
  port: 'top' | 'right' | 'bottom' | 'left',
  index: number,
  total: number
): { x: number; y: number } {
  const basePos = getPortPosition(node, port)
  if (total <= 1) return basePos

  // Calculate offset based on port direction
  // For top/bottom ports, distribute horizontally
  // For left/right ports, distribute vertically

  // 动态计算可用空间：根据端口方向使用宽度或高度
  const availableSpace = port === 'top' || port === 'bottom'
    ? node.width * 0.9  // 水平方向使用 90% 宽度
    : node.height * 0.9 // 垂直方向使用 90% 高度

  // 计算最小间距（至少 8px，确保可点击）
  const minSpacing = 8
  // 计算最大间距（最多 20px，避免过于分散）
  const maxSpacing = 20

  // 根据连线数量动态计算间距
  // 如果空间足够，使用理想间距；否则压缩间距以适应空间
  const idealTotalSpread = (total - 1) * 16  // 理想情况下每条连线间隔 16px
  const actualTotalSpread = Math.min(idealTotalSpread, availableSpace)

  // 动态计算实际间距，确保不小于最小间距
  const actualSpacing = Math.max(
    minSpacing,
    Math.min(maxSpacing, actualTotalSpread / (total - 1 || 1))
  )

  // 计算当前连线的偏移量
  const offset = (index - (total - 1) / 2) * actualSpacing

  switch (port) {
    case 'top':
    case 'bottom':
      return { x: basePos.x + offset, y: basePos.y }
    case 'left':
    case 'right':
      return { x: basePos.x, y: basePos.y + offset }
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

function isPointInNode(node: Node, x: number, y: number): boolean {
  return x >= node.x && x <= node.x + node.width && y >= node.y && y <= node.y + node.height
}

function findNodeAtPoint(nodes: Map<string, Node>, x: number, y: number): Node | null {
  for (const node of nodes.values()) {
    if (isPointInNode(node, x, y)) {
      return node
    }
  }
  return null
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
  bendPoints: { x: number; y: number }[],
  fromPort: 'top' | 'right' | 'bottom' | 'left' = 'right',
  toPort: 'top' | 'right' | 'bottom' | 'left' = 'left'
): { x: number; y: number } {
  if (connType === 'straight') {
    if (bendPoints.length > 0) {
      const points = [{ x: fromX, y: fromY }, ...bendPoints, { x: toX, y: toY }]
      return getPolylineMidpoint(points)
    }
    return { x: (fromX + toX) / 2, y: (fromY + toY) / 2 }
  }

  if (connType === 'curve' && bendPoints.length > 0) {
    const points = [{ x: fromX, y: fromY }, ...bendPoints, { x: toX, y: toY }]
    return getCatmullRomMidpoint(points)
  }

  if (connType === 'step' && bendPoints.length > 0) {
    const points = [{ x: fromX, y: fromY }, ...bendPoints, { x: toX, y: toY }]
    return getPolylineMidpoint(points)
  }

  if (connType === 'curve') {
    // 使用与实际绘制相同的控制点计算逻辑（三次贝塞尔曲线）
    const { cp1x, cp1y, cp2x, cp2y } = calculateCurveControlPointsForLabel(
      fromX, fromY, toX, toY, fromPort, toPort
    )
    return getCubicBezierMidpoint(fromX, fromY, cp1x, cp1y, cp2x, cp2y, toX, toY)
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

// Calculate control points for curve label positioning (same logic as canvas.ts)
function calculateCurveControlPointsForLabel(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  fromPort: 'top' | 'right' | 'bottom' | 'left',
  toPort: 'top' | 'right' | 'bottom' | 'left'
): { cp1x: number; cp1y: number; cp2x: number; cp2y: number } {
  const dx = toX - fromX
  const dy = toY - fromY
  const distance = Math.sqrt(dx * dx + dy * dy) || 1

  const getPortOffsetVector = (port: 'top' | 'right' | 'bottom' | 'left') => {
    switch (port) {
      case 'top': return { dx: 0, dy: -1 }
      case 'right': return { dx: 1, dy: 0 }
      case 'bottom': return { dx: 0, dy: 1 }
      case 'left': return { dx: -1, dy: 0 }
    }
  }

  const fromOffset = getPortOffsetVector(fromPort)
  const toOffset = getPortOffsetVector(toPort)

  const minOffset = Math.max(distance * 0.25, 60)
  const maxOffset = Math.min(distance * 0.5, 150)
  const baseOffset = Math.max(minOffset, maxOffset)

  const cp1x = fromX + fromOffset.dx * baseOffset
  const cp1y = fromY + fromOffset.dy * baseOffset
  const cp2x = toX + toOffset.dx * baseOffset
  const cp2y = toY + toOffset.dy * baseOffset

  return { cp1x, cp1y, cp2x, cp2y }
}

// Get midpoint of a cubic bezier curve
function getCubicBezierMidpoint(
  x1: number, y1: number,
  cp1x: number, cp1y: number,
  cp2x: number, cp2y: number,
  x2: number, y2: number
): { x: number; y: number } {
  const t = 0.5
  const mt = 1 - t
  const mt3 = mt * mt * mt
  const mt2t = 3 * mt * mt * t
  const mt2 = 3 * mt * t * t
  const t3 = t * t * t

  const x = mt3 * x1 + mt2t * cp1x + mt2 * cp2x + t3 * x2
  const y = mt3 * y1 + mt2t * cp1y + mt2 * cp2y + t3 * y2

  return { x, y }
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

// Read CSRF token from cookie for REST API calls
function getCsrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)x-csrf-token=([^;]*)/)
  return match ? decodeURIComponent(match[1]) : ''
}

// keepalive fetch 有 64KB 累积上限（浏览器强制），超限会静默截断请求体，
// 截断的部分数据写入服务端后会让下一步重载时 localStorage 完整缓存被跳过
// 加载（DB 有数据即优先），反而造成数据丢失。因此仅对小负载发送 keepalive
// 网络请求，大负载完全依赖 localStorage 缓存兜底。
//
// 协作模式下跳过 REST 全量快照保存：POST mutex 只串行化其他 POST，不串行
// WS 操作的应用，全量快照会与并发 WS 操作交叉覆盖他人编辑；协作数据由
// 服务端 handleClientDisconnect 的 persistCanvasState 持久化。
//
// beforeunload 与 pagehide 两个处理器共用此逻辑。
const KEEPALIVE_MAX_BODY_BYTES = 48 * 1024

function sendKeepaliveSnapshot(
  id: number,
  data: ReturnType<typeof collectCanvasData>,
): void {
  const token = localStorage.getItem('mindmap_token')
  if (!token || collabService.isConnected()) return
  const body = JSON.stringify(data)
  if (new Blob([body]).size >= KEEPALIVE_MAX_BODY_BYTES) return
  fetch(`/api/canvases/${id}/data`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'x-csrf-token': getCsrfToken(),
    },
    credentials: 'include',
    body,
    keepalive: true,
  }).catch(() => { })
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
  const connectionContextMenuStartRef = useRef({ x: 0, y: 0 })
  const nodeContextMenuStartRef = useRef({ x: 0, y: 0 })
  const panStartRef = useRef({ x: 0, y: 0 })
  const panRafRef = useRef<number | null>(null)
  const pendingPanRef = useRef<{ x: number; y: number } | null>(null)
  const cacheTimeoutRef = useRef<ReturnType<typeof setTimeout>>()
  const dbSaveTimeoutRef = useRef<ReturnType<typeof setTimeout>>()
  const mouseDownOnContentRef = useRef(false) // Track if mouse down was on content
  const [hasInitializedCamera, setHasInitializedCamera] = useState(false) // Track if camera has been initialized
  const [hasLoadedCanvasData, setHasLoadedCanvasData] = useState(false) // Track if canvas data has been loaded
  const justFinishedConnectionRef = useRef(false) // Track if just finished creating a connection
  const justFinishedBoxSelectingRef = useRef(false) // Track if just finished box selection
  const justFinishedEndpointDraggingRef = useRef(false) // Track if just finished dragging endpoint
  const justFinishedBendPointDraggingRef = useRef(false) // Track if just finished dragging bend point

  // Thumbnail worker ref
  const thumbnailWorkerRef = useRef<Worker | null>(null)
  const pendingThumbnailRequests = useRef<Map<string, (dataUrl: string | null) => void>>(new Map())

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

  // Start port preview state for connection creation
  const [startPortPreview, setStartPortPreview] = useState<{ port: 'top' | 'right' | 'bottom' | 'left'; position: { x: number; y: number } } | null>(null)

  // Hovered port state for showing port preview before connection starts
  const [hoveredPort, setHoveredPort] = useState<{ nodeId: string; port: 'top' | 'right' | 'bottom' | 'left'; position: { x: number; y: number } } | null>(null)

  // Node dragging state for real-time connection updates
  // Using ref to avoid re-renders on every mousemove
  const draggingNodePositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map())
  // Counter to force re-render when dragging position changes
  const [, setDragRenderCounter] = useState(0)

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
  const [editingField, setEditingField] = useState<'title' | 'content' | null>(null)

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
    aiSidebarOpen,
    stylePanelOpen,
    sidebarOpen,
    minimapVisible,
    relationshipHighlightMode,
    setCurrentTool,
    toggleGrid,
    toggleQuickEditMode,
    toggleRelationshipHighlightMode,
    toggleDragMode,
    toggleMinimap,
    setSelectedType,
    isLoading,
    setLoading,
    connectionType,
    connectionDirection,
    connectionStyle,
    closeStylePanel,
    openStylePanel,
    addToast,
    nodeDefaults,
    toggleSidebar,
    toggleNodePool,
    setSettingsOpen,
    setCommandPaletteOpen,
    zoomStep,
  } = useUIStore()

  const id = canvasId ? parseInt(canvasId) : null

  const { sendCursor } = useCollaboration({
    canvasId: id || 0,
    enabled: id !== null && id > 0,
    // P3: 被 owner 移除成员资格时提示并跳转回项目列表
    onKicked: () => {
      addToast({
        type: 'warning',
        title: '已被移出项目',
        message: '你已不再是该项目成员，无法继续协作',
      })
      navigate('/')
    },
  })

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

  // Cancel any pending pan rAF on unmount
  useEffect(() => {
    return () => {
      if (panRafRef.current) {
        cancelAnimationFrame(panRafRef.current)
        panRafRef.current = null
      }
    }
  }, [])

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

        // Remove from pool after adding to canvas (Move operation)
        // Using direct store access to avoid adding dependency to useEffect
        const { removeCard } = useNodePoolStore.getState()
        removeCard(card.id)

        addToast({ type: 'success', title: '移动成功', message: '节点已移动到画布' })

        // 清除拖拽状态
        const { setDraggingCardFromPool, setIsOverCanvas, setPoolDragGhostPosition } = useUIStore.getState()
        setDraggingCardFromPool(null)
        setIsOverCanvas(false)
        setPoolDragGhostPosition(null)
      } catch (error) {
        addToast({ type: 'error', title: '移动失败', message: '无法解析节点数据' })
      }
    }

    document.addEventListener('canvasDrop', handleCanvasDrop as EventListener)

    return () => {
      document.removeEventListener('canvasDrop', handleCanvasDrop as EventListener)
    }
  }, [addNode, addToast, panX, panY, zoom])

  const { loadProjects, restoreCurrentProject, canvases, updateCanvas: updateCanvasInStore, currentMemberRole } = useProjectsStore()
  const { user } = useAuthStore()

  const canEdit = currentMemberRole === 'owner' || currentMemberRole === 'editor'
  const isViewer = currentMemberRole === 'viewer'

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
    // 注意：只有当 canvases 已加载（length > 0）时才检查，避免在初始加载时误判
    if (!canvasExists && !hasTemporaryCanvas && canvases.length > 0) {
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
    setHasInitializedCamera(false)

    // Reset data loaded flag when canvas changes
    setHasLoadedCanvasData(false)

    // Reset last save time when canvas changes
    lastSaveTimeRef.current = 0

    // Initialize thumbnail worker
    try {
      thumbnailWorkerRef.current = new Worker(new URL('@/workers/thumbnail.worker.ts', import.meta.url), {
        type: 'module',
      })

      thumbnailWorkerRef.current.onmessage = (event) => {
        const { id, type, data, error } = event.data
        const resolve = pendingThumbnailRequests.current.get(id)
        if (resolve) {
          resolve(data)
          pendingThumbnailRequests.current.delete(id)
        }
        if (error) {
          // Worker error handled silently
        }
      }

      thumbnailWorkerRef.current.onerror = () => {
        // Worker error handled silently
      }
    } catch {
      // Failed to initialize worker, continue without it
      thumbnailWorkerRef.current = null
    }

    // Track if this effect is still active
    let isCancelled = false
    let isMounted = true

    const loadFromDatabase = async () => {
      try {
        setLoading(true)

        // Clear old canvas data immediately when entering this canvas.
        // This serves two purposes:
        // 1. Prevents showing stale data from the previous canvas during loading.
        // 2. Ensures the WebSocket sync guard below correctly detects that any
        //    data in the store was put there by the CURRENT canvas's WebSocket sync
        //    (not leaked from a previous canvas).
        //
        // IMPORTANT: clearCanvas() MUST run BEFORE setCanvasId() below.
        // If a pagehide/beforeunload event fires between setCanvasId() and
        // clearCanvas(), the handlers would save the OLD canvas's data under
        // the NEW canvas's cache key, causing cross-canvas data corruption.
        const initBinding = getYjsBinding()
        if (initBinding) {
          initBinding.suppressSync(() => { clearCanvas() })
        } else {
          clearCanvas()
        }

        // Update store canvasId AFTER clearing old data, so any page lifecycle
        // event (pagehide, beforeunload) between these two calls will see the
        // correct canvasId paired with empty data, rather than the old canvas's
        // data under the new canvas's ID.
        setCanvasId(id)

        // 如果是临时ID，不尝试从数据库加载数据
        if (id < 0) {
          setDirty(false)
          return
        }

        // Ensure projects are loaded first to get correct context
        if (useProjectsStore.getState().projects.length === 0) {
          await stableLoadProjects()
          await stableRestoreCurrentProject()

          // Check if cancelled after async operations
          if (!isMounted || isCancelled) {
            return
          }
        }

        const dbData = await loadCanvasNodesData(id)

        // Check if cancelled after API call
        if (!isMounted || isCancelled) {
          return
        }

        // During the async DB load above, WebSocket sync may have completed
        // and already populated the canvas store with fresh data. The API
        // response below was generated before those synced changes were committed
        // to the database, so loading it after sync would:
        // 1. Overwrite fresh canvas data with stale DB data
        // 2. Reset serverVersion to a stale value, causing every subsequent
        //    operation to be NAKed with version-conflict → full sync cycle on
        //    every edit (the "canvas clears on each edit" bug).
        const storeState = useCanvasStore.getState()
        if (collabService.isConnected() &&
          (storeState.nodes.size > 0 || storeState.domains.size > 0)) {
          setDirty(false)
          return
        }

        const hasData = dbData && (
          (dbData.nodes && dbData.nodes.length > 0) ||
          (dbData.groups && dbData.groups.length > 0) ||
          (dbData.domains && dbData.domains.length > 0) ||
          (dbData.connections && dbData.connections.length > 0)
        )

        if (hasData) {
          const binding = getYjsBinding()
          if (binding) {
            binding.suppressSync(() => {
              clearCanvas()
              setCanvasData(dbData)
            })
          } else {
            clearCanvas()
            setCanvasData(dbData)
          }
          setDirty(false)
          saveToCache(id, dbData)
        } else {
          // No data in DB, try cache
          const cachedData = loadFromCache(id)
          if (cachedData) {
            const binding = getYjsBinding()
            if (binding) {
              binding.suppressSync(() => {
                clearCanvas()
                setCanvasData(cachedData)
              })
            } else {
              clearCanvas()
              setCanvasData(cachedData)
            }
            setDirty(false)
          } else {
            // No data anywhere
            const binding = getYjsBinding()
            if (binding) {
              binding.suppressSync(() => { clearCanvas() })
            } else {
              clearCanvas()
            }
          }
        }
      } catch (error) {
        // Check if cancelled
        if (!isMounted || isCancelled) {
          return
        }

        // DB load failed, fallback to cache
        const cachedData = loadFromCache(id)
        if (cachedData) {
          const binding = getYjsBinding()
          if (binding) {
            binding.suppressSync(() => {
              clearCanvas()
              setCanvasData(cachedData)
            })
          } else {
            clearCanvas()
            setCanvasData(cachedData)
          }
          setDirty(false)
        } else {
          const binding = getYjsBinding()
          if (binding) {
            binding.suppressSync(() => { clearCanvas() })
          } else {
            clearCanvas()
          }
        }
      } finally {
        // Only update state if still mounted
        if (isMounted) {
          setLoading(false)
          setHasLoadedCanvasData(true)
        }
      }
    }

    loadFromDatabase()

    return () => {
      // Mark as cancelled when effect is cleaned up
      isCancelled = true
      isMounted = false

      // Force-save dirty data before switching canvases or unmounting
      // This prevents data loss when auto-save timers are cancelled below
      if (id > 0) {
        const state = useCanvasStore.getState()
        if (state.isDirty && state.canvasId === id) {
          const canvasData = collectCanvasData(state)
          // localStorage 缓存无论协作与否都写，作为兜底备份
          saveToCache(id, canvasData)
          // 协作模式下跳过 REST 全量快照保存：POST mutex 只串行化其他 POST，
          // 不串行 WS 操作的应用，全量快照会与并发 WS 操作交叉覆盖他人编辑。
          // 协作模式数据由服务端 handleClientDisconnect 的 persistCanvasState
          // 持久化，无需客户端再发全量快照。与 saveToDatabase/handleManualSave
          // 保持一致。
          if (!collabService.isConnected()) {
            // 使用 apiClient.post 替代 fetch(keepalive: true)：
            // 1. 切换画布时页面未卸载，无需 keepalive 保证请求完成
            // 2. apiClient 自动处理 CSRF 获取/刷新/重试
            // 3. 无 64KB 负载上限（keepalive fetch 的浏览器限制）
            apiClient.post(`/api/canvases/${id}/data`, canvasData).catch(() => { })
          }
        }
      }

      clearTimeout(cacheTimeoutRef.current)
      clearTimeout(dbSaveTimeoutRef.current)

      // Terminate thumbnail worker
      if (thumbnailWorkerRef.current) {
        thumbnailWorkerRef.current.terminate()
        thumbnailWorkerRef.current = null
      }
    }
  }, [canvasId])

  // 组件卸载时清空画布ID
  useEffect(() => {
    return () => {
      // 组件卸载时清空 canvasId，确保 AI 侧边栏进入锁定状态
      setCanvasId(null)
    }
  }, [])

  // Initialize camera position from localStorage when canvas data is loaded
  useEffect(() => {
    if (!canvasId) return

    const id = parseInt(canvasId)
    if (isNaN(id)) return

    if (hasInitializedCamera) return

    if (isLoading) return

    // Only initialize camera after data has been loaded
    if (!hasLoadedCanvasData) return

    // Wait for container to have valid dimensions
    if (containerSize.width === 0 || containerSize.height === 0) return

    // Load saved view state from localStorage
    const savedView = loadCanvasView(id)
    if (savedView) {
      // Restore saved camera state
      setZoom(savedView.zoom)
      setPan(savedView.panX, savedView.panY)
    } else {
      // Set default view state: 100% zoom, viewport centered at origin
      // Calculate pan so that viewport center aligns with canvas origin (0, 0)
      // viewport center = (containerWidth/2 - panX) / zoom = 0
      // => panX = containerWidth / 2
      const defaultPanX = containerSize.width / 2
      const defaultPanY = containerSize.height / 2
      setZoom(1)
      setPan(defaultPanX, defaultPanY)
      // Save default state to localStorage
      saveCanvasView(id, 1, defaultPanX, defaultPanY)
    }

    setHasInitializedCamera(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasId, containerSize.width, containerSize.height, isLoading, hasLoadedCanvasData, hasInitializedCamera])

  // Note: We no longer auto-adjust zoom when container size changes
  // The zoom level should remain constant, only the viewport size changes
  // The minimap will automatically update to reflect the new viewport size

  // Auto-save camera state to localStorage when zoom or pan changes
  useEffect(() => {
    if (!canvasId) return

    const id = parseInt(canvasId)
    if (isNaN(id)) return

    // Only save after camera has been initialized
    if (!hasInitializedCamera) return

    // Debounce save to avoid frequent writes
    const timer = setTimeout(() => {
      saveCanvasView(id, zoom, panX, panY)
    }, 500)

    return () => clearTimeout(timer)
  }, [canvasId, zoom, panX, panY, hasInitializedCamera])

  const generateThumbnail = useCallback(async (canvasId: number) => {
    if (!thumbnailWorkerRef.current) {
      return
    }

    try {
      const currentStore = useCanvasStore.getState()

      if (currentStore.canvasId !== canvasId) {
        return
      }

      const nodesArray = Array.from(currentStore.nodes.values())
      const connectionsArray = Array.from(currentStore.connections.values())
      const groupsArray = Array.from(currentStore.groups.values())
      const domainsArray = Array.from(currentStore.domains.values())

      if (nodesArray.length === 0 && groupsArray.length === 0 && domainsArray.length === 0) {
        const canvas = document.createElement('canvas')
        canvas.width = THUMBNAIL.WIDTH
        canvas.height = THUMBNAIL.HEIGHT
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.fillStyle = THUMBNAIL.BACKGROUND_COLOR
          ctx.fillRect(0, 0, canvas.width, canvas.height)
          const thumbnailDataUrl = canvas.toDataURL('image/jpeg', THUMBNAIL.QUALITY)
          // Skip the optimistic-lock clientVersion in collaboration mode — same
          // rationale as the non-empty branch below: multiple peers may PUT
          // thumbnails concurrently and version-checking would cause a storm of
          // 409s for a best-effort preview.
          const canvasMeta = collabService.isConnected()
            ? undefined
            : useProjectsStore.getState().canvases.find((c) => c.id === canvasId)
          const clientVersion = resolveClientVersion(canvasMeta?.updatedAt)
          await updateCanvasInStore(canvasId, {
            thumbnail: thumbnailDataUrl,
            clientVersion,
          }, true)
        }
        return
      }

      const requestId = `thumb-${canvasId}-${Date.now()}`

      thumbnailWorkerRef.current.postMessage({
        type: 'generateThumbnail',
        id: requestId,
        nodes: nodesArray,
        connections: connectionsArray,
        groups: groupsArray,
        domains: domainsArray,
        targetWidth: THUMBNAIL.WIDTH,
        targetHeight: THUMBNAIL.HEIGHT,
        quality: THUMBNAIL.QUALITY,
        backgroundColor: THUMBNAIL.BACKGROUND_COLOR,
        padding: THUMBNAIL.PADDING,
      })

      const thumbnailDataUrl = await new Promise<string | null>((resolve) => {
        pendingThumbnailRequests.current.set(requestId, resolve)

        setTimeout(() => {
          if (pendingThumbnailRequests.current.has(requestId)) {
            pendingThumbnailRequests.current.delete(requestId)
            resolve(null)
          }
        }, 30000)
      })

      if (thumbnailDataUrl) {
        // In collaboration mode we intentionally skip the optimistic-lock
        // clientVersion. Multiple peers generate thumbnails concurrently, so
        // version-checking would produce a storm of 409 responses and stale
        // previews. The last thumbnail wins, which is acceptable for a
        // best-effort preview.
        const clientVersion = collabService.isConnected()
          ? undefined
          : resolveClientVersion(
            useProjectsStore.getState().canvases.find((c) => c.id === canvasId)?.updatedAt,
          )
        await updateCanvasInStore(canvasId, {
          thumbnail: thumbnailDataUrl,
          clientVersion,
        }, true)
      }
    } catch {
      // Thumbnail generation failed silently
    }
  }, [])

  // Debounced thumbnail generation to avoid excessive updates
  const thumbnailTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastRemoteThumbnailRef = useRef<number>(0)

  const triggerThumbnailGeneration = useCallback((canvasId: number) => {
    // During active collaboration, remote changes arrive every 100ms (drag
    // throttle) or faster. Enforce a minimum 2s interval between remote-triggered
    // thumbnails so they don't flash on every peer edit.
    const now = Date.now()
    if (now - lastRemoteThumbnailRef.current < 2000) return
    lastRemoteThumbnailRef.current = now
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
      // CRITICAL: Check if we're still on the same canvas before saving to cache
      if (state.canvasId !== id) {
        return
      }
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

      // CRITICAL: Check if we're still on the same canvas before saving
      // This prevents saving the wrong canvas's data when switching between canvases
      if (currentState.canvasId !== id) {
        return
      }

      if (!currentIsDirty) {
        dbSaveTimeoutRef.current = setTimeout(saveToDatabase, AUTO_SAVE_INTERVAL)
        return
      }

      // In collaboration mode, changes are saved in real-time via WebSocket, skip REST API auto-save.
      // Still generate a thumbnail for local edits, then clear the dirty flag so
      // we don't keep re-triggering thumbnail PUTs on every timer tick.
      if (collabService.isConnected()) {
        const state = useCanvasStore.getState()
        if (state.canvasId === id) {
          const { nodes, domains } = collectCanvasData(state)
          if (hasCanvasContent(nodes, domains)) {
            triggerThumbnailGeneration(id)
          }
        }
        setDirty(false)
        dbSaveTimeoutRef.current = setTimeout(saveToDatabase, AUTO_SAVE_INTERVAL)
        return
      }

      const now = Date.now()
      if (now - currentLastSaveTime < AUTO_SAVE_INTERVAL) {
        dbSaveTimeoutRef.current = setTimeout(saveToDatabase, AUTO_SAVE_INTERVAL)
        return
      }

      try {
        const state = useCanvasStore.getState()
        const canvasData = collectCanvasData(state)
        const snapshotNodes = state.nodes
        const snapshotGroups = state.groups
        const snapshotDomains = state.domains
        const snapshotConnections = state.connections

        await apiClient.post<{ message: string; version: number }>(`/api/canvases/${id}/data`, canvasData)

        lastSaveTimeRef.current = Date.now()
        const currentState = useCanvasStore.getState()
        if (currentState.nodes === snapshotNodes &&
          currentState.groups === snapshotGroups &&
          currentState.domains === snapshotDomains &&
          currentState.connections === snapshotConnections) {
          setDirty(false)
        }

        // Generate thumbnail after successful auto-save
        if (hasCanvasContent(canvasData.nodes, canvasData.domains)) {
          await triggerThumbnailGeneration(id)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (error instanceof ApiError && error.status === 409) {
          addToast({ type: 'warning', title: '保存冲突', message: '已获取服务端最新版本，可再次保存' })
        } else if (message.includes('网络连接失败')) {
          addToast({ type: 'error', title: '保存失败', message: '网络错误，请检查连接后重试' })
        } else {
          addToast({ type: 'error', title: '保存失败', message: '服务器错误，请稍后重试' })
        }
      } finally {
        dbSaveTimeoutRef.current = setTimeout(saveToDatabase, AUTO_SAVE_INTERVAL)
      }
    }

    dbSaveTimeoutRef.current = setTimeout(saveToDatabase, AUTO_SAVE_INTERVAL)

    return () => {
      if (dbSaveTimeoutRef.current) {
        clearTimeout(dbSaveTimeoutRef.current)
      }
    }
  }, [canvasId, setDirty, triggerThumbnailGeneration, addToast])

  // Manual save function
  const handleManualSave = useCallback(async () => {
    if (!canvasId) return

    const id = parseInt(canvasId)
    if (isNaN(id)) return

    // In collaboration mode, edits are synced in real time via WebSocket.
    // Sending a full-snapshot POST /data here races with concurrent WS ops:
    // the POST mutex only serializes other POSTs, not WS applies, so a WS
    // op landing between the POST's state read and its DB write could be
    // overwritten by the (staler) client snapshot. The auto-save and Ctrl+S
    // paths already skip POST in collaboration mode; do the same here so the
    // toolbar save button can't trigger the race. Still flush the thumbnail.
    if (collabService.isConnected()) {
      const state = useCanvasStore.getState()
      const { nodes, domains } = collectCanvasData(state)
      if (hasCanvasContent(nodes, domains)) {
        await generateThumbnail(id)
      }
      addToast({
        type: 'info',
        title: '已实时保存',
        message: '协作模式下编辑内容会实时同步到服务器',
        duration: 3000,
      })
      return
    }

    const state = useCanvasStore.getState()
    const canvasData = collectCanvasData(state)

    try {
      await apiClient.post<{ message: string; version: number }>(`/api/canvases/${id}/data`, canvasData)

      lastSaveTimeRef.current = Date.now()
      setDirty(false)

      if (hasCanvasContent(canvasData.nodes, canvasData.domains)) {
        await generateThumbnail(id)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof ApiError && error.status === 409) {
        addToast({ type: 'warning', title: '保存冲突', message: '已获取服务端最新版本，可再次保存' })
      } else if (message.includes('网络连接失败')) {
        addToast({ type: 'error', title: '保存失败', message: '网络错误，请检查连接后重试' })
      } else {
        addToast({ type: 'error', title: '保存失败', message: '服务器错误，请稍后重试' })
      }
    }
  }, [canvasId, setDirty, generateThumbnail, addToast])

  // Handle page refresh/close - save data immediately before unloading
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!canvasId) return

      const id = parseInt(canvasId)
      if (isNaN(id)) return

      const state = useCanvasStore.getState()

      if (state.isDirty) {
        // Guard: skip if canvasId has already changed (race with canvas
        // switch). Matches the check in handlePageHide below.
        if (state.canvasId !== id) return
        e.preventDefault()
        e.returnValue = ''

        const canvasData = collectCanvasData(state)

        try {
          saveToCache(id, canvasData)
        } catch (error) {
          // Silently fail for cache save errors
        }

        // 尝试通过 REST API 兜底保存。仅对小负载发送 keepalive 网络请求，
        // 大负载完全依赖上面的 localStorage 缓存兜底。协作模式下跳过 REST
        // 保存（见 sendKeepaliveSnapshot 注释）。
        try {
          sendKeepaliveSnapshot(id, canvasData)
        } catch (error) {
          // Silently fail
        }

        // Generate thumbnail when page is being unloaded
        if (hasCanvasContent(canvasData.nodes, canvasData.domains)) {
          triggerThumbnailGeneration(id)
        }
      }
    }

    // pagehide: 比 beforeunload 更可靠的页面卸载兜底（含移动端浏览器后台化场景）
    // 立即写入 localStorage 作为紧急备份，不依赖 500ms 防抖的 cache save
    // 同时通过 sendBeacon 发送网络请求，确保数据在服务端持久化
    const handlePageHide = () => {
      if (!canvasId) return
      const id = parseInt(canvasId)
      if (isNaN(id)) return

      try {
        const state = useCanvasStore.getState()
        // 与 handleBeforeUnload 保持一致，仅在有未保存更改时写入缓存
        if (state.canvasId !== id || !state.isDirty) return
        const canvasData = collectCanvasData(state)
        if (canvasData.nodes.length > 0 || canvasData.groups.length > 0 || canvasData.domains.length > 0) {
          saveToCache(id, { nodes: canvasData.nodes, groups: canvasData.groups, domains: canvasData.domains, connections: canvasData.connections })

          // 仅对小负载发送 keepalive 网络请求，大负载完全依赖上面的
          // localStorage 缓存兜底。协作模式下跳过 REST 保存
          // （见 sendKeepaliveSnapshot 注释）。
          sendKeepaliveSnapshot(id, canvasData)
        }
      } catch {
        // Silently fail
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    window.addEventListener('pagehide', handlePageHide)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      window.removeEventListener('pagehide', handlePageHide)

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

  useLayoutEffect(() => {
    // 使用 ref 追踪是否已就绪，避免重复设置状态
    let isReady = false
    let lastWidth = 0
    let lastHeight = 0
    const STABLE_FRAMES = 3
    let stableFrameCount = 0

    const updateSize = () => {
      if (containerRef.current) {
        const width = containerRef.current.clientWidth
        const height = containerRef.current.clientHeight

        // 立即更新容器大小，不等待稳定
        if (width > 0 && height > 0) {
          setContainerSize({ width, height })
        }

        // Check if size is stable (not changing rapidly)
        if (width === lastWidth && height === lastHeight) {
          stableFrameCount++
        } else {
          stableFrameCount = 0
          lastWidth = width
          lastHeight = height
        }

        // Only set ready when size is stable and non-zero
        if (!isReady && width > 0 && height > 0 && stableFrameCount >= STABLE_FRAMES) {
          isReady = true
          setContainerReady(true)
          return true
        }
      }
      return isReady
    }

    // 使用 requestAnimationFrame 确保 DOM 已经渲染完成
    const measure = () => {
      if (containerRef.current) {
        const width = containerRef.current.clientWidth
        const height = containerRef.current.clientHeight

        if (width > 0 && height > 0) {
          // 立即设置容器大小
          setContainerSize({ width, height })
          updateSize()
          return
        }
      }
      // 如果容器大小为 0，继续等待
      requestAnimationFrame(measure)
    }

    requestAnimationFrame(measure)

    const resizeObserver = new ResizeObserver(() => {
      updateSize()
    })

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current)
    }

    const handleResize = () => {
      updateSize()
    }

    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      resizeObserver.disconnect()
    }
  }, [])


  // Update container size when sidebar state changes
  useEffect(() => {
    let frameCount = 0
    const STABLE_FRAMES = 3
    let lastWidth = 0
    let lastHeight = 0
    let stableFrameCount = 0

    const measure = () => {
      if (containerRef.current) {
        const width = containerRef.current.clientWidth
        const height = containerRef.current.clientHeight

        // Check if size is stable
        if (width === lastWidth && height === lastHeight) {
          stableFrameCount++
        } else {
          stableFrameCount = 0
          lastWidth = width
          lastHeight = height
        }

        // Update size each frame, but wait for stability before considering it final
        setContainerSize({ width, height })

        if (stableFrameCount >= STABLE_FRAMES) {
          return true
        }
      }

      frameCount++
      if (frameCount < 30) {
        requestAnimationFrame(measure)
      }
      return false
    }

    requestAnimationFrame(measure)
  }, [nodePoolOpen, aiSidebarOpen, sidebarOpen])

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle shortcuts when typing in input fields
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement).contentEditable === 'true'
      ) {
        return
      }

      // Don't handle most shortcuts when editing
      const { editingId: currentEditingId } = useCanvasStore.getState()
      if (currentEditingId !== null) {
        // Only allow Escape when editing
        if (e.key === 'Escape') {
          setEditingId(null)
        }
        return
      }

      // Ctrl+S save shortcut
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        // In collaboration mode, changes are already saved in real-time via WebSocket
        if (collabService.isConnected()) {
          addToast({
            type: 'info',
            title: '已实时保存',
            message: '协作模式下编辑内容会实时同步到服务器',
            duration: 3000,
          })
          return
        }
        handleManualSave().then(() => {
          addToast({
            type: 'success',
            title: '保存成功',
            message: '画布内容已保存到服务器',
            duration: 3000,
          })
        }).catch((error) => {
          addToast({
            type: 'error',
            title: '保存失败',
            message: error instanceof Error ? error.message : '保存画布时发生错误',
            duration: 5000,
          })
        })
        return
      }

      // Delete/Backspace
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length > 0) {
        e.preventDefault()
        const { removeNode, removeConnection, removeGroup, removeDomain, nodes: currentNodes, connections: currentConnections, groups: currentGroups, domains: currentDomains } = useCanvasStore.getState()
        selectedIds.forEach((id) => {
          if (currentNodes.has(id)) {
            removeNode(id)
          } else if (currentConnections.has(id)) {
            removeConnection(id)
          } else if (currentGroups.has(id)) {
            removeGroup(id)
          } else if (currentDomains.has(id)) {
            removeDomain(id)
          }
        })
        setSelectedIds([])
        return
      }

      // Undo: Ctrl+Z
      if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault()
        if (canUndo()) {
          undo()
        }
        return
      }

      // Redo: Ctrl+Y or Ctrl+Shift+Z
      if (((e.key === 'y' || e.key === 'Y') && (e.ctrlKey || e.metaKey)) ||
        ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && e.shiftKey)) {
        e.preventDefault()
        if (canRedo()) {
          redo()
        }
        return
      }

      // Duplicate: Ctrl+D
      if ((e.key === 'd' || e.key === 'D') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        const { duplicateNode } = useCanvasStore.getState()
        if (selectedIds.length === 1) {
          duplicateNode(selectedIds[0])
        }
        return
      }

      // Copy: Ctrl+C
      if ((e.key === 'c' || e.key === 'C') && (e.ctrlKey || e.metaKey)) {
        const nodesToCopy = selectedIds.map((id) => nodes.get(id)).filter(Boolean)
        sessionStorage.setItem('clipboard_nodes', JSON.stringify(nodesToCopy))
        return
      }

      // Paste: Ctrl+V
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
          } catch {
            // Silently fail
          }
        }
        return
      }

      // Select all: Ctrl+A
      if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        setSelectedIds(Array.from(nodes.keys()))
        return
      }

      // Shift key - toggle drag mode
      if (e.key === 'Shift' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        toggleDragMode()
        return
      }

      // Tool shortcuts (single key, no modifiers)
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
        if (e.key === 'n' || e.key === 'N') {
          setCurrentTool(currentTool === 'node' ? 'select' : 'node')
          return
        } else if (e.key === 'i' || e.key === 'I') {
          setCurrentTool(currentTool === 'image' ? 'select' : 'image')
          return
        } else if (e.key === 'r' || e.key === 'R') {
          setCurrentTool(currentTool === 'domain' ? 'select' : 'domain')
          return
        } else if (e.key === 'l' || e.key === 'L') {
          setCurrentTool(currentTool === 'connection' ? 'select' : 'connection')
          return
        } else if (e.key === 'g' || e.key === 'G') {
          setCurrentTool(currentTool === 'group' ? 'select' : 'group')
          return
        } else if (e.key === 'h' || e.key === 'H') {
          toggleGrid()
          return
        } else if (e.key === 'm' || e.key === 'M') {
          toggleMinimap()
          return
        } else if (e.key === 'e' || e.key === 'E') {
          toggleQuickEditMode()
          return
        } else if (e.key === 't' || e.key === 'T') {
          toggleRelationshipHighlightMode()
          return
        } else if (e.key === 'o' || e.key === 'O') {
          // 优化连线 - 调整所有连线到最近端口
          e.preventDefault()
          const { connections: currentConnections, nodes: currentNodes, updateConnection } = useCanvasStore.getState()
          let organizedCount = 0

          currentConnections.forEach((conn) => {
            const fromNode = currentNodes.get(conn.fromNodeId)
            const toNode = currentNodes.get(conn.toNodeId)
            if (!fromNode || !toNode) return

            // 计算两个节点的中心点
            const fromCenterX = fromNode.x + fromNode.width / 2
            const fromCenterY = fromNode.y + fromNode.height / 2
            const toCenterX = toNode.x + toNode.width / 2
            const toCenterY = toNode.y + toNode.height / 2

            // 计算角度来确定最佳端口方向
            const dx = toCenterX - fromCenterX
            const dy = toCenterY - fromCenterY
            const angle = Math.atan2(dy, dx) * (180 / Math.PI)

            // 根据角度确定最佳端口方向
            let bestFromPort: 'top' | 'right' | 'bottom' | 'left'
            let bestToPort: 'top' | 'right' | 'bottom' | 'left'

            if (angle >= -45 && angle < 45) {
              bestFromPort = 'right'
              bestToPort = 'left'
            } else if (angle >= 45 && angle < 135) {
              bestFromPort = 'bottom'
              bestToPort = 'top'
            } else if (angle >= 135 || angle < -135) {
              bestFromPort = 'left'
              bestToPort = 'right'
            } else {
              bestFromPort = 'top'
              bestToPort = 'bottom'
            }

            // 只有当端口发生变化时才更新
            if (conn.fromPort !== bestFromPort || conn.toPort !== bestToPort) {
              updateConnection(conn.id, {
                fromPort: bestFromPort,
                toPort: bestToPort,
              })
              organizedCount++
            }
          })

          // 显示提示
          if (organizedCount > 0) {
            addToast({
              type: 'success',
              title: '优化完成',
              message: `已优化 ${organizedCount} 条连线的端口位置`,
              duration: 3000,
            })
          } else {
            addToast({
              type: 'info',
              title: '无需优化',
              message: '所有连线的端口位置已经是最优',
              duration: 2000,
            })
          }
          return
        } else if (e.key === 'Enter') {
          if (selectedIds.length === 1) {
            const nodeId = selectedIds[0]
            if (nodes.has(nodeId)) {
              e.preventDefault()
              setEditingId(nodeId)
              return
            }
          }
        } else if (e.key === 'Escape') {
          setCurrentTool('select')
          setEditingId(null)
          setIsCreatingConnection(false)
          setConnectionStartNodeId(null)
          setStartPortPreview(null)
          return
        }
      }

      // Ctrl+G create group
      if ((e.ctrlKey || e.metaKey) && (e.key === 'g' || e.key === 'G')) {
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
        return
      }

      // Zoom shortcuts
      if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault()
        setZoom(1)
      } else if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        setZoom(Math.min(zoom + 0.1, 5))
      } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault()
        setZoom(Math.max(zoom - 0.1, 0.1))
      }

      // Panel shortcuts
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault()
        toggleSidebar()
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault()
        toggleNodePool()
      } else if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault()
        setSettingsOpen(true)
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        setCommandPaletteOpen(true)
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [zoom, currentTool, setCurrentTool, setZoom, setPan, toggleGrid, toggleQuickEditMode, toggleRelationshipHighlightMode, toggleDragMode, toggleMinimap, setEditingId, nodes, groups, selectedIds, addGroup, toggleSidebar, toggleNodePool, setSettingsOpen, setCommandPaletteOpen, handleManualSave, setIsCreatingConnection, setConnectionStartNodeId, setStartPortPreview, setSelectedIds, canUndo, canRedo, undo, redo, addNode, addToast])

  // Space key for canvas drag
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement).contentEditable === 'true')) {
        e.preventDefault()
        setIsSpacePressed(true)
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault()
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
        setHoveredPort(null)

        const rect = containerRef.current?.getBoundingClientRect()
        if (rect) {
          const canvasMouseX = (mouseX - rect.left - panX) / zoom
          const canvasMouseY = (mouseY - rect.top - panY) / zoom
          const bestPort = findBestPort(node, canvasMouseX, canvasMouseY)
          setConnectionStartPort(bestPort)

          const portPosition = getPortPosition(node, bestPort)
          setConnectionEndPosition(portPosition)
          setStartPortPreview({ port: bestPort, position: portPosition })
        }
      }
    }

    window.addEventListener('connectionStart', handleConnectionStart)
    return () => {
      window.removeEventListener('connectionStart', handleConnectionStart)
    }
  }, [nodes, panX, panY, zoom])

  // Handle node editing field change from NodeItem
  useEffect(() => {
    const handleNodeEditingFieldChange = (e: Event) => {
      const customEvent = e as CustomEvent<{ field: 'title' | 'content' | null }>
      setEditingField(customEvent.detail.field)
    }

    window.addEventListener('nodeEditingFieldChange', handleNodeEditingFieldChange)
    return () => {
      window.removeEventListener('nodeEditingFieldChange', handleNodeEditingFieldChange)
    }
  }, [])

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
      // Record context menu start position for all element types
      connectionContextMenuStartRef.current = { x: e.clientX, y: e.clientY }
      nodeContextMenuStartRef.current = { x: e.clientX, y: e.clientY }
      groupContextMenuStartRef.current = { x: e.clientX, y: e.clientY }
      domainContextMenuStartRef.current = { x: e.clientX, y: e.clientY }
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
  }, [isSpacePressed, currentTool, panX, panY, zoom, setSelectedIds, editingId, setEditingId, editingField])

  // Handle mouse move for drag panning and connection creation
  const handleMouseMove = useCallback(async (e: React.MouseEvent) => {
    if (isDragging) {
      const dx = e.clientX - dragStartRef.current.x
      const dy = e.clientY - dragStartRef.current.y
      pendingPanRef.current = {
        x: panStartRef.current.x + dx,
        y: panStartRef.current.y + dy,
      }
      if (!panRafRef.current) {
        panRafRef.current = requestAnimationFrame(() => {
          panRafRef.current = null
          if (pendingPanRef.current) {
            setPan(pendingPanRef.current.x, pendingPanRef.current.y)
            pendingPanRef.current = null
          }
        })
      }
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

      if (connectionStartNodeId) {
        const startNode = nodes.get(connectionStartNodeId)
        if (startNode) {
          const startNearest = findNearestPort(
            new Map([[connectionStartNodeId, startNode]]),
            canvasMouseX,
            canvasMouseY,
            undefined,
            50
          )
          if (startNearest) {
            setStartPortPreview({ port: startNearest.port, position: startNearest.position })
            setConnectionStartPort(startNearest.port)
          } else {
            setStartPortPreview(null)
          }
        }
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

      if (currentTool === 'connection') {
        const hoveredNode = findNodeAtPoint(nodes, canvasX, canvasY)
        if (hoveredNode) {
          const bestPort = findBestPort(hoveredNode, canvasX, canvasY)
          const portPosition = getPortPosition(hoveredNode, bestPort)
          setHoveredPort({ nodeId: hoveredNode.id, port: bestPort, position: portPosition })
        } else {
          setHoveredPort(null)
        }
      } else {
        setHoveredPort(null)
      }
    } else {
      setHoveredPort(null)
    }

    if (containerRef.current && id && id > 0) {
      const rect = containerRef.current.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top
      const canvasX = (mouseX - panX) / zoom
      const canvasY = (mouseY - panY) / zoom
      sendCursor(canvasX, canvasY)
    }
  }, [isDragging, isBoxSelecting, isCreatingDomain, isCreatingConnection, isDraggingConnectionEndpoint, isDraggingBendPoint, isResizingGroup, isCreatingGroup, panX, panY, zoom, setPan, nodes, connectionStartNodeId, draggingConnectionId, draggingEndpoint, draggingBendPointId, connections, isDraggingGroup, draggingGroupId, groups, groupDragStart, groupInitialPositions, initialGroupNodeIds, groupDragInitialGroupPos, resizeHandle, resizeStart, resizeInitialGroup, resizeInitialNodePositions, updateGroup, resizingGroupId, currentTool, selectedIds, customCursor, setCustomCursor, id, sendCursor])

  // Handle mouse up
  const handleMouseUp = useCallback(async (e: React.MouseEvent) => {
    setIsDragging(false)

    if (panRafRef.current) {
      cancelAnimationFrame(panRafRef.current)
      panRafRef.current = null
    }
    if (pendingPanRef.current) {
      setPan(pendingPanRef.current.x, pendingPanRef.current.y)
      pendingPanRef.current = null
    }

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
      setStartPortPreview(null)
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
    if (isViewer) return

    // Check if this is a drag operation (mouse moved more than threshold)
    const dx = e.clientX - connectionContextMenuStartRef.current.x
    const dy = e.clientY - connectionContextMenuStartRef.current.y
    if (Math.hypot(dx, dy) > 5) return

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
  }, [containerRef, panX, panY, zoom, isViewer])

  // Handle node context menu
  const handleNodeContextMenu = useCallback((x: number, y: number, nodeId: string) => {
    if (isViewer) return
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
    if (isViewer) return
    const connection = connections.get(connectionId)
    if (connection) {
      setEditingConnectionLabel({
        connectionId,
        label: connection.label || '',
      })
    }
  }, [connections, setEditingConnectionLabel, isViewer])

  const handleRelationshipLabelClick = useCallback((nodeId: string) => {
    const node = nodes.get(nodeId)
    if (!node) {
      return
    }

    const nodeCenterX = node.x + node.width / 2
    const nodeCenterY = node.y + node.height / 2

    const canvasContainer = document.querySelector('[data-canvas-container]') as HTMLElement
    const width = canvasContainer?.clientWidth || window.innerWidth
    const height = canvasContainer?.clientHeight || window.innerHeight

    const newPanX = width / 2 - nodeCenterX
    const newPanY = height / 2 - nodeCenterY

    setZoom(1)
    setPan(newPanX, newPanY)
    setSelectedIds([nodeId])
  }, [nodes, setZoom, setPan, setSelectedIds])

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
      const newNode = {
        id: generateId('node'),
        x: snappedX - nodeDefaults.textNode.width / 2,
        y: snappedY - nodeDefaults.textNode.height / 2,
        width: nodeDefaults.textNode.width,
        height: nodeDefaults.textNode.height,
        title: '新节点',
        content: '',
        color: nodeDefaults.textNode.color,
        fontSize: nodeDefaults.textNode.fontSize,
        textAlign: nodeDefaults.textNode.contentAlign,
        titleAlign: nodeDefaults.textNode.titleAlign,
        contentAlign: nodeDefaults.textNode.contentAlign,
        collapsedTitleAlign: nodeDefaults.textNode.collapsedTitleAlign,
        collapsed: false,
        locked: false,
      }

      addNode(newNode)

      setCurrentTool('select')
    } else if (currentTool === 'image') {
      const newNode: Node = {
        id: generateId('node'),
        x: snappedX - nodeDefaults.imageNode.width / 2,
        y: snappedY - nodeDefaults.imageNode.height / 2,
        width: nodeDefaults.imageNode.width,
        height: nodeDefaults.imageNode.height,
        title: '',
        content: '',
        fontSize: nodeDefaults.imageNode.fontSize,
        textAlign: nodeDefaults.imageNode.titleAlign,
        titleAlign: nodeDefaults.imageNode.titleAlign,
        collapsedTitleAlign: nodeDefaults.imageNode.collapsedTitleAlign,
        collapsed: false,
        locked: false,
        type: 'image',
      }

      addNode(newNode)

      setCurrentTool('select')
    }
  }, [isEditingConnectionEndpoint, editingConnectionId, editingEndpoint, connections, updateConnection, nodes, panX, panY, zoom, containerRef, currentTool, isDragging, setSelectedIds, dragMode, addNode, setCurrentTool, findBestPort, stylePanelOpen, closeStylePanel, nodeDefaults])

  // Handle mouse wheel for zooming and panning
  const handleWheel = (e: React.WheelEvent) => {
    if (e.shiftKey) {
      e.preventDefault()
      setPan(panX - e.deltaY, panY)
    } else if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      setPan(panX, panY - e.deltaY)
    } else {
      e.preventDefault()
      // Use zoomStep for wheel zoom (scale delta based on zoomStep)
      const direction = e.deltaY > 0 ? -1 : 1
      const delta = direction * zoomStep
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
      draggingNodePositionsRef.current.set(nodeId, { x, y })
      setDragRenderCounter(c => c + 1)

      // 检查是否拖拽到节点池区域
      const node = nodes.get(nodeId) as Node | undefined
      if (node) {
        const { setDraggingNodeFromCanvas } = useUIStore.getState()
        setDraggingNodeFromCanvas({ nodeId, nodeData: node })
      }
    }

    const handleNodeDragMove = (e: Event) => {
      const customEvent = e as CustomEvent<{ nodeId: string; x: number; y: number }>
      const { nodeId, x, y } = customEvent.detail
      draggingNodePositionsRef.current.set(nodeId, { x, y })
      setDragRenderCounter(c => c + 1)
    }

    const handleNodeDragEnd = (e: Event) => {
      const customEvent = e as CustomEvent<{ nodeId: string; droppedInNodePool?: boolean; targetFolderId?: number | null }>
      const { nodeId, droppedInNodePool, targetFolderId } = customEvent.detail

      draggingNodePositionsRef.current.delete(nodeId)
      setDragRenderCounter(c => c + 1)

      // 如果在节点池区域释放，则添加节点到节点池
      if (droppedInNodePool) {
        const { draggingNodeFromCanvas } = useUIStore.getState()
        if (draggingNodeFromCanvas) {
          const { currentProject } = useProjectsStore.getState()
          const { addCard } = useNodePoolStore.getState()
          const { moveNodeToPool } = useCanvasStore.getState()
          const { addToast } = useUIStore.getState()

          const node = draggingNodeFromCanvas.nodeData as Node
          // 使用 moveNodeToPool 将节点移动到节点池（支持撤销/重做）
          // onExecute: 添加卡片到节点池
          // onUndo: 从节点池移除卡片
          moveNodeToPool(
            nodeId,
            node,
            async () => {
              // execute: 添加卡片到节点池
              await addCard({
                name: node.title || node.content || '未命名',
                content: JSON.stringify(node),
                type: node.type || 'text',
                color: node.color,
                tags: null,
                sortOrder: 0,
                folderId: targetFolderId ?? null,
                thumbnail: node.type === 'image' ? node.imageUrl : undefined,
              })
            },
            async () => {
              // undo: 需要从节点池找到并移除对应的卡片
              // 由于卡片ID是后端生成的，我们需要通过内容匹配来找到它
              const { cardsMap, removeCard } = useNodePoolStore.getState()
              // 查找匹配的卡片（通过内容匹配）
              for (const [cardId, card] of cardsMap) {
                try {
                  const cardNodeData = JSON.parse(card.content)
                  // 如果内容匹配，则移除该卡片
                  if (cardNodeData.id === node.id) {
                    await removeCard(cardId)
                    break
                  }
                } catch {
                  // 解析失败，跳过
                }
              }
            }
          )
          const folderMessage = targetFolderId ? '节点已添加到指定文件夹' : '节点已添加到节点池'
          addToast({ type: 'success', title: '已添加到节点池', message: folderMessage })
        }
      }
    }

    window.addEventListener('nodeDragStart', handleNodeDragStart as EventListener)
    window.addEventListener('nodeDragMove', handleNodeDragMove as EventListener)
    window.addEventListener('nodeDragEnd', handleNodeDragEnd as EventListener)

    return () => {
      window.removeEventListener('nodeDragStart', handleNodeDragStart as EventListener)
      window.removeEventListener('nodeDragMove', handleNodeDragMove as EventListener)
      window.removeEventListener('nodeDragEnd', handleNodeDragEnd as EventListener)
    }
  }, [nodes])

  // Show/hide rich text toolbar based on editing state
  useEffect(() => {
    if (editingId && editingField === 'content' && containerRef.current) {
      const node = nodes.get(editingId)
      if (node) {
        const rect = containerRef.current.getBoundingClientRect()
        const nodeX = node.x * zoom + panX
        const nodeY = node.y * zoom + panY + node.height * zoom

        // 工具栏尺寸估算
        const toolbarWidth = 280
        const toolbarHeight = 50
        const padding = 10

        // 计算初始位置
        let x = rect.left + nodeX + (node.width * zoom) / 2
        let y = rect.top + nodeY

        // 边界检查：确保工具栏不超出视口
        const viewportWidth = window.innerWidth
        const viewportHeight = window.innerHeight

        // 水平边界检查
        if (x - toolbarWidth / 2 < padding) {
          x = toolbarWidth / 2 + padding
        } else if (x + toolbarWidth / 2 > viewportWidth - padding) {
          x = viewportWidth - toolbarWidth / 2 - padding
        }

        // 垂直边界检查：优先显示在节点下方，如果空间不足则显示在上方
        if (y + toolbarHeight > viewportHeight - padding) {
          // 显示在节点上方
          y = rect.top + nodeY - node.height * zoom - toolbarHeight - 10
        }

        // 确保不超出顶部
        if (y < padding) {
          y = padding
        }

        setRichTextToolbarPosition({ x, y })
        setRichTextToolbarVisible(true)
      }
    } else {
      setRichTextToolbarVisible(false)
    }
  }, [editingId, editingField, nodes, zoom, panX, panY])

  // 验证画布ID有效性
  const validCanvasId = canvasId ? parseInt(canvasId) : null
  const isCanvasValid = validCanvasId !== null && !isNaN(validCanvasId)

  // 使用 useMemo 缓存端口分布计算，使用智能算法根据连线来源方向排序
  const portDistribution = useMemo(() => {
    // 按连线 ID 排序，确保顺序稳定
    const sortedConnections = Array.from(connections.values()).sort((a, b) =>
      a.id.localeCompare(b.id)
    )

    // 构建连接信息数组，包含节点位置信息
    const connectionInfos: ConnectionInfo[] = sortedConnections.map((conn) => {
      const fromNode = nodes.get(conn.fromNodeId)
      const toNode = nodes.get(conn.toNodeId)
      const fromPort = getConnectionPort(conn, 'start')
      const toPort = getConnectionPort(conn, 'end')

      // 获取节点中心位置（用于计算角度）
      const fromX = fromNode ? fromNode.x + fromNode.width / 2 : 0
      const fromY = fromNode ? fromNode.y + fromNode.height / 2 : 0
      const toX = toNode ? toNode.x + toNode.width / 2 : 0
      const toY = toNode ? toNode.y + toNode.height / 2 : 0

      return {
        connId: conn.id,
        fromNodeId: conn.fromNodeId,
        toNodeId: conn.toNodeId,
        fromX,
        fromY,
        toX,
        toY,
        fromPort,
        toPort,
      }
    })

    // 构建连接信息映射表
    const connectionInfoMap = buildConnectionInfoMap(connectionInfos)

    return { connectionInfoMap, sortedConnections, connectionInfos }
  }, [connections, nodes])

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
        <CanvasToolbar onSave={handleManualSave} isViewer={isViewer} isCollabConnected={collabService.isConnected()} />
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

        style={{
          cursor: customCursor || (isCreatingConnection ? 'crosshair' : isCreatingGroup ? 'crosshair' : isDragging ? 'grabbing' : isDefaultSelectionTool(currentTool) || currentTool === 'pan' || isSpacePressed ? 'grab' : currentTool === 'node' || currentTool === 'image' ? 'pointer' : currentTool === 'domain' ? 'cell' : currentTool === 'connection' ? 'crosshair' : currentTool === 'group' ? 'crosshair' : 'default'),
          userSelect: isDragging || currentTool === 'pan' ? 'none' : undefined,
        }}
      >
        <CanvasGrid zoom={zoom} panX={panX} panY={panY} />

        {minimapVisible && (
          <CanvasMinimap
            nodes={nodes}
            groups={groups}
            domains={domains}
            connections={connections}
            zoom={zoom}
            panX={panX}
            panY={panY}
            containerWidth={containerSize.width}
            containerHeight={containerSize.height}
            nodePoolOpen={nodePoolOpen}
            aiSidebarOpen={aiSidebarOpen}
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
            zoom: zoom,
            transform: `translate(${panX / zoom}px, ${panY / zoom}px)`,
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
                if (isViewer) return

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
                  if (isViewer) return

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
                    if (isViewer) return

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
                    if (isViewer) return
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
            className="absolute inset-0 pointer-events-none"
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
            {(() => {
              const { connectionInfoMap, sortedConnections } = portDistribution

              const selectedNodeIds = selectedIds.filter(id => nodes.has(id))
              const highlightedConnectionIds = new Set<string>()
              if (relationshipHighlightMode && selectedNodeIds.length > 0) {
                sortedConnections.forEach((conn) => {
                  if (selectedNodeIds.includes(conn.fromNodeId) || selectedNodeIds.includes(conn.toNodeId)) {
                    highlightedConnectionIds.add(conn.id)
                  }
                })
              }

              interface LabelData {
                connId: string
                nodeId: string
                nodeTitle: string
                port: PortDirection
                portX: number
                portY: number
                index: number
                total: number
                opacity: number
              }

              const allLabels: LabelData[] = []

              const connectionElements = sortedConnections.map((conn) => {
                const fromNode = nodes.get(conn.fromNodeId)
                const toNode = nodes.get(conn.toNodeId)
                if (!fromNode || !toNode) return null

                const fromDraggingPos = draggingNodePositionsRef.current.get(conn.fromNodeId)
                const toDraggingPos = draggingNodePositionsRef.current.get(conn.toNodeId)

                const actualFromNode = getActualNodePosition(fromNode, fromDraggingPos, isDraggingGroup, draggingGroupId, initialGroupNodeIds, groupDragOffset)
                const actualToNode = getActualNodePosition(toNode, toDraggingPos, isDraggingGroup, draggingGroupId, initialGroupNodeIds, groupDragOffset)

                const fromPort = getConnectionPort(conn, 'start')
                const toPort = getConnectionPort(conn, 'end')

                const fromKey = `${conn.fromNodeId}-${fromPort}`
                const toKey = `${conn.toNodeId}-${toPort}`
                const fromConnections = connectionInfoMap.get(fromKey) || []
                const toConnections = connectionInfoMap.get(toKey) || []

                const fromPosition = calculateSmartPortPosition(
                  actualFromNode,
                  fromPort,
                  fromConnections,
                  conn.id
                )
                const toPosition = calculateSmartPortPosition(
                  actualToNode,
                  toPort,
                  toConnections,
                  conn.id
                )
                const fromX = fromPosition.x
                const fromY = fromPosition.y
                const toX = toPosition.x
                const toY = toPosition.y

                let connectionOpacity = 1
                if (relationshipHighlightMode && selectedNodeIds.length > 0) {
                  connectionOpacity = highlightedConnectionIds.has(conn.id) ? 1 : 0.15
                }

                if (relationshipHighlightMode && highlightedConnectionIds.has(conn.id)) {
                  allLabels.push({
                    connId: conn.id,
                    nodeId: conn.toNodeId,
                    nodeTitle: toNode.title || '未命名',
                    port: fromPort,
                    portX: fromX,
                    portY: fromY,
                    index: fromPosition.index,
                    total: fromPosition.total,
                    opacity: connectionOpacity,
                  })
                  allLabels.push({
                    connId: conn.id,
                    nodeId: conn.fromNodeId,
                    nodeTitle: fromNode.title || '未命名',
                    port: toPort,
                    portX: toX,
                    portY: toY,
                    index: toPosition.index,
                    total: toPosition.total,
                    opacity: connectionOpacity,
                  })
                }

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
                      fromPort={getConnectionPort(conn, 'start')}
                      toPort={getConnectionPort(conn, 'end')}
                      onClick={handleConnectionClick}
                      onContextMenu={handleConnectionContextMenu}
                      onDoubleClick={handleConnectionDoubleClick}
                      opacity={connectionOpacity}
                    />
                    {conn.label && (() => {
                      const fromOffsetX = fromDraggingPos ? fromDraggingPos.x - fromNode.x : 0
                      const fromOffsetY = fromDraggingPos ? fromDraggingPos.y - fromNode.y : 0
                      const toOffsetX = toDraggingPos ? toDraggingPos.x - toNode.x : 0
                      const toOffsetY = toDraggingPos ? toDraggingPos.y - toNode.y : 0

                      const adjustedBendPoints = conn.bendPoints?.map((bp, index, arr) => {
                        const ratio = (index + 1) / (arr.length + 1)
                        return {
                          x: bp.x + fromOffsetX * (1 - ratio) + toOffsetX * ratio,
                          y: bp.y + fromOffsetY * (1 - ratio) + toOffsetY * ratio
                        }
                      }) || []

                      const fromPortDir = getConnectionPort(conn, 'start')
                      const toPortDir = getConnectionPort(conn, 'end')
                      const labelPos = getLabelPosition(conn.type, fromX, fromY, toX, toY, adjustedBendPoints, fromPortDir, toPortDir)
                      return (
                        <text
                          x={labelPos.x}
                          y={labelPos.y - 5}
                          textAnchor="middle"
                          fontSize={11}
                          fontWeight="500"
                          fill="#64748b"
                          opacity={connectionOpacity}
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
              })

              const labelElements = relationshipHighlightMode ? (() => {
                return allLabels.map((label) => {
                  const portOffset = getPortOffsetVector(label.port)
                  const isVertical = label.port === 'top' || label.port === 'bottom'

                  const charCount = label.nodeTitle.length
                  const charSize = 11
                  const padding = 8

                  const textWidth = isVertical ? charSize + padding : charCount * charSize + padding
                  const textHeight = isVertical ? charCount * charSize + padding : charSize + padding

                  const labelOffset = isVertical ? textHeight / 2 + 10 : textWidth / 2 + 10
                  const textX = label.portX + portOffset.dx * labelOffset
                  const textY = label.portY + portOffset.dy * labelOffset
                  return (
                    <g
                      key={`label-${label.connId}-${label.nodeId}`}
                      style={{ pointerEvents: 'auto' }}
                    >
                      <rect
                        x={textX - textWidth / 2}
                        y={textY - textHeight / 2}
                        width={textWidth}
                        height={textHeight}
                        rx={4}
                        fill="white"
                        stroke="#94a3b8"
                        strokeWidth={1}
                        opacity={label.opacity}
                        style={{ cursor: 'pointer', pointerEvents: 'all' }}
                        className="hover:stroke-blue-400 hover:fill-blue-50"
                        data-relationship-label="true"
                        onMouseDown={(e) => {
                          e.stopPropagation()
                        }}
                        onClick={(e) => {
                          e.stopPropagation()
                          e.preventDefault()
                          handleRelationshipLabelClick(label.nodeId)
                        }}
                      />
                      {isVertical ? (
                        <text
                          x={textX}
                          y={textY - (charCount - 1) * charSize / 2 + 3}
                          textAnchor="middle"
                          fontSize={10}
                          fontWeight="500"
                          fill="#374151"
                          opacity={label.opacity}
                          className="pointer-events-none"
                        >
                          {label.nodeTitle.split('').map((char, i) => (
                            <tspan
                              key={i}
                              x={textX}
                              dy={i === 0 ? 0 : charSize}
                              textAnchor="middle"
                            >
                              {char}
                            </tspan>
                          ))}
                        </text>
                      ) : (
                        <text
                          x={textX}
                          y={textY}
                          textAnchor="middle"
                          dominantBaseline="middle"
                          fontSize={10}
                          fontWeight="500"
                          fill="#374151"
                          opacity={label.opacity}
                          className="pointer-events-none"
                        >
                          {label.nodeTitle}
                        </text>
                      )}
                    </g>
                  )
                })
              })() : null

              return (
                <>
                  {connectionElements}
                  {labelElements}
                </>
              )
            })()}

            {/* Hovered port preview (before connection starts) - only in connection tool mode */}
            {hoveredPort && !isCreatingConnection && currentTool === 'connection' && (
              <circle
                cx={hoveredPort.position.x}
                cy={hoveredPort.position.y}
                r={10}
                fill="none"
                stroke="#4A90E2"
                strokeWidth={2}
              />
            )}

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

                {startPortPreview && (
                  <circle
                    cx={startPortPreview.position.x}
                    cy={startPortPreview.position.y}
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

              const fromDraggingPos = draggingNodePositionsRef.current.get(conn.fromNodeId)
              const toDraggingPos = draggingNodePositionsRef.current.get(conn.toNodeId)

              const actualFromNode = getActualNodePosition(fromNode, fromDraggingPos, isDraggingGroup, draggingGroupId, initialGroupNodeIds, groupDragOffset)
              const actualToNode = getActualNodePosition(toNode, toDraggingPos, isDraggingGroup, draggingGroupId, initialGroupNodeIds, groupDragOffset)

              const fromPosition = getPortPosition(actualFromNode, getConnectionPort(conn, 'start'))
              const toPosition = getPortPosition(actualToNode, getConnectionPort(conn, 'end'))

              if (isViewer) return null

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

          {/* Render bend points for straight, step and curve connections */}
          {Array.from(connections.values())
            .filter(conn => (conn.type === 'straight' || conn.type === 'step' || conn.type === 'curve') && selectedIds.includes(conn.id) && conn.bendPoints && conn.bendPoints.length > 0)
            .map((conn) => {
              const fromNode = nodes.get(conn.fromNodeId)
              const toNode = nodes.get(conn.toNodeId)
              if (!fromNode || !toNode) return null

              const fromDraggingPos = draggingNodePositionsRef.current.get(conn.fromNodeId)
              const toDraggingPos = draggingNodePositionsRef.current.get(conn.toNodeId)

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
                          transition: isDragging ? 'none' : 'all 0.15s ease',
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

          {/* Calculate highlighted nodes and connections for relationship mode */}
          {(() => {
            // Calculate highlighted nodes and connections
            const selectedNodeIds = selectedIds.filter(id => nodes.has(id))
            const highlightedNodeIds = new Set<string>(selectedNodeIds)
            const highlightedConnectionIds = new Set<string>()

            if (relationshipHighlightMode && selectedNodeIds.length > 0) {
              connections.forEach((conn, connId) => {
                if (selectedNodeIds.includes(conn.fromNodeId) || selectedNodeIds.includes(conn.toNodeId)) {
                  highlightedConnectionIds.add(connId)
                  highlightedNodeIds.add(conn.fromNodeId)
                  highlightedNodeIds.add(conn.toNodeId)
                }
              })
            }

            return (
              <>
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

                  // Calculate opacity for relationship highlight mode
                  let nodeOpacity = 1
                  if (relationshipHighlightMode && selectedNodeIds.length > 0) {
                    nodeOpacity = highlightedNodeIds.has(node.id) ? 1 : 0.3
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
                      isViewer={isViewer}
                      opacity={nodeOpacity}
                    />
                  )
                })}
              </>
            )
          })()}

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

          {/* Add Bend Point - for straight, step and curve connections */}
          {(() => {
            const connection = connections.get(connectionContextMenu.connectionId)
            if (connection?.type === 'straight' || connection?.type === 'step' || connection?.type === 'curve') {
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
          if (!['fontSize', 'justifyLeft', 'justifyCenter', 'justifyRight'].includes(command)) {
            execFormatCommand(command, value)
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
              }
            }
          }
        }}
      />
    </div>
  )
}
