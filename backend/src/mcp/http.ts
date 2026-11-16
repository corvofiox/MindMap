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
 *
 * Error contract: everything this file produces is a JSON-RPC error object, never the
 * `{success:false}` REST envelope. A client that receives a non-JSON-RPC body reports
 * "cannot parse response" and loses the ability to retry with backoff.
 */
import { Router, type Request, type Response } from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { authenticateMcp, type McpAuthRequest } from '../middleware/mcpAuth.middleware.js'
import { createMcpLimiter } from '../middleware/rateLimit.middleware.js'
import { createMcpServer } from '../mcp/server.js'
import { pickAuditIds, recordMcpCall } from '../mcp/audit.js'
import { logError } from '../utils/logger.js'

export const mcpRouter = Router()

const mcpLimiter = createMcpLimiter()

/** JSON-RPC error body, with the HTTP status the transport layer should carry. */
function jsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): void {
  res.status(status).json({
    jsonrpc: '2.0',
    id: null,
    error: { code, message, ...(data ? { data } : {}) },
  })
}

/** Pull the auditable facts out of a JSON-RPC body without trusting its shape. */
function describeRequest(body: unknown): { method: string; tool?: string; ids: Record<string, string | number> } {
  if (Array.isArray(body)) return { method: 'batch', ids: {} }
  if (!body || typeof body !== 'object') return { method: 'unknown', ids: {} }
  const message = body as { method?: unknown; params?: { name?: unknown; arguments?: unknown } }
  const method = typeof message.method === 'string' ? message.method : 'unknown'
  const tool = typeof message.params?.name === 'string' ? message.params.name : undefined
  return { method, tool, ids: pickAuditIds(message.params?.arguments) }
}

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
    jsonRpcError(res, 401, -32001, '未认证的 MCP 请求')
    return
  }

  const startedAt = Date.now()
  const described = describeRequest(req.body)

  // Tool calls are audited by the registry wrapper in `mcp/audit.ts` (it is the only
  // place that sees a tool's `isError`); here we record the transport-level messages —
  // initialize, tools/list, malformed bodies — so the trail covers every request.
  if (described.method !== 'tools/call') {
    res.on('close', () => {
      recordMcpCall({
        userId: user.id,
        tokenId: req.mcpTokenId,
        method: described.method,
        tool: described.tool,
        ids: described.ids,
        durationMs: Date.now() - startedAt,
        ok: res.statusCode < 400,
        status: res.statusCode,
      })
    })
  }

  const server = createMcpServer({
    userId: user.id,
    tokenId: req.mcpTokenId,
    tokenName: req.mcpTokenName,
  })
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
      tool: described.tool,
      error: error instanceof Error ? error.message : String(error),
    })
    if (!res.headersSent) {
      jsonRpcError(res, 500, -32603, 'MCP 内部错误', { code: 'E_INTERNAL' })
    }
  }
}

// POST carries every JSON-RPC call (initialize, tools/list, tools/call).
// Authentication runs first, then the per-token limiter — the limiter needs the
// identity to key on, and a bad token must not consume a good agent's quota.
mcpRouter.post('/', authenticateMcp, mcpLimiter, (req, res) => {
  void handleMcpRequest(req as McpAuthRequest, res)
})

// Stateless mode has no server-initiated stream and no session to delete; answer
// with the protocol's prescribed codes rather than a bare 404 so a client can
// tell "unsupported here" from "wrong URL". `Allow` is required on 405 by RFC 9110.
mcpRouter.get('/', authenticateMcp, (_req, res) => {
  res.set('Allow', 'POST')
  jsonRpcError(res, 405, -32000, '本服务为无状态模式，不支持服务端推送流（GET）', {
    hint: '请用 POST 发送 JSON-RPC 请求。',
  })
})

mcpRouter.delete('/', authenticateMcp, (_req, res) => {
  res.set('Allow', 'POST')
  jsonRpcError(res, 405, -32000, '本服务为无状态模式，无需终止会话（DELETE）', {
    hint: '请用 POST 发送 JSON-RPC 请求。',
  })
})

/**
 * Error handler that belongs to `/mcp` only.
 *
 * Mounted immediately after the router so it catches what happens *before* the
 * transport: malformed JSON (body-parser 400) and oversized bodies (413). Without it
 * those responses fall through to the global handler and turn into
 * `{success:false, error:"Unexpected token ..."}`, which an MCP client cannot read.
 */
export function mcpErrorHandler(
  err: Error & { status?: number; statusCode?: number; type?: string },
  _req: Request,
  res: Response,
  next: (error?: unknown) => void,
): void {
  if (res.headersSent) {
    next(err)
    return
  }
  const status = err.status ?? err.statusCode ?? 500
  if (status === 413 || err.type === 'entity.too.large') {
    jsonRpcError(res, 413, -32000, '请求体过大（上限 10 MB）', {
      code: 'E_LIMIT',
      hint: '大图请先上传到 /api/files，正文里只放 URL；批量构图请拆成多次调用。',
    })
    return
  }
  if (status === 400) {
    jsonRpcError(res, 400, -32700, '请求体不是合法的 JSON', { hint: '必须是一个 JSON-RPC 2.0 对象。' })
    return
  }
  next(err)
}
