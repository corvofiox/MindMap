/**
 * 连线弯折点（bend point）的几何计算。
 *
 * 从 CanvasPage 抽出：这些是纯几何函数、与 React 无关。抽出来的直接原因是
 * 「插在哪一段」决定了新点在 `connection.bendPoints` 数组里的**位置**，而
 * 折线渲染是完全按该数组顺序连点的 —— 顺序一旦错位，对端就会把线画成折返
 * （交叉）而本地看着正常。顺序语义需要被单测钉住，所以计算逻辑必须可测。
 */

/** 计算新增弯折点的默认落点（用户没在线上点击时用）。 */
export function calculateOptimalBendPoint(
  fromX: number, fromY: number,
  toX: number, toY: number
): { x: number; y: number } {
  const dx = toX - fromX
  const dy = toY - fromY

  const distance = Math.sqrt(dx * dx + dy * dy)
  if (distance < 100) {
    return { x: (fromX + toX) / 2, y: fromY }
  }

  return { x: fromX + dx / 3, y: fromY }
}

/** 点到线段的距离（用于找点击位置离哪一段最近）。 */
export function pointToLineSegmentDistance(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number
): number {
  const A = px - x1
  const B = py - y1
  const C = x2 - x1
  const D = y2 - y1

  const dot = A * C + B * D
  const lenSq = C * C + D * D

  if (lenSq === 0) return Math.sqrt(A * A + B * B)

  let param = -1
  if (lenSq !== 0) param = dot / lenSq

  let xx, yy
  if (param < 0) {
    xx = x1
    yy = y1
  } else if (param > 1) {
    xx = x2
    yy = y2
  } else {
    xx = x1 + param * C
    yy = y1 + param * D
  }

  const dx = px - xx
  const dy = py - yy

  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * 求新弯折点应插入 `bendPoints` 的索引：先找出点击位置离「起点→各弯折点→
 * 终点」这条折线的哪一段最近，再把新点插到那一段中间。
 *
 * 注意它**可能返回 0**（点在更前面的一段上）—— 也就是说新点未必追加在末尾。
 * 调用方（store / Yjs 绑定）必须真正按这个索引插入，否则本地顺序与共享文档
 * 顺序不一致。
 */
export function findBendPointInsertIndex(
  clickX: number, clickY: number,
  fromX: number, fromY: number,
  toX: number, toY: number,
  bendPoints: { x: number; y: number }[]
): number {
  if (bendPoints.length === 0) return 0

  // Build all points including endpoints
  const allPoints = [
    { x: fromX, y: fromY },
    ...bendPoints,
    { x: toX, y: toY }
  ]

  // Find which line segment is closest to the click point
  let minDistance = Infinity
  let insertIndex = 0

  for (let i = 0; i < allPoints.length - 1; i++) {
    const p1 = allPoints[i]
    const p2 = allPoints[i + 1]
    const distance = pointToLineSegmentDistance(clickX, clickY, p1.x, p1.y, p2.x, p2.y)

    if (distance < minDistance) {
      minDistance = distance
      insertIndex = i
    }
  }

  return insertIndex
}
