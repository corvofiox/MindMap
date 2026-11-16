/**
 * 老库自动升级：删掉 `node_cards.use_count`。
 *
 * 这个计数属于一个从未真正落地的模型（"一张卡片可以被反复使用，每用一次 +1"）：
 * 前端从不递增、界面从不展示、按它排序的选项也点不到；而产品语义是**搬运**
 * （卡片拖到画布就从池里消失），所以"使用次数"没有意义。列被彻底删除。
 *
 * 老库必须满足的契约：
 *   1. 启动时自动去掉这一列，不需要人工干预；
 *   2. 卡片数据（名称/正文/文件夹/来源）一条不丢；
 *   3. 重复运行幂等（服务每次启动都会跑迁移）；
 *   4. 新库从建立时就没有这一列。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '../database/migration.js'

function columnsOf(sqlite: Database.Database, table: string): string[] {
  return (sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name)
}

/** 当前结构的库，再补回 use_count，模拟还没升级的老库。 */
function makeLegacyDb(): Database.Database {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  runMigrations(sqlite)

  sqlite.exec('ALTER TABLE node_cards ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0')
  sqlite.exec(`INSERT INTO users (email, password) VALUES ('legacy@old.db', 'x')`)
  sqlite.exec(`INSERT INTO node_pool_folders (user_id, name) VALUES (1, '旧文件夹')`)
  sqlite.exec(
    `INSERT INTO node_cards (user_id, name, content, type, color, tags, use_count, created_by, folder_id, sort_order)
     VALUES (1, '旧卡片', '{"title":"旧卡片","content":"<p>正文</p>"}', 'text', '#ffffff', 'tag1', 7, 1, 1, 3)`,
  )
  return sqlite
}

describe('migration: node_cards.use_count 下线', () => {
  it('新库从建立时就没有这一列', () => {
    const sqlite = new Database(':memory:')
    sqlite.pragma('foreign_keys = ON')
    runMigrations(sqlite)

    expect(columnsOf(sqlite, 'node_cards')).not.toContain('use_count')
    sqlite.close()
  })

  it('老库升级后这一列消失，卡片数据一条不丢', () => {
    const sqlite = makeLegacyDb()
    expect(columnsOf(sqlite, 'node_cards')).toContain('use_count')

    runMigrations(sqlite)

    expect(columnsOf(sqlite, 'node_cards')).not.toContain('use_count')
    const card = sqlite
      .prepare('SELECT id, user_id, name, content, tags, folder_id, sort_order FROM node_cards WHERE name = ?')
      .get('旧卡片') as Record<string, unknown>
    expect(card).toBeTruthy()
    expect(card.user_id).toBe(1)
    expect(card.content).toContain('正文')
    expect(card.tags).toBe('tag1')
    expect(card.folder_id).toBe(1)
    expect(card.sort_order).toBe(3)
    sqlite.close()
  })

  it('重复运行是幂等的（服务每次启动都会跑）', () => {
    const sqlite = makeLegacyDb()

    runMigrations(sqlite)
    runMigrations(sqlite)
    runMigrations(sqlite)

    expect(columnsOf(sqlite, 'node_cards')).not.toContain('use_count')
    expect(sqlite.prepare('SELECT COUNT(*) AS c FROM node_cards').get()).toEqual({ c: 1 })
    sqlite.close()
  })
})
