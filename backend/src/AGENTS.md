# Backend 源码知识库

**父级**: 根 AGENTS.md
**评分**: 18（高复杂度）

## 概述
Express 4 + TypeScript + SQLite (better-sqlite3) REST API + Yjs CRDT WebSocket 服务器

## 目录结构

```
src/
├── controllers/       # API 路由控制器（7 文件）
├── database/         # Drizzle ORM + SQLite（5 文件）
├── middleware/       # Express 中间件（4 文件）
├── websocket/        # Yjs CRDT provider (sync/awareness) + canvas-state doc 管理
├── utils/            # 工具函数（3 文件）
├── __tests__/        # 单元测试
└── index.ts         # 应用入口
```

## 快速定位

| 任务 | 位置 | 说明 |
|------|------|------|
| 应用入口 | `index.ts` | Express + WebSocket 启动 |
| 数据库 Schema | `database/schema.ts` | Drizzle ORM 表定义 |
| 数据库连接 | `database/connection.ts` | better-sqlite3 文件数据库 |
| WebSocket 服务 | `websocket/index.ts` | Yjs CRDT 自研 provider（鉴权/房间/心跳/踢人 + sync 协议）|
| 认证中间件 | `middleware/auth.middleware.ts` | JWT 验证 |
| CORS 中间件 | `middleware/cors.middleware.ts` | 动态 CORS |

## 数据库架构

**使用 Drizzle ORM 0.30.x + better-sqlite3**（文件数据库，WAL 模式，写入即时落盘）

**核心表**（`database/schema.ts`）:
- `users` - 用户信息
- `groups` - 群组信息
- `projects` - 项目信息
- `canvases` - 画布数据（`yjs_update` 列存 Yjs 二进制 base64；`yjs_data` 列为 legacy JSON 备份）
- `folders` - 文件夹
- `node_cards` - 节点卡片
- `files` - 上传文件

**数据连接**（`database/connection.ts`）:
```typescript
// better-sqlite3 文件数据库实例
let sqlite: Database.Database | null = null
let dbInstance: AppDatabase | null = null

// 初始化数据库连接（WAL + 外键约束）
export function getSqlite(): Database.Database {
  if (sqlite) return sqlite
  sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  return sqlite
}
```

## 中间件栈

**执行顺序**（`index.ts`）:
1. `cors.middleware.ts` - 动态 CORS（ALLOWED_ORIGINS 环境变量）
2. `express.json()` - JSON 解析
3. `csrf.middleware.ts` - CSRF 保护（双重 cookie 模式）
4. `rateLimit.middleware.ts` - 速率限制（100 req/15min）
5. `auth.middleware.ts` - JWT 认证（可选）
6. `error.middleware.ts` - 全局错误处理

## WebSocket 协议

**Yjs CRDT 自研 provider**（复用现有 wsServer 的鉴权/房间/心跳/踢人基础设施）

**消息分两通道**:
- 二进制帧：Yjs sync 协议（`[varUint messageType, payload]`，messageType 0=SYNC、1=AWARENESS）
- 文本帧（JSON）：业务消息（`cursor`、`ping`/`pong`、`kicked`、`user-join`/`user-leave`、`room-state`、`user-role-changed`）

**特性**:
- 房间管理（每个 canvas 一个房间 + 共享 Awareness）
- JWT 认证（query string `token`）
- 速率限制（100 连接/分钟/IP）
- Yjs state vector 同步（STEP1/STEP2 握手）
- viewer 角色拦截 STEP2 写操作
- 双通道心跳（ws ping/pong + 应用层 ping/pong，120s 超时）
- 优雅关闭时 flush 画布状态到数据库

## API 控制器

**路由结构**（`controllers/`）:

| 控制器 | 路径前缀 | 功能 |
|---------|-----------|------|
| auth.controller.ts | `/api/auth` | 注册、登录、登出 |
| user.controller.ts | `/api/users` | 用户资料、密码修改 |
| project.controller.ts | `/api/projects` | 项目 CRUD、成员管理 |
| canvas.controller.ts | `/api/canvases` | 画布 CRUD、Yjs 数据 |
| upload.controller.ts | `/api/upload` | 文件上传（multer）|

**响应格式**:
```typescript
// 成功
{ success: true, data: { ... } }

// 失败
{ success: false, error: "错误消息" }
```

## 独特约定

### 模块导入（ESM）
```typescript
// 所有导入必须使用 .js 扩展名
import { Router } from 'express'
import { users } from '../database/schema.js'
```

### 错误处理
```typescript
// 使用 asyncHandler 包装
router.post('/login', asyncHandler(async (req, res) => {
  try {
    // 业务逻辑
  } catch (error) {
    throw error  // 由 error.middleware.ts 处理
  }
}))
```

### 验证中间件
```typescript
// Zod schema 验证
router.post('/create',
  validateBody(createProjectSchema),
  authMiddleware,
  asyncHandler(async (req, res) => { ... })
)
```

## 反模式（禁止）

- ❌ 禁止使用 `any` 类型
- ❌ 禁止 `parseInt()` 无验证（当前 `controllers/canvas.controller.ts` 存在此问题）
- ❌ 禁止 `console.log` 泄漏到生产（当前 27+ 处）
- ❌ 禁止 `throw error` 而不加上下文（当前 8+ 处）
- ❌ 禁止 JSON.parse 无 try-catch（当前多处存在）

## 已知问题

### 高优先级
1. **Drizzle 命名不一致** - Schema snake_case，TypeScript camelCase
2. **WebSocket 错误静默** - `websocket/index.ts` 错误被吞噬
3. **parseInt 无验证** - `controllers/canvas.controller.ts` canvasId 可能为 NaN

### 中优先级
1. **console.log 泄漏** - 27+ 处生产代码日志
2. **JSON.parse 无保护** - 多处解析风险
3. **错误处理无上下文** - 8+ 处直接 throw error

## 开发命令

```bash
# 开发服务器（热重载）
npm run dev              # tsx watch 模式

# 构建
npm run build            # tsc 编译到 dist/

# 启动生产服务器
npm run start            # node dist/index.js

# 数据库操作
npm run db:generate      # 生成迁移
npm run db:push          # 推送 schema
npm run db:studio        # 打开 Drizzle Studio
npm run db:migrate       # 运行迁移
npm run db:clean         # 删除数据库文件

# 测试
npm run test             # Vitest（Node 环境）
npm run test:coverage    # 覆盖率报告

# 代码检查
npm run lint            # ESLint
```

## 关键依赖

- Express 4.18.2 - Web 框架
- Drizzle ORM 0.30.1 - ORM
- better-sqlite3 - SQLite（文件数据库 + WAL）
- ws 8.x - WebSocket 原生实现（承载 Yjs sync 协议二进制帧 + 业务 JSON 文本帧）
- yjs 13.x + lib0 + y-protocols - CRDT 协作核心（doc 管理 / sync / awareness）
- bcrypt 6.x - 密码加密
- JWT 9.x - Token 认证
- Zod - Schema 验证
- multer - 文件上传
- csurf - CSRF 保护
- express-rate-limit - 速率限制

## 环境变量

**必需**（`start.js` 自动生成）:
```
PORT=3000
WS_PORT=3001
JWT_SECRET=<自动生成>
CSRF_SECRET=<自动生成>
DB_FILE=./data/mindmap.db

ALLOWED_ORIGINS=http://localhost:5173,http://localhost:8001
UPLOAD_DIR=./uploads
MAX_FILE_SIZE=5242880
```
