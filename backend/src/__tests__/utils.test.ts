/**
 * Utility tests.
 *
 * Replaces `utils.test.ts`, whose 37 tests declared local objects shaped like the
 * schemas/utils and then asserted on those local objects — no project code was
 * imported, so `transformResponse.ts`, `dateTransform.ts`, `env.ts` and `logger.ts`
 * all sat near 0% coverage.
 *
 * Everything here imports the real modules and asserts real return values,
 * including the edge cases the originals only pretended to cover.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  getProperty,
  getUserId,
  transformResponse,
  transformResponseArray,
} from '../utils/transformResponse.js'
import { transformDateFields, transformDateFieldsArray } from '../utils/dateTransform.js'
import { getEnv, getValidatedEnv, isTrustProxyEnabled } from '../utils/env.js'

describe('transformResponse', () => {
  describe('getProperty', () => {
    it('reads the first present key, tolerating snake_case vs camelCase', () => {
      expect(getProperty<number>({ owner_id: 7 }, 'owner_id', 'ownerId')).toBe(7)
      expect(getProperty<number>({ ownerId: 8 }, 'owner_id', 'ownerId')).toBe(8)
    })

    it('returns undefined for a missing key, null input, or an empty key list', () => {
      expect(getProperty<number>({ other: 1 }, 'owner_id', 'ownerId')).toBeUndefined()
      expect(getProperty<number>(null, 'owner_id')).toBeUndefined()
      expect(getProperty<number>(undefined, 'owner_id')).toBeUndefined()
      expect(getProperty<number>({ a: 1 })).toBeUndefined()
    })

    it('returns an explicit undefined value rather than skipping to the next key', () => {
      // `!== undefined` is the guard, so an explicit undefined falls through.
      expect(getProperty<number>({ a: undefined, b: 5 }, 'a', 'b')).toBe(5)
    })

    it('preserves falsy-but-present values (0, empty string, false)', () => {
      expect(getProperty<number>({ n: 0 }, 'n')).toBe(0)
      expect(getProperty<string>({ s: '' }, 's')).toBe('')
      expect(getProperty<boolean>({ b: false }, 'b')).toBe(false)
    })
  })

  describe('getUserId', () => {
    it('reads userId or user_id', () => {
      expect(getUserId({ userId: 3 })).toBe(3)
      expect(getUserId({ user_id: 4 })).toBe(4)
    })

    it('returns undefined for null/undefined/missing', () => {
      expect(getUserId(null)).toBeUndefined()
      expect(getUserId(undefined)).toBeUndefined()
      expect(getUserId({})).toBeUndefined()
    })
  })

  describe('transformResponse', () => {
    it('converts the named timestamp fields to ISO strings and camelCases keys', () => {
      const row = {
        id: 1,
        created_at: 1700000000,
        updated_at: 1700000100,
        display_name: 'x',
      }
      const out = transformResponse(row, ['createdAt', 'updatedAt'])

      expect(out.id).toBe(1)
      expect(out.displayName).toBe('x')
      expect(typeof out.createdAt).toBe('string')
      expect(out.createdAt).toBe(new Date(1700000000 * 1000).toISOString())
      expect(out.updatedAt).toBe(new Date(1700000100 * 1000).toISOString())
    })

    it('camelCases nested object keys recursively (up to the depth cap)', () => {
      const out = transformResponse(
        { id: 2, nested: { deep_value: 'keep' }, list: [{ inner_key: 1 }], nil: null },
        [],
      )
      // Nested keys are converted too, not just top-level ones.
      expect(out.nested).toEqual({ deepValue: 'keep' })
      expect(out.list).toEqual([{ innerKey: 1 }])
      expect(out.nil).toBeNull()
    })

    it('leaves primitives inside arrays untouched', () => {
      const out = transformResponse({ list: [1, 2, 3] }, [])
      expect(out.list).toEqual([1, 2, 3])
    })

    it('does not throw on a null/undefined timestamp value', () => {
      const out = transformResponse({ created_at: null }, ['createdAt'])
      expect(out.createdAt).toBeNull()
    })

    it('returns an empty object for empty input', () => {
      expect(transformResponse({}, [])).toEqual({})
    })
  })

  describe('transformResponseArray', () => {
    it('maps every element', () => {
      const out = transformResponseArray(
        [
          { id: 1, created_at: 1700000000 },
          { id: 2, created_at: 1700000001 },
        ],
        ['createdAt'],
      )
      expect(out).toHaveLength(2)
      expect(out[0].createdAt).toBe(new Date(1700000000 * 1000).toISOString())
      expect(out[1].id).toBe(2)
    })

    it('returns an empty array for empty input', () => {
      expect(transformResponseArray([], ['createdAt'])).toEqual([])
    })
  })
})

describe('dateTransform', () => {
  it('converts seconds timestamps to ISO strings for the named fields', () => {
    const out = transformDateFields({ a: 1700000000, b: 'unchanged' }, ['a'])
    expect(out.a).toBe(new Date(1700000000 * 1000).toISOString())
    expect(out.b).toBe('unchanged')
  })

  it('skips fields that are absent or null', () => {
    const out = transformDateFields({ a: null }, ['a', 'missing'])
    expect(out.a).toBeNull()
    expect('missing' in out).toBe(false)
  })

  it('transforms each element of an array', () => {
    const out = transformDateFieldsArray([{ t: 1700000000 }, { t: 1700000001 }], ['t'])
    expect(out[0].t).toBe(new Date(1700000000 * 1000).toISOString())
    expect(out[1].t).toBe(new Date(1700000001 * 1000).toISOString())
  })

  it('does not mutate the input object', () => {
    const input = { a: 1700000000 }
    transformDateFields(input, ['a'])
    expect(input.a).toBe(1700000000)
  })
})

describe('env', () => {
  const ORIGINAL = { ...process.env }

  afterEach(() => {
    process.env = { ...ORIGINAL }
  })

  describe('getEnv', () => {
    it('returns the value when set', () => {
      process.env.__TEST_VAR = 'hello'
      expect(getEnv('__TEST_VAR' as never)).toBe('hello')
    })

    it('throws for a required missing variable', () => {
      delete process.env.__TEST_MISSING
      expect(() => getEnv('__TEST_MISSING' as never, true)).toThrow(/__TEST_MISSING/)
    })

    it('returns undefined for an optional missing variable', () => {
      delete process.env.__TEST_MISSING
      expect(getEnv('__TEST_MISSING' as never, false)).toBeUndefined()
    })
  })

  describe('getValidatedEnv', () => {
    /**
     * getValidatedEnv reads JWT_SECRET, JWT_EXPIRES_IN, PORT, WS_PORT, DB_FILE,
     * ALLOWED_ORIGINS and NODE_ENV with `required` defaulting to true — so all of
     * them must be present or it throws. Fill the whole set so each test can
     * isolate the variable it actually cares about.
     */
    function setFullEnv(): void {
      process.env.JWT_SECRET = 'a-secret'
      process.env.JWT_EXPIRES_IN = '7d'
      process.env.PORT = '3000'
      process.env.WS_PORT = '3001'
      process.env.DB_FILE = './data/test.db'
      process.env.ALLOWED_ORIGINS = 'http://localhost:5173'
      process.env.NODE_ENV = 'test'
    }

    it('throws when JWT_SECRET is missing', () => {
      setFullEnv()
      delete process.env.JWT_SECRET
      expect(() => getValidatedEnv()).toThrow(/JWT_SECRET/)
    })

    it('returns the configured values', () => {
      setFullEnv()
      const env = getValidatedEnv()
      expect(env.JWT_SECRET).toBe('a-secret')
      expect(env.JWT_EXPIRES_IN).toBe('7d')
      expect(env.PORT).toBe('3000')
      expect(env.NODE_ENV).toBe('test')
    })

    it('accepts valid JWT_EXPIRES_IN duration forms', () => {
      for (const value of ['3600', '7d', '12h', '30m', '86400000ms', '1.5h', '2 days']) {
        setFullEnv()
        process.env.JWT_EXPIRES_IN = value
        expect(() => getValidatedEnv(), `value=${value}`).not.toThrow()
      }
    })

    it('rejects a malformed JWT_EXPIRES_IN at startup rather than at first login', () => {
      setFullEnv()
      process.env.JWT_EXPIRES_IN = 'not-a-duration'
      expect(() => getValidatedEnv()).toThrow(/JWT_EXPIRES_IN/)
    })
  })

  describe('isTrustProxyEnabled', () => {
    it('is true only for the documented truthy spellings', () => {
      for (const v of ['true', '1', 'yes', 'TRUE', 'Yes']) {
        process.env.TRUST_PROXY = v
        expect(isTrustProxyEnabled(), `value=${v}`).toBe(true)
      }
    })

    it('is false for anything else, including unset and lookalikes', () => {
      for (const v of ['', 'false', '0', 'no', 'on', 'y', 'enabled']) {
        process.env.TRUST_PROXY = v
        expect(isTrustProxyEnabled(), `value=${v}`).toBe(false)
      }
      delete process.env.TRUST_PROXY
      expect(isTrustProxyEnabled()).toBe(false)
    })
  })
})

describe('logger', () => {
  let tmpDir: string
  let originalCwd: string

  beforeEach(() => {
    // logger.ts resolves its log directory from process.cwd() at import time,
    // so exercise it against the real file it actually writes.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-logger-'))
    originalCwd = process.cwd()
  })

  afterEach(() => {
    process.chdir(originalCwd)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes a log entry and reads it back', async () => {
    // Import fresh so LOG_DIR is computed from the temp cwd.
    vi.resetModules()
    process.chdir(tmpDir)
    const logger = await import('../utils/logger.js')

    logger.log('hello-log', { detail: 42 })
    const content = logger.readLogFile()

    expect(content).toContain('hello-log')
    expect(content).toContain('42')
  })

  it('writes errors with level ERROR and the message', async () => {
    vi.resetModules()
    process.chdir(tmpDir)
    const logger = await import('../utils/logger.js')

    logger.logError('boom', new Error('kaboom'))
    const content = logger.readLogFile()

    expect(content).toContain('boom')
    expect(content).toContain('ERROR')
    expect(content).toContain('kaboom')
  })

  it('clearLogFile removes the log contents', async () => {
    vi.resetModules()
    process.chdir(tmpDir)
    const logger = await import('../utils/logger.js')

    logger.log('to-be-cleared')
    expect(logger.readLogFile()).toContain('to-be-cleared')

    logger.clearLogFile()
    expect(logger.readLogFile()).toBe('No log file found')
  })

  it('readLogFile reports a friendly message when no log exists', async () => {
    vi.resetModules()
    process.chdir(tmpDir)
    const logger = await import('../utils/logger.js')
    expect(logger.readLogFile()).toBe('No log file found')
  })
})
