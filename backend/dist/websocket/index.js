import * as Y from 'yjs';
import { db } from '../database/connection.js';
import { canvases, projects } from '../database/schema.js';
import { eq } from 'drizzle-orm';
import { getValidatedEnv } from '../utils/env.js';
const wsConnectionRates = new Map();
const WS_MAX_CONNECTIONS_PER_MINUTE = 10;
const WS_WINDOW_MS = 60 * 1000;
function checkWsRateLimit(ip) {
    const now = Date.now();
    const rateData = wsConnectionRates.get(ip);
    if (!rateData || now > rateData.resetTime) {
        wsConnectionRates.set(ip, {
            count: 1,
            resetTime: now + WS_WINDOW_MS,
        });
        return true;
    }
    if (rateData.count >= WS_MAX_CONNECTIONS_PER_MINUTE) {
        console.warn(`WebSocket rate limit exceeded for IP: ${ip}`);
        return false;
    }
    rateData.count++;
    return true;
}
const canvasRooms = new Map();
const MESSAGE_SYNC = 0;
const MESSAGE_QUERY_AWARENESS = 1;
const MESSAGE_AWARENESS = 2;
const MESSAGE_BROADCAST = 3;
export function setupWebSocket(wss) {
    wss.on('connection', handleConnection);
    setInterval(() => {
        const now = Date.now();
        for (const [ip, rateData] of wsConnectionRates.entries()) {
            if (now > rateData.resetTime) {
                wsConnectionRates.delete(ip);
            }
        }
        for (const [canvasId, room] of canvasRooms.entries()) {
            if (room.clients.size === 0) {
                saveCanvasDocument(canvasId, room.doc);
                room.doc.destroy();
                canvasRooms.delete(canvasId);
            }
        }
    }, 60000);
}
async function handleConnection(ws, req) {
    const clientIp = req.socket.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';
    if (!checkWsRateLimit(clientIp)) {
        ws.close(1008, 'Too many connection attempts. Please try again later.');
        return;
    }
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const canvasIdParam = url.searchParams.get('canvasId');
    if (!canvasIdParam) {
        ws.close(1008, 'Missing canvasId');
        return;
    }
    const canvasId = parseInt(canvasIdParam);
    const authHeader = req.headers.authorization?.replace('Bearer ', '');
    if (!authHeader) {
        ws.close(1008, 'Missing authentication header');
        return;
    }
    let userId = null;
    if (authHeader) {
        try {
            const jwt = (await import('jsonwebtoken')).default;
            const env = getValidatedEnv();
            const decoded = jwt.verify(authHeader, env.JWT_SECRET);
            userId = decoded.userId;
        }
        catch (error) {
            ws.close(1008, 'Invalid token');
            return;
        }
    }
    ws.userId = userId;
    ws.canvasId = canvasId;
    if (!userId) {
        ws.close(1008, 'Authentication required');
        return;
    }
    const canvas = await db.query.canvases.findFirst({
        where: eq(canvases.id, canvasId),
    });
    if (!canvas) {
        ws.close(1008, 'Canvas not found');
        return;
    }
    const project = await db.query.projects.findFirst({
        where: eq(projects.id, canvas.projectId),
    });
    if (!project) {
        ws.close(1008, 'Project not found');
        return;
    }
    const projectOwnerId = project.ownerId ?? project.ownerId;
    if (projectOwnerId !== userId) {
        ws.close(1008, 'Access denied');
        return;
    }
    let room = canvasRooms.get(canvasId);
    if (!room) {
        const canvas = await db.query.canvases.findFirst({
            where: eq(canvases.id, canvasId),
        });
        const doc = new Y.Doc();
        if (canvas && canvas.yjsData) {
            try {
                const base64Data = canvas.yjsData;
                const data = Buffer.from(base64Data, 'base64');
                Y.applyUpdate(doc, new Uint8Array(data));
            }
            catch (error) {
            }
        }
        room = {
            id: canvasId,
            doc,
            clients: new Set(),
        };
        doc.on('update', () => {
            if (room.saveTimeout) {
                clearTimeout(room.saveTimeout);
            }
            room.saveTimeout = setTimeout(() => saveCanvasDocument(canvasId, doc), 5000);
        });
        canvasRooms.set(canvasId, room);
    }
    room.clients.add(ws);
    ws.on('message', (data) => {
        handleMessage(ws, room, data);
    });
    ws.on('close', () => {
        room.clients.delete(ws);
    });
    ws.on('error', (_) => {
    });
}
function handleMessage(ws, room, data) {
    try {
        const uint8Array = new Uint8Array(data);
        if (uint8Array.length === 0) {
            return;
        }
        const messageType = uint8Array[0];
        const messageData = uint8Array.slice(1);
        if (messageData.length === 0) {
            return;
        }
        switch (messageType) {
            case MESSAGE_SYNC:
                handleSyncMessage(ws, room, messageData);
                break;
            case MESSAGE_QUERY_AWARENESS:
            case MESSAGE_AWARENESS:
                broadcastAwareness(room, ws, messageData);
                break;
            case MESSAGE_BROADCAST:
                broadcastUpdate(room, ws, messageData);
                break;
            default:
        }
    }
    catch (error) {
    }
}
function handleSyncMessage(ws, room, data) {
    try {
        let offset = 0;
        let stateVectorLength = 0;
        let shift = 0;
        let byte;
        do {
            if (offset >= data.length)
                break;
            byte = data[offset++];
            stateVectorLength |= (byte & 0x7f) << shift;
            shift += 7;
        } while (byte & 0x80);
        let stateVector = null;
        if (stateVectorLength > 0) {
            stateVector = data.slice(offset, offset + stateVectorLength);
            offset += stateVectorLength;
        }
        let updateLength = 0;
        shift = 0;
        if (offset < data.length) {
            do {
                if (offset >= data.length)
                    break;
                byte = data[offset++];
                updateLength |= (byte & 0x7f) << shift;
                shift += 7;
            } while (byte & 0x80);
        }
        let update = null;
        if (updateLength > 0 && offset <= data.length - updateLength) {
            update = data.slice(offset, offset + updateLength);
        }
        if (stateVector !== null || (stateVectorLength === 0 && !update)) {
            const sv = stateVector || new Uint8Array(0);
            const missingUpdate = Y.encodeStateAsUpdate(room.doc, sv);
            if (missingUpdate.length > 0) {
                const syncMessage = new Uint8Array(missingUpdate.length + 1);
                syncMessage[0] = MESSAGE_SYNC;
                syncMessage.set(missingUpdate, 1);
                ws.send(syncMessage);
            }
        }
        if (update !== null && update.length > 0) {
            if (update.length === 1 && update[0] === 0) {
                return;
            }
            try {
                Y.applyUpdate(room.doc, update);
                broadcastUpdate(room, ws, update);
            }
            catch (error) {
            }
        }
    }
    catch (error) {
    }
}
function broadcastUpdate(room, sender, update) {
    const message = new Uint8Array(update.length + 1);
    message[0] = MESSAGE_SYNC;
    message.set(update, 1);
    for (const client of room.clients) {
        if (client !== sender && client.readyState === 1) {
            client.send(message);
        }
    }
}
function broadcastAwareness(room, sender, data) {
    const message = new Uint8Array(data.length + 1);
    message[0] = MESSAGE_AWARENESS;
    message.set(data, 1);
    for (const client of room.clients) {
        if (client !== sender && client.readyState === 1) {
            client.send(message);
        }
    }
}
async function saveCanvasDocument(canvasId, doc) {
    try {
        const update = Y.encodeStateAsUpdate(doc);
        const base64 = Buffer.from(update).toString('base64');
        await db
            .update(canvases)
            .set({
            yjsData: base64,
            updatedAt: Math.floor(Date.now() / 1000),
        })
            .where(eq(canvases.id, canvasId));
    }
    catch (error) {
    }
}
