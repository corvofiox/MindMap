/**
 * Node-pool (节点池) tools.
 *
 * A card holds a JSON snapshot of one canvas node and is capped at 5000 characters
 * (`MAX_CARD_CONTENT`); the tools accept `text` or `html` for the body and let the
 * domain layer do the encoding, so a card created here is byte-identical to one
 * created by dragging a node into the pool.
 *
 * Deleting a folder physically deletes the cards inside it (node_cards has no
 * soft-delete column), which is why that tool demands `confirm: true`.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  createCard,
  createFolder,
  deleteCard,
  deleteFolder,
  getCard,
  listCards,
  listFolders,
  updateCard,
  updateFolder,
} from '../../domain/pool.js'
import { clampLimit, clampOffset, ok, paginate, toolError } from '../result.js'
import { runTool } from '../errors.js'
import type { ToolContext } from '../types.js'

const idSchema = z.number().int().positive()
const limitSchema = z.number().int().min(1).max(200).optional()
const offsetSchema = z.number().int().min(0).optional()

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true } as const
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false } as const

export function registerPoolTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'poolList',
    {
      title: '列出节点池卡片',
      description:
        '列出当前账号节点池里的卡片。支持关键词（匹配名称/正文预览/标签）与文件夹过滤，分页同 notebookList。返回 cardId、名称、正文预览、类型、颜色、标签与所属文件夹。',
      inputSchema: {
        q: z.string().optional().describe('关键词'),
        tag: z.string().optional().describe('按标签过滤'),
        folderId: idSchema.optional().describe('只列该文件夹下的卡片'),
        rootOnly: z.boolean().optional().describe('只列不在任何文件夹里的卡片'),
        limit: limitSchema,
        offset: offsetSchema,
      },
      annotations: { title: '列出节点池卡片', ...READ },
    },
    async (args) =>
      runTool({ tool: 'poolList', userId: ctx.userId }, async () => {
        const limit = clampLimit(args.limit)
        const offset = clampOffset(args.offset)
        const folderId = args.rootOnly ? null : args.folderId
        const { items, total } = await listCards(ctx.userId, {
          q: args.q,
          tag: args.tag,
          folderId,
          limit,
          offset,
        })
        return ok(paginate(items, total, limit, offset))
      }),
  )

  server.registerTool(
    'poolGet',
    {
      title: '读取一张卡片',
      description:
        '读取卡片正文。node 是把这张卡片拖到画布时会写入的完整节点数据（含 content/cover），contentHtml 是同一份正文的 HTML。',
      inputSchema: { cardId: idSchema.describe('卡片 ID，来自 poolList') },
      annotations: { title: '读取一张卡片', ...READ },
    },
    async ({ cardId }) =>
      runTool({ tool: 'poolGet', userId: ctx.userId }, async () => {
        return ok(await getCard(ctx.userId, cardId))
      }),
  )

  server.registerTool(
    'poolCreate',
    {
      title: '新建卡片',
      description:
        '在节点池里新建一张卡片。正文用 text（纯文本，自动转格式并转义）或 html 二选一，序列化后上限 5000 字符。tags 是逗号分隔的标签串。',
      inputSchema: {
        title: z.string().optional().describe('卡片标题，最多 200 字'),
        text: z.string().optional().describe('纯文本正文'),
        html: z.string().optional().describe('富文本正文'),
        tags: z.string().optional().describe('逗号分隔的标签，如 "产品,需求"'),
        color: z.string().optional().describe('卡片颜色，十六进制，默认 #ffffff'),
        description: z.string().optional().describe('备注'),
        folderId: idSchema.optional().describe('放进哪个文件夹'),
      },
      annotations: { title: '新建卡片', ...CREATE },
    },
    async (args) =>
      runTool({ tool: 'poolCreate', userId: ctx.userId }, async () => {
        if (args.text !== undefined && args.html !== undefined) {
          return toolError('E_VALIDATION', 'text 与 html 只能给一个', '纯文本用 text。')
        }
        const card = await createCard(ctx.userId, {
          title: args.title,
          text: args.text,
          html: args.html,
          tags: args.tags ?? null,
          color: args.color,
          description: args.description ?? null,
          folderId: args.folderId,
        })
        return ok(card)
      }),
  )

  server.registerTool(
    'poolUpdate',
    {
      title: '修改卡片',
      description: '修改卡片的标题 / 正文 / 标签 / 颜色 / 备注 / 所属文件夹，只改传入的字段。',
      inputSchema: {
        cardId: idSchema,
        title: z.string().optional(),
        text: z.string().optional().describe('新的纯文本正文（整段替换）'),
        html: z.string().optional().describe('新的富文本正文（整段替换）'),
        tags: z.string().nullable().optional(),
        color: z.string().optional(),
        description: z.string().nullable().optional(),
        folderId: z.number().int().positive().nullable().optional().describe('传 null 移出文件夹'),
      },
      annotations: { title: '修改卡片', ...WRITE },
    },
    async (args) =>
      runTool({ tool: 'poolUpdate', userId: ctx.userId }, async () => {
        const card = await updateCard(ctx.userId, args.cardId, {
          title: args.title,
          text: args.text,
          html: args.html,
          tags: args.tags,
          color: args.color,
          description: args.description,
          folderId: args.folderId,
        })
        return ok(card)
      }),
  )

  server.registerTool(
    'poolDelete',
    {
      title: '删除卡片',
      description:
        '从节点池里删除一张卡片。节点池没有软删除，这是物理删除，无法恢复；如需保留内容，先用 transferCardToManuscript 转成手稿。',
      inputSchema: { cardId: idSchema },
      annotations: { title: '删除卡片', ...DESTRUCTIVE },
    },
    async ({ cardId }) =>
      runTool({ tool: 'poolDelete', userId: ctx.userId }, async () => {
        const result = await deleteCard(ctx.userId, cardId)
        return ok({ ...result, note: '物理删除，无法恢复。' })
      }),
  )

  server.registerTool(
    'poolFolderList',
    {
      title: '列出节点池文件夹',
      description:
        '列出节点池的文件夹树（扁平数组 + parentId + path），并给出每个文件夹里的卡片数。与笔记本文件夹是两套独立的树，ID 不通用。',
      inputSchema: {},
      annotations: { title: '列出节点池文件夹', ...READ },
    },
    async () =>
      runTool({ tool: 'poolFolderList', userId: ctx.userId }, async () => {
        const folders = await listFolders(ctx.userId)
        return ok({ folders, count: folders.length })
      }),
  )

  server.registerTool(
    'poolFolderCreate',
    {
      title: '新建节点池文件夹',
      description: '新建一个节点池文件夹，可指定父文件夹。',
      inputSchema: {
        name: z.string().describe('文件夹名称'),
        parentId: idSchema.optional(),
      },
      annotations: { title: '新建节点池文件夹', ...CREATE },
    },
    async (args) =>
      runTool({ tool: 'poolFolderCreate', userId: ctx.userId }, async () => {
        return ok(await createFolder(ctx.userId, { name: args.name, parentId: args.parentId }))
      }),
  )

  server.registerTool(
    'poolFolderUpdate',
    {
      title: '重命名或移动节点池文件夹',
      description: '修改节点池文件夹的名称、父文件夹、排序或折叠状态。',
      inputSchema: {
        folderId: idSchema,
        name: z.string().optional(),
        parentId: z.number().int().positive().nullable().optional(),
        sortOrder: z.number().int().optional(),
        collapsed: z.boolean().optional(),
      },
      annotations: { title: '重命名或移动节点池文件夹', ...WRITE },
    },
    async (args) =>
      runTool({ tool: 'poolFolderUpdate', userId: ctx.userId }, async () => {
        return ok(
          await updateFolder(ctx.userId, args.folderId, {
            name: args.name,
            parentId: args.parentId,
            sortOrder: args.sortOrder,
            collapsed: args.collapsed,
          }),
        )
      }),
  )

  server.registerTool(
    'poolFolderDelete',
    {
      title: '删除节点池文件夹（连带卡片）',
      description:
        '删除一个文件夹及其整棵子树，子树里的卡片会被物理删除（不可恢复）。必须传 confirm=true，返回实际删除了多少文件夹与卡片。',
      inputSchema: {
        folderId: idSchema,
        confirm: z.boolean().optional().describe('必须为 true，表示确认连带删除卡片'),
      },
      annotations: { title: '删除节点池文件夹（连带卡片）', ...DESTRUCTIVE },
    },
    async (args) =>
      runTool({ tool: 'poolFolderDelete', userId: ctx.userId }, async () => {
        if (args.confirm !== true) {
          return toolError(
            'E_VALIDATION',
            '删除节点池文件夹会物理删除子树里的全部卡片，需要 confirm=true 确认',
            '先用 poolFolderList 查看 cardCount，确认后再调用。',
          )
        }
        return ok(await deleteFolder(ctx.userId, args.folderId))
      }),
  )
}

/** Exported for the tool-contract test. */
export const POOL_TOOL_NAMES = [
  'poolList',
  'poolGet',
  'poolCreate',
  'poolUpdate',
  'poolDelete',
  'poolFolderList',
  'poolFolderCreate',
  'poolFolderUpdate',
  'poolFolderDelete',
] as const
