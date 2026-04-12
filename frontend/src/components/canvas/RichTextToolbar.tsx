import { Bold, Italic, Underline, Strikethrough, Palette, X, RemoveFormatting } from 'lucide-react'
import { useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react'
import { Z_INDEX } from '@/constants'
import { queryFormatState, queryCurrentColor, ColorUtils } from '@/utils/richTextCommands'

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

const FORMAT_COMMANDS = ['bold', 'italic', 'underline', 'strikeThrough'] as const

export function RichTextToolbar({ visible, position, onCommand, onClose, onFocus }: RichTextToolbarProps) {
  const [showColorDropdown, setShowColorDropdown] = useState(false)
  const [activeFormats, setActiveFormats] = useState<Record<string, boolean>>({})
  const [activeColor, setActiveColor] = useState<string | null>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const isUpdatingRef = useRef(false)

  // 使用 useLayoutEffect 确保在渲染前更新状态
  useLayoutEffect(() => {
    if (!visible) return

    const updateFormatState = () => {
      // 防止重复更新
      if (isUpdatingRef.current) return
      isUpdatingRef.current = true

      // 使用 requestAnimationFrame 确保在下一帧更新
      requestAnimationFrame(() => {
        const formats: Record<string, boolean> = {}
        for (const cmd of FORMAT_COMMANDS) {
          formats[cmd] = queryFormatState(cmd)
        }
        setActiveFormats(formats)
        setActiveColor(queryCurrentColor())
        isUpdatingRef.current = false
      })
    }

    // 立即更新一次
    updateFormatState()

    // 监听选择变化
    document.addEventListener('selectionchange', updateFormatState)

    // 也监听鼠标抬起事件，确保拖拽选择后更新
    const handleMouseUp = () => {
      setTimeout(updateFormatState, 0)
    }
    document.addEventListener('mouseup', handleMouseUp)

    // 监听键盘事件
    const handleKeyUp = (e: KeyboardEvent) => {
      // 方向键、Shift+方向键等可能改变选择
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
        setTimeout(updateFormatState, 0)
      }
    }
    document.addEventListener('keyup', handleKeyUp)

    return () => {
      document.removeEventListener('selectionchange', updateFormatState)
      document.removeEventListener('mouseup', handleMouseUp)
      document.removeEventListener('keyup', handleKeyUp)
    }
  }, [visible])

  const handleCommand = useCallback((command: string, value?: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    e?.preventDefault()

    // 调用命令前先聚焦
    onFocus?.()

    // 执行命令
    onCommand(command, value)

    // 命令执行后立即更新状态
    setTimeout(() => {
      const formats: Record<string, boolean> = {}
      for (const cmd of FORMAT_COMMANDS) {
        formats[cmd] = queryFormatState(cmd)
      }
      setActiveFormats(formats)
      setActiveColor(queryCurrentColor())
    }, 10)
  }, [onCommand, onFocus])

  const handleColorChange = useCallback((color: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    e?.preventDefault()

    const currentColor = queryCurrentColor()
    // 使用 ColorUtils.equals 来比较颜色，支持不同格式的颜色比较
    if (currentColor && ColorUtils.equals(currentColor, color)) {
      handleCommand('removeForeColor', undefined, e)
    } else {
      handleCommand('foreColor', color, e)
    }
    setShowColorDropdown(false)
  }, [handleCommand])

  const handleRemoveColor = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation()
    e?.preventDefault()
    handleCommand('removeForeColor', undefined, e)
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

  const formatButtonClass = (command: string, extraClass: string) => {
    const isActive = activeFormats[command]
    return `p-2 rounded transition-colors ${extraClass} ${isActive
        ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
        : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
      }`
  }

  return (
    <div
      ref={toolbarRef}
      data-rich-text-toolbar="true"
      className="fixed bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl flex items-center gap-1 p-1 select-none"
      style={{
        left: position.x,
        top: position.y,
        transform: 'translateX(-50%)',
        zIndex: Z_INDEX.RICH_TEXT_TOOLBAR,
      }}
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onFocus?.()
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => handleCommand('bold', undefined, e)}
        className={formatButtonClass('bold', 'font-bold')}
        title="加粗 (Ctrl+B)"
      >
        <Bold className="w-4 h-4" />
      </button>

      <button
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => handleCommand('italic', undefined, e)}
        className={formatButtonClass('italic', 'italic')}
        title="斜体 (Ctrl+I)"
      >
        <Italic className="w-4 h-4" />
      </button>

      <button
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => handleCommand('underline', undefined, e)}
        className={formatButtonClass('underline', 'underline')}
        title="下划线 (Ctrl+U)"
      >
        <Underline className="w-4 h-4" />
      </button>

      <button
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => handleCommand('strikeThrough', undefined, e)}
        className={formatButtonClass('strikeThrough', 'line-through')}
        title="删除线"
      >
        <Strikethrough className="w-4 h-4" />
      </button>

      <div className="w-px h-6 bg-gray-200 dark:bg-gray-600 mx-1" />

      <div className="relative">
        <button
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            e.preventDefault()
            setShowColorDropdown(!showColorDropdown)
          }}
          className={`p-2 rounded transition-colors ${activeColor
              ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
              : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
            }`}
          title="文字颜色"
        >
          <Palette className="w-4 h-4" />
        </button>

        {showColorDropdown && (
          <div
            className="absolute bottom-full left-0 mb-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl p-3 min-w-[180px]"
            style={{ zIndex: Z_INDEX.RICH_TEXT_POPOVER }}
            onMouseDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-wrap gap-2 mb-2">
              {TEXT_COLORS.map((color) => {
                // 使用 ColorUtils.equals 来比较颜色
                const isCurrentColor = activeColor && ColorUtils.equals(activeColor, color)
                return (
                  <button
                    key={color}
                    tabIndex={-1}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => handleColorChange(color, e)}
                    className={`w-7 h-7 rounded-md border-2 transition-all shadow-sm ${
                      isCurrentColor
                        ? 'border-blue-500 scale-110 ring-2 ring-blue-300'
                        : 'border-gray-200 dark:border-gray-600 hover:scale-110 hover:border-blue-400'
                    }`}
                    style={{ backgroundColor: color }}
                    title={isCurrentColor ? `${color} (再次点击移除)` : color}
                  />
                )
              })}
            </div>
            {activeColor && (
              <button
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => handleRemoveColor(e)}
                className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                title="移除文字颜色"
              >
                <RemoveFormatting className="w-3.5 h-3.5" />
                <span>移除颜色</span>
              </button>
            )}
          </div>
        )}
      </div>

      <div className="w-px h-6 bg-gray-200 dark:bg-gray-600 mx-1" />

      <button
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation()
          e.preventDefault()
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
