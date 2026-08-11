import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useUIStore } from '@/store/useUIStore'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useProjectsStore } from '@/store/useProjectsStore'
import { searchNodesInMap, type SearchResult } from './NodeSearchDialog'
import { Search, X, FileText, Box } from 'lucide-react'
import { Z_INDEX } from '@/constants'

export function SearchPanel() {
  const { searchOpen, setSearchOpen } = useUIStore()
  const canvases = useProjectsStore((s) => s.canvases)
  const nodes = useCanvasStore((s) => s.nodes)
  const setZoom = useCanvasStore((s) => s.setZoom)
  const setPan = useCanvasStore((s) => s.setPan)
  const setSelectedIds = useCanvasStore((s) => s.setSelectedIds)
  const navigate = useNavigate()
  const [query, setQuery] = useState('')

  const trimmedQuery = query.trim().toLowerCase()

  // 全局搜索:当前项目下的画布名
  const canvasResults = useMemo(() => {
    if (!trimmedQuery) return []
    return canvases.filter((c) => (c.name || '').toLowerCase().includes(trimmedQuery))
  }, [trimmedQuery, canvases])

  // 画布内搜索:复用 NodeSearchDialog 的节点搜索逻辑(标题/内容全词匹配)
  const nodeResults = useMemo(() => searchNodesInMap(nodes, query), [nodes, query])

  // 关闭时统一清理查询/结果/节点高亮(与 NodeSearchDialog 一致)
  useEffect(() => {
    if (searchOpen) return
    setQuery('')
    window.dispatchEvent(
      new CustomEvent('nodeSearchHighlight', { detail: { nodeId: null, keywords: [] } })
    )
  }, [searchOpen])

  // 输入变化时同步节点高亮(复用既有 nodeSearchHighlight 事件)
  // m-1: 批量协议——单次事件携带全部匹配 nodeId(NodeItem 端按集合判断),
  // 避免逐条派发时后一个事件清除前一个、只剩最后一个节点高亮;有查询词但
  // 零匹配时同样必须派发清除事件,否则旧高亮残留与"未找到匹配"空态矛盾。
  useEffect(() => {
    const keywords = trimmedQuery.split(/\s+/).filter((k) => k.length > 0)
    const dispatchClear = () =>
      window.dispatchEvent(
        new CustomEvent('nodeSearchHighlight', { detail: { nodeId: null, keywords: [] } })
      )
    if (keywords.length === 0 || nodeResults.length === 0) {
      dispatchClear()
      return
    }
    window.dispatchEvent(
      new CustomEvent('nodeSearchHighlight', {
        detail: { nodeIds: nodeResults.map((r) => r.nodeId), keywords },
      })
    )
  }, [trimmedQuery, nodeResults])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') {
        e.preventDefault()
        setSearchOpen(!searchOpen)
      }

      if (searchOpen && e.key === 'Escape') {
        setSearchOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [searchOpen, setSearchOpen])

  // 节点结果跳转:与 NodeSearchDialog.jumpToNode 一致(复位缩放 + 平移居中 + 选中 + 高亮)
  const jumpToNode = useCallback(
    (result: SearchResult) => {
      const node = result.node
      const nodeCenterX = node.x + node.width / 2
      const nodeCenterY = node.y + node.height / 2

      const canvasContainer = document.querySelector('[data-canvas-container]') as HTMLElement | null
      const width = canvasContainer?.clientWidth ?? window.innerWidth
      const height = canvasContainer?.clientHeight ?? window.innerHeight

      setZoom(1)
      setPan(width / 2 - nodeCenterX, height / 2 - nodeCenterY)
      setSelectedIds([node.id])

      window.dispatchEvent(
        new CustomEvent('nodeSearchHighlight', {
          detail: { nodeId: node.id, keywords: result.matchedKeywords },
        })
      )
    },
    [setZoom, setPan, setSelectedIds]
  )

  const jumpToCanvas = useCallback(
    (canvasId: number) => {
      setSearchOpen(false)
      navigate('/canvas/' + canvasId)
    },
    [navigate, setSearchOpen]
  )

  if (!searchOpen) return null

  const hasQuery = trimmedQuery.length > 0
  const hasResults = canvasResults.length > 0 || nodeResults.length > 0

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-start justify-center pt-[15vh]"
      style={{ zIndex: Z_INDEX.SEARCH_PANEL }}
      onClick={() => setSearchOpen(false)}
    >
      <div
        className="w-full max-w-2xl bg-white dark:bg-gray-800 rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <Search className="w-5 h-5 text-gray-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search across all canvases..."
            className="flex-1 bg-transparent border-0 outline-none text-gray-900 dark:text-white placeholder-gray-500"
            autoFocus
          />
          <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            <kbd className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700 rounded">Ctrl+Shift+F</kbd>
          </div>
          <button
            onClick={() => setSearchOpen(false)}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="max-h-96 overflow-y-auto custom-scrollbar">
          {!hasQuery ? (
            <div className="p-8 text-center text-gray-500 dark:text-gray-400">
              <Search className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>Search for nodes, canvases, and more</p>
              <p className="text-sm mt-2">Type to start searching</p>
            </div>
          ) : !hasResults ? (
            <div className="p-4 text-center text-gray-500 dark:text-gray-400">
              未找到匹配的画布或节点
            </div>
          ) : (
            <div className="p-2">
              {canvasResults.length > 0 && (
                <div className="mb-2">
                  <div className="px-3 py-1.5 text-xs font-medium text-gray-400 dark:text-gray-500 uppercase">
                    画布 ({canvasResults.length})
                  </div>
                  {canvasResults.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => jumpToCanvas(c.id)}
                      className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-left"
                    >
                      <FileText className="w-4 h-4 text-gray-400 flex-shrink-0" />
                      <span className="text-sm text-gray-700 dark:text-gray-200 truncate">
                        {c.name}
                      </span>
                      <span className="ml-auto text-xs text-gray-400 flex-shrink-0">画布</span>
                    </button>
                  ))}
                </div>
              )}

              {nodeResults.length > 0 && (
                <div className="mb-2">
                  <div className="px-3 py-1.5 text-xs font-medium text-gray-400 dark:text-gray-500 uppercase">
                    节点 ({nodeResults.length})
                  </div>
                  {nodeResults.map((result) => (
                    <button
                      key={result.nodeId}
                      onClick={() => jumpToNode(result)}
                      className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-left"
                    >
                      <Box className="w-4 h-4 text-gray-400 flex-shrink-0" />
                      <span className="text-sm text-gray-700 dark:text-gray-200 truncate">
                        {result.node.title && result.node.title.trim()
                          ? result.node.title.trim()
                          : '未命名节点'}
                      </span>
                      <span className="ml-auto text-xs text-gray-400 flex-shrink-0">节点</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
