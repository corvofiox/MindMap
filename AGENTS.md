# MindMap 项目指南

**最后更新**: 2026-05-23

## 概述

TypeScript monorepo (npm workspaces): React 18 + Vite + Fabric.js (前端), Express + Drizzle ORM + better-sqlite3 (后端), shared 类型包。

子目录也有更详细的 AGENTS.md: `frontend/src/AGENTS.md`, `backend/src/AGENTS.md`。

## 开发命令

```bash
# 完整启动（环境变量 + 数据库 + 前后端）
node start.js              # 同 npm run dev
npm run dev
node start.js --production # 生产模式
node start.js --start-only # 跳过环境/数据库初始化，仅启动服务器
node start.js --env-only   # 仅生成环境文件
node start.js --db-only    # 仅初始化数据库

# 仅生成环境文件（不做其他事）
npm run init:env

# 仅安装依赖
npm run install:all

# 分别启动
npm run start:backend      # cd backend && npm run start
npm run start:frontend     # cd frontend && npm run dev，端口 5173

# 构建（顺序重要: shared → frontend → backend）
npm run build              # 构建全部
npm run build:shared       # cd shared && npm run build
npm run build:frontend     # cd frontend && npm run build (tsc && vite build)
npm run build:backend      # cd backend && npm run build (tsc && tsc-alias)

# 代码检查
npm run lint               # 所有（前端允许 150 条 warning）
npm run lint:frontend -- --fix
npm run lint:backend -- --fix

# 测试
npm run test               # 所有（交互模式）
npm run test:run           # 所有（CI 模式，单次运行）
npm run test:frontend      # 前端（交互模式）
npm run test:backend       # 后端（交互模式）

# 测试 - 单个文件
cd frontend && npx vitest run src/test/basic.test.ts
cd frontend && npx vitest run src/components/canvas/__tests__/FabricCanvas.test.tsx
cd backend && npx vitest run src/__tests__/app.test.ts

# 数据库
cd backend && npm run db:generate    # 生成迁移
cd backend && npm run db:push        # 推送 schema 变更
cd backend && npm run db:studio      # 打开 Drizzle Studio
cd backend && npm run db:clean       # 删除数据库文件

# Docker
docker compose up -d        # 构建并启动（端口 9000）
```

## 关键架构事实

### monorepo 构建顺序
`shared` 必须先构建，因为前后端都依赖 `@shared/types`。根 `npm run build` 执行顺序为 `build:shared → build:frontend → build:backend`。

### 后端构建需要 tsc-alias
```bash
cd backend && npm run build    # tsc && tsc-alias
```
`tsc-alias` 将编译后 JS 中的路径别名（`@/* → ./src/*`）替换为实际相对路径。仅 tsc 是不够的。

### Fabric.js
Fabric.js 作为 npm 依赖打包进 Vite，通过 `import { fabric } from 'fabric'` 使用，构建产物包含 fabric 代码。

### 数据库：better-sqlite3 文件数据库
使用 better-sqlite3（原生 SQLite 绑定），数据直接写入 `backend/data/mindmap.db`，默认启用 WAL（Write-Ahead Logging）和外键约束。写入即时落盘，进程重启或异常退出后数据仍然保留。

### ESM 导入必须加 .js 后缀
后端所有相对导入必须在路径末尾加 `.js`：
```typescript
import { users } from '../database/schema.js'
import { asyncHandler } from '../middleware/error.middleware.js'
```
TypeScript ESM + `moduleResolution: "bundler"` 强制执行此约定。

### WebSocket：开发 vs 生产（Yjs CRDT 协作）
- **开发环境**: WebSocket 独立监听端口 3001
- **生产环境**: WebSocket 与 HTTP 共享端口 9000（路径 `/ws`）
- 实时协作基于 **Yjs CRDT**（自研 provider 复用现有 wsServer 的鉴权/房间/心跳/踢人基础设施）
- 数据流：客户端 `Y.Doc` update → 服务端 `Y.applyUpdate` → 广播给房间其他客户端；撤销重做保留 Zustand `ownCommands`（方案 B）

### CSRF 保护
- `/api/csrf-token` 是公开端点，返回 CSRF token
- `/api/auth/*` 路由免 CSRF（登录/注册需要先获取 token）
- 其他 `/api/*` 路由需要 CSRF token（`csrfProtectionMiddleware`）

### 前端 API 代理
Vite 开发时自动代理 `/api` → `http://localhost:3000`，`/ws` → `ws://localhost:3001`。

### start.js 自动初始化
`node start.js` 会自动：1) 生成 `.env` 文件（含 JWT_SECRET 和 CSRF_SECRET），2) 初始化 better-sqlite3 数据库文件，3) 启动前后端。环境文件不存在或缺少必需 key 时会自动重建。

## 代码风格

### Prettier
```json
{ "semi": false, "singleQuote": true, "tabWidth": 2, "printWidth": 100,
  "trailingComma": "es5", "arrowParens": "always", "endOfLine": "lf", "bracketSpacing": true }
```
配置文件位于 `frontend/.prettierrc.json`。

### 命名规范
- 组件/类型/接口: `PascalCase`，文件名与主导出名称一致
- 函数/变量: `camelCase`
- 常量: `UPPER_SNAKE_CASE`

### TypeScript
- **strict: false**（当前未启用严格模式）
- 前端路径别名: `@/*` → `./src/*`, `@shared/*` → `../shared/src/*`

### ESLint
- `@typescript-eslint/no-explicit-any`: warn
- `@typescript-eslint/no-unused-vars`: warn（忽略 `_` 前缀参数）
- 前端 lint 设置 `--max-warnings 150`，测试目录被忽略
- 后端 lint 忽略 `**/__tests__/**`

## 错误处理

### API 响应格式
```typescript
{ success: true, data: { ... } }
{ success: false, error: "错误消息" }
```

### asyncHandler 包装（必用）
后端所有路由 handler 必须用 `asyncHandler` 包装：
```typescript
router.post('/endpoint', asyncHandler(async (req, res) => {
  if (!req.body.name) {
    return res.status(400).json({ success: false, error: 'Name is required' })
  }
}))
```

### ID 验证
```typescript
const id = parseInt(req.params.id)
if (isNaN(id)) {
  return res.status(400).json({ success: false, error: 'Invalid ID' })
}
```

### 日志记录
- **禁止**在生产代码中使用 `console.log`
- 使用 `log()` 和 `logError()`（`backend/src/utils/logger.ts`）

## 测试

- **框架**: Vitest，前端 jsdom + vitest-canvas-mock，后端 node + supertest
- **前端位置**: `src/test/*.test.ts`, `src/**/__tests__/*.test.tsx`
- **后端位置**: `src/__tests__/*.test.ts`
- **覆盖率阈值**（后端）: statements 85%, branches 80%, functions 85%, lines 85%
- **后端覆盖率排除** `src/index.ts`, `src/types/**`, `src/__tests__/**`

## 项目结构

```
MindMap/
├── frontend/src/
│   ├── components/canvas/    # Fabric.js 画布组件
│   ├── components/layout/    # 布局 (Header, Sidebar, MainLayout)
│   ├── components/ui/        # Radix UI 封装
│   ├── features/node-pool/   # 节点卡片池模块
│   ├── store/                # Zustand 状态 (auth, canvas, projects, UI)
│   ├── services/             # API + WebSocket 客户端
│   └── utils/                # 工具函数 (nodeCache 等)
├── backend/src/
│   ├── controllers/          # auth, user, project, canvas, upload, collaboration, AI
│   ├── database/             # Drizzle schema, connection (better-sqlite3), migration
│   ├── middleware/            # CORS, CSRF, auth, error, rateLimit, validation
│   └── websocket/            # Yjs CRDT provider (sync/awareness) + canvas-state doc 管理
└── shared/src/               # 共享类型
```

## 反模式（禁止）

- ❌ 使用 `any` 类型（当前代码中存在残留，新代码禁止）
- ❌ 生产代码中使用 `console.log`
- ❌ `parseInt()` 无 NaN 验证
- ❌ `JSON.parse` 无 try-catch
- ❌ 直接访问 `localStorage`（使用 `utils/nodeCache.ts` 的封装函数）
- ❌ 直接修改 Fabric.js 对象（通过 Zustand store）
- ❌ 禁用 React.StrictMode

## 端口与环境

| 环境 | 前端 | API | WebSocket |
|------|------|-----|-----------|
| 开发 | 5173 | 3000 | 3001 |
| 生产 (Docker) | 9000 (静态服务) | 9000 | 9000 (/ws) |

后端在 `/health` 暴露健康检查端点。

## 测试账号

- 账号：test@test.com
- 密码：testtest
