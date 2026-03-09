// AI Conversation Controller
// Handles persistent storage of AI chat history per canvas

import { Router } from 'express'
import { db } from '../database/connection.js'
import { aiConversations } from '../database/schema.js'
import { eq, and } from 'drizzle-orm'
import { logError } from '../utils/logger.js'
import { authenticate } from '../middleware/auth.middleware.js'

// Message type matching frontend
interface Message {
  id: string
  role: 'user' | 'assistant' | 'divider'
  content: string
  timestamp: number
  reasoningContent?: string
  isInterrupted?: boolean
}

// Get conversation for a canvas
export async function getConversation(req, res) {
  try {
    const userId = req.user?.id
    const canvasId = parseInt(req.params.canvasId)

    if (!userId || isNaN(canvasId)) {
      return res.status(400).json({ success: false, error: 'Invalid parameters' })
    }

    const conversation = await db.query.aiConversations.findFirst({
      where: and(
        eq(aiConversations.canvasId, canvasId),
        eq(aiConversations.userId, userId)
      ),
    })

    // Check if conversation exists and has valid data
    // Drizzle ORM may return an object with undefined fields instead of null
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
        messages: JSON.parse(conversation.messages),
        contextDividerIndex: conversation.contextDividerIndex ?? -1,
      },
    })
  } catch (error) {
    logError('Failed to get AI conversation:', error)
    return res.status(500).json({ success: false, error: 'Failed to get conversation' })
  }
}

// Save or update conversation for a canvas
export async function saveConversation(req, res) {
  try {
    const userId = req.user?.id
    const canvasId = parseInt(req.params.canvasId)
    const { messages, contextDividerIndex } = req.body

    if (!userId || isNaN(canvasId)) {
      return res.status(400).json({ success: false, error: 'Invalid parameters' })
    }

    if (!Array.isArray(messages)) {
      return res.status(400).json({ success: false, error: 'Invalid messages format' })
    }

    // Check if conversation exists
    const existing = await db.query.aiConversations.findFirst({
      where: and(
        eq(aiConversations.canvasId, canvasId),
        eq(aiConversations.userId, userId)
      ),
    })

    // Check if conversation exists and has valid data
    if (existing && existing.id) {
      // Update existing conversation
      await db
        .update(aiConversations)
        .set({
          messages: JSON.stringify(messages),
          contextDividerIndex: contextDividerIndex ?? -1,
          updatedAt: Math.floor(Date.now() / 1000),
        })
        .where(eq(aiConversations.id, existing.id))
    } else {
      // Create new conversation
      await db.insert(aiConversations).values({
        canvasId,
        userId,
        messages: JSON.stringify(messages),
        contextDividerIndex: contextDividerIndex ?? -1,
        updatedAt: Math.floor(Date.now() / 1000),
      })
    }

    return res.json({ success: true })
  } catch (error) {
    logError('Failed to save AI conversation:', error)
    return res.status(500).json({ success: false, error: 'Failed to save conversation' })
  }
}

// Delete conversation for a canvas
export async function deleteConversation(req, res) {
  try {
    const userId = req.user?.id
    const canvasId = parseInt(req.params.canvasId)

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
  } catch (error) {
    logError('Failed to delete AI conversation:', error)
    return res.status(500).json({ success: false, error: 'Failed to delete conversation' })
  }
}

// Clear all conversations for a user (optional cleanup)
export async function clearAllConversations(req, res) {
  try {
    const userId = req.user?.id

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' })
    }

    await db.delete(aiConversations).where(eq(aiConversations.userId, userId))

    return res.json({ success: true })
  } catch (error) {
    logError('Failed to clear AI conversations:', error)
    return res.status(500).json({ success: false, error: 'Failed to clear conversations' })
  }
}

// Create router
const router = Router()

// All routes require authentication
router.use(authenticate)

// Get conversation for a canvas
router.get('/conversation/:canvasId', getConversation)

// Save conversation for a canvas
router.post('/conversation/:canvasId', saveConversation)

// Delete conversation for a canvas
router.delete('/conversation/:canvasId', deleteConversation)

// Clear all conversations for current user
router.delete('/conversations/all', clearAllConversations)

export { router as aiRouter }
