/**
 * Notebook (手稿) tools.
 *
 * Design notes that are not obvious from the schemas:
 *
 * - Content is accepted as `text` (converted to the editor's HTML subset) or as
 *   `html` (passthrough, size-capped, obviously-hostile markup rejected). Models
 *   produce prose, not `<p>` tags, so requiring HTML would guarantee malformed
 *   documents.
 * - `notebookUpdate` takes an optional `expectedUpdatedAt`. The notebook page keeps
 *   unsaved edits in memory and flushes them on a debounce, so an agent writing
 *   "blind" gets silently overwritten (or silently overwrites). The optimistic lock
 *   turns that into an `E_CONFLICT` the agent can resolve by re-reading.
 * - Deleting a folder is a cascade: every manuscript in the subtree is soft-deleted.
 *   The tool therefore requires `confirm: true` and reports what it destroyed.
 * - Errors carry stable codes (`E_NOT_FOUND`, `E_CONFLICT`, ...) via `toolErrorFrom`.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  createFolder,
  createManuscript,
  deleteFolder,
  deleteManuscript,
  getManuscript,
  listFolders,
  listManuscripts,
  updateFolder,
  updateManuscript,
} from '../../domain/notebook.js'
import {
  clampLimit,
  clampOffset,
  ok,
  paginate,
  toolError,
} from '../result.js'
import { runTool } from '../errors.js'
import type { ToolContext } from '../types.js'

const idSchema = z.number().int().positive()
const limitSchema = z.number().int().min(1).max(200).optional()
const offsetSchema = z.number().int().min(0).optional()

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true } as const
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false } as const

/** Turn a `null`/omitted folder filter into the domain's tri-state. */
function folderFilter(args: { folderId?: number; rootOnly?: boolean }): number | null | undefined {
  if (args.rootOnly) return null
  return args.folderId
}

export function registerNotebookTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'notebookList',
    {
      title: '列出手稿',
      description:
        '列出当前账号笔记本里的手稿（不含已删除）。支持关键词（匹配标题与正文预览）和文件夹过滤。分页：limit 默认 50、最多 200，用 nextOffset 继续翻页。返回 manuscriptId、标题、预览、图片数、所属文件夹与更新时间。',
      inputSchema: {
        q: z.string().optional().describe('关键词，匹配标题或正文预览'),
        folderId: idSchema.optional().describe('只列该文件夹下的手稿'),
        rootOnly: z.boolean().optional().describe('只列不在任何文件夹里的手稿'),
        limit: limitSchema,
        offset: offsetSchema,
      },
      annotations: { title: '列出手稿', ...READ },
    },
    async (args) =>
      runTool({ tool: 'notebookList', userId: ctx.userId }, async () => {
        const limit = clampLimit(args.limit)
        const offset = clampOffset(args.offset)
        const { items, total } = await listManuscripts(ctx.userId, {
          q: args.q,
          folderId: folderFilter(args),
          limit,
          offset,
        })
        return ok(paginate(items, total, limit, offset))
      }),
  )

  server.registerTool(
    'notebookGet',
    {
      title: '读取一篇手稿',
      description:
        '读取手稿正文。contentHtml 是编辑器能直接渲染的富文本；contentText 是同一内容的纯文本镜像（超过 20000 字符会截断，contentTextTruncated 为 true）。修改前请记录 updatedAt，用于 notebookUpdate 的乐观锁。',
      inputSchema: { manuscriptId: idSchema.describe('手稿 ID，来自 notebookList') },
      annotations: { title: '读取一篇手稿', ...READ },
    },
    async ({ manuscriptId }) =>
      runTool({ tool: 'notebookGet', userId: ctx.userId }, async () => {
        const manuscript = await getManuscript(ctx.userId, manuscriptId)
        return ok(manuscript)
      }),
  )

  server.registerTool(
    'notebookCreate',
    {
      title: '新建手稿',
      description:
        '在笔记本里新建一篇手稿。正文用 text（纯文本，自动转成编辑器格式并转义）或 html（已是富文本）二选一，不要同时给。标题可省略（默认「未命名手稿」）。返回完整手稿，含新 id 与 updatedAt。',
      inputSchema: {
        title: z.string().optional().describe('标题，最多 200 字'),
        text: z.string().optional().describe('纯文本正文，换行即段落'),
        html: z.string().optional().describe('富文本正文（仅限编辑器白名单内的标签）'),
        folderId: idSchema.optional().describe('放进哪个文件夹，省略则放在根目录'),
      },
      annotations: { title: '新建手稿', ...WRITE, idempotentHint: false },
    },
    async (args) =>
      runTool({ tool: 'notebookCreate', userId: ctx.userId }, async () => {
        if (args.text !== undefined && args.html !== undefined) {
          return toolError('E_VALIDATION', 'text 与 html 只能给一个', '纯文本用 text。')
        }
        const manuscript = await createManuscript(ctx.userId, {
          title: args.title,
          text: args.text,
          html: args.html,
          folderId: args.folderId,
        })
        return ok(manuscript)
      }),
  )

  server.registerTool(
    'notebookUpdate',
    {
      title: '修改手稿',
      description:
        '修改手稿的标题 / 正文 / 所属文件夹，只改传入的字段。强烈建议带上 expectedUpdatedAt（来自 notebookGet）：值不一致说明用户或另一个 agent 在这期间改过，本次修改会被拒绝（E_CONFLICT），此时应重新读取再合并，不要盲目重试。',
      inputSchema: {
        manuscriptId: idSchema,
        title: z.string().optional(),
        text: z.string().optional().describe('新的纯文本正文（会整段替换现有正文）'),
        html: z.string().optional().describe('新的富文本正文（整段替换）'),
        folderId: z.number().int().positive().nullable().optional().describe('移动到文件夹；传 null 移回根目录'),
        expectedUpdatedAt: z
          .number()
          .int()
          .optional()
          .describe('乐观锁：@你上次读到的 updatedAt'),
      },
      annotations: { title: '修改手稿', ...WRITE },
    },
    async (args) =>
      runTool({ tool: 'notebookUpdate', userId: ctx.userId }, async () => {
        const manuscript = await updateManuscript(ctx.userId, args.manuscriptId, {
          title: args.title,
          text: args.text,
          html: args.html,
          folderId: args.folderId,
          expectedUpdatedAt: args.expectedUpdatedAt,
        })
        return ok(manuscript)
      }),
  )

  server.registerTool(
    'notebookDelete',
    {
      title: '删除手稿',
      description:
        '把一篇手稿标记为已删除（软删除：列表与详情立刻看不到，行还在库里等保留策略清理）。删除后 notebookGet 会报不存在。此操作没有回收站入口，需要拿回内容只能重新创建。',
      inputSchema: { manuscriptId: idSchema },
      annotations: { title: '删除手稿', ...DESTRUCTIVE },
    },
    async ({ manuscriptId }) =>
      runTool({ tool: 'notebookDelete', userId: ctx.userId }, async () => {
        const result = await deleteManuscript(ctx.userId, manuscriptId)
        return ok({ ...result, note: '手稿已软删除，无法通过接口恢复。' })
      }),
  )

  // ------------------------------------------------------------- folders

  server.registerTool(
    'notebookFolderList',
    {
      title: '列出笔记本文件夹',
      description:
        '列出笔记本的文件夹树（扁平数组，用 parentId 还原层级，path 是「父/子」形式的可读路径），并给出每个文件夹里的手稿数。文件夹属于账号私有，与节点池文件夹是两套独立的树。',
      inputSchema: {},
      annotations: { title: '列出笔记本文件夹', ...READ },
    },
    async () =>
      runTool({ tool: 'notebookFolderList', userId: ctx.userId }, async () => {
        const folders = await listFolders(ctx.userId)
        return ok({ folders, count: folders.length })
      }),
  )

  server.registerTool(
    'notebookFolderCreate',
    {
      title: '新建笔记本文件夹',
      description: '新建一个笔记本文件夹，可指定父文件夹形成层级。名称最多 200 字。',
      inputSchema: {
        name: z.string().describe('文件夹名称'),
        parentId: idSchema.optional().describe('父文件夹 ID，省略则为顶级'),
      },
      annotations: { title: '新建笔记本文件夹', ...WRITE, idempotentHint: false },
    },
    async (args) =>
      runTool({ tool: 'notebookFolderCreate', userId: ctx.userId }, async () => {
        const folder = await createFolder(ctx.userId, { name: args.name, parentId: args.parentId })
        return ok(folder)
      }),
  )

  server.registerTool(
    'notebookFolderUpdate',
    {
      title: '重命名或移动笔记本文件夹',
      description:
        '修改文件夹名称、父文件夹或排序。parentId 传 null 可移回顶级；移动到自己的子孙目录会被拒绝。',
      inputSchema: {
        folderId: idSchema,
        name: z.string().optional(),
        parentId: z.number().int().positive().nullable().optional(),
        sortOrder: z.number().int().optional(),
      },
      annotations: { title: '重命名或移动笔记本文件夹', ...WRITE },
    },
    async (args) =>
      runTool({ tool: 'notebookFolderUpdate', userId: ctx.userId }, async () => {
        const result = await updateFolder(ctx.userId, args.folderId, {
          name: args.name,
          parentId: args.parentId,
          sortOrder: args.sortOrder,
        })
        return ok(result)
      }),
  )

  server.registerTool(
    'notebookFolderDelete',
    {
      title: '删除笔记本文件夹（连带手稿）',
      description:
        '删除一个文件夹及其整棵子树，子树里的手稿会被一并软删除。破坏性操作：必须传 confirm=true 才会执行，返回实际删除了多少文件夹与手稿。执行前建议先 notebookFolderList 看 manuscriptCount。',
      inputSchema: {
        folderId: idSchema,
        confirm: z.boolean().optional().describe('必须为 true，表示确认连带删除子树里的手稿'),
      },
      annotations: { title: '删除笔记本文件夹（连带手稿）', ...DESTRUCTIVE },
    },
    async (args) =>
      runTool({ tool: 'notebookFolderDelete', userId: ctx.userId }, async () => {
        if (args.confirm !== true) {
          return toolError(
            'E_VALIDATION',
            '删除文件夹会连带软删除子树里的全部手稿，需要 confirm=true 确认',
            '先用 notebookFolderList 查看 manuscriptCount，确认后再调用。',
          )
        }
        const result = await deleteFolder(ctx.userId, args.folderId)
        return ok({ ...result, note: '手稿为软删除；文件夹下的子文件夹已一并删除。' })
      }),
  )
}

/** Exported for the tool-contract test: every notebook tool must be registered. */
export const NOTEBOOK_TOOL_NAMES = [
  'notebookList',
  'notebookGet',
  'notebookCreate',
  'notebookUpdate',
  'notebookDelete',
  'notebookFolderList',
  'notebookFolderCreate',
  'notebookFolderUpdate',
  'notebookFolderDelete',
] as const
