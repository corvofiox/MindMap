import { useEffect, useRef, useCallback } from 'react'
import { collabService } from '@/services/collaboration'
import { useCanvasStore } from '@/store/useCanvasStore'
import type { Node, NodeGroup, Domain, Connection } from '@/types'

interface UseCollaborationOptions {
  canvasId: number
  enabled?: boolean
}

interface EditingState {
  nodeId: string | null
  field: 'title' | 'content' | null
  version: number
}

const editingState: EditingState = {
  nodeId: null,
  field: null,
  version: 0
}

export function setEditingFieldForCollab(nodeId: string | null, field: 'title' | 'content' | null) {
  editingState.version++
  editingState.nodeId = nodeId
  editingState.field = field
}

export function getEditingState(): EditingState {
  return { ...editingState }
}

export function useCollaboration({ canvasId, enabled = true }: UseCollaborationOptions) {
  const isApplyingRemoteChanges = useRef(false)

  useEffect(() => {
    const handleEditingFieldChange = (e: Event) => {
      if (!(e instanceof CustomEvent)) return
      const { field, nodeId, version } = e.detail

      if (typeof version === 'number' && version < editingState.version) {
        return
      }

      if (field === 'title' || field === 'content') {
        editingState.version++
        editingState.nodeId = nodeId ?? null
        editingState.field = field
      } else if (field === null) {
        if (editingState.nodeId === nodeId) {
          editingState.version++
          editingState.nodeId = null
          editingState.field = null
        }
      }
    }

    window.addEventListener('nodeEditingFieldChange', handleEditingFieldChange)
    return () => {
      window.removeEventListener('nodeEditingFieldChange', handleEditingFieldChange)
    }
  }, [])

  useEffect(() => {
    if (!enabled || !canvasId || canvasId <= 0) return

    collabService.connect(canvasId)

    const handleAddNode = (data: unknown) => {
      const node = data as Node
      const store = useCanvasStore.getState()
      if (!store.nodes.has(node.id)) {
        isApplyingRemoteChanges.current = true
        store.addNode(node)
        isApplyingRemoteChanges.current = false
      }
    }

    const handleUpdateNode = (data: unknown) => {
      const { id, updates } = data as { id: string; updates: Partial<Node> }
      const store = useCanvasStore.getState()
      if (store.nodes.has(id)) {
        const currentState = getEditingState()
        if (currentState.nodeId === id && currentState.field !== null) {
          const filteredUpdates = { ...updates }
          const editingField = currentState.field
          if (editingField === 'title' && 'title' in filteredUpdates) {
            delete filteredUpdates.title
          } else if (editingField === 'content' && 'content' in filteredUpdates) {
            delete filteredUpdates.content
          }
          if (Object.keys(filteredUpdates).length === 0) {
            return
          }
          isApplyingRemoteChanges.current = true
          store.updateNode(id, filteredUpdates)
          isApplyingRemoteChanges.current = false
        } else {
          isApplyingRemoteChanges.current = true
          store.updateNode(id, updates)
          isApplyingRemoteChanges.current = false
        }
      }
    }

    const handleRemoveNode = (data: unknown) => {
      const { id } = data as { id: string }
      const store = useCanvasStore.getState()
      isApplyingRemoteChanges.current = true
      store.removeNode(id)
      isApplyingRemoteChanges.current = false
    }

    const handleAddGroup = (data: unknown) => {
      const group = data as NodeGroup
      const store = useCanvasStore.getState()
      if (!store.groups.has(group.id)) {
        isApplyingRemoteChanges.current = true
        store.addGroup(group)
        isApplyingRemoteChanges.current = false
      }
    }

    const handleUpdateGroup = (data: unknown) => {
      const { id, updates } = data as { id: string; updates: Partial<NodeGroup> }
      const store = useCanvasStore.getState()
      if (store.groups.has(id)) {
        isApplyingRemoteChanges.current = true
        store.updateGroup(id, updates)
        isApplyingRemoteChanges.current = false
      }
    }

    const handleRemoveGroup = (data: unknown) => {
      const { id } = data as { id: string }
      const store = useCanvasStore.getState()
      isApplyingRemoteChanges.current = true
      store.removeGroup(id)
      isApplyingRemoteChanges.current = false
    }

    const handleAddDomain = (data: unknown) => {
      const domain = data as Domain
      const store = useCanvasStore.getState()
      if (!store.domains.has(domain.id)) {
        isApplyingRemoteChanges.current = true
        store.addDomain(domain)
        isApplyingRemoteChanges.current = false
      }
    }

    const handleUpdateDomain = (data: unknown) => {
      const { id, updates } = data as { id: string; updates: Partial<Domain> }
      const store = useCanvasStore.getState()
      if (store.domains.has(id)) {
        isApplyingRemoteChanges.current = true
        store.updateDomain(id, updates)
        isApplyingRemoteChanges.current = false
      }
    }

    const handleRemoveDomain = (data: unknown) => {
      const { id } = data as { id: string }
      const store = useCanvasStore.getState()
      isApplyingRemoteChanges.current = true
      store.removeDomain(id)
      isApplyingRemoteChanges.current = false
    }

    const handleAddConnection = (data: unknown) => {
      const connection = data as Connection
      const store = useCanvasStore.getState()
      if (!store.connections.has(connection.id)) {
        isApplyingRemoteChanges.current = true
        store.addConnection(connection)
        isApplyingRemoteChanges.current = false
      }
    }

    const handleUpdateConnection = (data: unknown) => {
      const { id, updates } = data as { id: string; updates: Partial<Connection> }
      const store = useCanvasStore.getState()
      if (store.connections.has(id)) {
        isApplyingRemoteChanges.current = true
        store.updateConnection(id, updates)
        isApplyingRemoteChanges.current = false
      }
    }

    const handleRemoveConnection = (data: unknown) => {
      const { id } = data as { id: string }
      const store = useCanvasStore.getState()
      isApplyingRemoteChanges.current = true
      store.removeConnection(id)
      isApplyingRemoteChanges.current = false
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

    const unsubscribe = useCanvasStore.subscribe((state, prevState) => {
      if (isApplyingRemoteChanges.current) return

      if (state.nodes !== prevState.nodes) {
        const addedNodes: Node[] = []
        const updatedNodes: { id: string; updates: Partial<Node> }[] = []
        const removedNodeIds: string[] = []

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

        addedNodes.forEach(node => collabService.sendOperation('add-node', node))
        updatedNodes.forEach(({ id, updates }) => collabService.sendOperation('update-node', { id, updates }))
        removedNodeIds.forEach(id => collabService.sendOperation('remove-node', { id }))
      }

      if (state.groups !== prevState.groups) {
        const addedGroups: NodeGroup[] = []
        const updatedGroups: { id: string; updates: Partial<NodeGroup> }[] = []
        const removedGroupIds: string[] = []

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

        addedGroups.forEach(group => collabService.sendOperation('add-group', group))
        updatedGroups.forEach(({ id, updates }) => collabService.sendOperation('update-group', { id, updates }))
        removedGroupIds.forEach(id => collabService.sendOperation('remove-group', { id }))
      }

      if (state.domains !== prevState.domains) {
        const addedDomains: Domain[] = []
        const updatedDomains: { id: string; updates: Partial<Domain> }[] = []
        const removedDomainIds: string[] = []

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

        addedDomains.forEach(domain => collabService.sendOperation('add-domain', domain))
        updatedDomains.forEach(({ id, updates }) => collabService.sendOperation('update-domain', { id, updates }))
        removedDomainIds.forEach(id => collabService.sendOperation('remove-domain', { id }))
      }

      if (state.connections !== prevState.connections) {
        const addedConnections: Connection[] = []
        const updatedConnections: { id: string; updates: Partial<Connection> }[] = []
        const removedConnectionIds: string[] = []

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

        addedConnections.forEach(connection => collabService.sendOperation('add-connection', connection))
        updatedConnections.forEach(({ id, updates }) => collabService.sendOperation('update-connection', { id, updates }))
        removedConnectionIds.forEach(id => collabService.sendOperation('remove-connection', { id }))
      }
    })

    return () => {
      unsubscribe()
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
