import { Router } from 'express'
import { db, scheduleSave } from '../database/connection.js'
import { projects, projectMembers, projectInvitations, users } from '../database/schema.js'
import { eq, and, or } from 'drizzle-orm'
import { authenticate, type AuthRequest } from '../middleware/auth.middleware.js'
import { asyncHandler } from '../middleware/error.middleware.js'
import { transformResponse } from '../utils/transformResponse.js'

export const collaborationRouter = Router()

function getProperty<T>(obj: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const key of keys) {
    const value = obj[key]
    if (value !== undefined) {
      return value as T
    }
  }
  return undefined
}

// Get project members with invitation status
collaborationRouter.get('/projects/:projectId/members', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const projectId = parseInt(req.params.projectId, 10)
  if (isNaN(projectId)) {
    return res.status(400).json({
      success: false,
      error: '无效的项目ID',
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

  const members = await db
    .select({
      id: projectMembers.id,
      projectId: projectMembers.projectId,
      userId: projectMembers.userId,
      role: projectMembers.role,
      joinedAt: projectMembers.joinedAt,
      user: {
        id: users.id,
        email: users.email,
        nickname: users.nickname,
        avatar: users.avatar,
      },
    })
    .from(projectMembers)
    .innerJoin(users, eq(projectMembers.userId, users.id))
    .where(eq(projectMembers.projectId, projectId))

  const invitations = await db
    .select({
      id: projectInvitations.id,
      projectId: projectInvitations.projectId,
      inviterId: projectInvitations.inviterId,
      inviteeId: projectInvitations.inviteeId,
      role: projectInvitations.role,
      status: projectInvitations.status,
      createdAt: projectInvitations.createdAt,
      respondedAt: projectInvitations.respondedAt,
      invitee: {
        id: users.id,
        email: users.email,
        nickname: users.nickname,
        avatar: users.avatar,
      },
    })
    .from(projectInvitations)
    .innerJoin(users, eq(projectInvitations.inviteeId, users.id))
    .where(and(
      eq(projectInvitations.projectId, projectId),
      or(
        eq(projectInvitations.status, 'pending'),
        eq(projectInvitations.status, 'rejected')
      )
    ))

  const owner = await db.query.users.findFirst({
    where: eq(users.id, projectOwnerId),
  })

  const ownerAsMember = owner ? {
    id: -1,
    projectId,
    userId: owner.id,
    role: 'owner' as const,
    joinedAt: null,
    user: {
      id: owner.id,
      email: owner.email,
      nickname: owner.nickname,
      avatar: owner.avatar,
    },
    isOwner: true,
    invitationStatus: null,
  } : null

  const transformedMembers = members.map(member => ({
    ...transformResponse(member, ['joinedAt']),
    isOwner: member.userId === projectOwnerId,
    invitationStatus: null,
  }))

  if (ownerAsMember && !transformedMembers.some(m => m.userId === projectOwnerId)) {
    transformedMembers.unshift(ownerAsMember)
  }

  const transformedInvitations = invitations.map(inv => ({
    id: inv.id,
    projectId: inv.projectId,
    inviteeId: inv.inviteeId,
    role: inv.role,
    status: inv.status,
    createdAt: inv.createdAt ? new Date(inv.createdAt * 1000).toISOString() : null,
    respondedAt: inv.respondedAt ? new Date(inv.respondedAt * 1000).toISOString() : null,
    invitee: inv.invitee,
  }))

  res.json({
    success: true,
    data: {
      members: transformedMembers,
      invitations: transformedInvitations,
      ownerId: projectOwnerId,
    },
  })
}))

// Invite user to project
collaborationRouter.post('/projects/:projectId/invite', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const projectId = parseInt(req.params.projectId, 10)
  if (isNaN(projectId)) {
    return res.status(400).json({
      success: false,
      error: '无效的项目ID',
    })
  }

  const { userId, role } = req.body

  if (!userId) {
    return res.status(400).json({
      success: false,
      error: '请指定要邀请的用户',
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

  if (req.user!.id !== projectOwnerId) {
    return res.status(403).json({
      success: false,
      error: '只有项目所有者可以邀请成员',
    })
  }

  if (userId === req.user!.id) {
    return res.status(400).json({
      success: false,
      error: '不能邀请自己',
    })
  }

  const existingMember = await db.query.projectMembers.findFirst({
    where: and(
      eq(projectMembers.projectId, projectId),
      eq(projectMembers.userId, userId)
    ),
  })

  if (existingMember && existingMember.id !== undefined) {
    return res.status(400).json({
      success: false,
      error: '该用户已是项目成员',
    })
  }

  const existingInvitation = await db.query.projectInvitations.findFirst({
    where: and(
      eq(projectInvitations.projectId, projectId),
      eq(projectInvitations.inviteeId, userId),
      eq(projectInvitations.status, 'pending')
    ),
  })

  if (existingInvitation && existingInvitation.id !== undefined) {
    return res.status(400).json({
      success: false,
      error: '已向该用户发送过邀请，请等待对方回应',
    })
  }

  // 自动将项目标记为协作项目
  const projectIsCollaborative = getProperty<boolean>(project, 'is_collaborative', 'isCollaborative') || project.isCollaborative
  if (!projectIsCollaborative) {
    await db
      .update(projects)
      .set({ isCollaborative: true })
      .where(eq(projects.id, projectId))
  }

  const [invitation] = await db
    .insert(projectInvitations)
    .values({
      projectId,
      inviterId: req.user!.id,
      inviteeId: userId,
      role: role || 'viewer',
      status: 'pending',
    })
    .returning()

  scheduleSave()

  const invitee = await db.query.users.findFirst({
    where: eq(users.id, userId),
  })

  res.json({
    success: true,
    data: {
      id: invitation.id,
      projectId: invitation.projectId,
      inviteeId: invitation.inviteeId,
      role: invitation.role,
      status: invitation.status,
      createdAt: invitation.createdAt ? new Date(invitation.createdAt * 1000).toISOString() : null,
      invitee: {
        id: invitee!.id,
        email: invitee!.email,
        nickname: invitee!.nickname,
        avatar: invitee!.avatar,
      },
    },
  })
}))

// Get my pending invitations
collaborationRouter.get('/invitations', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const invitations = await db
    .select({
      id: projectInvitations.id,
      projectId: projectInvitations.projectId,
      inviterId: projectInvitations.inviterId,
      role: projectInvitations.role,
      status: projectInvitations.status,
      createdAt: projectInvitations.createdAt,
      project: {
        id: projects.id,
        name: projects.name,
      },
      inviter: {
        id: users.id,
        email: users.email,
        nickname: users.nickname,
        avatar: users.avatar,
      },
    })
    .from(projectInvitations)
    .innerJoin(projects, eq(projectInvitations.projectId, projects.id))
    .innerJoin(users, eq(projectInvitations.inviterId, users.id))
    .where(and(
      eq(projectInvitations.inviteeId, req.user!.id),
      eq(projectInvitations.status, 'pending')
    ))

  const transformedInvitations = invitations.map(inv => ({
    ...inv,
    createdAt: inv.createdAt ? new Date(inv.createdAt * 1000).toISOString() : null,
  }))

  res.json({
    success: true,
    data: transformedInvitations,
  })
}))

// Accept invitation
collaborationRouter.post('/invitations/:id/accept', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const invitationId = parseInt(req.params.id, 10)
  if (isNaN(invitationId)) {
    return res.status(400).json({
      success: false,
      error: '无效的邀请ID',
    })
  }

  const invitation = await db.query.projectInvitations.findFirst({
    where: and(
      eq(projectInvitations.id, invitationId),
      eq(projectInvitations.inviteeId, req.user!.id),
      eq(projectInvitations.status, 'pending')
    ),
  })

  if (!invitation || invitation.id === undefined) {
    return res.status(404).json({
      success: false,
      error: '邀请不存在或已处理',
    })
  }

  const invitationProjectId = getProperty<number>(invitation, 'project_id', 'projectId')
  const invitationRole = getProperty<string>(invitation, 'role') || 'viewer'

  await db.transaction(async (tx) => {
    await tx
      .update(projectInvitations)
      .set({
        status: 'accepted',
        respondedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(projectInvitations.id, invitationId))

    await tx.insert(projectMembers).values({
      projectId: invitationProjectId,
      userId: req.user!.id,
      role: invitationRole,
    })
  })

  scheduleSave()

  res.json({
    success: true,
    data: { message: '已接受邀请' },
  })
}))

// Reject invitation
collaborationRouter.post('/invitations/:id/reject', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const invitationId = parseInt(req.params.id, 10)
  if (isNaN(invitationId)) {
    return res.status(400).json({
      success: false,
      error: '无效的邀请ID',
    })
  }

  const invitation = await db.query.projectInvitations.findFirst({
    where: and(
      eq(projectInvitations.id, invitationId),
      eq(projectInvitations.inviteeId, req.user!.id),
      eq(projectInvitations.status, 'pending')
    ),
  })

  if (!invitation || invitation.id === undefined) {
    return res.status(404).json({
      success: false,
      error: '邀请不存在或已处理',
    })
  }

  await db
    .update(projectInvitations)
    .set({
      status: 'rejected',
      respondedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(projectInvitations.id, invitationId))

  scheduleSave()

  res.json({
    success: true,
    data: { message: '已拒绝邀请' },
  })
}))

// Remove member from project
collaborationRouter.delete('/projects/:projectId/members/:userId', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const projectId = parseInt(req.params.projectId, 10)
  const userId = parseInt(req.params.userId, 10)

  if (isNaN(projectId) || isNaN(userId)) {
    return res.status(400).json({
      success: false,
      error: '无效的ID',
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

  if (req.user!.id !== projectOwnerId) {
    return res.status(403).json({
      success: false,
      error: '只有项目所有者可以移除成员',
    })
  }

  if (userId === projectOwnerId) {
    return res.status(400).json({
      success: false,
      error: '不能移除项目所有者',
    })
  }

  await db
    .delete(projectMembers)
    .where(and(
      eq(projectMembers.projectId, projectId),
      eq(projectMembers.userId, userId)
    ))

  scheduleSave()

  res.json({
    success: true,
    data: { message: '成员已移除' },
  })
}))

// Cancel invitation
collaborationRouter.delete('/invitations/:id', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const invitationId = parseInt(req.params.id, 10)
  if (isNaN(invitationId)) {
    return res.status(400).json({
      success: false,
      error: '无效的邀请ID',
    })
  }

  const invitation = await db.query.projectInvitations.findFirst({
    where: eq(projectInvitations.id, invitationId),
  })

  if (!invitation || invitation.id === undefined) {
    return res.status(404).json({
      success: false,
      error: '邀请不存在',
    })
  }

  const invitationProjectId = getProperty<number>(invitation, 'project_id', 'projectId')

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, invitationProjectId),
  })

  if (!project || project.id === undefined) {
    return res.status(404).json({
      success: false,
      error: '项目未找到',
    })
  }

  const projectOwnerId = getProperty<number>(project, 'owner_id', 'ownerId') || project.ownerId
  const invitationInviteeId = getProperty<number>(invitation, 'invitee_id', 'inviteeId')

  if (req.user!.id !== projectOwnerId && req.user!.id !== invitationInviteeId) {
    return res.status(403).json({
      success: false,
      error: '无权取消此邀请',
    })
  }

  await db
    .delete(projectInvitations)
    .where(eq(projectInvitations.id, invitationId))

  scheduleSave()

  res.json({
    success: true,
    data: { message: '邀请已取消' },
  })
}))

// Update member role
collaborationRouter.put('/projects/:projectId/members/:userId/role', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const projectId = parseInt(req.params.projectId, 10)
  const userId = parseInt(req.params.userId, 10)
  const { role } = req.body

  if (isNaN(projectId) || isNaN(userId)) {
    return res.status(400).json({
      success: false,
      error: '无效的ID',
    })
  }

  if (!role || !['editor', 'viewer'].includes(role)) {
    return res.status(400).json({
      success: false,
      error: '无效的角色',
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

  if (req.user!.id !== projectOwnerId) {
    return res.status(403).json({
      success: false,
      error: '只有项目所有者可以修改成员角色',
    })
  }

  const [updatedMember] = await db
    .update(projectMembers)
    .set({ role })
    .where(and(
      eq(projectMembers.projectId, projectId),
      eq(projectMembers.userId, userId)
    ))
    .returning()

  if (!updatedMember) {
    return res.status(404).json({
      success: false,
      error: '成员未找到',
    })
  }

  scheduleSave()

  res.json({
    success: true,
    data: transformResponse(updatedMember, ['joinedAt']),
  })
}))
