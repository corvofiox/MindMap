import { X } from 'lucide-react'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useUIStore } from '@/store/useUIStore'
import { Z_INDEX } from '@/constants'
import type { Domain } from '@/types'

export function DomainStylePanel() {
  const { domains, updateDomain, selectedIds } = useCanvasStore()
  const { stylePanelOpen, closeStylePanel, selectedType } = useUIStore()

  const selectedDomains = selectedIds
    .map((id) => domains.get(id))
    .filter((d): d is Domain => d !== undefined)

  if (!stylePanelOpen || selectedType !== 'domain' || selectedDomains.length === 0) {
    return null
  }

  const firstDomain = selectedDomains[0]

  const handleUpdate = (updates: Partial<Domain>) => {
    selectedIds.forEach((id) => {
      const domain = domains.get(id)
      if (domain) {
        updateDomain(id, updates)
      }
    })
  }

  // 提取RGBA颜色中的透明度
  const getAlpha = (rgba: string): number => {
    const match = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/)
    return match ? parseFloat(match[4] || '1') : 1
  }

  // 提取RGB部分
  const getRgb = (rgba: string): string => {
    const match = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
    return match ? `rgb(${match[1]}, ${match[2]}, ${match[3]})` : rgba
  }

  // RGB转Hex
  const rgbToHex = (rgb: string): string => {
    const match = rgb.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/)
    if (!match) return '#000000'
    const r = parseInt(match[1]).toString(16).padStart(2, '0')
    const g = parseInt(match[2]).toString(16).padStart(2, '0')
    const b = parseInt(match[3]).toString(16).padStart(2, '0')
    return `#${r}${g}${b}`
  }

  return (
    <div className="fixed right-0 top-0 h-full w-80 bg-white dark:bg-gray-800 shadow-xl border-l border-gray-200 dark:border-gray-700" style={{ zIndex: Z_INDEX.STYLE_PANEL }}>
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          域样式 {selectedDomains.length > 1 ? `(${selectedDomains.length})` : ''}
        </h2>
        <button onClick={closeStylePanel} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">
          <X className="w-5 h-5 text-gray-600 dark:text-gray-400" />
        </button>
      </div>

      {/* Content */}
      <div className="p-4 space-y-6 overflow-y-auto h-[calc(100%-60px)]">
        {/* 名称 */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            名称
          </label>
          <input
            type="text"
            value={firstDomain.name}
            onChange={(e) => handleUpdate({ name: e.target.value })}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
          />
        </div>

        {/* 背景颜色 */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            背景颜色
          </label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={rgbToHex(getRgb(firstDomain.backgroundColor))}
              onChange={(e) => {
                const hex = e.target.value
                const r = parseInt(hex.slice(1, 3), 16)
                const g = parseInt(hex.slice(3, 5), 16)
                const b = parseInt(hex.slice(5, 7), 16)
                const alpha = getAlpha(firstDomain.backgroundColor)
                handleUpdate({ backgroundColor: `rgba(${r}, ${g}, ${b}, ${alpha})` })
              }}
              className="w-10 h-10 rounded cursor-pointer border-0"
            />
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={getAlpha(firstDomain.backgroundColor)}
              onChange={(e) => {
                const rgb = getRgb(firstDomain.backgroundColor)
                const match = rgb.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/)
                if (match) {
                  handleUpdate({
                    backgroundColor: `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${e.target.value})`,
                  })
                }
              }}
              className="flex-1"
            />
            <span className="text-sm text-gray-600 dark:text-gray-400 w-12 text-right">
              {Math.round(getAlpha(firstDomain.backgroundColor) * 100)}%
            </span>
          </div>
        </div>

        {/* 标题设置 */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            标题
          </label>
          <div className="space-y-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={firstDomain.titleVisible}
                onChange={(e) => handleUpdate({ titleVisible: e.target.checked })}
                className="rounded"
              />
              <span className="text-sm text-gray-700 dark:text-gray-300">显示标题</span>
            </label>

            {firstDomain.titleVisible && (
              <div className="space-y-3 pl-6">
                <div>
                  <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">
                    字体比例: {Math.round((firstDomain.titleScale || 0.08) * 100)}%
                  </label>
                  <input
                    type="range"
                    min="0.02"
                    max="0.2"
                    step="0.01"
                    value={firstDomain.titleScale || 0.08}
                    onChange={(e) => handleUpdate({ titleScale: parseFloat(e.target.value) })}
                    className="w-full"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
