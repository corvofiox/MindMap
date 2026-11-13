/**
 * 笔记本 API —— 账号私有的手稿，以及与节点池之间的双向转换。
 *
 * 设计要点（docs/requirements-notebook.md §4/§13）：
 *   - 手稿不协作：没有 Yjs，一行 REST 记录即可。
 *   - 隔离靠 `user_id` 过滤，越权一律 404（不泄露资源是否存在）。
 *   - 转换是**抄送**语义：只复制内容 + 记录来源 id，不做双向绑定；改一边不会
 *     影响另一边。统一节点之后不再需要"判断类型"——手稿 HTML 原样搬进卡片。
 */
import { Router } from 'express'
import { and, desc, eq, inArray, isNull, like, or } from 'drizzle-orm'
import { db } from '../database/connection.js'
import { manuscriptFolders, manuscripts, nodeCards, nodePoolFolders } from '../database/schema.js'
import { authenticate, type AuthRequest } from '../middleware/auth.middleware.js'
import { asyncHandler } from '../middleware/error.middleware.js'
import { log } from '../utils/logger.js'
import { extractFirstImageUrl, htmlToPlainText, normalizeNode } from 'mindmap-shared'

const router = Router()

const MAX_TITLE = 200
const MAX_CONTENT = 5 * 1024 * 1024 // 5 MB of HTML per manuscript

function toPositiveInt(value: unknown): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

function sanitizeTitle(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  // 去掉控制字符（\x00-\x1f）而不写控制字符正则——eslint 的 no-control-regex
  // 会拦，且按码位过滤比正则更直白。
  const cleaned = Array.from(raw)
    .map((ch) => (ch.charCodeAt(0) < 0x20 ? ' ' : ch))
    .join('')
  return cleaned.trim().slice(0, MAX_TITLE)
}

function countImages(html: string): number {
  return (html.match(/<img\b/gi) || []).length
}

/**
 * 手稿 → 卡片载荷。
 *
 * 统一节点之后这里没有"类型判定"：正文原样搬过去，第一张图作为 thumbnail。
 * 卡片仍写一个粗粒度 `type`（有图/无图），只为兼容节点池列表的缩略图样式。
 */
export function manuscriptToCardPayload(
  manuscript: { id: number; title: string; contentHtml: string; userId: number },
  folderId: number | null,
): {
  userId: number
  name: string
  content: string
  type: 'text' | 'image'
  color: string
  tags: null
  sortOrder: number
  folderId: number | null
  thumbnail: string | undefined
  sourceManuscriptId: number
  sourceKind: 'manuscript'
} {
  const cover = extractFirstImageUrl(manuscript.contentHtml) ?? undefined
  const content = manuscript.contentHtml || ''
  const fallbackName = htmlToPlainText(content).slice(0, 60) || '未命名手稿'
  return {
    userId: manuscript.userId,
    name: manuscript.title.trim() || fallbackName,
    // 卡片存的是"一个节点的形状"，统一节点只有 title/content/cover
    content: JSON.stringify({ title: manuscript.title, content, cover }),
    type: cover ? 'image' : 'text',
    color: '#ffffff',
    tags: null,
    sortOrder: 0,
    folderId,
    thumbnail: cover,
    sourceManuscriptId: manuscript.id,
    sourceKind: 'manuscript',
  }
}

/**
 * 卡片 → 手稿载荷。
 *
 * 老卡片可能还是 `type/imageUrl` 形态，先过 normalizeNode；图片若只存在于
 * `imageUrl`，normalizeNode 已经把它折成正文里的 `<img>`。
 */
export function cardToManuscriptPayload(card: {
  id: number
  userId: number
  name: string
  content: string
}): { title: string; contentHtml: string; previewText: string; imageCount: number; sourceCardId: number } {
  let parsed: Record<string, unknown> = {}
  try {
    const raw = JSON.parse(card.content) as unknown
    if (raw && typeof raw === 'object') parsed = raw as Record<string, unknown>
  } catch {
    // 老数据可能不是 JSON：把整串当正文
    parsed = { title: card.name, content: card.content }
  }

  const node = normalizeNode(parsed as Record<string, unknown> & { content?: string })
  const contentHtml = typeof node.content === 'string' ? node.content : ''
  return {
    title: sanitizeTitle(node.title) || sanitizeTitle(card.name) || '未命名手稿',
    contentHtml,
    previewText: htmlToPlainText(contentHtml).slice(0, 500),
    imageCount: countImages(contentHtml),
    sourceCardId: card.id,
  }
}

/** 只返回当前账号的、未删除的手稿；越权 = 不存在。 */
async function findOwnedManuscript(userId: number, id: number) {
  const row = await db.query.manuscripts.findFirst({
    where: and(eq(manuscripts.id, id), eq(manuscripts.userId, userId), isNull(manuscripts.deletedAt)),
  })
  return row ?? null
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

    const conditions = [eq(manuscripts.userId, userId), isNull(manuscripts.deletedAt)]
    if (q) {
      const pattern = `%${q}%`
      const match = or(like(manuscripts.title, pattern), like(manuscripts.previewText, pattern))
      if (match) conditions.push(match)
    }
    if (folderId !== undefined) {
      conditions.push(folderId === null ? isNull(manuscripts.folderId) : eq(manuscripts.folderId, folderId))
    }

    const rows = await db
      .select({
        id: manuscripts.id,
        folderId: manuscripts.folderId,
        title: manuscripts.title,
        previewText: manuscripts.previewText,
        imageCount: manuscripts.imageCount,
        updatedAt: manuscripts.updatedAt,
        createdAt: manuscripts.createdAt,
      })
      .from(manuscripts)
      .where(and(...conditions))
      .orderBy(desc(manuscripts.updatedAt))
      .limit(200)

    return res.json({ success: true, data: rows })
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

    const manuscript = await findOwnedManuscript(userId, id)
    if (!manuscript) return res.status(404).json({ success: false, error: '手稿不存在' })

    const folderId = toPositiveInt(req.body?.folderId)
    if (folderId !== null) {
      const folder = await db.query.nodePoolFolders.findFirst({
        where: and(eq(nodePoolFolders.id, folderId), eq(nodePoolFolders.userId, userId)),
      })
      if (!folder) return res.status(404).json({ success: false, error: '目标文件夹不存在' })
    }

    const payload = manuscriptToCardPayload(
      { id: manuscript.id, title: manuscript.title, contentHtml: manuscript.contentHtml, userId },
      folderId,
    )
    const inserted = await db.insert(nodeCards).values(payload).returning()
    log('manuscript → card', { manuscriptId: id, cardId: inserted[0]?.id })

    return res.status(201).json({ success: true, data: inserted[0] })
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

    const card = await db.query.nodeCards.findFirst({
      where: and(eq(nodeCards.id, cardId), eq(nodeCards.userId, userId)),
    })
    if (!card) return res.status(404).json({ success: false, error: '卡片不存在' })

    const payload = cardToManuscriptPayload(card)
    const now = Math.floor(Date.now() / 1000)
    const inserted = await db
      .insert(manuscripts)
      .values({ userId, ...payload, updatedAt: now })
      .returning()

    return res.status(201).json({ success: true, data: inserted[0] })
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
