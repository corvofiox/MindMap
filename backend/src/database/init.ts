import { getSqlite } from './connection.js'
import { runMigrations } from './migration.js'
import path from 'path'
import { fileURLToPath } from 'url'
import * as fs from 'fs/promises'
import { log, logError } from '../utils/logger.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Initialize database
async function initDatabase() {
  const startTime = Date.now()
  log('Starting database initialization...')
  
  try {
    // Create data directory if it doesn't exist
    const dataDir = process.env.DB_DIR || path.join(__dirname, '../../', 'data')
    try {
      await fs.mkdir(dataDir, { recursive: true })
      log('Data directory ready:', dataDir)
    } catch (error) {
      // Directory might already exist
      log('Data directory already exists:', dataDir)
    }

    const dbPath = process.env.DB_FILE || path.join(dataDir, 'mindmap.db')
    log('Database path:', dbPath)

    // Get the shared sqlite instance from connection.ts with timeout
    log('Getting database connection...')
    const sqlite = await Promise.race([
      getSqlite(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Database connection timeout after 60 seconds')), 60000)
      )
    ]) as any
    log('Database connection established')

    // Run migrations
    log('Running database migrations...')
    await runMigrations(sqlite)
    log('Migrations completed')

    // Save database
    log('Saving database to disk...')
    const data = sqlite.export()
    const buffer = Buffer.from(data)
    await fs.writeFile(dbPath, buffer)
    log('Database saved successfully')

    const duration = ((Date.now() - startTime) / 1000).toFixed(2)
    log(`Database initialized successfully in ${duration}s`)

    return
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2)
    logError(`Failed to initialize database after ${duration}s`, error)
    throw error
  }
}

export { initDatabase }
