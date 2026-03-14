import type { Node, NodeGroup, Domain, Connection } from '@/types'

interface FabricObjectMap {
  nodes: Map<string, fabric.Object>
  groups: Map<string, fabric.Object>
  domains: Map<string, fabric.Object>
  connections: Map<string, fabric.Object>
}

interface IncrementalRendererOptions {
  canvas: fabric.Canvas
  onNodeUpdate?: (id: string, node: Node) => void
  onConnectionUpdate?: (id: string, connection: Connection) => void
  onDomainUpdate?: (id: string, domain: Domain) => void
  onGroupUpdate?: (id: string, group: NodeGroup) => void
  worker?: Worker
}

export class IncrementalRenderer {
  private canvas: fabric.Canvas
  private objectMap: FabricObjectMap = {
    nodes: new Map(),
    groups: new Map(),
    domains: new Map(),
    connections: new Map(),
  }
  private options: IncrementalRendererOptions
  private pendingRender = false
  private worker: Worker | null = null
  private pendingWorkerRequests = new Map<string, (data: unknown) => void>()

  constructor(options: IncrementalRendererOptions) {
    this.canvas = options.canvas
    this.options = options
    this.worker = options.worker || null

    if (this.worker) {
      this.setupWorkerListener()
    }
  }

  private setupWorkerListener(): void {
    if (!this.worker) return

    this.worker.addEventListener('message', (event: MessageEvent) => {
      const { id, type, data, error } = event.data

      if (error) {
        console.error('Worker error:', error)
        if (id && this.pendingWorkerRequests.has(id)) {
          this.pendingWorkerRequests.delete(id)
        }
        return
      }

      // 处理批量路径计算结果
      if (type === 'pathsResult' && Array.isArray(data)) {
        data.forEach((item: { id: string; path: string }) => {
          if (this.pendingWorkerRequests.has(item.id)) {
            const resolve = this.pendingWorkerRequests.get(item.id)!
            resolve(item.path)
            this.pendingWorkerRequests.delete(item.id)
          }
        })
      }
    })
  }

  // 获取 fabric 对象
  private getFabric(): any {
    return (globalThis as any).fabric
  }

  // 创建 Fabric 节点
  private createNodeObject(node: Node): fabric.Object | null {
    const fabric = this.getFabric()
    if (!fabric) return null

    const rect = new fabric.Rect({
      left: node.x,
      top: node.y,
      width: node.width,
      height: node.height,
      fill: node.color || '#ffffff',
      stroke: '#e5e7eb',
      strokeWidth: 1,
      rx: 4,
      ry: 4,
      selectable: !node.locked,
      evented: !node.locked,
      data: {
        id: node.id,
        type: 'node',
      },
    })

    return rect
  }

  // 创建 Fabric 连接
  private createConnectionObject(connection: Connection, nodes: Map<string, Node>): fabric.Object | null {
    const fabric = this.getFabric()
    if (!fabric) return null

    const fromNode = nodes.get(connection.fromNodeId)
    const toNode = nodes.get(connection.toNodeId)
    if (!fromNode || !toNode) return null

    const fromX = fromNode.x + fromNode.width / 2
    const fromY = fromNode.y + fromNode.height / 2
    const toX = toNode.x + toNode.width / 2
    const toY = toNode.y + toNode.height / 2

    let path: fabric.Path | fabric.Line

    if (connection.type === 'straight') {
      path = new fabric.Line([fromX, fromY, toX, toY], {
        stroke: connection.color || '#6b7280',
        strokeWidth: connection.width || 2,
        selectable: false,
        evented: false,
        data: {
          id: connection.id,
          type: 'connection',
        },
      })
    } else {
      // 曲线或折线
      const pathData = this.calculateConnectionPath(fromX, fromY, toX, toY, connection.type)
      path = new fabric.Path(pathData, {
        stroke: connection.color || '#6b7280',
        strokeWidth: connection.width || 2,
        fill: '',
        selectable: false,
        evented: false,
        data: {
          id: connection.id,
          type: 'connection',
        },
      })
    }

    if (connection.style === 'dashed') {
      (path as fabric.Path).set({ strokeDashArray: [5, 5] })
    } else if (connection.style === 'dotted') {
      (path as fabric.Path).set({ strokeDashArray: [2, 2] })
    }

    return path
  }

  // 计算连接路径
  private calculateConnectionPath(fromX: number, fromY: number, toX: number, toY: number, type: string): string {
    switch (type) {
      case 'curve': {
        const dx = Math.abs(toX - fromX)
        const controlOffset = Math.min(dx * 0.5, 100)
        return `M ${fromX} ${fromY} C ${fromX + controlOffset} ${fromY}, ${toX - controlOffset} ${toY}, ${toX} ${toY}`
      }
      case 'step': {
        const midX = (fromX + toX) / 2
        return `M ${fromX} ${fromY} L ${midX} ${fromY} L ${midX} ${toY} L ${toX} ${toY}`
      }
      default:
        return `M ${fromX} ${fromY} L ${toX} ${toY}`
    }
  }

  // 创建 Fabric 域
  private createDomainObject(domain: Domain, isEditable: boolean): fabric.Object | null {
    const fabric = this.getFabric()
    if (!fabric) return null

    const rect = new fabric.Rect({
      left: domain.x,
      top: domain.y,
      width: domain.width,
      height: domain.height,
      fill: domain.backgroundColor || 'rgba(156, 163, 175, 0.2)',
      stroke: '#9ca3af',
      strokeWidth: 1,
      selectable: isEditable,
      evented: isEditable,
      hasControls: isEditable,
      hasBorders: isEditable,
      data: {
        id: domain.id,
        type: 'domain',
      },
    })

    return rect
  }

  // 创建 Fabric 组
  private createGroupObject(group: NodeGroup): fabric.Object | null {
    const fabric = this.getFabric()
    if (!fabric) return null

    const rect = new fabric.Rect({
      left: group.x,
      top: group.y,
      width: group.width,
      height: group.height,
      fill: group.backgroundColor || 'rgba(59, 130, 246, 0.1)',
      stroke: group.borderColor || '#3b82f6',
      strokeWidth: group.borderWidth || 2,
      rx: group.borderRadius || 8,
      ry: group.borderRadius || 8,
      selectable: true,
      data: {
        id: group.id,
        type: 'group',
      },
    })

    return rect
  }

  // 更新节点（增量）
  updateNode(node: Node): void {
    const existingObj = this.objectMap.nodes.get(node.id)

    if (existingObj) {
      // 更新现有对象
      existingObj.set({
        left: node.x,
        top: node.y,
        width: node.width,
        height: node.height,
        fill: node.color || '#ffffff',
        selectable: !node.locked,
        evented: !node.locked,
      })
    } else {
      // 创建新对象
      const newObj = this.createNodeObject(node)
      if (newObj) {
        this.objectMap.nodes.set(node.id, newObj)
        this.canvas.add(newObj)
      }
    }

    this.requestRender()
  }

  // 批量更新节点
  updateNodes(nodes: Map<string, Node>): void {
    const currentIds = new Set(nodes.keys())
    const existingIds = new Set(this.objectMap.nodes.keys())

    // 删除不存在的节点
    existingIds.forEach(id => {
      if (!currentIds.has(id)) {
        this.removeNode(id)
      }
    })

    // 添加或更新节点
    nodes.forEach((node, id) => {
      const existingObj = this.objectMap.nodes.get(id)
      if (existingObj) {
        // 检查是否需要更新
        const needsUpdate = this.nodeNeedsUpdate(existingObj, node)
        if (needsUpdate) {
          this.updateNode(node)
        }
      } else {
        this.updateNode(node)
      }
    })

    this.requestRender()
  }

  // 检查节点是否需要更新
  private nodeNeedsUpdate(obj: fabric.Object, node: Node): boolean {
    return (
      obj.left !== node.x ||
      obj.top !== node.y ||
      obj.width !== node.width ||
      obj.height !== node.height ||
      obj.fill !== node.color ||
      obj.selectable === node.locked
    )
  }

  // 删除节点
  removeNode(id: string): void {
    const obj = this.objectMap.nodes.get(id)
    if (obj) {
      this.canvas.remove(obj)
      this.objectMap.nodes.delete(id)
      this.requestRender()
    }
  }

  // 更新连接（增量）
  updateConnection(connection: Connection, nodes: Map<string, Node>): void {
    const existingObj = this.objectMap.connections.get(connection.id)

    if (existingObj) {
      // 删除旧对象，因为路径可能需要完全重绘
      this.canvas.remove(existingObj)
      this.objectMap.connections.delete(connection.id)
    }

    // 创建新对象
    const newObj = this.createConnectionObject(connection, nodes)
    if (newObj) {
      this.objectMap.connections.set(connection.id, newObj)
      this.canvas.add(newObj)
      this.canvas.sendToBack(newObj)
    }

    this.requestRender()
  }

  // 批量更新连接（支持 Worker 异步计算）
  async updateConnections(connections: Map<string, Connection>, nodes: Map<string, Node>): Promise<void> {
    const currentIds = new Set(connections.keys())
    const existingIds = new Set(this.objectMap.connections.keys())

    // 删除不存在的连接
    existingIds.forEach(id => {
      if (!currentIds.has(id)) {
        this.removeConnection(id)
      }
    })

    // 如果有 Worker 且连接数量较多，使用 Worker 批量计算
    if (this.worker && connections.size > 10) {
      await this.updateConnectionsWithWorker(connections, nodes)
    } else {
      // 添加或更新连接（同步方式）
      connections.forEach((connection) => {
        this.updateConnection(connection, nodes)
      })
    }

    this.requestRender()
  }

  // 使用 Worker 批量更新连接
  private async updateConnectionsWithWorker(
    connections: Map<string, Connection>,
    nodes: Map<string, Node>
  ): Promise<void> {
    if (!this.worker) return

    const connectionArray = Array.from(connections.entries())
    const pathResults = new Map<string, string>()

    // 为每个连接注册回调
    connectionArray.forEach(([id]) => {
      this.pendingWorkerRequests.set(
        id,
        (path: unknown) => {
          if (typeof path === 'string') {
            pathResults.set(id, path)
          }
        }
      )
    })

    // 发送批量计算请求（将 Map 转换为普通对象以便序列化）
    const nodesObj = Object.fromEntries(nodes)
    this.worker.postMessage({
      type: 'calculatePaths',
      connections: connectionArray.map(([id, conn]) => ({ id, connection: conn })),
      nodes: nodesObj,
    })

    // 等待结果（最多 1 秒）
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (pathResults.size >= connectionArray.length) {
          clearInterval(checkInterval)
          resolve()
        }
      }, 10)

      setTimeout(() => {
        clearInterval(checkInterval)
        resolve()
      }, 1000)
    })

    // 使用计算结果更新连接
    connectionArray.forEach(([id, connection]) => {
      const pathData = pathResults.get(id)
      if (pathData) {
        this.updateConnectionWithPath(connection, nodes, pathData)
      } else {
        this.updateConnection(connection, nodes)
      }
    })
  }

  // 使用预计算路径更新连接
  private updateConnectionWithPath(
    connection: Connection,
    nodes: Map<string, Node>,
    pathData: string
  ): void {
    const existingObj = this.objectMap.connections.get(connection.id)

    if (existingObj) {
      this.canvas.remove(existingObj)
      this.objectMap.connections.delete(connection.id)
    }

    const fabric = this.getFabric()
    if (!fabric) return

    const fromNode = nodes.get(connection.fromNodeId)
    const toNode = nodes.get(connection.toNodeId)
    if (!fromNode || !toNode) return

    let path: fabric.Path | fabric.Line

    if (connection.type === 'straight') {
      const fromX = fromNode.x + fromNode.width / 2
      const fromY = fromNode.y + fromNode.height / 2
      const toX = toNode.x + toNode.width / 2
      const toY = toNode.y + toNode.height / 2
      path = new fabric.Line([fromX, fromY, toX, toY], {
        stroke: connection.color || '#6b7280',
        strokeWidth: connection.width || 2,
        selectable: false,
        evented: false,
        data: { id: connection.id, type: 'connection' },
      })
    } else {
      path = new fabric.Path(pathData, {
        stroke: connection.color || '#6b7280',
        strokeWidth: connection.width || 2,
        fill: '',
        selectable: false,
        evented: false,
        data: { id: connection.id, type: 'connection' },
      })
    }

    if (connection.style === 'dashed') {
      (path as fabric.Path).set({ strokeDashArray: [5, 5] })
    } else if (connection.style === 'dotted') {
      (path as fabric.Path).set({ strokeDashArray: [2, 2] })
    }

    this.objectMap.connections.set(connection.id, path)
    this.canvas.add(path)
    this.canvas.sendToBack(path)
  }

  // 删除连接
  removeConnection(id: string): void {
    const obj = this.objectMap.connections.get(id)
    if (obj) {
      this.canvas.remove(obj)
      this.objectMap.connections.delete(id)
      this.requestRender()
    }
  }

  // 更新域（增量）
  updateDomain(domain: Domain, isEditable: boolean): void {
    const existingObj = this.objectMap.domains.get(domain.id)

    if (existingObj) {
      // 更新现有对象
      existingObj.set({
        left: domain.x,
        top: domain.y,
        width: domain.width,
        height: domain.height,
        fill: domain.backgroundColor || 'rgba(156, 163, 175, 0.2)',
        selectable: isEditable,
        evented: isEditable,
        hasControls: isEditable,
        hasBorders: isEditable,
      })
    } else {
      // 创建新对象
      const newObj = this.createDomainObject(domain, isEditable)
      if (newObj) {
        this.objectMap.domains.set(domain.id, newObj)
        this.canvas.add(newObj)
        this.canvas.sendToBack(newObj)
      }
    }

    this.requestRender()
  }

  // 批量更新域
  updateDomains(domains: Map<string, Domain>, isEditable: boolean): void {
    const currentIds = new Set(domains.keys())
    const existingIds = new Set(this.objectMap.domains.keys())

    // 删除不存在的域
    existingIds.forEach(id => {
      if (!currentIds.has(id)) {
        this.removeDomain(id)
      }
    })

    // 添加或更新域
    domains.forEach((domain, id) => {
      const existingObj = this.objectMap.domains.get(id)
      if (existingObj) {
        const needsUpdate = this.domainNeedsUpdate(existingObj, domain, isEditable)
        if (needsUpdate) {
          this.updateDomain(domain, isEditable)
        }
      } else {
        this.updateDomain(domain, isEditable)
      }
    })

    this.requestRender()
  }

  // 检查域是否需要更新
  private domainNeedsUpdate(obj: fabric.Object, domain: Domain, isEditable: boolean): boolean {
    return (
      obj.left !== domain.x ||
      obj.top !== domain.y ||
      obj.width !== domain.width ||
      obj.height !== domain.height ||
      obj.fill !== (domain.backgroundColor || 'rgba(156, 163, 175, 0.2)') ||
      obj.selectable !== isEditable
    )
  }

  // 删除域
  removeDomain(id: string): void {
    const obj = this.objectMap.domains.get(id)
    if (obj) {
      this.canvas.remove(obj)
      this.objectMap.domains.delete(id)
      this.requestRender()
    }
  }

  // 更新组（增量）
  updateGroup(group: NodeGroup): void {
    const existingObj = this.objectMap.groups.get(group.id)

    if (existingObj) {
      // 更新现有对象
      (existingObj as fabric.Rect).set({
        left: group.x,
        top: group.y,
        width: group.width,
        height: group.height,
        fill: group.backgroundColor || 'rgba(59, 130, 246, 0.1)',
        stroke: group.borderColor || '#3b82f6',
        strokeWidth: group.borderWidth || 2,
        rx: group.borderRadius || 8,
        ry: group.borderRadius || 8,
      })
    } else {
      // 创建新对象
      const newObj = this.createGroupObject(group)
      if (newObj) {
        this.objectMap.groups.set(group.id, newObj)
        this.canvas.add(newObj)
      }
    }

    this.requestRender()
  }

  // 批量更新组
  updateGroups(groups: Map<string, NodeGroup>): void {
    const currentIds = new Set(groups.keys())
    const existingIds = new Set(this.objectMap.groups.keys())

    // 删除不存在的组
    existingIds.forEach(id => {
      if (!currentIds.has(id)) {
        this.removeGroup(id)
      }
    })

    // 添加或更新组
    groups.forEach((group, id) => {
      const existingObj = this.objectMap.groups.get(id)
      if (existingObj) {
        const needsUpdate = this.groupNeedsUpdate(existingObj, group)
        if (needsUpdate) {
          this.updateGroup(group)
        }
      } else {
        this.updateGroup(group)
      }
    })

    this.requestRender()
  }

  // 检查组是否需要更新
  private groupNeedsUpdate(obj: fabric.Object, group: NodeGroup): boolean {
    return (
      obj.left !== group.x ||
      obj.top !== group.y ||
      obj.width !== group.width ||
      obj.height !== group.height ||
      obj.fill !== (group.backgroundColor || 'rgba(59, 130, 246, 0.1)')
    )
  }

  // 删除组
  removeGroup(id: string): void {
    const obj = this.objectMap.groups.get(id)
    if (obj) {
      this.canvas.remove(obj)
      this.objectMap.groups.delete(id)
      this.requestRender()
    }
  }

  // 请求渲染（节流）
  private requestRender(): void {
    if (this.pendingRender) return

    this.pendingRender = true
    requestAnimationFrame(() => {
      this.canvas.renderAll()
      this.pendingRender = false
    })
  }

  // 立即渲染
  render(): void {
    this.canvas.renderAll()
  }

  // 设置视口变换
  setViewport(zoom: number, panX: number, panY: number): void {
    this.canvas.setZoom(zoom)
    this.canvas.viewportTransform = [zoom, 0, 0, zoom, panX, panY]
    this.requestRender()
  }

  // 清空所有对象
  clear(): void {
    this.objectMap.nodes.clear()
    this.objectMap.connections.clear()
    this.objectMap.domains.clear()
    this.objectMap.groups.clear()
    this.canvas.clear()
  }

  // 获取对象映射（用于调试）
  getObjectMap(): FabricObjectMap {
    return {
      nodes: new Map(this.objectMap.nodes),
      groups: new Map(this.objectMap.groups),
      domains: new Map(this.objectMap.domains),
      connections: new Map(this.objectMap.connections),
    }
  }

  // 获取对象数量
  getObjectCount(): { nodes: number; connections: number; domains: number; groups: number } {
    return {
      nodes: this.objectMap.nodes.size,
      connections: this.objectMap.connections.size,
      domains: this.objectMap.domains.size,
      groups: this.objectMap.groups.size,
    }
  }
}

// 创建增量渲染器的工厂函数
export function createIncrementalRenderer(options: IncrementalRendererOptions): IncrementalRenderer {
  return new IncrementalRenderer(options)
}
