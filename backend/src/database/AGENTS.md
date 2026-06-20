# 数据库知识库

**父级**: Backend AGENTS.md
**评分**: 8（独立域）

## 概述

Drizzle ORM + better-sqlite3（SQLite 文件数据库），包含 Schema 定义、连接管理、迁移脚本。

数据直接写入 `backend/data/mindmap.db`，默认启用 WAL（Write-Ahead Logging）和外键约束；进程重启或异常退出后数据仍然保留，无需手动 flush。

## 文件列表

| 文件 | 行数 | 功能 |
|------|------|------|
| schema.ts | ~400 | Drizzle ORM 表定义 |
| connection.ts | ~120 | better-sqlite3 连接 + WAL + 优雅关闭 |
| migration.ts | ~390 | 迁移脚本（创建表、node_cards 迁移、yjs_update 列等） |
| init.ts | ~50 | 数据库初始化入口 |
| migrate-to-yjs.ts | ~150 | 将旧版 JSON snapshot 迁移为 Yjs binary update |

## 数据库技术栈

**Drizzle ORM 0.30.x + better-sqlite3**：
- better-sqlite3：原生 SQLite 绑定，文件级持久化，同步 API
- Drizzle：类型安全的 SQL 查询构建器

**为什么用 better-sqlite3？**
- 写入即时落盘，避免进程重启导致数据丢失
- WAL 模式提升并发写入性能与崩溃安全性
- 与 Drizzle ORM 的 better-sqlite3 驱动原生集成

## Schema 定义（schema.ts）

**核心表**（11+ 个）使用 `sqliteTable`：

```typescript
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  password: text('password').notNull(),
  nickname: text('nickname'),
  avatar: text('avatar'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})
```

时间戳统一使用 Unix 秒整数（`integer`），查询/返回时通过 `transformResponse` 转换为 ISO 字符串。

## 数据库连接（connection.ts）

**连接模式**:

```typescript
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'

let sqlite: Database.Database | null = null
let dbInstance: BetterSQLite3Database<typeof schema> | null = null

export function getSqlite(): Database.Database {
  if (sqlite) return sqlite

  const dbPath = process.env.DB_FILE
    ? path.resolve(process.env.DB_FILE)
    : path.join(__dirname, '../../data/mindmap.db')

  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  return sqlite
}

export function getDb() {
  if (!dbInstance) {
    dbInstance = drizzle(getSqlite(), { schema })
  }
  return dbInstance
}
```

**导出的全局实例**:

```typescript
export let db!: BetterSQLite3Database<typeof schema>

export function initializeDb() {
  db = getDb()
}
```

控制器直接 import `{ db }` 使用；测试通过 vi.mock 替换该对象。

**优雅关闭**:

```typescript
export function registerShutdownHandlers() {
  process.on('SIGINT', () => gracefulShutdownAndExit(0))
  process.on('SIGTERM', () => gracefulShutdownAndExit(0))
  // ...
}
```

关闭时会 flush 画布 Yjs 状态，然后关闭 better-sqlite3 连接。

## 迁移脚本（migration.ts）

`runMigrations(sqlite)` 是幂等的，首次启动创建所有表；后续启动会：
1. 跳过已存在的表
2. 将旧 `node_cards`/`node_pool_folders` 的 `project_id` 迁移为 `user_id`
3. 为 `canvases` 表添加 `yjs_update` 列（如果缺失）

## 数据库初始化（init.ts）

```typescript
export async function initDatabase() {
  const sqlite = getSqlite()
  await runMigrations(sqlite)
}
```

由 `start.js` 和 `backend/src/index.ts` 调用。

## 独特约定

### Drizzle 查询模式

```typescript
import { eq, and, like } from 'drizzle-orm'

// 查询单个
const user = db.select().from(users).where(eq(users.id, userId)).get()

// 查询多个
const projectList = db.select().from(projects).where(eq(projects.ownerId, userId)).all()

// 复杂查询
const results = db
  .select()
  .from(canvases)
  .where(and(eq(canvases.projectId, projectId), like(canvases.name, `%${search}%`)))
  .all()
```

better-sqlite3 + Drizzle 查询是同步的，不需要 `await`。

### 插入 / 更新 / 删除

```typescript
// 插入单条
const [created] = db.insert(users).values({ email, password, nickname }).returning().all()

// 更新
db.update(canvases).set({ name: '新名称', updatedAt: now }).where(eq(canvases.id, canvasId)).run()

// 删除
db.delete(users).where(eq(users.id, userId)).run()
```

## 反模式（禁止）

- ❌ 使用 `any` 类型
- ❌ 生产代码中使用 `console.log`
- ❌ 直接操作 `sqlite` 实例而不经过 Drizzle（迁移脚本除外）
- ❌ 在模块加载时执行文件系统或网络副作用

## 已知问题

### 高优先级
1. **Drizzle 命名不一致** - Schema 使用 snake_case，TypeScript 字段使用 camelCase，需通过 `transformResponse` 转换

### 中优先级
1. **JSON.parse 无保护** - 多处存在解析风险
2. **非空断言 `!`** - 部分代码使用 `value!` 而非显式空值检查

## 开发命令

```bash
# 生成迁移
cd backend && npm run db:generate

# 推送 schema
cd backend && npm run db:push

# 打开 Drizzle Studio
cd backend && npm run db:studio

# 清理数据库文件（含 WAL）
cd backend && npm run db:clean
```

## 关键依赖

- Drizzle ORM 0.30.x - ORM
- better-sqlite3 - SQLite 文件数据库（WAL 模式）
- Drizzle Kit 0.31.x - 迁移工具
