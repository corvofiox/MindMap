export const Z_INDEX = {
  DOMAIN: 0,
  GROUP: 1,
  CONNECTION: 5,
  NODE: 10,
  // m-2: 协作覆盖层(远端光标/选区/在线头像)——内容层 data-canvas-content 带
  // zoom/transform 构成独立 stacking context,覆盖层需显式 z-index 才不被节点
  // 遮挡。取略高于 NODE 的最小可行值,低于 ZOOM_CONTROLS 保持小地图/缩放控件在上。
  COLLAB_OVERLAY: 15,
  BEND_POINT: 8,
  RICH_TEXT_TOOLBAR: 55,
  RICH_TEXT_POPOVER: 56,
  ZOOM_CONTROLS: 60,
  NODE_POOL_PANEL: 70,
  NODE_POOL_CONTEXT_MASK: 75,
  CONTEXT_MENU: 80,
  STYLE_PANEL: 80,
  SIDEBAR_SUBMENU: 90,
  DROPDOWN_MENU: 90,
  DIALOG: 100,
  SEARCH_PANEL: 100,
  COMMAND_PALETTE: 100,
  TOAST: 120,
  DRAG_GHOST: 1000,
} as const
