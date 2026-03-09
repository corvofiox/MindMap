import { MousePointer2, Square, Layers, Link, Grid3x3, Undo, Redo, Trash2, ArrowRight, ArrowLeftRight, Minus, Group, Save, Download, Upload, Check, Map, Layout, Image as ImageIcon, Pencil, ChevronDown } from 'lucide-react'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useUIStore } from '@/store/useUIStore'
import type { Tool } from '@/types'
import { useState, useCallback, useRef, useEffect } from 'react'
import { generateId } from '@/utils/canvas'
import { exportCanvas, importCanvas, downloadJsonFile, readJsonFile } from '@/utils/canvasExport'

interface CanvasToolbarProps {
  onSave?: () => Promise<void>
  isViewer?: boolean
}

const tools: { id: Tool; icon: typeof MousePointer2; label: string; shortcut: string }[] = [
  { id: 'node', icon: Square, label: '节点', shortcut: 'N' },
  { id: 'image', icon: ImageIcon, label: '图片', shortcut: 'I' },
  { id: 'connection', icon: Link, label: '连线', shortcut: 'L' },
  { id: 'group', icon: Layers, label: '分组', shortcut: 'G' },
  { id: 'domain', icon: Layout, label: '域', shortcut: 'R' },
]

const toolSeparators = [1, 2]

export function CanvasToolbar({ onSave, isViewer }: CanvasToolbarProps) {
  const { currentTool, gridVisible, dragMode, minimapVisible, quickEditMode, setCurrentTool, toggleGrid, toggleDragMode, toggleMinimap, toggleQuickEditMode, connectionDirection, setConnectionDirection, connectionStyle, setConnectionStyle, connectionType, setConnectionType, addToast } = useUIStore()
  const { selectedIds, removeNode, removeConnection, removeGroup, removeDomain, nodes, undo, redo, history, groups, domains, addGroup, connections, zoom, panX, panY, setCanvasData } = useCanvasStore()

  const [isSaving, setIsSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [showImportExportMenu, setShowImportExportMenu] = useState(false)
  const importExportRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

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

  const connectionTypes = [
    { id: 'straight' as const, label: '直线' },
    { id: 'step' as const, label: '直角线' },
    { id: 'curve' as const, label: '曲线' },
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

  // 点击外部关闭导入导出菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (importExportRef.current && !importExportRef.current.contains(event.target as Node)) {
        setShowImportExportMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // 处理导出
  const handleExport = useCallback(() => {
    const jsonString = exportCanvas(
      nodes,
      connections,
      groups,
      domains,
      { zoom, panX, panY }
    )
    const filename = `mindmap-${new Date().toISOString().slice(0, 10)}.json`
    downloadJsonFile(jsonString, filename)
    addToast({
      type: 'success',
      title: '导出成功',
      message: '画布数据已导出为 JSON 文件',
      duration: 3000,
    })
    setShowImportExportMenu(false)
  }, [nodes, connections, groups, domains, zoom, panX, panY, addToast])

  // 处理导入按钮点击
  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click()
    setShowImportExportMenu(false)
  }, [])

  // 处理文件选择
  const handleFileSelect = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const jsonString = await readJsonFile(file)
      const data = importCanvas(jsonString)

      if (data) {
        setCanvasData(data)
        addToast({
          type: 'success',
          title: '导入成功',
          message: `成功导入 ${data.nodes.length} 个节点, ${data.connections.length} 条连线`,
          duration: 3000,
        })
      } else {
        addToast({
          type: 'error',
          title: '导入失败',
          message: '文件格式不正确或已损坏',
          duration: 5000,
        })
      }
    } catch (error) {
      addToast({
        type: 'error',
        title: '导入失败',
        message: '读取文件时发生错误',
        duration: 5000,
      })
    }

    // 清空 input 值，允许重复选择同一文件
    event.target.value = ''
  }, [setCanvasData, addToast])

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
            const isDisabled = isViewer && tool.id !== 'select'

            return (
              <div key={tool.id} className="flex items-center gap-1">
                <button
                  onClick={() => {
                    if (isDisabled) return
                    if (currentTool === tool.id) {
                      setCurrentTool('select')
                    } else {
                      setCurrentTool(tool.id)
                    }
                  }}
                  className={`
                    p-2 rounded-lg transition-colors
                    ${isDisabled
                      ? 'opacity-50 cursor-not-allowed text-gray-400 dark:text-gray-600'
                      : isActive
                        ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 cursor-pointer'
                        : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400 cursor-pointer'
                    }
                  `}
                  title={`${tool.label} (${tool.shortcut})${isDisabled ? ' - 查看者无法使用' : ''}`}
                  disabled={isDisabled}
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
            onClick={isViewer ? undefined : toggleDragMode}
            disabled={isViewer}
            className={`
              px-3 py-1.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap
              ${isViewer
                ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
                : dragMode === 'grid'
                  ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
              }
            `}
            title={isViewer ? '查看者无法切换拖动模式' : '切换拖动模式 (Shift)'}
          >
            {dragMode === 'grid' ? '网格吸附' : '自由移动'}
          </button>

          <button
            onClick={isViewer ? undefined : toggleQuickEditMode}
            disabled={isViewer}
            className={`
              p-2 rounded-lg transition-colors
              ${isViewer
                ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
                : quickEditMode
                  ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
              }
            `}
            title={isViewer ? '查看者无法使用快速编辑模式' : '快速编辑模式 (E)'}
          >
            <Pencil className="w-5 h-5" />
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
            title="切换小地图 (M)"
          >
            <Map className="w-5 h-5" />
          </button>

          <div className="h-6 w-px bg-gray-300 dark:bg-gray-600" />
        </div>

        {/* Right - Actions */}
        <div className="flex items-center gap-1">
          <button
            onClick={handleCreateGroup}
            disabled={!hasSelectedNodes || isViewer}
            className={`
              p-2 rounded-lg transition-colors
              ${hasSelectedNodes && !isViewer
                ? 'hover:bg-blue-100 dark:hover:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                : 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
              }
            `}
            title={isViewer ? '查看者无法创建组' : '创建组 (Ctrl+G)'}
          >
            <Group className="w-5 h-5" />
          </button>

          <button
            onClick={handleDelete}
            disabled={selectedIds.length === 0 || isViewer}
            className={`
              p-2 rounded-lg transition-colors
              ${selectedIds.length > 0 && !isViewer
                ? 'hover:bg-red-100 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400'
                : 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
              }
            `}
            title={isViewer ? '查看者无法删除' : '删除选中项 (Delete)'}
          >
            <Trash2 className="w-5 h-5" />
          </button>

          <div className="h-6 w-px bg-gray-300 dark:bg-gray-600" />

          <button
            onClick={undo}
            disabled={!canUndo || isViewer}
            className={`
              p-2 rounded-lg transition-colors
              ${canUndo && !isViewer
                ? 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
                : 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
              }
            `}
            title={isViewer ? '查看者无法撤销' : '撤销 (Ctrl+Z)'}
          >
            <Undo className="w-5 h-5" />
          </button>

          <button
            onClick={redo}
            disabled={!canRedo || isViewer}
            className={`
              p-2 rounded-lg transition-colors
              ${canRedo && !isViewer
                ? 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
                : 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
              }
            `}
            title={isViewer ? '查看者无法重做' : '重做 (Ctrl+Y)'}
          >
            <Redo className="w-5 h-5" />
          </button>

          <div className="h-6 w-px bg-gray-300 dark:bg-gray-600" />

          <button
            onClick={handleSave}
            disabled={isSaving || !onSave || isViewer}
            className={`p-2 rounded-lg transition-colors relative ${isViewer
              ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
              : isSaving
                ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                : saveSuccess
                  ? 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
              } ${!onSave ? 'opacity-50 cursor-not-allowed' : ''}`}
            title={isViewer ? '查看者无法保存' : '保存 (Ctrl+S)'}
          >
            {isSaving ? (
              <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            ) : saveSuccess ? (
              <Check className="w-5 h-5" />
            ) : (
              <Save className="w-5 h-5" />
            )}
          </button>

          <div className="relative" ref={importExportRef}>
            <button
              onClick={() => setShowImportExportMenu(!showImportExportMenu)}
              disabled={isViewer}
              className={`
                flex items-center gap-1 px-2 py-2 rounded-lg transition-colors
                ${isViewer
                  ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
                }
              `}
              title={isViewer ? '查看者无法导入导出' : '导入/导出'}
            >
              <Upload className="w-5 h-5" />
              <ChevronDown className="w-3 h-3" />
            </button>

            {/* 导入导出下拉菜单 */}
            {showImportExportMenu && !isViewer && (
              <div className="absolute right-0 top-full mt-1 w-32 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-50">
                <button
                  onClick={handleImportClick}
                  className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
                >
                  <Download className="w-4 h-4" />
                  导入
                </button>
                <button
                  onClick={handleExport}
                  className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
                >
                  <Upload className="w-4 h-4" />
                  导出
                </button>
              </div>
            )}
          </div>

          {/* 隐藏的文件输入 */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.mindmap"
            onChange={handleFileSelect}
            className="hidden"
          />
        </div>
      </div>

      {/* Secondary Toolbar - Connection Options */}
      {showSecondaryToolbar && (
        <div className="inline-grid h-auto min-h-12 border-t border-gray-200 dark:border-gray-700 grid grid-cols-1 xl:grid-cols-3 xl:grid-auto-rows xl:grid-flow-col gap-y-1 xl:gap-x-4 px-4 py-2 bg-gray-50 dark:bg-gray-900/50 shadow-md z-10">
          {currentTool === 'connection' ? (
            <>
              {/* Connection Directions */}
              <div className="flex items-center xl:justify-center gap-1 min-w-fit">
                <span className="text-xs text-gray-500 dark:text-gray-400 mr-1 px-1 shrink-0 bg-gray-100 dark:bg-gray-800 rounded">方向：</span>
                {connectionDirections.map((dir) => {
                  const DirIcon = dir.icon
                  const isActive = connectionDirection === dir.id
                  return (
                    <button
                      key={dir.id}
                      onClick={() => setConnectionDirection(dir.id)}
                      className={`
                        px-2 py-1 rounded-lg text-xs font-medium transition-colors flex items-center gap-1 shrink-0
                        ${isActive
                          ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                          : 'hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
                        }
                      `}
                      title={dir.label}
                    >
                      <DirIcon className="w-3 h-3" />
                      {dir.label}
                    </button>
                  )
                })}
              </div>

              {/* Connection Styles */}
              <div className="flex items-center xl:justify-center gap-1 min-w-fit">
                <span className="text-xs text-gray-500 dark:text-gray-400 mr-1 px-1 shrink-0 bg-gray-100 dark:bg-gray-800 rounded">样式：</span>
                {connectionStyles.map((style) => {
                  const isActive = connectionStyle === style.id
                  return (
                    <button
                      key={style.id}
                      onClick={() => setConnectionStyle(style.id)}
                      className={`
                        px-2 py-1 rounded-lg text-xs font-medium transition-colors shrink-0
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

              {/* Connection Types */}
              <div className="flex items-center xl:justify-center gap-1 min-w-fit">
                <span className="text-xs text-gray-500 dark:text-gray-400 mr-1 px-1 shrink-0 bg-gray-100 dark:bg-gray-800 rounded">类型：</span>
                {connectionTypes.map((type) => {
                  const isActive = connectionType === type.id
                  return (
                    <button
                      key={type.id}
                      onClick={() => {
                        setConnectionType(type.id)
                      }}
                      className={`
                        px-2 py-1 rounded-lg text-xs font-medium transition-colors shrink-0
                        ${isActive
                          ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                          : 'hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400'
                        }
                      `}
                      title={type.label}
                    >
                      {type.label}
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
        <div className="absolute top-14 left-1/2 transform -translate-x-1/2 bg-blue-500 dark:bg-blue-600 text-white px-4 py-2 rounded-lg shadow-lg z-20">
          域编辑模式 - 拖拽创建域，点击选中编辑
        </div>
      )}
    </div>
  )
}
