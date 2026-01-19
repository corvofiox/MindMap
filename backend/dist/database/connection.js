import initSqlJs from 'sql.js';
import { drizzle } from 'drizzle-orm/sql-js';
import path from 'path';
import { fileURLToPath } from 'url';
import * as schema from './schema.js';
import * as fs from 'fs/promises';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, '../../data');
try {
    await fs.mkdir(dataDir, { recursive: true });
}
catch (error) {
}
const dbPath = process.env.DB_FILE || path.join(dataDir, 'mindmap.db');
let sqlite = null;
let dbInstance = null;
export async function getSqlite() {
    if (!sqlite) {
        const SQL = await initSqlJs();
        let dbData = null;
        try {
            const dbFile = await fs.readFile(dbPath);
            dbData = new Uint8Array(dbFile);
        }
        catch (error) {
            console.log('Database file not found, creating new one:', dbPath);
            dbData = null;
        }
        sqlite = new SQL.Database(dbData);
    }
    return sqlite;
}
export async function getDb() {
    if (!dbInstance) {
        const sqlite = await getSqlite();
        dbInstance = drizzle(sqlite, { schema });
    }
    return dbInstance;
}
export const db = await getDb();
let saveTimeout = null;
let lastSaveTime = Date.now();
const SAVE_INTERVAL = 5000;
async function saveToDisk() {
    try {
        const sqlite = await getSqlite();
        const data = sqlite.export();
        const buffer = Buffer.from(data);
        await fs.writeFile(dbPath, buffer);
        lastSaveTime = Date.now();
    }
    catch (error) {
        console.error('Failed to save database:', error);
    }
}
export function scheduleSave() {
    if (saveTimeout) {
        clearTimeout(saveTimeout);
    }
    const elapsed = Date.now() - lastSaveTime;
    const delay = Math.max(0, SAVE_INTERVAL - elapsed);
    saveTimeout = setTimeout(() => {
        saveToDisk();
        saveTimeout = null;
    }, delay || 100);
}
async function gracefulShutdown() {
    if (saveTimeout) {
        clearTimeout(saveTimeout);
        saveTimeout = null;
    }
    await saveToDisk();
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('beforeExit', gracefulShutdown);
