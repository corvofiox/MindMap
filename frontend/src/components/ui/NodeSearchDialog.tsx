import { useState, useCallback, useEffect, useRef } from 'react'
import { Search, X, GripVertical, ChevronUp, ChevronDown } from 'lucide-react'
import { useUIStore } from '@/store/useUIStore'
import { useCanvasStore } from '@/store/useCanvasStore'
import { Z_INDEX } from '@/constants'
import type { Node } from '@/types'
import clsx from 'clsx'

interface SearchResult {
  nodeId: string
  node: Node
  matchedFields: ('title' | 'content')[]
  matchedKeywords: string[]
}

interface DragState {
  isDragging: boolean
  startX: number
  startY: number
  startLeft: number
  startTop: number
}

export function NodeSearchDialog() {
  const { nodeSearchOpen, setNodeSearchOpen } = useUIStore()
  const { nodes, setZoom, setPan, setSelectedIds } = useCanvasStore()

  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [currentIndex, setCurrentIndex] = useState(-1)
  const [position, setPosition] = useState({ left: 100, top: 100 })
  const [dragState, setDragState] = useState<DragState>({
    isDragging: false,
    startX: 0,
    startY: 0,
    startLeft: 0,
    startTop: 0,
  })

  const dialogRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const resultsListRef = useRef<HTMLDivElement>(null)

  // 关闭时统一清理查询/结果/高亮状态（D19：Escape、Ctrl+F 切换等所有关闭路径）
  useEffect(() => {
    if (nodeSearchOpen) return

    setQuery('')
    setSearchResults([])
    setCurrentIndex(-1)

    const clearEvent = new CustomEvent('nodeSearchHighlight', {
      detail: {
        nodeId: null,
        keywords: [],
      },
    })
    window.dispatchEvent(clearEvent)
  }, [nodeSearchOpen])

  const searchNodes = useCallback((searchQuery: string): SearchResult[] => {
    if (!searchQuery.trim()) return []

    const keywords = searchQuery.trim().toLowerCase().split(/\s+/).filter(k => k.length > 0)
    if (keywords.length === 0) return []

    const results: SearchResult[] = []

    nodes.forEach((node, nodeId) => {
      const titleLower = (node.title || '').toLowerCase()
      const contentLower = (node.content || '').toLowerCase()

      const matchedFields: ('title' | 'content')[] = []
      const matchedKeywords: string[] = []

      const titleMatches: string[] = []
      const contentMatches: string[] = []

      keywords.forEach(keyword => {
        const inTitle = titleLower.includes(keyword)
        const inContent = contentLower.includes(keyword)

        if (inTitle || inContent) {
          if (inTitle) titleMatches.push(keyword)
          if (inContent) contentMatches.push(keyword)
          matchedKeywords.push(keyword)
        }
      })

      if (matchedKeywords.length === keywords.length) {
        if (titleMatches.length === keywords.length) {
          matchedFields.push('title')
        }
        if (contentMatches.length === keywords.length) {
          matchedFields.push('content')
        }

        if (matchedFields.length > 0) {
          results.push({
            nodeId,
            node,
            matchedFields,
            matchedKeywords,
          })
        }
      }
    })

    return results
  }, [nodes])

  useEffect(() => {
    if (query.trim()) {
      const results = searchNodes(query)
      setSearchResults(results)
      setCurrentIndex(-1)

      const keywords = query.trim().toLowerCase().split(/\s+/).filter(k => k.length > 0)
      results.forEach(result => {
        const highlightEvent = new CustomEvent('nodeSearchHighlight', {
          detail: {
            nodeId: result.nodeId,
            keywords: keywords,
          },
        })
        window.dispatchEvent(highlightEvent)
      })
    } else {
      setSearchResults([])
      setCurrentIndex(-1)
      const clearEvent = new CustomEvent('nodeSearchHighlight', {
        detail: {
          nodeId: null,
          keywords: [],
        },
      })
      window.dispatchEvent(clearEvent)
    }
  }, [query, searchNodes])

  useEffect(() => {
    if (resultsListRef.current && currentIndex >= 0) {
      const selectedElement = resultsListRef.current.querySelector(`[data-index="${currentIndex}"]`)
      if (selectedElement) {
        selectedElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }
    }
  }, [currentIndex])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault()
        setNodeSearchOpen(!nodeSearchOpen)
      }

      if (nodeSearchOpen && e.key === 'Escape') {
        setNodeSearchOpen(false)
      }

      if (nodeSearchOpen && searchResults.length > 0) {
        if (e.key === 'Enter') {
          e.preventDefault()
          if (e.shiftKey) {
            handleFindPrev()
          } else {
            handleFindNext()
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [nodeSearchOpen, setNodeSearchOpen, searchResults.length])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragState.isDragging) return

      const deltaX = e.clientX - dragState.startX
      const deltaY = e.clientY - dragState.startY

      const newLeft = Math.max(0, Math.min(window.innerWidth - 320, dragState.startLeft + deltaX))
      const newTop = Math.max(0, Math.min(window.innerHeight - 200, dragState.startTop + deltaY))

      setPosition({ left: newLeft, top: newTop })
    }

    const handleMouseUp = () => {
      setDragState(prev => ({ ...prev, isDragging: false }))
    }

    if (dragState.isDragging) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [dragState])

  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault()
    setDragState({
      isDragging: true,
      startX: e.clientX,
      startY: e.clientY,
      startLeft: position.left,
      startTop: position.top,
    })
  }

  const jumpToNode = useCallback((index: number) => {
    if (index < 0 || index >= searchResults.length) return

    setCurrentIndex(index)

    const result = searchResults[index]
    const node = result.node

    const nodeCenterX = node.x + node.width / 2
    const nodeCenterY = node.y + node.height / 2

    const canvasContainer = document.querySelector('[data-canvas-container]') as HTMLElement
    const width = canvasContainer?.clientWidth || window.innerWidth
    const height = canvasContainer?.clientHeight || window.innerHeight

    const newPanX = width / 2 - nodeCenterX
    const newPanY = height / 2 - nodeCenterY

    setZoom(1)
    setPan(newPanX, newPanY)
    setSelectedIds([node.id])

    const highlightEvent = new CustomEvent('nodeSearchHighlight', {
      detail: {
        nodeId: node.id,
        keywords: result.matchedKeywords,
      },
    })
    window.dispatchEvent(highlightEvent)
  }, [searchResults, setZoom, setPan, setSelectedIds])

  const handleFindNext = useCallback(() => {
    if (searchResults.length === 0) return
    const nextIndex = (currentIndex + 1) % searchResults.length
    jumpToNode(nextIndex)
  }, [searchResults.length, currentIndex, jumpToNode])

  const handleFindPrev = useCallback(() => {
    if (searchResults.length === 0) return
    const prevIndex = currentIndex <= 0 ? searchResults.length - 1 : currentIndex - 1
    jumpToNode(prevIndex)
  }, [searchResults.length, currentIndex, jumpToNode])

  const handleResultClick = useCallback((index: number) => {
    jumpToNode(index)
  }, [jumpToNode])

  const handleClose = () => {
    // 状态清理统一由 nodeSearchOpen 变化的 effect 完成（D19）
    setNodeSearchOpen(false)
  }

  const getNodeTitle = (node: Node): string => {
    if (node.title && node.title.trim()) {
      return node.title.trim()
    }
    return '未命名节点'
  }

  if (!nodeSearchOpen) return null

  return (
    <div
      ref={dialogRef}
      className="fixed bg-white dark:bg-gray-800 rounded-xl shadow-2xl overflow-hidden flex flex-col"
      style={{
        left: position.left,
        top: position.top,
        width: 320,
        maxHeight: 400,
        zIndex: Z_INDEX.DIALOG,
      }}
    >
      <div
        ref={headerRef}
        className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-gray-700 cursor-move select-none flex-shrink-0"
        onMouseDown={handleDragStart}
      >
        <GripVertical className="w-4 h-4 text-gray-400" />
        <Search className="w-4 h-4 text-gray-500 dark:text-gray-400" />
        <span className="text-sm font-medium text-gray-700 dark:text-gray-200">搜索节点</span>
        <div className="flex-1" />
        <button
          onClick={handleClose}
          className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-4 flex-shrink-0">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="输入关键字搜索..."
            className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
            autoFocus
          />
        </div>

        {searchResults.length > 0 && (
          <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            找到 {searchResults.length} 个匹配节点
            {currentIndex >= 0 && ` (当前第 ${currentIndex + 1} 个)`}
          </div>
        )}

        {query && searchResults.length === 0 && (
          <div className="mt-2 text-xs text-gray-500 dark:text-gray-400 text-center">
            未找到匹配的节点
          </div>
        )}
      </div>

      {searchResults.length > 0 && (
        <div
          ref={resultsListRef}
          className="flex-1 overflow-y-auto px-4 pb-2 min-h-0"
          style={{ maxHeight: 180 }}
        >
          <div className="flex flex-wrap gap-2">
            {searchResults.map((result, index) => (
              <button
                key={result.nodeId}
                data-index={index}
                onClick={() => handleResultClick(index)}
                className={clsx(
                  'inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-all',
                  index === currentIndex
                    ? 'bg-blue-500 text-white border border-blue-500 shadow-sm'
                    : 'bg-white text-gray-700 border border-gray-200 hover:border-gray-300 hover:shadow-sm'
                )}
                title={getNodeTitle(result.node)}
              >
                <span className={clsx(
                  'flex-shrink-0 w-4 h-4 flex items-center justify-center rounded text-[10px]',
                  index === currentIndex
                    ? 'bg-white/20 text-white'
                    : 'bg-gray-100 text-gray-500'
                )}>
                  {index + 1}
                </span>
                <span className="truncate max-w-[120px]">{getNodeTitle(result.node)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2 flex-shrink-0">
        <button
          onClick={handleClose}
          className="px-4 py-1.5 text-sm font-medium rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
        >
          取消
        </button>
        <button
          onClick={handleFindPrev}
          disabled={searchResults.length === 0}
          className={clsx(
            'px-3 py-1.5 text-sm font-medium rounded-lg transition-colors flex items-center gap-1',
            searchResults.length > 0
              ? 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
              : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed'
          )}
          title="查找上一个 (Shift+Enter)"
        >
          <ChevronUp className="w-4 h-4" />
          上一个
        </button>
        <button
          onClick={handleFindNext}
          disabled={searchResults.length === 0}
          className={clsx(
            'px-3 py-1.5 text-sm font-medium rounded-lg transition-colors flex items-center gap-1',
            searchResults.length > 0
              ? 'bg-blue-500 hover:bg-blue-600 text-white'
              : 'bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 cursor-not-allowed'
          )}
          title="查找下一个 (Enter)"
        >
          下一个
          <ChevronDown className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
