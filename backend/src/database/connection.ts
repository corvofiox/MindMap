import initSqlJs from 'sql.js'
import { drizzle } from 'drizzle-orm/sql-js'
import type { SqlJsDatabase } from 'drizzle-orm/sql-js'
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

type AppDatabase = SqlJsDatabase<typeof schema>

let sqlite: initSqlJs.SqlJsStatic | null = null
let dbInstance: AppDatabase | null = null

let initPromise: Promise<initSqlJs.SqlJsStatic> | null = null

export async function getSqlite(): Promise<initSqlJs.SqlJsStatic> {
  if (sqlite) {
    return sqlite
  }

  if (!initPromise) {
    initPromise = (async () => {
      try {
        log('Initializing sql.js...')

        const SQL = await Promise.race([
          initSqlJs(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('sql.js initialization timeout after 30 seconds')), 30000)
          ),
        ])

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
const SAVE_INTERVAL = 5000

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
  if (saveTimeout) {
    clearTimeout(saveTimeout)
  }
  const elapsed = Date.now() - lastSaveTime
  const delay = Math.max(0, SAVE_INTERVAL - elapsed)
  saveTimeout = setTimeout(() => {
    saveToDisk()
    saveTimeout = null
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
