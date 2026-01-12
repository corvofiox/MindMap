import initSqlJs from 'sql.js'
import { drizzle } from 'drizzle-orm/sql-js'
import path from 'path'
import { fileURLToPath } from 'url'
import * as schema from './schema.js'
import { runMigrations as runMigrationsFromFile } from './migration.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Initialize database
async function initDatabase() {
  try {
    // Create data directory if it doesn't exist
    const fs = await import('fs')
    // 确保在Docker环境中使用正确的路径 - 与Dockerfile保持一致
    // 源代码位置: /app/backend/src/database/init.ts
    // 编译后位置: /app/backend/dist/database/init.js
    // 正确的数据目录: /app/backend/data
    const dataDir = process.env.DB_DIR || path.join(__dirname, '../../', 'data')
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
      console.log('Database loaded from file:', dbPath)
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        console.log('Database file not found, creating new database:', dbPath)
        dbData = null
      } else {
        throw error
      }
    }

    const sqlite = new SQL.Database(dbData)

    // Create drizzle instance
    const db = drizzle(sqlite, { schema })

    // Run migrations
    console.log('Running database migrations...')
    await runMigrationsFromFile(sqlite)

    // Save database
    console.log('Saving database...')
    const data = sqlite.export()
    const buffer = Buffer.from(data)
    await fs.promises.writeFile(dbPath, buffer)

    console.log('Database initialized successfully!')
    return db
  } catch (error) {
    console.error('Failed to initialize database:', error)
    throw error
  }
}

export { initDatabase }
