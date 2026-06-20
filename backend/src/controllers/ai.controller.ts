// AI Conversation Controller
// Handles persistent storage of AI chat history per canvas

import { Router } from 'express'
import { db } from '../database/connection.js'
import { aiConversations } from '../database/schema.js'
import { eq, and } from 'drizzle-orm'
import { authenticate, type AuthRequest } from '../middleware/auth.middleware.js'
import { asyncHandler } from '../middleware/error.middleware.js'

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
