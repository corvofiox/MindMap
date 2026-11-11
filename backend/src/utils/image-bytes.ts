/**
 * Image byte-level validation, shared by every upload path.
 *
 * The client-declared mimetype is not trustworthy: a body can claim
 * `image/png` while containing HTML/script (the A5 XSS vector pinned by
 * upload.controller.test.ts). Both `/api/upload` (legacy, returns a data URL)
 * and `/api/files` (canonical, returns a short URL) must therefore sniff the
 * magic bytes and refuse anything that is not one of the supported formats.
 */

export interface ImageSignature {
  mime: string
  match: (buf: Buffer) => boolean
}

export const IMAGE_SIGNATURES: ImageSignature[] = [
  {
    mime: 'image/png',
    match: (b) => b.length >= 8
      && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
      && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    mime: 'image/jpeg',
    match: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: 'image/gif',
    match: (b) => b.length >= 6
      && (b.toString('ascii', 0, 6) === 'GIF87a' || b.toString('ascii', 0, 6) === 'GIF89a'),
  },
  {
    mime: 'image/webp',
    match: (b) => b.length >= 12
      && b.toString('ascii', 0, 4) === 'RIFF'
      && b.toString('ascii', 8, 12) === 'WEBP',
  },
]

/** Return the real image mimetype, or null when the bytes are not a supported image. */
export function sniffImageMime(buffer: Buffer): string | null {
  for (const sig of IMAGE_SIGNATURES) {
    if (sig.match(buffer)) return sig.mime
  }
  return null
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/** Canonical file extension for a snapped mime; falls back to `bin`. */
export function extensionForMime(mime: string): string {
  return EXTENSION_BY_MIME[mime] ?? 'bin'
}

/** Maximum accepted upload size (5 MB) — shared so tests and both routes agree. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** User-facing rejection message, kept identical across routes. */
export const UNSUPPORTED_IMAGE_MESSAGE =
  '仅支持 PNG/JPEG/GIF/WebP 图片（不支持 SVG/BMP 等格式）'
