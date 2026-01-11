import { Router } from 'express'
import { db } from '../database/connection.js'
import { projects, projectMembers, nodeCards, nodePoolFolders } from '../database/schema.js'
import { eq, and } from 'drizzle-orm'
import { authenticate, type AuthRequest } from '../middleware/auth.middleware.js'
import { asyncHandler } from '../middleware/error.middleware.js'
import { transformResponse, transformResponseArray } from '../utils/transformResponse.js'

export const projectRouter = Router()

// Get all projects
projectRouter.get('/', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const userProjects = await db.query.projects.findMany({
    where: eq(projects.ownerId, req.user!.id),
    orderBy: (projects, { desc }) => [desc(projects.updatedAt)],
  })

  // 转换响应数据（下划线命名转驼峰 + 时间戳转ISO）
  const transformedProjects = transformResponseArray(userProjects, ['createdAt', 'updatedAt'])

  res.json({
    success: true,
    data: transformedProjects,
  })
}))

// Get project by ID
projectRouter.get('/:id', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const projectId = parseInt(req.params.id)
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  })

  if (!project) {
    return res.status(404).json({
      success: false,
      error: 'Project not found',
    })
  }

  // 转换响应数据
  const transformedProject = transformResponse(project, ['createdAt', 'updatedAt'])

  res.json({
    success: true,
    data: transformedProject,
  })
}))

// Create project
projectRouter.post('/', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const { name, description, is_public } = req.body

  const [newProject] = await db
    .insert(projects)
    .values({
      name,
      description: description || null,
      ownerId: req.user!.id,
      isPublic: is_public || false,
    })
    .returning()

  // 转换时间戳字段
  const transformedProject = transformResponse(newProject, ['createdAt', 'updatedAt'])

  res.json({
    success: true,
    data: transformedProject,
  })
}))

// Update project
projectRouter.put('/:id', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const projectId = parseInt(req.params.id)
  const { name, description, thumbnail } = req.body

  // Check ownership
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  })

  const projectOwnerId = (project as any).owner_id || project.ownerId

  if (!project || projectOwnerId !== req.user!.id) {
    return res.status(403).json({
      success: false,
      error: 'Access denied',
    })
  }

  const [updatedProject] = await db
    .update(projects)
    .set({
      name: name || project.name,
      description: description !== undefined ? description : project.description,
      thumbnail: thumbnail || project.thumbnail,
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(projects.id, projectId))
    .returning()

  // 转换时间戳字段
  const transformedProject = transformResponse(updatedProject, ['createdAt', 'updatedAt'])

  res.json({
    success: true,
    data: transformedProject,
  })
}))

// Delete project
projectRouter.delete('/:id', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const projectId = parseInt(req.params.id)

  // Check ownership
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  })

  if (!project) {
    return res.status(404).json({
      success: false,
      error: 'Project not found',
    })
  }

  // 使用原始列名 owner_id（Drizzle ORM 返回原始列名）
  const projectOwnerId = (project as any).owner_id || project.ownerId

  if (projectOwnerId !== req.user!.id) {
    return res.status(403).json({
      success: false,
      error: 'Access denied',
    })
  }

  await db.delete(projects).where(eq(projects.id, projectId))

  res.json({
    success: true,
    data: { message: 'Project deleted' },
  })
}))

// Add project member
projectRouter.post(
  '/:id/members',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const projectId = parseInt(req.params.id)
    const { userId, role } = req.body

    // Check ownership
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    })

    const projectOwnerId = (project as any).owner_id || project.ownerId

    if (!project || projectOwnerId !== req.user!.id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied',
      })
    }

    const [newMember] = await db
      .insert(projectMembers)
      .values({
        projectId,
        userId,
        role: role || 'viewer',
      })
      .returning()

    res.json({
      success: true,
      data: newMember,
    })
  })
)

// Remove project member
projectRouter.delete(
  '/:id/members/:userId',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const projectId = parseInt(req.params.id)
    const userId = parseInt(req.params.userId)

    // Check ownership
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    })

    const projectOwnerId = (project as any).owner_id || project.ownerId

    if (!project || projectOwnerId !== req.user!.id) {
      return res.status(403).json({
        success: false,
        error: 'Access denied',
      })
    }

    await db
      .delete(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, userId)
        )
      )

    res.json({
      success: true,
      data: { message: 'Member removed' },
    })
  })
)

// Get node pool for project
projectRouter.get(
  '/:id/node-pool',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const projectId = parseInt(req.params.id)

    // Verify project exists and user has access
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    })

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found',
      })
    }

    const nodes = await db.query.nodeCards.findMany({
      where: eq(nodeCards.projectId, projectId),
      orderBy: (nodeCards, { desc }) => [desc(nodeCards.useCount)],
    })

    // 转换响应数据
    const transformedNodes = transformResponseArray(nodes, ['createdAt'])

    res.json({
      success: true,
      data: transformedNodes,
    })
  })
)

// Add node to pool
projectRouter.post(
  '/:id/node-pool',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const projectId = parseInt(req.params.id)
    const { name, content, type, color, tags, image_url } = req.body

    // Verify project exists
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    })

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found',
      })
    }

    const [newNode] = await db
      .insert(nodeCards)
      .values({
        projectId,
        name,
        content,
        type: type || 'text',
        color: color || '#ffffff',
        tags: tags || null,
        thumbnail: image_url || null,
        createdBy: req.user!.id,
      })
      .returning()

    // 转换时间戳字段
    const transformedNode = transformResponse(newNode, ['createdAt'])

    res.json({
      success: true,
      data: transformedNode,
    })
  })
)

// Remove node from pool
projectRouter.delete(
  '/node-pool/:nodeId',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const nodeId = parseInt(req.params.nodeId)

    // Verify node exists
    const node = await db.query.nodeCards.findFirst({
      where: eq(nodeCards.id, nodeId),
    })

    if (!node) {
      return res.status(404).json({
        success: false,
        error: 'Node not found',
      })
    }

    await db.delete(nodeCards).where(eq(nodeCards.id, nodeId))

    res.json({
      success: true,
      data: { message: 'Node removed from pool' },
    })
  })
)

// Update node card in pool
projectRouter.put(
  '/node-pool/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const nodeId = parseInt(req.params.id)
    const { name, description, folderId, sortOrder } = req.body

    // Verify node exists
    const node = await db.query.nodeCards.findFirst({
      where: eq(nodeCards.id, nodeId),
    })

    if (!node) {
      return res.status(404).json({
        success: false,
        error: 'Node not found',
      })
    }

    // Handle both camelCase (TypeScript) and snake_case (database) column names
    const nodeSortOrder = (node as any).sort_order || node.sortOrder || 0

    const [updatedNode] = await db
      .update(nodeCards)
      .set({
        name: name !== undefined ? name : node.name,
        description: description !== undefined ? description : node.description,
        folderId: folderId !== undefined ? folderId : node.folderId,
        sortOrder: sortOrder !== undefined ? sortOrder : nodeSortOrder,
      })
      .where(eq(nodeCards.id, nodeId))
      .returning()

    const transformedNode = transformResponse(updatedNode, ['createdAt'])

    res.json({
      success: true,
      data: transformedNode,
    })
  })
)

// Increment node card use count
projectRouter.post(
  '/node-pool/:id/increment-use',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const nodeId = parseInt(req.params.id)

    // Verify node exists
    const node = await db.query.nodeCards.findFirst({
      where: eq(nodeCards.id, nodeId),
    })

    if (!node) {
      return res.status(404).json({
        success: false,
        error: 'Node not found',
      })
    }

    const currentUseCount = (node as any).use_count || node.useCount || 0

    const [updatedNode] = await db
      .update(nodeCards)
      .set({
        useCount: currentUseCount + 1,
      })
      .where(eq(nodeCards.id, nodeId))
      .returning()

    const transformedNode = transformResponse(updatedNode, ['createdAt'])

    res.json({
      success: true,
      data: transformedNode,
    })
  })
)

// Get node pool folders for project
projectRouter.get(
  '/:id/node-pool-folders',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const projectId = parseInt(req.params.id)

    // Verify project exists
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    })

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found',
      })
    }

    const folders = await db.query.nodePoolFolders.findMany({
      where: eq(nodePoolFolders.projectId, projectId),
      orderBy: (nodePoolFolders, { asc }) => [asc(nodePoolFolders.sortOrder)],
    })

    const transformedFolders = transformResponseArray(folders, ['createdAt'])

    res.json({
      success: true,
      data: transformedFolders,
    })
  })
)

// Create node pool folder
projectRouter.post(
  '/:id/node-pool-folders',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const projectId = parseInt(req.params.id)
    const { name, parentId, sortOrder, collapsed } = req.body

    // Verify project exists
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    })

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found',
      })
    }

    const result = await db
      .insert(nodePoolFolders)
      .values({
        projectId,
        name,
        parentId: parentId || null,
        sortOrder: sortOrder || 0,
        collapsed: collapsed ?? true,
      })
      .returning()

    const [newFolder] = result || []

    const transformedFolder = transformResponse(newFolder, ['createdAt'])

    res.json({
      success: true,
      data: transformedFolder,
    })
  })
)

// Update node pool folder
projectRouter.put(
  '/node-pool-folders/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const folderId = parseInt(req.params.id)
    const { name, parentId, sortOrder, collapsed } = req.body

    // Verify folder exists
    const folder = await db.query.nodePoolFolders.findFirst({
      where: eq(nodePoolFolders.id, folderId),
    })

    if (!folder) {
      return res.status(404).json({
        success: false,
        error: 'Folder not found',
      })
    }

    const result = await db
      .update(nodePoolFolders)
      .set({
        name: name !== undefined ? name : folder.name,
        parentId: parentId !== undefined ? parentId : folder.parentId,
        sortOrder: sortOrder !== undefined ? sortOrder : folder.sortOrder,
        collapsed: collapsed !== undefined ? collapsed : folder.collapsed,
      })
      .where(eq(nodePoolFolders.id, folderId))
      .returning()

    const [updatedFolder] = result || []

    const transformedFolder = transformResponse(updatedFolder, ['createdAt'])

    res.json({
      success: true,
      data: transformedFolder,
    })
  })
)

// Delete node pool folder
projectRouter.delete(
  '/node-pool-folders/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const folderId = parseInt(req.params.id)

    // Verify folder exists
    const folder = await db.query.nodePoolFolders.findFirst({
      where: eq(nodePoolFolders.id, folderId),
    })

    if (!folder) {
      return res.status(404).json({
        success: false,
        error: 'Folder not found',
      })
    }

    // Unlink nodes from this folder
    await db
      .update(nodeCards)
      .set({ folderId: null })
      .where(eq(nodeCards.folderId, folderId))

    // Delete folder
    await db.delete(nodePoolFolders).where(eq(nodePoolFolders.id, folderId))

    res.json({
      success: true,
      data: { message: 'Folder deleted' },
    })
  })
)
