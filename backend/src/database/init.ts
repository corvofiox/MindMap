import { getSqlite, scheduleSave } from './connection.js'
import { runMigrations } from './migration.js'
import path from 'path'
import { fileURLToPath } from 'url'
import * as fs from 'fs/promises'
import { log, logError } from '../utils/logger.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Initialize database
async function initDatabase() {
  try {
    // Create data directory if it doesn't exist
    const dataDir = process.env.DB_DIR || path.join(__dirname, '../../', 'data')
    try {
      await fs.mkdir(dataDir, { recursive: true })
    } catch (error) {
      // Directory might already exist
    }

    const dbPath = process.env.DB_FILE || path.join(dataDir, 'mindmap.db')

    // Get the shared sqlite instance from connection.ts
    const sqlite = await getSqlite()

    // Run migrations
    if (process.env.NODE_ENV === 'development') {
      log('Running database migrations...')
    }
    await runMigrations(sqlite)

    // Save database
    if (process.env.NODE_ENV === 'development') {
      log('Saving database...')
    }
    const data = sqlite.export()
    const buffer = Buffer.from(data)
    await fs.writeFile(dbPath, buffer)

    log('Database initialized successfully')

    return
  } catch (error) {
    logError('Failed to initialize database', error)
    throw error
  }
}

export { initDatabase }
