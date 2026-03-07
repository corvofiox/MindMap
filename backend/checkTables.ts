import initSqlJs from 'sql.js'
import * as fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const dbPath = path.join(__dirname, 'data', 'mindmap.db')

async function checkTables() {
  const SQL = await initSqlJs()
  const dbFile = fs.readFileSync(dbPath)
  const db = new SQL.Database(new Uint8Array(dbFile))
  
  const result = db.exec("SELECT name FROM sqlite_master WHERE type='table'")
  console.log('Tables:', result[0]?.values)
  
  db.close()
}

checkTables()
