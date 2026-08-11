import { Router } from 'express'
import bcrypt from 'bcrypt'
import { db } from '../database/connection.js'
import { users, projects, groups, nodeCards, canvases, folders, nodePoolFolders, settings } from '../database/schema.js'
import { eq, and, or, like, inArray, isNull } from 'drizzle-orm'
import { authenticate, type AuthRequest } from '../middleware/auth.middleware.js'
import { asyncHandler } from '../middleware/error.middleware.js'
import { logError } from '../utils/logger.js'
import { SHARED_NODE_DEFAULTS, NODE_DEFAULTS_VALIDATION } from 'mindmap-shared'
import { transformResponse, transformResponseArray, getUserId } from '../utils/transformResponse.js'
import { removeCanvasState } from '../websocket/canvas-state.js'
import { closeRoom } from '../websocket/index.js'

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

  // B8: 未提供的字段保持原值——`nickname || null` 会把空 body {} 的
  // nickname/avatar 清为 null。仅当字段显式提供（含显式 null 清空）时写入。
  const updateData: Record<string, unknown> = {
    updatedAt: Math.floor(Date.now() / 1000),
  }
  if (nickname !== undefined) {
    updateData.nickname = nickname
  }
  if (avatar !== undefined) {
    updateData.avatar = avatar
  }

  const [updatedUser] = await db
    .update(users)
    .set(updateData)
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

  // A7: 强制密码校验——持 JWT 而无密码不得删号（防撞库/被盗 token 直接删号）
  if (!password || typeof password !== 'string') {
    return res.status(400).json({
      success: false,
      error: '请输入密码以确认删除账户',
    })
  }
  const isValid = await bcrypt.compare(password, user.password)
  if (!isValid) {
    return res.status(401).json({
      success: false,
      error: '密码不正确',
    })
  }

  const userId = req.user!.id

  // B9: 多步删除包在事务里——中途失败整体回滚,不留"组删了项目没删"
  // 之类的半删状态。closeRoom/removeCanvasState 是内存态清理,留在事务外
  // 循环里执行（幂等,失败也不影响 DB 一致性;事务回滚后下次加载会重读 DB）。
  await db.transaction(async (tx) => {
    // Handle groups owned by the user (groups.owner_id has no cascade). Detach
    // associated projects first, then delete the groups.
    const ownedGroups = await tx.select().from(groups).where(eq(groups.ownerId, userId))
    const ownedGroupIds = ownedGroups.map((group) => group.id)
    if (ownedGroupIds.length > 0) {
      for (const groupId of ownedGroupIds) {
        await tx.update(projects).set({ groupId: null }).where(eq(projects.groupId, groupId))
      }
      await tx.delete(groups).where(eq(groups.ownerId, userId))
    }

    // Delete owned projects. Schema-level CASCADE handles members, invitations,
    // files, ai_conversations, and canvas_recycle_bin; we still need to close
    // WebSocket rooms and remove in-memory Yjs state for canvases.
    const ownedProjects = await tx.select().from(projects).where(eq(projects.ownerId, userId))

    for (const project of ownedProjects) {
      const projectCanvases = await tx.select().from(canvases).where(eq(canvases.projectId, project.id))
      for (const canvas of projectCanvases) {
        closeRoom(canvas.id, 'project-deleted')
      }

      const canvasIds = projectCanvases.map((canvas) => canvas.id)
      if (canvasIds.length > 0) {
        await tx.delete(canvases).where(inArray(canvases.id, canvasIds))
        for (const canvasId of canvasIds) {
          removeCanvasState(canvasId)
        }
      }

      const rootFolders = await tx
        .select()
        .from(folders)
        .where(and(eq(folders.projectId, project.id), isNull(folders.parentId)))
      for (const folder of rootFolders) {
        await tx.delete(folders).where(eq(folders.id, folder.id))
      }

      await tx.delete(projects).where(eq(projects.id, project.id))
    }

    // Schema-level CASCADE now handles the rest:
    // - settings, group_members, project_members, project_invitations
    // - node_cards (user_id CASCADE; created_by SET NULL)
    // - node_pool_folders
    // - files
    // - canvas_recycle_bin (deleted_by CASCADE)
    // - ai_conversations (user_id CASCADE)
    await tx.delete(users).where(eq(users.id, userId))
  })

  res.json({
    success: true,
    data: { message: 'Account deleted successfully' },
  })
}))

// Get node defaults
userRouter.get('/settings/node-defaults', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const userId = req.user!.id

  const result = await db
    .select()
    .from(settings)
    .where(and(eq(settings.userId, userId), eq(settings.key, 'node_defaults')))

  const nodeDefaults = { ...SHARED_NODE_DEFAULTS }

  if (result.length > 0 && result[0].value) {
    try {
      const parsed = JSON.parse(result[0].value)
      if (parsed.textNode) nodeDefaults.textNode = { ...SHARED_NODE_DEFAULTS.textNode, ...parsed.textNode }
      if (parsed.imageNode) nodeDefaults.imageNode = { ...SHARED_NODE_DEFAULTS.imageNode, ...parsed.imageNode }
    } catch (e) {
      logError('Failed to parse node defaults', e)
    }
  }

  res.json({
    success: true,
    data: nodeDefaults,
  })
}))

// Update node defaults
userRouter.put('/settings/node-defaults', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const userId = req.user!.id
  const { textNode, imageNode } = req.body

  if (!textNode || !imageNode) {
    return res.status(400).json({
      success: false,
      error: 'textNode and imageNode are required',
    })
  }

  const validation = NODE_DEFAULTS_VALIDATION

  // B5: 数值校验前先 Number() 归一——字符串 '150' 用 < / > 比较会被隐式
  // 转换绕过（'150' < 100 为 false，校验形同虚设），字符串值直接入库污染
  // 设置。归一化后写回数值类型，保证设置读取端拿到的是数字。
  const normalizeNumber = (
    value: unknown,
    min: number,
    max: number
  ): number | null => {
    if (typeof value !== 'number' && typeof value !== 'string') return null
    const num = typeof value === 'string' && value.trim() === '' ? NaN : Number(value)
    if (isNaN(num) || num < min || num > max) return null
    return num
  }

  const textNodeWidth = normalizeNumber(textNode.width, validation.textNode.minWidth, validation.textNode.maxWidth)
  if (textNodeWidth === null) {
    return res.status(400).json({
      success: false,
      error: `textNode width must be a number between ${validation.textNode.minWidth} and ${validation.textNode.maxWidth}`,
    })
  }

  const textNodeHeight = normalizeNumber(textNode.height, validation.textNode.minHeight, validation.textNode.maxHeight)
  if (textNodeHeight === null) {
    return res.status(400).json({
      success: false,
      error: `textNode height must be a number between ${validation.textNode.minHeight} and ${validation.textNode.maxHeight}`,
    })
  }

  const textNodeFontSize = normalizeNumber(textNode.fontSize, validation.textNode.minFontSize, validation.textNode.maxFontSize)
  if (textNodeFontSize === null) {
    return res.status(400).json({
      success: false,
      error: `textNode fontSize must be a number between ${validation.textNode.minFontSize} and ${validation.textNode.maxFontSize}`,
    })
  }

  const imageNodeWidth = normalizeNumber(imageNode.width, validation.imageNode.minWidth, validation.imageNode.maxWidth)
  if (imageNodeWidth === null) {
    return res.status(400).json({
      success: false,
      error: `imageNode width must be a number between ${validation.imageNode.minWidth} and ${validation.imageNode.maxWidth}`,
    })
  }

  const imageNodeHeight = normalizeNumber(imageNode.height, validation.imageNode.minHeight, validation.imageNode.maxHeight)
  if (imageNodeHeight === null) {
    return res.status(400).json({
      success: false,
      error: `imageNode height must be a number between ${validation.imageNode.minHeight} and ${validation.imageNode.maxHeight}`,
    })
  }

  const imageNodeFontSize = normalizeNumber(imageNode.fontSize, validation.imageNode.minFontSize, validation.imageNode.maxFontSize)
  if (imageNodeFontSize === null) {
    return res.status(400).json({
      success: false,
      error: `imageNode fontSize must be a number between ${validation.imageNode.minFontSize} and ${validation.imageNode.maxFontSize}`,
    })
  }

  // 归一化后的数值写回（保留对象其他字段不变）
  const value = JSON.stringify({
    textNode: { ...textNode, width: textNodeWidth, height: textNodeHeight, fontSize: textNodeFontSize },
    imageNode: { ...imageNode, width: imageNodeWidth, height: imageNodeHeight, fontSize: imageNodeFontSize },
  })

  const existing = await db
    .select()
    .from(settings)
    .where(and(eq(settings.userId, userId), eq(settings.key, 'node_defaults')))

  if (existing.length > 0) {
    await db
      .update(settings)
      .set({ value })
      .where(eq(settings.id, existing[0].id))
  } else {
    await db.insert(settings).values({
      userId,
      key: 'node_defaults',
      value,
      category: 'node',
    })
  }

  res.json({
    success: true,
    data: { textNode, imageNode },
  })
}))

// Search users by email or nickname
userRouter.get('/search', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const { q } = req.query

  if (!q || typeof q !== 'string' || q.trim().length === 0) {
    return res.json({
      success: true,
      data: [],
    })
  }

  const searchTerm = `%${q.trim()}%`

  const foundUsers = await db
    .select({
      id: users.id,
      email: users.email,
      nickname: users.nickname,
      avatar: users.avatar,
      created_at: users.createdAt,
      updated_at: users.updatedAt,
    })
    .from(users)
    .where(
      or(
        like(users.email, searchTerm),
        like(users.nickname, searchTerm)
      )
    )
    .limit(20)

  const formattedUsers = foundUsers.map(user => ({
    id: user.id,
    email: user.email,
    nickname: user.nickname,
    avatar: user.avatar,
    created_at: user.created_at,
    updated_at: user.updated_at,
  }))

  res.json({
    success: true,
    data: formattedUsers,
  })
}))

// ========== Node Pool API (User-specific) ==========

// Get user's node pool
userRouter.get('/node-pool', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const userId = req.user!.id

  const nodes = await db.query.nodeCards.findMany({
    where: eq(nodeCards.userId, userId),
    orderBy: (nodeCards, { desc }) => [desc(nodeCards.useCount)],
  })

  const transformedNodes = transformResponseArray(nodes, ['createdAt'])

  res.json({
    success: true,
    data: transformedNodes,
  })
}))

// Add node to user's pool
userRouter.post('/node-pool', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const userId = req.user!.id
  const { name, content, type, color, tags, image_url, thumbnail, folderId, description, sortOrder } = req.body

  if (!name || !content) {
    return res.status(400).json({
      success: false,
      error: '名称和内容为必填项',
    })
  }

  // B6: name/content 加长度上限，防止超长内容入库拖垮列表接口。
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 200) {
    return res.status(400).json({
      success: false,
      error: '名称长度需在 1-200 字符之间',
    })
  }
  if (typeof content !== 'string' || content.length > 5000) {
    return res.status(400).json({
      success: false,
      error: '内容长度不能超过 5000 字符',
    })
  }

  // B6: folderId 必须存在且属于当前用户，防止把节点挂到他人文件夹下。
  let resolvedFolderId: number | null = null
  if (folderId !== undefined && folderId !== null && folderId !== '') {
    const numericFolderId = typeof folderId === 'number'
      ? folderId
      : parseInt(String(folderId), 10)
    if (isNaN(numericFolderId)) {
      return res.status(400).json({
        success: false,
        error: '无效的文件夹',
      })
    }
    const folder = await db.query.nodePoolFolders.findFirst({
      where: eq(nodePoolFolders.id, numericFolderId),
    })
    if (!folder || getUserId(folder) !== userId) {
      return res.status(400).json({
        success: false,
        error: '文件夹不属于当前用户',
      })
    }
    resolvedFolderId = numericFolderId
  }

  const [newNode] = await db
    .insert(nodeCards)
    .values({
      userId,
      name,
      content,
      type: type || 'text',
      color: color || '#ffffff',
      tags: tags || null,
      thumbnail: thumbnail || image_url || null,
      createdBy: userId,
      folderId: resolvedFolderId,
      description: description || null,
      sortOrder: sortOrder || 0,
    })
    .returning()

  const transformedNode = transformResponse(newNode, ['createdAt'])

  res.json({
    success: true,
    data: transformedNode,
  })
}))

// Update node card in pool
userRouter.put('/node-pool/:id', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const userId = req.user!.id
  const nodeId = parseInt(req.params.id, 10)
  if (isNaN(nodeId)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid node ID format',
    })
  }

  const { name, description, folderId, sortOrder } = req.body

  // B6: 更新时同样校验 name 长度与 folderId 归属。
  if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0 || name.length > 200)) {
    return res.status(400).json({
      success: false,
      error: '名称长度需在 1-200 字符之间',
    })
  }
  // 归一后的数值写入独立变量（folderId 是解构 const，不可重赋值）
  let normalizedFolderId: number | null | undefined = folderId === undefined ? undefined : null
  if (folderId !== undefined && folderId !== null && folderId !== '') {
    const numericFolderId = typeof folderId === 'number'
      ? folderId
      : parseInt(String(folderId), 10)
    if (isNaN(numericFolderId)) {
      return res.status(400).json({
        success: false,
        error: '无效的文件夹',
      })
    }
    const folder = await db.query.nodePoolFolders.findFirst({
      where: eq(nodePoolFolders.id, numericFolderId),
    })
    if (!folder || getUserId(folder) !== userId) {
      return res.status(400).json({
        success: false,
        error: '文件夹不属于当前用户',
      })
    }
    normalizedFolderId = numericFolderId
  }

  const node = await db.query.nodeCards.findFirst({
    where: eq(nodeCards.id, nodeId),
  })

  if (!node) {
    return res.status(404).json({
      success: false,
      error: '节点未找到',
    })
  }

  if (getUserId(node) !== userId) {
    return res.status(403).json({
      success: false,
      error: '无权修改此节点',
    })
  }

  const nodeSortOrder = node.sortOrder || 0

  const [updatedNode] = await db
    .update(nodeCards)
    .set({
      name: name !== undefined ? name : node.name,
      description: description !== undefined ? description : node.description,
      folderId: normalizedFolderId === undefined ? node.folderId : normalizedFolderId,
      sortOrder: sortOrder !== undefined ? sortOrder : nodeSortOrder,
    })
    .where(eq(nodeCards.id, nodeId))
    .returning()

  const transformedNode = transformResponse(updatedNode, ['createdAt'])

  res.json({
    success: true,
    data: transformedNode,
  })
}))

// Remove node from pool
userRouter.delete('/node-pool/:id', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const userId = req.user!.id
  const nodeId = parseInt(req.params.id, 10)
  if (isNaN(nodeId)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid node ID format',
    })
  }

  const node = await db.query.nodeCards.findFirst({
    where: eq(nodeCards.id, nodeId),
  })

  if (!node) {
    return res.status(404).json({
      success: false,
      error: '节点未找到',
    })
  }

  if (getUserId(node) !== userId) {
    return res.status(403).json({
      success: false,
      error: '无权删除此节点',
    })
  }

  await db.delete(nodeCards).where(eq(nodeCards.id, nodeId))

  res.json({
    success: true,
    data: { message: 'Node removed from pool' },
  })
}))

// Increment node card use count
userRouter.post('/node-pool/:id/increment-use', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const userId = req.user!.id
  const nodeId = parseInt(req.params.id, 10)
  if (isNaN(nodeId)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid node ID format',
    })
  }

  const node = await db.query.nodeCards.findFirst({
    where: eq(nodeCards.id, nodeId),
  })

  if (!node) {
    return res.status(404).json({
      success: false,
      error: '节点未找到',
    })
  }

  if (getUserId(node) !== userId) {
    return res.status(403).json({
      success: false,
      error: '无权操作此节点',
    })
  }

  const currentUseCount = node.useCount || 0

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
}))

// ========== Node Pool Folders API (User-specific) ==========

// Get user's node pool folders
userRouter.get('/node-pool-folders', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const userId = req.user!.id

  const folders = await db.query.nodePoolFolders.findMany({
    where: eq(nodePoolFolders.userId, userId),
    orderBy: (nodePoolFolders, { asc }) => [asc(nodePoolFolders.sortOrder)],
  })

  const transformedFolders = transformResponseArray(folders, ['createdAt'])

  res.json({
    success: true,
    data: transformedFolders,
  })
}))

// Create node pool folder
userRouter.post('/node-pool-folders', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const userId = req.user!.id
  const { name, parentId, sortOrder, collapsed } = req.body

  // B7 同类顺手修复: 创建时 parentId 必须属于当前用户，防止跨用户挂载
  let resolvedParentId: number | null = null
  if (parentId !== undefined && parentId !== null && parentId !== '') {
    const numericParentId = typeof parentId === 'number'
      ? parentId
      : parseInt(String(parentId), 10)
    if (isNaN(numericParentId)) {
      return res.status(400).json({
        success: false,
        error: '无效的父文件夹',
      })
    }
    const parentFolder = await db.query.nodePoolFolders.findFirst({
      where: eq(nodePoolFolders.id, numericParentId),
    })
    if (!parentFolder) {
      return res.status(404).json({
        success: false,
        error: '父文件夹未找到',
      })
    }
    if (getUserId(parentFolder) !== userId) {
      return res.status(403).json({
        success: false,
        error: '无权使用此父文件夹',
      })
    }
    resolvedParentId = numericParentId
  }

  const result = await db
    .insert(nodePoolFolders)
    .values({
      userId,
      name,
      parentId: resolvedParentId,
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
}))

// Update node pool folder
userRouter.put('/node-pool-folders/:id', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const userId = req.user!.id
  const folderId = parseInt(req.params.id, 10)
  if (isNaN(folderId)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid folder ID format',
    })
  }

  const { name, parentId, sortOrder, collapsed } = req.body

  const folder = await db.query.nodePoolFolders.findFirst({
    where: eq(nodePoolFolders.id, folderId),
  })

  if (!folder) {
    return res.status(404).json({
      success: false,
      error: '文件夹未找到',
    })
  }

  if (getUserId(folder) !== userId) {
    return res.status(403).json({
      success: false,
      error: '无权修改此文件夹',
    })
  }

  // B7: 归一后的数值写入独立变量（parentId 是解构 const，不可重赋值）；
  // undefined = 未提供保持原值，null = 显式移到根级，number = 新父级。
  let resolvedParentId: number | null | undefined = parentId === undefined ? undefined : null
  if (parentId !== undefined && parentId !== null) {
    const numericParentId = typeof parentId === 'number'
      ? parentId
      : parseInt(String(parentId), 10)
    if (isNaN(numericParentId)) {
      return res.status(400).json({
        success: false,
        error: '无效的父文件夹',
      })
    }

    // B7: 环检测——parentId 不能是自身，也不能是自身子孙。成环后前端树
    // 渲染死循环，且删除时 SQLite 递归 CASCADE 可能触发触发器深度上限。
    if (numericParentId === folderId) {
      return res.status(400).json({
        success: false,
        error: '父文件夹不能是自身',
      })
    }

    const parentFolder = await db.query.nodePoolFolders.findFirst({
      where: eq(nodePoolFolders.id, numericParentId),
    })

    if (!parentFolder) {
      return res.status(404).json({
        success: false,
        error: '父文件夹未找到',
      })
    }

    if (getUserId(parentFolder) !== userId) {
      return res.status(403).json({
        success: false,
        error: '无权使用此父文件夹',
      })
    }

    // 沿新父链上溯，遇到 folderId 即成环（folderId 将成为 numericParentId 的祖先）。
    // visited 集合防既有脏数据造成的死循环。
    let cursorId: number | null = numericParentId
    const visited = new Set<number>()
    while (cursorId !== null) {
      if (cursorId === folderId) {
        return res.status(400).json({
          success: false,
          error: '不能将文件夹移动到其子文件夹下',
        })
      }
      if (visited.has(cursorId)) break
      visited.add(cursorId)
      const cursorFolder = await db.query.nodePoolFolders.findFirst({
        where: eq(nodePoolFolders.id, cursorId),
      })
      cursorId = cursorFolder ? (cursorFolder.parentId ?? null) : null
    }

    resolvedParentId = numericParentId
  }

  const result = await db
    .update(nodePoolFolders)
    .set({
      name: name !== undefined ? name : folder.name,
      parentId: resolvedParentId === undefined ? folder.parentId : resolvedParentId,
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
}))

// Delete node pool folder
userRouter.delete('/node-pool-folders/:id', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const userId = req.user!.id
  const folderId = parseInt(req.params.id, 10)

  if (isNaN(folderId)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid folder ID format',
    })
  }

  const folder = await db.query.nodePoolFolders.findFirst({
    where: eq(nodePoolFolders.id, folderId),
  })

  if (!folder) {
    return res.status(404).json({
      success: false,
      error: '文件夹未找到',
    })
  }

  if (getUserId(folder) !== userId) {
    return res.status(403).json({
      success: false,
      error: '无权删除此文件夹',
    })
  }

  // Schema-level CASCADE on parent_id deletes subfolders automatically;
  // folder_id ON DELETE SET NULL moves affected cards to the root.
  await db.delete(nodePoolFolders).where(eq(nodePoolFolders.id, folderId))

  res.json({
    success: true,
    data: { message: 'Folder deleted' },
  })
}))
