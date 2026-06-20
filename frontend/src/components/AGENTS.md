# UI 组件库知识库

**父级**: Frontend AGENTS.md
**评分**: 14（中高复杂度）

## 概述
基于 Radix UI 的可复用组件库，包含布局、UI 对话框、命令面板等

## 组件分类

### 布局组件（`components/layout/`）

| 组件 | 行数 | 功能 |
|------|------|------|
| `MainLayout.tsx` | ~600 | 主布局（项目栏 + 标签栏 + 画布）|
| `Sidebar.tsx` | 1279 | 项目侧边栏 |
| `Header.tsx` | ~200 | 顶部栏 |

**MainLayout 结构**:
```
┌─────────────────────────────────┐
│          Header              │
├──────┬──────────────────────┤
│      │                      │
│ Side │      Canvas          │
│ bar  │                      │
│      │                      │
└──────┴──────────────────────┘
```

### UI 组件（`components/ui/`）

Radix UI 封装组件（约 30+ 文件）:

**对话框类**:
- `Dialog.tsx` - 模态对话框
- `AlertDialog.tsx` - 警告对话框
- `AlertDialog` 相关组件（Action, Cancel, Content, Title, Description）

**表单组件**:
- `Button.tsx` - 按钮
- `Input.tsx` - 输入框
- `Label.tsx` - 标签
- `Switch.tsx` - 开关
- `Checkbox.tsx` - 复选框
- `RadioGroup.tsx` - 单选组

**展示组件**:
- `ScrollArea.tsx` - 滚动区域
- `Separator.tsx` - 分隔线
- `Tooltip.tsx` - 提示框
- `Badge.tsx` - 标签

**命令面板**:
- `CommandPalette.tsx` - VS Code 风格命令面板（使用 cmdk 库）

**其他**:
- `ContextMenuWrapper.tsx` - 右键菜单包装器
- `DragGhost.tsx` - 拖拽残影
- `ShortcutsDialog.tsx` - 快捷键说明对话框
- `SettingsDialog.tsx` - 设置对话框
- `AccountSettingsDialog.tsx` - 账户设置

### Canvas 组件（`components/canvas/`）

独立知识库，详见 `components/canvas/AGENTS.md`

## 设计系统

**颜色**（`tailwind.config.js`）:
- Morandi 调色板（15 个莫兰迪色）
- 玻璃态颜色（glass morphism）
- 语义化颜色（primary, secondary, danger, warning, success）

**阴影**:
```css
shadow-sm, shadow, shadow-md, shadow-lg, shadow-xl
glass, glass-lg /* 玻璃态专用 */
```

**动画**:
```css
animate-in, fade-in, slide-in-from-*
animate-pulse-slow /* 3 秒脉冲 */
animate-breathe   /* 2 秒呼吸 */
```

**字体**:
- 中文: PingFang SC, Lantinghei SC, Microsoft YaHei
- 英文: Inter, system-ui, sans-serif

## 组件模式

### 组件结构
```typescript
interface Props {
  // Props 定义
}

export function ComponentName({ prop1, prop2 }: Props) {
  // Hooks
  const [state, setState] = useState()
  const store = useStore()

  // 事件处理
  const handleAction = useCallback(() => {
    // ...
  }, [deps])

  // 渲染
  return (
    <div className="...">
      {/* JSX */}
    </div>
  )
}
```

### Radix UI 模式
```typescript
import * as Dialog from '@radix-ui/react-dialog'

export function MyDialog() {
  return (
    <Dialog.Root>
      <Dialog.Trigger>
        <Button>打开</Button>
      </Dialog.Trigger>
      <Dialog.Content>
        <Dialog.Title>标题</Dialog.Title>
        <Dialog.Description>描述</Dialog.Description>
        {/* 内容 */}
      </Dialog.Content>
    </Dialog.Root>
  )
}
```

### 命令面板模式
```typescript
import { Command } from 'cmdk'

export function CommandPalette() {
  return (
    <Command>
      <Command.Input placeholder="搜索..." />
      <Command.List>
        <Command.Empty>无结果</Command.Empty>
        <Command.Group heading="命令">
          <Command.Item onSelect={...}>新建画布</Command.Item>
          <Command.Item onSelect={...}>打开设置</Command.Item>
        </Command.Group>
      </Command.List>
    </Command>
  )
}
```

## 独特约定

### 样式约定
```tsx
// 类名顺序：布局 -> 尺寸 -> 间距 -> 颜色 -> 边框 -> 动画
<div className="
  flex items-center justify-between
  w-full h-12
  px-4 py-2
  bg-white text-gray-900
  border border-gray-200
  animate-in
">
```

### Props 类型定义
```typescript
// 组件内部定义 Props 接口
interface Props {
  children?: React.ReactNode
  className?: string
  variant?: 'default' | 'outline' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  onClick?: () => void
}

// 导出 Props 类型供外部使用
export type { Props as ButtonProps }
```

## 反模式（禁止）

- ❌ 禁止直接使用原生 HTML 元素，使用 Radix UI 组件
- ❌ 禁止硬编码样式值，使用 Tailwind 类名
- ❌ 禁止在 UI 组件中包含业务逻辑

## 已知问题

### 中优先级
1. **Sidebar 组件过大** - 1279 行，需拆分
2. **组件未完全统一** - 部分 UI 组件样式不一致

## 关键依赖

- Radix UI - 无障碍 UI 组件
- cmdk - 命令面板
- TailwindCSS 3.x - 样式
- Lucide React - 图标
- class-variance-authority - 组件变体
