/**
 * Domain-level errors.
 *
 * The point of a domain error is that it carries *what went wrong* in a form both
 * transports can translate: a REST controller turns it into a status code, an MCP
 * tool turns it into `isError` + a stable code. Business code never imports
 * Express and never returns HTTP.
 */

/**
 * Stable error codes — public API for agents.
 *
 *   E_VALIDATION  arguments understood but wrong (bad range, empty patch)
 *   E_NOT_FOUND   the target does not exist (or is invisible to this token)
 *   E_FORBIDDEN   the target exists but this account may not do that
 *   E_CONFLICT    lost a race, or violated a uniqueness/lock rule
 *   E_LIMIT       quota or size limit hit; retrying unchanged will not help
 *   E_UNSUPPORTED the operation is not offered here
 *   E_INTERNAL    unexpected server failure
 */
export type ErrorCode =
  | 'E_VALIDATION'
  | 'E_NOT_FOUND'
  | 'E_FORBIDDEN'
  | 'E_CONFLICT'
  | 'E_LIMIT'
  | 'E_UNSUPPORTED'
  | 'E_INTERNAL'

export class DomainError extends Error {
  readonly code: ErrorCode
  /** One line telling the caller what to do next, surfaced to the agent. */
  readonly hint?: string
  /** Extra machine-readable facts (e.g. which limit was hit). */
  readonly details?: Record<string, unknown>

  constructor(
    code: ErrorCode,
    message: string,
    options: { hint?: string; details?: Record<string, unknown> } = {},
  ) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    this.hint = options.hint
    this.details = options.details
  }
}

/** Convenience constructors — keeps call sites short and the wording consistent. */
export const domainErrors = {
  notFound: (what: string, hint?: string) =>
    new DomainError('E_NOT_FOUND', `${what}不存在`, { hint }),
  forbidden: (message: string, hint?: string) =>
    new DomainError('E_FORBIDDEN', message, { hint }),
  validation: (message: string, hint?: string) =>
    new DomainError('E_VALIDATION', message, { hint }),
  conflict: (message: string, hint?: string) =>
    new DomainError('E_CONFLICT', message, { hint }),
  limit: (message: string, details?: Record<string, unknown>) =>
    new DomainError('E_LIMIT', message, { details }),
}

/** True when the value is a `DomainError` (survives bundling, unlike instanceof). */
export function isDomainError(error: unknown): error is DomainError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'DomainError' &&
    typeof (error as { code?: string }).code === 'string'
  )
}
