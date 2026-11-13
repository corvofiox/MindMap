/**
 * 老库自动升级：`runMigrations` 必须能把**生产上已有的数据库**原地升到当前结构，
 * 不丢数据、不需要人工干预。
 *
 * 这一轮的唯一结构变更是「手稿加 sort_order（拖拽排序用）」。老库没有这一列，
 * 升级必须做到：
 *   1. 补上这一列（NOT NULL DEFAULT 0，老数据自动填 0）；
 *   2. 已有的手稿、文件夹、卡片一条不丢，内容不被改动；
 *   3. 升级后写入/排序照常工作；
 *   4. 重复运行是幂等的（服务重启会再跑一次迁移）。
 *
 * 做法与既有迁移测试一致：先用 runMigrations 建出当前库，再把它**降级**成老结构
 * （重建 manuscripts 表、去掉 sort_order），然后跑一次迁移看是否自动补齐。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../database/migration.js'

function tableNames(sqlite: Database.Database): string[] {
  return (sqlite.pragma('table_list') as Array<{ name: string }>).map((row) => row.name)
}

function columnsOf(sqlite: Database.Database, table: string): string[] {
  return (sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name)
}

/** 播种：一个账号、一个手稿文件夹、两篇手稿、一张节点池卡片 */
function seed(sqlite: Database.Database): void {
  sqlite.exec(`INSERT INTO users (email, password) VALUES ('legacy@old.db', 'x')`)
  sqlite.exec(`INSERT INTO manuscript_folders (user_id, name) VALUES (1, '旧文件夹')`)
  sqlite.exec(
    `INSERT INTO manuscripts (user_id, folder_id, title, content_html, preview_text, image_count)
     VALUES (1, 1, '旧稿一', '<p>正文一</p>', '正文一', 0)`,
  )
  sqlite.exec(
    `INSERT INTO manuscripts (user_id, folder_id, title, content_html, preview_text, image_count, deleted_at)
     VALUES (1, NULL, '旧稿二（已删）', '<p>正文二</p>', '正文二', 1, 1700000000)`,
  )
  sqlite.exec(
    `INSERT INTO node_cards (user_id, name, content) VALUES (1, '旧卡片', '{"title":"旧卡片","content":"<p>x</p>"}')`,
  )
}

/**
 * 把 manuscripts 表降级成"没有 sort_order"的老结构。
 *
 * 必须重建表（SQLite 不支持 DROP COLUMN 的旧版本兼容写法），并且沿用
 * 生产老库的真实列集。
 */
function degradeManuscriptsToLegacy(sqlite: Database.Database): void {
  sqlite.exec('PRAGMA foreign_keys = OFF')
  sqlite.exec(`
    CREATE TABLE manuscripts_legacy (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      folder_id INTEGER REFERENCES manuscript_folders(id) ON DELETE SET NULL,
      title TEXT NOT NULL DEFAULT '',
      content_html TEXT NOT NULL DEFAULT '',
      preview_text TEXT,
      image_count INTEGER NOT NULL DEFAULT 0,
      source_card_id INTEGER,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      updated_at INTEGER DEFAULT (strftime('%s', 'now')),
      deleted_at INTEGER
    )
  `)
  sqlite.exec(`
    INSERT INTO manuscripts_legacy
      (id, user_id, folder_id, title, content_html, preview_text, image_count,
       source_card_id, created_at, updated_at, deleted_at)
    SELECT
       id, user_id, folder_id, title, content_html, preview_text, image_count,
       source_card_id, created_at, updated_at, deleted_at
    FROM manuscripts
  `)
  sqlite.exec('DROP TABLE manuscripts')
  sqlite.exec('ALTER TABLE manuscripts_legacy RENAME TO manuscripts')
  sqlite.exec('PRAGMA foreign_keys = ON')
}

const readManuscripts = (sqlite: Database.Database) =>
  sqlite
    .prepare('SELECT id, title, content_html, folder_id, deleted_at FROM manuscripts ORDER BY id')
    .all() as Array<{
    id: number
    title: string
    content_html: string
    folder_id: number | null
    deleted_at: number | null
  }>

describe('老库自动升级：手稿加 sort_order', () => {
  let sqlite: Database.Database

  beforeEach(async () => {
    sqlite = new Database(':memory:')
    sqlite.pragma('foreign_keys = ON')
    await runMigrations(sqlite)
  })

  it('老库确实没有 sort_order（前置条件，否则这条测试没意义）', async () => {
    seed(sqlite)
    degradeManuscriptsToLegacy(sqlite)

    expect(columnsOf(sqlite, 'manuscripts')).not.toContain('sort_order')
    // 数据在
    expect(readManuscripts(sqlite)).toHaveLength(2)

    // 迁移必须能把它补回来
    await runMigrations(sqlite)
    expect(columnsOf(sqlite, 'manuscripts')).toContain('sort_order')
  })

  it('升级后老数据一条不丢、内容原样，sort_order 默认 0', async () => {
    seed(sqlite)
    const before = readManuscripts(sqlite)
    degradeManuscriptsToLegacy(sqlite)

    await runMigrations(sqlite)

    const after = readManuscripts(sqlite)
    expect(after).toHaveLength(before.length)
    // 逐条比对：id / 标题 / 正文 / 归属 / 软删除时间都不能变
    for (let i = 0; i < before.length; i += 1) {
      expect(after[i]).toMatchObject(before[i])
    }
    // 新列有默认值
    const orders = sqlite.prepare('SELECT sort_order FROM manuscripts').all() as Array<{
      sort_order: number
    }>
    expect(orders.every((row) => row.sort_order === 0)).toBe(true)
  })

  it('升级后其余表（目录、文件夹、卡片）不受影响', async () => {
    seed(sqlite)
    degradeManuscriptsToLegacy(sqlite)
    const beforeFolders = sqlite.prepare('SELECT * FROM manuscript_folders').all()
    const beforeCards = sqlite.prepare('SELECT * FROM node_cards').all()

    await runMigrations(sqlite)

    expect(sqlite.prepare('SELECT * FROM manuscript_folders').all()).toEqual(beforeFolders)
    expect(sqlite.prepare('SELECT * FROM node_cards').all()).toEqual(beforeCards)
  })

  it('升级后能直接按 sort_order 排序与写入（功能真的可用）', async () => {
    seed(sqlite)
    degradeManuscriptsToLegacy(sqlite)
    await runMigrations(sqlite)

    // 老库里 id=2 是软删除的那篇，这里只关心"未删除的能按新列排序"，
    // 所以先补一篇未删除的稿子当第二个排序对象
    sqlite.exec(`INSERT INTO manuscripts (user_id, title, content_html) VALUES (1, '旧稿三', '<p>三</p>')`)

    sqlite.exec(`UPDATE manuscripts SET sort_order = 20 WHERE id = 1`)
    sqlite.exec(`UPDATE manuscripts SET sort_order = 5 WHERE id = 3`)

    const ordered = sqlite
      .prepare(
        `SELECT id FROM manuscripts WHERE deleted_at IS NULL
         ORDER BY sort_order ASC, updated_at DESC`,
      )
      .all() as Array<{ id: number }>
    expect(ordered.map((row) => row.id)).toEqual([3, 1])

    // 软删除的那篇不受排序影响，仍然被排除
    expect(ordered.map((row) => row.id)).not.toContain(2)
  })

  it('迁移可重复执行（服务重启会再跑一次），结果不变', async () => {
    seed(sqlite)
    degradeManuscriptsToLegacy(sqlite)

    await runMigrations(sqlite)
    const first = readManuscripts(sqlite)

    await runMigrations(sqlite)
    await runMigrations(sqlite)

    expect(readManuscripts(sqlite)).toEqual(first)
    // 列不会重复添加
    const sortOrderColumns = columnsOf(sqlite, 'manuscripts').filter((c) => c === 'sort_order')
    expect(sortOrderColumns).toHaveLength(1)
  })

  it('全新库直接建表就带 sort_order（不走补列分支）', async () => {
    expect(columnsOf(sqlite, 'manuscripts')).toContain('sort_order')

    sqlite.exec(`INSERT INTO users (email, password) VALUES ('new@db', 'x')`)
    sqlite.exec(`INSERT INTO manuscripts (user_id, title) VALUES (1, '新稿')`)
    const row = sqlite.prepare('SELECT sort_order FROM manuscripts').get() as { sort_order: number }
    expect(row.sort_order).toBe(0)
  })

  it('表不存在时不因补列逻辑报错（首次建库的路径）', async () => {
    const fresh = new Database(':memory:')
    fresh.pragma('foreign_keys = ON')
    // 空库：manuscripts 由 runMigrations 自己建，补列逻辑不能先炸
    await expect(runMigrations(fresh)).resolves.not.toThrow()
    expect(tableNames(fresh)).toContain('manuscripts')
    expect(columnsOf(fresh, 'manuscripts')).toContain('sort_order')
    fresh.close()
  })
})

/**
 * 更极端的升级场景：库里有 users（所以"不是全新库"），但还没有后面才加的表。
 *
 * 回归背景：建表块原先只看 `users` 在不在。老库只要已经有 users，
 * 整块建表被跳过，紧接着的 `ALTER TABLE node_cards` 就抛
 * "no such table: node_cards"，升级直接失败——这是真实会遇到的
 * （任何"早期版本建的库"都长这样）。
 */
describe('老库自动升级：早于 node_cards / manuscripts 的库', () => {
  /** 造一个"最老"的库：只有 users / projects / canvases 三张表 */
  function makeAncientDatabase(): Database.Database {
    const sqlite = new Database(':memory:')
    sqlite.pragma('foreign_keys = ON')
    sqlite.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        nickname TEXT,
        avatar TEXT,
        created_at INTEGER DEFAULT (strftime('%s','now')),
        updated_at INTEGER DEFAULT (strftime('%s','now'))
      );
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        owner_id INTEGER NOT NULL REFERENCES users(id),
        group_id INTEGER,
        thumbnail TEXT,
        is_public INTEGER DEFAULT 0,
        is_collaborative INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (strftime('%s','now')),
        updated_at INTEGER DEFAULT (strftime('%s','now'))
      );
      CREATE TABLE canvases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        folder_id INTEGER,
        thumbnail TEXT,
        sort_order INTEGER DEFAULT 0 NOT NULL,
        yjs_data TEXT,
        yjs_update TEXT,
        created_at INTEGER DEFAULT (strftime('%s','now')),
        updated_at INTEGER DEFAULT (strftime('%s','now'))
      );
    `)
    sqlite.exec(`INSERT INTO users (email, password, nickname) VALUES ('ancient@old.db', 'x', '远古用户')`)
    sqlite.exec(`INSERT INTO projects (name, owner_id) VALUES ('远古项目', 1)`)
    sqlite.exec(`INSERT INTO canvases (name, project_id) VALUES ('远古画布', 1)`)
    return sqlite
  }

  it('有 users 但缺后续表时，迁移不报错并补齐所有表', async () => {
    const sqlite = makeAncientDatabase()
    expect(tableNames(sqlite)).not.toContain('node_cards')
    expect(tableNames(sqlite)).not.toContain('manuscripts')

    await expect(runMigrations(sqlite)).resolves.not.toThrow()

    const names = tableNames(sqlite)
    // 后来才加的表都要补上
    expect(names).toContain('node_cards')
    expect(names).toContain('node_pool_folders')
    expect(names).toContain('manuscripts')
    expect(names).toContain('manuscript_folders')
    expect(names).toContain('personal_access_tokens')
    // 新加的列也在
    expect(columnsOf(sqlite, 'manuscripts')).toContain('sort_order')
    sqlite.close()
  })

  it('升级不会覆盖老库已有的数据（users / projects / canvases 原样保留）', async () => {
    const sqlite = makeAncientDatabase()
    const before = {
      users: sqlite.prepare('SELECT * FROM users').all(),
      projects: sqlite.prepare('SELECT * FROM projects').all(),
      canvases: sqlite.prepare('SELECT * FROM canvases').all(),
    }

    await runMigrations(sqlite)

    expect(sqlite.prepare('SELECT * FROM users').all()).toEqual(before.users)
    expect(sqlite.prepare('SELECT * FROM projects').all()).toEqual(before.projects)
    // canvases 会被后续迁移补列，只比较原始字段
    const canvasesAfter = sqlite.prepare('SELECT id, name, project_id FROM canvases').all()
    expect(canvasesAfter).toEqual(
      before.canvases.map((row) => {
        const { id, name, project_id } = row as Record<string, unknown>
        return { id, name, project_id }
      }),
    )
    sqlite.close()
  })

  it('从远古库升级两次也稳定（幂等）', async () => {
    const sqlite = makeAncientDatabase()

    await runMigrations(sqlite)
    const snapshot = {
      tables: tableNames(sqlite).sort(),
      manuscriptCols: columnsOf(sqlite, 'manuscripts'),
      nodeCardCols: columnsOf(sqlite, 'node_cards'),
      users: sqlite.prepare('SELECT * FROM users').all(),
    }

    await runMigrations(sqlite)

    expect(tableNames(sqlite).sort()).toEqual(snapshot.tables)
    expect(columnsOf(sqlite, 'manuscripts')).toEqual(snapshot.manuscriptCols)
    expect(columnsOf(sqlite, 'node_cards')).toEqual(snapshot.nodeCardCols)
    expect(sqlite.prepare('SELECT * FROM users').all()).toEqual(snapshot.users)
    sqlite.close()
  })
})
