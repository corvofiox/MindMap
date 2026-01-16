import { Component, ErrorInfo, ReactNode } from 'react'
import { debugLogger } from '@/utils/debugLogger'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error?: Error
}

export class ContextMenuErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false
  }

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    debugLogger.error('context-menu', 'Context menu render error', {
      error: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack
    })
    debugLogger.saveToServer('context-menu')
  }

  public render() {
    if (this.state.hasError) {
      debugLogger.error('context-menu', 'Error boundary triggered', {
        error: this.state.error?.message,
      })
      return this.props.fallback || (
        <div className="fixed z-50 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 p-4 min-w-[200px]">
          <div className="text-sm text-red-600 dark:text-red-400">
            右键菜单渲染出错
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            请按 Ctrl+Shift+L 保存调试日志
          </div>
          <button
            onClick={() => {
              debugLogger.saveToServer('context-menu')
              this.setState({ hasError: false })
            }}
            className="mt-2 px-3 py-1 text-xs bg-gray-100 dark:bg-gray-700 rounded hover:bg-gray-200 dark:hover:bg-gray-600"
          >
            重试并保存日志
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
