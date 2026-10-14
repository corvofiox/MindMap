/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Migration tests for the AI-assistant removal.
 *
 * Two things must hold on an existing database, and both are destructive or
 * silently-skippable, so they are asserted rather than assumed:
 *
 *   1. The legacy `ai_conversations` / `ai_provider_keys` tables are dropped,
 *      taking any stored chat history and encrypted provider keys with them.
 *   2. The FK-cascade migration still runs. It used to be gated on
 *      `ai_conversations` existing; once that table is dropped the gate would
 *      never be satisfied, silently skipping cascade fixes for every *other*
 *      table. The gate now tests `project_members`, and this test pins that.
 *
 * Each test starts from a database that `runMigrations` has already fully built,
 * then mutates it into the legacy shape being tested — because `runMigrations`
 * assumes the base schema exists (it ALTERs `projects`/`node_cards`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

vi.mock('../utils/logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}))

import { runMigrations } from '../database/migration.js'

function tableNames(sqlite: Database.Database): string[] {
  const rows = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as Array<{ name: string }>
  return rows.map((r) => r.name)
}

function indexNames(sqlite: Database.Database): string[] {
  const rows = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='index'")
    .all() as Array<{ name: string }>
  return rows.map((r) => r.name)
}

/** ON DELETE actions declared on a table for a given FK column. */
function onDeleteActions(
  sqlite: Database.Database,
  table: string,
  column: string,
): string[] {
  const fks = sqlite.pragma(`foreign_key_list(${table})`) as Array<{
    from: string
    on_delete: string
  }>
  return fks.filter((fk) => fk.from === column).map((fk) => fk.on_delete.toUpperCase())
}

/** Recreate the legacy AI tables exactly as the removed feature left them. */
function seedLegacyAiTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE ai_provider_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_id TEXT NOT NULL,
      api_key_encrypted TEXT NOT NULL,
      base_url TEXT,
      updated_at INTEGER
    )
  `)
  sqlite.exec(
    `CREATE UNIQUE INDEX ai_provider_keys_user_provider_idx ON ai_provider_keys (user_id, provider_id)`,
  )
  sqlite.exec(`
    CREATE TABLE ai_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canvas_id INTEGER NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      messages TEXT NOT NULL,
      context_divider_index INTEGER NOT NULL DEFAULT -1,
      updated_at INTEGER
    )
  `)
  sqlite.exec(
    `CREATE UNIQUE INDEX ai_conversations_canvas_user_idx ON ai_conversations (canvas_id, user_id)`,
  )
}

/** Create one user + one canvas so the AI rows have valid FK targets. */
function seedUserAndCanvas(sqlite: Database.Database): void {
  sqlite.exec(`INSERT INTO users (email, password) VALUES ('a@b.c', 'x')`)
  sqlite.exec(
    `INSERT INTO projects (name, owner_id, is_public, is_collaborative) VALUES ('p', 1, 0, 0)`,
  )
  sqlite.exec(`INSERT INTO canvases (name, project_id) VALUES ('c', 1)`)
}

describe('migration: AI table cleanup', () => {
  let sqlite: Database.Database

  beforeEach(async () => {
    sqlite = new Database(':memory:')
    sqlite.pragma('foreign_keys = ON')
    // Build the current schema, then the tests degrade it to the legacy shape.
    await runMigrations(sqlite)
  })

  it('drops the removed AI tables, their rows and their indexes', async () => {
    seedLegacyAiTables(sqlite)
    seedUserAndCanvas(sqlite)
    sqlite.exec(
      `INSERT INTO ai_provider_keys (user_id, provider_id, api_key_encrypted) VALUES (1, 'deepseek', 'v1:secret')`,
    )
    sqlite.exec(
      `INSERT INTO ai_conversations (canvas_id, user_id, messages) VALUES (1, 1, '[{"role":"user"}]')`,
    )

    // Precondition: the legacy state really is present.
    expect(tableNames(sqlite)).toContain('ai_conversations')
    expect(tableNames(sqlite)).toContain('ai_provider_keys')

    await runMigrations(sqlite)

    const names = tableNames(sqlite)
    expect(names).not.toContain('ai_conversations')
    expect(names).not.toContain('ai_provider_keys')

    // The indexes must be gone too, not left orphaned.
    const indexes = indexNames(sqlite)
    expect(indexes).not.toContain('ai_conversations_canvas_user_idx')
    expect(indexes).not.toContain('ai_provider_keys_user_provider_idx')
  })

  it('creates personal_access_tokens with a unique token_hash', async () => {
    expect(tableNames(sqlite)).toContain('personal_access_tokens')

    const columns = (sqlite.pragma('table_info(personal_access_tokens)') as Array<{
      name: string
    }>).map((c) => c.name)
    expect(columns).toEqual(
      expect.arrayContaining([
        'id',
        'user_id',
        'name',
        'token_hash',
        'token_prefix',
        'last_used_at',
        'expires_at',
        'created_at',
        'revoked_at',
      ]),
    )

    // The unique constraint is the guarantee that one token maps to one row.
    sqlite.exec(`INSERT INTO users (email, password) VALUES ('u@b.c', 'x')`)
    sqlite.exec(
      `INSERT INTO personal_access_tokens (user_id, name, token_hash, token_prefix) VALUES (1, 'a', 'hash-1', 'mmp_aaaa…')`,
    )
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO personal_access_tokens (user_id, name, token_hash, token_prefix) VALUES (1, 'b', 'hash-1', 'mmp_bbbb…')`,
        )
        .run(),
    ).toThrow()
  })

  it('deletes a user\u2019s tokens when the user is deleted (FK cascade)', async () => {
    sqlite.exec(`INSERT INTO users (email, password) VALUES ('u@b.c', 'x')`)
    sqlite.exec(
      `INSERT INTO personal_access_tokens (user_id, name, token_hash, token_prefix) VALUES (1, 'a', 'h1', 'mmp_a…')`,
    )
    sqlite.exec(`DELETE FROM users WHERE id = 1`)

    const remaining = sqlite
      .prepare('SELECT COUNT(*) AS n FROM personal_access_tokens')
      .get() as { n: number }
    expect(remaining.n).toBe(0)
  })

  it('is idempotent — repeated runs keep the new table and leave no AI tables', async () => {
    seedLegacyAiTables(sqlite)
    await runMigrations(sqlite)
    await runMigrations(sqlite)

    const names = tableNames(sqlite)
    expect(names).toContain('personal_access_tokens')
    expect(names).not.toContain('ai_conversations')
    expect(names).not.toContain('ai_provider_keys')
  })

  it('still applies the FK cascade migration after the AI tables are gone', async () => {
    // Degrade project_members to the pre-migration shape (NO ACTION), and make sure
    // the OLD gate sentinel (ai_conversations) is absent — which is exactly the
    // situation that used to make this migration silently skip.
    sqlite.pragma('foreign_keys = OFF')
    sqlite.exec(`
      CREATE TABLE project_members_legacy (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        role TEXT NOT NULL DEFAULT 'viewer',
        joined_at INTEGER
      )
    `)
    sqlite.exec(`DROP TABLE project_members`)
    sqlite.exec(`ALTER TABLE project_members_legacy RENAME TO project_members`)
    sqlite.pragma('foreign_keys = ON')

    // Preconditions for the regression: no cascade, and no ai_conversations gate.
    expect(onDeleteActions(sqlite, 'project_members', 'project_id')).not.toContain('CASCADE')
    expect(tableNames(sqlite)).not.toContain('ai_conversations')

    await runMigrations(sqlite)

    // The cascade migration must still have fired.
    expect(onDeleteActions(sqlite, 'project_members', 'project_id')).toContain('CASCADE')
    expect(onDeleteActions(sqlite, 'project_members', 'user_id')).toContain('CASCADE')
  })
})
