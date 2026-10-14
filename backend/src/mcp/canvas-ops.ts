/**
 * Canvas entity operations for the MCP server.
 *
 * The built-in AI assistant used to mutate the browser's Zustand store directly
 * (frontend `aiTools.ts`). An MCP server is an out-of-process consumer, so it
 * cannot touch a browser store: it operates on the server's authoritative Yjs
 * document instead.
 *
 * Mutating that doc is enough to reach live clients. `loadCanvasStateFromDb`
 * returns the same in-memory `Y.Doc` a WebSocket room holds, and the room
 * registers a single doc-level `update` listener (see websocket/index.ts
 * `ensureRoomBroadcastHandler`) that forwards every change to the other clients.
 * A write here therefore also marks the doc dirty, which the debounced persist
 * timer flushes to the `yjs_update` column.
 *
 * Deliberately entity-scoped: unlike `mergeJsonSnapshotIntoCanvas` (a
 * whole-collection replace used by legacy REST snapshot clients), these helpers
 * only touch the entities named in the call, so an agent can never silently
 * delete a collaborator's work by omitting it from a payload.
 */
import * as Y from 'yjs'
import { loadCanvasStateFromDb } from '../websocket/canvas-state.js'
import {
  ensureRoot,
  writeEntityToYMap,
  ymapToObject,
} from '../websocket/yjs-schema.js'

/**
 * Transaction origin for every MCP write.
 *
 * Scoping the origin lets a `Y.UndoManager` track exactly the agent's own edits,
 * so `undo`/`redo` revert agent operations without unwinding a human's concurrent
 * edits. A frozen object (not a bare string) keeps it collision-proof against the
 * frontend's LOCAL_ORIGIN.
 */
export const MCP_ORIGIN: Readonly<{ source: 'mcp-server' }> = Object.freeze({
  source: 'mcp-server',
})

export interface CanvasSnapshot {
  nodes: Record<string, unknown>[]
  groups: Record<string, unknown>[]
  domains: Record<string, unknown>[]
  connections: Record<string, unknown>[]
}

export interface EntityPayload {
  nodes?: Record<string, unknown>[]
  groups?: Record<string, unknown>[]
  domains?: Record<string, unknown>[]
  connections?: Record<string, unknown>[]
}

export interface DeletedIds {
  nodeIds?: string[]
  groupIds?: string[]
  domainIds?: string[]
  connectionIds?: string[]
}

type CollectionKey = keyof CanvasSnapshot

/** Map the outward-facing id lists onto their doc collections. */
const DELETE_KEY_TO_COLLECTION: Record<keyof DeletedIds, CollectionKey> = {
  nodeIds: 'nodes',
  groupIds: 'groups',
  domainIds: 'domains',
  connectionIds: 'connections',
}

/** Read the whole canvas as plain objects (Yjs wrappers unwrapped). */
export async function getCanvasSnapshot(canvasId: number): Promise<CanvasSnapshot> {
  const state = await loadCanvasStateFromDb(canvasId)
  const { nodes, groups, domains, connections } = ensureRoot(state.doc)
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
 * Insert or field-merge the given entities in one transaction.
 *
 * Each entity needs a non-empty string `id`; entries without one are reported in
 * `skipped` rather than silently dropped, so a caller can tell "ignored" from
 * "written". Returns the ids actually written, per collection.
 */
export async function upsertEntities(
  canvasId: number,
  payload: EntityPayload,
): Promise<{ written: Record<string, string[]>; skipped: Record<string, number> }> {
  const state = await loadCanvasStateFromDb(canvasId)
  const collections = ensureRoot(state.doc)

  // Create the undo manager BEFORE mutating. A Y.UndoManager only observes
  // transactions that happen after it is constructed, so creating it lazily on the
  // first `undo` call would leave the history empty and undo would be a no-op.
  getUndoManager(state.doc)

  const written: Record<string, string[]> = {
    nodes: [],
    groups: [],
    domains: [],
    connections: [],
  }
  const skipped: Record<string, number> = {
    nodes: 0,
    groups: 0,
    domains: 0,
    connections: 0,
  }

  const collectionMap: Record<CollectionKey, Y.Map<Y.Map<unknown>>> = {
    nodes: collections.nodes,
    groups: collections.groups,
    domains: collections.domains,
    connections: collections.connections,
  }

  state.doc.transact(() => {
    for (const key of Object.keys(collectionMap) as CollectionKey[]) {
      const items = payload[key]
      if (!Array.isArray(items)) continue
      const target = collectionMap[key]
      for (const item of items) {
        if (!item || typeof item !== 'object') {
          skipped[key]++
          continue
        }
        const record = item as Record<string, unknown>
        const id = record.id
        if (typeof id !== 'string' || id.length === 0) {
          skipped[key]++
          continue
        }
        const existing = target.get(id)
        if (existing) {
          // Field-level merge: only the supplied keys change.
          writeEntityToYMap(existing, record)
        } else {
          const ymap = new Y.Map<unknown>()
          writeEntityToYMap(ymap, record)
          target.set(id, ymap)
        }
        written[key].push(id)
      }
    }
  }, MCP_ORIGIN)

  return { written, skipped }
}

/**
 * Delete the named entities in one transaction.
 *
 * Deleting a node does NOT cascade to its connections here: connections are
 * separate entities and the caller may legitimately want to re-point them. The
 * `deleteNode` tool performs that cascade explicitly so its behaviour matches the
 * frontend store's `removeNode`.
 */
export async function deleteEntities(
  canvasId: number,
  ids: DeletedIds,
): Promise<{ deleted: Record<string, string[]>; missing: Record<string, string[]> }> {
  const state = await loadCanvasStateFromDb(canvasId)
  const collections = ensureRoot(state.doc)

  // Same reason as upsertEntities: the manager must exist before the mutation it
  // is meant to be able to undo.
  getUndoManager(state.doc)

  const collectionMap: Record<CollectionKey, Y.Map<Y.Map<unknown>>> = {
    nodes: collections.nodes,
    groups: collections.groups,
    domains: collections.domains,
    connections: collections.connections,
  }

  const deleted: Record<string, string[]> = {
    nodes: [],
    groups: [],
    domains: [],
    connections: [],
  }
  const missing: Record<string, string[]> = {
    nodes: [],
    groups: [],
    domains: [],
    connections: [],
  }

  state.doc.transact(() => {
    for (const deleteKey of Object.keys(DELETE_KEY_TO_COLLECTION) as Array<keyof DeletedIds>) {
      const collection = DELETE_KEY_TO_COLLECTION[deleteKey]
      const target = collectionMap[collection]
      const list = ids[deleteKey]
      if (!Array.isArray(list)) continue
      for (const id of list) {
        if (typeof id !== 'string') continue
        if (target.has(id)) {
          target.delete(id)
          deleted[collection].push(id)
        } else {
          missing[collection].push(id)
        }
      }
    }
  }, MCP_ORIGIN)

  return { deleted, missing }
}

/**
 * Undo managers tracking only MCP-origin transactions, keyed by Y.Doc.
 *
 * WeakMap rather than a canvasId map on purpose: the server destroys a canvas's
 * doc whenever its room empties or the idle reclaimer runs (`removeCanvasState`),
 * and `loadCanvasStateFromDb` then swaps in a brand-new doc. Keying by the doc
 * makes both cases self-correcting — a destroyed doc's manager (and its captured
 * history) is collected with it instead of pinning a dead doc in memory forever,
 * and a swapped-in doc gets a fresh manager rather than a stale one.
 *
 * Consequence to be aware of: agent undo history lives only as long as the
 * in-memory doc, so it does not survive every client disconnecting.
 */
const undoManagers = new WeakMap<Y.Doc, Y.UndoManager>()

export function getUndoManager(doc: Y.Doc): Y.UndoManager {
  const existing = undoManagers.get(doc)
  if (existing) return existing

  const { nodes, groups, domains, connections } = ensureRoot(doc)
  const manager = new Y.UndoManager([nodes, groups, domains, connections], {
    // Only the agent's own writes are undoable; concurrent human edits (which
    // arrive as remote updates) are never rolled back by an MCP undo.
    trackedOrigins: new Set([MCP_ORIGIN]),
    // One undo step per tool call rather than time-batched edits.
    captureTimeout: 0,
  })
  undoManagers.set(doc, manager)
  return manager
}
