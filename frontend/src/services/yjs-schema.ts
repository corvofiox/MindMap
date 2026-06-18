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

/** Convert a plain object entity into a Y.Map (scalar fields only). */
export function entityToYMap(data: Record<string, unknown>): Y.Map<unknown> {
  const ymap = new Y.Map<unknown>()
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      const arr = new Y.Array<unknown>()
      arr.insert(0, value as unknown[])
      ymap.set(key, arr)
    } else if (value !== null && typeof value === 'object') {
      const nested = new Y.Map<unknown>()
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        nested.set(k, v as unknown)
      }
      ymap.set(key, nested)
    } else {
      ymap.set(key, value as unknown)
    }
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
