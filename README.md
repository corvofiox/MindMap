# MindMap - 个人思维整理工具

一个功能强大的协作式可视化思维整理应用，帮助用户在无限画布上创建、组织和连接各种内容节点，支持多人实时协作编辑。

## 功能特性

### 画布与节点管理

**无限画布**
- 可无限滚动的背景画布，支持任意位置创建内容
- 鼠标滚轮缩放和拖拽平移
- 点状网格背景，支持显示/隐藏、间距、颜色自定义
- 两种节点拖曳模式：无限制模式和网格对齐模式

**节点卡片**
- 统一的矩形节点卡片类型，通过颜色区分不同类型
- 支持文本和图片混合内容
- 富文本编辑：字体、颜色、大小、文本对齐
- 图片上传、大小调整和位置调整
- 节点卡片样式自定义：背景颜色、边框、圆角、阴影
- 折叠/展开功能

**组功能**
- 将多个节点卡片用带标识的矩形框体包裹
- 支持拖动组时保持节点卡片相对位置
- 支持组嵌套、复制、粘贴、删除
- 折叠/展开功能

**域功能**
- 在画布上创建矩形区域，用于标识和划分工作区域
- 通过快捷键 `R` 进入/退出域编辑模式
- 自定义底色、边框、标题样式
- 支持域的置顶/置底和层级管理

**连线功能**
- 支持直线、曲线、折线
- 箭头样式设置：无箭头、单向箭头、双向箭头
- 线条颜色和粗细设置
- 连线标签和智能路由

### 画布项目管理

**项目栏**
- 左侧项目栏，显示过往创作的画布缩略图
- 文件夹分类管理，支持拖拽排序
- 画布搜索、重命名、复制、删除
- 缩略图自动生成和更新

**标签栏**
- 支持同时打开多个画布
- 快速标签切换和管理
- 固定标签、关闭其他标签等功能

**节点卡片池**
- 右侧节点卡片池，保存可重复使用的节点卡片
- 文件夹分类管理
- 从节点卡片池添加到画布时保留所有样式和内容
- 节点卡片模板支持

**全局搜索**
- 支持模糊匹配、部分匹配、多词组搜索
- 搜索范围过滤：当前画布、所有画布、节点卡片池
- 类型过滤：节点卡片、组、画布、文件夹
- 匹配结果高亮和预览

### 协作与用户系统

**用户认证**
- 用户注册和登录
- JWT Token 认证
- 密码加密存储（bcrypt）

**实时协作**
- 基于 Yjs CRDT 的多人实时编辑
- WebSocket 通信
- 协作光标显示

## 技术栈

### 前端技术
- **框架**: React 18.x
- **语言**: TypeScript 5.x
- **构建工具**: Vite 5.x
- **画布渲染**: Fabric.js 5.x
- **状态管理**: Zustand 4.x
- **实时协作**: Yjs 13.x + y-websocket
- **UI 组件**: Radix UI + cmdk
- **样式**: TailwindCSS 3.x
- **图标**: Lucide React
- **日期处理**: date-fns 3.x
- **截图导出**: html2canvas

### 后端技术
- **运行时**: Node.js 20.x
- **框架**: Express 4.x
- **语言**: TypeScript 5.x
- **WebSocket**: ws 8.x (原生实现)
- **数据库**: SQLite 3.x (better-sqlite3)
- **ORM**: Drizzle ORM 0.30.x
- **认证**: JWT 9.x
- **密码加密**: bcrypt 5.x
- **文件上传**: multer 1.4.5-lts.1
- **类型定义**: @types/* 系列

## 项目结构

```
MindMap/
├── frontend/                 # 前端应用
│   ├── src/
│   │   ├── components/       # 通用组件
│   │   │   ├── canvas/       # 画布相关组件
│   │   │   │   ├── CanvasGrid.tsx       # 网格组件
│   │   │   │   ├── CanvasMinimap.tsx    # 缩略图组件
│   │   │   │   ├── CanvasToolbar.tsx    # 工具栏组件
│   │   │   │   ├── FabricCanvas.tsx     # Fabric.js 画布
│   │   │   │   ├── NodeItem.tsx         # 节点卡片组件
│   │   │   │   ├── NodeContextMenu.tsx  # 节点右键菜单
│   │   │   │   ├── NodeStylePanel.tsx   # 节点样式面板
│   │   │   │   ├── DomainContextMenu.tsx # 域右键菜单
│   │   │   │   ├── DomainStylePanel.tsx # 域样式面板
│   │   │   │   ├── ConnectionStylePanel.tsx # 连线样式面板
│   │   │   │   ├── ZoomControls.tsx     # 缩放控制
│   │   │   │   └── CollaborationCursors.tsx # 协作光标
│   │   │   ├── layout/        # 布局组件
│   │   │   │   ├── Header.tsx         # 顶部栏
│   │   │   │   ├── MainLayout.tsx     # 主布局
│   │   │   │   └── Sidebar.tsx        # 侧边栏
│   │   │   ├── ui/            # UI 组件
│   │   │   │   ├── AccountSettingsDialog.tsx # 账户设置
│   │   │   │   ├── CommandPalette.tsx # 命令面板
│   │   │   │   ├── SearchPanel.tsx    # 搜索面板
│   │   │   │   ├── SettingsDialog.tsx # 设置对话框
│   │   │   │   └── ShortcutsDialog.tsx # 快捷键说明
│   │   │   ├── ContextMenuWrapper.tsx # 右键菜单包装
│   │   │   └── DragGhost.tsx          # 拖拽残影
│   │   ├── features/          # 功能模块
│   │   │   └── node-pool/     # 节点卡片池
│   │   │       ├── components/      # 节点池组件
│   │   │       ├── hooks/           # 自定义 Hooks
│   │   │       ├── stores/          # 状态管理
│   │   │       ├── types/           # 类型定义
│   │   │       └── utils/           # 工具函数
│   │   ├── pages/             # 页面组件
│   │   │   ├── CanvasPage.tsx       # 画布页面
│   │   │   ├── LoginPage.tsx        # 登录页面
│   │   │   ├── ProjectsPage.tsx     # 项目页面
│   │   │   └── RegisterPage.tsx     # 注册页面
│   │   ├── services/          # 服务层
│   │   │   ├── api.ts               # API 服务
│   │   │   └── websocket.ts         # WebSocket 服务
│   │   ├── store/             # 状态管理
│   │   │   ├── useAuthStore.ts      # 认证状态
│   │   │   ├── useCanvasStore.ts    # 画布状态
│   │   │   ├── useProjectsStore.ts  # 项目状态
│   │   │   └── useUIStore.ts        # UI 状态
│   │   ├── constants/         # 常量定义
│   │   │   ├── index.ts
│   │   │   └── shortcuts.ts
│   │   ├── types/             # 类型定义
│   │   │   ├── fabric.d.ts
│   │   │   └── index.ts
│   │   ├── utils/             # 工具函数
│   │   │   ├── canvas.ts
│   │   │   ├── fabric.ts
│   │   │   └── nodeCache.ts
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   └── index.css
│   ├── package.json
│   ├── tailwind.config.js
│   ├── vite.config.ts
│   └── tsconfig.json
│
├── backend/                  # 后端应用
│   ├── src/
│   │   ├── controllers/      # 控制器
│   │   │   ├── auth.controller.ts    # 认证控制器
│   │   │   ├── canvas.controller.ts  # 画布控制器
│   │   │   ├── project.controller.ts # 项目控制器
│   │   │   ├── upload.controller.ts  # 上传控制器
│   │   │   ├── user.controller.ts    # 用户控制器
│   │   │   ├── log.routes.ts         # 日志路由
│   │   │   ├── logger.controller.ts  # 日志控制器
│   │   │   └── logs.controller.ts    # 日志控制器
│   │   ├── database/         # 数据库相关
│   │   │   ├── connection.ts         # 数据库连接
│   │   │   ├── schema.ts             # 数据库模式
│   │   │   ├── migration.ts          # 迁移脚本
│   │   │   └── check-db.ts           # 数据库检查
│   │   ├── middleware/       # 中间件
│   │   │   ├── auth.middleware.ts    # 认证中间件
│   │   │   ├── error.middleware.ts   # 错误处理中间件
│   │   │   └── validation.middleware.ts # 验证中间件
│   │   ├── utils/            # 工具函数
│   │   │   ├── dateTransform.ts
│   │   │   ├── logger.ts
│   │   │   └── transformResponse.ts
│   │   ├── websocket/        # WebSocket 处理
│   │   │   └── index.ts
│   │   └── index.ts          # 入口文件
│   ├── package.json
│   └── tsconfig.json
│
├── shared/                   # 共享代码
│   ├── src/
│   │   ├── index.ts
│   │   └── index.js
│   └── package.json
│
├── package.json              # 根目录 package.json
├── DEVELOPMENT.md            # 开发文档
└── README.md                 # 项目说明文档
```

## 快速开始

### 环境要求

- Node.js 20.x 或更高版本
- npm 或 yarn

### 方式一：使用初始化脚本（推荐）

我们提供了便捷的初始化脚本，可自动完成依赖安装、环境配置和数据库初始化：

#### Windows 用户

```bash
# 在项目根目录执行
init.bat
```

#### Linux/Mac 用户

```bash
# 在项目根目录执行
chmod +x init.sh  # 赋予执行权限
./init.sh
```

脚本执行过程中，会自动：
1. 检查 Node.js 和 npm 是否安装
2. 安装所有依赖
3. 创建必要的环境变量文件
4. 初始化数据库
5. 提供启动选项

### 方式二：手动安装（进阶用户）

#### 安装依赖

```bash
# 安装根目录依赖
npm install

# 安装前端依赖
cd frontend
npm install

# 安装后端依赖
cd ../backend
npm install
```

#### 环境配置

1. 复制环境变量示例文件（如果存在）：
```bash
# 后端
cp backend/.env.example backend/.env

# 前端
cp frontend/.env.example frontend/.env
```

2. 根据需要修改 `.env` 文件中的配置

##### 反向代理部署（TRUST_PROXY，重要）

服务**直曝公网**时（默认），后端**不信任** `X-Forwarded-For` 请求头——该头
完全由客户端控制，无条件信任会让攻击者伪造任意 IP 绕过全局限速，请保持
默认（不设置或 `TRUST_PROXY=false`）。

仅当部署在**反向代理**（Nginx / Caddy / Traefik 等）之后时，必须在
`backend/.env` 中显式设置：

```bash
TRUST_PROXY=true
```

取值仅 `true` / `1` / `yes` 视为开启，其他任何值一律视为关闭。若忘记设置，
限速会按反向代理的 IP 聚合——所有用户共享同一限额，容易误触发 429。

HTTPS 部署还需显式设置 `CSRF_COOKIE_SECURE=true`，否则浏览器不会在 HTTPS
下发送 Secure cookie，登录态与 CSRF 校验会失效。

#### 数据库初始化

```bash
cd backend
npm run db:generate
npm run db:push
```

### 启动开发服务器

**方式一：同时启动前后端（推荐）**

在项目根目录执行：
```bash
npm run dev
```

**方式二：分别启动**

前端开发服务器：
```bash
cd frontend
npm run dev
```

后端开发服务器：
```bash
cd backend
npm run dev
```

### 访问应用

- 前端应用: http://localhost:5173
- 后端 API: http://localhost:3000
- WebSocket: ws://localhost:3001

## 可用脚本

### 根目录脚本
- `npm run dev` - 同时启动前后端开发服务器
- `npm run build` - 构建前后端（如果配置了）

### 前端脚本
- `npm run dev` - 启动 Vite 开发服务器
- `npm run build` - 构建生产版本
- `npm run preview` - 预览生产构建
- `npm run lint` - 代码检查
- `npm run lint:fix` - 自动修复代码问题

### 后端脚本
- `npm run dev` - 启动开发服务器（热重载）
- `npm run build` - 编译 TypeScript
- `npm run start` - 启动生产服务器
- `npm run db:generate` - 生成数据库迁移
- `npm run db:push` - 推送数据库 schema 变更
- `npm run db:studio` - 打开 Drizzle Studio
- `npm run lint` - 代码检查

## 数据库结构

### 核心数据表

| 表名 | 说明 |
|------|------|
| `users` | 用户信息 |
| `groups` | 群组信息 |
| `group_members` | 群组成员关系 |
| `projects` | 项目信息 |
| `project_members` | 项目成员关系 |
| `folders` | 文件夹 |
| `canvases` | 画布数据 |
| `canvas_recycle_bin` | 画布回收站 |
| `node_cards` | 节点卡片 |
| `node_pool_folders` | 节点卡片池文件夹 |
| `files` | 上传文件 |
| `settings` | 用户设置 |

## 主要快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl + B` | 切换项目栏显示 |
| `Ctrl + P` | 切换节点卡片池显示 |
| `Ctrl + Shift + F` | 打开全局搜索 |
| `Ctrl + K` | 打开命令面板 |
| `Ctrl + N` | 新建画布 |
| `Ctrl + Tab` | 切换到下一个标签 |
| `Ctrl + W` | 关闭当前标签 |
| `R` | 进入/退出域编辑模式 |
| `Shift` | 临时切换拖曳模式 |
| `Delete` | 删除选中元素 |

## API 端点

### 认证模块
- `POST /api/auth/register` - 用户注册
- `POST /api/auth/login` - 用户登录
- `POST /api/auth/logout` - 退出登录

### 用户模块
- `GET /api/users/profile` - 获取用户信息
- `PUT /api/users/profile` - 更新用户信息
- `PUT /api/users/password` - 修改密码

### 项目模块
- `GET /api/projects` - 获取项目列表
- `POST /api/projects` - 创建项目
- `PUT /api/projects/:id` - 更新项目
- `DELETE /api/projects/:id` - 删除项目

### 画布模块
- `GET /api/canvases` - 获取画布列表
- `POST /api/canvases` - 创建画布
- `GET /api/canvases/:id` - 获取画布详情
- `PUT /api/canvases/:id` - 更新画布
- `DELETE /api/canvases/:id` - 删除画布

### 上传模块
- `POST /api/upload` - 上传文件

## 开发文档

详细开发指南请参考 [DEVELOPMENT.md](DEVELOPMENT.md)

## 许可证

MIT
