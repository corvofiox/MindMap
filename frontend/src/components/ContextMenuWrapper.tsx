import React, { useRef, useEffect, useState } from 'react'

interface ContextMenuWrapperProps {
  x: number
  y: number
  onClose: () => void
  children: React.ReactNode
}

export const ContextMenuWrapper: React.FC<ContextMenuWrapperProps> = ({
  x,
  y,
  onClose,
  children,
}) => {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  useEffect(() => {
    const adjustPosition = () => {
      const menu = menuRef.current
      if (!menu) return

      const menuRect = menu.getBoundingClientRect()
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const padding = 10

      let adjustedLeft = x
      let adjustedTop = y

      // Adjust horizontal position
      if (x + menuRect.width > viewportWidth - padding) {
        adjustedLeft = viewportWidth - menuRect.width - padding
      }
      if (adjustedLeft < padding) {
        adjustedLeft = padding
      }

      // Adjust vertical position
      if (y + menuRect.height > viewportHeight - padding) {
        adjustedTop = viewportHeight - menuRect.height - padding
      }
      if (adjustedTop < padding) {
        adjustedTop = padding
      }

      setPosition({ left: adjustedLeft, top: adjustedTop })
    }

    // Use setTimeout to ensure the menu has finished rendering
    const timeoutId = setTimeout(adjustPosition, 0)
    return () => clearTimeout(timeoutId)
  }, [x, y])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (e.button === 0) {
        if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
          onClose()
        }
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  return (
    <>
      <div
        ref={menuRef}
        className="fixed bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1 z-50 min-w-40"
        style={{
          left: position.left,
          top: position.top,
        }}
      >
        {children}
      </div>
    </>
  )
}
