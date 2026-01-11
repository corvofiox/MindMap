import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Trash2, Type, Settings2 } from 'lucide-react'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useUIStore } from '@/store/useUIStore'

interface DomainContextMenuProps {
  domainId: string
  position: { x: number; y: number }
  onClose: () => void
}

export function DomainContextMenu({ domainId, position, onClose }: DomainContextMenuProps) {
  const { domains, updateDomain, removeDomain, selectedIds, setSelectedIds } = useCanvasStore()
  const { openStylePanel, setSelectedType, addToast } = useUIStore()

  const menuRef = useRef<HTMLDivElement>(null)
  const [adjustedPosition, setAdjustedPosition] = useState(position)
  const domain = domains.get(domainId)

  useEffect(() => {
    const adjustPosition = () => {
      if (!menuRef.current) return

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

      setAdjustedPosition({ x, y })
    }

    adjustPosition()
  }, [position])

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

  if (!domain) return null

  const handleOpenStylePanel = () => {
    setSelectedIds([domainId])
    setSelectedType('domain')
    openStylePanel()
    onClose()
  }

  const handleToggleTitle = () => {
    updateDomain(domainId, { titleVisible: !domain.titleVisible })
    onClose()
  }

  const handleDelete = () => {
    removeDomain(domainId)
    onClose()
  }

  const MenuItem = ({
    icon: Icon,
    label,
    onClick,
    danger = false,
  }: {
    icon: typeof Trash2
    label: string
    onClick: () => void
    danger?: boolean
  }) => (
    <button
      className={`
        w-full px-2.5 py-2 text-left flex items-center gap-2 rounded-lg
        transition-all duration-150 group relative
        ${danger
          ? 'hover:bg-red-50 dark:hover:bg-red-900/20 text-gray-700 dark:text-gray-300'
          : 'hover:bg-gray-100 dark:hover:bg-gray-700/50 text-gray-700 dark:text-gray-300'
        }
      `}
      onClick={onClick}
    >
      <Icon className={`w-4 h-4 ${danger ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'}`} />
      <span className="flex-1 text-sm font-medium">{label}</span>
    </button>
  )

  const MenuDivider = () => <div className="h-px bg-gray-200 dark:bg-gray-700/50 my-1 -mx-1" />

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />

      <div
        ref={menuRef}
        className="fixed z-50 w-60 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 py-2 px-2 animate-in fade-in zoom-in-95 duration-150"
        style={{
          left: adjustedPosition.x,
          top: adjustedPosition.y,
        }}
      >
        <div className="space-y-0.5">
          <MenuItem
            icon={Settings2}
            label="样式设置..."
            onClick={handleOpenStylePanel}
          />
        </div>

        <MenuDivider />

        <div className="space-y-0.5">
          <MenuItem
            icon={Type}
            label={domain.titleVisible ? '隐藏标题' : '显示标题'}
            onClick={handleToggleTitle}
          />
        </div>

        <MenuDivider />

        <div className="space-y-0.5">
          <MenuItem
            icon={Trash2}
            label="删除"
            onClick={handleDelete}
            danger
          />
        </div>
      </div>
    </>,
    document.body
  )
}
