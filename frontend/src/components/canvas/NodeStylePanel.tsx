import { useRef, useEffect, useState } from 'react'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useUIStore } from '@/store/useUIStore'
import { NODE_COLORS, BORDER_COLORS } from '@/constants'

export function NodeStylePanel() {
  const { nodes, updateNode, selectedIds } = useCanvasStore()
  const { stylePanelOpen, closeStylePanel, selectedType } = useUIStore()

  const widthInputRef = useRef<HTMLInputElement>(null)
  const heightInputRef = useRef<HTMLInputElement>(null)

  const [tempWidth, setTempWidth] = useState('')
  const [tempHeight, setTempHeight] = useState('')

  const firstNode = selectedIds.length > 0 ? nodes.get(selectedIds[0]) : null

  useEffect(() => {
    if (firstNode) {
      setTempWidth(Math.round(firstNode.width).toString())
      setTempHeight(Math.round(firstNode.height).toString())
    }
  }, [firstNode?.id])

  if (!stylePanelOpen || selectedType !== 'node' || !firstNode) return null

  const handleUpdate = (updates: Partial<typeof firstNode>) => {
    selectedIds.forEach((id) => {
      const node = nodes.get(id)
      if (node) {
        updateNode(id, updates)
      }
    })
  }

  const handleWidthChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTempWidth(e.target.value)
  }

  const handleHeightChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTempHeight(e.target.value)
  }

  const handleWidthBlur = () => {
    const value = Math.max(100, parseInt(tempWidth) || 100)
    handleUpdate({ width: value })
    setTempWidth(value.toString())
  }

  const handleHeightBlur = () => {
    const value = Math.max(60, parseInt(tempHeight) || 60)
    handleUpdate({ height: value })
    setTempHeight(value.toString())
  }

  const handleWidthKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur()
    }
  }

  const handleHeightKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur()
    }
  }

  return (
    <div className="fixed right-0 top-0 h-full w-80 bg-white dark:bg-gray-800 shadow-xl border-l border-gray-200 dark:border-gray-700 z-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          节点样式 {selectedIds.length > 1 ? `(${selectedIds.length})` : ''}
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
        {/* Background Color */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            背景颜色
          </label>
          <div className="grid grid-cols-7 gap-2">
            {NODE_COLORS.map((color) => (
              <button
                key={color}
                className={`w-10 h-10 rounded-lg border-2 transition-all ${
                  firstNode.color === color
                    ? 'border-blue-500 scale-110'
                    : 'border-gray-300 dark:border-gray-600 hover:scale-105'
                }`}
                style={{ backgroundColor: color }}
                onClick={() => handleUpdate({ color })}
              />
            ))}
          </div>
          {/* Custom color input */}
          <div className="mt-2 flex items-center gap-2">
            <input
              type="color"
              value={firstNode.color}
              onChange={(e) => handleUpdate({ color: e.target.value })}
              className="w-10 h-10 rounded cursor-pointer"
            />
            <span className="text-xs text-gray-500 dark:text-gray-400">
              自定义颜色
            </span>
          </div>
        </div>

        {/* Border Color */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            边框颜色
          </label>
          <div className="grid grid-cols-7 gap-2">
            {BORDER_COLORS.map((color) => (
              <button
                key={color}
                className={`w-10 h-10 rounded-lg border-2 transition-all ${
                  firstNode.borderColor === color
                    ? 'border-blue-500 scale-110'
                    : 'border-gray-300 dark:border-gray-600 hover:scale-105'
                }`}
                style={{ backgroundColor: color }}
                onClick={() => handleUpdate({ borderColor: color })}
              />
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="color"
              value={firstNode.borderColor}
              onChange={(e) => handleUpdate({ borderColor: e.target.value })}
              className="w-10 h-10 rounded cursor-pointer"
            />
            <span className="text-xs text-gray-500 dark:text-gray-400">
              自定义颜色
            </span>
          </div>
        </div>

        {/* Font Size */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            字体大小: {firstNode.fontSize}px
          </label>
          <input
            type="range"
            min="10"
            max="36"
            value={firstNode.fontSize}
            onChange={(e) => handleUpdate({ fontSize: parseInt(e.target.value) })}
            className="w-full"
          />
        </div>

        {/* Text Align */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            文本对齐
          </label>
          <div className="flex gap-2">
            {(['left', 'center', 'right'] as const).map((align) => (
              <button
                key={align}
                className={`flex-1 py-2 px-3 rounded-lg border capitalize transition-colors ${
                  firstNode.textAlign === align
                    ? 'bg-blue-500 text-white border-blue-500'
                    : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
                }`}
                onClick={() => handleUpdate({ textAlign: align })}
              >
                {align === 'left' ? '左对齐' : align === 'center' ? '居中' : '右对齐'}
              </button>
            ))}
          </div>
        </div>

        {/* Size */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            尺寸
          </label>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400">宽度</label>
              <input
                ref={widthInputRef}
                type="number"
                min="100"
                max="1000"
                value={tempWidth}
                onChange={handleWidthChange}
                onBlur={handleWidthBlur}
                onKeyDown={handleWidthKeyDown}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400">高度</label>
              <input
                ref={heightInputRef}
                type="number"
                min="60"
                max="1000"
                value={tempHeight}
                onChange={handleHeightChange}
                onBlur={handleHeightBlur}
                onKeyDown={handleHeightKeyDown}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
