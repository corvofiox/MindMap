/**
 * Node Pool Feature - Type Definitions
 *
 * This file contains all type definitions for the node pool feature.
 * It provides complete type safety and eliminates the need for 'any' types.
 */

// Import and re-export base types from the main types file
import type { NodeCard, NodePoolFolder, NodePoolSortOption, NodePoolSortOrder } from '@/types'
export type { NodeCard, NodePoolFolder }

/**
 * The drop position relative to the target item
 */
export type DropPosition = 'before' | 'after' | 'inside'

/**
 * Complete drag state
 */
export interface DragState {
  /** The item currently being dragged (if any) */
  active: any | null
  /** The item currently being dragged over (if any) */
  over: any | null
}

/**
 * Node Pool Store state
 */
export interface NodePoolStore {
  /** Map of cards for O(1) lookup */
  cardsMap: Map<number, NodeCard>
  /** Map of folders for O(1) lookup */
  foldersMap: Map<number, NodePoolFolder>
  /** Current drag state */
  dragState: DragState
  /** Loading state */
  isLoading: boolean
  /** Error message */
  error: string | null

  // Card actions
  getCard: (id: number) => NodeCard | undefined
  setCards: (cards: NodeCard[]) => void
  loadNodePool: (projectId: number) => Promise<void>
  addCard: (projectId: number, data: Omit<NodeCard, 'id' | 'createdAt' | 'useCount'>) => Promise<NodeCard>
  updateCard: (id: number, data: Partial<NodeCard>) => Promise<void>
  removeCard: (id: number) => Promise<void>
  reorderCards: (updates: Array<{ id: number; sortOrder: number }>) => Promise<void>

  // Folder actions
  getFolder: (id: number) => NodePoolFolder | undefined
  setFolders: (folders: NodePoolFolder[]) => void
  addFolder: (folder: Omit<NodePoolFolder, 'id' | 'createdAt'>) => Promise<NodePoolFolder>
  updateFolder: (id: number, data: Partial<NodePoolFolder>) => Promise<void>
  removeFolder: (id: number) => Promise<void>
  reorderFolders: (updates: Array<{ id: number; sortOrder: number }>) => Promise<void>
  toggleFolderCollapsed: (id: number) => void

  // Drag state actions
  setDragState: (dragState: DragState) => void
  clearDragState: () => void

  // Utility actions
  clearError: () => void
  reset: () => void
}

/**
 * A reordering operation to be executed
 */
export interface ReorderOperation {
  /** Type of reorder operation */
  type: 'reorder-folder' | 'reorder-card'
  /** ID of the item being reordered */
  itemId: number
  /** ID of the target item (to reorder before/after) */
  targetId: number
  /** Where to place the item relative to the target */
  position: 'before' | 'after'
  /** For cards: the folder containing both items */
  folderId: number | null
  /** For folders: the parent containing both folders */
  parentId: number | null
}

/**
 * Result of a reorder calculation
 */
export interface ReorderResult {
  /** Items with updated sort orders */
  updates: Array<{ id: number; sortOrder: number }>
  /** New index of the dragged item */
  newIndex: number
  /** Old index of the dragged item */
  oldIndex: number
}

/**
 * Sort calculation options
 */
export interface SortCalculateOptions {
  /** Current sort order step (default: 10) */
  step?: number
  /** Minimum sort order (default: 0) */
  minSortOrder?: number
}

/**
 * Options for useNodePoolSort hook
 */
export interface UseNodePoolSortOptions {
  /** Whether to enable sorting */
  enabled?: boolean
  /** Sort by field (name, createdAt, or useCount) */
  sortBy?: NodePoolSortOption
  /** Sort order (asc or desc) */
  sortOrder?: NodePoolSortOrder
}

/**
 * Return value for useNodePoolSort hook
 */
export interface UseNodePoolSortReturn {
  /** Sorted folders at root level */
  sortedRootFolders: NodePoolFolder[]
  /** Sorted cards grouped by folder ID (null = root level) */
  sortedCardsByFolder: Map<number | null, NodeCard[]>
  /** Function to get the position of an item */
  getItemPosition: (id: number, type: 'folder' | 'card') => { index: number; folderId: number | null } | null
  /** Function to handle reordering */
  handleReorder: (operation: ReorderOperation) => Promise<void>
}

/**
 * Props for FolderItem component
 */
export interface FolderItemProps {
  /** Folder data */
  folder: NodePoolFolder
  /** Nesting depth level */
  level?: number
  /** Cards in this folder */
  cards: NodeCard[]
  /** Child folders */
  children: NodePoolFolder[]
  /** Whether folder is being dragged over */
  isDragOver: boolean
  /** Drag over position */
  dragOverPosition: DropPosition | null
  /** Callback to toggle folder collapse state */
  onToggle?: (id: number) => void
  /** Callback to show context menu for folder */
  onContextMenu?: (event: React.MouseEvent, folder: NodePoolFolder) => void
  /** Callback to show context menu for card */
  onCardContextMenu?: (event: React.MouseEvent, card: NodeCard) => void
  /** ID of card currently showing preview */
  previewCardId?: number | null
  /** Callback to toggle preview */
  onTogglePreview?: (cardId: number | null) => void
  /** Callback when a card is dropped on this folder */
  onDrop?: (e: React.DragEvent, folder: NodePoolFolder) => void
  /** Callback when dragging over this folder */
  onDragOver?: (e: React.DragEvent, folder: NodePoolFolder) => void
  /** Callback when dragging leaves this folder */
  onDragLeave?: (e: React.DragEvent, folder: NodePoolFolder) => void
  /** Callback to start editing folder name */
  onStartEdit?: (folder: NodePoolFolder) => void
  /** Callback to save folder name */
  onSaveEdit?: (folderId: number, name: string) => Promise<void>
  /** Callback to cancel editing */
  onCancelEdit?: () => void
  /** ID of folder currently being edited */
  editingFolderId?: number | null
  /** Callback to use a card */
  onUseCard?: (card: NodeCard) => void
  /** Callback to remove a card */
  onRemoveCard?: (id: number) => void
  /** Callback to save card name */
  onSaveCardName?: (id: number, name: string) => void
  /** ID of card currently being edited */
  editingCardId?: number | null
  /** Callback to start editing a card */
  onStartCardEdit?: (card: NodeCard) => void
}

/**
 * Props for NodeCardItem component
 */
export interface NodeCardItemProps {
  /** Card data */
  card: NodeCard
  /** Whether card is being dragged */
  isDragging: boolean
  /** Whether card is being dragged over */
  isDragOver: boolean
  /** Drag over position */
  dragOverPosition: DropPosition | null
  /** Callback to use the card */
  onUse: (card: NodeCard) => void
  /** Callback to remove the card */
  onRemove: (id: number) => void
  /** Callback to save card name */
  onSaveName: (id: number, name: string) => void
  /** Callback to show context menu */
  onContextMenu?: (event: React.MouseEvent, card: NodeCard) => void
  /** Whether this card's preview is shown */
  showPreview?: boolean
  /** Callback to toggle preview */
  onTogglePreview?: (cardId: number | null) => void
}
