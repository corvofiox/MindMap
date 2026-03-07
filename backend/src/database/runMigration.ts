import { getSqlite, scheduleSave } from './connection.js'
import { log, logError } from '../utils/logger.js'

async function runMigration() {
  try {
    log('Running manual migration...')
    const sqlite = await getSqlite()

    // Check if project_invitations table exists
    const tableCheck = sqlite.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='project_invitations'")
    
    if (!tableCheck || tableCheck.length === 0 || tableCheck[0].values.length === 0) {
      log('Creating project_invitations table...')
      sqlite.run(`
        CREATE TABLE project_invitations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL REFERENCES projects(id),
          inviter_id INTEGER NOT NULL REFERENCES users(id),
          invitee_id INTEGER NOT NULL REFERENCES users(id),
          role TEXT NOT NULL DEFAULT 'viewer',
          status TEXT NOT NULL DEFAULT 'pending',
          created_at INTEGER DEFAULT (strftime('%s', 'now')),
          responded_at INTEGER
        )
      `)
      log('project_invitations table created successfully')
      scheduleSave()
    } else {
      log('project_invitations table already exists')
    }

    log('Migration completed successfully')
    process.exit(0)
  } catch (error) {
    logError('Migration failed', error)
    process.exit(1)
  }
}

runMigration()
