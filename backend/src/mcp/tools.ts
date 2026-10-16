/**
 * MCP canvas tools.
 *
 * These are the MCP equivalent of the removed frontend `aiTools.ts`. The tool
 * set, names, semantics, defaults and even the wording of validation errors are
 * ported deliberately: the descriptions were tuned so a model picks the right
 * tool and supplies sane geometry (e.g. node size >= 200x160), and that tuning is
 * worth keeping.
 *
 * What changed is the target. The frontend operated on a Zustand store; these
 * operate on the server's authoritative Yjs doc via `canvas-ops.ts`, so an
 * external agent can drive a canvas and have the result appear live in any open
 * browser.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { db } from '../database/connection.js'
import { canvases, projects, projectMembers } from '../database/schema.js'
import { eq, inArray, desc } from 'drizzle-orm'
import { accessErrorMessage, resolveCanvasAccess } from './access.js'
import {
  deleteEntities,
  getCanvasSnapshot,
  getUndoManager,
  upsertEntities,
  type CanvasSnapshot,
} from './canvas-ops.js'

/** Identity behind the current MCP session; every call is scoped to this user. */
export interface ToolContext {
  userId: number
}

/** Tool reply: JSON text on success, or an `isError` result with a fix hint. */
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** Numeric coercion that refuses NaN/Infinity, mirroring the frontend helper. */
function toFiniteNumber(value: unknown, fallback: number): number {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

/** ~200 char excerpt centred on a search hit. */
function makeSnippet(text: string, matchIndex: number): string {
  const maxLength = 200
  if (text.length <= maxLength) return text
  const start = Math.max(0, Math.min(matchIndex - 60, text.length - maxLength))
  const prefix = start > 0 ? '...' : ''
  const suffix = start + maxLength < text.length ? '...' : ''
  return prefix + text.slice(start, start + maxLength) + suffix
}

/** Port direction from an angle, used when a caller omits connection ports. */
function getPortByAngle(angle: number): 'top' | 'right' | 'bottom' | 'left' {
  const normalizedAngle = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  if (normalizedAngle < Math.PI / 4 || normalizedAngle >= (7 * Math.PI) / 4) return 'right'
  if (normalizedAngle < (3 * Math.PI) / 4) return 'bottom'
  if (normalizedAngle < (5 * Math.PI) / 4) return 'left'
  return 'top'
}

/** Node lookup as a plain map, since doc entities are untyped records. */
function nodesById(snapshot: CanvasSnapshot): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>()
  for (const node of snapshot.nodes) {
    const id = node.id
    if (typeof id === 'string') map.set(id, node)
  }
  return map
}

/**
 * Bounding box covering the given nodes, with padding.
 * Returns null when none of the ids resolve — callers treat that as an error
 * rather than creating an empty container at the origin.
 */
function calculateNodesBounds(
  nodeIds: string[],
  nodes: Map<string, Record<string, unknown>>,
  padding: number,
): { x: number; y: number; width: number; height: number } | null {
  const valid = nodeIds
    .map((id) => nodes.get(id))
    .filter((n): n is Record<string, unknown> => n !== undefined)
  if (valid.length === 0) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of valid) {
    const x = toFiniteNumber(node.x, 0)
    const y = toFiniteNumber(node.y, 0)
    const w = toFiniteNumber(node.width, 200)
    const h = toFiniteNumber(node.height, 160)
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + w)
    maxY = Math.max(maxY, y + h)
  }
  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  }
}

/** Resolve a canvas + access check, returning either a ctx or a tool error. */
async function withCanvas(
  ctx: ToolContext,
  canvasId: number,
): Promise<{ error: ToolResult } | { snapshot: CanvasSnapshot }> {
  const access = await resolveCanvasAccess(canvasId, ctx.userId)
  if (access.status === 'denied') {
    return { error: fail(accessErrorMessage(canvasId, access.reason)) }
  }
  return { snapshot: await getCanvasSnapshot(canvasId) }
}

/** Shared canvasId argument used by nearly every tool. */
const canvasIdSchema = z
  .number()
  .int()
  .positive()
  .describe('画布 ID。可通过 listCanvases 获取。')

const ALIGN_ENUM = z.enum(['left', 'center', 'right'])
const PORT_ENUM = z.enum(['top', 'right', 'bottom', 'left'])

/**
 * Register every canvas tool on an MCP server.
 *
 * Called once per MCP session so the server instance is never shared across
 * different users' credentials.
 */
export function registerCanvasTools(server: McpServer, ctx: ToolContext): void {
  // ---------------------------------------------------------------- discovery

  server.registerTool(
    'listCanvases',
    {
      title: '列出可访问的画布',
      description:
        '列出当前令牌对应账号可访问的所有画布（自己拥有的项目 + 作为成员加入的项目）。返回画布 ID、名称、所属项目与更新时间。除 listProjects 外，其余工具都需要画布 ID，先用本工具获取。',
      inputSchema: {
        projectId: z.number().int().positive().optional().describe('可选：只列出该项目的画布'),
      },
    },
    async ({ projectId }) => {
      // Accessible projects = owned projects ∪ projects with a membership row.
      const owned = await db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(eq(projects.ownerId, ctx.userId))

      const memberRows = await db
        .select({ projectId: projectMembers.projectId })
        .from(projectMembers)
        .where(eq(projectMembers.userId, ctx.userId))
      const memberProjectIds = memberRows.map((r) => r.projectId)

      const accessibleIds = Array.from(
        new Set([...owned.map((p) => p.id), ...memberProjectIds]),
      )
      if (accessibleIds.length === 0) {
        return ok({ canvases: [], note: '当前账号还没有任何项目。' })
      }

      const filteredProjectIds =
        projectId !== undefined ? accessibleIds.filter((id) => id === projectId) : accessibleIds
      if (filteredProjectIds.length === 0) {
        return fail(`项目 ${projectId} 不存在或无权访问。请先用 listCanvases 查看可访问的项目。`)
      }

      const projectNameById = new Map<number, string>()
      const projectRows = await db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(inArray(projects.id, filteredProjectIds))
      for (const p of projectRows) projectNameById.set(p.id, p.name)

      const rows = await db
        .select({
          id: canvases.id,
          name: canvases.name,
          projectId: canvases.projectId,
          updatedAt: canvases.updatedAt,
        })
        .from(canvases)
        .where(inArray(canvases.projectId, filteredProjectIds))
        .orderBy(desc(canvases.updatedAt))

      return ok({
        canvases: rows.map((c) => ({
          canvasId: c.id,
          name: c.name,
          projectId: c.projectId,
          projectName: projectNameById.get(c.projectId) ?? null,
          updatedAt: c.updatedAt,
        })),
        count: rows.length,
      })
    },
  )

  server.registerTool(
    'getCanvasData',
    {
      title: '获取画布完整数据',
      description:
        '获取画布的完整数据，包括所有节点、连接、组和域。节点含 x/y/width/height，可用于规划新节点位置避免重叠。画布很大时优先用 getAllNodes / searchNodes。',
      inputSchema: { canvasId: canvasIdSchema },
    },
    async ({ canvasId }) => {
      const res = await withCanvas(ctx, canvasId)
      if ('error' in res) return res.error
      const { snapshot } = res
      return ok({
        nodes: snapshot.nodes,
        connections: snapshot.connections,
        groups: snapshot.groups,
        domains: snapshot.domains,
        counts: {
          nodes: snapshot.nodes.length,
          connections: snapshot.connections.length,
          groups: snapshot.groups.length,
          domains: snapshot.domains.length,
        },
      })
    },
  )

  server.registerTool(
    'getAllNodes',
    {
      title: '获取所有节点',
      description:
        '获取画布上所有节点的列表，包含节点的标题、内容、类型、坐标与尺寸等信息。',
      inputSchema: { canvasId: canvasIdSchema },
    },
    async ({ canvasId }) => {
      const res = await withCanvas(ctx, canvasId)
      if ('error' in res) return res.error
      return ok({ nodes: res.snapshot.nodes, count: res.snapshot.nodes.length })
    },
  )

  server.registerTool(
    'getAllConnections',
    {
      title: '获取所有连接',
      description:
        '获取画布上所有连接的列表，包含连接的起点、终点、标签、类型、样式等信息。',
      inputSchema: { canvasId: canvasIdSchema },
    },
    async ({ canvasId }) => {
      const res = await withCanvas(ctx, canvasId)
      if ('error' in res) return res.error
      return ok({
        connections: res.snapshot.connections,
        count: res.snapshot.connections.length,
      })
    },
  )

  server.registerTool(
    'getAllGroups',
    {
      title: '获取所有组',
      description:
        '获取画布上所有组的列表，包含组的名称、描述、包含的节点、折叠状态等信息。',
      inputSchema: { canvasId: canvasIdSchema },
    },
    async ({ canvasId }) => {
      const res = await withCanvas(ctx, canvasId)
      if ('error' in res) return res.error
      return ok({ groups: res.snapshot.groups, count: res.snapshot.groups.length })
    },
  )

  server.registerTool(
    'getAllDomains',
    {
      title: '获取所有域',
      description: '获取画布上所有域的列表，包含域的 ID 和名称。',
      inputSchema: { canvasId: canvasIdSchema },
    },
    async ({ canvasId }) => {
      const res = await withCanvas(ctx, canvasId)
      if ('error' in res) return res.error
      return ok({ domains: res.snapshot.domains, count: res.snapshot.domains.length })
    },
  )

  server.registerTool(
    'searchNodes',
    {
      title: '搜索节点',
      description:
        '在画布节点中搜索，按标题和/或内容匹配关键词（不区分大小写），返回匹配节点列表及命中片段。',
      inputSchema: {
        canvasId: canvasIdSchema,
        query: z.string().describe('搜索关键词'),
        scope: z
          .enum(['title', 'content', 'all'])
          .optional()
          .describe('搜索范围，默认 all（标题+内容）'),
      },
    },
    async ({ canvasId, query, scope }) => {
      const res = await withCanvas(ctx, canvasId)
      if ('error' in res) return res.error
      const needle = String(query || '').trim().toLowerCase()
      if (!needle) return fail('缺少搜索关键词(query)')
      const target = scope || 'all'

      const matches: Array<{
        id: string
        title: string
        match: 'title' | 'content'
        snippet: string
      }> = []
      for (const node of res.snapshot.nodes) {
        const title = typeof node.title === 'string' ? node.title : ''
        const content = typeof node.content === 'string' ? node.content : ''
        if (target === 'title' || target === 'all') {
          const index = title.toLowerCase().indexOf(needle)
          if (index !== -1) {
            matches.push({
              id: String(node.id),
              title,
              match: 'title',
              snippet: makeSnippet(title, index),
            })
            continue
          }
        }
        if (target === 'content' || target === 'all') {
          const index = content.toLowerCase().indexOf(needle)
          if (index !== -1) {
            matches.push({
              id: String(node.id),
              title,
              match: 'content',
              snippet: makeSnippet(content, index),
            })
          }
        }
      }
      return ok({ matches, count: matches.length })
    },
  )

  // ------------------------------------------------------------------- nodes

  server.registerTool(
    'createNode',
    {
      title: '创建节点',
      description:
        '在画布上创建一个新节点。建议节点大小不小于 200x160 以确保内容显示完整。创建成功返回 nodeId。未指定 x/y 时节点默认落在 (0,0)，建议先调用 getCanvasData 查看现有节点坐标再指定 x/y 避免重叠。',
      inputSchema: {
        canvasId: canvasIdSchema,
        title: z.string().describe('节点标题（必填）'),
        content: z.string().optional().describe('节点内容'),
        x: z.number().optional().describe('X 坐标位置'),
        y: z.number().optional().describe('Y 坐标位置'),
        width: z.number().optional().describe('节点宽度，默认 200，建议不小于 200'),
        height: z.number().optional().describe('节点高度，默认 160，建议不小于 160'),
        color: z
          .string()
          .optional()
          .describe(
            '节点背景颜色，十六进制格式。建议使用浅色（如 #e3f2fd、#f3e5f5、#e8f5e9），避免深色（如 #000000、#333333）以免影响文字可读性',
          ),
        fontSize: z.number().optional().describe('字体大小，默认 14'),
        textAlign: ALIGN_ENUM.optional().describe('文本统一对齐方式，默认 center'),
        titleAlign: ALIGN_ENUM.optional().describe('标题对齐方式'),
        contentAlign: ALIGN_ENUM.optional().describe('内容对齐方式'),
        collapsedTitleAlign: ALIGN_ENUM.optional().describe('折叠状态下标题对齐方式'),
        collapsed: z.boolean().optional().describe('是否折叠，默认 false'),
        locked: z.boolean().optional().describe('是否锁定，默认 false'),
        type: z.enum(['text', 'image']).optional().describe('节点类型，默认 text'),
        imageUrl: z.string().optional().describe('图片 URL，type 为 image 时必填'),
        aspectRatio: z.number().optional().describe('图片宽高比，如 1.5 表示宽:高=3:2'),
      },
    },
    async (args) => {
      const { canvasId, ...rest } = args
      const res = await withCanvas(ctx, canvasId)
      if ('error' in res) return res.error

      const title = String(rest.title || '').trim()
      if (!title) return fail('缺少节点标题(title)')

      const nodeType = rest.type || 'text'
      const nodeId = generateId('node')
      const node: Record<string, unknown> = {
        id: nodeId,
        title,
        content: String(rest.content || ''),
        x: toFiniteNumber(rest.x, 0),
        y: toFiniteNumber(rest.y, 0),
        width: toFiniteNumber(rest.width, 200),
        height: toFiniteNumber(rest.height, 160),
        color: String(rest.color ?? '#ffffff'),
        fontSize: toFiniteNumber(rest.fontSize, 14),
        textAlign: rest.textAlign || 'center',
        collapsed: Boolean(rest.collapsed ?? false),
        locked: Boolean(rest.locked ?? false),
        type: nodeType,
      }
      if (rest.titleAlign) node.titleAlign = rest.titleAlign
      if (rest.contentAlign) node.contentAlign = rest.contentAlign
      if (rest.collapsedTitleAlign) node.collapsedTitleAlign = rest.collapsedTitleAlign
      if (nodeType === 'image') node.imageUrl = String(rest.imageUrl || '')
      if (rest.aspectRatio !== undefined) {
        node.aspectRatio = toFiniteNumber(rest.aspectRatio, 1)
      }

      await upsertEntities(canvasId, { nodes: [node] })
      return ok({ nodeId, title, type: nodeType })
    },
  )

  server.registerTool(
    'updateNode',
    {
      title: '更新节点',
      description:
        '更新现有节点的属性，包括标题、内容、位置、大小、颜色、字体大小、对齐方式和折叠/锁定状态。只修改传入的字段，其余保持不变。节点 ID 通过 getAllNodes 或 createNode 获取。',
      inputSchema: {
        canvasId: canvasIdSchema,
        nodeId: z.string().describe('要更新的节点 ID'),
        title: z.string().optional().describe('新的节点标题'),
        content: z.string().optional().describe('新的节点内容'),
        x: z.number().optional().describe('新的 X 坐标'),
        y: z.number().optional().describe('新的 Y 坐标'),
        width: z.number().optional().describe('新的宽度，建议不小于 200'),
        height: z.number().optional().describe('新的高度，建议不小于 160'),
        color: z.string().optional().describe('新的节点颜色，十六进制格式'),
        fontSize: z.number().optional().describe('新的字体大小'),
        textAlign: ALIGN_ENUM.optional().describe('文本统一对齐方式'),
        titleAlign: ALIGN_ENUM.optional().describe('标题对齐方式'),
        contentAlign: ALIGN_ENUM.optional().describe('内容对齐方式'),
        collapsedTitleAlign: ALIGN_ENUM.optional().describe('折叠状态下标题对齐方式'),
        collapsed: z.boolean().optional().describe('是否折叠'),
        locked: z.boolean().optional().describe('是否锁定'),
        type: z.enum(['text', 'image']).optional().describe('节点类型'),
        imageUrl: z.string().optional().describe('图片 URL'),
        aspectRatio: z.number().optional().describe('图片宽高比'),
      },
    },
    async (args) => {
      const { canvasId, nodeId, ...rest } = args
      const res = await withCanvas(ctx, canvasId)
      if ('error' in res) return res.error
      if (!nodeId) return fail('缺少节点 ID')

      const existing = nodesById(res.snapshot).get(nodeId)
      if (!existing) {
        return fail(`节点不存在: ${nodeId}，可用 getAllNodes 获取有效节点 ID`)
      }

      const updates: Record<string, unknown> = {}
      if (rest.title !== undefined) updates.title = String(rest.title)
      if (rest.content !== undefined) updates.content = String(rest.content)
      if (rest.x !== undefined) updates.x = toFiniteNumber(rest.x, toFiniteNumber(existing.x, 0))
      if (rest.y !== undefined) updates.y = toFiniteNumber(rest.y, toFiniteNumber(existing.y, 0))
      if (rest.width !== undefined) {
        updates.width = toFiniteNumber(rest.width, toFiniteNumber(existing.width, 200))
      }
      if (rest.height !== undefined) {
        updates.height = toFiniteNumber(rest.height, toFiniteNumber(existing.height, 160))
      }
      if (rest.color !== undefined) updates.color = String(rest.color)
      if (rest.fontSize !== undefined) {
        updates.fontSize = toFiniteNumber(rest.fontSize, toFiniteNumber(existing.fontSize, 14))
      }
      if (rest.textAlign !== undefined) updates.textAlign = rest.textAlign
      if (rest.titleAlign !== undefined) updates.titleAlign = rest.titleAlign
      if (rest.contentAlign !== undefined) updates.contentAlign = rest.contentAlign
      if (rest.collapsedTitleAlign !== undefined) {
        updates.collapsedTitleAlign = rest.collapsedTitleAlign
      }
      if (rest.collapsed !== undefined) updates.collapsed = Boolean(rest.collapsed)
      if (rest.locked !== undefined) updates.locked = Boolean(rest.locked)
      if (rest.type !== undefined) updates.type = rest.type
      if (rest.imageUrl !== undefined) updates.imageUrl = String(rest.imageUrl)
      if (rest.aspectRatio !== undefined) {
        updates.aspectRatio = toFiniteNumber(
          rest.aspectRatio,
          toFiniteNumber(existing.aspectRatio, 1),
        )
      }

      if (Object.keys(updates).length === 0) {
        return fail('没有提供任何要更新的字段。请至少指定一个属性（如 title、content、x、y）。')
      }

      await upsertEntities(canvasId, { nodes: [{ id: nodeId, ...updates }] })
      return ok({ nodeId, updates })
    },
  )

  server.registerTool(
    'batchUpdateNodes',
    {
      title: '批量更新节点',
      description:
        '批量更新多个节点的相同属性，适用于统一修改（如全部改颜色、全部移动）。传入节点 ID 列表和要修改的字段，未提供的字段保持不变；不存在的节点会被跳过并记录。',
      inputSchema: {
        canvasId: canvasIdSchema,
        nodeIds: z.array(z.string()).describe('要更新的节点 ID 列表'),
        title: z.string().optional().describe('新的节点标题'),
        content: z.string().optional().describe('新的节点内容'),
        x: z.number().optional().describe('新的 X 坐标'),
        y: z.number().optional().describe('新的 Y 坐标'),
        width: z.number().optional().describe('新的宽度，建议不小于 200'),
        height: z.number().optional().describe('新的高度，建议不小于 160'),
        color: z.string().optional().describe('新的节点颜色，十六进制格式'),
        fontSize: z.number().optional().describe('新的字体大小'),
        textAlign: ALIGN_ENUM.optional().describe('文本统一对齐方式'),
        titleAlign: ALIGN_ENUM.optional().describe('标题对齐方式'),
        contentAlign: ALIGN_ENUM.optional().describe('内容对齐方式'),
        collapsedTitleAlign: ALIGN_ENUM.optional().describe('折叠状态下标题对齐方式'),
        collapsed: z.boolean().optional().describe('是否折叠'),
        locked: z.boolean().optional().describe('是否锁定'),
        type: z.enum(['text', 'image']).optional().describe('节点类型'),
        imageUrl: z.string().optional().describe('图片 URL'),
        aspectRatio: z.number().optional().describe('图片宽高比'),
      },
    },
    async (args) => {
      const { canvasId, nodeIds, ...rest } = args
      const res = await withCanvas(ctx, canvasId)
      if ('error' in res) return res.error
      if (!Array.isArray(nodeIds)) return fail('缺少节点 ID 列表(nodeIds)')

      const updates: Record<string, unknown> = {}
      if (rest.title !== undefined) updates.title = String(rest.title)
      if (rest.content !== undefined) updates.content = String(rest.content)
      if (rest.x !== undefined) updates.x = toFiniteNumber(rest.x, 0)
      if (rest.y !== undefined) updates.y = toFiniteNumber(rest.y, 0)
      if (rest.width !== undefined) updates.width = toFiniteNumber(rest.width, 200)
      if (rest.height !== undefined) updates.height = toFiniteNumber(rest.height, 160)
      if (rest.color !== undefined) updates.color = String(rest.color)
      if (rest.fontSize !== undefined) updates.fontSize = toFiniteNumber(rest.fontSize, 14)
      if (rest.textAlign !== undefined) updates.textAlign = rest.textAlign
      if (rest.titleAlign !== undefined) updates.titleAlign = rest.titleAlign
      if (rest.contentAlign !== undefined) updates.contentAlign = rest.contentAlign
      if (rest.collapsedTitleAlign !== undefined) {
        updates.collapsedTitleAlign = rest.collapsedTitleAlign
      }
      if (rest.collapsed !== undefined) updates.collapsed = Boolean(rest.collapsed)
      if (rest.locked !== undefined) updates.locked = Boolean(rest.locked)
      if (rest.type !== undefined) updates.type = rest.type
      if (rest.imageUrl !== undefined) updates.imageUrl = String(rest.imageUrl)
      if (rest.aspectRatio !== undefined) updates.aspectRatio = toFiniteNumber(rest.aspectRatio, 1)

      if (Object.keys(updates).length === 0) {
        return fail('没有提供任何要更新的字段。请至少指定一个属性。')
      }

      const existingIds = nodesById(res.snapshot)
      const skipped: string[] = []
      const toWrite: Record<string, unknown>[] = []
      for (const id of nodeIds) {
        if (!existingIds.has(id)) {
          skipped.push(id)
          continue
        }
        toWrite.push({ id, ...updates })
      }
      if (toWrite.length === 0) {
        return fail('所有节点均不存在，可用 getAllNodes 获取有效节点 ID')
      }

      await upsertEntities(canvasId, { nodes: toWrite })
      return ok({ updated: toWrite.length, skipped })
    },
  )

  server.registerTool(
    'deleteNode',
    {
      title: '删除节点',
      description:
        '删除指定的节点及其相关连接。节点 ID 通过 getAllNodes 或 createNode 获取。',
      inputSchema: {
        canvasId: canvasIdSchema,
        nodeId: z.string().describe('要删除的节点 ID'),
      },
    },
    async ({ canvasId, nodeId }) => {
      const res = await withCanvas(ctx, canvasId)
      if ('error' in res) return res.error
      if (!nodeId) return fail('缺少节点 ID')
      if (!nodesById(res.snapshot).has(nodeId)) {
        return fail(`节点不存在: ${nodeId}，可用 getAllNodes 获取有效节点 ID`)
      }

      // Cascade to attached connections, matching the frontend store's removeNode.
      const attached = res.snapshot.connections
        .filter((c) => c.fromNodeId === nodeId || c.toNodeId === nodeId)
        .map((c) => String(c.id))

      const result = await deleteEntities(canvasId, {
        nodeIds: [nodeId],
        connectionIds: attached,
      })
      return ok({
        deletedNodeId: nodeId,
        deletedConnectionIds: result.deleted.connections,
      })
    },
  )

  // ------------------------------------------------------------- connections

  server.registerTool(
    'createConnection',
    {
      title: '创建连接',
      description:
        '在两个节点之间创建连接。未指定端口时按两节点相对位置自动选择（水平关系用左右端口，垂直关系用上下端口）。源节点和目标节点必须已存在。',
      inputSchema: {
        canvasId: canvasIdSchema,
        fromNodeId: z.string().describe('源节点 ID'),
        toNodeId: z.string().describe('目标节点 ID'),
        fromPort: PORT_ENUM.optional().describe('源端口位置，不指定则自动计算'),
        toPort: PORT_ENUM.optional().describe('目标端口位置，不指定则自动计算'),
        type: z
          .enum(['straight', 'curve', 'step'])
          .optional()
          .describe('连线类型，默认 curve'),
        style: z
          .enum(['solid', 'dashed', 'dotted'])
          .optional()
          .describe('连线样式，默认 solid'),
        color: z.string().optional().describe('连线颜色，默认 #3b82f6'),
        width: z.number().optional().describe('连线宽度，默认 2'),
        label: z.string().optional().describe('连接标签文本'),
        arrowType: z
          .enum(['none', 'start', 'end', 'both'])
          .optional()
          .describe('箭头类型，默认 end'),
        direction: z
          .enum(['directed', 'bidirectional', 'undirected'])
          .optional()
          .describe('方向类型，默认 directed'),
      },
    },
    async (args) => {
      const { canvasId, fromNodeId, toNodeId, ...rest } = args
      const res = await withCanvas(ctx, canvasId)
      if ('error' in res) return res.error
      if (!fromNodeId || !toNodeId) return fail('缺少源节点或目标节点 ID')

      const nodes = nodesById(res.snapshot)
      const fromNode = nodes.get(fromNodeId)
      const toNode = nodes.get(toNodeId)
      if (!fromNode) {
        return fail(`节点不存在: ${fromNodeId}，可用 getAllNodes 获取有效节点 ID`)
      }
      if (!toNode) {
        return fail(`节点不存在: ${toNodeId}，可用 getAllNodes 获取有效节点 ID`)
      }

      let fromPort: string = 'bottom'
      let toPort: string = 'top'
      const dx = toFiniteNumber(toNode.x, 0) - toFiniteNumber(fromNode.x, 0)
      const dy = toFiniteNumber(toNode.y, 0) - toFiniteNumber(fromNode.y, 0)
      if (Math.abs(dx) > Math.abs(dy)) {
        fromPort = dx > 0 ? 'right' : 'left'
        toPort = dx > 0 ? 'left' : 'right'
      } else {
        fromPort = dy > 0 ? 'bottom' : 'top'
        toPort = dy > 0 ? 'top' : 'bottom'
      }

      const connectionId = generateId('conn')
      const connection: Record<string, unknown> = {
        id: connectionId,
        fromNodeId,
        toNodeId,
        fromPort: rest.fromPort || fromPort,
        toPort: rest.toPort || toPort,
        type: rest.type || 'curve',
        style: rest.style || 'solid',
        color: String(rest.color ?? '#3b82f6'),
        width: toFiniteNumber(rest.width, 2),
        arrowType: rest.arrowType || 'end',
        direction: rest.direction || 'directed',
        label: String(rest.label || ''),
      }

      await upsertEntities(canvasId, { connections: [connection] })
      return ok({ connectionId, fromNodeId, toNodeId })
    },
  )

  server.registerTool(
    'updateConnection',
    {
      title: '更新连接',
      description:
        '更新现有连接的属性，包括连线类型、样式、方向、箭头类型、颜色、宽度、标签和端口位置。连接 ID 通过 getAllConnections 获取。',
      inputSchema: {
        canvasId: canvasIdSchema,
        connectionId: z.string().describe('要更新的连接 ID'),
        fromNodeId: z.string().optional().describe('新的源节点 ID'),
        toNodeId: z.string().optional().describe('新的目标节点 ID'),
        fromPort: PORT_ENUM.optional().describe('新的源端口位置'),
        toPort: PORT_ENUM.optional().describe('新的目标端口位置'),
        type: z.enum(['straight', 'curve', 'step']).optional().describe('连线类型'),
        style: z.enum(['solid', 'dashed', 'dotted']).optional().describe('连线样式'),
        color: z.string().optional().describe('连线颜色，如 #666666'),
        width: z.number().optional().describe('连线宽度（像素）'),
        arrowType: z
          .enum(['none', 'start', 'end', 'both'])
          .optional()
          .describe('箭头类型'),
        direction: z
          .enum(['directed', 'bidirectional', 'undirected'])
          .optional()
          .describe('方向类型'),
        label: z.string().optional().describe('连接标签文本'),
      },
    },
    async (args) => {
      const { canvasId, connectionId, ...rest } = args
      const res = await withCanvas(ctx, canvasId)
      if ('error' in res) return res.error
      if (!connectionId) return fail('缺少连接 ID')

      const existing = res.snapshot.connections.find((c) => c.id === connectionId)
      if (!existing) {
        return fail(`连接不存在: ${connectionId}，可用 getAllConnections 获取有效连接 ID`)
      }

      // M3-fix: 校验新的端点节点存在——否则产生悬空连线：前端渲染
      // `if (!fromNode || !toNode) return null` 静默跳过，用户看不见但实体
      // 仍在 doc 中、会被导出与 getAllConnections 返回。createConnection
      // 有完整校验，这里对"重定向端点"路径补齐同款防线。
      const allNodes = nodesById(res.snapshot)
      if (rest.fromNodeId !== undefined && !allNodes.has(String(rest.fromNodeId))) {
        return fail(`源节点不存在: ${rest.fromNodeId}，可用 getAllNodes 获取有效节点 ID`)
      }
      if (rest.toNodeId !== undefined && !allNodes.has(String(rest.toNodeId))) {
        return fail(`目标节点不存在: ${rest.toNodeId}，可用 getAllNodes 获取有效节点 ID`)
      }

      const updates: Record<string, unknown> = {}
      if (rest.fromNodeId !== undefined) updates.fromNodeId = String(rest.fromNodeId)
      if (rest.toNodeId !== undefined) updates.toNodeId = String(rest.toNodeId)
      if (rest.fromPort !== undefined) updates.fromPort = rest.fromPort
      if (rest.toPort !== undefined) updates.toPort = rest.toPort
      if (rest.type !== undefined) updates.type = rest.type
      if (rest.style !== undefined) updates.style = rest.style
      if (rest.color !== undefined) updates.color = String(rest.color)
      if (rest.width !== undefined) {
        updates.width = toFiniteNumber(rest.width, toFiniteNumber(existing.width, 2))
      }
      if (rest.arrowType !== undefined) updates.arrowType = rest.arrowType
      if (rest.direction !== undefined) updates.direction = rest.direction
      if (rest.label !== undefined) updates.label = String(rest.label)

      if (Object.keys(updates).length === 0) {
        return fail('没有提供任何要更新的字段。请至少指定一个属性。')
      }

      await upsertEntities(canvasId, { connections: [{ id: connectionId, ...updates }] })
      return ok({ connectionId, updates })
    },
  )

  server.registerTool(
    'deleteConnection',
    {
      title: '删除连接',
      description: '删除指定的连接。连接 ID 通过 getAllConnections 获取。',
      inputSchema: {
        canvasId: canvasIdSchema,
        connectionId: z.string().describe('要删除的连接 ID'),
      },
    },
    async ({ canvasId, connectionId }) => {
      const res = await withCanvas(ctx, canvasId)
      if ('error' in res) return res.error
      if (!connectionId) return fail('缺少连接 ID')
      if (!res.snapshot.connections.some((c) => c.id === connectionId)) {
        return fail(`连接不存在: ${connectionId}，可用 getAllConnections 获取有效连接 ID`)
      }
      await deleteEntities(canvasId, { connectionIds: [connectionId] })
      return ok({ deletedConnectionId: connectionId })
    },
  )

  // ------------------------------------------------------------------ groups

  server.registerTool(
    'createGroup',
    {
      title: '创建组',
      description:
        '创建一个新组，用于将多个相关节点组合在一起。组是带边框的容器，适合小范围紧密组合。传入节点 ID 列表后，系统会自动计算边界框覆盖所有节点。',
      inputSchema: {
        canvasId: canvasIdSchema,
        name: z.string().optional().describe('组名称，如"家庭"、"团队"、"模块"'),
        description: z.string().optional().describe('组的详细描述'),
        nodeIds: z
          .array(z.string())
          .optional()
          .describe('包含的节点 ID 列表，提供后自动计算组的位置和大小'),
      },
    },
    async (args) => {
      const { canvasId, nodeIds, ...rest } = args
      const res = await withCanvas(ctx, canvasId)
      if ('error' in res) return res.error

      const ids = nodeIds ?? []
      let bounds: { x: number; y: number; width: number; height: number } | null = null
      if (ids.length > 0) {
        bounds = calculateNodesBounds(ids, nodesById(res.snapshot), 20)
      }
      if (ids.length > 0 && bounds === null) {
        return fail('指定的节点均不存在，可用 getAllNodes 获取有效节点 ID')
      }

      const groupId = generateId('group')
      const group: Record<string, unknown> = {
        id: groupId,
        name: String(rest.name || '新组'),
        description: String(rest.description || ''),
        x: bounds?.x ?? 0,
        y: bounds?.y ?? 0,
        width: bounds?.width ?? 300,
        height: bounds?.height ?? 200,
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59, 130, 246, 0.1)',
        borderWidth: 2,
        borderRadius: 8,
        nodeIds: ids,
        collapsed: false,
      }

      await upsertEntities(canvasId, { groups: [group] })
      return ok({ groupId, name: group.name, nodeCount: ids.length })
    },
  )

  server.registerTool(
    'updateGroup',
    {
      title: '更新组',
      description:
        '更新现有组的属性，包括名称、描述、位置、大小、颜色、边框样式和包含的节点。组 ID 通过 getAllGroups 获取。',
      inputSchema: {
        canvasId: canvasIdSchema,
        groupId: z.string().describe('要更新的组 ID'),
        name: z.string().optional().describe('新的组名称'),
        description: z.string().optional().describe('新的组描述'),
        nodeIds: z.array(z.string()).optional().describe('新的节点 ID 列表'),
        x: z.number().optional().describe('新的 X 坐标'),
        y: z.number().optional().describe('新的 Y 坐标'),
        width: z.number().optional().describe('新的宽度'),
        height: z.number().optional().describe('新的高度'),
        borderColor: z.string().optional().describe('边框颜色，如 #3b82f6'),
        backgroundColor: z
          .string()
          .optional()
          .describe('背景颜色，十六进制或 rgba，如 rgba(59, 130, 246, 0.1)'),
        borderWidth: z.number().optional().describe('边框宽度，如 2'),
        borderRadius: z.number().optional().describe('边框圆角，如 8'),
        collapsed: z.boolean().optional().describe('是否折叠'),
      },
    },
    async (args) => {
      const { canvasId, groupId, ...rest } = args
      const res = await withCanvas(ctx, canvasId)
      if ('error' in res) return res.error
      if (!groupId) return fail('缺少组 ID')

      const existing = res.snapshot.groups.find((g) => g.id === groupId)
      if (!existing) {
        return fail(`组不存在: ${groupId}，可用 getAllGroups 获取有效组 ID`)
      }

      const updates: Record<string, unknown> = {}
      if (rest.name !== undefined) updates.name = String(rest.name)
      if (rest.description !== undefined) updates.description = String(rest.description)
      if (rest.nodeIds !== undefined) updates.nodeIds = rest.nodeIds
      if (rest.x !== undefined) updates.x = toFiniteNumber(rest.x, toFiniteNumber(existing.x, 0))
      if (rest.y !== undefined) updates.y = toFiniteNumber(rest.y, toFiniteNumber(existing.y, 0))
      if (rest.width !== undefined) {
        updates.width = toFiniteNumber(rest.width, toFiniteNumber(existing.width, 300))
      }
      if (rest.height !== undefined) {
        updates.height = toFiniteNumber(rest.height, toFiniteNumber(existing.height, 200))
      }
      if (rest.borderColor !== undefined) updates.borderColor = String(rest.borderColor)
      if (rest.backgroundColor !== undefined) {
        updates.backgroundColor = String(rest.backgroundColor)
      }
      if (rest.borderWidth !== undefined) {
        updates.borderWidth = toFiniteNumber(
          rest.borderWidth,
          toFiniteNumber(existing.borderWidth, 2),
        )
      }
      if (rest.borderRadius !== undefined) {
        updates.borderRadius = toFiniteNumber(
          rest.borderRadius,
          toFiniteNumber(existing.borderRadius, 8),
        )
      }
      if (rest.collapsed !== undefined) updates.collapsed = Boolean(rest.collapsed)

      if (Object.keys(updates).length === 0) {
        return fail('没有提供任何要更新的字段。请至少指定一个属性。')
      }

      await upsertEntities(canvasId, { groups: [{ id: groupId, ...updates }] })
      return ok({ groupId, updates })
    },
  )

  server.registerTool(
    'deleteGroup',
    {
      title: '删除组',
      description: '删除指定的组。组 ID 通过 getAllGroups 获取。删除组不会删除组内的节点。',
      inputSchema: {
        canvasId: canvasIdSchema,
        groupId: z.string().describe('要删除的组 ID'),
      },
    },
    async ({ canvasId, groupId }) => {
      const res = await withCanvas(ctx, canvasId)
      if ('error' in res) return res.error
      if (!groupId) return fail('缺少组 ID')
      if (!res.snapshot.groups.some((g) => g.id === groupId)) {
        return fail(`组不存在: ${groupId}，可用 getAllGroups 获取有效组 ID`)
      }
      await deleteEntities(canvasId, { groupIds: [groupId] })
      return ok({ deletedGroupId: groupId })
    },
  )

  // ----------------------------------------------------------------- domains

  server.registerTool(
    'createDomain',
    {
      title: '创建域',
      description:
        '创建一个新域，用于划分画布的特定区域。域是背景级别的容器，适合大范围划分。传入节点 ID 列表后，系统会自动计算边界框覆盖所有节点。',
      inputSchema: {
        canvasId: canvasIdSchema,
        name: z.string().optional().describe('域名称，如"研发部"、"销售区"、"决策层"'),
        nodeIds: z
          .array(z.string())
          .optional()
          .describe('包含的节点 ID 列表，提供后自动计算域的位置和大小'),
      },
    },
    async (args) => {
      const { canvasId, nodeIds, ...rest } = args
      const res = await withCanvas(ctx, canvasId)
      if ('error' in res) return res.error

      const ids = nodeIds ?? []
      let bounds: { x: number; y: number; width: number; height: number } | null = null
      if (ids.length > 0) {
        bounds = calculateNodesBounds(ids, nodesById(res.snapshot), 20)
      }
      if (ids.length > 0 && bounds === null) {
        return fail('指定的节点均不存在，可用 getAllNodes 获取有效节点 ID')
      }

      const domainId = generateId('domain')
      const domain: Record<string, unknown> = {
        id: domainId,
        name: String(rest.name || '新域'),
        x: bounds?.x ?? 0,
        y: bounds?.y ?? 0,
        width: bounds?.width ?? 400,
        height: bounds?.height ?? 300,
        backgroundColor: 'rgba(139, 92, 246, 0.1)',
        titleVisible: true,
      }

      await upsertEntities(canvasId, { domains: [domain] })
      return ok({ domainId, name: domain.name, nodeCount: ids.length })
    },
  )

  server.registerTool(
    'updateDomain',
    {
      title: '更新域',
      description:
        '更新现有域的属性，包括名称、位置、大小、背景颜色和标题样式。域 ID 通过 getAllDomains 获取。',
      inputSchema: {
        canvasId: canvasIdSchema,
        domainId: z.string().describe('要更新的域 ID'),
        name: z.string().optional().describe('新的域名称'),
        x: z.number().optional().describe('新的 X 坐标'),
        y: z.number().optional().describe('新的 Y 坐标'),
        width: z.number().optional().describe('新的宽度'),
        height: z.number().optional().describe('新的高度'),
        backgroundColor: z
          .string()
          .optional()
          .describe('背景颜色，十六进制或 rgba，如 rgba(139, 92, 246, 0.1)'),
        titleVisible: z.boolean().optional().describe('标题是否可见'),
        titleColor: z.string().optional().describe('标题颜色，十六进制格式'),
        titleFontSize: z.number().optional().describe('标题字体大小'),
        titleScale: z.number().optional().describe('标题缩放比例'),
      },
    },
    async (args) => {
      const { canvasId, domainId, ...rest } = args
      const res = await withCanvas(ctx, canvasId)
      if ('error' in res) return res.error
      if (!domainId) return fail('缺少域 ID')

      const existing = res.snapshot.domains.find((d) => d.id === domainId)
      if (!existing) {
        return fail(`域不存在: ${domainId}，可用 getAllDomains 获取有效域 ID`)
      }

      const updates: Record<string, unknown> = {}
      if (rest.name !== undefined) updates.name = String(rest.name)
      if (rest.x !== undefined) updates.x = toFiniteNumber(rest.x, toFiniteNumber(existing.x, 0))
      if (rest.y !== undefined) updates.y = toFiniteNumber(rest.y, toFiniteNumber(existing.y, 0))
      if (rest.width !== undefined) {
        updates.width = toFiniteNumber(rest.width, toFiniteNumber(existing.width, 400))
      }
      if (rest.height !== undefined) {
        updates.height = toFiniteNumber(rest.height, toFiniteNumber(existing.height, 300))
      }
      if (rest.backgroundColor !== undefined) {
        updates.backgroundColor = String(rest.backgroundColor)
      }
      if (rest.titleVisible !== undefined) updates.titleVisible = Boolean(rest.titleVisible)
      if (rest.titleColor !== undefined) updates.titleColor = String(rest.titleColor)
      if (rest.titleFontSize !== undefined) {
        updates.titleFontSize = toFiniteNumber(
          rest.titleFontSize,
          toFiniteNumber(existing.titleFontSize, 14),
        )
      }
      if (rest.titleScale !== undefined) {
        updates.titleScale = toFiniteNumber(
          rest.titleScale,
          toFiniteNumber(existing.titleScale, 1),
        )
      }

      if (Object.keys(updates).length === 0) {
        return fail('没有提供任何要更新的字段。请至少指定一个属性。')
      }

      await upsertEntities(canvasId, { domains: [{ id: domainId, ...updates }] })
      return ok({ domainId, updates })
    },
  )

  server.registerTool(
    'deleteDomain',
    {
      title: '删除域',
      description: '删除指定的域。域 ID 通过 getAllDomains 获取。',
      inputSchema: {
        canvasId: canvasIdSchema,
        domainId: z.string().describe('要删除的域 ID'),
      },
    },
    async ({ canvasId, domainId }) => {
      const res = await withCanvas(ctx, canvasId)
      if ('error' in res) return res.error
      if (!domainId) return fail('缺少域 ID')
      if (!res.snapshot.domains.some((d) => d.id === domainId)) {
        return fail(`域不存在: ${domainId}，可用 getAllDomains 获取有效域 ID`)
      }
      await deleteEntities(canvasId, { domainIds: [domainId] })
      return ok({ deletedDomainId: domainId })
    },
  )

  // ------------------------------------------------------------- bulk builder

  server.registerTool(
    'generateGraphFromJSON',
    {
      title: '用 JSON 批量生成图形',
      description: `通过 JSON 数据结构一次性生成图形。支持任意节点和连线关系，可创建复杂的对象关系图、流程图、网络拓扑图、类图等，不限于树状思维导图。追加语义：只新增实体，不会清空或替换画布上已有的节点/连线。

【核心特性】
- 节点和连线完全独立定义，无层级限制
- 支持任意复杂关系（多对多、循环引用、自连接等）
- 每条连线可独立配置样式（颜色、线型、箭头、标签）
- 支持组和域来组织节点
- 节点坐标可精确指定或由系统自动布局

【JSON 结构】
1. nodes（必须，至少一个）：{ id?, title(必须), content?, x?, y?, width?(建议>=200), height?(建议>=160), color?(建议浅色), fontSize?, textAlign?, titleAlign?, contentAlign?, collapsedTitleAlign?, collapsed?, locked?, type?('text'|'image'), imageUrl?, aspectRatio? }
2. connections（可选）：{ from(节点 id 或 title), to(节点 id 或 title), fromPort?, toPort?, type?('straight'|'curve'|'step'), style?('solid'|'dashed'|'dotted'), color?(默认 #666666), width?, arrowType?('none'|'start'|'end'|'both'), direction?('directed'|'bidirectional'|'undirected'), label? }
   - 未指定端口时按节点相对位置自动计算
3. layout（可选，用于未指定坐标的节点）：{ type?('grid'|'circle'), centerX?, centerY?, spacing?(默认 250), columns?(grid 默认 3) }
4. defaultNodeStyle / defaultConnectionStyle（可选）：为所有节点/连线提供默认属性
5. groups（可选）：{ id?, name(必须), nodeIds(节点 id 或 title), description?, x?, y?, width?, height?, borderColor?, backgroundColor?, borderWidth?, borderRadius?, collapsed? } —— 未指定位置/尺寸时按包含节点自动计算（30px 边距）
6. domains（可选）：{ id?, name(必须), nodeIds?, x?, y?, width?, height?, backgroundColor?, titleVisible?, titleColor?, titleFontSize?, titleScale? } —— 未指定时自动计算（40px 边距）

【建议】节点宽度 >= 200、高度 >= 160；背景色用浅色（#e3f2fd、#f3e5f5、#e8f5e9）以免文字不可读；连线样式：solid+end 表示调用/数据流，dashed+end 表示依赖，dotted+none 表示弱关联。`,
      inputSchema: {
        canvasId: canvasIdSchema,
        data: z
          .object({
            nodes: z
              .array(z.object({ title: z.string() }).passthrough())
              .describe('节点数组（必须，每个节点至少含 title）'),
            connections: z.array(z.object({}).passthrough()).optional().describe('连线数组'),
            groups: z.array(z.object({}).passthrough()).optional().describe('组数组'),
            domains: z.array(z.object({}).passthrough()).optional().describe('域数组'),
            layout: z.object({}).passthrough().optional().describe('自动布局配置'),
            defaultNodeStyle: z.object({}).passthrough().optional().describe('默认节点样式'),
            defaultConnectionStyle: z
              .object({})
              .passthrough()
              .optional()
              .describe('默认连线样式'),
          })
          .passthrough()
          .describe('图形的完整 JSON 数据结构'),
      },
    },
    async ({ canvasId, data }) => {
      const res = await withCanvas(ctx, canvasId)
      if ('error' in res) return res.error

      // Runtime validation with actionable messages. The schema above is
      // intentionally permissive (models emit extra keys and stringy numbers),
      // so the real checks live here and name the offending node by index.
      const graph = data as {
        nodes?: unknown
        connections?: unknown[]
        groups?: unknown[]
        domains?: unknown[]
        layout?: Record<string, unknown>
        defaultNodeStyle?: Record<string, unknown>
        defaultConnectionStyle?: Record<string, unknown>
      }

      if (!graph || typeof graph !== 'object') {
        return fail('缺少图形数据参数。请确保提供了有效的 data 参数，包含 nodes 节点数组。')
      }
      if (!Array.isArray(graph.nodes)) {
        return fail(
          `nodes 必须是数组类型，但收到的是 ${typeof graph.nodes}。请确保 JSON 格式正确。`,
        )
      }
      if (graph.nodes.length === 0) {
        return fail('nodes 数组不能为空。请至少提供一个节点对象，包含 title 属性。')
      }

      const invalid: Array<{ index: number; reason: string }> = []
      graph.nodes.forEach((node, index) => {
        if (!node || typeof node !== 'object') {
          invalid.push({ index, reason: '节点不是有效的对象' })
        } else {
          const title = (node as Record<string, unknown>).title
          if (typeof title !== 'string' || title.trim() === '') {
            invalid.push({ index, reason: '缺少 title 属性或 title 为空字符串' })
          }
        }
      })
      if (invalid.length > 0) {
        const details = invalid.map((i) => `第 ${i.index + 1} 个节点: ${i.reason}`).join('\n')
        return fail(
          `发现 ${invalid.length} 个无效节点:\n${details}\n\n每个节点必须包含一个非空的 title 属性。`,
        )
      }

      const existing = res.snapshot
      const existingNodeIds = new Set(existing.nodes.map((n) => String(n.id)))
      const existingConnectionIds = new Set(existing.connections.map((c) => String(c.id)))
      const existingGroupIds = new Set(existing.groups.map((g) => String(g.id)))
      const existingDomainIds = new Set(existing.domains.map((d) => String(d.id)))

      const nodeIdMap = new Map<string, string>()
      const usedNodeIds = new Set<string>()
      const nodesOut: Record<string, unknown>[] = []
      const defaultStyle = (graph.defaultNodeStyle ?? {}) as Record<string, unknown>

      // Step 1: materialise nodes (positions computed when omitted).
      ;(graph.nodes as Record<string, unknown>[]).forEach((nodeData, index) => {
        let nodeId = typeof nodeData.id === 'string' && nodeData.id ? nodeData.id : generateId('node')
        while (usedNodeIds.has(nodeId) || existingNodeIds.has(nodeId)) {
          nodeId = generateId('node')
        }
        usedNodeIds.add(nodeId)
        nodeIdMap.set(
          typeof nodeData.id === 'string' && nodeData.id ? nodeData.id : String(nodeData.title),
          nodeId,
        )

        let x = typeof nodeData.x === 'number' ? nodeData.x : undefined
        let y = typeof nodeData.y === 'number' ? nodeData.y : undefined
        if (x === undefined || y === undefined) {
          const layout = (graph.layout ?? {}) as Record<string, unknown>
          const layoutType = (layout.type as string) || 'grid'
          const spacing = toFiniteNumber(layout.spacing, 250) || 250
          const centerX = toFiniteNumber(layout.centerX, 0)
          const centerY = toFiniteNumber(layout.centerY, 0)
          const total = (graph.nodes as unknown[]).length
          if (layoutType === 'circle') {
            const angle = (index / total) * 2 * Math.PI
            const radius = spacing * 2
            x = centerX + Math.cos(angle) * radius
            y = centerY + Math.sin(angle) * radius
          } else {
            const columns = toFiniteNumber(layout.columns, 3) || 3
            const row = Math.floor(index / columns)
            const col = index % columns
            x = centerX + (col - (columns - 1) / 2) * spacing
            y = centerY + (row - Math.floor(total / columns) / 2) * spacing
          }
        }

        const node: Record<string, unknown> = {
          id: nodeId,
          title: String(nodeData.title),
          content: String(nodeData.content ?? defaultStyle.content ?? ''),
          x: x as number,
          y: y as number,
          width: toFiniteNumber(nodeData.width ?? defaultStyle.width, 200),
          height: toFiniteNumber(nodeData.height ?? defaultStyle.height, 160),
          color: String(nodeData.color ?? defaultStyle.color ?? '#ffffff'),
          fontSize: toFiniteNumber(nodeData.fontSize ?? defaultStyle.fontSize, 14),
          textAlign: nodeData.textAlign ?? defaultStyle.textAlign ?? 'center',
          collapsed: Boolean(nodeData.collapsed ?? defaultStyle.collapsed ?? false),
          locked: Boolean(nodeData.locked ?? defaultStyle.locked ?? false),
          type: nodeData.type ?? defaultStyle.type ?? 'text',
        }
        const titleAlign = nodeData.titleAlign ?? defaultStyle.titleAlign
        const contentAlign = nodeData.contentAlign ?? defaultStyle.contentAlign
        const collapsedTitleAlign = nodeData.collapsedTitleAlign ?? defaultStyle.collapsedTitleAlign
        const imageUrl = nodeData.imageUrl ?? defaultStyle.imageUrl
        const aspectRatio = nodeData.aspectRatio ?? defaultStyle.aspectRatio
        if (titleAlign !== undefined) node.titleAlign = titleAlign
        if (contentAlign !== undefined) node.contentAlign = contentAlign
        if (collapsedTitleAlign !== undefined) node.collapsedTitleAlign = collapsedTitleAlign
        if (imageUrl !== undefined) node.imageUrl = imageUrl
        if (aspectRatio !== undefined) node.aspectRatio = aspectRatio
        nodesOut.push(node)
      })

      // Step 2: connections, resolving from/to by id or title.
      const connectionsOut: Record<string, unknown>[] = []
      // L2-fix: 无法解析端点引用的连线不再静默丢弃——记录条数并在返回值中
      // 报告，调用方（agent）能发现图的边缺失而不是以为全部创建成功。
      let skippedConnections = 0
      const usedConnectionIds = new Set<string>()
      if (Array.isArray(graph.connections)) {
        const defaultConn = (graph.defaultConnectionStyle ?? {}) as Record<string, unknown>
        for (const connData of graph.connections as Record<string, unknown>[]) {
          const fromRef = String(connData.from ?? '')
          const toRef = String(connData.to ?? '')
          const fromNodeId =
            nodeIdMap.get(fromRef) ?? nodesOut.find((n) => n.title === fromRef)?.id
          const toNodeId = nodeIdMap.get(toRef) ?? nodesOut.find((n) => n.title === toRef)?.id
          if (typeof fromNodeId !== 'string' || typeof toNodeId !== 'string') {
            skippedConnections++
            continue
          }

          const fromNode = nodesOut.find((n) => n.id === fromNodeId)
          const toNode = nodesOut.find((n) => n.id === toNodeId)

          let fromPort = connData.fromPort as string | undefined
          let toPort = connData.toPort as string | undefined
          if (!fromPort || !toPort) {
            if (fromNode && toNode) {
              const dx = toFiniteNumber(toNode.x, 0) - toFiniteNumber(fromNode.x, 0)
              const dy = toFiniteNumber(toNode.y, 0) - toFiniteNumber(fromNode.y, 0)
              const angle = Math.atan2(dy, dx)
              fromPort = fromPort ?? getPortByAngle(angle)
              toPort = toPort ?? getPortByAngle(angle + Math.PI)
            } else {
              fromPort = fromPort ?? 'bottom'
              toPort = toPort ?? 'top'
            }
          }

          let connId =
            typeof connData.id === 'string' && connData.id ? connData.id : generateId('conn')
          while (usedConnectionIds.has(connId) || existingConnectionIds.has(connId)) {
            connId = generateId('conn')
          }
          usedConnectionIds.add(connId)

          connectionsOut.push({
            id: connId,
            fromNodeId,
            toNodeId,
            fromPort,
            toPort,
            type: connData.type ?? defaultConn.type ?? 'curve',
            style: connData.style ?? defaultConn.style ?? 'solid',
            // L2-fix: 默认色与 createConnection 统一为 CONNECTION 蓝，避免
            // 同一画布上 agent 建的线与用户手画的线颜色不一致。
            color: connData.color ?? defaultConn.color ?? '#3b82f6',
            width: toFiniteNumber(connData.width ?? defaultConn.width, 2),
            arrowType: connData.arrowType ?? defaultConn.arrowType ?? 'end',
            direction: connData.direction ?? defaultConn.direction ?? 'directed',
            label: String(connData.label ?? ''),
          })
        }
      }

      // Step 3: groups (auto-bounds with 30px padding).
      const groupsOut: Record<string, unknown>[] = []
      const usedGroupIds = new Set<string>()
      if (Array.isArray(graph.groups)) {
        for (const groupData of graph.groups as Record<string, unknown>[]) {
          let groupId =
            typeof groupData.id === 'string' && groupData.id ? groupData.id : generateId('group')
          while (usedGroupIds.has(groupId) || existingGroupIds.has(groupId)) {
            groupId = generateId('group')
          }
          usedGroupIds.add(groupId)

          const refs = Array.isArray(groupData.nodeIds) ? (groupData.nodeIds as unknown[]) : []
          const resolvedNodeIds = refs
            .map(
              (ref) =>
                nodeIdMap.get(String(ref)) ??
                nodesOut.find((n) => n.title === String(ref))?.id,
            )
            .filter((id): id is string => typeof id === 'string')

          const bounds = calculateNodesBounds(
            resolvedNodeIds,
            nodesById({ ...existing, nodes: nodesOut }),
            30,
          )
          groupsOut.push({
            id: groupId,
            name: String(groupData.name ?? '新组'),
            description: String(groupData.description || ''),
            x: toFiniteNumber(groupData.x, bounds?.x ?? 0),
            y: toFiniteNumber(groupData.y, bounds?.y ?? 0),
            width: toFiniteNumber(groupData.width, bounds?.width ?? 300),
            height: toFiniteNumber(groupData.height, bounds?.height ?? 200),
            borderColor: String(groupData.borderColor ?? '#3b82f6'),
            backgroundColor: String(groupData.backgroundColor ?? 'rgba(59, 130, 246, 0.1)'),
            borderWidth: toFiniteNumber(groupData.borderWidth, 2),
            borderRadius: toFiniteNumber(groupData.borderRadius, 8),
            nodeIds: resolvedNodeIds,
            collapsed: Boolean(groupData.collapsed ?? false),
          })
        }
      }

      // Step 4: domains (auto-bounds with 40px padding).
      const domainsOut: Record<string, unknown>[] = []
      const usedDomainIds = new Set<string>()
      if (Array.isArray(graph.domains)) {
        for (const domainData of graph.domains as Record<string, unknown>[]) {
          let domainId =
            typeof domainData.id === 'string' && domainData.id ? domainData.id : generateId('domain')
          while (usedDomainIds.has(domainId) || existingDomainIds.has(domainId)) {
            domainId = generateId('domain')
          }
          usedDomainIds.add(domainId)

          const refs = Array.isArray(domainData.nodeIds) ? (domainData.nodeIds as unknown[]) : []
          const resolvedNodeIds = refs
            .map(
              (ref) =>
                nodeIdMap.get(String(ref)) ??
                nodesOut.find((n) => n.title === String(ref))?.id,
            )
            .filter((id): id is string => typeof id === 'string')

          const bounds = calculateNodesBounds(
            resolvedNodeIds,
            nodesById({ ...existing, nodes: nodesOut }),
            40,
          )
          const domain: Record<string, unknown> = {
            id: domainId,
            name: String(domainData.name ?? '新域'),
            x: toFiniteNumber(domainData.x, bounds?.x ?? 0),
            y: toFiniteNumber(domainData.y, bounds?.y ?? 0),
            width: toFiniteNumber(domainData.width, bounds?.width ?? 400),
            height: toFiniteNumber(domainData.height, bounds?.height ?? 300),
            backgroundColor: String(domainData.backgroundColor ?? 'rgba(139, 92, 246, 0.1)'),
            titleVisible: Boolean(domainData.titleVisible ?? true),
          }
          if (domainData.titleColor !== undefined) domain.titleColor = String(domainData.titleColor)
          if (domainData.titleFontSize !== undefined) {
            domain.titleFontSize = toFiniteNumber(domainData.titleFontSize, 14)
          }
          if (domainData.titleScale !== undefined) {
            domain.titleScale = toFiniteNumber(domainData.titleScale, 1)
          }
          domainsOut.push(domain)
        }
      }

      // Single transaction so the whole graph lands atomically for collaborators.
      await upsertEntities(canvasId, {
        nodes: nodesOut,
        connections: connectionsOut,
        groups: groupsOut,
        domains: domainsOut,
      })

      return ok({
        nodesCreated: nodesOut.length,
        connectionsCreated: connectionsOut.length,
        groupsCreated: groupsOut.length,
        domainsCreated: domainsOut.length,
        nodeIds: nodesOut.map((n) => n.id),
        // L2-fix: 端点引用无法解析而被跳过的连线数——0 缺省，>0 时调用方
        // 应检查 from/to 拼写（id 或 title 均可，但必须能在本图内解析）。
        connectionsSkipped: skippedConnections,
      })
    },
  )

  // ------------------------------------------------------------ undo / redo

  server.registerTool(
    'undo',
    {
      title: '撤销',
      description:
        '撤销上一步由 MCP 执行且尚未提交的画布写操作。只撤销 agent 自己的操作，不会回退其他协作者同时进行的编辑。无可撤销操作时返回错误。',
      inputSchema: { canvasId: canvasIdSchema },
    },
    async ({ canvasId }) => {
      const access = await resolveCanvasAccess(canvasId, ctx.userId)
      if (access.status === 'denied') return fail(accessErrorMessage(canvasId, access.reason))
      // Load the doc rather than requiring it to be in memory, so a canvas with no
      // MCP history reports "nothing to undo" instead of "not loaded".
      const { loadCanvasStateFromDb } = await import('../websocket/canvas-state.js')
      const state = await loadCanvasStateFromDb(canvasId)
      const manager = getUndoManager(state.doc)
      if (!manager.canUndo()) return fail('没有可撤销的操作')
      manager.undo()
      return ok({ undone: true })
    },
  )

  server.registerTool(
    'redo',
    {
      title: '重做',
      description: '重做被 undo 撤销的画布操作。无可重做操作时返回错误。',
      inputSchema: { canvasId: canvasIdSchema },
    },
    async ({ canvasId }) => {
      const access = await resolveCanvasAccess(canvasId, ctx.userId)
      if (access.status === 'denied') return fail(accessErrorMessage(canvasId, access.reason))
      const { loadCanvasStateFromDb } = await import('../websocket/canvas-state.js')
      const state = await loadCanvasStateFromDb(canvasId)
      const manager = getUndoManager(state.doc)
      if (!manager.canRedo()) return fail('没有可重做的操作')
      manager.redo()
      return ok({ redone: true })
    },
  )
}
