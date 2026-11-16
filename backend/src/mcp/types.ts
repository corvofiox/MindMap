/**
 * Shared types for MCP tool modules.
 *
 * `ToolContext` is the identity a tool acts as. It is per-request (a fresh
 * `McpServer` is built for each call), which is what keeps one caller's tools from
 * running with another caller's credentials.
 *
 * `tokenId` is optional because the stdio proxy and tests construct contexts
 * directly; when it is present it is written to the audit log so a specific token
 * can be blamed for a specific write.
 */
export interface ToolContext {
  /** Owning account. Every query is scoped to this id. */
  userId: number
  /** Personal access token row id, for auditing. */
  tokenId?: number
  /** Token label ("e2e agent"), for human-readable audit lines. */
  tokenName?: string
}
