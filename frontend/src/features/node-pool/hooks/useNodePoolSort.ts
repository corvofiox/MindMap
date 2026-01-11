/**
 * useNodePoolSort Hook
 *
 * Handles sorting logic for node pool items.
 * Provides sorted lists and reorder functionality.
 */

import { useMemo, useCallback } from 'react'
import type { NodeCard, NodePoolFolder, NodePoolSortOption, NodePoolSortOrder } from '@/types'
import { useNodePoolStore, selectCardsByFolder, selectFoldersByParent } from '../stores/useNodePoolStore'
import type { ReorderOperation, UseNodePoolSortReturn, UseNodePoolSortOptions, NodePoolStore } from '../types/node-pool'
import { calculateReorderByTarget } from '../utils/sort-calculator'

/**
 * Custom hook for node pool sorting functionality
 */
export function useNodePoolSort(options: UseNodePoolSortOptions = {}): UseNodePoolSortReturn {
  const { enabled = true, sortBy = 'createdAt', sortOrder = 'desc' } = options
  const { cardsMap, foldersMap, reorderCards, reorderFolders } = useNodePoolStore()

  // Get sorted cards grouped by folder
  const sortedCardsByFolder = useMemo(() => {
    if (!enabled) {
      return new Map<number | null, NodeCard[]>()
    }

    const grouped = new Map<number | null, NodeCard[]>()

    // Get root cards (folderId is null)
    let rootCards = selectCardsByFolder(useNodePoolStore.getState(), null)
    // Sort root cards
    rootCards = sortCards(rootCards, sortBy, sortOrder)
    grouped.set(null, rootCards)

    // Get cards for each folder
    const allFolders = Array.from(foldersMap.values()) as NodePoolFolder[]
    for (const folder of allFolders) {
      let folderCards = selectCardsByFolder(useNodePoolStore.getState(), folder.id)
      // Sort folder cards
      folderCards = sortCards(folderCards, sortBy, sortOrder)
      grouped.set(folder.id, folderCards)
    }

    return grouped
  }, [enabled, cardsMap, foldersMap, sortBy, sortOrder])

  // Get sorted root folders
  const sortedRootFolders = useMemo((): NodePoolFolder[] => {
    if (!enabled) {
      return []
    }
    return selectFoldersByParent(useNodePoolStore.getState(), null)
  }, [enabled])

  // Get item position
  const getItemPosition = useCallback((
    id: number,
    type: 'folder' | 'card'
  ): { index: number; folderId: number | null } | null => {
    if (type === 'card') {
      const card = cardsMap.get(id)
      if (!card) return null

      const cards = sortedCardsByFolder.get(card.folderId || null) || []
      const index = cards.findIndex(c => c.id === id)

      return index >= 0 ? { index, folderId: card.folderId || null } : null
    } else {
      const folder = foldersMap.get(id)
      if (!folder) return null

      const folders = selectFoldersByParent(useNodePoolStore.getState(), folder.parentId || null)
      const index = folders.findIndex(f => f.id === id)

      return index >= 0 ? { index, folderId: folder.parentId || null } : null
    }
  }, [cardsMap, foldersMap, sortedCardsByFolder])

  // Handle reorder
  const handleReorder = useCallback(async (operation: ReorderOperation) => {
    if (!enabled) {
      return
    }

    const { type, itemId, targetId, position } = operation

    if (type === 'reorder-card') {
      // Get cards at the same level
      const folderId = operation.folderId || null
      const cards = sortedCardsByFolder.get(folderId) || []

      // Calculate new sort orders
      const result = calculateReorderByTarget(
        cards.map(c => ({ id: c.id, sortOrder: c.sortOrder })),
        itemId,
        targetId,
        position
      )

      // Apply reorder
      await reorderCards(result.updates)
    } else if (type === 'reorder-folder') {
      // Get folders at the same level
      const parentId = operation.parentId || null
      const folders = selectFoldersByParent(useNodePoolStore.getState(), parentId)

      // Calculate new sort orders
      const result = calculateReorderByTarget(
        folders.map(f => ({ id: f.id, sortOrder: f.sortOrder })),
        itemId,
        targetId,
        position
      )

      // Apply reorder
      await reorderFolders(result.updates)
    }
  }, [enabled, sortedCardsByFolder, reorderCards, reorderFolders])

  return {
    sortedRootFolders,
    sortedCardsByFolder,
    getItemPosition,
    handleReorder,
  }
}

/**
 * Sort cards by specified field and order
 */
function sortCards(cards: NodeCard[], sortBy: NodePoolSortOption, sortOrder: NodePoolSortOrder): NodeCard[] {
  return [...cards].sort((a, b) => {
    let comparison = 0

    if (sortBy === 'name') {
      comparison = a.name.localeCompare(b.name, 'zh-CN')
    } else if (sortBy === 'createdAt') {
      comparison = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    } else if (sortBy === 'useCount') {
      comparison = a.useCount - b.useCount
    }

    return sortOrder === 'asc' ? comparison : -comparison
  })
}

/**
 * Hook to get the folder tree structure
 */
export function useFolderTree() {
  const { foldersMap } = useNodePoolStore()

  const folderTree = useMemo(() => {
    const buildTree = (parentId: number | null): (NodePoolFolder & { children: NodePoolFolder[] })[] => {
      const children = selectFoldersByParent(useNodePoolStore.getState(), parentId) as NodePoolFolder[]
      return children.map((folder: NodePoolFolder) => ({
        ...folder,
        children: buildTree(folder.id),
      }))
    }

    return buildTree(null)
  }, [foldersMap])

  return folderTree
}

/**
 * Hook to get cards and folders for a specific folder
 */
export function useFolderContents(folderId: number | null = null) {
  const cards = useNodePoolStore((state: NodePoolStore) => selectCardsByFolder(state, folderId))
  const folders = useNodePoolStore((state: NodePoolStore) => selectFoldersByParent(state, folderId))

  return {
    cards,
    folders,
    isEmpty: cards.length === 0 && folders.length === 0,
  }
}

export type { UseNodePoolSortReturn, UseNodePoolSortOptions }
