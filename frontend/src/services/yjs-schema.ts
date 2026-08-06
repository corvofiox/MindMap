/**
 * Frontend Yjs document schema helpers.
 *
 * Mirror of backend/src/websocket/yjs-schema.ts. Both sides MUST stay in sync
 * because the wire format (Yjs binary update) crosses the boundary.
 *
 * Layout:
 *   Y.Doc
 *   └── root: Y.Map
 *       ├── nodes:       Y.Map<nodeId, Y.Map<field, value>>
 *       ├── groups:      Y.Map<groupId, Y.Map<field, value>>
 *       ├── domains:     Y.Map<domainId, Y.Map<field, value>>
 *       └── connections: Y.Map<connId,  Y.Map<field, value>>
 */
import * as Y from 'yjs'

export const ROOT_KEY = 'root'
export const NODES_KEY = 'nodes'
export const GROUPS_KEY = 'groups'
export const DOMAINS_KEY = 'domains'
export const CONNECTIONS_KEY = 'connections'

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
 * Read the existing root structure. This is critical on the client side
 * before the initial STEP2 sync: calling doc.getMap() on a fresh doc would
 * create an empty root map with this client's own CRDT origin and break
 * sync. We first check `doc.share` to see if the root type has been
 * materialized by an incoming update; only then do we call doc.getMap(),
 * which converts the generic AbstractType stored by Yjs into a concrete
 * Y.Map without creating a new one.
 */
export function getExistingRoot(doc: Y.Doc) {
  if (!doc.share.has(ROOT_KEY)) return null
  const root = doc.getMap(ROOT_KEY)
  return {
    root,
    nodes: root.get(NODES_KEY) as Y.Map<Y.Map<unknown>> | undefined,
    groups: root.get(GROUPS_KEY) as Y.Map<Y.Map<unknown>> | undefined,
    domains: root.get(DOMAINS_KEY) as Y.Map<Y.Map<unknown>> | undefined,
    connections: root.get(CONNECTIONS_KEY) as Y.Map<Y.Map<unknown>> | undefined,
  }
}

/**
 * 递归地把普通 JS 值转换为 Yjs 类型：
 * - 对象 → Y.Map（字段递归转换）
 * - 数组 → Y.Array（元素递归转换，嵌套对象/数组也会展开）
 * - 标量 → 原样保留（undefined 表示删除语义，由调用方处理）
 * 与读取侧 unwrapYValue 的递归展开一一对应。
 */
function toYValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Y.Map || value instanceof Y.Array) return value // 已是 Yjs 类型，原样保留
  if (Array.isArray(value)) {
    // 数组元素保持原始 JS 值（不递归转 Y.Map）。Y.Array 本身已是 CRDT 容器，
    // 元素为普通对象即可正确合并；若元素也转 Y.Map，writeFields 的
    // diffObjectArrayById（'id' in item）会对 Y.Map 实例失效，导致对象数组
    // （如 bendPoints）每次写入都全量追加。
    const arr = new Y.Array<unknown>()
    arr.insert(0, value as unknown[])
    return arr
  }
  const nested = new Y.Map<unknown>()
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v !== undefined) nested.set(k, toYValue(v))
  }
  return nested
}

/** Convert a plain object entity into a Y.Map (recursive: nested objects and
 *  arrays are fully expanded into Y.Map / Y.Array). */
export function entityToYMap(data: Record<string, unknown>): Y.Map<unknown> {
  const ymap = new Y.Map<unknown>()
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue
    ymap.set(key, toYValue(value))
  }
  return ymap
}

/** Unwrap a Y.Map/Y.Array back to plain JS. */
export function unwrapYValue(value: unknown): unknown {
  if (value instanceof Y.Map) {
    const result: Record<string, unknown> = {}
    for (const [key, v] of value.entries()) {
      result[key] = unwrapYValue(v)
    }
    return result
  }
  if (value instanceof Y.Array) {
    return value.toArray().map((v) => unwrapYValue(v))
  }
  return value
}

export function ymapToObject(ymap: Y.Map<unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of ymap.entries()) {
    result[key] = unwrapYValue(value)
  }
  return result
}
