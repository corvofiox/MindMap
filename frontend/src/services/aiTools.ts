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
    const node: Node = {
      id: nodeId,
      title: String(args.title || '新节点'),
      content: String(args.content || ''),
      x: Number(args.x ?? 0),
      y: Number(args.y ?? 0),
      width: Number(args.width ?? 200),
      height: Number(args.height ?? 120),
      color: String(args.color ?? '#ffffff'),  // 默认白色背景
      fontSize: Number(args.fontSize ?? 14),
      textAlign: (args.textAlign as Node['textAlign']) || 'center',
      titleAlign: (args.titleAlign as Node['titleAlign']) || undefined,
      contentAlign: (args.contentAlign as Node['contentAlign']) || undefined,
      collapsedTitleAlign: (args.collapsedTitleAlign as Node['collapsedTitleAlign']) || undefined,
      collapsed: Boolean(args.collapsed ?? false),
      locked: Boolean(args.locked ?? false),
      type: nodeType,
      imageUrl: nodeType === 'image' ? String(args.imageUrl || '') : undefined,
      aspectRatio: args.aspectRatio !== undefined ? Number(args.aspectRatio) : undefined,
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
    const { updateNode } = useCanvasStore.getState()
    const nodeId = String(args.nodeId)
    if (!nodeId) {
      return { success: false, error: '缺少节点 ID' }
    }

    const updates: Partial<Node> = {}
    if (args.title !== undefined) updates.title = String(args.title)
    if (args.content !== undefined) updates.content = String(args.content)
    if (args.x !== undefined) updates.x = Number(args.x)
    if (args.y !== undefined) updates.y = Number(args.y)
    if (args.width !== undefined) updates.width = Number(args.width)
    if (args.height !== undefined) updates.height = Number(args.height)
    if (args.color !== undefined) updates.color = String(args.color)
    if (args.fontSize !== undefined) updates.fontSize = Number(args.fontSize)
    if (args.textAlign !== undefined) updates.textAlign = args.textAlign as Node['textAlign']
    if (args.titleAlign !== undefined) updates.titleAlign = args.titleAlign as Node['titleAlign']
    if (args.contentAlign !== undefined) updates.contentAlign = args.contentAlign as Node['contentAlign']
    if (args.collapsedTitleAlign !== undefined) updates.collapsedTitleAlign = args.collapsedTitleAlign as Node['collapsedTitleAlign']
    if (args.collapsed !== undefined) updates.collapsed = Boolean(args.collapsed)
    if (args.locked !== undefined) updates.locked = Boolean(args.locked)
    if (args.type !== undefined) updates.type = args.type as Node['type']
    if (args.imageUrl !== undefined) updates.imageUrl = String(args.imageUrl)
    if (args.aspectRatio !== undefined) updates.aspectRatio = Number(args.aspectRatio)

    updateNode(nodeId, updates)
    return { success: true, data: { nodeId, updates } }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// 删除节点
function deleteNode(args: Record<string, unknown>): ToolCallResult {
  try {
    const { removeNode } = useCanvasStore.getState()
    const nodeId = String(args.nodeId)
    if (!nodeId) {
      return { success: false, error: '缺少节点 ID' }
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
    const { removeConnection } = useCanvasStore.getState()
    const connectionId = String(args.connectionId)
    if (!connectionId) {
      return { success: false, error: '缺少连接 ID' }
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
    const { updateConnection } = useCanvasStore.getState()
    const connectionId = String(args.connectionId)
    if (!connectionId) {
      return { success: false, error: '缺少连接 ID' }
    }

    const updates: Partial<Connection> = {}
    if (args.fromNodeId !== undefined) updates.fromNodeId = String(args.fromNodeId)
    if (args.toNodeId !== undefined) updates.toNodeId = String(args.toNodeId)
    if (args.fromPort !== undefined) updates.fromPort = args.fromPort as Connection['fromPort']
    if (args.toPort !== undefined) updates.toPort = args.toPort as Connection['toPort']
    if (args.type !== undefined) updates.type = args.type as Connection['type']
    if (args.style !== undefined) updates.style = args.style as Connection['style']
    if (args.color !== undefined) updates.color = String(args.color)
    if (args.width !== undefined) updates.width = Number(args.width)
    if (args.arrowType !== undefined) updates.arrowType = args.arrowType as Connection['arrowType']
    if (args.direction !== undefined) updates.direction = args.direction as Connection['direction']
    if (args.label !== undefined) updates.label = String(args.label)

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
    const { updateGroup } = useCanvasStore.getState()
    const groupId = String(args.groupId)
    if (!groupId) {
      return { success: false, error: '缺少组 ID' }
    }

    const updates: Partial<NodeGroup> = {}
    if (args.name !== undefined) updates.name = String(args.name)
    if (args.description !== undefined) updates.description = String(args.description)
    if (args.nodeIds !== undefined) updates.nodeIds = args.nodeIds as string[]
    if (args.x !== undefined) updates.x = Number(args.x)
    if (args.y !== undefined) updates.y = Number(args.y)
    if (args.width !== undefined) updates.width = Number(args.width)
    if (args.height !== undefined) updates.height = Number(args.height)
    if (args.borderColor !== undefined) updates.borderColor = String(args.borderColor)
    if (args.backgroundColor !== undefined) updates.backgroundColor = String(args.backgroundColor)
    if (args.borderWidth !== undefined) updates.borderWidth = Number(args.borderWidth)
    if (args.borderRadius !== undefined) updates.borderRadius = Number(args.borderRadius)
    if (args.collapsed !== undefined) updates.collapsed = Boolean(args.collapsed)

    updateGroup(groupId, updates)
    return { success: true, data: { groupId, updates } }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// 删除组
function deleteGroup(args: Record<string, unknown>): ToolCallResult {
  try {
    const { removeGroup } = useCanvasStore.getState()
    const groupId = String(args.groupId)
    if (!groupId) {
      return { success: false, error: '缺少组 ID' }
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
    const { updateDomain } = useCanvasStore.getState()
    const domainId = String(args.domainId)
    if (!domainId) {
      return { success: false, error: '缺少域 ID' }
    }

    const updates: Partial<Domain> = {}
    if (args.name !== undefined) updates.name = String(args.name)
    if (args.x !== undefined) updates.x = Number(args.x)
    if (args.y !== undefined) updates.y = Number(args.y)
    if (args.width !== undefined) updates.width = Number(args.width)
    if (args.height !== undefined) updates.height = Number(args.height)
    if (args.backgroundColor !== undefined) updates.backgroundColor = String(args.backgroundColor)
    if (args.titleVisible !== undefined) updates.titleVisible = Boolean(args.titleVisible)
    if (args.titleColor !== undefined) updates.titleColor = String(args.titleColor)
    if (args.titleFontSize !== undefined) updates.titleFontSize = Number(args.titleFontSize)
    if (args.titleScale !== undefined) updates.titleScale = Number(args.titleScale)

    updateDomain(domainId, updates)
    return { success: true, data: { domainId, updates } }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// 删除域
function deleteDomain(args: Record<string, unknown>): ToolCallResult {
  try {
    const { removeDomain } = useCanvasStore.getState()
    const domainId = String(args.domainId)
    if (!domainId) {
      return { success: false, error: '缺少域 ID' }
    }
    removeDomain(domainId)
    return { success: true, data: { deletedDomainId: domainId } }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// 生成思维导图结构
function generateMindMapStructure(args: Record<string, unknown>): ToolCallResult {
  try {
    const { addNode, addConnection } = useCanvasStore.getState()
    const topic = String(args.topic || '主题')
    const structure = args.structure as Array<{
      label: string
      children?: Array<{ label: string }>
    }>

    if (!structure || !Array.isArray(structure)) {
      return { success: false, error: '缺少有效的结构数据' }
    }

    // 创建中心节点
    const centerNodeId = `node-${Date.now()}-center`
    const centerNode: Node = {
      id: centerNodeId,
      title: topic,
      content: '',
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      color: '#8b5cf6',
      fontSize: 16,
      textAlign: 'center',
      collapsed: false,
      locked: false,
      type: 'text',
    }
    addNode(centerNode)

    let nodesCreated = 1
    let connectionsCreated = 0

    // 创建分支节点
    structure.forEach((branch, index) => {
      const angle = (index / structure.length) * 2 * Math.PI
      const radius = 200
      const branchX = Math.cos(angle) * radius
      const branchY = Math.sin(angle) * radius

      const branchNodeId = `node-${Date.now()}-${index}`
      const branchNode: Node = {
        id: branchNodeId,
        title: branch.label,
        content: '',
        x: branchX,
        y: branchY,
        width: 180,
        height: 80,
        color: '#3b82f6',
        fontSize: 14,
        textAlign: 'center',
        collapsed: false,
        locked: false,
        type: 'text',
      }
      addNode(branchNode)
      nodesCreated++

      // 连接到中心节点
      const connId = `conn-${Date.now()}-${index}`
      const conn: Connection = {
        id: connId,
        fromNodeId: centerNodeId,
        toNodeId: branchNodeId,
        fromPort: 'bottom',
        toPort: 'top',
        type: 'curve',
        style: 'solid',
        color: '#666666',
        width: 2,
        arrowType: 'end',
        direction: 'directed',
        label: '',
      }
      addConnection(conn)
      connectionsCreated++

      // 创建子节点
      if (branch.children) {
        branch.children.forEach((child, childIndex) => {
          const childAngle = angle + ((childIndex - branch.children!.length / 2) * 0.3)
          const childRadius = 350
          const childX = Math.cos(childAngle) * childRadius
          const childY = Math.sin(childAngle) * childRadius

          const childNodeId = `node-${Date.now()}-${index}-${childIndex}`
          const childNode: Node = {
            id: childNodeId,
            title: child.label,
            content: '',
            x: childX,
            y: childY,
            width: 160,
            height: 70,
            color: '#10b981',
            fontSize: 12,
            textAlign: 'center',
            collapsed: false,
            locked: false,
            type: 'text',
          }
          addNode(childNode)
          nodesCreated++

          const childConnId = `conn-${Date.now()}-${index}-${childIndex}`
          const childConn: Connection = {
            id: childConnId,
            fromNodeId: branchNodeId,
            toNodeId: childNodeId,
            fromPort: 'bottom',
            toPort: 'top',
            type: 'curve',
            style: 'solid',
            color: '#666666',
            width: 2,
            arrowType: 'end',
            direction: 'directed',
            label: '',
          }
          addConnection(childConn)
          connectionsCreated++
        })
      }
    })

    return {
      success: true,
      data: {
        nodesCreated,
        connectionsCreated,
        centerNodeId,
      },
    }
  } catch (error) {
    return { success: false, error: String(error) }
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
      description: '获取画布上所有组的列表，包含组的名称、描述、包含的节点等信息',
      parameters: {},
      handler: getAllGroups,
    },
    {
      name: 'getAllDomains',
      description: '获取画布上所有域的列表',
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
      description: '在画布上创建一个新节点。默认创建白色背景的节点，如需其他颜色请指定 color 参数',
      parameters: {
        title: { type: 'string', description: '节点标题' },
        content: { type: 'string', description: '节点内容' },
        x: { type: 'number', description: 'X 坐标位置' },
        y: { type: 'number', description: 'Y 坐标位置' },
        width: { type: 'number', description: '节点宽度，默认200' },
        height: { type: 'number', description: '节点高度，默认120' },
        color: { type: 'string', description: '节点背景颜色，十六进制格式，默认白色#ffffff' },
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
      description: '更新现有节点的属性，包括标题、内容、位置、大小、颜色、字体大小、对齐方式和折叠/锁定状态',
      parameters: {
        nodeId: { type: 'string', description: '要更新的节点 ID' },
        title: { type: 'string', description: '新的节点标题' },
        content: { type: 'string', description: '新的节点内容' },
        x: { type: 'number', description: '新的 X 坐标' },
        y: { type: 'number', description: '新的 Y 坐标' },
        width: { type: 'number', description: '新的节点宽度' },
        height: { type: 'number', description: '新的节点高度' },
        color: { type: 'string', description: '新的节点颜色，十六进制格式' },
        fontSize: { type: 'number', description: '新的字体大小' },
        textAlign: { type: 'string', enum: ['left', 'center', 'right'], description: '文本统一对齐方式' },
        titleAlign: { type: 'string', enum: ['left', 'center', 'right'], description: '标题对齐方式' },
        contentAlign: { type: 'string', enum: ['left', 'center', 'right'], description: '内容对齐方式' },
        collapsedTitleAlign: { type: 'string', enum: ['left', 'center', 'right'], description: '折叠状态下标题对齐方式' },
        collapsed: { type: 'boolean', description: '是否折叠' },
        locked: { type: 'boolean', description: '是否锁定' },
        type: { type: 'string', enum: ['text', 'image'], description: '节点类型，可切换为image图片节点' },
        imageUrl: { type: 'string', description: '图片URL地址，切换为图片节点时必填' },
        aspectRatio: { type: 'number', description: '图片宽高比' },
      },
      handler: updateNode,
    },
    {
      name: 'deleteNode',
      description: '删除指定的节点及其相关连接',
      parameters: {
        nodeId: { type: 'string', description: '要删除的节点 ID' },
      },
      handler: deleteNode,
    },
    {
      name: 'createConnection',
      description: '在两个节点之间创建连接。系统会根据节点相对位置自动选择最佳端口（水平连接使用左右端口，垂直连接使用上下端口），默认创建蓝色连线',
      parameters: {
        fromNodeId: { type: 'string', description: '源节点 ID' },
        toNodeId: { type: 'string', description: '目标节点 ID' },
        fromPort: { type: 'string', enum: ['top', 'right', 'bottom', 'left'], description: '源端口位置，如不指定则自动根据节点位置计算' },
        toPort: { type: 'string', enum: ['top', 'right', 'bottom', 'left'], description: '目标端口位置，如不指定则自动根据节点位置计算' },
        type: { type: 'string', enum: ['straight', 'curve', 'step'], description: '连线类型，默认curve曲线' },
        style: { type: 'string', enum: ['solid', 'dashed', 'dotted'], description: '连线样式，默认solid实线' },
        color: { type: 'string', description: '连线颜色，十六进制格式，默认蓝色#3b82f6' },
        label: { type: 'string', description: '连接标签文本' },
        arrowType: { type: 'string', enum: ['none', 'start', 'end', 'both'], description: '箭头类型，默认end在终点显示箭头' },
        direction: { type: 'string', enum: ['directed', 'bidirectional', 'undirected'], description: '方向类型，默认directed有向' },
      },
      handler: createConnection,
    },
    {
      name: 'deleteConnection',
      description: '删除指定的连接',
      parameters: {
        connectionId: { type: 'string', description: '要删除的连接 ID' },
      },
      handler: deleteConnection,
    },
    {
      name: 'updateConnection',
      description: '更新现有连接的属性，包括连线类型、样式、方向、箭头类型、颜色、宽度、标签和端口位置',
      parameters: {
        connectionId: { type: 'string', description: '要更新的连接 ID', required: true },
        fromNodeId: { type: 'string', description: '新的源节点 ID' },
        toNodeId: { type: 'string', description: '新的目标节点 ID' },
        fromPort: { type: 'string', enum: ['top', 'right', 'bottom', 'left'], description: '新的源端口位置' },
        toPort: { type: 'string', enum: ['top', 'right', 'bottom', 'left'], description: '新的目标端口位置' },
        type: { type: 'string', enum: ['straight', 'curve', 'step'], description: '连线类型：直线、曲线、阶梯' },
        style: { type: 'string', enum: ['solid', 'dashed', 'dotted'], description: '连线样式：实线、虚线、点线' },
        color: { type: 'string', description: '连线颜色（十六进制颜色码，如 #666666）' },
        width: { type: 'number', description: '连线宽度（像素）' },
        arrowType: { type: 'string', enum: ['none', 'start', 'end', 'both'], description: '箭头类型：无箭头、起点箭头、终点箭头、双向箭头' },
        direction: { type: 'string', enum: ['directed', 'bidirectional', 'undirected'], description: '方向类型：有向、双向、无向' },
        label: { type: 'string', description: '连接标签文本' },
      },
      handler: updateConnection,
    },
    {
      name: 'createGroup',
      description: `创建一个新组，用于将多个相关节点组合在一起。组是带边框的容器，适合小范围紧密组合。

【组 vs 域的区别】
- 组：带边框的容器，用于小范围紧密组合（如家庭、小团队、功能模块）
- 域：背景级别的区域划分，无边框，用于大范围分类（如部门、阶段、层级）

【何时使用组】
✓ 家庭关系：如"张家"、"李家"，包含家庭成员节点
✓ 小团队：如"前端小组"、"后端小组"、"设计团队"
✓ 功能模块：如"用户模块"、"支付模块"、"消息模块"
✓ 项目分组：如"第一阶段"、"核心功能"、"辅助功能"
✓ 需要边框视觉强调的组合

【何时使用域】
✓ 大部门划分：如"研发部"、"市场部"（包含多个组）
✓ 阶段划分：如"规划期"、"开发期"、"运维期"
✓ 层级划分：如"管理层"、"执行层"
✓ 只需要背景色区分的大范围区域

传入节点ID列表后，系统会自动计算边界框覆盖所有节点`,
      parameters: {
        name: { type: 'string', description: '组名称，如"家庭"、"团队"、"模块"等' },
        description: { type: 'string', description: '组的详细描述' },
        nodeIds: { type: 'array', items: { type: 'string' }, description: '包含的节点 ID 列表。提供此参数后，系统会自动计算组的位置和大小以覆盖所有节点' },
      },
      handler: createGroup,
    },
    {
      name: 'updateGroup',
      description: '更新现有组的属性，包括名称、描述、位置、大小、颜色、边框样式和包含的节点',
      parameters: {
        groupId: { type: 'string', description: '要更新的组 ID' },
        name: { type: 'string', description: '新的组名称' },
        description: { type: 'string', description: '新的组描述' },
        nodeIds: { type: 'array', items: { type: 'string' }, description: '新的节点 ID 列表' },
        x: { type: 'number', description: '新的 X 坐标位置' },
        y: { type: 'number', description: '新的 Y 坐标位置' },
        width: { type: 'number', description: '新的宽度' },
        height: { type: 'number', description: '新的高度' },
        borderColor: { type: 'string', description: '边框颜色，十六进制格式，如#3b82f6' },
        backgroundColor: { type: 'string', description: '背景颜色，十六进制格式或rgba，如rgba(59, 130, 246, 0.1)' },
        borderWidth: { type: 'number', description: '边框宽度，如2' },
        borderRadius: { type: 'number', description: '边框圆角，如8' },
        collapsed: { type: 'boolean', description: '是否折叠' },
      },
      handler: updateGroup,
    },
    {
      name: 'deleteGroup',
      description: '删除指定的组',
      parameters: {
        groupId: { type: 'string', description: '要删除的组 ID' },
      },
      handler: deleteGroup,
    },
    {
      name: 'createDomain',
      description: `创建一个新域，用于划分画布的特定区域。域是背景级别的容器，适合大范围划分。

【域 vs 组的区别】
- 域：背景级别的区域划分，无边框，用于大范围分类（如部门、阶段、层级）
- 组：带边框的容器，用于小范围组合相关节点（如家庭、小团队、功能模块）

【何时使用域】
✓ 按部门划分：如"研发部"、"市场部"、"管理层"
✓ 按阶段划分：如"规划阶段"、"开发阶段"、"测试阶段"
✓ 按层级划分：如"决策层"、"执行层"、"支持层"
✓ 大范围的背景色区分不同区域

【何时使用组】
✓ 小团队/家庭：如"张家"、"前端小组"
✓ 功能模块：如"用户模块"、"订单模块"
✓ 需要边框和标题的紧密组合

传入节点ID列表后，系统会自动计算边界框覆盖所有节点`,
      parameters: {
        name: { type: 'string', description: '域名称，如"研发部"、"销售区"、"决策层"等' },
        nodeIds: { type: 'array', items: { type: 'string' }, description: '包含的节点 ID 列表。提供此参数后，系统会自动计算域的位置和大小以覆盖所有节点' },
      },
      handler: createDomain,
    },
    {
      name: 'updateDomain',
      description: '更新现有域的属性，包括名称、位置、大小、背景颜色和标题样式',
      parameters: {
        domainId: { type: 'string', description: '要更新的域 ID' },
        name: { type: 'string', description: '新的域名称' },
        x: { type: 'number', description: '新的 X 坐标位置' },
        y: { type: 'number', description: '新的 Y 坐标位置' },
        width: { type: 'number', description: '新的宽度' },
        height: { type: 'number', description: '新的高度' },
        backgroundColor: { type: 'string', description: '背景颜色，十六进制格式或rgba，如rgba(139, 92, 246, 0.1)' },
        titleVisible: { type: 'boolean', description: '标题是否可见' },
        titleColor: { type: 'string', description: '标题颜色，十六进制格式' },
        titleFontSize: { type: 'number', description: '标题字体大小' },
        titleScale: { type: 'number', description: '标题缩放比例' },
      },
      handler: updateDomain,
    },
    {
      name: 'deleteDomain',
      description: '删除指定的域',
      parameters: {
        domainId: { type: 'string', description: '要删除的域 ID' },
      },
      handler: deleteDomain,
    },
    {
      name: 'generateMindMapStructure',
      description: '根据给定的主题和结构自动生成完整的思维导图',
      parameters: {
        topic: { type: 'string', description: '思维导图的中心主题' },
        structure: {
          type: 'array',
          description: '思维导图结构，包含分支和子分支',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '分支标签' },
              children: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: '子分支标签' },
                  },
                },
              },
            },
          },
        },
      },
      handler: generateMindMapStructure,
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
export function getToolsForAI(): Array<{
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    }
  }
}> {
  return AI_TOOLS.map((tool) => {
    // 从 parameters 中提取 required 字段（标记为 required: true 的参数）
    const properties: Record<string, unknown> = {}
    const required: string[] = []

    for (const [key, value] of Object.entries(tool.parameters)) {
      if (typeof value === 'object' && value !== null) {
        const param = value as Record<string, unknown>
        properties[key] = {
          type: param.type,
          description: param.description,
          ...(param.enum && { enum: param.enum }),
          ...(param.items && { items: param.items }),
        }
        // 如果参数标记为 required: true，则加入 required 数组
        if (param.required === true) {
          required.push(key)
        }
      }
    }

    return {
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
  })
}

// 获取 Gemini 格式的工具定义
// Gemini 使用不同的工具格式
// https://ai.google.dev/docs/function_calling
export function getToolsForGemini(): Array<{
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}> {
  return AI_TOOLS.map((tool) => {
    const properties: Record<string, unknown> = {}
    const required: string[] = []

    for (const [key, value] of Object.entries(tool.parameters)) {
      if (typeof value === 'object' && value !== null) {
        const param = value as Record<string, unknown>
        properties[key] = {
          type: param.type,
          description: param.description,
          ...(param.enum && { enum: param.enum }),
          ...(param.items && { items: param.items }),
        }
        if (param.required === true) {
          required.push(key)
        }
      }
    }

    return {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object' as const,
        properties,
        ...(required.length > 0 && { required }),
      },
    }
  })
}
