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
  Download,
} from 'lucide-react'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useUIStore } from '@/store/useUIStore'
import { useProjectsStore } from '@/store/useProjectsStore'
import { useAuthStore } from '@/store/useAuthStore'
import { useNodePoolStore } from '@/features/node-pool/stores/useNodePoolStore'
import { uploadImage } from '@/services/api'
import { NODE_COLORS, Z_INDEX } from '@/constants'

interface NodeContextMenuProps {
  nodeId: string
  position: { x: number; y: number }
  onClose: () => void
}

export function NodeContextMenu({ nodeId, position, onClose }: NodeContextMenuProps) {
  const { nodes, updateNode, removeNode, duplicateNode } = useCanvasStore()
  const { openStylePanel, setSelectedNodeIds, setSelectedType, addToast } = useUIStore()
  const { currentProject } = useProjectsStore()
  const { user } = useAuthStore()
  const { addCard } = useNodePoolStore()

  const menuRef = useRef<HTMLDivElement>(null)
  const colorSectionRef = useRef<HTMLDivElement>(null)
  const [colorSectionOpen, setColorSectionOpen] = useState(false)
  const [isPositioned, setIsPositioned] = useState(false)
  const [finalPosition, setFinalPosition] = useState(position)
  const node = nodes.get(nodeId)

  // Adjust menu position based on actual menu size and viewport boundaries
  useEffect(() => {
    if (isPositioned) return

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

      setFinalPosition({ x, y })
      setIsPositioned(true)
    }

    const rafId = requestAnimationFrame(adjustPosition)
    return () => cancelAnimationFrame(rafId)
  }, [position, isPositioned])

  // Re-adjust when color section opens/closes
  useEffect(() => {
    if (colorSectionOpen && menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect()
      const padding = 10
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight

      let x = position.x
      let y = position.y

      if (x + rect.width > viewportWidth - padding) {
        x = viewportWidth - rect.width - padding
      }
      if (x < padding) {
        x = padding
      }

      if (y + rect.height > viewportHeight - padding) {
        y = viewportHeight - rect.height - padding
      }
      if (y < padding) {
        y = padding
      }

      setFinalPosition({ x, y })
    }
  }, [colorSectionOpen, position])

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

    // 统一节点没有"类型"了；卡片仍保留一个粗粒度 type（有图/无图），
    // 供节点池卡片列表选择缩略图样式，不需要改动卡片表结构。
    const cardData = {
      name: node.title || node.content || '未命名',
      content: JSON.stringify(node),
      type: node.cover ? 'image' : 'text',
      color: node.color,
      tags: null,
      sortOrder: 0,
      thumbnail: node.cover,
    }

    onClose()

    try {
      await addCard(cardData)
      // 从画布中移除原始节点
      removeNode(nodeId)
      addToast({ type: 'success', title: '已添加到节点池', message: '节点已添加到节点池并从画布移除' })
    } catch (error) {
      addToast({ type: 'error', title: '添加失败', message: error instanceof Error ? error.message : '未知错误' })
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

  // 置顶/置底：具体的层序计算在 store 的 bringNodeToFront / sendNodeToBack 里，
  // 这里只负责转调与关闭菜单。层序是节点的普通字段（shared/src/z-order.ts），
  // 因此会持久化、会同步给协作者、也进撤销历史。
  const handleBringToFront = () => {
    useCanvasStore.getState().bringNodeToFront(nodeId)
    onClose()
  }

  // 置底与置顶同理，只是取 min - STEP。
  const handleSendToBack = () => {
    useCanvasStore.getState().sendNodeToBack(nodeId)
    onClose()
  }

  const handleColorChange = (color: string) => {
    updateNode(nodeId, { color })
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
        <div className="fixed inset-0" style={{ zIndex: Z_INDEX.CONTEXT_MENU }} onClick={onClose} />

        <div
          ref={menuRef}
          className="fixed w-60 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 py-2 px-2 animate-in fade-in zoom-in-95 duration-150"
          style={{
            left: finalPosition.x,
            top: finalPosition.y,
            opacity: isPositioned ? 1 : 0,
            pointerEvents: isPositioned ? 'auto' : 'none',
            transition: 'opacity 0.1s ease-out',
            zIndex: Z_INDEX.CONTEXT_MENU,
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
            {(
              <MenuItem
                icon={node.collapsed ? Plus : Minus}
                label={node.collapsed ? '展开' : '折叠'}
                onClick={handleToggleCollapse}
              />
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

          {(
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
                </div>
              )}
            </div>
          )}

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