/**
 * Node Pool Store - Zustand Store
 *
 * A dedicated store for node pool state management.
 * Uses Map for O(1) lookups instead of O(n) array searches.
 */

import { create } from 'zustand'
import type {
  NodeCard,
  NodePoolFolder,
} from '@/types'
import type {
  NodePoolStore,
  DragState,
} from '../types/node-pool'
import * as api from '@/services/api'

/**
 * Node pool store with complete state management
 * No external Store dependencies, self-contained
 */
export const useNodePoolStore = create<NodePoolStore>((set, get) => ({
  // Initial state
  cardsMap: new Map(),
  foldersMap: new Map(),
  dragState: { active: null, over: null },
  isLoading: false,
  error: null,

  // ========== Card Actions ==========

  getCard: (id: number) => {
    return get().cardsMap.get(id)
  },

  // Set cards from API or initial load
  setCards: (cards: NodeCard[]) => {
    const cardsMap = new Map(cards.map(card => [card.id, card]))
    set({ cardsMap })
  },

  // Load node pool data for current project
  loadNodePool: async (projectId: number) => {
    set({ isLoading: true, error: null })
    try {
      const cards = await api.getNodePool(projectId)
      const folders = await api.getNodePoolFolders(projectId)
      
      set({
        cardsMap: new Map(cards.map(card => [card.id, card])),
        foldersMap: new Map(folders.map(folder => [folder.id, folder])),
        isLoading: false
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '加载节点池失败'
      set({ error: errorMessage, isLoading: false })
    }
  },

  // Add card to node pool
  addCard: async (projectId: number, data: Omit<NodeCard, 'id' | 'createdAt' | 'useCount'>) => {
    // Generate temp ID for optimistic update
    const tempId = -Date.now()
    
    // Create temp card object
    const tempCard: NodeCard = {
      id: tempId,
      ...data,
      projectId,
      createdAt: new Date().toISOString(),
      useCount: 0
    }
    
    // Optimistic update
    set((state) => {
      const newCardsMap = new Map(state.cardsMap)
      newCardsMap.set(tempId, tempCard)
      return { cardsMap: newCardsMap }
    })

    try {
      // Call API to create card
      const created = await api.addToNodePool(projectId, data)

      // Replace temp card with real card
      set((state) => {
        const newCardsMap = new Map(state.cardsMap)
        newCardsMap.delete(tempId)
        newCardsMap.set(created.id, created)
        return { cardsMap: newCardsMap }
      })

      return created
    } catch (error) {
      // Rollback on error
      set((state) => {
        const newCardsMap = new Map(state.cardsMap)
        newCardsMap.delete(tempId)
        return { cardsMap: newCardsMap }
      })
      
      const errorMessage = error instanceof Error ? error.message : '添加到节点池失败'
      set({ error: errorMessage })
      throw error
    }
  },

  updateCard: async (id: number, data: Partial<NodeCard>) => {
    // Get original card data for rollback
    const originalCard = get().cardsMap.get(id)
    if (!originalCard) return
    
    // Optimistic update
    set((state) => {
      const newCardsMap = new Map(state.cardsMap)
      const updatedCard = { ...originalCard, ...data }
      newCardsMap.set(id, updatedCard)
      return { cardsMap: newCardsMap }
    })

    try {
      // Call API to update card
      const updated = await api.updateNodeCard(id, data)
      
      // Update with real data from API
      set((state) => {
        const newCardsMap = new Map(state.cardsMap)
        newCardsMap.set(id, updated)
        return { cardsMap: newCardsMap }
      })
    } catch (error) {
      // Rollback on error
      set((state) => {
        const newCardsMap = new Map(state.cardsMap)
        newCardsMap.set(id, originalCard)
        return { cardsMap: newCardsMap }
      })
      
      const errorMessage = error instanceof Error ? error.message : '更新卡片失败'
      set({ error: errorMessage })
    }
  },

  removeCard: async (id: number) => {
    // Get original card for rollback
    const originalCard = get().cardsMap.get(id)
    if (!originalCard) return
    
    // Optimistic update
    set((state) => {
      const newCardsMap = new Map(state.cardsMap)
      newCardsMap.delete(id)
      return { cardsMap: newCardsMap }
    })

    try {
      // Call API to remove card
      await api.removeFromNodePool(id)
    } catch (error) {
      // Rollback on error
      set((state) => {
        const newCardsMap = new Map(state.cardsMap)
        newCardsMap.set(id, originalCard)
        return { cardsMap: newCardsMap }
      })
      
      const errorMessage = error instanceof Error ? error.message : '移除卡片失败'
      set({ error: errorMessage })
    }
  },

  reorderCards: async (updates: Array<{ id: number; sortOrder: number }>) => {
    const state = get()

    // Optimistic update
    const newCardsMap = new Map(state.cardsMap)

    updates.forEach(({ id, sortOrder }) => {
      const card = newCardsMap.get(id)
      if (card) {
        newCardsMap.set(id, { ...card, sortOrder })
      }
    })

    set({ cardsMap: newCardsMap })

    try {
      // Sync with server
      await Promise.all(
        updates.map(({ id, sortOrder }) =>
          api.updateNodeCard(id, { sortOrder })
        )
      )
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '重新排序卡片失败'
      set({ error: errorMessage })

      // Revert on error
      set({ cardsMap: state.cardsMap })
    }
  },

  // ========== Folder Actions ==========

  getFolder: (id: number) => {
    return get().foldersMap.get(id)
  },

  setFolders: (folders: NodePoolFolder[]) => {
    const foldersMap = new Map(folders.map(folder => [folder.id, folder]))
    set({ foldersMap })
  },

  // Add folder with optimistic update
  addFolder: async (folder: Omit<NodePoolFolder, 'id' | 'createdAt'>) => {
    // Generate temp ID
    const tempId = -Date.now()
    
    // Create temp folder object
    const tempFolder = {
      id: tempId,
      ...folder,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      children: []
    }
    
    // Optimistic update
    set((state) => {
      const newFoldersMap = new Map(state.foldersMap)
      newFoldersMap.set(tempId, tempFolder)
      return { foldersMap: newFoldersMap }
    })

    try {
      // Call API to create folder
      const created = await api.createNodePoolFolder(folder.projectId, folder)

      // Replace temp folder with real data
      set((state) => {
        const newFoldersMap = new Map(state.foldersMap)
        newFoldersMap.delete(tempId)
        newFoldersMap.set(created.id, { ...created, children: [] })
        return { foldersMap: newFoldersMap }
      })

      return created
    } catch (error) {
      // Rollback on error
      set((state) => {
        const newFoldersMap = new Map(state.foldersMap)
        newFoldersMap.delete(tempId)
        return { foldersMap: newFoldersMap }
      })
      
      const errorMessage = error instanceof Error ? error.message : '添加文件夹失败'
      set({ error: errorMessage })
      return null
    }
  },

  updateFolder: async (id: number, data: Partial<NodePoolFolder>) => {
    set({ isLoading: true, error: null })

    try {
      const updated = await api.updateNodePoolFolder(id, data)

      set((state) => {
        const newFoldersMap = new Map(state.foldersMap)
        newFoldersMap.set(id, { ...updated, children: [] })
        return { foldersMap: newFoldersMap, isLoading: false }
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '更新文件夹失败'
      set({ error: errorMessage, isLoading: false })
    }
  },

  removeFolder: async (id: number) => {
    // Get original folder for rollback and project ID
    const originalFolder = get().foldersMap.get(id)
    if (!originalFolder) return
    
    // Save original state for rollback
    const originalFoldersMap = new Map(get().foldersMap)
    
    // Optimistic update
    set((state) => {
      const newFoldersMap = new Map(state.foldersMap)
      newFoldersMap.delete(id)
      return { foldersMap: newFoldersMap }
    })

    try {
      // Call API to remove folder
      await api.deleteNodePoolFolder(id)
    } catch (error) {
      // Rollback on error
      set({ foldersMap: originalFoldersMap })
      
      const errorMessage = error instanceof Error ? error.message : '移除文件夹失败'
      set({ error: errorMessage })
    }
  },

  reorderFolders: async (updates: Array<{ id: number; sortOrder: number }>) => {
    const state = get()

    // Optimistic update
    const newFoldersMap = new Map(state.foldersMap)

    updates.forEach(({ id, sortOrder }) => {
      const folder = newFoldersMap.get(id)
      if (folder) {
        newFoldersMap.set(id, { ...folder, sortOrder })
      }
    })

    set({ foldersMap: newFoldersMap })

    try {
      // Sync with server
      await Promise.all(
        updates.map(({ id, sortOrder }) =>
          api.updateNodePoolFolder(id, { sortOrder })
        )
      )
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '重新排序文件夹失败'
      set({ error: errorMessage })

      // Revert on error
      set({ foldersMap: state.foldersMap })
    }
  },

  toggleFolderCollapsed: (id: number) => {
    set((state) => {
      const folder = state.foldersMap.get(id)
      if (!folder) return state

      const newFoldersMap = new Map(state.foldersMap)
      newFoldersMap.set(id, { ...folder, collapsed: !folder.collapsed })
      return { foldersMap: newFoldersMap }
    })
  },

  // ========== Drag State Actions ==========

  setDragState: (dragState: DragState) => {
    set({ dragState })
  },

  clearDragState: () => {
    set({ dragState: { active: null, over: null } })
  },

  // ========== Utility Actions ==========

  clearError: () => {
    set({ error: null })
  },

  // Reset store to initial state
  reset: () => {
    set({
      cardsMap: new Map(),
      foldersMap: new Map(),
      dragState: { active: null, over: null },
      isLoading: false,
      error: null,
    })
  },
}))

// ========== Selectors ==========

/**
 * Get all cards as an array (sorted by sortOrder)
 */
export const selectAllCards = (store: NodePoolStore): NodeCard[] => {
  return Array.from(store.cardsMap.values()).sort((a, b) => a.sortOrder - b.sortOrder)
}

/**
 * Get all folders as an array (sorted by sortOrder)
 */
export const selectAllFolders = (store: NodePoolStore): NodePoolFolder[] => {
  return Array.from(store.foldersMap.values()).sort((a, b) => a.sortOrder - b.sortOrder)
}

/**
 * Get cards by folder ID (null for root level)
 */
export const selectCardsByFolder = (store: NodePoolStore, folderId: number | null): NodeCard[] => {
  return Array.from(store.cardsMap.values())
    .filter(card => card.folderId === folderId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
}

/**
 * Get folders by parent ID (null for root level)
 */
export const selectFoldersByParent = (store: NodePoolStore, parentId: number | null): NodePoolFolder[] => {
  return Array.from(store.foldersMap.values())
    .filter(folder => folder.parentId === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
}

/**
 * Build folder tree structure
 */
export const selectFolderTree = (store: NodePoolStore, parentId: number | null = null): NodePoolFolder[] => {
  const folders = selectFoldersByParent(store, parentId)
  return folders.map(folder => ({
    ...folder,
    children: selectFolderTree(store, folder.id),
  }))
}
