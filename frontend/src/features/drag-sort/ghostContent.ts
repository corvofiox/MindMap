/**
 * 拖拽时的"影子卡片"内容——判断依据必须是"有没有正文"，不是"有没有图"。
 *
 * 回归背景（2026-11-13 真机复现）：节点池卡片只要带图（`cover` 或 `thumbnail`），
 * 拖拽影子就整块换成 `<img>`，"文字 + 图（图在文字下面）"的卡片拖起来只剩一张图，
 * 用户以为文字丢了。实际落进画布后正文是完整的——错的是影子，不是数据。
 *
 * 统一节点之后，节点/卡片的内容永远是一段富文本，图只是其中一个块。
 * 所以影子的规则和真实渲染一致：有正文就排正文（图在正文里），
 * 正文为空且只有图时，才退化成一个图片占位。
 */

export interface GhostContentInput {
  /** 富文本正文（可能含 <img>） */
  content?: string | null
  /** 首图，用于"纯图片"时的占位与缩略 */
  cover?: string | null
  imageUrl?: string | null
  thumbnail?: string | null
}

export interface GhostContent {
  /** 纯图片形态（正文里没有任何文字，只有图） */
  isImageOnly: boolean
  /** 图片地址（仅 isImageOnly 时有意义） */
  imageSrc: string | null
  /** 正文纯文本（用于影子里的两行预览） */
  text: string
}

/** HTML 里是否还有可见文字（`<img>`/`<br>` 都不算）。 */
export function htmlHasText(html: string | null | undefined): boolean {
  if (!html) return false
  const withoutTags = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
  return withoutTags.replace(/\s+/g, '').length > 0
}

/** 输入是否是"只有一张图、没有文字"的内容。 */
export function describeGhostContent(input: GhostContentInput): GhostContent {
  const content = typeof input.content === 'string' ? input.content : ''
  const text = content
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()

  const hasText = htmlHasText(content)
  const imageSrc = input.cover || input.imageUrl || input.thumbnail || null

  return {
    // 关键：只要有文字就走文字形态，哪怕同时也带图
    isImageOnly: !hasText && imageSrc !== null,
    imageSrc,
    text,
  }
}
