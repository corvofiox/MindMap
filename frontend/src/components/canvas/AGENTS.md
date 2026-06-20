# Canvas 组件知识库

**父级**: Frontend AGENTS.md
**评分**: 15（高复杂度）

## 概述
Fabric.js 画布核心实现，包含节点卡片、域、连线等可交互对象

## 组件列表

| 组件 | 行数 | 功能 |
|------|------|------|
| `FabricCanvas.tsx` | ~400 | Fabric.js 画布实例管理 |
| `NodeItem.tsx` | 1232 | 节点卡片核心组件 |
| `NodeContextMenu.tsx` | 501 | 节点右键菜单 |
| `DomainContextMenu.tsx` | ~300 | 域右键菜单 |
| `NodeStylePanel.tsx` | ~400 | 节点样式面板 |
| `DomainStylePanel.tsx` | ~350 | 域样式面板 |
| `ConnectionStylePanel.tsx` | ~300 | 连线样式面板 |
| `CanvasGrid.tsx` | ~200 | 点状网格背景 |
| `CanvasMinimap.tsx` | ~250 | 缩略图组件 |
| `ZoomControls.tsx` | ~150 | 缩放控制 |
| `CanvasToolbar.tsx` | ~300 | 工具栏 |
| `CollaborationCursors.tsx` | ~200 | 协作光标显示 |

## Fabric.js 对象模型

**对象类型**（扩展 Fabric.js）:
- `Rect` - 节点卡片、域
- `Line` - 连线（直线、曲线、折线）
- `IText` - 文本编辑器
- `Image` - 图片对象

**自定义属性**:
```typescript
// NodeItem
{
  type: 'node',
  nodeId: string,
  canvasId: number,
  ...Fabric.Rect 属性
}

// Domain
{
  type: 'domain',
  domainId: string,
  ...Fabric.Rect 属性
}
```

## 状态管理

**通过 Zustand store 同步**（`store/useCanvasStore.ts`）:
```typescript
interface CanvasStore {
  nodes: Map<string, Node>
  selectedIds: Set<string>
  connections: Connection[]
  // ...

  // Actions
  addNode: (node: Node) => void
  updateNode: (id: string, data: Partial<Node>) => void
  deleteNode: (id: string) => void
  // ...
}
```

## 画布事件处理

**核心事件**（`FabricCanvas.tsx`）:
- `selection:created` - 创建选区
- `selection:updated` - 更新选区
- `selection:cleared` - 清除选区
- `object:modified` - 对象修改
- `object:moving` - 对象移动
- `object:scaling` - 对象缩放
- `object:rotating` - 对象旋转
- `mouse:down` - 鼠标按下
- `mouse:up` - 鼠标抬起

**拖曳模式**:
- 无限制模式（默认）
- 网格对齐模式（Shift 键临时切换）

## 样式面板

**节点样式**（`NodeStylePanel.tsx`）:
- 背景颜色（Morandi 调色板）
- 边框颜色和粗细
- 圆角半径
- 阴影效果
- 折叠/展开状态

**域样式**（`DomainStylePanel.tsx`）:
- 域背景色（半透明）
- 边框样式
- 标题样式
- 置顶/置底

**连线样式**（`ConnectionStylePanel.tsx`）:
- 线条类型（直线、曲线、折线）
- 颜色和粗细
- 箭头样式（无、单向、双向）
- 智能路由

## 交互模式

**快捷键**:
- `R` - 进入/退出域编辑模式
- `Shift` - 临时切换网格对齐
- `Delete/Backspace` - 删除选中
- `Ctrl+C/V` - 复制/粘贴

**右键菜单**:
- 节点: 编辑、复制、删除、样式、置顶/置底
- 域: 编辑、删除、样式、置顶/置底

## 缓存策略

**节点缓存**（`utils/nodeCache.ts`）:
```typescript
// 保存到 localStorage
setCanvasCache(canvasId: number, nodes: Node[]) => void

// 从 localStorage 读取
getCanvasCache(canvasId: number): Node[] | null

// 清除缓存
clearCanvasCache(canvasId: number): void
```

**注意**: localStorage 有配额限制，无错误处理

## 独特约定

### Fabric.js 导入
- 作为 npm 依赖打包进 Vite bundle
- 通过 `import { fabric } from 'fabric'` 导入
- 支持离线使用，无需 CDN

### 节点数据同步
```typescript
// Fabric 对象 -> Store 数据
const nodeData: Node = {
  id: fabricObject.nodeId,
  x: fabricObject.left,
  y: fabricObject.top,
  width: fabricObject.getScaledWidth(),
  height: fabricObject.getScaledHeight(),
  ...
}

// Store 数据 -> Fabric 对象
fabricObject.set({
  left: node.x,
  top: node.y,
  ...
})
```

## 反模式（禁止）

- ❌ 禁止直接操作 Fabric.js 对象，通过 `useCanvasStore`
- ❌ 禁止在渲染逻辑中调用 `localStorage`，使用 `nodeCache.ts`
- ❌ 禁止节点状态不一致（Fabric vs Store）

## 已知问题

### 高优先级
1. **NodeItem 组件过大** - 1232 行，需拆分
2. **节点缓存无错误处理** - localStorage 配额限制
3. **节点定位问题** - React.StrictMode 禁用原因

### 中优先级
1. **样式面板组件重复** - 多个面板有相似逻辑
2. **画布性能优化** - 大量节点时卡顿

## 关键依赖

- Fabric.js 5.x - 画布渲染
- Zustand - 状态同步
- Radix UI - 样式面板 UI
- Lucide React - 图标
