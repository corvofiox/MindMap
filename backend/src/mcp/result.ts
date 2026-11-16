/**
 * Tool result plumbing shared by every MCP tool module.
 *
 * Two shapes, deliberately:
 *
 *   - `ok(data)` — JSON text payload. The text mirror is what an LLM reads;
 *     there is no `structuredContent` yet because the SDK's typed-output path
 *     requires an `outputSchema` per tool and the payloads here are heterogeneous
 *     (a canvas snapshot, a card, a page of manuscripts).
 *   - `fail(message)` / `toolError(code, message, hint)` — an `isError` result.
 *
 * `toolError` prefixes a stable machine-readable code. Prose alone ("节点不存在")
 * forces an agent to regex Chinese to decide whether to retry, fix the id or ask a
 * human; the code makes that a switch statement. The old `fail()` is kept for the
 * canvas tools whose wording is already pinned by tests — new tools must use
 * `toolError`.
 */

import type { ErrorCode } from '../domain/errors.js'

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

/**
 * Stable error codes. Treat these as public API: an agent may branch on them.
 *
 * Defined in `domain/errors.ts` so the domain layer does not have to import the MCP
 * layer; re-exported here because tools read more naturally with a local name.
 */
export type ToolErrorCode = ErrorCode

/** JSON text payload — the success shape every tool uses. */
export function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

/**
 * Error without a code. Prefer `toolError`; this exists for the canvas tools
 * whose message wording is asserted verbatim by existing tests.
 */
export function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/**
 * Error carrying a stable code plus an optional actionable hint.
 *
 * Rendered as `[E_CODE] message` + a `hint:` line, so both a model and a human
 * reading the transcript know what to do next.
 */
export function toolError(
  code: ToolErrorCode,
  message: string,
  hint?: string,
): ToolResult {
  const text = hint ? `[${code}] ${message}\n提示：${hint}` : `[${code}] ${message}`
  return { content: [{ type: 'text', text }], isError: true }
}

/** Standard hint for "the id you passed does not exist". */
export function notFoundHint(lister: string): string {
  return `先用 ${lister} 获取有效 ID，再重试。`
}

/** Clamp a caller-supplied page size into a safe range. */
export function clampLimit(value: number | undefined, fallback = 50, max = 200): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  const n = Math.trunc(value)
  if (n < 1) return 1
  return Math.min(n, max)
}

/** Clamp a caller-supplied offset. */
export function clampOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  const n = Math.trunc(value)
  return n < 0 ? 0 : n
}

/**
 * Page envelope shared by every list tool.
 *
 * `hasMore` is computed from an over-fetched row (limit + 1) so callers never
 * have to issue a count query, and `nextOffset` is null when exhausted — an agent
 * can loop on it without guessing.
 */
export interface PageEnvelope<T> {
  items: T[]
  count: number
  total: number
  limit: number
  offset: number
  hasMore: boolean
  nextOffset: number | null
}

export function paginate<T>(
  rows: T[],
  total: number,
  limit: number,
  offset: number,
): PageEnvelope<T> {
  const hasMore = offset + rows.length < total
  return {
    items: rows,
    count: rows.length,
    total,
    limit,
    offset,
    hasMore,
    nextOffset: hasMore ? offset + rows.length : null,
  }
}
