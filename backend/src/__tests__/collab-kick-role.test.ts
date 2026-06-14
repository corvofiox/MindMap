/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
// P3 单元测试：验证 kickUserFromRoom / updateUserRole 的真实行为。
// 通过 _setRoomForTesting 注入受控的 room/client，验证 send kicked 消息、
// terminate、引用计数清理、user-role-changed 广播等完整链路。

vi.mock('../utils/logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('../database/connection', () => ({
  db: {
    query: {
      canvases: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
      projects: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ run: vi.fn() }) }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ run: vi.fn() }) }) }),
  },
  scheduleSave: vi.fn(),
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => true),
  and: vi.fn(() => true),
  or: vi.fn(() => true),
  sql: vi.fn(),
}))

// mock canvas-state，避免 kick 后 room 变空触发真实的 flushPendingPersist/persist 副作用
vi.mock('../websocket/canvas-state', () => ({
  loadCanvasStateFromDb: vi.fn().mockResolvedValue(undefined),
  ensureCanvasStateLoaded: vi.fn().mockResolvedValue(undefined),
  getSyncData: vi.fn().mockReturnValue({ nodes: [], groups: [], domains: [], connections: [], version: 0 }),
  persistCanvasState: vi.fn().mockResolvedValue(true),
  applyAddNode: vi.fn(),
  applyUpdateNode: vi.fn(),
  applyRemoveNode: vi.fn(),
  applyAddGroup: vi.fn(),
  applyUpdateGroup: vi.fn(),
  applyRemoveGroup: vi.fn(),
  applyAddDomain: vi.fn(),
  applyUpdateDomain: vi.fn(),
  applyRemoveDomain: vi.fn(),
  applyAddConnection: vi.fn(),
  applyUpdateConnection: vi.fn(),
  applyRemoveConnection: vi.fn(),
  applyBatchOperations: vi.fn(),
  removeCanvasState: vi.fn(),
  flushPendingPersist: vi.fn(),
  getCanvasState: vi.fn().mockReturnValue(undefined),
  isCanvasStatePersisted: vi.fn().mockReturnValue(true),
  startPeriodicCanvasFlush: vi.fn(),
  stopPeriodicCanvasFlush: vi.fn(),
  incrementStateGeneration: vi.fn(),
  getStateGeneration: vi.fn().mockReturnValue(0),
}))

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  kickUserFromRoom,
  updateUserRole,
  _setRoomForTesting,
  type CanvasRoom,
} from '../websocket/index.js'
import { flushPendingPersist } from '../websocket/canvas-state.js'

// 构造 mock client：具备 kick/role 路径所需的最小字段
function makeMockClient(userId: number, role: 'editor' | 'viewer' = 'editor') {
  const client = {
    userId,
    canvasId: 1,
    userRole: role,
    userInfo: { userId, email: `u${userId}@x.com`, nickname: `u${userId}`, avatar: null, role, joinedAt: 0 },
    readyState: 1, // OPEN
    send: vi.fn(),
    terminate: vi.fn(),
    close: vi.fn(),
  }
  return client as any
}

function makeRoom(id: number, clients: any[]): CanvasRoom {
  const room: CanvasRoom = {
    id,
    clients: new Set(clients),
    activeUsers: new Map(),
    userConnectionCounts: new Map(),
  }
  for (const c of clients) {
    if (c.userId) {
      room.activeUsers.set(c.userId, c.userInfo)
      room.userConnectionCounts.set(c.userId, (room.userConnectionCounts.get(c.userId) || 0) + 1)
    }
  }
  return room
}

describe('P3: kickUserFromRoom / updateUserRole', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _setRoomForTesting(1, null)
  })

  describe('kickUserFromRoom — 真实行为', () => {
    it('对不存在画布应安全无操作', () => {
      expect(() => kickUserFromRoom(99999, 1, 'removed')).not.toThrow()
    })

    it('发送 kicked 消息后 terminate 目标连接', () => {
      const target = makeMockClient(5)
      const other = makeMockClient(6)
      const room = makeRoom(1, [target, other])
      _setRoomForTesting(1, room)

      kickUserFromRoom(1, 5, 'removed')

      // 目标收到 kicked 消息
      expect(target.send).toHaveBeenCalledTimes(1)
      const sent = JSON.parse(target.send.mock.calls[0][0])
      expect(sent.type).toBe('kicked')
      expect(sent.reason).toBe('removed')

      // 目标被 terminate（handleClientDisconnect shouldTerminate=true）
      expect(target.terminate).toHaveBeenCalledTimes(1)
    })

    it('踢出后从 room.clients 移除目标，其他用户保留', () => {
      const target = makeMockClient(5)
      const other = makeMockClient(6)
      const room = makeRoom(1, [target, other])
      _setRoomForTesting(1, room)

      kickUserFromRoom(1, 5)

      expect(room.clients.has(target)).toBe(false)
      expect(room.clients.has(other)).toBe(true)
      expect(room.clients.size).toBe(1)
    })

    it('最后一个连接被踢时，清理 activeUsers 并广播 user-leave', () => {
      const target = makeMockClient(5)
      const witness = makeMockClient(6) // 在场但不是踢出目标，用于接收 user-leave 广播
      const room = makeRoom(1, [target, witness])
      _setRoomForTesting(1, room)

      kickUserFromRoom(1, 5)

      // target 的引用计数归零 → 从 activeUsers 删除
      expect(room.activeUsers.has(5)).toBe(false)
      // witness 应收到 user-leave 广播（handleClientDisconnect 内 broadcastToRoom）
      const witnessSends = witness.send.mock.calls.map((c: any[]) => JSON.parse(c[0]))
      const userLeave = witnessSends.find((m: any) => m.type === 'user-leave')
      expect(userLeave).toBeDefined()
      expect(userLeave.user.userId).toBe(5)
    })

    it('同用户多连接（多标签页）：两个 tab 连接都被踢', () => {
      const tab1 = makeMockClient(5)
      const tab2 = makeMockClient(5)
      const room = makeRoom(1, [tab1, tab2])
      _setRoomForTesting(1, room)

      kickUserFromRoom(1, 5)

      // kickUserFromRoom 遍历所有匹配 userId 的连接，两个 tab 都被 terminate
      expect(tab1.terminate).toHaveBeenCalledTimes(1)
      expect(tab2.terminate).toHaveBeenCalledTimes(1)
      expect(room.clients.size).toBe(0)
    })

    it('未匹配任何连接时安全无操作', () => {
      const other = makeMockClient(6)
      const room = makeRoom(1, [other])
      _setRoomForTesting(1, room)

      kickUserFromRoom(1, 999) // 不存在的用户

      expect(other.send).not.toHaveBeenCalled()
      expect(other.terminate).not.toHaveBeenCalled()
      expect(room.clients.size).toBe(1)
    })

    it('room 变空时触发 flushPendingPersist', () => {
      const target = makeMockClient(5)
      const room = makeRoom(1, [target])
      _setRoomForTesting(1, room)

      kickUserFromRoom(1, 5)

      expect(flushPendingPersist).toHaveBeenCalledWith(1)
    })
  })

  describe('updateUserRole — 真实行为', () => {
    it('对不存在画布应安全无操作', () => {
      expect(() => updateUserRole(99999, 1, 'editor')).not.toThrow()
    })

    it('更新目标连接的 userRole 与 activeUsers', () => {
      const target = makeMockClient(5, 'viewer')
      const room = makeRoom(1, [target])
      _setRoomForTesting(1, room)

      updateUserRole(1, 5, 'editor')

      expect(target.userRole).toBe('editor')
      expect(room.activeUsers.get(5)?.role).toBe('editor')
    })

    it('广播 user-role-changed 给房间内所有连接', () => {
      const target = makeMockClient(5, 'viewer')
      const witness = makeMockClient(6)
      const room = makeRoom(1, [target, witness])
      _setRoomForTesting(1, room)

      updateUserRole(1, 5, 'editor')

      // 两条连接都应收到广播（broadcastToRoom excludeClient=null）
      for (const c of [target, witness]) {
        const sends = c.send.mock.calls.map((call: any[]) => JSON.parse(call[0]))
        const roleChanged = sends.find((m: any) => m.type === 'user-role-changed')
        expect(roleChanged).toBeDefined()
        expect(roleChanged.userId).toBe(5)
        expect(roleChanged.role).toBe('editor')
      }
    })

    it('用户不在 activeUsers 时不抛错，仍广播', () => {
      const witness = makeMockClient(6)
      const room = makeRoom(1, [witness])
      _setRoomForTesting(1, room)

      expect(() => updateUserRole(1, 999, 'editor')).not.toThrow()

      const sends = witness.send.mock.calls.map((call: any[]) => JSON.parse(call[0]))
      expect(sends.some((m: any) => m.type === 'user-role-changed' && m.userId === 999)).toBe(true)
    })

    it('接受 editor 与 viewer 角色', () => {
      const target = makeMockClient(5, 'editor')
      const room = makeRoom(1, [target])
      _setRoomForTesting(1, room)

      updateUserRole(1, 5, 'viewer')
      expect(target.userRole).toBe('viewer')

      updateUserRole(1, 5, 'editor')
      expect(target.userRole).toBe('editor')
    })
  })
})
