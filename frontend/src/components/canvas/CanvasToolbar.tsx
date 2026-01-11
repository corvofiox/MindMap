import { MousePointer2, Square, Layers, Link, Grid3x3, Undo, Redo, Trash2, ArrowRight, ArrowLeftRight, Minus, Group, Save, Download, Check, Map, Layout, Image as ImageIcon } from 'lucide-react'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useUIStore } from '@/store/useUIStore'
import type { Tool } from '@/types'
import { useState, useCallback } from 'react'
import { generateId } from '@/utils/canvas'

interface CanvasToolbarProps {
  onSave?: () => Promise<void>
}

const tools: { id: Tool; icon: typeof MousePointer2; label: string; shortcut: string }[] = [
  { id: 'node', icon: Square, label: '节点', shortcut: 'N' },
  { id: 'image', icon: ImageIcon, label: '图片', shortcut: 'I' },
  { id: 'connection', icon: Link, label: '连线', shortcut: 'L' },
  { id: 'group', icon: Layers, label: '分组', shortcut: 'G' },
  { id: 'domain', icon: Layout, label: '域', shortcut: 'R' },
]

const toolSeparators = [1, 2]

export function CanvasToolbar({ onSave }: CanvasToolbarProps) {
  const { currentTool, gridVisible, dragMode, minimapVisible, setCurrentTool, toggleGrid, toggleDragMode, toggleMinimap, connectionDirection, setConnectionDirection, connectionStyle, setConnectionStyle, addToast } = useUIStore()
  const { zoom, selectedIds, removeNode, removeConnection, removeGroup, removeDomain, nodes, connections, undo, redo, history, groups, domains, addGroup } = useCanvasStore()

  const [isSaving, setIsSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)

  const connectionDirections = [
    { id: 'directed' as const, icon: ArrowRight, label: '单向' },
    { id: 'bidirectional' as const, icon: ArrowLeftRight, label: '双向' },
    { id: 'undirected' as const, icon: Minus, label: '无向' },
  ]

  const connectionStyles = [
    { id: 'solid' as const, label: '实线' },
    { id: 'dashed' as const, label: '虚线' },
    { id: 'dotted' as const, label: '点线' },
  ]

  const canUndo = history.currentIndex >= 0
  const canRedo = history.currentIndex < history.commands.length - 1

  const handleSave = useCallback(async () => {
    if (!onSave || isSaving) return

    setIsSaving(true)
    setSaveSuccess(false)

    try {
      await onSave()
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2000)

      // Show success toast
      addToast({
        type: 'success',
        title: '保存成功',
        message: '画布内容已保存到服务器',
        duration: 3000,
      })
    } catch (error) {
      // Show error toast
      addToast({
        type: 'error',
        title: '保存失败',
        message: error instanceof Error ? error.message : '保存画布时发生错误',
        duration: 5000,
      })
    } finally {
      setIsSaving(false)
    }
  }, [onSave, isSaving, addToast])

  const handleDelete = () => {
    selectedIds.forEach((id) => {
      if (nodes.has(id)) {
        removeNode(id)
      } else if (groups.has(id)) {
        removeGroup(id)
      } else if (domains.has(id)) {
        removeDomain(id)
      } else {
        removeConnection(id)
      }
    })
  }

  const hasSelectedNodes = selectedIds.some(id => nodes.has(id))

  const handleCreateGroup = () => {
    if (hasSelectedNodes) {
      const selectedNodes = selectedIds.map(id => nodes.get(id)).filter(Boolean)
      if (selectedNodes.length > 0) {
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity

        selectedNodes.forEach(node => {
          minX = Math.min(minX, node.x)
          minY = Math.min(minY, node.y)
          maxX = Math.max(maxX, node.x + node.width)
          maxY = Math.max(maxY, node.y + node.height)
        })

        const newGroup = {
          id: generateId('group'),
          name: `组 ${groups.size + 1}`,
          x: minX - 10,
          y: minY - 10,
          width: maxX - minX + 20,
          height: maxY - minY + 20,
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          borderWidth: 2,
          borderRadius: 8,
          nodeIds: selectedIds,
          collapsed: false,
        }
        addGroup(newGroup)
      }
    }
  }

  // Show secondary toolbar when connection tool is active
  const showSecondaryToolbar = currentTool === 'connection'

  return (
    <div className="relative border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
      {/* Primary Toolbar */}
      <div className="h-12 flex items-center justify-between px-4">
        {/* Left - Tools */}
        <div className="flex items-center gap-1">
          {tools.map((tool, index) => {
            const Icon = tool.icon
            const isActive = currentTool === tool.id
            const showSeparatorAfter = toolSeparators.includes(index)

            return (
              <div key={tool.id} className="flex items-center gap-1">
                <button
                  onClick={() => {
                    if (currentTool === tool.id) {
                      setCurrentTool('select')
                    } else {
                      setCurrentTool(tool.id)
                    }
                  }}
                  className={`
                    p-2 rounded-lg transition-colors cursor-pointer
                    ${isActive
                      ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                      : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
                    }
                  `}
                  title={`${tool.label} (${tool.shortcut})`}
                >
                  <Icon className="w-5 h-5" />
                </button>
                {showSeparatorAfter && <div className="h-6 w-px bg-gray-300 dark:bg-gray-600 mx-1" />}
              </div>
            )
          })}
        </div>

        {/* Center - View options */}
        <div className="flex items-center gap-2">
          <button
            onClick={toggleDragMode}
            className={`
              px-3 py-1.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap
              ${dragMode === 'grid'
                ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
              }
            `}
            title="切换拖动模式 (Shift)"
          >
            {dragMode === 'grid' ? '网格吸附' : '自由移动'}
          </button>

          <button
            onClick={toggleGrid}
            className={`
              p-2 rounded-lg transition-colors
              ${gridVisible
                ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
              }
            `}
            title="切换网格 (H)"
          >
            <Grid3x3 className="w-5 h-5" />
          </button>

          <button
            onClick={toggleMinimap}
            className={`
              p-2 rounded-lg transition-colors
              ${minimapVisible
                ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
              }
            `}
            title="切换缩略图"
          >
            <Map className="w-5 h-5" />
          </button>

          <div className="h-6 w-px bg-gray-300 dark:bg-gray-600" />
        </div>

        {/* Right - Actions */}
        <div className="flex items-center gap-1">
          <button
            onClick={handleCreateGroup}
            disabled={!hasSelectedNodes}
            className={`
              p-2 rounded-lg transition-colors
              ${hasSelectedNodes
                ? 'hover:bg-blue-100 dark:hover:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                : 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
              }
            `}
            title="创建组 (Ctrl+G)"
          >
            <Group className="w-5 h-5" />
          </button>

          <button
            onClick={handleDelete}
            disabled={selectedIds.length === 0}
            className={`
              p-2 rounded-lg transition-colors
              ${selectedIds.length > 0
                ? 'hover:bg-red-100 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400'
                : 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
              }
            `}
            title="删除选中项 (Delete)"
          >
            <Trash2 className="w-5 h-5" />
          </button>

          <div className="h-6 w-px bg-gray-300 dark:bg-gray-600" />

          <button
            onClick={undo}
            disabled={!canUndo}
            className={`
              p-2 rounded-lg transition-colors
              ${canUndo
                ? 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
                : 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
              }
            `}
            title="撤销 (Ctrl+Z)"
          >
            <Undo className="w-5 h-5" />
          </button>

          <button
            onClick={redo}
            disabled={!canRedo}
            className={`
              p-2 rounded-lg transition-colors
              ${canRedo
                ? 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
                : 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
              }
            `}
            title="重做 (Ctrl+Y)"
          >
            <Redo className="w-5 h-5" />
          </button>

          <div className="h-6 w-px bg-gray-300 dark:bg-gray-600" />

          <button
            onClick={handleSave}
            disabled={isSaving || !onSave}
            className={`p-2 rounded-lg transition-colors relative ${isSaving
                ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                : saveSuccess
                  ? 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
              } ${!onSave ? 'opacity-50 cursor-not-allowed' : ''}`}
            title="保存 (Ctrl+S)"
          >
            {isSaving ? (
              <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            ) : saveSuccess ? (
              <Check className="w-5 h-5" />
            ) : (
              <Save className="w-5 h-5" />
            )}
          </button>

          <button
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400"
            title="导出 (Ctrl+E)"
          >
            <Download className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Secondary Toolbar - Connection Options */}
      {showSecondaryToolbar && (
        <div className="absolute left-0 right-0 top-12 h-12 border-t border-gray-200 dark:border-gray-700 flex items-center justify-center px-4 bg-gray-50 dark:bg-gray-900/50 shadow-md z-10">
          {currentTool === 'connection' ? (
            <>
              {/* Connection Directions */}
              <div className="flex items-center gap-1 mr-4">
                <span className="text-xs text-gray-500 dark:text-gray-400 mr-2">方向</span>
                {connectionDirections.map((dir) => {
                  const DirIcon = dir.icon
                  const isActive = connectionDirection === dir.id
                  return (
                    <button
                      key={dir.id}
                      onClick={() => setConnectionDirection(dir.id)}
                      className={`
                        px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5
                        ${isActive
                          ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                          : 'hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
                        }
                      `}
                      title={dir.label}
                    >
                      <DirIcon className="w-4 h-4" />
                      {dir.label}
                    </button>
                  )
                })}
              </div>

              <div className="h-6 w-px bg-gray-300 dark:bg-gray-600" />

              {/* Connection Styles */}
              <div className="flex items-center gap-1 ml-4">
                <span className="text-xs text-gray-500 dark:text-gray-400 mr-2">样式</span>
                {connectionStyles.map((style) => {
                  const isActive = connectionStyle === style.id
                  return (
                    <button
                      key={style.id}
                      onClick={() => setConnectionStyle(style.id)}
                      className={`
                        px-3 py-1.5 rounded-lg text-sm font-medium transition-colors
                        ${isActive
                          ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                          : 'hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
                        }
                      `}
                      title={style.label}
                    >
                      {style.label}
                    </button>
                  )
                })}
              </div>
            </>
          ) : null}
        </div>
      )}

      {/* 域编辑模式提示 */}
      {currentTool === 'domain' && (
        <div className="absolute top-14 left-1/2 transform -translate-x-1/2 bg-blue-500 text-white px-4 py-2 rounded-lg shadow-lg z-20">
          域编辑模式 - 拖拽创建域，点击选中编辑
        </div>
      )}
    </div>
  )
}
