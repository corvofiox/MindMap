import { useEffect, useRef, useCallback, useState } from 'react'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useUIStore } from '@/store/useUIStore'
import { CANVAS_DEFAULTS, NODE_DEFAULTS, DOMAIN_DEFAULTS } from '@/constants'
import { screenToCanvas, generateId, clamp } from '@/utils/canvas'
import { createFabricNode, createFabricGroup, createFabricDomain, createFabricConnection, updateFabricDomainsEditable, snapToGridFabric } from '@/utils/fabric'

interface FabricCanvasProps {
  canvasId: number
  width: number
  height: number
}

export function FabricCanvas({ canvasId, width, height }: FabricCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<fabric.Canvas | null>(null)
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

  const { currentTool, domainEditMode, setDomainEditMode, nodeDefaults } = useUIStore()

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
    const delta = e.e.deltaY
    const newZoom = clamp(zoom - delta * 0.001, CANVAS_DEFAULTS.MIN_ZOOM, CANVAS_DEFAULTS.MAX_ZOOM)

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
  }, [zoom, panX, panY, setZoom])

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
  }, [currentTool, zoom, panX, panY, addNode, addDomain, setSelectedIds])

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

        // 添加到画布
        const fabricDomain = createFabricDomain(newDomain, true)
        canvas.add(fabricDomain)
        canvas.sendToBack(fabricDomain)
        canvas.renderAll()
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
    }
  }, [canvasId, handleSelectionChanged, handleSelectionCleared, handleObjectMoved, handleObjectScaling, handleMouseWheel, handleMouseDown, handleMouseUp, handleMouseMove, handleDoubleClick])

  // Load canvas data from store
  const loadCanvasData = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    canvas.clear()

    // Add domains (background) - 使用当前编辑模式
    const isDomainEditable = currentTool === 'domain'
    domains.forEach((domain) => {
      const fabricDomain = createFabricDomain(domain, isDomainEditable)
      if (fabricDomain) canvas.add(fabricDomain)
    })

    // Add connections
    connections.forEach((connection) => {
      const fabricConnection = createFabricConnection(connection, nodes)
      if (fabricConnection) canvas.add(fabricConnection)
    })

    // Add groups
    groups.forEach((group) => {
      const fabricGroup = createFabricGroup(group)
      if (fabricGroup) canvas.add(fabricGroup)
    })

    // Add nodes
    nodes.forEach((node) => {
      const fabricNode = createFabricNode(node)
      if (fabricNode) {
        canvas.add(fabricNode)
      }
    })

    // Update zoom and pan
    canvas.setZoom(zoom)
    canvas.viewportTransform = [zoom, 0, 0, zoom, panX, panY]
  }, [nodes, groups, domains, connections, zoom, panX, panY, currentTool])

  // Update canvas size when container size changes
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    canvas.setWidth(width)
    canvas.setHeight(height)
    canvas.renderAll()
  }, [width, height])

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
