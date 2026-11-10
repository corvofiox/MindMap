/**
 * Node vertical order (z-order) helpers — shared by frontend and backend.
 *
 * ## Why a field instead of array/Map order
 *
 * Paint order used to be whatever order the `nodes` Map happened to iterate in.
 * That made z-order unaddressable (no field to read or write), unpersistable
 * (the Yjs doc stores nodes in a `Y.Map`, which has no order) and unsyncable
 * (the collaboration layer diffs per-node fields, so a container-level order is
 * invisible to it). `zIndex` is a plain node field, which means the existing
 * field-level diff transports it for free.
 *
 * ## Numbering scheme
 *
 * Integers on a coarse grid (`NODE_Z_STEP` apart). "Bring to front" takes
 * `max + STEP`, "send to back" takes `min - STEP`, and inserting between two
 * neighbours uses their midpoint. Gaps of 1000 mean a renumbering pass is never
 * needed in practice: you would have to bring the same canvas to the front
 * 9e12 times before leaving the safe-integer range, and by then every other
 * part of the document would have failed first.
 *
 * A node without `zIndex` reads as 0. Legacy canvases therefore keep their
 * historical visual order (stable sort leaves equal keys in Map order), and the
 * first explicitly ordered node lands at `STEP` above all of them.
 */

/** Distance between adjacent z-index values. */
export const NODE_Z_STEP = 1000

export interface ZOrderable {
  zIndex?: number
}

/** Read a node's z-index, treating a missing or non-finite value as 0. */
export function nodeZIndex(node: ZOrderable | null | undefined): number {
  const value = node?.zIndex
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Comparator for `Array.prototype.sort`.
 *
 * Equal z-indexes compare 0 and are therefore left in their existing order —
 * `Array.prototype.sort` is stable per spec (ES2019), and callers pass the Map's
 * iteration order. Do NOT add an id tie-breaker here: that would alphabetise
 * every legacy canvas whose nodes all read as 0.
 */
export function compareNodeZIndex(a: ZOrderable, b: ZOrderable): number {
  return nodeZIndex(a) - nodeZIndex(b)
}

/**
 * Paint order for a canvas: ascending z-index, ties left in iteration order.
 *
 * This is what the node render loop must use. Keeping it a named function makes
 * "does the canvas actually sort before painting?" answerable by a unit test
 * instead of by reading CanvasPage.
 */
export function sortByZIndex<T extends ZOrderable>(nodes: Iterable<T>): T[] {
  return [...nodes].sort(compareNodeZIndex)
}

/** Smallest z-index in the collection; 0 when it is empty. */export function minNodeZIndex(nodes: Iterable<ZOrderable>): number {
  let min = 0
  let seen = false
  for (const node of nodes) {
    const z = nodeZIndex(node)
    if (!seen || z < min) {
      min = z
      seen = true
    }
  }
  return min
}

/** Largest z-index in the collection; 0 when it is empty. */
export function maxNodeZIndex(nodes: Iterable<ZOrderable>): number {
  let max = 0
  let seen = false
  for (const node of nodes) {
    const z = nodeZIndex(node)
    if (!seen || z > max) {
      max = z
      seen = true
    }
  }
  return max
}

/** z-index that places a node above every existing one. */
export function nextZIndexAbove(nodes: Iterable<ZOrderable>): number {
  return maxNodeZIndex(nodes) + NODE_Z_STEP
}

/** z-index that places a node below every existing one. */
export function nextZIndexBelow(nodes: Iterable<ZOrderable>): number {
  return minNodeZIndex(nodes) - NODE_Z_STEP
}
