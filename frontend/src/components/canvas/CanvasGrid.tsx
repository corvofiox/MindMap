import { useUIStore } from '@/store/useUIStore'
import { CANVAS_DEFAULTS } from '@/constants'

interface CanvasGridProps {
  zoom: number
  panX: number
  panY: number
}

export function CanvasGrid({ zoom, panX, panY }: CanvasGridProps) {
  const { gridVisible } = useUIStore()

  if (!gridVisible) return null

  // Calculate grid spacing based on zoom
  const baseGridSize = CANVAS_DEFAULTS.GRID_SIZE // 20px
  const scaledGridSize = baseGridSize * zoom

  // Dot size stays proportional to grid
  const dotSize = Math.max(0.5, CANVAS_DEFAULTS.GRID_DOT_SIZE * zoom)

  // Calculate offset to create infinite grid effect (handle negative values)
  const offsetX = ((panX % scaledGridSize) + scaledGridSize) % scaledGridSize
  const offsetY = ((panY % scaledGridSize) + scaledGridSize) % scaledGridSize

  // Generate unique pattern ID for this zoom level
  const patternId = `dot-grid-${zoom.toFixed(2)}`

  return (
    <svg
      className="absolute inset-0 pointer-events-none w-full h-full"
      style={{
        transform: `translate(${offsetX - scaledGridSize}px, ${offsetY - scaledGridSize}px)`,
        transformOrigin: '0 0',
      }}
    >
      <defs>
        <pattern
          id={patternId}
          x="0"
          y="0"
          width={scaledGridSize}
          height={scaledGridSize}
          patternUnits="userSpaceOnUse"
        >
          <circle
            cx={scaledGridSize / 2}
            cy={scaledGridSize / 2}
            r={dotSize}
            fill="currentColor"
            className="text-gray-300 dark:text-gray-600"
          />
        </pattern>
      </defs>
      <rect
        x={-scaledGridSize}
        y={-scaledGridSize}
        width="400%"
        height="400%"
        fill={`url(#${patternId})`}
        className="text-gray-300 dark:text-gray-600"
      />
    </svg>
  )
}
