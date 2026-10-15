# MindMap 项目指南

**最后更新**: 2026-10-13

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

## 镜像发布（Docker Hub `corvofiox/mindmap`）

构建机为内网 Ubuntu（`~/mindmap-build/mindmap_v<四位版本>/`）。双架构产物，版本 tag 与 `latest` 必须指向同一 digest：

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg APP_VERSION=v1.9.15 \
  --build-arg GIT_REVISION=$(git rev-parse HEAD) \
  -t corvofiox/mindmap:v1.9.15 -t corvofiox/mindmap:latest \
  --push .
```

`APP_VERSION` 决定镜像 LABEL 与 `/health` 返回的版本号；不传则两处都显示 `dev`（宁可标"未知"也不谎报版本）。

发布前后逐项核对：

1. 工作区干净、前后端测试全绿；
2. **`buildx push` 成功 ≠ 镜像能启动** —— v1.9.13 曾因 Dockerfile 漏 `COPY scripts/` 导致 `start.js` 崩溃循环；
3. 起容器冒烟 `curl localhost:9000/health`，版本号必须是本次发布的，不能是 `dev`；
4. `docker image inspect` 的 `org.opencontainers.image.revision` 应等于本次 commit；
5. 打 git tag（`git tag v1.9.15 && git push origin v1.9.15`）—— 镜像版本与源码 commit 的对应关系只存在于此；
6. 崩溃循环先 `docker logs` 定位；回滚 = 拉上一版 → 重新 tag 成 `latest` → `compose up -d`。

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

### better-sqlite3 的事务必须写成同步形式
`db.transaction()` 在 better-sqlite3 driver 下是**同步**的。传 async 回调会抛
`Transaction function cannot return a promise`（被 errorHandler 转成 500「服务器内部错误」），
而且回调里的语句会在事务被回滚**之后**才落库 —— 表现为**接口报错、数据却已写入**，
既无原子性又误导调用方。

```typescript
// 正确：同步回调 + .run()（写）/ .all()（读）
db.transaction((tx) => {
  tx.update(projectInvitations).set({ status: 'accepted' }).where(...).run()
  const rows = tx.select().from(projects).where(...).all()
})

// 错误：async 回调 —— 会抛错且没有事务保护
await db.transaction(async (tx) => {
  await tx.insert(projectMembers).values({ ... })
})
```

`backend/src/__tests__/collaboration-accept.integration.test.ts` 末尾有一条源码守卫测试，
会扫描 `backend/src` 并让这类写法直接失败 —— 别再写 async 回调。

### ESM 导入必须加 .js 后缀
后端所有相对导入必须在路径末尾加 `.js`：
```typescript
import { users } from '../database/schema.js'
import { asyncHandler } from '../middleware/error.middleware.js'
```
TypeScript ESM + `moduleResolution: "bundler"` 强制执行此约定。

### 判断样式里的属性必须走 CSSOM，不要字符串匹配
读/改元素内联样式里的某个属性时，用 `element.style.<prop>` / `style.removeProperty(...)`，
**不要** `style.match(/color\s*:\s*([^;]+)/)` 或 `style.includes('color')`：这些写法没有属性边界，
`background-color` / `border-color` / `caret-color` 都会被误命中（曾导致"刚打出的默认文字一划选
就被判成已改颜色"，且"移除文字颜色"会把 `background-color: x` 抠成残缺的 `background-`）。
相关实现集中在 `frontend/src/utils/richTextCommands.ts` 的 `getInlineTextColor` /
`clearInlineTextColor`，并有源码守卫测试（`frontend/src/test/richTextCommands.test.ts`）。
另：向上找样式时要**在 contenteditable 边界停止**，否则会把节点卡片/画布的颜色当成本段文字的。

### WebSocket：开发 vs 生产（Yjs CRDT 协作）
- **开发环境**: WebSocket 独立监听端口 3001
- **生产环境**: WebSocket 与 HTTP 共享端口 9000（路径 `/ws`）
- 实时协作基于 **Yjs CRDT**（自研 provider 复用现有 wsServer 的鉴权/房间/心跳/踢人基础设施）
- 数据流：客户端 `Y.Doc` update → 服务端 `Y.applyUpdate` → 广播给房间其他客户端；撤销重做保留 Zustand `ownCommands`（方案 B）

### WS 写操作的角色复验（TTL，2026-10-14）
连接的角色（`ws.userRole`）在 connect 时快照，正常变更由 REST 层推送
`updateUserRole` / `kickUserFromRoom`。这覆盖所有正常路径但**不强制**——绕过 REST
直接改库（或未来漏调 kick 的代码路径）会让被撤权者继续写权威文档（CRDT 写不可撤销）。
防线（`websocket/index.ts` 的 `revalidateWriteRole`）：
- **只有写帧复验**（SYNC STEP2/UPDATE）；awareness/cursor/读帧永不查库；
- 结果按连接缓存 **5s TTL**，一次写突发只付一对查询；快照新鲜时的快路径**无 await**（帧序不变）；
- 查询成功且显示无成员资格 → **确定撤权**：复用 kicked 通知 + 清理路径踢出；
- 查询抛错 → **状态不明**：保留最后已知角色放行并记日志——静默丢 Yjs 更新会让
  对端文档与服务端分叉而客户端仍以为已同步，比有界的放行窗口更糟。
注意 `updateUserRole` 会同时刷新 `roleCheckedAt`（REST 刚写库，快照即新鲜）。

### REST 全量快照合并：三条防线与两个已知限制（2026-10-15 协作审查）
单用户 REST 客户端仍会发**完整 JSON 快照**（`POST /api/canvases/:id/data`、
`PUT /api/canvases/:id` 的 `yjsData`）。它和 CRDT 是两套语义，合并逻辑在
`backend/src/websocket/canvas-state.ts` 的 `mergeJsonSnapshotIntoCanvas`。三道防线：

1. **upsertOnly（保守合并）**：快照"缺失 doc 中存在的实体"即视为过期快照
   （`snapshotMissingDocEntities`），或房间仍有活跃用户 / 15s 内刚拆除
   （`shouldUpsertOnlyForSnapshot`）→ 只增改、不删。删除只认客户端显式声明的
   `deletedIds`（`MAX_DELETED_IDS_PER_COLLECTION = 10_000`，超限即丢弃该集合声明
   转为保守）。
2. **H2 删除墓碑**：doc 里被删除的实体 id 由 `yjs-schema.collectTombstonedIds`
   从 Yjs struct 历史中读出（`deleted===true` 且 `parentSub` 命中集合，排除仍
   存活的 id）。upsertOnly 分支拒绝把墓碑 id 写回——否则 A 的过期快照会让 B
   刚删的实体在 A 眼前复活、而 B 看不到，双端分叉。
   **墓碑不反向强制 upsertOnly**：单用户"删除 → Ctrl+Z"重发同 id 是合法写入，
   无条件拦截会让撤销静默不落库。
3. **写路径互斥**：`withPostSaveMutex` 串行化同一画布的 REST 合并；但它**不**
   串行 WS 应用，故第 1 条的判定必须保守（见 `canvas.controller.ts` 注释）。

**已知限制（未根治，改动相关代码前先读）：**
- **H3 字段级 LWW**：同一实体的**字段**冲突仍按"后写覆盖"处理。REST 快照会整
  字段覆盖协作方刚改的字段。实体级增删已由防线 1/2 保护，字段级没有——无删除
  声明信号时服务端无法区分"本地权威修改"与"过期字段值"。
- **残余复活窗口**：房间拆除超过 15s 宽限期后，单用户过期快照仍可复活已删 id
  （与 H3 同源）。要真正根治需要 doc 内持久化墓碑集合 + 快照携带版本向量。

### 断线关页：本地缓冲编辑必须有 REST 兜底（H1，2026-10-15 修复）
`hasCollaborationEvidence()` 一旦置位本会话不再清除，但**它不保证 WS 此刻在线**。
`CanvasPage.tsx` 的 `sendKeepaliveSnapshot` 因此不能只凭该标志跳过 REST：
先 `provider.flushPendingUpdates()`，再用 `provider.hasPendingOfflineEdits()`
（= `pendingUpdates.length > 0`，`frontend/src/services/yjsProvider.ts`）判定，
**仍有待发编辑时即使有协作证据也要发 keepalive REST**。
残余取舍：待发编辑体积超过 48KB（`KEEPALIVE_MAX_BODY_BYTES`）时仍只靠 localStorage。

### sanitizeHTML：unwrap 必须逐子消毒（mXSS）+ CSS 值检查用空白剥离副本
- 白名单外标签解包时，**被提升的每个子节点必须立即重新 `sanitizeNode`**：外层循环
  迭代的是提升前的 childNodes 快照，否则提升的子树完全逃过净化——
  `<math><mtext><mglyph><style><img onerror=…>` 曾借这个洞把裸 `<style>` 正文
  （CDATA 里的 img 标记）原样送进输出。同时解包不得对已脱管节点再 `removeChild`
  （必抛 NotFoundError，曾让 `safeHTML` 整体降级成 stripHTML、合法 `<b>` 全丢）。
- 解包后**元素自身必须从 DOM 移除，输出不得残留空壳**（`<font>x</font>` →
  恰为 `x`，不是 `x<font></font>`）。该处的 parentNode 守卫在 fragment 重构后
  恒真（children 摘走、element 无人动），已简化为无条件移除并由精确输出测试锁定。
- `sanitizeStyle` 的危险值检查（`javascript:` 等）必须测**空白剥离后的副本**：
  CSS 里换行是普通空白，`url(java\nscript:…)` 在浏览器拼回可执行协议，
  字面 `/javascript:/i` 测不到；声明的原值保留原间距。
- **jsdom 的 DOM 操作是 O(位置)**（实测纯 DOM 解包 4k→0.8s、8k→2.9s），真实浏览器
  是 O(1) 链表操作——净化器性能测试不要用几万标签的输入，那测的是环境不是代码。

### 同步对象数组时顺序必须保真（顺序即语义）
`connection.bendPoints` 这类**对象数组**在 Yjs 里是 `Y.Array`，绑定层
（`frontend/src/services/yjsBinding.ts` → `diffObjectArrayById`）按 `id` 做增量
diff。踩过的坑：新增项曾被一律追加到数组末尾，于是「本地在更靠前的位置插入一个
弯折点」时，共享文档里的顺序与本地不同 —— 而对端渲染折线是**完全按文档数组顺序
连点**的，净效果就是"写点的人本地看着是对的，别人看到一条折返/交叉的线"。
规则：diff 完必须让文档顺序与本地目标顺序**逐位一致**（新项按目标索引插入、
位置变了的项原地移动）；渲染侧**不要**靠排序去"纠正"顺序 —— 用户可能故意画
折返的折线。插入索引的计算在 `frontend/src/utils/connectionBendPoints.ts`，
顺序保真的回归测试在 `frontend/src/test/yjsBinding.test.ts`。

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
- **后端位置**: `src/__tests__/*.test.ts`（controller 集成测试在 `src/__tests__/*.integration.test.ts`）
- **覆盖率阈值**（后端，`backend/vitest.config.ts`）: statements 76%, branches 68%, functions 75%, lines 78%
  （2026-10-13 重新标定为真实水平；旧 85/80 从未真实达成过。提高方式：补真实覆盖后上调数字。）
- **覆盖率阈值**（前端，`frontend/vitest.config.ts`）: statements 33%, branches 27%, functions 36%, lines 33%
  （2026-10-14 重新标定为真实水平——旧 80/75/80/80 从未真实达成过，`--coverage` 一直以退出码 1
  静默失败，门限形同虚设；页面层（CanvasPage/LoginPage/ProjectsPage/NodePoolPanel）目前接近 0 覆盖。
  提高方式：补真实覆盖后上调数字。）
- **后端覆盖率排除** `src/index.ts`, `src/types/**`, `src/__tests__/**`
- **MCP E2E 冒烟**（不属于 vitest，手动跑）: `npm run smoke:mcp`（HTTP 全链路）、`npm run smoke:mcp:stdio`（stdio 代理）

### 测试真实性纪律（2026-10-13 全量审视确立，有守卫测试强制）

项目曾出现大量"假测试"——断言恒真、看起来在覆盖实际什么都没验证。实证：把
canvas 列表路由改成永远 500，对应 25 条"测试"仍全绿。现已清理，并由
`backend/src/__tests__/test-quality-guard.test.ts` 守卫防回潮。规则：

1. **测试必须 import 被测的真实模块**。禁止在测试文件里重新实现被测逻辑再断言自己的副本。
2. **supertest 调用必须 `await`**（或 `return`）。未 await 时拿到的是 Test 对象，`expect(res).toBeDefined()` 恒真。
3. **禁止只有 `toBeDefined()`/`toBeTruthy()` 断言的用例**——每个测试必须能在被测行为改变时失败。
4. **后端 controller 测试用集成写法**：真实 router + 真实 in-memory SQLite（`runMigrations`）+ 真实 HTTP 响应断言 + 数据库行断言。共享夹具在 `src/__tests__/helpers/integration-harness.ts`（`createTestDatabase` / `buildApp` / `seedUser` / `authHeader` 等）。参照 `canvas.controller.integration.test.ts`。
5. **安全关键行为（鉴权、越权、XSS/路径穿越防护、密钥哈希）必须做变异验证**：临时破坏实现 → 确认测试变红 → 还原。守卫测试防的是"恒真"，变异验证防的是"断言了错误的期望"。
6. **只 mock 真正的外部**（数据库连接、限速、websocket、logger）；**绝不 mock 被测模块本身**。

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
│   ├── controllers/          # auth, user, project, canvas, upload, collaboration, token
│   ├── database/             # Drizzle schema, connection (better-sqlite3), migration
│   ├── middleware/           # CORS, CSRF, auth, mcpAuth, error, rateLimit, validation
│   ├── mcp/                  # MCP server（画布工具 + stdio/HTTP 传输 + 访问控制）
│   └── websocket/            # Yjs CRDT provider (sync/awareness) + canvas-state doc 管理
└── shared/src/               # 共享类型
```

## MCP 服务（外部 agent 接入）

项目**不再内置 AI 助手**（侧边栏对话、服务端 LLM 代理、供应商密钥加密存储均已移除）。
改为对外提供 MCP 服务，由外部 agent 自带模型来管理画布。

| 传输 | 入口 | 鉴权 |
|------|------|------|
| Streamable HTTP | `POST /mcp`（复用 3000/9000 端口） | `Authorization: Bearer mmp_…` |
| stdio | `npm run mcp:stdio`（`backend/dist/mcp/stdio.js`） | 环境变量 `MINDMAP_TOKEN` |

- 令牌在网页端「账号设置 → 访问令牌」创建，只存 SHA-256 哈希，明文仅创建时返回一次；
  表为 `personal_access_tokens`，管理接口 `/api/tokens`（JWT + CSRF）。
- `/mcp` **不挂 CSRF**：凭证是显式 Authorization 头，跨站表单无法设置。
- stdio 入口是**代理**，不是独立实现：它把 JSON-RPC 转发给已运行的服务端。
  原因——画布是**服务端进程内存里的 Y.Doc**，且广播 handler 也在那里；独立进程
  自己从 SQLite 载入副本会产生第二个写入者，改动既不会广播给浏览器，还会被服务端
  下一次持久化覆盖。
- 工具层在 `backend/src/mcp/tools.ts`（23 个工具），实体操作在 `canvas-ops.ts`，
  访问控制在 `access.ts`。工具语义与已删除的前端 `aiTools.ts` 保持一致。

**关键约束：MCP 写操作必须走 `canvas-ops.ts` 的 `upsertEntities` / `deleteEntities`。**
它们以 `MCP_ORIGIN` 事务写入，这是 `undo`/`redo` 能追踪 agent 自己改动、
且不会回退他人编辑的前提；同时是**实体级**写入，不会像
`mergeJsonSnapshotIntoCanvas` 那样整集合替换（那会静默删除协作方的内容）。
另注意 `Y.UndoManager` 只能观察**构造之后**的事务，故 `getUndoManager` 必须在
写入前调用（已封装在两个写函数内部，勿绕过）。

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
