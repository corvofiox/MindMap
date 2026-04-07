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
          is_collaborative INTEGER NOT NULL DEFAULT 0,
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

      // Create node_cards table (user-specific)
      sqlite.run(`
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
      sqlite.run(`
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

    // Add is_collaborative column to projects table if it doesn't exist
    const projectsTableInfo = sqlite.exec('PRAGMA table_info(projects)')
    if (projectsTableInfo.length > 0) {
      const projectColumns = projectsTableInfo[0].values.map((row: any) => row[1])

      // Add is_collaborative column
      if (!projectColumns.includes('is_collaborative')) {
        log('Adding is_collaborative column to projects table')
        sqlite.run('ALTER TABLE projects ADD COLUMN is_collaborative INTEGER NOT NULL DEFAULT 0')
        log('is_collaborative column added successfully')
      }
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

    // Create ai_conversations table if it doesn't exist
    const aiConversationsTable = sqlite.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_conversations'")
    if (!aiConversationsTable || aiConversationsTable.length === 0 || aiConversationsTable[0].values.length === 0) {
      log('Creating ai_conversations table')
      sqlite.run(`
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
      sqlite.run(`
        CREATE UNIQUE INDEX ai_conversations_canvas_user_idx ON ai_conversations (canvas_id, user_id)
      `)
      log('ai_conversations table created successfully')
    }

    // Migrate node_cards and node_pool_folders from project_id to user_id
    const nodeCardsTableInfo = sqlite.exec('PRAGMA table_info(node_cards)')
    if (nodeCardsTableInfo.length > 0) {
      const nodeCardsColumns = nodeCardsTableInfo[0].values.map((row: any) => row[1])

      // Check if user_id column exists (new schema)
      if (!nodeCardsColumns.includes('user_id') && nodeCardsColumns.includes('project_id')) {
        log('Migrating node_cards from project_id to user_id')

        // Create new node_pool_folders table with user_id (without self-referencing FK)
        sqlite.run(`
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
        sqlite.run(`
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
        sqlite.run(`
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
        sqlite.run(`
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
        sqlite.run('DROP TABLE node_cards')
        sqlite.run('DROP TABLE node_pool_folders')

        // Rename new tables
        sqlite.run('ALTER TABLE node_cards_new RENAME TO node_cards')
        sqlite.run('ALTER TABLE node_pool_folders_new RENAME TO node_pool_folders')

        log('node_cards and node_pool_folders migrated to user_id successfully')
      }
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
  runMigration().catch((err) => logError('Migration failed', err))
}
