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

// Get current project ID helper
const getCurrentProjectId = (): number => {
  // Import from useProjectsStore to get current project
  // This avoids circular dependencies
  const state = (window as any).__projectsStore__
  return state?.currentProject?.id || null
}

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

  setCards: (cards: NodeCard[]) => {
    const cardsMap = new Map(cards.map(card => [card.id, card]))
    set({ cardsMap })
  },

  updateCard: async (id: number, data: Partial<NodeCard>) => {
    // 获取原始卡片数据用于回滚
    const originalCard = get().cardsMap.get(id)
    if (!originalCard) return
    
    // 立即更新本地状态（乐观更新）
    set((state) => {
      const newCardsMap = new Map(state.cardsMap)
      const updatedCard = { ...originalCard, ...data }
      newCardsMap.set(id, updatedCard)
      return { cardsMap: newCardsMap }
    })

    try {
      // 后台执行API请求
      await api.updateNodeCard(id, data)
    } catch (error) {
      // API失败：回滚本地状态
      set((state) => {
        const newCardsMap = new Map(state.cardsMap)
        newCardsMap.set(id, originalCard)
        return { cardsMap: newCardsMap }
      })
      
      // 显示错误信息
      const errorMessage = error instanceof Error ? error.message : '更新卡片失败'
      set({ error: errorMessage })
    }
  },

  removeCard: async (id: number) => {
    const state = get()
    
    // 保存原始状态用于回滚
    const originalCardsMap = new Map(state.cardsMap)
    
    try {
      // 调用useProjectsStore的removeFromNodePool函数，确保两个store的数据一致
      await (await import('@/store/useProjectsStore')).useProjectsStore.getState().removeFromNodePool(id)
      
      // 更新当前store的状态
      set((state) => {
        const newCardsMap = new Map(state.cardsMap)
        newCardsMap.delete(id)
        return { cardsMap: newCardsMap }
      })
    } catch (error) {
      // API失败：保持当前store状态不变
      const errorMessage = error instanceof Error ? error.message : '移除卡片失败'
      set({ error: errorMessage })
    }
  },

  reorderCards: async (updates: Array<{ id: number; sortOrder: number }>) => {
    const state = get()

    // Optimistic update - update local state first
    const newCardsMap = new Map(state.cardsMap)

    updates.forEach(({ id, sortOrder }) => {
      const card = newCardsMap.get(id)
      if (card) {
        newCardsMap.set(id, { ...card, sortOrder })
      }
    })

    set({ cardsMap: newCardsMap })

    try {
      // Then sync with server
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

  addFolder: async (folder: Omit<NodePoolFolder, 'id' | 'createdAt'>) => {
    // 生成临时ID
    const tempId = -Date.now()
    
    // 创建临时文件夹对象
    const tempFolder = {
      id: tempId,
      ...folder,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      children: []
    }
    
    // 乐观更新：立即添加到本地状态
    set((state) => {
      const newFoldersMap = new Map(state.foldersMap)
      newFoldersMap.set(tempId, tempFolder)
      return { foldersMap: newFoldersMap }
    })

    try {
      // 后台执行API请求
      const projectId = folder.projectId
      const created = await api.createNodePoolFolder(projectId, folder)

      // 用真实数据替换临时文件夹
      set((state) => {
        const newFoldersMap = new Map(state.foldersMap)
        newFoldersMap.delete(tempId)
        newFoldersMap.set(created.id, { ...created, children: [] }) // children computed separately
        return { foldersMap: newFoldersMap }
      })

      return created
    } catch (error) {
      // API失败：从本地状态移除临时文件夹
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
        newFoldersMap.set(id, { ...updated, children: [] }) // children computed separately
        return { foldersMap: newFoldersMap, isLoading: false }
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '更新文件夹失败'
      set({ error: errorMessage, isLoading: false })
    }
  },

  removeFolder: async (id: number) => {
    const state = get()
    
    // 保存原始状态用于回滚
    const originalFoldersMap = new Map(state.foldersMap)
    
    // 乐观更新：立即从本地状态移除文件夹
    set((state) => {
      const newFoldersMap = new Map(state.foldersMap)
      newFoldersMap.delete(id)
      return { foldersMap: newFoldersMap }
    })

    try {
      // 后台执行API请求
      await api.deleteNodePoolFolder(id)
    } catch (error) {
      // API失败：回滚到原始状态
      set((state) => {
        return { foldersMap: originalFoldersMap }
      })
      
      // 显示错误信息
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
