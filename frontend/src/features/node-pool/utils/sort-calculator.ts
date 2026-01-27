/**
 * Sort Calculator Utility
 *
 * Efficient sorting calculations with O(n) complexity.
 * Provides functions for reordering items within a list.
 */

import type { ReorderOperation, ReorderResult, SortCalculateOptions } from '../types/node-pool.js'

/**
 * Default options for sort calculations
 */
const DEFAULT_OPTIONS: Required<SortCalculateOptions> = {
  step: 10,
  minSortOrder: 0,
}

/**
 * Calculate the new sort orders after reordering an item
 *
 * @param items - Array of items to reorder
 * @param oldIndex - Current index of the item being moved
 * @param newIndex - Target index for the item
 * @param options - Sort calculation options
 * @returns Reorder result with updates and indices
 *
 * @example
 * const items = [{ id: 1, sortOrder: 0 }, { id: 2, sortOrder: 10 }, { id: 3, sortOrder: 20 }]
 * const result = calculateReorder(items, 0, 2)
 * // Result: updates = [{ id: 1, sortOrder: 20 }, { id: 2, sortOrder: 0 }, { id: 3, sortOrder: 10 }]
 */
export function calculateReorder(
  items: Array<{ id: number; sortOrder: number }>,
  oldIndex: number,
  newIndex: number,
  options: SortCalculateOptions = {}
): ReorderResult {
  const { step } = { ...DEFAULT_OPTIONS, ...options }

  // Validate indices
  if (oldIndex < 0 || oldIndex >= items.length) {
    throw new Error(`oldIndex ${oldIndex} out of bounds [0, ${items.length})`)
  }
  if (newIndex < 0 || newIndex >= items.length) {
    throw new Error(`newIndex ${newIndex} out of bounds [0, ${items.length})`)
  }

  // If indices are the same, no change needed
  if (oldIndex === newIndex) {
    return {
      updates: [],
      newIndex: oldIndex,
      oldIndex,
    }
  }

  // Create a copy of items and move the item
  const reorderedItems = [...items]
  const [movedItem] = reorderedItems.splice(oldIndex, 1)
  reorderedItems.splice(newIndex, 0, movedItem)

  // Recalculate sort orders
  const updates = reorderedItems.map((item, index) => ({
    id: item.id,
    sortOrder: index * step,
  }))

  return {
    updates,
    newIndex,
    oldIndex,
  }
}

/**
 * Calculate reorder based on target item and position (before/after)
 *
 * @param items - Array of items in the current order
 * @param itemId - ID of the item being moved
 * @param targetId - ID of the target item
 * @param position - Position relative to target ('before' | 'after')
 * @param options - Sort calculation options
 * @returns Reorder result with updates and indices
 */
export function calculateReorderByTarget(
  items: Array<{ id: number; sortOrder: number }>,
  itemId: number,
  targetId: number,
  position: 'before' | 'after',
  options: SortCalculateOptions = {}
): ReorderResult {
  const oldIndex = items.findIndex(item => item.id === itemId)
  const targetIndex = items.findIndex(item => item.id === targetId)

  if (oldIndex === -1) {
    throw new Error(`Item with id ${itemId} not found`)
  }
  if (targetIndex === -1) {
    throw new Error(`Target item with id ${targetId} not found`)
  }

  // Calculate new index based on position
  let newIndex: number

  if (position === 'after') {
    // Place after target
    if (oldIndex < targetIndex) {
      // Moving forward: place at targetIndex (target shifts left)
      newIndex = targetIndex
    } else {
      // Moving backward: place at targetIndex + 1
      newIndex = targetIndex + 1
    }
  } else {
    // Place before target
    if (oldIndex < targetIndex) {
      // Moving forward: place at targetIndex - 1
      newIndex = targetIndex - 1
    } else {
      // Moving backward: place at targetIndex
      newIndex = targetIndex
    }
  }

  // Ensure new index is within bounds
  newIndex = Math.max(0, Math.min(items.length - 1, newIndex))

  return calculateReorder(items, oldIndex, newIndex, options)
}

/**
 * Get items at the same level (same folder or parent)
 *
 * @param allItems - All items
 * @param itemId - ID of the item to get level for
 * @param getFolderId - Function to get folder ID from item
 * @returns Items at the same level
 */
export function getItemsAtSameLevel<T extends { id: number }>(
  allItems: T[],
  itemId: number,
  getFolderId: (item: T) => number | null
): T[] {
  const item = allItems.find(i => i.id === itemId)
  if (!item) return []

  const folderId = getFolderId(item)
  return allItems.filter(i => getFolderId(i) === folderId)
}

/**
 * Create a reorder operation from drag data
 *
 * @param activeId - ID of the dragged item
 * @param overId - ID of the drop target
 * @param position - Drop position
 * @param folderId - Folder ID for cards
 * @returns Reorder operation
 */
export function createReorderOperation(
  activeId: number,
  overId: number,
  position: 'before' | 'after',
  folderId: number | null = null
): ReorderOperation {
  return {
    type: folderId !== null ? 'reorder-card' : 'reorder-folder',
    itemId: activeId,
    targetId: overId,
    position,
    folderId,
    parentId: folderId, // For cards, folderId acts as parent
  }
}

/**
 * Validate if a reorder operation is valid
 *
 * @param operation - Reorder operation to validate
 * @param items - Items to validate against
 * @returns True if valid, false otherwise
 */
export function validateReorderOperation(
  operation: ReorderOperation,
  items: Array<{ id: number }>
): boolean {
  // Cannot reorder item to itself
  if (operation.itemId === operation.targetId) {
    return false
  }

  // Both items must exist
  const itemExists = items.some(i => i.id === operation.itemId)
  const targetExists = items.some(i => i.id === operation.targetId)

  return itemExists && targetExists
}

/**
 * Batch multiple reorder operations into a single update
 *
 * @param items - All items
 * @param operations - Reorder operations to batch
 * @param options - Sort calculation options
 * @returns Combined reorder result
 */
export function batchReorderOperations(
  items: Array<{ id: number; sortOrder: number }>,
  operations: ReorderOperation[],
  options: SortCalculateOptions = {}
): ReorderResult {
  const { step } = { ...DEFAULT_OPTIONS, ...options }

  // Start with current items
  let currentItems = [...items]
  let allUpdates: Array<{ id: number; sortOrder: number }> = []

  // Apply operations in sequence
  for (const op of operations) {
    // Filter items at the same level
    const levelItems = op.type === 'reorder-card'
      ? currentItems.filter(item => {
          const card = currentItems.find(i => i.id === item.id)
          return card !== undefined // This is a simplified check
        })
      : currentItems

    const result = calculateReorderByTarget(
      levelItems,
      op.itemId,
      op.targetId,
      op.position,
      options
    )

    // Apply the reorder
    const movedItem = levelItems[result.oldIndex]
    const reorderedLevelItems = [...levelItems]
    reorderedLevelItems.splice(result.oldIndex, 1)
    reorderedLevelItems.splice(result.newIndex, 0, movedItem)

    // Update sort orders in level items
    const updatedLevelItems = reorderedLevelItems.map((item, index) => ({
      ...item,
      sortOrder: index * step,
    }))

    // Merge back into current items
    currentItems = currentItems.map(item => {
      const updated = updatedLevelItems.find(u => u.id === item.id)
      return updated || item
    })

    allUpdates = [...allUpdates, ...result.updates]
  }

  // Deduplicate updates (last update for each id wins)
  const updatesMap = new Map(allUpdates.map(u => [u.id, u]))

  return {
    updates: Array.from(updatesMap.values()),
    newIndex: operations.length > 0
      ? currentItems.findIndex(i => i.id === operations[operations.length - 1].itemId)
      : 0,
    oldIndex: operations.length > 0
      ? items.findIndex(i => i.id === operations[operations.length - 1].itemId)
      : 0,
  }
}
