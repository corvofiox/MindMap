import { useCanvasStore } from '@/store/useCanvasStore'
import { useUIStore } from '@/store/useUIStore'
import { Z_INDEX } from '@/constants'
import type { Connection } from '@/types'

export function ConnectionStylePanel() {
  const { connections, updateConnection, selectedIds } = useCanvasStore()
  const { stylePanelOpen, closeStylePanel, selectedType } = useUIStore()

  if (!stylePanelOpen || selectedType !== 'connection') return null

  const firstConnection = selectedIds.length > 0 ? connections.get(selectedIds[0]) : null
  if (!firstConnection) return null

  const handleUpdate = (updates: Partial<Connection>) => {
    selectedIds.forEach((id) => {
      const connection = connections.get(id)
      if (connection) {
        // If changing to non-orthogonal and non-curve type, clear bend points
        if (updates.type && updates.type !== 'orthogonal' && updates.type !== 'curve' && (connection.type === 'orthogonal' || connection.type === 'curve')) {
          updateConnection(id, { ...updates, bendPoints: undefined })
        } else {
          updateConnection(id, updates)
        }
      }
    })
  }

  const CONNECTION_TYPES = [
    { value: 'straight', label: '直线' },
    { value: 'step', label: '折线' },
    { value: 'curve', label: '曲线' },
    { value: 'orthogonal', label: '直角线' },
  ] as const

  const CONNECTION_STYLES = [
    { value: 'solid', label: '实线' },
    { value: 'dashed', label: '虚线' },
    { value: 'dotted', label: '点线' },
  ] as const

  const ARROW_TYPES = [
    { value: 'none', label: '无箭头' },
    { value: 'start', label: '起点箭头' },
    { value: 'end', label: '终点箭头' },
    { value: 'both', label: '双向箭头' },
  ] as const

  const LINE_COLORS = [
    '#3b82f6',
    '#6b7280',
    '#10b981',
    '#f59e0b',
    '#ef4444',
    '#8b5cf6',
    '#ec4899',
  ]

  return (
    <div className="fixed right-0 top-0 h-full w-80 bg-white dark:bg-gray-800 shadow-xl border-l border-gray-200 dark:border-gray-700 flex flex-col" style={{ zIndex: Z_INDEX.STYLE_PANEL }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          连线样式 {selectedIds.length > 1 ? `(${selectedIds.length})` : ''}
        </h2>
        <button
          onClick={closeStylePanel}
          className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
        >
          <svg
            className="w-5 h-5 text-gray-500 dark:text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Connection Type */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            连线类型
          </label>
          <div className="grid grid-cols-4 gap-2">
            {CONNECTION_TYPES.map((type) => (
              <button
                key={type.value}
                className={`py-2 px-3 rounded-lg border capitalize transition-colors ${
                  firstConnection.type === type.value
                    ? 'bg-blue-500 text-white border-blue-500'
                    : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
                }`}
                onClick={() => handleUpdate({ type: type.value })}
              >
                {type.label}
              </button>
            ))}
          </div>
        </div>

        {/* Connection Style */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            线条样式
          </label>
          <div className="grid grid-cols-3 gap-2">
            {CONNECTION_STYLES.map((style) => (
              <button
                key={style.value}
                className={`py-2 px-3 rounded-lg border capitalize transition-colors ${
                  firstConnection.style === style.value
                    ? 'bg-blue-500 text-white border-blue-500'
                    : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
                }`}
                onClick={() => handleUpdate({ style: style.value })}
              >
                {style.label}
              </button>
            ))}
          </div>
        </div>

        {/* Line Color */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            线条颜色
          </label>
          <div className="grid grid-cols-7 gap-2">
            {LINE_COLORS.map((color) => (
              <button
                key={color}
                className={`w-10 h-10 rounded-lg border-2 transition-all ${
                  firstConnection.color === color
                    ? 'border-blue-500 scale-110'
                    : 'border-gray-300 dark:border-gray-600 hover:scale-105'
                }`}
                style={{ backgroundColor: color }}
                onClick={() => handleUpdate({ color })}
              />
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="color"
              value={firstConnection.color}
              onChange={(e) => handleUpdate({ color: e.target.value })}
              className="w-10 h-10 rounded cursor-pointer"
            />
            <span className="text-xs text-gray-500 dark:text-gray-400">
              自定义颜色
            </span>
          </div>
        </div>

        {/* Line Width */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            线条宽度: {firstConnection.width}px
          </label>
          <input
            type="range"
            min="1"
            max="10"
            value={firstConnection.width}
            onChange={(e) => handleUpdate({ width: parseInt(e.target.value) })}
            className="w-full"
          />
        </div>

        {/* Arrow Type */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            箭头类型
          </label>
          <div className="grid grid-cols-2 gap-2">
            {ARROW_TYPES.map((arrow) => (
              <button
                key={arrow.value}
                className={`py-2 px-3 rounded-lg border capitalize transition-colors ${
                  firstConnection.arrowType === arrow.value
                    ? 'bg-blue-500 text-white border-blue-500'
                    : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
                }`}
                onClick={() => handleUpdate({ arrowType: arrow.value })}
              >
                {arrow.label}
              </button>
            ))}
          </div>
        </div>

          {/* Label */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            标签文本
          </label>
          <input
            type="text"
            value={firstConnection.label || ''}
            onChange={(e) => handleUpdate({ label: e.target.value || undefined })}
            placeholder="输入标签文本..."
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
          />
        </div>

        {/* Orthogonal Mode Info */}
        {firstConnection.type === 'orthogonal' && (
          <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
            <div className="text-sm text-blue-700 dark:text-blue-300 mb-1">
              💡 直角线模式
            </div>
            <div className="text-xs text-blue-600 dark:text-blue-400">
              右键点击连线可添加或删除弯折点，拖拽弯折点可调整连线形状。
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
