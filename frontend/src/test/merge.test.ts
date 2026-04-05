import { describe, it, expect, beforeEach } from 'vitest'
import type { Node, Connection } from '@/types'

type OperationType = 'create' | 'update' | 'delete' | 'move' | 'resize' | 'style' | 'content' | 'state'

interface FieldChange {
  field: string
  oldValue: unknown
  newValue: unknown
  operationType: OperationType
  timestamp: number
}

interface PendingNodeChanges {
  nodeId: string
  baseVersion: number
  changes: Map<string, FieldChange>
}

interface ConflictResolutionResult {
  value: unknown
  strategy: 'local' | 'remote' | 'merged' | 'conflict'
  reason: string
}

interface MergeTestHelper {
  mergeNodes: (local: Node[], remote: Node[]) => Node[]
  mergeConnectionsWithVersion: (local: Connection[], remote: Connection[]) => Connection[]
  setEditingState: (nodeId: string | null, field: 'title' | 'content' | null) => void
  setLastSyncedVersion: (nodeId: string, version: number) => void
  trackPendingChange: (nodeId: string, field: string, oldValue: unknown, newValue: unknown, operationType: OperationType) => void
  clearPendingChanges: (nodeId: string) => void
  detectConflictType: (localVersion: number, remoteVersion: number, lastSyncedVersion: number, hasLocalPendingChanges: boolean) => string
}

function createMergeHelper(): MergeTestHelper {
  let editingNodeId: string | null = null
  let editingField: 'title' | 'content' | null = null
  const lastSyncedVersions = new Map<string, number>()
  const pendingNodeChanges = new Map<string, PendingNodeChanges>()

  return {
    setEditingState(nodeId: string | null, field: 'title' | 'content' | null) {
      editingNodeId = nodeId
      editingField = field
    },

    setLastSyncedVersion(nodeId: string, version: number) {
      lastSyncedVersions.set(nodeId, version)
    },

    trackPendingChange(nodeId: string, field: string, oldValue: unknown, newValue: unknown, operationType: OperationType) {
      let pending = pendingNodeChanges.get(nodeId)
      if (!pending) {
        pending = {
          nodeId,
          baseVersion: 0,
          changes: new Map()
        }
        pendingNodeChanges.set(nodeId, pending)
      }
      pending.changes.set(field, {
        field,
        oldValue,
        newValue,
        operationType,
        timestamp: Date.now()
      })
    },

    clearPendingChanges(nodeId: string) {
      pendingNodeChanges.delete(nodeId)
    },

    detectConflictType(
      localVersion: number,
      remoteVersion: number,
      lastSyncedVersion: number,
      hasLocalPendingChanges: boolean
    ): string {
      if (remoteVersion === localVersion && localVersion === lastSyncedVersion) {
        if (hasLocalPendingChanges) {
          return 'concurrent'
        }
        return 'no_conflict'
      }

      if (remoteVersion > localVersion) {
        if (localVersion > lastSyncedVersion && hasLocalPendingChanges) {
          return 'diverged'
        }
        if (!hasLocalPendingChanges) {
          return 'sequential_remote'
        }
      }

      if (localVersion > remoteVersion && remoteVersion === lastSyncedVersion) {
        return 'sequential_local'
      }

      if (remoteVersion === localVersion && hasLocalPendingChanges) {
        return 'concurrent'
      }

      if (remoteVersion > lastSyncedVersion && localVersion > lastSyncedVersion && remoteVersion !== localVersion) {
        return 'diverged'
      }

      return 'no_conflict'
    },

    mergeNodes(localNodes: Node[], remoteNodes: Node[]): Node[] {
      const merged = new Map<string, Node>()

      localNodes.forEach((node) => {
        merged.set(node.id, node)
      })

      remoteNodes.forEach((remoteNode) => {
        const id = remoteNode.id
        const localNode = merged.get(id)

        if (!localNode) {
          merged.set(id, remoteNode)
          lastSyncedVersions.set(id, remoteNode._version || 0)
          return
        }

        const localVersion = localNode._version || 0
        const remoteVersion = remoteNode._version || 0
        const lastSynced = lastSyncedVersions.get(id) || 0

        const hasLocalPendingChanges = pendingNodeChanges.has(id) && (pendingNodeChanges.get(id)?.changes.size || 0) > 0
        const conflictType = this.detectConflictType(localVersion, remoteVersion, lastSynced, hasLocalPendingChanges)

        const mergedNode = this.resolveNodeConflict(localNode, remoteNode, conflictType, lastSynced)
        merged.set(id, mergedNode)

        lastSyncedVersions.set(id, remoteVersion)
      })

      return Array.from(merged.values())
    },

    resolveNodeConflict(
      local: Node,
      remote: Node,
      conflictType: string,
      lastSyncedVersion: number
    ): Node {
      let result: Node

      switch (conflictType) {
        case 'no_conflict':
          result = { ...remote }
          break

        case 'sequential_remote':
          result = { ...remote }
          break

        case 'sequential_local':
          result = { ...local }
          break

        case 'concurrent':
        case 'diverged':
          return this.mergeNodeFieldsWithConflictResolution(local, remote, lastSyncedVersion, conflictType === 'diverged')

        default:
          result = { ...remote }
      }

      result._version = Math.max(local._version || 0, remote._version || 0) + 1
      return result
    },

    mergeNodeFieldsWithConflictResolution(
      local: Node,
      remote: Node,
      lastSyncedVersion: number,
      isDiverged: boolean
    ): Node {
      const result: Node = { ...local }
      const pendingChanges = pendingNodeChanges.get(local.id)
      const isEditingThisNode = editingNodeId === local.id

      const fieldGroups = {
        content: ['title', 'content'] as const,
        position: ['x', 'y', 'width', 'height'] as const,
        style: ['color', 'fontSize', 'textAlign', 'titleAlign', 'contentAlign', 'collapsedTitleAlign'] as const,
        state: ['collapsed', 'locked', 'expandedHeight'] as const,
        media: ['type', 'imageUrl', 'aspectRatio'] as const,
      }

      Object.entries(fieldGroups).forEach(([group, fields]) => {
        fields.forEach((field) => {
          const localVal = local[field as keyof Node]
          const remoteVal = remote[field as keyof Node]

          if (remoteVal === undefined || remoteVal === localVal) {
            return
          }

          const resolution = this.resolveFieldConflict(
            local.id,
            field,
            localVal,
            remoteVal,
            group as keyof typeof fieldGroups,
            pendingChanges,
            isEditingThisNode && editingField === field,
            isDiverged
          )

          if (resolution.strategy !== 'local') {
            (result as Record<string, unknown>)[field] = resolution.value
          }
        })
      })

      result._version = Math.max(local._version || 0, remote._version || 0) + 1

      if (pendingChanges) {
        pendingNodeChanges.delete(local.id)
      }

      return result
    },

    resolveFieldConflict(
      nodeId: string,
      field: string,
      localValue: unknown,
      remoteValue: unknown,
      fieldGroup: 'content' | 'position' | 'style' | 'state' | 'media',
      pendingChanges: PendingNodeChanges | undefined,
      isCurrentlyEditing: boolean,
      isDiverged: boolean
    ): ConflictResolutionResult {
      const pendingChange = pendingChanges?.changes.get(field)
      const hasLocalChange = pendingChange !== undefined

      if (isCurrentlyEditing && fieldGroup === 'content') {
        return {
          value: localValue,
          strategy: 'local',
          reason: 'User is currently editing this field'
        }
      }

      if (hasLocalChange && fieldGroup === 'content') {
        if (isDiverged) {
          return {
            value: remoteValue,
            strategy: 'remote',
            reason: 'Diverged versions - accepting remote for content field'
          }
        }
        return {
          value: localValue,
          strategy: 'local',
          reason: 'Local has pending changes for this content field'
        }
      }

      if (fieldGroup === 'position') {
        if (hasLocalChange) {
          const localTime = pendingChange.timestamp
          const now = Date.now()
          const timeDiff = now - localTime

          if (timeDiff < 5000) {
            return {
              value: localValue,
              strategy: 'local',
              reason: 'Recent local position change (within 5s)'
            }
          }
        }
        return {
          value: remoteValue,
          strategy: 'remote',
          reason: 'Position changes use latest remote'
        }
      }

      if (fieldGroup === 'style') {
        if (hasLocalChange) {
          return {
            value: localValue,
            strategy: 'local',
            reason: 'Local style change pending'
          }
        }
        return {
          value: remoteValue,
          strategy: 'remote',
          reason: 'Style changes use latest remote'
        }
      }

      if (fieldGroup === 'state') {
        if (field === 'collapsed' || field === 'locked') {
          if (hasLocalChange) {
            return {
              value: localValue,
              strategy: 'local',
              reason: 'State change by local user takes priority'
            }
          }
        }
        return {
          value: remoteValue,
          strategy: 'remote',
          reason: 'State changes use latest remote'
        }
      }

      if (fieldGroup === 'media') {
        return {
          value: remoteValue,
          strategy: 'remote',
          reason: 'Media properties always use remote'
        }
      }

      return {
        value: remoteValue,
        strategy: 'remote',
        reason: 'Default: accept remote'
      }
    },

    mergeConnectionsWithVersion(
      localConnections: Connection[],
      remoteConnections: Connection[]
    ): Connection[] {
      const merged = new Map<string, Connection>()

      localConnections.forEach((conn) => {
        merged.set(conn.id, conn)
      })

      remoteConnections.forEach((remoteConn) => {
        const id = remoteConn.id
        const localConn = merged.get(id)

        if (!localConn) {
          merged.set(id, remoteConn)
          return
        }

        const mergedConn = { ...localConn }
        const geometryFields: (keyof Connection)[] = [
          'fromPort', 'toPort', 'type', 'style', 'color', 'width', 'arrowType', 'direction', 'label', 'bendPoints'
        ]

        geometryFields.forEach((field) => {
          const remoteVal = remoteConn[field]
          if (remoteVal !== undefined) {
            (mergedConn as Record<string, unknown>)[field] = remoteVal
          }
        })

        merged.set(id, mergedConn)
      })

      return Array.from(merged.values())
    }
  }
}

function createTestNode(overrides: Partial<Node> = {}): Node {
  return {
    id: 'node-1',
    x: 100,
    y: 100,
    width: 200,
    height: 100,
    title: 'Original Title',
    content: 'Original Content',
    fontSize: 14,
    textAlign: 'left',
    collapsed: false,
    locked: false,
    ...overrides
  }
}

function createTestConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'conn-1',
    fromNodeId: 'node-1',
    toNodeId: 'node-2',
    fromPort: 'right',
    toPort: 'left',
    type: 'Straight',
    style: 'solid',
    color: '#000000',
    width: 2,
    arrowType: 'end',
    direction: 'directed',
    ...overrides
  }
}

describe('Conflict Type Detection', () => {
  let helper: MergeTestHelper

  beforeEach(() => {
    helper = createMergeHelper()
  })

  describe('detectConflictType', () => {
    it('should return no_conflict when versions match last synced', () => {
      helper.setLastSyncedVersion('node-1', 5)
      const result = helper.detectConflictType(5, 5, 5, false)
      expect(result).toBe('no_conflict')
    })

    it('should return sequential_remote when remote is ahead and no local pending changes', () => {
      helper.setLastSyncedVersion('node-1', 3)
      const result = helper.detectConflictType(3, 5, 3, false)
      expect(result).toBe('sequential_remote')
    })

    it('should return sequential_local when local is ahead and remote matches last synced', () => {
      helper.setLastSyncedVersion('node-1', 3)
      const result = helper.detectConflictType(5, 3, 3, false)
      expect(result).toBe('sequential_local')
    })

    it('should return concurrent when versions are equal but local has pending changes', () => {
      helper.setLastSyncedVersion('node-1', 3)
      const result = helper.detectConflictType(3, 3, 3, true)
      expect(result).toBe('concurrent')
    })

    it('should return diverged when both versions are ahead of last synced and local has pending changes', () => {
      helper.setLastSyncedVersion('node-1', 3)
      const result = helper.detectConflictType(5, 6, 3, true)
      expect(result).toBe('diverged')
    })

    it('should return sequential_remote when remote is higher and local has no pending', () => {
      helper.setLastSyncedVersion('node-1', 3)
      const result = helper.detectConflictType(4, 5, 3, false)
      expect(result).toBe('sequential_remote')
    })
  })
})

describe('Node Merge Functions', () => {
  let helper: MergeTestHelper

  beforeEach(() => {
    helper = createMergeHelper()
  })

  describe('mergeNodes - basic scenarios', () => {
    it('should add new remote nodes that do not exist locally', () => {
      const localNodes: Node[] = [createTestNode({ id: 'node-1' })]
      const remoteNodes: Node[] = [createTestNode({ id: 'node-2', _version: 1 })]

      const result = helper.mergeNodes(localNodes, remoteNodes)

      expect(result).toHaveLength(2)
      expect(result.find(n => n.id === 'node-2')).toBeDefined()
    })

    it('should keep local nodes that do not exist remotely', () => {
      const localNodes: Node[] = [createTestNode({ id: 'node-1' })]
      const remoteNodes: Node[] = []

      const result = helper.mergeNodes(localNodes, remoteNodes)

      expect(result).toHaveLength(1)
      expect(result.find(n => n.id === 'node-1')).toBeDefined()
    })
  })

  describe('mergeNodes - version-based conflict detection', () => {
    it('should accept remote node when remote version is higher (sequential remote)', () => {
      helper.setLastSyncedVersion('node-1', 1)
      const localNodes: Node[] = [createTestNode({ id: 'node-1', title: 'Local Title', _version: 1 })]
      const remoteNodes: Node[] = [createTestNode({ id: 'node-1', title: 'Remote Title', _version: 5 })]

      const result = helper.mergeNodes(localNodes, remoteNodes)

      expect(result[0].title).toBe('Remote Title')
    })

    it('should keep local node when local version is higher (sequential local)', () => {
      helper.setLastSyncedVersion('node-1', 3)
      const localNodes: Node[] = [createTestNode({ id: 'node-1', title: 'Local Title', _version: 5 })]
      const remoteNodes: Node[] = [createTestNode({ id: 'node-1', title: 'Remote Title', _version: 3 })]

      const result = helper.mergeNodes(localNodes, remoteNodes)

      expect(result[0].title).toBe('Local Title')
    })

    it('should merge fields when remote version is exactly one higher (sequential remote)', () => {
      helper.setLastSyncedVersion('node-1', 2)
      const localNodes: Node[] = [createTestNode({ id: 'node-1', title: 'Local Title', content: 'Local Content', _version: 2 })]
      const remoteNodes: Node[] = [createTestNode({ id: 'node-1', title: 'Remote Title', content: 'Remote Content', _version: 3 })]

      const result = helper.mergeNodes(localNodes, remoteNodes)

      expect(result[0].title).toBe('Remote Title')
      expect(result[0].content).toBe('Remote Content')
    })
  })

  describe('mergeNodes - field-level merge with pending changes', () => {
    it('should preserve local content field when pending change exists', () => {
      helper.setLastSyncedVersion('node-1', 1)
      helper.trackPendingChange('node-1', 'title', 'Base Title', 'Local Title', 'content')

      const localNodes: Node[] = [createTestNode({ id: 'node-1', title: 'Local Title', content: 'Base Content', _version: 1 })]
      const remoteNodes: Node[] = [createTestNode({ id: 'node-1', title: 'Remote Title', content: 'Remote Content', _version: 1 })]

      const result = helper.mergeNodes(localNodes, remoteNodes)

      expect(result[0].title).toBe('Local Title')
    })

    it('should merge position fields from remote when no pending position change', () => {
      helper.setLastSyncedVersion('node-1', 1)
      const localNodes: Node[] = [createTestNode({ id: 'node-1', x: 100, y: 100, _version: 1 })]
      const remoteNodes: Node[] = [createTestNode({ id: 'node-1', x: 200, y: 200, _version: 1 })]

      const result = helper.mergeNodes(localNodes, remoteNodes)

      expect(result[0].x).toBe(200)
      expect(result[0].y).toBe(200)
    })

    it('should merge style fields from remote when no pending style change', () => {
      helper.setLastSyncedVersion('node-1', 1)
      const localNodes: Node[] = [createTestNode({ id: 'node-1', color: '#ff0000', fontSize: 14, _version: 1 })]
      const remoteNodes: Node[] = [createTestNode({ id: 'node-1', color: '#00ff00', fontSize: 16, _version: 1 })]

      const result = helper.mergeNodes(localNodes, remoteNodes)

      expect(result[0].color).toBe('#00ff00')
      expect(result[0].fontSize).toBe(16)
    })

    it('should preserve local style when pending style change exists', () => {
      helper.setLastSyncedVersion('node-1', 1)
      helper.trackPendingChange('node-1', 'color', '#ff0000', '#0000ff', 'style')

      const localNodes: Node[] = [createTestNode({ id: 'node-1', color: '#0000ff', fontSize: 14, _version: 1 })]
      const remoteNodes: Node[] = [createTestNode({ id: 'node-1', color: '#00ff00', fontSize: 16, _version: 1 })]

      const result = helper.mergeNodes(localNodes, remoteNodes)

      expect(result[0].color).toBe('#0000ff')
    })

    it('should increment version after merge', () => {
      helper.setLastSyncedVersion('node-1', 2)
      const localNodes: Node[] = [createTestNode({ id: 'node-1', _version: 2 })]
      const remoteNodes: Node[] = [createTestNode({ id: 'node-1', _version: 3 })]

      const result = helper.mergeNodes(localNodes, remoteNodes)

      expect(result[0]._version).toBe(4)
    })
  })

  describe('mergeNodes - concurrent edit scenarios', () => {
    it('should preserve local title when user is editing title field', () => {
      helper.setLastSyncedVersion('node-1', 1)
      helper.trackPendingChange('node-1', 'title', 'Base Title', 'User A Title', 'content')
      helper.setEditingState('node-1', 'title')

      const localNodes: Node[] = [createTestNode({ id: 'node-1', title: 'User A Title', content: 'Base Content', _version: 1 })]
      const remoteNodes: Node[] = [createTestNode({ id: 'node-1', title: 'User B Title', content: 'User B Content', _version: 1 })]

      const result = helper.mergeNodes(localNodes, remoteNodes)

      expect(result[0].title).toBe('User A Title')
    })

    it('should preserve local content when user is editing content field', () => {
      helper.setLastSyncedVersion('node-1', 1)
      helper.trackPendingChange('node-1', 'content', 'Base Content', 'User A Content', 'content')
      helper.setEditingState('node-1', 'content')

      const localNodes: Node[] = [createTestNode({ id: 'node-1', title: 'Base Title', content: 'User A Content', _version: 1 })]
      const remoteNodes: Node[] = [createTestNode({ id: 'node-1', title: 'User B Title', content: 'User B Content', _version: 1 })]

      const result = helper.mergeNodes(localNodes, remoteNodes)

      expect(result[0].content).toBe('User A Content')
    })

    it('should preserve local state when pending state change exists', () => {
      helper.setLastSyncedVersion('node-1', 1)
      helper.trackPendingChange('node-1', 'collapsed', false, true, 'state')

      const localNodes: Node[] = [createTestNode({ id: 'node-1', collapsed: true, _version: 1 })]
      const remoteNodes: Node[] = [createTestNode({ id: 'node-1', collapsed: false, _version: 1 })]

      const result = helper.mergeNodes(localNodes, remoteNodes)

      expect(result[0].collapsed).toBe(true)
    })
  })

  describe('mergeNodes - diverged version handling', () => {
    it('should accept remote for content fields in diverged scenario', () => {
      helper.setLastSyncedVersion('node-1', 1)
      helper.trackPendingChange('node-1', 'title', 'Base Title', 'Local Title', 'content')

      const localNodes: Node[] = [createTestNode({ id: 'node-1', title: 'Local Title', _version: 3 })]
      const remoteNodes: Node[] = [createTestNode({ id: 'node-1', title: 'Remote Title', _version: 2 })]

      const result = helper.mergeNodes(localNodes, remoteNodes)

      expect(result[0].title).toBe('Remote Title')
    })
  })
})

describe('Connection Merge Functions', () => {
  let helper: MergeTestHelper

  beforeEach(() => {
    helper = createMergeHelper()
  })

  describe('mergeConnectionsWithVersion - basic scenarios', () => {
    it('should add new remote connections', () => {
      const localConns: Connection[] = [createTestConnection({ id: 'conn-1' })]
      const remoteConns: Connection[] = [createTestConnection({ id: 'conn-2' })]

      const result = helper.mergeConnectionsWithVersion(localConns, remoteConns)

      expect(result).toHaveLength(2)
    })

    it('should merge connection fields from remote', () => {
      const localConns: Connection[] = [createTestConnection({ id: 'conn-1', color: '#ff0000', width: 2 })]
      const remoteConns: Connection[] = [createTestConnection({ id: 'conn-1', color: '#00ff00', width: 4 })]

      const result = helper.mergeConnectionsWithVersion(localConns, remoteConns)

      expect(result[0].color).toBe('#00ff00')
      expect(result[0].width).toBe(4)
    })

    it('should merge bendPoints from remote', () => {
      const localConns: Connection[] = [createTestConnection({ id: 'conn-1' })]
      const remoteConns: Connection[] = [createTestConnection({
        id: 'conn-1',
        bendPoints: [{ id: 'bp-1', x: 150, y: 150 }]
      })]

      const result = helper.mergeConnectionsWithVersion(localConns, remoteConns)

      expect(result[0].bendPoints).toHaveLength(1)
      expect(result[0].bendPoints?.[0].x).toBe(150)
    })
  })
})
