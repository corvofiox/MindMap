import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import { log, logError } from './src/utils/logger.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const dbPath = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(__dirname, 'data', 'mindmap.db')

function checkData() {
  log('Checking database data', { path: dbPath })

  try {
    const db = new Database(dbPath)

    log('=== project_members ===')
    const members = db.prepare('SELECT * FROM project_members').all()
    log(members.length ? members : 'No data')

    log('=== project_invitations ===')
    const invitations = db.prepare('SELECT * FROM project_invitations').all()
    log(invitations.length ? invitations : 'No data')

    log('=== users ===')
    const users = db.prepare('SELECT id, email, nickname FROM users').all()
    log(users.length ? users : 'No data')

    log('=== projects ===')
    const projects = db.prepare('SELECT id, name, owner_id FROM projects').all()
    log(projects.length ? projects : 'No data')

    db.close()
    log('Data check completed')
  } catch (error) {
    logError('Failed to check database data', error)
    process.exit(1)
  }
}

checkData()
