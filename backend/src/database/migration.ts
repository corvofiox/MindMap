import initSqlJs from 'sql.js'
import path, { join } from 'path'
import { fileURLToPath } from 'url'
import * as fs from 'fs'
import { log, logError } from '../utils/logger.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// 注意：这些路径仅用于直接运行迁移脚本时使用
// 在init.ts中会使用正确的Docker路径
const dataDir = join(__dirname, '../../data')
const dbPath = join(dataDir, 'mindmap.db')

// Function to run migrations on an existing sqlite instance
export async function runMigrations(sqlite: any) {
  try {
    // Check if users table exists, if not create all tables
    const usersTable = sqlite.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
     if (!usersTable || usersTable.length === 0 || usersTable[0].values.length === 0) {
      log('Creating database tables')

      // Create users table
      sqlite.run(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT NOT NULL UNIQUE,
          password TEXT NOT NULL,
          nickname TEXT,
          avatar TEXT,
          created_at INTEGER DEFAULT (strftime('%s', 'now')),
          updated_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `)

      // Create groups table
      sqlite.run(`
        CREATE TABLE groups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT,
          owner_id INTEGER NOT NULL REFERENCES users(id),
          invite_code TEXT NOT NULL UNIQUE,
          created_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `)

      // Create group_members table
      sqlite.run(`
        CREATE TABLE group_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id INTEGER NOT NULL REFERENCES groups(id),
          user_id INTEGER NOT NULL REFERENCES users(id),
          role TEXT NOT NULL DEFAULT 'member',
          joined_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `)

      // Create projects table
      sqlite.run(`
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT,
          owner_id INTEGER NOT NULL REFERENCES users(id),
          group_id INTEGER REFERENCES groups(id),
          thumbnail TEXT,
          is_public INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER DEFAULT (strftime('%s', 'now')),
          updated_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `)

      // Create project_members table
      sqlite.run(`
        CREATE TABLE project_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL REFERENCES projects(id),
          user_id INTEGER NOT NULL REFERENCES users(id),
          role TEXT NOT NULL DEFAULT 'viewer',
          joined_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `)

      // Create folders table
      sqlite.run(`
        CREATE TABLE folders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          project_id INTEGER NOT NULL REFERENCES projects(id),
          parent_id INTEGER REFERENCES folders(id),
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `)

      // Create canvases table
      sqlite.run(`
        CREATE TABLE canvases (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          project_id INTEGER NOT NULL REFERENCES projects(id),
          folder_id INTEGER REFERENCES folders(id),
          yjs_data TEXT,
          preview_text TEXT,
          thumbnail TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER DEFAULT (strftime('%s', 'now')),
          updated_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `)

      // Create canvas_recycle_bin table
      sqlite.run(`
        CREATE TABLE canvas_recycle_bin (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          canvas_id INTEGER NOT NULL REFERENCES canvases(id),
          project_id INTEGER NOT NULL REFERENCES projects(id),
          deleted_by INTEGER NOT NULL REFERENCES users(id),
          deleted_at INTEGER DEFAULT (strftime('%s', 'now')),
          expires_at INTEGER NOT NULL
        )
      `)

      // Create node_cards table
      sqlite.run(`
        CREATE TABLE node_cards (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL REFERENCES projects(id),
          name TEXT NOT NULL,
          content TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'text',
          color TEXT NOT NULL DEFAULT '#ffffff',
          tags TEXT,
          use_count INTEGER NOT NULL DEFAULT 0,
          created_by INTEGER NOT NULL REFERENCES users(id),
          folder_id INTEGER,
          description TEXT,
          thumbnail TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `)

      // Create node_pool_folders table
      sqlite.run(`
        CREATE TABLE node_pool_folders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL REFERENCES projects(id),
          name TEXT NOT NULL,
          parent_id INTEGER REFERENCES node_pool_folders(id),
          sort_order INTEGER NOT NULL DEFAULT 0,
          collapsed INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `)

      // Create settings table
      sqlite.run(`
        CREATE TABLE settings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id),
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'general'
        )
      `)

      // Create files table
      sqlite.run(`
        CREATE TABLE files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filename TEXT NOT NULL,
          path TEXT NOT NULL,
          size INTEGER NOT NULL,
          mime_type TEXT NOT NULL,
          uploader_id INTEGER NOT NULL REFERENCES users(id),
          project_id INTEGER REFERENCES projects(id),
          created_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `)

      log('All database tables created successfully')
     }

    // Add new columns to node_cards table if they don't exist
    const tableInfo = sqlite.exec('PRAGMA table_info(node_cards)')
    if (tableInfo.length > 0) {
      const columns = tableInfo[0].values.map((row: any) => row[1])

      // Add folder_id column
      if (!columns.includes('folder_id')) {
        sqlite.run('ALTER TABLE node_cards ADD COLUMN folder_id INTEGER')
      }

      // Add description column
      if (!columns.includes('description')) {
        sqlite.run('ALTER TABLE node_cards ADD COLUMN description TEXT')
      }

      // Add thumbnail column
      if (!columns.includes('thumbnail')) {
        sqlite.run('ALTER TABLE node_cards ADD COLUMN thumbnail TEXT')
      }

      // Add sort_order column
      if (!columns.includes('sort_order')) {
        sqlite.run('ALTER TABLE node_cards ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0')
     }
     }

    // Create project_invitations table if it doesn't exist
    const projectInvitationsTable = sqlite.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='project_invitations'")
    if (!projectInvitationsTable || projectInvitationsTable.length === 0 || projectInvitationsTable[0].values.length === 0) {
      log('Creating project_invitations table')
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
    }

     log('Migrations completed successfully')
  } catch (error: any) {
    logError('Error running migrations', error.message)
    throw error
  }
}

// Export main migration function for direct use
export async function runMigration() {
  // Initialize SQL.js
  const SQL = await initSqlJs()

  // Load database
  let dbData: Uint8Array | null = null
  try {
    const dbFile = fs.readFileSync(dbPath)
    dbData = new Uint8Array(dbFile)
  } catch {
    logError('Database file not found at:', dbPath)
    process.exit(1)
  }

  const db = new SQL.Database(dbData)

  // Run migrations
  await runMigrations(db)

  // Save database
  const data = db.export()
  const buffer = Buffer.from(data)
  fs.writeFileSync(dbPath, buffer)

  db.close()
}

// Only run migration directly if this file is executed as main
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigration().catch(console.error)
}
