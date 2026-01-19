import { ReactNode } from 'react'
import clsx from 'clsx'

interface MenuItemProps {
  icon?: ReactNode
  label: string
  onClick: () => void
  danger?: boolean
  shortcut?: string
  disabled?: boolean
  divider?: boolean
  className?: string
  children?: ReactNode
}

export function MenuItem({
  icon,
  label,
  onClick,
  danger = false,
  shortcut,
  disabled = false,
  divider = false,
  className = '',
  children,
}: MenuItemProps) {
  if (divider) {
    return <div className="h-px bg-gray-200 dark:bg-gray-700 my-1" />
  }

  return (
    <button
      className={clsx(
        'w-full flex items-center gap-2 px-3 py-2 text-sm rounded transition-colors duration-150 focus:outline-none',
        {
          'opacity-40 cursor-not-allowed': disabled,
          'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30': danger && !disabled,
          'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700': !danger && !disabled,
        },
        className
      )}
      onClick={onClick}
      disabled={disabled}
      type="button"
    >
      {icon && <span className="w-4 h-4 flex-shrink-0">{icon}</span>}
      <span className="flex-1 text-left">{label}</span>
      {shortcut && (
        <span className="text-xs text-gray-400 dark:text-gray-500 font-mono">{shortcut}</span>
      )}
      {children}
    </button>
  )
}

interface MenuProps {
  children: ReactNode
  className?: string
  onClickOutside?: () => void
}

export function Menu({
  children,
  className = '',
  onClickOutside,
}: MenuProps) {
  const handleClickOutside = (e: React.MouseEvent) => {
    if (onClickOutside && !(e.target as Element).closest('.menu-container')) {
      onClickOutside()
    }
  }

  return (
    <div
      className="fixed z-[80] bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 min-w-[160px] menu-container"
      onClick={handleClickOutside}
    >
      <div className={className}>{children}</div>
    </div>
  )
}
