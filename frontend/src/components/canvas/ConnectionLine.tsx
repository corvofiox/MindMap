import { useMemo } from 'react'
import type { Connection } from '@/types'
import {
  calculateCurveControlPoints,
  getCurveThroughPoints,
  getStepPath,
  pointsToPath,
  type PortDirection
} from '@/utils/canvas'

interface ConnectionLineProps {
  conn: Connection
  fromX: number
  fromY: number
  toX: number
  toY: number
  fromPort: PortDirection
  toPort: PortDirection
  onClick: (e: React.MouseEvent, connectionId: string) => void
  onContextMenu: (e: React.MouseEvent, connectionId: string) => void
  onDoubleClick: (e: React.MouseEvent, connectionId: string) => void
}

export function ConnectionLine({
  conn,
  fromX,
  fromY,
  toX,
  toY,
  fromPort,
  toPort,
  onClick,
  onContextMenu,
  onDoubleClick,
}: ConnectionLineProps) {
  const lineColor = conn.color

  const element = useMemo(() => {
    if (conn.type === 'straight') {
      const hasBendPoints = conn.bendPoints && conn.bendPoints.length > 0

      if (hasBendPoints) {
        const points = [
          { x: fromX, y: fromY },
          ...conn.bendPoints!,
          { x: toX, y: toY }
        ]
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
              }}
            />
          </g>
        )
      }

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
            }}
          />
        </g>
      )
    } else if (conn.type === 'curve') {
      // Check if curve has bend points
      const hasBendPoints = conn.bendPoints && conn.bendPoints.length > 0

      if (hasBendPoints) {
        const points = [
          { x: fromX, y: fromY },
          ...conn.bendPoints,
          { x: toX, y: toY }
        ]
        const pathData = getCurveThroughPoints(points, fromPort, toPort)

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
              }}
            />
          </g>
        )
      }

      const { cp1x, cp1y, cp2x, cp2y } = calculateCurveControlPoints(
        fromX, fromY, toX, toY, fromPort, toPort
      )
      const pathData = `M ${fromX} ${fromY} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${toX} ${toY}`

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
            }}
          />
        </g>
      )
    } else if (conn.type === 'step') {
      const points = getStepPath(fromX, fromY, toX, toY, conn.bendPoints || [], fromPort, toPort)
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
            }}
          />
        </g>
      )
    }
    return null
  }, [conn.id, conn.type, conn.color, conn.width, conn.style, conn.arrowType, conn.bendPoints, fromX, fromY, toX, toY, fromPort, toPort, onClick, onContextMenu, onDoubleClick])

  return element
}
