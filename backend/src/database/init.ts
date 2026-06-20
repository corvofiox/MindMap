import { getSqlite } from './connection.js'
import { runMigrations } from './migration.js'
import { log, logError } from '../utils/logger.js'

// Initialize database
async function initDatabase() {
  const startTime = Date.now()
  log('Starting database initialization...')

  try {
    // The database directory is created lazily inside getSqlite().
    log('Getting database connection...')
    const sqlite = getSqlite()
    log('Database connection established')

    // Run migrations
    log('Running database migrations...')
    await runMigrations(sqlite)
    log('Migrations completed')

    const duration = ((Date.now() - startTime) / 1000).toFixed(2)
    log(`Database initialized successfully in ${duration}s`)
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2)
    logError(`Failed to initialize database after ${duration}s`, error)
    throw error
  }
}

export { initDatabase }
