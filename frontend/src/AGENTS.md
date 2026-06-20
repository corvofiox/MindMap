# Frontend 源码知识库

**父级**: 根 AGENTS.md
**评分**: 22（高复杂度）

## 概述
React 18 + TypeScript + Vite 应用入口，包含组件、状态管理、服务层和页面逻辑

## 目录结构

```
src/
├── components/       # UI 组件库
│   ├── canvas/       # Fabric.js 画布核心（14 文件）
│   ├── layout/       # 布局组件（Header, Sidebar）
│   └── ui/           # Radix UI 组件封装
├── features/         # 功能模块
│   └── node-pool/    # 节点卡片池功能
├── pages/            # 页面组件
├── services/         # API + WebSocket 服务
├── store/            # Zustand 状态管理
├── utils/            # 工具函数
├── constants/        # 常量定义
└── types/            # 类型定义
```

## 快速定位

| 任务 | 位置 | 说明 |
|------|------|------|
| React Router 配置 | `App.tsx` | 路由定义 |
| 应用入口 | `main.tsx` | ReactDOM.render |
| Zustand stores | `store/` | 全局状态 |
| API 客户端 | `services/api.ts` | REST API 封装 |
| WebSocket 客户端 | `services/yjsProvider.ts` + `yjsBinding.ts` | Yjs CRDT 自研 provider + Y.Doc↔Zustand 绑定 |
| 工具函数 | `utils/` | 画布、Fabric、缓存工具 |

## 状态管理

**使用 Zustand 4.x**，4 个主要 store：

| Store | 文件 | 状态 |
|--------|------|------|
| useAuthStore | `store/useAuthStore.ts` | 用户认证、JWT |
| useCanvasStore | `store/useCanvasStore.ts` | 画布节点、选中状态 |
| useProjectsStore | `store/useProjectsStore.ts` | 项目、文件夹、画布列表 |
| useUIStore | `store/useUIStore.ts` | UI 状态（侧边栏、面板等） |

## 关键组件

**画布组件**（`components/canvas/`）:
- `FabricCanvas.tsx` - Fabric.js 画布实例
- `CanvasGrid.tsx` - 点状网格背景
- `NodeItem.tsx` - 节点卡片组件（1232 行）
- `NodeContextMenu.tsx` - 节点右键菜单（501 行）
- `DomainStylePanel.tsx` - 域样式面板
- `ConnectionStylePanel.tsx` - 连线样式面板

**布局组件**（`components/layout/`）:
- `MainLayout.tsx` - 主布局（项目栏 + 标签栏 + 内容区）
- `Sidebar.tsx` - 项目侧边栏（1279 行）

**UI 组件**（`components/ui/`）:
- Radix UI 封装（Dialog, Command, ScrollArea 等）
- 使用 Lucide React 图标

## 独特约定

### 路径别名
```typescript
import { Component } from '@/components/xxx'
import { store } from '@/store/xxx'
import type { Type } from '@/types/xxx'
```

### Fabric.js 集成
- **npm 导入**: 通过 `import { fabric } from 'fabric'` 导入，随 Vite 一起打包
- **自定义对象**: 扩展 Fabric.js 对象支持自定义属性
- **缓存策略**: `utils/nodeCache.ts` 缓存画布节点到 localStorage

### 实时协作（Yjs CRDT）
```typescript
// Yjs 自研 provider：复用后端 wsServer 鉴权/房间/心跳，承载 Yjs sync 协议
import { useCollaboration } from '@/hooks/useCollaboration'

const { sendCursor, isConnected } = useCollaboration({
  canvasId,
  enabled: canvasId > 0,
  onKicked: () => navigate('/'),
})
// 本地操作通过 useCanvasStore 的 mutator 触发，store 内部 syncDiffToYDoc
// 自动把变更写入 Y.Doc（origin = LOCAL_ORIGIN），provider 广播给其他客户端。
// 远程变更由 yjsBinding 的 observer 应用到 store（isApplyingRemoteChanges 守卫防回环）。
```

## 反模式（禁止）

- ❌ 禁止在组件中直接调用 `localStorage`，使用 `utils/nodeCache.ts`
- ❌ 禁止 Fabric.js 对象直接修改状态，通过 `useCanvasStore`
- ❌ 禁止 WebSocket 错误静默处理（当前 `services/collaboration.ts` 已添加日志）

## 已知问题

### 高优先级
1. **React.StrictMode 禁用** - `main.tsx` 临时禁用调试节点定位问题
2. **节点池组件过大** - `features/node-pool/components/NodePoolPanel.tsx` (731 行)

### 中优先级
1. **本地存储无错误处理** - `utils/clearStorage.ts` 使用 console.warn

## 开发命令

```bash
# 开发服务器
npm run dev              # Vite 开发服务器（端口 5173）

# 构建
npm run build            # tsc + vite build
npm run preview          # 预览生产构建

# 测试
npm run test             # Vitest (JSDOM 环境)

# 代码检查
npm run lint            # ESLint
npm run lint:fix        # 自动修复
```

## 关键依赖

- React 18.2.0 + React Router DOM
- Fabric.js 5.x（npm 依赖，打包进 bundle）
- Zustand 4.x（状态管理）
- Yjs CRDT 协作（自研 provider，复用后端 wsServer 基础设施；撤销重走 Zustand ownCommands）
- Radix UI + cmdk（UI 组件）
- html2canvas-pro（截图导出）
- TailwindCSS 3.x（样式）
- Lucide React（图标）
