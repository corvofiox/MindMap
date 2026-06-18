/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the backend Yjs schema helpers.
 *
 * Covers the round-trip: JSON snapshot → Y.Doc → base64 → Y.Doc → JSON snapshot,
 * ensuring no data is lost across the encode/decode boundary.
 */
import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import {
  ensureRoot,
  writeEntityToYMap,
  ymapToObject,
  unwrapYValue,
  docToJsonSnapshot,
  jsonSnapshotToDoc,
  encodeDocToBase64,
  decodeBase64ToDoc,
} from '../websocket/yjs-schema.js'

describe('yjs-schema', () => {
  describe('ensureRoot', () => {
    it('creates the four top-level Y.Maps on a fresh doc', () => {
      const doc = new Y.Doc()
      const c = ensureRoot(doc)
      expect(c.nodes).toBeInstanceOf(Y.Map)
      expect(c.groups).toBeInstanceOf(Y.Map)
      expect(c.domains).toBeInstanceOf(Y.Map)
      expect(c.connections).toBeInstanceOf(Y.Map)
    })

    it('is idempotent — calling twice returns the same Y.Maps', () => {
      const doc = new Y.Doc()
      const c1 = ensureRoot(doc)
      const c2 = ensureRoot(doc)
      expect(c1.nodes).toBe(c2.nodes)
      expect(c1.groups).toBe(c2.groups)
    })
  })

  describe('writeEntityToYMap / ymapToObject', () => {
    it('round-trips scalar fields', () => {
      const doc = new Y.Doc()
      const collections = ensureRoot(doc)
      doc.transact(() => {
        const ymap = new Y.Map()
        writeEntityToYMap(ymap, { id: 'n1', x: 10, y: 20, title: 'Hello' })
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
        const ymap = new Y.Map()
        writeEntityToYMap(ymap, { id: 'g1', nodeIds: ['a', 'b', 'c'] })
        collections.groups.set('g1', ymap)
      })
      const obj = ymapToObject(collections.groups.get('g1')!)
      expect(obj.nodeIds).toEqual(['a', 'b', 'c'])
    })

    it('round-trips nested object fields as Y.Map', () => {
      const doc = new Y.Doc()
      const collections = ensureRoot(doc)
      doc.transact(() => {
        const ymap = new Y.Map()
        writeEntityToYMap(ymap, { id: 'n1', style: { color: 'red', fontSize: 14 } })
        collections.nodes.set('n1', ymap)
      })
      const obj = ymapToObject(collections.nodes.get('n1')!)
      expect(obj.style).toEqual({ color: 'red', fontSize: 14 })
    })

    it('skips undefined values but keeps null', () => {
      const doc = new Y.Doc()
      const collections = ensureRoot(doc)
      doc.transact(() => {
        const ymap = new Y.Map()
        writeEntityToYMap(ymap, { id: 'n1', title: undefined, content: null })
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

    it('returns primitives unchanged', () => {
      expect(unwrapYValue(42)).toBe(42)
      expect(unwrapYValue('hello')).toBe('hello')
      expect(unwrapYValue(null)).toBeNull()
    })
  })

  describe('jsonSnapshotToDoc / docToJsonSnapshot round-trip', () => {
    it('preserves nodes, groups, domains, connections', () => {
      const snapshot = {
        nodes: [
          { id: 'n1', x: 1, y: 2, title: 'Node 1' },
          { id: 'n2', x: 3, y: 4, title: 'Node 2' },
        ],
        groups: [{ id: 'g1', name: 'Group 1', nodeIds: ['n1', 'n2'] }],
        domains: [{ id: 'd1', name: 'Domain 1' }],
        connections: [{ id: 'c1', fromNodeId: 'n1', toNodeId: 'n2' }],
      }
      const doc = jsonSnapshotToDoc(snapshot)
      const result = docToJsonSnapshot(doc)
      expect(result.nodes).toHaveLength(2)
      expect(result.groups).toHaveLength(1)
      expect(result.domains).toHaveLength(1)
      expect(result.connections).toHaveLength(1)
      expect(result.groups[0].nodeIds).toEqual(['n1', 'n2'])
    })

    it('handles empty / partial snapshots', () => {
      const doc = jsonSnapshotToDoc({ nodes: [{ id: 'x', x: 0, y: 0 }] })
      const result = docToJsonSnapshot(doc)
      expect(result.nodes).toHaveLength(1)
      expect(result.groups).toHaveLength(0)
      expect(result.domains).toHaveLength(0)
      expect(result.connections).toHaveLength(0)
    })

    it('skips items without a string id', () => {
      const doc = jsonSnapshotToDoc({
        nodes: [
          { id: 'valid', x: 1 },
          { x: 2 } as any,
          { id: 123, x: 3 } as any,
        ],
      })
      const result = docToJsonSnapshot(doc)
      expect(result.nodes).toHaveLength(1)
      expect(result.nodes[0].id).toBe('valid')
    })
  })

  describe('encodeDocToBase64 / decodeBase64ToDoc round-trip', () => {
    it('encodes and decodes a doc without data loss', () => {
      const original = jsonSnapshotToDoc({
        nodes: [{ id: 'n1', x: 10, y: 20, title: 'Test' }],
        connections: [{ id: 'c1', fromNodeId: 'n1', toNodeId: 'n2' }],
      })
      const base64 = encodeDocToBase64(original)
      expect(base64.length).toBeGreaterThan(4)

      const decoded = decodeBase64ToDoc(base64)
      expect(decoded).not.toBeNull()
      const result = docToJsonSnapshot(decoded!)
      expect(result.nodes).toHaveLength(1)
      expect(result.nodes[0].id).toBe('n1')
      expect(result.nodes[0].x).toBe(10)
      expect(result.connections).toHaveLength(1)
    })

    it('returns null for empty / invalid base64', () => {
      expect(decodeBase64ToDoc(null)).toBeNull()
      expect(decodeBase64ToDoc('')).toBeNull()
      expect(decodeBase64ToDoc(undefined)).toBeNull()
    })
  })
})
