import initSqlJs from 'sql.js'
import { drizzle } from 'drizzle-orm/sql-js'
import path from 'path'
import { fileURLToPath } from 'url'
import * as schema from './schema.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Create data directory if it doesn't exist
const fs = await import('fs')
const dataDir = path.join(__dirname, '../../data')
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true })
}

// Initialize SQL.js
const SQL = await initSqlJs() as any
const dbPath = process.env.DB_FILE || path.join(dataDir, 'mindmap.db')

// Load or create database
let dbData: Uint8Array | null = null
try {
  const dbFile = await fs.promises.readFile(dbPath)
  dbData = new Uint8Array(dbFile)
} catch {
  // Database doesn't exist yet, will be created on save
}

const sqlite = new SQL.Database(dbData)

// Run migrations to ensure database schema is up to date
function runMigrations() {
  try {
    // Check if node_cards table exists and needs migration
    const tableInfo = sqlite.exec('PRAGMA table_info(node_cards)')
    if (tableInfo.length > 0) {
      const columns = tableInfo[0].values.map((row: any) => row[1])

      // Add folder_id column if missing
      if (!columns.includes('folder_id')) {
        sqlite.run('ALTER TABLE node_cards ADD COLUMN folder_id INTEGER REFERENCES node_pool_folders(id)')
      }

      // Add description column if missing
      if (!columns.includes('description')) {
        sqlite.run('ALTER TABLE node_cards ADD COLUMN description TEXT')
      }

      // Add thumbnail column if missing
      if (!columns.includes('thumbnail')) {
        sqlite.run('ALTER TABLE node_cards ADD COLUMN thumbnail TEXT')
      }

      // Add sort_order column if missing
      if (!columns.includes('sort_order')) {
        sqlite.run('ALTER TABLE node_cards ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0')
      }
    }

    // Create node_pool_folders table if missing
    const tables = sqlite.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='node_pool_folders'")
    if (!tables || tables.length === 0 || tables[0].values.length === 0) {
      sqlite.run(`
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

    // Create files table if missing
    const filesTables = sqlite.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='files'")
    if (!filesTables || filesTables.length === 0 || filesTables[0].values.length === 0) {
      sqlite.run(`
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
    console.log('Migration note:', error.message)
  }
}

runMigrations()

// Create drizzle instance
export const db = drizzle(sqlite, { schema })

// Save database immediately
export async function saveDatabase() {
  const data = (sqlite as any).export()
  const buffer = Buffer.from(data)
  await fs.promises.writeFile(dbPath, buffer)
}

// Save database on interval
setInterval(saveDatabase, 5000)

// Export for direct access if needed
export { sqlite }
