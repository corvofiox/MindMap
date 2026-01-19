import { useState, useEffect, useCallback } from 'react'
import { useUIStore } from '@/store/useUIStore'
import { Search } from 'lucide-react'

export function CommandPalette() {
  const { commandPaletteOpen, setCommandPaletteOpen } = useUIStore()
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)

  const commands = [
    { id: 'new-canvas', label: 'New Canvas', shortcut: 'Ctrl+N', action: () => { } },
    { id: 'save', label: 'Save', shortcut: 'Ctrl+S', action: () => { } },
    { id: 'export', label: 'Export', shortcut: 'Ctrl+E', action: () => { } },
    { id: 'settings', label: 'Settings', shortcut: 'Ctrl+,', action: () => { } },
    { id: 'toggle-grid', label: 'Toggle Grid', shortcut: 'G', action: () => { } },
    { id: 'zoom-in', label: 'Zoom In', shortcut: 'Ctrl++', action: () => { } },
    { id: 'zoom-out', label: 'Zoom Out', shortcut: 'Ctrl+-', action: () => { } },
    { id: 'reset-view', label: 'Reset View', shortcut: 'Ctrl+0', action: () => { } },
  ]

  const filteredCommands = commands.filter((cmd) =>
    cmd.label.toLowerCase().includes(query.toLowerCase())
  )

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault()
      setCommandPaletteOpen(!commandPaletteOpen)
    }

    if (commandPaletteOpen) {
      if (e.key === 'Escape') {
        setCommandPaletteOpen(false)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => (i + 1) % filteredCommands.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        filteredCommands[selectedIndex]?.action()
        setCommandPaletteOpen(false)
      }
    }
  }, [commandPaletteOpen, filteredCommands, selectedIndex, setCommandPaletteOpen])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  if (!commandPaletteOpen) return null

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-start justify-center pt-[20vh] z-[110]"
      onClick={() => setCommandPaletteOpen(false)}
    >
      <div
        className="w-full max-w-xl bg-white dark:bg-gray-800 rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <Search className="w-5 h-5 text-gray-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelectedIndex(0)
            }}
            placeholder="Type a command or search..."
            className="flex-1 bg-transparent border-0 outline-none text-gray-900 dark:text-white placeholder-gray-500"
            autoFocus
          />
        </div>

        <div className="max-h-80 overflow-y-auto custom-scrollbar p-2">
          {filteredCommands.map((cmd, index) => (
            <button
              key={cmd.id}
              onClick={() => {
                cmd.action()
                setCommandPaletteOpen(false)
              }}
              className={`
                w-full flex items-center justify-between px-3 py-2 rounded-lg transition-colors
                ${index === selectedIndex
                  ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300'
                }
              `}
            >
              <span>{cmd.label}</span>
              <kbd className="px-2 py-1 text-xs font-mono bg-gray-100 dark:bg-gray-700 rounded">
                {cmd.shortcut}
              </kbd>
            </button>
          ))}

          {filteredCommands.length === 0 && (
            <div className="text-center py-8 text-gray-500 dark:text-gray-400">
              No commands found
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
