/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ===========================================================
// applyBatchOperations 单元测试
// 导入实际函数，mock 数据库 & logger 依赖
// ===========================================================

vi.mock('../utils/logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('../database/connection', () => ({
  db: {
    query: { canvases: { findFirst: vi.fn().mockResolvedValue(null) } },
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ run: vi.fn() }) }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ run: vi.fn() }) }) }),
  },
  scheduleSave: vi.fn(),
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => true),
  sql: vi.fn((strings: TemplateStringsArray, ..._values: unknown[]) => ({ strings, _values })),
}))

import { applyBatchOperations, ensureCanvasState, getCanvasState, removeCanvasState } from '../websocket/canvas-state.js'

describe('applyBatchOperations', () => {
  const CANVAS_ID = 1

  beforeEach(() => {
    // 创建一个已加载（loaded=true）的画布状态，避免触发 DB 查询
    const state = ensureCanvasState(CANVAS_ID)
      ; (state as any).loaded = true
    state.version = 1
  })

  afterEach(() => {
    removeCanvasState(CANVAS_ID)
  })

  describe('basic operations', () => {
    it('should return false for empty operations array', async () => {
      const result = await applyBatchOperations(CANVAS_ID, [])
      expect(result).toBe(false)
    })

    it('should return false for null/undefined operations', async () => {
      const result = await applyBatchOperations(CANVAS_ID, null as any)
      expect(result).toBe(false)
    })

    it('should apply a single add-node operation', async () => {
      const result = await applyBatchOperations(CANVAS_ID, [
        { operation: 'add-node', data: { id: 'n1', text: 'Hello' } },
      ])
      expect(result).toBe(true)

      const state = getCanvasState(CANVAS_ID)!
      expect(state.nodes.has('n1')).toBe(true)
      expect((state.nodes.get('n1') as any).text).toBe('Hello')
      expect(state.version).toBe(2)
    })

    it('should skip duplicate add-node (idempotent)', async () => {
      await applyBatchOperations(CANVAS_ID, [
        { operation: 'add-node', data: { id: 'n1', text: 'First' } },
      ])
      const result = await applyBatchOperations(CANVAS_ID, [
        { operation: 'add-node', data: { id: 'n1', text: 'Second' } },
      ])
      expect(result).toBe(false)

      const state = getCanvasState(CANVAS_ID)!
      expect((state.nodes.get('n1') as any).text).toBe('First')
      expect(state.version).toBe(2)
    })

    it('should apply update-node when data changes', async () => {
      await applyBatchOperations(CANVAS_ID, [
        { operation: 'add-node', data: { id: 'n1', text: 'Old' } },
      ])
      const result = await applyBatchOperations(CANVAS_ID, [
        { operation: 'update-node', data: { id: 'n1', updates: { text: 'New' } } },
      ])
      expect(result).toBe(true)

      const state = getCanvasState(CANVAS_ID)!
      expect((state.nodes.get('n1') as any).text).toBe('New')
      expect(state.version).toBe(3)
    })

    it('should skip update-node when data unchanged', async () => {
      await applyBatchOperations(CANVAS_ID, [
        { operation: 'add-node', data: { id: 'n1', text: 'Same', x: 100 } },
      ])
      const result = await applyBatchOperations(CANVAS_ID, [
        { operation: 'update-node', data: { id: 'n1', updates: { text: 'Same' } } },
      ])
      expect(result).toBe(false)

      const state = getCanvasState(CANVAS_ID)!
      expect(state.version).toBe(2)
    })

    it('should skip update-node when node does not exist', async () => {
      const result = await applyBatchOperations(CANVAS_ID, [
        { operation: 'update-node', data: { id: 'nonexistent', updates: { text: 'X' } } },
      ])
      expect(result).toBe(false)
    })

    it('should apply remove-node', async () => {
      await applyBatchOperations(CANVAS_ID, [
        { operation: 'add-node', data: { id: 'n1' } },
      ])
      const result = await applyBatchOperations(CANVAS_ID, [
        { operation: 'remove-node', data: { id: 'n1' } },
      ])
      expect(result).toBe(true)

      const state = getCanvasState(CANVAS_ID)!
      expect(state.nodes.has('n1')).toBe(false)
    })

    it('should skip remove-node when node does not exist', async () => {
      const result = await applyBatchOperations(CANVAS_ID, [
        { operation: 'remove-node', data: { id: 'nonexistent' } },
      ])
      expect(result).toBe(false)
    })
  })

  describe('TOCTOU version check', () => {
    it('should reject batch when server version exceeds clientVersion', async () => {
      const state = getCanvasState(CANVAS_ID)!
      state.version = 10

      const result = await applyBatchOperations(
        CANVAS_ID,
        [{ operation: 'add-node', data: { id: 'n1' } }],
        5
      )
      expect(result).toBe(false)
      expect(state.version).toBe(10)
      expect(state.nodes.has('n1')).toBe(false)
    })

    it('should accept batch when clientVersion equals serverVersion', async () => {
      const state = getCanvasState(CANVAS_ID)!
      state.version = 5

      const result = await applyBatchOperations(
        CANVAS_ID,
        [{ operation: 'add-node', data: { id: 'n1' } }],
        5
      )
      expect(result).toBe(true)
      expect(state.nodes.has('n1')).toBe(true)
    })

    it('should accept batch when clientVersion not provided', async () => {
      const state = getCanvasState(CANVAS_ID)!
      state.version = 100

      const result = await applyBatchOperations(
        CANVAS_ID,
        [{ operation: 'add-node', data: { id: 'n1' } }]
      )
      expect(result).toBe(true)
      expect(state.nodes.has('n1')).toBe(true)
    })
  })

  describe('mixed operations', () => {
    it('should apply multiple operations in a single batch', async () => {
      const result = await applyBatchOperations(CANVAS_ID, [
        { operation: 'add-node', data: { id: 'n1', text: 'A' } },
        { operation: 'add-node', data: { id: 'n2', text: 'B' } },
        { operation: 'update-node', data: { id: 'n1', updates: { text: 'Updated' } } },
      ])
      expect(result).toBe(true)

      const state = getCanvasState(CANVAS_ID)!
      expect(state.nodes.size).toBe(2)
      expect((state.nodes.get('n1') as any).text).toBe('Updated')
      expect(state.version).toBe(2)
    })

    it('should handle mixed entity types', async () => {
      const result = await applyBatchOperations(CANVAS_ID, [
        { operation: 'add-node', data: { id: 'n1' } },
        { operation: 'add-group', data: { id: 'g1' } },
        { operation: 'add-domain', data: { id: 'd1' } },
        { operation: 'add-connection', data: { id: 'c1' } },
      ])
      expect(result).toBe(true)

      const state = getCanvasState(CANVAS_ID)!
      expect(state.nodes.has('n1')).toBe(true)
      expect(state.groups.has('g1')).toBe(true)
      expect(state.domains.has('d1')).toBe(true)
      expect(state.connections.has('c1')).toBe(true)
    })

    it('should return false when all operations are no-ops', async () => {
      await applyBatchOperations(CANVAS_ID, [
        { operation: 'add-node', data: { id: 'n1' } },
      ])
      const result = await applyBatchOperations(CANVAS_ID, [
        { operation: 'add-node', data: { id: 'n1' } },
        { operation: 'update-node', data: { id: 'n1', updates: { text: undefined as any } } },
      ])
      expect(result).toBe(false)

      const state = getCanvasState(CANVAS_ID)!
      expect(state.version).toBe(2)
    })

    it('should return true when at least one operation applies', async () => {
      await applyBatchOperations(CANVAS_ID, [
        { operation: 'add-node', data: { id: 'n1' } },
      ])
      const result = await applyBatchOperations(CANVAS_ID, [
        { operation: 'add-node', data: { id: 'n1' } },
        { operation: 'add-node', data: { id: 'n2' } },
      ])
      expect(result).toBe(true)

      const state = getCanvasState(CANVAS_ID)!
      expect(state.nodes.has('n2')).toBe(true)
    })
  })

  describe('version management', () => {
    it('should increment version by exactly 1 for successful batch', async () => {
      for (let i = 0; i < 5; i++) {
        await applyBatchOperations(CANVAS_ID, [
          { operation: 'add-node', data: { id: `n${i}` } },
        ])
      }

      const state = getCanvasState(CANVAS_ID)!
      expect(state.version).toBe(6)
    })

    it('should NOT increment version for empty batch', async () => {
      const state = getCanvasState(CANVAS_ID)!
      const initialVersion = state.version

      await applyBatchOperations(CANVAS_ID, [])
      expect(state.version).toBe(initialVersion)
    })
  })

  describe('edge cases', () => {
    it('should ignore unknown operation types silently', async () => {
      const result = await applyBatchOperations(CANVAS_ID, [
        { operation: 'unknown-op', data: { id: 'x' } },
        { operation: 'add-node', data: { id: 'n1' } },
      ])
      expect(result).toBe(true)

      const state = getCanvasState(CANVAS_ID)!
      expect(state.nodes.has('n1')).toBe(true)
    })

    it('should handle updates with null/undefined values gracefully', async () => {
      await applyBatchOperations(CANVAS_ID, [
        { operation: 'add-node', data: { id: 'n1', text: 'Old' } },
      ])

      const result = await applyBatchOperations(CANVAS_ID, [
        { operation: 'update-node', data: { id: 'n1', updates: null } },
      ])
      expect(result).toBe(false)
    })

    it('should handle large batches', async () => {
      const ops = Array.from({ length: 100 }, (_, i) => ({
        operation: 'add-node' as const,
        data: { id: `n${i}` },
      }))
      const result = await applyBatchOperations(CANVAS_ID, ops)
      expect(result).toBe(true)

      const state = getCanvasState(CANVAS_ID)!
      expect(state.nodes.size).toBe(100)
      expect(state.version).toBe(2)
    })
  })

  describe('update with new fields', () => {
    it('should detect change when adding new field', async () => {
      await applyBatchOperations(CANVAS_ID, [
        { operation: 'add-node', data: { id: 'n1', text: 'Old' } },
      ])
      const result = await applyBatchOperations(CANVAS_ID, [
        { operation: 'update-node', data: { id: 'n1', updates: { newField: 'value' } } },
      ])
      expect(result).toBe(true)

      const state = getCanvasState(CANVAS_ID)!
      expect((state.nodes.get('n1') as any).newField).toBe('value')
      expect((state.nodes.get('n1') as any).text).toBe('Old')
    })
  })
})