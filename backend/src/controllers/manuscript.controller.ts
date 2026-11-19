/**
 * 笔记本 API —— 账号私有的手稿，以及与节点池之间的双向转换。
 *
 * 设计要点（docs/requirements-notebook.md §4/§13）：
 *   - 手稿不协作：没有 Yjs，一行 REST 记录即可。
 *   - 隔离靠 `user_id` 过滤，越权一律 404（不泄露资源是否存在）。
 *   - 转换是**移动**语义：同一个东西只在一个容器里存在。手稿转卡片的同时手稿
 *     被软删除，卡片转手稿的同时卡片被物理删除；两步在同一个事务里，不会出现
 *     "两边都有"或"两边都没有"的中间态。这与画布 ⇄ 节点池的既有行为一致
 *     （`moveNodeToPool` / `useCard` 都是搬运而不是复制）。
 *     内容本身不丢：转换只搬 title/content，来回转换能拿回正文。
 */
import { Router } from 'express'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../database/connection.js'
import { manuscriptFolders, manuscripts } from '../database/schema.js'
import { authenticate, type AuthRequest } from '../middleware/auth.middleware.js'
import { asyncHandler } from '../middleware/error.middleware.js'
import { log } from '../utils/logger.js'
import { htmlToPlainText } from 'mindmap-shared'
import {
  MAX_CONTENT,
  countImages,
  sanitizeTitle,
  toPositiveInt,
} from '../domain/rules.js'
import {
  cardToManuscriptPayload,
  manuscriptToCardPayload,
  moveCardToManuscript,
  moveManuscriptToCard,
} from '../domain/transfer.js'
import { isDomainError } from '../domain/errors.js'
import { manuscriptSearchMatch } from '../domain/notebook.js'

const router = Router()

// The payload builders moved to domain/transfer.ts so the MCP transfer tools and
// these endpoints cannot disagree on what a converted card looks like. Re-exported
// here because existing tests import them from this module.
export { cardToManuscriptPayload, manuscriptToCardPayload }

/** 只返回当前账号的、未删除的手稿；越权 = 不存在。 */
async function findOwnedManuscript(userId: number, id: number) {
  const row = await db.query.manuscripts.findFirst({
    where: and(eq(manuscripts.id, id), eq(manuscripts.userId, userId), isNull(manuscripts.deletedAt)),
  })
  return row ?? null
}

// ---- 分页 ---------------------------------------------------------------
/**
 * 一页最多多少条。
 *
 * 上限就是 200：前端左栏滚到底再取下一页，让 DOM 里的行数随"滚了多远"增长，
 * 而不是一次把几千条全塞进去（2000 行曾实测首屏 573ms、一次 340ms 长帧）。
 */
const PAGE_MAX = 200
const PAGE_DEFAULT = 200

/** 非负整数（offset 允许 0，非法值回退到 fallback）。 */
function toNonNegativeInt(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) return fallback
  return n
}

/** `folderIds=3,4,5` → `[3,4,5]`；空或全非法时返回空数组。 */
function parseIdList(value: unknown): number[] {
  if (typeof value !== 'string' || value.trim() === '') return []
  const out: number[] = []
  for (const part of value.split(',')) {
    const id = toPositiveInt(part)
    if (id !== null) out.push(id)
  }
  return out
}

// ---- 列表 ---------------------------------------------------------------
router.get(
  '/',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ success: false, error: '未提供令牌' })

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    const folderParam = req.query.folderId
    const folderId = folderParam === undefined ? undefined : toPositiveInt(folderParam)
    // 左栏选中父文件夹时要连同子孙一起列出。树的展开放在前端做（它本来就有树），
    // 服务端只按 id 集合过滤，不重复实现一遍层级逻辑。
    const folderIds = parseIdList(req.query.folderIds)
    const limit = Math.min(PAGE_MAX, Math.max(1, toNonNegativeInt(req.query.limit, PAGE_DEFAULT)))
    const offset = toNonNegativeInt(req.query.offset, 0)

    const conditions = [eq(manuscripts.userId, userId), isNull(manuscripts.deletedAt)]
    if (q) {
      // 匹配范围（标题 / 预览 / 完整正文）由 domain 定义，MCP 那边用的是同一处，
      // 免得"网页搜得到、MCP 搜不到"或者反过来。
      const match = manuscriptSearchMatch(q)
      if (match) conditions.push(match)
    }
    if (folderIds.length > 0) {
      conditions.push(inArray(manuscripts.folderId, folderIds))
    } else if (folderId !== undefined) {
      conditions.push(folderId === null ? isNull(manuscripts.folderId) : eq(manuscripts.folderId, folderId))
    }

    const where = and(...conditions)

    const rows = await db
      .select({
        id: manuscripts.id,
        folderId: manuscripts.folderId,
        title: manuscripts.title,
        previewText: manuscripts.previewText,
        imageCount: manuscripts.imageCount,
        sortOrder: manuscripts.sortOrder,
        updatedAt: manuscripts.updatedAt,
        createdAt: manuscripts.createdAt,
      })
      .from(manuscripts)
      .where(where)
      // 拖过顺序就按手排（sortOrder 升序）；没拖过的都是 0，自然按更新时间倒序
      .orderBy(asc(manuscripts.sortOrder), desc(manuscripts.updatedAt))
      .limit(limit)
      .offset(offset)

    // total 用同一套条件再数一次：翻页要知道"还有没有下一页"，也用来显示"共 N 篇"
    const totals = await db
      .select({ n: sql<number>`cast(count(*) as integer)` })
      .from(manuscripts)
      .where(where)
    const total = Number(totals[0]?.n ?? 0)

    return res.json({ success: true, data: rows, total, hasMore: offset + rows.length < total })
  }),
)

// ---- 计数（左栏徽标） ---------------------------------------------------
// 徽标不能靠"数一数已经加载的那一页"：1928 篇的文件夹只会显示成 200。
// 这里一次 GROUP BY 把所有文件夹的条数拿全，前端只在本地做子树的加总。
router.get(
  '/counts',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ success: false, error: '未提供令牌' })

    const rows = await db
      .select({ folderId: manuscripts.folderId, n: sql<number>`cast(count(*) as integer)` })
      .from(manuscripts)
      .where(and(eq(manuscripts.userId, userId), isNull(manuscripts.deletedAt)))
      .groupBy(manuscripts.folderId)

    let total = 0
    let unfiled = 0
    const byFolder: Record<string, number> = {}
    for (const row of rows) {
      const n = Number(row.n ?? 0)
      total += n
      if (row.folderId === null || row.folderId === undefined) unfiled += n
      else byFolder[String(row.folderId)] = n
    }

    return res.json({ success: true, data: { total, unfiled, byFolder } })
  }),
)

// ---- 批量排序（拖拽） ---------------------------------------------------
// 只改 sortOrder，不碰内容；只允许改自己的手稿。
router.put(
  '/reorder',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ success: false, error: '未提供令牌' })

    const updates = Array.isArray(req.body?.updates) ? req.body.updates : []
    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: '缺少排序数据' })
    }

    const userId_ = userId
    const applied: number[] = []
    for (const update of updates as Array<{ id?: unknown; sortOrder?: unknown }>) {
      const id = toPositiveInt(update?.id)
      const sortOrder = typeof update?.sortOrder === 'number' && Number.isFinite(update.sortOrder)
        ? Math.trunc(update.sortOrder)
        : null
      if (id === null || sortOrder === null) continue

      const owned = await findOwnedManuscript(userId_, id)
      if (!owned) continue

      await db.update(manuscripts).set({ sortOrder }).where(eq(manuscripts.id, id))
      applied.push(id)
    }

    return res.json({ success: true, data: { updated: applied } })
  }),
)

// ---- 新建 ---------------------------------------------------------------
router.post(
  '/',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ success: false, error: '未提供令牌' })

    const title = sanitizeTitle(req.body?.title) || '未命名手稿'
    const contentHtml = typeof req.body?.contentHtml === 'string' ? req.body.contentHtml : ''
    if (contentHtml.length > MAX_CONTENT) {
      return res.status(400).json({ success: false, error: '手稿内容过大' })
    }
    const folderId = toPositiveInt(req.body?.folderId)
    if (folderId !== null) {
      const folder = await db.query.manuscriptFolders.findFirst({
        where: and(eq(manuscriptFolders.id, folderId), eq(manuscriptFolders.userId, userId)),
      })
      if (!folder) return res.status(404).json({ success: false, error: '文件夹不存在' })
    }

    const now = Math.floor(Date.now() / 1000)
    const inserted = await db
      .insert(manuscripts)
      .values({
        userId,
        folderId,
        title,
        contentHtml,
        previewText: htmlToPlainText(contentHtml).slice(0, 500),
        imageCount: countImages(contentHtml),
        updatedAt: now,
      })
      .returning()

    return res.status(201).json({ success: true, data: inserted[0] })
  }),
)

// ---- 单篇读取 -----------------------------------------------------------
router.get(
  '/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id
    const id = toPositiveInt(req.params.id)
    if (!userId) return res.status(401).json({ success: false, error: '未提供令牌' })
    if (id === null) return res.status(404).json({ success: false, error: '手稿不存在' })

    const row = await findOwnedManuscript(userId, id)
    if (!row) return res.status(404).json({ success: false, error: '手稿不存在' })
    return res.json({ success: true, data: row })
  }),
)

// ---- 保存 ---------------------------------------------------------------
router.put(
  '/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id
    const id = toPositiveInt(req.params.id)
    if (!userId) return res.status(401).json({ success: false, error: '未提供令牌' })
    if (id === null) return res.status(404).json({ success: false, error: '手稿不存在' })

    const existing = await findOwnedManuscript(userId, id)
    if (!existing) return res.status(404).json({ success: false, error: '手稿不存在' })

    const updates: Record<string, unknown> = { updatedAt: Math.floor(Date.now() / 1000) }
    if (typeof req.body?.title === 'string') updates.title = sanitizeTitle(req.body.title)
    if (typeof req.body?.contentHtml === 'string') {
      if (req.body.contentHtml.length > MAX_CONTENT) {
        return res.status(400).json({ success: false, error: '手稿内容过大' })
      }
      updates.contentHtml = req.body.contentHtml
      updates.previewText = htmlToPlainText(req.body.contentHtml).slice(0, 500)
      updates.imageCount = countImages(req.body.contentHtml)
    }
    if (req.body?.folderId !== undefined) {
      const folderId = toPositiveInt(req.body.folderId)
      if (folderId !== null) {
        const folder = await db.query.manuscriptFolders.findFirst({
          where: and(eq(manuscriptFolders.id, folderId), eq(manuscriptFolders.userId, userId)),
        })
        if (!folder) return res.status(404).json({ success: false, error: '文件夹不存在' })
      }
      updates.folderId = folderId
    }

    await db.update(manuscripts).set(updates).where(eq(manuscripts.id, id))
    const row = await findOwnedManuscript(userId, id)
    return res.json({ success: true, data: row })
  }),
)

// ---- 软删除 -------------------------------------------------------------
router.delete(
  '/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id
    const id = toPositiveInt(req.params.id)
    if (!userId) return res.status(401).json({ success: false, error: '未提供令牌' })
    if (id === null) return res.status(404).json({ success: false, error: '手稿不存在' })

    const existing = await findOwnedManuscript(userId, id)
    if (!existing) return res.status(404).json({ success: false, error: '手稿不存在' })

    await db
      .update(manuscripts)
      .set({ deletedAt: Math.floor(Date.now() / 1000) })
      .where(eq(manuscripts.id, id))
    return res.json({ success: true, data: { id } })
  }),
)

// ---- 手稿 → 节点池 ------------------------------------------------------
router.post(
  '/:id/to-node-card',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id
    const id = toPositiveInt(req.params.id)
    if (!userId) return res.status(401).json({ success: false, error: '未提供令牌' })
    if (id === null) return res.status(404).json({ success: false, error: '手稿不存在' })

    const folderId = toPositiveInt(req.body?.folderId)
    try {
      // 建卡片 + 软删手稿在一个事务里，逻辑在 domain/transfer.ts —— MCP 的
      // transferManuscriptToCard 走同一段代码，两条入口不会出现语义漂移。
      const card = await moveManuscriptToCard(userId, id, folderId)
      log('manuscript → card (moved)', { manuscriptId: id, cardId: card?.id })
      return res.status(201).json({ success: true, data: card })
    } catch (error) {
      if (isDomainError(error)) {
        return res.status(error.code === 'E_NOT_FOUND' ? 404 : 400).json({
          success: false,
          error: error.message,
        })
      }
      throw error
    }
  }),
)

// ---- 节点池 → 手稿 ------------------------------------------------------
router.post(
  '/from-card',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id
    const cardId = toPositiveInt(req.body?.cardId)
    if (!userId) return res.status(401).json({ success: false, error: '未提供令牌' })
    if (cardId === null) return res.status(404).json({ success: false, error: '卡片不存在' })

    const folderId = toPositiveInt(req.body?.folderId)
    try {
      const manuscript = await moveCardToManuscript(userId, cardId, folderId)
      log('card → manuscript (moved)', { cardId, manuscriptId: manuscript?.id })
      return res.status(201).json({ success: true, data: manuscript })
    } catch (error) {
      if (isDomainError(error)) {
        return res.status(error.code === 'E_NOT_FOUND' ? 404 : 400).json({
          success: false,
          error: error.message,
        })
      }
      throw error
    }
  }),
)

export const manuscriptRouter = router

// ---------------------------------------------------------------------------
// 文件夹：与节点池文件夹同构，独立路由（避免 /:id 与 /folders 抢匹配）
// ---------------------------------------------------------------------------
export const manuscriptFolderRouter = Router()

manuscriptFolderRouter.get(
  '/',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ success: false, error: '未提供令牌' })
    const rows = await db
      .select()
      .from(manuscriptFolders)
      .where(eq(manuscriptFolders.userId, userId))
      .orderBy(manuscriptFolders.sortOrder)
    return res.json({ success: true, data: rows })
  }),
)

manuscriptFolderRouter.post(
  '/',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id
    if (!userId) return res.status(401).json({ success: false, error: '未提供令牌' })

    const name = sanitizeTitle(req.body?.name)
    if (!name) return res.status(400).json({ success: false, error: '文件夹名不能为空' })

    const parentId = toPositiveInt(req.body?.parentId)
    if (parentId !== null) {
      const parent = await db.query.manuscriptFolders.findFirst({
        where: and(eq(manuscriptFolders.id, parentId), eq(manuscriptFolders.userId, userId)),
      })
      if (!parent) return res.status(404).json({ success: false, error: '父文件夹不存在' })
    }

    const inserted = await db
      .insert(manuscriptFolders)
      .values({ userId, name, parentId, sortOrder: 0 })
      .returning()
    return res.status(201).json({ success: true, data: inserted[0] })
  }),
)

manuscriptFolderRouter.put(
  '/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id
    const id = toPositiveInt(req.params.id)
    if (!userId) return res.status(401).json({ success: false, error: '未提供令牌' })
    if (id === null) return res.status(404).json({ success: false, error: '文件夹不存在' })

    const existing = await db.query.manuscriptFolders.findFirst({
      where: and(eq(manuscriptFolders.id, id), eq(manuscriptFolders.userId, userId)),
    })
    if (!existing) return res.status(404).json({ success: false, error: '文件夹不存在' })

    const updates: Record<string, unknown> = {}
    if (typeof req.body?.name === 'string') {
      const name = sanitizeTitle(req.body.name)
      if (!name) return res.status(400).json({ success: false, error: '文件夹名不能为空' })
      updates.name = name
    }
    if (typeof req.body?.collapsed === 'boolean') updates.collapsed = req.body.collapsed
    // 拖拽排序：只收有限整数，避免 NaN/字符串把 sort_order 写坏
    if (req.body?.sortOrder !== undefined) {
      const sortOrder = typeof req.body.sortOrder === 'number' && Number.isFinite(req.body.sortOrder)
        ? Math.trunc(req.body.sortOrder)
        : null
      if (sortOrder === null) {
        return res.status(400).json({ success: false, error: '排序值无效' })
      }
      updates.sortOrder = sortOrder
    }
    if (Object.keys(updates).length === 0) {
      return res.json({ success: true, data: { id } })
    }
    await db.update(manuscriptFolders).set(updates).where(eq(manuscriptFolders.id, id))
    return res.json({ success: true, data: { id } })
  }),
)

manuscriptFolderRouter.delete(
  '/:id',
  authenticate,
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id
    const id = toPositiveInt(req.params.id)
    if (!userId) return res.status(401).json({ success: false, error: '未提供令牌' })
    if (id === null) return res.status(404).json({ success: false, error: '文件夹不存在' })

    const existing = await db.query.manuscriptFolders.findFirst({
      where: and(eq(manuscriptFolders.id, id), eq(manuscriptFolders.userId, userId)),
    })
    if (!existing) return res.status(404).json({ success: false, error: '文件夹不存在' })

    // 删文件夹 = 删这棵子树，手稿跟着一起走：
    //   1. 先收集子树里的所有文件夹（含自己）；
    //   2. 把这些文件夹里的手稿软删除（deleted_at）——列表/详情都拿不到，
    //      行还在，留给数据保留策略；
    //   3. 再删文件夹，子文件夹由 parent_id 上的 ON DELETE CASCADE 一并删除。
    // 顺序不能反：先删文件夹的话，手稿的 folder_id 会被 SET NULL 置空，
    // 就再也认不出哪些手稿属于这棵子树了。
    const allFolders = await db
      .select({ id: manuscriptFolders.id, parentId: manuscriptFolders.parentId })
      .from(manuscriptFolders)
      .where(eq(manuscriptFolders.userId, userId))
    const subtree = new Set<number>([id])
    let changed = true
    while (changed) {
      changed = false
      for (const folder of allFolders) {
        if (folder.parentId !== null && subtree.has(folder.parentId) && !subtree.has(folder.id)) {
          subtree.add(folder.id)
          changed = true
        }
      }
    }

    const doomed = await db
      .update(manuscripts)
      .set({ deletedAt: Math.floor(Date.now() / 1000) })
      .where(and(eq(manuscripts.userId, userId), isNull(manuscripts.deletedAt), inArray(manuscripts.folderId, [...subtree])))
      .returning({ id: manuscripts.id })

    await db.delete(manuscriptFolders).where(eq(manuscriptFolders.id, id))
    return res.json({ success: true, data: { id, deletedManuscripts: doomed.length } })
  }),
)
