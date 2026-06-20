# Zustand Store 状态管理知识库

**父级**: Frontend AGENTS.md
**评分**: 9（独立域）

## 概述
Zustand 4.x 全局状态管理，包含认证、画布、项目、UI 四个核心 store

## Store 列表

| Store | 文件 | 行数 | 状态 |
|--------|------|------|------|
| useAuthStore | `store/useAuthStore.ts` | ~100 | 用户认证、JWT |
| useCanvasStore | `store/useCanvasStore.ts` | 799 | 画布节点、选中状态 |
| useProjectsStore | `store/useProjectsStore.ts` | 609 | 项目、文件夹、画布列表 |
| useUIStore | `store/useUIStore.ts` | ~200 | UI 状态（侧边栏、面板）|

## useAuthStore

**状态**:
```typescript
interface AuthState {
  user: User | null           // 当前用户
  token: string | null        // JWT token
  isLoading: boolean          // 加载状态
  error: string | null       // 错误信息

  // Actions
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string, nickname: string) => Promise<void>
  logout: () => void
  updateUser: (data: Partial<User>) => void
  checkAuth: () => Promise<void>
}
```

**存储**:
- JWT token 存储在 `localStorage`
- 用户信息存储在 `localStorage`

## useCanvasStore

**状态**:
```typescript
interface CanvasState {
  // 节点
  nodes: Map<string, Node>
  selectedIds: Set<string>

  // 连线
  connections: Connection[]

  // 域
  domains: Domain[]

  // 画布状态
  zoom: number
  pan: { x: number; y: number }

  // 拖曳模式
  dragMode: 'free' | 'grid'

  // Actions
  addNode: (node: Node) => void
  updateNode: (id: string, data: Partial<Node>) => void
  deleteNode: (id: string) => void
  selectNodes: (ids: string[]) => void
  clearSelection: () => void
  addConnection: (conn: Connection) => void
  updateConnection: (id: string, data: Partial<Connection>) => void
  deleteConnection: (id: string) => void
  setZoom: (zoom: number) => void
  setPan: (pan: { x: number; y: number }) => void
  setDragMode: (mode: 'free' | 'grid') => void
  // ... 更多 actions
}
```

**数据结构**:
- `nodes`: 使用 `Map` 存储节点，O(1) 查找
- `selectedIds`: 使用 `Set` 存储选中 ID
- `connections`: 数组存储连线对象

## useProjectsStore

**状态**:
```typescript
interface ProjectsState {
  projects: Project[]
  folders: Folder[]
  canvases: Canvas[]
  currentProject: Project | null
  currentCanvas: Canvas | null

  // Actions
  loadProjects: () => Promise<void>
  createProject: (data: Partial<Project>) => Promise<void>
  updateProject: (id: number, data: Partial<Project>) => Promise<void>
  deleteProject: (id: number) => Promise<void>
  // ... 更多 actions
}
```

**数据同步**:
- 通过 API 获取项目列表
- 本地缓存减少网络请求

## useUIStore

**状态**:
```typescript
interface UIState {
  // 侧边栏
  sidebarOpen: boolean

  // 节点池
  nodePoolOpen: boolean

  // 面板
  activePanel: 'node' | 'domain' | 'connection' | null

  // 对话框
  commandPaletteOpen: boolean
  settingsOpen: boolean

  // 快捷键
  shortcutsOpen: boolean

  // Actions
  toggleSidebar: () => void
  toggleNodePool: () => void
  setActivePanel: (panel: 'node' | 'domain' | 'connection' | null) => void
  toggleCommandPalette: () => void
  toggleSettings: () => void
  toggleShortcuts: () => void
}
```

## 独特约定

### Store 创建模式
```typescript
import { create } from 'zustand'

interface State {
  // 状态定义
  value: string

  // Actions
  setValue: (value: string) => void
}

export const useStore = create<State>((set) => ({
  value: '',

  setValue: (value) => set({ value }),
}))
```

### 持久化模式
```typescript
import { persist } from 'zustand/middleware'

export const useAuthStore = create(
  persist<AuthState>(
    (set) => ({
      // ...
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({
        token: state.token,
        user: state.user,
      }),
    }
  )
)
```

### 异步 Action 模式
```typescript
const login: (email: string, password: string) => Promise<void> = async (email, password) => {
  set({ isLoading: true, error: null })

  try {
    const res = await api.post('/auth/login', { email, password })
    set({ user: res.data.user, token: res.data.token, isLoading: false })
  } catch (error) {
    set({ error: error.message, isLoading: false })
  }
}
```

## 反模式（禁止）

- ❌ 禁止在 store 中调用 `localStorage`，使用 `persist` middleware
- ❌ 禁止在 store 中直接修改状态，必须通过 `set()`
- ❌ 禁止在 store 中包含业务逻辑，保持数据层纯净

## 已知问题

### 中优先级
1. **useCanvasStore 过大** - 799 行，需拆分
2. **节点选择状态复杂** - selectedIds Set 使用需谨慎

## 关键依赖

- Zustand 4.x - 状态管理
- zustand/middleware - persist 中间件
