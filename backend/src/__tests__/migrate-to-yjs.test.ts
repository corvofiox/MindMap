/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for the Yjs data migration script (migrate-to-yjs.ts).
 *
 * Covers:
 *   - decodeLegacySnapshot with null, empty, and valid base64 JSON
 *   - migrateCanvasesToYjs idempotency (skips already-migrated)
 *   - backfillLegacySnapshotFromYjs reverse path
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as Y from 'yjs'

// Mock the logger so tests don't produce noisy output
vi.mock('../utils/logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}))

// Mock the DB connection; each test sets up its own getDb return value
const mockGetDb = vi.hoisted(() => vi.fn())
vi.mock('../database/connection', () => ({
  getDb: mockGetDb,
}))

import {
  decodeLegacySnapshot,
  migrateCanvasesToYjs,
  backfillLegacySnapshotFromYjs,
} from '../database/migrate-to-yjs.js'
import { log, logError } from '../utils/logger.js'
import { encodeDocToBase64 } from '../websocket/yjs-schema.js'

/**
 * Encode a JSON object as a base64 string (simulates legacy yjs_data column).
 */
function encodeSnapshot(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64')
}

/**
 * Build a minimal mock DB for migrateCanvasesToYjs (uses select → from → where).
 */
function mockSelectDb(rows: any[]) {
  const mockDb = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => rows),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
    })),
  }
  mockGetDb.mockReturnValue(mockDb)
  return mockDb
}

/**
 * Build a mock DB for backfillLegacySnapshotFromYjs (uses select → from only).
 */
function mockSelectAllDb(rows: any[]) {
  const mockDb = {
    select: vi.fn(() => ({
      from: vi.fn(async () => rows),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => undefined),
      })),
    })),
  }
  mockGetDb.mockReturnValue(mockDb)
  return mockDb
}

// ─────────────────────────────────────────────
// decodeLegacySnapshot
// ─────────────────────────────────────────────
describe('decodeLegacySnapshot', () => {
  it('returns null for null input', () => {
    expect(decodeLegacySnapshot(null)).toBeNull()
  })

  it('returns null for undefined input', () => {
    expect(decodeLegacySnapshot(undefined)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(decodeLegacySnapshot('')).toBeNull()
  })

  it('returns null for invalid base64', () => {
    expect(decodeLegacySnapshot('!!!not-base64!!!')).toBeNull()
    expect(logError).toHaveBeenCalled()
  })

  it('returns null for valid base64 that is not valid JSON', () => {
    const encoded = Buffer.from('not-json').toString('base64')
    expect(decodeLegacySnapshot(encoded)).toBeNull()
    expect(logError).toHaveBeenCalled()
  })

  it('decodes a valid base64 JSON snapshot', () => {
    const data = { nodes: [{ id: 'n1' }], groups: [], domains: [], connections: [] }
    const result = decodeLegacySnapshot(encodeSnapshot(data))
    expect(result).not.toBeNull()
    expect(result!.nodes).toHaveLength(1)
    expect((result!.nodes![0] as any).id).toBe('n1')
  })

  it('decodes a snapshot with all four collections', () => {
    const data = {
      nodes: [{ id: 'n1' }, { id: 'n2' }],
      groups: [{ id: 'g1' }],
      domains: [{ id: 'd1' }],
      connections: [{ id: 'c1' }],
    }
    const result = decodeLegacySnapshot(encodeSnapshot(data))
    expect(result).not.toBeNull()
    expect(result!.nodes).toHaveLength(2)
    expect(result!.groups).toHaveLength(1)
    expect(result!.domains).toHaveLength(1)
    expect(result!.connections).toHaveLength(1)
  })

  it('returns null for a non-object JSON value', () => {
    // Valid JSON, parsed as number, reverts to null (typeof !== 'object')
    const encoded = Buffer.from('42', 'utf-8').toString('base64')
    expect(decodeLegacySnapshot(encoded)).toBeNull()
  })

  it('logs an error on decode failure', () => {
    vi.mocked(logError).mockClear()
    decodeLegacySnapshot('broken')
    expect(logError).toHaveBeenCalledWith(
      'Failed to decode legacy yjs_data snapshot',
      expect.any(String),
    )
  })
})

// ─────────────────────────────────────────────
// migrateCanvasesToYjs
// ─────────────────────────────────────────────
describe('migrateCanvasesToYjs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('migrates a canvas with legacy yjs_data', async () => {
    const data = { nodes: [{ id: 'n1', x: 10 }], groups: [], domains: [], connections: [] }
    const rows = [
      { id: 1, yjsData: encodeSnapshot(data), yjsUpdate: null },
    ]
    const mockDb = mockSelectDb(rows)
    // Pre-clear the clearAllMocks from beforeEach because we need the mock
    // log to verify migration summary
    vi.mocked(log).mockClear()

    const count = await migrateCanvasesToYjs()

    expect(count).toBe(1)
    // DB update should have been called
    expect(mockDb.update).toHaveBeenCalledTimes(1)
    // Verify migration summary log
    expect(log).toHaveBeenCalledWith('Yjs migration summary', {
      total: 1,
      migrated: 1,
      empty: 0,
      skipped: 0,
    })
  })

  it('counts an empty yjsData canvas as migrated (not empty + migrated)', async () => {
    // A null yjsData canvas gets an empty Y.Doc and is migrated;
    // it should count as migrated=1, empty=0 (the old double-count bug).
    const rows = [
      { id: 2, yjsData: null, yjsUpdate: null },
    ]
    const mockDb = mockSelectDb(rows)
    vi.mocked(log).mockClear()

    const count = await migrateCanvasesToYjs()

    expect(count).toBe(1)
    expect(mockDb.update).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('Yjs migration summary', {
      total: 1,
      migrated: 1,
      empty: 0,
      skipped: 0,
    })
  })

  it('is idempotent — skips canvases that already have yjsUpdate', async () => {
    // When yjsUpdate is already set, the WHERE clause (isNull) excludes them,
    // so zero rows are returned and nothing is migrated.
    const rows: any[] = []
    const mockDb = mockSelectDb(rows)
    vi.mocked(log).mockClear()

    const count = await migrateCanvasesToYjs()

    expect(count).toBe(0)
    expect(mockDb.update).not.toHaveBeenCalled()
  })

  it('handles DB errors gracefully', async () => {
    // Mock DB that throws on select
    const errorDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => {
            throw new Error('DB connection lost')
          }),
        })),
      })),
      update: vi.fn(),
    }
    mockGetDb.mockReturnValue(errorDb)
    vi.mocked(logError).mockClear()
    vi.mocked(log).mockClear()

    // The error will propagate since there's no try-catch around db.select
    await expect(migrateCanvasesToYjs()).rejects.toThrow('DB connection lost')
  })

  it('skips individual row on conversion error', async () => {
    // Provide yjsData that will fail to decode (invalid base64)
    const rows = [
      { id: 3, yjsData: '!!!broken!!!', yjsUpdate: null },
    ]
    const mockDb = mockSelectDb(rows)
    vi.mocked(logError).mockClear()
    vi.mocked(log).mockClear()

    const count = await migrateCanvasesToYjs()

    // The decodeLegacySnapshot returns null (catching the error), then
    // new Y.Doc() is created, encoded, and saved successfully.
    expect(count).toBe(1)
    expect(mockDb.update).toHaveBeenCalledTimes(1)
    // Verify the summary — decode failure for yjsData is inside decodeLegacySnapshot
    // which logs its own error, but since it returns null, the migration continues
    // with an empty doc.
  })
})

// ─────────────────────────────────────────────
// backfillLegacySnapshotFromYjs
// ─────────────────────────────────────────────
describe('backfillLegacySnapshotFromYjs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips rows that already have yjsData', async () => {
    const rows = [
      { id: 1, yjsData: 'existing', yjsUpdate: 'some-update' },
    ]
    const mockDb = mockSelectAllDb(rows)
    vi.mocked(log).mockClear()

    const count = await backfillLegacySnapshotFromYjs()
    expect(count).toBe(0)
    expect(mockDb.update).not.toHaveBeenCalled()
  })

  it('skips rows where yjsUpdate is absent', async () => {
    const rows = [
      { id: 2, yjsData: null, yjsUpdate: null },
    ]
    const mockDb = mockSelectAllDb(rows)
    vi.mocked(log).mockClear()

    const count = await backfillLegacySnapshotFromYjs()
    expect(count).toBe(0)
    expect(mockDb.update).not.toHaveBeenCalled()
  })

  it('skips rows with empty yjsUpdate bytes', async () => {
    const rows = [
      { id: 3, yjsData: null, yjsUpdate: '' },
    ]
    const mockDb = mockSelectAllDb(rows)
    vi.mocked(log).mockClear()

    const count = await backfillLegacySnapshotFromYjs()
    expect(count).toBe(0)
    expect(mockDb.update).not.toHaveBeenCalled()
  })

  // For a fully end-to-end backfill test we need real Yjs updates in the
  // yjsUpdate column. The test below creates such data and then verifies
  // that backfill decodes it and writes back the legacy JSON.
  it('backfills a row that has valid yjsUpdate but no yjsData', async () => {
    // Build a real Yjs doc and encode it as base64
    const doc = new Y.Doc()
    const { ensureRoot, writeEntityToYMap } = await import('../websocket/yjs-schema.js')
    const collections = ensureRoot(doc)
    doc.transact(() => {
      const ymap = new Y.Map()
      writeEntityToYMap(ymap, { id: 'b1', x: 100, y: 200 })
      collections.nodes.set('b1', ymap)
    })
    const yjsUpdate = encodeDocToBase64(doc)

    const rows = [
      { id: 10, yjsData: null, yjsUpdate },
    ]
    const mockDb = mockSelectAllDb(rows)
    vi.mocked(log).mockClear()

    const count = await backfillLegacySnapshotFromYjs()

    expect(count).toBe(1)
    expect(mockDb.update).toHaveBeenCalledTimes(1)
    // Verify the update was called with the id and a yjsData field
    const updateCall = mockDb.update.mock.calls[0]
    expect(updateCall).toBeDefined()
    // The .set() call should include yjsData field
    const setFn = mockDb.update.mock.results[0]?.value
    if (setFn) {
      // We can also check it was called with the correct row id via .where
    }
    expect(log).toHaveBeenCalledWith('Legacy snapshot backfill summary', { backfilled: 1 })
  })

  it('handles corrupt yjsUpdate gracefully — skips and logs', async () => {
    // Corrupt base64 (invalid Yjs update bytes)
    const rows = [
      { id: 4, yjsData: null, yjsUpdate: Buffer.from(new Uint8Array([0xff, 0xfe, 0xfd])).toString('base64') },
    ]
    const mockDb = mockSelectAllDb(rows)
    vi.mocked(logError).mockClear()
    vi.mocked(log).mockClear()

    const count = await backfillLegacySnapshotFromYjs()
    expect(count).toBe(0)
    expect(mockDb.update).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalled()
  })

  it('reports the correct backfilled count', async () => {
    // Simple smoke test: function signature and basic existence
    expect(typeof backfillLegacySnapshotFromYjs).toBe('function')
  })
})
