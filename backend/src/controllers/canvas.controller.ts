import { Router } from 'express'
import { db, sqlite } from '../database/connection.js'
import { canvases, folders, projects } from '../database/schema.js'
import { eq, and, inArray } from 'drizzle-orm'
import { authenticate, type AuthRequest } from '../middleware/auth.middleware.js'
import { asyncHandler } from '../middleware/error.middleware.js'
import { transformResponse, transformResponseArray } from '../utils/transformResponse.js'
import { log } from '../utils/logger.js'

export const canvasRouter = Router()

// Get canvas by ID (more specific route must come first)
canvasRouter.get('/detail/:id', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const canvasId = parseInt(req.params.id)

  const canvas = await db.query.canvases.findFirst({
    where: eq(canvases.id, canvasId),
  })

  if (!canvas) {
    return res.status(404).json({
      success: false,
      error: 'Canvas not found',
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
  const projectId = parseInt(req.params.projectId)

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  })

  if (!project) {
    return res.status(404).json({
      success: false,
      error: 'Project not found',
    })
  }

  const projectOwnerId = (project as any).owner_id || project.ownerId

  if (projectOwnerId !== req.user!.id) {
    return res.status(403).json({
      success: false,
      error: 'Access denied',
    })
  }

  const projectCanvases = await db.query.canvases.findMany({
    where: eq(canvases.projectId, projectId),
    orderBy: (canvases, { asc }) => [asc(canvases.sortOrder)],
  })

  const transformedCanvases = transformResponseArray(projectCanvases, ['createdAt', 'updatedAt'])

  res.json({
    success: true,
    data: transformedCanvases,
  })
}))

// Create canvas
canvasRouter.post('/:projectId', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const projectId = parseInt(req.params.projectId)
  const { name, folderId } = req.body

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  })

  if (!project) {
    return res.status(404).json({
      success: false,
      error: 'Project not found',
    })
  }

  const projectOwnerId = (project as any).owner_id || project.ownerId

  if (projectOwnerId !== req.user!.id) {
    return res.status(403).json({
      success: false,
      error: 'Access denied',
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

  const transformedCanvas = transformResponse(newCanvas, ['createdAt', 'updatedAt'])

  res.json({
    success: true,
    data: transformedCanvas,
  })
}))

// Update canvas
canvasRouter.put('/:id', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const canvasId = parseInt(req.params.id)
  const { name, yjsData, previewText, thumbnail, folderId, sortOrder } = req.body

  log('PUT canvas - Start', { canvasId, userId: req.user!.id, body: { name, yjsData: typeof yjsData, previewText, thumbnail, folderId, sortOrder } })

  try {
    const canvas = await db.query.canvases.findFirst({
      where: eq(canvases.id, canvasId),
    })

    log('PUT canvas - Canvas query result', { canvasId, canvasFound: !!canvas, canvas: canvas ? JSON.stringify(canvas) : null })

    if (!canvas) {
      log('PUT canvas - Canvas not found', { canvasId })
      return res.status(404).json({
        success: false,
        error: 'Canvas not found',
      })
    }

    // 使用原始列名 project_id（Drizzle ORM 返回原始列名）
    const canvasProjectId = (canvas as any).project_id || canvas.projectId

    const project = await db.query.projects.findFirst({
      where: eq(projects.id, canvasProjectId),
    })

    log('PUT canvas - Project query result', { canvasId, projectId: canvasProjectId, projectFound: !!project })

    if (!project) {
      log('PUT canvas - Project not found', { canvasId, projectId: canvasProjectId })
      return res.status(404).json({
        success: false,
        error: 'Project not found',
      })
    }

    const projectOwnerId = (project as any).owner_id || project.ownerId

    if (projectOwnerId !== req.user!.id) {
      log('PUT canvas - Access denied', { canvasId, projectOwnerId, userId: req.user!.id })
      return res.status(403).json({
        success: false,
        error: 'Access denied',
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
      updateData.yjsData = yjsData
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
  const canvasId = parseInt(req.params.id)

  log('DELETE canvas - Start', { canvasId, userId: req.user!.id })

  const canvas = await db.query.canvases.findFirst({
    where: eq(canvases.id, canvasId),
  })

  if (!canvas) {
    log('DELETE canvas - Canvas not found', { canvasId })
    return res.status(404).json({
      success: false,
      error: 'Canvas not found',
    })
  }

  // 使用原始列名 project_id（Drizzle ORM 返回原始列名）
  const canvasProjectId = (canvas as any).project_id || canvas.projectId

  log('DELETE canvas - Canvas found', { canvasId, projectId: canvasProjectId, canvas: JSON.stringify(canvas) })

  try {
    log('DELETE canvas - About to query project', { canvasId, projectId: canvasProjectId, projectIdType: typeof canvasProjectId })

    const project = await db.query.projects.findFirst({
      where: eq(projects.id, canvasProjectId),
    })

    log('DELETE canvas - Project query result', { canvasId, projectId: canvasProjectId, projectFound: !!project })

    if (!project) {
      log('DELETE canvas - Project not found', { canvasId, projectId: canvasProjectId })
      return res.status(404).json({
        success: false,
        error: 'Project not found',
      })
    }

    const projectOwnerId = (project as any).owner_id || project.ownerId

    log('DELETE canvas - Checking ownership', { canvasId, projectOwnerId, userId: req.user!.id })

    if (projectOwnerId !== req.user!.id) {
      log('DELETE canvas - Access denied', { canvasId, projectOwnerId, userId: req.user!.id })
      return res.status(403).json({
        success: false,
        error: 'Access denied',
      })
    }

    await db.delete(canvases).where(eq(canvases.id, canvasId))

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
  const canvasId = parseInt(req.params.id)

  const canvas = await db.query.canvases.findFirst({
    where: eq(canvases.id, canvasId),
  })

  if (!canvas) {
    return res.status(404).json({
      success: false,
      error: 'Canvas not found',
    })
  }

  // 使用原始列名 project_id（Drizzle ORM 返回原始列名）
  const canvasProjectId = (canvas as any).project_id || canvas.projectId

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, canvasProjectId),
  })

  if (!project) {
    return res.status(404).json({
      success: false,
      error: 'Project not found',
    })
  }

  const projectOwnerId = (project as any).owner_id || project.ownerId

  if (projectOwnerId !== req.user!.id) {
    return res.status(403).json({
      success: false,
      error: 'Access denied',
    })
  }

  const { nodes, groups, domains, connections } = req.body

  const jsonString = JSON.stringify({ nodes, groups, domains, connections })
  const utf8Bytes = new TextEncoder().encode(jsonString)
  const binaryString = Array.from(utf8Bytes, byte => String.fromCharCode(byte)).join('')
  const base64Data = btoa(binaryString)

  await db
    .update(canvases)
    .set({
      yjsData: base64Data,
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(canvases.id, canvasId))

  res.json({
    success: true,
    data: { message: 'Canvas data saved' },
  })
}))

// Get folders for project
canvasRouter.get(
  '/:projectId/folders',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const projectId = parseInt(req.params.projectId)

    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    })

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found',
      })
    }

    const projectOwnerId = (project as any).owner_id || project.ownerId

    if (projectOwnerId !== req.user!.id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied',
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
    const projectId = parseInt(req.params.projectId)
    const { name, parentId } = req.body

    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    })

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found',
      })
    }

    const projectOwnerId = (project as any).owner_id || project.ownerId

    if (projectOwnerId !== req.user!.id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied',
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
    const folderId = parseInt(req.params.id)
    const { name } = req.body

    const folder = await db.query.folders.findFirst({
      where: eq(folders.id, folderId),
    })

    if (!folder) {
      return res.status(404).json({
        success: false,
        error: 'Folder not found',
      })
    }

    // Use original column name project_id (Drizzle ORM returns original column names)
    const folderProjectId = (folder as any).project_id || folder.projectId

    const project = await db.query.projects.findFirst({
      where: eq(projects.id, folderProjectId),
    })

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found',
      })
    }

    const projectOwnerId = (project as any).owner_id || project.ownerId

    if (projectOwnerId !== req.user!.id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied',
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
    const folderId = parseInt(req.params.id)

    const folder = await db.query.folders.findFirst({
      where: eq(folders.id, folderId),
    })

    if (!folder) {
      return res.status(404).json({
        success: false,
        error: 'Folder not found',
      })
    }

    // Use original column name project_id (Drizzle ORM returns original column names)
    const folderProjectId = (folder as any).project_id || folder.projectId

    const project = await db.query.projects.findFirst({
      where: eq(projects.id, folderProjectId),
    })

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found',
      })
    }

    const projectOwnerId = (project as any).owner_id || project.ownerId

    if (projectOwnerId !== req.user!.id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied',
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
