import initSqlJs from 'sql.js'
import { drizzle, type SQLJsDatabase } from 'drizzle-orm/sql-js'
import path from 'path'
import { fileURLToPath } from 'url'
import * as schema from './schema.js'
import * as fs from 'fs/promises'
import { log, logError } from '../utils/logger.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const dataDir = path.join(__dirname, '../../data')
try {
  await fs.mkdir(dataDir, { recursive: true })
} catch (error) {
  // Directory might already exist
}

const dbPath = process.env.DB_FILE || path.join(dataDir, 'mindmap.db')

type AppDatabase = SQLJsDatabase<typeof schema>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sqlite: any = null
let dbInstance: AppDatabase | null = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let initPromise: Promise<any> | null = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getSqlite(): Promise<any> {
  if (sqlite) {
    return sqlite
  }

  if (!initPromise) {
    initPromise = (async () => {
      try {
        log('Initializing sql.js...')

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const SQL = await Promise.race([
          initSqlJs(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('sql.js initialization timeout after 30 seconds')), 30000)
          ),
        ]) as any

        log('sql.js initialized successfully')

        let dbData: Uint8Array | null = null
        try {
          const dbFile = await fs.readFile(dbPath)
          dbData = new Uint8Array(dbFile)
          log('Database file loaded:', dbPath)
        } catch (error) {
          if (process.env.NODE_ENV === 'development') {
            log('Database file not found, creating new one:', dbPath)
          }
          dbData = null
        }

        sqlite = new SQL.Database(dbData)
        log('Database instance created')

        return sqlite
      } catch (error) {
        logError('Failed to initialize sqlite database', error)
        initPromise = null
        throw error
      }
    })()
  }

  return initPromise
}

export async function getDb(): Promise<AppDatabase> {
  if (!dbInstance) {
    const sqliteDb = await getSqlite()
    dbInstance = drizzle(sqliteDb, { schema }) as AppDatabase
  }
  return dbInstance
}

// Lazily-initialized database instance - call initializeDb() on startup
// Controllers access db directly (typed as AppDatabase, not any)
// Using definite assignment assertion (!) - initialized by initializeDb() before any requests
export let db!: AppDatabase

export async function initializeDb(): Promise<AppDatabase> {
  db = await getDb()
  log('Database initialized and ready for use')
  return db
}

let saveTimeout: NodeJS.Timeout | null = null
let lastSaveTime = Date.now()
let firstScheduleTime = 0
const SAVE_INTERVAL = 5000
const MAX_SAVE_DELAY = 15000

async function saveToDisk() {
  try {
    const sqlite = await getSqlite()
    const data = sqlite.export()
    const buffer = Buffer.from(data)
    await fs.writeFile(dbPath, buffer)
    lastSaveTime = Date.now()
  } catch (error) {
    logError('Failed to save database', error)
  }
}

export function scheduleSave() {
  const now = Date.now()
  if (saveTimeout) {
    clearTimeout(saveTimeout)
  }

  if (firstScheduleTime === 0) {
    firstScheduleTime = now
  }

  const elapsed = Date.now() - lastSaveTime
  const sinceFirstSchedule = now - firstScheduleTime
  const maxRemaining = Math.max(0, MAX_SAVE_DELAY - sinceFirstSchedule)
  const delay = Math.min(Math.max(0, SAVE_INTERVAL - elapsed), maxRemaining)

  saveTimeout = setTimeout(() => {
    saveToDisk()
    saveTimeout = null
    firstScheduleTime = 0
  }, delay || 100)
}

async function gracefulShutdown() {
  if (saveTimeout) {
    clearTimeout(saveTimeout)
    saveTimeout = null
  }
  await saveToDisk()
}

process.on('SIGINT', gracefulShutdown)
process.on('SIGTERM', gracefulShutdown)

process.on('beforeExit', gracefulShutdown)
