import { Plus, Minus, Maximize2 } from 'lucide-react'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useUIStore } from '@/store/useUIStore'
import { CANVAS_DEFAULTS, Z_INDEX } from '@/constants'

export function ZoomControls() {
  const { zoom, setZoom, setPan } = useCanvasStore()
  const { nodePoolOpen } = useUIStore()

  const handleZoomIn = () => {
    setZoom(Math.min(zoom + CANVAS_DEFAULTS.ZOOM_STEP, CANVAS_DEFAULTS.MAX_ZOOM))
  }

  const handleZoomOut = () => {
    setZoom(Math.max(zoom - CANVAS_DEFAULTS.ZOOM_STEP, CANVAS_DEFAULTS.MIN_ZOOM))
  }

  const handleReset = () => {
    setZoom(CANVAS_DEFAULTS.DEFAULT_ZOOM)
    setPan(0, 0)
  }

  return (
    <div
      className={`absolute bottom-4 flex items-center gap-1 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 p-1 ${nodePoolOpen ? 'right-[18.25rem]' : 'right-4'}`}
      style={{ zIndex: Z_INDEX.ZOOM_CONTROLS }}
    >
      <button
        onClick={handleZoomOut}
        className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400"
        title="缩小 (Ctrl+-)"
      >
        <Minus className="w-4 h-4" />
      </button>

      <span className="px-3 text-sm font-medium text-gray-700 dark:text-gray-300 min-w-[50px] text-center">
        {Math.round(zoom * 100)}%
      </span>

      <button
        onClick={handleZoomIn}
        className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400"
        title="放大 (Ctrl++)"
      >
        <Plus className="w-4 h-4" />
      </button>

      <div className="h-6 w-px bg-gray-300 dark:bg-gray-600" />

      <button
        onClick={handleReset}
        className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400"
        title="重置视图 (Ctrl+0)"
      >
        <Maximize2 className="w-4 h-4" />
      </button>
    </div>
  )
}
