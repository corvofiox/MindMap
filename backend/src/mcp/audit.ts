/**
 * Audit trail for MCP calls.
 *
 * Why this exists: the tools previously wrote nothing. After a bad afternoon, the only
 * question that matters is "which agent, on which token, deleted which folder" and the
 * answer has to be on disk in the server log. Keeping the last N entries in memory is
 * for tests and a future admin view; the durable copy is the structured log line.
 *
 * What is deliberately NOT recorded: tool arguments. A node's `content` is the user's
 * writing (possibly a whole manuscript) and the logs rotate at a fixed size — copying
 * documents into them would both leak content and bloat the file. Only ids and counts.
 */
import { log } from '../utils/logger.js'

export interface McpAuditEntry {
  at: number
  userId: number
  tokenId?: number
  method: string
  tool?: string
  /** Id-ish arguments only (canvasId, nodeId, manuscriptId, ...), never content. */
  ids: Record<string, string | number>
  durationMs: number
  ok: boolean
  status?: number
}

const MAX_ENTRIES = 500
const entries: McpAuditEntry[] = []

/** Argument keys that are safe to record: identifiers, not user prose. */
const ID_KEYS = [
  'canvasId',
  'nodeId',
  'fromNodeId',
  'toNodeId',
  'groupNodeIds',
  'connectionId',
  'groupId',
  'domainId',
  'manuscriptId',
  'cardId',
  'folderId',
  'projectId',
  'parentId',
  'confirm',
  'limit',
  'offset',
]

/** Extract the recordable subset of tool arguments. */
export function pickAuditIds(args: unknown): Record<string, string | number> {
  if (!args || typeof args !== 'object') return {}
  const out: Record<string, string | number> = {}
  for (const key of ID_KEYS) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      out[key] = value as string | number
    }
  }
  return out
}

export function recordMcpCall(entry: Omit<McpAuditEntry, 'at'>): void {
  const full: McpAuditEntry = { at: Date.now(), ...entry }
  entries.push(full)
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  log('mcp.call', {
    userId: full.userId,
    tokenId: full.tokenId ?? null,
    method: full.method,
    tool: full.tool ?? null,
    ids: full.ids,
    ok: full.ok,
    status: full.status ?? null,
    durationMs: full.durationMs,
  })
}

/** Recent entries, newest last. Used by tests and (later) an admin endpoint. */
export function recentMcpCalls(limit = 50): McpAuditEntry[] {
  return entries.slice(Math.max(0, entries.length - limit))
}

/** Test helper. */
export function clearMcpAudit(): void {
  entries.length = 0
}

/**
 * Wrap every tool registration on `server` so each call is audited.
 *
 * Done by patching the instance (not the SDK) inside `createMcpServer`, before any
 * tool module runs. Two reasons it lives here rather than at the HTTP edge: a tool
 * failure is an HTTP 200 with `result.isError`, so the transport cannot tell success
 * from refusal; and the SDK's Node adapter writes the response through
 * `@hono/node-server`, so sniffing `res.end` is both fragile and incomplete.
 *
 * The wrapper preserves the handler's contract exactly — same arguments, same
 * returned `ToolResult` — and only observes.
 */
export function auditToolCalls(
  server: { registerTool: (...args: unknown[]) => unknown },
  context: { userId: number; tokenId?: number },
): void {
  const original = server.registerTool.bind(server)
  server.registerTool = ((name: string, config: unknown, handler: unknown) => {
    if (typeof handler !== 'function') {
      return (original as (...args: unknown[]) => unknown)(name, config, handler)
    }
    const wrapped = async (args: unknown, extra?: unknown) => {
      const startedAt = Date.now()
      let ok = true
      try {
        const result = await (handler as (a: unknown, e?: unknown) => Promise<unknown>)(args, extra)
        if (
          result &&
          typeof result === 'object' &&
          (result as { isError?: boolean }).isError === true
        ) {
          ok = false
        }
        return result
      } catch (error) {
        ok = false
        throw error
      } finally {
        recordMcpCall({
          userId: context.userId,
          tokenId: context.tokenId,
          method: 'tools/call',
          tool: name,
          ids: pickAuditIds(args),
          durationMs: Date.now() - startedAt,
          ok,
        })
      }
    }
    return (original as (...args: unknown[]) => unknown)(name, config, wrapped)
  }) as typeof server.registerTool
}
