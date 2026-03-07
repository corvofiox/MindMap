import initSqlJs from 'sql.js'
import * as fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const dbPath = path.join(__dirname, 'data', 'mindmap.db')

async function checkData() {
  const SQL = await initSqlJs()
  const dbFile = fs.readFileSync(dbPath)
  const db = new SQL.Database(new Uint8Array(dbFile))

  console.log('=== project_members ===')
  const members = db.exec('SELECT * FROM project_members')
  console.log(members[0]?.values || 'No data')

  console.log('\n=== project_invitations ===')
  const invitations = db.exec('SELECT * FROM project_invitations')
  console.log(invitations[0]?.values || 'No data')

  console.log('\n=== users ===')
  const users = db.exec('SELECT id, email, nickname FROM users')
  console.log(users[0]?.values || 'No data')

  console.log('\n=== projects ===')
  const projects = db.exec('SELECT id, name, owner_id FROM projects')
  console.log(projects[0]?.values || 'No data')

  db.close()
}

checkData()
