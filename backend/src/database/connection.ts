import initSqlJs from 'sql.js'
import { drizzle } from 'drizzle-orm/sql-js'
import path from 'path'
import { fileURLToPath } from 'url'
import * as schema from './schema.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const fs = await import('fs')
const dataDir = path.join(__dirname, '../../data')
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true })
}

const SQL = await initSqlJs() as any
const dbPath = process.env.DB_FILE || path.join(dataDir, 'mindmap.db')

let dbData: Uint8Array | null = null
try {
  const dbFile = await fs.promises.readFile(dbPath)
  dbData = new Uint8Array(dbFile)
} catch {
}

const sqlite = new SQL.Database(dbData)

export const db = drizzle(sqlite, { schema })

let saveTimeout: NodeJS.Timeout | null = null
let lastSaveTime = Date.now()
const SAVE_INTERVAL = 5000

async function saveToDisk() {
  try {
    const data = (sqlite as any).export()
    const buffer = Buffer.from(data)
    await fs.promises.writeFile(dbPath, buffer)
    lastSaveTime = Date.now()
  } catch (error) {
    console.error('Failed to save database:', error)
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
