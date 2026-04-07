/**
 * Node Pool Store - Zustand Store
 *
 * A dedicated store for node pool state management with operation queue system.
 * Uses Map for O(1) lookups and operation queue for race condition prevention.
 */

import { create } from 'zustand'
import type {
  NodeCard,
  NodePoolFolder,
} from '@/types'
import type {
  NodePoolStore,
  DragState,
  Operation,
  TemporaryCard,
} from '../types/node-pool'
import * as api from '@/services/api'

/**
 * Node pool store with operation queue system
 * No external Store dependencies, self-contained
 */
let tempIdCounter = 0
let operationIdCounter = 0

function generateTempId(): number {
  return -Date.now() * 1000 - (tempIdCounter++)
}

function generateOperationId(): string {
  return `op-${Date.now()}-${operationIdCounter++}`
}

export const useNodePoolStore = create<NodePoolStore>((set, get) => ({
  // Initial state
  cardsMap: new Map(),
  foldersMap: new Map(),
  dragState: { active: null, over: null },
  isLoading: false,
  error: null,
  pendingCardIds: new Set<number>(),
  // Operation queue system
  operationQueue: new Map<string, Operation>(),
  temporaryCards: new Map<number, TemporaryCard>(),
  processingOperations: new Set<string>(),

  // ========== Card Actions ==========

  getCard: (id: number) => {
    return get().cardsMap.get(id)
  },

  useCard: async (card: NodeCard, addNodeToCanvas: (node: any) => void) => {
    const cardId = card.id

    const state = get()

    const tempCard = state.temporaryCards.get(cardId)
    const realCard = state.cardsMap.get(cardId)

    const actualCard = tempCard?.card || realCard

    if (!actualCard) {
      return
    }

    const operationId = generateOperationId()

    const operation: Operation = {
      id: operationId,
      type: 'remove',
      status: 'pending',
      cardId: cardId,
      realCardId: cardId > 0 ? cardId : null,
      timestamp: Date.now(),
      retryCount: 0
    }

    try {
      const freshTempCard = get().temporaryCards.get(cardId)
      if (freshTempCard?.card._markedForDeletion) {
        return
      }

      let nodeData
      try {
        nodeData = JSON.parse(actualCard.content)
      } catch {
        throw new Error('Failed to parse card content')
      }

      const newNode = {
        ...nodeData,
        id: `${nodeData.id}-pool-${Date.now()}`,
        x: nodeData.x + 50,
        y: nodeData.y + 50,
      }

      addNodeToCanvas(newNode)

      const newOperationQueue = new Map(state.operationQueue)
      const newProcessingOps = new Set(state.processingOperations)
      newOperationQueue.set(operationId, operation)
      newProcessingOps.add(operationId)

      const newCardsMap = new Map(state.cardsMap)
      const newPendingCardIds = new Set(state.pendingCardIds)
      const newTemporaryCards = new Map(state.temporaryCards)

      newCardsMap.delete(cardId)
      newPendingCardIds.delete(cardId)

      if (tempCard) {
        const updatedTempCard = { ...tempCard.card, _markedForDeletion: true }
        newTemporaryCards.set(cardId, { ...tempCard, card: updatedTempCard })
      } else {
        newTemporaryCards.delete(cardId)
      }

      set({
        cardsMap: newCardsMap,
        pendingCardIds: newPendingCardIds,
        operationQueue: newOperationQueue,
        temporaryCards: newTemporaryCards,
        processingOperations: newProcessingOps
      })

      const cardToRemove = tempCard || { card: actualCard }

      if (cardToRemove?.card?.id > 0) {
        await api.removeFromNodePool(cardToRemove.card.id)
      }

      set(() => {
        const updatedOp = newOperationQueue.get(operationId)
        if (updatedOp) {
          newOperationQueue.set(operationId, { ...updatedOp, status: 'completed' })
        }

        newProcessingOps.delete(operationId)

        setTimeout(() => {
          set((state) => {
            const newOps = new Map(state.operationQueue)
            newOps.delete(operationId)
            return { operationQueue: newOps }
          })
        }, 5000)

        return {
          operationQueue: newOperationQueue,
          processingOperations: newProcessingOps
        }
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '使用节点失败'
      set({ error: errorMessage })
      throw error
    }
  },

  // Set cards from API or initial load
  setCards: (cards: NodeCard[]) => {
    const cardsMap = new Map(cards.map(card => [card.id, card]))
    set({ cardsMap })
  },

  // Load node pool data for current user
  loadNodePool: async () => {
    set({ isLoading: true, error: null })
    try {
      const cards = await api.getNodePool()
      const folders = await api.getNodePoolFolders()

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

  // Add card to node pool with operation queue
  addCard: async (data: Omit<NodeCard, 'id' | 'createdAt' | 'useCount' | 'userId' | 'createdBy'>) => {
    const operationId = generateOperationId()
    const tempId = generateTempId()

    const tempCard: NodeCard = {
      id: tempId,
      userId: 0,
      createdBy: 0,
      ...data,
      createdAt: new Date().toISOString(),
      useCount: 0
    }

    const operation: Operation = {
      id: operationId,
      type: 'add',
      status: 'pending',
      cardId: tempId,
      realCardId: null,
      timestamp: Date.now(),
      retryCount: 0,
      data: { ...data } as Partial<NodeCard>
    }

    const temporaryCard: TemporaryCard = {
      card: tempCard,
      operationId,
      status: 'creating',
      realCardId: null
    }

    // Optimistic update: add temporary card and operation
    set((state) => {
      const newCardsMap = new Map(state.cardsMap)
      newCardsMap.set(tempId, tempCard)
      const newPendingCardIds = new Set(state.pendingCardIds)
      newPendingCardIds.add(tempId)
      const newOperationQueue = new Map(state.operationQueue)
      newOperationQueue.set(operationId, operation)
      const newTemporaryCards = new Map(state.temporaryCards)
      newTemporaryCards.set(tempId, temporaryCard)
      return {
        cardsMap: newCardsMap,
        pendingCardIds: newPendingCardIds,
        operationQueue: newOperationQueue,
        temporaryCards: newTemporaryCards
      }
    })

    try {
      // Mark operation as processing
      set((state) => {
        const newProcessingOps = new Set(state.processingOperations)
        newProcessingOps.add(operationId)
        const newOperationQueue = new Map(state.operationQueue)
        const updatedOp = newOperationQueue.get(operationId)
        if (updatedOp) {
          newOperationQueue.set(operationId, { ...updatedOp, status: 'processing' })
        }
        return {
          processingOperations: newProcessingOps,
          operationQueue: newOperationQueue
        }
      })

      // Call API
      const created = await api.addToNodePool(data)

      // Update state with real card
      set((state) => {
        const newCardsMap = new Map(state.cardsMap)
        const newPendingCardIds = new Set(state.pendingCardIds)
        const newOperationQueue = new Map(state.operationQueue)
        const newTemporaryCards = new Map(state.temporaryCards)
        const newProcessingOps = new Set(state.processingOperations)

        const tempCardData = newTemporaryCards.get(tempId)

        const shouldDelete = tempCardData?.card?._markedForDeletion === true

        newCardsMap.delete(tempId)
        newPendingCardIds.delete(tempId)

        // If should delete, discard the real card
        if (shouldDelete) {
          newTemporaryCards.delete(tempId)
          // Update operation status as completed
          const updatedOp = newOperationQueue.get(operationId)
          if (updatedOp) {
            newOperationQueue.set(operationId, {
              ...updatedOp,
              status: 'completed',
              realCardId: created.id,
              cardId: created.id
            })
          }

          // Remove from processing
          newProcessingOps.delete(operationId)

          // Delete the real card from server
          api.removeFromNodePool(created.id).catch(() => {
            // Silently ignore cleanup errors
          })

          // Clean up completed operation after delay
          setTimeout(() => {
            set((state) => {
              const newOps = new Map(state.operationQueue)
              newOps.delete(operationId)
              return { operationQueue: newOps }
            })
          }, 5000)

          return {
            cardsMap: newCardsMap,
            pendingCardIds: newPendingCardIds,
            operationQueue: newOperationQueue,
            temporaryCards: newTemporaryCards,
            processingOperations: newProcessingOps
          }
        } else {
          // Add real card
          const finalCard = { ...created }
          if (tempCardData) {
            // Merge with temporary card data if any
            Object.keys(tempCardData.card).forEach(key => {
              if (key !== 'id' && (tempCardData.card as any)[key] !== (created as any)[key]) {
                (finalCard as any)[key] = (tempCardData.card as any)[key]
              }
            })
          }
          newCardsMap.set(created.id, finalCard)

          // Update temporary card with realCardId for updateCard to find
          if (tempCardData) {
            newTemporaryCards.set(tempId, {
              ...tempCardData,
              realCardId: created.id,
              status: 'created'
            })
          }

          // Update operation status
          const updatedOp = newOperationQueue.get(operationId)
          if (updatedOp) {
            newOperationQueue.set(operationId, {
              ...updatedOp,
              status: 'completed',
              realCardId: created.id,
              cardId: created.id
            })
          }

          // Remove from processing
          newProcessingOps.delete(operationId)

          // Clean up completed operation and temporary card after delay
          setTimeout(() => {
            set((state) => {
              const newOps = new Map(state.operationQueue)
              newOps.delete(operationId)
              const newTemps = new Map(state.temporaryCards)
              newTemps.delete(tempId)
              return { operationQueue: newOps, temporaryCards: newTemps }
            })
          }, 10000)

          return {
            cardsMap: newCardsMap,
            pendingCardIds: newPendingCardIds,
            operationQueue: newOperationQueue,
            temporaryCards: newTemporaryCards,
            processingOperations: newProcessingOps
          }
        }
      })

      return created
    } catch (error) {
      // Rollback on error
      set((state) => {
        const newCardsMap = new Map(state.cardsMap)
        const newPendingCardIds = new Set(state.pendingCardIds)
        const newOperationQueue = new Map(state.operationQueue)
        const newTemporaryCards = new Map(state.temporaryCards)
        const newProcessingOps = new Set(state.processingOperations)

        // Remove temporary card
        newCardsMap.delete(tempId)
        newPendingCardIds.delete(tempId)
        newTemporaryCards.delete(tempId)

        // Update operation status
        const updatedOp = newOperationQueue.get(operationId)
        if (updatedOp) {
          newOperationQueue.set(operationId, {
            ...updatedOp,
            status: 'failed',
            retryCount: updatedOp.retryCount + 1
          })
        }

        // Remove from processing
        newProcessingOps.delete(operationId)

        // Clean up failed operation after delay
        setTimeout(() => {
          set((state) => {
            const newOps = new Map(state.operationQueue)
            newOps.delete(operationId)
            return { operationQueue: newOps }
          })
        }, 10000)

        return {
          cardsMap: newCardsMap,
          pendingCardIds: newPendingCardIds,
          operationQueue: newOperationQueue,
          temporaryCards: newTemporaryCards,
          processingOperations: newProcessingOps
        }
      })

      const errorMessage = error instanceof Error ? error.message : '添加到节点池失败'
      set({ error: errorMessage })
      throw error
    }
  },

  updateCard: async (id: number, data: Partial<NodeCard>) => {
    const isPendingCard = get().pendingCardIds.has(id)
    const originalCard = get().cardsMap.get(id)

    if (!originalCard) {
      return
    }

    const tempCard = get().temporaryCards.get(id)
    if (tempCard?.card._markedForDeletion) {
      return
    }

    // 如果是临时卡片且已有 realCardId，使用真实卡片 ID 进行更新
    if (id < 0 && tempCard?.realCardId) {
      return get().updateCard(tempCard.realCardId, data)
    }

    // 如果是临时卡片但 tempCard 不存在（可能正在被替换），等待或查找映射
    if (id < 0 && !tempCard) {
      // 尝试在 operationQueue 中查找对应的操作
      for (const [, op] of get().operationQueue) {
        if (op.cardId === id && op.realCardId) {
          return get().updateCard(op.realCardId, data)
        }
      }
      return
    }

    if (isPendingCard) {
      let retries = 0
      const maxRetries = 20

      while (retries < maxRetries && get().pendingCardIds.has(id)) {
        await new Promise(resolve => setTimeout(resolve, 100))
        retries++
      }

      if (get().pendingCardIds.has(id)) {
        return
      }

      // 等待完成后，检查卡片是否还在 cardsMap 中
      const newCard = get().cardsMap.get(id)
      if (!newCard) {
        // 卡片可能已经从临时 ID 替换为真实 ID
        // 检查 temporaryCards 中是否有这个临时 ID 的映射
        if (id < 0) {
          const currentTempCard = get().temporaryCards.get(id)
          if (currentTempCard?.realCardId) {
            return get().updateCard(currentTempCard.realCardId, data)
          }
        }
        return
      }

      if (id < 0) {
        const currentTempCard = get().temporaryCards.get(id)
        if (currentTempCard?.realCardId) {
          return get().updateCard(currentTempCard.realCardId, data)
        }
        return
      }
    }

    set((state) => {
      const newCardsMap = new Map(state.cardsMap)
      const updatedCard = { ...originalCard, ...data }
      newCardsMap.set(id, updatedCard)
      return { cardsMap: newCardsMap }
    })

    try {
      const updated = await api.updateNodeCard(id, data)

      set((state) => {
        // If card was removed from store while API call was in flight, do not re-add it
        if (!state.cardsMap.has(id)) return state

        const newCardsMap = new Map(state.cardsMap)
        newCardsMap.set(id, updated)
        return { cardsMap: newCardsMap }
      })
    } catch (error) {
      set((state) => {
        const newCardsMap = new Map(state.cardsMap)
        newCardsMap.set(id, originalCard)
        return { cardsMap: newCardsMap }
      })

      const errorMessage = error instanceof Error ? error.message : '更新卡片失败'
      set({ error: errorMessage })
      throw error
    }
  },

  removeCard: async (id: number) => {
    const state = get()

    const originalCard = state.cardsMap.get(id)
    const temporaryCard = state.temporaryCards.get(id)

    if (!originalCard && !temporaryCard) {
      return
    }

    const operationId = generateOperationId()

    const operation: Operation = {
      id: operationId,
      type: 'remove',
      status: 'pending',
      cardId: id,
      realCardId: id > 0 ? id : null,
      timestamp: Date.now(),
      retryCount: 0
    }

    set((prevState) => {
      const newCardsMap = new Map(prevState.cardsMap)
      const newPendingCardIds = new Set(prevState.pendingCardIds)
      const newOperationQueue = new Map(prevState.operationQueue)
      const newTemporaryCards = new Map(prevState.temporaryCards)

      newCardsMap.delete(id)
      newPendingCardIds.delete(id)
      newTemporaryCards.delete(id)

      newOperationQueue.set(operationId, operation)

      return {
        cardsMap: newCardsMap,
        pendingCardIds: newPendingCardIds,
        operationQueue: newOperationQueue,
        temporaryCards: newTemporaryCards
      }
    })

    try {
      set((prevState) => {
        const newProcessingOps = new Set(prevState.processingOperations)
        newProcessingOps.add(operationId)

        const newOperationQueue = new Map(prevState.operationQueue)
        const updatedOp = newOperationQueue.get(operationId)

        if (updatedOp) {
          newOperationQueue.set(operationId, { ...updatedOp, status: 'processing' })
        }

        return {
          processingOperations: newProcessingOps,
          operationQueue: newOperationQueue
        }
      })

      const cardToRemove = temporaryCard || { card: originalCard }

      if (cardToRemove?.card?.id > 0) {
        await api.removeFromNodePool(cardToRemove.card.id)
      }

      set((prevState) => {
        const newOperationQueue = new Map(prevState.operationQueue)
        const newProcessingOps = new Set(prevState.processingOperations)

        const updatedOp = newOperationQueue.get(operationId)
        if (updatedOp) {
          newOperationQueue.set(operationId, { ...updatedOp, status: 'completed' })
        }

        newProcessingOps.delete(operationId)

        setTimeout(() => {
          set((state) => {
            const newOps = new Map(state.operationQueue)
            newOps.delete(operationId)
            return { operationQueue: newOps }
          })
        }, 5000)

        return {
          operationQueue: newOperationQueue,
          processingOperations: newProcessingOps
        }
      })
    } catch (error) {
      set((prevState) => {
        const newCardsMap = new Map(prevState.cardsMap)
        const newOperationQueue = new Map(prevState.operationQueue)
        const newProcessingOps = new Set(prevState.processingOperations)

        if (!newCardsMap.has(id) && originalCard) {
          newCardsMap.set(id, originalCard)
        }

        const updatedOp = newOperationQueue.get(operationId)
        if (updatedOp) {
          newOperationQueue.set(operationId, {
            ...updatedOp,
            status: 'failed',
            retryCount: (updatedOp.retryCount || 0) + 1
          })
        }

        newProcessingOps.delete(operationId)

        setTimeout(() => {
          set((state) => {
            const newOps = new Map(state.operationQueue)
            newOps.delete(operationId)
            return { operationQueue: newOps }
          })
        }, 10000)

        return {
          cardsMap: newCardsMap,
          operationQueue: newOperationQueue,
          processingOperations: newProcessingOps
        }
      })

      const errorMessage = error instanceof Error ? error.message : '移除卡片失败'
      set({ error: errorMessage })
      throw error
    }
  },

  reorderCards: async (updates: Array<{ id: number; sortOrder: number }>) => {
    const originalCards = new Map<number, NodeCard>()
    updates.forEach(({ id }) => {
      const card = get().cardsMap.get(id)
      if (card) originalCards.set(id, { ...card })
    })

    // Optimistic update
    set((state) => {
      const newCardsMap = new Map(state.cardsMap)
      updates.forEach(({ id, sortOrder }) => {
        const card = newCardsMap.get(id)
        if (card) {
          newCardsMap.set(id, { ...card, sortOrder })
        }
      })
      return { cardsMap: newCardsMap }
    })

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

      // Revert on error - only for the specific cards that were being reordered
      set((state) => {
        const revertedCardsMap = new Map(state.cardsMap)
        originalCards.forEach((card, id) => {
          if (revertedCardsMap.has(id)) {
            revertedCardsMap.set(id, card)
          }
        })
        return { cardsMap: revertedCardsMap }
      })
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
  addFolder: async (folder: Omit<NodePoolFolder, 'id' | 'createdAt' | 'userId'>) => {
    const tempId = generateTempId()

    const tempFolder = {
      id: tempId,
      userId: 0, // Will be set by server
      ...folder,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      children: []
    }

    set((state) => {
      const newFoldersMap = new Map(state.foldersMap)
      newFoldersMap.set(tempId, tempFolder)
      return { foldersMap: newFoldersMap }
    })

    try {
      const created = await api.createNodePoolFolder(folder)

      set((state) => {
        const newFoldersMap = new Map(state.foldersMap)

        // If temporary folder was removed while API call was in flight, discard the real folder
        if (!newFoldersMap.has(tempId)) {
          api.deleteNodePoolFolder(created.id).catch(() => {
            // Silently ignore cleanup errors
          })
          return state
        }

        newFoldersMap.delete(tempId)
        newFoldersMap.set(created.id, { ...created, children: [] })
        return { foldersMap: newFoldersMap }
      })

      return created
    } catch (error) {
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
        // If folder was removed from store while API call was in flight, do not re-add it
        if (!state.foldersMap.has(id)) return { isLoading: false }

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
    const originalFolder = get().foldersMap.get(id)
    if (!originalFolder) return

    const originalFoldersMap = new Map(get().foldersMap)

    set((state) => {
      const newFoldersMap = new Map(state.foldersMap)
      newFoldersMap.delete(id)
      return { foldersMap: newFoldersMap }
    })

    try {
      await api.deleteNodePoolFolder(id)
    } catch (error) {
      set({ foldersMap: originalFoldersMap })

      const errorMessage = error instanceof Error ? error.message : '移除文件夹失败'
      set({ error: errorMessage })
      throw error
    }
  },

  reorderFolders: async (updates: Array<{ id: number; sortOrder: number }>) => {
    const originalFolders = new Map<number, NodePoolFolder>()
    updates.forEach(({ id }) => {
      const folder = get().foldersMap.get(id)
      if (folder) originalFolders.set(id, { ...folder })
    })

    // Optimistic update
    set((state) => {
      const newFoldersMap = new Map(state.foldersMap)
      updates.forEach(({ id, sortOrder }) => {
        const folder = newFoldersMap.get(id)
        if (folder) {
          newFoldersMap.set(id, { ...folder, sortOrder })
        }
      })
      return { foldersMap: newFoldersMap }
    })

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

      // Revert on error - only for the specific folders that were being reordered
      set((state) => {
        const revertedFoldersMap = new Map(state.foldersMap)
        originalFolders.forEach((folder, id) => {
          if (revertedFoldersMap.has(id)) {
            revertedFoldersMap.set(id, folder)
          }
        })
        return { foldersMap: revertedFoldersMap }
      })
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
      pendingCardIds: new Set(),
      operationQueue: new Map(),
      temporaryCards: new Map(),
      processingOperations: new Set(),
    })
  },

  // ========== State Validation ==========

  validateAndFixState: () => {
    const fixes: string[] = []

    set((prevState) => {
      const newCardsMap = new Map(prevState.cardsMap)
      const newPendingCardIds = new Set(prevState.pendingCardIds)
      const newTemporaryCards = new Map(prevState.temporaryCards)
      const newOperationQueue = new Map(prevState.operationQueue)

      // Fix 1: Remove cards that are in pending but not in cardsMap
      for (const id of newPendingCardIds) {
        if (!newCardsMap.has(id) && !newTemporaryCards.has(id)) {
          newPendingCardIds.delete(id)
          fixes.push(`Removed stale pending ID: ${id}`)
        }
      }

      // Fix 2: Add IDs to pending if card exists but not in pending
      for (const [id, _tempCard] of newTemporaryCards) {
        if (!newPendingCardIds.has(id)) {
          newPendingCardIds.add(id)
          fixes.push(`Added missing pending ID: ${id}`)
        }
      }

      // Fix 3: Remove temporary cards without operations
      for (const [id, tempCard] of newTemporaryCards) {
        if (!newOperationQueue.has(tempCard.operationId)) {
          newCardsMap.delete(id)
          newTemporaryCards.delete(id)
          newPendingCardIds.delete(id)
          fixes.push(`Removed orphaned temporary card: ${id}`)
        }
      }

      // Fix 4: Remove completed/failed operations older than 60 seconds
      const now = Date.now()
      for (const [opId, op] of newOperationQueue) {
        if ((op.status === 'completed' || op.status === 'failed') && now - op.timestamp > 60000) {
          newOperationQueue.delete(opId)
          fixes.push(`Cleaned up old operation: ${opId}`)
        }
      }

      // Fix 5: Clear processing operations that are stuck
      const newProcessingOps = new Set(prevState.processingOperations)
      for (const opId of newProcessingOps) {
        const op = newOperationQueue.get(opId)
        if (!op || op.status !== 'processing') {
          newProcessingOps.delete(opId)
          fixes.push(`Cleared stuck processing operation: ${opId}`)
        }
      }

      return {
        cardsMap: newCardsMap,
        pendingCardIds: newPendingCardIds,
        temporaryCards: newTemporaryCards,
        operationQueue: newOperationQueue,
        processingOperations: newProcessingOps
      }
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
