import { useUIStore } from '@/store/useUIStore'
import { X, Keyboard } from 'lucide-react'
import { SHORTCUTS, SHORTCUT_CATEGORIES } from '@/constants/shortcuts'
import { Z_INDEX } from '@/constants'

export function ShortcutsDialog() {
  const { shortcutsOpen, setShortcutsOpen } = useUIStore()

  if (!shortcutsOpen) return null

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center"
      style={{ zIndex: Z_INDEX.DIALOG }}
      onClick={() => setShortcutsOpen(false)}
    >
      <div
        className="w-full max-w-2xl bg-white dark:bg-gray-800 rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <Keyboard className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              快捷键
            </h2>
          </div>

          <button
            onClick={() => setShortcutsOpen(false)}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto custom-scrollbar">
          {Object.entries(SHORTCUT_CATEGORIES).map(([categoryKey, categoryName]) => {
            const categoryShortcuts = SHORTCUTS.filter(s => s.category === categoryKey)
            if (categoryShortcuts.length === 0) return null

            return (
              <div key={categoryKey}>
                <h3 className="text-base font-medium text-gray-900 dark:text-white mb-3">
                  {categoryName}
                </h3>
                <div className="space-y-2">
                  {categoryShortcuts.map((shortcut, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between py-2 px-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg"
                    >
                      <span className="text-sm text-gray-700 dark:text-gray-300">
                        {shortcut.description}
                      </span>
                      <div className="flex gap-1">
                        {shortcut.keys.map((key, keyIndex) => (
                          <span
                            key={keyIndex}
                            className="px-2 py-1 text-xs font-medium bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-300 rounded"
                          >
                            {key}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>

        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end">
          <button
            onClick={() => setShortcutsOpen(false)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  )
}
