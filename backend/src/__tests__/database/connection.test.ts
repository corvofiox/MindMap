/**
 * database/connection.ts + database/init.ts tests — hermetic, file-backed.
 *
 * connection.ts memoises the sqlite instance and the drizzle instance at
 * MODULE level, and reads DB_FILE at module load. Every test therefore uses
 * vi.resetModules() + a dynamic import with a FRESH temp DB_FILE, so each test
 * gets an untouched module graph. Opened instances are closed and temp dirs
 * removed in afterEach.
 *
 * NOT covered (infeasible hermetically): the process.exit paths in
 * gracefulShutdownAndExit and the uncaughtException/unhandledRejection
 * handlers — asserting them would require terminating the test process or
 * triggering a real uncaught exception, both of which kill the vitest worker.
 * gracefulShutdown()'s sqlite.close() side effect is likewise only reachable
 * through those handlers; the file/instance lifecycle it manages IS covered
 * via getSqlite()/getDb() below.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { sql } from 'drizzle-orm'

vi.mock('../../utils/logger.js', () => ({ log: vi.fn(), logError: vi.fn() }))

import * as schema from '../../database/schema.js'

const tempDirs: string[] = []
const openedSqlites: { close: () => void }[] = []
let originalDbFile: string | undefined

beforeEach(() => {
  vi.resetModules()
  originalDbFile = process.env.DB_FILE
})

afterEach(() => {
  for (const instance of openedSqlites) {
    try {
      instance.close()
    } catch {
      // already closed — fine
    }
  }
  openedSqlites.length = 0
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  tempDirs.length = 0
  if (originalDbFile === undefined) {
    delete process.env.DB_FILE
  } else {
    process.env.DB_FILE = originalDbFile
  }
})

/** Fresh temp DB path inside a NOT-yet-existing subdirectory of a temp dir. */
function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindmap-connection-'))
  tempDirs.push(dir)
  return path.join(dir, 'nested', 'test.db')
}

/** Re-import connection.js (and init.js) with DB_FILE pointing at dbFile. */
async function importFreshModules(dbFile: string) {
  process.env.DB_FILE = dbFile
  const connection = await import('../../database/connection.js')
  const init = await import('../../database/init.js')
  return { connection, init }
}

describe('database/connection', () => {
  it('getSqlite creates the file and its missing parent directory, enables WAL + foreign_keys, and memoises the instance', async () => {
    const dbFile = tempDbPath()
    const { connection } = await importFreshModules(dbFile)

    expect(fs.existsSync(path.dirname(dbFile))).toBe(false)
    const first = connection.getSqlite()
    openedSqlites.push(first)

    // Parent dir + file created by the lazy initialization
    expect(fs.existsSync(path.dirname(dbFile))).toBe(true)
    expect(fs.existsSync(dbFile)).toBe(true)

    // WAL journal mode and FK enforcement are actually on. (Setting
    // journal_mode = WAL is also what writes the file header, so these two
    // assertions double as a "the file is a real, initialized db" check.)
    expect(first.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(first.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(fs.statSync(dbFile).size).toBeGreaterThan(0)

    // Memoised: a second call returns the SAME instance, not a new connection
    expect(connection.getSqlite()).toBe(first)
  })

  it('getDb returns a working drizzle instance wired to the same sqlite file; initializeDb is idempotent', async () => {
    const dbFile = tempDbPath()
    const { connection } = await importFreshModules(dbFile)
    openedSqlites.push(connection.getSqlite())

    const db1 = connection.getDb()
    const db2 = connection.getDb()
    expect(db2).toBe(db1)

    // A real round-trip through drizzle proves the instance executes SQL
    expect(db1.get(sql`select 41 + 1 as answer`)).toEqual({ answer: 42 })

    // Writes through drizzle land in the same file db that getSqlite exposes:
    // create a probe table via drizzle, then find it via the raw sqlite handle.
    db1.run(sql`CREATE TABLE probe (id INTEGER)`)
    const raw = connection.getSqlite()
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'probe'").get()).toBeDefined()

    // initializeDb wires the exported `db` and is idempotent
    const initialized1 = connection.initializeDb()
    const initialized2 = connection.initializeDb()
    expect(initialized2).toBe(initialized1)
    expect(initialized1).toBe(db1)
    expect(connection.db).toBe(db1)
  })

  it('registerShutdownHandlers registers the four handlers once and ignores duplicate registration', async () => {
    const dbFile = tempDbPath()
    const { connection } = await importFreshModules(dbFile)
    openedSqlites.push(connection.getSqlite())

    // Narrow facade over process: Node's own listenerCount/listeners/
    // removeListener overloads are keyed by specific event-name literals and
    // reject a plain string, which is all we need here.
    const proc = process as unknown as {
      listenerCount(event: string): number
      listeners(event: string): ((...args: unknown[]) => void)[]
      removeListener(event: string, listener: (...args: unknown[]) => void): unknown
    }

    const events = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']
    const beforeCounts = new Map<string, number>()
    const beforeListeners = new Map<string, ((...args: unknown[]) => void)[]>()
    for (const event of events) {
      beforeCounts.set(event, proc.listenerCount(event))
      beforeListeners.set(event, proc.listeners(event))
    }

    expect(() => connection.registerShutdownHandlers()).not.toThrow()
    const added: Array<{ event: string; listener: (...args: unknown[]) => void }> = []
    for (const event of events) {
      expect(proc.listenerCount(event)).toBe(beforeCounts.get(event)! + 1)
      const fresh = proc.listeners(event).filter((l) => !beforeListeners.get(event)!.includes(l))
      expect(fresh).toHaveLength(1)
      added.push({ event, listener: fresh[0] })
    }

    // The shutdownHandlersRegistered guard: a second call must not
    // double-register any handler (would run gracefulShutdown twice per signal).
    connection.registerShutdownHandlers()
    for (const event of events) {
      expect(proc.listenerCount(event)).toBe(beforeCounts.get(event)! + 1)
    }

    // Clean up so other suites in this worker never inherit our handlers.
    for (const { event, listener } of added) {
      proc.removeListener(event, listener)
    }
    for (const event of events) {
      expect(proc.listenerCount(event)).toBe(beforeCounts.get(event)!)
    }
  })

  it('initDatabase runs the migrations on the file database, making the schema usable', async () => {
    const dbFile = tempDbPath()
    const { connection, init } = await importFreshModules(dbFile)

    await expect(init.initDatabase()).resolves.toBeUndefined()

    const sqlite = connection.getSqlite()
    openedSqlites.push(sqlite)
    const usersTable = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'")
      .get() as { name: string } | undefined
    expect(usersTable?.name).toBe('users')

    // The migrated schema is actually writable through the drizzle instance
    const db = connection.getDb()
    db.insert(schema.users)
      .values({ email: 'init@test.com', password: 'x', nickname: 'n', createdAt: 1, updatedAt: 1 })
      .run()
    expect(sqlite.prepare('SELECT COUNT(*) AS c FROM users').get()).toEqual({ c: 1 })
  })
})
