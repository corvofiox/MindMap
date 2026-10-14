/**
 * Personal access token (PAT) primitives.
 *
 * Tokens authenticate external agents against the MCP server. Design notes:
 *
 * - The plaintext is returned exactly once (at creation) and never stored. Only a
 *   SHA-256 hash is persisted, so a database leak does not hand over working
 *   credentials.
 * - A fast hash is correct here, not a password KDF: the token is 256 bits of
 *   `randomBytes` entropy, so there is no low-entropy secret to slow down with
 *   bcrypt — and token verification happens on every MCP call, where a slow KDF
 *   would be a needless cost.
 * - The `mmp_` prefix makes a leaked token greppable in logs and secret scanners.
 */
import { createHash, randomBytes } from 'crypto'

export const TOKEN_PREFIX = 'mmp_'

/** Token length: 32 random bytes -> 64 hex chars, plus the prefix. */
const TOKEN_BYTES = 32

export interface GeneratedToken {
  /** Shown to the user once; never persisted. */
  plaintext: string
  /** Stored in the DB. */
  hash: string
  /** Non-secret label for the UI, e.g. "mmp_1a2b3c4d…". */
  display: string
}

export function generateToken(): GeneratedToken {
  const raw = randomBytes(TOKEN_BYTES).toString('hex')
  const plaintext = `${TOKEN_PREFIX}${raw}`
  return {
    plaintext,
    hash: hashToken(plaintext),
    display: `${plaintext.slice(0, 12)}…`,
  }
}

export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex')
}

/** True when the string looks like one of our tokens (cheap pre-filter). */
export function looksLikeToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX) && value.length > TOKEN_PREFIX.length
}
