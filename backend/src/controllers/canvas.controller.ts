import { Router } from 'express'
import { db } from '../database/connection.js'
import { canvases, folders, projects, projectMembers } from '../database/schema.js'
import { eq, inArray, and, lte } from 'drizzle-orm'
import { authenticate, type AuthRequest } from '../middleware/auth.middleware.js'
import { asyncHandler } from '../middleware/error.middleware.js'
import { transformResponse, transformResponseArray, getProperty } from '../utils/transformResponse.js'
import { log } from '../utils/logger.js'
import { getCanvasActiveUsers, closeRoom, shouldUpsertOnlyForSnapshot } from '../websocket/index.js'
import { loadCanvasStateFromDb, mergeJsonSnapshotIntoCanvas, removeCanvasState, snapshotMissingDocEntities } from '../websocket/canvas-state.js'

export const canvasRouter = Router()

const postSaveMutexes = new Map<number, Promise<void>>()
const MUTEX_TIMEOUT = 30000

async function withPostSaveMutex<T>(canvasId: number, fn: () => Promise<T>): Promise<T> {
  const prev = (postSaveMutexes.get(canvasId) ?? Promise.resolve()).catch(() => { })

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
  const cleanupGuard = next.then(() => { }, () => { })
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
      await next.catch(() => { })
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
      // R3: 显式毫秒时间戳，避免走 schema 默认值 strftime('%s','now')（秒级）。
      // 秒级行会让升级前的两个并发缩略图 PUT 都通过 lte 检查（等值允许），
      // 且旧 bundle 的秒级 clientVersion 对新毫秒行会永久 409。
      updatedAt: Date.now(),
    })
    .returning()

  await db
    .update(projects)
    .set({ updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(projects.id, projectId))

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
      // Move yjsData merge inside mutex (Bug 2 fix) — previously this merged
      // outside the mutex and could interleave with concurrent WS operations.
      return await withPostSaveMutex(canvasId, async () => {
        if (yjsData !== undefined) {
          log('PUT canvas - Thumbnail branch also has yjsData; merging first', { canvasId })
          try {
            const jsonStr = Buffer.from(yjsData, 'base64').toString('utf-8')
            const parsed = JSON.parse(jsonStr)
            const snapshot: { nodes?: unknown[]; groups?: unknown[]; domains?: unknown[]; connections?: unknown[] } = {}
            if (Array.isArray(parsed.nodes)) snapshot.nodes = parsed.nodes
            if (Array.isArray(parsed.groups)) snapshot.groups = parsed.groups
            if (Array.isArray(parsed.domains)) snapshot.domains = parsed.domains
            if (Array.isArray(parsed.connections)) snapshot.connections = parsed.connections
            await loadCanvasStateFromDb(canvasId)
            // R1: 快照缺失 doc 实体 → upsertOnly（与 POST /data 一致）。
            const upsertOnly = snapshotMissingDocEntities(canvasId, snapshot)
              || shouldUpsertOnlyForSnapshot(canvasId)
            await mergeJsonSnapshotIntoCanvas(canvasId, snapshot, upsertOnly)
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

        const updateData: Record<string, unknown> = {
          // R3: 毫秒级时间戳作为乐观锁版本。秒级粒度下同一秒内的两个并发
          // 缩略图 PUT 都会通过 lte 检查（等值允许），锁形同虚设。
          updatedAt: Date.now(),
          thumbnail,
        }

        log('PUT canvas - Thumbnail update (version-checked)', { canvasId, clientVersion })

        const [updatedCanvas] = await db
          .update(canvases)
          .set(updateData)
          .where(and(
            eq(canvases.id, canvasId),
            // Optimistic lock: only update if the row hasn't been modified
            // since the client's snapshot. clientVersion is the updatedAt
            // the client knows about.
            lte(canvases.updatedAt, clientVersion),
          ))
          .returning()

        if (!updatedCanvas) {
          log('PUT canvas - Thumbnail version conflict, returning 409', { canvasId, clientVersion })
          return res.status(409).json({
            success: false,
            error: '缩略图版本过期，画布已被更新',
          })
        }

        if (canvasProjectId) {
          await db
            .update(projects)
            .set({ updatedAt: Math.floor(Date.now() / 1000) })
            .where(eq(projects.id, canvasProjectId))
        }

        const transformedCanvas = transformResponse(updatedCanvas, ['createdAt', 'updatedAt'])
        res.json({ success: true, data: transformedCanvas })
      })
    }

    log('PUT canvas - About to update', { canvasId, updateData: { name, yjsData: typeof yjsData, previewText, thumbnail, folderId, sortOrder } })

    const updateData: Record<string, unknown> = {
      // R3: 与缩略图版本检查分支保持同一精度（毫秒），否则该分支写入的秒级
      // 时间戳会把乐观锁版本"倒退回秒"，两个并发缩略图 PUT 又都能通过检查。
      updatedAt: Date.now(),
    }

    if (name !== undefined) {
      updateData.name = name
    }
    if (yjsData !== undefined) {
      log('PUT canvas - yjsData provided; merging into Yjs doc instead of legacy column', { canvasId })
      try {
        // Wrap in withPostSaveMutex to prevent TOCTOU race (C1/C2):
        // snapshotMissingDocEntities/shouldUpsertOnlyForSnapshot decision and
        // mergeJsonSnapshotIntoCanvas must be atomic with respect to concurrent
        // POST /data and WS save operations.
        await withPostSaveMutex(canvasId, async () => {
          const jsonStr = Buffer.from(yjsData, 'base64').toString('utf-8')
          const parsed = JSON.parse(jsonStr)
          const snapshot: { nodes?: unknown[]; groups?: unknown[]; domains?: unknown[]; connections?: unknown[] } = {}
          if (Array.isArray(parsed.nodes)) snapshot.nodes = parsed.nodes
          if (Array.isArray(parsed.groups)) snapshot.groups = parsed.groups
          if (Array.isArray(parsed.domains)) snapshot.domains = parsed.domains
          if (Array.isArray(parsed.connections)) snapshot.connections = parsed.connections
          await loadCanvasStateFromDb(canvasId)
          // R1: 快照缺失 doc 实体 → upsertOnly（与 POST /data 一致）。
          const upsertOnly = snapshotMissingDocEntities(canvasId, snapshot)
            || shouldUpsertOnlyForSnapshot(canvasId)
          await mergeJsonSnapshotIntoCanvas(canvasId, snapshot, upsertOnly)
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

    // Close the WebSocket room first so connected clients can't send further
    // updates to a canvas that is about to be deleted.
    closeRoom(canvasId, 'canvas-deleted')

    // Schema-level CASCADE handles ai_conversations and canvas_recycle_bin.
    await db.delete(canvases).where(eq(canvases.id, canvasId))
    postSaveMutexes.delete(canvasId)
    removeCanvasState(canvasId)

    if (canvasProjectId) {
      await db
        .update(projects)
        .set({ updatedAt: Math.floor(Date.now() / 1000) })
        .where(eq(projects.id, canvasProjectId))
    }

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
    const { nodes, groups, domains, connections, yjsData, deletedIds } = req.body

    // R1 幽灵复活修复：客户端本地删除声明（{ nodes?: string[], ... }）。
    // 快照缺失但客户端声明删除的实体视为"知情且主动删除"，允许全量合并执行
    // 删除（否则单用户离线删除会被 upsertOnly 吞掉而"复活"）。
    // 防御：单集合声明超过上限时忽略该集合（保守方向——不豁免 → upsertOnly），
    // 防止异常/恶意客户端用超大声明集绕过实体保护。
    const MAX_DELETED_IDS_PER_COLLECTION = 10_000
    const sanitizeDeletedIds = (arr: unknown[] | undefined): string[] | undefined => {
      if (!Array.isArray(arr)) return undefined
      const ids = arr.filter((x): x is string => typeof x === 'string')
      return ids.length > 0 && ids.length <= MAX_DELETED_IDS_PER_COLLECTION ? ids : undefined
    }
    const clientDeletedIds: { nodes?: string[]; groups?: string[]; domains?: string[]; connections?: string[] } | undefined =
      deletedIds && typeof deletedIds === 'object'
        ? {
            nodes: sanitizeDeletedIds(deletedIds.nodes),
            groups: sanitizeDeletedIds(deletedIds.groups),
            domains: sanitizeDeletedIds(deletedIds.domains),
            connections: sanitizeDeletedIds(deletedIds.connections),
          }
        : undefined

    // 先解析出统一的快照对象（兼容 yjsData 旧格式），再决定合并策略。
    let snapshot: { nodes?: unknown[]; groups?: unknown[]; domains?: unknown[]; connections?: unknown[] } | null = null

    // Handle yjsData (base64-encoded JSON snapshot) for backward compatibility
    // with old clients that send the snapshot as a single base64 field instead
    // of individual JSON arrays.
    if (yjsData !== undefined && typeof yjsData === 'string') {
      try {
        const jsonStr = Buffer.from(yjsData, 'base64').toString('utf-8')
        const parsed = JSON.parse(jsonStr)
        snapshot = {}
        if (Array.isArray(parsed.nodes)) snapshot.nodes = parsed.nodes
        if (Array.isArray(parsed.groups)) snapshot.groups = parsed.groups
        if (Array.isArray(parsed.domains)) snapshot.domains = parsed.domains
        if (Array.isArray(parsed.connections)) snapshot.connections = parsed.connections
      } catch (err) {
        log('POST canvas data - Failed to decode yjsData', {
          canvasId,
          error: err instanceof Error ? err.message : String(err),
        })
        return res.status(400).json({
          success: false,
          error: 'Failed to merge canvas data: invalid or corrupt yjsData',
        })
      }
    } else {
      // 只合并请求体中实际存在的集合，避免把未提供的集合误删为空。
      const hasContent = nodes !== undefined || groups !== undefined
        || domains !== undefined || connections !== undefined
      if (hasContent) {
        snapshot = {}
        if (Array.isArray(nodes)) snapshot.nodes = nodes
        if (Array.isArray(groups)) snapshot.groups = groups
        if (Array.isArray(domains)) snapshot.domains = domains
        if (Array.isArray(connections)) snapshot.connections = connections
      }
    }

    if (snapshot) {
      // R1: upsertOnly 判定（逐层保守）：
      // 1. 快照缺失 doc 中的实体（实体 ID 集合比对，排除客户端声明删除的
      //    实体）→ 全量合并会删除它们，可能是客户端不知道的他人编辑 →
      //    upsertOnly。精确覆盖"先后协作"、长窗口、服务端重启等一切时序，
      //    不依赖房间共处历史；
      // 2. 房间内有活跃用户 → 防止过期快照删除对端编辑（现状）；
      // 3. 房间刚拆除（15s 宽限期）且该画布曾多人协作 → 兜住"判定与 merge
      //    之间房间恰好拆除"的 TOCTOU 窗口。
      // 注意：withPostSaveMutex 只串行化其他 POST，不串行 WS 操作的应用；
      // 因此该判定必须保守（宁可 upsertOnly，也不允许过期快照删除对端编辑）。
      await loadCanvasStateFromDb(canvasId)
      const upsertOnly = snapshotMissingDocEntities(canvasId, snapshot, clientDeletedIds)
        || shouldUpsertOnlyForSnapshot(canvasId)
      if (upsertOnly) {
        log('POST canvas data - upsertOnly mode (snapshot missing doc entities or active/recent collaboration)', { canvasId })
      }
      await mergeJsonSnapshotIntoCanvas(canvasId, snapshot, upsertOnly)
    } else {
      // 无内容变更也要确保 doc 已加载（供后续读取一致）
      await loadCanvasStateFromDb(canvasId)
    }

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

    // Close rooms and delete all canvases in the folder subtree. Schema-level
    // CASCADE handles ai_conversations and canvas_recycle_bin; folders.parent_id
    // CASCADE handles subfolders when the root folder is deleted.
    if (folderIdsToDelete.length > 0) {
      const canvasesToDelete = await db.query.canvases.findMany({
        where: inArray(canvases.folderId, folderIdsToDelete),
      })
      const canvasIdsToDelete = canvasesToDelete.map((canvas) => canvas.id)

      if (canvasIdsToDelete.length > 0) {
        for (const id of canvasIdsToDelete) {
          closeRoom(id, 'folder-deleted')
        }
        await db.delete(canvases).where(inArray(canvases.id, canvasIdsToDelete))
        for (const id of canvasIdsToDelete) {
          postSaveMutexes.delete(id)
          removeCanvasState(id)
        }
      }
    }

    // Deleting the root folder cascades to all subfolders via parent_id CASCADE.
    await db.delete(folders).where(eq(folders.id, folderId))

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
