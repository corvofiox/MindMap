/**
 * MCP server construction.
 *
 * Exposes the three content domains over the Model Context Protocol so external
 * agents can read and manage them: canvases (nodes/connections/groups/domains plus
 * canvas lifecycle), the notebook (manuscripts + folders) and the node pool (cards +
 * folders), plus the transfers between them.
 *
 * Two transports are supported from one tool registry:
 *
 *   - stdio  (server/stdio.ts)      — an agent launches the process locally.
 *   - HTTP   (server/http.ts)       — remote agents POST to /mcp with a token.
 *
 * A fresh `McpServer` is built per session rather than shared, because the tool
 * handlers close over the authenticated `userId`. Sharing one instance would let
 * one caller's tools run with another caller's identity.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerCanvasTools } from './tools.js'
import { registerNotebookTools } from './tools/notebook.js'
import { registerPoolTools } from './tools/pool.js'
import { registerCanvasLifecycleTools } from './tools/canvas-lifecycle.js'
import { registerTransferTools } from './tools/transfer.js'
import { registerMetaTools } from './tools/meta.js'
import { auditToolCalls } from './audit.js'
import type { ToolContext } from './types.js'

export const MCP_SERVER_NAME = 'mindmap'

/**
 * Server version reported to clients.
 *
 * Read at call time, not at module scope: ESM hoists `import` statements above
 * `dotenv.config()` in index.ts, so a module-level read returns 'dev' for a local
 * `npm start` even though `/health` reports the real version.
 */
export function mcpServerVersion(): string {
  return process.env.APP_VERSION?.trim() || 'dev'
}

/**
 * Guidance sent to the client during initialization.
 *
 * This is the one place to state cross-cutting behaviour that the per-tool
 * descriptions cannot: that edits are live, that ids are per-domain, that the three
 * domains are separate namespaces, and that the agent should look before it writes.
 */
const INSTRUCTIONS = `MindMap 内容管理服务（画布 / 笔记本 / 节点池）。三个域互相独立，ID 不通用。

画布（协作，实时同步）
- 先用 canvasList 或 canvasGet 拿画布 ID；节点/连线/组/域的 ID 只在单个画布内有效。
- 写入会实时推给所有打开该画布的浏览器，无需任何人手动保存。
- 读之后再改：update/delete 前先查一次，不要臆造 ID。
- 批量构图优先用 graphGenerate（一次调用、原子写入、只追加不清空）。
- undo/redo 只回退本账号通过 MCP 做过的改动，不会动别人（人和其它 agent）的编辑；撤销栈在画布被服务端回收后清空。

笔记本（账号私有，非实时）
- notebookList / notebookGet / notebookCreate / notebookUpdate / notebookDelete。
- 正文用 text（自动转编辑器格式）或 html 二选一。
- 修改前记下 updatedAt 并作为 expectedUpdatedAt 传入：用户可能正在编辑，冲突会以 E_CONFLICT 拒绝，此时重读再合并。

节点池（账号私有，非实时）
- poolList / poolGet / poolCreate / poolUpdate / poolDelete，卡片正文上限 5000 字符。
- 拖到画布是「复制」（卡片保留、使用次数 +1）；转成手稿是「搬运」（卡片消失）。

跨容器搬运（会删除源）
- transferManuscriptToCard：手稿变卡片，手稿从笔记本消失。
- transferCardToManuscript：卡片变手稿，卡片从节点池消失。
- transferNodeToCard：画布节点变卡片，节点与其连线从画布消失。
- copyCardToCanvas：卡片复制到画布，卡片保留。

错误契约
- 工具失败时 isError=true，正文以 [E_XXX] 开头：E_NOT_FOUND / E_FORBIDDEN / E_VALIDATION / E_CONFLICT / E_LIMIT / E_INTERNAL / E_UNSUPPORTED。
- 看到 E_CONFLICT 不要盲目重试，先重新读取。
- 只读成员（viewer）可以读画布但没有写权限，写操作会返回 E_FORBIDDEN。

建议尺寸：节点不小于 200x160，浅色背景，保证文字可读。`

/** Build an MCP server whose tools act as `ctx.userId`. */
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: mcpServerVersion() },
    { instructions: INSTRUCTIONS },
  )
  // Wrap the registry before any tool registers, so every tool (existing and future)
  // is audited without touching 55 call sites.
  auditToolCalls(server as unknown as { registerTool: (...args: unknown[]) => unknown }, {
    userId: ctx.userId,
    tokenId: ctx.tokenId,
  })
  registerCanvasTools(server, ctx)
  registerNotebookTools(server, ctx)
  registerPoolTools(server, ctx)
  registerCanvasLifecycleTools(server, ctx)
  registerTransferTools(server, ctx)
  registerMetaTools(server, ctx)
  return server
}

export type { ToolContext }
