/**
 * Transfer tools — the four "move something between containers" operations.
 *
 * The semantics differ per direction and that difference is the whole reason these
 * are separate tools rather than one `convert` with a flag:
 *
 *   manuscript ⇄ card   MOVE   (the source row disappears)
 *   canvas node → card  MOVE   (node + its connections disappear)
 *   card → canvas       COPY   (the card stays; `use_count` increments)
 *
 * The two manuscript directions are shared with the REST endpoints
 * (`domain/transfer.ts`), so an agent and the UI cannot produce different results.
 * The canvas-node direction is implemented here because it has to read the live Yjs
 * doc, and it is written as "create the card first, delete the node second": if the
 * card insert fails (size cap, DB error) the node is still on the canvas. There is no
 * cross-store transaction, so the only safe failure mode is "nothing moved".
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { nextZIndexAbove, normalizeNode } from 'mindmap-shared'
import { db } from '../../database/connection.js'
import { nodeCards, nodePoolFolders } from '../../database/schema.js'
import { and, eq } from 'drizzle-orm'
import {
  moveCardToManuscript,
  moveManuscriptToCard,
  nodeToCardPayload,
} from '../../domain/transfer.js'
import { getCard, incrementUseCount } from '../../domain/pool.js'
import { getManuscript } from '../../domain/notebook.js'
import { deleteEntities, getCanvasSnapshot, upsertEntities, actorKeyOf } from '../canvas-ops.js'
import { accessErrorMessage, readOnlyErrorMessage, resolveCanvasAccess } from '../access.js'
import { ok, toolError } from '../result.js'
import { runTool } from '../errors.js'
import type { ToolContext } from '../types.js'

const idSchema = z.number().int().positive()
const MOVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false } as const
const COPY = { readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const

/** Canvas editor access, or a tool error explaining why not. */
async function requireCanvasEditor(ctx: ToolContext, canvasId: number) {
  const access = await resolveCanvasAccess(canvasId, ctx.userId)
  if (access.status === 'denied') {
    return { error: toolError('E_NOT_FOUND', accessErrorMessage(canvasId, access.reason)) }
  }
  if (!access.access.canEdit) {
    return { error: toolError('E_FORBIDDEN', readOnlyErrorMessage(canvasId), '请项目所有者把你的角色改为 editor。') }
  }
  return { access: access.access }
}

export function registerTransferTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'transferManuscriptToCard',
    {
      title: '手稿转为卡片（搬运）',
      description:
        '把一篇手稿搬进节点池：新建一张卡片，同时手稿从笔记本消失（软删除）。两步在一个事务里，不会两边都有或两边都没有。目标文件夹必须属于当前账号。要保留手稿请改用 poolCreate 重新录入，不要用本工具。',
      inputSchema: {
        manuscriptId: idSchema.describe('手稿 ID，来自 notebookList'),
        folderId: idSchema.optional().describe('放进节点池的哪个文件夹'),
      },
      annotations: { title: '手稿转为卡片（搬运）', ...MOVE },
    },
    async (args) =>
      runTool({ tool: 'transferManuscriptToCard', userId: ctx.userId }, async () => {
        const card = await moveManuscriptToCard(ctx.userId, args.manuscriptId, args.folderId ?? null)
        // Re-read through the pool service so the reply has the same shape as poolGet
        // (`cardId`, not the raw row's `id`).
        const detail = await getCard(ctx.userId, Number(card.id))
        return ok({ moved: 'manuscript-to-card', manuscriptId: args.manuscriptId, card: detail })
      }),
  )

  server.registerTool(
    'transferCardToManuscript',
    {
      title: '卡片转为手稿（搬运）',
      description:
        '把一张节点池卡片搬进笔记本：新建一篇手稿，同时卡片从节点池消失（物理删除）。两步在一个事务里。要保留卡片请改用 notebookCreate。',
      inputSchema: {
        cardId: idSchema.describe('卡片 ID，来自 poolList'),
        folderId: idSchema.optional().describe('放进笔记本的哪个文件夹'),
      },
      annotations: { title: '卡片转为手稿（搬运）', ...MOVE },
    },
    async (args) =>
      runTool({ tool: 'transferCardToManuscript', userId: ctx.userId }, async () => {
        const manuscript = await moveCardToManuscript(ctx.userId, args.cardId, args.folderId ?? null)
        const detail = await getManuscript(ctx.userId, Number(manuscript.id))
        return ok({ moved: 'card-to-manuscript', cardId: args.cardId, manuscript: detail })
      }),
  )

  server.registerTool(
    'transferNodeToCard',
    {
      title: '画布节点转为卡片（搬运）',
      description:
        '把画布上的一个节点搬进节点池：先建卡片，成功后再从画布删除该节点及其连线。卡片建不成功（例如内容超过 5000 字符）时画布不会有任何变化。需要画布的写权限。',
      inputSchema: {
        canvasId: idSchema,
        nodeId: z.string().describe('节点 ID，来自 nodeList 或 canvasGet'),
        folderId: idSchema.optional().describe('放进节点池的哪个文件夹'),
      },
      annotations: { title: '画布节点转为卡片（搬运）', ...MOVE },
    },
    async (args) =>
      runTool({ tool: 'transferNodeToCard', userId: ctx.userId }, async () => {
        const guard = await requireCanvasEditor(ctx, args.canvasId)
        if ('error' in guard) return guard.error

        const snapshot = await getCanvasSnapshot(args.canvasId)
        const node = snapshot.nodes.find((n) => n.id === args.nodeId)
        if (!node) {
          return toolError(
            'E_NOT_FOUND',
            `节点 ${args.nodeId} 不在画布 ${args.canvasId} 上`,
            '先用 nodeList 获取有效节点 ID。',
          )
        }

        if (args.folderId !== undefined) {
          const folder = await db.query.nodePoolFolders.findFirst({
            where: and(eq(nodePoolFolders.id, args.folderId), eq(nodePoolFolders.userId, ctx.userId)),
          })
          if (!folder) {
            return toolError('E_NOT_FOUND', `文件夹 ${args.folderId} 不存在`, '先用 poolFolderList 获取文件夹 ID。')
          }
        }

        // Build + insert the card first (may throw E_LIMIT). Nothing has been removed
        // from the canvas at this point, so a failure here is a clean no-op.
        const payload = nodeToCardPayload(node, ctx.userId, args.folderId ?? null)
        const inserted = await db.insert(nodeCards).values(payload as never).returning()
        const card = inserted[0] as Record<string, unknown>

        // Only now remove the node (and the connections attached to it, matching the
        // frontend's removeNode cascade).
        const attached = snapshot.connections
          .filter((c) => c.fromNodeId === args.nodeId || c.toNodeId === args.nodeId)
          .map((c) => String(c.id))
        const removal = await deleteEntities(
          args.canvasId,
          { nodeIds: [args.nodeId], connectionIds: attached },
          actorKeyOf(ctx.userId),
        )

        return ok({
          moved: 'node-to-card',
          cardId: Number(card.id),
          removedNodeIds: removal.deleted.nodes,
          removedConnectionIds: removal.deleted.connections,
          note: '卡片已建好并从画布移除了该节点。',
        })
      }),
  )

  server.registerTool(
    'copyCardToCanvas',
    {
      title: '卡片复制到画布',
      description:
        '把卡片复制成一个画布节点（COPY：卡片保留，使用次数 +1）。不指定 x/y 时放在 (0,0)；建议先 canvasGet 规划位置，避免与已有节点重叠。需要画布写权限。',
      inputSchema: {
        canvasId: idSchema,
        cardId: idSchema,
        x: z.number().optional().describe('新节点左上角 X，默认 0'),
        y: z.number().optional().describe('新节点左上角 Y，默认 0'),
      },
      annotations: { title: '卡片复制到画布', ...COPY },
    },
    async (args) =>
      runTool({ tool: 'copyCardToCanvas', userId: ctx.userId }, async () => {
        const guard = await requireCanvasEditor(ctx, args.canvasId)
        if ('error' in guard) return guard.error

        const card = await getCard(ctx.userId, args.cardId)
        const snapshot = await getCanvasSnapshot(args.canvasId)
        const nodeId = `node-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

        // Identity and geometry belong to the destination, not the card: dropping the
        // same card twice must not collide, and the caller's x/y wins.
        const unified = normalizeNode({
          ...card.node,
          id: nodeId,
          x: args.x ?? 0,
          y: args.y ?? 0,
          width: typeof card.node.width === 'number' ? card.node.width : 240,
          height: typeof card.node.height === 'number' ? card.node.height : 160,
          zIndex: nextZIndexAbove(snapshot.nodes as { zIndex?: number }[]),
        } as never) as Record<string, unknown>

        await upsertEntities(args.canvasId, { nodes: [unified] }, actorKeyOf(ctx.userId))
        const { useCount } = await incrementUseCount(ctx.userId, args.cardId)

        return ok({ copied: true, nodeId, cardId: args.cardId, useCount, note: '卡片保留在节点池。' })
      }),
  )
}

/** Exported for the tool-contract test. */
export const TRANSFER_TOOL_NAMES = [
  'transferManuscriptToCard',
  'transferCardToManuscript',
  'transferNodeToCard',
  'copyCardToCanvas',
] as const

