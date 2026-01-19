import { useEffect, useState, ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface PortalProps {
  children: ReactNode
  container?: HTMLElement | null
  className?: string
}

export function Portal({ children, container, className = '' }: PortalProps) {
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null)

  useEffect(() => {
    // 如果提供了容器，直接使用
    if (container) {
      setPortalContainer(container)
      return
    }

    // 否则创建一个默认容器
    const defaultContainer = document.createElement('div')
    defaultContainer.className = className
    document.body.appendChild(defaultContainer)
    setPortalContainer(defaultContainer)

    // 清理函数
    return () => {
      if (defaultContainer.parentNode) {
        defaultContainer.parentNode.removeChild(defaultContainer)
      }
    }
  }, [container, className])

  if (!portalContainer) {
    return null
  }

  return createPortal(children, portalContainer)
}
