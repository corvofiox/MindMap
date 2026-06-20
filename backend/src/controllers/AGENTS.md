# API 控制器知识库

**父级**: Backend AGENTS.md
**评分**: 8（独立域）

## 概述
Express REST API 路由控制器，处理认证、用户、项目、画布、文件上传等业务逻辑

## 控制器列表

| 控制器 | 路径前缀 | 行数 | 功能 |
|---------|-----------|------|------|
| auth.controller.ts | `/api/auth` | ~200 | 注册、登录、登出 |
| user.controller.ts | `/api/users` | ~150 | 用户资料、密码修改 |
| project.controller.ts | `/api/projects` | 581 | 项目 CRUD、成员管理 |
| canvas.controller.ts | `/api/canvases` | 578 | 画布 CRUD、Yjs 数据 |
| upload.controller.ts | `/api/upload` | ~300 | 文件上传（multer）|

## 认证控制器（auth.controller.ts）

**路由**:
```typescript
POST   /api/auth/register  // 用户注册
POST   /api/auth/login     // 用户登录
POST   /api/auth/logout    // 用户登出
GET    /api/auth/me        // 获取当前用户
```

**密码加密**:
```typescript
import bcrypt from 'bcrypt'

// 加密密码
const hashedPassword = await bcrypt.hash(password, 10)

// 验证密码
const isValid = await bcrypt.compare(password, user.password)
```

**JWT Token 生成**:
```typescript
import jwt from 'jsonwebtoken'

const token = jwt.sign(
  { userId: user.id, email: user.email },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
)
```

## 用户控制器（user.controller.ts）

**路由**:
```typescript
GET    /api/users/profile          // 获取用户资料
PUT    /api/users/profile          // 更新用户资料
PUT    /api/users/password        // 修改密码
```

**验证中间件**:
```typescript
router.put(
  '/password',
  authMiddleware,           // 必须登录
  validateBody(updatePasswordSchema),  // Zod 验证
  asyncHandler(updatePassword)
)
```

## 项目控制器（project.controller.ts）

**路由**:
```typescript
GET    /api/projects                    // 获取项目列表
POST   /api/projects                    // 创建项目
GET    /api/projects/:id                // 获取项目详情
PUT    /api/projects/:id                // 更新项目
DELETE /api/projects/:id                // 删除项目
POST   /api/projects/:id/members       // 添加成员
DELETE /api/projects/:id/members/:userId // 删除成员
```

**权限控制**:
- 只有项目所有者可以删除项目
- 只有项目成员可以查看项目
- 只有项目所有者可以管理成员

**已知问题**:
- `parseInt(req.params.id)` 无验证，可能为 NaN
- 多处使用 `(project as any).owner_id` 因 Drizzle 命名不一致

## 画布控制器（canvas.controller.ts）

**路由**:
```typescript
GET    /api/canvases              // 获取画布列表
POST   /api/canvases              // 创建画布
GET    /api/canvases/:id          // 获取画布详情
PUT    /api/canvases/:id          // 更新画布
DELETE /api/canvases/:id          // 删除画布
POST   /api/canvases/:id/yjs      // 同步 Yjs 数据
GET    /api/canvases/:id/yjs      // 获取 Yjs 数据
```

**Yjs 数据存储**:
```typescript
// Yjs 文档序列化为 base64
const yjsData = Buffer.from(Y.encodeStateAsUpdate(yDoc)).toString('base64')

// base64 反序列化为 Yjs 更新
const yDoc = new Y.Doc()
Y.applyUpdate(yDoc, Buffer.from(yjsData, 'base64'))
```

**已知问题**:
- `parseInt(req.params.id)` 无验证
- `(canvas as any).project_id` 因 Drizzle 命名不一致

## 文件上传控制器（upload.controller.ts）

**路由**:
```typescript
POST   /api/upload                // 上传文件
GET    /api/upload/:filename      // 获取文件
DELETE /api/upload/:filename      // 删除文件
```

**Multer 配置**:
```typescript
import multer from 'multer'

const upload = multer({
  dest: process.env.UPLOAD_DIR || './uploads',
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024 // 5MB
  },
  fileFilter: (req, file, cb) => {
    // 只允许图片
    if (file.mimetype.startsWith('image/')) {
      cb(null, true)
    } else {
      cb(new Error('只允许上传图片文件'))
    }
  }
})
```

**已知问题**:
- 10+ 处 `console.log` 泄漏到生产

## 独特约定

### asyncHandler 包装
```typescript
import { asyncHandler } from '../middleware/error.middleware.js'

// 所有路由使用 asyncHandler 包装错误
router.post('/login', asyncHandler(async (req, res) => {
  // ...
}))
```

### 验证中间件
```typescript
import { validateBody, validateParams } from '../middleware/validation.middleware.js'

// Zod schema 验证
router.post('/create',
  validateBody(createProjectSchema),
  asyncHandler(async (req, res) => {
    // req.body 已经验证
  })
)
```

### 认证中间件
```typescript
import { authMiddleware, optionalAuth } from '../middleware/auth.middleware.js'

// 必须登录
router.get('/profile', authMiddleware, ...)

// 可选登录
router.get('/public', optionalAuth, ...)
```

### 响应格式
```typescript
// 成功响应
res.json({ success: true, data: result })

// 错误响应
res.status(400).json({ success: false, error: '错误消息' })
```

## 反模式（禁止）

- ❌ 禁止 `parseInt(req.params.id)` 无验证，必须检查 `isNaN()`
- ❌ 禁止使用 `(obj as any)`，修复 Drizzle 命名不一致
- ❌ 禁止 `console.log` 泄漏到生产，使用 `logger.ts`
- ❌ 禁止 `throw error` 而不加上下文

## 已知问题

### 高优先级
1. **parseInt 无验证** - canvas/project controllers
2. **any 类型转换** - Drizzle snake_case vs camelCase
3. **console.log 泄漏** - upload.controller.ts (10+ 处)

### 中优先级
1. **错误处理无上下文** - 多处直接 throw error
2. **文件上传日志过多** - upload.controller.ts

## 关键依赖

- Express 4.x - 路由框架
- bcrypt 6.x - 密码加密
- JWT 9.x - Token 认证
- multer - 文件上传
- Zod - Schema 验证
- Drizzle ORM - 数据库操作
