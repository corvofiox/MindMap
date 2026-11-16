/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Workspace MCP tools against a real (in-memory) database and a real Yjs doc.
 *
 * Why a separate file from `mcp-server.test.ts`: that one stubs the DB to isolate the
 * protocol layer. These tools are thin adapters over `domain/*`, so the interesting
 * failures are SQL-shaped (isolation, cascade order, size caps, optimistic locks). The
 * shared integration harness gives a fully migrated SQLite plus seeds, and the real
 * `createMcpServer` is driven through the SDK's in-memory transport — so the assertions
 * run over the actual protocol, including zod validation and the error contract.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../utils/logger.js', () => ({ log: vi.fn(), logError: vi.fn() }))

vi.mock('../database/connection.js', async () => {
  const { installDbMock } = await import('./helpers/integration-harness.js')
  return installDbMock()
})

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  createTestDatabase,
  seedCanvas,
  seedMember,
  seedProject,
  seedUser,
  setTestEnv,
  type TestDatabase,
} from './helpers/integration-harness.js'

setTestEnv()

const { createMcpServer } = await import('../mcp/server.js')
const { removeCanvasState } = await import('../websocket/canvas-state.js')

const OWNER_EMAIL = 'owner@test.com'
const VIEWER_EMAIL = 'viewer@test.com'

let t: TestDatabase
let ownerId: number
let viewerId: number
let projectId: number
let canvasId: number

async function connect(userId: number = ownerId) {
  const server = createMcpServer({ userId })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'workspace-test', version: '1.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client, server }
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result: any = await client.callTool({ name, arguments: args })
  const text = result.content?.[0]?.text ?? ''
  let parsed: any = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  return { result, text, parsed, isError: result.isError === true }
}

beforeEach(() => {
  t = createTestDatabase()
  ownerId = seedUser(t.raw, OWNER_EMAIL)
  viewerId = seedUser(t.raw, VIEWER_EMAIL)
  projectId = seedProject(t.raw, ownerId, 'P')
  seedMember(t.raw, projectId, viewerId, 'viewer')
  canvasId = seedCanvas(t.raw, projectId, 'C')
  removeCanvasState(canvasId)
})

// ---------------------------------------------------------------------------
// Notebook
// ---------------------------------------------------------------------------

describe('notebook tools', () => {
  it('creates a manuscript from plain text, escaping it and building a preview', async () => {
    const { client } = await connect()
    const created = await call(client, 'notebookCreate', {
      title: '第一篇',
      text: '第一段\n第二行\n\n<script>alert(1)</script>',
    })

    expect(created.isError).toBeFalsy()
    expect(created.parsed.manuscriptId).toBeGreaterThan(0)
    expect(created.parsed.title).toBe('第一篇')
    // text mode escapes everything, so a pasted script tag is inert text
    expect(created.parsed.contentHtml).toContain('&lt;script&gt;')
    expect(created.parsed.contentHtml).not.toContain('<script>')
    expect(created.parsed.contentText).toContain('第一段')
    expect(created.parsed.imageCount).toBe(0)
  })

  it('lists only live manuscripts, isolated per account', async () => {
    const { client } = await connect()
    await call(client, 'notebookCreate', { text: 'a' })
    await call(client, 'notebookCreate', { text: 'b' })

    const mine = await call(client, 'notebookList', {})
    expect(mine.parsed.total).toBe(2)

    const other = await connect(viewerId)
    const theirs = await call(other.client, 'notebookList', {})
    expect(theirs.parsed.total).toBe(0)
  })

  it('pages with nextOffset instead of dumping everything', async () => {
    const { client } = await connect()
    for (let i = 0; i < 5; i++) await call(client, 'notebookCreate', { title: `m${i}` })

    const first = await call(client, 'notebookList', { limit: 2 })
    expect(first.parsed.items).toHaveLength(2)
    expect(first.parsed.total).toBe(5)
    expect(first.parsed.hasMore).toBe(true)
    expect(first.parsed.nextOffset).toBe(2)

    const last = await call(client, 'notebookList', { limit: 2, offset: 4 })
    expect(last.parsed.items).toHaveLength(1)
    expect(last.parsed.hasMore).toBe(false)
    expect(last.parsed.nextOffset).toBeNull()
  })

  it('refuses to overwrite a manuscript that changed since the caller read it', async () => {
    const { client } = await connect()
    const created = await call(client, 'notebookCreate', { title: '并发', text: 'v1' })
    const id = created.parsed.manuscriptId
    const stale = created.parsed.updatedAt

    // Simulate the user saving in the editor while the agent was thinking.
    t.raw.prepare('UPDATE manuscripts SET updated_at = updated_at + 10 WHERE id = ?').run(id)

    const rejected = await call(client, 'notebookUpdate', {
      manuscriptId: id,
      text: 'agent version',
      expectedUpdatedAt: stale,
    })
    expect(rejected.isError).toBe(true)
    expect(rejected.text).toContain('E_CONFLICT')
    // The user's content must still be there.
    const current = await call(client, 'notebookGet', { manuscriptId: id })
    expect(current.parsed.contentText).toContain('v1')

    // Re-reading and retrying with the fresh stamp succeeds.
    const retry = await call(client, 'notebookUpdate', {
      manuscriptId: id,
      text: 'agent version',
      expectedUpdatedAt: current.parsed.updatedAt,
    })
    expect(retry.isError).toBeFalsy()
    expect(retry.parsed.contentText).toContain('agent version')
  })

  it('rejects obviously hostile html instead of storing it', async () => {
    const { client } = await connect()
    const res = await call(client, 'notebookCreate', { html: '<p onclick="x()">hi</p>' })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('E_VALIDATION')
  })

  it('soft-deletes a manuscript so it disappears from every read path', async () => {
    const { client } = await connect()
    const created = await call(client, 'notebookCreate', { text: 'x' })
    const id = created.parsed.manuscriptId

    const deleted = await call(client, 'notebookDelete', { manuscriptId: id })
    expect(deleted.isError).toBeFalsy()

    const gone = await call(client, 'notebookGet', { manuscriptId: id })
    expect(gone.isError).toBe(true)
    expect(gone.text).toContain('E_NOT_FOUND')
    const list = await call(client, 'notebookList', {})
    expect(list.parsed.total).toBe(0)
    // soft, not physical: the row is still there for the retention job
    expect(t.raw.prepare('SELECT deleted_at FROM manuscripts WHERE id = ?').get(id)).toBeTruthy()
  })

  it('cannot read another account\'s manuscript through a guessed id', async () => {
    const owner = await connect(ownerId)
    const created = await call(owner.client, 'notebookCreate', { text: 'private' })
    const viewer = await connect(viewerId)

    const peek = await call(viewer.client, 'notebookGet', { manuscriptId: created.parsed.manuscriptId })
    expect(peek.isError).toBe(true)
    expect(peek.text).toContain('E_NOT_FOUND')
  })

  it('builds a folder tree with readable paths and per-folder counts', async () => {
    const { client } = await connect()
    const parent = await call(client, 'notebookFolderCreate', { name: '剧本' })
    const child = await call(client, 'notebookFolderCreate', {
      name: '第一幕',
      parentId: parent.parsed.folderId,
    })
    await call(client, 'notebookCreate', { text: 'a', folderId: child.parsed.folderId })

    const listed = await call(client, 'notebookFolderList', {})
    const byId = new Map(listed.parsed.folders.map((f: any) => [f.folderId, f]))
    expect(byId.get(child.parsed.folderId).path).toBe('剧本/第一幕')
    expect(byId.get(child.parsed.folderId).manuscriptCount).toBe(1)
    expect(byId.get(parent.parsed.folderId).manuscriptCount).toBe(0)
  })

  it('refuses to delete a folder without confirm, and cascades only with it', async () => {
    const { client } = await connect()
    const folder = await call(client, 'notebookFolderCreate', { name: '待删' })
    const child = await call(client, 'notebookFolderCreate', {
      name: '子',
      parentId: folder.parsed.folderId,
    })
    const doc = await call(client, 'notebookCreate', { text: 'inside', folderId: child.parsed.folderId })

    const refused = await call(client, 'notebookFolderDelete', { folderId: folder.parsed.folderId })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('E_VALIDATION')
    expect((await call(client, 'notebookList', {})).parsed.total).toBe(1)

    const done = await call(client, 'notebookFolderDelete', {
      folderId: folder.parsed.folderId,
      confirm: true,
    })
    expect(done.isError).toBeFalsy()
    expect(done.parsed.deletedFolders).toBe(2)
    expect(done.parsed.deletedManuscripts).toBe(1)
    expect((await call(client, 'notebookList', {})).parsed.total).toBe(0)
    // The manuscript still exists as a row (soft delete), it is just invisible.
    expect(t.raw.prepare('SELECT deleted_at FROM manuscripts WHERE id = ?').get(doc.parsed.manuscriptId)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Node pool
// ---------------------------------------------------------------------------

describe('pool tools', () => {
  it('creates a card whose JSON body matches what the canvas would receive', async () => {
    const { client } = await connect()
    const created = await call(client, 'poolCreate', {
      title: '卖点',
      text: '轻量\n本地存储',
      tags: '产品,文案',
    })

    expect(created.isError).toBeFalsy()
    const row = t.raw.prepare('SELECT content, name, tags FROM node_cards WHERE id = ?').get(created.parsed.cardId) as any
    const body = JSON.parse(row.content)
    expect(body.title).toBe('卖点')
    expect(body.content).toContain('轻量')
    expect(row.name).toBe('卖点')
    expect(row.tags).toBe('产品,文案')
    // 卡片必须是一个**完整节点**：缺 color 时画布按 node.color 上色，结果是全透明卡片
    // （用户看到的就是"半透明"）。这几个字段是拖回画布时的渲染前提。
    expect(body.color).toBe('#ffffff')
    expect(body.width).toBe(200)
    expect(body.fontSize).toBe(14)
    expect(body.textAlign).toBe('left')
    expect(body.collapsed).toBe(false)
  })

  it('enforces the 5000-character card cap', async () => {
    const { client } = await connect()
    const res = await call(client, 'poolCreate', { title: 'huge', text: 'x'.repeat(6000) })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('E_LIMIT')
  })

  it('searches by name, body and tags', async () => {
    const { client } = await connect()
    await call(client, 'poolCreate', { title: 'Alpha', text: 'one', tags: 'red' })
    await call(client, 'poolCreate', { title: 'Beta', text: 'two', tags: 'blue' })

    expect((await call(client, 'poolList', { q: 'alpha' })).parsed.total).toBe(1)
    expect((await call(client, 'poolList', { q: 'two' })).parsed.total).toBe(1)
    expect((await call(client, 'poolList', { tag: 'blue' })).parsed.total).toBe(1)
  })

  it('updates a card and keeps the serialized body in sync with the title', async () => {
    const { client } = await connect()
    const created = await call(client, 'poolCreate', { title: 'old', text: 'body' })
    const updated = await call(client, 'poolUpdate', {
      cardId: created.parsed.cardId,
      title: 'new',
      text: 'body2',
    })

    expect(updated.isError).toBeFalsy()
    expect(updated.parsed.name).toBe('new')
    expect(updated.parsed.contentHtml).toContain('body2')
  })

  it('physically deletes a card', async () => {
    const { client } = await connect()
    const created = await call(client, 'poolCreate', { title: 'gone', text: 'x' })
    await call(client, 'poolDelete', { cardId: created.parsed.cardId })
    expect(t.raw.prepare('SELECT COUNT(*) AS c FROM node_cards').get() as any).toEqual({ c: 0 })
    expect((await call(client, 'poolGet', { cardId: created.parsed.cardId })).isError).toBe(true)
  })

  it('deletes folder subtrees and every card inside them, with confirm', async () => {
    const { client } = await connect()
    const folder = await call(client, 'poolFolderCreate', { name: 'F' })
    await call(client, 'poolCreate', { title: 'c1', text: 'x', folderId: folder.parsed.folderId })

    const refused = await call(client, 'poolFolderDelete', { folderId: folder.parsed.folderId })
    expect(refused.text).toContain('E_VALIDATION')

    const done = await call(client, 'poolFolderDelete', {
      folderId: folder.parsed.folderId,
      confirm: true,
    })
    expect(done.parsed.deletedCards).toBe(1)
    expect(t.raw.prepare('SELECT COUNT(*) AS c FROM node_cards').get() as any).toEqual({ c: 0 })
  })
})

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

describe('transfer tools', () => {
  it('moves a manuscript into the pool (source disappears)', async () => {
    const { client } = await connect()
    const doc = await call(client, 'notebookCreate', { title: '稿', text: '正文' })

    const moved = await call(client, 'transferManuscriptToCard', { manuscriptId: doc.parsed.manuscriptId })
    expect(moved.isError).toBeFalsy()
    expect(moved.parsed.card.cardId).toBeGreaterThan(0)
    expect((await call(client, 'notebookGet', { manuscriptId: doc.parsed.manuscriptId })).isError).toBe(true)
    expect((await call(client, 'poolList', {})).parsed.total).toBe(1)
  })

  it('moves a card into the notebook (card disappears)', async () => {
    const { client } = await connect()
    const card = await call(client, 'poolCreate', { title: '卡', text: '正文' })

    const moved = await call(client, 'transferCardToManuscript', { cardId: card.parsed.cardId })
    expect(moved.isError).toBeFalsy()
    expect(moved.parsed.manuscript.title).toBe('卡')
    expect((await call(client, 'poolList', {})).parsed.total).toBe(0)
    expect((await call(client, 'notebookList', {})).parsed.total).toBe(1)
  })

  it('fails a move atomically: a bad target folder leaves the manuscript alone', async () => {
    const { client } = await connect()
    const doc = await call(client, 'notebookCreate', { title: '稿', text: '正文' })

    const failed = await call(client, 'transferManuscriptToCard', {
      manuscriptId: doc.parsed.manuscriptId,
      folderId: 99999,
    })
    expect(failed.isError).toBe(true)
    expect((await call(client, 'notebookGet', { manuscriptId: doc.parsed.manuscriptId })).isError).toBeFalsy()
    expect((await call(client, 'poolList', {})).parsed.total).toBe(0)
  })

  it('moves a card onto a canvas and removes it from the pool', async () => {
    const { client } = await connect()
    const card = await call(client, 'poolCreate', { title: '可复用', text: 'x' })

    const moved = await call(client, 'moveCardToCanvas', {
      canvasId,
      cardId: card.parsed.cardId,
      x: 40,
      y: 60,
    })
    expect(moved.isError).toBeFalsy()
    expect(moved.parsed.moved).toBe('card-to-canvas')

    const nodes = await call(client, 'getAllNodes', { canvasId })
    expect(nodes.parsed.count).toBe(1)
    expect(nodes.parsed.nodes[0].x).toBe(40)
    expect(nodes.parsed.nodes[0].title).toBe('可复用')

    // MOVE semantics — identical to dragging the card onto a canvas in the UI.
    expect((await call(client, 'poolList', {})).parsed.total).toBe(0)
    const gone = await call(client, 'poolGet', { cardId: card.parsed.cardId })
    expect(gone.isError).toBe(true)
    expect(gone.text).toContain('E_NOT_FOUND')
  })

  it('moves a canvas node into the pool, removing the node and its connections', async () => {
    const { client } = await connect()
    const a = await call(client, 'createNode', { canvasId, title: 'A' })
    const b = await call(client, 'createNode', { canvasId, title: 'B' })
    await call(client, 'createConnection', {
      canvasId,
      fromNodeId: a.parsed.nodeId,
      toNodeId: b.parsed.nodeId,
    })

    const moved = await call(client, 'transferNodeToCard', { canvasId, nodeId: a.parsed.nodeId })
    expect(moved.isError).toBeFalsy()
    expect(moved.parsed.removedConnectionIds).toHaveLength(1)

    const nodes = await call(client, 'getAllNodes', { canvasId })
    expect(nodes.parsed.count).toBe(1)
    expect(nodes.parsed.nodes[0].title).toBe('B')
    const conns = await call(client, 'getAllConnections', { canvasId })
    expect(conns.parsed.count).toBe(0)
    expect((await call(client, 'poolList', {})).parsed.total).toBe(1)
  })

  it('refuses node→card for a viewer without touching the canvas', async () => {
    const { client } = await connect(ownerId)
    const node = await call(client, 'createNode', { canvasId, title: 'A' })

    const viewer = await connect(viewerId)
    const denied = await call(viewer.client, 'transferNodeToCard', { canvasId, nodeId: node.parsed.nodeId })
    expect(denied.isError).toBe(true)
    expect(denied.text).toContain('E_FORBIDDEN')
    expect((await call(client, 'getAllNodes', { canvasId })).parsed.count).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Canvas lifecycle
// ---------------------------------------------------------------------------

describe('canvas lifecycle tools', () => {
  it('creates, renames, moves and deletes a canvas', async () => {
    const { client } = await connect()
    const created = await call(client, 'canvasCreate', { projectId, name: '新画布' })
    expect(created.isError).toBeFalsy()
    const id = created.parsed.canvasId

    const renamed = await call(client, 'canvasRename', { canvasId: id, name: '改名后' })
    expect(renamed.parsed.name).toBe('改名后')

    const folder = await call(client, 'canvasFolderCreate', { projectId, name: 'F' })
    const moved = await call(client, 'canvasMove', { canvasId: id, folderId: folder.parsed.folderId })
    expect(moved.parsed.folderId).toBe(folder.parsed.folderId)

    const refused = await call(client, 'canvasDelete', { canvasId: id })
    expect(refused.text).toContain('E_VALIDATION')

    const deleted = await call(client, 'canvasDelete', { canvasId: id, confirm: true })
    expect(deleted.isError).toBeFalsy()
    const listed = await call(client, 'listCanvases', {})
    expect(listed.parsed.canvases.some((c: any) => c.canvasId === id)).toBe(false)
  })

  it('refuses canvas creation for a viewer of the project', async () => {
    const viewer = await connect(viewerId)
    const res = await call(viewer.client, 'canvasCreate', { projectId, name: 'nope' })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('E_FORBIDDEN')
  })

  it('deletes a canvas folder subtree and reports how many canvases went with it', async () => {
    const { client } = await connect()
    const folder = await call(client, 'canvasFolderCreate', { projectId, name: '整组' })
    const a = await call(client, 'canvasCreate', {
      projectId,
      name: 'a',
      folderId: folder.parsed.folderId,
    })
    const child = await call(client, 'canvasFolderCreate', {
      projectId,
      name: '子',
      parentId: folder.parsed.folderId,
    })
    await call(client, 'canvasCreate', { projectId, name: 'b', folderId: child.parsed.folderId })

    const listed = await call(client, 'canvasFolderList', { projectId })
    expect(listed.parsed.folders.find((f: any) => f.folderId === folder.parsed.folderId).canvasCount).toBe(1)

    const done = await call(client, 'canvasFolderDelete', {
      folderId: folder.parsed.folderId,
      confirm: true,
    })
    expect(done.isError).toBeFalsy()
    expect(done.parsed.deletedFolders).toBe(2)
    expect(done.parsed.deletedCanvases).toBe(2)
    const remaining = await call(client, 'listCanvases', {})
    expect(remaining.parsed.canvases.some((c: any) => c.canvasId === a.parsed.canvasId)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Session info
// ---------------------------------------------------------------------------

describe('sessionInfo', () => {
  it('summarises the account, its projects and its content counts', async () => {
    const { client } = await connect()
    await call(client, 'notebookCreate', { text: 'x' })
    await call(client, 'poolCreate', { title: 'c', text: 'y' })

    const info = await call(client, 'sessionInfo', {})
    expect(info.isError).toBeFalsy()
    expect(info.parsed.account.userId).toBe(ownerId)
    expect(info.parsed.counts.projects).toBe(1)
    expect(info.parsed.counts.canvases).toBe(1)
    expect(info.parsed.counts.manuscripts).toBe(1)
    expect(info.parsed.counts.poolCards).toBe(1)
    expect(info.parsed.projects[0].role).toBe('owner')
    expect(info.parsed.errorContract.codes).toContain('E_CONFLICT')
  })
})
