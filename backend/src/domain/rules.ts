/**
 * Content rules shared by REST controllers and MCP tools.
 *
 * These used to live inside `manuscript.controller.ts`. They moved here because
 * the MCP notebook tools need exactly the same limits and the same title cleaning:
 * two copies drift, and a drifted limit means a card that REST refuses can be
 * created through MCP (or vice versa) — the same class of bug as the duplicated
 * authorization check.
 */

/** Longest accepted title / card name. */
export const MAX_TITLE = 200

/** Longest accepted manuscript body (HTML). */
export const MAX_CONTENT = 5 * 1024 * 1024

/** Longest accepted node-pool card body, matching `POST /api/users/node-pool`. */
export const MAX_CARD_CONTENT = 5000

/** Characters kept in `previewText`. */
export const PREVIEW_LENGTH = 500

/** Parse a positive integer id, or null. Accepts numeric strings. */
export function toPositiveInt(value: unknown): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * Strip control characters and clamp the length.
 *
 * Control characters are filtered by code point rather than with a regex because
 * eslint's `no-control-regex` rejects the obvious pattern, and the code-point loop
 * is easier to read anyway.
 */
export function sanitizeTitle(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const cleaned = Array.from(raw)
    .map((ch) => (ch.charCodeAt(0) < 0x20 ? ' ' : ch))
    .join('')
  return cleaned.trim().slice(0, MAX_TITLE)
}

/** Count `<img>` tags, used for the notebook's "has images" badge. */
export function countImages(html: string): number {
  return (html.match(/<img\b/gi) || []).length
}

/** Escape text so it is safe inside HTML. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Convert plain text to the HTML subset the editor understands.
 *
 * Agents produce Markdown-ish prose, not sanitized HTML. Asking a model to emit
 * `<p>` tags reliably is a losing battle, so the tools accept `text` and convert
 * here: blank lines separate paragraphs, single newlines become `<br>`, and every
 * character is escaped so agent output can never inject markup. Deliberately no
 * Markdown inline syntax: the editor's whitelist has no `<a>`, and a half-working
 * `**bold**` would be more confusing than none.
 */
export function textToHtml(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (normalized.length === 0) return ''
  return normalized
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

/**
 * Reject HTML that is obviously hostile before it is stored.
 *
 * The database has never been a sanitizing layer (the editor's whitelist runs in
 * the browser), and this is not a replacement for it. What it does is stop an
 * agent from *persisting* `<script>` / `onload=` payloads that would then be
 * served to every collaborator: it fails loudly (E_VALIDATION) instead of
 * silently rewriting the author's content, which would leave the caller believing
 * something was saved that was not.
 */
export function findUnsafeHtml(html: string): string | null {
  if (/<\s*script\b/i.test(html)) return '<script> 标签'
  if (/<\s*iframe\b/i.test(html)) return '<iframe> 标签'
  if (/\son[a-z]+\s*=/i.test(html)) return 'on* 事件属性'
  if (/(?:href|src)\s*=\s*["']?\s*javascript:/i.test(html)) return 'javascript: 协议'
  if (/<\s*(?:object|embed|link|meta)\b/i.test(html)) return '危险标签（object/embed/link/meta）'
  return null
}
