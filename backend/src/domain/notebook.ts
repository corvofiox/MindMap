/**
 * Notebook (手稿) domain service.
 *
 * Manuscripts are an account-private, flat REST resource: no Yjs, no rooms, no
 * merge — one row per document, soft-deleted so the retention job owns physical
 * cleanup. Everything here is therefore ordinary SQL, and the two adapters (REST
 * controller, MCP tools) differ only in how they translate errors.
 *
 * Isolation rule: every query filters on `user_id`, and "someone else's row" is
 * reported exactly like "no such row" — an agent must not be able to probe ids.
 */
import { and, asc, desc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm'
import { db } from '../database/connection.js'
import { manuscriptFolders, manuscripts } from '../database/schema.js'
import { htmlToPlainText } from 'mindmap-shared'
import { DomainError, domainErrors } from './errors.js'
import {
  MAX_CONTENT,
  PREVIEW_LENGTH,
  countImages,
  findUnsafeHtml,
  sanitizeTitle,
  textToHtml,
  toPositiveInt,
} from './rules.js'

/** How much plain text `get` mirrors next to the HTML. */
const CONTENT_TEXT_LIMIT = 20_000

export interface ManuscriptSummary {
  manuscriptId: number
  title: string
  previewText: string | null
  imageCount: number
  folderId: number | null
  sortOrder: number
  updatedAt: number | null
  createdAt: number | null
}

export interface ManuscriptDetail extends ManuscriptSummary {
  contentHtml: string
  /** HTML stripped to text, capped at CONTENT_TEXT_LIMIT chars. */
  contentText: string
  contentTextTruncated: boolean
  sourceCardId: number | null
}

export interface FolderNode {
  folderId: number
  name: string
  parentId: number | null
  sortOrder: number
  collapsed: boolean
  /** Slash-joined ancestor names, for agents that need a human-readable address. */
  path: string
  manuscriptCount: number
}

export interface ListManuscriptsQuery {
  q?: string
  /** `undefined` = all folders; `null` = only the root. */
  folderId?: number | null
  limit: number
  offset: number
}

function toSummary(row: Record<string, unknown>): ManuscriptSummary {
  return {
    manuscriptId: Number(row.id),
    title: (row.title as string) ?? '',
    previewText: (row.previewText as string | null) ?? null,
    imageCount: Number(row.imageCount ?? 0),
    folderId: row.folderId === null || row.folderId === undefined ? null : Number(row.folderId),
    sortOrder: Number(row.sortOrder ?? 0),
    updatedAt: row.updatedAt === null || row.updatedAt === undefined ? null : Number(row.updatedAt),
    createdAt: row.createdAt === null || row.createdAt === undefined ? null : Number(row.createdAt),
  }
}

function toDetail(row: Record<string, unknown>): ManuscriptDetail {
  const contentHtml = (row.contentHtml as string) ?? ''
  const text = htmlToPlainText(contentHtml)
  return {
    ...toSummary(row),
    contentHtml,
    contentText: text.length > CONTENT_TEXT_LIMIT ? text.slice(0, CONTENT_TEXT_LIMIT) : text,
    contentTextTruncated: text.length > CONTENT_TEXT_LIMIT,
    sourceCardId:
      row.sourceCardId === null || row.sourceCardId === undefined ? null : Number(row.sourceCardId),
  }
}

/** Owned + not deleted, or null. Never distinguishes "not yours" from "gone". */
async function findOwned(userId: number, id: number): Promise<Record<string, unknown> | null> {
  const row = await db.query.manuscripts.findFirst({
    where: and(eq(manuscripts.id, id), eq(manuscripts.userId, userId), isNull(manuscripts.deletedAt)),
  })
  return (row as Record<string, unknown> | undefined) ?? null
}

export async function listManuscripts(
  userId: number,
  query: ListManuscriptsQuery,
): Promise<{ items: ManuscriptSummary[]; total: number }> {
  const conditions = [eq(manuscripts.userId, userId), isNull(manuscripts.deletedAt)]
  const q = query.q?.trim()
  if (q) {
    const pattern = `%${q}%`
    const match = or(like(manuscripts.title, pattern), like(manuscripts.previewText, pattern))
    if (match) conditions.push(match)
  }
  if (query.folderId !== undefined) {
    conditions.push(
      query.folderId === null ? isNull(manuscripts.folderId) : eq(manuscripts.folderId, query.folderId),
    )
  }
  const where = and(...conditions)

  const rows = await db
    .select()
    .from(manuscripts)
    .where(where)
    .orderBy(asc(manuscripts.sortOrder), desc(manuscripts.updatedAt))
    .limit(query.limit)
    .offset(query.offset)

  const totals = await db
    .select({ n: sql<number>`cast(count(*) as integer)` })
    .from(manuscripts)
    .where(where)

  return {
    items: rows.map((row) => toSummary(row as Record<string, unknown>)),
    total: Number(totals[0]?.n ?? 0),
  }
}

export async function getManuscript(userId: number, id: number): Promise<ManuscriptDetail> {
  const row = await findOwned(userId, id)
  if (!row) {
    throw domainErrors.notFound(`手稿 ${id} `, '先用 notebookList 获取有效的手稿 ID。')
  }
  return toDetail(row)
}

/** Resolve `contentHtml` from either `html` (passthrough) or `text` (converted). */
function resolveContent(input: { html?: string; text?: string }, current?: string): string | undefined {
  if (input.html !== undefined && input.text !== undefined) {
    throw domainErrors.validation('html 与 text 只能给一个', '纯文本请用 text，已经排好版的富文本才用 html。')
  }
  if (input.text !== undefined) {
    return textToHtmlSafe(input.text)
  }
  if (input.html !== undefined) {
    if (input.html.length > MAX_CONTENT) {
      throw domainErrors.limit(`手稿正文超过上限（${MAX_CONTENT} 字符）`, { limit: MAX_CONTENT })
    }
    const unsafe = findUnsafeHtml(input.html)
    if (unsafe) {
      throw domainErrors.validation(
        `正文里含有不被接受的内容：${unsafe}`,
        '只允许编辑器白名单内的排版标签；脚本、事件属性、iframe 一律拒绝。',
      )
    }
    return input.html
  }
  return current
}

function textToHtmlSafe(text: string): string {
  if (text.length > MAX_CONTENT) {
    throw domainErrors.limit(`手稿正文超过上限（${MAX_CONTENT} 字符）`, { limit: MAX_CONTENT })
  }
  return textToHtml(text)
}

export interface CreateManuscriptInput {
  title?: string
  html?: string
  text?: string
  folderId?: number | null
}

export async function createManuscript(
  userId: number,
  input: CreateManuscriptInput,
): Promise<ManuscriptDetail> {
  const title = sanitizeTitle(input.title) || '未命名手稿'
  const contentHtml = resolveContent(input) ?? ''
  await assertFolderOwned(userId, input.folderId ?? null)

  const now = Math.floor(Date.now() / 1000)
  const inserted = await db
    .insert(manuscripts)
    .values({
      userId,
      folderId: input.folderId ?? null,
      title,
      contentHtml,
      previewText: htmlToPlainText(contentHtml).slice(0, PREVIEW_LENGTH),
      imageCount: countImages(contentHtml),
      updatedAt: now,
    })
    .returning()

  return toDetail(inserted[0] as Record<string, unknown>)
}

export interface UpdateManuscriptInput {
  title?: string
  html?: string
  text?: string
  folderId?: number | null
  /**
   * Optimistic lock: the `updatedAt` the caller last saw.
   *
   * Without it an agent silently overwrites whatever the human typed in the editor
   * since the read — the editor keeps its own copy locally and will flush it right
   * over the agent's work, so neither side notices.
   */
  expectedUpdatedAt?: number
}

export async function updateManuscript(
  userId: number,
  id: number,
  patch: UpdateManuscriptInput,
): Promise<ManuscriptDetail> {
  const existing = await findOwned(userId, id)
  if (!existing) {
    throw domainErrors.notFound(`手稿 ${id} `, '先用 notebookList 获取有效的手稿 ID。')
  }

  if (
    patch.expectedUpdatedAt !== undefined &&
    Number(existing.updatedAt ?? 0) !== Number(patch.expectedUpdatedAt)
  ) {
    throw domainErrors.conflict(
      `手稿 ${id} 在读取之后被修改过（当前 updatedAt=${Number(existing.updatedAt ?? 0)}）`,
      '重新调用 notebookGet 拿到最新内容与 updatedAt，合并后再提交。',
    )
  }

  const updates: Record<string, unknown> = { updatedAt: Math.floor(Date.now() / 1000) }
  if (patch.title !== undefined) updates.title = sanitizeTitle(patch.title)
  const content = resolveContent(patch, existing.contentHtml as string)
  if (content !== undefined && content !== existing.contentHtml) {
    updates.contentHtml = content
    updates.previewText = htmlToPlainText(content).slice(0, PREVIEW_LENGTH)
    updates.imageCount = countImages(content)
  }
  if (patch.folderId !== undefined) {
    await assertFolderOwned(userId, patch.folderId)
    updates.folderId = patch.folderId
  }

  if (Object.keys(updates).length === 1) {
    throw domainErrors.validation(
      '没有提供任何要更新的字段',
      '至少给一个：title / text / html / folderId。',
    )
  }

  await db.update(manuscripts).set(updates).where(eq(manuscripts.id, id))
  const row = await findOwned(userId, id)
  return toDetail(row as Record<string, unknown>)
}

export async function deleteManuscript(userId: number, id: number): Promise<{ manuscriptId: number }> {
  const existing = await findOwned(userId, id)
  if (!existing) {
    throw domainErrors.notFound(`手稿 ${id} `, '先用 notebookList 获取有效的手稿 ID。')
  }
  await db
    .update(manuscripts)
    .set({ deletedAt: Math.floor(Date.now() / 1000) })
    .where(eq(manuscripts.id, id))
  return { manuscriptId: id }
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

async function assertFolderOwned(userId: number, folderId: number | null): Promise<void> {
  if (folderId === null || folderId === undefined) return
  const folder = await db.query.manuscriptFolders.findFirst({
    where: and(eq(manuscriptFolders.id, folderId), eq(manuscriptFolders.userId, userId)),
  })
  if (!folder) {
    throw domainErrors.notFound(`文件夹 ${folderId} `, '先用 notebookFolderList 获取有效的文件夹 ID。')
  }
}

/** All folders of one account, each with a readable path and a document count. */
export async function listFolders(userId: number): Promise<FolderNode[]> {
  const rows = await db
    .select()
    .from(manuscriptFolders)
    .where(eq(manuscriptFolders.userId, userId))
    .orderBy(asc(manuscriptFolders.sortOrder), asc(manuscriptFolders.id))

  const counts = await db
    .select({
      folderId: manuscripts.folderId,
      n: sql<number>`cast(count(*) as integer)`,
    })
    .from(manuscripts)
    .where(and(eq(manuscripts.userId, userId), isNull(manuscripts.deletedAt)))
    .groupBy(manuscripts.folderId)

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
    const parentId = row.parentId === null || row.parentId === undefined ? null : Number(row.parentId)
    return {
      folderId: id,
      name: (row.name as string) ?? '',
      parentId,
      sortOrder: Number(row.sortOrder ?? 0),
      collapsed: Boolean(row.collapsed),
      path: pathOf(id),
      manuscriptCount: countByFolder.get(id) ?? 0,
    }
  })
}

export interface CreateFolderInput {
  name: string
  parentId?: number | null
}

export async function createFolder(userId: number, input: CreateFolderInput): Promise<FolderNode> {
  const name = sanitizeTitle(input.name)
  if (!name) throw domainErrors.validation('文件夹名称不能为空')
  await assertFolderOwned(userId, input.parentId ?? null)

  const inserted = await db
    .insert(manuscriptFolders)
    .values({ userId, name, parentId: input.parentId ?? null, sortOrder: 0 })
    .returning()

  return {
    folderId: Number(inserted[0].id),
    name,
    parentId: input.parentId ?? null,
    sortOrder: 0,
    collapsed: false,
    path: name,
    manuscriptCount: 0,
  }
}

export interface UpdateFolderInput {
  name?: string
  parentId?: number | null
  sortOrder?: number
}

export async function updateFolder(
  userId: number,
  id: number,
  patch: UpdateFolderInput,
): Promise<{ folderId: number }> {
  const existing = await db.query.manuscriptFolders.findFirst({
    where: and(eq(manuscriptFolders.id, id), eq(manuscriptFolders.userId, userId)),
  })
  if (!existing) {
    throw domainErrors.notFound(`文件夹 ${id} `, '先用 notebookFolderList 获取有效的文件夹 ID。')
  }

  const updates: Record<string, unknown> = {}
  if (patch.name !== undefined) {
    const name = sanitizeTitle(patch.name)
    if (!name) throw domainErrors.validation('文件夹名称不能为空')
    updates.name = name
  }
  if (patch.parentId !== undefined) {
    if (patch.parentId === id) {
      throw domainErrors.validation('不能把文件夹移动到它自己里面')
    }
    await assertFolderOwned(userId, patch.parentId)
    if (patch.parentId !== null && (await isDescendant(userId, id, patch.parentId))) {
      throw domainErrors.validation('不能把文件夹移动到自己的子文件夹里')
    }
    updates.parentId = patch.parentId
  }
  if (patch.sortOrder !== undefined) {
    if (!Number.isFinite(patch.sortOrder)) throw domainErrors.validation('sortOrder 必须是数字')
    updates.sortOrder = Math.trunc(patch.sortOrder)
  }
  if (Object.keys(updates).length === 0) {
    throw domainErrors.validation('没有提供任何要更新的字段', '至少给一个：name / parentId / sortOrder。')
  }

  await db.update(manuscriptFolders).set(updates).where(eq(manuscriptFolders.id, id))
  return { folderId: id }
}

/** True when `candidate` sits somewhere below `ancestorId` in the same tree. */
async function isDescendant(userId: number, ancestorId: number, candidate: number): Promise<boolean> {
  const rows = await db
    .select({ id: manuscriptFolders.id, parentId: manuscriptFolders.parentId })
    .from(manuscriptFolders)
    .where(eq(manuscriptFolders.userId, userId))
  const parentOf = new Map<number, number | null>()
  for (const row of rows) {
    parentOf.set(
      Number(row.id),
      row.parentId === null || row.parentId === undefined ? null : Number(row.parentId),
    )
  }
  let cursor: number | null = candidate
  const guard = new Set<number>()
  while (cursor !== null && !guard.has(cursor)) {
    if (cursor === ancestorId) return true
    guard.add(cursor)
    cursor = parentOf.get(cursor) ?? null
  }
  return false
}

/**
 * Delete a folder subtree.
 *
 * Order matters and is the same as the REST handler: collect the subtree, soft-delete
 * every live manuscript inside it, then delete the folder row (children go with it
 * via `ON DELETE CASCADE` on `parent_id`). Deleting folders first would null out
 * `folder_id` and lose the ability to tell which manuscripts belonged here.
 */
export async function deleteFolder(
  userId: number,
  id: number,
): Promise<{ folderId: number; deletedFolders: number; deletedManuscripts: number }> {
  const existing = await db.query.manuscriptFolders.findFirst({
    where: and(eq(manuscriptFolders.id, id), eq(manuscriptFolders.userId, userId)),
  })
  if (!existing) {
    throw domainErrors.notFound(`文件夹 ${id} `, '先用 notebookFolderList 获取有效的文件夹 ID。')
  }

  const all = await db
    .select({ id: manuscriptFolders.id, parentId: manuscriptFolders.parentId })
    .from(manuscriptFolders)
    .where(eq(manuscriptFolders.userId, userId))

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
    .update(manuscripts)
    .set({ deletedAt: Math.floor(Date.now() / 1000) })
    .where(
      and(
        eq(manuscripts.userId, userId),
        isNull(manuscripts.deletedAt),
        inArray(manuscripts.folderId, [...subtree]),
      ),
    )
    .returning({ id: manuscripts.id })

  await db.delete(manuscriptFolders).where(eq(manuscriptFolders.id, id))

  return {
    folderId: id,
    deletedFolders: subtree.size,
    deletedManuscripts: doomed.length,
  }
}

/** Re-exported so callers can narrow ids without importing rules directly. */
export { toPositiveInt }

/** Type guard used by the MCP adapter to translate errors. */
export { DomainError }
