/**
 * Translating domain errors into MCP tool results.
 *
 * One place, so every tool answers the same way: a `DomainError` keeps its code and
 * hint; anything else is an internal failure and must not leak a stack trace or a
 * SQLite message to the caller (it goes to the server log instead).
 */
import { isDomainError } from '../domain/errors.js'
import { toolError, type ToolResult } from './result.js'
import { logError } from '../utils/logger.js'

export function toolErrorFrom(error: unknown, context?: Record<string, unknown>): ToolResult {
  if (isDomainError(error)) {
    return toolError(error.code, error.message, error.hint)
  }
  logError('MCP tool failed', {
    ...context,
    error: error instanceof Error ? error.message : String(error),
  })
  return toolError(
    'E_INTERNAL',
    '服务端内部错误，本次操作未完成',
    '稍后重试；如果持续失败，请查看服务端日志。',
  )
}

/**
 * Wrap an async handler so a thrown error becomes a tool error rather than a
 * protocol-level failure the client cannot attribute to a tool.
 */
export async function runTool(
  context: Record<string, unknown>,
  fn: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await fn()
  } catch (error) {
    return toolErrorFrom(error, context)
  }
}
