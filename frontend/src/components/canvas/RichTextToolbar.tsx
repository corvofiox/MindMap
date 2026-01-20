import { Bold, Italic, Underline, Strikethrough, Palette, X } from 'lucide-react'
import { useState, useCallback, useRef, useEffect } from 'react'
import { Z_INDEX } from '@/constants'

interface RichTextToolbarProps {
  visible: boolean
  position: { x: number; y: number }
  onCommand: (command: string, value?: string) => void
  onClose: () => void
  onFocus?: () => void
}

const TEXT_COLORS = [
  '#000000', '#4b5563', '#dc2626', '#ea580c', '#d97706', '#65a30d',
  '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#db2777', '#ffffff'
]

export function RichTextToolbar({ visible, position, onCommand, onClose, onFocus }: RichTextToolbarProps) {
  const [showColorDropdown, setShowColorDropdown] = useState(false)
  const toolbarRef = useRef<HTMLDivElement>(null)



  const handleCommand = useCallback((command: string, value?: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    onCommand(command, value)
  }, [onCommand])

  const handleColorChange = useCallback((color: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    handleCommand('foreColor', color)
    setShowColorDropdown(false)
  }, [handleCommand])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        setShowColorDropdown(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  if (!visible) return null

  return (
    <div
      ref={toolbarRef}
      data-rich-text-toolbar="true"
      className="fixed bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl flex items-center gap-1 p-1"
      style={{
        left: position.x,
        top: position.y,
        transform: 'translateX(-50%)',
        zIndex: Z_INDEX.RICH_TEXT_TOOLBAR,
      }}
      onMouseDown={(e) => {
        e.stopPropagation()
        onFocus?.()
      }}
      onClick={(e) => e.stopPropagation()}
    >


      <button
        tabIndex={-1}
        onClick={(e) => handleCommand('bold', undefined, e)}
        className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400 transition-colors font-bold"
        title="加粗 (Ctrl+B)"
      >
        <Bold className="w-4 h-4" />
      </button>

      <button
        tabIndex={-1}
        onClick={(e) => handleCommand('italic', undefined, e)}
        className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400 transition-colors italic"
        title="斜体 (Ctrl+I)"
      >
        <Italic className="w-4 h-4" />
      </button>

      <button
        tabIndex={-1}
        onClick={(e) => handleCommand('underline', undefined, e)}
        className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400 transition-colors underline"
        title="下划线 (Ctrl+U)"
      >
        <Underline className="w-4 h-4" />
      </button>

      <button
        tabIndex={-1}
        onClick={(e) => handleCommand('strikeThrough', undefined, e)}
        className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400 transition-colors line-through"
        title="删除线"
      >
        <Strikethrough className="w-4 h-4" />
      </button>

      <div className="w-px h-6 bg-gray-200 dark:bg-gray-600 mx-1" />

      <div className="relative">
        <button
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation()
            setShowColorDropdown(!showColorDropdown)
          }}
          className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400 transition-colors"
          title="文字颜色"
        >
          <Palette className="w-4 h-4" />
        </button>

        {showColorDropdown && (
          <div
            className="absolute bottom-full left-0 mb-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl p-3 min-w-[160px]"
            style={{ zIndex: Z_INDEX.RICH_TEXT_POPOVER }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-wrap gap-2">
              {TEXT_COLORS.map((color) => (
                <button
                  key={color}
                  tabIndex={-1}
                  onClick={(e) => handleColorChange(color, e)}
                  className="w-7 h-7 rounded-md border-2 border-gray-200 dark:border-gray-600 hover:scale-110 hover:border-blue-400 transition-all shadow-sm"
                  style={{ backgroundColor: color }}
                  title={color}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="w-px h-6 bg-gray-200 dark:bg-gray-600 mx-1" />

      <button
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className="p-2 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400 transition-colors"
        title="关闭"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  )
}
