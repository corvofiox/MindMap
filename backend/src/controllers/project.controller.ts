import { Router } from 'express'
import { db, scheduleSave } from '../database/connection.js'
import { projects, projectMembers, nodeCards, nodePoolFolders } from '../database/schema.js'
import { eq, and } from 'drizzle-orm'
import { authenticate, type AuthRequest } from '../middleware/auth.middleware.js'
import { asyncHandler } from '../middleware/error.middleware.js'
import { transformResponse, transformResponseArray } from '../utils/transformResponse.js'

// Helper function to safely get property from Drizzle result (handles both snake_case and camelCase)
function getProperty<T>(obj: any, ...keys: string[]): T | undefined {
  for (const key of keys) {
    const value = obj[key]
    if (value !== undefined) {
      return value
    }
  }
  return undefined
}

export const projectRouter = Router()

// Get all projects (owned + collaborated)
projectRouter.get('/', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const ownedProjects = await db.query.projects.findMany({
    where: eq(projects.ownerId, req.user!.id),
    orderBy: (projects, { desc }) => [desc(projects.updatedAt)],
  })

  const memberRecords = await db.query.projectMembers.findMany({
    where: eq(projectMembers.userId, req.user!.id),
  })

  const collaboratedProjects = []
  for (const member of memberRecords) {
    const projectId = getProperty<number>(member, 'project_id', 'projectId')
    if (projectId) {
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
      })
      if (project) {
        collaboratedProjects.push({
          ...project,
          memberRole: member.role,
        })
      }
    }
  }

  const allProjects = [
    ...ownedProjects.map(p => ({ ...p, memberRole: 'owner' })),
    ...collaboratedProjects,
  ]

  allProjects.sort((a, b) => {
    const aTime = a.updatedAt || a.updated_at || 0
    const bTime = b.updatedAt || b.updated_at || 0
    return bTime - aTime
  })

  const transformedProjects = transformResponseArray(allProjects, ['createdAt', 'updatedAt'])

  res.json({
    success: true,
    data: transformedProjects,
  })
}))

// Get project by ID
projectRouter.get('/:id', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const projectId = parseInt(req.params.id, 10)
  if (isNaN(projectId)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid project ID format',
    })
  }

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  })

  if (!project) {
    return res.status(404).json({
      success: false,
      error: '项目未找到',
    })
  }

  const projectOwnerId = getProperty(project, 'owner_id', 'ownerId') || project.ownerId
  const isOwner = projectOwnerId === req.user!.id

  const member = await db.query.projectMembers.findFirst({
    where: and(
      eq(projectMembers.projectId, projectId),
      eq(projectMembers.userId, req.user!.id)
    ),
  })

  const isMember = member && member.id !== undefined

  if (!isOwner && !isMember) {
    return res.status(403).json({
      success: false,
      error: '访问被拒绝',
    })
  }

  const transformedProject = transformResponse(project, ['createdAt', 'updatedAt'])
    ; (transformedProject as any).memberRole = isOwner ? 'owner' : member?.role

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

  scheduleSave()

  const transformedProject = transformResponse(newProject, ['createdAt', 'updatedAt'])
  ;(transformedProject as any).memberRole = 'owner'

  res.json({
    success: true,
    data: transformedProject,
  })
}))

// Update project (owner only)
projectRouter.put('/:id', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const projectId = parseInt(req.params.id, 10)
  if (isNaN(projectId)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid project ID format',
    })
  }

  const { name, description, thumbnail } = req.body

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  })

  if (!project) {
    return res.status(404).json({
      success: false,
      error: '项目未找到',
    })
  }

  const projectOwnerId = getProperty(project, 'owner_id', 'ownerId') || project.ownerId

  if (projectOwnerId !== req.user!.id) {
    return res.status(403).json({
      success: false,
      error: '只有项目所有者可以修改项目',
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

  scheduleSave()

  const transformedProject = transformResponse(updatedProject, ['createdAt', 'updatedAt'])

  res.json({
    success: true,
    data: transformedProject,
  })
}))

// Delete project
projectRouter.delete('/:id', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const projectId = parseInt(req.params.id, 10)
  if (isNaN(projectId)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid project ID format',
    })
  }

  // Check ownership
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  })

  if (!project) {
    return res.status(404).json({
      success: false,
      error: '项目未找到',
    })
  }

  const projectOwnerId = getProperty(project, 'owner_id', 'ownerId') || project.ownerId

  if (projectOwnerId !== req.user!.id) {
    return res.status(403).json({
      success: false,
      error: '访问被拒绝',
    })
  }

  await db.delete(projects).where(eq(projects.id, projectId))

  scheduleSave()

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
    const projectId = parseInt(req.params.id, 10)
    if (isNaN(projectId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid project ID format',
      })
    }

    const { userId, role } = req.body

    // Check ownership
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    })

    const projectOwnerId = getProperty(project, 'owner_id', 'ownerId') || project.ownerId

    if (!project || projectOwnerId !== req.user!.id) {
      return res.status(403).json({
        success: false,
        error: '访问被拒绝',
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

    scheduleSave()

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
    const projectId = parseInt(req.params.id, 10)
    const userId = parseInt(req.params.userId, 10)
    if (isNaN(projectId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid project ID format',
      })
    }
    if (isNaN(userId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid user ID format',
      })
    }

    // Check ownership
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    })

    const projectOwnerId = project.ownerId

    if (!project || projectOwnerId !== req.user!.id) {
      return res.status(403).json({
        success: false,
        error: '访问被拒绝',
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

    scheduleSave()

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
    const projectId = parseInt(req.params.id, 10)
    if (isNaN(projectId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid project ID format',
      })
    }

    // Verify project exists and user has access
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    })

    if (!project) {
      return res.status(404).json({
        success: false,
        error: '项目未找到',
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
    const projectId = parseInt(req.params.id, 10)
    if (isNaN(projectId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid project ID format',
      })
    }

    const { name, content, type, color, tags, image_url, thumbnail } = req.body

    // Verify project exists
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    })

    if (!project) {
      return res.status(404).json({
        success: false,
        error: '项目未找到',
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
        thumbnail: thumbnail || image_url || null,
        createdBy: req.user!.id,
      })
      .returning()

    scheduleSave()

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
    const nodeId = parseInt(req.params.nodeId, 10)
    if (isNaN(nodeId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid node ID format',
      })
    }

    // Verify node exists
    const node = await db.query.nodeCards.findFirst({
      where: eq(nodeCards.id, nodeId),
    })

    if (!node) {
      return res.status(404).json({
        success: false,
        error: '节点未找到',
      })
    }

    await db.delete(nodeCards).where(eq(nodeCards.id, nodeId))

    scheduleSave()

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
    const nodeId = parseInt(req.params.id, 10)
    if (isNaN(nodeId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid node ID format',
      })
    }

    const { name, description, folderId, sortOrder } = req.body

    // Verify node exists
    const node = await db.query.nodeCards.findFirst({
      where: eq(nodeCards.id, nodeId),
    })

    if (!node) {
      return res.status(404).json({
        success: false,
        error: '节点未找到',
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

    scheduleSave()

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
    const nodeId = parseInt(req.params.id, 10)
    if (isNaN(nodeId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid node ID format',
      })
    }

    // Verify node exists
    const node = await db.query.nodeCards.findFirst({
      where: eq(nodeCards.id, nodeId),
    })

    if (!node) {
      return res.status(404).json({
        success: false,
        error: '节点未找到',
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

    scheduleSave()

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
    const projectId = parseInt(req.params.id, 10)
    if (isNaN(projectId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid project ID format',
      })
    }

    // Verify project exists
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    })

    if (!project) {
      return res.status(404).json({
        success: false,
        error: '项目未找到',
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
    const projectId = parseInt(req.params.id, 10)
    if (isNaN(projectId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid project ID format',
      })
    }

    const { name, parentId, sortOrder, collapsed } = req.body

    // Verify project exists
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
    })

    if (!project) {
      return res.status(404).json({
        success: false,
        error: '项目未找到',
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

    scheduleSave()

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
    const folderId = parseInt(req.params.id, 10)
    if (isNaN(folderId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid folder ID format',
      })
    }

    const { name, parentId, sortOrder, collapsed } = req.body

    // Verify folder exists
    const folder = await db.query.nodePoolFolders.findFirst({
      where: eq(nodePoolFolders.id, folderId),
    })

    if (!folder) {
      return res.status(404).json({
        success: false,
        error: '文件夹未找到',
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

    scheduleSave()

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
    const folderId = parseInt(req.params.id, 10)
    if (isNaN(folderId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid folder ID format',
      })
    }

    // Verify folder exists
    const folder = await db.query.nodePoolFolders.findFirst({
      where: eq(nodePoolFolders.id, folderId),
    })

    if (!folder) {
      return res.status(404).json({
        success: false,
        error: '文件夹未找到',
      })
    }

    // Wrap in transaction for atomicity
    await db.transaction(async (tx) => {
      // Unlink nodes from this folder
      await tx
        .update(nodeCards)
        .set({ folderId: null })
        .where(eq(nodeCards.folderId, folderId))

      // Delete folder
      await tx.delete(nodePoolFolders).where(eq(nodePoolFolders.id, folderId))
    })

    scheduleSave()

    res.json({
      success: true,
      data: { message: 'Folder deleted' },
    })
  })
)
