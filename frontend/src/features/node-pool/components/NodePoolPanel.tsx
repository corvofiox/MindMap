/**
 * NodePoolPanel Component - New Implementation
 *
 * Main container for the node pool feature.
 * This is a complete rewrite using the new architecture.
 *
 * Key improvements:
 * - Modular component structure
 * - Type-safe with no 'any' types
 * - Optimized performance with Map lookups
 */

import { useState, useCallback, useMemo, useEffect, Fragment } from 'react'
import {
  Plus,
  Search,
  FolderPlus,
  SortAsc,
  SortDesc,
  X,
  FileUp,
} from 'lucide-react'
import { clsx } from 'clsx'
import { useProjectsStore } from '@/store/useProjectsStore'
import { useUIStore } from '@/store/useUIStore'
import { useAuthStore } from '@/store/useAuthStore'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useNodePoolStore } from '../stores/useNodePoolStore'
import { useNodePoolSort, useFolderTree } from '../hooks/useNodePoolSort'
import { FolderItem } from './FolderItem'
import { NodeCardItem } from './NodeCardItem'
import { FolderContextMenu } from './FolderContextMenu'
import { NodeCardContextMenu } from './NodeCardContextMenu'
import { ContextMenuErrorBoundary } from './ContextMenuErrorBoundary'
import { Z_INDEX } from '@/constants'
import type { NodePoolSortOption, NodePoolSortOrder, Node } from '@/types'
import type { NodeCard, NodePoolFolder } from '../types/node-pool'

/**
 * NodePoolPanel component props
 */
interface NodePoolPanelProps {
  open: boolean;
}

/**
 * Main node pool panel component
 */
export function NodePoolPanel({ open }: NodePoolPanelProps) {
  const { currentProject } = useProjectsStore()
  const { user } = useAuthStore()
  const { selectedIds, addNode } = useCanvasStore()
  const { addToast, setDragGhost } = useUIStore()

  // Node pool store - 使用selector确保响应式更新
  const cardsMap = useNodePoolStore(state => state.cardsMap)
  const foldersMap = useNodePoolStore(state => state.foldersMap)
  const pendingCardIds = useNodePoolStore(state => state.pendingCardIds)
  const { updateCard, updateFolder, removeCard, toggleFolderCollapsed, addFolder, addCard, loadNodePool } = useNodePoolStore()

  // Local state
  const [searchQuery, setSearchQuery] = useState('')
  const [sortBy, setSortBy] = useState<NodePoolSortOption>('createdAt')
  const [sortOrder, setSortOrder] = useState<NodePoolSortOrder>('desc')
  const [showNewFolderInput, setShowNewFolderInput] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [previewCardId, setPreviewCardId] = useState<number | null>(null)
  const [folderContextMenu, setFolderContextMenu] = useState<{ folder: NodePoolFolder; position: { x: number; y: number } } | null>(null)
  const [cardContextMenu, setCardContextMenu] = useState<{ card: NodeCard; position: { x: number; y: number } } | null>(null)
  const [editingCardId, setEditingCardId] = useState<number | null>(null)
  const [editingFolderId, setEditingFolderId] = useState<number | null>(null)
  const [isRootDragOver, setIsRootDragOver] = useState(false)
  const [isDragOverFolder, setIsDragOverFolder] = useState(false)

  // Sort functionality
  useNodePoolSort({ sortBy, sortOrder })

  // Load node pool data when project changes
  useEffect(() => {
    if (currentProject) {
      loadNodePool(currentProject.id)
    }
  }, [currentProject, loadNodePool])

  // Handle add selected node to pool
  const handleAddToPool = useCallback(async () => {
    if (selectedIds.length === 0) {
      addToast({ type: 'warning', title: '未选择节点', message: '请选择一个节点添加到节点池' })
      return
    }

    const nodeId = selectedIds[0]
    const nodes = useCanvasStore.getState().nodes
    const node = nodes.get(nodeId)
    if (!node || !currentProject) return

    try {
      await addCard(currentProject.id, {
        projectId: currentProject.id,
        name: node.title || node.content || '未命名',
        content: JSON.stringify(node),
        type: node.type || 'text',
        color: node.color,
        tags: null,
        createdBy: user?.id || 1,
        sortOrder: 0,
        thumbnail: node.type === 'image' ? (node as any).imageUrl : undefined,
      })

      addToast({ type: 'success', title: '已添加到节点池', message: '节点已添加到节点池' })
    } catch (error) {
      addToast({ type: 'error', title: '添加失败', message: error instanceof Error ? error.message : '未知错误' })
    }
  }, [selectedIds, currentProject, addToast, addCard])

  // Handle use card from pool
  const handleUseCard = useCallback(async (card: NodeCard) => {
    try {
      const { useCard: poolUseCard } = useNodePoolStore.getState()

      await poolUseCard(card, (node) => {
        addNode(node)
      })

      addToast({ type: 'success', title: '节点已取出', message: '卡片已从池中取出到画布' })
    } catch (error) {
      addToast({ type: 'error', title: '使用节点失败', message: error instanceof Error ? error.message : '未知错误' })
    }
  }, [addNode, addToast])

  // Handle remove card
  const handleRemoveCard = useCallback(async (id: number) => {
    try {
      await removeCard(id)
      addToast({ type: 'success', title: '已移除', message: '节点卡片已移除' })
    } catch (error) {
      addToast({ type: 'error', title: '移除失败', message: error instanceof Error ? error.message : '未知错误' })
    }
  }, [removeCard, addToast])

  // Handle save card name
  const handleSaveCardName = useCallback(async (id: number, name: string) => {
    try {
      await updateCard(id, { name })
      addToast({ type: 'success', title: '已更新', message: '卡片名称已更新' })
    } catch (error) {
      addToast({ type: 'error', title: '更新失败', message: error instanceof Error ? error.message : '未知错误' })
    }
  }, [updateCard, addToast])

  // Handle sort change
  const handleSortChange = useCallback((newSortBy: NodePoolSortOption) => {
    if (sortBy === newSortBy) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(newSortBy)
      setSortOrder('desc')
    }
  }, [sortBy, sortOrder])

  // Handle folder collapse toggle
  const handleToggleFolder = useCallback((id: number) => {
    toggleFolderCollapsed(id)
  }, [toggleFolderCollapsed])

  // Handle folder context menu
  const handleFolderContextMenu = useCallback((e: React.MouseEvent, folder: NodePoolFolder) => {
    e.preventDefault()
    setFolderContextMenu({
      folder,
      position: { x: e.clientX, y: e.clientY }
    })
  }, [setFolderContextMenu])

  // Handle card context menu
  const handleCardContextMenu = useCallback((e: React.MouseEvent, card: NodeCard) => {
    e.preventDefault()
    setCardContextMenu({
      card,
      position: { x: e.clientX, y: e.clientY }
    })
  }, [setCardContextMenu])

  // Handle rename folder
  const handleRenameFolder = useCallback((folder: NodePoolFolder) => {
    setEditingFolderId(folder.id)
    setFolderContextMenu(null)
  }, [])

  // Handle start folder edit
  const handleStartFolderEdit = useCallback((folder: NodePoolFolder) => {
    setEditingFolderId(folder.id)
  }, [])

  // Handle save folder name
  const handleSaveFolderName = useCallback(async (folderId: number, name: string) => {
    if (!name.trim()) {
      addToast({ type: 'warning', title: '名称不能为空', message: '请输入文件夹名称' })
      return
    }

    const folder = foldersMap.get(folderId)
    if (name === folder?.name) {
      setEditingFolderId(null)
      return
    }

    try {
      await updateFolder(folderId, { name: name.trim() })
      addToast({ type: 'success', title: '已重命名', message: '文件夹名称已更新' })
      setEditingFolderId(null)
    } catch (error) {
      addToast({ type: 'error', title: '重命名失败', message: error instanceof Error ? error.message : '未知错误' })
    }
  }, [updateFolder, addToast, foldersMap])

  // Handle cancel folder edit
  const handleCancelFolderEdit = useCallback(() => {
    setEditingFolderId(null)
  }, [])

  // Handle rename card
  const handleRenameCard = useCallback((card: NodeCard) => {
    setEditingCardId(card.id)
  }, [])

  // Handle create folder
  const handleCreateFolder = useCallback(async () => {
    const name = newFolderName.trim()
    if (!name) {
      addToast({ type: 'warning', title: '名称不能为空', message: '请输入文件夹名称' })
      return
    }

    if (!currentProject) {
      addToast({ type: 'error', title: '项目未加载', message: '请先选择一个项目' })
      return
    }

    try {
      await addFolder({
        projectId: currentProject.id,
        name,
        parentId: null,
        sortOrder: 0,
        collapsed: true,
      })

      setNewFolderName('')
      setShowNewFolderInput(false)
      addToast({ type: 'success', title: '创建成功', message: '文件夹已创建' })
    } catch (error) {
      addToast({ type: 'error', title: '创建失败', message: error instanceof Error ? error.message : '未知错误' })
    }
  }, [newFolderName, currentProject, addFolder, addToast])

  // Handle move card to folder
  const handleMoveCardToFolder = useCallback((card: NodeCard, folderId: number | null) => {
    const currentCardsMap = useNodePoolStore.getState().cardsMap
    if (!currentCardsMap.has(card.id)) {
      return
    }
    updateCard(card.id, { folderId })
  }, [updateCard])

  // Handle drop on folder
  const handleFolderDrop = useCallback((e: React.DragEvent, folder: NodePoolFolder) => {
    e.preventDefault()
    e.stopPropagation()

    const cardData = e.dataTransfer.getData('application/nodepool-card')
    const canvasNodeData = e.dataTransfer.getData('application/canvas-node')

    if (cardData) {
      try {
        const card = JSON.parse(cardData) as NodeCard
        handleMoveCardToFolder(card, folder.id)
      } catch (error) {
        addToast({ type: 'error', title: '解析失败', message: '卡片数据格式错误' })
      }
    } else if (canvasNodeData && currentProject) {
      // 添加新卡片到节点池
      try {
        const node = JSON.parse(canvasNodeData) as unknown as Node
        addCard(currentProject.id, {
          projectId: currentProject.id,
          name: node.title || node.content || '未命名',
          content: JSON.stringify(node),
          type: node.type || 'text',
          color: node.color,
          tags: null,
          createdBy: user?.id || 1,
          sortOrder: 0,
          folderId: folder.id,
          thumbnail: node.type === 'image' ? (node as any).imageUrl : undefined,
        }).then(() => {
          addToast({ type: 'success', title: '已添加到节点池', message: '节点已添加到节点池' })
        }).catch(error => {
          addToast({ type: 'error', title: '添加失败', message: error instanceof Error ? error.message : '未知错误' })
        })
      } catch (error) {
        addToast({ type: 'error', title: '解析失败', message: '节点数据格式错误' })
      }
    }
  }, [handleMoveCardToFolder, addToast, currentProject, addCard, user])

  // Handle drop on root (move to root folder)
  const handleRootDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()

    setIsRootDragOver(false)
    const cardData = e.dataTransfer.getData('application/nodepool-card')
    const canvasNodeData = e.dataTransfer.getData('application/canvas-node')

    if (cardData) {
      try {
        const card = JSON.parse(cardData) as NodeCard
        handleMoveCardToFolder(card, null)
      } catch (error) {
        addToast({ type: 'error', title: '解析失败', message: '卡片数据格式错误' })
      }
    } else if (canvasNodeData && currentProject) {
      // 添加新卡片到节点池
      try {
        const node = JSON.parse(canvasNodeData) as unknown as Node
        addCard(currentProject.id, {
          projectId: currentProject.id,
          name: node.title || node.content || '未命名',
          content: JSON.stringify(node),
          type: node.type || 'text',
          color: node.color,
          tags: null,
          createdBy: user?.id || 1,
          sortOrder: 0,
          folderId: null,
          thumbnail: node.type === 'image' ? (node as any).imageUrl : undefined,
        }).then(() => {
          addToast({ type: 'success', title: '已添加到节点池', message: '节点已添加到节点池' })
        }).catch(error => {
          addToast({ type: 'error', title: '添加失败', message: error instanceof Error ? error.message : '未知错误' })
        })
      } catch (error) {
        addToast({ type: 'error', title: '解析失败', message: '节点数据格式错误' })
      }
    }
  }, [handleMoveCardToFolder, addToast, currentProject, addCard, user])

  // Handle drag over root
  const handleRootDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!isDragOverFolder) {
      setIsRootDragOver(true)
    }
  }, [isDragOverFolder])

  // Handle drag leave root
  const handleRootDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsRootDragOver(false)
  }, [])

  // Filter cards based on search - optimized with useMemo
  const filteredCardsByFolder = useMemo(() => {
    if (!searchQuery.trim()) {
      const result = new Map<number | null, NodeCard[]>()
      cardsMap.forEach((card) => {
        if ((card as any)._markedForDeletion) return
        // 只过滤临时卡片（负数id），真实卡片（正数id）不需要检查pendingCardIds
        if (card.id < 0 && !pendingCardIds.has(card.id)) return
        const folderId = card.folderId || null
        if (!result.has(folderId)) {
          result.set(folderId, [])
        }
        result.get(folderId)!.push(card)
      })
      return result
    }

    const searchTerms = searchQuery.trim().toLowerCase().split(/\s+/).filter(term => term.length > 0)
    const result = new Map<number | null, NodeCard[]>()

    cardsMap.forEach((card: NodeCard) => {
      if ((card as any)._markedForDeletion) return
      // 只过滤临时卡片（负数id），真实卡片（正数id）不需要检查pendingCardIds
      if (card.id < 0 && !pendingCardIds.has(card.id)) return

      const name = card.name.toLowerCase()
      let content = ''

      try {
        const nodeData = JSON.parse(card.content)
        content = (nodeData.content || nodeData.title || '').toLowerCase()
      } catch {
        content = card.content.toLowerCase()
      }

      const matches = searchTerms.every(term => name.includes(term) || content.includes(term))
      if (matches) {
        const folderId = card.folderId || null
        if (!result.has(folderId)) {
          result.set(folderId, [])
        }
        result.get(folderId)!.push(card)
      }
    })

    return result
  }, [cardsMap, pendingCardIds, searchQuery])

  // Get folders that have matching cards
  const filteredFolderIds = useMemo(() => {
    if (!searchQuery.trim()) {
      return new Set<number>(foldersMap.keys())
    }

    const folderIds = new Set<number>()
    filteredCardsByFolder.forEach((_, folderId) => {
      if (folderId !== null) {
        folderIds.add(folderId)
      }
    })
    return folderIds
  }, [foldersMap, filteredCardsByFolder, searchQuery])

  // Filter folder tree to only show folders with matching cards
  const filteredFolderTree = useMemo(() => {
    const buildFilteredTree = (parentId: number | null): (NodePoolFolder & { children?: NodePoolFolder[] })[] => {
      const folders = Array.from(foldersMap.values())
        .filter(folder => folder.parentId === parentId)
        .sort((a, b) => a.sortOrder - b.sortOrder)

      return folders
        .filter(folder => {
          if (searchQuery.trim()) {
            return filteredFolderIds.has(folder.id) || hasMatchingDescendant(folder.id)
          }
          return true
        })
        .map(folder => ({
          ...folder,
          children: buildFilteredTree(folder.id)
        }))
    }

    const hasMatchingDescendant = (folderId: number): boolean => {
      const childFolders = Array.from(foldersMap.values()).filter(f => f.parentId === folderId)
      return childFolders.some(child =>
        filteredFolderIds.has(child.id) || hasMatchingDescendant(child.id)
      )
    }

    return buildFilteredTree(null)
  }, [foldersMap, filteredFolderIds, searchQuery])

  // Calculate total matching cards count
  const totalMatchingCards = useMemo(() => {
    let count = 0
    filteredCardsByFolder.forEach(cards => count += cards.length)
    return count
  }, [filteredCardsByFolder])

  // Render folder with its contents
  const renderFolder = useCallback((folder: NodePoolFolder & { children?: NodePoolFolder[] }, level = 0) => {
    const cards = filteredCardsByFolder.get(folder.id) || []
    const children = (folder.children || []).filter(childFolder => {
      if (!searchQuery.trim()) return true
      const childCards = filteredCardsByFolder.get(childFolder.id) || []
      const grandChildren = (childFolder.children || []).some(gc => (filteredCardsByFolder.get(gc.id) || []).length > 0)
      return childCards.length > 0 || grandChildren
    })

    const hasContent = cards.length > 0 || children.length > 0

    return (
      <FolderItem
        key={folder.id}
        folder={folder}
        level={level}
        cards={cards}
        children={children}
        searchQuery={searchQuery}
        isDragOver={false}
        dragOverPosition={null}
        onToggle={handleToggleFolder}
        onContextMenu={handleFolderContextMenu}
        onCardContextMenu={handleCardContextMenu}
        previewCardId={previewCardId}
        onTogglePreview={setPreviewCardId}
        onDrop={handleFolderDrop}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOverFolder(true);
          setIsRootDragOver(false);
        }}
        onDragLeave={() => {
          setIsDragOverFolder(false);
        }}
        onStartEdit={handleStartFolderEdit}
        onSaveEdit={handleSaveFolderName}
        onCancelEdit={handleCancelFolderEdit}
        editingFolderId={editingFolderId}
        onUseCard={handleUseCard}
        onRemoveCard={handleRemoveCard}
        onSaveCardName={handleSaveCardName}
        editingCardId={editingCardId}
      />
    )
  }, [filteredCardsByFolder, handleToggleFolder, handleFolderContextMenu, handleCardContextMenu, previewCardId, handleFolderDrop, handleStartFolderEdit, handleSaveFolderName, handleCancelFolderEdit, editingFolderId, handleUseCard, handleRemoveCard, handleSaveCardName, editingCardId, searchQuery])

  return (
    <aside
      data-node-pool="true"
      className={`w-72 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 flex flex-col transition-all duration-200 fixed right-0 top-14 h-[calc(100vh-3.5rem)] ${open ? 'transform translate-x-0' : 'transform translate-x-full'}`}
      style={{ zIndex: Z_INDEX.NODE_POOL_PANEL }}
    >
      {/* Header */}
      <div className="h-12 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between px-4 flex-shrink-0">
        <h2 className="font-semibold text-gray-800 dark:text-white">节点池</h2>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowNewFolderInput(!showNewFolderInput)}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400"
            title="新建文件夹"
          >
            <FolderPlus className="w-4 h-4" />
          </button>
          <button
            onClick={handleAddToPool}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400"
            title="添加选中节点到池"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* New folder input */}
      {showNewFolderInput && (
        <div className="p-3 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
          <div className="flex gap-2 items-center">
            <input
              type="text"
              placeholder="文件夹名称..."
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              className="flex-1 min-w-0 px-2 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 border-0 rounded focus:ring-2 focus:ring-blue-500 text-gray-800 dark:text-white"
            />
            <button
              onClick={handleCreateFolder}
              className="flex-shrink-0 px-3 py-1.5 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 whitespace-nowrap"
            >
              创建
            </button>
            <button
              onClick={() => setShowNewFolderInput(false)}
              className="flex-shrink-0 p-1.5 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Search and Sort */}
      <div className="p-3 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <div className="relative mb-2">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="搜索节点..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm bg-gray-100 dark:bg-gray-700 border-0 rounded-lg focus:ring-2 focus:ring-blue-500 text-gray-800 dark:text-white placeholder-gray-500"
          />
        </div>

        {/* Sort buttons */}
        <div className="flex gap-1">
          <button
            onClick={() => handleSortChange('name')}
            className={clsx(
              'flex-1 px-2 py-1 text-xs rounded flex items-center justify-center gap-1',
              sortBy === 'name'
                ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
            )}
          >
            名称
            {sortBy === 'name' && (
              sortOrder === 'asc' ? <SortAsc className="w-3 h-3" /> : <SortDesc className="w-3 h-3" />
            )}
          </button>
          <button
            onClick={() => handleSortChange('createdAt')}
            className={clsx(
              'flex-1 px-2 py-1 text-xs rounded flex items-center justify-center gap-1',
              sortBy === 'createdAt'
                ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
            )}
          >
            创建时间
            {sortBy === 'createdAt' && (
              sortOrder === 'asc' ? <SortAsc className="w-3 h-3" /> : <SortDesc className="w-3 h-3" />
            )}
          </button>
        </div>
      </div>

      {/* Content */}
      <div
        className={clsx(
          'flex-1 overflow-y-auto custom-scrollbar p-3 transition-all duration-200',
          isRootDragOver && 'bg-blue-50 dark:bg-blue-900/20'
        )}
        style={isRootDragOver ? {
          border: '2px solid rgba(59, 130, 246, 0.5)',
          borderRadius: '8px'
        } : {}}
        onDragOver={handleRootDragOver}
        onDragLeave={handleRootDragLeave}
        onDrop={handleRootDrop}
      >
        {/* Render folder tree */}
        {filteredFolderTree.length === 0 && !searchQuery.trim() ? (
          <EmptyState onAddToPool={handleAddToPool} />
        ) : filteredFolderTree.length === 0 && searchQuery.trim() ? (
          <div className="text-center py-8 text-gray-500 dark:text-gray-400">
            <Search className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">未找到匹配的节点</p>
            <p className="text-xs mt-1">尝试其他关键词</p>
            <button
              onClick={() => setSearchQuery('')}
              className="mt-3 px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600"
            >
              清除搜索
            </button>
          </div>
        ) : (
          <>
            {/* Search results summary */}
            {searchQuery.trim() && (
              <div className="mb-3 px-2 py-1.5 bg-blue-50 dark:bg-blue-900/30 rounded-lg text-xs text-blue-600 dark:text-blue-400 flex items-center gap-2">
                <Search className="w-3 h-3" />
                <span>找到 <strong>{totalMatchingCards}</strong> 个匹配结果</span>
                {totalMatchingCards > 0 && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="ml-auto text-blue-500 hover:text-blue-700 dark:hover:text-blue-300"
                  >
                    清除搜索
                  </button>
                )}
              </div>
            )}

            {/* Render filtered folder tree */}
            {filteredFolderTree.map((folder) => (
              <Fragment key={folder.id}>
                {renderFolder(folder, 0)}
              </Fragment>
            ))}

            {/* Root cards */}
            {filteredCardsByFolder.get(null)?.map((card) => (
              <div key={card.id} className="mb-2">
                <NodeCardItem
                  card={card}
                  isDragging={false}
                  isDragOver={false}
                  dragOverPosition={null}
                  onUse={handleUseCard}
                  onRemove={handleRemoveCard}
                  onSaveName={handleSaveCardName}
                  onContextMenu={handleCardContextMenu}
                  showPreview={previewCardId === card.id}
                  onTogglePreview={setPreviewCardId}
                  searchQuery={searchQuery}
                />
              </div>
            ))}
          </>
        )}
      </div>

      {/* Folder Context Menu with Error Boundary */}
      <ContextMenuErrorBoundary>
        {folderContextMenu && (
          <FolderContextMenu
            folder={folderContextMenu.folder}
            position={folderContextMenu.position}
            onClose={() => setFolderContextMenu(null)}
            onRename={() => handleRenameFolder(folderContextMenu.folder)}
          />
        )}
      </ContextMenuErrorBoundary>

      {/* Card Context Menu with Error Boundary */}
      <ContextMenuErrorBoundary>
        {cardContextMenu && (
          <NodeCardContextMenu
            card={cardContextMenu.card}
            position={cardContextMenu.position}
            onClose={() => {
              setCardContextMenu(null)
              setDragGhost(null, null)
            }}
            onRename={() => handleRenameCard(cardContextMenu.card)}
            onMoveToFolder={(folderId) => handleMoveCardToFolder(cardContextMenu.card, folderId)}
          />
        )}
      </ContextMenuErrorBoundary>
    </aside>
  )
}

function EmptyState({ onAddToPool }: { onAddToPool: () => void }) {
  return (
    <div className="text-center py-8">
      <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center">
        <FileUp className="w-6 h-6 text-gray-400 dark:text-gray-500" />
      </div>
      <p className="text-sm text-gray-600 dark:text-gray-400">节点池为空</p>
      <p className="text-xs text-gray-500 dark:text-gray-500 mt-1">从画布拖入节点或选择节点后添加</p>
      <button
        onClick={onAddToPool}
        className="mt-4 px-4 py-2 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
      >
        添加选中节点
      </button>
    </div>
  )
}

export default NodePoolPanel
