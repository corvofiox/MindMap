/**
 * Canvas access control for MCP tool calls.
 *
 * An agent authenticates as a user (personal access token), so every canvas it
 * names must be re-checked against that user's project membership — a token must
 * never widen the reach of the account behind it. This mirrors the ownership rule
 * used by the rest of the server, and it now also mirrors the *role* rule:
 *
 *   owner  → read + write
 *   editor → read + write
 *   viewer → read only
 *
 * That last line used to be missing here while REST (`checkProjectAccess`) and
 * the WebSocket room both enforced it. The result was a real privilege
 * escalation: a read-only collaborator could rewrite or delete any canvas with
 * their own token. `canEdit` is therefore part of the access result, not
 * something individual tools are trusted to remember.
 */
import { db } from '../database/connection.js'
import { canvases } from '../database/schema.js'
import { eq } from 'drizzle-orm'
import { getProperty } from '../utils/transformResponse.js'
import { resolveProjectAccess, type ProjectRole } from '../domain/access.js'

export type { ProjectRole }

export interface CanvasAccess {
  canvasId: number
  projectId: number
  canvasName: string | null
  projectName: string | null
  /** Effective role of the calling user in the project. */
  role: ProjectRole
  /** True only for owner/editor. Every mutating tool must require this. */
  canEdit: boolean
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

  const project = await resolveProjectAccess(projectId, userId)
  if (!project || project.role === null) {
    return { status: 'denied', reason: 'forbidden' }
  }

  return {
    status: 'ok',
    access: {
      canvasId,
      projectId,
      canvasName: (canvas.name as string | undefined) ?? null,
      projectName: project.projectName,
      role: project.role,
      canEdit: project.canEdit,
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

/**
 * Message for a caller that may read but not write.
 *
 * Separate from `accessErrorMessage` on purpose: "you are a read-only member" is
 * actionable (ask the owner for editor rights) while "forbidden" suggests the
 * canvas is invisible, which would be wrong — the same token can read it fine.
 */
export function readOnlyErrorMessage(canvasId: number): string {
  return (
    `无权修改画布 ${canvasId}：当前账号在该项目里是只读（viewer）成员，` +
    `只能读取。请让项目所有者把你的角色改为 editor 后重试。`
  )
}
