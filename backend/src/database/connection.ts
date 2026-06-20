import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import * as fs from 'fs'
import { log, logError } from '../utils/logger.js'
import * as schema from './schema.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const dataDir = path.join(__dirname, '../../data')

const dbPath = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(dataDir, 'mindmap.db')

type AppDatabase = BetterSQLite3Database<typeof schema>

let sqlite: Database.Database | null = null
let dbInstance: AppDatabase | null = null

export function getSqlite(): Database.Database {
  if (sqlite) {
    return sqlite
  }

  // Ensure parent directory exists before opening the database file.
  // Kept inside the function so merely importing this module does not
  // touch the filesystem.
  const dbDir = path.dirname(dbPath)
  fs.mkdirSync(dbDir, { recursive: true })

  log('Database path:', dbPath)
  log('Initializing better-sqlite3...')
  sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  log('better-sqlite3 initialized successfully')

  return sqlite
}

export function getDb(): AppDatabase {
  if (!dbInstance) {
    const sqliteDb = getSqlite()
    dbInstance = drizzle(sqliteDb, { schema })
  }
  return dbInstance
}

// Lazily-initialized database instance - call initializeDb() on startup
// Controllers access db directly (typed as AppDatabase, not any)
export let db: AppDatabase

export function initializeDb(): AppDatabase {
  db = getDb()
  log('Database initialized and ready for use')
  return db
}

async function gracefulShutdown() {
  log('Graceful shutdown initiated, flushing canvas states...')

  // Dynamically import canvas-state to flush all in-memory canvas states to DB
  try {
    const { flushAllCanvasStates, stopPeriodicCanvasFlush } = await import(
      '../websocket/canvas-state.js'
    )
    stopPeriodicCanvasFlush()
    await flushAllCanvasStates()
  } catch (error) {
    logError('Failed to flush canvas states during shutdown', error)
  }

  if (sqlite) {
    sqlite.close()
    sqlite = null
    dbInstance = null
    log('Database connection closed')
  }
}

async function gracefulShutdownAndExit(code: number = 0) {
  await gracefulShutdown()
  process.exit(code)
}

let shutdownHandlersRegistered = false

// Register process-level shutdown handlers. Should be called once during
// application startup (e.g. in index.ts after initializeDb()) so tests do not
// inherit global signal handlers from merely importing this module.
export function registerShutdownHandlers() {
  if (shutdownHandlersRegistered) {
    return
  }
  shutdownHandlersRegistered = true

  process.on('SIGINT', () => gracefulShutdownAndExit(0))
  process.on('SIGTERM', () => gracefulShutdownAndExit(0))

  process.on('uncaughtException', async (error) => {
    logError('Uncaught exception, attempting graceful shutdown', error)
    try {
      await gracefulShutdown()
    } catch (shutdownError) {
      logError('Shutdown failed during uncaught exception handler', shutdownError)
    } finally {
      process.exit(1)
    }
  })

  process.on('unhandledRejection', async (reason) => {
    logError('Unhandled rejection, attempting graceful shutdown', reason)
    try {
      await gracefulShutdown()
    } catch (shutdownError) {
      logError('Shutdown failed during unhandled rejection handler', shutdownError)
    } finally {
      process.exit(1)
    }
  })
}
