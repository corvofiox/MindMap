import { useEffect, useRef, useCallback, useState } from 'react'
import { useCanvasStore, getYjsBinding } from '@/store/useCanvasStore'
import { useUIStore } from '@/store/useUIStore'
import { CANVAS_DEFAULTS, DOMAIN_DEFAULTS } from '@/constants'
import { screenToCanvas, generateId, clamp } from '@/utils/canvas'
import { snapToGridFabric } from '@/utils/fabric'
import { IncrementalRenderer, createIncrementalRenderer } from '@/utils/incrementalRenderer'
import { collabService } from '@/services/collaboration'

interface FabricCanvasProps {
  canvasId: number
  width: number
  height: number
}

export function FabricCanvas({ canvasId, width, height }: FabricCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<fabric.Canvas | null>(null)
  const rendererRef = useRef<IncrementalRenderer | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const mouseButtonRef = useRef<number | null>(null)
  const lastHoveredIdRef = useRef<string | null>(null)

  // Domain creation state
  const [isCreatingDomain, setIsCreatingDomain] = useState(false)
  const [domainStartPos, setDomainStartPos] = useState({ x: 0, y: 0 })
  const [domainPreviewRect, setDomainPreviewRect] = useState<fabric.Rect | null>(null)

  const {
    nodes,
    groups,
    domains,
    connections,
    selectedIds,
    zoom,
    panX,
    panY,
    addNode,
    addDomain,
    updateNode,
    updateNodeWithoutHistory,
    updateDomain,
    setSelectedIds,
    setZoom,
    setPan,
    setEditingId,
    setHoveredId,
  } = useCanvasStore()

  const { currentTool, nodeDefaults, relationshipHighlightMode, zoomStep } = useUIStore()

  // Selection handlers
  const handleSelectionChanged = useCallback((e: { selected?: fabric.Object[] }) => {
    const selected = e.selected?.map((obj) => obj.data?.id).filter(Boolean) || []
    setSelectedIds(selected)
  }, [setSelectedIds])

  const handleSelectionCleared = useCallback(() => {
    setSelectedIds([])
  }, [setSelectedIds])

  // Track active object interactions for collaboration protection
  const activeObjectRef = useRef<string | null>(null)
  const interactionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const startObjectInteraction = useCallback((nodeId: string) => {
    if (interactionTimeoutRef.current) {
      clearTimeout(interactionTimeoutRef.current)
    }
    activeObjectRef.current = nodeId
    getYjsBinding()?.startInteraction(nodeId, 'position')
  }, [])

  const endObjectInteraction = useCallback(() => {
    if (interactionTimeoutRef.current) {
      clearTimeout(interactionTimeoutRef.current)
    }
    interactionTimeoutRef.current = setTimeout(() => {
      if (activeObjectRef.current) {
        getYjsBinding()?.endInteraction(activeObjectRef.current)
        activeObjectRef.current = null
      }
    }, 100)
  }, [])

  // Throttle the in-flight store update during drag/scale so connection
  // lines and other store-driven UI can follow the node visually, but
  // without flooding the WS or polluting undo history with too many
  // entries per drag. 10Hz (100ms) is sufficient for visual feedback and
  // reduces version conflict NAKs during concurrent dragging.
  const lastThrottleUpdateRef = useRef<number>(0)
  const THROTTLE_MS = 100

  const flushThrottledGeometry = useCallback(
    (obj: any) => {
      const now = Date.now()
      if (now - lastThrottleUpdateRef.current < THROTTLE_MS) return
      lastThrottleUpdateRef.current = now
      // updateNodeWithoutHistory keeps the store in sync so connection lines
      // and other store-driven UI follow during the drag, but does NOT
      // create a history entry per frame. Only the final object:modified
      // commit goes through the regular updateNode (with history), so undo
      // behaves naturally (one entry per drag).
      updateNodeWithoutHistory(
        obj.data.id,
        {
          x: obj.left,
          y: obj.top,
          width: obj.width * obj.scaleX,
          height: obj.height * obj.scaleY,
        },
        false
      )
    },
    [updateNodeWithoutHistory]
  )

  // object:moving fires ~60Hz during a drag. Refresh interaction timer
  // every frame to keep drag protection alive, and flush throttled geometry.
  const handleObjectMoving = useCallback(
    (e: any) => {
      if (mouseButtonRef.current !== 0) return
      const obj = e.target
      if (!obj || !obj.data || obj.data.type !== 'node') return
      if (activeObjectRef.current !== obj.data.id) {
        // Reset the throttle timer so the first frame of a new drag flushes
        // immediately rather than waiting up to 100ms.
        lastThrottleUpdateRef.current = 0
      }
      startObjectInteraction(obj.data.id)
      flushThrottledGeometry(obj)
    },
    [startObjectInteraction, flushThrottledGeometry]
  )

  // object:modified fires once after drag/scale/rotate ends. This is the
  // single point where we commit the final geometry to history (one entry
  // per drag/scale, so undo behaves naturally).
  const handleObjectModified = useCallback(
    (e: any) => {
      if (mouseButtonRef.current !== 0) return
      const obj = e.target
      if (!obj || !obj.data || obj.data.type !== 'node') return

      const finalWidth = obj.width * obj.scaleX
      const finalHeight = obj.height * obj.scaleY
      updateNode(obj.data.id, {
        x: obj.left,
        y: obj.top,
        width: finalWidth,
        height: finalHeight,
      })

      if (obj.scaleX !== 1 || obj.scaleY !== 1) {
        obj.set({ scaleX: 1, scaleY: 1 })
      }
      lastThrottleUpdateRef.current = 0
    },
    [updateNode]
  )

  // object:scaling fires during scale drag — refresh interaction timer,
  // reset scaleX/scaleY each frame (so dimensions don't accumulate), and
  // flush throttled geometry so store-driven UI follows the scale.
  const handleObjectScaling = useCallback(
    (e: any) => {
      const obj = e.target
      if (!obj || !obj.data || obj.data.type !== 'node') return

      if (activeObjectRef.current !== obj.data.id) {
        lastThrottleUpdateRef.current = 0
      }
      startObjectInteraction(obj.data.id)

      if (obj.scaleX !== 1 || obj.scaleY !== 1) {
        obj.set({ scaleX: 1, scaleY: 1 })
      }

      flushThrottledGeometry(obj)
    },
    [startObjectInteraction, flushThrottledGeometry]
  )

  // Mouse event handlers
  const handleMouseWheel = useCallback((e: any) => {
    // Use zoomStep for wheel zoom
    const direction = e.e.deltaY > 0 ? 1 : -1
    const newZoom = clamp(zoom - direction * zoomStep, CANVAS_DEFAULTS.MIN_ZOOM, CANVAS_DEFAULTS.MAX_ZOOM)

    const pointer = canvasRef.current?.getPointer(e.e)
    if (!pointer) {
      setZoom(newZoom)
      return
    }

    const mouseX = pointer.x
    const mouseY = pointer.y

    const canvasX = (mouseX - panX) / zoom
    const canvasY = (mouseY - panY) / zoom

    const newPanX = mouseX - canvasX * newZoom
    const newPanY = mouseY - canvasY * newZoom

    setZoom(newZoom)
    setPan(newPanX, newPanY)
  }, [zoom, panX, panY, setZoom, setPan, zoomStep])

  const handleMouseDown = useCallback((e: any) => {
    // Record which mouse button was pressed (0 = left, 2 = right)
    mouseButtonRef.current = e.e.button

    if (currentTool === 'node') {
      const pointer = canvasRef.current?.getPointer(e.e)
      if (!pointer) return

      const { x, y } = screenToCanvas(pointer.x, pointer.y, zoom, panX, panY)

      const newNode = {
        id: generateId('node'),
        x,
        y,
        width: nodeDefaults?.textNode?.width ?? 200,
        height: nodeDefaults?.textNode?.height ?? 120,
        title: '',
        content: '',
        color: nodeDefaults?.textNode?.color ?? '#ffffff',
        fontSize: nodeDefaults?.textNode?.fontSize ?? 14,
        textAlign: nodeDefaults?.textNode?.contentAlign ?? 'center',
        titleAlign: nodeDefaults?.textNode?.titleAlign ?? 'left',
        collapsedTitleAlign: nodeDefaults?.textNode?.collapsedTitleAlign ?? 'left',
        collapsed: false,
        locked: false,
      }

      addNode(newNode)
      setSelectedIds([newNode.id])
    } else if (currentTool === 'domain') {
      const canvas = canvasRef.current
      if (!canvas) return

      const pointer = canvas.getPointer(e.e)
      if (!pointer) return

      const { x, y } = screenToCanvas(pointer.x, pointer.y, zoom, panX, panY)

      // 检查是否点击在现有域上
      const target = canvas.findTarget(e.e, false)
      if (target && target.data?.type === 'domain') {
        // 选中域进行编辑
        return
      }

      // 开始创建新域
      setIsCreatingDomain(true)
      const snappedStart = {
        x: snapToGridFabric(x, CANVAS_DEFAULTS.GRID_SIZE),
        y: snapToGridFabric(y, CANVAS_DEFAULTS.GRID_SIZE),
      }
      setDomainStartPos(snappedStart)

      // 创建预览矩形
      const fabric = (globalThis as any).fabric
      const Rect = fabric.Rect
      const preview = new Rect({
        left: snappedStart.x,
        top: snappedStart.y,
        width: 0,
        height: 0,
        fill: 'rgba(59, 130, 246, 0.2)',
        stroke: '#3b82f6',
        strokeWidth: 2,
        strokeDashArray: [5, 5],
        selectable: false,
        evented: false,
      })
      canvas.add(preview)
      setDomainPreviewRect(preview)
    }
  }, [currentTool, zoom, panX, panY, addNode, addDomain, setSelectedIds, nodeDefaults])

  const handleMouseMove = useCallback((e: any) => {
    const pointer = canvasRef.current?.getPointer(e.e)
    if (!pointer) return

    if (isCreatingDomain && domainPreviewRect) {
      const canvas = canvasRef.current
      if (!canvas) return

      const { x, y } = screenToCanvas(pointer.x, pointer.y, zoom, panX, panY)
      const snappedPos = {
        x: snapToGridFabric(x, CANVAS_DEFAULTS.GRID_SIZE),
        y: snapToGridFabric(y, CANVAS_DEFAULTS.GRID_SIZE),
      }

      const width = Math.abs(snappedPos.x - domainStartPos.x)
      const height = Math.abs(snappedPos.y - domainStartPos.y)
      const left = Math.min(domainStartPos.x, snappedPos.x)
      const top = Math.min(domainStartPos.y, snappedPos.y)

      domainPreviewRect.set({ left, top, width, height })
      canvas.renderAll()
      return
    }

    const target = canvasRef.current?.findTarget(e.e, false)
    const hoveredId = target ? target.data?.id : null

    if (hoveredId !== lastHoveredIdRef.current) {
      lastHoveredIdRef.current = hoveredId
      setHoveredId(hoveredId)
    }
  }, [isCreatingDomain, domainPreviewRect, domainStartPos, zoom, panX, panY, setHoveredId])

  const handleDoubleClick = useCallback((e: any) => {
    const target = canvasRef.current?.findTarget(e.e, false)
    if (!target) return

    const data = target.data
    if (data && data.type === 'domain') {
      // 双击域编辑标题
      setEditingId(data.id)
    } else if (data && data.type === 'node') {
      setEditingId(data.id)
    }
  }, [setEditingId])

  const handleMouseUp = useCallback(() => {
    // 域创建完成
    if (isCreatingDomain && domainPreviewRect) {
      const canvas = canvasRef.current
      if (!canvas) return

      const width = domainPreviewRect.width
      const height = domainPreviewRect.height
      const left = domainPreviewRect.left
      const top = domainPreviewRect.top

      // 移除预览矩形
      canvas.remove(domainPreviewRect)
      setDomainPreviewRect(null)
      setIsCreatingDomain(false)

      // 最小尺寸检查（2个网格单元 = 40px）
      if (width >= 40 && height >= 40) {
        const newDomain = {
          id: generateId('domain'),
          name: `域 ${domains.size + 1}`,
          x: left,
          y: top,
          width,
          height,
          backgroundColor: DOMAIN_DEFAULTS.BACKGROUND_COLOR,
          titleVisible: true,
        }
        addDomain(newDomain)

        // 添加到画布（通过增量渲染器）- 域不可编辑
        if (rendererRef.current) {
          rendererRef.current.updateDomain(newDomain, false)
        }
      }

      setDomainStartPos({ x: 0, y: 0 })
    }

    // End object interaction when mouse is released
    endObjectInteraction()

    // Clear the mouse button record when mouse is released
    mouseButtonRef.current = null
  }, [isCreatingDomain, domainPreviewRect, domainStartPos, domains, addDomain, endObjectInteraction])

  // Initialize Fabric canvas
  useEffect(() => {
    if (!containerRef.current) return

    const fabric = (globalThis as any).fabric
    if (!fabric) {
      return
    }

    const canvas = new fabric.Canvas('fabric-canvas', {
      width,
      height,
      selection: true,
      preserveObjectStacking: true,
    })

    canvasRef.current = canvas

    try {
      workerRef.current = new Worker(new URL('@/workers/canvas.worker.ts', import.meta.url), {
        type: 'module',
      })
    } catch {
      workerRef.current = null
    }

    rendererRef.current = createIncrementalRenderer({
      canvas,
      worker: workerRef.current,
    })

    return () => {
      if (rendererRef.current) {
        rendererRef.current.destroy()
      }
      canvas.dispose()
      canvasRef.current = null
      rendererRef.current = null
      if (workerRef.current) {
        workerRef.current.terminate()
        workerRef.current = null
      }
    }
  }, [canvasId])

  // Set up event handlers (separate from initialization)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    canvas.on('selection:created', handleSelectionChanged)
    canvas.on('selection:updated', handleSelectionChanged)
    canvas.on('selection:cleared', handleSelectionCleared)
    canvas.on('object:moving', handleObjectMoving)
    canvas.on('object:modified', handleObjectModified)
    canvas.on('object:scaling', handleObjectScaling)
    canvas.on('mouse:wheel', handleMouseWheel)
    canvas.on('mouse:down', handleMouseDown)
    canvas.on('mouse:up', handleMouseUp)
    canvas.on('mouse:move', handleMouseMove)
    canvas.on('mouse:dblclick', handleDoubleClick)

    return () => {
      canvas.off('selection:created', handleSelectionChanged)
      canvas.off('selection:updated', handleSelectionChanged)
      canvas.off('selection:cleared', handleSelectionCleared)
      canvas.off('object:moving', handleObjectMoving)
      canvas.off('object:modified', handleObjectModified)
      canvas.off('object:scaling', handleObjectScaling)
      canvas.off('mouse:wheel', handleMouseWheel)
      canvas.off('mouse:down', handleMouseDown)
      canvas.off('mouse:up', handleMouseUp)
      canvas.off('mouse:move', handleMouseMove)
      canvas.off('mouse:dblclick', handleDoubleClick)
    }
  }, [handleSelectionChanged, handleSelectionCleared, handleObjectMoving, handleObjectModified, handleObjectScaling, handleMouseWheel, handleMouseDown, handleMouseUp, handleMouseMove, handleDoubleClick])

  // Load canvas data from store (initial load only)
  const loadCanvasData = useCallback(() => {
    const renderer = rendererRef.current
    if (!renderer) return

    renderer.updateDomains(domains, false)
    renderer.updateConnections(connections, nodes)
    renderer.updateGroups(groups)
    renderer.updateNodes(nodes)

    renderer.setViewport(zoom, panX, panY)
  }, [nodes, groups, domains, connections, zoom, panX, panY])

  // Incremental updates for nodes
  useEffect(() => {
    const renderer = rendererRef.current
    if (!renderer) return

    renderer.updateNodes(nodes)
  }, [nodes])

  // Incremental updates for connections
  useEffect(() => {
    const renderer = rendererRef.current
    if (!renderer) return

    // 异步更新连接（支持 Worker）
    renderer.updateConnections(connections, nodes).catch(() => {
      // Connection update failed silently
    })
  }, [connections, nodes])

  // Incremental updates for domains - 域始终不可编辑
  useEffect(() => {
    const renderer = rendererRef.current
    if (!renderer) return

    renderer.updateDomains(domains, false)
  }, [domains])

  // Incremental updates for groups
  useEffect(() => {
    const renderer = rendererRef.current
    if (!renderer) return

    renderer.updateGroups(groups)
  }, [groups])

  // Update canvas size when container size changes
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    canvas.setWidth(width)
    canvas.setHeight(height)
    canvas.renderAll()
  }, [width, height])

  // Update viewport (zoom and pan)
  useEffect(() => {
    const renderer = rendererRef.current
    if (!renderer) return

    renderer.setViewport(zoom, panX, panY)
  }, [zoom, panX, panY])

  // Relationship highlight effect (关系梳理) - 优化版本
  useEffect(() => {
    const canvas = canvasRef.current
    const renderer = rendererRef.current
    if (!canvas || !renderer) return

    const selectedNodes = selectedIds.filter(id => nodes.has(id))

    if (!relationshipHighlightMode || selectedNodes.length === 0) {
      renderer.forEachNode((obj) => {
        if (obj.opacity !== 1) {
          obj.set({ opacity: 1 })
        }
      })
      renderer.forEachConnection((obj) => {
        if (obj.opacity !== 1) {
          obj.set({ opacity: 1 })
        }
      })

      renderer.render()
      return
    }

    const relatedNodeIds = new Set<string>(selectedNodes)
    const relatedConnectionIds = new Set<string>()

    selectedNodes.forEach(nodeId => {
      connections.forEach((conn, connId) => {
        if (conn.fromNodeId === nodeId || conn.toNodeId === nodeId) {
          relatedConnectionIds.add(connId)
          relatedNodeIds.add(conn.fromNodeId)
          relatedNodeIds.add(conn.toNodeId)
        }
      })
    })

    renderer.forEachNode((obj, id) => {
      const isRelated = relatedNodeIds.has(id)
      const targetOpacity = isRelated ? 1 : 0.3
      if (obj.opacity !== targetOpacity) {
        obj.set({ opacity: targetOpacity })
      }
    })

    renderer.forEachConnection((obj, id) => {
      const isRelated = relatedConnectionIds.has(id)
      const targetOpacity = isRelated ? 1 : 0.15
      if (obj.opacity !== targetOpacity) {
        obj.set({ opacity: targetOpacity })
      }
    })

    renderer.render()
  }, [relationshipHighlightMode, selectedIds, nodes, connections])

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 bg-gray-50 dark:bg-gray-900"
      style={{
        cursor:
          currentTool === 'node' ? 'crosshair' :
            currentTool === 'domain' ? 'crosshair' :
              currentTool === 'pan' ? 'grab' :
                'default'
      }}
    >
      <canvas id="fabric-canvas" />
    </div>
  )
}
