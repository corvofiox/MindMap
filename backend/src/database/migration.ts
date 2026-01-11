import initSqlJs from 'sql.js'
import { join } from 'path'
import { fileURLToPath } from 'url'
import * as fs from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = join(__filename, '..')

const dataDir = join(__dirname, '../../data')
const dbPath = join(dataDir, 'mindmap.db')

async function runMigration() {
  // Initialize SQL.js
  const SQL = await initSqlJs()

  // Load database
  let dbData: Uint8Array | null = null
  try {
    const dbFile = fs.readFileSync(dbPath)
    dbData = new Uint8Array(dbFile)
  } catch {
    console.error('Database file not found at:', dbPath)
    process.exit(1)
  }

  const db = new SQL.Database(dbData)

  // Add new columns to node_cards table
  try {
    const tableInfo = db.exec('PRAGMA table_info(node_cards)')
    const columns = tableInfo[0].values.map((row: any) => row[1])

    // Add folder_id column
    if (!columns.includes('folder_id')) {
      db.run('ALTER TABLE node_cards ADD COLUMN folder_id INTEGER REFERENCES node_pool_folders(id)')
    }

    // Add description column
    if (!columns.includes('description')) {
      db.run('ALTER TABLE node_cards ADD COLUMN description TEXT')
    }

    // Add thumbnail column
    if (!columns.includes('thumbnail')) {
      db.run('ALTER TABLE node_cards ADD COLUMN thumbnail TEXT')
    }

    // Add sort_order column
    if (!columns.includes('sort_order')) {
      db.run('ALTER TABLE node_cards ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0')
    }
  } catch (error: any) {
    console.error('Error updating node_cards:', error.message)
  }

  // Create node_pool_folders table
  try {
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='node_pool_folders'")
    if (!tables || tables.length === 0 || tables[0].values.length === 0) {
      db.run(`
        CREATE TABLE node_pool_folders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          parent_id INTEGER REFERENCES node_pool_folders(id),
          sort_order INTEGER NOT NULL DEFAULT 0,
          collapsed INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER DEFAULT (strftime('%s', 'now')),
          FOREIGN KEY (project_id) REFERENCES projects(id)
        )
      `)
    }
  } catch (error: any) {
    console.error('Error creating node_pool_folders table:', error.message)
  }

  // Create files table
  try {
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='files'")
    if (!tables || tables.length === 0 || tables[0].values.length === 0) {
      db.run(`
        CREATE TABLE files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filename TEXT NOT NULL,
          path TEXT NOT NULL,
          size INTEGER NOT NULL,
          mime_type TEXT NOT NULL,
          uploader_id INTEGER NOT NULL,
          project_id INTEGER REFERENCES projects(id),
          created_at INTEGER DEFAULT (strftime('%s', 'now')),
          FOREIGN KEY (uploader_id) REFERENCES users(id)
        )
      `)
    }
  } catch (error: any) {
    console.error('Error creating files table:', error.message)
  }

  // Save database
  const data = db.export()
  const buffer = Buffer.from(data)
  fs.writeFileSync(dbPath, buffer)

  db.close()
}

runMigration().catch(console.error)
