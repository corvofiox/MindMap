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
