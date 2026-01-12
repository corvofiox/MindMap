import type { Connection } from '@/types'
import { CANVAS_DEFAULTS } from '@/constants'

/**
 * Snap value to grid
 */
export function snapToGrid(value: number, gridSize = CANVAS_DEFAULTS.GRID_SIZE): number {
  return Math.round(value / gridSize) * gridSize
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




