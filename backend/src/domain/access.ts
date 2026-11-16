/**
 * Project access — the single source of truth for "may this user act on this project".
 *
 * Why this file exists: the canvas REST controller, the WebSocket room and the MCP
 * tools each used to answer that question with their own query. They drifted. The
 * MCP copy forgot to look at `role`, so a viewer could rewrite a canvas through a
 * personal access token while the very same account was read-only in the UI.
 *
 * Everything now goes through `resolveProjectAccess`; new call sites cannot
 * accidentally invent a weaker rule.
 */
import { db } from '../database/connection.js'
import { projects, projectMembers } from '../database/schema.js'
import { eq, and } from 'drizzle-orm'
import { getProperty } from '../utils/transformResponse.js'

export type ProjectRole = 'owner' | 'editor' | 'viewer'

export interface ProjectAccess {
  projectId: number
  /** Project name, for messages that name the project instead of the id. */
  projectName: string | null
  /** True when `userId` owns the project row. */
  isOwner: boolean
  /** True when an explicit `project_members` row exists. */
  isMember: boolean
  /** Effective role; null only when the project does not exist. */
  role: ProjectRole | null
  /** Owner or editor. Every mutating path must require this. */
  canEdit: boolean
}

/**
 * Resolve membership + role, or null when the project row is missing.
 *
 * Unknown role strings degrade to `viewer`: a corrupted or future value must never
 * silently grant write access.
 */
export async function resolveProjectAccess(
  projectId: number,
  userId: number,
): Promise<ProjectAccess | null> {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  })
  if (!project) return null

  const projectOwnerId =
    getProperty<number>(project, 'owner_id', 'ownerId') || project.ownerId

  if (projectOwnerId === userId) {
    return {
      projectId,
      projectName: (project.name as string | undefined) ?? null,
      isOwner: true,
      isMember: true,
      role: 'owner',
      canEdit: true,
    }
  }

  const member = await db.query.projectMembers.findFirst({
    where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)),
  })
  if (!member || member.id === undefined) {
    return {
      projectId,
      projectName: (project.name as string | undefined) ?? null,
      isOwner: false,
      isMember: false,
      role: null,
      canEdit: false,
    }
  }

  const role: ProjectRole = member.role === 'editor' ? 'editor' : 'viewer'
  return {
    projectId,
    projectName: (project.name as string | undefined) ?? null,
    isOwner: false,
    isMember: true,
    role,
    canEdit: role === 'editor',
  }
}
