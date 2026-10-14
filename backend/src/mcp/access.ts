/**
 * Canvas access control for MCP tool calls.
 *
 * An agent authenticates as a user (personal access token), so every canvas it
 * names must be re-checked against that user's project membership — a token must
 * never widen the reach of the account behind it. This mirrors the ownership rule
 * used by the collaboration controller: a project's owner, or an explicit
 * `project_members` row, grants access.
 */
import { db } from '../database/connection.js'
import { canvases, projects, projectMembers } from '../database/schema.js'
import { eq, and } from 'drizzle-orm'
import { getProperty } from '../utils/transformResponse.js'

export interface CanvasAccess {
  canvasId: number
  projectId: number
  canvasName: string | null
  projectName: string | null
}

/**
 * Access outcome.
 *
 * The discriminant is a string literal (`status`), not a boolean `ok` flag, and
 * that is load-bearing: this project compiles with `strict: false`, so
 * `strictNullChecks` is off and a boolean discriminant does NOT narrow a union
 * (TS2339 when reading `.reason`). String-literal discriminants narrow correctly.
 */
export type AccessResult =
  | { status: 'ok'; access: CanvasAccess }
  | { status: 'denied'; reason: 'not-found' | 'forbidden' }

/**
 * Resolve a canvas and confirm `userId` may act on it.
 *
 * 'not-found' and 'forbidden' are kept distinct so a tool can answer precisely,
 * but callers must not leak the distinction to untrusted output beyond what the
 * UI already shows (an unreadable canvas is simply "not found").
 */
export async function resolveCanvasAccess(
  canvasId: number,
  userId: number,
): Promise<AccessResult> {
  const canvas = await db.query.canvases.findFirst({
    where: eq(canvases.id, canvasId),
  })
  if (!canvas) {
    return { status: 'denied', reason: 'not-found' }
  }

  const projectId =
    getProperty<number>(canvas, 'project_id', 'projectId') ?? canvas.projectId
  if (!projectId) {
    return { status: 'denied', reason: 'forbidden' }
  }

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  })
  if (!project) {
    return { status: 'denied', reason: 'forbidden' }
  }

  const projectOwnerId =
    getProperty<number>(project, 'owner_id', 'ownerId') ?? project.ownerId
  if (projectOwnerId !== userId) {
    const member = await db.query.projectMembers.findFirst({
      where: and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
      ),
    })
    if (!member) {
      return { status: 'denied', reason: 'forbidden' }
    }
  }

  return {
    status: 'ok',
    access: {
      canvasId,
      projectId,
      canvasName: (canvas.name as string | undefined) ?? null,
      projectName: (project.name as string | undefined) ?? null,
    },
  }
}

/**
 * Turn a failed access check into a message an agent can act on.
 *
 * The wording is deliberate: it tells the caller whether to fix the id or to ask
 * a human for access, instead of a bare "error".
 */
export function accessErrorMessage(canvasId: number, reason: 'not-found' | 'forbidden'): string {
  return reason === 'not-found'
    ? `画布 ${canvasId} 不存在。请先用 listCanvases 获取有效画布 ID。`
    : `无权访问画布 ${canvasId}。当前令牌对应的用户不是该项目成员；请让项目所有者授予成员权限。`
}
