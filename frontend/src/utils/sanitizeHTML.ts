/**
 * HTML sanitization utilities for safely rendering rich text content
 */

/**
 * Allowed HTML tags and their allowed attributes
 * This is a conservative whitelist for basic formatting
 */
const ALLOWED_TAGS = new Set([
  // Text formatting
  'p', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'strike',
  'sub', 'sup', 'mark', 'small', 'del', 'ins',
  // Headings
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  // Lists
  'ul', 'ol', 'li',
  // Block elements
  'div', 'br', 'hr',
  // Code
  'code', 'pre',
  // Blockquote
  'blockquote',
  // Table
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  // Links (disabled for security, can be enabled if needed)
  // 'a',
])

/**
 * Allowed HTML attributes for specific tags
 */
const ALLOWED_ATTRIBUTES: Record<string, Set<string>> = {
  '*': new Set(['class', 'style']),
  'td': new Set(['class', 'style', 'colspan', 'rowspan']),
  'th': new Set(['class', 'style', 'colspan', 'rowspan']),
  // 'a': new Set(['href', 'class', 'style', 'target', 'title']),
}

/**
 * Allowed CSS properties (basic text formatting only)
 */
const ALLOWED_STYLES = new Set([
  'color', 'background-color',
  'font-size', 'font-weight', 'font-style', 'text-decoration',
  'text-align', 'line-height', 'letter-spacing', 'word-spacing',
  'padding', 'margin', 'border', 'display',
])

/**
 * Sanitize an HTML string by removing disallowed tags and attributes
 *
 * @param html - The HTML string to sanitize
 * @returns Sanitized HTML string
 */
export function sanitizeHTML(html: string): string {
  // Create a temporary DOM element
  const tempDiv = document.createElement('div')
  tempDiv.innerHTML = html

  // Remove disallowed tags recursively
  const sanitizeNode = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      // Keep text nodes as is
      return
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element

      // Remove disallowed tags
      if (!ALLOWED_TAGS.has(element.tagName.toLowerCase())) {
        // Replace element with its children.
        // Guard the re-parent: a previous sanitization pass on a nested
        // disallowed tag may already have hoisted this element's siblings, so
        // `element.parentNode` can be null or no longer contain `element`.
        // Throwing here used to bubble into safeHTML's fallback, which stripped
        // ALL tags (including legitimate allowed ones like <b>) — the mixed
        // input "<b>标题</b><script>…</script>" lost its formatting entirely.
        const parent = element.parentNode
        if (!parent) return
        // Detach, SANITIZE each child (nodes work fine detached), then move the
        // sanitized results back in ONE fragment insert. Two holes closed here:
        //
        // 1. mXSS — the outer loop iterates a childNodes snapshot taken before
        //    this unwrap, so hoisted subtrees used to escape sanitization
        //    entirely; "<math><mtext><mglyph><style><img onerror=…>" rode that
        //    hole and shipped a raw <style> body (img markup as CDATA) to the
        //    output. Every hoisted child is now re-visited by sanitizeNode.
        //
        // 2. O(n²) — hoisting one child at a time with `element` as the insert
        //    reference made each insert walk a growing sibling list
        //    (40k disallowed tags ≈ 150 s of CPU; a user-controlled input, so a
        //    theoretical DoS). One fragment insert is linear.
        const children = Array.from(element.childNodes)
        const fragment = document.createDocumentFragment()
        children.forEach(child => {
          fragment.appendChild(child)
        })
        children.forEach(child => {
          sanitizeNode(child)
        })
        parent.insertBefore(fragment, element)
        // element 必然仍是 parent 的子节点：上面只摘走了它的 children（挂到
        // fragment），element 本身从未被 detach，sanitizeNode 只会递归进
        // fragment 里的 child，不会触及 element。此前这里有一个
        // `if (element.parentNode === parent)` 守卫——恒真、不可达 false 分支
        // （R1 变异审计），故改为无条件移除，并由
        // sanitizeHTML.test.ts 的「不残留空壳」测试锁定行为。
        parent.removeChild(element)
        return
      }

      // Remove disallowed attributes
      const tagName = element.tagName.toLowerCase()
      const allowedAttrs = ALLOWED_ATTRIBUTES['*']

      Array.from(element.attributes).forEach((attr) => {
        const isAllowed = allowedAttrs.has(attr.name) ||
          ALLOWED_ATTRIBUTES[tagName]?.has(attr.name)

        if (!isAllowed) {
          element.removeAttribute(attr.name)
        } else if (attr.name === 'style') {
          // Sanitize style attribute
          const sanitizedStyle = sanitizeStyle(attr.value)
          if (sanitizedStyle) {
            element.setAttribute('style', sanitizedStyle)
          } else {
            element.removeAttribute('style')
          }
        }
      })
    }

    // Process children recursively. Iterate a SNAPSHOT: sanitizeNode may detach
    // or hoist children, which would mutate the live childNodes list mid-loop.
    const childNodes = Array.from(node.childNodes)
    childNodes.forEach(child => {
      sanitizeNode(child)
      // NOTE: do NOT removeChild here. A child that sanitizeNode detached (e.g. a
      // disallowed <script> whose children were hoisted) already has parentNode
      // === null, and removeChild on a detached node THROWS NotFoundError — which
      // used to bubble into safeHTML's strip-all fallback, destroying legitimate
      // formatting: "<b>标题</b><script>…</script>" lost its <b> entirely.
      // Detached/hoisted children are already out of this node's child list.
    })
  }

  // Start sanitization
  sanitizeNode(tempDiv)

  return tempDiv.innerHTML
}

/**
 * Sanitize CSS style string
 *
 * @param style - The CSS style string
 * @returns Sanitized CSS style string
 */
function sanitizeStyle(style: string): string {
  if (!style) return ''

  return style
    .split(';')
    .map(declaration => declaration.trim())
    .filter(declaration => {
      if (!declaration) return false

      const [property, ...valueParts] = declaration.split(':')
      if (!property || valueParts.length === 0) return false

      const propName = property.trim().toLowerCase()
      const propValue = valueParts.join(':').trim()

      // Check if property is allowed
      if (!ALLOWED_STYLES.has(propName)) return false

      // Check value for dangerous patterns.
      // Test a WHITESPACE-STRIPPED copy: CSS treats newlines as ordinary
      // whitespace, so "url(java\nscript:alert(1))" reassembles to
      // "javascript:alert(1)" in the browser while the raw value slips past a
      // literal /javascript:/i test. The declared value keeps its original
      // spacing; only the security check sees the collapsed form.
      const collapsedValue = propValue.replace(/\s+/g, '')
      const dangerousPatterns = [
        /expression\s*\(/i,
        /javascript:/i,
        /vbscript:/i,
        /data:/i,
        /behavior\s*:/i,
        /binding\s*:/i,
      ]

      return !dangerousPatterns.some(pattern => pattern.test(collapsedValue))
    })
    .join('; ')
}

/**
 * Strip all HTML tags from a string, keeping only the text content
 *
 * @param html - The HTML string to strip
 * @returns Plain text string
 */
export function stripHTML(html: string): string {
  const tempDiv = document.createElement('div')
  tempDiv.innerHTML = html
  return tempDiv.textContent || tempDiv.innerText || ''
}

/**
 * Check if a string contains HTML tags
 *
 * @param str - The string to check
 * @returns True if the string contains HTML tags
 */
export function containsHTML(str: string): boolean {
  return /<[a-z][\s\S]*>/i.test(str)
}

/**
 * Safely render HTML content by sanitizing it first
 *
 * @param html - The HTML string to render
 * @returns Sanitized HTML string, or empty string if invalid
 */
export function safeHTML(html: string): string {
  if (!html || typeof html !== 'string') {
    return ''
  }

  try {
    return sanitizeHTML(html)
  } catch {
    // If sanitization fails, strip all HTML
    return stripHTML(html)
  }
}
