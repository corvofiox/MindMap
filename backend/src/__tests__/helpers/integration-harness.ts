/**
 * Shared harness for backend integration tests.
 *
 * Why this exists: several controller "tests" used to define their own inline
 * Express routes and assert on unawaited supertest objects, so they passed even
 * when the real controller was broken (a mutation making the canvas list route
 * always return 500 still left all 25 tests green). Real coverage requires the
 * actual router mounted on a real app, backed by a real (in-memory) database.
 *
 * Each test file still needs its own `vi.mock('../database/connection.js', ...)`
 * block: `vi.mock` factories are hoisted above imports, so they cannot reference
 * values imported from here. The boilerplate is deliberately kept tiny — call
 * `installDbMock()` inside the factory.
 */
import express, { type RequestHandler } from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../database/schema.js'
import { runMigrations } from '../../database/migration.js'

/** Set JWT env before importing anything that reads it at module scope. */
export function setTestEnv(): void {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'integration-test-jwt-secret'
  process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h'
  process.env.PORT = process.env.PORT || '3097'
  process.env.WS_PORT = process.env.WS_PORT || '3197'
  process.env.DB_FILE = ':memory:'
  process.env.ALLOWED_ORIGINS = 'http://localhost:5173'
}

/**
 * Mutable DB holder shared with the hoisted `vi.mock` factory.
 *
 * The factory returns a module whose `db` property is an accessor onto this
 * holder, so a test can swap in a fresh in-memory database per case while the
 * controllers keep their live ESM binding to `db`.
 */
const holder: { db: BetterSQLite3Database<typeof schema> | null } = { db: null }

export function setTestDb(db: BetterSQLite3Database<typeof schema>): void {
  holder.db = db
}

/**
 * Body of the `vi.mock('../database/connection.js', ...)` factory.
 * Return this object from the factory.
 */
export function installDbMock(): Record<string, unknown> {
  const mod: Record<string, unknown> = {
    getSqlite: () => null,
    getDb: () => holder.db,
    initializeDb: () => undefined,
    registerShutdownHandlers: () => undefined,
  }
  Object.defineProperty(mod, 'db', {
    get: () => holder.db,
    enumerable: true,
    configurable: true,
  })
  return mod
}

export interface TestDatabase {
  raw: Database.Database
  db: BetterSQLite3Database<typeof schema>
}

/** Fresh in-memory SQLite with the full migrated schema. */
export function createTestDatabase(): TestDatabase {
  const raw = new Database(':memory:')
  raw.pragma('foreign_keys = ON')
  runMigrations(raw)
  const db = drizzle(raw, { schema })
  setTestDb(db)
  return { raw, db }
}

/**
 * Express app with the given router mounted, plus a JSON error handler.
 *
 * The error handler matters: `asyncHandler` forwards rejections to Express, and
 * without a handler the response is an empty 500 that hides the real failure.
 * It mirrors the production error middleware's `{ success, error }` shape.
 */
export function buildApp(mountPath: string, router: RequestHandler): express.Express {
  const app = express()
  app.use(cookieParser())
  app.use(express.json({ limit: '50mb' }))
  app.use(mountPath, router)
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const e = err as { statusCode?: number; status?: number; message?: string }
    res.status(e.statusCode || e.status || 500).json({
      success: false,
      error: e.message || 'Internal server error',
    })
  })
  return app
}

export function signToken(userId: number, expiresIn = '1h'): string {
  return jwt.sign({ userId }, process.env.JWT_SECRET as string, { expiresIn })
}

/** Insert a user and return its id. */
export function seedUser(
  raw: Database.Database,
  email: string,
  passwordHash = 'hash',
  nickname: string | null = null,
): number {
  const now = Math.floor(Date.now() / 1000)
  return Number(
    raw
      .prepare(
        'INSERT INTO users (email, password, nickname, created_at, updated_at) VALUES (?,?,?,?,?)',
      )
      .run(email, passwordHash, nickname, now, now).lastInsertRowid,
  )
}

/** Insert a project and return its id. */
export function seedProject(
  raw: Database.Database,
  ownerId: number,
  name = 'Project',
  opts: { isPublic?: boolean; isCollaborative?: boolean } = {},
): number {
  const now = Math.floor(Date.now() / 1000)
  return Number(
    raw
      .prepare(
        'INSERT INTO projects (name, owner_id, is_public, is_collaborative, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      )
      .run(name, ownerId, opts.isPublic ? 1 : 0, opts.isCollaborative ? 1 : 0, now, now)
      .lastInsertRowid,
  )
}

/** Insert a canvas and return its id. */
export function seedCanvas(
  raw: Database.Database,
  projectId: number,
  name = 'Canvas',
  opts: { folderId?: number | null; yjsUpdate?: string | null } = {},
): number {
  const now = Math.floor(Date.now() / 1000)
  return Number(
    raw
      .prepare(
        'INSERT INTO canvases (name, project_id, folder_id, yjs_update, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(name, projectId, opts.folderId ?? null, opts.yjsUpdate ?? null, 0, now, now)
      .lastInsertRowid,
  )
}

/** Insert a project member and return its id. */
export function seedMember(
  raw: Database.Database,
  projectId: number,
  userId: number,
  role = 'editor',
): number {
  const now = Math.floor(Date.now() / 1000)
  return Number(
    raw
      .prepare(
        'INSERT INTO project_members (project_id, user_id, role, joined_at) VALUES (?,?,?,?)',
      )
      .run(projectId, userId, role, now).lastInsertRowid,
  )
}

/** Insert a folder and return its id. */
export function seedFolder(
  raw: Database.Database,
  projectId: number,
  name = 'Folder',
  parentId: number | null = null,
): number {
  const now = Math.floor(Date.now() / 1000)
  return Number(
    raw
      .prepare(
        'INSERT INTO folders (name, project_id, parent_id, sort_order, created_at) VALUES (?,?,?,?,?)',
      )
      .run(name, projectId, parentId, 0, now).lastInsertRowid,
  )
}

/** Count rows matching a simple WHERE clause. */
export function countRows(
  raw: Database.Database,
  table: string,
  where = '1=1',
  ...params: unknown[]
): number {
  return (
    raw.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`).get(...params) as {
      c: number
    }
  ).c
}

/** Read one column of one row, or undefined. */
export function readColumn<T = unknown>(
  raw: Database.Database,
  sql: string,
  ...params: unknown[]
): T | undefined {
  const row = raw.prepare(sql).get(...params) as Record<string, unknown> | undefined
  if (!row) return undefined
  return Object.values(row)[0] as T
}

/** Standard auth header for a user id. */
export function authHeader(userId: number): Record<string, string> {
  return { Authorization: `Bearer ${signToken(userId)}` }
}
