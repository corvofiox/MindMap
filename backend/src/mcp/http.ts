/**
 * MCP over Streamable HTTP.
 *
 * Mounted at `/mcp`, authenticated by a personal access token. Runs in stateless
 * mode: a fresh `McpServer` + transport pair is created per request and torn down
 * with the response.
 *
 * Why stateless rather than session-based:
 *   - Every tool is a self-contained request/response; there is no per-session
 *     state to preserve, so a session id would only add a failure mode (a client
 *     that loses its id after a restart gets 404s).
 *   - No in-memory session table means no leak on abandoned connections and no
 *     affinity requirement if the service is ever scaled or restarted.
 *   - It sidesteps the SDK's cross-request session-transport lookup, which would
 *     otherwise need its own store keyed by session id.
 *
 * The tradeoff is that server-initiated SSE streams (notifications pushed between
 * requests) are unavailable. Tool-only servers do not need them; if push
 * notifications are ever required, this must move to a sessionful transport.
 */
import { Router, type Response } from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { authenticateMcp, type McpAuthRequest } from '../middleware/mcpAuth.middleware.js'
import { createMcpServer } from '../mcp/server.js'
import { logError } from '../utils/logger.js'

export const mcpRouter = Router()

/**
 * Handle one MCP request.
 *
 * The body is already parsed by the global `express.json()` middleware, so it is
 * forwarded explicitly — the transport would otherwise try to read an already
 * consumed stream.
 */
async function handleMcpRequest(req: McpAuthRequest, res: Response): Promise<void> {
  const user = req.mcpUser
  if (!user) {
    // Unreachable behind authenticateMcp, but a missing identity must never
    // silently fall through to an anonymous tool context.
    res.status(401).json({ success: false, error: '未认证的 MCP 请求' })
    return
  }

  const server = createMcpServer({ userId: user.id })
  const transport = new StreamableHTTPServerTransport({
    // Stateless: no session id is issued or validated.
    sessionIdGenerator: undefined,
    // Reply with a single JSON body instead of an SSE stream — appropriate for
    // request/response tools and far simpler for clients to consume.
    enableJsonResponse: true,
  })

  // Tear both down when the response finishes, so nothing accumulates per call.
  res.on('close', () => {
    transport.close().catch(() => {
      /* transport already closing */
    })
    server.close().catch(() => {
      /* server already closing */
    })
  })

  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (error) {
    logError('MCP request failed', {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
    })
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'MCP 内部错误' },
        id: null,
      })
    }
  }
}

// POST carries every JSON-RPC call (initialize, tools/list, tools/call).
mcpRouter.post('/', authenticateMcp, (req, res) => {
  void handleMcpRequest(req as McpAuthRequest, res)
})

// Stateless mode has no server-initiated stream and no session to delete; answer
// with the protocol's prescribed codes rather than a bare 404 so a client can
// tell "unsupported here" from "wrong URL".
mcpRouter.get('/', authenticateMcp, (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: '本服务为无状态模式，不支持服务端推送流（GET）' },
    id: null,
  })
})

mcpRouter.delete('/', authenticateMcp, (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: '本服务为无状态模式，无需终止会话（DELETE）' },
    id: null,
  })
})
