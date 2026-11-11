/**
 * Unified node helpers.
 *
 * ## What changed
 *
 * Nodes used to come in two shapes: a `text` node rendered `content` (rich HTML)
 * and an `image` node rendered `imageUrl` (one picture, base64 data URL). There
 * was no shape that held both, which is why "upload an image" used to *replace*
 * the node's text (NodeItem.tsx used to set `type: 'image'` on upload).
 *
 * A node is now one thing: a rich-text document that may contain `<img>`. The
 * legacy fields (`type`, `imageUrl`, `aspectRatio`) are read-only compatibility
 * inputs and never written again.
 *
 * ## Where normalization happens
 *
 * Every document ingest boundary (REST load, localStorage cache, Yjs remote
 * update, node-pool card drop, JSON import) funnels through `normalizeNode`, so
 * the rest of the app only ever sees the unified shape. Keeping the legacy
 * fallback in one place is what makes the migration tolerant: even a doc the
 * batch migration has not touched yet renders correctly.
 *
 * Pure functions only — shared by frontend and backend (MCP output goes through
 * the same normalizer).
 */

/** Fields a node may still carry from before the unification. */
export interface LegacyNodeFields {
  type?: string
  imageUrl?: string
  aspectRatio?: number
  content?: string
  cover?: string
}

const FIRST_IMG_SRC = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/i

/** First `<img src>` inside an HTML string, or null. */
export function extractFirstImageUrl(html: string | null | undefined): string | null {
  if (!html) return null
  const match = FIRST_IMG_SRC.exec(html)
  return match ? match[1] : null
}

/** Plain-text projection of an HTML string (for previews, search hints). */
export function htmlToPlainText(html: string | null | undefined): string {
  if (!html) return ''
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Map any node shape (current or legacy) onto the unified shape.
 *
 * - a legacy `imageUrl` becomes `content: '<img src=…>'` when there is no body
 *   text, and always becomes `cover` so thumbnails keep working;
 * - `cover` falls back to the first image found in `content`;
 * - `type` / `imageUrl` / `aspectRatio` are dropped from the returned object.
 *
 * The input is never mutated.
 */
export function normalizeNode<T extends LegacyNodeFields>(raw: T): T {
  const source = (raw ?? {}) as T
  const legacyImage = typeof source.imageUrl === 'string' && source.imageUrl !== ''
    ? source.imageUrl
    : null

  let content = typeof source.content === 'string' ? source.content : ''
  if (!content.trim() && legacyImage) {
    content = `<img src="${legacyImage}" alt="">`
  }

  const cover = source.cover
    || legacyImage
    || extractFirstImageUrl(content)
    || undefined

  const { type: _type, imageUrl: _imageUrl, aspectRatio: _aspectRatio, ...rest } = source
  const normalized = { ...rest, content } as T
  if (cover) {
    ;(normalized as LegacyNodeFields).cover = cover
  } else {
    delete (normalized as LegacyNodeFields).cover
  }
  return normalized
}

/** True when the node has any picture (unified `cover` or a legacy `imageUrl`). */
export function nodeHasImage(node: LegacyNodeFields | null | undefined): boolean {
  if (!node) return false
  if (typeof node.cover === 'string' && node.cover !== '') return true
  if (typeof node.imageUrl === 'string' && node.imageUrl !== '') return true
  return extractFirstImageUrl(node.content) !== null
}
