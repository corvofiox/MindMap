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
  private workerRequestVersion = 0

  constructor(options: IncrementalRendererOptions) {
    this.canvas = options.canvas
    this.options = options
    this.worker = options.worker || null
  }

  destroy(): void {
    this.pendingRender = false
    this.workerRequestVersion = 0
    this.objectMap.nodes.clear()
    this.objectMap.connections.clear()
    this.objectMap.domains.clear()
    this.objectMap.groups.clear()
    this.worker = null
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
        const dx = toX - fromX
        const dy = toY - fromY
        const distance = Math.sqrt(dx * dx + dy * dy)
        const controlOffset = Math.min(distance * 0.5, 100)
        const dirX = dx >= 0 ? 1 : -1
        return `M ${fromX} ${fromY} C ${fromX + controlOffset * dirX} ${fromY}, ${toX - controlOffset * dirX} ${toY}, ${toX} ${toY}`
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
    this.updateNodeInternal(node)
    this.requestRender()
  }

  // 更新节点内部方法（不触发渲染）
  private updateNodeInternal(node: Node): void {
    const existingObj = this.objectMap.nodes.get(node.id)

    if (existingObj) {
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
      const newObj = this.createNodeObject(node)
      if (newObj) {
        this.objectMap.nodes.set(node.id, newObj)
        this.canvas.add(newObj)
      }
    }
  }

  // 批量更新节点
  updateNodes(nodes: Map<string, Node>): void {
    const currentIds = new Set(nodes.keys())
    const existingIds = new Set(this.objectMap.nodes.keys())

    existingIds.forEach(id => {
      if (!currentIds.has(id)) {
        this.removeNodeInternal(id)
      }
    })

    let hasChanges = false

    nodes.forEach((node, id) => {
      const existingObj = this.objectMap.nodes.get(id)
      if (existingObj) {
        const needsUpdate = this.nodeNeedsUpdate(existingObj, node)
        if (needsUpdate) {
          this.updateNodeInternal(node)
          hasChanges = true
        }
      } else {
        this.updateNodeInternal(node)
        hasChanges = true
      }
    })

    if (hasChanges) {
      this.requestRender()
    }
  }

  // 检查节点是否需要更新
  private nodeNeedsUpdate(obj: fabric.Object, node: Node): boolean {
    const fillColor = typeof obj.fill === 'string' ? obj.fill : (obj.fill as any)?.color
    return (
      obj.left !== node.x ||
      obj.top !== node.y ||
      obj.width !== node.width ||
      obj.height !== node.height ||
      fillColor !== node.color ||
      obj.selectable !== !node.locked
    )
  }

  // 删除节点
  removeNode(id: string): void {
    this.removeNodeInternal(id)
    this.requestRender()
  }

  // 删除节点内部方法（不触发渲染）
  private removeNodeInternal(id: string): void {
    const obj = this.objectMap.nodes.get(id)
    if (obj) {
      this.canvas.remove(obj)
      this.objectMap.nodes.delete(id)
    }
  }

  // 更新连接（增量）
  updateConnection(connection: Connection, nodes: Map<string, Node>): void {
    this.updateConnectionInternal(connection, nodes)
    this.requestRender()
  }

  // 更新连接内部方法（不触发渲染）
  private updateConnectionInternal(connection: Connection, nodes: Map<string, Node>): void {
    const existingObj = this.objectMap.connections.get(connection.id)
    const fromNode = nodes.get(connection.fromNodeId)
    const toNode = nodes.get(connection.toNodeId)

    if (!fromNode || !toNode) {
      if (existingObj) {
        this.canvas.remove(existingObj)
        this.objectMap.connections.delete(connection.id)
      }
      return
    }

    const fromX = fromNode.x + fromNode.width / 2
    const fromY = fromNode.y + fromNode.height / 2
    const toX = toNode.x + toNode.width / 2
    const toY = toNode.y + toNode.height / 2

    if (existingObj) {
      const needsRebuild = this.connectionNeedsRebuild(existingObj, connection, fromX, fromY, toX, toY)

      if (!needsRebuild) {
        this.updateConnectionProperties(existingObj, connection)
        return
      }

      this.canvas.remove(existingObj)
      this.objectMap.connections.delete(connection.id)
    }

    const newObj = this.createConnectionObject(connection, nodes)
    if (newObj) {
      this.objectMap.connections.set(connection.id, newObj)
      this.canvas.add(newObj)
      this.canvas.sendToBack(newObj)
    }
  }

  // 检查连接是否需要重建
  private connectionNeedsRebuild(
    obj: fabric.Object,
    connection: Connection,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number
  ): boolean {
    const data = obj.data
    if (!data || data.type !== 'connection') return true

    if (connection.type === 'straight') {
      const x1 = (obj as fabric.Line).x1
      const y1 = (obj as fabric.Line).y1
      const x2 = (obj as fabric.Line).x2
      const y2 = (obj as fabric.Line).y2
      return x1 !== fromX || y1 !== fromY || x2 !== toX || y2 !== toY
    }

    const pathObj = obj as fabric.Path
    if (!pathObj.path) return true

    const pathData = this.calculateConnectionPath(fromX, fromY, toX, toY, connection.type)
    const currentPath = (pathObj.path as unknown as any[][]).map((seg) => seg.join(' ')).join(' ')
    return currentPath !== pathData
  }

  // 更新连接属性（不重建对象）
  private updateConnectionProperties(obj: fabric.Object, connection: Connection): void {
    const stroke = connection.color || '#6b7280'
    const strokeWidth = connection.width || 2

    obj.set({
      stroke,
      strokeWidth,
    })

    if (connection.style === 'dashed') {
      obj.set({ strokeDashArray: [5, 5] })
    } else if (connection.style === 'dotted') {
      obj.set({ strokeDashArray: [2, 2] })
    } else {
      obj.set({ strokeDashArray: undefined })
    }
  }

  // 批量更新连接（支持 Worker 异步计算）
  async updateConnections(connections: Map<string, Connection>, nodes: Map<string, Node>): Promise<void> {
    const currentIds = new Set(connections.keys())
    const existingIds = new Set(this.objectMap.connections.keys())
    let hasChanges = false

    existingIds.forEach(id => {
      if (!currentIds.has(id)) {
        this.removeConnectionInternal(id)
        hasChanges = true
      }
    })

    if (this.worker && connections.size > 10) {
      await this.updateConnectionsWithWorker(connections, nodes)
      hasChanges = true
    } else {
      connections.forEach((connection) => {
        const existingObj = this.objectMap.connections.get(connection.id)
        const fromNode = nodes.get(connection.fromNodeId)
        const toNode = nodes.get(connection.toNodeId)

        if (existingObj && fromNode && toNode) {
          const fromX = fromNode.x + fromNode.width / 2
          const fromY = fromNode.y + fromNode.height / 2
          const toX = toNode.x + toNode.width / 2
          const toY = toNode.y + toNode.height / 2
          const needsRebuild = this.connectionNeedsRebuild(existingObj, connection, fromX, fromY, toX, toY)

          if (!needsRebuild) {
            this.updateConnectionProperties(existingObj, connection)
          } else {
            this.updateConnectionInternal(connection, nodes)
            hasChanges = true
          }
        } else {
          this.updateConnectionInternal(connection, nodes)
          hasChanges = true
        }
      })
    }

    if (hasChanges) {
      this.requestRender()
    }
  }

  // 使用 Worker 批量更新连接
  private async updateConnectionsWithWorker(
    connections: Map<string, Connection>,
    nodes: Map<string, Node>
  ): Promise<void> {
    if (!this.worker) return

    const currentVersion = ++this.workerRequestVersion
    const connectionArray = Array.from(connections.entries())

    const nodesObj = Object.fromEntries(nodes)

    const pathResults = await this.sendWorkerMessage<{ id: string; path: string }[]>(
      'calculatePaths',
      {
        connections: connectionArray.map(([id, conn]) => ({ id, connection: conn })),
        nodes: nodesObj,
      },
      currentVersion,
      2000
    )

    if (!pathResults || currentVersion !== this.workerRequestVersion) return

    const pathMap = new Map(pathResults.map(item => [item.id, item.path]))

    connectionArray.forEach(([id, connection]) => {
      const pathData = pathMap.get(id)
      if (pathData) {
        this.updateConnectionWithPath(connection, nodes, pathData)
      } else {
        this.updateConnectionInternal(connection, nodes)
      }
    })
  }

  // 发送 Worker 消息并等待响应（Promise 化）
  private sendWorkerMessage<T>(
    type: string,
    data: unknown,
    version: number,
    timeout: number = 5000
  ): Promise<T | null> {
    return new Promise((resolve) => {
      if (!this.worker) {
        resolve(null)
        return
      }

      const handleMessage = (event: MessageEvent) => {
        const response = event.data
        if (response.type === `${type}Result` || response.type === 'pathsResult') {
          if (version === this.workerRequestVersion) {
            this.worker!.removeEventListener('message', handleMessage)
            resolve(response.data as T)
          }
        }
      }

      this.worker.addEventListener('message', handleMessage)

      this.worker!.postMessage({ type, ...(data as Record<string, unknown>) })

      setTimeout(() => {
        this.worker!.removeEventListener('message', handleMessage)
        resolve(null)
      }, timeout)
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
    this.removeConnectionInternal(id)
    this.requestRender()
  }

  // 删除连接内部方法（不触发渲染）
  private removeConnectionInternal(id: string): void {
    const obj = this.objectMap.connections.get(id)
    if (obj) {
      this.canvas.remove(obj)
      this.objectMap.connections.delete(id)
    }
  }

  // 更新域（增量）
  updateDomain(domain: Domain, isEditable: boolean): void {
    this.updateDomainInternal(domain, isEditable)
    this.requestRender()
  }

  // 更新域内部方法（不触发渲染）
  private updateDomainInternal(domain: Domain, isEditable: boolean): void {
    const existingObj = this.objectMap.domains.get(domain.id)

    if (existingObj) {
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
      const newObj = this.createDomainObject(domain, isEditable)
      if (newObj) {
        this.objectMap.domains.set(domain.id, newObj)
        this.canvas.add(newObj)
        this.canvas.sendToBack(newObj)
      }
    }
  }

  // 批量更新域
  updateDomains(domains: Map<string, Domain>, isEditable: boolean): void {
    const currentIds = new Set(domains.keys())
    const existingIds = new Set(this.objectMap.domains.keys())
    let hasChanges = false

    existingIds.forEach(id => {
      if (!currentIds.has(id)) {
        this.removeDomainInternal(id)
        hasChanges = true
      }
    })

    domains.forEach((domain, id) => {
      const existingObj = this.objectMap.domains.get(id)
      if (existingObj) {
        const needsUpdate = this.domainNeedsUpdate(existingObj, domain, isEditable)
        if (needsUpdate) {
          this.updateDomainInternal(domain, isEditable)
          hasChanges = true
        }
      } else {
        this.updateDomainInternal(domain, isEditable)
        hasChanges = true
      }
    })

    if (hasChanges) {
      this.requestRender()
    }
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
    this.removeDomainInternal(id)
    this.requestRender()
  }

  // 删除域内部方法（不触发渲染）
  private removeDomainInternal(id: string): void {
    const obj = this.objectMap.domains.get(id)
    if (obj) {
      this.canvas.remove(obj)
      this.objectMap.domains.delete(id)
    }
  }

  // 更新组（增量）
  updateGroup(group: NodeGroup): void {
    this.updateGroupInternal(group)
    this.requestRender()
  }

  // 更新组内部方法（不触发渲染）
  private updateGroupInternal(group: NodeGroup): void {
    const existingObj = this.objectMap.groups.get(group.id)

    if (existingObj) {
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
      const newObj = this.createGroupObject(group)
      if (newObj) {
        this.objectMap.groups.set(group.id, newObj)
        this.canvas.add(newObj)
      }
    }
  }

  // 批量更新组
  updateGroups(groups: Map<string, NodeGroup>): void {
    const currentIds = new Set(groups.keys())
    const existingIds = new Set(this.objectMap.groups.keys())
    let hasChanges = false

    existingIds.forEach(id => {
      if (!currentIds.has(id)) {
        this.removeGroupInternal(id)
        hasChanges = true
      }
    })

    groups.forEach((group, id) => {
      const existingObj = this.objectMap.groups.get(id)
      if (existingObj) {
        const needsUpdate = this.groupNeedsUpdate(existingObj, group)
        if (needsUpdate) {
          this.updateGroupInternal(group)
          hasChanges = true
        }
      } else {
        this.updateGroupInternal(group)
        hasChanges = true
      }
    })

    if (hasChanges) {
      this.requestRender()
    }
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
    this.removeGroupInternal(id)
    this.requestRender()
  }

  // 删除组内部方法（不触发渲染）
  private removeGroupInternal(id: string): void {
    const obj = this.objectMap.groups.get(id)
    if (obj) {
      this.canvas.remove(obj)
      this.objectMap.groups.delete(id)
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

  // 遍历节点对象（避免创建副本）
  forEachNode(callback: (obj: fabric.Object, id: string) => void): void {
    this.objectMap.nodes.forEach(callback)
  }

  // 遍历连接对象（避免创建副本）
  forEachConnection(callback: (obj: fabric.Object, id: string) => void): void {
    this.objectMap.connections.forEach(callback)
  }

  // 遍历域对象（避免创建副本）
  forEachDomain(callback: (obj: fabric.Object, id: string) => void): void {
    this.objectMap.domains.forEach(callback)
  }

  // 遍历组对象（避免创建副本）
  forEachGroup(callback: (obj: fabric.Object, id: string) => void): void {
    this.objectMap.groups.forEach(callback)
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
