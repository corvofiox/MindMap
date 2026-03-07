import initSqlJs from 'sql.js'
import path from 'path'
import { fileURLToPath } from 'url'
import * as fs from 'fs/promises'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const dataDir = path.join(__dirname, 'data')
const dbPath = path.join(dataDir, 'mindmap.db')

async function runMigration() {
  console.log('Running migration to add project_invitations table...')

  try {
    // Initialize SQL.js
    const SQL = await initSqlJs()

    // Load existing database
    let dbData = null
    try {
      const dbFile = await fs.readFile(dbPath)
      dbData = new Uint8Array(dbFile)
      console.log('Database file loaded:', dbPath)
    } catch {
      console.error('Database file not found at:', dbPath)
      process.exit(1)
    }

    const db = new SQL.Database(dbData)

    // Check if project_invitations table exists
    const result = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='project_invitations'")

    if (!result || result.length === 0 || result[0].values.length === 0) {
      console.log('Creating project_invitations table...')
      db.run(`
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
      console.log('project_invitations table created successfully')

      // Save database
      const data = db.export()
      const buffer = Buffer.from(data)
      await fs.writeFile(dbPath, buffer)
      console.log('Database saved successfully')
    } else {
      console.log('project_invitations table already exists')
    }

    db.close()
    console.log('Migration completed!')
  } catch (error) {
    console.error('Migration failed:', error)
    process.exit(1)
  }
}

runMigration()
