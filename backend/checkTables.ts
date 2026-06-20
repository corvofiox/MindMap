import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import { log, logError } from './src/utils/logger.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const dbPath = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(__dirname, 'data', 'mindmap.db')

function checkTables() {
  log('Checking database tables', { path: dbPath })

  try {
    const db = new Database(dbPath)

    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>
    log('Tables:', rows.map((row) => row.name))

    db.close()
    log('Table check completed')
  } catch (error) {
    logError('Failed to check database tables', error)
    process.exit(1)
  }
}

checkTables()
