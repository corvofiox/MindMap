import { useState, useRef, useEffect, useCallback } from 'react'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useUIStore } from '@/store/useUIStore'
import { snapToGrid } from '@/utils/canvas'
import { CANVAS_DEFAULTS, Z_INDEX } from '@/constants'
import { loadApiModule } from '@/utils/moduleLoader'
import type { Node } from '@/types'

// Helper function to check if in default selection mode
function isDefaultSelectionTool(tool: string): boolean {
  return tool === 'select'
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
}

type EditingField = 'title' | 'content' | null

export function NodeItem({ node, isSelected, zoom, onDragStart, onDragEnd, groupDragOffset, onNodeContextMenuOpen, onMouseDown }: NodeItemProps) {
  const {
    updateNode,
    setSelectedIds,
    removeNode,
    addToSelection,
    removeFromSelection,
    editingId: globalEditingId,
    setEditingId,
  } = useCanvasStore()

  const { setSelectedType, currentTool, draggingNodeFromCanvas, isOverNodePool } = useUIStore()

  const [isDragging, setIsDragging] = useState(false)
  const [isResizing, setIsResizing] = useState(false)
  const [resizeDirection, setResizeDirection] = useState<string>('')
  const [isComposing, setIsComposing] = useState(false)
  const [editingField, setEditingField] = useState<EditingField>(null)
  const [isHovered, setIsHovered] = useState(false)
  // 本地状态用于拖动时的实时更新，避免频繁更新全局状态
  const [localPosition, setLocalPosition] = useState({ x: node.x, y: node.y })
  const [localSize, setLocalSize] = useState({ width: node.width, height: node.height })

  const nodeRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const dragStartRef = useRef({ x: 0, y: 0, nodeX: node.x, nodeY: node.y })
  const resizeStartRef = useRef({ x: 0, y: 0, width: node.width, height: node.height })
  const justFinishedDragRef = useRef(false)
  const lastSyncedNodeRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const editingTitleRef = useRef<string>('')
  const editingContentRef = useRef<string>('')
  const contextMenuStartRef = useRef({ x: 0, y: 0 })
  const { addToast } = useUIStore()

  // Image Upload Handler
  const handleImageUpload = useCallback(async (file: File) => {
    try {
      // 使用 import.meta.glob 预加载的模块
      const apiModule = await loadApiModule()
      const { uploadImage } = apiModule
      const { url } = await uploadImage(file)

      // Load image to get dimensions
      const img = new Image()
      img.src = url
      img.onload = () => {
        const aspectRatio = img.width / img.height
        updateNode(node.id, {
          imageUrl: url,
          aspectRatio: aspectRatio,
          type: 'image',
          height: node.width / aspectRatio
        })
        addToast({ type: 'success', title: '上传成功', message: '图片已上传' })
      }
    } catch (error) {
      addToast({
        type: 'error',
        title: '上传失败',
        message: error instanceof Error ? error.message : '上传图片失败，请重试',
      })
    }
  }, [node.id, node.width, updateNode, addToast])

  const isEditingTitle = editingField === 'title'
  const isEditingContent = editingField === 'content'

  useEffect(() => {
    if (editingField !== null) return

    if (!isDragging && !isResizing) {
      const shouldSync = !lastSyncedNodeRef.current ||
        lastSyncedNodeRef.current.x !== node.x ||
        lastSyncedNodeRef.current.y !== node.y ||
        lastSyncedNodeRef.current.width !== node.width ||
        lastSyncedNodeRef.current.height !== node.height

      if (shouldSync) {
        setLocalPosition({ x: node.x, y: node.y })
        setLocalSize({ width: node.width, height: node.height })
        lastSyncedNodeRef.current = { x: node.x, y: node.y, width: node.width, height: node.height }
      }
    }
  }, [node.x, node.y, node.width, node.height, isDragging, isResizing, editingField])

  // 将文本转换为安全HTML（转义HTML标签，保留换行）
  const textToSafeHtml = useCallback((text: string): string => {
    if (!text) return ''

    // 检查是否包含 HTML 标签
    const hasHtmlTags = /<[a-z][\s\S]*>/i.test(text)

    if (hasHtmlTags) {
      // 如果已经包含 HTML 标签，直接返回（假设是安全的 HTML）
      return text
    } else {
      // 如果是纯文本，转义 HTML 特殊字符并将换行符转换为 <br>
      const escaped = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
      return escaped.replace(/\n/g, '<br>')
    }
  }, [])

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

    return text
  }, [])

  // 进入编辑模式时初始化内容
  useEffect(() => {
    if (editingField === 'title') {
      editingTitleRef.current = node.title || ''
      document.body.classList.add('allow-text-selection')
      setTimeout(() => {
        if (titleRef.current) {
          titleRef.current.innerHTML = textToSafeHtml(editingTitleRef.current)
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
        }
      }, 0)
    } else if (editingField === 'content') {
      editingContentRef.current = node.content || ''
      document.body.classList.add('allow-text-selection')
      setTimeout(() => {
        if (contentRef.current) {
          contentRef.current.innerHTML = textToSafeHtml(editingContentRef.current)
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
        }
      }, 0)
    } else {
      document.body.classList.remove('allow-text-selection')
    }

    return () => {
      document.body.classList.remove('allow-text-selection')
    }
  }, [editingField, node.title, node.content, textToSafeHtml])

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

  // 清理 HTML 内容，保留基本的文字格式标签
  const cleanHtmlContent = useCallback((html: string): string => {
    // 创建临时元素来解析 HTML
    const temp = document.createElement('div')
    temp.innerHTML = html

    // 允许保留的标签及其属性白名单
    const allowedTags = new Set([
      'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'sub', 'sup',
      'span', 'br', 'div', 'p', 'font'
    ])
    const allowedAttributes = new Set(['style', 'class', 'color', 'face'])

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

    // 清理所有节点
    const cleanedNodes = Array.from(temp.childNodes).map(child => cleanNode(child))
    temp.innerHTML = ''
    cleanedNodes.forEach(node => temp.appendChild(node))

    // 简化换行处理
    let result = temp.innerHTML

    // 移除空的 span 标签
    result = result.replace(/<span[^>]*>\s*<\/span>/g, '')

    // 规范化：所有块级换行元素统一为 <br>
    result = result
      .replace(/<(?:div|p)[^>]*>/gi, '')
      .replace(/<\/(?:div|p)>/gi, '')

    // 确保非空内容有换行标记
    if (result && !result.includes('<br>')) {
      result = result + '<br>'
    }

    return result || '<br>'
  }, [])

  // 保存标题 - 纯文本处理，移除所有换行
  const saveTitle = useCallback(() => {
    if (titleRef.current && isEditingTitle) {
      const temp = document.createElement('div')
      temp.innerHTML = titleRef.current.innerHTML
      const text = temp.textContent || ''
      const title = text.replace(/\n/g, '').trim()
      
      if (title !== editingTitleRef.current) {
        updateNode(node.id, { title })
        editingTitleRef.current = title
      }
    }
  }, [isEditingTitle, node.id, updateNode])

  // 保存内容 - 保留完整换行和空格结构
  const saveContent = useCallback(() => {
    if (contentRef.current && isEditingContent) {
      const cleanedHtml = cleanHtmlContent(contentRef.current.innerHTML)
      const content = htmlToText(cleanedHtml)
      // 如果内容只有空白字符（换行、空格等），视为空字符串
      const trimmedContent = content.replace(/[\n\s]+/g, '').trim() ? content : ''
      if (trimmedContent !== editingContentRef.current) {
        updateNode(node.id, { content: trimmedContent })
        editingContentRef.current = trimmedContent
      }
    }
  }, [isEditingContent, node.id, updateNode, cleanHtmlContent, htmlToText])

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

      if (editingField !== null) {
        // Prevent loss of focus and event leakage when clicking on node internal areas while editing
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
          width: node.width,
          height: node.height,
        }
        return
      }

      // Only allow selection and dragging in default selection mode
      if (!isDefaultSelectionTool(currentTool)) {
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
          nodeX: node.x,
          nodeY: node.y,
        }
        onDragStart?.(node.id, e)
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
      setSelectedIds,
      addToSelection,
      removeFromSelection,
      onDragStart,
      node.id,
      currentTool,
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

        // 检测鼠标是否进入节点池区域
        const nodePoolElement = document.querySelector('[data-node-pool]')
        if (nodePoolElement) {
          const rect = nodePoolElement.getBoundingClientRect()
          const isOver = e.clientX >= rect.left && e.clientX <= rect.right &&
                        e.clientY >= rect.top && e.clientY <= rect.bottom

          const { setIsOverNodePool, setCanvasDragGhostPosition, isOverNodePool: currentIsOverNodePool } = useUIStore.getState()

          if (isOver !== currentIsOverNodePool) {
            setIsOverNodePool(isOver)
          }

          if (isOver) {
            setCanvasDragGhostPosition({ x: e.clientX, y: e.clientY })
          } else {
            setCanvasDragGhostPosition(null)
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
          newWidth = Math.max(100, resizeStartRef.current.width + dx)
        }
        if (resizeDirection.includes('w')) {
          newWidth = Math.max(100, resizeStartRef.current.width - dx)
          newX = dragStartRef.current.nodeX + dx
        }
        if (resizeDirection.includes('s')) {
          newHeight = Math.max(60, resizeStartRef.current.height + dy)
        }
        if (resizeDirection.includes('n')) {
          newHeight = Math.max(60, resizeStartRef.current.height - dy)
          newY = dragStartRef.current.nodeY + dy
        }

        // 只更新本地状态
        setLocalPosition({ x: newX, y: newY })
        setLocalSize({ width: newWidth, height: newHeight })
      }
    }

    const handleMouseUp = () => {
      if (isDragging || isResizing) {
        // 拖动/调整大小时才更新全局状态
        if (isDragging) {
          // 检查是否在节点池区域释放
          const { isOverNodePool, setDraggingNodeFromCanvas, setIsOverNodePool, setCanvasDragGhostPosition } = useUIStore.getState()

          if (isOverNodePool) {
            // 在节点池区域释放，触发添加到节点池的事件
            window.dispatchEvent(new CustomEvent('nodeDragEnd', {
              detail: { nodeId: node.id, droppedInNodePool: true }
            }))
            // 重置状态
            setDraggingNodeFromCanvas(null)
            setIsOverNodePool(false)
            setCanvasDragGhostPosition(null)
          } else {
            // 正常释放，更新节点位置
            updateNode(node.id, {
              x: localPosition.x,
              y: localPosition.y,
            })
            // 设置标志，防止 useEffect 立即重置位置
            justFinishedDragRef.current = true
            // 更新 lastSyncedNodeRef 为新位置，防止被覆盖
            lastSyncedNodeRef.current = { x: localPosition.x, y: localPosition.y, width: localSize.width, height: localSize.height }
            // 延迟清除标志，允许 React 状态更新完成
            setTimeout(() => {
              justFinishedDragRef.current = false
            }, 200)
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
          updateNode(node.id, {
            x: localPosition.x,
            y: localPosition.y,
            width: localSize.width,
            height: localSize.height,
          })
          justFinishedDragRef.current = true
          setTimeout(() => {
            justFinishedDragRef.current = false
          }, 100)
        }
        setIsDragging(false)
        setIsResizing(false)
        setResizeDirection('')
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
  }, [isDragging, isResizing, resizeDirection, node.id, node.locked, zoom, updateNode, onDragEnd, localPosition, localSize])

  // Handle double click to edit
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent, field?: 'title' | 'content') => {
      e.stopPropagation()
      if (!node.locked) {
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

        setEditingField(field)
        setEditingId(node.id)
        window.dispatchEvent(new CustomEvent('nodeEditingFieldChange', {
          detail: { field }
        }))
      }
    },
    [node.locked, node.title, node.type, isEditingTitle, isEditingContent, saveTitle, saveContent]
  )

  // 中文输入法开始
  const handleCompositionStart = useCallback(() => {
    setIsComposing(true)
  }, [])

  // 中文输入法结束
  const handleCompositionEnd = useCallback(() => {
    setIsComposing(false)
  }, [])

  // 不做状态更新，避免光标跳动
  const handleInputChange = useCallback(() => { }, [])

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
        document.execCommand('insertText', false, '  ')
        return
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        if (field === 'title') {
          saveTitle()
        } else {
          saveContent()
        }
        setEditingField(null)
        window.dispatchEvent(new CustomEvent('nodeEditingFieldChange', {
          detail: { field: null }
        }))
      } else if (e.key === 'Enter') {
        // Shift+Enter 或 Ctrl+Enter/Meta+Enter：换行不退出
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          e.preventDefault()
          document.execCommand('insertLineBreak', false, undefined)
          return
        }
        e.preventDefault()
        // 纯 Enter：结束编辑并保存
        if (field === 'title') {
          saveTitle()
        } else {
          saveContent()
        }
        setEditingField(null)
        window.dispatchEvent(new CustomEvent('nodeEditingFieldChange', {
          detail: { field: null }
        }))
      }
    },
    [isComposing, saveTitle, saveContent]
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
      Array.from(temp.childNodes).forEach(node => {
        range.insertNode(node.cloneNode(true))
      })
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

    setEditingField(null)
    setEditingId(null)
    window.dispatchEvent(new CustomEvent('nodeEditingFieldChange', {
      detail: { field: null }
    }))
  }, [isEditingTitle, isEditingContent, saveTitle, saveContent, setEditingId])

  // Handle context menu
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (editingField !== null) return
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

    if (newCollapsed) {
      updateNode(node.id, {
        collapsed: newCollapsed,
        expandedHeight: node.height,
        height: 36
      })
      setLocalSize({ width: node.width, height: 36 })
    } else {
      const expandedHeight = node.expandedHeight || node.height
      updateNode(node.id, {
        collapsed: newCollapsed,
        height: expandedHeight
      })
      setLocalSize({ width: node.width, height: expandedHeight })
    }
  }, [node.id, node.collapsed, node.height, node.expandedHeight, node.width, updateNode])

  // Sync with global editing state
  useEffect(() => {
    if (globalEditingId !== node.id && editingField !== null) {
      if (editingField === 'title') {
        saveTitle()
      } else if (editingField === 'content') {
        saveContent()
      }
      setEditingField(null)
      window.dispatchEvent(new CustomEvent('nodeEditingFieldChange', {
        detail: { field: null }
      }))
    }
  }, [globalEditingId, node.id, editingField, saveTitle, saveContent])

  // 检查当前节点是否正在被拖拽到节点池
  const isBeingDraggedToPool = draggingNodeFromCanvas?.nodeId === node.id && isOverNodePool

  return (
    <>
      <style>{`
        .node-dragging,
        .node-dragging * {
          cursor: move !important;
        }
      `}</style>
      {/* Wrapper for node and resize handles */}
      <div
        style={{
          position: 'absolute',
          left: (groupDragOffset ? localPosition.x + groupDragOffset.x : localPosition.x) - 16,
          top: (groupDragOffset ? localPosition.y + groupDragOffset.y : localPosition.y) - 16,
          width: localSize.width + 32,
          height: localSize.height + 32,
          opacity: isBeingDraggedToPool ? 0 : 1,
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
                  width: node.width,
                  height: node.height,
                }
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
                  width: node.width,
                  height: node.height,
                }
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
                  width: node.width,
                  height: node.height,
                }
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
                  width: node.width,
                  height: node.height,
                }
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M 6 10 L 10 10 L 10 6" stroke="#3b82f6" strokeWidth="2" fill="none" strokeLinecap="round" />
              </svg>
            </div>
          </>
        )}

        {/* Node container */}
        <div
          ref={nodeRef}
          data-node-id={node.id}
          className={`node-item absolute shadow-sm ${isDragging ? 'node-dragging' : node.locked ? 'cursor-not-allowed' : editingField !== null ? 'cursor-text' : 'cursor-move'
            } ${isDragging ? 'shadow-2xl scale-[1.01]' : ''} ${isHovered && !isSelected && !node.locked ? 'shadow-md' : ''
            } ${isDragging || isResizing || groupDragOffset ? '' : 'transition-all duration-200'}`}
          style={{
            cursor: isDragging ? 'move' : undefined,
            left: 16,
            top: 16,
            width: localSize.width,
            height: localSize.height,
            backgroundColor: node.type === 'image' ? '#ffffff' : node.color,
            overflow: 'visible',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: isSelected
              ? '0 4px 12px rgba(0, 0, 0, 0.15)'
              : isDragging || groupDragOffset
                ? '0 4px 12px rgba(0, 0, 0, 0.1)'
                : '0 1px 3px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.04)',
            zIndex: Z_INDEX.NODE,
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
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
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
                  color: '#1f2937',
                  caretColor: '#1f2937',
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
                className="w-full h-full flex items-center px-3 text-sm truncate cursor-text"
                style={{
                  fontSize: node.fontSize + 2,
                  ...getTitleAlign(node, true),
                  color: '#1f2937',
                  fontWeight: '600',
                }}
                onDoubleClick={(e) => handleDoubleClick(e, 'title')}
                title={node.title?.replace(/<[^>]*>/g, '') || node.content?.replace(/<[^>]*>/g, '')}
              >
                {node.title?.replace(/<[^>]*>/g, '') || node.content?.replace(/<[^>]*>/g, '') || '双击添加标题'}
              </div>
            )
          ) : node.type === 'image' ? (
            // Image Type Logic
            <div className="w-full h-full flex flex-col">
              {/* Title Area */}
              <div
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
                      color: '#111827',
                      minHeight: '24px',
                      caretColor: '#111827',
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
                      color: '#111827',
                      minHeight: '24px',
                      fontSize: `${node.fontSize + 2}px`,
                      textAlign: node.titleAlign || node.textAlign,
                      whiteSpace: 'pre-wrap',
                    }}
                    onDoubleClick={(e) => handleDoubleClick(e, 'title')}
                    dangerouslySetInnerHTML={{ __html: node.title || '' }}
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
                      color: '#111827',
                      minHeight: '24px',
                      caretColor: '#111827',
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
                      color: '#111827',
                      minHeight: '24px',
                      fontSize: `${node.fontSize + 2}px`,
                      textAlign: node.titleAlign || node.textAlign,
                      whiteSpace: 'pre-wrap',
                    }}
                    onDoubleClick={(e) => handleDoubleClick(e, 'title')}
                    dangerouslySetInnerHTML={{ __html: node.title || '' }}
                  />
                )}
              </div>

              {/* 内容区域 */}
              <div className="flex-1 p-4 overflow-auto">
                {isEditingContent ? (
                  <div
                    ref={contentRef}
                    contentEditable
                    suppressContentEditableWarning
                    style={{
                      color: '#4b5563',
                      minHeight: '60px',
                      caretColor: '#4b5563',
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
                ) : (
                  <div
                    style={{
                      color: '#4b5563',
                      minHeight: '40px',
                      wordBreak: 'break-word',
                      lineHeight: '1.6',
                      whiteSpace: 'pre-wrap',
                      fontSize: `${node.fontSize}px`,
                      textAlign: node.contentAlign || node.textAlign,
                    }}
                    onDoubleClick={(e) => handleDoubleClick(e, 'content')}
                    dangerouslySetInnerHTML={{ __html: node.content || '双击添加内容' }}
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
      {/* End wrapper for node and resize handles */}
    </>
  )
}
