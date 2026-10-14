/**
 * MCP server construction.
 *
 * Exposes the canvas tools over the Model Context Protocol so external agents can
 * read and manage canvases. Two transports are supported from one tool registry:
 *
 *   - stdio  (server/stdio.ts)      — an agent launches the process locally.
 *   - HTTP   (server/http.ts)       — remote agents POST to /mcp with a token.
 *
 * A fresh `McpServer` is built per session rather than shared, because the tool
 * handlers close over the authenticated `userId`. Sharing one instance would let
 * one caller's tools run with another caller's identity.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerCanvasTools, type ToolContext } from './tools.js'

export const MCP_SERVER_NAME = 'mindmap'

/**
 * Server version reported to clients. Kept in sync with the image version when
 * built, so an agent can tell which build it is talking to.
 */
export const MCP_SERVER_VERSION = process.env.APP_VERSION?.trim() || 'dev'

/**
 * Guidance sent to the client during initialization.
 *
 * This is the one place to state cross-cutting behaviour that the per-tool
 * descriptions cannot: that edits are live, that ids are per-canvas, and that the
 * agent should look before it writes.
 */
const INSTRUCTIONS = `MindMap 画布管理服务。用于读取和修改思维导图/关系图画布。

工作方式：
- 先调用 listCanvases 获取画布 ID；除 listCanvases 外，其余工具都需要 canvasId。
- 修改会实时同步给正在打开该画布的所有浏览器，无需用户手动保存。
- 节点、连接、组、域的 ID 是每个画布内独立的，务必先读取（getCanvasData / getAllNodes）再修改，不要臆造 ID。
- 建议节点尺寸不小于 200x160，背景使用浅色，以保证文字可读。
- 批量构建图形优先使用 generateGraphFromJSON（一次调用、原子写入），它只追加实体，不会清空已有内容。
- undo/redo 只作用于本会话通过 MCP 执行的操作，不会回退其他协作者的人工编辑。`

/** Build an MCP server whose tools act as `ctx.userId`. */
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  )
  registerCanvasTools(server, ctx)
  return server
}

export type { ToolContext }
