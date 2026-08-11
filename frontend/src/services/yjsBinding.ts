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
import { ensureRoot, getExistingRoot, entityToYMap, ymapToObject } from './yjs-schema'
import { type MindMapYjsProvider, type DeletionCollection, recordLocalDeletion, isLocalDeletion } from './yjsProvider'
import { useCanvasStore } from '@/store/useCanvasStore'
import { logger } from '@/utils/logger'

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
  setCanvasData: (
    data: {
      nodes?: Node[]
      groups?: NodeGroup[]
      domains?: Domain[]
      connections?: Connection[]
    },
    viewState?: { zoom: number; panX: number; panY: number },
  ) => void
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
  /** Accessor for the nodes Y.Map. Returns undefined before STEP2 sync. */
  getYNodes: () => Y.Map<Y.Map<unknown>> | undefined
  getYGroups: () => Y.Map<Y.Map<unknown>> | undefined
  getYDomains: () => Y.Map<Y.Map<unknown>> | undefined
  getYConnections: () => Y.Map<Y.Map<unknown>> | undefined
  /** Replace the entire Y.Doc content with imported entities in a single
   *  LOCAL_ORIGIN transaction. Local observers skip it; remote peers receive
   *  the full replacement update. Returns true if the doc root existed. */
  importIntoDoc: (data: {
    nodes: Node[]
    groups: NodeGroup[]
    domains: Domain[]
    connections: Connection[]
  }) => boolean
  /** Copy all entities from the Zustand store into the Y.Doc (initial sync). */
  syncLocalStateToYDoc: () => void
  /** M4: 握手窗口内本地编辑过的实体整字段写回 doc（即使 doc 中已存在）。 */
  syncLocalEditsToYDoc: (ids: Set<string>) => void
  /** Copy entities present in the Y.Doc but missing from the store back into
   *  the store (doc → store). Called after STEP2 sync so entities the server
   *  already had (but the local API load did not include) appear in the UI.
   *  @param options.skipRemoval If true, entities present locally but missing
   *    from the doc are NOT removed. Use on the very first sync so API-loaded
   *    data for a brand-new canvas is not wiped.
   *  @param options.skipExistingUpdates If true or a Set of entity IDs,
   *    existing local entities are NOT refreshed from the doc. Use for IDs
   *    edited locally while the handshake was in flight so they are not
   *    overwritten by the server snapshot.
   *  @returns true if the doc was empty but the local store had entities and
   *    the function already mirrored local state back into the doc; callers
   *    should skip a follow-up syncLocalStateToYDoc() call. */
  syncYDocToLocalState: (options?: { skipRemoval?: boolean; skipExistingUpdates?: boolean | Set<string> }) => boolean
  /** Detach all observers. */
  destroy: () => void
  /** Re-register observers on current Y.Map instances (after STEP2 sync). */
  reconnectObservers: () => void
  /** Temporarily suppress Yjs sync (for initial data loading). */
  suppressSync: (fn: () => void) => void
  /** Mark a node as being interacted with (defers remote position updates). */
  startInteraction: (nodeId: string, field?: string) => void
  /** End an interaction and flush deferred position updates. */
  endInteraction: (nodeId: string) => void
}

/**
 * Wire a provider's Y.Doc to a Zustand store. Returns a binding handle whose
 * `writeToYDoc` should be called by the store's command.execute/undo to make
 * local changes propagate to the doc.
 */
export interface YjsBindingOptions {
  /**
   * R4 #8（C7）：交互超时兜底时长（毫秒）。默认 10000（10s）。
   * R5 #4：由 useCollaboration 创建绑定时显式透传（COLLAB_INTERACTION_MAX_MS
   * 常量），不再是无人消费的死配置。拖拽期间 FabricCanvas 的
   * startObjectInteraction 每帧续期（clearTimeout + 重新计时），本超时仅在
   * endInteraction 因组件卸载/异常路径未触发时兜底结束交互。
   */
  interactionMaxMs?: number
}

export function bindYjsToStore(
  provider: MindMapYjsProvider,
  store: CanvasStoreBinding,
  options: YjsBindingOptions = {},
): YjsCanvasBinding {
  const doc = provider.doc

  // Dynamic getters: resolve the current Y.Map references from the doc WITHOUT
  // creating missing maps. Creating maps before STEP2 would give them this
  // client's CRDT origin and break the initial sync (the server would see that
  // origin in the state vector and skip sending its own root maps). After
  // STEP2 the server's root maps exist, so these resolve to the authoritative
  // shared types.
  const getYNodes = () => getExistingRoot(doc)?.nodes
  const getYGroups = () => getExistingRoot(doc)?.groups
  const getYDomains = () => getExistingRoot(doc)?.domains
  const getYConnections = () => getExistingRoot(doc)?.connections

  // Guard against feedback loops: when the observer applies remote changes to
  // the store, set this flag so the store's syncDiffToYDoc skips the echo-back.
  let isApplyingRemoteChanges = false

  // Track which nodes/fields the local user is currently interacting with
  // (e.g. dragging a node). When applyRemoteNode sees an interacting node,
  // position/scalar updates are deferred until the interaction ends. Without
  // this, simultaneous drags on the same node create a tug-of-war because
  // Yjs position fields are Last-Writer-Wins.
  const interactingNodes = new Map<string, string | undefined>()
  const deferredNodeUpdates = new Map<string, Partial<Node>>()
  // C7: 交互超时兜底——若 endInteraction 因组件卸载/异常路径从未触发，
  // 该节点会永久处于"交互中"，远端位置更新被无限期延迟。超时后自动结束交互。
  // R4 #8：时长通过 bindYjsToStore options 配置（默认 10s）。
  // R5 #4：useCollaboration 已透传 interactionMaxMs，此处读取的是真实配置。
  const INTERACTION_MAX_MS = options.interactionMaxMs ?? 10000
  const interactionTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function startInteraction(nodeId: string, field?: string): void {
    interactingNodes.set(nodeId, field)
    const existing = interactionTimers.get(nodeId)
    if (existing) clearTimeout(existing)
    interactionTimers.set(
      nodeId,
      setTimeout(() => {
        interactionTimers.delete(nodeId)
        // 超时自动结束交互（与手动结束走同一 flush 路径）
        endInteraction(nodeId)
      }, INTERACTION_MAX_MS),
    )
  }

  function endInteraction(nodeId: string): void {
    const timer = interactionTimers.get(nodeId)
    if (timer) {
      clearTimeout(timer)
      interactionTimers.delete(nodeId)
    }
    interactingNodes.delete(nodeId)
    // Flush deferred position updates so the remote peer's position is
    // visible as soon as the local interaction ends.
    const deferred = deferredNodeUpdates.get(nodeId)
    if (deferred) {
      deferredNodeUpdates.delete(nodeId)
      // C4: 本地最后写入优先。deferred 是交互期间捕获的远端位置；flush 前
      // 比对 doc 当前值——若本地用户松手前又拖动了节点，doc 中已是本地
      // 更新的位置（LOCAL_ORIGIN 写入），此时逐字段跳过被本地改过的字段，
      // 避免用较旧的远端位置覆盖本地拖拽结果；本地未动的字段仍应用远端值。
      const currentYMap = getYNodes()?.get(nodeId)
      if (currentYMap) {
        const current = ymapToObject(currentYMap) as Partial<Node>
        const toApply: Partial<Node> = {}
        for (const key of ['x', 'y', 'width', 'height'] as const) {
          if (current[key] === deferred[key]) {
            toApply[key] = deferred[key]
          }
        }
        if (Object.keys(toApply).length > 0) {
          // M8: 远端派生更新不置 dirty——本地拖拽已置 dirty，远端值只需落到 store。
          store.updateNodeWithoutHistory(nodeId, toApply, false)
        }
      } else {
        // doc 尚无该节点（罕见），直接应用远端值
        store.updateNodeWithoutHistory(nodeId, deferred, false)
      }
    }
  }

  /** Temporarily set isApplyingRemoteChanges so the store's syncDiffToYDoc
   *  skips echoing these mutations back into the doc (which is already the
   *  source of truth for the data being applied). Extracted as a named
   *  function so both syncYDocToLocalState and the returned handle can use it. */
  function suppressSync(fn: () => void): void {
    const prev = isApplyingRemoteChanges
    isApplyingRemoteChanges = true
    try { fn() } finally { isApplyingRemoteChanges = prev }
  }

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
   *  Field deletions are handled explicitly: keys present in the local node
   *  but absent from the remote Y.Map are set to undefined before the update,
   *  so the store's merge ({ ...current, ...obj }) removes them. */
  // M8: 远端变更一律不置 store.isDirty。
  // 协作模式下 isDirty 的主要消费者是自动保存 tick——已连接时它只做
  // 缩略图生成（POST 被协作分支跳过）。若远端变更也置 dirty，两个协作者
  // 会互相触发缩略图 PUT，产生 409 风暴（useCollaboration 注释明确不想要
  // 这种行为）。本地编辑仍由各自的 mutator 置 dirty，缩略图照常生成；
  // 远端更新只需落到 store（UI 展示），不产生副作用。addNode/removeNode
  // 的新实体路径同样经由 executeCommand 的 skipHistory 分支——其 markDirty
  // 默认值保持 true 会让新实体同步也置 dirty，但这类事件每次同步只发生
  // 一次（实体创建/删除），不构成风暴；字段级更新（高频）全部走
  // updateXxxWithoutHistory(…, false)。
  const applyRemoteNode = (id: string, ymap: Y.Map<unknown>) => {
    const obj = ymapToObject(ymap) as unknown as Node
    const existing = useCanvasStore.getState().nodes.get(id)
    if (!existing) {
      store.addNode({ ...obj, id })
    } else {
      // If the local user is currently interacting with this node (e.g.
      // dragging it), defer position/scalar updates to prevent a tug-of-war.
      // Yjs position fields are LWW, so simultaneous drags would overwrite
      // each other without this guard. Non-position updates (title, content,
      // style, etc.) are applied immediately regardless.
      const interacting = interactingNodes.get(id)
      if (interacting !== undefined) {
        // Only defer x/y/width/height changes; let text/style through.
        const hasPositionChange = (existing.x !== obj.x || existing.y !== obj.y ||
          existing.width !== obj.width || existing.height !== obj.height)
        if (hasPositionChange) {
          // Store the latest remote position so endInteraction can flush it.
          deferredNodeUpdates.set(id, {
            x: obj.x,
            y: obj.y,
            width: obj.width,
            height: obj.height,
          })
          // Still apply non-position field updates immediately.
          const nonPositionUpdates: Partial<Node> = {}
          for (const key of Object.keys(obj) as (keyof Node)[]) {
            if (key !== 'x' && key !== 'y' && key !== 'width' && key !== 'height') {
              (nonPositionUpdates as Record<string, unknown>)[key] = obj[key]
            }
          }
          // Handle field deletions: keys present in existing but absent from
          // remote Y.Map are not included by ymapToObject, so explicitly set
          // them to undefined so the store merge removes them. Position keys
          // are intentionally skipped here because they are deferred above.
          const newKeys = new Set(Object.keys(obj))
          for (const key of Object.keys(existing)) {
            if (!newKeys.has(key) && key !== 'id' &&
              key !== 'x' && key !== 'y' && key !== 'width' && key !== 'height') {
              (nonPositionUpdates as Record<string, unknown>)[key] = undefined
            }
          }
          if (Object.keys(nonPositionUpdates).length > 0) {
            // M8: 远端变更不置 dirty（见 applyRemote* 顶部注释）。
            store.updateNodeWithoutHistory(id, nonPositionUpdates, false)
          }
          return  // skip the full apply below; position deferred
        }
        // No position change — apply everything normally.
      }
      // Position field overwrites are expected here: Yjs scalar fields are
      // Last-Writer-Wins, so simultaneous drags by two users can silently
      // overwrite one user's position. We intentionally do not warn in
      // production because high-frequency collaboration generates a flood of
      // these messages and they are not actionable.
      // Handle field deletions: keys present in existing but absent from
      // remote Y.Map are not included by ymapToObject, so explicitly set
      // them to undefined so the store merge removes them.
      const newKeys = new Set(Object.keys(obj))
      for (const key of Object.keys(existing)) {
        if (!newKeys.has(key) && key !== 'id') {
          (obj as unknown as Record<string, unknown>)[key] = undefined
        }
      }
      store.updateNodeWithoutHistory(id, obj, false)
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
      store.updateGroupWithoutHistory(id, obj, false)
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
      store.updateDomainWithoutHistory(id, obj, false)
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
      store.updateConnectionWithoutHistory(id, obj, false)
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
    ymap: Y.Map<Y.Map<unknown>> | undefined,
    kind: DeletionCollection,
    applyAddOrUpdate: (id: string, entity: Y.Map<unknown>) => void,
    applyRemove: (id: string) => void,
  ): (() => void) => {
    if (!ymap) {
      // Collection does not exist yet (before STEP2 sync). Return a no-op
      // unsubscriber; reconnectObservers() will attach the real observer once
      // the server's root maps are applied to the doc.
      return () => { }
    }
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
        // R7-fix: 判断 store 中是否已有该实体。仅当"store 无此实体且已声明
        // 本地删除"时才跳过增量应用(防离线删除实体在重连 STEP2 合并时复活)。
        // 删除→撤销恢复的实体 store 中已存在,必须正常接收远端更新——
        // 否则该实体被永久冻结(远端对其的字段更新被静默丢弃)。
        const storeHasEntity = (id: string): boolean => {
          const s = useCanvasStore.getState()
          if (kind === 'nodes') return s.nodes.has(id)
          if (kind === 'groups') return s.groups.has(id)
          if (kind === 'domains') return s.domains.has(id)
          return s.connections.has(id)
        }
        for (const event of events) {
          if (event.target === ymap) {
            // Top-level key change: entity added / deleted / replaced.
            for (const [key, change] of event.keys.entries()) {
              if (change.action === 'delete') {
                applyRemove(key)
              } else {
                // C18 + R7-fix: 离线删除后重连,STEP2 合并使 doc 中重新出现该
                // 实体,且 store 中不存在(未撤销)→ 跳过,防瞬时"复活"。
                // store 中已有该实体(如撤销恢复)→ 正常应用远端更新。
                if (isLocalDeletion(provider.canvasId, kind, key) && !storeHasEntity(key)) continue
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
            // C18 + R7-fix: 嵌套变更同样仅在"store 无此实体且已声明删除"时跳过
            if (isLocalDeletion(provider.canvasId, kind, id) && !storeHasEntity(id)) continue
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

  // Register observers using dynamic getters. Before STEP2 the top-level maps
  // do not exist yet, so attach a no-op unsubscriber and wait for
  // reconnectObservers() after sync completes.
  let unobserveNodes = observeCollection(getYNodes(), 'nodes', applyRemoteNode, (id) => store.removeNode(id))
  let unobserveGroups = observeCollection(getYGroups(), 'groups', applyRemoteGroup, (id) => store.removeGroup(id))
  let unobserveDomains = observeCollection(getYDomains(), 'domains', applyRemoteDomain, (id) => store.removeDomain(id))
  let unobserveConnections = observeCollection(getYConnections(), 'connections', applyRemoteConnection, (id) => store.removeConnection(id))

  /** Re-register observers on the current Y.Map instances. Called after
   *  STEP2 sync to pick up the possibly-replaced Y.Map references. */
  function reconnectObservers() {
    unobserveNodes()
    unobserveGroups()
    unobserveDomains()
    unobserveConnections()
    unobserveNodes = observeCollection(getYNodes(), 'nodes', applyRemoteNode, (id) => store.removeNode(id))
    unobserveGroups = observeCollection(getYGroups(), 'groups', applyRemoteGroup, (id) => store.removeGroup(id))
    unobserveDomains = observeCollection(getYDomains(), 'domains', applyRemoteDomain, (id) => store.removeDomain(id))
    unobserveConnections = observeCollection(getYConnections(), 'connections', applyRemoteConnection, (id) => store.removeConnection(id))
  }

  /**
   * Diff a before/after snapshot of the four entity maps and write the delta
   * into the doc inside a LOCAL_ORIGIN transaction. Called by the store after
   * every local mutation so peers receive the change.
   */
  const applyDiff = (
    before: { nodes: Map<string, Node>; groups: Map<string, NodeGroup>; domains: Map<string, Domain>; connections: Map<string, Connection> },
    after: { nodes: Map<string, Node>; groups: Map<string, NodeGroup>; domains: Map<string, Domain>; connections: Map<string, Connection> },
  ) => {
    // Keep the doc empty before the initial STEP2 sync so the server's root
    // maps are authoritative. If root maps already exist (we are already
    // synced or reconnecting to a doc that has them), write the diff normally;
    // otherwise skip until syncLocalStateToYDoc can backfill local entities
    // after the handshake.
    const existingRoot = getExistingRoot(doc)
    if (!existingRoot && !provider.getIsSynced()) return
    // R1: 记录本地删除声明（供 REST 快照附带，服务端据此区分"客户端主动删除"
    // 与"未知实体"，避免离线删除被 upsertOnly 吞掉而"复活"）。
    // 本函数仅由 store 的 syncDiffToYDoc 调用（已排除远端应用与 bulk 加载），
    // 因此这里记录的删除全部来自本地用户。
    for (const id of before.nodes.keys()) {
      if (!after.nodes.has(id)) recordLocalDeletion(provider.canvasId, 'nodes', id)
    }
    for (const id of before.groups.keys()) {
      if (!after.groups.has(id)) recordLocalDeletion(provider.canvasId, 'groups', id)
    }
    for (const id of before.domains.keys()) {
      if (!after.domains.has(id)) recordLocalDeletion(provider.canvasId, 'domains', id)
    }
    for (const id of before.connections.keys()) {
      if (!after.connections.has(id)) recordLocalDeletion(provider.canvasId, 'connections', id)
    }
    const collections = existingRoot ?? ensureRoot(doc)
    doc.transact(() => {
      diffAndApply(before.nodes, after.nodes, collections.nodes)
      diffAndApply(before.groups, after.groups, collections.groups)
      diffAndApply(before.domains, after.domains, collections.domains)
      diffAndApply(before.connections, after.connections, collections.connections)
    }, LOCAL_ORIGIN)
  }

  /** Copy all entities from the current Zustand store into the Y.Doc.
   *  Called after initial connection sync to ensure the Y.Doc contains
   *  all entities loaded from the API, not only those changed by local
   *  mutations (which is what applyDiff/diffAndApply handles). */
  function syncLocalStateToYDoc() {
    // Viewers have no business writing local state into the shared doc.
    // Defense-in-depth: even though wireLocalDocUpdates blocks outgoing
    // viewer mutations, mutating the local doc violates the read-only contract.
    if (provider.getRole() === 'viewer') return
    // Guard against writing before STEP2: creating root maps now would give
    // them this client's CRDT origin and break the authoritative server snapshot.
    const existingRoot = getExistingRoot(doc)
    if (!existingRoot && !provider.getIsSynced()) return
    const s = useCanvasStore.getState()
    // After STEP2 the server's root maps exist and ensureRoot simply returns them;
    // on a fresh empty canvas (no existing root and already synced) it creates the
    // structure so local API-loaded data can be mirrored into the doc.
    const collections = existingRoot ?? ensureRoot(doc)
    doc.transact(() => {
      for (const [id, entity] of s.nodes) {
        if (!collections.nodes.has(id)) collections.nodes.set(id, entityToYMap(entity as unknown as Record<string, unknown>))
      }
      for (const [id, entity] of s.groups) {
        if (!collections.groups.has(id)) collections.groups.set(id, entityToYMap(entity as unknown as Record<string, unknown>))
      }
      for (const [id, entity] of s.domains) {
        if (!collections.domains.has(id)) collections.domains.set(id, entityToYMap(entity as unknown as Record<string, unknown>))
      }
      for (const [id, entity] of s.connections) {
        if (!collections.connections.has(id)) collections.connections.set(id, entityToYMap(entity as unknown as Record<string, unknown>))
      }
    }, LOCAL_ORIGIN)
  }

  /**
   * M4 + R2-3 + R2-4: 将握手窗口内被本地编辑/删除过的实体同步回 Y.Doc。
   *
   * 背景：STEP2 完成前 applyDiff 会丢弃 store→doc 的 diff（486 行守卫），
   * 而 syncLocalStateToYDoc 只补 doc 缺失的实体——握手期间对"已存在实体"
   * 的编辑因此永远无法上行，形成静默数据丢失。
   *
   * R2-3: 写回采用字段级合并（mergeEntityFields）：以 doc 现有 ymap 为基底，
   * 仅覆盖本地 store 中存在的字段，本地缺失的字段保留 doc 现值——避免整字段
   * 覆盖回退"连接前远端对该实体其他字段的更新"（本地快照较旧时 LWW 本地胜出）。
   *
   * R2-4: store 中不存在的 id（握手窗口内被本地删除的实体——useCollaboration
   * 的 editedDuringHandshake 采集时补录了 prevState 中消失的 id）执行与
   * applyDiff 删除分支等价的处理：从 doc 删除该实体 ymap 并 recordLocalDeletion
   * 声明。applyDiff 的删除声明守卫（STEP2 前 return）在握手窗口内不执行，
   * 因此这里必须补上，否则实体残留 doc，重连/重载后复活。
   */
  function syncLocalEditsToYDoc(ids: Set<string>) {
    if (ids.size === 0) return
    // 与 syncLocalStateToYDoc 相同的双守卫：viewer 只读；STEP2 前不建根。
    if (provider.getRole() === 'viewer') return
    const existingRoot = getExistingRoot(doc)
    if (!existingRoot && !provider.getIsSynced()) return
    const s = useCanvasStore.getState()
    const collections = existingRoot ?? ensureRoot(doc)
    doc.transact(() => {
      for (const id of ids) {
        const node = s.nodes.get(id)
        if (node) {
          // R2-3: 字段级合并写回（保留 doc 中本地缺失的字段）
          mergeEntityFields(collections.nodes, id, node as unknown as Record<string, unknown>)
          continue
        }
        const group = s.groups.get(id)
        if (group) {
          mergeEntityFields(collections.groups, id, group as unknown as Record<string, unknown>)
          continue
        }
        const domain = s.domains.get(id)
        if (domain) {
          mergeEntityFields(collections.domains, id, domain as unknown as Record<string, unknown>)
          continue
        }
        const conn = s.connections.get(id)
        if (conn) {
          mergeEntityFields(collections.connections, id, conn as unknown as Record<string, unknown>)
          continue
        }
        // R2-4: store 中不存在该 id = 握手窗口内被本地删除 → 从 doc 删除 + 声明
        // （记录删除声明与 applyDiff 删除分支一致，供 REST 快照 deletedIds 使用）
        const deletedKinds: Array<[DeletionCollection, Y.Map<Y.Map<unknown>>]> = [
          ['nodes', collections.nodes],
          ['groups', collections.groups],
          ['domains', collections.domains],
          ['connections', collections.connections],
        ]
        for (const [kind, ymap] of deletedKinds) {
          if (ymap.has(id)) {
            ymap.delete(id)
            recordLocalDeletion(provider.canvasId, kind, id)
            break
          }
        }
      }
    }, LOCAL_ORIGIN)
  }

  /** Copy entities from the Y.Doc into the store when they are missing locally.
   *  STEP2 (server → client state vector reply) applies the server's full doc
   *  state to the local doc, but it runs INSIDE readSyncMessage, which fires
   *  BEFORE the onSynced callback re-registers observers — so the observer
   *  never sees those initial entities. This function performs the doc → store
   *  direction that the observer would have done, ensuring entities the server
   *  already had (and the local API load did not include) appear in the UI.
   *
   *  Uses getExistingRoot (read-only): if STEP2 has not arrived the doc has no
   *  root structure and there is nothing to mirror. Wrapped in a single
   *  suppressSync block so the store mutations it performs are NOT echoed back
   *  to the doc (the doc is already the source of truth for these entities). */
  function syncYDocToLocalState(options?: {
    /** If true, never remove local entities that are missing from the doc.
     *  Use on the very first sync so API-loaded data for a brand-new canvas
     *  is not wiped before syncLocalStateToYDoc can mirror it into the doc. */
    skipRemoval?: boolean
    /** Entities whose existing local state should not be overwritten by the
     *  server snapshot. Can be a boolean (legacy coarse-grained) or a Set of
     *  entity IDs edited locally while the handshake was in flight. */
    skipExistingUpdates?: boolean | Set<string>
  }) {
    const skipRemoval = options?.skipRemoval ?? false
    const skipExistingUpdates = options?.skipExistingUpdates ?? false
    const shouldSkipExistingUpdate = (id: string) => {
      if (typeof skipExistingUpdates === 'boolean') return skipExistingUpdates
      return skipExistingUpdates.has(id)
    }

    const collections = getExistingRoot(doc)
    if (!collections) return

    // Safety guard: if the authoritative doc is completely empty but the local
    // store still has entities, do NOT wipe the local store. This happens when
    // the server loses its in-memory doc (e.g. last client left, process
    // restarted, or persisted yjsUpdate was empty/corrupted) and reconnects the
    // client to an empty doc before the local offline edits have been replayed.
    // In that case the local store is the only surviving copy of the data; we
    // mirror it back into the doc instead of deleting it.
    const docEntityCount =
      (collections.nodes?.size ?? 0) +
      (collections.groups?.size ?? 0) +
      (collections.domains?.size ?? 0) +
      (collections.connections?.size ?? 0)
    const liveState = useCanvasStore.getState()
    const localEntityCount =
      liveState.nodes.size +
      liveState.groups.size +
      liveState.domains.size +
      liveState.connections.size
    if (docEntityCount === 0 && localEntityCount > 0) {
      // Distinguish between:
      // 1. Brand-new empty doc (server lost in-memory state / yjsUpdate missing):
      //    the local store is the only surviving copy, so preserve it.
      // 2. Doc with history but currently empty (peers intentionally deleted all
      //    entities while we were offline): trust the server snapshot and let
      //    the normal removal logic clear the local store.
      // An empty doc that only contains the root structure has a deterministic
      // update size; anything larger means real edit history exists.
      const emptyWithRoot = new Y.Doc()
      ensureRoot(emptyWithRoot)
      const emptyUpdateLen = Y.encodeStateAsUpdate(emptyWithRoot).length
      const currentUpdateLen = Y.encodeStateAsUpdate(doc).length

      if (currentUpdateLen <= emptyUpdateLen) {
        logger.warn(
          '[yjs-binding] server doc is empty (no history) but local store has entities; ' +
          'preserving local state and mirroring it back to the doc',
          { localEntityCount },
        )
        syncLocalStateToYDoc()
        return true
      }
      // Fall through: doc has deletion history, apply the authoritative empty state.
    }

    suppressSync(() => {
      // Remove local entities that no longer exist in the authoritative doc.
      // Observers are not attached while STEP2 is applied, so peer deletions
      // that happened while offline would otherwise remain in the store.
      // On the very first sync we skip this cleanup: the local store may contain
      // API-loaded data for a brand-new canvas that the server doc has not yet
      // received. Removing here would wipe that data before syncLocalStateToYDoc
      // has a chance to mirror it into the shared doc.
      if (!skipRemoval) {
        if (collections.nodes) {
          const docIds = new Set(collections.nodes.keys())
          for (const id of liveState.nodes.keys()) {
            if (!docIds.has(id)) store.removeNode(id)
          }
        }
        if (collections.groups) {
          const docIds = new Set(collections.groups.keys())
          for (const id of liveState.groups.keys()) {
            if (!docIds.has(id)) store.removeGroup(id)
          }
        }
        if (collections.domains) {
          const docIds = new Set(collections.domains.keys())
          for (const id of liveState.domains.keys()) {
            if (!docIds.has(id)) store.removeDomain(id)
          }
        }
        if (collections.connections) {
          const docIds = new Set(collections.connections.keys())
          for (const id of liveState.connections.keys()) {
            if (!docIds.has(id)) store.removeConnection(id)
          }
        }
      }

      // Add server-only entities. Skip refreshing specific entities that were
      // edited locally while the handshake was in flight, so those edits are not
      // overwritten by the server snapshot; they will propagate to the doc on
      // the next local mutation via applyDiff.
      // C14: 重连后本地已声明删除的实体（localDeletions）不重新加入 store，
      // 否则离线删除会在重连同步时"幽灵复活"。
      if (collections.nodes) {
        for (const [id, ymap] of collections.nodes) {
          if (isLocalDeletion(provider.canvasId, 'nodes', id)) continue
          if (!liveState.nodes.has(id)) {
            store.addNode({ ...(ymapToObject(ymap) as unknown as Node), id })
          } else if (!shouldSkipExistingUpdate(id)) {
            applyRemoteNode(id, ymap)
          }
        }
      }
      if (collections.groups) {
        for (const [id, ymap] of collections.groups) {
          if (isLocalDeletion(provider.canvasId, 'groups', id)) continue
          if (!liveState.groups.has(id)) {
            store.addGroup({ ...(ymapToObject(ymap) as unknown as NodeGroup), id })
          } else if (!shouldSkipExistingUpdate(id)) {
            applyRemoteGroup(id, ymap)
          }
        }
      }
      if (collections.domains) {
        for (const [id, ymap] of collections.domains) {
          if (isLocalDeletion(provider.canvasId, 'domains', id)) continue
          if (!liveState.domains.has(id)) {
            store.addDomain({ ...(ymapToObject(ymap) as unknown as Domain), id })
          } else if (!shouldSkipExistingUpdate(id)) {
            applyRemoteDomain(id, ymap)
          }
        }
      }
      if (collections.connections) {
        for (const [id, ymap] of collections.connections) {
          if (isLocalDeletion(provider.canvasId, 'connections', id)) continue
          if (!liveState.connections.has(id)) {
            store.addConnection({ ...(ymapToObject(ymap) as unknown as Connection), id })
          } else if (!shouldSkipExistingUpdate(id)) {
            applyRemoteConnection(id, ymap)
          }
        }
      }
    })
    return false
  }

  /** Replace all entities in the Y.Doc with the imported data in one atomic
   *  LOCAL_ORIGIN transaction. The local observer skips LOCAL_ORIGIN, so the
   *  store is not updated by the observer; callers must update the local store
   *  separately (usually via setCanvasData). Remote peers receive the update
   *  and their observers apply it, replacing their local canvas content. */
  function importIntoDoc(data: {
    nodes: Node[]
    groups: NodeGroup[]
    domains: Domain[]
    connections: Connection[]
  }): boolean {
    const collections = getExistingRoot(doc)
    if (!collections) return false

    doc.transact(() => {
      collections.nodes.clear()
      collections.groups.clear()
      collections.domains.clear()
      collections.connections.clear()

      for (const node of data.nodes) {
        collections.nodes.set(node.id, entityToYMap(node as unknown as Record<string, unknown>))
      }
      for (const group of data.groups) {
        collections.groups.set(group.id, entityToYMap(group as unknown as Record<string, unknown>))
      }
      for (const domain of data.domains) {
        collections.domains.set(domain.id, entityToYMap(domain as unknown as Record<string, unknown>))
      }
      for (const connection of data.connections) {
        collections.connections.set(
          connection.id,
          entityToYMap(connection as unknown as Record<string, unknown>),
        )
      }
    }, LOCAL_ORIGIN)

    return true
  }

  return {
    applyDiff,
    get isApplyingRemoteChanges() {
      return isApplyingRemoteChanges
    },
    writeToYDoc: (fn: () => void) => {
      doc.transact(fn, LOCAL_ORIGIN)
    },
    getYNodes,
    getYGroups,
    getYDomains,
    getYConnections,
    importIntoDoc,
    syncLocalStateToYDoc,
    syncLocalEditsToYDoc,
    syncYDocToLocalState,
    reconnectObservers,
    destroy: () => {
      unobserveNodes()
      unobserveGroups()
      unobserveDomains()
      unobserveConnections()
      // C7: 清理交互超时定时器，避免 destroy 后定时器触发 endInteraction
      for (const timer of interactionTimers.values()) {
        clearTimeout(timer)
      }
      interactionTimers.clear()
    },
    suppressSync,
    startInteraction,
    endInteraction,
  }
}

/** R2-3: 握手写回用的实体字段级合并——以 doc 现有 ymap 为基底，仅覆盖本地
 *  实体中"存在的字段"（嵌套对象递归合并、数组增量更新），本地缺失的字段保留
 *  doc 现值。与 writeFields 的差异：① undefined 字段跳过而非删除（本地快照
 *  可能较旧，undefined 常表示"快照里没有"，删除会回退远端新字段）；② 嵌套
 *  对象递归合并，不删除本地缺失的嵌套字段（writeFields 会删）。 */
function mergeEntityFields(collections: Y.Map<Y.Map<unknown>>, id: string, entity: Record<string, unknown>): void {
  const existing = collections.get(id)
  if (existing) {
    mergeFieldsIntoYMap(existing, entity)
  } else {
    collections.set(id, entityToYMap(entity))
  }
}

function mergeFieldsIntoYMap(ymap: Y.Map<unknown>, obj: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue // 本地无此字段值 → 保留 doc 现值（R2-3）
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
      const existing = ymap.get(k)
      if (existing instanceof Y.Map) {
        mergeFieldsIntoYMap(existing as Y.Map<unknown>, v as Record<string, unknown>)
      } else {
        ymap.set(k, entityToYMap(v as Record<string, unknown>))
      }
    } else {
      ymap.set(k, v)
    }
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
  // Replace the whole array in-place so the target order is preserved exactly.
  // The previous Set-based implementation treated the array as an unordered bag,
  // which destroyed order for primitive arrays (e.g. tag lists). For primitive
  // values there is no object identity to merge, so a full ordered replacement
  // is both correct and simple.
  if (current.length > 0) {
    arr.delete(0, current.length)
  }
  if (target.length > 0) {
    arr.insert(0, target)
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
