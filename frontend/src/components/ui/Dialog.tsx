import { useEffect, ReactNode } from 'react'
import { X } from 'lucide-react'
import clsx from 'clsx'
import { Z_INDEX } from '@/constants'

interface DialogProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  footer?: ReactNode
  zIndex?: number
  className?: string
  contentClassName?: string
  showCloseButton?: boolean
  closeOnEscape?: boolean
  closeOnOutsideClick?: boolean
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  zIndex = Z_INDEX.DIALOG,
  className = '',
  contentClassName = '',
  showCloseButton = true,
  closeOnEscape = true,
  closeOnOutsideClick = true,
}: DialogProps) {
  useEffect(() => {
    if (!open) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (closeOnEscape && e.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, closeOnEscape, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center"
      onClick={(_e) => {
        if (closeOnOutsideClick) {
          onClose()
        }
      }}
      style={{ zIndex }}
    >
      <div
        className={clsx(
          'w-full max-w-2xl bg-white dark:bg-gray-800 rounded-xl shadow-2xl',
          className
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        {title && (
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <div className="flex items-center gap-2">
              {title}
            </div>

            {showCloseButton && (
              <button
                onClick={onClose}
                className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400 transition-colors"
                aria-label="关闭"
              >
                <X className="w-5 h-5" />
              </button>
            )}
          </div>
        )}

        {/* Content */}
        <div className={clsx('p-6', contentClassName)}>
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

export interface DialogActionProps {
  children: ReactNode
  onClick: () => void
  variant?: 'primary' | 'secondary' | 'danger'
  disabled?: boolean
  className?: string
}

export function DialogAction({
  children,
  onClick,
  variant = 'primary',
  disabled = false,
  className = '',
}: DialogActionProps) {
  const variantClasses = {
    primary: 'bg-blue-600 hover:bg-blue-700 text-white',
    secondary: 'bg-gray-200 hover:bg-gray-300 text-gray-800 dark:bg-gray-700 dark:hover:bg-gray-600 dark:text-gray-200',
    danger: 'bg-red-600 hover:bg-red-700 text-white',
  }

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'px-4 py-2 font-medium rounded-lg transition-colors',
        variantClasses[variant],
        disabled && 'opacity-50 cursor-not-allowed',
        className
      )}
    >
      {children}
    </button>
  )
}
