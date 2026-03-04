export interface Shortcut {
  keys: string[]
  description: string
  category: 'tools' | 'edit' | 'view' | 'selection' | 'actions' | 'panels'
}

export const SHORTCUTS: Shortcut[] = [
  {
    keys: ['N'],
    description: '节点工具',
    category: 'tools'
  },
  {
    keys: ['I'],
    description: '图片工具',
    category: 'tools'
  },
  {
    keys: ['L'],
    description: '连线工具',
    category: 'tools'
  },
  {
    keys: ['G'],
    description: '分组工具',
    category: 'tools'
  },
  {
    keys: ['R'],
    description: '域工具',
    category: 'tools'
  },
  {
    keys: ['H'],
    description: '切换网格显示',
    category: 'view'
  },
  {
    keys: ['M'],
    description: '切换小地图',
    category: 'view'
  },
  {
    keys: ['Space'],
    description: '拖动画布（按住）',
    category: 'view'
  },
  {
    keys: ['Shift'],
    description: '切换拖动模式',
    category: 'view'
  },
  {
    keys: ['Ctrl', '0'],
    description: '重置缩放',
    category: 'view'
  },
  {
    keys: ['Ctrl', '+'],
    description: '放大',
    category: 'view'
  },
  {
    keys: ['Ctrl', '-'],
    description: '缩小',
    category: 'view'
  },
  {
    keys: ['E'],
    description: '切换快速编辑模式',
    category: 'edit'
  },
  {
    keys: ['Enter'],
    description: '编辑选中节点',
    category: 'edit'
  },
  {
    keys: ['Ctrl', 'Z'],
    description: '撤销',
    category: 'edit'
  },
  {
    keys: ['Ctrl', 'Y'],
    description: '重做',
    category: 'edit'
  },
  {
    keys: ['Ctrl', 'S'],
    description: '保存',
    category: 'edit'
  },
  {
    keys: ['Ctrl', 'D'],
    description: '复制选中节点',
    category: 'edit'
  },
  {
    keys: ['Ctrl', 'C'],
    description: '复制',
    category: 'edit'
  },
  {
    keys: ['Ctrl', 'V'],
    description: '粘贴',
    category: 'edit'
  },
  {
    keys: ['Ctrl', 'A'],
    description: '全选',
    category: 'selection'
  },
  {
    keys: ['Ctrl', 'G'],
    description: '创建分组',
    category: 'actions'
  },
  {
    keys: ['Delete'],
    description: '删除选中元素',
    category: 'actions'
  },
  {
    keys: ['Backspace'],
    description: '删除选中元素',
    category: 'actions'
  },
  {
    keys: ['Escape'],
    description: '退出当前操作',
    category: 'actions'
  },
  {
    keys: ['Ctrl', 'B'],
    description: '切换侧边栏',
    category: 'panels'
  },
  {
    keys: ['Ctrl', 'P'],
    description: '切换节点池',
    category: 'panels'
  },
  {
    keys: ['Ctrl', ','],
    description: '打开设置',
    category: 'panels'
  },
  {
    keys: ['Ctrl', 'K'],
    description: '打开命令面板',
    category: 'panels'
  },
  {
    keys: ['Ctrl', 'Shift', 'F'],
    description: '打开搜索面板',
    category: 'panels'
  }
]

export const SHORTCUT_CATEGORIES = {
  tools: '工具',
  edit: '编辑',
  view: '视图',
  selection: '选择',
  actions: '操作',
  panels: '面板'
} as const
