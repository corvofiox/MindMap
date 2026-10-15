/**
 * Yjs document schema for canvas data.
 *
 * Shared by the WebSocket provider, REST controllers, and the data-migration
 * script. The Y.Doc layout mirrors the legacy JSON snapshot structure so that
 * `setCanvasData` consumers (Zustand, AI prompt builder) can treat the doc as
 * a plain object graph.
 *
 * Layout:
 *   Y.Doc
 *   └── root: Y.Map
 *       ├── nodes:       Y.Map<nodeId, Y.Map<field, value>>
 *       ├── groups:      Y.Map<groupId, Y.Map<field, value>>
 *       ├── domains:     Y.Map<domainId, Y.Map<field, value>>
 *       └── connections: Y.Map<connId,  Y.Map<field, value>>
 *
 * Scalar fields (strings/numbers/booleans) are stored as plain Y.Map entries.
 * Array fields (group.nodeIds, connection.bendPoints) are stored as Y.Array
 * of plain values or nested Y.Map. Object values that should merge field-by-field
 * under CRDT semantics are stored as nested Y.Map; otherwise as JSON-encoded
 * strings to keep the wire format stable.
 */
import * as Y from 'yjs'

export const ROOT_KEY = 'root'
export const NODES_KEY = 'nodes'
export const GROUPS_KEY = 'groups'
export const DOMAINS_KEY = 'domains'
export const CONNECTIONS_KEY = 'connections'

/**
 * Ensure the root structure exists on a fresh doc and return the four top-level
 * Y.Maps. Safe to call repeatedly.
 */
export function ensureRoot(doc: Y.Doc) {
  const root = doc.getMap(ROOT_KEY)
  if (!root.has(NODES_KEY)) root.set(NODES_KEY, new Y.Map())
  if (!root.has(GROUPS_KEY)) root.set(GROUPS_KEY, new Y.Map())
  if (!root.has(DOMAINS_KEY)) root.set(DOMAINS_KEY, new Y.Map())
  if (!root.has(CONNECTIONS_KEY)) root.set(CONNECTIONS_KEY, new Y.Map())
  return {
    root,
    nodes: root.get(NODES_KEY) as Y.Map<Y.Map<unknown>>,
    groups: root.get(GROUPS_KEY) as Y.Map<Y.Map<unknown>>,
    domains: root.get(DOMAINS_KEY) as Y.Map<Y.Map<unknown>>,
    connections: root.get(CONNECTIONS_KEY) as Y.Map<Y.Map<unknown>>,
  }
}

/**
 * H2 幽灵复活防护：读取 doc 中四个实体集合的"删除墓碑"。
 *
 * Yjs 删除一个 map key 并不会抹掉它的 Item——struct 会以 `deleted=true`
 * 保留在 store 里（内容退化成 ContentDeleted / GC），并且 `parentSub` 仍是
 * 被删的实体 id、`parent` 仍指向所属集合 Y.Map。实测该 struct 在任意次
 * encodeStateAsUpdate → applyUpdate 往返后依然存在（doc.gc=true 也不回收
 * struct 本身），因此无需新增任何 doc 结构或 wire 格式，直接扫描即可得到
 * "本集合中被删除且尚未重建的实体 id"。
 *
 * 用途：REST 全量快照合并时，若快照仍携带某个已被删除的实体 id，直接写回
 * 会让该实体在所有人面前复活（而删除它的协作者本地看不到它——分叉）。
 * 合并前用本函数判定并跳过这类 id。
 *
 * 判定必须排除"当前仍存活"的 id：删除后用同一个 id 重新 set 会生成一个新的
 * Item（旧 Item 仍是 deleted），此时 `target.has(id)` 为 true，说明是重建而
 * 非幽灵，不应拦截。Y.UndoManager 撤销删除时是把原 Item 的 deleted 置回
 * false，同样会被 `has` 排除。
 */
interface YjsStoreLike {
  clients?: Map<number, Record<string, unknown>>
}

interface YjsStructLike {
  deleted?: boolean
  parent?: unknown
  parentSub?: unknown
}

export interface TombstonedIds {
  nodes: Set<string>
  groups: Set<string>
  domains: Set<string>
  connections: Set<string>
}

export function collectTombstonedIds(
  doc: Y.Doc,
  collections: {
    nodes: Y.Map<unknown>
    groups: Y.Map<unknown>
    domains: Y.Map<unknown>
    connections: Y.Map<unknown>
  },
): TombstonedIds {
  const result: TombstonedIds = {
    nodes: new Set<string>(),
    groups: new Set<string>(),
    domains: new Set<string>(),
    connections: new Set<string>(),
  }
  const byParent = new Map<Y.Map<unknown>, Set<string>>([
    [collections.nodes, result.nodes],
    [collections.groups, result.groups],
    [collections.domains, result.domains],
    [collections.connections, result.connections],
  ])

  const store = (doc as unknown as { store?: YjsStoreLike }).store
  if (!store?.clients) return result

  for (const client of store.clients.values()) {
    if (!client || typeof client !== 'object') continue
    for (const key in client) {
      const struct = client[key] as YjsStructLike | undefined
      if (!struct || typeof struct !== 'object') continue
      if (struct.deleted !== true) continue
      const bucket = byParent.get(struct.parent as Y.Map<unknown>)
      if (!bucket) continue
      const id = struct.parentSub
      if (typeof id !== 'string' || id.length === 0) continue
      bucket.add(id)
    }
  }

  // 排除仍存活的 id（删除后以同 id 重建 / undo 撤销删除）。
  for (const [parent, bucket] of byParent) {
    for (const id of Array.from(bucket)) {
      if (parent.has(id)) bucket.delete(id)
    }
  }
  return result
}

/**
 * Write a plain object entity into a (possibly pre-existing) Y.Map node.
 * - Scalar values overwrite in place.
 * - Array values (group.nodeIds, connection.bendPoints) are stored as Y.Array
 *   of plain JS values so they survive encodeStateAsUpdate round-trips.
 * - Unknown / null fields are skipped.
 */
export function writeEntityToYMap(ymap: Y.Map<unknown>, data: Record<string, unknown>) {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      const arr = new Y.Array<unknown>()
      // Insert the elements as one block. (Y.Array.push(value) is semantically
      // equivalent — its argument is an array of items, so it also inserts each
      // element individually; insert(0, …) is just the explicit form.)
      arr.insert(0, value as unknown[])
      ymap.set(key, arr)
    } else if (value !== null && typeof value === 'object') {
      // Bend points etc. are arrays of objects; non-array objects are stored as
      // a nested Y.Map for field-level CRDT merging.
      const nested = new Y.Map<unknown>()
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        nested.set(k, v as unknown)
      }
      ymap.set(key, nested)
    } else {
      ymap.set(key, value as unknown)
    }
  }
}

/**
 * Convert a Y.Map entity back to a plain JS object.
 * Nested Y.Map / Y.Array are unwrapped recursively.
 */
export function ymapToObject(ymap: Y.Map<unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of ymap.entries()) {
    result[key] = unwrapYValue(value)
  }
  return result
}

export function unwrapYValue(value: unknown): unknown {
  if (value instanceof Y.Map) {
    return ymapToObject(value)
  }
  if (value instanceof Y.Array) {
    return value.toArray().map((v) => unwrapYValue(v))
  }
  return value
}

/**
 * Export the whole doc into the legacy JSON snapshot shape:
 *   { nodes: [...], groups: [...], domains: [...], connections: [...] }
 * Used by REST GET endpoints and AI prompts.
 */
export function docToJsonSnapshot(doc: Y.Doc): {
  nodes: Record<string, unknown>[]
  groups: Record<string, unknown>[]
  domains: Record<string, unknown>[]
  connections: Record<string, unknown>[]
} {
  const { nodes, groups, domains, connections } = ensureRoot(doc)
  const toArray = (m: Y.Map<Y.Map<unknown>>) =>
    Array.from(m.values()).map((ymap) => ymapToObject(ymap))
  return {
    nodes: toArray(nodes),
    groups: toArray(groups),
    domains: toArray(domains),
    connections: toArray(connections),
  }
}

/**
 * Build a fresh Y.Doc from a legacy JSON snapshot
 * ({ nodes, groups, domains, connections } arrays).
 * Returns the doc with the root structure populated.
 */
export function jsonSnapshotToDoc(snapshot: {
  nodes?: unknown[]
  groups?: unknown[]
  domains?: unknown[]
  connections?: unknown[]
}): Y.Doc {
  const doc = new Y.Doc()
  const collections = ensureRoot(doc)
  const populate = (
    target: Y.Map<Y.Map<unknown>>,
    items: unknown[] | undefined,
  ) => {
    if (!Array.isArray(items)) return
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const id = record.id
      if (typeof id !== 'string') continue
      const ymap = new Y.Map<unknown>()
      writeEntityToYMap(ymap, record)
      target.set(id, ymap)
    }
  }
  populate(collections.nodes, snapshot.nodes)
  populate(collections.groups, snapshot.groups)
  populate(collections.domains, snapshot.domains)
  populate(collections.connections, snapshot.connections)
  return doc
}

/**
 * Encode a doc into a base64 string suitable for the `yjs_update` column.
 */
export function encodeDocToBase64(doc: Y.Doc): string {
  const update = Y.encodeStateAsUpdate(doc)
  return Buffer.from(update).toString('base64')
}

/**
 * Decode a base64-encoded Yjs update and apply it to a fresh doc.
 * Returns null if the input is empty/invalid.
 */
export function decodeBase64ToDoc(base64: string | null | undefined): Y.Doc | null {
  if (!base64) return null
  try {
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.length === 0) return null
    const doc = new Y.Doc()
    Y.applyUpdate(doc, new Uint8Array(bytes))
    return doc
  } catch {
    return null
  }
}
