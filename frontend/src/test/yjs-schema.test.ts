/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the frontend Yjs schema helpers.
 *
 * Mirrors backend/src/__tests__/yjs-schema.test.ts — both sides MUST produce
 * identical wire bytes because the Yjs binary update crosses the boundary.
 */
import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import {
  ensureRoot,
  entityToYMap,
  unwrapYValue,
  ymapToObject,
  ROOT_KEY,
  NODES_KEY,
  GROUPS_KEY,
  DOMAINS_KEY,
  CONNECTIONS_KEY,
} from '../services/yjs-schema'

describe('yjs-schema (frontend)', () => {
  describe('ensureRoot', () => {
    it('creates the four top-level Y.Maps on a fresh doc', () => {
      const doc = new Y.Doc()
      const c = ensureRoot(doc)
      expect(c.nodes).toBeInstanceOf(Y.Map)
      expect(c.groups).toBeInstanceOf(Y.Map)
      expect(c.domains).toBeInstanceOf(Y.Map)
      expect(c.connections).toBeInstanceOf(Y.Map)
    })

    it('is idempotent', () => {
      const doc = new Y.Doc()
      const c1 = ensureRoot(doc)
      const c2 = ensureRoot(doc)
      expect(c1.nodes).toBe(c2.nodes)
    })

    it('uses the correct root key', () => {
      const doc = new Y.Doc()
      ensureRoot(doc)
      expect(doc.getMap(ROOT_KEY)).toBeInstanceOf(Y.Map)
      const root = doc.getMap(ROOT_KEY)
      expect(root.has(NODES_KEY)).toBe(true)
      expect(root.has(GROUPS_KEY)).toBe(true)
      expect(root.has(DOMAINS_KEY)).toBe(true)
      expect(root.has(CONNECTIONS_KEY)).toBe(true)
    })
  })

  describe('entityToYMap / ymapToObject', () => {
    it('round-trips scalar fields', () => {
      const doc = new Y.Doc()
      const collections = ensureRoot(doc)
      doc.transact(() => {
        const ymap = entityToYMap({ id: 'n1', x: 10, y: 20, title: 'Hello' })
        collections.nodes.set('n1', ymap)
      })
      const obj = ymapToObject(collections.nodes.get('n1')!)
      expect(obj.id).toBe('n1')
      expect(obj.x).toBe(10)
      expect(obj.y).toBe(20)
      expect(obj.title).toBe('Hello')
    })

    it('round-trips array fields as Y.Array', () => {
      const doc = new Y.Doc()
      const collections = ensureRoot(doc)
      doc.transact(() => {
        const ymap = entityToYMap({ id: 'g1', nodeIds: ['a', 'b', 'c'] })
        collections.groups.set('g1', ymap)
      })
      const obj = ymapToObject(collections.groups.get('g1')!)
      expect(obj.nodeIds).toEqual(['a', 'b', 'c'])
    })

    it('round-trips nested object fields as Y.Map', () => {
      const doc = new Y.Doc()
      const collections = ensureRoot(doc)
      doc.transact(() => {
        const ymap = entityToYMap({ id: 'n1', style: { color: 'red', fontSize: 14 } })
        collections.nodes.set('n1', ymap)
      })
      const obj = ymapToObject(collections.nodes.get('n1')!)
      expect(obj.style).toEqual({ color: 'red', fontSize: 14 })
    })

    it('skips undefined values', () => {
      const doc = new Y.Doc()
      const collections = ensureRoot(doc)
      doc.transact(() => {
        const ymap = entityToYMap({ id: 'n1', title: undefined, content: null })
        collections.nodes.set('n1', ymap)
      })
      const obj = ymapToObject(collections.nodes.get('n1')!)
      expect(obj.id).toBe('n1')
      expect(obj).not.toHaveProperty('title')
      expect(obj.content).toBeNull()
    })
  })

  describe('unwrapYValue', () => {
    it('unwraps a Y.Array of scalars', () => {
      const doc = new Y.Doc()
      const arr = new Y.Array()
      doc.transact(() => {
        arr.insert(0, [1, 2, 3])
        doc.getMap('root').set('arr', arr)
      })
      expect(unwrapYValue(arr)).toEqual([1, 2, 3])
    })

    it('unwraps a nested Y.Map inside Y.Array', () => {
      const doc = new Y.Doc()
      const inner = new Y.Map()
      const arr = new Y.Array()
      doc.transact(() => {
        inner.set('x', 1)
        arr.insert(0, [inner])
        doc.getMap('root').set('arr', arr)
      })
      expect(unwrapYValue(arr)).toEqual([{ x: 1 }])
    })

    it('returns primitives unchanged', () => {
      expect(unwrapYValue(42)).toBe(42)
      expect(unwrapYValue('hello')).toBe('hello')
      expect(unwrapYValue(null)).toBeNull()
    })
  })

  describe('cross-boundary compatibility', () => {
    it('frontend and backend schemas share the same key constants', () => {
      // These constants must match backend/src/websocket/yjs-schema.ts exactly.
      expect(ROOT_KEY).toBe('root')
      expect(NODES_KEY).toBe('nodes')
      expect(GROUPS_KEY).toBe('groups')
      expect(DOMAINS_KEY).toBe('domains')
      expect(CONNECTIONS_KEY).toBe('connections')
    })
  })
})
