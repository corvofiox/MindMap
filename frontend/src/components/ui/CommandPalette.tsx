import { useState, useEffect, useCallback } from 'react'
import { useUIStore } from '@/store/useUIStore'
import { useProjectsStore } from '@/store/useProjectsStore'
import { useCanvasStore } from '@/store/useCanvasStore'
import { exportCanvas, downloadJsonFile } from '@/utils/canvasExport'
import { Search } from 'lucide-react'
import { Z_INDEX, CANVAS_DEFAULTS } from '@/constants'

/** CommandPalette "Save" 命令桥接事件:由 CanvasPage 监听并复用 Ctrl+S 的完整保存逻辑 */
export const SAVE_COMMAND_EVENT = 'mindmap-command:save'

/**
 * M-2: 画布上下文守卫。canvasId 由 CanvasPage 挂载时 setCanvasId 写入、卸载或
 * 画布不存在时置 null——非画布页(项目列表/设置等)执行画布类命令(保存/导出/
 * 缩放/网格/复位视图)无人监听或导出空数据,必须拦截并提示,禁止静默失败。
 */
function isCanvasContext(): boolean {
  const { canvasId } = useCanvasStore.getState()
  return canvasId !== null && canvasId !== undefined
}

interface PaletteCommand {
  id: string
  label: string
  shortcut: string
  /** M-2: 画布上下文命令——非画布页灰置禁用并提示 */
  requiresCanvas?: boolean
  action: () => void
}

// 命令为模块级常量:action 在触发时经 getState() 读取最新 store 状态,
// 避免组件重渲染重建。所有 action 与 CanvasPage/Header 既有操作保持一致。
const commands: PaletteCommand[] = [
  {
    id: 'new-canvas',
    label: 'New Canvas',
    shortcut: 'Ctrl+N',
    action: () => {
      const { currentProject, canvases, createCanvas } = useProjectsStore.getState()
      if (!currentProject) {
        useUIStore.getState().addToast({
          type: 'warning',
          title: '未选择项目',
          message: '请先选择一个项目',
        })
        return
      }
      // 与 Sidebar 新建画布一致:乐观更新 + 失败回滚 + 错误 toast
      createCanvas(currentProject.id, {
        name: `未命名画布 ${canvases.length + 1}`,
        projectId: currentProject.id,
      }).catch((error) => {
        useUIStore.getState().addToast({
          type: 'error',
          title: '创建画布失败',
          message: error instanceof Error ? error.message : '未知错误',
        })
      })
    },
  },
  {
    id: 'save',
    label: 'Save',
    shortcut: 'Ctrl+S',
    requiresCanvas: true,
    action: () => {
      // 保存逻辑(协作模式守卫/本地删除声明/缩略图/错误提示)在 CanvasPage,
      // 通过事件桥接复用,避免在面板内复制一份漂移的保存实现
      window.dispatchEvent(new CustomEvent(SAVE_COMMAND_EVENT))
    },
  },
  {
    id: 'export',
    label: 'Export',
    shortcut: 'Ctrl+E',
    requiresCanvas: true,
    action: () => {
      const state = useCanvasStore.getState()
      const jsonString = exportCanvas(state.nodes, state.connections, state.groups, state.domains, {
        zoom: state.zoom,
        panX: state.panX,
        panY: state.panY,
      })
      const filename = `mindmap-${new Date().toISOString().slice(0, 10)}.json`
      downloadJsonFile(jsonString, filename)
      useUIStore.getState().addToast({
        type: 'success',
        title: '导出成功',
        message: '画布数据已导出为 JSON 文件',
        duration: 3000,
      })
    },
  },
  {
    id: 'settings',
    label: 'Settings',
    shortcut: 'Ctrl+,',
    action: () => useUIStore.getState().setSettingsOpen(true),
  },
  {
    id: 'toggle-grid',
    label: 'Toggle Grid',
    shortcut: 'H',
    requiresCanvas: true,
    action: () => useUIStore.getState().toggleGrid(),
  },
  {
    id: 'zoom-in',
    label: 'Zoom In',
    shortcut: 'Ctrl++',
    requiresCanvas: true,
    action: () => {
      const { zoom, setZoom } = useCanvasStore.getState()
      setZoom(Math.min(zoom + 0.1, CANVAS_DEFAULTS.MAX_ZOOM))
    },
  },
  {
    id: 'zoom-out',
    label: 'Zoom Out',
    shortcut: 'Ctrl+-',
    requiresCanvas: true,
    action: () => {
      const { zoom, setZoom } = useCanvasStore.getState()
      setZoom(Math.max(zoom - 0.1, CANVAS_DEFAULTS.MIN_ZOOM))
    },
  },
  {
    id: 'reset-view',
    label: 'Reset View',
    shortcut: 'Ctrl+0',
    requiresCanvas: true,
    action: () => {
      // 与 CanvasPage Ctrl+0 一致:缩放复位 1 + 画布原点居中(容器中心)
      const canvasContainer = document.querySelector('[data-canvas-container]') as HTMLElement | null
      const width = canvasContainer?.clientWidth ?? window.innerWidth
      const height = canvasContainer?.clientHeight ?? window.innerHeight
      const { setZoom, setPan } = useCanvasStore.getState()
      setZoom(1)
      setPan(width / 2, height / 2)
    },
  },
]

export function CommandPalette() {
  const { commandPaletteOpen, setCommandPaletteOpen } = useUIStore()
  // M-2: 订阅画布上下文,非画布页灰置画布类命令
  const canvasContextActive = useCanvasStore(
    (s) => s.canvasId !== null && s.canvasId !== undefined
  )
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)

  const filteredCommands = commands.filter((cmd) =>
    cmd.label.toLowerCase().includes(query.toLowerCase())
  )

  // M-2: 统一执行入口——画布类命令在非画布页拦截并提示(不再静默失败/导出空数据)
  const runCommand = useCallback((cmd: PaletteCommand) => {
    if (cmd.requiresCanvas && !isCanvasContext()) {
      useUIStore.getState().addToast({
        type: 'warning',
        title: '请先打开画布',
        message: `「${cmd.label}」需要在画布页面中使用`,
      })
      return
    }
    cmd.action()
  }, [])

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
        if (filteredCommands.length > 0) {
          setSelectedIndex((i) => (i + 1) % filteredCommands.length)
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (filteredCommands.length > 0) {
          setSelectedIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length)
        }
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const cmd = filteredCommands[selectedIndex]
        if (cmd) {
          runCommand(cmd)
          setCommandPaletteOpen(false)
        }
      } else if (e.ctrlKey || e.metaKey) {
        // m-3: 面板打开时其命令快捷键(与 CanvasPage 注册一致)不应被 typing guard
        // 拦截——焦点在面板输入框时 CanvasPage 的 keydown 直接 return,这里兜底
        // 执行。仅响应 Ctrl/Cmd 组合键;裸字母(如 H/G/N/E 工具键)留在画布侧,
        // 不干扰搜索框输入。
        const key = e.key.toLowerCase()
        let cmdId: string | null = null
        if (key === 'n') cmdId = 'new-canvas'
        else if (key === 's') cmdId = 'save'
        else if (key === 'e') cmdId = 'export'
        else if (key === ',') cmdId = 'settings'
        else if (key === '=' || key === '+') cmdId = 'zoom-in'
        else if (key === '-') cmdId = 'zoom-out'
        else if (key === '0') cmdId = 'reset-view'
        if (cmdId) {
          e.preventDefault()
          const cmd = commands.find((c) => c.id === cmdId)
          if (cmd) {
            runCommand(cmd)
            setCommandPaletteOpen(false)
          }
        }
      }
    }
  }, [commandPaletteOpen, filteredCommands, selectedIndex, setCommandPaletteOpen, runCommand])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  if (!commandPaletteOpen) return null

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-start justify-center pt-[20vh]"
      style={{ zIndex: Z_INDEX.COMMAND_PALETTE }}
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
          {filteredCommands.map((cmd, index) => {
            const isCanvasCommandDisabled = cmd.requiresCanvas && !canvasContextActive
            return (
              <button
                key={cmd.id}
                disabled={isCanvasCommandDisabled}
                onClick={() => {
                  runCommand(cmd)
                  setCommandPaletteOpen(false)
                }}
                className={`
                  w-full flex items-center justify-between px-3 py-2 rounded-lg transition-colors
                  ${isCanvasCommandDisabled ? 'opacity-50 cursor-not-allowed' : ''}
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
            )
          })}

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
