import { db } from './connection.js';
async function check() {
    const allProjects = await db.query.projects.findMany();
    const allUsers = await db.query.users.findMany();
    return { projects: allProjects, users: allUsers };
}
check().catch(console.error);
