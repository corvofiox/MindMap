import { useMemo } from 'react'
import type { Connection } from '@/types'

interface ConnectionLineProps {
  conn: Connection
  fromX: number
  fromY: number
  toX: number
  toY: number
  disableTransition: boolean
  onClick: (e: React.MouseEvent, connectionId: string) => void
  onContextMenu: (e: React.MouseEvent, connectionId: string) => void
  onDoubleClick: (e: React.MouseEvent, connectionId: string) => void
}

// Helper function to calculate Catmull-Rom spline through points
function getCurveThroughPoints(points: { x: number; y: number }[]): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`
  if (points.length === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`

  let path = `M ${points[0].x} ${points[0].y}`

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[Math.min(points.length - 1, i + 2)]

    const cp1x = p1.x + (p2.x - p0.x) / 6
    const cp1y = p1.y + (p2.y - p0.y) / 6
    const cp2x = p2.x - (p3.x - p1.x) / 6
    const cp2y = p2.y - (p3.y - p1.y) / 6

    path += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`
  }

  return path
}

// Helper function to get orthogonal path
function getOrthogonalPath(fromX: number, fromY: number, toX: number, toY: number, bendPoints: { x: number; y: number }[]) {
  return [
    { x: fromX, y: fromY },
    ...bendPoints,
    { x: toX, y: toY }
  ]
}

// Helper function to convert points to path
function pointsToPath(points: { x: number; y: number }[]) {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
}

export function ConnectionLine({
  conn,
  fromX,
  fromY,
  toX,
  toY,
  disableTransition,
  onClick,
  onContextMenu,
  onDoubleClick,
  }: ConnectionLineProps) {
  const lineColor = conn.color

  const element = useMemo(() => {
    if (conn.type === 'straight') {
      const dx = toX - fromX
      const dy = toY - fromY
      const length = Math.sqrt(dx * dx + dy * dy)
      const endpointExclusion = 20
      const shouldCreateHitArea = length > endpointExclusion * 2

      let hitStartX = fromX, hitStartY = fromY, hitEndX = toX, hitEndY = toY
      if (shouldCreateHitArea && length > 0) {
        const ratio = endpointExclusion / length
        hitStartX = fromX + dx * ratio
        hitStartY = fromY + dy * ratio
        hitEndX = toX - dx * ratio
        hitEndY = toY - dy * ratio
      }

      return (
        <g>
          {shouldCreateHitArea && (
            <line
              x1={hitStartX}
              y1={hitStartY}
              x2={hitEndX}
              y2={hitEndY}
              stroke="transparent"
              strokeWidth={24}
              data-connection-id={conn.id}
              style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
              onClick={(e) => onClick(e, conn.id)}
              onContextMenu={(e) => onContextMenu(e, conn.id)}
              onDoubleClick={(e) => onDoubleClick(e, conn.id)}
            />
          )}
          <line
            x1={fromX}
            y1={fromY}
            x2={toX}
            y2={toY}
            stroke={lineColor}
            strokeWidth={conn.width}
            strokeDasharray={conn.style === 'dashed' ? '6,4' : conn.style === 'dotted' ? '3,3' : undefined}
            strokeLinecap="round"
            markerEnd={conn.arrowType === 'end' || conn.arrowType === 'both' ? `url(#arrowhead-${conn.id})` : undefined}
            markerStart={conn.arrowType === 'start' || conn.arrowType === 'both' ? `url(#arrowhead-reverse-${conn.id})` : undefined}
            style={{
              pointerEvents: 'none',
              transition: disableTransition ? 'none' : 'all 0.2s ease',
            }}
          />
        </g>
      )
    } else if (conn.type === 'curve') {
      // Check if curve has bend points
      const hasBendPoints = conn.bendPoints && conn.bendPoints.length > 0

      if (hasBendPoints) {
        // Use Catmull-Rom spline through bend points
        const points = [
          { x: fromX, y: fromY },
          ...conn.bendPoints,
          { x: toX, y: toY }
        ]
        const pathData = getCurveThroughPoints(points)

        return (
          <g>
            <path
              d={pathData}
              stroke="transparent"
              strokeWidth={24}
              fill="none"
              style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
              onClick={(e) => onClick(e, conn.id)}
              onContextMenu={(e) => onContextMenu(e, conn.id)}
              onDoubleClick={(e) => onDoubleClick(e, conn.id)}
            />
            <path
              d={pathData}
              stroke={lineColor}
              strokeWidth={conn.width}
              strokeDasharray={conn.style === 'dashed' ? '6,4' : conn.style === 'dotted' ? '3,3' : undefined}
              strokeLinecap="round"
              fill="none"
              markerEnd={conn.arrowType === 'end' || conn.arrowType === 'both' ? `url(#arrowhead-${conn.id})` : undefined}
              markerStart={conn.arrowType === 'start' || conn.arrowType === 'both' ? `url(#arrowhead-reverse-${conn.id})` : undefined}
              style={{
                pointerEvents: 'none',
                transition: disableTransition ? 'none' : 'all 0.2s ease',
              }}
            />
          </g>
        )
      }

      // Default curve without bend points
      const midX = (fromX + toX) / 2
      const midY = (fromY + toY) / 2
      const dx = toX - fromX
      const dy = toY - fromY
      const controlX = midX - dy * 0.2
      const controlY = midY + dx * 0.2

      return (
        <g>
          <path
            d={`M ${fromX} ${fromY} Q ${controlX} ${controlY} ${toX} ${toY}`}
            stroke="transparent"
            strokeWidth={24}
            fill="none"
            style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
            onClick={(e) => onClick(e, conn.id)}
            onContextMenu={(e) => onContextMenu(e, conn.id)}
            onDoubleClick={(e) => onDoubleClick(e, conn.id)}
          />
          <path
            d={`M ${fromX} ${fromY} Q ${controlX} ${controlY} ${toX} ${toY}`}
            stroke={lineColor}
            strokeWidth={conn.width}
            strokeDasharray={conn.style === 'dashed' ? '6,4' : conn.style === 'dotted' ? '3,3' : undefined}
            strokeLinecap="round"
            fill="none"
            markerEnd={conn.arrowType === 'end' || conn.arrowType === 'both' ? `url(#arrowhead-${conn.id})` : undefined}
            markerStart={conn.arrowType === 'start' || conn.arrowType === 'both' ? `url(#arrowhead-reverse-${conn.id})` : undefined}
            style={{
              pointerEvents: 'none',
              transition: disableTransition ? 'none' : 'all 0.2s ease',
            }}
          />
        </g>
      )
    } else if (conn.type === 'step') {
      const midX = (fromX + toX) / 2

      return (
        <g>
          <path
            d={`M ${fromX} ${fromY} L ${midX} ${fromY} L ${midX} ${toY} L ${toX} ${toY}`}
            stroke="transparent"
            strokeWidth={24}
            fill="none"
            style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
            onClick={(e) => onClick(e, conn.id)}
            onContextMenu={(e) => onContextMenu(e, conn.id)}
            onDoubleClick={(e) => onDoubleClick(e, conn.id)}
          />
          <path
            d={`M ${fromX} ${fromY} L ${midX} ${fromY} L ${midX} ${toY} L ${toX} ${toY}`}
            stroke={lineColor}
            strokeWidth={conn.width}
            strokeDasharray={conn.style === 'dashed' ? '6,4' : conn.style === 'dotted' ? '3,3' : undefined}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            markerEnd={conn.arrowType === 'end' || conn.arrowType === 'both' ? `url(#arrowhead-${conn.id})` : undefined}
            markerStart={conn.arrowType === 'start' || conn.arrowType === 'both' ? `url(#arrowhead-reverse-${conn.id})` : undefined}
            style={{
              pointerEvents: 'none',
              transition: disableTransition ? 'none' : 'all 0.2s ease',
            }}
          />
        </g>
      )
    } else if (conn.type === 'orthogonal') {
      const points = getOrthogonalPath(fromX, fromY, toX, toY, conn.bendPoints || [])
      const pathData = pointsToPath(points)

      return (
        <g>
          <path
            d={pathData}
            stroke="transparent"
            strokeWidth={24}
            fill="none"
            style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
            onClick={(e) => onClick(e, conn.id)}
            onContextMenu={(e) => onContextMenu(e, conn.id)}
            onDoubleClick={(e) => onDoubleClick(e, conn.id)}
          />
          <path
            d={pathData}
            stroke={lineColor}
            strokeWidth={conn.width}
            strokeDasharray={conn.style === 'dashed' ? '6,4' : conn.style === 'dotted' ? '3,3' : undefined}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            markerEnd={conn.arrowType === 'end' || conn.arrowType === 'both' ? `url(#arrowhead-${conn.id})` : undefined}
            markerStart={conn.arrowType === 'start' || conn.arrowType === 'both' ? `url(#arrowhead-reverse-${conn.id})` : undefined}
            style={{
              pointerEvents: 'none',
              transition: disableTransition ? 'none' : 'all 0.2s ease',
            }}
          />
        </g>
      )
    }
    return null
  }, [conn.id, conn.type, conn.color, conn.width, conn.style, conn.arrowType, conn.bendPoints, fromX, fromY, toX, toY, disableTransition, onClick, onContextMenu, onDoubleClick])

  return element
}
