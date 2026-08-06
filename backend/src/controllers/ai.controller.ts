// AI Conversation Controller
// Handles persistent storage of AI chat history per canvas

import { Router } from 'express'
import type { Response } from 'express'
import { db } from '../database/connection.js'
import { aiConversations, canvases, projects, projectMembers } from '../database/schema.js'
import { eq, and } from 'drizzle-orm'
import { authenticate, type AuthRequest } from '../middleware/auth.middleware.js'
import { asyncHandler } from '../middleware/error.middleware.js'
import { getProperty } from '../utils/transformResponse.js'

// Message type matching frontend
interface Message {
  id: string
  role: 'user' | 'assistant' | 'divider'
  content: string
  timestamp: number
  reasoningContent?: string
  isInterrupted?: boolean
}

function safeJsonParse(messages: string): Message[] {
  try {
    return JSON.parse(messages) as Message[]
  } catch {
    return []
  }
}

// B5: 校验画布存在且当前用户对所属项目有访问权（owner 或成员），
// 防止通过画布 ID 越权读写他人 AI 对话。
async function checkCanvasAccess(
  canvasId: number,
  userId: number
): Promise<{ allowed: boolean; exists: boolean }> {
  const canvas = await db.query.canvases.findFirst({
    where: eq(canvases.id, canvasId),
  })
  if (!canvas) {
    return { allowed: false, exists: false }
  }

  const projectId = getProperty<number>(canvas, 'project_id', 'projectId') || canvas.projectId
  if (!projectId) {
    return { allowed: false, exists: true }
  }

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  })
  if (!project) {
    return { allowed: false, exists: true }
  }

  const projectOwnerId = getProperty<number>(project, 'owner_id', 'ownerId') || project.ownerId
  if (projectOwnerId === userId) {
    return { allowed: true, exists: true }
  }

  const member = await db.query.projectMembers.findFirst({
    where: and(
      eq(projectMembers.projectId, projectId),
      eq(projectMembers.userId, userId)
    ),
  })

  return { allowed: !!member, exists: true }
}

async function assertCanvasAccess(canvasId: number, userId: number, res: Response): Promise<boolean> {
  const access = await checkCanvasAccess(canvasId, userId)
  if (!access.allowed) {
    res.status(access.exists ? 403 : 404).json({
      success: false,
      error: access.exists ? '无权访问该画布' : '画布未找到',
    })
    return false
  }
  return true
}

// Create router
const router = Router()

// All routes require authentication
router.use(authenticate)

// Get conversation for a canvas
router.get(
  '/conversation/:canvasId',
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id
    const canvasId = parseInt(req.params.canvasId, 10)

    if (!userId || isNaN(canvasId)) {
      return res.status(400).json({ success: false, error: 'Invalid parameters' })
    }

    // B5: 画布访问权校验
    if (!(await assertCanvasAccess(canvasId, userId, res))) return

    const conversation = await db.query.aiConversations.findFirst({
      where: and(
        eq(aiConversations.canvasId, canvasId),
        eq(aiConversations.userId, userId)
      ),
    })

    if (!conversation || !conversation.id || !conversation.messages) {
      return res.json({
        success: true,
        data: {
          messages: [],
          contextDividerIndex: -1,
        },
      })
    }

    return res.json({
      success: true,
      data: {
        messages: safeJsonParse(conversation.messages),
        contextDividerIndex: conversation.contextDividerIndex ?? -1,
      },
    })
  })
)

// Save or update conversation for a canvas
router.post(
  '/conversation/:canvasId',
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id
    const canvasId = parseInt(req.params.canvasId, 10)
    const { messages, contextDividerIndex } = req.body

    if (!userId || isNaN(canvasId)) {
      return res.status(400).json({ success: false, error: 'Invalid parameters' })
    }

    if (!Array.isArray(messages)) {
      return res.status(400).json({ success: false, error: 'Invalid messages format' })
    }

    // B5: 画布访问权校验
    if (!(await assertCanvasAccess(canvasId, userId, res))) return

    const existing = await db.query.aiConversations.findFirst({
      where: and(
        eq(aiConversations.canvasId, canvasId),
        eq(aiConversations.userId, userId)
      ),
    })

    if (existing && existing.id) {
      await db
        .update(aiConversations)
        .set({
          messages: JSON.stringify(messages),
          contextDividerIndex: contextDividerIndex ?? -1,
          updatedAt: Math.floor(Date.now() / 1000),
        })
        .where(eq(aiConversations.id, existing.id))
    } else {
      await db.insert(aiConversations).values({
        canvasId,
        userId,
        messages: JSON.stringify(messages),
        contextDividerIndex: contextDividerIndex ?? -1,
        updatedAt: Math.floor(Date.now() / 1000),
      })
    }

    return res.json({ success: true })
  })
)

// Delete conversation for a canvas
router.delete(
  '/conversation/:canvasId',
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id
    const canvasId = parseInt(req.params.canvasId, 10)

    if (!userId || isNaN(canvasId)) {
      return res.status(400).json({ success: false, error: 'Invalid parameters' })
    }

    // B5: 画布访问权校验
    if (!(await assertCanvasAccess(canvasId, userId, res))) return

    await db
      .delete(aiConversations)
      .where(
        and(
          eq(aiConversations.canvasId, canvasId),
          eq(aiConversations.userId, userId)
        )
      )

    return res.json({ success: true })
  })
)

// Clear all conversations for a user (optional cleanup)
router.delete(
  '/conversations/all',
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' })
    }

    await db.delete(aiConversations).where(eq(aiConversations.userId, userId))

    return res.json({ success: true })
  })
)

export { router as aiRouter }
