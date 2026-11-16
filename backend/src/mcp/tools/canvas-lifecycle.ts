/**
 * Canvas lifecycle tools: the containers around the content.
 *
 * Canvas *entities* (nodes/connections/groups/domains) are in `mcp/tools.ts` and go
 * through the live Yjs doc; these tools only touch rows. Splitting them keeps the
 * "edits reach open browsers instantly" contract limited to the entity tools.
 *
 * Every tool here requires owner/editor on the owning project, and deletion is
 * permanent (there is no recycle bin in use), so deletes demand `confirm: true` and
 * report what was destroyed.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  createCanvas,
  createCanvasFolder,
  deleteCanvas,
  deleteCanvasFolder,
  listCanvasFolders,
  moveCanvas,
  renameCanvas,
  updateCanvasFolder,
} from '../../domain/canvas.js'
import { ok, toolError } from '../result.js'
import { runTool } from '../errors.js'
import type { ToolContext } from '../types.js'

const idSchema = z.number().int().positive()
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true } as const
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false } as const

export function registerCanvasLifecycleTools(server: McpServer, ctx: ToolContext): void {
  // NOTE: the discovery tool stays `listCanvases` (defined with the entity tools in
  // mcp/tools.ts). Adding a second `canvasList` with identical semantics would give
  // a model two names for one action, which is worse than a mixed naming scheme.
  server.registerTool(
    'canvasCreate',
    {
      title: '新建画布',
      description:
        '在项目里新建一张空白画布。需要该项目 owner 或 editor 权限。可指定所属文件夹（文件夹必须属于同一个项目）。',
      inputSchema: {
        projectId: idSchema.describe('项目 ID'),
        name: z.string().describe('画布名称，最多 200 字'),
        folderId: idSchema.optional().describe('放进哪个文件夹'),
      },
      annotations: { title: '新建画布', ...CREATE },
    },
    async (args) =>
      runTool({ tool: 'canvasCreate', userId: ctx.userId }, async () => {
        const canvas = await createCanvas(ctx.userId, {
          projectId: args.projectId,
          name: args.name,
          folderId: args.folderId ?? null,
        })
        return ok(canvas)
      }),
  )

  server.registerTool(
    'canvasRename',
    {
      title: '重命名画布',
      description: '修改画布名称。需要 owner/editor 权限。',
      inputSchema: { canvasId: idSchema, name: z.string().describe('新名称，最多 200 字') },
      annotations: { title: '重命名画布', ...WRITE },
    },
    async (args) =>
      runTool({ tool: 'canvasRename', userId: ctx.userId }, async () => {
        return ok(await renameCanvas(ctx.userId, args.canvasId, args.name))
      }),
  )

  server.registerTool(
    'canvasMove',
    {
      title: '移动画布',
      description: '把画布移到同一个项目的另一个文件夹（folderId 传 null 移到项目根），可同时调整排序。',
      inputSchema: {
        canvasId: idSchema,
        folderId: z.number().int().positive().nullable().describe('目标文件夹；null = 项目根'),
        sortOrder: z.number().int().optional(),
      },
      annotations: { title: '移动画布', ...WRITE },
    },
    async (args) =>
      runTool({ tool: 'canvasMove', userId: ctx.userId }, async () => {
        return ok(
          await moveCanvas(ctx.userId, args.canvasId, {
            folderId: args.folderId,
            sortOrder: args.sortOrder,
          }),
        )
      }),
  )

  server.registerTool(
    'canvasDelete',
    {
      title: '删除画布（不可恢复）',
      description:
        '永久删除一张画布及其全部内容，会立刻断开所有正在协作的客户端。没有回收站，无法恢复。必须传 confirm=true；调用前建议先 canvasGet 确认拿到的就是目标画布。',
      inputSchema: {
        canvasId: idSchema,
        confirm: z.boolean().optional().describe('必须为 true，表示确认永久删除'),
      },
      annotations: { title: '删除画布（不可恢复）', ...DESTRUCTIVE },
    },
    async (args) =>
      runTool({ tool: 'canvasDelete', userId: ctx.userId }, async () => {
        if (args.confirm !== true) {
          return toolError(
            'E_VALIDATION',
            '删除画布不可恢复，需要 confirm=true 确认',
            '先 canvasGet 核对画布名称，确认无误后再带 confirm=true 调用。',
          )
        }
        return ok({ ...(await deleteCanvas(ctx.userId, args.canvasId)), note: '画布已永久删除。' })
      }),
  )

  // ------------------------------------------------------------- folders

  server.registerTool(
    'canvasFolderList',
    {
      title: '列出画布文件夹',
      description:
        '列出某个项目下的画布文件夹（扁平数组 + parentId + path），并给出每个文件夹里的画布数。画布文件夹是项目级的，与笔记本、节点池的文件夹是不同命名空间。',
      inputSchema: { projectId: idSchema },
      annotations: { title: '列出画布文件夹', ...READ },
    },
    async (args) =>
      runTool({ tool: 'canvasFolderList', userId: ctx.userId }, async () => {
        const items = await listCanvasFolders(ctx.userId, args.projectId)
        return ok({ folders: items, count: items.length })
      }),
  )

  server.registerTool(
    'canvasFolderCreate',
    {
      title: '新建画布文件夹',
      description: '在项目下新建画布文件夹，可指定父文件夹。需要 owner/editor 权限。',
      inputSchema: {
        projectId: idSchema,
        name: z.string().describe('文件夹名称'),
        parentId: idSchema.optional(),
      },
      annotations: { title: '新建画布文件夹', ...CREATE },
    },
    async (args) =>
      runTool({ tool: 'canvasFolderCreate', userId: ctx.userId }, async () => {
        return ok(
          await createCanvasFolder(ctx.userId, {
            projectId: args.projectId,
            name: args.name,
            parentId: args.parentId ?? null,
          }),
        )
      }),
  )

  server.registerTool(
    'canvasFolderUpdate',
    {
      title: '重命名或移动画布文件夹',
      description: '修改画布文件夹的名称、父文件夹或排序。',
      inputSchema: {
        folderId: idSchema,
        name: z.string().optional(),
        parentId: z.number().int().positive().nullable().optional(),
        sortOrder: z.number().int().optional(),
      },
      annotations: { title: '重命名或移动画布文件夹', ...WRITE },
    },
    async (args) =>
      runTool({ tool: 'canvasFolderUpdate', userId: ctx.userId }, async () => {
        return ok(
          await updateCanvasFolder(ctx.userId, args.folderId, {
            name: args.name,
            parentId: args.parentId,
            sortOrder: args.sortOrder,
          }),
        )
      }),
  )

  server.registerTool(
    'canvasFolderDelete',
    {
      title: '删除画布文件夹（连带画布）',
      description:
        '删除画布文件夹及其整棵子树，子树里的画布会被永久删除（无法恢复，正在协作的客户端会被断开）。必须传 confirm=true，返回实际删除了多少文件夹与画布。',
      inputSchema: {
        folderId: idSchema,
        confirm: z.boolean().optional().describe('必须为 true，表示确认连带删除画布'),
      },
      annotations: { title: '删除画布文件夹（连带画布）', ...DESTRUCTIVE },
    },
    async (args) =>
      runTool({ tool: 'canvasFolderDelete', userId: ctx.userId }, async () => {
        if (args.confirm !== true) {
          return toolError(
            'E_VALIDATION',
            '删除画布文件夹会永久删除子树里的全部画布，需要 confirm=true 确认',
            '先 canvasFolderList 查看 canvasCount，确认后再调用。',
          )
        }
        return ok(await deleteCanvasFolder(ctx.userId, args.folderId))
      }),
  )
}

/** Exported for the tool-contract test. */
export const CANVAS_LIFECYCLE_TOOL_NAMES = [
  'canvasCreate',
  'canvasRename',
  'canvasMove',
  'canvasDelete',
  'canvasFolderList',
  'canvasFolderCreate',
  'canvasFolderUpdate',
  'canvasFolderDelete',
] as const
