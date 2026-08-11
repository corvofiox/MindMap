import { Router } from 'express'
import { db } from '../database/connection.js'
import { projects, users, canvases, folders, projectMembers } from '../database/schema.js'
import { eq, and, inArray, isNull, type InferSelectModel } from 'drizzle-orm'
import { authenticate, type AuthRequest } from '../middleware/auth.middleware.js'
import { asyncHandler } from '../middleware/error.middleware.js'
import { transformResponse, transformResponseArray, getProperty } from '../utils/transformResponse.js'
import { removeCanvasState } from '../websocket/canvas-state.js'
import { closeRoom, kickUserFromRoom } from '../websocket/index.js'
import { logError } from '../utils/logger.js'

export const projectRouter = Router()

type Project = InferSelectModel<typeof projects>

interface ProjectResponse extends Project {
  memberRole: 'owner' | 'editor' | 'viewer'
}

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

  const projectOwnerId = getProperty<number>(project, 'owner_id', 'ownerId') || project.ownerId
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

  const transformedProject: ProjectResponse = {
    ...(transformResponse(project, ['createdAt', 'updatedAt']) as Project),
    memberRole: isOwner ? 'owner' : ((member?.role || 'viewer') as ProjectResponse['memberRole']),
  }

  res.json({
    success: true,
    data: transformedProject,
  })
}))

// Create project
projectRouter.post('/', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const { name, description, is_public, is_collaborative, isCollaborative } = req.body

  // 支持 camelCase 和 snake_case 两种参数名
  const collaborativeValue = is_collaborative !== undefined ? is_collaborative : isCollaborative

  const [newProject] = await db
    .insert(projects)
    .values({
      name,
      description: description || null,
      ownerId: req.user!.id,
      isPublic: is_public || false,
      isCollaborative: collaborativeValue || false,
    })
    .returning()

  const transformedProject: ProjectResponse = {
    ...(transformResponse(newProject, ['createdAt', 'updatedAt']) as Project),
    memberRole: 'owner',
  }

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

  const { name, description, thumbnail, is_collaborative, isCollaborative } = req.body

  // 支持 camelCase 和 snake_case 两种参数名
  const collaborativeValue = is_collaborative !== undefined ? is_collaborative : isCollaborative

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  })

  if (!project) {
    return res.status(404).json({
      success: false,
      error: '项目未找到',
    })
  }

  const projectOwnerId = getProperty<number>(project, 'owner_id', 'ownerId') || project.ownerId

  if (projectOwnerId !== req.user!.id) {
    return res.status(403).json({
      success: false,
      error: '只有项目所有者可以修改项目',
    })
  }

  const updateData: Record<string, unknown> = {
    updatedAt: Math.floor(Date.now() / 1000),
  }

  if (name !== undefined) updateData.name = name
  if (description !== undefined) updateData.description = description
  if (thumbnail !== undefined) updateData.thumbnail = thumbnail
  if (collaborativeValue !== undefined) updateData.isCollaborative = collaborativeValue

  const [updatedProject] = await db
    .update(projects)
    .set(updateData)
    .where(eq(projects.id, projectId))
    .returning()

  const transformedProject: ProjectResponse = {
    ...(transformResponse(updatedProject, ['createdAt', 'updatedAt']) as Project),
    memberRole: 'owner',
  }

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

  const projectOwnerId = getProperty<number>(project, 'owner_id', 'ownerId') || project.ownerId

  if (projectOwnerId !== req.user!.id) {
    return res.status(403).json({
      success: false,
      error: '访问被拒绝',
    })
  }

  // Close rooms for all canvases in the project before deleting them.
  const projectCanvases = await db.query.canvases.findMany({
    where: eq(canvases.projectId, projectId),
  })
  for (const canvas of projectCanvases) {
    closeRoom(canvas.id, 'project-deleted')
  }

  // Schema-level CASCADE handles ai_conversations, canvas_recycle_bin,
  // project_members, project_invitations, and files when the project is deleted.
  // Delete canvases first so removeCanvasState runs and the in-memory Yjs docs
  // are cleaned up.
  const canvasIdsToDelete = projectCanvases.map((canvas) => canvas.id)
  if (canvasIdsToDelete.length > 0) {
    await db.delete(canvases).where(inArray(canvases.id, canvasIdsToDelete))
    for (const canvasId of canvasIdsToDelete) {
      removeCanvasState(canvasId)
    }
  }

  // Delete root folders; subfolders cascade via parent_id CASCADE.
  const rootFolders = await db.query.folders.findMany({
    where: and(eq(folders.projectId, projectId), isNull(folders.parentId)),
  })
  for (const folder of rootFolders) {
    await db.delete(folders).where(eq(folders.id, folder.id))
  }

  // Deleting the project cascades to members, invitations, and files.
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
    const projectId = parseInt(req.params.id, 10)
    if (isNaN(projectId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid project ID format',
      })
    }

    const { userId: rawUserId, role } = req.body
    const memberUserId = typeof rawUserId === 'number' ? rawUserId : parseInt(rawUserId, 10)

    if (isNaN(memberUserId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid user ID format',
      })
    }

    const normalizedRole = role || 'viewer'
    if (!['editor', 'viewer'].includes(normalizedRole)) {
      return res.status(400).json({
        success: false,
        error: '无效的角色',
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

    const projectOwnerId = getProperty<number>(project, 'owner_id', 'ownerId') || project.ownerId

    if (projectOwnerId !== req.user!.id) {
      return res.status(403).json({
        success: false,
        error: '访问被拒绝',
      })
    }

    if (memberUserId === req.user!.id) {
      return res.status(400).json({
        success: false,
        error: '不能添加自己为成员',
      })
    }

    const targetUser = await db.query.users.findFirst({
      where: eq(users.id, memberUserId),
    })

    if (!targetUser) {
      return res.status(404).json({
        success: false,
        error: '用户未找到',
      })
    }

    const existingMember = await db.query.projectMembers.findFirst({
      where: and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, memberUserId)
      ),
    })

    if (existingMember && existingMember.id !== undefined) {
      return res.status(409).json({
        success: false,
        error: '该用户已是项目成员',
      })
    }

    const [newMember] = await db
      .insert(projectMembers)
      .values({
        projectId,
        userId: memberUserId,
        role: normalizedRole,
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

    // B1: ownerId 在 !project 判空之前解引用，项目不存在时抛 TypeError 500。
    // 先判空返回 404，再校验所有权（与添加成员端点语义一致）。
    if (!project) {
      return res.status(404).json({
        success: false,
        error: '项目未找到',
      })
    }

    const projectOwnerId = getProperty<number>(project, 'owner_id', 'ownerId') || project.ownerId

    if (projectOwnerId !== req.user!.id) {
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

    // B1: 对齐 collaboration.controller 移除成员端点的行为——被移除成员的
    // 在线 WS 连接仍持有 editor 权限可继续写入 Y.Doc，必须踢出该项目下所有
    // 协作画布的房间（kickUserFromRoom 发 kicked 通知并断开连接）。
    try {
      const projectCanvases = await db.query.canvases.findMany({
        where: eq(canvases.projectId, projectId),
      })
      for (const c of projectCanvases) {
        kickUserFromRoom(c.id, userId, 'removed')
      }
    } catch (error) {
      // 踢人失败不应阻塞 API 响应，记录后继续
      logError('Failed to kick removed member from rooms', {
        projectId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    res.json({
      success: true,
      data: { message: 'Member removed' },
    })
  })
)
