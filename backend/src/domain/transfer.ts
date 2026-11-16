/**
 * Cross-container transfers between the notebook and the node pool.
 *
 * The semantic is **move**, not copy: converting a manuscript to a card soft-deletes
 * the manuscript, converting a card to a manuscript physically deletes the card,
 * and both happen in one SQLite transaction so there is never a moment with two
 * copies or none. (The canvas ⇄ pool directions live in `mcp/tools/transfer.ts` and are
 * moves too: dropping a card on a canvas removes it from the pool.)
 *
 * This module is shared by the REST controller and the MCP tools. The payload
 * shapes are exported because tests pin the "first paragraph as fallback name"
 * behaviour, and both adapters must agree on it.
 */
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../database/connection.js'
import { manuscriptFolders, manuscripts, nodeCards, nodePoolFolders } from '../database/schema.js'
import { extractFirstImageUrl, htmlToPlainText, normalizeNode } from 'mindmap-shared'
import { domainErrors } from './errors.js'
import { MAX_CARD_CONTENT, PREVIEW_LENGTH, countImages, sanitizeTitle } from './rules.js'
import { buildCardNodeJson } from './pool.js'

/** Manuscript → card row payload. */
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
    // A card stores a complete node snapshot (title/content/cover + the style defaults
    // a canvas node needs), so dropping it on a canvas renders like any other node.
    content: buildCardNodeJson({ title: manuscript.title, content, cover }),
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
 * Card → manuscript row payload.
 *
 * Old cards may still carry `type/imageUrl`; `normalizeNode` folds an `imageUrl` into
 * an `<img>` in the body, so both shapes end up as one.
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
    // Legacy rows are not JSON: treat the whole string as the body.
    parsed = { title: card.name, content: card.content }
  }

  const node = normalizeNode(parsed as Record<string, unknown> & { content?: string })
  const contentHtml = typeof node.content === 'string' ? node.content : ''
  return {
    title: sanitizeTitle(node.title) || sanitizeTitle(card.name) || '未命名手稿',
    contentHtml,
    previewText: htmlToPlainText(contentHtml).slice(0, PREVIEW_LENGTH),
    imageCount: countImages(contentHtml),
    sourceCardId: card.id,
  }
}

/**
 * Canvas node → card row payload.
 *
 * The node comes from the live Yjs doc, so it is already in unified shape; the card
 * stores `{title, content, cover}` and keeps the colour so dropping it back on a
 * canvas reproduces the original look. Enforces the same 5000-char card cap as the
 * manual "drag node into pool" path, otherwise an oversized node would enter the pool
 * through MCP only.
 */
export function nodeToCardPayload(
  node: Record<string, unknown>,
  userId: number,
  folderId: number | null,
): Record<string, unknown> {
  const normalized = normalizeNode(node)
  const title = sanitizeTitle(normalized.title) || '未命名卡片'
  const content = typeof normalized.content === 'string' ? normalized.content : ''
  const cover =
    typeof normalized.cover === 'string' && normalized.cover.length > 0 ? normalized.cover : undefined
  // 保留节点自己的颜色/字号，其余几何与边框用卡片默认值补齐：卡片拖回画布时
  // 必须是"一个完整节点"，否则会因为缺 color 渲染成透明卡片。
  const serialized = buildCardNodeJson({
    title,
    content,
    cover,
    color: typeof normalized.color === 'string' ? normalized.color : undefined,
    fontSize: typeof normalized.fontSize === 'number' ? normalized.fontSize : undefined,
  })
  if (serialized.length > MAX_CARD_CONTENT) {
    throw domainErrors.limit(
      `节点内容超过节点池卡片上限（序列化后 ${serialized.length} 字符，上限 ${MAX_CARD_CONTENT}）`,
      { limit: MAX_CARD_CONTENT, actual: serialized.length },
    )
  }
  return {
    userId,
    name: title,
    content: serialized,
    type: cover ? 'image' : 'text',
    color: typeof normalized.color === 'string' ? normalized.color : '#ffffff',
    tags: null,
    sortOrder: 0,
    folderId,
    thumbnail: cover,
    sourceKind: 'canvas',
  }
}

/** True when the manuscript exists, belongs to `userId` and is not soft-deleted. */
async function requireLiveManuscript(userId: number, id: number) {
  const row = await db.query.manuscripts.findFirst({
    where: and(eq(manuscripts.id, id), eq(manuscripts.userId, userId), isNull(manuscripts.deletedAt)),
  })
  if (!row) {
    throw domainErrors.notFound(`手稿 ${id} `, '先用 notebookList 获取有效的手稿 ID。')
  }
  return row
}

/** True when the card exists and belongs to `userId`. */
async function requireOwnedCard(userId: number, cardId: number) {
  const row = await db.query.nodeCards.findFirst({
    where: and(eq(nodeCards.id, cardId), eq(nodeCards.userId, userId)),
  })
  if (!row) {
    throw domainErrors.notFound(`卡片 ${cardId} `, '先用 poolList 获取有效的卡片 ID。')
  }
  return row
}

/**
 * Move a manuscript into the node pool as a card.
 *
 * Note the drizzle constraint: `db.transaction` here takes a **synchronous** callback
 * (drizzle 0.30 + better-sqlite3). An async callback throws "Transaction function
 * cannot return a promise". So the payload is built before the transaction and the
 * transaction only does the two writes.
 */
export async function moveManuscriptToCard(
  userId: number,
  manuscriptId: number,
  folderId: number | null = null,
): Promise<Record<string, unknown>> {
  const manuscript = await requireLiveManuscript(userId, manuscriptId)

  if (folderId !== null) {
    const folder = await db.query.nodePoolFolders.findFirst({
      where: and(eq(nodePoolFolders.id, folderId), eq(nodePoolFolders.userId, userId)),
    })
    if (!folder) {
      throw domainErrors.notFound(`目标文件夹 ${folderId} `, '先用 poolFolderList 获取有效的文件夹 ID。')
    }
  }

  const payload = manuscriptToCardPayload(
    {
      id: Number(manuscript.id),
      title: (manuscript.title as string) ?? '',
      contentHtml: (manuscript.contentHtml as string) ?? '',
      userId,
    },
    folderId,
  )

  const inserted = db.transaction((tx) => {
    const rows = tx.insert(nodeCards).values(payload).returning().all()
    tx.update(manuscripts)
      .set({ deletedAt: Math.floor(Date.now() / 1000) })
      .where(eq(manuscripts.id, manuscriptId))
      .run()
    return rows
  })

  return inserted[0] as Record<string, unknown>
}

/** Move a card out of the pool and into the notebook as a manuscript. */
export async function moveCardToManuscript(
  userId: number,
  cardId: number,
  folderId: number | null = null,
): Promise<Record<string, unknown>> {
  const card = await requireOwnedCard(userId, cardId)

  if (folderId !== null) {
    const folder = await db.query.manuscriptFolders.findFirst({
      where: and(eq(manuscriptFolders.id, folderId), eq(manuscriptFolders.userId, userId)),
    })
    if (!folder) {
      throw domainErrors.notFound(`目标文件夹 ${folderId} `, '先用 notebookFolderList 获取有效的文件夹 ID。')
    }
  }

  const payload = cardToManuscriptPayload({
    id: Number(card.id),
    userId,
    name: (card.name as string) ?? '',
    content: (card.content as string) ?? '',
  })
  const now = Math.floor(Date.now() / 1000)

  const inserted = db.transaction((tx) => {
    const rows = tx
      .insert(manuscripts)
      .values({ userId, ...payload, folderId, updatedAt: now })
      .returning()
      .all()
    tx.delete(nodeCards).where(eq(nodeCards.id, cardId)).run()
    return rows
  })

  return inserted[0] as Record<string, unknown>
}
