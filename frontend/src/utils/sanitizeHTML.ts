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
        // Replace element with its children
        const parent = element.parentNode
        while (element.firstChild) {
          parent?.insertBefore(element.firstChild, element)
        }
        parent?.removeChild(element)
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

    // Process children recursively
    const childNodes = Array.from(node.childNodes)
    childNodes.forEach(child => {
      sanitizeNode(child)
      // Check if child was removed during sanitization
      if (!child.parentNode) {
        node.removeChild(child)
      }
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

      // Check value for dangerous patterns
      const dangerousPatterns = [
        /expression\s*\(/i,
        /javascript:/i,
        /vbscript:/i,
        /data:/i,
        /behavior\s*:/i,
        /binding\s*:/i,
      ]

      return !dangerousPatterns.some(pattern => pattern.test(propValue))
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
