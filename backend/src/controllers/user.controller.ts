import { Router } from 'express'
import bcrypt from 'bcrypt'
import { db, scheduleSave } from '../database/connection.js'
import { users, projects, projectMembers, groupMembers, nodeCards, files, canvases, folders, canvasRecycleBin, nodePoolFolders } from '../database/schema.js'
import { eq, and } from 'drizzle-orm'
import { authenticate, type AuthRequest } from '../middleware/auth.middleware.js'
import { asyncHandler } from '../middleware/error.middleware.js'

export const userRouter = Router()

// Get profile
userRouter.get('/profile', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const user = await db.query.users.findFirst({
    where: eq(users.id, req.user!.id),
  })

  if (!user) {
    return res.status(404).json({
      success: false,
      error: '用户不存在',
    })
  }

  res.json({
    success: true,
    data: {
      id: user.id,
      email: user.email,
      nickname: user.nickname,
      avatar: user.avatar,
      created_at: user.createdAt,
      updated_at: user.updatedAt,
    },
  })
}))

// Update profile
userRouter.put('/profile', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const { nickname, avatar } = req.body

  const [updatedUser] = await db
    .update(users)
    .set({
      nickname: nickname || null,
      avatar: avatar || null,
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(users.id, req.user!.id))
    .returning()

  res.json({
    success: true,
    data: {
      id: updatedUser.id,
      email: updatedUser.email,
      nickname: updatedUser.nickname,
      avatar: updatedUser.avatar,
      created_at: updatedUser.createdAt,
      updated_at: updatedUser.updatedAt,
    },
  })
}))

// Upload avatar
userRouter.post('/avatar', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  // Avatar upload handled by file controller
  res.json({
    success: false,
    error: 'Use /api/files/upload for file uploads',
  })
}))

// Change password
userRouter.put('/password', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const { currentPassword, newPassword } = req.body

  // Validate input
  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      success: false,
      error: '当前密码和新密码不能为空',
    })
  }

  if (newPassword.length < 6) {
    return res.status(400).json({
      success: false,
      error: '新密码长度不能少于6个字符',
    })
  }

  // Get user with password
  const userList = await db
    .select()
    .from(users)
    .where(eq(users.id, req.user!.id))
  const user = userList[0]

  if (!user || !user.password) {
    return res.status(404).json({
      success: false,
      error: '用户不存在',
    })
  }

  // Verify current password
  const isValid = await bcrypt.compare(currentPassword, user.password)
  if (!isValid) {
    return res.status(401).json({
      success: false,
      error: '当前密码不正确',
    })
  }

  // Hash new password
  const hashedPassword = await bcrypt.hash(newPassword, 10)

  // Update password
  await db
    .update(users)
    .set({
      password: hashedPassword,
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(users.id, req.user!.id))

  scheduleSave()

  res.json({
    success: true,
    data: { message: 'Password updated successfully' },
  })
}))

// Delete account permanently
userRouter.delete('/account', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const { password, confirmation } = req.body

  // Validate confirmation
  if (!confirmation || confirmation !== 'DELETE') {
    return res.status(400).json({
      success: false,
      error: '请输入DELETE确认删除账户',
    })
  }

  // Get user with password
  const userList = await db
    .select()
    .from(users)
    .where(eq(users.id, req.user!.id))
  const user = userList[0]

  if (!user || !user.password) {
    return res.status(404).json({
      success: false,
      error: '用户未找到',
    })
  }

  // Verify password
  if (password) {
    const isValid = await bcrypt.compare(password, user.password)
    if (!isValid) {
      return res.status(401).json({
        success: false,
        error: '密码不正确',
      })
    }
  }

  const userId = req.user!.id

  // Delete all user's project memberships (where user is not owner)
  await db
    .delete(projectMembers)
    .where(
      and(
        eq(projectMembers.userId, userId),
        eq(projectMembers.role, 'viewer')
      )
    )
  await db
    .delete(projectMembers)
    .where(
      and(
        eq(projectMembers.userId, userId),
        eq(projectMembers.role, 'editor')
      )
    )

  // Delete all group memberships (where user is not owner)
  await db
    .delete(groupMembers)
    .where(eq(groupMembers.userId, userId))

  // Delete user's owned projects and their dependencies
  const ownedProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.ownerId, userId))

  for (const project of ownedProjects) {
    // Delete project members
    await db
      .delete(projectMembers)
      .where(eq(projectMembers.projectId, project.id))

    // Delete canvases
    const projectCanvases = await db
      .select()
      .from(canvases)
      .where(eq(canvases.projectId, project.id))

    for (const canvas of projectCanvases) {
      // Delete canvas from recycle bin
      await db
        .delete(canvasRecycleBin)
        .where(eq(canvasRecycleBin.canvasId, canvas.id))
    }

    // Delete all canvases for this project
    await db
      .delete(canvases)
      .where(eq(canvases.projectId, project.id))

    // Delete folders
    await db
      .delete(folders)
      .where(eq(folders.projectId, project.id))

    // Delete node pool folders
    await db
      .delete(nodePoolFolders)
      .where(eq(nodePoolFolders.projectId, project.id))

    // Delete node cards
    await db
      .delete(nodeCards)
      .where(eq(nodeCards.projectId, project.id))

    // Delete files
    await db
      .delete(files)
      .where(eq(files.projectId, project.id))

    // Delete project
    await db
      .delete(projects)
      .where(eq(projects.id, project.id))
  }

  // Delete user's uploaded files
  await db
    .delete(files)
    .where(eq(files.uploaderId, userId))

  // Delete user's node cards created in other projects
  await db
    .delete(nodeCards)
    .where(eq(nodeCards.createdBy, userId))

  // Delete recycle bin entries where user deleted the canvas
  await db
    .delete(canvasRecycleBin)
    .where(eq(canvasRecycleBin.deletedBy, userId))

  // Finally delete the user
  await db
    .delete(users)
    .where(eq(users.id, userId))

  scheduleSave()

  res.json({
    success: true,
    data: { message: 'Account deleted successfully' },
  })
}))
