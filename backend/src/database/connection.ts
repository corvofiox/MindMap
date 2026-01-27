import initSqlJs from 'sql.js'
import { drizzle } from 'drizzle-orm/sql-js'
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sqlite: any = null
let dbInstance: any = null

// Initialization lock to prevent concurrent initialization
let initPromise: Promise<any> | null = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getSqlite() {
  if (sqlite) {
    return sqlite
  }

  // Use initialization lock to prevent concurrent initialization
  if (!initPromise) {
    initPromise = (async () => {
      try {
        log('Initializing sql.js...')
        
        // Add timeout protection for sql.js initialization
        const SQL = await Promise.race([
          initSqlJs() as any,
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('sql.js initialization timeout after 30 seconds')), 30000)
          )
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getDb() {
  if (!dbInstance) {
    const sqliteDb = await getSqlite()
    dbInstance = drizzle(sqliteDb as any, { schema })
  }
  return dbInstance
}

// Export db as null initially, will be initialized by index.ts on startup
// This prevents top-level await blocking
export let db: any = null

// Initialize db instance - call this on app startup
export async function initializeDb() {
  if (!db) {
    db = await getDb()
    log('Database initialized and ready for use')
  }
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
