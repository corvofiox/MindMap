import { useUIStore } from '@/store/useUIStore'
import { X, Settings2 } from 'lucide-react'
import { Z_INDEX } from '@/constants'

export function SettingsDialog() {
  const { settingsOpen, setSettingsOpen, theme, setTheme, dragMode, setDragMode, gridVisible, setGridVisible } = useUIStore()

  if (!settingsOpen) return null

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center"
      style={{ zIndex: Z_INDEX.DIALOG }}
      onClick={() => setSettingsOpen(false)}
    >
      <div
        className="w-full max-w-2xl bg-white dark:bg-gray-800 rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <Settings2 className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              设置
            </h2>
          </div>

          <button
            onClick={() => setSettingsOpen(false)}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto custom-scrollbar">
          {/* Appearance */}
          <section>
            <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-3">
              外观
            </h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  主题
                </label>
                <select
                  value={theme}
                  onChange={(e) => setTheme(e.target.value as any)}
                  className="w-full px-3 py-2 bg-gray-100 dark:bg-gray-700 border-0 rounded-lg text-gray-900 dark:text-white"
                >
                  <option value="light">浅色</option>
                  <option value="dark">深色</option>
                  <option value="system">跟随系统</option>
                </select>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    显示网格
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    在画布上显示点状网格
                  </p>
                </div>

                <button
                  onClick={() => setGridVisible(!gridVisible)}
                  className={`
                    relative w-12 h-6 rounded-full transition-colors
                    ${gridVisible ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}
                  `}
                >
                  <span
                    className={`
                      absolute top-1 left-1 w-4 h-4 bg-white rounded-full transition-transform
                      ${gridVisible ? 'translate-x-6' : 'translate-x-0'}
                    `}
                  />
                </button>
              </div>
            </div>
          </section>

          {/* Canvas */}
          <section>
            <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-3">
              画布
            </h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  拖动模式
                </label>
                <select
                  value={dragMode}
                  onChange={(e) => setDragMode(e.target.value as any)}
                  className="w-full px-3 py-2 bg-gray-100 dark:bg-gray-700 border-0 rounded-lg text-gray-900 dark:text-white"
                >
                  <option value="free">自由移动</option>
                  <option value="grid">网格吸附</option>
                </select>
              </div>
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end">
          <button
            onClick={() => setSettingsOpen(false)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  )
}
