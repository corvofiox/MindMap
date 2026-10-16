/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * End-to-end MCP server tests.
 *
 * Drives the real `McpServer` through the SDK's in-memory transport pair, so the
 * assertions run over the actual protocol (initialize → tools/list → tools/call)
 * rather than calling handlers directly. That is deliberate: it catches schema
 * mistakes that a direct call would hide, and it proves the tool set is
 * discoverable by a real client.
 *
 * Access control is exercised through `resolveCanvasAccess`, mocked here so the
 * tests can express "this user may / may not touch canvas N" without a database.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

vi.mock('../utils/logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}))

/** Canvas rows the mocked DB will serve for listCanvases. */
const state: {
  access: { status: 'ok'; access: any } | { status: 'denied'; reason: any }
  canvases: any[]
  projects: any[]
  memberships: any[]
} = {
  access: { status: 'ok', access: { canvasId: 1, projectId: 1, canvasName: 'C', projectName: 'P' } },
  canvases: [],
  projects: [],
  memberships: [],
}

vi.mock('../mcp/access.js', () => ({
  resolveCanvasAccess: vi.fn(async () => state.access),
  accessErrorMessage: (canvasId: number, reason: string) =>
    reason === 'not-found' ? `画布 ${canvasId} 不存在。` : `无权访问画布 ${canvasId}。`,
}))

/** Chainable Drizzle-ish stub: every builder method returns itself. */
function chain(result: any[]) {
  const self: any = {}
  const passthrough = () => self
  for (const m of ['select', 'from', 'where', 'orderBy', 'innerJoin', 'limit']) {
    self[m] = vi.fn(passthrough)
  }
  self.then = (resolve: (v: any[]) => unknown) => Promise.resolve(result).then(resolve)
  return self
}

vi.mock('../database/connection', () => ({
  db: {
    query: {
      canvases: { findFirst: vi.fn(async () => null) },
      projects: { findFirst: vi.fn(async () => null) },
      projectMembers: { findFirst: vi.fn(async () => null) },
    },
    select: vi.fn(() => chain(state.projects)),
  },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => true),
  and: vi.fn(() => true),
  or: vi.fn(() => true),
  inArray: vi.fn(() => true),
  desc: vi.fn(() => true),
  sql: vi.fn(),
}))

import { createMcpServer } from '../mcp/server.js'
import { removeCanvasState } from '../websocket/canvas-state.js'

const CANVAS_ID = 11
const USER_ID = 5

/** Connect a client to a server instance built for the given user. */
async function connect(userId = USER_ID) {
  const server = createMcpServer({ userId })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client, server }
}

/** Invoke a tool and parse its JSON text payload. */
async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result: any = await client.callTool({ name, arguments: args })
  const text = result.content?.[0]?.text ?? ''
  let parsed: any = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  return { result, text, parsed }
}

describe('MCP server', () => {
  beforeEach(() => {
    state.access = {
      status: 'ok',
      access: { canvasId: CANVAS_ID, projectId: 1, canvasName: 'C', projectName: 'P' },
    }
    state.canvases = []
    state.projects = []
    state.memberships = []
    removeCanvasState(CANVAS_ID)
  })

  it('exposes a discoverable tool set over the protocol', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()

    // The full 23-name list is pinned in mcp-http.test.ts (the network truth).
    // Here only the invariant this layer adds: the tool set is complete and every
    // entry is callable-in-principle, i.e. carries a description and a schema.
    expect(tools).toHaveLength(23)

    // Each tool must carry a description and a JSON schema for its arguments,
    // otherwise a model cannot call it correctly.
    for (const tool of tools) {
      expect(tool.description, `${tool.name} description`).toBeTruthy()
      expect(tool.inputSchema, `${tool.name} inputSchema`).toBeTruthy()
    }
  })

  it('creates, reads, updates and deletes a node end to end', async () => {
    const { client } = await connect()

    const created = await callTool(client, 'createNode', {
      canvasId: CANVAS_ID,
      title: '根节点',
      content: 'hello',
      x: 100,
      y: 200,
    })
    expect(created.result.isError).toBeFalsy()
    const nodeId = created.parsed.nodeId
    expect(nodeId).toMatch(/^node-/)

    const listed = await callTool(client, 'getAllNodes', { canvasId: CANVAS_ID })
    expect(listed.parsed.count).toBe(1)
    expect(listed.parsed.nodes[0].title).toBe('根节点')
    expect(listed.parsed.nodes[0].x).toBe(100)

    const updated = await callTool(client, 'updateNode', {
      canvasId: CANVAS_ID,
      nodeId,
      title: '改名',
    })
    expect(updated.result.isError).toBeFalsy()

    const after = await callTool(client, 'getAllNodes', { canvasId: CANVAS_ID })
    expect(after.parsed.nodes[0].title).toBe('改名')
    // The update must not have dropped the fields it did not mention.
    expect(after.parsed.nodes[0].content).toBe('hello')
    expect(after.parsed.nodes[0].y).toBe(200)

    const deleted = await callTool(client, 'deleteNode', { canvasId: CANVAS_ID, nodeId })
    expect(deleted.result.isError).toBeFalsy()

    const empty = await callTool(client, 'getAllNodes', { canvasId: CANVAS_ID })
    expect(empty.parsed.count).toBe(0)
  })

  it('rejects createNode without a title, with an actionable message', async () => {
    const { client } = await connect()
    const { result, text } = await callTool(client, 'createNode', {
      canvasId: CANVAS_ID,
      title: '   ',
    })
    expect(result.isError).toBe(true)
    expect(text).toContain('title')
  })

  it('reports a missing node id instead of silently doing nothing', async () => {
    const { client } = await connect()
    const { result, text } = await callTool(client, 'updateNode', {
      canvasId: CANVAS_ID,
      nodeId: 'ghost',
      title: 'x',
    })
    expect(result.isError).toBe(true)
    expect(text).toContain('ghost')
  })

  it('refuses a write when the token owner cannot access the canvas', async () => {
    state.access = { status: 'denied', reason: 'forbidden' }
    const { client } = await connect()

    const { result, text } = await callTool(client, 'createNode', {
      canvasId: CANVAS_ID,
      title: 'should not happen',
    })
    expect(result.isError).toBe(true)
    expect(text).toContain('无权访问')

    // And nothing was written.
    state.access = {
      status: 'ok',
      access: { canvasId: CANVAS_ID, projectId: 1, canvasName: 'C', projectName: 'P' },
    }
    const listed = await callTool(client, 'getAllNodes', { canvasId: CANVAS_ID })
    expect(listed.parsed.count).toBe(0)
  })

  it('reports a nonexistent canvas distinctly from a forbidden one', async () => {
    state.access = { status: 'denied', reason: 'not-found' }
    const { client } = await connect()
    const { result, text } = await callTool(client, 'getCanvasData', { canvasId: 999 })
    expect(result.isError).toBe(true)
    expect(text).toContain('不存在')
  })

  it('cascades connection deletion when a node is deleted', async () => {
    const { client } = await connect()
    const a = await callTool(client, 'createNode', { canvasId: CANVAS_ID, title: 'A' })
    const b = await callTool(client, 'createNode', { canvasId: CANVAS_ID, title: 'B', x: 400 })

    await callTool(client, 'createConnection', {
      canvasId: CANVAS_ID,
      fromNodeId: a.parsed.nodeId,
      toNodeId: b.parsed.nodeId,
    })
    const conns = await callTool(client, 'getAllConnections', { canvasId: CANVAS_ID })
    expect(conns.parsed.count).toBe(1)

    const del = await callTool(client, 'deleteNode', { canvasId: CANVAS_ID, nodeId: a.parsed.nodeId })
    expect(del.result.isError).toBeFalsy()
    expect(del.parsed.deletedConnectionIds).toHaveLength(1)

    const afterConns = await callTool(client, 'getAllConnections', { canvasId: CANVAS_ID })
    expect(afterConns.parsed.count).toBe(0)
  })

  it('auto-computes connection ports from relative node positions', async () => {
    const { client } = await connect()
    // B sits to the right of A, so ports should be right -> left.
    const a = await callTool(client, 'createNode', { canvasId: CANVAS_ID, title: 'A', x: 0, y: 0 })
    const b = await callTool(client, 'createNode', { canvasId: CANVAS_ID, title: 'B', x: 500, y: 0 })
    await callTool(client, 'createConnection', {
      canvasId: CANVAS_ID,
      fromNodeId: a.parsed.nodeId,
      toNodeId: b.parsed.nodeId,
    })

    const conns = await callTool(client, 'getAllConnections', { canvasId: CANVAS_ID })
    expect(conns.parsed.connections[0].fromPort).toBe('right')
    expect(conns.parsed.connections[0].toPort).toBe('left')
  })

  it('searches nodes by title and content with snippets', async () => {
    const { client } = await connect()
    await callTool(client, 'createNode', {
      canvasId: CANVAS_ID,
      title: 'Alpha',
      content: 'nothing here',
    })
    await callTool(client, 'createNode', {
      canvasId: CANVAS_ID,
      title: 'Beta',
      content: 'contains alpha inside',
    })

    const byTitle = await callTool(client, 'searchNodes', {
      canvasId: CANVAS_ID,
      query: 'alpha',
      scope: 'title',
    })
    expect(byTitle.parsed.count).toBe(1)
    expect(byTitle.parsed.matches[0].match).toBe('title')

    const byContent = await callTool(client, 'searchNodes', {
      canvasId: CANVAS_ID,
      query: 'alpha',
      scope: 'content',
    })
    expect(byContent.parsed.count).toBe(1)
    expect(byContent.parsed.matches[0].match).toBe('content')

    const all = await callTool(client, 'searchNodes', { canvasId: CANVAS_ID, query: 'alpha' })
    expect(all.parsed.count).toBe(2)
  })

  it('batch-updates nodes and reports the ones that were skipped', async () => {
    const { client } = await connect()
    const a = await callTool(client, 'createNode', { canvasId: CANVAS_ID, title: 'A' })
    const b = await callTool(client, 'createNode', { canvasId: CANVAS_ID, title: 'B' })

    const res = await callTool(client, 'batchUpdateNodes', {
      canvasId: CANVAS_ID,
      nodeIds: [a.parsed.nodeId, b.parsed.nodeId, 'ghost'],
      color: '#e3f2fd',
    })
    expect(res.parsed.updated).toBe(2)
    expect(res.parsed.skipped).toEqual(['ghost'])

    const listed = await callTool(client, 'getAllNodes', { canvasId: CANVAS_ID })
    for (const node of listed.parsed.nodes) expect(node.color).toBe('#e3f2fd')
  })

  it('builds a whole graph from JSON, resolving connections by title', async () => {
    const { client } = await connect()
    const res = await callTool(client, 'generateGraphFromJSON', {
      canvasId: CANVAS_ID,
      data: {
        nodes: [
          { title: '中心', x: 0, y: 0 },
          { title: '左', x: -300, y: 0 },
          { title: '右', x: 300, y: 0 },
        ],
        connections: [
          { from: '中心', to: '左', label: 'L' },
          { from: '中心', to: '右', label: 'R' },
        ],
        groups: [{ name: '一组', nodeIds: ['中心', '左'] }],
        domains: [{ name: '区域', nodeIds: ['中心', '左', '右'] }],
      },
    })

    expect(res.result.isError).toBeFalsy()
    expect(res.parsed.nodesCreated).toBe(3)
    expect(res.parsed.connectionsCreated).toBe(2)
    expect(res.parsed.groupsCreated).toBe(1)
    expect(res.parsed.domainsCreated).toBe(1)

    const data = await callTool(client, 'getCanvasData', { canvasId: CANVAS_ID })
    expect(data.parsed.counts.nodes).toBe(3)
    expect(data.parsed.counts.connections).toBe(2)
    // Group auto-bounds must actually cover the nodes it names.
    const group = data.parsed.groups[0]
    expect(group.width).toBeGreaterThan(0)
    expect(group.nodeIds).toHaveLength(2)
  })

  it('appends rather than replaces when generating into a non-empty canvas', async () => {
    const { client } = await connect()
    await callTool(client, 'createNode', { canvasId: CANVAS_ID, title: 'pre-existing' })

    await callTool(client, 'generateGraphFromJSON', {
      canvasId: CANVAS_ID,
      data: { nodes: [{ title: 'added' }] },
    })

    const data = await callTool(client, 'getAllNodes', { canvasId: CANVAS_ID })
    expect(data.parsed.count).toBe(2)
    const titles = data.parsed.nodes.map((n: any) => n.title).sort()
    expect(titles).toEqual(['added', 'pre-existing'])
  })

  it('rejects a graph whose node is missing a title, naming its position', async () => {
    const { client } = await connect()
    const { result, text } = await callTool(client, 'generateGraphFromJSON', {
      canvasId: CANVAS_ID,
      data: { nodes: [{ title: 'ok' }, { title: '' }] },
    })
    expect(result.isError).toBe(true)
    expect(text).toContain('第 2 个节点')
  })

  it('rejects an empty nodes array', async () => {
    const { client } = await connect()
    const { result, text } = await callTool(client, 'generateGraphFromJSON', {
      canvasId: CANVAS_ID,
      data: { nodes: [] },
    })
    expect(result.isError).toBe(true)
    expect(text).toContain('不能为空')
  })

  it('undoes and redoes an agent write', async () => {
    const { client } = await connect()
    await callTool(client, 'createNode', { canvasId: CANVAS_ID, title: 'A' })

    const undone = await callTool(client, 'undo', { canvasId: CANVAS_ID })
    expect(undone.result.isError).toBeFalsy()
    const afterUndo = await callTool(client, 'getAllNodes', { canvasId: CANVAS_ID })
    expect(afterUndo.parsed.count).toBe(0)

    const redone = await callTool(client, 'redo', { canvasId: CANVAS_ID })
    expect(redone.result.isError).toBeFalsy()
    const afterRedo = await callTool(client, 'getAllNodes', { canvasId: CANVAS_ID })
    expect(afterRedo.parsed.count).toBe(1)
  })

  it('reports nothing to undo on a fresh canvas rather than throwing', async () => {
    const { client } = await connect()
    const { result, text } = await callTool(client, 'undo', { canvasId: CANVAS_ID })
    expect(result.isError).toBe(true)
    expect(text).toContain('没有可撤销的操作')
  })

  it('rejects an invalid canvasId at the schema level', async () => {
    const { client } = await connect()
    // The SDK reports schema violations as an isError result (JSON-RPC -32602),
    // not as a transport-level rejection.
    const negative: any = await client.callTool({
      name: 'getAllNodes',
      arguments: { canvasId: -1 },
    })
    expect(negative.isError).toBe(true)
    expect(negative.content[0].text).toContain('canvasId')

    const notANumber: any = await client.callTool({
      name: 'getAllNodes',
      arguments: { canvasId: 'abc' },
    })
    expect(notANumber.isError).toBe(true)
    expect(notANumber.content[0].text).toContain('canvasId')
  })

  it('lists accessible canvases for the authenticated user', async () => {
    // Owned projects come from the first select; memberships/canvases follow.
    state.projects = [{ id: 1, name: 'Mine' }]
    const { client } = await connect()

    const { parsed, result } = await callTool(client, 'listCanvases', {})
    expect(result.isError).toBeFalsy()
    expect(Array.isArray(parsed.canvases)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Error paths and option handling in tools.ts
//
// The suite above covers the happy paths of the tool set. Everything below pins
// the branches a model hits when it supplies incomplete or wrong arguments, plus
// the option handling of createNode/updateNode/createConnection/
// generateGraphFromJSON. Each assertion reads a real tool reply or the real
// canvas snapshot, never just "defined".
// ---------------------------------------------------------------------------

interface NodeShape {
  id: string
  title: string
  content: string
  x: number
  y: number
  width: number
  height: number
  color: string
  fontSize: number
  textAlign: string
  titleAlign?: string
  contentAlign?: string
  collapsedTitleAlign?: string
  collapsed: boolean
  locked: boolean
  type: string
  imageUrl?: string
  aspectRatio?: number
}

interface ConnectionShape {
  id: string
  fromNodeId: string
  toNodeId: string
  fromPort: string
  toPort: string
  type: string
  style: string
  color: string
  width: number
  arrowType: string
  direction: string
  label: string
}

interface GroupShape {
  id: string
  name: string
  width: number
  height: number
  nodeIds: string[]
}

interface DomainShape {
  id: string
  name: string
  width: number
  height: number
}

/** Call a tool and fail the test if the SDK reported a protocol-level error. */
async function callOk(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, any>> {
  const { result, text, parsed } = await callTool(client, name, args)
  expect(result.isError, `${name} failed: ${text}`).toBeFalsy()
  return parsed
}

describe('MCP tools — error paths and options', () => {
  beforeEach(() => {
    state.access = {
      status: 'ok',
      access: { canvasId: CANVAS_ID, projectId: 1, canvasName: 'C', projectName: 'P' },
    }
    state.canvases = []
    state.projects = []
    state.memberships = []
    removeCanvasState(CANVAS_ID)
  })

  describe('update* with no updatable fields', () => {
    it('updateNode refuses an empty update set', async () => {
      const { client } = await connect()
      const created = await callOk(client, 'createNode', { canvasId: CANVAS_ID, title: 'A' })

      const { result, text } = await callTool(client, 'updateNode', {
        canvasId: CANVAS_ID,
        nodeId: created.nodeId,
      })

      expect(result.isError).toBe(true)
      expect(text).toContain('没有提供任何要更新的字段')
    })

    it('updateGroup refuses an empty update set', async () => {
      const { client } = await connect()
      const created = await callOk(client, 'createGroup', { canvasId: CANVAS_ID, name: 'G' })

      const { result, text } = await callTool(client, 'updateGroup', {
        canvasId: CANVAS_ID,
        groupId: created.groupId,
      })

      expect(result.isError).toBe(true)
      expect(text).toContain('没有提供任何要更新的字段')
    })

    it('updateDomain refuses an empty update set', async () => {
      const { client } = await connect()
      const created = await callOk(client, 'createDomain', { canvasId: CANVAS_ID, name: 'D' })

      const { result, text } = await callTool(client, 'updateDomain', {
        canvasId: CANVAS_ID,
        domainId: created.domainId,
      })

      expect(result.isError).toBe(true)
      expect(text).toContain('没有提供任何要更新的字段')
    })

    it('updateConnection refuses an empty update set', async () => {
      const { client } = await connect()
      const a = await callOk(client, 'createNode', { canvasId: CANVAS_ID, title: 'A' })
      const b = await callOk(client, 'createNode', { canvasId: CANVAS_ID, title: 'B' })
      const conn = await callOk(client, 'createConnection', {
        canvasId: CANVAS_ID,
        fromNodeId: a.nodeId,
        toNodeId: b.nodeId,
      })

      const { result, text } = await callTool(client, 'updateConnection', {
        canvasId: CANVAS_ID,
        connectionId: conn.connectionId,
      })

      expect(result.isError).toBe(true)
      expect(text).toContain('没有提供任何要更新的字段')
    })

    it('updateConnection refuses to re-point an endpoint at a nonexistent node (M3)', async () => {
      const { client } = await connect()
      const a = await callOk(client, 'createNode', { canvasId: CANVAS_ID, title: 'A' })
      const b = await callOk(client, 'createNode', { canvasId: CANVAS_ID, title: 'B' })
      const conn = await callOk(client, 'createConnection', {
        canvasId: CANVAS_ID,
        fromNodeId: a.nodeId,
        toNodeId: b.nodeId,
      })

      // New fromNodeId doesn't exist: must be refused BEFORE the write, so no
      // dangling connection (rendering skips it but it lingers in the doc) can
      // be created.
      const badFrom = await callTool(client, 'updateConnection', {
        canvasId: CANVAS_ID,
        connectionId: conn.connectionId,
        fromNodeId: 'ghost-node-x',
      })
      expect(badFrom.result.isError).toBe(true)
      expect(badFrom.text).toContain('源节点不存在')

      const badTo = await callTool(client, 'updateConnection', {
        canvasId: CANVAS_ID,
        connectionId: conn.connectionId,
        toNodeId: 'ghost-node-y',
      })
      expect(badTo.result.isError).toBe(true)
      expect(badTo.text).toContain('目标节点不存在')

      // Neither rejected request may have touched the connection.
      const conns = await callOk(client, 'getAllConnections', { canvasId: CANVAS_ID })
      const unchanged = conns.connections.find((c: { id: string }) => c.id === conn.connectionId)
      expect(unchanged.fromNodeId).toBe(a.nodeId)
      expect(unchanged.toNodeId).toBe(b.nodeId)

      // A valid re-point still works.
      const c = await callOk(client, 'createNode', { canvasId: CANVAS_ID, title: 'C' })
      const okReply = await callOk(client, 'updateConnection', {
        canvasId: CANVAS_ID,
        connectionId: conn.connectionId,
        toNodeId: c.nodeId,
      })
      expect(okReply.updates.toNodeId).toBe(c.nodeId)
    })
  })

  describe('batchUpdateNodes', () => {
    it('refuses an empty update set even with valid node ids', async () => {
      const { client } = await connect()
      const a = await callOk(client, 'createNode', { canvasId: CANVAS_ID, title: 'A' })

      const { result, text } = await callTool(client, 'batchUpdateNodes', {
        canvasId: CANVAS_ID,
        nodeIds: [a.nodeId],
      })

      expect(result.isError).toBe(true)
      expect(text).toContain('没有提供任何要更新的字段')
    })

    it('reports that every id was missing when none exist', async () => {
      const { client } = await connect()

      const { result, text } = await callTool(client, 'batchUpdateNodes', {
        canvasId: CANVAS_ID,
        nodeIds: ['ghost-1', 'ghost-2'],
        color: '#000000',
      })

      expect(result.isError).toBe(true)
      expect(text).toContain('所有节点均不存在')
    })
  })

  describe('delete* of a nonexistent id', () => {
    it('deleteConnection names the missing id', async () => {
      const { client } = await connect()
      const { result, text } = await callTool(client, 'deleteConnection', {
        canvasId: CANVAS_ID,
        connectionId: 'ghost-conn',
      })
      expect(result.isError).toBe(true)
      expect(text).toContain('ghost-conn')
      expect(text).toContain('连接不存在')
    })

    it('deleteGroup names the missing id', async () => {
      const { client } = await connect()
      const { result, text } = await callTool(client, 'deleteGroup', {
        canvasId: CANVAS_ID,
        groupId: 'ghost-group',
      })
      expect(result.isError).toBe(true)
      expect(text).toContain('ghost-group')
      expect(text).toContain('组不存在')
    })

    it('deleteDomain names the missing id', async () => {
      const { client } = await connect()
      const { result, text } = await callTool(client, 'deleteDomain', {
        canvasId: CANVAS_ID,
        domainId: 'ghost-domain',
      })
      expect(result.isError).toBe(true)
      expect(text).toContain('ghost-domain')
      expect(text).toContain('域不存在')
    })
  })

  describe('createGroup / createDomain with only nonexistent node ids', () => {
    it('createGroup refuses when no named node resolves', async () => {
      const { client } = await connect()
      const { result, text } = await callTool(client, 'createGroup', {
        canvasId: CANVAS_ID,
        name: 'Nowhere',
        nodeIds: ['nope-1', 'nope-2'],
      })
      expect(result.isError).toBe(true)
      expect(text).toContain('指定的节点均不存在')

      const groups = await callOk(client, 'getAllGroups', { canvasId: CANVAS_ID })
      expect(groups.count).toBe(0)
    })

    it('createDomain refuses when no named node resolves', async () => {
      const { client } = await connect()
      const { result, text } = await callTool(client, 'createDomain', {
        canvasId: CANVAS_ID,
        name: 'Nowhere',
        nodeIds: ['nope-1'],
      })
      expect(result.isError).toBe(true)
      expect(text).toContain('指定的节点均不存在')

      const domains = await callOk(client, 'getAllDomains', { canvasId: CANVAS_ID })
      expect(domains.count).toBe(0)
    })
  })

  describe('searchNodes validation', () => {
    it('rejects an empty query', async () => {
      const { client } = await connect()
      const { result, text } = await callTool(client, 'searchNodes', {
        canvasId: CANVAS_ID,
        query: '',
      })
      expect(result.isError).toBe(true)
      expect(text).toContain('缺少搜索关键词')
    })

    it('rejects a whitespace-only query', async () => {
      const { client } = await connect()
      const { result, text } = await callTool(client, 'searchNodes', {
        canvasId: CANVAS_ID,
        query: '   \t ',
      })
      expect(result.isError).toBe(true)
      expect(text).toContain('缺少搜索关键词')
    })
  })

  describe('read-only tools report accurate counts', () => {
    it('getCanvasData / getAllGroups / getAllDomains / getAllConnections count what was written', async () => {
      const { client } = await connect()
      const a = await callOk(client, 'createNode', { canvasId: CANVAS_ID, title: 'A', x: 0, y: 0 })
      const b = await callOk(client, 'createNode', { canvasId: CANVAS_ID, title: 'B', x: 500, y: 0 })
      await callOk(client, 'createConnection', {
        canvasId: CANVAS_ID,
        fromNodeId: a.nodeId,
        toNodeId: b.nodeId,
      })
      await callOk(client, 'createGroup', {
        canvasId: CANVAS_ID,
        name: 'G',
        nodeIds: [a.nodeId, b.nodeId],
      })
      await callOk(client, 'createDomain', {
        canvasId: CANVAS_ID,
        name: 'D',
        nodeIds: [a.nodeId],
      })

      const data = await callOk(client, 'getCanvasData', { canvasId: CANVAS_ID })
      expect(data.counts).toEqual({ nodes: 2, connections: 1, groups: 1, domains: 1 })
      expect(data.nodes).toHaveLength(2)
      expect(data.connections).toHaveLength(1)
      expect(data.groups).toHaveLength(1)
      expect(data.domains).toHaveLength(1)

      const groups = await callOk(client, 'getAllGroups', { canvasId: CANVAS_ID })
      expect(groups.count).toBe(1)
      expect((groups.groups as GroupShape[])[0].name).toBe('G')
      // Auto-bounds must actually span both nodes.
      expect((groups.groups as GroupShape[])[0].width).toBeGreaterThan(0)

      const domains = await callOk(client, 'getAllDomains', { canvasId: CANVAS_ID })
      expect(domains.count).toBe(1)
      expect((domains.domains as DomainShape[])[0].name).toBe('D')

      const conns = await callOk(client, 'getAllConnections', { canvasId: CANVAS_ID })
      expect(conns.count).toBe(1)
      expect((conns.connections as ConnectionShape[])[0].fromNodeId).toBe(a.nodeId)
    })

    it('reports zero counts on an empty canvas', async () => {
      const { client } = await connect()
      expect((await callOk(client, 'getAllGroups', { canvasId: CANVAS_ID })).count).toBe(0)
      expect((await callOk(client, 'getAllDomains', { canvasId: CANVAS_ID })).count).toBe(0)
      expect((await callOk(client, 'getAllConnections', { canvasId: CANVAS_ID })).count).toBe(0)
      const data = await callOk(client, 'getCanvasData', { canvasId: CANVAS_ID })
      expect(data.counts).toEqual({ nodes: 0, connections: 0, groups: 0, domains: 0 })
    })
  })

  describe('createNode option handling', () => {
    it('sets imageUrl for type:image', async () => {
      const { client } = await connect()
      await callOk(client, 'createNode', {
        canvasId: CANVAS_ID,
        title: 'Pic',
        type: 'image',
        imageUrl: 'https://example.test/a.png',
      })

      const listed = await callOk(client, 'getAllNodes', { canvasId: CANVAS_ID })
      const node = (listed.nodes as NodeShape[])[0]
      expect(node.type).toBe('image')
      expect(node.imageUrl).toBe('https://example.test/a.png')
    })

    it('defaults imageUrl to an empty string for type:image without one', async () => {
      const { client } = await connect()
      await callOk(client, 'createNode', { canvasId: CANVAS_ID, title: 'Pic', type: 'image' })

      const listed = await callOk(client, 'getAllNodes', { canvasId: CANVAS_ID })
      expect((listed.nodes as NodeShape[])[0].imageUrl).toBe('')
    })

    it('persists aspectRatio when supplied and omits it otherwise', async () => {
      const { client } = await connect()
      await callOk(client, 'createNode', { canvasId: CANVAS_ID, title: 'With', aspectRatio: 1.5 })
      await callOk(client, 'createNode', { canvasId: CANVAS_ID, title: 'Without' })

      const listed = await callOk(client, 'getAllNodes', { canvasId: CANVAS_ID })
      const nodes = listed.nodes as NodeShape[]
      expect(nodes.find((n) => n.title === 'With')?.aspectRatio).toBe(1.5)
      expect(nodes.find((n) => n.title === 'Without')?.aspectRatio).toBeUndefined()
    })

    it('persists every alignment field', async () => {
      const { client } = await connect()
      await callOk(client, 'createNode', {
        canvasId: CANVAS_ID,
        title: 'Aligned',
        textAlign: 'left',
        titleAlign: 'right',
        contentAlign: 'center',
        collapsedTitleAlign: 'left',
      })

      const listed = await callOk(client, 'getAllNodes', { canvasId: CANVAS_ID })
      const node = (listed.nodes as NodeShape[])[0]
      expect(node.textAlign).toBe('left')
      expect(node.titleAlign).toBe('right')
      expect(node.contentAlign).toBe('center')
      expect(node.collapsedTitleAlign).toBe('left')
    })

    it('persists collapsed and locked booleans', async () => {
      const { client } = await connect()
      await callOk(client, 'createNode', {
        canvasId: CANVAS_ID,
        title: 'Flags',
        collapsed: true,
        locked: true,
      })

      const listed = await callOk(client, 'getAllNodes', { canvasId: CANVAS_ID })
      const node = (listed.nodes as NodeShape[])[0]
      expect(node.collapsed).toBe(true)
      expect(node.locked).toBe(true)
    })

    it('defaults geometry and style when nothing is supplied', async () => {
      const { client } = await connect()
      await callOk(client, 'createNode', { canvasId: CANVAS_ID, title: 'Defaults' })

      const listed = await callOk(client, 'getAllNodes', { canvasId: CANVAS_ID })
      const node = (listed.nodes as NodeShape[])[0]
      expect(node.x).toBe(0)
      expect(node.y).toBe(0)
      expect(node.width).toBe(200)
      expect(node.height).toBe(160)
      expect(node.color).toBe('#ffffff')
      expect(node.fontSize).toBe(14)
      expect(node.textAlign).toBe('center')
      expect(node.collapsed).toBe(false)
      expect(node.locked).toBe(false)
      expect(node.type).toBe('text')
    })
  })

  describe('updateNode persists each scalar field', () => {
    it('writes x/y/width/height/color/fontSize/collapsed/locked', async () => {
      const { client } = await connect()
      const created = await callOk(client, 'createNode', {
        canvasId: CANVAS_ID,
        title: 'Before',
        content: 'keep',
        x: 1,
        y: 2,
        width: 200,
        height: 160,
      })

      const updated = await callTool(client, 'updateNode', {
        canvasId: CANVAS_ID,
        nodeId: created.nodeId,
        x: 111,
        y: 222,
        width: 333,
        height: 444,
        color: '#ff0000',
        fontSize: 22,
        collapsed: true,
        locked: true,
      })
      expect(updated.result.isError).toBeFalsy()

      const listed = await callOk(client, 'getAllNodes', { canvasId: CANVAS_ID })
      const node = (listed.nodes as NodeShape[])[0]
      expect(node.x).toBe(111)
      expect(node.y).toBe(222)
      expect(node.width).toBe(333)
      expect(node.height).toBe(444)
      expect(node.color).toBe('#ff0000')
      expect(node.fontSize).toBe(22)
      expect(node.collapsed).toBe(true)
      expect(node.locked).toBe(true)
      // Untouched fields survive a partial update.
      expect(node.title).toBe('Before')
      expect(node.content).toBe('keep')
    })

    it('updates alignment fields and aspectRatio individually', async () => {
      const { client } = await connect()
      const created = await callOk(client, 'createNode', { canvasId: CANVAS_ID, title: 'N' })

      await callOk(client, 'updateNode', {
        canvasId: CANVAS_ID,
        nodeId: created.nodeId,
        textAlign: 'right',
        titleAlign: 'center',
        contentAlign: 'left',
        collapsedTitleAlign: 'right',
        aspectRatio: 2,
      })

      const listed = await callOk(client, 'getAllNodes', { canvasId: CANVAS_ID })
      const node = (listed.nodes as NodeShape[])[0]
      expect(node.textAlign).toBe('right')
      expect(node.titleAlign).toBe('center')
      expect(node.contentAlign).toBe('left')
      expect(node.collapsedTitleAlign).toBe('right')
      expect(node.aspectRatio).toBe(2)
    })

    it('returns the applied updates so the caller can see what changed', async () => {
      const { client } = await connect()
      const created = await callOk(client, 'createNode', { canvasId: CANVAS_ID, title: 'N' })

      const updated = await callOk(client, 'updateNode', {
        canvasId: CANVAS_ID,
        nodeId: created.nodeId,
        title: 'Renamed',
        color: '#00ff00',
      })
      expect(updated.nodeId).toBe(created.nodeId)
      expect(updated.updates).toEqual({ title: 'Renamed', color: '#00ff00' })
    })
  })

  describe('createConnection explicit ports', () => {
    it('lets fromPort/toPort override the auto-computed ports', async () => {
      const { client } = await connect()
      // B is to the right of A, so the auto ports would be right -> left.
      const a = await callOk(client, 'createNode', { canvasId: CANVAS_ID, title: 'A', x: 0, y: 0 })
      const b = await callOk(client, 'createNode', { canvasId: CANVAS_ID, title: 'B', x: 500, y: 0 })

      await callOk(client, 'createConnection', {
        canvasId: CANVAS_ID,
        fromNodeId: a.nodeId,
        toNodeId: b.nodeId,
        fromPort: 'top',
        toPort: 'bottom',
      })

      const conns = await callOk(client, 'getAllConnections', { canvasId: CANVAS_ID })
      const conn = (conns.connections as ConnectionShape[])[0]
      expect(conn.fromPort).toBe('top')
      expect(conn.toPort).toBe('bottom')
    })

    it('applies the supplied connection style options', async () => {
      const { client } = await connect()
      const a = await callOk(client, 'createNode', { canvasId: CANVAS_ID, title: 'A' })
      const b = await callOk(client, 'createNode', { canvasId: CANVAS_ID, title: 'B' })

      await callOk(client, 'createConnection', {
        canvasId: CANVAS_ID,
        fromNodeId: a.nodeId,
        toNodeId: b.nodeId,
        type: 'step',
        style: 'dashed',
        color: '#123456',
        width: 4,
        label: 'edge',
        arrowType: 'both',
        direction: 'bidirectional',
      })

      const conns = await callOk(client, 'getAllConnections', { canvasId: CANVAS_ID })
      const conn = (conns.connections as ConnectionShape[])[0]
      expect(conn.type).toBe('step')
      expect(conn.style).toBe('dashed')
      expect(conn.color).toBe('#123456')
      expect(conn.width).toBe(4)
      expect(conn.label).toBe('edge')
      expect(conn.arrowType).toBe('both')
      expect(conn.direction).toBe('bidirectional')
    })

    it('reports a missing endpoint node by id', async () => {
      const { client } = await connect()
      const a = await callOk(client, 'createNode', { canvasId: CANVAS_ID, title: 'A' })

      const missingTarget = await callTool(client, 'createConnection', {
        canvasId: CANVAS_ID,
        fromNodeId: a.nodeId,
        toNodeId: 'ghost',
      })
      expect(missingTarget.result.isError).toBe(true)
      expect(missingTarget.text).toContain('ghost')

      const missingSource = await callTool(client, 'createConnection', {
        canvasId: CANVAS_ID,
        fromNodeId: 'ghost',
        toNodeId: a.nodeId,
      })
      expect(missingSource.result.isError).toBe(true)
      expect(missingSource.text).toContain('ghost')
    })
  })

  describe('updateConnection / updateGroup / updateDomain persist fields', () => {
    it('updateConnection writes the supplied fields', async () => {
      const { client } = await connect()
      const a = await callOk(client, 'createNode', { canvasId: CANVAS_ID, title: 'A' })
      const b = await callOk(client, 'createNode', { canvasId: CANVAS_ID, title: 'B' })
      const conn = await callOk(client, 'createConnection', {
        canvasId: CANVAS_ID,
        fromNodeId: a.nodeId,
        toNodeId: b.nodeId,
      })

      await callOk(client, 'updateConnection', {
        canvasId: CANVAS_ID,
        connectionId: conn.connectionId,
        style: 'dotted',
        color: '#abcdef',
        width: 7,
        label: 'updated',
        arrowType: 'none',
        direction: 'undirected',
      })

      const conns = await callOk(client, 'getAllConnections', { canvasId: CANVAS_ID })
      const updated = (conns.connections as ConnectionShape[])[0]
      expect(updated.style).toBe('dotted')
      expect(updated.color).toBe('#abcdef')
      expect(updated.width).toBe(7)
      expect(updated.label).toBe('updated')
      expect(updated.arrowType).toBe('none')
      expect(updated.direction).toBe('undirected')
      // The endpoints are untouched.
      expect(updated.fromNodeId).toBe(a.nodeId)
      expect(updated.toNodeId).toBe(b.nodeId)
    })

    it('updateGroup writes the supplied fields and keeps nodeIds', async () => {
      const { client } = await connect()
      const a = await callOk(client, 'createNode', { canvasId: CANVAS_ID, title: 'A' })
      const group = await callOk(client, 'createGroup', {
        canvasId: CANVAS_ID,
        name: 'G',
        nodeIds: [a.nodeId],
      })

      await callOk(client, 'updateGroup', {
        canvasId: CANVAS_ID,
        groupId: group.groupId,
        name: 'Renamed',
        description: 'desc',
        borderColor: '#111111',
        backgroundColor: 'rgba(1,2,3,0.5)',
        borderWidth: 5,
        borderRadius: 12,
        collapsed: true,
      })

      const groups = await callOk(client, 'getAllGroups', { canvasId: CANVAS_ID })
      const updated = (groups.groups as GroupShape[])[0]
      expect(updated.name).toBe('Renamed')
      expect(updated.borderWidth).toBe(5)
      expect(updated.borderRadius).toBe(12)
      expect(updated.collapsed).toBe(true)
      expect(updated.nodeIds).toEqual([a.nodeId])
    })

    it('updateDomain writes the supplied fields', async () => {
      const { client } = await connect()
      const domain = await callOk(client, 'createDomain', { canvasId: CANVAS_ID, name: 'D' })

      await callOk(client, 'updateDomain', {
        canvasId: CANVAS_ID,
        domainId: domain.domainId,
        name: 'Renamed',
        backgroundColor: 'rgba(9,9,9,0.2)',
        titleVisible: false,
        titleColor: '#222222',
        titleFontSize: 18,
        titleScale: 1.5,
      })

      const domains = await callOk(client, 'getAllDomains', { canvasId: CANVAS_ID })
      const updated = (domains.domains as DomainShape[])[0]
      expect(updated.name).toBe('Renamed')
      expect(updated.titleVisible).toBe(false)
      expect(updated.titleColor).toBe('#222222')
      expect(updated.titleFontSize).toBe(18)
      expect(updated.titleScale).toBe(1.5)
    })
  })

  describe('generateGraphFromJSON — layout', () => {
    it('lays out nodes on a grid with the requested column count', async () => {
      const { client } = await connect()
      const res = await callOk(client, 'generateGraphFromJSON', {
        canvasId: CANVAS_ID,
        data: {
          nodes: [{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }],
          layout: { type: 'grid', columns: 2, spacing: 100, centerX: 0, centerY: 0 },
        },
      })
      expect(res.nodesCreated).toBe(4)

      const listed = await callOk(client, 'getAllNodes', { canvasId: CANVAS_ID })
      const nodes = listed.nodes as NodeShape[]
      for (const node of nodes) {
        expect(typeof node.x).toBe('number')
        expect(typeof node.y).toBe('number')
        expect(Number.isFinite(node.x)).toBe(true)
        expect(Number.isFinite(node.y)).toBe(true)
      }
      // Two columns: exactly two distinct x values, and two rows.
      expect(new Set(nodes.map((n) => n.x))).toEqual(new Set([-50, 50]))
      expect(new Set(nodes.map((n) => n.y))).toEqual(new Set([-100, 0]))
    })

    it('lays out nodes on a circle when asked', async () => {
      const { client } = await connect()
      const res = await callOk(client, 'generateGraphFromJSON', {
        canvasId: CANVAS_ID,
        data: {
          nodes: [{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }],
          layout: { type: 'circle', spacing: 100, centerX: 10, centerY: 20 },
        },
      })
      expect(res.nodesCreated).toBe(4)

      const listed = await callOk(client, 'getAllNodes', { canvasId: CANVAS_ID })
      const nodes = listed.nodes as NodeShape[]
      for (const node of nodes) {
        expect(Number.isFinite(node.x)).toBe(true)
        expect(Number.isFinite(node.y)).toBe(true)
      }
      // A circle must not collapse every node onto one point.
      expect(new Set(nodes.map((n) => `${n.x},${n.y}`)).size).toBe(4)
    })

    it('keeps explicitly supplied coordinates even when a layout is present', async () => {
      const { client } = await connect()
      await callOk(client, 'generateGraphFromJSON', {
        canvasId: CANVAS_ID,
        data: {
          nodes: [{ title: 'Fixed', x: 1234, y: 5678 }],
          layout: { type: 'grid' },
        },
      })

      const listed = await callOk(client, 'getAllNodes', { canvasId: CANVAS_ID })
      const node = (listed.nodes as NodeShape[])[0]
      expect(node.x).toBe(1234)
      expect(node.y).toBe(5678)
    })
  })

  describe('generateGraphFromJSON — default styles', () => {
    it('applies defaultNodeStyle to every node', async () => {
      const { client } = await connect()
      await callOk(client, 'generateGraphFromJSON', {
        canvasId: CANVAS_ID,
        data: {
          nodes: [{ title: 'A' }, { title: 'B' }],
          defaultNodeStyle: {
            color: '#123456',
            width: 333,
            height: 222,
            fontSize: 20,
            content: 'from default',
            textAlign: 'right',
            collapsed: true,
            locked: true,
            titleAlign: 'left',
          },
        },
      })

      const listed = await callOk(client, 'getAllNodes', { canvasId: CANVAS_ID })
      for (const node of listed.nodes as NodeShape[]) {
        expect(node.color).toBe('#123456')
        expect(node.width).toBe(333)
        expect(node.height).toBe(222)
        expect(node.fontSize).toBe(20)
        expect(node.content).toBe('from default')
        expect(node.textAlign).toBe('right')
        expect(node.collapsed).toBe(true)
        expect(node.locked).toBe(true)
        expect(node.titleAlign).toBe('left')
      }
    })

    it('lets an explicit node field win over the default style', async () => {
      const { client } = await connect()
      await callOk(client, 'generateGraphFromJSON', {
        canvasId: CANVAS_ID,
        data: {
          nodes: [{ title: 'A', color: '#ffffff', content: 'own' }],
          defaultNodeStyle: { color: '#000000', content: 'default' },
        },
      })

      const listed = await callOk(client, 'getAllNodes', { canvasId: CANVAS_ID })
      const node = (listed.nodes as NodeShape[])[0]
      expect(node.color).toBe('#ffffff')
      expect(node.content).toBe('own')
    })

    it('applies defaultConnectionStyle to every connection', async () => {
      const { client } = await connect()
      await callOk(client, 'generateGraphFromJSON', {
        canvasId: CANVAS_ID,
        data: {
          nodes: [
            { title: 'A', x: 0, y: 0 },
            { title: 'B', x: 400, y: 0 },
          ],
          connections: [{ from: 'A', to: 'B' }],
          defaultConnectionStyle: {
            color: '#abcdef',
            style: 'dashed',
            type: 'step',
            width: 5,
            arrowType: 'none',
            direction: 'undirected',
          },
        },
      })

      const conns = await callOk(client, 'getAllConnections', { canvasId: CANVAS_ID })
      const conn = (conns.connections as ConnectionShape[])[0]
      expect(conn.color).toBe('#abcdef')
      expect(conn.style).toBe('dashed')
      expect(conn.type).toBe('step')
      expect(conn.width).toBe(5)
      expect(conn.arrowType).toBe('none')
      expect(conn.direction).toBe('undirected')
    })

    it('reports skipped connections whose endpoint refs cannot be resolved (L2)', async () => {
      const { client } = await connect()
      const res = await callOk(client, 'generateGraphFromJSON', {
        canvasId: CANVAS_ID,
        data: {
          nodes: [{ title: 'A', x: 0, y: 0 }],
          connections: [
            { from: 'A', to: 'B' }, // B 不存在 → 跳过
            { from: 'Ghost', to: 'A' }, // Ghost 不存在 → 跳过
          ],
        },
      })

      expect(res.connectionsCreated).toBe(0)
      expect(res.connectionsSkipped).toBe(2)

      // 默认色与 createConnection 一致（agent 建线与用户手画同色）。
      const okRes = await callOk(client, 'generateGraphFromJSON', {
        canvasId: CANVAS_ID,
        data: {
          nodes: [{ title: 'A', x: 0, y: 0 }, { title: 'B', x: 400, y: 0 }],
          connections: [{ from: 'A', to: 'B' }],
        },
      })
      expect(okRes.connectionsSkipped).toBe(0)
      const conns = await callOk(client, 'getAllConnections', { canvasId: CANVAS_ID })
      const conn = (conns.connections as ConnectionShape[])[0]
      expect(conn.color).toBe('#3b82f6')
    })
  })

  describe('generateGraphFromJSON — id collisions', () => {
    it('never overwrites an existing entity when a supplied id collides', async () => {
      const { client } = await connect()
      const existing = await callOk(client, 'createNode', {
        canvasId: CANVAS_ID,
        title: 'Original',
        content: 'must survive',
      })

      const res = await callOk(client, 'generateGraphFromJSON', {
        canvasId: CANVAS_ID,
        data: { nodes: [{ id: existing.nodeId, title: 'Collision' }] },
      })
      expect(res.nodesCreated).toBe(1)
      // The generated node got a fresh id rather than the colliding one.
      expect(res.nodeIds[0]).not.toBe(existing.nodeId)

      const listed = await callOk(client, 'getAllNodes', { canvasId: CANVAS_ID })
      expect(listed.count).toBe(2)
      const original = (listed.nodes as NodeShape[]).find((n) => n.id === existing.nodeId)
      expect(original?.title).toBe('Original')
      expect(original?.content).toBe('must survive')
    })

    it('resolves a collision between two nodes inside the same payload', async () => {
      const { client } = await connect()
      const res = await callOk(client, 'generateGraphFromJSON', {
        canvasId: CANVAS_ID,
        data: {
          nodes: [
            { id: 'dup', title: 'First' },
            { id: 'dup', title: 'Second' },
          ],
        },
      })
      expect(res.nodesCreated).toBe(2)
      expect(new Set(res.nodeIds).size).toBe(2)

      const listed = await callOk(client, 'getAllNodes', { canvasId: CANVAS_ID })
      const titles = (listed.nodes as NodeShape[]).map((n) => n.title).sort()
      expect(titles).toEqual(['First', 'Second'])
    })

    it('resolves a connection id collision against an existing connection', async () => {
      const { client } = await connect()
      const a = await callOk(client, 'createNode', { canvasId: CANVAS_ID, title: 'A', x: 0, y: 0 })
      const b = await callOk(client, 'createNode', { canvasId: CANVAS_ID, title: 'B', x: 500, y: 0 })
      const existingConn = await callOk(client, 'createConnection', {
        canvasId: CANVAS_ID,
        fromNodeId: a.nodeId,
        toNodeId: b.nodeId,
      })

      await callOk(client, 'generateGraphFromJSON', {
        canvasId: CANVAS_ID,
        data: {
          nodes: [
            { id: 'c-a', title: 'CA', x: 0, y: 0 },
            { id: 'c-b', title: 'CB', x: 400, y: 0 },
          ],
          connections: [{ id: existingConn.connectionId, from: 'c-a', to: 'c-b' }],
        },
      })

      const conns = await callOk(client, 'getAllConnections', { canvasId: CANVAS_ID })
      expect(conns.count).toBe(2)
      // The pre-existing connection still points at its original endpoints.
      const original = (conns.connections as ConnectionShape[]).find(
        (c) => c.id === existingConn.connectionId,
      )
      expect(original?.fromNodeId).toBe(a.nodeId)
      expect(original?.toNodeId).toBe(b.nodeId)
    })
  })

  describe('undo / redo on a canvas with no history', () => {
    it('redo reports nothing to redo instead of throwing', async () => {
      const { client } = await connect()
      const { result, text } = await callTool(client, 'redo', { canvasId: CANVAS_ID })
      expect(result.isError).toBe(true)
      expect(text).toContain('没有可重做的操作')
    })

    it('undo and redo both answer with an error, never a protocol failure', async () => {
      const { client } = await connect()
      const undone = await callTool(client, 'undo', { canvasId: CANVAS_ID })
      const redone = await callTool(client, 'redo', { canvasId: CANVAS_ID })
      expect(undone.result.isError).toBe(true)
      expect(redone.result.isError).toBe(true)
      expect(undone.parsed).toBeNull()
      expect(redone.parsed).toBeNull()
    })
  })
})
