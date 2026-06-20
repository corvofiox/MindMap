import path, { join } from 'path'
import { fileURLToPath } from 'url'
import * as fs from 'fs'
import Database from 'better-sqlite3'
import { log, logError } from '../utils/logger.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Note: these paths are only used when running this migration file directly
// init.ts uses the correct Docker paths
const dataDir = join(__dirname, '../../data')
const dbPath = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : join(dataDir, 'mindmap.db')

function tableExists(sqlite: Database.Database, name: string): boolean {
  const row = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { name: string } | undefined
  return !!row
}

function getColumns(sqlite: Database.Database, tableName: string): string[] {
  const rows = sqlite.pragma(`table_info(${tableName})`) as Array<{ name: string }>
  return rows.map((row) => row.name)
}

// Function to run migrations on an existing sqlite instance
export async function runMigrations(sqlite: Database.Database) {
  try {
    // Check if users table exists, if not create all tables
    if (!tableExists(sqlite, 'users')) {
      log('Creating database tables')

      // Create users table
      sqlite.exec(`
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
      sqlite.exec(`
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
      sqlite.exec(`
        CREATE TABLE group_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id INTEGER NOT NULL REFERENCES groups(id),
          user_id INTEGER NOT NULL REFERENCES users(id),
          role TEXT NOT NULL DEFAULT 'member',
          joined_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `)

      // Create projects table
      sqlite.exec(`
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          description TEXT,
          owner_id INTEGER NOT NULL REFERENCES users(id),
          group_id INTEGER REFERENCES groups(id),
          thumbnail TEXT,
          is_public INTEGER NOT NULL DEFAULT 0,
          is_collaborative INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER DEFAULT (strftime('%s', 'now')),
          updated_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `)

      // Create project_members table
      sqlite.exec(`
        CREATE TABLE project_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL REFERENCES projects(id),
          user_id INTEGER NOT NULL REFERENCES users(id),
          role TEXT NOT NULL DEFAULT 'viewer',
          joined_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `)

      // Create folders table
      sqlite.exec(`
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
      sqlite.exec(`
        CREATE TABLE canvases (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          project_id INTEGER NOT NULL REFERENCES projects(id),
          folder_id INTEGER REFERENCES folders(id),
          yjs_data TEXT,
          yjs_update TEXT,
          preview_text TEXT,
          thumbnail TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER DEFAULT (strftime('%s', 'now')),
          updated_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `)

      // Create canvas_recycle_bin table
      sqlite.exec(`
        CREATE TABLE canvas_recycle_bin (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          canvas_id INTEGER NOT NULL REFERENCES canvases(id),
          project_id INTEGER NOT NULL REFERENCES projects(id),
          deleted_by INTEGER NOT NULL REFERENCES users(id),
          deleted_at INTEGER DEFAULT (strftime('%s', 'now')),
          expires_at INTEGER NOT NULL
        )
      `)

      // Create node_cards table (user-specific)
      sqlite.exec(`
        CREATE TABLE node_cards (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id),
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

      // Create node_pool_folders table (user-specific)
      sqlite.exec(`
        CREATE TABLE node_pool_folders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id),
          name TEXT NOT NULL,
          parent_id INTEGER REFERENCES node_pool_folders(id),
          sort_order INTEGER NOT NULL DEFAULT 0,
          collapsed INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `)

      // Create settings table
      sqlite.exec(`
        CREATE TABLE settings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id),
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'general'
        )
      `)

      // Create files table
      sqlite.exec(`
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

    // Add is_collaborative column to projects table if it doesn't exist
    const projectColumns = getColumns(sqlite, 'projects')
    if (!projectColumns.includes('is_collaborative')) {
      log('Adding is_collaborative column to projects table')
      sqlite.exec('ALTER TABLE projects ADD COLUMN is_collaborative INTEGER NOT NULL DEFAULT 0')
      log('is_collaborative column added successfully')
    }

    // Add new columns to node_cards table if they don't exist
    const columns = getColumns(sqlite, 'node_cards')

    // Add folder_id column
    if (!columns.includes('folder_id')) {
      sqlite.exec('ALTER TABLE node_cards ADD COLUMN folder_id INTEGER')
    }

    // Add description column
    if (!columns.includes('description')) {
      sqlite.exec('ALTER TABLE node_cards ADD COLUMN description TEXT')
    }

    // Add thumbnail column
    if (!columns.includes('thumbnail')) {
      sqlite.exec('ALTER TABLE node_cards ADD COLUMN thumbnail TEXT')
    }

    // Add sort_order column
    if (!columns.includes('sort_order')) {
      sqlite.exec('ALTER TABLE node_cards ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0')
    }

    // Create project_invitations table if it doesn't exist
    if (!tableExists(sqlite, 'project_invitations')) {
      log('Creating project_invitations table')
      sqlite.exec(`
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

    // Create ai_conversations table if it doesn't exist
    if (!tableExists(sqlite, 'ai_conversations')) {
      log('Creating ai_conversations table')
      sqlite.exec(`
        CREATE TABLE ai_conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          canvas_id INTEGER NOT NULL REFERENCES canvases(id),
          user_id INTEGER NOT NULL REFERENCES users(id),
          messages TEXT NOT NULL,
          context_divider_index INTEGER NOT NULL DEFAULT -1,
          updated_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `)
      // Create unique index for canvas_id and user_id
      sqlite.exec(`
        CREATE UNIQUE INDEX ai_conversations_canvas_user_idx ON ai_conversations (canvas_id, user_id)
      `)
      log('ai_conversations table created successfully')
    }

    // Migrate node_cards and node_pool_folders from project_id to user_id
    const nodeCardsColumns = getColumns(sqlite, 'node_cards')

    // Check if user_id column exists (new schema)
    if (!nodeCardsColumns.includes('user_id') && nodeCardsColumns.includes('project_id')) {
      log('Migrating node_cards from project_id to user_id')

      // Create new node_pool_folders table with user_id (without self-referencing FK)
      sqlite.exec(`
        CREATE TABLE node_pool_folders_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          parent_id INTEGER,
          sort_order INTEGER DEFAULT 0 NOT NULL,
          collapsed INTEGER DEFAULT 0 NOT NULL,
          created_at INTEGER DEFAULT (strftime('%s', 'now')),
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `)

      // Create new node_cards table with user_id
      sqlite.exec(`
        CREATE TABLE node_cards_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          content TEXT NOT NULL,
          type TEXT DEFAULT 'text' NOT NULL,
          color TEXT DEFAULT '#ffffff' NOT NULL,
          tags TEXT,
          use_count INTEGER DEFAULT 0 NOT NULL,
          created_by INTEGER NOT NULL,
          folder_id INTEGER,
          description TEXT,
          thumbnail TEXT,
          sort_order INTEGER DEFAULT 0 NOT NULL,
          created_at INTEGER DEFAULT (strftime('%s', 'now')),
          FOREIGN KEY (user_id) REFERENCES users(id),
          FOREIGN KEY (created_by) REFERENCES users(id)
        )
      `)

      // Migrate node_pool_folders data
      sqlite.exec(`
        INSERT INTO node_pool_folders_new (id, user_id, name, parent_id, sort_order, collapsed, created_at)
        SELECT
          npf.id,
          COALESCE(p.owner_id, (
            SELECT nc.created_by
            FROM node_cards nc
            WHERE nc.folder_id = npf.id
            LIMIT 1
          )) as user_id,
          npf.name,
          npf.parent_id,
          npf.sort_order,
          npf.collapsed,
          npf.created_at
        FROM node_pool_folders npf
        LEFT JOIN projects p ON npf.project_id = p.id
        WHERE COALESCE(p.owner_id, (
          SELECT nc.created_by
          FROM node_cards nc
          WHERE nc.folder_id = npf.id
          LIMIT 1
        )) IS NOT NULL
      `)

      // Migrate node_cards data
      sqlite.exec(`
        INSERT INTO node_cards_new (id, user_id, name, content, type, color, tags, use_count, created_by, folder_id, description, thumbnail, sort_order, created_at)
        SELECT
          nc.id,
          COALESCE(p.owner_id, nc.created_by) as user_id,
          nc.name,
          nc.content,
          nc.type,
          nc.color,
          nc.tags,
          nc.use_count,
          nc.created_by,
          nc.folder_id,
          nc.description,
          nc.thumbnail,
          nc.sort_order,
          nc.created_at
        FROM node_cards nc
        LEFT JOIN projects p ON nc.project_id = p.id
      `)

      // Drop old tables
      sqlite.exec('DROP TABLE node_cards')
      sqlite.exec('DROP TABLE node_pool_folders')

      // Rename new tables
      sqlite.exec('ALTER TABLE node_cards_new RENAME TO node_cards')
      sqlite.exec('ALTER TABLE node_pool_folders_new RENAME TO node_pool_folders')

      log('node_cards and node_pool_folders migrated to user_id successfully')
    }

    // Add yjs_update column to canvases table if it doesn't exist
    // This column stores the Yjs binary state update (base64) and is the authoritative
    // canvas data store after the Yjs migration. The legacy yjs_data column (JSON base64)
    // is retained for rollback safety.
    const canvasColumns = getColumns(sqlite, 'canvases')
    if (!canvasColumns.includes('yjs_update')) {
      log('Adding yjs_update column to canvases table')
      sqlite.exec('ALTER TABLE canvases ADD COLUMN yjs_update TEXT')
      log('yjs_update column added successfully')
    }

    log('Migrations completed successfully')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logError('Error running migrations', message)
    throw error
  }
}

// Export main migration function for direct use
export function runMigration() {
  // Initialize better-sqlite3
  log('Running manual migration...')
  try {
    // Ensure parent directory exists before opening the database file
    const dbDir = path.dirname(dbPath)
    fs.mkdirSync(dbDir, { recursive: true })

    const sqlite = new Database(dbPath)
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')

    // Run migrations
    runMigrations(sqlite)

    sqlite.close()
    log('Migration completed successfully')
    process.exit(0)
  } catch (error) {
    logError('Migration failed', error)
    process.exit(1)
  }
}

// Only run migration directly if this file is executed as main
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigration()
}
