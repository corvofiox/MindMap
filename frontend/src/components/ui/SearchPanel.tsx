import { useState, useEffect } from 'react'
import { useUIStore } from '@/store/useUIStore'
import { Search, X } from 'lucide-react'
import { Z_INDEX } from '@/constants'

export function SearchPanel() {
  const { searchOpen, setSearchOpen } = useUIStore()
  const [query, setQuery] = useState('')

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') {
        e.preventDefault()
        setSearchOpen(!searchOpen)
      }

      if (searchOpen && e.key === 'Escape') {
        setSearchOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [searchOpen, setSearchOpen])

  if (!searchOpen) return null

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-start justify-center pt-[15vh]"
      style={{ zIndex: Z_INDEX.SEARCH_PANEL }}
      onClick={() => setSearchOpen(false)}
    >
      <div
        className="w-full max-w-2xl bg-white dark:bg-gray-800 rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <Search className="w-5 h-5 text-gray-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search across all canvases..."
            className="flex-1 bg-transparent border-0 outline-none text-gray-900 dark:text-white placeholder-gray-500"
            autoFocus
          />
          <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            <kbd className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700 rounded">Ctrl+Shift+F</kbd>
          </div>
          <button
            onClick={() => setSearchOpen(false)}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="max-h-96 overflow-y-auto custom-scrollbar">
          {query ? (
            <div className="p-4 text-center text-gray-500 dark:text-gray-400">
              Search results for "{query}"
            </div>
          ) : (
            <div className="p-8 text-center text-gray-500 dark:text-gray-400">
              <Search className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>Search for nodes, canvases, and more</p>
              <p className="text-sm mt-2">Type to start searching</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
