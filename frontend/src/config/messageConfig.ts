// 消息系统配置

// Toast 配置
export interface ToastConfig {
  // 默认持续时间（毫秒）
  defaultDuration: number
  // 最大显示数量
  maxToasts: number
  // 默认标题
  defaultTitles: {
    success: string
    error: string
    warning: string
    info: string
  }
}

// Dialog 配置
export interface DialogConfig {
  // 默认 z-index
  defaultZIndex: number
  // 默认是否显示关闭按钮
  defaultShowCloseButton: boolean
  // 默认是否按 ESC 关闭
  defaultCloseOnEscape: boolean
  // 默认是否点击外部关闭
  defaultCloseOnOutsideClick: boolean
}

// 上下文菜单配置
export interface ContextMenuConfig {
  // 默认 z-index
  defaultZIndex: number
  // 是否支持键盘导航
  enableKeyboardNavigation: boolean
}

// 消息系统配置
export interface MessageConfig {
  toast: ToastConfig
  dialog: DialogConfig
  contextMenu: ContextMenuConfig
}

// 默认配置
export const messageConfig: MessageConfig = {
  toast: {
    defaultDuration: 3000,
    maxToasts: 5,
    defaultTitles: {
      success: '成功',
      error: '错误',
      warning: '警告',
      info: '提示'
    }
  },
  dialog: {
    defaultZIndex: 110,
    defaultShowCloseButton: true,
    defaultCloseOnEscape: true,
    defaultCloseOnOutsideClick: true
  },
  contextMenu: {
    defaultZIndex: 80,
    enableKeyboardNavigation: true
  }
}

// 获取 Toast 配置
export const getToastConfig = (): ToastConfig => {
  return messageConfig.toast
}

// 获取 Dialog 配置
export const getDialogConfig = (): DialogConfig => {
  return messageConfig.dialog
}

// 获取上下文菜单配置
export const getContextMenuConfig = (): ContextMenuConfig => {
  return messageConfig.contextMenu
}
