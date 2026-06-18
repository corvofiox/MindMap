import { Router } from 'express'
import { db, scheduleSave } from '../database/connection.js'
import { canvases, folders, projects, projectMembers } from '../database/schema.js'
import { eq, inArray, and } from 'drizzle-orm'
import { authenticate, type AuthRequest } from '../middleware/auth.middleware.js'
import { asyncHandler } from '../middleware/error.middleware.js'
import { transformResponse, transformResponseArray, getProperty } from '../utils/transformResponse.js'
import { log } from '../utils/logger.js'
import { getCanvasActiveUsers } from '../websocket/index.js'
import { loadCanvasStateFromDb, mergeJsonSnapshotIntoCanvas } from '../websocket/canvas-state.js'

export const canvasRouter = Router()

const postSaveMutexes = new Map<number, Promise<void>>()
const MUTEX_TIMEOUT = 30000

async function withPostSaveMutex<T>(canvasId: number, fn: () => Promise<T>): Promise<T> {
  const prev = (postSaveMutexes.get(canvasId) ?? Promise.resolve()).catch(() => {})

  // Execute fn() inside the chain so the mutex always waits for fn() to fully complete
  let done = false
  const next = prev.then(async () => {
    try {
      return await fn()
    } finally {
      done = true
    }
  })

  // The mutex guard resolves only after fn() finishes (or errors), preventing
  // the next queued operation from starting before the current one is done
  const cleanupGuard = next.then(() => {}, () => {})
  postSaveMutexes.set(canvasId, cleanupGuard)

  // Auto-cleanup stale mutex entry after resolution: if no new POST has been
  // queued for this canvas (entry still points to our guard), remove it
  cleanupGuard.finally(() => {
    if (postSaveMutexes.get(canvasId) === cleanupGuard) {
      postSaveMutexes.delete(canvasId)
    }
  })

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Canvas save timed out')), MUTEX_TIMEOUT),
  )

  try {
    return await Promise.race([next, timeoutPromise])
  } catch (error) {
    // If timed out, wait for fn() to actually finish before propagating the error.
    // This ensures mutex integrity — the next operation won't start until fn() completes.
    if (!done) {
      await next.catch(() => {})
    }
    throw error
  }
}

async function checkProjectAccess(projectId: number, userId: number): Promise<{ isOwner: boolean; isMember: boolean; canEdit: boolean; role: string | null }> {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  })

  if (!project) {
    return { isOwner: false, isMember: false, canEdit: false, role: null }
  }

  const projectOwnerId = getProperty<number>(project, 'owner_id', 'ownerId') || project.ownerId
  const isOwner = projectOwnerId === userId

  const member = await db.query.projectMembers.findFirst({
    where: and(
      eq(projectMembers.projectId, projectId),
      eq(projectMembers.userId, userId)
    ),
  })

  const isMember = member && member.id !== undefined
  const role = isOwner ? 'owner' : (member?.role || null)
  const canEdit = isOwner || (isMember && member?.role === 'editor')

  return { isOwner, isMember, canEdit, role }
}

// Get canvas by ID (more specific route must come first)
canvasRouter.get('/detail/:id', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const canvasId = parseInt(req.params.id, 10)
  if (isNaN(canvasId)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid canvas ID format',
    })
  }

  const canvas = await db.query.canvases.findFirst({
    where: eq(canvases.id, canvasId),
  })

  if (!canvas) {
    return res.status(404).json({
      success: false,
      error: '画布未找到',
    })
  }

  const transformedCanvas = transformResponse(canvas, ['createdAt', 'updatedAt'])

  res.json({
    success: true,
    data: transformedCanvas,
  })
}))

// Get canvases for project (more generic route must come after)
canvasRouter.get('/:projectId', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const projectId = parseInt(req.params.projectId, 10)
  if (isNaN(projectId)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid project ID format',
    })
  }

  const access = await checkProjectAccess(projectId, req.user!.id)

  if (!access.isOwner && !access.isMember) {
    return res.status(403).json({
      success: false,
      error: '访问被拒绝',
    })
  }

  const projectCanvases = await db.query.canvases.findMany({
    where: eq(canvases.projectId, projectId),
    orderBy: (canvases, { asc }) => [asc(canvases.sortOrder)],
  })

  const transformedCanvases = transformResponseArray(projectCanvases, ['createdAt', 'updatedAt'])

  const canvasesWithActiveUsers = transformedCanvases.map(canvas => ({
    ...canvas,
    activeUsers: getCanvasActiveUsers(canvas.id),
  }))

  res.json({
    success: true,
    data: canvasesWithActiveUsers,
  })
}))

// Create canvas
canvasRouter.post('/:projectId', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const projectId = parseInt(req.params.projectId, 10)
  if (isNaN(projectId)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid project ID format',
    })
  }

  const { name, folderId } = req.body

  const access = await checkProjectAccess(projectId, req.user!.id)

  if (!access.canEdit) {
    return res.status(403).json({
      success: false,
      error: '访问被拒绝',
    })
  }

  const [newCanvas] = await db
    .insert(canvases)
    .values({
      name,
      projectId,
      folderId: folderId || null,
    })
    .returning()

  await db
    .update(projects)
    .set({ updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(projects.id, projectId))

  scheduleSave()

  const transformedCanvas = transformResponse(newCanvas, ['createdAt', 'updatedAt'])

  res.json({
    success: true,
    data: transformedCanvas,
  })
}))

// Update canvas
canvasRouter.put('/:id', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const canvasId = parseInt(req.params.id, 10)
  if (isNaN(canvasId)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid canvas ID format',
    })
  }

  const { name, yjsData, previewText, thumbnail, folderId, sortOrder, clientVersion } = req.body

  log('PUT canvas - Start', { canvasId, userId: req.user!.id, body: { name, yjsData: typeof yjsData, previewText, thumbnail, folderId, sortOrder, clientVersion } })

  try {
    const canvas = await db.query.canvases.findFirst({
      where: eq(canvases.id, canvasId),
    })

    log('PUT canvas - Canvas query result', { canvasId, canvasFound: !!canvas, canvas: canvas ? JSON.stringify(canvas) : null })

    if (!canvas) {
      log('PUT canvas - Canvas not found', { canvasId })
      return res.status(404).json({
        success: false,
        error: '画布未找到',
      })
    }

    const canvasProjectId = getProperty<number>(canvas, 'project_id', 'projectId') || canvas.projectId

    const access = await checkProjectAccess(canvasProjectId, req.user!.id)

    if (!access.canEdit) {
      log('PUT canvas - Access denied', { canvasId, userId: req.user!.id })
      return res.status(403).json({
        success: false,
        error: '访问被拒绝',
      })
    }

    // P1 修复：缩略图并发保护。协作模式下多用户各自生成缩略图并发 PUT，
    // 旧版本（基于过时画布状态）的缩略图会覆盖新版本。当客户端带 clientVersion
    // 时，复用 POST /data 的 mutex + 版本检查模式：若服务端内存版本已超过
    // clientVersion，说明画布已被更新，本次缩略图过期，返回 409 让客户端静默跳过。
    // 缩略图是"尽力而为"的展示辅助，过期丢弃比覆盖更安全。
    //
    // 注意：本分支假定 payload 仅含缩略图（前端 generateThumbnail 只发
    // { thumbnail, clientVersion }）。若未来在同一请求附带 name/yjsData 等其他
    // 可写字段，它们会被此分支忽略（仅写 thumbnail+updatedAt）。下方日志会在
    // 检测到其他字段时记录，便于及时发现该误用模式。
    if (thumbnail !== undefined && typeof clientVersion === 'number') {
      if (name !== undefined || yjsData !== undefined || previewText !== undefined
        || folderId !== undefined || sortOrder !== undefined) {
        log('PUT canvas - version-checked thumbnail branch received extra writable fields', {
          canvasId,
          hasName: name !== undefined,
          hasYjsData: yjsData !== undefined,
          hasPreviewText: previewText !== undefined,
          hasFolderId: folderId !== undefined,
          hasSortOrder: sortOrder !== undefined,
        })
      }
      // If yjsData is also present in this request, merge it into the Yjs doc
      // before continuing with the thumbnail-only update, so it's not discarded.
      if (yjsData !== undefined) {
        log('PUT canvas - Thumbnail branch also has yjsData; merging first', { canvasId })
        try {
          const jsonStr = Buffer.from(yjsData, 'base64').toString('utf-8')
          const snapshot = JSON.parse(jsonStr)
          await mergeJsonSnapshotIntoCanvas(canvasId, {
            nodes: Array.isArray(snapshot.nodes) ? snapshot.nodes : [],
            groups: Array.isArray(snapshot.groups) ? snapshot.groups : [],
            domains: Array.isArray(snapshot.domains) ? snapshot.domains : [],
            connections: Array.isArray(snapshot.connections) ? snapshot.connections : [],
          })
        } catch (err) {
          log('PUT canvas - Failed to merge yjsData into Yjs doc in thumbnail branch', {
            canvasId,
            error: err instanceof Error ? err.message : String(err),
          })
          return res.status(400).json({
            success: false,
            error: 'Failed to merge canvas data: invalid or corrupt yjsData',
          })
        }
      }
      return await withPostSaveMutex(canvasId, async () => {

        const updateData: Record<string, unknown> = {
          updatedAt: Math.floor(Date.now() / 1000),
          thumbnail,
        }

        log('PUT canvas - Thumbnail update (version-checked)', { canvasId, clientVersion })

        const [updatedCanvas] = await db
          .update(canvases)
          .set(updateData)
          .where(eq(canvases.id, canvasId))
          .returning()

        if (canvasProjectId) {
          await db
            .update(projects)
            .set({ updatedAt: Math.floor(Date.now() / 1000) })
            .where(eq(projects.id, canvasProjectId))
        }

        scheduleSave()

        const transformedCanvas = transformResponse(updatedCanvas, ['createdAt', 'updatedAt'])
        res.json({ success: true, data: transformedCanvas })
      })
    }

    log('PUT canvas - About to update', { canvasId, updateData: { name, yjsData: typeof yjsData, previewText, thumbnail, folderId, sortOrder } })

    const updateData: any = {
      updatedAt: Math.floor(Date.now() / 1000),
    }

    if (name !== undefined) {
      updateData.name = name
    }
    if (yjsData !== undefined) {
      log('PUT canvas - yjsData provided; merging into Yjs doc instead of legacy column', { canvasId })
      try {
        const jsonStr = Buffer.from(yjsData, 'base64').toString('utf-8')
        const snapshot = JSON.parse(jsonStr)
        await mergeJsonSnapshotIntoCanvas(canvasId, {
          nodes: Array.isArray(snapshot.nodes) ? snapshot.nodes : [],
          groups: Array.isArray(snapshot.groups) ? snapshot.groups : [],
          domains: Array.isArray(snapshot.domains) ? snapshot.domains : [],
          connections: Array.isArray(snapshot.connections) ? snapshot.connections : [],
        })
      } catch (err) {
        log('PUT canvas - Failed to merge yjsData into Yjs doc, returning error', {
          canvasId,
          error: err instanceof Error ? err.message : String(err),
        })
        return res.status(400).json({
          success: false,
          error: 'Failed to merge canvas data: invalid or corrupt yjsData',
        })
      }
    }
    if (previewText !== undefined) {
      updateData.previewText = previewText
    }
    if (thumbnail !== undefined) {
      updateData.thumbnail = thumbnail
    }
    if (folderId !== undefined) {
      updateData.folderId = folderId
    }
    if (sortOrder !== undefined) {
      updateData.sortOrder = sortOrder
    }

    log('PUT canvas - Final update data', { canvasId, updateData })

    const [updatedCanvas] = await db
      .update(canvases)
      .set(updateData)
      .where(eq(canvases.id, canvasId))
      .returning()

    if (canvasProjectId) {
      await db
        .update(projects)
        .set({ updatedAt: Math.floor(Date.now() / 1000) })
        .where(eq(projects.id, canvasProjectId))
    }

    scheduleSave()

    log('PUT canvas - Success', { canvasId })

    const transformedCanvas = transformResponse(updatedCanvas, ['createdAt', 'updatedAt'])

    res.json({
      success: true,
      data: transformedCanvas,
    })
  } catch (error) {
    log('PUT canvas - Error', { canvasId, error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}))

// Delete canvas
canvasRouter.delete('/:id', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const canvasId = parseInt(req.params.id, 10)
  if (isNaN(canvasId)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid canvas ID format',
    })
  }

  log('DELETE canvas - Start', { canvasId, userId: req.user!.id })

  const canvas = await db.query.canvases.findFirst({
    where: eq(canvases.id, canvasId),
  })

  if (!canvas) {
    log('DELETE canvas - Canvas not found', { canvasId })
    return res.status(404).json({
      success: false,
      error: '画布未找到',
    })
  }

  const canvasProjectId = getProperty<number>(canvas, 'project_id', 'projectId') || canvas.projectId

  log('DELETE canvas - Canvas found', { canvasId, projectId: canvasProjectId, canvas: JSON.stringify(canvas) })

  try {
    log('DELETE canvas - About to check access', { canvasId, projectId: canvasProjectId })

    const access = await checkProjectAccess(canvasProjectId, req.user!.id)

    log('DELETE canvas - Access check result', { canvasId, access })

    if (!access.canEdit) {
      log('DELETE canvas - Access denied', { canvasId, userId: req.user!.id })
      return res.status(403).json({
        success: false,
        error: '访问被拒绝',
      })
    }

    await db.delete(canvases).where(eq(canvases.id, canvasId))
    postSaveMutexes.delete(canvasId)

    if (canvasProjectId) {
      await db
        .update(projects)
        .set({ updatedAt: Math.floor(Date.now() / 1000) })
        .where(eq(projects.id, canvasProjectId))
    }

    scheduleSave()

    log('DELETE canvas - Success', { canvasId })
    res.json({
      success: true,
      data: { message: 'Canvas deleted' },
    })
  } catch (error) {
    log('DELETE canvas - Error', { canvasId, error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}))

// Save canvas nodes data via POST (for sendBeacon support during page unload)
canvasRouter.post('/:id/data', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const canvasId = parseInt(req.params.id, 10)
  if (isNaN(canvasId)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid canvas ID format',
    })
  }

  const canvas = await db.query.canvases.findFirst({
    where: eq(canvases.id, canvasId),
  })

  if (!canvas) {
    return res.status(404).json({
      success: false,
      error: '画布未找到',
    })
  }

  const canvasProjectId = getProperty<number>(canvas, 'project_id', 'projectId') || canvas.projectId

  const access = await checkProjectAccess(canvasProjectId, req.user!.id)

  if (!access.canEdit) {
    return res.status(403).json({
      success: false,
      error: '访问被拒绝',
    })
  }

  await withPostSaveMutex(canvasId, async () => {
    const { nodes, groups, domains, connections } = req.body

    // Yjs: 单用户保存直接把客户端 JSON 快照合并进 doc。CRDT 自动处理字段级合并，
    // 不再需要版本号乐观锁——并发保存会被 Y.Doc 的 update 事件正确归并。
    // 注意：只合并请求体中实际存在的集合，避免把未提供的集合误删为空。
    const hasContent = nodes !== undefined || groups !== undefined
      || domains !== undefined || connections !== undefined
    if (hasContent) {
      const snapshot: { nodes?: unknown[]; groups?: unknown[]; domains?: unknown[]; connections?: unknown[] } = {}
      if (Array.isArray(nodes)) snapshot.nodes = nodes
      if (Array.isArray(groups)) snapshot.groups = groups
      if (Array.isArray(domains)) snapshot.domains = domains
      if (Array.isArray(connections)) snapshot.connections = connections
      await mergeJsonSnapshotIntoCanvas(canvasId, snapshot)
      // mergeJsonSnapshotIntoCanvas 通过 applyUpdate 触发 doc update 事件，
      // 进而触发 schedulePersistCanvasState，无需手动写库。
    } else {
      // 无内容变更也要确保 doc 已加载（供后续读取一致）
      await loadCanvasStateFromDb(canvasId)
    }

    scheduleSave()
    log('POST canvas data - Saved (Yjs merge)', { canvasId })

    res.json({
      success: true,
      data: { message: 'Canvas data saved' },
    })
  })
}))

// Get folders for project
canvasRouter.get(
  '/:projectId/folders',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const projectId = parseInt(req.params.projectId, 10)
    if (isNaN(projectId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid project ID format',
      })
    }

    const access = await checkProjectAccess(projectId, req.user!.id)

    if (!access.isOwner && !access.isMember) {
      return res.status(403).json({
        success: false,
        error: '访问被拒绝',
      })
    }

    const projectFolders = await db.query.folders.findMany({
      where: eq(folders.projectId, projectId),
      orderBy: (folders, { asc }) => [asc(folders.sortOrder)],
    })

    res.json({
      success: true,
      data: projectFolders,
    })
  })
)

// Create folder
canvasRouter.post(
  '/:projectId/folders',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const projectId = parseInt(req.params.projectId, 10)
    if (isNaN(projectId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid project ID format',
      })
    }

    const { name, parentId } = req.body

    const access = await checkProjectAccess(projectId, req.user!.id)

    if (!access.canEdit) {
      return res.status(403).json({
        success: false,
        error: '访问被拒绝',
      })
    }

    const result = await db
      .insert(folders)
      .values({
        name,
        projectId,
        parentId: parentId || null,
      })
      .returning()

    const [newFolder] = result || []

    scheduleSave()

    res.json({
      success: true,
      data: newFolder,
    })
  })
)

// Update folder
canvasRouter.put(
  '/folders/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const folderId = parseInt(req.params.id, 10)
    if (isNaN(folderId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid folder ID format',
      })
    }

    const { name } = req.body

    const folder = await db.query.folders.findFirst({
      where: eq(folders.id, folderId),
    })

    if (!folder) {
      return res.status(404).json({
        success: false,
        error: '文件夹未找到',
      })
    }

    const folderProjectId = getProperty<number>(folder, 'project_id', 'projectId') || folder.projectId

    const access = await checkProjectAccess(folderProjectId, req.user!.id)

    if (!access.canEdit) {
      return res.status(403).json({
        success: false,
        error: '访问被拒绝',
      })
    }

    const result = await db
      .update(folders)
      .set({
        name: name || folder.name,
      })
      .where(eq(folders.id, folderId))
      .returning()

    const [updatedFolder] = result || []

    if (folderProjectId) {
      await db
        .update(projects)
        .set({ updatedAt: Math.floor(Date.now() / 1000) })
        .where(eq(projects.id, folderProjectId))
    }

    scheduleSave()

    res.json({
      success: true,
      data: updatedFolder,
    })
  })
)

// Delete folder
canvasRouter.delete(
  '/folders/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const folderId = parseInt(req.params.id, 10)
    if (isNaN(folderId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid folder ID format',
      })
    }

    const folder = await db.query.folders.findFirst({
      where: eq(folders.id, folderId),
    })

    if (!folder) {
      return res.status(404).json({
        success: false,
        error: '文件夹未找到',
      })
    }

    const folderProjectId = getProperty<number>(folder, 'project_id', 'projectId') || folder.projectId

    const access = await checkProjectAccess(folderProjectId, req.user!.id)

    if (!access.canEdit) {
      return res.status(403).json({
        success: false,
        error: '访问被拒绝',
      })
    }

    // Collect all folder IDs to delete (including subfolders)
    const folderIdsToDelete: number[] = []

    // Use a queue-based approach to collect all descendant folders
    const queue: number[] = [folderId]
    while (queue.length > 0) {
      const currentId = queue.shift()!
      folderIdsToDelete.push(currentId)

      // Find all immediate children of the current folder
      const childFolders = await db.query.folders.findMany({
        where: eq(folders.parentId, currentId),
      })

      for (const child of childFolders) {
        queue.push(child.id)
      }
    }

    log('DELETE folder - Deleting folders and their canvases', {
      folderId,
      totalFolders: folderIdsToDelete.length,
      folderIds: folderIdsToDelete,
    })

    // Delete all canvases in all folders to be deleted
    if (folderIdsToDelete.length > 0) {
      await db.delete(canvases).where(inArray(canvases.folderId, folderIdsToDelete))
    }

    // Delete all folders (including subfolders)
    // Delete in reverse order (children first) to respect foreign key constraints
    for (let i = folderIdsToDelete.length - 1; i >= 0; i--) {
      await db.delete(folders).where(eq(folders.id, folderIdsToDelete[i]))
    }

    if (folderProjectId) {
      await db
        .update(projects)
        .set({ updatedAt: Math.floor(Date.now() / 1000) })
        .where(eq(projects.id, folderProjectId))
    }

    log('DELETE folder - Success', { folderId, foldersDeleted: folderIdsToDelete.length })

    res.json({
      success: true,
      data: {
        message: 'Folder deleted',
        foldersDeleted: folderIdsToDelete.length,
      },
    })
  })
)
