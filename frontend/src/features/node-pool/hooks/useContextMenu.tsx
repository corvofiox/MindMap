/**
 * useContextMenu Hook
 *
 * Provides common functionality for context menus.
 * Handles position adjustment, click outside detection, and keyboard navigation.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'

interface UseContextMenuOptions {
  initialPosition: { x: number; y: number }
  onClose: () => void
}

interface UseContextMenuReturn {
  isPositioned: boolean
  finalPosition: { x: number; y: number }
  menuRef: React.RefObject<HTMLDivElement>
}

export function useContextMenu({ initialPosition, onClose }: UseContextMenuOptions): UseContextMenuReturn {
  const [isPositioned, setIsPositioned] = useState(false)
  const [finalPosition, setFinalPosition] = useState(initialPosition)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const adjustPosition = () => {
      if (!menuRef.current) return

      const rect = menuRef.current.getBoundingClientRect()
      const padding = 10
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight

      let x = initialPosition.x
      let y = initialPosition.y

      if (x + rect.width > viewportWidth - padding) {
        x = Math.max(padding, viewportWidth - rect.width - padding)
      }

      if (y + rect.height > viewportHeight - padding) {
        y = Math.max(padding, viewportHeight - rect.height - padding)
      }

      setFinalPosition({ x, y })
      setIsPositioned(true)
    }

    const rafId = requestAnimationFrame(adjustPosition)
    return () => cancelAnimationFrame(rafId)
  }, [initialPosition])

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

  return { isPositioned, finalPosition, menuRef }
}

interface MenuItemProps {
  icon: React.ComponentType<{ className?: string }>
  label: string
  onClick: () => void
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  rightElement?: React.ReactNode
}

export function MenuItem({ icon: Icon, label, onClick, shortcut, disabled = false, danger = false, rightElement }: MenuItemProps) {
  return (
    <button
      className={`
        w-full flex items-center gap-2 px-3 py-2 text-sm rounded
        ${disabled
          ? 'opacity-40 cursor-not-allowed'
          : danger
            ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30'
            : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
        }
      `}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon className="w-3 h-3" />
      {label}
      {shortcut && (
        <span className="text-xs text-gray-400 dark:text-gray-500">{shortcut}</span>
      )}
      {rightElement}
    </button>
  )
}

export function MenuDivider() {
  return <div className="h-px bg-gray-200 dark:border-gray-700 border-t border-gray-200 dark:border-gray-700 my-1" />
}
