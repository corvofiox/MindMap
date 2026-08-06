/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the Yjs ↔ Zustand binding (yjsBinding.ts).
 *
 * Covers:
 *   - Remote doc change → store update (observer path)
 *   - Local store mutation → doc update (applyDiff path)
 *   - isApplyingRemoteChanges guard prevents feedback loops
 *   - writeFields preserves Y.Array identity for CRDT merge
 *   - Observer reads live store state, not the stale creation-time snapshot
 */
import { describe, it, expect, vi } from 'vitest'
import * as Y from 'yjs'
import { ensureRoot, getExistingRoot, entityToYMap } from '../services/yjs-schema'
import type { Node, NodeGroup, Domain, Connection } from '@/types'

/**
 * Live state that useCanvasStore.getState() returns.
 * Mutated in-place by the mock store's addNode/removeNode/update* methods
 * so the state returned by getState() is always current.
 */
const liveState = {
  nodes: null as Map<string, any> | null,
  groups: null as Map<string, any> | null,
  domains: null as Map<string, any> | null,
  connections: null as Map<string, any> | null,
}

vi.mock('@/store/useCanvasStore', () => ({
  useCanvasStore: {
    getState: () => ({
      nodes: liveState.nodes ?? new Map(),
      groups: liveState.groups ?? new Map(),
      domains: liveState.domains ?? new Map(),
      connections: liveState.connections ?? new Map(),
    }),
  },
}))

// Dynamically import yjsBinding after the mock is set up (vitest hoists vi.mock
// to the top, but the dynamic import ensures the mock is active when the
// module is first evaluated).
const { bindYjsToStore, LOCAL_ORIGIN } = await import('../services/yjsBinding')

/** Minimal mock store that records every mutation call.
 *  Also registers its Maps in `liveState` so that the mocked
 *  useCanvasStore.getState() returns them — this is how the binding
 *  observes live state instead of the stale snapshot. */
function createMockStore() {
  const nodes = new Map<string, Node>()
  const groups = new Map<string, NodeGroup>()
  const domains = new Map<string, Domain>()
  const connections = new Map<string, Connection>()
  // Make the mocked useCanvasStore.getState() return these live maps.
  liveState.nodes = nodes
  liveState.groups = groups
  liveState.domains = domains
  liveState.connections = connections
  const calls: string[] = []
  return {
    nodes,
    groups,
    domains,
    connections,
    calls,
    addNode: vi.fn((n: Node) => { nodes.set(n.id, n); calls.push('addNode') }),
    addGroup: vi.fn((g: NodeGroup) => { groups.set(g.id, g); calls.push('addGroup') }),
    addDomain: vi.fn((d: Domain) => { domains.set(d.id, d); calls.push('addDomain') }),
    addConnection: vi.fn((c: Connection) => { connections.set(c.id, c); calls.push('addConnection') }),
    updateNodeWithoutHistory: vi.fn((id: string, updates: Partial<Node>) => {
      const existing = nodes.get(id)
      if (existing) nodes.set(id, { ...existing, ...updates })
      calls.push('updateNode')
    }),
    updateGroupWithoutHistory: vi.fn((id: string, updates: Partial<NodeGroup>) => {
      const existing = groups.get(id)
      if (existing) groups.set(id, { ...existing, ...updates })
      calls.push('updateGroup')
    }),
    updateDomainWithoutHistory: vi.fn((id: string, updates: Partial<Domain>) => {
      const existing = domains.get(id)
      if (existing) domains.set(id, { ...existing, ...updates })
      calls.push('updateDomain')
    }),
    updateConnectionWithoutHistory: vi.fn((id: string, updates: Partial<Connection>) => {
      const existing = connections.get(id)
      if (existing) connections.set(id, { ...existing, ...updates })
      calls.push('updateConnection')
    }),
    removeNode: vi.fn((id: string) => { nodes.delete(id); calls.push('removeNode') }),
    removeGroup: vi.fn((id: string) => { groups.delete(id); calls.push('removeGroup') }),
    removeDomain: vi.fn((id: string) => { domains.delete(id); calls.push('removeDomain') }),
    removeConnection: vi.fn((id: string) => { connections.delete(id); calls.push('removeConnection') }),
    setCanvasData: vi.fn(() => { calls.push('setCanvasData') }),
  }
}

/** Minimal mock provider — needs doc, sync status and role. */
function createMockProvider(doc: Y.Doc, isSynced = true, role: 'owner' | 'editor' | 'viewer' = 'editor') {
  return {
    doc,
    getIsSynced: () => isSynced,
    getRole: () => role,
  } as any
}

describe('yjsBinding', () => {
  describe('remote → store (observer)', () => {
    it('fires addNode when a new node is added to the doc', () => {
      const doc = new Y.Doc()
      ensureRoot(doc)
      const store = createMockStore()
      const binding = bindYjsToStore(createMockProvider(doc), store as any)

      const collections = ensureRoot(doc)
      doc.transact(() => {
        collections.nodes.set('n1', entityToYMap({ id: 'n1', x: 1, y: 2, title: 'Test' }))
      }) // origin = null → treated as remote

      expect(store.addNode).toHaveBeenCalledWith(expect.objectContaining({ id: 'n1' }))
      binding.destroy()
    })

    it('fires updateNode when an existing node field changes', () => {
      const doc = new Y.Doc()
      ensureRoot(doc)
      const store = createMockStore()
      // Pre-seed store with an existing node
      store.nodes.set('n1', { id: 'n1', x: 1, y: 2, title: 'Old' } as any)
      const binding = bindYjsToStore(createMockProvider(doc), store as any)

      const collections = ensureRoot(doc)
      // Pre-seed doc with the same node
      doc.transact(() => {
        collections.nodes.set('n1', entityToYMap({ id: 'n1', x: 1, y: 2, title: 'Old' }))
      }, LOCAL_ORIGIN) // local origin → observer skips

      // Now make a remote change (origin = null)
      doc.transact(() => {
        const ymap = collections.nodes.get('n1')!
        ymap.set('title', 'New')
      })

      expect(store.updateNodeWithoutHistory).toHaveBeenCalledWith('n1', expect.objectContaining({ title: 'New' }), true)
      binding.destroy()
    })

    it('fires removeNode when a node is deleted from the doc', () => {
      const doc = new Y.Doc()
      ensureRoot(doc)
      const store = createMockStore()
      store.nodes.set('n1', { id: 'n1', x: 1, y: 2 } as any)
      const binding = bindYjsToStore(createMockProvider(doc), store as any)

      const collections = ensureRoot(doc)
      doc.transact(() => {
        collections.nodes.set('n1', entityToYMap({ id: 'n1', x: 1, y: 2 }))
      }, LOCAL_ORIGIN)

      doc.transact(() => {
        collections.nodes.delete('n1')
      })

      expect(store.removeNode).toHaveBeenCalledWith('n1')
      binding.destroy()
    })

    it('skips observer when origin is LOCAL_ORIGIN', () => {
      const doc = new Y.Doc()
      ensureRoot(doc)
      const store = createMockStore()
      const binding = bindYjsToStore(createMockProvider(doc), store as any)

      const collections = ensureRoot(doc)
      doc.transact(() => {
        collections.nodes.set('n1', entityToYMap({ id: 'n1', x: 1, y: 2 }))
      }, LOCAL_ORIGIN)

      expect(store.addNode).not.toHaveBeenCalled()
      binding.destroy()
    })

    it('fires addNode when origin is the provider instance (R2-2 fix)', () => {
      const doc = new Y.Doc()
      ensureRoot(doc)
      const provider = createMockProvider(doc)
      const store = createMockStore()
      const binding = bindYjsToStore(provider, store as any)

      const collections = ensureRoot(doc)
      doc.transact(() => {
        collections.nodes.set('n1', entityToYMap({ id: 'n1', x: 1, y: 2 }))
      }, provider)

      // With the R2-2 fix, provider-origin updates MUST propagate to the store.
      // Previously this was blocked, which broke all remote→store sync in production
      // (the provider passes itself as origin in handleBinary's readSyncMessage call).
      expect(store.addNode).toHaveBeenCalledWith(expect.objectContaining({ id: 'n1' }))
      binding.destroy()
    })

    it('reads live store state after initial sync populates the store via observer', () => {
      // Simulate the real scenario: binding created with empty store,
      // then initial sync populates store via observer, then a subsequent
      // remote update correctly updates (not re-adds) existing entities.
      const doc = new Y.Doc()
      ensureRoot(doc)
      const store = createMockStore()
      // store.nodes is EMPTY at binding time — just like in the real app
      // where the store hasn't loaded any canvas data yet.
      const binding = bindYjsToStore(createMockProvider(doc), store as any)

      const collections = ensureRoot(doc)

      // Step 1: initial sync adds n1 to the doc (as a remote change).
      doc.transact(() => {
        collections.nodes.set('n1', entityToYMap({ id: 'n1', x: 1, y: 2, title: 'Initial' }))
      })
      // Observer fires → should call addNode because store.nodes is still empty
      // but useCanvasStore.getState().nodes is now populated (via the mock).
      expect(store.addNode).toHaveBeenCalled()

      // Step 2: now a remote update for n1 arrives.
      store.addNode.mockClear()
      store.updateNodeWithoutHistory.mockClear()
      doc.transact(() => {
        collections.nodes.get('n1')!.set('title', 'Updated')
      })
      // CRITICAL: must call updateNodeWithoutHistory, NOT addNode.
      // If addNode is called, the update is silently lost (addNode's has() check
      // skips it because n1 already exists in the live store).
      expect(store.updateNodeWithoutHistory).toHaveBeenCalled()
      expect(store.addNode).not.toHaveBeenCalled()
      binding.destroy()
    })
  })

  describe('store → doc (applyDiff)', () => {
    it('adds new entities to the doc', () => {
      const doc = new Y.Doc()
      ensureRoot(doc)
      const store = createMockStore()
      const binding = bindYjsToStore(createMockProvider(doc), store as any)

      const before = { nodes: new Map(), groups: new Map(), domains: new Map(), connections: new Map() }
      const after = {
        nodes: new Map([['n1', { id: 'n1', x: 1, y: 2 } as any]]),
        groups: new Map(),
        domains: new Map(),
        connections: new Map(),
      }
      binding.applyDiff(before, after)

      const collections = ensureRoot(doc)
      expect(collections.nodes.get('n1')).toBeDefined()
      const ymap = collections.nodes.get('n1')!
      expect(ymap.get('x')).toBe(1)
      binding.destroy()
    })

    it('deletes removed entities from the doc', () => {
      const doc = new Y.Doc()
      ensureRoot(doc)
      const store = createMockStore()
      const binding = bindYjsToStore(createMockProvider(doc), store as any)

      // Seed the doc with a node via applyDiff
      const before0 = { nodes: new Map(), groups: new Map(), domains: new Map(), connections: new Map() }
      const after0 = {
        nodes: new Map([['n1', { id: 'n1', x: 1, y: 2 } as any]]),
        groups: new Map(),
        domains: new Map(),
        connections: new Map(),
      }
      binding.applyDiff(before0, after0)

      // Now remove it
      binding.applyDiff(after0, before0)

      const collections = ensureRoot(doc)
      expect(collections.nodes.has('n1')).toBe(false)
      binding.destroy()
    })

    it('updates changed entity fields in-place', () => {
      const doc = new Y.Doc()
      ensureRoot(doc)
      const store = createMockStore()
      const binding = bindYjsToStore(createMockProvider(doc), store as any)

      const node = { id: 'n1', x: 1, y: 2, title: 'Old' } as any
      const before = { nodes: new Map([['n1', node]]), groups: new Map(), domains: new Map(), connections: new Map() }
      const after = {
        nodes: new Map([['n1', { ...node, title: 'New' } as any]]),
        groups: new Map(),
        domains: new Map(),
        connections: new Map(),
      }
      binding.applyDiff(before, after)

      const collections = ensureRoot(doc)
      expect(collections.nodes.get('n1')!.get('title')).toBe('New')
      binding.destroy()
    })
  })

  describe('writeFields array diff (Bug 1 fix)', () => {
    it('does not rewrite unchanged array fields when a sibling scalar changes', () => {
      const doc = new Y.Doc()
      ensureRoot(doc)
      const store = createMockStore()
      const binding = bindYjsToStore(createMockProvider(doc), store as any)
      const collections = ensureRoot(doc)

      const groupData = {
        id: 'g1', name: 'Old', nodeIds: ['n1', 'n2'],
        x: 0, y: 0, width: 100, height: 100,
        borderColor: '#000', backgroundColor: '#fff',
        borderWidth: 1, borderRadius: 4, collapsed: false,
      }

      doc.transact(() => {
        collections.groups.set('g1', entityToYMap(groupData))
      }, LOCAL_ORIGIN)

      const yArrayBefore = collections.groups.get('g1')!.get('nodeIds') as Y.Array<unknown>

      binding.applyDiff(
        { nodes: new Map(), groups: new Map([['g1', { ...groupData } as any]]), domains: new Map(), connections: new Map() },
        { nodes: new Map(), groups: new Map([['g1', { ...groupData, name: 'New' } as any]]), domains: new Map(), connections: new Map() },
      )

      const yArrayAfter = collections.groups.get('g1')!.get('nodeIds') as Y.Array<unknown>
      expect(yArrayAfter).toBe(yArrayBefore)
      expect(yArrayAfter.toArray()).toEqual(['n1', 'n2'])
      expect(yArrayAfter.length).toBe(2)
      binding.destroy()
    })

    it('merges concurrent edits to different fields without array duplicates', () => {
      const docA = new Y.Doc()
      ensureRoot(docA)
      const docB = new Y.Doc()
      ensureRoot(docB)

      const groupData = {
        id: 'g1', name: 'Old', nodeIds: ['n1', 'n2'],
        x: 0, y: 0, width: 100, height: 100,
        borderColor: '#000', backgroundColor: '#fff',
        borderWidth: 1, borderRadius: 4, collapsed: false,
      }

      docA.transact(() => {
        ensureRoot(docA).groups.set('g1', entityToYMap(groupData))
      })
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))

      const storeA = createMockStore()
      storeA.groups.set('g1', { ...groupData } as any)
      const bindingA = bindYjsToStore(createMockProvider(docA), storeA as any)

      const storeB = createMockStore()
      storeB.groups.set('g1', { ...groupData } as any)
      const bindingB = bindYjsToStore(createMockProvider(docB), storeB as any)

      bindingA.applyDiff(
        { nodes: new Map(), groups: new Map([['g1', { ...groupData } as any]]), domains: new Map(), connections: new Map() },
        { nodes: new Map(), groups: new Map([['g1', { ...groupData, name: 'NewName' } as any]]), domains: new Map(), connections: new Map() },
      )

      bindingB.applyDiff(
        { nodes: new Map(), groups: new Map([['g1', { ...groupData } as any]]), domains: new Map(), connections: new Map() },
        { nodes: new Map(), groups: new Map([['g1', { ...groupData, nodeIds: ['n1', 'n2', 'n3'] } as any]]), domains: new Map(), connections: new Map() },
      )

      Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB))
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))

      const nodeIdsA = (ensureRoot(docA).groups.get('g1')!.get('nodeIds') as Y.Array<unknown>).toArray()
      const nodeIdsB = (ensureRoot(docB).groups.get('g1')!.get('nodeIds') as Y.Array<unknown>).toArray()

      expect(nodeIdsA).toHaveLength(3)
      expect(nodeIdsB).toHaveLength(3)
      expect(new Set(nodeIdsA)).toEqual(new Set(['n1', 'n2', 'n3']))
      expect(new Set(nodeIdsB)).toEqual(new Set(['n1', 'n2', 'n3']))

      bindingA.destroy()
      bindingB.destroy()
    })

    it('diffs primitive arrays by value (add/remove only changed elements)', () => {
      const doc = new Y.Doc()
      ensureRoot(doc)
      const store = createMockStore()
      const binding = bindYjsToStore(createMockProvider(doc), store as any)
      const collections = ensureRoot(doc)

      const groupData = {
        id: 'g1', name: 'G', nodeIds: ['n1', 'n2', 'n3'],
        x: 0, y: 0, width: 100, height: 100,
        borderColor: '#000', backgroundColor: '#fff',
        borderWidth: 1, borderRadius: 4, collapsed: false,
      }

      doc.transact(() => {
        collections.groups.set('g1', entityToYMap(groupData))
      }, LOCAL_ORIGIN)

      binding.applyDiff(
        { nodes: new Map(), groups: new Map([['g1', { ...groupData } as any]]), domains: new Map(), connections: new Map() },
        { nodes: new Map(), groups: new Map([['g1', { ...groupData, nodeIds: ['n1', 'n3', 'n4'] } as any]]), domains: new Map(), connections: new Map() },
      )

      const yArray = collections.groups.get('g1')!.get('nodeIds') as Y.Array<unknown>
      const result = yArray.toArray()
      expect(result).toContain('n1')
      expect(result).toContain('n3')
      expect(result).toContain('n4')
      expect(result).not.toContain('n2')
      expect(result).toHaveLength(3)
      binding.destroy()
    })

    it('diffs object arrays by id (bendPoints)', () => {
      const doc = new Y.Doc()
      ensureRoot(doc)
      const store = createMockStore()
      const binding = bindYjsToStore(createMockProvider(doc), store as any)
      const collections = ensureRoot(doc)

      const connData = {
        id: 'c1', fromNodeId: 'a', toNodeId: 'b',
        fromPort: 'right', toPort: 'left',
        type: 'curve', style: 'solid', color: '#000', width: 2,
        arrowType: 'end', direction: 'directed',
        bendPoints: [{ id: 'bp1', x: 10, y: 20 }],
      }

      doc.transact(() => {
        collections.connections.set('c1', entityToYMap(connData))
      }, LOCAL_ORIGIN)

      binding.applyDiff(
        { nodes: new Map(), groups: new Map(), domains: new Map(), connections: new Map([['c1', { ...connData } as any]]) },
        { nodes: new Map(), groups: new Map(), domains: new Map(), connections: new Map([['c1', { ...connData, bendPoints: [{ id: 'bp1', x: 10, y: 20 }, { id: 'bp2', x: 30, y: 40 }] } as any]]) },
      )

      const yArray = collections.connections.get('c1')!.get('bendPoints') as Y.Array<unknown>
      const result = yArray.toArray()
      expect(result).toHaveLength(2)
      expect((result[0] as any).id).toBe('bp1')
      expect((result[1] as any).id).toBe('bp2')
      binding.destroy()
    })
  })

  describe('isApplyingRemoteChanges guard', () => {
    it('is true while observer applies remote changes, false otherwise', () => {
      const doc = new Y.Doc()
      ensureRoot(doc)
      const store = createMockStore()
      store.nodes.set('n1', { id: 'n1', x: 1, y: 2, title: 'Old' } as any)
      const binding = bindYjsToStore(createMockProvider(doc), store as any)

      const collections = ensureRoot(doc)
      doc.transact(() => {
        collections.nodes.set('n1', entityToYMap({ id: 'n1', x: 1, y: 2, title: 'Old' }))
      }, LOCAL_ORIGIN)

      // During the remote transaction below, isApplyingRemoteChanges should be true.
      let observedFlag: boolean | null = null
      store.updateNodeWithoutHistory.mockImplementation(() => {
        observedFlag = binding.isApplyingRemoteChanges
      })

      doc.transact(() => {
        collections.nodes.get('n1')!.set('title', 'Changed')
      })

      expect(observedFlag).toBe(true)
      expect(binding.isApplyingRemoteChanges).toBe(false)
      binding.destroy()
    })
  })

  describe('destroy', () => {
    it('stops observers after destroy', () => {
      const doc = new Y.Doc()
      ensureRoot(doc)
      const store = createMockStore()
      const binding = bindYjsToStore(createMockProvider(doc), store as any)
      binding.destroy()

      const collections = ensureRoot(doc)
      doc.transact(() => {
        collections.nodes.set('n1', entityToYMap({ id: 'n1', x: 1, y: 2 }))
      })

      expect(store.addNode).not.toHaveBeenCalled()
    })
  })

  describe('initial sync helpers', () => {
    it('syncLocalStateToYDoc writes local store entities into the doc', () => {
      const doc = new Y.Doc()
      const store = createMockStore()
      store.nodes.set('n1', { id: 'n1', x: 10, y: 20, title: 'Local' } as any)
      const binding = bindYjsToStore(createMockProvider(doc, true), store as any)

      binding.syncLocalStateToYDoc()

      const collections = ensureRoot(doc)
      expect(collections.nodes.has('n1')).toBe(true)
      expect(collections.nodes.get('n1')!.get('x')).toBe(10)
      expect(collections.nodes.get('n1')!.get('title')).toBe('Local')
      binding.destroy()
    })

    it('syncLocalStateToYDoc does nothing before STEP2 sync', () => {
      const doc = new Y.Doc()
      const store = createMockStore()
      store.nodes.set('n1', { id: 'n1', x: 10, y: 20, title: 'Local' } as any)
      const binding = bindYjsToStore(createMockProvider(doc, false), store as any)

      binding.syncLocalStateToYDoc()

      expect(getExistingRoot(doc)).toBeNull()
      binding.destroy()
    })

    it('syncLocalStateToYDoc does nothing for viewers', () => {
      const doc = new Y.Doc()
      const store = createMockStore()
      store.nodes.set('n1', { id: 'n1', x: 10, y: 20 } as any)
      const binding = bindYjsToStore(createMockProvider(doc, false, 'viewer'), store as any)

      binding.syncLocalStateToYDoc()

      const collections = ensureRoot(doc)
      expect(collections.nodes.has('n1')).toBe(false)
      binding.destroy()
    })

    it('syncYDocToLocalState adds server-only entities to the store', () => {
      const doc = new Y.Doc()
      ensureRoot(doc)
      doc.transact(() => {
        ensureRoot(doc).nodes.set('n1', entityToYMap({ id: 'n1', x: 1, y: 2, title: 'Server' }))
      })
      const store = createMockStore()
      const binding = bindYjsToStore(createMockProvider(doc, true), store as any)

      binding.syncYDocToLocalState()

      expect(store.addNode).toHaveBeenCalledWith(expect.objectContaining({ id: 'n1', title: 'Server' }))
      binding.destroy()
    })

    it('syncYDocToLocalState removes entities deleted on the server', () => {
      const doc = new Y.Doc()
      ensureRoot(doc)
      const store = createMockStore()
      store.nodes.set('n1', { id: 'n1', x: 1, y: 2 } as any)
      store.nodes.set('n2', { id: 'n2', x: 3, y: 4 } as any)

      // Server doc only retains n1.
      doc.transact(() => {
        ensureRoot(doc).nodes.set('n1', entityToYMap({ id: 'n1', x: 10, y: 20 }))
      })

      const binding = bindYjsToStore(createMockProvider(doc, true), store as any)
      binding.syncYDocToLocalState()

      expect(store.removeNode).toHaveBeenCalledWith('n2')
      expect(store.removeNode).not.toHaveBeenCalledWith('n1')
      binding.destroy()
    })

    it('preserves local store when server doc is brand-new empty on reconnect', () => {
      // Regression test for: real-time collaboration clears the canvas when
      // the server reconnects to a brand-new empty doc (e.g. process restart or
      // empty yjsUpdate column). The local store must be preserved and mirrored
      // back to the doc instead of being deleted.
      const doc = new Y.Doc()
      ensureRoot(doc) // server STEP2 delivered an empty root structure only
      const store = createMockStore()
      store.nodes.set('n1', { id: 'n1', x: 1, y: 2, title: 'Local' } as any)
      store.domains.set('d1', { id: 'd1', name: 'Domain' } as any)

      const binding = bindYjsToStore(createMockProvider(doc, true), store as any)
      binding.syncYDocToLocalState()

      // Local entities must NOT be removed.
      expect(store.removeNode).not.toHaveBeenCalled()
      expect(store.removeDomain).not.toHaveBeenCalled()
      // They must be mirrored into the empty doc.
      const collections = ensureRoot(doc)
      expect(collections.nodes.has('n1')).toBe(true)
      expect(collections.nodes.get('n1')!.get('title')).toBe('Local')
      expect(collections.domains.has('d1')).toBe(true)
      binding.destroy()
    })

    it('wipes local store when server doc was intentionally emptied by peers', () => {
      // If peers deleted all entities while we were offline, the server doc
      // still carries deletion history. We must trust that authoritative empty
      // state and remove our stale local entities.
      const doc = new Y.Doc()
      ensureRoot(doc)
      doc.transact(() => {
        ensureRoot(doc).nodes.set('n1', entityToYMap({ id: 'n1', x: 0, y: 0, title: 'Server' }))
      })
      doc.transact(() => {
        ensureRoot(doc).nodes.delete('n1')
      })
      expect(ensureRoot(doc).nodes.size).toBe(0)

      const store = createMockStore()
      store.nodes.set('n1', { id: 'n1', x: 1, y: 2, title: 'Stale' } as any)

      const binding = bindYjsToStore(createMockProvider(doc, true), store as any)
      binding.syncYDocToLocalState()

      // Stale local entity must be removed because the doc has deletion history.
      expect(store.removeNode).toHaveBeenCalledWith('n1')
      // The local entity must NOT be mirrored back to the authoritative doc.
      expect(ensureRoot(doc).nodes.has('n1')).toBe(false)
      binding.destroy()
    })

    it('reconnectObservers attaches observers once root maps exist', () => {
      const doc = new Y.Doc()
      const store = createMockStore()
      const binding = bindYjsToStore(createMockProvider(doc, false), store as any)

      // Before root maps exist no observer is attached.
      expect(store.addNode).not.toHaveBeenCalled()

      // Simulate STEP2 creating the authoritative root maps.
      ensureRoot(doc)
      binding.reconnectObservers()

      const collections = ensureRoot(doc)
      doc.transact(() => {
        collections.nodes.set('n1', entityToYMap({ id: 'n1', x: 1, y: 2 }))
      })

      expect(store.addNode).toHaveBeenCalledWith(expect.objectContaining({ id: 'n1' }))
      binding.destroy()
    })
  })

  describe('import into doc', () => {
    it('replaces all doc entities and skips the local observer', () => {
      const doc = new Y.Doc()
      const collections = ensureRoot(doc)
      doc.transact(() => {
        collections.nodes.set('old', entityToYMap({ id: 'old', x: 0, y: 0, title: 'Old' }))
      })

      const store = createMockStore()
      const binding = bindYjsToStore(createMockProvider(doc, true), store as any)

      const imported = binding.importIntoDoc({
        nodes: [{ id: 'new', x: 1, y: 2, title: 'New' } as any],
        groups: [{ id: 'g1', name: 'G', x: 0, y: 0, width: 100, height: 100, borderColor: '#000', backgroundColor: '#fff', borderWidth: 1, borderRadius: 0, nodeIds: [], collapsed: false }],
        domains: [{ id: 'd1', name: 'D', x: 0, y: 0, width: 100, height: 100, backgroundColor: '#fff', titleVisible: true }],
        connections: [{ id: 'c1', fromNodeId: 'new', toNodeId: 'new', fromPort: 'right', toPort: 'left', type: 'curve', style: 'solid', color: '#000', width: 1, arrowType: 'end', direction: 'directed' } as any],
      })

      expect(imported).toBe(true)
      expect(collections.nodes.has('new')).toBe(true)
      expect(collections.nodes.has('old')).toBe(false)
      expect(collections.groups.has('g1')).toBe(true)
      expect(collections.domains.has('d1')).toBe(true)
      expect(collections.connections.has('c1')).toBe(true)
      // LOCAL_ORIGIN must not trigger the local observer.
      expect(store.addNode).not.toHaveBeenCalled()
      expect(store.removeNode).not.toHaveBeenCalled()
      binding.destroy()
    })

    it('propagates the imported state to a remote doc', () => {
      const localDoc = new Y.Doc()
      ensureRoot(localDoc)
      const remoteDoc = new Y.Doc()

      const store = createMockStore()
      const binding = bindYjsToStore(createMockProvider(localDoc, true), store as any)

      binding.importIntoDoc({
        nodes: [{ id: 'r1', x: 5, y: 6, title: 'Remote' } as any],
        groups: [],
        domains: [],
        connections: [],
      })

      // Simulate the provider sending the missing updates to the server/peer.
      const update = Y.encodeStateAsUpdate(localDoc, Y.encodeStateVector(remoteDoc))
      Y.applyUpdate(remoteDoc, update)

      const remoteCollections = ensureRoot(remoteDoc)
      expect(remoteCollections.nodes.has('r1')).toBe(true)
      binding.destroy()
    })

    it('returns false when the doc root is not yet available', () => {
      const doc = new Y.Doc()
      const store = createMockStore()
      const binding = bindYjsToStore(createMockProvider(doc, false), store as any)

      const imported = binding.importIntoDoc({
        nodes: [{ id: 'n1', x: 0, y: 0, title: 'X' } as any],
        groups: [],
        domains: [],
        connections: [],
      })

      expect(imported).toBe(false)
      binding.destroy()
    })

    // R7 回归测试:删除→撤销恢复的实体,store 中已存在,必须正常接收远端更新。
    // 旧实现(C18 一刀切 isLocalDeletion 检查)会永久跳过该实体的远端更新,
    // 导致实体冻结在撤销时刻。修复后:仅"store 无此实体且已声明删除"才跳过。
    it('applies remote updates to an entity restored by local undo after deletion', async () => {
      const doc = new Y.Doc()
      ensureRoot(doc)
      const store = createMockStore()
      // 提供 canvasId 以便 recordLocalDeletion/isLocalDeletion 使用
      const provider = { ...createMockProvider(doc), canvasId: 9999 } as any
      const binding = bindYjsToStore(provider, store as any)
      // 动态导入 yjsProvider(与顶部 mock useCanvasStore 的加载时序一致)
      const yjsProvider = await import('../services/yjsProvider')

      const collections = ensureRoot(doc)

      // 1. 本地删除 n1 并声明删除
      store.nodes.set('n1', { id: 'n1', x: 1, y: 2, title: 'A' } as any)
      // 模拟 applyDiff 的删除路径:记录 localDeletion
      yjsProvider.recordLocalDeletion(9999, 'nodes', 'n1')

      // 2. 撤销:store 恢复 n1(模拟撤销后 store 已有该实体)
      store.nodes.set('n1', { id: 'n1', x: 1, y: 2, title: 'A' } as any)

      // 3. 远端更新 n1(顶层 key set 事件)
      doc.transact(() => {
        collections.nodes.set('n1', entityToYMap({ id: 'n1', x: 100, y: 200, title: 'Remote' }))
      })

      // 4. 修复后:store 已有 n1(撤销恢复)→ 不应跳过,应应用远端更新
      expect(store.nodes.get('n1')?.title).toBe('Remote')
      expect(store.nodes.get('n1')?.x).toBe(100)

      binding.destroy()
      // 清理模块级 localDeletions,避免污染其他测试
      yjsProvider.clearLocalDeletions(9999)
    })
  })
})
