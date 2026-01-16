import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Edit,
  Copy,
  Trash2,
  Lock,
  Unlock,
  Minus,
  Plus,
  ArrowUpToLine,
  ArrowDownToLine,
  Palette,
  ChevronRight,
  Check,
  FolderPlus,
  Image as ImageIcon,
  RefreshCw,
} from 'lucide-react'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useUIStore } from '@/store/useUIStore'
import { useProjectsStore } from '@/store/useProjectsStore'
import { useNodePoolStore } from '@/features/node-pool/stores/useNodePoolStore'
import { uploadImage } from '@/services/api'
import { NODE_COLORS, BORDER_COLORS } from '@/constants'

interface NodeContextMenuProps {
  nodeId: string
  position: { x: number; y: number }
  onClose: () => void
}

export function NodeContextMenu({ nodeId, position, onClose }: NodeContextMenuProps) {
  const { nodes, updateNode, removeNode, duplicateNode } = useCanvasStore()
  const { openStylePanel, setSelectedNodeIds, setSelectedType, addToast } = useUIStore()
  const { currentProject, addToNodePool } = useProjectsStore()
  const { setCards, cardsMap } = useNodePoolStore()

  const menuRef = useRef<HTMLDivElement>(null)
  const colorSectionRef = useRef<HTMLDivElement>(null)
  const [colorSectionOpen, setColorSectionOpen] = useState(false)
  const [adjustedPosition, setAdjustedPosition] = useState(position)
  const node = nodes.get(nodeId)

  // Adjust menu position based on actual menu size and viewport boundaries
  useEffect(() => {
    const adjustPosition = () => {
      if (!menuRef.current) return

      const rect = menuRef.current.getBoundingClientRect()
      const padding = 10
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight

      let x = position.x
      let y = position.y

      // Adjust horizontal position
      if (x + rect.width > viewportWidth - padding) {
        x = viewportWidth - rect.width - padding
      }
      if (x < padding) {
        x = padding
      }

      // Adjust vertical position
      if (y + rect.height > viewportHeight - padding) {
        y = viewportHeight - rect.height - padding
      }
      if (y < padding) {
        y = padding
      }

      setAdjustedPosition({ x, y })
    }

    // Initial adjustment
    adjustPosition()

    // Re-adjust when color section opens/closes
    if (colorSectionOpen) {
      // Use setTimeout to ensure the menu has finished rendering with the new size
      const timeoutId = setTimeout(adjustPosition, 0)
      return () => clearTimeout(timeoutId)
    }
  }, [position, colorSectionOpen])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as unknown as globalThis.Node)) {
        onClose()
      }
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])

  if (!node) return null

  const handleAddToNodePool = async () => {
    if (!currentProject) {
      addToast({ type: 'warning', title: '未选择项目', message: '请先选择一个项目' })
      return
    }

    try {
      const card = await addToNodePool(currentProject.id, {
        projectId: currentProject.id,
        name: node.title || node.content || '未命名',
        content: JSON.stringify(node),
        type: node.type || 'text',
        color: node.color,
        tags: null,
        createdBy: 1,
        sortOrder: 0,
      })

      setCards([...cardsMap.values(), card])
      addToast({ type: 'success', title: '已添加到节点池', message: '节点已添加到节点池' })
    } catch (error) {
      addToast({ type: 'error', title: '添加失败', message: error instanceof Error ? error.message : '未知错误' })
    }
    onClose()
  }

  const handleReplaceImage = async () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return

      try {
        const { url } = await uploadImage(file)
        const img = new Image()
        img.onload = () => {
          const aspectRatio = img.width / img.height
          const newHeight = node.width / aspectRatio
          const updates: any = {
            imageUrl: url,
            aspectRatio: aspectRatio,
            height: node.collapsed ? 36 : newHeight,
            expandedHeight: newHeight
          }
          updateNode(nodeId, updates)
          addToast({ type: 'success', title: '更新成功', message: '图片已更换' })
        }
        img.src = url
      } catch (error) {
        addToast({ type: 'error', title: '更新失败', message: '上传图片失败' })
      }
    }
    input.click()
    onClose()
  }

  const handleResetAspectRatio = () => {
    if (!node.imageUrl) {
      addToast({ type: 'warning', title: '重置失败', message: '节点未包含图片' })
      onClose()
      return
    }

    const performReset = (ratio: number) => {
      const newHeight = node.width / ratio
      const updates: any = {
        aspectRatio: ratio,
        height: newHeight,
      }

      // If node is not collapsed, update height normally.
      // If it is collapsed, height should stay 36, but expandedHeight should be updated.
      if (node.collapsed) {
        updates.height = 36
        updates.expandedHeight = newHeight
      } else {
        updates.expandedHeight = newHeight
      }

      updateNode(nodeId, updates)
      addToast({ type: 'success', title: '重置成功', message: '已重置图片比例' })
      onClose()
    }

    if (node.aspectRatio) {
      performReset(node.aspectRatio)
    } else {
      // If aspectRatio is missing, try to calculate it from the image
      const img = new Image()
      img.onload = () => {
        const ratio = img.width / img.height
        performReset(ratio)
      }
      img.onerror = () => {
        addToast({ type: 'error', title: '重置失败', message: '无法读取图片信息' })
        onClose()
      }
      img.src = node.imageUrl
    }
  }

  const handleDuplicate = () => {
    duplicateNode(nodeId)
    onClose()
  }

  const handleDelete = () => {
    removeNode(nodeId)
    onClose()
  }

  const handleLock = () => {
    updateNode(nodeId, { locked: !node.locked })
    onClose()
  }

  const handleToggleCollapse = () => {
    const newCollapsed = !node.collapsed

    if (newCollapsed) {
      updateNode(nodeId, {
        collapsed: newCollapsed,
        expandedHeight: node.height,
        height: 36
      })
    } else {
      updateNode(nodeId, {
        collapsed: newCollapsed,
        height: node.expandedHeight || node.height
      })
    }
    onClose()
  }

  const handleBringToFront = () => {
    const { nodes: allNodes } = useCanvasStore.getState()
    const newNodes = new Map(allNodes)
    const currentNode = newNodes.get(nodeId)
    if (currentNode) {
      newNodes.delete(nodeId)
      newNodes.set(nodeId, currentNode)
      useCanvasStore.setState({ nodes: newNodes })
    }
    onClose()
  }

  const handleSendToBack = () => {
    const { nodes: allNodes } = useCanvasStore.getState()
    const newNodes = new Map(allNodes)
    const currentNode = newNodes.get(nodeId)
    if (currentNode) {
      newNodes.delete(nodeId)
      const orderedNodes = new Map([[nodeId, currentNode], ...Array.from(newNodes.entries())])
      useCanvasStore.setState({ nodes: orderedNodes })
    }
    onClose()
  }

  const handleColorChange = (color: string) => {
    updateNode(nodeId, { color })
  }

  const handleBorderColorChange = (color: string) => {
    updateNode(nodeId, { borderColor: color })
  }

  const handleEditStyle = () => {
    setSelectedNodeIds([nodeId])
    setSelectedType('node')
    openStylePanel()
    onClose()
  }

  const MenuItem = ({
    icon: Icon,
    label,
    onClick,
    shortcut,
    disabled = false,
    danger = false,
    rightElement,
  }: {
    icon: typeof Edit
    label: string
    onClick: () => void
    shortcut?: string
    disabled?: boolean
    danger?: boolean
    rightElement?: React.ReactNode
  }) => (
    <button
      className={`
        w-full px-3 py-2.5 text-left flex items-center gap-3 rounded-lg
        transition-all duration-150 group relative
        ${disabled
          ? 'opacity-40 cursor-not-allowed'
          : danger
            ? 'hover:bg-red-50 dark:hover:bg-red-900/20 text-gray-700 dark:text-gray-300'
            : 'hover:bg-gray-100 dark:hover:bg-gray-700/50 text-gray-700 dark:text-gray-300'
        }
      `}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon className={`w-4 h-4 ${danger ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'}`} />
      <span className="flex-1 text-sm font-medium">{label}</span>
      {shortcut && (
        <span className="text-xs text-gray-400 dark:text-gray-500 font-normal">{shortcut}</span>
      )}
      {rightElement}
    </button>
  )

  const MenuDivider = () => <div className="h-px bg-gray-200 dark:bg-gray-700/50 my-1.5 -mx-1" />

  return (
    createPortal(
      <>
        <div className="fixed inset-0 z-40" onClick={onClose} />

        <div
          ref={menuRef}
          className="fixed z-[80] w-60 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 py-2 px-2 animate-in fade-in zoom-in-95 duration-150"
          style={{
            left: adjustedPosition.x,
            top: adjustedPosition.y,
          }}
        >
          {/* Edit Actions */}
          <div className="space-y-0.5">
            <MenuItem
              icon={FolderPlus}
              label="加入节点池"
              onClick={handleAddToNodePool}
              shortcut="Ctrl+Shift+A"
              disabled={node.locked}
            />
            <MenuItem
              icon={Copy}
              label="复制"
              onClick={handleDuplicate}
              shortcut="⌘D"
            />
            <MenuItem
              icon={Trash2}
              label="删除"
              onClick={handleDelete}
              shortcut="Del"
              danger
            />
          </div>

          <MenuDivider />

          {/* Node State */}
          <div className="space-y-0.5">
            <MenuItem
              icon={node.locked ? Unlock : Lock}
              label={node.locked ? '解锁' : '锁定'}
              onClick={handleLock}
            />
            {node.type !== 'image' && (
              <MenuItem
                icon={node.collapsed ? Plus : Minus}
                label={node.collapsed ? '展开' : '折叠'}
                onClick={handleToggleCollapse}
              />
            )}
            {node.type === 'image' && (
              <>
                <MenuItem
                  icon={ImageIcon}
                  label="更换图片"
                  onClick={handleReplaceImage}
                  disabled={node.locked}
                />
                <MenuItem
                  icon={RefreshCw}
                  label="重置比例"
                  onClick={handleResetAspectRatio}
                  disabled={node.locked}
                />
              </>
            )}
          </div>

          <MenuDivider />

          {/* Layer */}
          <div className="space-y-0.5">
            <MenuItem
              icon={ArrowUpToLine}
              label="置于顶层"
              onClick={handleBringToFront}
            />
            <MenuItem
              icon={ArrowDownToLine}
              label="置于底层"
              onClick={handleSendToBack}
            />
          </div>

          <MenuDivider />

          {/* Colors */}
          <div ref={colorSectionRef}>
            <button
              className="w-full px-3 py-2.5 text-left flex items-center gap-3 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700/50 text-gray-700 dark:text-gray-300 transition-all duration-150 group"
              onClick={() => setColorSectionOpen(!colorSectionOpen)}
            >
              <Palette className="w-4 h-4 text-gray-500 dark:text-gray-400" />
              <span className="flex-1 text-sm font-medium">颜色设置</span>
              <ChevronRight
                className={`w-4 h-4 text-gray-400 transition-transform duration-150 ${colorSectionOpen ? 'rotate-90' : ''}`}
              />
            </button>

            {colorSectionOpen && (
              <div className="mt-2 space-y-3 animate-in slide-in-from-top-2 duration-150">
                {/* Background Colors */}
                {node.type !== 'image' && (
                  <div>
                    <div className="px-1 pb-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">
                      背景颜色
                    </div>
                    <div className="grid grid-cols-8 gap-1.5">
                      {NODE_COLORS.map((color) => (
                        <button
                          key={color}
                          className="relative w-6 h-6 rounded-md shadow-sm hover:scale-110 hover:shadow-md transition-all duration-150"
                          style={{ backgroundColor: color }}
                          onClick={() => handleColorChange(color)}
                          title={color}
                        >
                          {node.color === color && (
                            <Check className="absolute inset-0 m-auto w-3.5 h-3.5 text-gray-800" strokeWidth={3} />
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Border Colors */}
                <div>
                  <div className="px-1 pb-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">
                    边框颜色
                  </div>
                  <div className="grid grid-cols-8 gap-1.5">
                    {BORDER_COLORS.map((color) => (
                      <button
                        key={color}
                        className="relative w-6 h-6 rounded-md border-2 hover:scale-110 hover:shadow-md transition-all duration-150"
                        style={{ borderColor: color, backgroundColor: 'transparent' }}
                        onClick={() => handleBorderColorChange(color)}
                        title={color}
                      >
                        {node.borderColor === color && (
                          <Check className="absolute inset-0 m-auto w-3.5 h-3.5 drop-shadow-md" strokeWidth={3} style={{ color }} />
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          <MenuDivider />

          {/* Advanced Style */}
          <MenuItem
            icon={Palette}
            label="高级样式..."
            onClick={handleEditStyle}
            rightElement={<ChevronRight className="w-4 h-4 text-gray-400" />}
          />
        </div>
      </>,
      document.body
    )
  )
}
