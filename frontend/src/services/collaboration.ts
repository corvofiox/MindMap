/**
 * Legacy collaboration service shim.
 *
 * The real-time collaboration layer has been migrated to Yjs (see yjsProvider.ts
 * and yjsBinding.ts). This module is kept as a thin compatibility shim so that
 * existing call sites (CanvasPage, FabricCanvas, NodeItem) keep compiling while
 * they are progressively refactored to use the new Yjs-based APIs directly.
 *
 * All methods here are either no-ops or delegate to the Yjs provider. The
 * version-number, ACK/NAK, pending, and offline-queue machinery has been
 * removed entirely — Yjs handles all of that natively.
 */

import { isCollabConnected } from '@/hooks/useCollaboration'
import { logger } from '@/utils/logger'

// Re-export BatchOperations shape so call sites that type against it still work.
export interface BatchOperations {
  addedNodes?: unknown[]
  updatedNodes?: unknown[]
  removedNodeIds?: string[]
  addedGroups?: unknown[]
  updatedGroups?: unknown[]
  removedGroupIds?: string[]
  addedDomains?: unknown[]
  updatedDomains?: unknown[]
  removedDomainIds?: string[]
  addedConnections?: unknown[]
  updatedConnections?: unknown[]
  removedConnectionIds?: string[]
}

/** No-op shim for the legacy sendBatch. Yjs auto-syncs store mutations. */
export function batchToOperations(_batch: BatchOperations): Array<{ operation: string; data: unknown }> {
  return []
}

/** No-op shim retained for the legacy test suite (collaboration.test.ts). */
export function queueToBatch(_queue: unknown[]): BatchOperations {
  return {}
}

/**
 * Compatibility singleton. All methods are no-ops or trivial delegates.
 * Callers should migrate to useCollaboration / getActiveYjsProvider instead.
 */
class CollaborationService {
  /**
   * Backwards-compatible flag. Existing CanvasPage code toggles this around
   * store mutations to suppress echo; with Yjs the binding handles that via
   * isApplyingRemoteChanges, so this field is vestigial but kept assignable.
   */
  isApplyingRemoteUpdate = false

  isConnected(): boolean {
    return isCollabConnected()
  }

  /** Yjs has no global version; return 0 so REST callers send a benign value. */
  getServerVersion(): number {
    return 0
  }

  /** No-op. */
  setServerVersion(_v: number): void {
    // intentionally empty
  }

  /** No-op. */
  requestSync(): void {
    // Yjs auto-syncs; nothing to do.
  }

  /** No-op. Remote cursor is now driven via awareness. */
  sendCursor(_x: number, _y: number): void {
    // handled by useCollaboration.sendCursor via the provider
  }

  /** No-op. Updates are auto-synced through the store's syncDiffToYDoc. */
  sendOperation(_operation: string, _data: unknown): void {
    // intentionally empty
  }

  /** No-op. */
  sendBatch(_batch: BatchOperations): void {
    // intentionally empty
  }

  /** No-op (formerly a no-op, now handled directly by the Yjs binding's
   *  startInteraction/endInteraction in yjsBinding.ts). */
  startInteraction(_nodeId: string, _field?: string): void {
    logger.warn('[collab] startInteraction is deprecated — use getYjsBinding().startInteraction()')
  }

  /** No-op. */
  endInteraction(_nodeId: string): void {
    logger.warn('[collab] endInteraction is deprecated — use getYjsBinding().endInteraction()')
  }
}

export const collabService = new CollaborationService()
