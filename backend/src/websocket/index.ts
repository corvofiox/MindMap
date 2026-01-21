import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import * as Y from 'yjs'
import { db } from '../database/connection.js'
import { canvases, projects } from '../database/schema.js'
import { eq } from 'drizzle-orm'
import { getValidatedEnv } from '../utils/env.js'
import { logError } from '../utils/logger.js'

// WebSocket connection rate limiting
const wsConnectionRates = new Map<string, { count: number; resetTime: number }>()
const WS_MAX_CONNECTIONS_PER_MINUTE = 10
const WS_WINDOW_MS = 60 * 1000 // 1 minute

function checkWsRateLimit(ip: string): boolean {
  const now = Date.now()
  const rateData = wsConnectionRates.get(ip)

  if (!rateData || now > rateData.resetTime) {
    // Reset or create new rate limit entry
    wsConnectionRates.set(ip, {
      count: 1,
      resetTime: now + WS_WINDOW_MS,
    })
    return true
  }

  if (rateData.count >= WS_MAX_CONNECTIONS_PER_MINUTE) {
    console.warn(`WebSocket rate limit exceeded for IP: ${ip}`)
    return false
  }

  rateData.count++
  return true
}

interface WebSocketWithUserData extends WebSocket {
  userId?: number | null
  canvasId?: number
}

interface CanvasRoom {
  id: number
  doc: Y.Doc
  clients: Set<WebSocketWithUserData>
  saveTimeout?: ReturnType<typeof setTimeout>
}

const canvasRooms = new Map<number, CanvasRoom>()

// y-websocket message types
const MESSAGE_SYNC = 0
const MESSAGE_QUERY_AWARENESS = 1
const MESSAGE_AWARENESS = 2
const MESSAGE_BROADCAST = 3

export function setupWebSocket(wss: WebSocketServer) {
  wss.on('connection', handleConnection)

  // Periodic cleanup
  setInterval(() => {
    const now = Date.now()

    // Clean up rate limit entries
    for (const [ip, rateData] of wsConnectionRates.entries()) {
      if (now > rateData.resetTime) {
        wsConnectionRates.delete(ip)
      }
    }

    // Clean up canvas rooms
    for (const [canvasId, room] of canvasRooms.entries()) {
      if (room.clients.size === 0) {
        // Save document before cleanup
        saveCanvasDocument(canvasId, room.doc)
        room.doc.destroy()
        canvasRooms.delete(canvasId)
      }
    }
  }, 60000) // Check every minute
}

async function handleConnection(ws: WebSocketWithUserData, req: any) {
  const clientIp = req.socket.remoteAddress || req.headers['x-forwarded-for'] as string || 'unknown'

  // Check rate limit for WebSocket connections
  if (!checkWsRateLimit(clientIp)) {
    ws.close(1008, 'Too many connection attempts. Please try again later.')
    return
  }

  const url = new URL(req.url || '', `http://${req.headers.host}`)
  const canvasIdParam = url.searchParams.get('canvasId')

  if (!canvasIdParam) {
    ws.close(1008, 'Missing canvasId')
    return
  }

  const canvasId = parseInt(canvasIdParam, 10)
  if (isNaN(canvasId)) {
    ws.close(1008, 'Invalid canvas ID format')
    return
  }

  // Verify token from Authorization header
  const authHeader = req.headers.authorization?.replace('Bearer ', '')
  if (!authHeader) {
    ws.close(1008, 'Missing authentication header')
    return
  }

  // Verify token and get user ID
  let userId: number | null = null
  if (authHeader) {
    try {
      const jwt = (await import('jsonwebtoken')).default
      const env = getValidatedEnv()
      const decoded = jwt.verify(authHeader, env.JWT_SECRET) as { userId: number }
      userId = decoded.userId
    } catch (error) {
      ws.close(1008, 'Invalid token')
      return
    }
  }

  ws.userId = userId
  ws.canvasId = canvasId

  if (!userId) {
    ws.close(1008, 'Authentication required')
    return
  }

  const canvas = await db.query.canvases.findFirst({
    where: eq(canvases.id, canvasId),
  })

  if (!canvas) {
    ws.close(1008, 'Canvas not found')
    return
  }

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, canvas.projectId),
  })

  if (!project) {
    ws.close(1008, 'Project not found')
    return
  }

  const projectOwnerId = project.ownerId ?? project.ownerId

  if (projectOwnerId !== userId) {
    ws.close(1008, 'Access denied')
    return
  }

  let room = canvasRooms.get(canvasId)
  if (!room) {
    // Load existing document from database
    const canvas = await db.query.canvases.findFirst({
      where: eq(canvases.id, canvasId),
    })

    const doc = new Y.Doc()

    if (canvas && (canvas as any).yjsData) {
      try {
        const base64Data = (canvas as any).yjsData
        const data = Buffer.from(base64Data, 'base64')
        Y.applyUpdate(doc, new Uint8Array(data))
      } catch (error) {
        logError('Failed to load Yjs document from database', {
          canvasId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        })
        // If loading fails, create empty document
      }
    }

    room = {
      id: canvasId,
      doc,
      clients: new Set(),
    }

    // Set up document persistence
    doc.on('update', () => {
      // Debounced save
      if (room!.saveTimeout) {
        clearTimeout(room!.saveTimeout)
      }
      room!.saveTimeout = setTimeout(
        () => saveCanvasDocument(canvasId, doc),
        5000
      )
    })

    canvasRooms.set(canvasId, room)
  }

  room.clients.add(ws)

  // Handle binary messages (y-websocket format)
  ws.on('message', (data: Buffer) => {
    handleMessage(ws, room!, data)
  })

  ws.on('close', () => {
    room!.clients.delete(ws)
  })

  ws.on('error', (error) => {
    logError('WebSocket connection error', {
      userId: ws.userId,
      canvasId: ws.canvasId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
  })
}

function handleMessage(ws: WebSocketWithUserData, room: CanvasRoom, data: Buffer) {
  try {
    const uint8Array = new Uint8Array(data)

    if (uint8Array.length === 0) {
      return
    }

    const messageType = uint8Array[0]
    const messageData = uint8Array.slice(1)

    // If message has only type byte and no data, skip processing
    if (messageData.length === 0) {
      return
    }

    switch (messageType) {
      case MESSAGE_SYNC:
        // SYNC message may contain: state vector, document update or both
        handleSyncMessage(ws, room, messageData)
        break

      case MESSAGE_QUERY_AWARENESS:
      case MESSAGE_AWARENESS:
        // Handle awareness (not fully implemented)
        broadcastAwareness(room, ws, messageData)
        break

      case MESSAGE_BROADCAST:
        // Broadcast message to all other clients
        broadcastUpdate(room, ws, messageData)
        break

      default:
        // Unknown message type - ignore
    }
  } catch (error) {
    logError('WebSocket message handling error', {
      userId: ws.userId,
      canvasId: ws.canvasId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
  }
}

// Handle y-websocket SYNC message
// SYNC message format:
// - [state vector length: varint, state vector: bytes, update length: varint, update: bytes]
// - [state vector length: varint, state vector: bytes]
// - [update length: varint, update: bytes]
function handleSyncMessage(
  ws: WebSocketWithUserData,
  room: CanvasRoom,
  data: Uint8Array
) {
  try {
    let offset = 0

    // Read state vector length (varint)
    let stateVectorLength = 0
    let shift = 0
    let byte: number
    do {
      if (offset >= data.length) break
      byte = data[offset++]
      stateVectorLength |= (byte & 0x7f) << shift
      shift += 7
    } while (byte & 0x80)

    // Read state vector (if present)
    let stateVector: Uint8Array | null = null
    if (stateVectorLength > 0) {
      stateVector = data.slice(offset, offset + stateVectorLength)
      offset += stateVectorLength
    }

    // Read update length (varint)
    let updateLength = 0
    shift = 0
    if (offset < data.length) {
      do {
        if (offset >= data.length) break
        byte = data[offset++]
        updateLength |= (byte & 0x7f) << shift
        shift += 7
      } while (byte & 0x80)
    }

    // Read update (if present)
    let update: Uint8Array | null = null
    if (updateLength > 0 && offset <= data.length - updateLength) {
      update = data.slice(offset, offset + updateLength)
    }

    // If there's a state vector, compute and send missing updates
    if (stateVector !== null || (stateVectorLength === 0 && !update)) {
      // stateVectorLength === 0 means client wants full state
      const sv = stateVector || new Uint8Array(0)
      const missingUpdate = Y.encodeStateAsUpdate(room.doc, sv)

      if (missingUpdate.length > 0) {
        const syncMessage = new Uint8Array(missingUpdate.length + 1)
        syncMessage[0] = MESSAGE_SYNC
        syncMessage.set(missingUpdate, 1)
        ws.send(syncMessage)
      }
    }

    // If there's an update, apply it
    if (update !== null && update.length > 0) {
      // Skip invalid updates (like single 0x00 byte, which represents empty update)
      if (update.length === 1 && update[0] === 0) {
        return
      }

      try {
        Y.applyUpdate(room.doc, update)

        // Broadcast to other clients
        broadcastUpdate(room, ws, update)
      } catch (error) {
        logError('Failed to apply Yjs update', {
          userId: ws.userId,
          canvasId: ws.canvasId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        })
      }
    }

  } catch (error) {
    logError('WebSocket SYNC message handling error', {
      userId: ws.userId,
      canvasId: ws.canvasId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
  }
}


function broadcastUpdate(
  room: CanvasRoom,
  sender: WebSocketWithUserData,
  update: Uint8Array
) {
  // Create y-websocket format message
  const message = new Uint8Array(update.length + 1)
  message[0] = MESSAGE_SYNC
  message.set(update, 1)

  for (const client of room.clients) {
    if (client !== sender && client.readyState === 1) {
      client.send(message)
    }
  }
}

function broadcastAwareness(
  room: CanvasRoom,
  sender: WebSocketWithUserData,
  data: Uint8Array
) {
  // Create y-websocket format awareness message
  const message = new Uint8Array(data.length + 1)
  message[0] = MESSAGE_AWARENESS
  message.set(data, 1)

  for (const client of room.clients) {
    if (client !== sender && client.readyState === 1) {
      client.send(message)
    }
  }
}

async function saveCanvasDocument(canvasId: number, doc: Y.Doc) {
  try {
    const update = Y.encodeStateAsUpdate(doc)
    const base64 = Buffer.from(update).toString('base64')

    await db
      .update(canvases)
      .set({
        yjsData: base64,
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(canvases.id, canvasId))
  } catch (error) {
    logError('Failed to save canvas document', {
      canvasId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    })
    // TODO: Consider implementing retry logic or notifying user about save failure
  }
}
