/**
 * 画布右侧悬浮覆盖层（缩放控件 / 小地图 / 在线头像）的避让布局工具。
 *
 * 背景：节点池面板与 AI 侧边栏是 `fixed right-0` 覆盖层（各 288px / 320px 宽），
 * 小地图固定在画布区域右上角（最短边恒为内容上限，最长边随内容宽高比在
 * MINIMAP_MAX_CONTENT_* 之间变化），协作头像栏则位于小地图**正下方**。
 * 画布内的悬浮覆盖层若不主动避让，会被这些面板/小地图覆盖而不可见。
 * 此处集中偏移量，避免 ZoomControls / CanvasMinimap / UserAvatars 三处漂移。
 *
 * 注意：小地图的**实际**尺寸是运行时算出来的，常量只能表示上限。头像栏的纵向
 * 起点因此取自 store 里的 `minimapFrame`（由 CanvasMinimap 实时上报），
 * 而不是这里的 MAX 常量 —— 否则小地图偏小时，头像会被推得很远。
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

/**
 * 小地图外框最大高度 = 内容上限 + 上下 padding。
 * 用作 store 里 `minimapFrame` 的初始值；CanvasMinimap 挂载后上报真实值覆盖它。
 *
 * （原先还有一个 MINIMAP_MAX_FRAME_WIDTH_PX 常量，供协作头像栏按"小地图最大宽度"
 * 横向预留偏移。头像栏改为停在小地图正下方后它已无使用者 —— 留着反而会引诱人
 * 再按上限预留，故删除。）
 */
export const MINIMAP_MAX_FRAME_HEIGHT_PX =
  MINIMAP_MAX_CONTENT_HEIGHT_PX + MINIMAP_FRAME_PADDING_PX * 2

/** 悬浮覆盖层之间的安全间距。 */
export const OVERLAY_GAP_PX = 8

/** 小地图距画布顶部的距离（次级工具栏收起时）。 */
export const MINIMAP_TOP_PX = 16

/** 次级工具栏（如连线工具）展开时，小地图下移到的顶部距离。 */
export const MINIMAP_TOP_WITH_TOOLBAR_PX = 64