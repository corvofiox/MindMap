import { db } from './connection.js'
import { projects, users } from './schema.js'

async function check() {
  const allProjects = await db.query.projects.findMany()
  const allUsers = await db.query.users.findMany()

  // Return data instead of logging
  return { projects: allProjects, users: allUsers }
}

check().catch(console.error)
