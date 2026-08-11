/**
 * 协作模式判定工具。
 *
 * 产品语义：仅协作项目(isCollaborative=true，即被邀请过成员的项目)启用
 * WS 协作(房间人数/实时同步/协作保存)，私人项目一律走单机 REST 保存路径。
 * 此判定集中于此纯函数，CanvasPage 与后续调用方共用，避免判定逻辑漂移。
 */

interface CanvasLike {
  id: number
  tempId?: number
  projectId: number
}

interface ProjectLike {
  id: number
  isCollaborative: boolean
}

/**
 * 解析某画布是否属于协作项目。
 * - 画布按 id 或 tempId(新建中临时画布)匹配；
 * - 画布不存在 / 项目不存在 / 项目非协作 → false(不启用协作)。
 */
export function resolveCanvasIsCollaborative(
  canvases: CanvasLike[],
  projects: ProjectLike[],
  canvasId: number | null,
): boolean {
  if (!canvasId) return false
  const canvas = canvases.find((c) => c.id === canvasId || c.tempId === canvasId)
  if (!canvas) return false
  return projects.find((p) => p.id === canvas.projectId)?.isCollaborative ?? false
}
