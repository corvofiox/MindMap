import type { Node, NodeGroup, Domain, Connection } from '@/types'

export interface BatchOperations {
  addedNodes?: Node[]
  updatedNodes?: { id: string; updates: Partial<Node> }[]
  removedNodeIds?: string[]
  addedGroups?: NodeGroup[]
  updatedGroups?: { id: string; updates: Partial<NodeGroup> }[]
  removedGroupIds?: string[]
  addedDomains?: Domain[]
  updatedDomains?: { id: string; updates: Partial<Domain> }[]
  removedDomainIds?: string[]
  addedConnections?: Connection[]
  updatedConnections?: { id: string; updates: Partial<Connection> }[]
  removedConnectionIds?: string[]
}

export interface FieldChange {
  field: string
  newValue: unknown
  timestamp: number
}

export interface PendingNodeChanges {
  nodeId: string
  changes: Map<string, FieldChange>
}

export interface PendingConnectionChanges {
  connectionId: string
  changes: Map<string, FieldChange>
}

export interface PendingGroupChanges {
  groupId: string
  changes: Map<string, FieldChange>
}

export interface PendingDomainChanges {
  domainId: string
  changes: Map<string, FieldChange>
}

/**
 * Pending remove tracking: entity IDs the local user has deleted but
 * haven't been ACKed by the server yet. Used in handleSync to re-apply
 * removals after a NAK→resync cycle so deleted entities don't "resurrect".
 */
export interface PendingRemoves {
  nodeIds: Set<string>
  groupIds: Set<string>
  domainIds: Set<string>
  connectionIds: Set<string>
}

export function prunePendingFields<P extends { changes: Map<string, FieldChange> }>(
  map: Map<string, P>,
  id: string,
  updates: Record<string, unknown>,
  cutoff: number
): void {
  const pending = map.get(id)
  if (!pending) return
  for (const field of Object.keys(updates)) {
    const change = pending.changes.get(field)
    if (change && change.timestamp <= cutoff) {
      pending.changes.delete(field)
    }
  }
  if (pending.changes.size === 0) {
    map.delete(id)
  }
}

export function clearPendingRemoves(
  batch: BatchOperations,
  pendingRemoves: PendingRemoves,
): void {
  if (batch.removedNodeIds) {
    for (const id of batch.removedNodeIds) {
      pendingRemoves.nodeIds.delete(id)
    }
  }
  if (batch.removedGroupIds) {
    for (const id of batch.removedGroupIds) {
      pendingRemoves.groupIds.delete(id)
    }
  }
  if (batch.removedDomainIds) {
    for (const id of batch.removedDomainIds) {
      pendingRemoves.domainIds.delete(id)
    }
  }
  if (batch.removedConnectionIds) {
    for (const id of batch.removedConnectionIds) {
      pendingRemoves.connectionIds.delete(id)
    }
  }
}

export function clearPendingForBatch(
  batch: BatchOperations,
  cutoff: number,
  pendingNodeChanges: Map<string, PendingNodeChanges>,
  pendingGroupChanges: Map<string, PendingGroupChanges>,
  pendingDomainChanges: Map<string, PendingDomainChanges>,
  pendingConnectionChanges: Map<string, PendingConnectionChanges>,
): void {
  if (batch.updatedNodes) {
    for (const { id, updates } of batch.updatedNodes) {
      prunePendingFields(pendingNodeChanges, id, updates, cutoff)
    }
  }
  if (batch.updatedGroups) {
    for (const { id, updates } of batch.updatedGroups) {
      prunePendingFields(pendingGroupChanges, id, updates, cutoff)
    }
  }
  if (batch.updatedDomains) {
    for (const { id, updates } of batch.updatedDomains) {
      prunePendingFields(pendingDomainChanges, id, updates, cutoff)
    }
  }
  if (batch.updatedConnections) {
    for (const { id, updates } of batch.updatedConnections) {
      prunePendingFields(pendingConnectionChanges, id, updates, cutoff)
    }
  }
}

/**
 * Clear pending entries for a single confirmed operation (path B:
 * NodeItem input timer → sendOperation('update-node', {id, updates})).
 *
 * Why this exists: prior to this, single-operation ACKs were ignored when
 * clearing pending — only batch-operation ACKs went through clearPendingForBatch.
 * That meant a single-field edit (e.g. typing in a node title) would linger in
 * pending*Changes indefinitely (until the 30s cleanupRecentChanges safety net or
 * a sync-replay). On the next sync the stale value could be replayed over the
 * user's newer edit. ACK is the authoritative "server accepted this change"
 * signal, so by the same cutoff rule used for batches we prune the confirmed
 * fields while preserving any newer writes to the same field.
 */
export function clearPendingForSingleOperation(
  operation: string,
  data: unknown,
  cutoff: number,
  pendingNodeChanges: Map<string, PendingNodeChanges>,
  pendingGroupChanges: Map<string, PendingGroupChanges>,
  pendingDomainChanges: Map<string, PendingDomainChanges>,
  pendingConnectionChanges: Map<string, PendingConnectionChanges>,
): void {
  if (!data || typeof data !== 'object') return
  const d = data as { id?: string; updates?: Record<string, unknown> }
  if (!d.id || !d.updates) return

  const updates = d.updates
  switch (operation) {
    case 'update-node':
      prunePendingFields(pendingNodeChanges, d.id, updates, cutoff)
      break
    case 'update-group':
      prunePendingFields(pendingGroupChanges, d.id, updates, cutoff)
      break
    case 'update-domain':
      prunePendingFields(pendingDomainChanges, d.id, updates, cutoff)
      break
    case 'update-connection':
      prunePendingFields(pendingConnectionChanges, d.id, updates, cutoff)
      break
    default:
      break
  }
}
