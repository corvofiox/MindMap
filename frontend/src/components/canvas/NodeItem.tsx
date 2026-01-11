import { useState, useRef, useEffect, useCallback } from 'react'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useUIStore } from '@/store/useUIStore'
import { NodeContextMenu } from './NodeContextMenu'
import { snapToGrid } from '@/utils/canvas'
import { CANVAS_DEFAULTS } from '@/constants'
import { debugLogger } from '@/utils/debugLogger'
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
}

const RESIZE_HANDLE_SIZE = 16

type EditingField = 'title' | 'content' | null

export function NodeItem({ node, isSelected, zoom, onDragStart, onDragEnd, groupDragOffset }: NodeItemProps) {
  const {
    nodes,
    updateNode,
    setSelectedIds,
    addToSelection,
    removeFromSelection,
    editingId: globalEditingId,
    setEditingId,
  } = useCanvasStore()

  const { setSelectedType, currentTool } = useUIStore()

  const [isDragging, setIsDragging] = useState(false)
  const [isResizing, setIsResizing] = useState(false)
  const [resizeDirection, setResizeDirection] = useState<string>('')
  const [isContextMenuOpen, setIsContextMenuOpen] = useState(false)
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 })
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
      // Optimistic update or loading state could go here
      const { url } = await import('@/services/api').then(m => m.uploadImage(file))

      // Load image to get dimensions
      const img = new Image()
      img.src = url
      img.onload = () => {
        // Calculate aspect ratio
        const aspectRatio = img.width / img.height

        updateNode(node.id, {
          imageUrl: url,
          aspectRatio: aspectRatio,
          // Optional: Auto-resize node to match aspect ratio if needed, keeping width fixed
          height: node.width / aspectRatio
        })
        addToast({ type: 'success', title: '上传成功', message: '图片已上传' })
      }
    } catch (error) {
      addToast({
        type: 'error',
        title: '上传失败',
        message: '上传图片失败，请重试',
      })
    }
  }, [node.id, node.width, updateNode, addToast])

  const isEditingTitle = editingField === 'title'
  const isEditingContent = editingField === 'content'

  useEffect(() => {
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
  }, [node.x, node.y, node.width, node.height, isDragging, isResizing])

  // 将文本转换为安全HTML（转义HTML标签，保留换行）
  const textToSafeHtml = useCallback((text: string): string => {
    if (!text) return ''
    // 转义HTML特殊字符
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
    // 将换行符转换为<br>
    return escaped.replace(/\n/g, '<br>')
  }, [])

  // 进入编辑模式时初始化内容
  useEffect(() => {
    if (editingField === 'title') {
      editingTitleRef.current = node.title || ''
      document.body.classList.add('allow-text-selection')
      setTimeout(() => {
        if (titleRef.current) {
          if (!titleRef.current.innerHTML) {
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
        }
      }, 0)
    } else if (editingField === 'content') {
      editingContentRef.current = node.content || ''
      document.body.classList.add('allow-text-selection')
      setTimeout(() => {
        if (contentRef.current) {
          if (!contentRef.current.innerHTML) {
            contentRef.current.innerHTML = textToSafeHtml(editingContentRef.current)
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
        }
      }, 0)
    } else {
      document.body.classList.remove('allow-text-selection')
    }

    return () => {
      document.body.classList.remove('allow-text-selection')
    }
  }, [editingField, node.title, node.content, textToSafeHtml])


  // 清理 HTML 内容，保留纯文本和换行
  const cleanHtmlContent = useCallback((html: string): string => {
    // 创建临时元素来解析 HTML
    const temp = document.createElement('div')
    temp.innerHTML = html

    // 将 <br>, <div>, <p> 转换为换行符
    // 注意：contentEditable 在不同浏览器中换行表现不同，有的用 br，有的用 div 包装
    temp.querySelectorAll('br').forEach(el => {
      el.replaceWith('\n')
    })
    temp.querySelectorAll('div, p').forEach(el => {
      if (el.textContent || el.querySelector('br')) {
        el.prepend('\n')
      }
    })

    // 获取纯文本，移除所有 HTML 标签
    let text = temp.textContent || temp.innerText || ''

    // 清理多余的空白字符
    text = text
      .replace(/\n{3,}/g, '\n\n') // 多个连续换行缩减为两个
      .replace(/[ \t]+/g, ' ') // 多个空格/制表符缩减为一个
      .replace(/^ +| +$/g, '') // 去除首尾空格

    return text
  }, [])

  // 保存标题
  const saveTitle = useCallback(() => {
    if (titleRef.current && isEditingTitle) {
      const title = cleanHtmlContent(titleRef.current.innerHTML)
      if (title !== editingTitleRef.current) {
        updateNode(node.id, { title })
        editingTitleRef.current = title
      }
    }
  }, [isEditingTitle, node.id, updateNode, cleanHtmlContent])

  // 保存内容
  const saveContent = useCallback(() => {
    if (contentRef.current && isEditingContent) {
      const content = cleanHtmlContent(contentRef.current.innerHTML)
      if (content !== editingContentRef.current) {
        updateNode(node.id, { content })
        editingContentRef.current = content
      }
    }
  }, [isEditingContent, node.id, updateNode, cleanHtmlContent])

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
            detail: { nodeId: node.id }
          }))
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
    (e: React.MouseEvent, field: 'title' | 'content') => {
      e.stopPropagation()
      if (!node.locked) {
        setEditingField(field)
        setEditingId(node.id)
      }
    },
    [node.locked]
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

      if (e.key === 'Escape') {
        e.preventDefault()
        if (field === 'title') {
          saveTitle()
        } else {
          saveContent()
        }
        setEditingField(null)
      } else if (e.key === 'Enter') {
        if (e.shiftKey) {
          // Shift + Enter 允许在该处换行，不退出编辑
          return
        }
        e.preventDefault()
        // 纯 Enter 结束编辑并保存
        if (field === 'title') {
          saveTitle()
        } else {
          saveContent()
        }
        setEditingField(null)
      }
    },
    [isComposing, saveTitle, saveContent]
  )

  // Handle paste - 清理格式
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain')
    document.execCommand('insertText', false, text)
  }, [])

  // 失焦时保存
  const handleBlur = useCallback((field: 'title' | 'content') => {
    if (field === 'title' && isEditingTitle) {
      saveTitle()
    } else if (field === 'content' && isEditingContent) {
      saveContent()
    }
    setEditingField(null)
    setEditingId(null)
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

      setContextMenuPosition({
        x: e.clientX + 5,  // 5px offset from mouse
        y: e.clientY + 5
      })

      setIsContextMenuOpen(true)
      if (!isSelected) {
        setSelectedIds([node.id])
      }
    },
    [editingField, isSelected, node.id, setSelectedIds]
  )

  // Toggle collapsed state
  const toggleCollapsed = useCallback(() => {
    const newCollapsed = !node.collapsed

    debugLogger.info('[NodeItem] Toggle collapsed:', { nodeId: node.id, newCollapsed })

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

  // Close context menu
  const closeContextMenu = useCallback(() => {
    setIsContextMenuOpen(false)
  }, [])

  // Sync with global editing state
  useEffect(() => {
    if (globalEditingId !== node.id && editingField !== null) {
      if (editingField === 'title') {
        saveTitle()
      } else if (editingField === 'content') {
        saveContent()
      }
      setEditingField(null)
    }
  }, [globalEditingId, node.id, editingField, saveTitle, saveContent])

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
          className={`node-item absolute border rounded-xl shadow-sm ${isDragging ? 'node-dragging' : node.locked ? 'cursor-not-allowed' : editingField !== null ? 'cursor-text' : 'cursor-move'
            } ${isDragging ? 'shadow-2xl scale-[1.01]' : ''} ${isHovered && !isSelected && !node.locked ? 'shadow-md' : ''
            } ${isDragging || isResizing || groupDragOffset ? '' : 'transition-all duration-200'}`}
          style={{
            cursor: isDragging ? 'move' : undefined,
            left: 16,
            top: 16,
            width: localSize.width,
            height: localSize.height,
            backgroundColor: node.color,
            borderColor: isSelected ? '#3b82f6' : node.borderColor,
            borderWidth: node.borderWidth,
            borderRadius: node.borderRadius,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            // Simplify shadow during dragging for better performance
            boxShadow: isSelected
              ? '0 4px 12px rgba(0, 0, 0, 0.15)'
              : isDragging || groupDragOffset
                ? '0 4px 12px rgba(0, 0, 0, 0.1)'
                : '0 1px 3px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.04)',
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
          onContextMenu={handleContextMenu}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          {/* Node content */}
          {node.collapsed ? (
            // 折叠状态 - 只显示标题
            <div
              className="w-full h-full flex items-center justify-center px-3 text-sm truncate"
              style={{
                fontSize: node.fontSize + 2,
                textAlign: node.textAlign,
                color: '#1f2937',
                fontWeight: '600',
              }}
              title={node.title?.replace(/<[^>]*>/g, '') || node.content?.replace(/<[^>]*>/g, '')}
            >
              {node.title?.replace(/<[^>]*>/g, '') || node.content?.replace(/<[^>]*>/g, '') || '空白节点'}
            </div>
          ) : node.type === 'image' ? (
            // Image Type Logic
            <div className="w-full h-full flex flex-col">
              {/* Title Area */}
              <div
                className="flex-shrink-0 px-4 py-2.5 border-b border-gray-100 dark:border-gray-700/50"
                style={{ minHeight: '36px' }}
              >
                {isEditingTitle ? (
                  <div
                    ref={titleRef}
                    contentEditable
                    suppressContentEditableWarning
                    className="outline-none font-semibold"
                    style={{
                      fontSize: node.fontSize + 2,
                      textAlign: node.textAlign,
                      color: '#111827',
                      minHeight: '24px',
                    }}
                    onInput={handleInputChange}
                    onKeyDown={(e) => handleKeyDown(e, 'title')}
                    onCompositionStart={handleCompositionStart}
                    onCompositionEnd={handleCompositionEnd}
                    onPaste={handlePaste}
                    onBlur={() => handleBlur('title')}
                    onMouseDown={(e) => e.stopPropagation()}
                  />
                ) : (
                  <div
                    className="font-semibold"
                    style={{
                      fontSize: node.fontSize + 2,
                      textAlign: node.textAlign,
                      color: '#111827',
                      minHeight: '24px',
                    }}
                    onDoubleClick={(e) => handleDoubleClick(e, 'title')}
                  >
                    {node.title?.replace(/<[^>]*>/g, '') || '图片节点'}
                  </div>
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
                    className="outline-none font-semibold"
                    style={{
                      fontSize: node.fontSize + 2,
                      textAlign: node.textAlign,
                      color: '#111827',
                      minHeight: '24px',
                    }}
                    onInput={handleInputChange}
                    onKeyDown={(e) => handleKeyDown(e, 'title')}
                    onCompositionStart={handleCompositionStart}
                    onCompositionEnd={handleCompositionEnd}
                    onPaste={handlePaste}
                    onBlur={() => handleBlur('title')}
                    onMouseDown={(e) => e.stopPropagation()}
                  />
                ) : (
                  <div
                    className="font-semibold"
                    style={{
                      fontSize: node.fontSize + 2,
                      textAlign: node.textAlign,
                      color: '#111827',
                      minHeight: '24px',
                    }}
                    onDoubleClick={(e) => handleDoubleClick(e, 'title')}
                  >
                    {node.title?.replace(/<[^>]*>/g, '') || '点击添加标题'}
                  </div>
                )}
              </div>

              {/* 内容区域 */}
              <div className="flex-1 p-4 overflow-auto">
                {isEditingContent ? (
                  <div
                    ref={contentRef}
                    contentEditable
                    suppressContentEditableWarning
                    className="outline-none"
                    style={{
                      fontSize: node.fontSize,
                      textAlign: node.textAlign,
                      color: '#4b5563',
                      minHeight: '60px',
                    }}
                    onInput={handleInputChange}
                    onKeyDown={(e) => handleKeyDown(e, 'content')}
                    onCompositionStart={handleCompositionStart}
                    onCompositionEnd={handleCompositionEnd}
                    onPaste={handlePaste}
                    onBlur={() => handleBlur('content')}
                    onMouseDown={(e) => e.stopPropagation()}
                  />
                ) : (
                  <div
                    style={{
                      fontSize: node.fontSize,
                      textAlign: node.textAlign,
                      color: '#4b5563',
                      minHeight: '40px',
                      wordBreak: 'break-word',
                      lineHeight: '1.6',
                      whiteSpace: 'pre-wrap',
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

      {/* Context menu */}
      {isContextMenuOpen && (
        <NodeContextMenu
          nodeId={node.id}
          position={contextMenuPosition}
          onClose={closeContextMenu}
        />
      )}
    </>
  )
}
