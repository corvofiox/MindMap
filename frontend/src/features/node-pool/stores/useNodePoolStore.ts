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
import { createNodeFromCard, parseCardNodeData } from '../utils/createNodeFromCard'

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

function resolveRealCardId(id: number): number | null {
  if (id > 0) return id

  const state = useNodePoolStore.getState()

  const tempCard = state.temporaryCards.get(id)
  if (tempCard?.realCardId) {
    return tempCard.realCardId
  }

  for (const [, op] of state.operationQueue) {
    if (op.cardId === id && op.realCardId) {
      return op.realCardId
    }
  }

  return null
}

export const useNodePoolStore = create<NodePoolStore>((set, get) => {
  /**
   * Serialize async operations that mutate a specific card.
   * Prevents duplicate API calls when the user rapidly clicks use/delete/update.
   */
  const withCardLock = async (cardId: number, operation: () => Promise<void>) => {
    if (get().processingCardIds.has(cardId)) {
      return
    }
    set((state) => ({
      processingCardIds: new Set([...state.processingCardIds, cardId]),
    }))
    try {
      await operation()
    } finally {
      set((state) => {
        const next = new Set(state.processingCardIds)
        next.delete(cardId)
        return { processingCardIds: next }
      })
    }
  }

  return {
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
  processingCardIds: new Set<number>(),
  pendingUpdates: new Map<number, Partial<NodeCard>>(),

  // ========== Card Actions ==========

  getCard: (id: number) => {
    return get().cardsMap.get(id)
  },

  useCard: async (card: NodeCard, addNodeToCanvas: (node: any) => void) => {
    const cardId = card.id

    const state = get()

    const tempCard = state.temporaryCards.get(cardId)
    const realCard = state.cardsMap.get(cardId)
    const resolvedRealId = resolveRealCardId(cardId)

    const actualCard = realCard || tempCard?.card

    if (!actualCard && !resolvedRealId) {
      return
    }

    const effectiveCard = actualCard || state.cardsMap.get(resolvedRealId!)
    if (!effectiveCard) {
      return
    }

    return withCardLock(cardId, async () => {
    const operationId = generateOperationId()

    const operation: Operation = {
      id: operationId,
      type: 'remove',
      status: 'pending',
      cardId: cardId,
      realCardId: resolvedRealId,
      timestamp: Date.now(),
      retryCount: 0
    }

    try {
      const freshTempCard = get().temporaryCards.get(cardId)
      if (freshTempCard?.card._markedForDeletion) {
        return
      }

      const nodeData = parseCardNodeData(effectiveCard)
      const newNode = createNodeFromCard(effectiveCard, {
        x: (nodeData.x ?? 0) + 50,
        y: (nodeData.y ?? 0) + 50,
      })

      addNodeToCanvas(newNode)

      let latestRealId: number | null = resolvedRealId

      set((state) => {
        const newCardsMap = new Map(state.cardsMap)
        const newPendingCardIds = new Set(state.pendingCardIds)
        const newOperationQueue = new Map(state.operationQueue)
        const newTemporaryCards = new Map(state.temporaryCards)
        const newProcessingOps = new Set(state.processingOperations)
        const newPendingUpdates = new Map(state.pendingUpdates)

        newCardsMap.delete(cardId)

        const currentTempCard = newTemporaryCards.get(cardId)
        const currentRealId = currentTempCard?.realCardId || resolvedRealId
        if (currentRealId) {
          newCardsMap.delete(currentRealId)
          latestRealId = currentRealId
        }

        newPendingCardIds.delete(cardId)
        newPendingUpdates.delete(cardId)

        if (currentTempCard) {
          newTemporaryCards.set(cardId, {
            ...currentTempCard,
            card: { ...currentTempCard.card, _markedForDeletion: true }
          })
        } else {
          newTemporaryCards.delete(cardId)
        }

        newOperationQueue.set(operationId, operation)
        newProcessingOps.add(operationId)

        return {
          cardsMap: newCardsMap,
          pendingCardIds: newPendingCardIds,
          operationQueue: newOperationQueue,
          temporaryCards: newTemporaryCards,
          processingOperations: newProcessingOps,
          pendingUpdates: newPendingUpdates
        }
      })

      if (!latestRealId) {
        latestRealId = resolveRealCardId(cardId)
      }
      const apiCardId = latestRealId || (cardId > 0 ? cardId : null)
      if (apiCardId) {
        await api.removeFromNodePool(apiCardId)
      }

      set(() => {
        const currentOpQueue = new Map(useNodePoolStore.getState().operationQueue)
        const currentProcessingOps = new Set(useNodePoolStore.getState().processingOperations)

        const updatedOp = currentOpQueue.get(operationId)
        if (updatedOp) {
          currentOpQueue.set(operationId, { ...updatedOp, status: 'completed' })
        }

        currentProcessingOps.delete(operationId)

        setTimeout(() => {
          set((state) => {
            const newOps = new Map(state.operationQueue)
            newOps.delete(operationId)
            return { operationQueue: newOps }
          })
        }, 5000)

        return {
          operationQueue: currentOpQueue,
          processingOperations: currentProcessingOps
        }
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '使用节点失败'
      set({ error: errorMessage })
      throw error
    }
    })
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
        const newPendingUpdates = new Map(state.pendingUpdates)

        const tempCardData = newTemporaryCards.get(tempId)

        const shouldDelete = tempCardData?.card?._markedForDeletion === true

        newCardsMap.delete(tempId)
        newPendingCardIds.delete(tempId)

        // If should delete, discard the real card
        if (shouldDelete) {
          newTemporaryCards.delete(tempId)
          newPendingUpdates.delete(tempId)
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
            processingOperations: newProcessingOps,
            pendingUpdates: newPendingUpdates
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

          // Apply pending updates that were queued while card was being created
          const pendingUpdate = newPendingUpdates.get(tempId)
          if (pendingUpdate) {
            Object.assign(finalCard, pendingUpdate)
            newPendingUpdates.delete(tempId)
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

          // Sync pending updates with server
          if (pendingUpdate) {
            api.updateNodeCard(created.id, pendingUpdate).catch(() => {
              // Silently ignore sync errors - client state is already correct
            })
          }

          return {
            cardsMap: newCardsMap,
            pendingCardIds: newPendingCardIds,
            operationQueue: newOperationQueue,
            temporaryCards: newTemporaryCards,
            processingOperations: newProcessingOps,
            pendingUpdates: newPendingUpdates
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
        const newPendingUpdates = new Map(state.pendingUpdates)

        // Remove temporary card
        newCardsMap.delete(tempId)
        newPendingCardIds.delete(tempId)
        newTemporaryCards.delete(tempId)
        newPendingUpdates.delete(tempId)

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
          processingOperations: newProcessingOps,
          pendingUpdates: newPendingUpdates
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
      if (id < 0) {
        const resolvedId = resolveRealCardId(id)
        if (resolvedId) {
          return get().updateCard(resolvedId, data)
        }
      }
      return
    }

    const tempCard = get().temporaryCards.get(id)
    if (tempCard?.card._markedForDeletion) {
      return
    }

    if (id < 0 && tempCard?.realCardId) {
      return get().updateCard(tempCard.realCardId, data)
    }

    return withCardLock(id, async () => {
    if (isPendingCard) {
      set((state) => {
        const newCardsMap = new Map(state.cardsMap)
        const updatedCard = { ...originalCard, ...data }
        newCardsMap.set(id, updatedCard)

        const newTemporaryCards = new Map(state.temporaryCards)
        const existingTempCard = newTemporaryCards.get(id)
        if (existingTempCard) {
          newTemporaryCards.set(id, {
            ...existingTempCard,
            card: { ...existingTempCard.card, ...data }
          })
        }

        const newPendingUpdates = new Map(state.pendingUpdates)
        const existingUpdates = newPendingUpdates.get(id)
        newPendingUpdates.set(id, { ...existingUpdates, ...data })

        return {
          cardsMap: newCardsMap,
          temporaryCards: newTemporaryCards,
          pendingUpdates: newPendingUpdates
        }
      })
      return
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
    })
  },

  removeCard: async (id: number) => {
    const state = get()

    const originalCard = state.cardsMap.get(id)
    const temporaryCard = state.temporaryCards.get(id)
    const resolvedRealId = resolveRealCardId(id)

    if (!originalCard && !temporaryCard && !resolvedRealId) {
      return
    }

    const effectiveRealId = resolvedRealId
    const realCard = effectiveRealId ? state.cardsMap.get(effectiveRealId) : null

    return withCardLock(id, async () => {
    const operationId = generateOperationId()

    const operation: Operation = {
      id: operationId,
      type: 'remove',
      status: 'pending',
      cardId: id,
      realCardId: effectiveRealId || (id > 0 ? id : null),
      timestamp: Date.now(),
      retryCount: 0
    }

    let latestRealId: number | null = effectiveRealId

    set((prevState) => {
      const newCardsMap = new Map(prevState.cardsMap)
      const newPendingCardIds = new Set(prevState.pendingCardIds)
      const newOperationQueue = new Map(prevState.operationQueue)
      const newTemporaryCards = new Map(prevState.temporaryCards)
      const newPendingUpdates = new Map(prevState.pendingUpdates)

      newCardsMap.delete(id)

      const currentTempCard = newTemporaryCards.get(id)
      const currentRealId = currentTempCard?.realCardId || effectiveRealId
      if (currentRealId) {
        newCardsMap.delete(currentRealId)
        latestRealId = currentRealId
      }

      newPendingCardIds.delete(id)
      newPendingUpdates.delete(id)

      if (currentTempCard) {
        newTemporaryCards.set(id, {
          ...currentTempCard,
          card: { ...currentTempCard.card, _markedForDeletion: true }
        })
      } else {
        newTemporaryCards.delete(id)
      }

      newOperationQueue.set(operationId, operation)

      return {
        cardsMap: newCardsMap,
        pendingCardIds: newPendingCardIds,
        operationQueue: newOperationQueue,
        temporaryCards: newTemporaryCards,
        pendingUpdates: newPendingUpdates
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

      if (!latestRealId) {
        latestRealId = resolveRealCardId(id)
      }
      const apiCardId = latestRealId || (id > 0 ? id : null)
      if (apiCardId) {
        await api.removeFromNodePool(apiCardId)
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
        const newTemporaryCards = new Map(prevState.temporaryCards)

        if (!newCardsMap.has(id) && originalCard) {
          newCardsMap.set(id, originalCard)
        }
        if (latestRealId && !newCardsMap.has(latestRealId) && realCard) {
          newCardsMap.set(latestRealId, realCard)
        }

        const currentTempCard = newTemporaryCards.get(id)
        if (currentTempCard?.card._markedForDeletion) {
          const { _markedForDeletion, ...cardWithoutFlag } = currentTempCard.card as any
          newTemporaryCards.set(id, {
            ...currentTempCard,
            card: cardWithoutFlag as NodeCard
          })
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
          processingOperations: newProcessingOps,
          temporaryCards: newTemporaryCards
        }
      })

      const errorMessage = error instanceof Error ? error.message : '移除卡片失败'
      set({ error: errorMessage })
      throw error
    }
    })
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
      pendingUpdates: new Map(),
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
      const newPendingUpdates = new Map(prevState.pendingUpdates)

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
          newPendingUpdates.delete(id)
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

      // Fix 6: Remove pending updates for temp IDs that no longer exist
      for (const [id] of newPendingUpdates) {
        if (!newTemporaryCards.has(id) && !newCardsMap.has(id)) {
          newPendingUpdates.delete(id)
          fixes.push(`Removed stale pending update for: ${id}`)
        }
      }

      return {
        cardsMap: newCardsMap,
        pendingCardIds: newPendingCardIds,
        temporaryCards: newTemporaryCards,
        operationQueue: newOperationQueue,
        processingOperations: newProcessingOps,
        pendingUpdates: newPendingUpdates
      }
    })
  },
  }
})

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
