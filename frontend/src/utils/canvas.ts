import type { Connection } from '@/types'
import { CANVAS_DEFAULTS } from '@/constants'

export type PortDirection = 'top' | 'right' | 'bottom' | 'left'

/**
 * Snap value to grid
 */
export function snapToGrid(value: number, gridSize = CANVAS_DEFAULTS.GRID_SIZE): number {
  return Math.round(value / gridSize) * gridSize
}

/**
 * Get offset vector based on port direction
 */
export function getPortOffsetVector(port: PortDirection): { dx: number; dy: number } {
  switch (port) {
    case 'right': return { dx: 1, dy: 0 }
    case 'left': return { dx: -1, dy: 0 }
    case 'bottom': return { dx: 0, dy: 1 }
    case 'top': return { dx: 0, dy: -1 }
  }
}

/**
 * Calculate Bezier curve control points based on port directions
 * Uses cubic Bezier curve where:
 * - cp1 is in fromPort direction (start arrow points away from node)
 * - cp2 is in toPort direction (end arrow points into node, tangent = -toPort)
 * - Control points are placed far enough to ensure smooth entry into arrows
 */
export function calculateCurveControlPoints(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  fromPort: PortDirection,
  toPort: PortDirection
): { cp1x: number; cp1y: number; cp2x: number; cp2y: number } {
  const dx = toX - fromX
  const dy = toY - fromY
  const distance = Math.sqrt(dx * dx + dy * dy) || 1

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



/**
 * Generate unique ID
 */
export function generateId(prefix = 'node'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}















/**
 * Calculate connection path
 */
export function getConnectionPath(
  from: { x: number; y: number; width: number; height: number },
  to: { x: number; y: number; width: number; height: number },
  type: Connection['type']
): string {
  const fromCenter = {
    x: from.x + from.width / 2,
    y: from.y + from.height / 2,
  }
  const toCenter = {
    x: to.x + to.width / 2,
    y: to.y + to.height / 2,
  }

  switch (type) {
    case 'straight':
      return `M ${fromCenter.x} ${fromCenter.y} L ${toCenter.x} ${toCenter.y}`

    case 'step': {
      const midX = (fromCenter.x + toCenter.x) / 2
      return `M ${fromCenter.x} ${fromCenter.y} L ${midX} ${fromCenter.y} L ${midX} ${toCenter.y} L ${toCenter.x} ${toCenter.y}`
    }

    case 'curve':
    default: {
      const dx = Math.abs(toCenter.x - fromCenter.x)
      const controlOffset = Math.min(dx * 0.5, 100)
      return `M ${fromCenter.x} ${fromCenter.y} C ${fromCenter.x + controlOffset} ${fromCenter.y}, ${toCenter.x - controlOffset} ${toCenter.y}, ${toCenter.x} ${toCenter.y}`
    }
  }
}



/**
 * Constrain value within range
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}



/**
 * Convert screen coordinates to canvas coordinates
 */
export function screenToCanvas(
  screenX: number,
  screenY: number,
  zoom: number,
  panX: number,
  panY: number
): { x: number; y: number } {
  return {
    x: (screenX - panX) / zoom,
    y: (screenY - panY) / zoom,
  }
}

/**
 * Convert canvas coordinates to screen coordinates
 */
export function canvasToScreen(
  canvasX: number,
  canvasY: number,
  zoom: number,
  panX: number,
  panY: number
): { x: number; y: number } {
  return {
    x: canvasX * zoom + panX,
    y: canvasY * zoom + panY,
  }
}

/**
 * Convert rgba/rgb color to hex
 */
export function colorToHex(color: string): string {
  if (color.startsWith('#')) {
    return color
  }

  const rgbMatch = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/)
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1])
    const g = parseInt(rgbMatch[2])
    const b = parseInt(rgbMatch[3])
    const a = rgbMatch[4] ? parseFloat(rgbMatch[4]) : 1

    const toHex = (n: number) => n.toString(16).padStart(2, '0')
    const hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`

    if (a !== 1) {
      const alphaHex = Math.round(a * 255).toString(16).padStart(2, '0')
      return hex + alphaHex
    }
    return hex
  }

  return '#3b82f6'
}

/**
 * Convert hex color to rgba
 */
export function hexToRgba(hex: string, alpha: number = 1): string {
  hex = hex.replace('#', '')

  const r = parseInt(hex.substring(0, 2), 16)
  const g = parseInt(hex.substring(2, 4), 16)
  const b = parseInt(hex.substring(4, 6), 16)

  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * Convert points array to SVG path string
 */
export function pointsToPath(points: { x: number; y: number }[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
}

/**
 * Calculate Catmull-Rom spline through points with port direction support
 * Returns SVG path string for smooth curve passing through all points
 */
export function getCurveThroughPoints(
  points: { x: number; y: number }[],
  fromPort?: PortDirection,
  toPort?: PortDirection
): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`
  if (points.length === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`

  let path = `M ${points[0].x} ${points[0].y}`

  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i]
    const p2 = points[i + 1]

    let cp1x: number, cp1y: number, cp2x: number, cp2y: number

    if (i === 0) {
      const dx = p2.x - p1.x
      const dy = p2.y - p1.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1

      if (fromPort) {
        const fromOffset = getPortOffsetVector(fromPort)
        const minOffset = Math.max(dist * 0.25, 50)
        const maxOffset = Math.min(dist * 0.5, 120)
        const offset = Math.max(minOffset, maxOffset)
        cp1x = p1.x + fromOffset.dx * offset
        cp1y = p1.y + fromOffset.dy * offset
      } else {
        const naturalDirX = dx / dist
        const naturalDirY = dy / dist
        const offset = Math.min(Math.max(dist * 0.3, 30), 100)
        cp1x = p1.x + naturalDirX * offset
        cp1y = p1.y + naturalDirY * offset
      }
    } else {
      const p0 = points[i - 1]
      cp1x = p1.x + (p2.x - p0.x) / 6
      cp1y = p1.y + (p2.y - p0.y) / 6
    }

    if (i === points.length - 2) {
      const dx = p2.x - p1.x
      const dy = p2.y - p1.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1

      if (toPort) {
        const toOffset = getPortOffsetVector(toPort)
        const minOffset = Math.max(dist * 0.25, 50)
        const maxOffset = Math.min(dist * 0.5, 120)
        const offset = Math.max(minOffset, maxOffset)
        cp2x = p2.x + toOffset.dx * offset
        cp2y = p2.y + toOffset.dy * offset
      } else {
        const naturalDirX = dx / dist
        const naturalDirY = dy / dist
        const offset = Math.min(Math.max(dist * 0.3, 30), 100)
        cp2x = p2.x - naturalDirX * offset
        cp2y = p2.y - naturalDirY * offset
      }
    } else {
      const p3 = points[Math.min(points.length - 1, i + 2)]
      cp2x = p2.x - (p3.x - p1.x) / 6
      cp2y = p2.y - (p3.y - p1.y) / 6
    }

    path += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`
  }

  return path
}

/**
 * Get step path points with port-aligned guide segments
 * Returns array of points for step/orthogonal connection
 */
export function getStepPath(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  bendPoints: { x: number; y: number }[],
  fromPort: PortDirection,
  toPort: PortDirection
): { x: number; y: number }[] {
  const GUIDE_LENGTH = 20

  if (bendPoints.length === 0) {
    const points: { x: number; y: number }[] = [{ x: fromX, y: fromY }]

    const fromDir = getPortOffsetVector(fromPort)
    const toDir = getPortOffsetVector(toPort)

    const fromGuideX = fromX + fromDir.dx * GUIDE_LENGTH
    const fromGuideY = fromY + fromDir.dy * GUIDE_LENGTH
    const toGuideX = toX + toDir.dx * GUIDE_LENGTH
    const toGuideY = toY + toDir.dy * GUIDE_LENGTH

    if (fromDir.dx === 0 && toDir.dx === 0) {
      const midY = (fromGuideY + toGuideY) / 2
      points.push({ x: fromGuideX, y: fromGuideY })
      points.push({ x: fromGuideX, y: midY })
      points.push({ x: toGuideX, y: midY })
      points.push({ x: toGuideX, y: toGuideY })
    } else if (fromDir.dy === 0 && toDir.dy === 0) {
      const midX = (fromGuideX + toGuideX) / 2
      points.push({ x: fromGuideX, y: fromGuideY })
      points.push({ x: midX, y: fromGuideY })
      points.push({ x: midX, y: toGuideY })
      points.push({ x: toGuideX, y: toGuideY })
    } else if (fromDir.dx === 0) {
      points.push({ x: fromGuideX, y: fromGuideY })
      points.push({ x: toGuideX, y: fromGuideY })
      points.push({ x: toGuideX, y: toGuideY })
    } else {
      points.push({ x: fromGuideX, y: fromGuideY })
      points.push({ x: fromGuideX, y: toGuideY })
      points.push({ x: toGuideX, y: toGuideY })
    }

    points.push({ x: toX, y: toY })
    return points
  }

  const points: { x: number; y: number }[] = [{ x: fromX, y: fromY }]

  const fromDir = getPortOffsetVector(fromPort)
  const toDir = getPortOffsetVector(toPort)

  const fromGuideX = fromX + fromDir.dx * GUIDE_LENGTH
  const fromGuideY = fromY + fromDir.dy * GUIDE_LENGTH
  const toGuideX = toX + toDir.dx * GUIDE_LENGTH
  const toGuideY = toY + toDir.dy * GUIDE_LENGTH

  points.push({ x: fromGuideX, y: fromGuideY })

  const firstBend = bendPoints[0]
  if (fromDir.dx === 0) {
    points.push({ x: fromGuideX, y: firstBend.y })
    points.push({ x: firstBend.x, y: firstBend.y })
  } else {
    points.push({ x: firstBend.x, y: fromGuideY })
    points.push({ x: firstBend.x, y: firstBend.y })
  }

  for (let i = 1; i < bendPoints.length; i++) {
    points.push({ x: bendPoints[i].x, y: bendPoints[i].y })
  }

  const lastBend = bendPoints[bendPoints.length - 1]
  if (toDir.dx === 0) {
    points.push({ x: lastBend.x, y: toGuideY })
    points.push({ x: toGuideX, y: toGuideY })
  } else {
    points.push({ x: toGuideX, y: lastBend.y })
    points.push({ x: toGuideX, y: toGuideY })
  }

  points.push({ x: toX, y: toY })
  return points
}




