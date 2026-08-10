// AI 工具调用系统
// 为 AI 助手提供读取和修改画布数据的能力

import { useCanvasStore } from '@/store/useCanvasStore'
import type { Node, Connection, NodeGroup, Domain } from '@/types'

// 工具调用结果
export interface ToolCallResult {
  success: boolean
  data?: unknown
  error?: string
}

// 工具调用信息
export interface ToolCall {
  tool: string
  arguments: Record<string, unknown>
}

/** 数值安全转换：非有限数（NaN/Infinity）返回 fallback，避免 NaN 写入节点属性。 */
function toFiniteNumber(value: unknown, fallback: number): number {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

// 读取画布所有节点
function getAllNodes(): ToolCallResult {
  try {
    const { nodes } = useCanvasStore.getState()
    const nodesArray = Array.from(nodes.values()).map((node) => ({
      id: node.id,
      title: node.title,
      content: node.content,
      type: node.type,
      collapsed: node.collapsed,
      locked: node.locked,
    }))
    return { success: true, data: nodesArray }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// 读取画布所有连接
function getAllConnections(): ToolCallResult {
  try {
    const { connections } = useCanvasStore.getState()
    const connectionsArray = Array.from(connections.values()).map((conn) => ({
      id: conn.id,
      fromNodeId: conn.fromNodeId,
      toNodeId: conn.toNodeId,
      fromPort: conn.fromPort,
      toPort: conn.toPort,
      type: conn.type,
      style: conn.style,
      label: conn.label,
      arrowType: conn.arrowType,
      direction: conn.direction,
    }))
    return { success: true, data: connectionsArray }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// 读取画布所有组
function getAllGroups(): ToolCallResult {
  try {
    const { groups } = useCanvasStore.getState()
    const groupsArray = Array.from(groups.values()).map((group) => ({
      id: group.id,
      name: group.name,
      description: group.description,
      nodeIds: group.nodeIds,
      collapsed: group.collapsed,
    }))
    return { success: true, data: groupsArray }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// 读取画布所有域
function getAllDomains(): ToolCallResult {
  try {
    const { domains } = useCanvasStore.getState()
    const domainsArray = Array.from(domains.values()).map((domain) => ({
      id: domain.id,
      name: domain.name,
    }))
    return { success: true, data: domainsArray }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// 读取画布完整数据
function getCanvasData(): ToolCallResult {
  try {
    const state = useCanvasStore.getState()
    const nodes = Array.from(state.nodes.values())
    const connections = Array.from(state.connections.values())
    const groups = Array.from(state.groups.values())
    const domains = Array.from(state.domains.values())

    return {
      success: true,
      data: {
        nodes: nodes.map((n) => ({
          id: n.id,
          title: n.title,
          content: n.content,
          type: n.type,
          collapsed: n.collapsed,
          locked: n.locked,
        })),
        connections: connections.map((c) => ({
          id: c.id,
          fromNodeId: c.fromNodeId,
          toNodeId: c.toNodeId,
          fromPort: c.fromPort,
          toPort: c.toPort,
          type: c.type,
          style: c.style,
          label: c.label,
          arrowType: c.arrowType,
          direction: c.direction,
        })),
        groups: groups.map((g) => ({
          id: g.id,
          name: g.name,
          description: g.description,
          nodeIds: g.nodeIds,
          collapsed: g.collapsed,
        })),
        domains: domains.map((d) => ({
          id: d.id,
          name: d.name,
        })),
      },
    }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// 创建新节点
function createNode(args: Record<string, unknown>): ToolCallResult {
  try {
    const { addNode } = useCanvasStore.getState()
    const nodeId = `node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    const nodeType = (args.type as Node['type']) || 'text'
    const title = String(args.title || '').trim()
    if (!title) {
      return { success: false, error: '缺少节点标题(title)' }
    }
    const node: Node = {
      id: nodeId,
      title,
      content: String(args.content || ''),
      x: toFiniteNumber(args.x, 0),
      y: toFiniteNumber(args.y, 0),
      width: toFiniteNumber(args.width, 200),
      height: toFiniteNumber(args.height, 160),
      color: String(args.color ?? '#ffffff'),  // 默认白色背景
      fontSize: toFiniteNumber(args.fontSize, 14),
      textAlign: (args.textAlign as Node['textAlign']) || 'center',
      titleAlign: (args.titleAlign as Node['titleAlign']) || undefined,
      contentAlign: (args.contentAlign as Node['contentAlign']) || undefined,
      collapsedTitleAlign: (args.collapsedTitleAlign as Node['collapsedTitleAlign']) || undefined,
      collapsed: Boolean(args.collapsed ?? false),
      locked: Boolean(args.locked ?? false),
      type: nodeType,
      imageUrl: nodeType === 'image' ? String(args.imageUrl || '') : undefined,
      aspectRatio: args.aspectRatio !== undefined ? toFiniteNumber(args.aspectRatio, 1) : undefined,
    }
    addNode(node)
    return { success: true, data: { nodeId, title: node.title, type: nodeType } }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// 更新节点
function updateNode(args: Record<string, unknown>): ToolCallResult {
  try {
    const { updateNode, nodes } = useCanvasStore.getState()
    const nodeId = String(args.nodeId)
    if (!nodeId) {
      return { success: false, error: '缺少节点 ID' }
    }
    // 读取当前节点作为数值兜底（toFiniteNumber fallback）
    const existingNode = nodes.get(nodeId)
    if (!existingNode) {
      return { success: false, error: `节点不存在: ${nodeId},可用 getAllNodes 获取有效节点 ID` }
    }

    const updates: Partial<Node> = {}
    if (args.title !== undefined && args.title !== null) updates.title = String(args.title)
    if (args.content !== undefined && args.content !== null) updates.content = String(args.content)
    if (args.x !== undefined && args.x !== null) updates.x = toFiniteNumber(args.x, existingNode?.x ?? 0)
    if (args.y !== undefined && args.y !== null) updates.y = toFiniteNumber(args.y, existingNode?.y ?? 0)
    if (args.width !== undefined && args.width !== null) updates.width = toFiniteNumber(args.width, existingNode?.width ?? 200)
    if (args.height !== undefined && args.height !== null) updates.height = toFiniteNumber(args.height, existingNode?.height ?? 160)
    if (args.color !== undefined && args.color !== null) updates.color = String(args.color)
    if (args.fontSize !== undefined && args.fontSize !== null) updates.fontSize = toFiniteNumber(args.fontSize, existingNode?.fontSize ?? 14)
    if (args.textAlign !== undefined && args.textAlign !== null) updates.textAlign = args.textAlign as Node['textAlign']
    if (args.titleAlign !== undefined && args.titleAlign !== null) updates.titleAlign = args.titleAlign as Node['titleAlign']
    if (args.contentAlign !== undefined && args.contentAlign !== null) updates.contentAlign = args.contentAlign as Node['contentAlign']
    if (args.collapsedTitleAlign !== undefined && args.collapsedTitleAlign !== null) updates.collapsedTitleAlign = args.collapsedTitleAlign as Node['collapsedTitleAlign']
    if (args.collapsed !== undefined && args.collapsed !== null) updates.collapsed = Boolean(args.collapsed)
    if (args.locked !== undefined && args.locked !== null) updates.locked = Boolean(args.locked)
    if (args.type !== undefined && args.type !== null) updates.type = args.type as Node['type']
    if (args.imageUrl !== undefined && args.imageUrl !== null) updates.imageUrl = String(args.imageUrl)
    if (args.aspectRatio !== undefined && args.aspectRatio !== null) updates.aspectRatio = toFiniteNumber(args.aspectRatio, existingNode?.aspectRatio ?? 1)

    updateNode(nodeId, updates)
    return { success: true, data: { nodeId, updates } }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// 批量更新多个节点(R6)
function batchUpdateNodes(args: Record<string, unknown>): ToolCallResult {
  try {
    const { updateNode } = useCanvasStore.getState()
    if (!Array.isArray(args.nodeIds)) {
      return { success: false, error: '缺少节点 ID 列表(nodeIds)' }
    }
    const nodeIds = args.nodeIds as string[]

    const updates: Partial<Node> = {}
    if (args.title !== undefined && args.title !== null) updates.title = String(args.title)
    if (args.content !== undefined && args.content !== null) updates.content = String(args.content)
    if (args.x !== undefined && args.x !== null) updates.x = toFiniteNumber(args.x, 0)
    if (args.y !== undefined && args.y !== null) updates.y = toFiniteNumber(args.y, 0)
    if (args.width !== undefined && args.width !== null) updates.width = toFiniteNumber(args.width, 200)
    if (args.height !== undefined && args.height !== null) updates.height = toFiniteNumber(args.height, 160)
    if (args.color !== undefined && args.color !== null) updates.color = String(args.color)
    if (args.fontSize !== undefined && args.fontSize !== null) updates.fontSize = toFiniteNumber(args.fontSize, 14)
    if (args.textAlign !== undefined && args.textAlign !== null) updates.textAlign = args.textAlign as Node['textAlign']
    if (args.titleAlign !== undefined && args.titleAlign !== null) updates.titleAlign = args.titleAlign as Node['titleAlign']
    if (args.contentAlign !== undefined && args.contentAlign !== null) updates.contentAlign = args.contentAlign as Node['contentAlign']
    if (args.collapsedTitleAlign !== undefined && args.collapsedTitleAlign !== null) updates.collapsedTitleAlign = args.collapsedTitleAlign as Node['collapsedTitleAlign']
    if (args.collapsed !== undefined && args.collapsed !== null) updates.collapsed = Boolean(args.collapsed)
    if (args.locked !== undefined && args.locked !== null) updates.locked = Boolean(args.locked)
    if (args.type !== undefined && args.type !== null) updates.type = args.type as Node['type']
    if (args.imageUrl !== undefined && args.imageUrl !== null) updates.imageUrl = String(args.imageUrl)
    if (args.aspectRatio !== undefined && args.aspectRatio !== null) updates.aspectRatio = toFiniteNumber(args.aspectRatio, 1)

    const skipped: string[] = []
    let updated = 0
    for (const id of nodeIds) {
      if (!useCanvasStore.getState().nodes.has(id)) {
        skipped.push(id)
        continue
      }
      updateNode(id, updates)
      updated++
    }
    if (updated === 0) {
      return { success: false, error: '所有节点均不存在,可用 getAllNodes 获取有效节点 ID' }
    }
    return { success: true, data: { updated, skipped } }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// 删除节点
function deleteNode(args: Record<string, unknown>): ToolCallResult {
  try {
    const { removeNode, nodes } = useCanvasStore.getState()
    const nodeId = String(args.nodeId)
    if (!nodeId) {
      return { success: false, error: '缺少节点 ID' }
    }
    if (!nodes.has(nodeId)) {
      return { success: false, error: `节点不存在: ${nodeId},可用 getAllNodes 获取有效节点 ID` }
    }
    removeNode(nodeId)
    return { success: true, data: { deletedNodeId: nodeId } }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// 创建连接
function createConnection(args: Record<string, unknown>): ToolCallResult {
  try {
    const { addConnection, nodes } = useCanvasStore.getState()
    const fromNodeId = String(args.fromNodeId)
    const toNodeId = String(args.toNodeId)

    if (!fromNodeId || !toNodeId) {
      return { success: false, error: '缺少源节点或目标节点 ID' }
    }

    // 智能计算端口位置：根据两个节点的相对位置
    const fromNode = nodes.get(fromNodeId)
    const toNode = nodes.get(toNodeId)
    if (!fromNode) {
      return { success: false, error: `节点不存在: ${fromNodeId},可用 getAllNodes 获取有效节点 ID` }
    }
    if (!toNode) {
      return { success: false, error: `节点不存在: ${toNodeId},可用 getAllNodes 获取有效节点 ID` }
    }
    let fromPort: Connection['fromPort'] = 'bottom'
    let toPort: Connection['toPort'] = 'top'

    if (fromNode && toNode) {
      const dx = toNode.x - fromNode.x
      const dy = toNode.y - fromNode.y

      // 根据相对位置决定端口
      if (Math.abs(dx) > Math.abs(dy)) {
        // 水平关系
        fromPort = dx > 0 ? 'right' : 'left'
        toPort = dx > 0 ? 'left' : 'right'
      } else {
        // 垂直关系
        fromPort = dy > 0 ? 'bottom' : 'top'
        toPort = dy > 0 ? 'top' : 'bottom'
      }
    }

    const connectionId = `conn-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    const connection: Connection = {
      id: connectionId,
      fromNodeId,
      toNodeId,
      fromPort: (args.fromPort as Connection['fromPort']) || fromPort,
      toPort: (args.toPort as Connection['toPort']) || toPort,
      type: (args.type as Connection['type']) || 'curve',
      style: (args.style as Connection['style']) || 'solid',
      color: String(args.color ?? '#3b82f6'),  // 默认蓝色
      width: Number(args.width ?? 2),
      arrowType: (args.arrowType as Connection['arrowType']) || 'end',
      direction: (args.direction as Connection['direction']) || 'directed',
      label: String(args.label || ''),
    }
    addConnection(connection)
    return { success: true, data: { connectionId, fromNodeId, toNodeId } }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// 删除连接
function deleteConnection(args: Record<string, unknown>): ToolCallResult {
  try {
    const { removeConnection, connections } = useCanvasStore.getState()
    const connectionId = String(args.connectionId)
    if (!connectionId) {
      return { success: false, error: '缺少连接 ID' }
    }
    if (!connections.has(connectionId)) {
      return { success: false, error: `连接不存在: ${connectionId},可用 getAllConnections 获取有效连接 ID` }
    }
    removeConnection(connectionId)
    return { success: true, data: { deletedConnectionId: connectionId } }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// 更新连接
function updateConnection(args: Record<string, unknown>): ToolCallResult {
  try {
    const { updateConnection, connections } = useCanvasStore.getState()
    const connectionId = String(args.connectionId)
    if (!connectionId) {
      return { success: false, error: '缺少连接 ID' }
    }
    const existingConnection = connections.get(connectionId)
    if (!existingConnection) {
      return { success: false, error: `连接不存在: ${connectionId},可用 getAllConnections 获取有效连接 ID` }
    }

    const updates: Partial<Connection> = {}
    if (args.fromNodeId !== undefined && args.fromNodeId !== null) updates.fromNodeId = String(args.fromNodeId)
    if (args.toNodeId !== undefined && args.toNodeId !== null) updates.toNodeId = String(args.toNodeId)
    if (args.fromPort !== undefined && args.fromPort !== null) updates.fromPort = args.fromPort as Connection['fromPort']
    if (args.toPort !== undefined && args.toPort !== null) updates.toPort = args.toPort as Connection['toPort']
    if (args.type !== undefined && args.type !== null) updates.type = args.type as Connection['type']
    if (args.style !== undefined && args.style !== null) updates.style = args.style as Connection['style']
    if (args.color !== undefined && args.color !== null) updates.color = String(args.color)
    if (args.width !== undefined && args.width !== null) updates.width = toFiniteNumber(args.width, existingConnection?.width ?? 2)
    if (args.arrowType !== undefined && args.arrowType !== null) updates.arrowType = args.arrowType as Connection['arrowType']
    if (args.direction !== undefined && args.direction !== null) updates.direction = args.direction as Connection['direction']
    if (args.label !== undefined && args.label !== null) updates.label = String(args.label)

    updateConnection(connectionId, updates)
    return { success: true, data: { connectionId, updates } }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// 计算节点集合的边界框
function calculateNodesBounds(nodeIds: string[], nodes: Map<string, Node>): { x: number; y: number; width: number; height: number } | null {
  if (nodeIds.length === 0) return null

  const validNodes = nodeIds
    .map((id) => nodes.get(id))
    .filter((n): n is Node => n !== undefined)

  if (validNodes.length === 0) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const node of validNodes) {
    minX = Math.min(minX, node.x)
    minY = Math.min(minY, node.y)
    maxX = Math.max(maxX, node.x + node.width)
    maxY = Math.max(maxY, node.y + node.height)
  }

  // 添加内边距
  const padding = 20
  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  }
}

// 创建组
function createGroup(args: Record<string, unknown>): ToolCallResult {
  try {
    const { addGroup, nodes } = useCanvasStore.getState()
    const nodeIds = (args.nodeIds as string[]) ?? []

    // 如果有节点ID，自动计算边界
    let bounds: { x: number; y: number; width: number; height: number } | null = null
    if (nodeIds.length > 0) {
      bounds = calculateNodesBounds(nodeIds, nodes)
    }
    // 指定的节点全部无效时不允许创建空容器
    if (nodeIds.length > 0 && bounds === null) {
      return { success: false, error: '指定的节点均不存在,可用 getAllNodes 获取有效节点 ID' }
    }

    const groupId = `group-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    const group: NodeGroup = {
      id: groupId,
      name: String(args.name || '新组'),
      description: String(args.description || ''),
      x: bounds?.x ?? Number(args.x ?? 0),
      y: bounds?.y ?? Number(args.y ?? 0),
      width: bounds?.width ?? Number(args.width ?? 300),
      height: bounds?.height ?? Number(args.height ?? 200),
      borderColor: String(args.borderColor ?? '#3b82f6'),
      backgroundColor: String(args.backgroundColor ?? 'rgba(59, 130, 246, 0.1)'),
      borderWidth: Number(args.borderWidth ?? 2),
      borderRadius: Number(args.borderRadius ?? 8),
      nodeIds: nodeIds,
      collapsed: Boolean(args.collapsed ?? false),
    }
    addGroup(group)
    return { success: true, data: { groupId, name: group.name, nodeCount: nodeIds.length } }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// 更新组
function updateGroup(args: Record<string, unknown>): ToolCallResult {
  try {
    const { updateGroup, groups } = useCanvasStore.getState()
    const groupId = String(args.groupId)
    if (!groupId) {
      return { success: false, error: '缺少组 ID' }
    }
    const existingGroup = groups.get(groupId)
    if (!existingGroup) {
      return { success: false, error: `组不存在: ${groupId},可用 getAllGroups 获取有效组 ID` }
    }

    const updates: Partial<NodeGroup> = {}
    if (args.name !== undefined && args.name !== null) updates.name = String(args.name)
    if (args.description !== undefined && args.description !== null) updates.description = String(args.description)
    if (args.nodeIds !== undefined && args.nodeIds !== null) updates.nodeIds = args.nodeIds as string[]
    if (args.x !== undefined && args.x !== null) updates.x = toFiniteNumber(args.x, existingGroup?.x ?? 0)
    if (args.y !== undefined && args.y !== null) updates.y = toFiniteNumber(args.y, existingGroup?.y ?? 0)
    if (args.width !== undefined && args.width !== null) updates.width = toFiniteNumber(args.width, existingGroup?.width ?? 300)
    if (args.height !== undefined && args.height !== null) updates.height = toFiniteNumber(args.height, existingGroup?.height ?? 200)
    if (args.borderColor !== undefined && args.borderColor !== null) updates.borderColor = String(args.borderColor)
    if (args.backgroundColor !== undefined && args.backgroundColor !== null) updates.backgroundColor = String(args.backgroundColor)
    if (args.borderWidth !== undefined && args.borderWidth !== null) updates.borderWidth = toFiniteNumber(args.borderWidth, existingGroup?.borderWidth ?? 2)
    if (args.borderRadius !== undefined && args.borderRadius !== null) updates.borderRadius = toFiniteNumber(args.borderRadius, existingGroup?.borderRadius ?? 8)
    if (args.collapsed !== undefined && args.collapsed !== null) updates.collapsed = Boolean(args.collapsed)

    updateGroup(groupId, updates)
    return { success: true, data: { groupId, updates } }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// 删除组
function deleteGroup(args: Record<string, unknown>): ToolCallResult {
  try {
    const { removeGroup, groups } = useCanvasStore.getState()
    const groupId = String(args.groupId)
    if (!groupId) {
      return { success: false, error: '缺少组 ID' }
    }
    if (!groups.has(groupId)) {
      return { success: false, error: `组不存在: ${groupId},可用 getAllGroups 获取有效组 ID` }
    }
    removeGroup(groupId)
    return { success: true, data: { deletedGroupId: groupId } }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// 创建域
function createDomain(args: Record<string, unknown>): ToolCallResult {
  try {
    const { addDomain, nodes } = useCanvasStore.getState()
    const nodeIds = (args.nodeIds as string[]) ?? []

    // 如果有节点ID，自动计算边界
    let bounds: { x: number; y: number; width: number; height: number } | null = null
    if (nodeIds.length > 0) {
      bounds = calculateNodesBounds(nodeIds, nodes)
    }
    // 指定的节点全部无效时不允许创建空容器
    if (nodeIds.length > 0 && bounds === null) {
      return { success: false, error: '指定的节点均不存在,可用 getAllNodes 获取有效节点 ID' }
    }

    const domainId = `domain-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    const domain: Domain = {
      id: domainId,
      name: String(args.name || '新域'),
      x: bounds?.x ?? Number(args.x ?? 0),
      y: bounds?.y ?? Number(args.y ?? 0),
      width: bounds?.width ?? Number(args.width ?? 400),
      height: bounds?.height ?? Number(args.height ?? 300),
      backgroundColor: String(args.backgroundColor ?? 'rgba(139, 92, 246, 0.1)'),
      titleVisible: Boolean(args.titleVisible ?? true),
    }
    addDomain(domain)
    return { success: true, data: { domainId, name: domain.name, nodeCount: nodeIds.length } }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// 更新域
function updateDomain(args: Record<string, unknown>): ToolCallResult {
  try {
    const { updateDomain, domains } = useCanvasStore.getState()
    const domainId = String(args.domainId)
    if (!domainId) {
      return { success: false, error: '缺少域 ID' }
    }
    const existingDomain = domains.get(domainId)
    if (!existingDomain) {
      return { success: false, error: `域不存在: ${domainId},可用 getAllDomains 获取有效域 ID` }
    }

    const updates: Partial<Domain> = {}
    if (args.name !== undefined && args.name !== null) updates.name = String(args.name)
    if (args.x !== undefined && args.x !== null) updates.x = toFiniteNumber(args.x, existingDomain?.x ?? 0)
    if (args.y !== undefined && args.y !== null) updates.y = toFiniteNumber(args.y, existingDomain?.y ?? 0)
    if (args.width !== undefined && args.width !== null) updates.width = toFiniteNumber(args.width, existingDomain?.width ?? 400)
    if (args.height !== undefined && args.height !== null) updates.height = toFiniteNumber(args.height, existingDomain?.height ?? 300)
    if (args.backgroundColor !== undefined && args.backgroundColor !== null) updates.backgroundColor = String(args.backgroundColor)
    if (args.titleVisible !== undefined && args.titleVisible !== null) updates.titleVisible = Boolean(args.titleVisible)
    if (args.titleColor !== undefined && args.titleColor !== null) updates.titleColor = String(args.titleColor)
    if (args.titleFontSize !== undefined && args.titleFontSize !== null) updates.titleFontSize = toFiniteNumber(args.titleFontSize, existingDomain?.titleFontSize ?? 14)
    if (args.titleScale !== undefined && args.titleScale !== null) updates.titleScale = toFiniteNumber(args.titleScale, existingDomain?.titleScale ?? 1)

    updateDomain(domainId, updates)
    return { success: true, data: { domainId, updates } }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// 删除域
function deleteDomain(args: Record<string, unknown>): ToolCallResult {
  try {
    const { removeDomain, domains } = useCanvasStore.getState()
    const domainId = String(args.domainId)
    if (!domainId) {
      return { success: false, error: '缺少域 ID' }
    }
    if (!domains.has(domainId)) {
      return { success: false, error: `域不存在: ${domainId},可用 getAllDomains 获取有效域 ID` }
    }
    removeDomain(domainId)
    return { success: true, data: { deletedDomainId: domainId } }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// 撤销上一步画布操作(R7)
async function undo(_args: Record<string, unknown>): Promise<ToolCallResult> {
  const store = useCanvasStore.getState()
  if (!store.canUndo()) {
    return { success: false, error: '没有可撤销的操作' }
  }
  await store.undo()
  return { success: true, data: { undone: true } }
}

// 重做被撤销的画布操作(R7)
async function redo(_args: Record<string, unknown>): Promise<ToolCallResult> {
  const store = useCanvasStore.getState()
  if (!store.canRedo()) {
    return { success: false, error: '没有可重做的操作' }
  }
  await store.redo()
  return { success: true, data: { redone: true } }
}

// 搜索节点(R8)
function searchNodes(args: Record<string, unknown>): ToolCallResult {
  try {
    const { nodes } = useCanvasStore.getState()
    const query = String(args.query || '').trim().toLowerCase()
    if (!query) {
      return { success: false, error: '缺少搜索关键词(query)' }
    }
    const scope = (args.scope as string) || 'all'
    const matches: Array<{ id: string; title: string; match: 'title' | 'content'; snippet: string }> = []

    for (const node of nodes.values()) {
      const title = node.title || ''
      const content = node.content || ''
      if (scope === 'title' || scope === 'all') {
        const index = title.toLowerCase().indexOf(query)
        if (index !== -1) {
          matches.push({ id: node.id, title, match: 'title', snippet: makeSnippet(title, index) })
          continue
        }
      }
      if (scope === 'content' || scope === 'all') {
        const index = content.toLowerCase().indexOf(query)
        if (index !== -1) {
          matches.push({ id: node.id, title, match: 'content', snippet: makeSnippet(content, index) })
        }
      }
    }

    return { success: true, data: { matches } }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// 截取命中片段(约 200 字符)
function makeSnippet(text: string, matchIndex: number): string {
  const maxLength = 200
  if (text.length <= maxLength) return text
  const start = Math.max(0, Math.min(matchIndex - 60, text.length - maxLength))
  const prefix = start > 0 ? '...' : ''
  const suffix = start + maxLength < text.length ? '...' : ''
  return prefix + text.slice(start, start + maxLength) + suffix
}

// 生成唯一ID
function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

// 根据角度计算端口方向
function getPortByAngle(angle: number): 'top' | 'right' | 'bottom' | 'left' {
  // 将角度归一化到 0-2π
  const normalizedAngle = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  // 将圆分为4个区域，每个区域90度
  // 0-45度和315-360度为 right
  // 45-135度为 bottom
  // 135-225度为 left
  // 225-315度为 top
  if (normalizedAngle < Math.PI / 4 || normalizedAngle >= (7 * Math.PI) / 4) {
    return 'right'
  } else if (normalizedAngle < (3 * Math.PI) / 4) {
    return 'bottom'
  } else if (normalizedAngle < (5 * Math.PI) / 4) {
    return 'left'
  } else {
    return 'top'
  }
}

// JSON节点定义接口 - 支持任意关系图
interface JSONGraphNode {
  id?: string
  title: string
  content?: string
  x?: number
  y?: number
  width?: number
  height?: number
  color?: string
  fontSize?: number
  textAlign?: 'left' | 'center' | 'right'
  titleAlign?: 'left' | 'center' | 'right'
  contentAlign?: 'left' | 'center' | 'right'
  collapsedTitleAlign?: 'left' | 'center' | 'right'
  collapsed?: boolean
  locked?: boolean
  type?: 'text' | 'image'
  imageUrl?: string
  aspectRatio?: number
}

// JSON连线定义接口 - 独立定义，支持任意关系
interface JSONGraphConnection {
  id?: string
  from: string  // 源节点ID或标题
  to: string    // 目标节点ID或标题
  fromPort?: 'top' | 'right' | 'bottom' | 'left'
  toPort?: 'top' | 'right' | 'bottom' | 'left'
  type?: 'straight' | 'curve' | 'step'
  style?: 'solid' | 'dashed' | 'dotted'
  color?: string
  width?: number
  arrowType?: 'none' | 'start' | 'end' | 'both'
  direction?: 'directed' | 'bidirectional' | 'undirected'
  label?: string
}

// JSON组定义接口
interface JSONGraphGroup {
  id?: string
  name: string
  description?: string
  nodeIds?: string[]  // 节点ID或标题数组
  x?: number
  y?: number
  width?: number
  height?: number
  borderColor?: string
  backgroundColor?: string
  borderWidth?: number
  borderRadius?: number
  collapsed?: boolean
}

// JSON域定义接口
interface JSONGraphDomain {
  id?: string
  name: string
  nodeIds?: string[]  // 节点ID或标题数组
  x?: number
  y?: number
  width?: number
  height?: number
  backgroundColor?: string
  titleVisible?: boolean
  titleColor?: string
  titleFontSize?: number
  titleScale?: number
}

// JSON图形完整数据结构 - 支持任意关系图
interface JSONGraphData {
  // 布局配置（可选，用于自动计算未指定坐标的节点位置）
  layout?: {
    type?: 'grid' | 'circle' | 'hierarchy' | 'force' | 'custom'
    centerX?: number
    centerY?: number
    spacing?: number  // 节点间距
    columns?: number  // grid布局的列数
  }
  // 默认节点样式（所有节点属性均可设置默认值）
  defaultNodeStyle?: {
    content?: string
    width?: number
    height?: number
    color?: string
    fontSize?: number
    textAlign?: 'left' | 'center' | 'right'
    titleAlign?: 'left' | 'center' | 'right'
    contentAlign?: 'left' | 'center' | 'right'
    collapsedTitleAlign?: 'left' | 'center' | 'right'
    collapsed?: boolean
    locked?: boolean
    type?: 'text' | 'image'
    imageUrl?: string
    aspectRatio?: number
  }
  // 默认连接样式
  defaultConnectionStyle?: {
    type?: 'straight' | 'curve' | 'step'
    style?: 'solid' | 'dashed' | 'dotted'
    color?: string
    width?: number
    arrowType?: 'none' | 'start' | 'end' | 'both'
    direction?: 'directed' | 'bidirectional' | 'undirected'
  }
  // 节点数组（必须）
  nodes: JSONGraphNode[]
  // 连线数组（可选，不指定则不创建连线）
  connections?: JSONGraphConnection[]
  // 组数组（可选）
  groups?: JSONGraphGroup[]
  // 域数组（可选）
  domains?: JSONGraphDomain[]
}

// 从JSON生成图形（支持任意节点和连线关系）
function generateMindMapFromJSON(args: Record<string, unknown>): ToolCallResult {
  try {
    const { addNode, addConnection, addGroup, addDomain } = useCanvasStore.getState()
    const data = args.data as JSONGraphData

    // 验证数据是否存在
    if (!data) {
      return {
        success: false,
        error: '缺少图形数据参数。请确保提供了有效的 data 参数，包含 nodes 节点数组。',
      }
    }

    // 验证 nodes 是否为数组
    if (!Array.isArray(data.nodes)) {
      return {
        success: false,
        error: `nodes 必须是数组类型，但收到的是 ${typeof data.nodes}。请确保 JSON 格式正确，nodes 应该是一个包含节点对象的数组。`,
      }
    }

    // 验证 nodes 是否为空
    if (data.nodes.length === 0) {
      return {
        success: false,
        error: 'nodes 数组不能为空。请至少提供一个节点对象，包含 title 属性。',
      }
    }

    // 验证每个节点是否有 title
    interface InvalidNodeInfo {
      index: number
      reason: string
    }
    const invalidNodes: InvalidNodeInfo[] = []
    data.nodes.forEach((node, index) => {
      if (!node || typeof node !== 'object') {
        invalidNodes.push({ index, reason: '节点不是有效的对象' })
      } else if (!node.title || typeof node.title !== 'string' || node.title.trim() === '') {
        invalidNodes.push({ index, reason: '缺少 title 属性或 title 为空字符串' })
      }
    })

    if (invalidNodes.length > 0) {
      const errorDetails = invalidNodes
        .map((item) => `第 ${item.index + 1} 个节点: ${item.reason}`)
        .join('\n')
      return {
        success: false,
        error: `发现 ${invalidNodes.length} 个无效节点:\n${errorDetails}\n\n每个节点必须包含一个非空的 title 属性。`,
      }
    }

    const nodeIdMap = new Map<string, string>()  // 标题/自定义ID -> 实际ID
    const nodes: Node[] = []
    const connections: Connection[] = []
    // C9: 冲突防护——AI 传入的 id 可能与画布已有实体或本批次实体重复，
    // 重复会导致 addNode 等静默覆盖已有实体，必须为冲突 id 重新生成。
    const usedNodeIds = new Set<string>()
    const existingNodeIds = new Set(useCanvasStore.getState().nodes.keys())
    const existingConnectionIds = new Set(useCanvasStore.getState().connections.keys())
    const existingGroupIds = new Set(useCanvasStore.getState().groups.keys())
    const existingDomainIds = new Set(useCanvasStore.getState().domains.keys())

    // 第一步：创建所有节点
    data.nodes.forEach((nodeData, index) => {
      let nodeId = nodeData.id || generateId('node')
      while (usedNodeIds.has(nodeId) || existingNodeIds.has(nodeId)) {
        nodeId = generateId('node')
      }
      usedNodeIds.add(nodeId)
      const key = nodeData.id || nodeData.title
      nodeIdMap.set(key, nodeId)

      // 计算位置（如果未指定）
      let x = nodeData.x
      let y = nodeData.y

      if (x === undefined || y === undefined) {
        const layout = data.layout
        const layoutType = layout?.type || 'grid'
        const spacing = layout?.spacing || 250
        const centerX = layout?.centerX || 0
        const centerY = layout?.centerY || 0

        if (layoutType === 'grid') {
          const columns = layout?.columns || 3
          const row = Math.floor(index / columns)
          const col = index % columns
          x = centerX + (col - (columns - 1) / 2) * spacing
          y = centerY + (row - Math.floor(data.nodes.length / columns) / 2) * spacing
        } else if (layoutType === 'circle') {
          const angle = (index / data.nodes.length) * 2 * Math.PI
          const radius = spacing * 2
          x = centerX + Math.cos(angle) * radius
          y = centerY + Math.sin(angle) * radius
        } else {
          // 默认网格布局
          const columns = 3
          const row = Math.floor(index / columns)
          const col = index % columns
          x = centerX + (col - 1) * spacing
          y = centerY + (row - 1) * spacing
        }
      }

      const defaultStyle = data.defaultNodeStyle || {}
      const node: Node = {
        id: nodeId,
        title: nodeData.title,
        content: nodeData.content ?? defaultStyle.content ?? '',
        x: x!,
        y: y!,
        width: nodeData.width ?? defaultStyle.width ?? 200,
        height: nodeData.height ?? defaultStyle.height ?? 160,
        color: nodeData.color ?? defaultStyle.color ?? '#ffffff',
        fontSize: nodeData.fontSize ?? defaultStyle.fontSize ?? 14,
        textAlign: nodeData.textAlign ?? defaultStyle.textAlign ?? 'center',
        titleAlign: nodeData.titleAlign ?? defaultStyle.titleAlign,
        contentAlign: nodeData.contentAlign ?? defaultStyle.contentAlign,
        collapsedTitleAlign: nodeData.collapsedTitleAlign ?? defaultStyle.collapsedTitleAlign,
        collapsed: nodeData.collapsed ?? defaultStyle.collapsed ?? false,
        locked: nodeData.locked ?? defaultStyle.locked ?? false,
        type: nodeData.type ?? defaultStyle.type ?? 'text',
        imageUrl: nodeData.imageUrl ?? defaultStyle.imageUrl,
        aspectRatio: nodeData.aspectRatio ?? defaultStyle.aspectRatio,
      }
      nodes.push(node)
    })

    // 第二步：创建所有连线
    if (data.connections && Array.isArray(data.connections)) {
      const usedConnectionIds = new Set<string>()
      data.connections.forEach((connData) => {
        // 解析源节点和目标节点ID
        const fromNodeId = nodeIdMap.get(connData.from) ||
          nodes.find((n) => n.title === connData.from)?.id
        const toNodeId = nodeIdMap.get(connData.to) ||
          nodes.find((n) => n.title === connData.to)?.id

        if (!fromNodeId || !toNodeId) {
          return
        }

        // 获取节点位置用于计算端口
        const fromNode = nodes.find((n) => n.id === fromNodeId)
        const toNode = nodes.find((n) => n.id === toNodeId)

        let fromPort = connData.fromPort
        let toPort = connData.toPort

        // 自动计算端口（如果未指定）
        // 从源节点指向目标节点的角度决定端口：
        // - 源节点使用指向目标的方向的端口
        // - 目标节点使用相反方向的端口
        if (!fromPort || !toPort) {
          if (fromNode && toNode) {
            const dx = toNode.x - fromNode.x
            const dy = toNode.y - fromNode.y
            const angle = Math.atan2(dy, dx)
            // 源节点端口：指向目标节点的方向
            fromPort = fromPort ?? getPortByAngle(angle)
            // 目标节点端口：来自源节点的反方向
            toPort = toPort ?? getPortByAngle(angle + Math.PI)
          } else {
            fromPort = fromPort ?? 'bottom'
            toPort = toPort ?? 'top'
          }
        }

        const defaultConnStyle = data.defaultConnectionStyle || {}
        // C9: 连线 id 冲突时重新生成
        let connId = connData.id || generateId('conn')
        while (usedConnectionIds.has(connId) || existingConnectionIds.has(connId)) {
          connId = generateId('conn')
        }
        usedConnectionIds.add(connId)
        const connection: Connection = {
          id: connId,
          fromNodeId,
          toNodeId,
          fromPort: fromPort!,
          toPort: toPort!,
          type: connData.type ?? defaultConnStyle.type ?? 'curve',
          style: connData.style ?? defaultConnStyle.style ?? 'solid',
          color: connData.color ?? defaultConnStyle.color ?? '#666666',
          width: connData.width ?? defaultConnStyle.width ?? 2,
          arrowType: connData.arrowType ?? defaultConnStyle.arrowType ?? 'end',
          direction: connData.direction ?? defaultConnStyle.direction ?? 'directed',
          label: connData.label ?? '',
        }
        connections.push(connection)
      })
    }

    // 第三步：添加所有节点到画布
    nodes.forEach((node) => addNode(node))

    // 第四步：添加所有连接到画布
    connections.forEach((conn) => addConnection(conn))

    // 第五步：处理组
    let groupsCreated = 0
    if (data.groups && Array.isArray(data.groups)) {
      const usedGroupIds = new Set<string>()
      data.groups.forEach((groupData) => {
        let groupId = groupData.id || generateId('group')
        // C9: 组 id 冲突时重新生成
        while (usedGroupIds.has(groupId) || existingGroupIds.has(groupId)) {
          groupId = generateId('group')
        }
        usedGroupIds.add(groupId)

        // 解析节点ID
        const resolvedNodeIds = (groupData.nodeIds || [])
          .map((id) => nodeIdMap.get(id) || nodes.find((n) => n.title === id)?.id)
          .filter((id): id is string => id !== undefined)

        // 获取组包含的节点
        const groupNodes = nodes.filter((n) => resolvedNodeIds.includes(n.id))

        // 自动计算组的边界（如果未指定位置或尺寸）
        let groupX = groupData.x
        let groupY = groupData.y
        let groupWidth = groupData.width
        let groupHeight = groupData.height

        if (groupNodes.length > 0) {
          // 计算节点的边界框（节点的x,y是左上角坐标）
          const nodeLefts = groupNodes.map((n) => n.x)
          const nodeRights = groupNodes.map((n) => n.x + n.width)
          const nodeTops = groupNodes.map((n) => n.y)
          const nodeBottoms = groupNodes.map((n) => n.y + n.height)

          const minX = Math.min(...nodeLefts)
          const maxX = Math.max(...nodeRights)
          const minY = Math.min(...nodeTops)
          const maxY = Math.max(...nodeBottoms)

          // 如果没有指定位置，使用边界框的位置（带边距）
          const padding = 30
          if (groupX === undefined) {
            groupX = minX - padding
          }
          if (groupY === undefined) {
            groupY = minY - padding
          }
          if (groupWidth === undefined) {
            groupWidth = maxX - minX + padding * 2
          }
          if (groupHeight === undefined) {
            groupHeight = maxY - minY + padding * 2
          }
        }

        const group: NodeGroup = {
          id: groupId,
          name: groupData.name,
          description: groupData.description || '',
          x: groupX ?? 0,
          y: groupY ?? 0,
          width: groupWidth ?? 300,
          height: groupHeight ?? 200,
          borderColor: groupData.borderColor ?? '#3b82f6',
          backgroundColor: groupData.backgroundColor ?? 'rgba(59, 130, 246, 0.1)',
          borderWidth: groupData.borderWidth ?? 2,
          borderRadius: groupData.borderRadius ?? 8,
          nodeIds: resolvedNodeIds,
          collapsed: groupData.collapsed ?? false,
        }
        addGroup(group)
        groupsCreated++
      })
    }

    // 第六步：处理域
    let domainsCreated = 0
    if (data.domains && Array.isArray(data.domains)) {
      const usedDomainIds = new Set<string>()
      data.domains.forEach((domainData) => {
        let domainId = domainData.id || generateId('domain')
        // C9: 域 id 冲突时重新生成
        while (usedDomainIds.has(domainId) || existingDomainIds.has(domainId)) {
          domainId = generateId('domain')
        }
        usedDomainIds.add(domainId)

        // 解析节点ID
        const resolvedNodeIds = (domainData.nodeIds || [])
          .map((id) => nodeIdMap.get(id) || nodes.find((n) => n.title === id)?.id)
          .filter((id): id is string => id !== undefined)

        // 获取域包含的节点
        const domainNodes = nodes.filter((n) => resolvedNodeIds.includes(n.id))

        // 自动计算域的边界（如果未指定位置或尺寸）
        let domainX = domainData.x
        let domainY = domainData.y
        let domainWidth = domainData.width
        let domainHeight = domainData.height

        if (domainNodes.length > 0) {
          // 计算节点的边界框（节点的x,y是左上角坐标）
          const nodeLefts = domainNodes.map((n) => n.x)
          const nodeRights = domainNodes.map((n) => n.x + n.width)
          const nodeTops = domainNodes.map((n) => n.y)
          const nodeBottoms = domainNodes.map((n) => n.y + n.height)

          const minX = Math.min(...nodeLefts)
          const maxX = Math.max(...nodeRights)
          const minY = Math.min(...nodeTops)
          const maxY = Math.max(...nodeBottoms)

          // 如果没有指定位置，使用边界框的位置（带边距）
          const padding = 40
          if (domainX === undefined) {
            domainX = minX - padding
          }
          if (domainY === undefined) {
            domainY = minY - padding
          }
          if (domainWidth === undefined) {
            domainWidth = maxX - minX + padding * 2
          }
          if (domainHeight === undefined) {
            domainHeight = maxY - minY + padding * 2
          }
        }

        const domain: Domain = {
          id: domainId,
          name: domainData.name,
          x: domainX ?? 0,
          y: domainY ?? 0,
          width: domainWidth ?? 400,
          height: domainHeight ?? 300,
          backgroundColor: domainData.backgroundColor ?? 'rgba(139, 92, 246, 0.1)',
          titleVisible: domainData.titleVisible ?? true,
          titleColor: domainData.titleColor,
          titleFontSize: domainData.titleFontSize,
          titleScale: domainData.titleScale,
        }
        addDomain(domain)
        domainsCreated++
      })
    }

    return {
      success: true,
      data: {
        nodesCreated: nodes.length,
        connectionsCreated: connections.length,
        groupsCreated,
        domainsCreated,
        nodeIds: nodes.map((n) => n.id),
      },
    }
  } catch (error) {
    // 提供友好的错误提示
    const errorMessage = String(error)

    // 检测常见的 JSON 格式错误
    if (errorMessage.includes('Expected double-quoted property name') ||
      errorMessage.includes('Unexpected token') ||
      errorMessage.includes('is not valid JSON') ||
      errorMessage.includes('Unterminated string')) {
      return {
        success: false,
        error: `JSON 格式错误: ${errorMessage}\n\n这通常是因为 AI 模型生成的 JSON 格式不正确。可能的原因:\n1. 属性名没有用双引号包裹（如 {name: "value"} 应该是 {"name": "value"}）\n2. 使用了单引号而不是双引号\n3. JSON 被截断或不完整（AI 输出被截断）\n4. 字符串中包含未转义的换行符或引号\n\n建议:\n1. 如果是生成思维导图，请尝试简化需求，减少节点数量\n2. 重新发送请求，让 AI 重新生成`,
      }
    }

    // 检测属性访问错误
    if (errorMessage.includes('Cannot read properties') ||
      errorMessage.includes('undefined')) {
      return {
        success: false,
        error: `数据访问错误: ${errorMessage}\n\n这通常是因为数据结构中缺少必要的属性。请确保:\n1. 所有节点都有 title 属性\n2. nodes 是一个数组\n3. 所有必需的字段都已提供`,
      }
    }

    return {
      success: false,
      error: `生成图形时出错: ${errorMessage}\n\n如果问题持续存在，请检查:\n1. JSON 数据格式是否正确\n2. 所有节点是否都有 title 属性\n3. 连线中的 from/to 是否引用了有效的节点`,
    }
  }
}

// 工具定义列表
export const AI_TOOLS: Array<{
  name: string
  description: string
  parameters: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<ToolCallResult> | ToolCallResult
}> = [
    {
      name: 'getAllNodes',
      description: '获取画布上所有节点的列表，包含节点的标题、内容、类型等信息',
      parameters: {},
      handler: getAllNodes,
    },
    {
      name: 'getAllConnections',
      description: '获取画布上所有连接的列表，包含连接的起点、终点、标签、类型、样式等信息',
      parameters: {},
      handler: getAllConnections,
    },
    {
      name: 'getAllGroups',
      description: '获取画布上所有组的列表，包含组的名称、描述、包含的节点、折叠状态等信息',
      parameters: {},
      handler: getAllGroups,
    },
    {
      name: 'getAllDomains',
      description: '获取画布上所有域的列表，包含域的ID和名称',
      parameters: {},
      handler: getAllDomains,
    },
    {
      name: 'getCanvasData',
      description: '获取画布的完整数据，包括所有节点、连接、组和域',
      parameters: {},
      handler: getCanvasData,
    },
    {
      name: 'createNode',
      description: '在画布上创建一个新节点。建议节点大小不小于200x160以确保内容显示完整。创建成功会返回 nodeId(形如 node-xxx)。建议先调用 getCanvasData 了解画布现有布局再指定 x/y 坐标,避免节点重叠',
      parameters: {
        title: { type: 'string', description: '节点标题', required: true },
        content: { type: 'string', description: '节点内容' },
        x: { type: 'number', description: 'X 坐标位置' },
        y: { type: 'number', description: 'Y 坐标位置' },
        width: { type: 'number', description: '节点宽度，默认200，建议不小于200' },
        height: { type: 'number', description: '节点高度，默认160，建议不小于160' },
        color: { type: 'string', description: '节点背景颜色，十六进制格式。建议使用浅色（如#e3f2fd、#f3e5f5、#e8f5e9），避免使用深色（如#000000、#333333）以免影响文字可读性' },
        fontSize: { type: 'number', description: '字体大小，默认14' },
        textAlign: { type: 'string', enum: ['left', 'center', 'right'], description: '文本统一对齐方式，默认center居中' },
        titleAlign: { type: 'string', enum: ['left', 'center', 'right'], description: '标题对齐方式，单独设置标题对齐' },
        contentAlign: { type: 'string', enum: ['left', 'center', 'right'], description: '内容对齐方式，单独设置内容对齐' },
        collapsedTitleAlign: { type: 'string', enum: ['left', 'center', 'right'], description: '折叠状态下标题对齐方式' },
        collapsed: { type: 'boolean', description: '是否折叠，默认false' },
        locked: { type: 'boolean', description: '是否锁定，默认false' },
        type: { type: 'string', enum: ['text', 'image'], description: '节点类型，默认text文本节点，可选image图片节点' },
        imageUrl: { type: 'string', description: '图片URL地址，当type为image时必填' },
        aspectRatio: { type: 'number', description: '图片宽高比，用于保持图片比例，如1.5表示宽:高=3:2' },
      },
      handler: createNode,
    },
    {
      name: 'updateNode',
      description: '更新现有节点的属性，包括标题、内容、位置、大小、颜色、字体大小、对齐方式和折叠/锁定状态。建议节点大小不小于200x160以确保内容显示完整。节点 ID 通过 getAllNodes 或 createNode 返回值获取',
      parameters: {
        nodeId: { type: 'string', description: '要更新的节点 ID', required: true },
        title: { type: 'string', description: '新的节点标题', nullable: true },
        content: { type: 'string', description: '新的节点内容', nullable: true },
        x: { type: 'number', description: '新的 X 坐标', nullable: true },
        y: { type: 'number', description: '新的 Y 坐标', nullable: true },
        width: { type: 'number', description: '新的节点宽度，建议不小于200', nullable: true },
        height: { type: 'number', description: '新的节点高度，建议不小于160', nullable: true },
        color: { type: 'string', description: '新的节点颜色，十六进制格式', nullable: true },
        fontSize: { type: 'number', description: '新的字体大小', nullable: true },
        textAlign: { type: 'string', enum: ['left', 'center', 'right'], description: '文本统一对齐方式', nullable: true },
        titleAlign: { type: 'string', enum: ['left', 'center', 'right'], description: '标题对齐方式', nullable: true },
        contentAlign: { type: 'string', enum: ['left', 'center', 'right'], description: '内容对齐方式', nullable: true },
        collapsedTitleAlign: { type: 'string', enum: ['left', 'center', 'right'], description: '折叠状态下标题对齐方式', nullable: true },
        collapsed: { type: 'boolean', description: '是否折叠', nullable: true },
        locked: { type: 'boolean', description: '是否锁定', nullable: true },
        type: { type: 'string', enum: ['text', 'image'], description: '节点类型，可切换为image图片节点', nullable: true },
        imageUrl: { type: 'string', description: '图片URL地址，切换为图片节点时必填', nullable: true },
        aspectRatio: { type: 'number', description: '图片宽高比', nullable: true },
      },
      handler: updateNode,
    },
    {
      name: 'batchUpdateNodes',
      description: '批量更新多个节点的相同属性,适用于统一修改(如全部改颜色、全部移动)。传入节点ID列表和要修改的字段,未提供的字段保持不变;不存在的节点会被跳过并记录',
      parameters: {
        nodeIds: { type: 'array', items: { type: 'string' }, description: '要更新的节点 ID 列表', required: true },
        title: { type: 'string', description: '新的节点标题', nullable: true },
        content: { type: 'string', description: '新的节点内容', nullable: true },
        x: { type: 'number', description: '新的 X 坐标', nullable: true },
        y: { type: 'number', description: '新的 Y 坐标', nullable: true },
        width: { type: 'number', description: '新的节点宽度，建议不小于200', nullable: true },
        height: { type: 'number', description: '新的节点高度，建议不小于160', nullable: true },
        color: { type: 'string', description: '新的节点颜色，十六进制格式', nullable: true },
        fontSize: { type: 'number', description: '新的字体大小', nullable: true },
        textAlign: { type: 'string', enum: ['left', 'center', 'right'], description: '文本统一对齐方式', nullable: true },
        titleAlign: { type: 'string', enum: ['left', 'center', 'right'], description: '标题对齐方式', nullable: true },
        contentAlign: { type: 'string', enum: ['left', 'center', 'right'], description: '内容对齐方式', nullable: true },
        collapsedTitleAlign: { type: 'string', enum: ['left', 'center', 'right'], description: '折叠状态下标题对齐方式', nullable: true },
        collapsed: { type: 'boolean', description: '是否折叠', nullable: true },
        locked: { type: 'boolean', description: '是否锁定', nullable: true },
        type: { type: 'string', enum: ['text', 'image'], description: '节点类型，可切换为image图片节点', nullable: true },
        imageUrl: { type: 'string', description: '图片URL地址，切换为图片节点时必填', nullable: true },
        aspectRatio: { type: 'number', description: '图片宽高比', nullable: true },
      },
      handler: batchUpdateNodes,
    },
    {
      name: 'undo',
      description: '撤销上一步画布操作(AI 或用户的操作)。AI 的所有写操作都会进入撤销历史,可用于纠正误操作。无操作可撤销时返回错误',
      parameters: {},
      handler: undo,
    },
    {
      name: 'redo',
      description: '重做被撤销的画布操作。无操作可重做时返回错误',
      parameters: {},
      handler: redo,
    },
    {
      name: 'searchNodes',
      description: '在画布节点中搜索,按标题和/或内容匹配关键词(不区分大小写),返回匹配节点列表及命中片段',
      parameters: {
        query: { type: 'string', description: '搜索关键词', required: true },
        scope: { type: 'string', enum: ['title', 'content', 'all'], description: '搜索范围,默认 all(标题+内容)' },
      },
      handler: searchNodes,
    },
    {
      name: 'deleteNode',
      description: '删除指定的节点及其相关连接。节点 ID 通过 getAllNodes 或 createNode 返回值获取',
      parameters: {
        nodeId: { type: 'string', description: '要删除的节点 ID', required: true },
      },
      handler: deleteNode,
    },
    {
      name: 'createConnection',
      description: '在两个节点之间创建连接。系统会根据节点相对位置自动选择最佳端口（水平连接使用左右端口，垂直连接使用上下端口），默认创建蓝色连线。源节点和目标节点必须已存在，节点 ID 通过 getAllNodes 或 createNode 返回值获取',
      parameters: {
        fromNodeId: { type: 'string', description: '源节点 ID', required: true },
        toNodeId: { type: 'string', description: '目标节点 ID', required: true },
        fromPort: { type: 'string', enum: ['top', 'right', 'bottom', 'left'], description: '源端口位置，如不指定则自动根据节点位置计算' },
        toPort: { type: 'string', enum: ['top', 'right', 'bottom', 'left'], description: '目标端口位置，如不指定则自动根据节点位置计算' },
        type: { type: 'string', enum: ['straight', 'curve', 'step'], description: '连线类型，默认curve曲线' },
        style: { type: 'string', enum: ['solid', 'dashed', 'dotted'], description: '连线样式，默认solid实线' },
        color: { type: 'string', description: '连线颜色，十六进制格式，默认蓝色#3b82f6' },
        width: { type: 'number', description: '连线宽度，默认2像素' },
        label: { type: 'string', description: '连接标签文本' },
        arrowType: { type: 'string', enum: ['none', 'start', 'end', 'both'], description: '箭头类型，默认end在终点显示箭头' },
        direction: { type: 'string', enum: ['directed', 'bidirectional', 'undirected'], description: '方向类型，默认directed有向' },
      },
      handler: createConnection,
    },
    {
      name: 'deleteConnection',
      description: '删除指定的连接。连接 ID 通过 getAllConnections 获取',
      parameters: {
        connectionId: { type: 'string', description: '要删除的连接 ID', required: true },
      },
      handler: deleteConnection,
    },
    {
      name: 'updateConnection',
      description: '更新现有连接的属性，包括连线类型、样式、方向、箭头类型、颜色、宽度、标签和端口位置。连接 ID 通过 getAllConnections 获取',
      parameters: {
        connectionId: { type: 'string', description: '要更新的连接 ID', required: true },
        fromNodeId: { type: 'string', description: '新的源节点 ID', nullable: true },
        toNodeId: { type: 'string', description: '新的目标节点 ID', nullable: true },
        fromPort: { type: 'string', enum: ['top', 'right', 'bottom', 'left'], description: '新的源端口位置', nullable: true },
        toPort: { type: 'string', enum: ['top', 'right', 'bottom', 'left'], description: '新的目标端口位置', nullable: true },
        type: { type: 'string', enum: ['straight', 'curve', 'step'], description: '连线类型：直线、曲线、阶梯', nullable: true },
        style: { type: 'string', enum: ['solid', 'dashed', 'dotted'], description: '连线样式：实线、虚线、点线', nullable: true },
        color: { type: 'string', description: '连线颜色（十六进制颜色码，如 #666666）', nullable: true },
        width: { type: 'number', description: '连线宽度（像素）', nullable: true },
        arrowType: { type: 'string', enum: ['none', 'start', 'end', 'both'], description: '箭头类型：无箭头、起点箭头、终点箭头、双向箭头', nullable: true },
        direction: { type: 'string', enum: ['directed', 'bidirectional', 'undirected'], description: '方向类型：有向、双向、无向', nullable: true },
        label: { type: 'string', description: '连接标签文本', nullable: true },
      },
      handler: updateConnection,
    },
    {
      name: 'createGroup',
      description: `创建一个新组，用于将多个相关节点组合在一起。组是带边框的容器，适合小范围紧密组合。传入节点ID列表后，系统会自动计算边界框覆盖所有节点`,
      parameters: {
        name: { type: 'string', description: '组名称，如"家庭"、"团队"、"模块"等' },
        description: { type: 'string', description: '组的详细描述' },
        nodeIds: { type: 'array', items: { type: 'string' }, description: '包含的节点 ID 列表。提供此参数后，系统会自动计算组的位置和大小以覆盖所有节点' },
      },
      handler: createGroup,
    },
    {
      name: 'updateGroup',
      description: '更新现有组的属性，包括名称、描述、位置、大小、颜色、边框样式和包含的节点。组 ID 通过 getAllGroups 获取',
      parameters: {
        groupId: { type: 'string', description: '要更新的组 ID', required: true },
        name: { type: 'string', description: '新的组名称', nullable: true },
        description: { type: 'string', description: '新的组描述', nullable: true },
        nodeIds: { type: 'array', items: { type: 'string' }, description: '新的节点 ID 列表', nullable: true },
        x: { type: 'number', description: '新的 X 坐标位置', nullable: true },
        y: { type: 'number', description: '新的 Y 坐标位置', nullable: true },
        width: { type: 'number', description: '新的宽度', nullable: true },
        height: { type: 'number', description: '新的高度', nullable: true },
        borderColor: { type: 'string', description: '边框颜色，十六进制格式，如#3b82f6', nullable: true },
        backgroundColor: { type: 'string', description: '背景颜色，十六进制格式或rgba，如rgba(59, 130, 246, 0.1)', nullable: true },
        borderWidth: { type: 'number', description: '边框宽度，如2', nullable: true },
        borderRadius: { type: 'number', description: '边框圆角，如8', nullable: true },
        collapsed: { type: 'boolean', description: '是否折叠', nullable: true },
      },
      handler: updateGroup,
    },
    {
      name: 'deleteGroup',
      description: '删除指定的组。组 ID 通过 getAllGroups 获取',
      parameters: {
        groupId: { type: 'string', description: '要删除的组 ID', required: true },
      },
      handler: deleteGroup,
    },
    {
      name: 'createDomain',
      description: `创建一个新域，用于划分画布的特定区域。域是背景级别的容器，适合大范围划分。传入节点ID列表后，系统会自动计算边界框覆盖所有节点`,
      parameters: {
        name: { type: 'string', description: '域名称，如"研发部"、"销售区"、"决策层"等' },
        nodeIds: { type: 'array', items: { type: 'string' }, description: '包含的节点 ID 列表。提供此参数后，系统会自动计算域的位置和大小以覆盖所有节点' },
      },
      handler: createDomain,
    },
    {
      name: 'updateDomain',
      description: '更新现有域的属性，包括名称、位置、大小、背景颜色和标题样式。域 ID 通过 getAllDomains 获取',
      parameters: {
        domainId: { type: 'string', description: '要更新的域 ID', required: true },
        name: { type: 'string', description: '新的域名称', nullable: true },
        x: { type: 'number', description: '新的 X 坐标位置', nullable: true },
        y: { type: 'number', description: '新的 Y 坐标位置', nullable: true },
        width: { type: 'number', description: '新的宽度', nullable: true },
        height: { type: 'number', description: '新的高度', nullable: true },
        backgroundColor: { type: 'string', description: '背景颜色，十六进制格式或rgba，如rgba(139, 92, 246, 0.1)', nullable: true },
        titleVisible: { type: 'boolean', description: '标题是否可见', nullable: true },
        titleColor: { type: 'string', description: '标题颜色，十六进制格式', nullable: true },
        titleFontSize: { type: 'number', description: '标题字体大小', nullable: true },
        titleScale: { type: 'number', description: '标题缩放比例', nullable: true },
      },
      handler: updateDomain,
    },
    {
      name: 'deleteDomain',
      description: '删除指定的域。域 ID 通过 getAllDomains 获取',
      parameters: {
        domainId: { type: 'string', description: '要删除的域 ID', required: true },
      },
      handler: deleteDomain,
    },
    {
      name: 'generateMindMapFromJSON',
      description: `通过JSON数据结构生成图形。支持任意节点和连线关系，可创建复杂的对象关系图、流程图、网络拓扑图、类图等，不限于树状思维导图。

【核心特性】
- 节点和连线完全独立定义，无层级限制
- 支持任意复杂的对象关系（多对多、循环引用、自连接等）
- 每个连线可独立配置样式（颜色、线型、箭头、标签）
- 支持组和域来组织节点
- 节点坐标可精确指定或由系统自动布局

【工作流程】
1. 分析用户需求，识别所有对象（节点）和它们之间的关系（连线）
2. 设计JSON数据结构：
   - 在nodes数组中定义所有节点（每个节点必须有title）
   - 在connections数组中定义所有连线（使用from/to指定节点关系）
   - 可选：使用groups/domains组织节点
3. 调用此工具，传入完整的JSON数据
4. 系统自动生成所有节点、连线、组和域

【JSON数据结构详解】

1. nodes - 节点数组（必须，至少一个节点）
   每个节点对象包含：
   - id: 节点唯一标识（可选，不提供则自动生成）
   - title: 节点标题（必须，用于显示和引用）
   - content: 节点内容（可选）
   - x, y: 坐标（可选，未指定则使用自动布局）
   - width, height: 尺寸（可选，默认200x160，建议不小于200x160以避免内容显示不全）
   - color: 背景色（可选，默认#ffffff）。建议使用浅色背景（如#e3f2fd淡蓝、#f3e5f5淡紫、#e8f5e9淡绿、#fff3e0淡橙），避免使用深色背景（如#000000、#333333、#1a1a1a）以免影响文字可读性
   - fontSize: 字体大小（可选，默认14）
   - textAlign: 文本对齐（可选，left/center/right）
   - titleAlign/contentAlign/collapsedTitleAlign: 对齐方式（可选）
   - collapsed: 是否折叠（可选，默认false）
   - locked: 是否锁定（可选，默认false）
   - type: 节点类型（可选，text/image）
   - imageUrl: 图片URL（type为image时）
   - aspectRatio: 图片宽高比（可选）

   建议：width >= 200, height >= 160，以确保节点内容有足够显示空间

2. connections - 连线数组（可选）
   每个连线对象包含：
   - from: 源节点ID或标题（必须）
   - to: 目标节点ID或标题（必须）
   - fromPort/toPort: 连接端口（可选，top/right/bottom/left）
     * 自动计算规则：系统根据节点相对位置自动选择最佳端口
     * 例如：A在B的左侧，则A使用right端口，B使用left端口
     * 如需精确控制，可手动指定端口
   - type: 线型（可选，straight/curve/step，默认curve）
   - style: 样式（可选，solid/dashed/dotted，默认solid）
     * solid: 实线，用于正常关系
     * dashed: 虚线，用于依赖、关联关系
     * dotted: 点线，用于弱关联、可选关系
   - color: 颜色（可选，默认#666666）
   - width: 线宽（可选，默认2）
   - arrowType: 箭头（可选，none/start/end/both，默认end）
     * none: 无箭头，用于无方向关系
     * start: 起点箭头，用于被指向关系
     * end: 终点箭头，用于指向关系（默认）
     * both: 双向箭头，用于双向关系
   - direction: 方向（可选，directed/bidirectional/undirected，默认directed）
   - label: 关系标签（可选），如"1:N"、"继承"、"调用"等

   连线样式使用建议：
   - 实线(solid)+终点箭头(end)：默认关系、调用关系、数据流向
   - 虚线(dashed)+终点箭头(end)：依赖关系、异步调用
   - 点线(dotted)+无箭头(none)：弱关联、注释关系
   - 实线(solid)+双向箭头(both)：双向关联、双向依赖
   - 不同颜色：用不同颜色区分不同类型的关系（如蓝色表示数据流，红色表示控制流）

3. layout - 自动布局配置（可选，用于未指定坐标的节点）
   - type: 布局类型（grid网格/circle圆形，默认grid）
   - centerX, centerY: 布局中心点（可选，默认0,0）
   - spacing: 节点间距（可选，默认250）
   - columns: grid布局列数（可选，默认3）

4. defaultNodeStyle - 默认节点样式（可选）
   为所有节点设置默认属性值

5. defaultConnectionStyle - 默认连线样式（可选）
   为所有连线设置默认属性值

6. groups - 组定义数组（可选）
   组用于将相关节点视觉上分组，显示为带边框的矩形区域。
   每个组对象包含：
   - id: 组标识（可选，自动生成）
   - name: 组名称（必须）
   - nodeIds: 包含的节点ID或标题数组（必须）
   - description: 组描述（可选）
   - x, y: 组位置（可选，自动计算）
   - width, height: 组尺寸（可选，自动计算）
   - borderColor: 边框颜色（可选，默认#3b82f6蓝色）
   - backgroundColor: 背景色（可选，默认rgba(59,130,246,0.1)淡蓝）
   - borderWidth: 边框宽度（可选，默认2）
   - borderRadius: 圆角（可选，默认8）
   - collapsed: 是否折叠（可选，默认false）

   重要：
   - nodeIds中的值可以是节点的id或title，系统会自动匹配
   - 如果未指定x,y,width,height，系统会自动计算以覆盖所有包含的节点（带30px边距）
   - 如需精确控制组的位置和大小，可手动指定x,y,width,height

7. domains - 域定义数组（可选）
   域用于创建带标题的背景区域，作为功能区域的视觉标识。
   每个域对象包含：
   - id: 域标识（可选，自动生成）
   - name: 域名称（必须）
   - nodeIds: 包含的节点ID或标题数组（可选，用于自动计算边界）
   - x, y: 域位置（可选，自动计算）
   - width, height: 域尺寸（可选，自动计算）
   - backgroundColor: 背景色（可选，默认rgba(139,92,246,0.1)淡紫）
   - titleVisible: 标题是否可见（可选，默认true）
   - titleColor: 标题颜色（可选）
   - titleFontSize: 标题字体大小（可选）
   - titleScale: 标题缩放（可选）

   重要：
   - 如果指定了nodeIds且未指定x,y,width,height，系统会自动计算以覆盖所有包含的节点（带40px边距）
   - 如需精确控制域的位置和大小，可手动指定x,y,width,height
   - titleScale: 标题缩放（可选）

   注意：域只是视觉背景区域，不像组那样包含具体节点`,
      parameters: {
        data: {
          type: 'object',
          description: '图形的完整JSON数据结构',
          properties: {
            nodes: {
              type: 'array',
              description: '节点数组（必须）',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: '节点ID（可选，自动生成）' },
                  title: { type: 'string', description: '节点标题（必须）' },
                  content: { type: 'string', description: '节点内容' },
                  x: { type: 'number', description: 'X坐标（可选，未指定则自动布局）' },
                  y: { type: 'number', description: 'Y坐标（可选，未指定则自动布局）' },
                  width: { type: 'number', description: '宽度，建议不小于200' },
                  height: { type: 'number', description: '高度，建议不小于160' },
                  color: { type: 'string', description: '背景颜色，建议使用浅色（如#e3f2fd、#f3e5f5），避免使用深色以免影响文字可读性' },
                  fontSize: { type: 'number', description: '字体大小' },
                  textAlign: { type: 'string', enum: ['left', 'center', 'right'], description: '文本对齐' },
                  titleAlign: { type: 'string', enum: ['left', 'center', 'right'], description: '标题对齐' },
                  contentAlign: { type: 'string', enum: ['left', 'center', 'right'], description: '内容对齐' },
                  collapsedTitleAlign: { type: 'string', enum: ['left', 'center', 'right'], description: '折叠状态标题对齐' },
                  collapsed: { type: 'boolean', description: '是否折叠' },
                  locked: { type: 'boolean', description: '是否锁定' },
                  type: { type: 'string', enum: ['text', 'image'], description: '节点类型' },
                  imageUrl: { type: 'string', description: '图片URL（type为image时）' },
                  aspectRatio: { type: 'number', description: '图片宽高比' },
                },
              },
            },
            connections: {
              type: 'array',
              description: '连线数组（可选）',
              items: {
                type: 'object',
                properties: {
                  from: { type: 'string', description: '源节点ID或标题（必须）' },
                  to: { type: 'string', description: '目标节点ID或标题（必须）' },
                  fromPort: { type: 'string', enum: ['top', 'right', 'bottom', 'left'], description: '源端口' },
                  toPort: { type: 'string', enum: ['top', 'right', 'bottom', 'left'], description: '目标端口' },
                  type: { type: 'string', enum: ['straight', 'curve', 'step'], description: '连线类型' },
                  style: { type: 'string', enum: ['solid', 'dashed', 'dotted'], description: '连线样式' },
                  color: { type: 'string', description: '连线颜色' },
                  width: { type: 'number', description: '连线宽度' },
                  arrowType: { type: 'string', enum: ['none', 'start', 'end', 'both'], description: '箭头类型' },
                  direction: { type: 'string', enum: ['directed', 'bidirectional', 'undirected'], description: '方向类型' },
                  label: { type: 'string', description: '关系标签' },
                },
              },
            },
            layout: {
              type: 'object',
              description: '自动布局配置（可选，用于未指定坐标的节点）',
              properties: {
                type: { type: 'string', enum: ['grid', 'circle', 'custom'], description: '布局类型：grid网格、circle圆形' },
                centerX: { type: 'number', description: '中心点X坐标，默认0' },
                centerY: { type: 'number', description: '中心点Y坐标，默认0' },
                spacing: { type: 'number', description: '节点间距，默认250' },
                columns: { type: 'number', description: 'grid布局的列数' },
              },
            },
            defaultNodeStyle: {
              type: 'object',
              description: '默认节点样式，建议width>=200，height>=160',
              properties: {
                content: { type: 'string', description: '默认内容' },
                width: { type: 'number', description: '默认宽度，建议不小于200' },
                height: { type: 'number', description: '默认高度，建议不小于160' },
                color: { type: 'string', description: '默认颜色，建议使用浅色，避免使用深色以免影响文字可读性' },
                fontSize: { type: 'number', description: '默认字体大小' },
                textAlign: { type: 'string', enum: ['left', 'center', 'right'], description: '默认文本对齐' },
                titleAlign: { type: 'string', enum: ['left', 'center', 'right'], description: '默认标题对齐' },
                contentAlign: { type: 'string', enum: ['left', 'center', 'right'], description: '默认内容对齐' },
                collapsedTitleAlign: { type: 'string', enum: ['left', 'center', 'right'], description: '默认折叠标题对齐' },
                collapsed: { type: 'boolean', description: '默认折叠状态' },
                locked: { type: 'boolean', description: '默认锁定状态' },
                type: { type: 'string', enum: ['text', 'image'], description: '默认节点类型' },
                imageUrl: { type: 'string', description: '默认图片URL' },
                aspectRatio: { type: 'number', description: '默认图片宽高比' },
              },
            },
            defaultConnectionStyle: {
              type: 'object',
              description: '默认连线样式',
              properties: {
                type: { type: 'string', enum: ['straight', 'curve', 'step'], description: '连线类型' },
                style: { type: 'string', enum: ['solid', 'dashed', 'dotted'], description: '连线样式' },
                color: { type: 'string', description: '连线颜色' },
                width: { type: 'number', description: '连线宽度' },
                arrowType: { type: 'string', enum: ['none', 'start', 'end', 'both'], description: '箭头类型' },
              },
            },
            groups: {
              type: 'array',
              description: '组定义数组',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: '组ID' },
                  name: { type: 'string', description: '组名称' },
                  description: { type: 'string', description: '组描述' },
                  nodeIds: { type: 'array', items: { type: 'string' }, description: '包含的节点ID或标题数组' },
                },
              },
            },
            domains: {
              type: 'array',
              description: '域定义数组',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: '域ID' },
                  name: { type: 'string', description: '域名称' },
                  nodeIds: { type: 'array', items: { type: 'string' }, description: '包含的节点ID或标题数组' },
                },
              },
            },
          },
        },
      },
      handler: generateMindMapFromJSON,
    },
  ]

// 执行工具调用
export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  const tool = AI_TOOLS.find((t) => t.name === toolName)
  if (!tool) {
    return { success: false, error: `未知工具: ${toolName}` }
  }

  try {
    const result = await tool.handler(args)
    return result
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// 获取工具定义（用于发送给 AI）
// 遵循 OpenAI Function Calling 规范
// https://platform.openai.com/docs/guides/function-calling
export function getToolsForAI(useStrict: boolean = false): Array<{
  type: 'function'
  function: {
    name: string
    description: string
    strict?: boolean
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
      additionalProperties?: boolean
    }
  }
}> {
  const applyStrictSchema = (schema: Record<string, unknown>): Record<string, unknown> => {
    const result = { ...schema }
    if (result.type === 'object') {
      result.additionalProperties = false
      if (result.properties && typeof result.properties === 'object') {
        const allKeys = Object.keys(result.properties as Record<string, unknown>)
        result.required = allKeys
        const strictProps: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(result.properties as Record<string, unknown>)) {
          if (typeof v === 'object' && v !== null) {
            strictProps[k] = applyStrictSchema(v as Record<string, unknown>)
          } else {
            strictProps[k] = v
          }
        }
        result.properties = strictProps
      }
    }
    if (result.items && typeof result.items === 'object') {
      result.items = applyStrictSchema(result.items as Record<string, unknown>)
    }
    if (result.anyOf && Array.isArray(result.anyOf)) {
      result.anyOf = result.anyOf.map((s: unknown) =>
        typeof s === 'object' && s !== null ? applyStrictSchema(s as Record<string, unknown>) : s
      )
    }
    return result
  }

  return AI_TOOLS.map((tool) => {
    const properties: Record<string, unknown> = {}
    const required: string[] = []

    for (const [key, value] of Object.entries(tool.parameters)) {
      if (typeof value === 'object' && value !== null) {
        const param = value as Record<string, unknown>
        if (param.nullable === true) {
          // nullable 字段输出 anyOf 结构，避免 strict 模式下模型用 null 污染可选字段
          properties[key] = {
            anyOf: [
              {
                type: param.type,
                ...(param.enum && { enum: param.enum }),
                ...(param.items && { items: param.items }),
                ...(param.properties && { properties: param.properties }),
              },
              { type: 'null' },
            ],
            description: param.description,
          }
        } else {
          properties[key] = {
            type: param.type,
            description: param.description,
            ...(param.enum && { enum: param.enum }),
            ...(param.items && { items: param.items }),
            ...(param.properties && { properties: param.properties }),
          }
        }
        if (param.required === true) {
          required.push(key)
        }
      }
    }

    const toolDef: {
      type: 'function'
      function: {
        name: string
        description: string
        strict?: boolean
        parameters: {
          type: 'object'
          properties: Record<string, unknown>
          required?: string[]
          additionalProperties?: boolean
        }
      }
    } = {
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties,
          ...(required.length > 0 && { required }),
        },
      },
    }

    if (useStrict) {
      toolDef.function.strict = true
      toolDef.function.parameters = applyStrictSchema(
        toolDef.function.parameters as Record<string, unknown>
      ) as typeof toolDef.function.parameters
    }

    return toolDef
  })
}

