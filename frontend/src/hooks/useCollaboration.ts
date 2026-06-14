import { useEffect, useRef, useCallback } from 'react'
import { collabService } from '@/services/collaboration'
import { useCanvasStore } from '@/store/useCanvasStore'
import type { Node, NodeGroup, Domain, Connection } from '@/types'
import {
  isLocalEditingUpdate,
  getEditingState,
} from '@/hooks/useCollabEditing'

interface UseCollaborationOptions {
  canvasId: number
  enabled?: boolean
  onRemoteChange?: (canvasId: number) => void
  /**
   * P3: 当前用户被 owner 移除项目成员资格时触发（服务端 kicked 消息）。
   * 前端通常在此提示用户并跳转到项目列表。
   */
  onKicked?: (reason: string) => void
}

export function useCollaboration({ canvasId, enabled = true, onRemoteChange, onKicked }: UseCollaborationOptions) {
  const isApplyingRemoteChanges = useRef(false)
  const onRemoteChangeRef = useRef(onRemoteChange)
  onRemoteChangeRef.current = onRemoteChange
  const onKickedRef = useRef(onKicked)
  onKickedRef.current = onKicked

  useEffect(() => {
    if (!enabled || !canvasId || canvasId <= 0) return

    collabService.connect(canvasId)

    // Remote operation handlers - directly apply server-authorized changes
    const handleAddNode = (data: unknown) => {
      const node = data as Node
      const store = useCanvasStore.getState()
      if (!store.nodes.has(node.id)) {
        isApplyingRemoteChanges.current = true
        store.executeCommand({
          type: 'addNode',
          timestamp: Date.now(),
          execute: () => {
            const nodes = new Map(useCanvasStore.getState().nodes)
            nodes.set(node.id, node)
            return { nodes }
          },
          undo: () => {
            const nodes = new Map(useCanvasStore.getState().nodes)
            nodes.delete(node.id)
            return { nodes }
          },
        }, true, false)
        isApplyingRemoteChanges.current = false
      }
    }

    const handleUpdateNode = (data: unknown) => {
      const { id, updates } = data as { id: string; updates: Partial<Node> }
      if (!updates || typeof updates !== 'object') return
      const store = useCanvasStore.getState()
      if (store.nodes.has(id)) {
        const currentState = getEditingState()

        // Type-safe field filtering: skip updates for fields the user is currently editing
        const validNodeFields: Array<keyof Node> = [
          'id', 'x', 'y', 'width', 'height', 'title', 'content', 'color',
          'fontSize', 'textAlign', 'titleAlign', 'collapsedTitleAlign', 'contentAlign',
          'collapsed', 'locked', 'expandedHeight', 'type', 'imageUrl', 'aspectRatio', '_version'
        ]

        const filteredUpdates: Partial<Node> = {}
        for (const [key, value] of Object.entries(updates)) {
          // Skip the field the user is currently editing
          if (currentState.nodeId === id && currentState.field && key === currentState.field) {
            continue
          }

          // Only include valid Node fields
          if (validNodeFields.includes(key as keyof Node)) {
            (filteredUpdates as Record<string, unknown>)[key] = value
          }
        }

        if (Object.keys(filteredUpdates).length === 0) {
          return
        }
        isApplyingRemoteChanges.current = true
        store.updateNodeWithoutHistory(id, filteredUpdates, false)
        isApplyingRemoteChanges.current = false
      }
    }

    const handleRemoveNode = (data: unknown) => {
      const { id } = data as { id: string }
      const store = useCanvasStore.getState()
      const node = store.nodes.get(id)
      if (node) {
        const removedConnections: Connection[] = []
        for (const [, conn] of store.connections) {
          if (conn.fromNodeId === id || conn.toNodeId === id) {
            removedConnections.push(conn)
          }
        }
        isApplyingRemoteChanges.current = true
        store.executeCommand({
          type: 'removeNode',
          timestamp: Date.now(),
          execute: () => {
            const state = useCanvasStore.getState()
            const nodes = new Map(state.nodes)
            nodes.delete(id)
            const connections = new Map(state.connections)
            for (const conn of removedConnections) {
              connections.delete(conn.id)
            }
            return { nodes, connections }
          },
          undo: () => {
            const state = useCanvasStore.getState()
            const nodes = new Map(state.nodes)
            const connections = new Map(state.connections)
            nodes.set(id, node)
            for (const conn of removedConnections) {
              connections.set(conn.id, conn)
            }
            return { nodes, connections }
          },
        }, true, false)
        isApplyingRemoteChanges.current = false
      }
    }

    const handleAddGroup = (data: unknown) => {
      const group = data as NodeGroup
      const store = useCanvasStore.getState()
      if (!store.groups.has(group.id)) {
        isApplyingRemoteChanges.current = true
        store.executeCommand({
          type: 'addGroup',
          timestamp: Date.now(),
          execute: () => {
            const groups = new Map(useCanvasStore.getState().groups)
            groups.set(group.id, group)
            return { groups }
          },
          undo: () => {
            const groups = new Map(useCanvasStore.getState().groups)
            groups.delete(group.id)
            return { groups }
          },
        }, true, false)
        isApplyingRemoteChanges.current = false
      }
    }

    const handleUpdateGroup = (data: unknown) => {
      const { id, updates } = data as { id: string; updates: Partial<NodeGroup> }
      const store = useCanvasStore.getState()
      if (store.groups.has(id)) {
        isApplyingRemoteChanges.current = true
        store.updateGroupWithoutHistory(id, updates, false)
        isApplyingRemoteChanges.current = false
      }
    }

    const handleRemoveGroup = (data: unknown) => {
      const { id } = data as { id: string }
      const store = useCanvasStore.getState()
      const group = store.groups.get(id)
      if (group) {
        isApplyingRemoteChanges.current = true
        store.executeCommand({
          type: 'removeGroup',
          timestamp: Date.now(),
          execute: () => {
            const groups = new Map(useCanvasStore.getState().groups)
            groups.delete(id)
            return { groups }
          },
          undo: () => {
            const groups = new Map(useCanvasStore.getState().groups)
            groups.set(id, group)
            return { groups }
          },
        }, true, false)
        isApplyingRemoteChanges.current = false
      }
    }

    const handleAddDomain = (data: unknown) => {
      const domain = data as Domain
      const store = useCanvasStore.getState()
      if (!store.domains.has(domain.id)) {
        isApplyingRemoteChanges.current = true
        store.executeCommand({
          type: 'addDomain',
          timestamp: Date.now(),
          execute: () => {
            const domains = new Map(useCanvasStore.getState().domains)
            domains.set(domain.id, domain)
            return { domains }
          },
          undo: () => {
            const domains = new Map(useCanvasStore.getState().domains)
            domains.delete(domain.id)
            return { domains }
          },
        }, true, false)
        isApplyingRemoteChanges.current = false
      }
    }

    const handleUpdateDomain = (data: unknown) => {
      const { id, updates } = data as { id: string; updates: Partial<Domain> }
      const store = useCanvasStore.getState()
      if (store.domains.has(id)) {
        isApplyingRemoteChanges.current = true
        store.updateDomainWithoutHistory(id, updates, false)
        isApplyingRemoteChanges.current = false
      }
    }

    const handleRemoveDomain = (data: unknown) => {
      const { id } = data as { id: string }
      const store = useCanvasStore.getState()
      const domain = store.domains.get(id)
      if (domain) {
        isApplyingRemoteChanges.current = true
        store.executeCommand({
          type: 'removeDomain',
          timestamp: Date.now(),
          execute: () => {
            const domains = new Map(useCanvasStore.getState().domains)
            domains.delete(id)
            return { domains }
          },
          undo: () => {
            const domains = new Map(useCanvasStore.getState().domains)
            domains.set(id, domain)
            return { domains }
          },
        }, true, false)
        isApplyingRemoteChanges.current = false
      }
    }

    const handleAddConnection = (data: unknown) => {
      const connection = data as Connection
      const store = useCanvasStore.getState()
      if (!store.connections.has(connection.id)) {
        isApplyingRemoteChanges.current = true
        store.executeCommand({
          type: 'addConnection',
          timestamp: Date.now(),
          execute: () => {
            const connections = new Map(useCanvasStore.getState().connections)
            connections.set(connection.id, connection)
            return { connections }
          },
          undo: () => {
            const connections = new Map(useCanvasStore.getState().connections)
            connections.delete(connection.id)
            return { connections }
          },
        }, true, false)
        isApplyingRemoteChanges.current = false
      }
    }

    const handleUpdateConnection = (data: unknown) => {
      const { id, updates } = data as { id: string; updates: Partial<Connection> }
      const store = useCanvasStore.getState()
      if (store.connections.has(id)) {
        isApplyingRemoteChanges.current = true
        store.updateConnectionWithoutHistory(id, updates, false)
        isApplyingRemoteChanges.current = false
      }
    }

    const handleRemoveConnection = (data: unknown) => {
      const { id } = data as { id: string }
      const store = useCanvasStore.getState()
      const connection = store.connections.get(id)
      if (connection) {
        isApplyingRemoteChanges.current = true
        store.executeCommand({
          type: 'removeConnection',
          timestamp: Date.now(),
          execute: () => {
            const connections = new Map(useCanvasStore.getState().connections)
            connections.delete(id)
            return { connections }
          },
          undo: () => {
            const connections = new Map(useCanvasStore.getState().connections)
            connections.set(id, connection)
            return { connections }
          },
        }, true, false)
        isApplyingRemoteChanges.current = false
      }
    }

    collabService.onOperation('add-node', handleAddNode)
    collabService.onOperation('update-node', handleUpdateNode)
    collabService.onOperation('remove-node', handleRemoveNode)
    collabService.onOperation('add-group', handleAddGroup)
    collabService.onOperation('update-group', handleUpdateGroup)
    collabService.onOperation('remove-group', handleRemoveGroup)
    collabService.onOperation('add-domain', handleAddDomain)
    collabService.onOperation('update-domain', handleUpdateDomain)
    collabService.onOperation('remove-domain', handleRemoveDomain)
    collabService.onOperation('add-connection', handleAddConnection)
    collabService.onOperation('update-connection', handleUpdateConnection)
    collabService.onOperation('remove-connection', handleRemoveConnection)

    // Local change detection -> send to server as batch
    const unsubscribe = useCanvasStore.subscribe((state, prevState) => {
      if (isApplyingRemoteChanges.current) return
      if (isLocalEditingUpdate()) return
      if (collabService.isApplyingRemoteUpdate) return

      let batchNeeded = false
      const addedNodes: Node[] = []
      const updatedNodes: { id: string; updates: Partial<Node> }[] = []
      const removedNodeIds: string[] = []
      const addedGroups: NodeGroup[] = []
      const updatedGroups: { id: string; updates: Partial<NodeGroup> }[] = []
      const removedGroupIds: string[] = []
      const addedDomains: Domain[] = []
      const updatedDomains: { id: string; updates: Partial<Domain> }[] = []
      const removedDomainIds: string[] = []
      const addedConnections: Connection[] = []
      const updatedConnections: { id: string; updates: Partial<Connection> }[] = []
      const removedConnectionIds: string[] = []

      if (state.nodes !== prevState.nodes) {
        batchNeeded = true

        state.nodes.forEach((node, id) => {
          const prevNode = prevState.nodes.get(id)
          if (!prevNode) {
            addedNodes.push(node)
          } else if (JSON.stringify(prevNode) !== JSON.stringify(node)) {
            const updates: Partial<Node> = {}
            const allKeys = new Set([...Object.keys(prevNode), ...Object.keys(node)]) as Set<keyof Node>
            allKeys.forEach(key => {
              if (JSON.stringify(prevNode[key]) !== JSON.stringify(node[key])) {
                (updates as Record<string, unknown>)[key] = node[key]
              }
            })
            if (Object.keys(updates).length > 0) {
              updatedNodes.push({ id, updates })
            }
          }
        })

        prevState.nodes.forEach((_, id) => {
          if (!state.nodes.has(id)) {
            removedNodeIds.push(id)
          }
        })
      }

      if (state.groups !== prevState.groups) {
        batchNeeded = true

        state.groups.forEach((group, id) => {
          const prevGroup = prevState.groups.get(id)
          if (!prevGroup) {
            addedGroups.push(group)
          } else if (JSON.stringify(prevGroup) !== JSON.stringify(group)) {
            const updates: Partial<NodeGroup> = {}
            const allKeys = new Set([...Object.keys(prevGroup), ...Object.keys(group)]) as Set<keyof NodeGroup>
            allKeys.forEach(key => {
              if (JSON.stringify(prevGroup[key]) !== JSON.stringify(group[key])) {
                (updates as Record<string, unknown>)[key] = group[key]
              }
            })
            if (Object.keys(updates).length > 0) {
              updatedGroups.push({ id, updates })
            }
          }
        })

        prevState.groups.forEach((_, id) => {
          if (!state.groups.has(id)) {
            removedGroupIds.push(id)
          }
        })
      }

      if (state.domains !== prevState.domains) {
        batchNeeded = true

        state.domains.forEach((domain, id) => {
          const prevDomain = prevState.domains.get(id)
          if (!prevDomain) {
            addedDomains.push(domain)
          } else if (JSON.stringify(prevDomain) !== JSON.stringify(domain)) {
            const updates: Partial<Domain> = {}
            const allKeys = new Set([...Object.keys(prevDomain), ...Object.keys(domain)]) as Set<keyof Domain>
            allKeys.forEach(key => {
              if (JSON.stringify(prevDomain[key]) !== JSON.stringify(domain[key])) {
                (updates as Record<string, unknown>)[key] = domain[key]
              }
            })
            if (Object.keys(updates).length > 0) {
              updatedDomains.push({ id, updates })
            }
          }
        })

        prevState.domains.forEach((_, id) => {
          if (!state.domains.has(id)) {
            removedDomainIds.push(id)
          }
        })
      }

      if (state.connections !== prevState.connections) {
        batchNeeded = true

        state.connections.forEach((connection, id) => {
          const prevConnection = prevState.connections.get(id)
          if (!prevConnection) {
            addedConnections.push(connection)
          } else if (JSON.stringify(prevConnection) !== JSON.stringify(connection)) {
            const updates: Partial<Connection> = {}
            const allKeys = new Set([...Object.keys(prevConnection), ...Object.keys(connection)]) as Set<keyof Connection>
            allKeys.forEach(key => {
              if (JSON.stringify(prevConnection[key]) !== JSON.stringify(connection[key])) {
                (updates as Record<string, unknown>)[key] = connection[key]
              }
            })
            if (Object.keys(updates).length > 0) {
              updatedConnections.push({ id, updates })
            }
          }
        })

        prevState.connections.forEach((_, id) => {
          if (!state.connections.has(id)) {
            removedConnectionIds.push(id)
          }
        })
      }

      if (!batchNeeded) return

      // Track local changes for sync replay
      updatedNodes.forEach(({ id, updates }) => {
        Object.keys(updates).forEach((field) => {
          collabService.trackLocalChange(id, field, (updates as Record<string, unknown>)[field])
        })
      })
      updatedGroups.forEach(({ id, updates }) => {
        Object.keys(updates).forEach((field) => {
          collabService.trackLocalGroupChange(id, field, (updates as Record<string, unknown>)[field])
        })
      })
      updatedDomains.forEach(({ id, updates }) => {
        Object.keys(updates).forEach((field) => {
          collabService.trackLocalDomainChange(id, field, (updates as Record<string, unknown>)[field])
        })
      })
      updatedConnections.forEach(({ id, updates }) => {
        Object.keys(updates).forEach((field) => {
          collabService.trackLocalConnectionChange(id, field, (updates as Record<string, unknown>)[field])
        })
      })

      // Track remove operations for NAK→resync recovery
      removedNodeIds.forEach((id) => {
        collabService.trackPendingRemove('node', id)
      })
      removedGroupIds.forEach((id) => {
        collabService.trackPendingRemove('group', id)
      })
      removedDomainIds.forEach((id) => {
        collabService.trackPendingRemove('domain', id)
      })
      removedConnectionIds.forEach((id) => {
        collabService.trackPendingRemove('connection', id)
      })

      // 使用 sendBatch 将所有变更合并为一条消息，共享同一个 clientVersion，
      // 避免服务端版本递增导致后续操作被 NAK 拒绝
      collabService.sendBatch({
        addedNodes: addedNodes.length > 0 ? addedNodes : undefined,
        updatedNodes: updatedNodes.length > 0 ? updatedNodes : undefined,
        removedNodeIds: removedNodeIds.length > 0 ? removedNodeIds : undefined,
        addedGroups: addedGroups.length > 0 ? addedGroups : undefined,
        updatedGroups: updatedGroups.length > 0 ? updatedGroups : undefined,
        removedGroupIds: removedGroupIds.length > 0 ? removedGroupIds : undefined,
        addedDomains: addedDomains.length > 0 ? addedDomains : undefined,
        updatedDomains: updatedDomains.length > 0 ? updatedDomains : undefined,
        removedDomainIds: removedDomainIds.length > 0 ? removedDomainIds : undefined,
        addedConnections: addedConnections.length > 0 ? addedConnections : undefined,
        updatedConnections: updatedConnections.length > 0 ? updatedConnections : undefined,
        removedConnectionIds: removedConnectionIds.length > 0 ? removedConnectionIds : undefined,
      })
    })

    // Trigger thumbnail generation when remote changes are applied
    const thumbnailUnsubscribe = useCanvasStore.subscribe(() => {
      if (isApplyingRemoteChanges.current && onRemoteChangeRef.current) {
        onRemoteChangeRef.current(canvasId)
      }
    })

    // P3: 被踢出时通知 CanvasPage 提示用户并跳转
    const handleKicked = (reason: string) => {
      if (onKickedRef.current) onKickedRef.current(reason)
    }
    collabService.onKicked(handleKicked)

    return () => {
      unsubscribe()
      thumbnailUnsubscribe()
      collabService.offKicked(handleKicked)
      collabService.offOperation('add-node', handleAddNode)
      collabService.offOperation('update-node', handleUpdateNode)
      collabService.offOperation('remove-node', handleRemoveNode)
      collabService.offOperation('add-group', handleAddGroup)
      collabService.offOperation('update-group', handleUpdateGroup)
      collabService.offOperation('remove-group', handleRemoveGroup)
      collabService.offOperation('add-domain', handleAddDomain)
      collabService.offOperation('update-domain', handleUpdateDomain)
      collabService.offOperation('remove-domain', handleRemoveDomain)
      collabService.offOperation('add-connection', handleAddConnection)
      collabService.offOperation('update-connection', handleUpdateConnection)
      collabService.offOperation('remove-connection', handleRemoveConnection)
      collabService.disconnect()
    }
  }, [canvasId, enabled])

  const sendCursor = useCallback((x: number, y: number) => {
    collabService.sendCursor(x, y)
  }, [])

  return {
    sendCursor,
    isConnected: collabService.isConnected.bind(collabService)
  }
}
