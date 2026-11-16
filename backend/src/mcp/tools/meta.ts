/**
 * Session/self-description tools.
 *
 * `sessionInfo` exists because the alternative is expensive: an agent that wants to
 * know "who am I, what can I touch, how much is there" would otherwise spend a dozen
 * list calls (and the /mcp rate limit is per IP at 1000 requests / 15 min). It is also
 * the natural place to advertise the error-code contract and the transfer semantics to
 * a client that only reads one tool.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../../database/connection.js'
import {
  canvases,
  manuscripts,
  nodeCards,
  projectMembers,
  projects,
  users,
} from '../../database/schema.js'
import { mcpServerVersion } from '../server.js'
import { clampLimit, ok } from '../result.js'
import { runTool } from '../errors.js'
import type { ToolContext } from '../types.js'

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const

export function registerMetaTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'sessionInfo',
    {
      title: '当前会话信息',
      description:
        '返回当前令牌对应的账号（id/邮箱/昵称）、可写画布数、笔记本手稿数、节点池卡片数、服务端版本。适合在开始工作前用它摸清环境，避免用一堆 list 工具试探。',
      inputSchema: {
        projectListLimit: z.number().int().min(1).max(50).optional().describe('返回多少个项目的概要，默认 20'),
      },
      annotations: { title: '当前会话信息', ...READ },
    },
    async (args) =>
      runTool({ tool: 'sessionInfo', userId: ctx.userId }, async () => {
        const limit = clampLimit(args.projectListLimit, 20, 50)

        const user = await db.query.users.findFirst({ where: eq(users.id, ctx.userId) })

        const ownedProjects = await db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(eq(projects.ownerId, ctx.userId))

        const memberRows = await db
          .select({ projectId: projectMembers.projectId, role: projectMembers.role })
          .from(projectMembers)
          .where(eq(projectMembers.userId, ctx.userId))

        const accessibleProjectIds = Array.from(
          new Set([...ownedProjects.map((p) => Number(p.id)), ...memberRows.map((m) => Number(m.projectId))]),
        )

        const roleByProject = new Map<number, string>()
        for (const p of ownedProjects) roleByProject.set(Number(p.id), 'owner')
        for (const m of memberRows) {
          if (!roleByProject.has(Number(m.projectId))) {
            roleByProject.set(Number(m.projectId), m.role === 'editor' ? 'editor' : 'viewer')
          }
        }

        const [manuscriptCount, cardCount] = await Promise.all([
          db
            .select({ n: sql<number>`cast(count(*) as integer)` })
            .from(manuscripts)
            .where(and(eq(manuscripts.userId, ctx.userId), isNull(manuscripts.deletedAt))),
          db
            .select({ n: sql<number>`cast(count(*) as integer)` })
            .from(nodeCards)
            .where(eq(nodeCards.userId, ctx.userId)),
        ])

        const canvasRows =
          accessibleProjectIds.length === 0
            ? []
            : await db
                .select({ id: canvases.id, name: canvases.name, projectId: canvases.projectId })
                .from(canvases)
                .where(inArray(canvases.projectId, accessibleProjectIds))

        const allProjects = new Map<number, string>()
        for (const p of ownedProjects) allProjects.set(Number(p.id), p.name as string)
        if (accessibleProjectIds.length > 0) {
          const rows = await db
            .select({ id: projects.id, name: projects.name })
            .from(projects)
            .where(inArray(projects.id, accessibleProjectIds))
          for (const row of rows) allProjects.set(Number(row.id), row.name as string)
        }

        return ok({
          server: { name: 'mindmap', version: mcpServerVersion() },
          account: {
            userId: ctx.userId,
            email: (user?.email as string | undefined) ?? null,
            nickname: (user?.nickname as string | null | undefined) ?? null,
            tokenName: ctx.tokenName ?? null,
          },
          counts: {
            projects: accessibleProjectIds.length,
            canvases: canvasRows.length,
            manuscripts: Number(manuscriptCount[0]?.n ?? 0),
            poolCards: Number(cardCount[0]?.n ?? 0),
          },
          projects: accessibleProjectIds.slice(0, limit).map((id) => ({
            projectId: id,
            name: allProjects.get(id) ?? null,
            role: roleByProject.get(id) ?? 'viewer',
            canEdit: roleByProject.get(id) !== 'viewer',
            canvasCount: canvasRows.filter((c) => Number(c.projectId) === id).length,
          })),
          errorContract: {
            codes: ['E_VALIDATION', 'E_NOT_FOUND', 'E_FORBIDDEN', 'E_CONFLICT', 'E_LIMIT', 'E_INTERNAL'],
            note: '工具失败时 isError=true 且正文以 [E_XXX] 开头。收到 E_CONFLICT 时应重新读取后再改。',
          },
          transferSemantics: {
            'transferManuscriptToCard': 'MOVE：手稿从笔记本消失',
            'transferCardToManuscript': 'MOVE：卡片从节点池消失',
            'transferNodeToCard': 'MOVE：节点及连线从画布消失',
            'moveCardToCanvas': 'MOVE：卡片从节点池消失',
          },
        })
      }),
  )
}

/** Exported for the tool-contract test. */
export const META_TOOL_NAMES = ['sessionInfo'] as const
