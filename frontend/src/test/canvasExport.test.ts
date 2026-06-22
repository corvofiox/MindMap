import { describe, it, expect } from 'vitest'
import { exportCanvas, importCanvas, EXPORT_VERSION, EXPORT_APP } from '../utils/canvasExport'
import type { Node, Connection, NodeGroup, Domain } from '../types'

function createNode(id: string, overrides?: Partial<Node>): Node {
  return {
    id,
    x: 10,
    y: 20,
    width: 200,
    height: 160,
    title: `Node ${id}`,
    content: `Content ${id}`,
    fontSize: 14,
    textAlign: 'left',
    collapsed: false,
    locked: false,
    ...overrides,
  }
}

function createConnection(id: string, from: string, to: string): Connection {
  return {
    id,
    fromNodeId: from,
    toNodeId: to,
    fromPort: 'right',
    toPort: 'left',
    type: 'curve',
    style: 'solid',
    color: '#3b82f6',
    width: 2,
    arrowType: 'end',
    direction: 'directed',
  }
}

function createGroup(id: string, nodeIds: string[]): NodeGroup {
  return {
    id,
    name: 'Group',
    x: 0,
    y: 0,
    width: 400,
    height: 300,
    borderColor: '#3b82f6',
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    borderWidth: 2,
    borderRadius: 8,
    nodeIds,
    collapsed: false,
  }
}

function createDomain(id: string): Domain {
  return {
    id,
    name: 'Domain',
    x: 0,
    y: 0,
    width: 500,
    height: 400,
    backgroundColor: 'rgba(156, 163, 175, 0.2)',
    titleVisible: true,
  }
}

describe('exportCanvas', () => {
  it('should export canvas data with metadata', () => {
    const nodes = new Map([['n1', createNode('n1')]])
    const connections = new Map<string, Connection>()
    const groups = new Map<string, NodeGroup>()
    const domains = new Map<string, Domain>()

    const json = exportCanvas(nodes, connections, groups, domains)
    const parsed = JSON.parse(json)

    expect(parsed.version).toBe(EXPORT_VERSION)
    expect(parsed.app).toBe(EXPORT_APP)
    expect(parsed.exportedAt).toBeDefined()
    expect(parsed.data.nodes).toHaveLength(1)
    expect(parsed.data.connections).toHaveLength(0)
    expect(parsed.data.groups).toHaveLength(0)
    expect(parsed.data.domains).toHaveLength(0)
  })

  it('should include viewState when provided', () => {
    const json = exportCanvas(
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      { zoom: 1.5, panX: 100, panY: 200 },
    )
    const parsed = JSON.parse(json)

    expect(parsed.viewState).toEqual({ zoom: 1.5, panX: 100, panY: 200 })
  })
})

describe('importCanvas', () => {
  it('should import valid canvas data', () => {
    const data = {
      version: EXPORT_VERSION,
      app: EXPORT_APP,
      exportedAt: new Date().toISOString(),
      data: {
        nodes: [createNode('n1'), createNode('n2')],
        connections: [createConnection('c1', 'n1', 'n2')],
        groups: [createGroup('g1', ['n1'])],
        domains: [createDomain('d1')],
      },
      viewState: { zoom: 1.2, panX: 50, panY: 60 },
    }

    const result = importCanvas(JSON.stringify(data))

    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.data?.nodes).toHaveLength(2)
    expect(result.data?.connections).toHaveLength(1)
    expect(result.data?.groups).toHaveLength(1)
    expect(result.data?.domains).toHaveLength(1)
    expect(result.viewState).toEqual({ zoom: 1.2, panX: 50, panY: 60 })
  })

  it('should reject invalid JSON', () => {
    const result = importCanvas('not json')
    expect(result.success).toBe(false)
    expect(result.error).toContain('JSON')
  })

  it('should reject missing version', () => {
    const result = importCanvas(JSON.stringify({ data: {} }))
    expect(result.success).toBe(false)
    expect(result.error).toContain('版本')
  })

  it('should reject unsupported version', () => {
    const result = importCanvas(JSON.stringify({ version: '2.0', data: {} }))
    expect(result.success).toBe(false)
    expect(result.error).toContain('版本')
  })

  it('should reject incompatible app', () => {
    const result = importCanvas(
      JSON.stringify({ version: EXPORT_VERSION, app: 'other', data: {} }),
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('应用标识')
  })

  it('should reject missing data', () => {
    const result = importCanvas(JSON.stringify({ version: EXPORT_VERSION }))
    expect(result.success).toBe(false)
    expect(result.error).toContain('画布数据')
  })

  it('should reject connection with missing node reference', () => {
    const data = {
      version: EXPORT_VERSION,
      app: EXPORT_APP,
      exportedAt: new Date().toISOString(),
      data: {
        nodes: [createNode('n1')],
        connections: [createConnection('c1', 'n1', 'missing')],
        groups: [],
        domains: [],
      },
    }

    const result = importCanvas(JSON.stringify(data))

    expect(result.success).toBe(false)
    expect(result.error).toContain('连线')
    expect(result.error).toContain('missing')
  })

  it('should reject group with missing node reference', () => {
    const data = {
      version: EXPORT_VERSION,
      app: EXPORT_APP,
      exportedAt: new Date().toISOString(),
      data: {
        nodes: [createNode('n1')],
        connections: [],
        groups: [createGroup('g1', ['missing'])],
        domains: [],
      },
    }

    const result = importCanvas(JSON.stringify(data))

    expect(result.success).toBe(false)
    expect(result.error).toContain('组')
    expect(result.error).toContain('missing')
  })

  it('should sanitize invalid fields and keep valid entities', () => {
    const data = {
      version: EXPORT_VERSION,
      app: EXPORT_APP,
      exportedAt: new Date().toISOString(),
      data: {
        nodes: [
          {
            id: 'n1',
            x: 'invalid',
            y: null,
            width: -50,
            height: 10000,
            title: 123,
            content: '',
            fontSize: 'large',
            textAlign: 'invalid',
            collapsed: 'yes',
            locked: 1,
          },
        ],
        connections: [
          {
            id: 'c1',
            fromNodeId: 'n1',
            toNodeId: 'n1',
            fromPort: 'invalid',
            toPort: 'invalid',
            type: 'invalid',
            style: 'invalid',
            color: 123,
            width: -5,
            arrowType: 'invalid',
            direction: 'invalid',
          },
        ],
        groups: [],
        domains: [],
      },
    }

    const result = importCanvas(JSON.stringify(data))

    expect(result.success).toBe(true)
    const node = result.data!.nodes[0]
    expect(node.x).toBe(0)
    expect(node.y).toBe(0)
    expect(node.width).toBe(100)
    expect(node.title).toBe('')
    expect(node.fontSize).toBe(14)
    expect(node.textAlign).toBe('center')
    expect(node.collapsed).toBe(false)
    expect(node.locked).toBe(false)

    const conn = result.data!.connections[0]
    expect(conn.fromPort).toBe('right')
    expect(conn.toPort).toBe('left')
    expect(conn.type).toBe('curve')
    expect(conn.style).toBe('solid')
    expect(conn.color).toBe('#3b82f6')
    expect(conn.width).toBe(1)
    expect(conn.arrowType).toBe('end')
    expect(conn.direction).toBe('directed')
  })

  it('should skip malformed entities and keep valid ones', () => {
    const data = {
      version: EXPORT_VERSION,
      app: EXPORT_APP,
      exportedAt: new Date().toISOString(),
      data: {
        nodes: [{ id: 'n1' }, { invalid: true }, createNode('n2')],
        connections: [],
        groups: [],
        domains: [],
      },
    }

    const result = importCanvas(JSON.stringify(data))

    expect(result.success).toBe(true)
    expect(result.data!.nodes).toHaveLength(2)
    expect(result.data!.nodes.some((n) => n.id === 'n1')).toBe(true)
    expect(result.data!.nodes.some((n) => n.id === 'n2')).toBe(true)
  })

  it('should restore viewState within zoom bounds', () => {
    const data = {
      version: EXPORT_VERSION,
      app: EXPORT_APP,
      exportedAt: new Date().toISOString(),
      data: { nodes: [], connections: [], groups: [], domains: [] },
      viewState: { zoom: 10, panX: 100, panY: 200 },
    }

    const result = importCanvas(JSON.stringify(data))

    expect(result.success).toBe(true)
    expect(result.viewState!.zoom).toBe(5)
  })
})
