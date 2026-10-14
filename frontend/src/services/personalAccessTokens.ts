/**
 * Personal access token (PAT) API.
 *
 * These tokens are the credentials external agents use to reach the MCP endpoint
 * at `/mcp`. The three calls below are the web UI's whole view of them:
 * list metadata, mint one, revoke one.
 *
 * All requests go through the shared `apiClient` so they inherit the same
 * auth + CSRF handling as every other authenticated call (the client attaches
 * `x-csrf-token` from the cookie and refreshes it on a 403 CSRF rejection).
 * Do not hand-roll `fetch` here — a bare fetch would silently skip CSRF and 403.
 *
 * Timestamps are Unix **seconds** (or `null`), matching the backend schema; they
 * are formatted for display by the UI, never reinterpreted here.
 */
import { API_ENDPOINTS } from '@/constants'
import { apiClient } from './apiClient.js'

/** Metadata for an existing token. Never contains the secret. */
export interface PersonalAccessToken {
  id: number
  name: string
  /** Non-secret display prefix, e.g. `mmp_1a2b3c4d…`. */
  tokenPrefix: string
  /** Unix seconds of the last successful use, or `null` if never used. */
  lastUsedAt: number | null
  /** Unix seconds, or `null` when the token never expires. */
  expiresAt: number | null
  /** Unix seconds, or `null` if unknown. */
  createdAt: number | null
  /** Unix seconds of revocation, or `null` while still active. */
  revokedAt: number | null
  revoked: boolean
}

/**
 * A freshly minted token.
 *
 * `token` is the plaintext secret and exists **only** in the POST response — it
 * is never persisted and cannot be fetched again. The UI must show it once.
 */
export interface CreatedPersonalAccessToken {
  id: number
  name: string
  token: string
  tokenPrefix: string
  expiresAt: number | null
  createdAt: number | null
}

export interface CreatePersonalAccessTokenInput {
  name: string
  /** Omit (or leave undefined) for a token that never expires. */
  expiresInDays?: number
}

interface TokenListPayload {
  tokens: PersonalAccessToken[]
}

/** List the caller's tokens, newest first. Revoked ones are included. */
export async function listPersonalAccessTokens(): Promise<PersonalAccessToken[]> {
  const data = await apiClient.get<TokenListPayload>(API_ENDPOINTS.TOKENS)
  return data?.tokens ?? []
}

/** Mint a token. The returned plaintext is shown once and never retrievable again. */
export async function createPersonalAccessToken(
  input: CreatePersonalAccessTokenInput
): Promise<CreatedPersonalAccessToken> {
  const body: CreatePersonalAccessTokenInput = { name: input.name }
  // Omit the key entirely when no expiry was requested: the backend treats a
  // missing/empty value as "never expires", while 0 would be rejected.
  if (typeof input.expiresInDays === 'number') {
    body.expiresInDays = input.expiresInDays
  }
  return await apiClient.post<CreatedPersonalAccessToken>(API_ENDPOINTS.TOKENS, body)
}

/** Revoke a token. The row is kept server-side with `revokedAt` set. */
export async function revokePersonalAccessToken(id: number): Promise<void> {
  await apiClient.delete<void>(API_ENDPOINTS.TOKENS_BY_ID(id))
}
