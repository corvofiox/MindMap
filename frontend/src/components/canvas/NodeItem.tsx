import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react'
import { useCanvasStore, getYjsBinding } from '@/store/useCanvasStore'
import { useUIStore } from '@/store/useUIStore'
import { snapToGrid } from '@/utils/canvas'
import { CANVAS_DEFAULTS, NODE_DEFAULTS, Z_INDEX } from '@/constants'
import { loadApiModule } from '@/utils/moduleLoader'
import { logger } from '@/utils/logger'
import { execFormatCommand } from '@/utils/richTextCommands'
import { setEditingFieldForCollab, getEditingState, setLocalEditingUpdate } from '@/hooks/useCollabEditing'
import type { Node } from '@/types'

// 节点通用样式全局只注入一次（D12：避免每个节点渲染一份 <style>）
let nodeItemStylesInjected = false
function ensureNodeItemStyles(): void {
  if (nodeItemStylesInjected) return
  nodeItemStylesInjected = true
  if (typeof document === 'undefined') return
  const style = document.createElement('style')
  style.id = 'node-item-global-styles'
  style.textContent = `
    .node-dragging,
    .node-dragging * {
      cursor: move !important;
    }
    .node-content-placeholder {
      color: #9ca3af;
      font-style: italic;
    }
    .dark .node-content-placeholder {
      color: #6b7280;
    }
  `
  document.head.appendChild(style)
}
ensureNodeItemStyles()

/**
 * zustand 字段级订阅辅助（D7 性能优化）。
 * 真实 store 下 hook(selector) 返回选中值；automock 测试中 hook 会忽略
 * selector 直接返回整个 store 对象，这里检测到后手动应用 selector，
 * 使两种环境下取值一致（字段级订阅避免全量订阅导致的重渲染）。
 */
function useStoreField<T>(
  hook: (selector: (state: any) => T) => any,
  selector: (state: any) => T
): T {
  const value = hook(selector)
  if (value !== null && typeof value === 'object') {
    const selected = selector(value)
    if (selected !== undefined && selected !== value) {
      return selected
    }
  }
  return value
}

// Helper function to check if in default selection mode
function isDefaultSelectionTool(tool: string): boolean {
  return tool === 'select'
}

function toFinite(value: number | undefined | null, fallback: number): number {
  if (value === undefined || value === null || Number.isNaN(value) || !Number.isFinite(value)) {
    return fallback
  }
  return value
}

// 判断一段 HTML 是否没有任何可见文本（用于显示占位符）
function isVisuallyEmpty(html: string | undefined | null): boolean {
  if (!html) return true
  const div = document.createElement('div')
  div.innerHTML = html
  return (div.textContent || '').replace(/\s+/g, '').length === 0
}

// 清理 HTML 内容，保留基本的文字格式标签
function cleanHtmlContent(html: string): string {
  // 创建临时元素来解析 HTML
  const temp = document.createElement('div')
  temp.innerHTML = html

  // 允许保留的标签及其属性白名单
  const allowedTags = new Set([
    'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'sub', 'sup',
    'span', 'br', 'div', 'p', 'font'
  ])
  const allowedAttributes = new Set(['style', 'class', 'color', 'face'])

  // 清理样式属性，只保留安全的 CSS 属性
  const cleanStyle = (style: string): string => {
    const allowedStyles = new Set([
      'color', 'background-color', 'font-weight', 'font-style',
      'text-decoration', 'text-decoration-line',
      'text-decoration-style', 'text-decoration-color', 'line-height',
      'letter-spacing', 'word-spacing', 'text-transform', 'font-family'
    ])

    const styles = style.split(';').filter(s => s.trim())
    return styles
      .filter(s => {
        const [property] = s.split(':').map(p => p.trim().toLowerCase())
        return allowedStyles.has(property)
      })
      .join(';')
  }

  // 递归清理函数
  const cleanNode = (node: globalThis.Node): globalThis.Node => {
    if (node.nodeType === globalThis.Node.TEXT_NODE) {
      return node
    }

    if (node.nodeType === globalThis.Node.ELEMENT_NODE) {
      const element = node as Element
      const tagName = element.tagName.toLowerCase()

      // 如果是允许的标签，保留它并清理其属性
      if (allowedTags.has(tagName)) {
        const newElement = element.cloneNode(false) as Element

        // 特殊处理 font 标签，将其属性转换为内联样式
        if (tagName === 'font') {
          const color = element.getAttribute('color')
          const face = element.getAttribute('face')
          const styleParts: string[] = []

          if (color) {
            styleParts.push(`color: ${color}`)
          }
          if (face) {
            styleParts.push(`font-family: ${face}`)
          }

          if (styleParts.length > 0) {
            const existingStyle = element.getAttribute('style') || ''
            const safeStyle = cleanStyle(existingStyle)
            const combinedStyle = safeStyle
              ? `${safeStyle}; ${styleParts.join('; ')}`
              : styleParts.join('; ')
            if (combinedStyle) {
              newElement.setAttribute('style', combinedStyle)
            }
          }
        }

        // 只保留允许的属性
        Array.from(element.attributes).forEach(attr => {
          if (allowedAttributes.has(attr.name.toLowerCase())) {
            // 清理 style 属性，只保留安全的 CSS 属性
            if (attr.name.toLowerCase() === 'style') {
              const safeStyle = cleanStyle(attr.value)
              if (safeStyle) {
                newElement.setAttribute('style', safeStyle)
              }
            } else if (tagName !== 'font' ||
              (attr.name.toLowerCase() !== 'color' &&
                attr.name.toLowerCase() !== 'size' &&
                attr.name.toLowerCase() !== 'face')) {
              // 对于非 font 标签，保留其他允许的属性
              newElement.setAttribute(attr.name, attr.value)
            }
          }
        })

        // 递归清理子节点
        Array.from(element.childNodes).forEach(child => {
          newElement.appendChild(cleanNode(child))
        })

        return newElement
      } else {
        // 不允许的标签，只保留其子节点
        const fragment = document.createDocumentFragment()
        Array.from(element.childNodes).forEach(child => {
          fragment.appendChild(cleanNode(child))
        })
        return fragment
      }
    }

    return node
  }

  // 清理所有节点
  const cleanedNodes = Array.from(temp.childNodes).map(child => cleanNode(child))
  temp.innerHTML = ''
  cleanedNodes.forEach(node => temp.appendChild(node))

  // 简化换行处理
  let result = temp.innerHTML

  // 移除零宽空格（用于光标定位的辅助字符，不应保存）
  result = result.replace(/\u200B/g, '')

  // 移除真正空的 span 标签（不包含任何内容），但保留只含空格的 span
  result = result.replace(/<span[^>]*><\/span>/g, '')

  // 规范化：将块级换行元素转换为 <br>
  // 重要：先处理结束标签转换为换行，再移除开始标签
  result = result
    .replace(/<\/(?:div|p)>/gi, '<br>')  // 结束标签转换为换行
    .replace(/<(?:div|p)[^>]*>/gi, '')   // 移除开始标签

  // 清理连续换行之间的多余空白字符，但保留用户输入的换行数量
  result = result.replace(/(<br\s*\/?>)[ \t]+(?=<br\s*\/?>)/gi, '$1')

  // 清理开头换行（保留用户在开头的换行意图），只清理结尾多余换行保留一个
  result = result.replace(/(<br\s*\/?>\s*)+$/i, '<br>')

  // 确保非空内容有换行标记
  if (result && !result.includes('<br>')) {
    result = result + '<br>'
  }

  return result || '<br>'
}

interface NodeItemProps {
  node: Node
  isSelected: boolean
  zoom: number
  onDragStart?: (nodeId: string, e: React.MouseEvent) => void
  onDragEnd?: () => void
  groupDragOffset?: { x: number; y: number }
  onNodeContextMenuOpen?: (x: number, y: number, nodeId: string) => void
  onMouseDown?: () => void
  isViewer?: boolean
  opacity?: number
}

type EditingField = 'title' | 'content' | null

interface HighlightState {
  keywords: string[]
  timestamp: number
}

// M7: React.memo 包裹——CanvasPage 全量订阅 store 时（字段级 selector 改造前）
// 任意 store 变更都会重渲染整棵画布树，memo 让未变化的节点跳过重渲染。
// 注意：传参必须引用稳定（node/zoom/opacity 为原始值或 Map 稳定引用，
// onMouseDown 等在 CanvasPage 侧已 useCallback）。
export const NodeItem = memo(function NodeItem({ node, isSelected, zoom, onDragStart, onDragEnd, groupDragOffset, onNodeContextMenuOpen, onMouseDown, isViewer, opacity = 1 }: NodeItemProps) {
  // D7: 字段级订阅，避免 store 任意字段变化导致所有 NodeItem 重渲染
  const updateNode = useStoreField(useCanvasStore, (s) => s.updateNode)
  const updateNodeWithoutHistory = useStoreField(useCanvasStore, (s) => s.updateNodeWithoutHistory)
  const updateNodeWithOriginal = useStoreField(useCanvasStore, (s) => s.updateNodeWithOriginal)
  const setSelectedIds = useStoreField(useCanvasStore, (s) => s.setSelectedIds)
  const removeNode = useStoreField(useCanvasStore, (s) => s.removeNode)
  const addToSelection = useStoreField(useCanvasStore, (s) => s.addToSelection)
  const removeFromSelection = useStoreField(useCanvasStore, (s) => s.removeFromSelection)
  const globalEditingId = useStoreField(useCanvasStore, (s) => s.editingId)
  const setEditingId = useStoreField(useCanvasStore, (s) => s.setEditingId)

  const setSelectedType = useStoreField(useUIStore, (s) => s.setSelectedType)
  const currentTool = useStoreField(useUIStore, (s) => s.currentTool)
  const draggingNodeFromCanvas = useStoreField(useUIStore, (s) => s.draggingNodeFromCanvas)
  const isOverNodePool = useStoreField(useUIStore, (s) => s.isOverNodePool)
  const quickEditMode = useStoreField(useUIStore, (s) => s.quickEditMode)
  const addToast = useStoreField(useUIStore, (s) => s.addToast)

  const [isDragging, setIsDragging] = useState(false)
  const [isResizing, setIsResizing] = useState(false)
  const [resizeDirection, setResizeDirection] = useState<string>('')
  const [isComposing, setIsComposing] = useState(false)
  const [editingField, setEditingField] = useState<EditingField>(null)
  const [isHovered, setIsHovered] = useState(false)
  const [highlightState, setHighlightState] = useState<HighlightState | null>(null)
  // 本地状态用于拖动时的实时更新，避免频繁更新全局状态
  const [localPosition, setLocalPosition] = useState({
    x: toFinite(node.x, 0),
    y: toFinite(node.y, 0),
  })
  const [localSize, setLocalSize] = useState({
    width: toFinite(node.width, NODE_DEFAULTS.WIDTH),
    height: toFinite(node.height, NODE_DEFAULTS.HEIGHT),
  })

  const nodeRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const contentAreaRef = useRef<HTMLDivElement>(null)
  const dragStartRef = useRef({ x: 0, y: 0, nodeX: toFinite(node.x, 0), nodeY: toFinite(node.y, 0) })
  const resizeStartRef = useRef({ x: 0, y: 0, width: toFinite(node.width, NODE_DEFAULTS.WIDTH), height: toFinite(node.height, NODE_DEFAULTS.HEIGHT) })
  const justFinishedDragRef = useRef(false)
  const lastSyncedNodeRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const editingTitleRef = useRef<string>('')
  const editingContentRef = useRef<string>('')
  const wasEditingRef = useRef<EditingField>(null)
  const hasInitializedEditRef = useRef<{ title: boolean; content: boolean }>({ title: false, content: false })
  const domReadyRef = useRef<{ title: boolean; content: boolean }>({ title: false, content: false })
  const contextMenuStartRef = useRef({ x: 0, y: 0 })
  const timerRefsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  const imageRef = useRef<HTMLImageElement | null>(null)
  const uploadSeqRef = useRef(0)
  const inputSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dragSyncThrottleRef = useRef<number>(0)
  const resizeSyncThrottleRef = useRef<number>(0)
  const isDraggingRef = useRef(false)
  const isResizingRef = useRef(false)
  const localPositionRef = useRef(localPosition)
  const localSizeRef = useRef(localSize)

  const dispatchEditingFieldChange = useCallback((field: 'title' | 'content' | null, nodeId: string | null) => {
    setEditingFieldForCollab(nodeId, field)
    const state = getEditingState()
    window.dispatchEvent(new CustomEvent('nodeEditingFieldChange', {
      detail: { field, nodeId, version: state.version }
    }))
  }, [])

  useEffect(() => {
    return () => {
      timerRefsRef.current.forEach(timer => clearTimeout(timer))
      timerRefsRef.current.clear()
      if (inputSyncTimerRef.current) {
        clearTimeout(inputSyncTimerRef.current)
        inputSyncTimerRef.current = null
      }
      if (imageRef.current) {
        imageRef.current.onload = null
        imageRef.current.onerror = null
        imageRef.current = null
      }
      // Commit the current drag/resize position on unmount so intermediate
      // positions are not lost if the component is destroyed mid-interaction.
      if (isDraggingRef.current) {
        updateNode(node.id, {
          x: localPositionRef.current.x,
          y: localPositionRef.current.y,
        })
      }
      if (isResizingRef.current) {
        updateNode(node.id, {
          x: localPositionRef.current.x,
          y: localPositionRef.current.y,
          width: localSizeRef.current.width,
          height: localSizeRef.current.height,
        })
      }
    }
  }, [node.id, updateNode])

  useEffect(() => {
    const handleHighlight = (e: Event) => {
      const customEvent = e as CustomEvent<{
        nodeId: string | null
        nodeIds?: string[]
        keywords: string[]
      }>
      const { nodeId, nodeIds, keywords } = customEvent.detail
      if (nodeId === null) {
        setHighlightState(null)
      } else if (Array.isArray(nodeIds)) {
        // m-1: 批量高亮协议——单次事件携带全部匹配 nodeId,按集合成员判断
        // (与逐条派发"后发覆盖先发"不同,多结果可同时保持高亮)
        setHighlightState(
          nodeIds.includes(node.id)
            ? { keywords, timestamp: Date.now() }
            : null
        )
      } else if (nodeId === node.id) {
        setHighlightState({
          keywords,
          timestamp: Date.now(),
        })
      } else {
        setHighlightState(null)
      }
    }

    window.addEventListener('nodeSearchHighlight', handleHighlight)
    return () => {
      window.removeEventListener('nodeSearchHighlight', handleHighlight)
    }
  }, [node.id])

  // Image Upload Handler
  const handleImageUpload = useCallback(async (file: File) => {
    // 请求序号：防止快速连续上传时旧请求的 onload 覆盖新结果（D13）
    const requestSeq = ++uploadSeqRef.current
    try {
      // 使用 import.meta.glob 预加载的模块
      const apiModule = await loadApiModule()
      const { uploadImage } = apiModule
      const { url } = await uploadImage(file)

      // 已有更新的上传请求，丢弃本次结果
      if (requestSeq !== uploadSeqRef.current) return

      // Load image to get dimensions
      const img = new Image()
      imageRef.current = img
      img.src = url
      img.onload = () => {
        if (requestSeq !== uploadSeqRef.current) return
        const aspectRatio = img.width / img.height
        updateNode(node.id, {
          imageUrl: url,
          aspectRatio: aspectRatio,
          type: 'image',
          height: toFinite(node.width, NODE_DEFAULTS.WIDTH) / toFinite(aspectRatio, 1)
        })
        addToast({ type: 'success', title: '上传成功', message: '图片已上传' })
      }
    } catch (error) {
      if (requestSeq !== uploadSeqRef.current) return
      addToast({
        type: 'error',
        title: '上传失败',
        message: error instanceof Error ? error.message : '上传图片失败，请重试',
      })
    }
  }, [node.id, node.width, updateNode, addToast])

  const isEditingTitle = editingField === 'title'
  const isEditingContent = editingField === 'content'

  const highlightKeywords = useCallback((text: string, keywords: string[]): string => {
    if (!text || keywords.length === 0) return text

    let result = text
    keywords.forEach(keyword => {
      const regex = new RegExp(`(${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
      result = result.replace(regex, '<mark class="bg-yellow-300 dark:bg-yellow-500 px-0.5 rounded">$1</mark>')
    })
    return result
  }, [])

  /** Highlight keywords in an HTML string without breaking tags or attributes.
   *  HTML tags are temporarily replaced with placeholders, the remaining plain
   *  text is highlighted, then tags are restored. This prevents keywords from
   *  being matched inside tag names/attributes (e.g. `color` inside
   *  `style="color: red"` or `example` inside `href="...example..."`). */
  const safeHighlightHtml = useCallback((html: string, keywords: string[]): string => {
    if (!html || keywords.length === 0) return html

    const placeholders: string[] = []
    const protectedHtml = html.replace(/<[^>]+>/g, (tag) => {
      placeholders.push(tag)
      return `\0${placeholders.length - 1}\0`
    })

    let highlighted = protectedHtml
    keywords.forEach((keyword) => {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      highlighted = highlighted.replace(
        new RegExp(`(${escaped})`, 'gi'),
        '<mark class="bg-yellow-300 dark:bg-yellow-500 px-0.5 rounded">$1</mark>'
      )
    })

    return highlighted.replace(/\0(\d+)\0/g, (_, index) => placeholders[Number(index)])
  }, [])

  /** Strip HTML tags and decode entities, returning plain text for display. */
  const stripHtml = useCallback((html: string): string => {
    if (!html) return ''
    const doc = new DOMParser().parseFromString(html, 'text/html')
    return doc.body.textContent || ''
  }, [])

  // Keep refs in sync with latest interaction state / local geometry so the
  // unmount cleanup can commit the current position if the component is
  // destroyed mid-drag/resize.
  useEffect(() => {
    isDraggingRef.current = isDragging
    isResizingRef.current = isResizing
    localPositionRef.current = localPosition
    localSizeRef.current = localSize
  })

  useEffect(() => {
    if (editingField !== null) return

    // Guard against overwriting the local drag/resize result with a stale node
    // prop immediately after mouseup. The mouseup handler sets this ref while it
    // commits the final local position to the store.
    if (!isDragging && !isResizing && !justFinishedDragRef.current) {
      const shouldSync = !lastSyncedNodeRef.current ||
        lastSyncedNodeRef.current.x !== node.x ||
        lastSyncedNodeRef.current.y !== node.y ||
        lastSyncedNodeRef.current.width !== node.width ||
        lastSyncedNodeRef.current.height !== node.height

      if (shouldSync) {
        const safeX = toFinite(node.x, 0)
        const safeY = toFinite(node.y, 0)
        const safeWidth = toFinite(node.width, NODE_DEFAULTS.WIDTH)
        const safeHeight = toFinite(node.height, NODE_DEFAULTS.HEIGHT)
        setLocalPosition({ x: safeX, y: safeY })
        setLocalSize({ width: safeWidth, height: safeHeight })
        lastSyncedNodeRef.current = { x: safeX, y: safeY, width: safeWidth, height: safeHeight }
      }
    }
  }, [node.x, node.y, node.width, node.height, isDragging, isResizing, editingField])

  // 将文本转换为安全HTML（始终转义HTML标签，保留换行）
  const textToSafeHtml = useCallback((text: string): string => {
    if (!text) return ''

    // 标题字段按纯文本处理：始终转义 HTML 特殊字符并将换行符转换为 <br>。
    // 不再信任输入中已有的 HTML 标签，以防止远程用户通过 node.title 注入
    // 恶意脚本（XSS）。
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
    return escaped.replace(/\n/g, '<br>')
  }, [])

  /** Highlight keywords in a node title, then escape the text portions so the
   *  resulting string is safe for dangerouslySetInnerHTML. The <mark> tags
   *  produced by highlightKeywords are preserved; everything else is escaped.
   *  This prevents keywords from matching inside HTML entities (e.g. &lt;). */
  const safeHighlightTitle = useCallback((title: string, keywords: string[]): string => {
    const highlighted = highlightKeywords(title, keywords)
    return highlighted
      .split(/(<mark[^>]*>.*?<\/mark>)/gi)
      .map((part, index) => {
        // Even-indexed parts are plain text; odd-indexed parts are <mark> tags.
        if (index % 2 === 1) return part
        return textToSafeHtml(part)
      })
      .join('')
  }, [highlightKeywords, textToSafeHtml])

  // 将 HTML 转换为纯文本（提取换行符）
  const htmlToText = useCallback((html: string): string => {
    if (!html) return ''

    // 创建临时元素解析 HTML
    const temp = document.createElement('div')
    temp.innerHTML = html

    // 处理 <br> 标签为换行
    const brs = temp.querySelectorAll('br')
    brs.forEach(br => {
      br.replaceWith('\n')
    })

    // 处理 <p> 和 <div> 标签为换行
    const paragraphs = temp.querySelectorAll('p, div')
    paragraphs.forEach(p => {
      const prevText = p.previousSibling?.nodeType === Node.TEXT_NODE ? p.previousSibling.textContent : ''
      if (prevText && !prevText.endsWith('\n') && prevText.length > 0) {
        p.before('\n')
      }
      const text = p.textContent || ''
      if (text && !text.endsWith('\n')) {
        p.after('\n')
      }
    })

    // 获取文本并清理
    let text = temp.textContent || ''

    // 清理 HTML 实体
    text = text
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/\u200B/g, '')

    return text
  }, [])

  // 进入编辑模式时初始化内容
  useEffect(() => {
    const prevEditingField = wasEditingRef.current
    wasEditingRef.current = editingField

    if (editingField === 'title') {
      const isEnteringEdit = !hasInitializedEditRef.current.title
      if (isEnteringEdit) {
        editingTitleRef.current = node.title || ''
        hasInitializedEditRef.current.title = true
      }
      document.body.classList.add('allow-text-selection')
      const timer = setTimeout(() => {
        if (titleRef.current) {
          if (isEnteringEdit) {
            titleRef.current.innerHTML = textToSafeHtml(editingTitleRef.current)
          }
          titleRef.current.focus()
          const range = document.createRange()
          const selection = window.getSelection()
          if (titleRef.current.childNodes.length > 0) {
            range.selectNodeContents(titleRef.current)
            range.collapse(false)
          } else {
            range.setStart(titleRef.current, 0)
            range.collapse(true)
          }
          selection?.removeAllRanges()
          selection?.addRange(range)
          domReadyRef.current.title = true
        }
      }, 0)
      timerRefsRef.current.add(timer)
    } else if (editingField === 'content') {
      const isEnteringEdit = !hasInitializedEditRef.current.content
      if (isEnteringEdit) {
        // 内容字段是富文本 HTML，初始化时应清理而不是转义，否则 <br> 等标签会被二次转义。
        editingContentRef.current = cleanHtmlContent(node.content || '')
        hasInitializedEditRef.current.content = true
      }
      document.body.classList.add('allow-text-selection')
      const timer = setTimeout(() => {
        if (contentRef.current) {
          if (isEnteringEdit) {
            contentRef.current.innerHTML = editingContentRef.current
          }
          contentRef.current.focus()
          const range = document.createRange()
          const selection = window.getSelection()
          if (contentRef.current.childNodes.length > 0) {
            range.selectNodeContents(contentRef.current)
            range.collapse(false)
          } else {
            range.setStart(contentRef.current, 0)
            range.collapse(true)
          }
          selection?.removeAllRanges()
          selection?.addRange(range)
          domReadyRef.current.content = true
        }
      }, 0)
      timerRefsRef.current.add(timer)
    } else {
      document.body.classList.remove('allow-text-selection')
      hasInitializedEditRef.current = { title: false, content: false }
      domReadyRef.current = { title: false, content: false }
    }

    return () => {
      document.body.classList.remove('allow-text-selection')
    }
  }, [editingField, textToSafeHtml, cleanHtmlContent])

  const getTitleAlign = useCallback((node: Node, isCollapsed: boolean) => {
    if (isCollapsed) {
      const align = node.collapsedTitleAlign || node.titleAlign || node.textAlign
      return {
        textAlign: align,
        justifyContent: align === 'left' ? 'flex-start' :
          align === 'center' ? 'center' : 'flex-end'
      }
    }
    return {
      textAlign: node.titleAlign || node.textAlign,
      justifyContent: undefined
    }
  }, [])


  // 保存标题 - 纯文本处理，移除所有换行
  const saveTitle = useCallback(() => {
    if (inputSyncTimerRef.current) {
      clearTimeout(inputSyncTimerRef.current)
      inputSyncTimerRef.current = null
    }

    if (titleRef.current && isEditingTitle) {
      if (!domReadyRef.current.title) {
        logger.debug('[NodeItem] saveTitle skipped: DOM not ready yet')
        return
      }
      const temp = document.createElement('div')
      temp.innerHTML = titleRef.current.innerHTML
      const text = temp.textContent || ''
      const title = text.replace(/\n/g, '').replace(/\u200B/g, '').trim()

      // 注意: 这里不再用 editingTitleRef/node.title 内容判断"是否初始化异常"——
      // 初始化竞态已由上方 domReadyRef.current.title 检查覆盖(与 saveContent 一致)。
      // 旧的空值守卫会把用户"清空标题"当成初始化异常直接吞掉(D2)。
      if (title !== editingTitleRef.current) {
        const originalTitle = editingTitleRef.current
        updateNodeWithOriginal(node.id, { title }, { title: originalTitle })
        editingTitleRef.current = title
      }
    }
  }, [isEditingTitle, node.id, node.title, updateNodeWithOriginal])

  // 保存内容 - 保留富文本样式（HTML格式）
  const saveContent = useCallback(() => {
    if (inputSyncTimerRef.current) {
      clearTimeout(inputSyncTimerRef.current)
      inputSyncTimerRef.current = null
    }

    if (contentRef.current && isEditingContent) {
      if (!domReadyRef.current.content) {
        logger.debug('[NodeItem] saveContent skipped: DOM not ready yet')
        return
      }
      const cleanedHtml = cleanHtmlContent(contentRef.current.innerHTML)
      const tempDiv = document.createElement('div')
      tempDiv.innerHTML = cleanedHtml
      const textContent = tempDiv.textContent || ''
      const hasVisibleContent = textContent.replace(/\s+/g, '').trim().length > 0
      const hasLineBreaks = cleanedHtml.includes('<br')
      // contenteditable 清空后浏览器会留下占位 <br>，视为空内容（R3 #4）
      const isEmpty = (!hasVisibleContent && !hasLineBreaks) || cleanedHtml === '<br>'

      // 注意: 这里不再用 editingContentRef/node.content 内容判断"是否初始化异常"——
      // 初始化竞态已由上方 domReadyRef.current.content 检查覆盖（与 saveTitle 的 D2
      // 修复一致）。旧的空值守卫会把用户"清空内容"当成初始化异常直接吞掉，
      // 导致内容字段无法清空（R3 #4）。
      const trimmedContent = isEmpty ? '' : cleanedHtml
      if (trimmedContent !== editingContentRef.current) {
        const originalContent = editingContentRef.current
        updateNodeWithOriginal(node.id, { content: trimmedContent }, { content: originalContent })
        editingContentRef.current = trimmedContent
      }
    }
  }, [isEditingContent, node.id, node.content, updateNodeWithOriginal, cleanHtmlContent])

  // 切换编辑字段时重置目标字段的初始化状态，确保从最新的 store 值重新初始化 DOM
  // （修复 title↔content 切换后 editing ref 未重置导致的边界问题，D24）
  const resetFieldEditState = useCallback((field: 'title' | 'content') => {
    hasInitializedEditRef.current[field] = false
    domReadyRef.current[field] = false
  }, [])

  // Handle node selection
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Handle right click (allow bubbling for canvas pan)
      if (e.button === 2) {
        contextMenuStartRef.current = { x: e.clientX, y: e.clientY }
        return
      }

      // Only allow left mouse button for dragging and selection
      if (e.button !== 0) {
        return
      }

      // Viewer cannot edit
      if (isViewer) {
        e.stopPropagation()
        setSelectedIds([node.id])
        setSelectedType('node')
        return
      }

      if (editingField !== null) {
        if (quickEditMode && !node.locked) {
          const target = e.target as HTMLElement
          const fieldElement = target.closest('[data-field]') as HTMLElement
          const clickedField = fieldElement?.dataset.field as 'title' | 'content' | undefined

          if (clickedField && clickedField !== editingField) {
            if (clickedField === 'content' && node.type === 'image') {
              e.preventDefault()
              e.stopPropagation()
              return
            }
            e.preventDefault()
            e.stopPropagation()
            if (editingField === 'title') {
              saveTitle()
            } else if (editingField === 'content') {
              saveContent()
            }
            setEditingFieldForCollab(node.id, clickedField)
            resetFieldEditState(clickedField)
            setEditingField(clickedField)
            dispatchEditingFieldChange(clickedField, node.id)
            return
          }
        }
        e.preventDefault()
        e.stopPropagation()
        return
      }

      onMouseDown?.()
      e.stopPropagation()

      const target = e.target as HTMLElement
      const resizeTarget = target.closest('[data-resize]') as HTMLElement
      if (resizeTarget) {
        const direction = resizeTarget.dataset.resize
        setResizeDirection(direction)
        setIsResizing(true)
        resizeStartRef.current = {
          x: e.clientX,
          y: e.clientY,
          width: toFinite(node.width, NODE_DEFAULTS.WIDTH),
          height: toFinite(node.height, NODE_DEFAULTS.HEIGHT),
        }
        getYjsBinding()?.startInteraction(node.id, 'position')
        return
      }

      // Only allow selection and dragging in default selection mode
      if (!isDefaultSelectionTool(currentTool)) {
        return
      }

      // Quick edit mode: single click enters edit mode directly
      if (quickEditMode && !node.locked && !e.shiftKey) {
        const target = e.target as HTMLElement
        const fieldElement = target.closest('[data-field]') as HTMLElement
        const clickedField = fieldElement?.dataset.field as 'title' | 'content' | undefined

        let field: 'title' | 'content'
        if (clickedField === 'title') {
          field = 'title'
        } else if (clickedField === 'content') {
          if (node.type === 'image') {
            setSelectedIds([node.id])
            setSelectedType('node')
            return
          }
          field = 'content'
        } else {
          field = node.title && node.title.trim() !== '' ? 'content' : 'title'
          if (node.type === 'image' && field === 'content') {
            setSelectedIds([node.id])
            setSelectedType('node')
            return
          }
        }

        if (isEditingTitle) {
          saveTitle()
        } else if (isEditingContent) {
          saveContent()
        }
        setEditingFieldForCollab(node.id, field)
        resetFieldEditState(field)
        setEditingField(field)
        setEditingId(node.id)
        dispatchEditingFieldChange(field, node.id)
        return
      }

      if (e.shiftKey) {
        if (isSelected) {
          removeFromSelection(node.id)
        } else {
          addToSelection(node.id)
        }
      } else {
        setSelectedIds([node.id])
        setSelectedType('node')
      }

      if (!node.locked) {
        setIsDragging(true)
        dragStartRef.current = {
          x: e.clientX,
          y: e.clientY,
          nodeX: toFinite(node.x, 0),
          nodeY: toFinite(node.y, 0),
        }
        onDragStart?.(node.id, e)
        getYjsBinding()?.startInteraction(node.id, 'position')
        // 触发自定义事件，通知 CanvasPage 开始拖动
        window.dispatchEvent(new CustomEvent('nodeDragStart', {
          detail: { nodeId: node.id, x: node.x, y: node.y }
        }))
      }
    },
    [
      editingField,
      isSelected,
      node.locked,
      node.x,
      node.y,
      node.width,
      node.height,
      node.title,
      node.type,
      setSelectedIds,
      addToSelection,
      removeFromSelection,
      onDragStart,
      node.id,
      currentTool,
      quickEditMode,
      isEditingTitle,
      isEditingContent,
      saveTitle,
      saveContent,
      setSelectedType,
    ]
  )

  // Handle mouse move for dragging and resizing
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging && !node.locked) {
        e.preventDefault()
        const dx = (e.clientX - dragStartRef.current.x) / zoom
        const dy = (e.clientY - dragStartRef.current.y) / zoom
        let newPos = {
          x: dragStartRef.current.nodeX + dx,
          y: dragStartRef.current.nodeY + dy,
        }

        const { dragMode: currentDragMode } = useUIStore.getState()

        if (currentDragMode === 'grid') {
          const snappedPos = {
            x: snapToGrid(newPos.x, CANVAS_DEFAULTS.GRID_SIZE),
            y: snapToGrid(newPos.y, CANVAS_DEFAULTS.GRID_SIZE),
          }
          newPos = snappedPos
        }

        setLocalPosition(newPos)
        window.dispatchEvent(new CustomEvent('nodeDragMove', {
          detail: { nodeId: node.id, x: newPos.x, y: newPos.y }
        }))

        // Throttled store update during drag so Yjs binding syncs to peers.
        // markDirty=false: only the final mouseup should trigger autosave/cache.
        const now = Date.now()
        if (now - dragSyncThrottleRef.current >= 100) {
          dragSyncThrottleRef.current = now
          updateNodeWithoutHistory(node.id, { x: newPos.x, y: newPos.y }, false)
        }

        // 检测鼠标是否进入节点池区域
        const nodePoolElement = document.querySelector('[data-node-pool]')
        if (nodePoolElement) {
          const rect = nodePoolElement.getBoundingClientRect()
          const isOver = e.clientX >= rect.left && e.clientX <= rect.right &&
            e.clientY >= rect.top && e.clientY <= rect.bottom

          const { setIsOverNodePool, setCanvasDragGhostPosition, isOverNodePool: currentIsOverNodePool, setOverFolderId } = useUIStore.getState()

          if (isOver !== currentIsOverNodePool) {
            setIsOverNodePool(isOver)
          }

          if (isOver) {
            setCanvasDragGhostPosition({ x: e.clientX, y: e.clientY })

            // 检测是否悬停在文件夹上
            const folderElements = document.querySelectorAll('[data-folder-id]')
            let foundFolderId: number | null = null
            for (const el of folderElements) {
              const folderRect = el.getBoundingClientRect()
              if (e.clientX >= folderRect.left && e.clientX <= folderRect.right &&
                e.clientY >= folderRect.top && e.clientY <= folderRect.bottom) {
                const folderId = el.getAttribute('data-folder-id')
                if (folderId) {
                  const parsedId = parseInt(folderId, 10)
                  if (!isNaN(parsedId)) {
                    foundFolderId = parsedId
                    break
                  }
                }
              }
            }
            setOverFolderId(foundFolderId)
          } else {
            setCanvasDragGhostPosition(null)
            setOverFolderId(null)
          }
        }
      }

      if (isResizing) {
        e.preventDefault()
        const dx = (e.clientX - resizeStartRef.current.x) / zoom
        const dy = (e.clientY - resizeStartRef.current.y) / zoom

        let newWidth = resizeStartRef.current.width
        let newHeight = resizeStartRef.current.height
        let newX = localPosition.x
        let newY = localPosition.y

        if (resizeDirection.includes('e')) {
          newWidth = Math.max(NODE_DEFAULTS.MIN_WIDTH, resizeStartRef.current.width + dx)
        }
        if (resizeDirection.includes('w')) {
          newWidth = Math.max(NODE_DEFAULTS.MIN_WIDTH, resizeStartRef.current.width - dx)
          newX = dragStartRef.current.nodeX + dx
        }
        if (resizeDirection.includes('s')) {
          newHeight = Math.max(NODE_DEFAULTS.MIN_HEIGHT, resizeStartRef.current.height + dy)
        }
        if (resizeDirection.includes('n')) {
          newHeight = Math.max(NODE_DEFAULTS.MIN_HEIGHT, resizeStartRef.current.height - dy)
          newY = dragStartRef.current.nodeY + dy
        }

        // 只更新本地状态
        setLocalPosition({ x: newX, y: newY })
        setLocalSize({ width: newWidth, height: newHeight })

        // Throttled store update during resize so Yjs binding syncs to peers.
        // markDirty=false: only the final mouseup should trigger autosave/cache.
        const now = Date.now()
        if (now - resizeSyncThrottleRef.current >= 100) {
          resizeSyncThrottleRef.current = now
          updateNodeWithoutHistory(node.id, { x: newX, y: newY, width: newWidth, height: newHeight }, false)
        }
      }
    }

    const handleMouseUp = () => {
      if (isDragging || isResizing) {
        // 拖动/调整大小时才更新全局状态
        if (isDragging) {
          // 检查是否在节点池区域释放
          const { isOverNodePool, setDraggingNodeFromCanvas, setIsOverNodePool, setCanvasDragGhostPosition, overFolderId, setOverFolderId } = useUIStore.getState()

          if (isOverNodePool) {
            // 在节点池区域释放，触发添加到节点池的事件
            window.dispatchEvent(new CustomEvent('nodeDragEnd', {
              detail: { nodeId: node.id, droppedInNodePool: true, targetFolderId: overFolderId }
            }))
            // 重置状态
            setDraggingNodeFromCanvas(null)
            setIsOverNodePool(false)
            setCanvasDragGhostPosition(null)
            setOverFolderId(null)
            getYjsBinding()?.endInteraction(node.id)
          } else {
            // 先结束交互并 flush 被推迟的远程位置，再用本地最终位置覆盖；
            // 这样用户拖拽的结果优先于远端协作位置。
            getYjsBinding()?.endInteraction(node.id)
            // 正常释放，更新节点位置（从 ref 读取避免 effect 依赖本地 state）
            const finalPosition = localPositionRef.current
            const finalSize = localSizeRef.current
            updateNode(node.id, {
              x: finalPosition.x,
              y: finalPosition.y,
            })
            // 设置标志，防止 useEffect 立即重置位置
            justFinishedDragRef.current = true
            // 更新 lastSyncedNodeRef 为新位置，防止被覆盖
            lastSyncedNodeRef.current = { x: finalPosition.x, y: finalPosition.y, width: finalSize.width, height: finalSize.height }
            // 延迟清除标志，允许 React 状态更新完成
            const timer = setTimeout(() => {
              justFinishedDragRef.current = false
            }, 200)
            timerRefsRef.current.add(timer)
            // 触发自定义事件，通知 CanvasPage 结束拖动
            window.dispatchEvent(new CustomEvent('nodeDragEnd', {
              detail: { nodeId: node.id, droppedInNodePool: false }
            }))
            // 重置拖拽状态
            setDraggingNodeFromCanvas(null)
            setCanvasDragGhostPosition(null)
          }
        }
        if (isResizing) {
          // End interaction first so the local final size takes precedence
          // over any deferred remote position/size updates.
          getYjsBinding()?.endInteraction(node.id)
          const finalPosition = localPositionRef.current
          const finalSize = localSizeRef.current
          updateNode(node.id, {
            x: finalPosition.x,
            y: finalPosition.y,
            width: finalSize.width,
            height: finalSize.height,
          })
          justFinishedDragRef.current = true
          const timer = setTimeout(() => {
            justFinishedDragRef.current = false
          }, 100)
          timerRefsRef.current.add(timer)
        }
        setIsDragging(false)
        setIsResizing(false)
        setResizeDirection('')
        dragSyncThrottleRef.current = 0
        resizeSyncThrottleRef.current = 0
        onDragEnd?.()
      }
    }

    if (isDragging || isResizing) {
      // 禁用文本选择
      document.body.style.userSelect = 'none'
      window.addEventListener('mousemove', handleMouseMove, { passive: false })
      window.addEventListener('mouseup', handleMouseUp)

      return () => {
        // 恢复文本选择
        document.body.style.userSelect = ''
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)
      }
    }
  }, [isDragging, isResizing, resizeDirection, node.id, node.locked, zoom, updateNode, onDragEnd])

  // Handle double click to edit
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent, field?: 'title' | 'content') => {
      e.stopPropagation()
      if (node.locked || isViewer) return
      if (!field) {
        field = node.title && node.title.trim() !== '' ? 'content' : 'title'
      }

      // 对于图片节点，只允许编辑title，不允许编辑content
      if (node.type === 'image' && field === 'content') {
        return
      }

      // Save current editing content before switching fields
      if (isEditingTitle) {
        saveTitle()
      } else if (isEditingContent) {
        saveContent()
      }

      setEditingFieldForCollab(node.id, field)
      // 同字段重复双击（如正在编辑 content 时再次双击 content）不重置初始化状态：
      // 此时 editingField 未变、初始化 effect 不会重跑，重置 domReadyRef 会导致
      // 本次编辑的保存被"DOM not ready"跳过，改动丢失（R3 #3）
      if (!((isEditingTitle && field === 'title') || (isEditingContent && field === 'content'))) {
        resetFieldEditState(field)
      }
      setEditingField(field)
      setEditingId(node.id)
      dispatchEditingFieldChange(field, node.id)
    },
    [node.locked, node.title, node.type, isEditingTitle, isEditingContent, saveTitle, saveContent, isViewer, node.id, dispatchEditingFieldChange, resetFieldEditState]
  )

  // 中文输入法开始
  const handleCompositionStart = useCallback(() => {
    setIsComposing(true)
    if (inputSyncTimerRef.current) {
      clearTimeout(inputSyncTimerRef.current)
      inputSyncTimerRef.current = null
    }
  }, [])

  // 中文输入法结束
  const handleCompositionEnd = useCallback(() => {
    setIsComposing(false)
  }, [])

  // 不做状态更新，避免光标跳动
  const handleInputChange = useCallback(() => {
    if (isComposing) return
    if (inputSyncTimerRef.current) {
      clearTimeout(inputSyncTimerRef.current)
    }

    inputSyncTimerRef.current = setTimeout(() => {
      const currentField = editingField
      if (!currentField) return

      if (currentField === 'title' && titleRef.current) {
        const temp = document.createElement('div')
        temp.innerHTML = titleRef.current.innerHTML
        const text = temp.textContent || ''
        const title = text.replace(/\n/g, '').replace(/\u200B/g, '').trim()
        if (title && title !== editingTitleRef.current) {
          setLocalEditingUpdate(true)
          try {
            updateNodeWithoutHistory(node.id, { title })
          } finally {
            setLocalEditingUpdate(false)
          }
        }
      } else if (currentField === 'content' && contentRef.current) {
        const cleanedHtml = cleanHtmlContent(contentRef.current.innerHTML)
        const tempDiv = document.createElement('div')
        tempDiv.innerHTML = cleanedHtml
        const textContent = tempDiv.textContent || ''
        const hasVisibleContent = textContent.replace(/\s+/g, '').trim().length > 0
        const hasLineBreaks = cleanedHtml.includes('<br')
        const isEmpty = !hasVisibleContent && !hasLineBreaks
        const content = isEmpty ? '' : cleanedHtml
        if (content !== editingContentRef.current) {
          setLocalEditingUpdate(true)
          try {
            updateNodeWithoutHistory(node.id, { content })
          } finally {
            setLocalEditingUpdate(false)
          }
        }
      }
    }, 300)
  }, [editingField, node.id, updateNodeWithoutHistory, cleanHtmlContent, isComposing])

  // 手动插入换行，确保光标位置正确
  const insertLineBreakManually = useCallback(() => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return

    const range = selection.getRangeAt(0)
    range.deleteContents()

    const br = document.createElement('br')
    range.insertNode(br)

    const zeroWidthSpace = document.createTextNode('\u200B')
    range.setStartAfter(br)
    range.insertNode(zeroWidthSpace)

    range.setStartBefore(zeroWidthSpace)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  }, [])

  // Handle key down
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, field: 'title' | 'content') => {
      if (isComposing) return

      // Prevent delete and backspace from bubbling up when editing
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.stopPropagation()
        return
      }

      if (e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        execFormatCommand('insertText', '  ')
        return
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        if (field === 'title') {
          saveTitle()
        } else {
          saveContent()
        }
        setEditingFieldForCollab(null, null)
        setEditingField(null)
        dispatchEditingFieldChange(null, null)
      } else if (e.key === 'Enter') {
        // Shift+Enter 或 Ctrl+Enter/Meta+Enter：换行不退出
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          e.preventDefault()
          insertLineBreakManually()
          return
        }
        e.preventDefault()
        // 纯 Enter：结束编辑并保存
        if (field === 'title') {
          saveTitle()
        } else {
          saveContent()
        }
        setEditingFieldForCollab(null, null)
        setEditingField(null)
        dispatchEditingFieldChange(null, null)
      }
    },
    [isComposing, saveTitle, saveContent, insertLineBreakManually, dispatchEditingFieldChange]
  )

  // Handle paste - 统一处理 HTML 和纯文本，保留换行格式
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault()

    // 获取剪贴板中的 HTML 和纯文本
    const htmlData = e.clipboardData.getData('text/html')
    const textData = e.clipboardData.getData('text/plain')

    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return

    const range = selection.getRangeAt(0)

    // 优先使用纯文本，统一转换为 HTML 格式
    const text = textData || (htmlData ? htmlToText(htmlData) : '')
    if (text) {
      const html = textToSafeHtml(text)
      const temp = document.createElement('div')
      temp.innerHTML = html

      range.deleteContents()
      // 使用 DocumentFragment 一次性插入所有节点，保持正确顺序
      const fragment = document.createDocumentFragment()
      Array.from(temp.childNodes).forEach(node => {
        fragment.appendChild(node.cloneNode(true))
      })
      range.insertNode(fragment)
      range.collapse(false)
      selection.removeAllRanges()
      selection.addRange(range)
    }
  }, [htmlToText, textToSafeHtml])

  // 失焦时保存
  const handleBlur = useCallback((field: 'title' | 'content', e?: React.FocusEvent) => {
    if (field === 'title' && isEditingTitle) {
      saveTitle()
    } else if (field === 'content' && isEditingContent) {
      saveContent()
    }

    // 检查焦点是否转移到了富文本工具栏
    if (e?.relatedTarget) {
      const target = e.relatedTarget as HTMLElement
      // 向上查找是否在富文本工具栏内
      let current = target
      while (current && current !== document.body) {
        if (current.classList.contains('fixed') &&
          current.classList.contains('bg-white') &&
          current.classList.contains('border-gray-200')) {
          // 焦点转移到了富文本工具栏，不清除编辑状态
          return
        }
        current = current.parentElement
      }
    }

    setEditingFieldForCollab(null, null)
    setEditingField(null)
    setEditingId(null)
    dispatchEditingFieldChange(null, null)
  }, [isEditingTitle, isEditingContent, saveTitle, saveContent, setEditingId, dispatchEditingFieldChange])

  // Handle wheel event on content area - prevent canvas zoom when content is scrollable
  const handleContentWheel = useCallback((e: React.WheelEvent) => {
    const contentArea = contentAreaRef.current
    if (!contentArea) return

    // Check if content area is scrollable
    const isScrollable = contentArea.scrollHeight > contentArea.clientHeight
    if (!isScrollable) return

    // Always stop propagation when content area is scrollable
    // This prevents canvas zoom when scrolling node content
    e.stopPropagation()
  }, [])

  // Handle context menu
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (editingField !== null || isViewer) return
      e.preventDefault()
      e.stopPropagation()

      // Use mouse position with a small offset
      // This ensures the menu appears close to where the user clicked
      const dx = e.clientX - contextMenuStartRef.current.x
      const dy = e.clientY - contextMenuStartRef.current.y
      if (Math.hypot(dx, dy) > 5) return

      if (onNodeContextMenuOpen) {
        onNodeContextMenuOpen(e.clientX + 5, e.clientY + 5, node.id)
      }

      if (!isSelected) {
        setSelectedIds([node.id])
      }
    },
    [editingField, isSelected, node.id, setSelectedIds, onNodeContextMenuOpen]
  )

  // Toggle collapsed state
  const toggleCollapsed = useCallback(() => {
    const newCollapsed = !node.collapsed
    const safeWidth = toFinite(node.width, NODE_DEFAULTS.WIDTH)

    if (newCollapsed) {
      const safeHeight = toFinite(node.height, NODE_DEFAULTS.HEIGHT)
      updateNode(node.id, {
        collapsed: newCollapsed,
        expandedHeight: safeHeight,
        height: 36
      })
      setLocalSize({ width: safeWidth, height: 36 })
    } else {
      const expandedHeight = toFinite(node.expandedHeight, toFinite(node.height, NODE_DEFAULTS.HEIGHT))
      updateNode(node.id, {
        collapsed: newCollapsed,
        height: expandedHeight
      })
      setLocalSize({ width: safeWidth, height: expandedHeight })
    }
  }, [node.id, node.collapsed, node.height, node.expandedHeight, node.width, updateNode])

  // Sync with global editing state
  useEffect(() => {
    if (globalEditingId === node.id && editingField === null) {
      setEditingFieldForCollab(node.id, 'content')
      setEditingField('content')
      dispatchEditingFieldChange('content', node.id)
    } else if (globalEditingId !== node.id && editingField !== null) {
      const currentState = getEditingState()
      if (currentState.nodeId === node.id) {
        setEditingFieldForCollab(null, null)
      }
      if (editingField === 'title') {
        saveTitle()
      } else if (editingField === 'content') {
        saveContent()
      }
      setEditingField(null)
      dispatchEditingFieldChange(null, null)
    }
  }, [globalEditingId, node.id, editingField, saveTitle, saveContent, dispatchEditingFieldChange])

  // 检查当前节点是否正在被拖拽到节点池
  const isBeingDraggedToPool = draggingNodeFromCanvas?.nodeId === node.id && isOverNodePool

  // 内容为空时显示占位符，但不要把占位符写进 node.content
  const isContentEmpty = useMemo(() => isVisuallyEmpty(node.content), [node.content])
  const displayContent = isContentEmpty ? '双击添加内容' : (node.content || '')
  const contentPreviewStyle = {
    minHeight: '40px',
    wordBreak: 'break-word' as const,
    lineHeight: '1.6',
    whiteSpace: 'pre-wrap' as const,
    fontSize: `${node.fontSize}px`,
    textAlign: node.contentAlign || node.textAlign,
  }

  return (
    <>
      {/* 全局样式已由 ensureNodeItemStyles() 注入一次（D12） */}
      {/* Wrapper for node and resize handles */}
      <div
        style={{
          position: 'absolute',
          left: toFinite((groupDragOffset ? localPosition.x + groupDragOffset.x : localPosition.x) - 16, -16),
          top: toFinite((groupDragOffset ? localPosition.y + groupDragOffset.y : localPosition.y) - 16, -16),
          width: toFinite(localSize.width + 32, NODE_DEFAULTS.WIDTH + 32),
          height: toFinite(localSize.height + 32, NODE_DEFAULTS.HEIGHT + 32),
          opacity: isBeingDraggedToPool ? 0 : opacity,
          visibility: isBeingDraggedToPool ? 'hidden' : 'visible',
          transition: 'opacity 0.2s ease',
        }}
      >
        {/* Resize handles - outside node container */}
        {(isSelected || isHovered) && editingField === null && !node.locked && !node.collapsed && (
          <>
            <div
              data-resize="nw"
              className="absolute cursor-nw-resize"
              style={{
                top: 6,
                left: 6,
                width: 16,
                height: 16,
                zIndex: Z_INDEX.NODE,
              }}
              onMouseDown={(e) => {
                e.stopPropagation()
                e.preventDefault()
                setResizeDirection('nw')
                setIsResizing(true)
                resizeStartRef.current = {
                  x: e.clientX,
                  y: e.clientY,
                  width: toFinite(node.width, NODE_DEFAULTS.WIDTH),
                  height: toFinite(node.height, NODE_DEFAULTS.HEIGHT),
                }
                dragStartRef.current = {
                  x: e.clientX,
                  y: e.clientY,
                  nodeX: toFinite(node.x, 0),
                  nodeY: toFinite(node.y, 0),
                }
                getYjsBinding()?.startInteraction(node.id, 'position')
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M 10 6 L 6 6 L 6 10" stroke="#3b82f6" strokeWidth="2" fill="none" strokeLinecap="round" />
              </svg>
            </div>
            <div
              data-resize="ne"
              className="absolute cursor-ne-resize"
              style={{
                top: 6,
                right: 6,
                width: 16,
                height: 16,
                zIndex: Z_INDEX.NODE,
              }}
              onMouseDown={(e) => {
                e.stopPropagation()
                e.preventDefault()
                setResizeDirection('ne')
                setIsResizing(true)
                resizeStartRef.current = {
                  x: e.clientX,
                  y: e.clientY,
                  width: toFinite(node.width, NODE_DEFAULTS.WIDTH),
                  height: toFinite(node.height, NODE_DEFAULTS.HEIGHT),
                }
                dragStartRef.current = {
                  x: e.clientX,
                  y: e.clientY,
                  nodeX: toFinite(node.x, 0),
                  nodeY: toFinite(node.y, 0),
                }
                getYjsBinding()?.startInteraction(node.id, 'position')
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M 6 6 L 10 6 L 10 10" stroke="#3b82f6" strokeWidth="2" fill="none" strokeLinecap="round" />
              </svg>
            </div>
            <div
              data-resize="sw"
              className="absolute cursor-sw-resize"
              style={{
                bottom: 6,
                left: 6,
                width: 16,
                height: 16,
                zIndex: Z_INDEX.NODE,
              }}
              onMouseDown={(e) => {
                e.stopPropagation()
                e.preventDefault()
                setResizeDirection('sw')
                setIsResizing(true)
                resizeStartRef.current = {
                  x: e.clientX,
                  y: e.clientY,
                  width: toFinite(node.width, NODE_DEFAULTS.WIDTH),
                  height: toFinite(node.height, NODE_DEFAULTS.HEIGHT),
                }
                dragStartRef.current = {
                  x: e.clientX,
                  y: e.clientY,
                  nodeX: toFinite(node.x, 0),
                  nodeY: toFinite(node.y, 0),
                }
                getYjsBinding()?.startInteraction(node.id, 'position')
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M 10 10 L 6 10 L 6 6" stroke="#3b82f6" strokeWidth="2" fill="none" strokeLinecap="round" />
              </svg>
            </div>
            <div
              data-resize="se"
              className="absolute cursor-se-resize"
              style={{
                bottom: 6,
                right: 6,
                width: 16,
                height: 16,
                zIndex: Z_INDEX.NODE,
              }}
              onMouseDown={(e) => {
                e.stopPropagation()
                e.preventDefault()
                setResizeDirection('se')
                setIsResizing(true)
                resizeStartRef.current = {
                  x: e.clientX,
                  y: e.clientY,
                  width: toFinite(node.width, NODE_DEFAULTS.WIDTH),
                  height: toFinite(node.height, NODE_DEFAULTS.HEIGHT),
                }
                dragStartRef.current = {
                  x: e.clientX,
                  y: e.clientY,
                  nodeX: toFinite(node.x, 0),
                  nodeY: toFinite(node.y, 0),
                }
                getYjsBinding()?.startInteraction(node.id, 'position')
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M 6 10 L 10 10 L 10 6" stroke="#3b82f6" strokeWidth="2" fill="none" strokeLinecap="round" />
              </svg>
            </div>
          </>
        )}

        {/* Node shadow container - carries boxShadow, no overflow clipping */}
        <div
          data-node-id={node.id}
          className={`node-item absolute shadow-sm ${isDragging ? 'node-dragging' : node.locked ? 'cursor-not-allowed' : editingField !== null ? 'cursor-text' : 'cursor-move'
            } ${isDragging ? 'shadow-2xl scale-[1.01]' : ''} ${isHovered && !isSelected && !node.locked ? 'shadow-md' : ''
            } ${isDragging || isResizing || groupDragOffset ? '' : 'transition-all duration-200'}`}
          style={{
            cursor: isDragging ? 'move' : undefined,
            left: 16,
            top: 16,
            width: toFinite(localSize.width, NODE_DEFAULTS.WIDTH),
            height: toFinite(localSize.height, NODE_DEFAULTS.HEIGHT),
            boxShadow: isSelected
              ? '0 4px 12px rgba(0, 0, 0, 0.15)'
              : isDragging || groupDragOffset
                ? '0 4px 12px rgba(0, 0, 0, 0.1)'
                : '0 1px 3px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.04)',
            zIndex: Z_INDEX.NODE,
          }}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          {/* Node content container - overflow: hidden clips content to bounds */}
          <div
            ref={nodeRef}
            style={{
              width: '100%',
              height: '100%',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              backgroundColor: node.type === 'image' ? '#ffffff' : node.color,
              borderRadius: 'inherit',
            }}
            onMouseDown={handleMouseDown}
            onClick={(e) => {
              if (editingField !== null) {
                e.stopPropagation()
                return
              }

              if (currentTool === 'connection') {
                const connectionStartEvent = new CustomEvent('connectionStart', {
                  detail: {
                    nodeId: node.id,
                    mouseX: e.clientX,
                    mouseY: e.clientY,
                  },
                  bubbles: true,
                })
                e.currentTarget.dispatchEvent(connectionStartEvent)
              } else {
                e.stopPropagation()
              }
            }}
            onDoubleClick={(e) => {
              // 对于图片节点，根元素双击只允许编辑title
              if (node.type === 'image') {
                handleDoubleClick(e, 'title')
              } else {
                handleDoubleClick(e)
              }
            }}
            onContextMenu={handleContextMenu}
          >
          {/* Node content */}
          {node.collapsed ? (
            // 折叠状态 - 只显示标题，支持编辑
            isEditingTitle ? (
              <div
                ref={titleRef}
                contentEditable
                suppressContentEditableWarning
                className="w-full h-full flex items-center px-3 text-sm truncate font-semibold"
                style={{
                  fontSize: node.fontSize + 2,
                  ...getTitleAlign(node, true),
                  outline: 'none',
                }}
                onInput={handleInputChange}
                onKeyDown={(e) => handleKeyDown(e, 'title')}
                onCompositionStart={handleCompositionStart}
                onCompositionEnd={handleCompositionEnd}
                onPaste={handlePaste}
                onBlur={(e) => handleBlur('title', e)}
                onMouseDown={(e) => e.stopPropagation()}
              />
            ) : (
              <div
                className="w-full h-full flex items-center px-3 text-sm truncate cursor-text font-semibold"
                style={{
                  fontSize: node.fontSize + 2,
                  ...getTitleAlign(node, true),
                }}
                onDoubleClick={(e) => handleDoubleClick(e, 'title')}
                title={node.title || stripHtml(node.content) || ''}
              >
                {node.title || stripHtml(node.content) || '双击添加标题'}
              </div>
            )
          ) : node.type === 'image' ? (
            // Image Type Logic
            <div className="w-full h-full flex flex-col">
              {/* Title Area */}
              <div
                data-field="title"
                className="flex-shrink-0 px-4 py-2.5 border-b border-gray-100 dark:border-gray-700/50 bg-white dark:bg-gray-800"
                style={{ minHeight: '36px' }}
              >
                {isEditingTitle ? (
                  <div
                    ref={titleRef}
                    contentEditable
                    suppressContentEditableWarning
                    className="font-semibold"
                    style={{
                      minHeight: '24px',
                      outline: 'none',
                      fontSize: `${node.fontSize + 2}px`,
                      textAlign: node.titleAlign || node.textAlign,
                    }}
                    onInput={handleInputChange}
                    onKeyDown={(e) => handleKeyDown(e, 'title')}
                    onCompositionStart={handleCompositionStart}
                    onCompositionEnd={handleCompositionEnd}
                    onPaste={handlePaste}
                    onBlur={(e) => handleBlur('title', e)}
                    onMouseDown={(e) => e.stopPropagation()}
                  />
                ) : (
                  <div
                    className="font-semibold"
                    style={{
                      minHeight: '24px',
                      fontSize: `${node.fontSize + 2}px`,
                      textAlign: node.titleAlign || node.textAlign,
                      whiteSpace: 'pre-wrap',
                    }}
                    onDoubleClick={(e) => handleDoubleClick(e, 'title')}
                    dangerouslySetInnerHTML={{ __html: highlightState?.keywords ? safeHighlightTitle(node.title || '', highlightState.keywords) : textToSafeHtml(node.title || '') }}
                  />
                )}
              </div>

              {/* Image Content Area */}
              <div className="flex-1 overflow-hidden relative group/image">
                {node.imageUrl ? (
                  <>
                    <img
                      src={node.imageUrl}
                      alt={node.title || 'Node Image'}
                      className="w-full h-full object-contain pointer-events-none"
                    />
                    {!node.locked && (
                      <div className="absolute inset-0 bg-black/50 opacity-0 group-hover/image:opacity-100 flex items-center justify-center transition-opacity duration-200">
                        <label className="cursor-pointer bg-white text-gray-800 px-3 py-1.5 rounded-md text-sm font-medium hover:bg-gray-100 transition-colors shadow-lg">
                          更换图片
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => {
                              const file = e.target.files?.[0]
                              if (file) {
                                handleImageUpload(file)
                              }
                            }}
                          />
                        </label>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-gray-50 dark:bg-gray-800/50">
                    <label className="cursor-pointer flex flex-col items-center gap-2 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition-colors p-4">
                      <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                      </svg>
                      <span className="text-sm font-medium">上传图片</span>
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          if (file) {
                            handleImageUpload(file)
                          }
                        }}
                      />
                    </label>
                  </div>
                )}
              </div>
            </div>
          ) : (
            // Text Type Logic (Default)
            <div className="w-full h-full flex flex-col">
              {/* 标题区域 */}
              <div
                data-field="title"
                className="flex-shrink-0 px-4 py-2.5 border-b border-gray-100 dark:border-gray-700/50"
                style={{ minHeight: '36px' }}
              >
                {isEditingTitle ? (
                  <div
                    ref={titleRef}
                    contentEditable
                    suppressContentEditableWarning
                    className="font-semibold"
                    style={{
                      minHeight: '24px',
                      outline: 'none',
                      fontSize: `${node.fontSize + 2}px`,
                      textAlign: node.titleAlign || node.textAlign,
                      whiteSpace: 'pre-wrap',
                    }}
                    onInput={handleInputChange}
                    onKeyDown={(e) => handleKeyDown(e, 'title')}
                    onCompositionStart={handleCompositionStart}
                    onCompositionEnd={handleCompositionEnd}
                    onPaste={handlePaste}
                    onBlur={(e) => handleBlur('title', e)}
                    onMouseDown={(e) => e.stopPropagation()}
                  />
                ) : (
                  <div
                    className="font-semibold"
                    style={{
                      minHeight: '24px',
                      fontSize: `${node.fontSize + 2}px`,
                      textAlign: node.titleAlign || node.textAlign,
                      whiteSpace: 'pre-wrap',
                    }}
                    onDoubleClick={(e) => handleDoubleClick(e, 'title')}
                    dangerouslySetInnerHTML={{ __html: highlightState?.keywords ? safeHighlightTitle(node.title || '', highlightState.keywords) : textToSafeHtml(node.title || '') }}
                  />
                )}
              </div>

              {/* 内容区域 */}
              <div
                ref={contentAreaRef}
                data-field="content"
                className="flex-1 p-4 overflow-auto"
                onWheel={handleContentWheel}
              >
                {isEditingContent ? (
                  <div
                    ref={contentRef}
                    contentEditable
                    suppressContentEditableWarning
                    style={{
                      minHeight: '60px',
                      outline: 'none',
                      fontSize: `${node.fontSize}px`,
                      textAlign: node.contentAlign || node.textAlign,
                      wordBreak: 'break-word',
                      lineHeight: '1.6',
                      whiteSpace: 'pre-wrap',
                    }}
                    onInput={handleInputChange}
                    onKeyDown={(e) => handleKeyDown(e, 'content')}
                    onCompositionStart={handleCompositionStart}
                    onCompositionEnd={handleCompositionEnd}
                    onPaste={handlePaste}
                    onBlur={(e) => handleBlur('content', e)}
                    onMouseDown={(e) => e.stopPropagation()}
                  />
                ) : isContentEmpty ? (
                  <div
                    style={contentPreviewStyle}
                    className="node-content-placeholder"
                    onDoubleClick={(e) => handleDoubleClick(e, 'content')}
                  >
                    双击添加内容
                  </div>
                ) : (
                  <div
                    style={contentPreviewStyle}
                    onDoubleClick={(e) => handleDoubleClick(e, 'content')}
                    dangerouslySetInnerHTML={{ __html: highlightState?.keywords ? safeHighlightHtml(cleanHtmlContent(displayContent), highlightState.keywords) : cleanHtmlContent(displayContent) }}
                  />
                )}
              </div>
            </div>
          )}

          {/* Collapse/Expand button */}
          {editingField === null && (
            <button
              className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center bg-white/90 dark:bg-gray-800/90 hover:bg-white dark:hover:bg-gray-800 rounded-full shadow-md hover:shadow-lg border border-gray-200 dark:border-gray-600 transition-all duration-200 hover:scale-110 active:scale-95 group"
              onClick={(e) => {
                e.stopPropagation()
                toggleCollapsed()
              }}
              title={node.collapsed ? '展开' : '折叠'}
            >
              <svg
                className={`w-3 h-3 text-gray-600 dark:text-gray-300 transition-transform duration-200 ${node.collapsed ? 'rotate-0' : 'rotate-180'}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={2.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          )}

          {/* Lock indicator */}
          {node.locked && (
            <div className="absolute top-1 left-1 w-4 h-4 flex items-center justify-center">
              <svg
                className="w-3 h-3 text-gray-500"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
          )}
        </div>
        </div>
        {/* End node shadow container */}
      </div>
      {/* End wrapper for node and resize handles */}
    </>
  )
})
