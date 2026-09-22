/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
// 回归测试：协作邀请「接受」接口
//
// 背景（2026-09-23 定位）：drizzle-orm 0.30 的 better-sqlite3 driver 只支持
// **同步**事务回调。写成 `db.transaction(async (tx) => { await tx... })` 时：
//   1) better-sqlite3 检测到回调返回 Promise → 抛 "Transaction function cannot
//      return a promise"（在 COMMIT 之前抛），异常冒泡成 500「服务器内部错误」；
//   2) 但回调里的语句是在微任务里、事务已被回滚之后才执行的，于是**照常落库**。
// 净效果：接口报错，数据却变了 —— 用户看到的「报错但依然加入协作」。
//
// 本文件两条断言分别钉住这个 bug 的两个面向：
//   - 接受邀请必须返回成功（不是 500）
//   - 事务必须真的原子（中途失败时邀请状态不得被改）

import { describe, it, expect, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../database/schema.js'
import { runMigrations } from '../database/migration.js'

process.env.JWT_SECRET = 'test-jwt-secret-key-for-collaboration-accept'
process.env.JWT_EXPIRES_IN = '1h'
process.env.PORT = '3098'
process.env.WS_PORT = '3198'
process.env.DB_FILE = ':memory:'
process.env.ALLOWED_ORIGINS = 'http://localhost:5173'

let _testDb: BetterSQLite3Database<typeof schema> | null = null

vi.mock('../database/connection.js', () => {
  const mod: Record<string, any> = {
    getSqlite: vi.fn(),
    getDb: vi.fn(),
    initializeDb: vi.fn(),
    registerShutdownHandlers: vi.fn(),
  }
  Object.defineProperty(mod, 'db', {
    get() {
      return _testDb
    },
    set(val: BetterSQLite3Database<typeof schema>) {
      _testDb = val
    },
    enumerable: true,
    configurable: true,
  })
  return mod
})

vi.mock('../middleware/rateLimit.middleware.js', () => ({
  apiLimiter: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authLimiter: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))

// accept 路径不触碰 websocket，但模块被 import 会带来真实 WSS 副作用，故最小 mock
vi.mock('../websocket/index.js', () => ({
  kickUserFromRoom: vi.fn(),
  updateUserRole: vi.fn(),
}))

import { collaborationRouter } from '../controllers/collaboration.controller.js'

const signToken = (userId: number) =>
  jwt.sign({ userId }, process.env.JWT_SECRET as string, { expiresIn: '1h' })

describe('协作邀请 accept —— 事务写法回归', () => {
  let app: express.Express
  let rawDb: Database.Database
  let ownerId: number
  let inviteeId: number
  let projectId: number
  let invitationId: number
  let inviteeToken: string

  beforeEach(() => {
    rawDb = new Database(':memory:')
    rawDb.pragma('foreign_keys = ON')
    runMigrations(rawDb)
    _testDb = drizzle(rawDb, { schema })

    app = express()
    app.use(cookieParser())
    app.use(express.json())
    app.use('/api/collaboration', collaborationRouter)
    app.use(
      (err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(err.statusCode || 500).json({
          success: false,
          error: err.message || 'Internal server error',
        })
      }
    )

    const now = Math.floor(Date.now() / 1000)
    const insUser = rawDb.prepare(
      'INSERT INTO users (email, password, nickname, created_at, updated_at) VALUES (?,?,?,?,?)'
    )
    ownerId = Number(insUser.run('owner@test.com', 'hash', 'Owner', now, now).lastInsertRowid)
    inviteeId = Number(insUser.run('invitee@test.com', 'hash', 'Invitee', now, now).lastInsertRowid)

    projectId = Number(
      rawDb
        .prepare(
          'INSERT INTO projects (name, owner_id, is_public, is_collaborative, created_at, updated_at) VALUES (?,?,?,?,?,?)'
        )
        .run('P', ownerId, 0, 1, now, now).lastInsertRowid
    )

    invitationId = Number(
      rawDb
        .prepare(
          'INSERT INTO project_invitations (project_id, inviter_id, invitee_id, role, status, created_at) VALUES (?,?,?,?,?,?)'
        )
        .run(projectId, ownerId, inviteeId, 'editor', 'pending', now).lastInsertRowid
    )

    inviteeToken = signToken(inviteeId)
  })

  const acceptInvitation = () =>
    supertest(app)
      .post(`/api/collaboration/invitations/${invitationId}/accept`)
      .set('Authorization', `Bearer ${inviteeToken}`)

  const inviteStatus = () =>
    (rawDb.prepare('SELECT status FROM project_invitations WHERE id = ?').get(invitationId) as any)
      .status

  const memberCount = () =>
    (rawDb.prepare('SELECT COUNT(*) c FROM project_members WHERE project_id = ? AND user_id = ?')
      .get(projectId, inviteeId) as any).c

  it('接受邀请应返回成功，而不是 500「服务器内部错误」', async () => {
    const res = await acceptInvitation()

    // 修复前：drizzle 的 async 事务回调抛 "Transaction function cannot return a
    // promise"，被 errorHandler 转成 500 —— 这里会拿到 500。
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
  })

  it('接受后邀请状态与成员关系都应生效（且不依赖"事务外意外落库"）', async () => {
    const res = await acceptInvitation()
    expect(res.status).toBe(200)

    expect(inviteStatus()).toBe('accepted')
    expect(memberCount()).toBe(1)
  })

  it('事务必须真的原子：成员写入失败时，邀请状态不得被改成 accepted', async () => {
    // 用触发器强制让事务的第二步（insert project_members）失败
    rawDb.exec(`
      CREATE TRIGGER force_member_insert_fail
      BEFORE INSERT ON project_members
      BEGIN
        SELECT RAISE(ABORT, 'forced failure for atomicity test');
      END;
    `)

    const res = await acceptInvitation()

    // 失败必须被如实返回（不能假装成功）
    expect(res.status).toBeGreaterThanOrEqual(400)

    // 关键：第一条语句（把邀请改成 accepted）必须被回滚。
    // 修复前，两条语句都跑在事务之外 —— 状态会变成 'accepted'，这条断言即失败。
    expect(inviteStatus()).toBe('pending')
    expect(memberCount()).toBe(0)
  })
})

describe('源码守卫：禁止在 better-sqlite3 上使用 async 事务回调', () => {
  const backendSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

  const collectTsFiles = (dir: string, acc: string[] = []): string[] => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) collectTsFiles(full, acc)
      else if (entry.name.endsWith('.ts')) acc.push(full)
    }
    return acc
  }

  it('backend/src 下不应存在 db.transaction(async ...) 写法', () => {
    const offenders: string[] = []
    for (const file of collectTsFiles(backendSrc)) {
      const text = fs.readFileSync(file, 'utf8')
      if (/\.transaction\(\s*async\b/.test(text)) {
        offenders.push(path.relative(backendSrc, file))
      }
    }
    // 说明：drizzle-orm 0.30 的 better-sqlite3 driver 用同步事务，
    // 传 async 回调会抛 "Transaction function cannot return a promise"，
    // 且语句会在事务被回滚之后才落库（报错但数据已变）。
    // 正确写法：同步回调 + .run()/.all()/.get()。
    expect(offenders).toEqual([])
  })
})
