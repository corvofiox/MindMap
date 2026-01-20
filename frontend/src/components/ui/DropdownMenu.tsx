import { useState, useRef, useEffect } from 'react'
import { Check } from 'lucide-react'
import clsx from 'clsx'
import { Z_INDEX } from '@/constants'

interface DropdownMenuProps {
  trigger: React.ReactNode
  items: Array<{
    label?: string
    action?: () => void
    icon?: React.ComponentType<{ className?: string }>
    checked?: boolean
    divider?: boolean
  }>
  align?: 'start' | 'end'
}

export function DropdownMenu({ trigger, items, align = 'end' }: DropdownMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  const handleItemClick = (item: typeof items[0]) => {
    item.action?.()
    setIsOpen(false)
  }

  return (
    <div ref={containerRef} className="relative">
      <div onClick={() => setIsOpen(!isOpen)}>
        {trigger}
      </div>

      {isOpen && (
        <div
          className={clsx(
            'absolute top-full mt-1 w-56 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1',
            align === 'end' ? 'right-0' : 'left-0'
          )}
          style={{ zIndex: Z_INDEX.DROPDOWN_MENU }}
        >
          {items.map((item, index) => {
            if (item.divider) {
              return <div key={index} className="h-px bg-gray-200 dark:bg-gray-700 my-1" />
            }

            const Icon = item.icon

            return (
              <button
                key={index}
                onClick={() => handleItemClick(item)}
                className="w-full flex items-center gap-3 px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 transition-colors"
              >
                {Icon && <Icon className="w-4 h-4" />}
                {item.label && <span className="flex-1 text-left text-sm">{item.label}</span>}
                {item.checked && <Check className="w-4 h-4 text-blue-500" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
