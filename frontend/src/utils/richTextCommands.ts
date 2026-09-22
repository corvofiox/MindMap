/**
 * 富文本编辑命令工具
 * 使用 document.execCommand 实现可靠的富文本编辑
 * 支持：加粗、斜体、下划线、删除线、文字颜色
 */
import { logger } from './logger'

const FORMAT_COMMANDS = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  strikeThrough: 'strikeThrough',
} as const

type FormatCommand = keyof typeof FORMAT_COMMANDS

/**
 * 颜色工具函数
 */
export const ColorUtils = {
  /**
   * 将各种颜色格式统一转换为标准十六进制格式 (#RRGGBB)
   */
  toHex(color: string): string {
    if (!color) return ''

    const normalized = color.toLowerCase().trim()

    // 已经是十六进制格式
    if (normalized.startsWith('#')) {
      let hex = normalized.slice(1)
      // 将 #RGB 转换为 #RRGGBB
      if (hex.length === 3) {
        hex = hex.split('').map((c) => c + c).join('')
      }
      return hex.length === 6 ? `#${hex}` : normalized
    }

    // 处理 rgb/rgba 格式
    const rgbMatch = normalized.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/)
    if (rgbMatch) {
      const r = parseInt(rgbMatch[1], 10)
      const g = parseInt(rgbMatch[2], 10)
      const b = parseInt(rgbMatch[3], 10)
      return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
    }

    // 处理颜色名称
    const colorNames: Record<string, string> = {
      black: '#000000',
      white: '#ffffff',
      red: '#ff0000',
      green: '#008000',
      blue: '#0000ff',
      yellow: '#ffff00',
      cyan: '#00ffff',
      magenta: '#ff00ff',
      gray: '#808080',
      grey: '#808080',
    }
    if (colorNames[normalized]) {
      return colorNames[normalized]
    }

    return normalized
  },

  /**
   * 比较两个颜色是否相同（忽略格式差异）
   */
  equals(color1: string, color2: string): boolean {
    if (!color1 || !color2) return false
    return this.toHex(color1) === this.toHex(color2)
  },

  /**
   * 检查是否为默认/黑色
   */
  isDefault(color: string): boolean {
    if (!color) return true
    const hex = this.toHex(color).toLowerCase()
    return hex === '#000000'
  },
}

/**
 * 获取选区范围内的所有文本节点
 */
function getTextNodesInRange(range: Range): Text[] {
  const textNodes: Text[] = []

  // 如果选区在单个文本节点内
  if (range.commonAncestorContainer.nodeType === Node.TEXT_NODE) {
    const text = range.commonAncestorContainer as Text
    if (text.textContent && text.textContent.length > 0) {
      textNodes.push(text)
    }
    return textNodes
  }

  const container = range.commonAncestorContainer as Element
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null)

  let node: Node | null
  while ((node = walker.nextNode())) {
    const textNode = node as Text
    if (!textNode.textContent || textNode.textContent.length === 0) {
      continue
    }

    const nodeRange = document.createRange()
    try {
      nodeRange.selectNode(textNode)
      const isInRange = !(
        range.compareBoundaryPoints(Range.END_TO_START, nodeRange) > 0 ||
        range.compareBoundaryPoints(Range.START_TO_END, nodeRange) < 0
      )
      if (isInRange) {
        textNodes.push(textNode)
      }
    } catch {
      // 忽略无法选择范围的节点
    }
  }

  return textNodes
}

/**
 * 读取元素内联样式里的**文字颜色**（只认 `color` 属性）。
 *
 * 不能用 `/color\s*:\s*([^;]+)/i` 去匹配 style 字符串：那个正则没有左边界，
 * `background-color: #fff`、`border-color`、`caret-color` 都会被当成文字颜色。
 * 节点卡片恰好带内联 `background-color`（NodeItem 里 `backgroundColor: node.color`），
 * 于是"刚打出来的默认文字"一划选就被判成"已改过颜色"，工具栏颜色按钮直接亮起。
 * 用 CSSOM 读 `element.style.color` 才是精确的 —— 它只认 color 这一个属性。
 */
function getInlineTextColor(el: HTMLElement): string | null {
  const value = el.style.color
  return value ? value.trim() : null
}

/**
 * 只清除内联样式里的 `color`，保留 background-color 等其它属性。
 * （旧实现用 `style.replace(/color\s*:[^;]+/gi,'')`，会把 `background-color: #fef08a`
 * 抠成残缺的 `background-` —— 不只丢背景色，还写坏了内联样式。）
 */
function clearInlineTextColor(el: HTMLElement): void {
  el.style.removeProperty('color')
  const remaining = el.getAttribute('style')
  if (!remaining || !remaining.trim()) el.removeAttribute('style')
}

/**
 * 是否是富文本编辑器的根容器 —— 向上找颜色到此为止，不再看更外层
 * （卡片 / 画布 / body 的颜色不属于这段文字）。
 *
 * 浏览器里用 `isContentEditable` 即可；但 jsdom 没有实现该属性（恒为 undefined），
 * 只靠它会让"边界"在测试里静默失效，所以同时看 contenteditable 属性。
 */
function isEditorRoot(el: HTMLElement): boolean {
  if (el.isContentEditable) return true
  const attr = el.getAttribute('contenteditable')
  return attr === '' || attr === 'true' || attr === 'plaintext-only'
}

/**
 * 获取节点上显式设置的颜色（从 style 属性或 font 标签）
 */
function getExplicitColor(node: Node): string | null {
  if (node.nodeType !== Node.TEXT_NODE) return null

  let element: Element | null = node.parentElement
  while (element && element instanceof HTMLElement) {
    // 只认内联 style 里的 color 属性（不能拿 background-color 当文字颜色）
    const inlineColor = getInlineTextColor(element)
    if (inlineColor) {
      return inlineColor
    }

    // 检查 font 标签的 color 属性
    if (element.tagName === 'FONT') {
      const fontColor = element.getAttribute('color')
      if (fontColor) {
        return fontColor
      }
    }

    // 到 contenteditable 容器即止：更外层（节点卡片/画布）的颜色不属于这段文字。
    // 与 getColorAtCursor 保持一致 —— 少了这一步，卡片的内联样式会被当成文字颜色。
    if (isEditorRoot(element)) break

    element = element.parentElement
  }

  return null
}

/**
 * 获取光标位置的颜色
 * 处理光标在文本末尾、文本中间、以及容器边缘的情况
 */
function getColorAtCursor(range: Range): string | null {
  let node: Node | null = range.startContainer
  const offset = range.startOffset

  // 如果是文本节点，获取其父元素
  if (node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement
  } else if (node instanceof HTMLElement) {
    // 如果 startContainer 是元素节点（如 contenteditable div）
    // 且 offset > 0，说明光标在元素内的某个位置
    // 我们需要检查光标前一个子节点的颜色
    if (offset > 0 && node.childNodes.length > 0) {
      // 获取光标前一个节点
      const prevNode = node.childNodes[offset - 1]
      if (prevNode) {
        // 如果是文本节点，获取其父元素
        if (prevNode.nodeType === Node.TEXT_NODE) {
          node = prevNode.parentElement
        } else if (prevNode instanceof HTMLElement) {
          // 如果是元素节点，直接使用它
          node = prevNode
        }
      }
    } else if (offset === 0 || node.childNodes.length === 0) {
      // 光标在空元素或元素开头，没有前一个节点可以获取颜色
      // 检查当前元素本身是否有显式设置的颜色（只认 color，不认 background-color）
      const inlineColor = getInlineTextColor(node as HTMLElement)
      if (inlineColor && !ColorUtils.isDefault(inlineColor)) {
        return ColorUtils.toHex(inlineColor)
      }
      // 空元素或没有显式颜色，返回 null
      return null
    }
  }

  // 向上遍历 DOM 树查找颜色
  // 但只遍历到 contenteditable 元素为止，不检查更外层的元素
  while (node && node instanceof HTMLElement) {
    // 只认内联 style 里的 color 属性（background-color 等不算文字颜色）
    const inlineColor = getInlineTextColor(node)
    if (inlineColor && !ColorUtils.isDefault(inlineColor)) {
      return ColorUtils.toHex(inlineColor)
    }

    if (node.tagName === 'FONT') {
      const fontColor = node.getAttribute('color')
      if (fontColor && !ColorUtils.isDefault(fontColor)) {
        return ColorUtils.toHex(fontColor)
      }
    }

    // 到达 contenteditable 容器即停止遍历（容器本身已在上面检查过）
    if (isEditorRoot(node)) break

    node = node.parentElement
  }

  return null
}

/**
 * 获取光标位置的格式状态
 * 通过检查 DOM 结构来确定光标位置是否应用了指定格式
 * 这比 document.queryCommandState 更可靠，特别是在光标位于格式化文本边缘时
 */
function getFormatAtCursor(range: Range, command: string): boolean {
  let node: Node | null = range.startContainer

  // 如果是文本节点，获取其父元素
  if (node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement
  }

  // 向上遍历 DOM 树，检查是否有对应的格式标签
  while (node && node instanceof HTMLElement) {
    const tagName = node.tagName.toLowerCase()

    switch (command) {
      case 'bold':
        if (tagName === 'b' || tagName === 'strong') return true
        break
      case 'italic':
        if (tagName === 'i' || tagName === 'em') return true
        break
      case 'underline':
        if (tagName === 'u') return true
        break
      case 'strikeThrough':
        if (tagName === 's' || tagName === 'strike') return true
        break
    }

    // 检查 style 属性中的 text-decoration
    if (command === 'underline') {
      const style = node.getAttribute('style') || ''
      if (style.includes('text-decoration') && style.includes('underline')) {
        return true
      }
    }

    node = node.parentElement
  }

  return false
}

/**
 * 检查当前选区是否应用了指定格式
 */
export function queryFormatState(command: string): boolean {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return false

  const range = selection.getRangeAt(0)

  // 如果选区是折叠的（没有选中文字，只有光标），使用 DOM 检查
  if (range.collapsed && command in FORMAT_COMMANDS) {
    return getFormatAtCursor(range, command)
  }

  if (command in FORMAT_COMMANDS) {
    return document.queryCommandState(FORMAT_COMMANDS[command as FormatCommand])
  }

  if (command === 'foreColor') {
    return queryCurrentColor() !== null
  }

  return false
}

/**
 * 获取当前选区的文字颜色
 * 返回选区内文本的主要颜色，如果选区内有多种颜色则返回 null
 */
export function queryCurrentColor(): string | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null

  const range = selection.getRangeAt(0)

  // 如果选区是折叠的（没有选中文字），获取光标位置的颜色
  if (range.collapsed) {
    return getColorAtCursor(range)
  }

  // 获取选区内所有文本节点的颜色
  const textNodes = getTextNodesInRange(range)
  if (textNodes.length === 0) return null

  const colors = new Set<string>()

  for (const textNode of textNodes) {
    const color = getExplicitColor(textNode)
    if (color && !ColorUtils.isDefault(color)) {
      colors.add(ColorUtils.toHex(color))
    }
  }

  // 如果只有一种颜色，返回它
  if (colors.size === 1) {
    return Array.from(colors)[0]
  }

  return null
}

/**
 * 保存当前选区
 */
export function saveSelection(): Range | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  return selection.getRangeAt(0).cloneRange()
}

/**
 * 恢复选区
 */
export function restoreSelection(range: Range | null): boolean {
  if (!range) return false
  const selection = window.getSelection()
  if (!selection) return false

  try {
    selection.removeAllRanges()
    selection.addRange(range)
    return true
  } catch {
    return false
  }
}

/**
 * 执行富文本格式命令
 * @param command 命令名称
 * @param value 命令值（如颜色值）
 * @returns 是否成功执行
 */
export function execFormatCommand(command: string, value?: string): boolean {
  const selection = window.getSelection()
  if (!selection) return false

  // 保存当前选区
  const savedRange = selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null

  // 确保编辑器获得焦点
  const editor = document.querySelector('[contenteditable="true"]') as HTMLElement
  if (editor && document.activeElement !== editor) {
    editor.focus()
    // 恢复选区
    if (savedRange) {
      restoreSelection(savedRange)
    }
  }

  try {
    let result = false

    switch (command) {
      case 'bold':
      case 'italic':
      case 'underline':
      case 'strikeThrough':
        result = document.execCommand(FORMAT_COMMANDS[command as FormatCommand], false)
        break

      case 'foreColor':
        result = applyColor(value || '#000000')
        break

      case 'removeForeColor':
        result = removeColor()
        break

      case 'insertText':
        result = insertText(value || '')
        break

      default:
        return false
    }

    // 触发 selectionchange 事件以更新工具栏状态
    document.dispatchEvent(new Event('selectionchange'))

    return result
  } catch (error) {
    logger.error('execFormatCommand error', error)
    return false
  }
}

/**
 * 应用文字颜色
 */
function applyColor(color: string): boolean {
  // 标准化颜色
  const normalizedColor = ColorUtils.toHex(color)

  // 使用 execCommand 设置颜色
  const result = document.execCommand('foreColor', false, normalizedColor)

  return result
}

/**
 * 移除文字颜色
 * 通过将颜色设置为默认黑色来实现
 */
function removeColor(): boolean {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return false

  const range = selection.getRangeAt(0)

  // 如果选区是折叠的，在光标位置移除颜色
  if (range.collapsed) {
    return removeColorAtCursor(range)
  }

  // 有选中文字时，直接使用 execCommand 移除颜色
  // execCommand 会将选中文字的颜色设为默认值
  return document.execCommand('foreColor', false, '#000000')
}

/**
 * 在光标位置移除颜色
 */
function removeColorAtCursor(range: Range): boolean {
  try {
    let current: Node | null = range.startContainer
    if (current.nodeType === Node.TEXT_NODE) {
      current = current.parentElement
    }

    // 向上查找带**文字颜色**的 span（background-color / border-color 都不算）
    while (current && current instanceof Element) {
      if (current.tagName === 'SPAN') {
        const span = current as HTMLElement
        if (getInlineTextColor(span)) {
          clearInlineTextColor(span)
          return true
        }
      }
      current = current.parentElement
    }

    return false
  } catch {
    return false
  }
}

/**
 * 在光标位置插入文本
 */
function insertText(text: string): boolean {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return false

  const range = selection.getRangeAt(0)

  // 删除当前选区内容
  range.deleteContents()

  // 插入文本节点
  const textNode = document.createTextNode(text)
  range.insertNode(textNode)

  // 将光标移到插入文本之后
  range.setStartAfter(textNode)
  range.collapse(true)

  selection.removeAllRanges()
  selection.addRange(range)

  return true
}
