/**
 * Bind a Y.Doc (from MindMapYjsProvider) to the Zustand useCanvasStore.
 *
 * Two-way data flow:
 *   1. Remote doc changes → observer → store.updateXxxWithoutHistory()
 *      (guarded by isApplyingRemoteChanges so the store's command history is
 *       untouched and no further echo is generated).
 *   2. Local commands call binding.writeToYDoc(() => { ... }) to mutate the doc
 *      inside a transaction tagged with LOCAL_ORIGIN. The observer sees the
 *      LOCAL_ORIGIN tag and skips the store update — the command already
 *      updated the store directly.
 *
 * This is "方案 B" from the migration design: the existing ownCommands undo
 * stack is preserved verbatim, and Yjs is purely a sync transport.
 */
import * as Y from 'yjs'
import type { Node, NodeGroup, Domain, Connection } from '@/types'
import { ensureRoot, entityToYMap, ymapToObject } from './yjs-schema'
import type { MindMapYjsProvider } from './yjsProvider'
import { useCanvasStore } from '@/store/useCanvasStore'

/**
 * Origin tag applied to every local transaction. The observer checks against
 * this to distinguish local mutations from remote ones.
 */
export const LOCAL_ORIGIN = Symbol('local-canvas-mutation')

/** Type of the store methods the binding consumes. Defined as a struct so we
 *  don't import the full store type (avoids a circular dependency). */
export interface CanvasStoreBinding {
  nodes: Map<string, Node>
  groups: Map<string, NodeGroup>
  domains: Map<string, Domain>
  connections: Map<string, Connection>
  addNode: (node: Node) => void
  addGroup: (group: NodeGroup) => void
  addDomain: (domain: Domain) => void
  addConnection: (connection: Connection) => void
  updateNodeWithoutHistory: (id: string, updates: Partial<Node>, markDirty?: boolean) => void
  updateGroupWithoutHistory: (id: string, updates: Partial<NodeGroup>, markDirty?: boolean) => void
  updateDomainWithoutHistory: (id: string, updates: Partial<Domain>, markDirty?: boolean) => void
  updateConnectionWithoutHistory: (id: string, updates: Partial<Connection>, markDirty?: boolean) => void
  removeNode: (id: string) => void
  removeGroup: (id: string) => void
  removeDomain: (id: string) => void
  removeConnection: (id: string) => void
  setCanvasData: (data: {
    nodes?: Node[]
    groups?: NodeGroup[]
    domains?: Domain[]
    connections?: Connection[]
  }) => void
}

export interface YjsCanvasBinding {
  /** Apply a before/after snapshot diff to the doc inside LOCAL_ORIGIN. */
  applyDiff: (
    before: { nodes: Map<string, Node>; groups: Map<string, NodeGroup>; domains: Map<string, Domain>; connections: Map<string, Connection> },
    after: { nodes: Map<string, Node>; groups: Map<string, NodeGroup>; domains: Map<string, Domain>; connections: Map<string, Connection> },
  ) => void
  /** True when the binding is currently applying remote changes to the store. */
  readonly isApplyingRemoteChanges: boolean
  /** Run a doc mutation as a local transaction (LOCAL_ORIGIN). */
  writeToYDoc: (fn: () => void) => void
  /** Accessor for the nodes Y.Map. */
  getYNodes: () => Y.Map<Y.Map<unknown>>
  getYGroups: () => Y.Map<Y.Map<unknown>>
  getYDomains: () => Y.Map<Y.Map<unknown>>
  getYConnections: () => Y.Map<Y.Map<unknown>>
  /** Detach all observers. */
  destroy: () => void
  /** Temporarily suppress Yjs sync (for initial data loading). */
  suppressSync: (fn: () => void) => void
}

/**
 * Wire a provider's Y.Doc to a Zustand store. Returns a binding handle whose
 * `writeToYDoc` should be called by the store's command.execute/undo to make
 * local changes propagate to the doc.
 */
export function bindYjsToStore(
  provider: MindMapYjsProvider,
  store: CanvasStoreBinding,
): YjsCanvasBinding {
  const doc = provider.doc
  const collections = ensureRoot(doc)
  const { nodes: yNodes, groups: yGroups, domains: yDomains, connections: yConnections } = collections

  // Guard against feedback loops: when the observer applies remote changes to
  // the store, set this flag so the store's syncDiffToYDoc skips the echo-back.
  let isApplyingRemoteChanges = false

  // NOTE on the `store` parameter vs `useCanvasStore.getState()`:
  // The `store` argument passed to bindYjsToStore is a snapshot captured at
  // binding-creation time. Its METHODS (addNode, removeNode, update*…) are
  // stable Zustand handlers that never go stale, so calling them is safe.
  // Its DATA fields (store.nodes, store.groups, …) however are Map references
  // from the snapshot — and Zustand replaces those Maps with fresh instances on
  // every `set({ nodes: new Map(...) })`. Reading store.nodes after the first
  // remote sync would observe a stale, empty Map.
  // Therefore the applyRemote* helpers below read the LIVE state via
  // `useCanvasStore.getState().xxx.get(id)` for existence checks, while still
  // invoking the stable `store.addXxx` / `store.updateXxxWithoutHistory`
  // methods to mutate. This is intentional, not a leak.

  /** Apply a remote node add/update. Reads the LIVE store state because
   *  `store.nodes` is a snapshot captured at binding-creation time and goes
   *  stale immediately after the first remote sync populates the store.
   *
   *  KNOWN LIMITATION: updateNodeWithoutHistory uses merge semantics
   *  ({ ...current, ...obj }), so fields present in the local node but absent
   *  from the remote Y.Map (i.e. fields the peer deleted) are NOT removed
   *  from the store. This is acceptable today because the app never deletes
   *  optional fields at runtime (imageUrl/aspectRatio/expandedHeight are set
   *  at creation and only overwritten, never cleared). If field deletion
   *  becomes a feature, applyRemote* must diff Object.keys(existing) vs
   *  Object.keys(obj) and explicitly set missing keys to undefined. */
  const applyRemoteNode = (id: string, ymap: Y.Map<unknown>) => {
    const obj = ymapToObject(ymap) as unknown as Node
    const existing = useCanvasStore.getState().nodes.get(id)
    if (!existing) {
      store.addNode({ ...obj, id })
    } else {
      // Handle field deletions: keys present in existing but absent from
      // remote Y.Map are not included by ymapToObject, so explicitly set
      // them to undefined so the store merge removes them.
      const newKeys = new Set(Object.keys(obj))
      for (const key of Object.keys(existing)) {
        if (!newKeys.has(key) && key !== 'id') {
          (obj as unknown as Record<string, unknown>)[key] = undefined
        }
      }
      store.updateNodeWithoutHistory(id, obj, true)
    }
  }

  const applyRemoteGroup = (id: string, ymap: Y.Map<unknown>) => {
    const obj = ymapToObject(ymap) as unknown as NodeGroup
    if (!useCanvasStore.getState().groups.get(id)) {
      store.addGroup({ ...obj, id })
    } else {
      // Handle field deletions: keys present in existing but absent from
      // remote Y.Map are not included by ymapToObject.
      const existing = useCanvasStore.getState().groups.get(id)!
      const newKeys = new Set(Object.keys(obj))
      for (const key of Object.keys(existing)) {
        if (!newKeys.has(key) && key !== 'id') {
          (obj as unknown as Record<string, unknown>)[key] = undefined
        }
      }
      store.updateGroupWithoutHistory(id, obj, true)
    }
  }

  const applyRemoteDomain = (id: string, ymap: Y.Map<unknown>) => {
    const obj = ymapToObject(ymap) as unknown as Domain
    if (!useCanvasStore.getState().domains.get(id)) {
      store.addDomain({ ...obj, id })
    } else {
      // Handle field deletions: keys present in existing but absent from
      // remote Y.Map are not included by ymapToObject.
      const existing = useCanvasStore.getState().domains.get(id)!
      const newKeys = new Set(Object.keys(obj))
      for (const key of Object.keys(existing)) {
        if (!newKeys.has(key) && key !== 'id') {
          (obj as unknown as Record<string, unknown>)[key] = undefined
        }
      }
      store.updateDomainWithoutHistory(id, obj, true)
    }
  }

  const applyRemoteConnection = (id: string, ymap: Y.Map<unknown>) => {
    const obj = ymapToObject(ymap) as unknown as Connection
    if (!useCanvasStore.getState().connections.get(id)) {
      store.addConnection({ ...obj, id })
    } else {
      // Handle field deletions: keys present in existing but absent from
      // remote Y.Map are not included by ymapToObject.
      const existing = useCanvasStore.getState().connections.get(id)!
      const newKeys = new Set(Object.keys(obj))
      for (const key of Object.keys(existing)) {
        if (!newKeys.has(key) && key !== 'id') {
          (obj as unknown as Record<string, unknown>)[key] = undefined
        }
      }
      store.updateConnectionWithoutHistory(id, obj, true)
    }
  }

  /**
   * Deep observer over each top-level collection. Y.Map.observeDeep surfaces
   * both key-level changes (entity add/delete) and nested Y.Map changes
   * (field updates on an existing entity).
   *
   * Strategy: collect the set of affected entity ids from each event (either
   * via top-level keys or via the event's path[0] for nested changes), then
   * re-apply the whole entity snapshot to the store. This is simpler than
   * dispatching on action types and is correct because the store's
   * updateXxxWithoutHistory overwrites all fields.
   */
  const observeCollection = (
    ymap: Y.Map<Y.Map<unknown>>,
    applyAddOrUpdate: (id: string, entity: Y.Map<unknown>) => void,
    applyRemove: (id: string) => void,
  ): (() => void) => {
    const handler = (events: Y.YEvent<Y.Map<unknown>>[]) => {
      const firstOrigin = events[0]?.transaction.origin
      // Skip local mutations (command.execute already updated the store).
      // NOTE: we intentionally do NOT skip when firstOrigin === the provider
      // instance. The provider applies every incoming remote frame (both the
      // initial STEP2 sync and subsequent peer broadcasts) to the Y.Doc using
      // origin===provider. If we skipped those, the Zustand store would never
      // receive remote changes — collaboration would be broken (Round 2 review
      // finding R2-2). The LOCAL_ORIGIN check above is sufficient to prevent
      // echo-back from local mutations; the isApplyingRemoteChanges flag below
      // prevents the store from re-entering the Y.Doc during observer replay.
      // The doc.on('update') listener in wireLocalDocUpdates still correctly
      // skips origin===provider to avoid re-broadcasting received frames.
      if (firstOrigin === LOCAL_ORIGIN) return

      isApplyingRemoteChanges = true
      try {
        for (const event of events) {
          if (event.target === ymap) {
            // Top-level key change: entity added / deleted / replaced.
            for (const [key, change] of event.keys.entries()) {
              if (change.action === 'delete') {
                applyRemove(key)
              } else {
                const child = ymap.get(key)
                if (child) applyAddOrUpdate(key, child as Y.Map<unknown>)
              }
            }
          } else if (event.path.length >= 1 && typeof event.path[0] === 'string') {
            // Nested change (field update, Y.Array push/delete, nested Y.Map set)
            // on an existing entity. path[0] is always the top-level entity id
            // regardless of how deep the actual change is, so we re-apply the
            // whole entity snapshot. This captures group.nodeIds / connection
            // .bendPoints in-place mutations that peers may perform.
            const id = event.path[0] as string
            const child = ymap.get(id)
            if (child) applyAddOrUpdate(id, child as Y.Map<unknown>)
          }
        }
      } finally {
        isApplyingRemoteChanges = false
      }
    }
    ymap.observeDeep(handler)
    return () => ymap.unobserveDeep(handler)
  }

  const unobserveNodes = observeCollection(yNodes, applyRemoteNode, (id) => store.removeNode(id))
  const unobserveGroups = observeCollection(yGroups, applyRemoteGroup, (id) => store.removeGroup(id))
  const unobserveDomains = observeCollection(yDomains, applyRemoteDomain, (id) => store.removeDomain(id))
  const unobserveConnections = observeCollection(yConnections, applyRemoteConnection, (id) => store.removeConnection(id))

  /**
   * Diff a before/after snapshot of the four entity maps and write the delta
   * into the doc inside a LOCAL_ORIGIN transaction. Called by the store after
   * every local mutation so peers receive the change.
   */
  const applyDiff = (
    before: { nodes: Map<string, Node>; groups: Map<string, NodeGroup>; domains: Map<string, Domain>; connections: Map<string, Connection> },
    after: { nodes: Map<string, Node>; groups: Map<string, NodeGroup>; domains: Map<string, Domain>; connections: Map<string, Connection> },
  ) => {
    // All entity types in a single transaction so a partial failure does not
    // leave the Y.Doc permanently out of sync with the Zustand store. If one
    // diffAndApply call throws, Yjs rolls back the entire transaction and the
    // doc stays consistent; on the next mutation the diff is retried.
    doc.transact(() => {
      diffAndApply(before.nodes, after.nodes, yNodes)
      diffAndApply(before.groups, after.groups, yGroups)
      diffAndApply(before.domains, after.domains, yDomains)
      diffAndApply(before.connections, after.connections, yConnections)
    }, LOCAL_ORIGIN)
  }

  return {
    applyDiff,
    get isApplyingRemoteChanges() {
      return isApplyingRemoteChanges
    },
    writeToYDoc: (fn: () => void) => {
      doc.transact(fn, LOCAL_ORIGIN)
    },
    getYNodes: () => yNodes,
    getYGroups: () => yGroups,
    getYDomains: () => yDomains,
    getYConnections: () => yConnections,
    destroy: () => {
      // Explicitly unobserve all collections so the binding can be torn down
      // even if the Y.Doc is not immediately destroyed.
      unobserveNodes()
      unobserveGroups()
      unobserveDomains()
      unobserveConnections()
    },
    suppressSync: (fn: () => void) => {
      const prev = isApplyingRemoteChanges
      isApplyingRemoteChanges = true
      try { fn() } finally { isApplyingRemoteChanges = prev }
    },
  }
}

/**
 * Diff two plain-JS maps of entities and apply the delta to a Y.Map.
 *   - new in `after` → entityToYMap + Y.Map.set (add)
 *   - changed       → field-level set on existing Y.Map (preserves CRDT merge)
 *   - removed       → Y.Map.delete
 */
function diffAndApply<T extends { id: string }>(
  before: Map<string, T>,
  after: Map<string, T>,
  ymap: Y.Map<Y.Map<unknown>>,
): void {
  // Adds and updates
  for (const [id, afterEntity] of after) {
    const beforeEntity = before.get(id)
    if (!beforeEntity) {
      // New entity
      ymap.set(id, entityToYMap(afterEntity as unknown as Record<string, unknown>))
    } else if (!shallowEqual(beforeEntity, afterEntity)) {
      // Changed entity: field-level set on existing Y.Map for CRDT merge.
      let existing = ymap.get(id)
      if (!existing) {
        existing = entityToYMap(afterEntity as unknown as Record<string, unknown>)
        ymap.set(id, existing)
      } else {
        writeFields(existing, afterEntity as unknown as Record<string, unknown>)
      }
    }
  }
  // Removes
  for (const id of before.keys()) {
    if (!after.has(id)) {
      ymap.delete(id)
    }
  }
}

/** Write each field of a plain object into a Y.Map (arrays → Y.Array).
 *  undefined values DELETE the field so callers can clear a field by setting
 *  it to undefined (otherwise the old CRDT value would linger).
 *  For array fields, if a Y.Array already exists for the key, its contents are
 *  updated incrementally (diff-and-replace elements) instead of replacing the
 *  whole Y.Array, preserving CRDT merge semantics for concurrent peer edits. */
function writeFields(ymap: Y.Map<unknown>, obj: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) {
      // Clear the field in the doc so peers see the removal.
      if (ymap.has(k)) ymap.delete(k)
      continue
    }
    if (Array.isArray(v)) {
      const existing = ymap.get(k)
      if (existing instanceof Y.Array) {
        const current = (existing as Y.Array<unknown>).toArray()
        const target = v as unknown[]
        if (arrayContentEqual(current, target)) continue
        diffAndUpdateYArray(existing as Y.Array<unknown>, current, target)
      } else {
        const arr = new Y.Array<unknown>()
        arr.insert(0, v as unknown[])
        ymap.set(k, arr)
      }
    } else if (v !== null && typeof v === 'object') {
      // For nested objects, update field-by-field if a Y.Map already exists
      // to preserve CRDT merge semantics for concurrent peer edits.
      const existing = ymap.get(k)
      if (existing instanceof Y.Map) {
        // Update/set fields present in the incoming object
        const incomingKeys = new Set(Object.keys(v as Record<string, unknown>))
        for (const [nk, nv] of Object.entries(v as Record<string, unknown>)) {
          if (nv === undefined) {
            (existing as Y.Map<unknown>).delete(nk)
          } else {
            (existing as Y.Map<unknown>).set(nk, nv as unknown)
          }
        }
        // Delete fields that exist in the current Y.Map but are absent from
        // the incoming object (nested field deletion). Without this, a remote
        // deletion of e.g. connection.style.width would leave the stale value
        // in the CRDT state because writeFields only writes keys present in obj.
        for (const nk of (existing as Y.Map<unknown>).keys()) {
          if (!incomingKeys.has(nk)) {
            (existing as Y.Map<unknown>).delete(nk)
          }
        }
      } else {
        const nested = new Y.Map<unknown>()
        for (const [nk, nv] of Object.entries(v as Record<string, unknown>)) {
          nested.set(nk, nv as unknown)
        }
        ymap.set(k, nested)
      }
    } else {
      if (ymap.get(k) === v) continue
      ymap.set(k, v as unknown)
    }
  }
}

function arrayContentEqual(current: unknown[], target: unknown[]): boolean {
  if (current.length !== target.length) return false
  for (let i = 0; i < current.length; i++) {
    if (!valuesEqual(current[i], target[i])) return false
  }
  return true
}

function hasObjectsWithId(items: unknown[]): boolean {
  return items.some(
    (item) => item !== null && typeof item === 'object' && 'id' in (item as Record<string, unknown>),
  )
}

function diffAndUpdateYArray(arr: Y.Array<unknown>, current: unknown[], target: unknown[]): void {
  if (hasObjectsWithId(current) || hasObjectsWithId(target)) {
    diffObjectArrayById(arr, current, target)
  } else if (
    current.every((item) => item === null || typeof item !== 'object') &&
    target.every((item) => item === null || typeof item !== 'object')
  ) {
    diffPrimitiveArray(arr, current, target)
  } else {
    if (current.length > 0) arr.delete(0, current.length)
    if (target.length > 0) arr.insert(0, target)
  }
}

function diffPrimitiveArray(arr: Y.Array<unknown>, current: unknown[], target: unknown[]): void {
  const targetSet = new Set<unknown>(target)
  for (let i = current.length - 1; i >= 0; i--) {
    if (!targetSet.has(current[i])) {
      arr.delete(i, 1)
    }
  }
  const currentArray = arr.toArray()
  const currentSet = new Set<unknown>(currentArray)
  const toAdd: unknown[] = []
  for (const item of target) {
    if (!currentSet.has(item)) {
      toAdd.push(item)
      currentSet.add(item)
    }
  }
  if (toAdd.length > 0) {
    arr.insert(arr.length, toAdd)
  }
}

function diffObjectArrayById(arr: Y.Array<unknown>, current: unknown[], target: unknown[]): void {
  const targetIds = new Set<string>()
  const targetMap = new Map<string, unknown>()
  for (const item of target) {
    if (item !== null && typeof item === 'object' && 'id' in item) {
      const id = (item as { id: string }).id
      targetIds.add(id)
      targetMap.set(id, item)
    }
  }

  for (let i = current.length - 1; i >= 0; i--) {
    const item = current[i] as { id?: string } | null
    if (item && typeof item === 'object' && item.id && !targetIds.has(item.id)) {
      arr.delete(i, 1)
    }
  }

  const currentArray = arr.toArray()
  for (let i = 0; i < currentArray.length; i++) {
    const existingItem = currentArray[i] as { id?: string } | null
    if (!existingItem || typeof existingItem !== 'object' || !existingItem.id) continue
    const targetItem = targetMap.get(existingItem.id)
    if (targetItem && !valuesEqual(existingItem, targetItem)) {
      arr.delete(i, 1)
      arr.insert(i, [targetItem])
    }
  }

  const updatedArray = arr.toArray()
  const existingIds = new Set<string>()
  for (const item of updatedArray) {
    if (item !== null && typeof item === 'object' && 'id' in item) {
      existingIds.add((item as { id: string }).id)
    }
  }
  const toAdd: unknown[] = []
  for (const item of target) {
    const obj = item as { id?: string } | null
    if (obj && typeof obj === 'object' && obj.id) {
      if (!existingIds.has(obj.id)) {
        toAdd.push(item)
      }
    } else {
      toAdd.push(item)
    }
  }
  if (toAdd.length > 0) {
    arr.insert(arr.length, toAdd)
  }
}

/**
 * Shallow equality with awareness of object arrays (e.g. bendPoints).
 * Plain scalars compared by ===; arrays compared element-by-element where
 * elements that are objects are compared by their own shallow key set
 * (so [{id,x,y}] !== [{id,x,y}] no longer triggers a spurious diff).
 */
function shallowEqual<T>(a: T, b: T): boolean {
  if (a === b) return true
  const ak = Object.keys(a as object)
  const bk = Object.keys(b as object)
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    const av = (a as Record<string, unknown>)[k]
    const bv = (b as Record<string, unknown>)[k]
    if (!valuesEqual(av, bv)) return false
  }
  return true
}

function valuesEqual(av: unknown, bv: unknown): boolean {
  if (av === bv) return true
  if (Array.isArray(av) && Array.isArray(bv)) {
    if (av.length !== bv.length) return false
    for (let i = 0; i < av.length; i++) {
      if (!valuesEqual(av[i], bv[i])) return false
    }
    return true
  }
  if (av !== null && bv !== null && typeof av === 'object' && typeof bv === 'object') {
    const ak = Object.keys(av as object)
    const bk = Object.keys(bv as object)
    if (ak.length !== bk.length) return false
    for (const k of ak) {
      if ((av as Record<string, unknown>)[k] !== (bv as Record<string, unknown>)[k]) return false
    }
    return true
  }
  return false
}
