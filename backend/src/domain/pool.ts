/**
 * Node-pool (节点池) domain service.
 *
 * A pool card is one row whose `content` column holds a *JSON snapshot of a canvas
 * node* (`{title, content, ...}`), capped at 5000 characters by the REST API. This
 * service owns that encoding so the REST endpoint and the MCP tools cannot disagree
 * about what a card body is.
 *
 * Isolation rule: `user_id` on every query; foreign rows read as "does not exist".
 */
import { and, asc, eq, inArray, like, sql } from 'drizzle-orm'
import { db } from '../database/connection.js'
import { nodeCards, nodePoolFolders } from '../database/schema.js'
import { htmlToPlainText, normalizeNode } from 'mindmap-shared'
import { domainErrors } from './errors.js'
import {
  MAX_CARD_CONTENT,
  findUnsafeHtml,
  sanitizeTitle,
  textToHtml,
  toPositiveInt,
} from './rules.js'

export interface CardSummary {
  cardId: number
  name: string
  /** Plain text of the card body, capped for list views. */
  preview: string
  type: string
  color: string
  tags: string | null
  folderId: number | null
  useCount: number
  createdAt: number | null
}

export interface CardDetail extends CardSummary {
  contentHtml: string
  /** Raw parsed node snapshot, exactly what would be dropped on a canvas. */
  node: Record<string, unknown>
}

export interface ListCardsQuery {
  q?: string
  tag?: string
  folderId?: number | null
  limit: number
  offset: number
}

const PREVIEW_LENGTH = 300

/** Parse a card's `content` JSON, tolerating pre-unification shapes. */
export function parseCardContent(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return normalizeNode(parsed as Record<string, unknown>) as Record<string, unknown>
    }
  } catch {
    /* legacy: raw text stored without JSON wrapper */
  }
  return normalizeNode({ title: '', content: raw }) as unknown as Record<string, unknown>
}

function toSummary(row: Record<string, unknown>): CardSummary {
  const node = parseCardContent((row.content as string) ?? '')
  const html = typeof node.content === 'string' ? node.content : ''
  const text = htmlToPlainText(html)
  return {
    cardId: Number(row.id),
    name: (row.name as string) ?? '',
    preview: text.length > PREVIEW_LENGTH ? text.slice(0, PREVIEW_LENGTH) : text,
    type: (row.type as string) ?? 'text',
    color: (row.color as string) ?? '#ffffff',
    tags: (row.tags as string | null) ?? null,
    folderId: row.folderId === null || row.folderId === undefined ? null : Number(row.folderId),
    useCount: Number(row.useCount ?? 0),
    createdAt:
      row.createdAt === null || row.createdAt === undefined ? null : Number(row.createdAt),
  }
}

function toDetail(row: Record<string, unknown>): CardDetail {
  const node = parseCardContent((row.content as string) ?? '')
  return {
    ...toSummary(row),
    contentHtml: typeof node.content === 'string' ? node.content : '',
    node,
  }
}

async function findOwned(userId: number, cardId: number): Promise<Record<string, unknown> | null> {
  const row = await db.query.nodeCards.findFirst({
    where: and(eq(nodeCards.id, cardId), eq(nodeCards.userId, userId)),
  })
  return (row as Record<string, unknown> | undefined) ?? null
}

export async function listCards(
  userId: number,
  query: ListCardsQuery,
): Promise<{ items: CardSummary[]; total: number }> {
  const conditions = [eq(nodeCards.userId, userId)]
  if (query.folderId !== undefined) {
    conditions.push(
      query.folderId === null ? sql`${nodeCards.folderId} IS NULL` : eq(nodeCards.folderId, query.folderId),
    )
  }
  if (query.tag?.trim()) {
    conditions.push(like(nodeCards.tags, `%${query.tag.trim()}%`))
  }
  const where = and(...conditions)

  // Text search lives in the JSON body, so it cannot be pushed into SQL reliably;
  // filter after loading the candidate page's worth of rows. Fine at this scale
  // (cards are per-account and capped by the UI's own list behaviour), and it keeps
  // the search semantics identical to the REST list.
  const q = query.q?.trim().toLowerCase()
  const rows = await db
    .select()
    .from(nodeCards)
    .where(where)
    .orderBy(asc(nodeCards.sortOrder), asc(nodeCards.id))

  const filtered = q
    ? rows.filter((row) => {
        const summary = toSummary(row as Record<string, unknown>)
        return (
          summary.name.toLowerCase().includes(q) ||
          summary.preview.toLowerCase().includes(q) ||
          (summary.tags ?? '').toLowerCase().includes(q)
        )
      })
    : rows

  const page = filtered.slice(query.offset, query.offset + query.limit)
  return { items: page.map((row) => toSummary(row as Record<string, unknown>)), total: filtered.length }
}

export async function getCard(userId: number, cardId: number): Promise<CardDetail> {
  const row = await findOwned(userId, cardId)
  if (!row) {
    throw domainErrors.notFound(`卡片 ${cardId} `, '先用 poolList 获取有效的卡片 ID。')
  }
  return toDetail(row)
}

export interface WriteCardInput {
  title?: string
  text?: string
  html?: string
  tags?: string | null
  color?: string
  description?: string | null
  folderId?: number | null
}

function resolveBody(input: WriteCardInput, current: string): string {
  if (input.text !== undefined && input.html !== undefined) {
    throw domainErrors.validation('text 与 html 只能给一个', '纯文本用 text；已经是编辑器 HTML 才用 html。')
  }
  if (input.text !== undefined) return textToHtml(input.text)
  if (input.html !== undefined) {
    const unsafe = findUnsafeHtml(input.html)
    if (unsafe) {
      throw domainErrors.validation(
        `卡片正文里含有不被接受的内容：${unsafe}`,
        '脚本、事件属性、iframe 一律拒绝。',
      )
    }
    return input.html
  }
  return current
}

function serializeCard(title: string, contentHtml: string): string {
  const payload = JSON.stringify({ title, content: contentHtml })
  if (payload.length > MAX_CARD_CONTENT) {
    throw domainErrors.limit(
      `卡片正文超过上限（序列化后 ${payload.length} 字符，上限 ${MAX_CARD_CONTENT}）`,
      { limit: MAX_CARD_CONTENT, actual: payload.length },
    )
  }
  return payload
}

async function assertFolderOwned(userId: number, folderId: number | null | undefined): Promise<void> {
  if (folderId === null || folderId === undefined) return
  const folder = await db.query.nodePoolFolders.findFirst({
    where: and(eq(nodePoolFolders.id, folderId), eq(nodePoolFolders.userId, userId)),
  })
  if (!folder) {
    throw domainErrors.notFound(`文件夹 ${folderId} `, '先用 poolFolderList 获取有效的文件夹 ID。')
  }
}

export async function createCard(userId: number, input: WriteCardInput): Promise<CardDetail> {
  const title = sanitizeTitle(input.title) || '未命名卡片'
  await assertFolderOwned(userId, input.folderId)
  const contentHtml = resolveBody(input, '')
  const content = serializeCard(title, contentHtml)
  const thumbnail = firstImage(contentHtml)

  const inserted = await db
    .insert(nodeCards)
    .values({
      userId,
      name: title,
      content,
      type: contentHtml.includes('<img') ? 'image' : 'text',
      color: input.color || '#ffffff',
      tags: input.tags ?? null,
      description: input.description ?? null,
      thumbnail,
      createdBy: userId,
      folderId: input.folderId ?? null,
    })
    .returning()

  return toDetail(inserted[0] as Record<string, unknown>)
}

export async function updateCard(
  userId: number,
  cardId: number,
  patch: WriteCardInput,
): Promise<CardDetail> {
  const existing = await findOwned(userId, cardId)
  if (!existing) {
    throw domainErrors.notFound(`卡片 ${cardId} `, '先用 poolList 获取有效的卡片 ID。')
  }

  const currentNode = parseCardContent((existing.content as string) ?? '')
  const currentHtml = typeof currentNode.content === 'string' ? currentNode.content : ''
  const title =
    patch.title !== undefined ? sanitizeTitle(patch.title) || (existing.name as string) : (existing.name as string)
  const contentHtml = resolveBody(patch, currentHtml)

  const updates: Record<string, unknown> = {}
  if (patch.title !== undefined || patch.text !== undefined || patch.html !== undefined) {
    updates.content = serializeCard(title, contentHtml)
    updates.name = title
    updates.type = contentHtml.includes('<img') ? 'image' : 'text'
    updates.thumbnail = firstImage(contentHtml)
  }
  if (patch.tags !== undefined) updates.tags = patch.tags
  if (patch.color !== undefined) updates.color = patch.color
  if (patch.description !== undefined) updates.description = patch.description
  if (patch.folderId !== undefined) {
    await assertFolderOwned(userId, patch.folderId)
    updates.folderId = patch.folderId
  }

  if (Object.keys(updates).length === 0) {
    throw domainErrors.validation(
      '没有提供任何要更新的字段',
      '至少给一个：title / text / html / tags / color / description / folderId。',
    )
  }

  await db.update(nodeCards).set(updates).where(eq(nodeCards.id, cardId))
  const row = await findOwned(userId, cardId)
  return toDetail(row as Record<string, unknown>)
}

export async function deleteCard(userId: number, cardId: number): Promise<{ cardId: number }> {
  const existing = await findOwned(userId, cardId)
  if (!existing) {
    throw domainErrors.notFound(`卡片 ${cardId} `, '先用 poolList 获取有效的卡片 ID。')
  }
  // node_cards has no soft-delete column: this is a physical delete.
  await db.delete(nodeCards).where(eq(nodeCards.id, cardId))
  return { cardId }
}

/** Bump the "used N times" counter (called when a card is dropped on a canvas). */
export async function incrementUseCount(userId: number, cardId: number): Promise<{ useCount: number }> {
  const existing = await findOwned(userId, cardId)
  if (!existing) {
    throw domainErrors.notFound(`卡片 ${cardId} `, '先用 poolList 获取有效的卡片 ID。')
  }
  const next = Number(existing.useCount ?? 0) + 1
  await db.update(nodeCards).set({ useCount: next }).where(eq(nodeCards.id, cardId))
  return { useCount: next }
}

/** First `<img src>` in the HTML, used as the pool thumbnail. */
export function firstImage(html: string): string | null {
  const match = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(html)
  return match ? match[1] : null
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export interface PoolFolderNode {
  folderId: number
  name: string
  parentId: number | null
  sortOrder: number
  collapsed: boolean
  path: string
  cardCount: number
}

export async function listFolders(userId: number): Promise<PoolFolderNode[]> {
  const rows = await db
    .select()
    .from(nodePoolFolders)
    .where(eq(nodePoolFolders.userId, userId))
    .orderBy(asc(nodePoolFolders.sortOrder), asc(nodePoolFolders.id))

  const counts = await db
    .select({ folderId: nodeCards.folderId, n: sql<number>`cast(count(*) as integer)` })
    .from(nodeCards)
    .where(eq(nodeCards.userId, userId))
    .groupBy(nodeCards.folderId)

  const countByFolder = new Map<number, number>()
  for (const row of counts) {
    if (row.folderId !== null && row.folderId !== undefined) {
      countByFolder.set(Number(row.folderId), Number(row.n))
    }
  }

  const byId = new Map<number, Record<string, unknown>>()
  for (const row of rows) byId.set(Number(row.id), row as Record<string, unknown>)

  const pathOf = (id: number, seen = new Set<number>()): string => {
    const row = byId.get(id)
    if (!row || seen.has(id)) return ''
    seen.add(id)
    const name = (row.name as string) ?? ''
    const parentId = row.parentId === null || row.parentId === undefined ? null : Number(row.parentId)
    if (parentId === null) return name
    const parentPath = pathOf(parentId, seen)
    return parentPath ? `${parentPath}/${name}` : name
  }

  return rows.map((row) => {
    const id = Number(row.id)
    return {
      folderId: id,
      name: (row.name as string) ?? '',
      parentId: row.parentId === null || row.parentId === undefined ? null : Number(row.parentId),
      sortOrder: Number(row.sortOrder ?? 0),
      collapsed: Boolean(row.collapsed),
      path: pathOf(id),
      cardCount: countByFolder.get(id) ?? 0,
    }
  })
}

export async function createFolder(
  userId: number,
  input: { name: string; parentId?: number | null },
): Promise<PoolFolderNode> {
  const name = sanitizeTitle(input.name)
  if (!name) throw domainErrors.validation('文件夹名称不能为空')
  await assertFolderOwned(userId, input.parentId ?? null)

  const inserted = await db
    .insert(nodePoolFolders)
    .values({ userId, name, parentId: input.parentId ?? null, sortOrder: 0 })
    .returning()

  return {
    folderId: Number(inserted[0].id),
    name,
    parentId: input.parentId ?? null,
    sortOrder: 0,
    collapsed: false,
    path: name,
    cardCount: 0,
  }
}

export async function updateFolder(
  userId: number,
  id: number,
  patch: { name?: string; parentId?: number | null; sortOrder?: number; collapsed?: boolean },
): Promise<{ folderId: number }> {
  const existing = await db.query.nodePoolFolders.findFirst({
    where: and(eq(nodePoolFolders.id, id), eq(nodePoolFolders.userId, userId)),
  })
  if (!existing) {
    throw domainErrors.notFound(`文件夹 ${id} `, '先用 poolFolderList 获取有效的文件夹 ID。')
  }

  const updates: Record<string, unknown> = {}
  if (patch.name !== undefined) {
    const name = sanitizeTitle(patch.name)
    if (!name) throw domainErrors.validation('文件夹名称不能为空')
    updates.name = name
  }
  if (patch.parentId !== undefined) {
    if (patch.parentId === id) throw domainErrors.validation('不能把文件夹移动到它自己里面')
    await assertFolderOwned(userId, patch.parentId)
    updates.parentId = patch.parentId
  }
  if (patch.sortOrder !== undefined) {
    if (!Number.isFinite(patch.sortOrder)) throw domainErrors.validation('sortOrder 必须是数字')
    updates.sortOrder = Math.trunc(patch.sortOrder)
  }
  if (patch.collapsed !== undefined) updates.collapsed = Boolean(patch.collapsed)
  if (Object.keys(updates).length === 0) {
    throw domainErrors.validation('没有提供任何要更新的字段', '至少给一个：name / parentId / sortOrder / collapsed。')
  }

  await db.update(nodePoolFolders).set(updates).where(eq(nodePoolFolders.id, id))
  return { folderId: id }
}

/**
 * Delete a folder subtree, physically deleting the cards inside it.
 *
 * Distinct from the notebook equivalent (which soft-deletes manuscripts): a card has
 * no `deleted_at` column, so this is irreversible. Callers must confirm first and the
 * reply reports exactly how much disappeared.
 */
export async function deleteFolder(
  userId: number,
  id: number,
): Promise<{ folderId: number; deletedFolders: number; deletedCards: number }> {
  const existing = await db.query.nodePoolFolders.findFirst({
    where: and(eq(nodePoolFolders.id, id), eq(nodePoolFolders.userId, userId)),
  })
  if (!existing) {
    throw domainErrors.notFound(`文件夹 ${id} `, '先用 poolFolderList 获取有效的文件夹 ID。')
  }

  const all = await db
    .select({ id: nodePoolFolders.id, parentId: nodePoolFolders.parentId })
    .from(nodePoolFolders)
    .where(eq(nodePoolFolders.userId, userId))

  const subtree = new Set<number>([id])
  let changed = true
  while (changed) {
    changed = false
    for (const folder of all) {
      const parentId = folder.parentId === null ? null : Number(folder.parentId)
      if (parentId !== null && subtree.has(parentId) && !subtree.has(Number(folder.id))) {
        subtree.add(Number(folder.id))
        changed = true
      }
    }
  }

  const doomed = await db
    .delete(nodeCards)
    .where(and(eq(nodeCards.userId, userId), inArray(nodeCards.folderId, [...subtree])))
    .returning({ id: nodeCards.id })

  await db.delete(nodePoolFolders).where(eq(nodePoolFolders.id, id))

  return { folderId: id, deletedFolders: subtree.size, deletedCards: doomed.length }
}

export { toPositiveInt }
