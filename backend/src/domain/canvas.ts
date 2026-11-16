/**
 * Canvas lifecycle domain service: the canvas *containers*, not their contents.
 *
 * Entity edits live in `mcp/canvas-ops.ts` (they have to go through the live Yjs
 * doc). This module owns the rows around them — create/rename/move/delete a canvas,
 * and the project-scoped folder tree the sidebar shows.
 *
 * Access rule: everything requires owner/editor on the owning project, resolved by
 * `resolveProjectAccess` so it cannot drift from REST or the WebSocket room.
 *
 * Deletion is irreversible — `canvas_recycle_bin` exists in the schema but nothing
 * writes to it, so a deleted canvas is gone. Tools must confirm before calling.
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../database/connection.js'
import { canvases, folders, projects, projectMembers } from '../database/schema.js'
import { DomainError, domainErrors } from './errors.js'
import { resolveProjectAccess, type ProjectAccess } from './access.js'
import { sanitizeTitle } from './rules.js'

export interface CanvasRow {
  canvasId: number
  name: string
  projectId: number
  folderId: number | null
  sortOrder: number
  updatedAt: number | null
  createdAt: number | null
  previewText: string | null
  hasThumbnail: boolean
}

export interface CanvasFolderRow {
  folderId: number
  name: string
  projectId: number
  parentId: number | null
  sortOrder: number
  path: string
  canvasCount: number
}

function toRow(row: Record<string, unknown>): CanvasRow {
  return {
    canvasId: Number(row.id),
    name: (row.name as string) ?? '',
    projectId: Number(row.projectId),
    folderId: row.folderId === null || row.folderId === undefined ? null : Number(row.folderId),
    sortOrder: Number(row.sortOrder ?? 0),
    updatedAt: row.updatedAt === null || row.updatedAt === undefined ? null : Number(row.updatedAt),
    createdAt: row.createdAt === null || row.createdAt === undefined ? null : Number(row.createdAt),
    previewText: (row.previewText as string | null) ?? null,
    hasThumbnail: Boolean(row.thumbnail),
  }
}

/** Project access, or a domain error explaining why not. */
export async function requireProjectEditor(
  userId: number,
  projectId: number,
): Promise<ProjectAccess> {
  const access = await resolveProjectAccess(projectId, userId)
  if (!access || access.role === null) {
    throw domainErrors.notFound(`项目 ${projectId} `, '先用 canvasList 查看可访问的项目。')
  }
  if (!access.canEdit) {
    throw domainErrors.forbidden(
      `无权修改项目 ${projectId}：当前账号在该项目里是只读（viewer）成员`,
      '请项目所有者把你的角色改为 editor 后重试。',
    )
  }
  return access
}

/** Canvas row + editor access, or a domain error. */
export async function requireCanvasEditor(
  userId: number,
  canvasId: number,
): Promise<{ row: Record<string, unknown>; access: ProjectAccess }> {
  const row = await db.query.canvases.findFirst({ where: eq(canvases.id, canvasId) })
  if (!row) {
    throw domainErrors.notFound(`画布 ${canvasId} `, '先用 canvasList 获取有效画布 ID。')
  }
  const projectId = Number((row as Record<string, unknown>).projectId)
  const access = await requireProjectEditor(userId, projectId)
  return { row: row as Record<string, unknown>, access }
}

/** Every canvas the account can see: owned projects plus projects it belongs to. */
export async function listAccessibleCanvases(
  userId: number,
  projectId?: number,
): Promise<CanvasRow[]> {
  const owned = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.ownerId, userId))
  const memberRows = await db
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, userId))

  const accessible = Array.from(
    new Set([...owned.map((p) => Number(p.id)), ...memberRows.map((m) => Number(m.projectId))]),
  )
  if (accessible.length === 0) return []

  const targets = projectId !== undefined ? accessible.filter((id) => id === projectId) : accessible
  if (targets.length === 0) {
    throw domainErrors.notFound(`项目 ${projectId} `, '先用 canvasList 查看可访问的项目。')
  }

  const rows = await db
    .select()
    .from(canvases)
    .where(inArray(canvases.projectId, targets))
    .orderBy(desc(canvases.updatedAt))

  return rows.map((row) => toRow(row as Record<string, unknown>))
}

/** Resolve a canvas folder inside a project the caller may edit. */
async function requireFolderInProject(
  userId: number,
  projectId: number,
  folderId: number | null,
): Promise<void> {
  await requireProjectEditor(userId, projectId)
  if (folderId === null) return
  const folder = await db.query.folders.findFirst({ where: eq(folders.id, folderId) })
  if (!folder || Number((folder as Record<string, unknown>).projectId) !== projectId) {
    throw domainErrors.notFound(`文件夹 ${folderId} `, '先用 canvasFolderList 获取该项目下的文件夹 ID。')
  }
}

export async function createCanvas(
  userId: number,
  input: { projectId: number; name: string; folderId?: number | null },
): Promise<CanvasRow> {
  const name = sanitizeTitle(input.name)
  if (!name) throw domainErrors.validation('画布名称不能为空')
  await requireFolderInProject(userId, input.projectId, input.folderId ?? null)

  const now = Math.floor(Date.now() / 1000)
  const inserted = await db
    .insert(canvases)
    .values({
      name,
      projectId: input.projectId,
      folderId: input.folderId ?? null,
      sortOrder: 0,
      createdAt: now,
      updatedAt: Date.now(),
    })
    .returning()

  await db.update(projects).set({ updatedAt: now }).where(eq(projects.id, input.projectId))
  return toRow(inserted[0] as Record<string, unknown>)
}

export async function renameCanvas(
  userId: number,
  canvasId: number,
  name: string,
): Promise<CanvasRow> {
  const clean = sanitizeTitle(name)
  if (!clean) throw domainErrors.validation('画布名称不能为空')
  const { row } = await requireCanvasEditor(userId, canvasId)
  await db
    .update(canvases)
    .set({ name: clean, updatedAt: Date.now() })
    .where(eq(canvases.id, canvasId))
  return toRow({ ...row, name: clean })
}

export async function moveCanvas(
  userId: number,
  canvasId: number,
  input: { folderId: number | null; sortOrder?: number },
): Promise<CanvasRow> {
  const { row } = await requireCanvasEditor(userId, canvasId)
  const projectId = Number(row.projectId)
  await requireFolderInProject(userId, projectId, input.folderId)

  const updates: Record<string, unknown> = { folderId: input.folderId, updatedAt: Date.now() }
  if (input.sortOrder !== undefined) {
    if (!Number.isFinite(input.sortOrder)) throw domainErrors.validation('sortOrder 必须是数字')
    updates.sortOrder = Math.trunc(input.sortOrder)
  }
  await db.update(canvases).set(updates).where(eq(canvases.id, canvasId))
  return toRow({ ...row, ...updates })
}

/**
 * Delete a canvas for good.
 *
 * Order: close the room (so connected clients cannot send further updates), drop the
 * row, then drop the in-memory doc. `canvas_recycle_bin` is a legacy table nothing
 * writes to, so this is not a soft delete.
 *
 * The websocket module is imported lazily: this file is used by MCP tools, which are
 * also loaded by the stdio proxy where the WS layer is irrelevant.
 */
export async function deleteCanvas(
  userId: number,
  canvasId: number,
): Promise<{ canvasId: number; name: string }> {
  const { row } = await requireCanvasEditor(userId, canvasId)
  const projectId = Number(row.projectId)

  const { closeRoom } = await import('../websocket/index.js')
  const { removeCanvasState } = await import('../websocket/canvas-state.js')

  closeRoom(canvasId, 'canvas-deleted')
  await db.delete(canvases).where(eq(canvases.id, canvasId))
  removeCanvasState(canvasId)
  await db
    .update(projects)
    .set({ updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(projects.id, projectId))

  return { canvasId, name: (row.name as string) ?? '' }
}

// ---------------------------------------------------------------------------
// Canvas folders (project-scoped)
// ---------------------------------------------------------------------------

export async function listCanvasFolders(
  userId: number,
  projectId: number,
): Promise<CanvasFolderRow[]> {
  await requireProjectEditor(userId, projectId)

  const rows = await db
    .select()
    .from(folders)
    .where(eq(folders.projectId, projectId))
    .orderBy(asc(folders.sortOrder), asc(folders.id))

  const counts = await db
    .select({ folderId: canvases.folderId })
    .from(canvases)
    .where(eq(canvases.projectId, projectId))
  const countByFolder = new Map<number, number>()
  for (const row of counts) {
    const id = row.folderId === null || row.folderId === undefined ? null : Number(row.folderId)
    if (id !== null) countByFolder.set(id, (countByFolder.get(id) ?? 0) + 1)
  }

  const byId = new Map<number, Record<string, unknown>>()
  for (const row of rows) byId.set(Number(row.id), row as Record<string, unknown>)
  const pathOf = (id: number, seen = new Set<number>()): string => {
    const row = byId.get(id)
    if (!row || seen.has(id)) return ''
    seen.add(id)
    const name = (row.name as string) ?? ''
    const parentId = row.parentId === null || row.parentId === undefined ? null : Number(row.parentId)
    if (parentId === null) return name
    const parent = pathOf(parentId, seen)
    return parent ? `${parent}/${name}` : name
  }

  return rows.map((row) => {
    const id = Number(row.id)
    return {
      folderId: id,
      name: (row.name as string) ?? '',
      projectId: Number(row.projectId),
      parentId: row.parentId === null || row.parentId === undefined ? null : Number(row.parentId),
      sortOrder: Number(row.sortOrder ?? 0),
      path: pathOf(id),
      canvasCount: countByFolder.get(id) ?? 0,
    }
  })
}

export async function createCanvasFolder(
  userId: number,
  input: { projectId: number; name: string; parentId?: number | null },
): Promise<CanvasFolderRow> {
  const name = sanitizeTitle(input.name)
  if (!name) throw domainErrors.validation('文件夹名称不能为空')
  await requireFolderInProject(userId, input.projectId, input.parentId ?? null)

  const inserted = await db
    .insert(folders)
    .values({ name, projectId: input.projectId, parentId: input.parentId ?? null, sortOrder: 0 })
    .returning()

  return {
    folderId: Number(inserted[0].id),
    name,
    projectId: input.projectId,
    parentId: input.parentId ?? null,
    sortOrder: 0,
    path: name,
    canvasCount: 0,
  }
}

export async function updateCanvasFolder(
  userId: number,
  folderId: number,
  patch: { name?: string; parentId?: number | null; sortOrder?: number },
): Promise<{ folderId: number }> {
  const folder = await db.query.folders.findFirst({ where: eq(folders.id, folderId) })
  if (!folder) {
    throw domainErrors.notFound(`文件夹 ${folderId} `, '先用 canvasFolderList 获取文件夹 ID。')
  }
  const projectId = Number((folder as Record<string, unknown>).projectId)
  await requireProjectEditor(userId, projectId)

  const updates: Record<string, unknown> = {}
  if (patch.name !== undefined) {
    const name = sanitizeTitle(patch.name)
    if (!name) throw domainErrors.validation('文件夹名称不能为空')
    updates.name = name
  }
  if (patch.parentId !== undefined) {
    if (patch.parentId === folderId) throw domainErrors.validation('不能把文件夹移动到它自己里面')
    await requireFolderInProject(userId, projectId, patch.parentId)
    updates.parentId = patch.parentId
  }
  if (patch.sortOrder !== undefined) {
    if (!Number.isFinite(patch.sortOrder)) throw domainErrors.validation('sortOrder 必须是数字')
    updates.sortOrder = Math.trunc(patch.sortOrder)
  }
  if (Object.keys(updates).length === 0) {
    throw domainErrors.validation('没有提供任何要更新的字段', '至少给一个：name / parentId / sortOrder。')
  }

  await db.update(folders).set(updates).where(eq(folders.id, folderId))
  return { folderId }
}

/**
 * Delete a canvas folder subtree — including the canvases inside it.
 *
 * This is the most destructive operation exposed over MCP: canvases are hard-deleted
 * (no recycle bin), and every open room is closed. The reply reports counts so the
 * agent can tell the human what it cost.
 */
export async function deleteCanvasFolder(
  userId: number,
  folderId: number,
): Promise<{ folderId: number; deletedFolders: number; deletedCanvases: number }> {
  const folder = await db.query.folders.findFirst({ where: eq(folders.id, folderId) })
  if (!folder) {
    throw domainErrors.notFound(`文件夹 ${folderId} `, '先用 canvasFolderList 获取文件夹 ID。')
  }
  const projectId = Number((folder as Record<string, unknown>).projectId)
  await requireProjectEditor(userId, projectId)

  const all = await db.select().from(folders).where(eq(folders.projectId, projectId))
  const subtree = new Set<number>([folderId])
  let changed = true
  while (changed) {
    changed = false
    for (const item of all) {
      const parentId = item.parentId === null ? null : Number(item.parentId)
      if (parentId !== null && subtree.has(parentId) && !subtree.has(Number(item.id))) {
        subtree.add(Number(item.id))
        changed = true
      }
    }
  }

  const doomedCanvases = await db
    .select({ id: canvases.id })
    .from(canvases)
    .where(and(eq(canvases.projectId, projectId), inArray(canvases.folderId, [...subtree])))

  const { closeRoom } = await import('../websocket/index.js')
  const { removeCanvasState } = await import('../websocket/canvas-state.js')

  for (const canvas of doomedCanvases) {
    closeRoom(Number(canvas.id), 'folder-deleted')
    removeCanvasState(Number(canvas.id))
  }
  await db.delete(canvases).where(
    and(eq(canvases.projectId, projectId), inArray(canvases.folderId, [...subtree])),
  )
  await db.delete(folders).where(eq(folders.id, folderId))
  await db
    .update(projects)
    .set({ updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(projects.id, projectId))

  return {
    folderId,
    deletedFolders: subtree.size,
    deletedCanvases: doomedCanvases.length,
  }
}

export { DomainError }
