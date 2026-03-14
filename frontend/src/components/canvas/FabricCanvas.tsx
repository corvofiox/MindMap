import { useEffect, useRef, useCallback, useState } from 'react'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useUIStore } from '@/store/useUIStore'
import { CANVAS_DEFAULTS, DOMAIN_DEFAULTS } from '@/constants'
import { screenToCanvas, generateId, clamp } from '@/utils/canvas'
import { createFabricDomain, updateFabricDomainsEditable, snapToGridFabric } from '@/utils/fabric'
import { IncrementalRenderer, createIncrementalRenderer } from '@/utils/incrementalRenderer'

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
    updateDomain,
    setSelectedIds,
    setZoom,
    setPan,
    setEditingId,
    setHoveredId,
  } = useCanvasStore()

  const { currentTool, domainEditMode, setDomainEditMode, nodeDefaults, relationshipHighlightMode, zoomStep } = useUIStore()

  // Selection handlers
  const handleSelectionChanged = useCallback((e: { selected?: fabric.Object[] }) => {
    const selected = e.selected?.map((obj) => obj.data?.id).filter(Boolean) || []
    setSelectedIds(selected)
  }, [setSelectedIds])

  const handleSelectionCleared = useCallback(() => {
    setSelectedIds([])
  }, [setSelectedIds])

  // Object modification handlers
  const handleObjectMoved = useCallback((e: any) => {
    // Only allow left mouse button to move objects
    if (mouseButtonRef.current !== 0) {
      return
    }

    const obj = e.target
    if (!obj) return

    const data = obj.data
    if (!data) return

    if (data.type === 'domain') {
      const canvas = canvasRef.current
      if (!canvas) return

      // 对齐到网格
      const snappedX = snapToGridFabric(obj.left || 0, CANVAS_DEFAULTS.GRID_SIZE)
      const snappedY = snapToGridFabric(obj.top || 0, CANVAS_DEFAULTS.GRID_SIZE)

      obj.set({ left: snappedX, top: snappedY })
      canvas.renderAll()

      updateDomain(data.id, { x: snappedX, y: snappedY })
    } else if (data.type === 'node') {
      updateNode(data.id, { x: obj.left, y: obj.top })
    }
  }, [updateDomain, updateNode])

  const handleObjectScaling = useCallback((e: any) => {
    const obj = e.target
    const data = obj.data
    if (!data) return

    if (data.type === 'domain') {
      const domain = domains.get(data.id)
      if (!domain) return

      // 对齐到网格，最小尺寸40px
      const newWidth = Math.max(snapToGridFabric(obj.width * obj.scaleX, CANVAS_DEFAULTS.GRID_SIZE), 40)
      const newHeight = Math.max(snapToGridFabric(obj.height * obj.scaleY, CANVAS_DEFAULTS.GRID_SIZE), 40)

      updateDomain(data.id, { width: newWidth, height: newHeight })

      // 重置缩放
      obj.set({
        scaleX: 1,
        scaleY: 1,
      })
    } else if (data.type === 'node') {
      const node = nodes.get(data.id)
      if (!node) return

      updateNode(data.id, {
        width: obj.width * obj.scaleX,
        height: obj.height * obj.scaleY,
      })

      // Reset scale to prevent accumulation
      obj.set({
        scaleX: 1,
        scaleY: 1,
      })
    }
  }, [domains, nodes, updateDomain, updateNode])

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

    // 域创建预览
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

    // Find hovered object
    const target = canvasRef.current?.findTarget(e.e, false)
    const hoveredId = target ? target.data?.id : null

    setHoveredId(hoveredId)
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

        // 添加到画布（通过增量渲染器）
        if (rendererRef.current) {
          rendererRef.current.updateDomain(newDomain, true)
        }
      }

      setDomainStartPos({ x: 0, y: 0 })
    }

    // Clear the mouse button record when mouse is released
    mouseButtonRef.current = null
  }, [isCreatingDomain, domainPreviewRect, domainStartPos, domains, addDomain])

  // 域编辑模式切换
  useEffect(() => {
    if (currentTool === 'domain') {
      setDomainEditMode(true)
    } else if (domainEditMode) {
      setDomainEditMode(false)
    }

    // 更新现有域的可编辑状态
    if (canvasRef.current) {
      updateFabricDomainsEditable(canvasRef.current, currentTool === 'domain')
    }
  }, [currentTool, domainEditMode, setDomainEditMode])

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

    // 初始化 Web Worker
    try {
      workerRef.current = new Worker(new URL('@/workers/canvas.worker.ts', import.meta.url), {
        type: 'module',
      })
    } catch (error) {
      console.warn('Failed to initialize Web Worker:', error)
      workerRef.current = null
    }

    // 初始化增量渲染器
    rendererRef.current = createIncrementalRenderer({
      canvas,
      worker: workerRef.current,
    })

    // Set up event handlers
    canvas.on('selection:created', handleSelectionChanged)
    canvas.on('selection:updated', handleSelectionChanged)
    canvas.on('selection:cleared', handleSelectionCleared)
    canvas.on('object:moving', handleObjectMoved)
    canvas.on('object:modified', handleObjectMoved)
    canvas.on('object:scaling', handleObjectScaling)
    canvas.on('mouse:wheel', handleMouseWheel)
    canvas.on('mouse:down', handleMouseDown)
    canvas.on('mouse:up', handleMouseUp)
    canvas.on('mouse:move', handleMouseMove)
    canvas.on('mouse:dblclick', handleDoubleClick)

    // Load existing data
    loadCanvasData()

    return () => {
      canvas.dispose()
      rendererRef.current = null
      if (workerRef.current) {
        workerRef.current.terminate()
        workerRef.current = null
      }
    }
  }, [canvasId, handleSelectionChanged, handleSelectionCleared, handleObjectMoved, handleObjectScaling, handleMouseWheel, handleMouseDown, handleMouseUp, handleMouseMove, handleDoubleClick])

  // Load canvas data from store (initial load only)
  const loadCanvasData = useCallback(() => {
    const renderer = rendererRef.current
    if (!renderer) return

    // 批量加载所有数据
    const isDomainEditable = currentTool === 'domain'
    renderer.updateDomains(domains, isDomainEditable)
    renderer.updateConnections(connections, nodes)
    renderer.updateGroups(groups)
    renderer.updateNodes(nodes)

    // Update zoom and pan
    renderer.setViewport(zoom, panX, panY)
  }, [nodes, groups, domains, connections, zoom, panX, panY, currentTool])

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
    renderer.updateConnections(connections, nodes).catch((error) => {
      console.error('Failed to update connections:', error)
    })
  }, [connections, nodes])

  // Incremental updates for domains
  useEffect(() => {
    const renderer = rendererRef.current
    if (!renderer) return

    const isDomainEditable = currentTool === 'domain'
    renderer.updateDomains(domains, isDomainEditable)
  }, [domains, currentTool])

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

    // If relationship highlight mode is off or no nodes selected, reset all opacities
    if (!relationshipHighlightMode || selectedNodes.length === 0) {
      const objectMap = renderer.getObjectMap()

      // 只更新需要恢复透明度的对象
      objectMap.nodes.forEach((obj) => {
        if (obj.opacity !== 1) {
          obj.set({ opacity: 1 })
        }
      })
      objectMap.connections.forEach((obj) => {
        if (obj.opacity !== 1) {
          obj.set({ opacity: 1 })
        }
      })

      renderer.render()
      return
    }

    // Get all related node IDs and connection IDs
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

    // Apply opacity to objects using renderer's object map
    const objectMap = renderer.getObjectMap()

    // 批量更新节点透明度
    objectMap.nodes.forEach((obj, id) => {
      const isRelated = relatedNodeIds.has(id)
      const targetOpacity = isRelated ? 1 : 0.3
      if (obj.opacity !== targetOpacity) {
        obj.set({ opacity: targetOpacity })
      }
    })

    // 批量更新连接透明度
    objectMap.connections.forEach((obj, id) => {
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
