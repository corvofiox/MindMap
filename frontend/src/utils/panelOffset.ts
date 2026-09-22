/**
 * 画布右侧悬浮覆盖层（缩放控件 / 小地图 / 在线头像）的避让布局工具。
 *
 * 背景：节点池面板与 AI 侧边栏是 `fixed right-0` 覆盖层（各 288px / 320px 宽），
 * 小地图固定在画布区域右上角（top 16px，最长边 220x165，容器各 +4px padding）。
 * 画布内的悬浮覆盖层若不主动避让（左移或下移），会被这些面板/小地图覆盖而不可见。
 * 此处集中偏移量，避免 ZoomControls / CanvasMinimap / UserAvatars 三处漂移。
 */

/** 右侧面板（节点池 / AI 侧边栏）打开时，覆盖层需要让出的 right 值。 */
export function getRightPanelOffset(nodePoolOpen: boolean, aiSidebarOpen: boolean): string {
  if (aiSidebarOpen) return '20.5rem' // 320px + 16px margin
  if (nodePoolOpen) return '18.25rem' // 288px + 16px margin
  return '1rem' // right-4 = 16px
}

/** 小地图内容区最大尺寸（与 CanvasMinimap.calculateMinimapSize 的上限一致）。 */
export const MINIMAP_MAX_CONTENT_WIDTH_PX = 220
export const MINIMAP_MAX_CONTENT_HEIGHT_PX = 165

/** 小地图容器四周的 padding（canvas 的 margin）。 */
export const MINIMAP_FRAME_PADDING_PX = 4

/** 小地图外框最大尺寸 = 内容上限 + 两侧 padding。 */
export const MINIMAP_MAX_FRAME_WIDTH_PX =
  MINIMAP_MAX_CONTENT_WIDTH_PX + MINIMAP_FRAME_PADDING_PX * 2
export const MINIMAP_MAX_FRAME_HEIGHT_PX =
  MINIMAP_MAX_CONTENT_HEIGHT_PX + MINIMAP_FRAME_PADDING_PX * 2

/** 悬浮覆盖层之间的安全间距。 */
export const OVERLAY_GAP_PX = 8