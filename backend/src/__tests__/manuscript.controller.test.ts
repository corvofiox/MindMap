/**
 * 笔记本 API —— 手稿 CRUD、账号隔离、以及与节点池的双向转换。
 *
 * 这里钉的是三条容易悄悄坏掉的契约：
 *   1. 隔离：别人的手稿在我这里必须 404（不是 403，不泄露存在性）；
 *   2. 转换是抄送：手稿 → 卡片只复制内容 + 记录来源，之后各改各的；
 *   3. 统一节点：卡片里存的必须是 {title, content, cover}，不再有 type/imageUrl。
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import express from 'express'
import cookieParser from 'cookie-parser'

vi.mock('../utils/logger.js', () => ({ log: vi.fn(), logError: vi.fn() }))

vi.mock('../database/connection.js', async () => {
  const { installDbMock } = await import('./helpers/integration-harness.js')
  return installDbMock()
})

// authenticate 走 getValidatedEnv()，它要求 PORT/WS_PORT/DB_FILE/ALLOWED_ORIGINS/
// NODE_ENV 齐全，缺一个就会在鉴权里抛错并被兜成 401（看起来像令牌无效）。
process.env.JWT_SECRET = process.env.JWT_SECRET || 'manuscript-test-jwt-secret'
process.env.JWT_EXPIRES_IN = '1h'
process.env.PORT = '3098'
process.env.WS_PORT = '3198'
process.env.DB_FILE = ':memory:'
process.env.ALLOWED_ORIGINS = 'http://localhost:5173'
process.env.NODE_ENV = 'test'

const {
  manuscriptRouter,
  manuscriptFolderRouter,
  manuscriptToCardPayload,
  cardToManuscriptPayload,
} = await import('../controllers/manuscript.controller.js')
const { createTestDatabase, seedUser, signToken } = await import('./helpers/integration-harness.js')

let app: express.Express
let tokenA: string
let tokenB: string
let userA: number
let testDb: ReturnType<typeof createTestDatabase>

beforeAll(() => {
  testDb = createTestDatabase()
  userA = seedUser(testDb.raw, 'a@nb.com', 'hash', 'A')
  const userB = seedUser(testDb.raw, 'b@nb.com', 'hash', 'B')
  tokenA = signToken(userA)
  tokenB = signToken(userB)

  const mounted = express()
  mounted.use(cookieParser())
  mounted.use(express.json({ limit: '20mb' }))
  mounted.use('/api/manuscripts', manuscriptRouter)
  mounted.use('/api/manuscript-folders', manuscriptFolderRouter)
  mounted.use(
    (err: { statusCode?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(err.statusCode || 500).json({ success: false, error: err.message || 'error' })
    },
  )
  app = mounted
})

beforeEach(() => {
  testDb.raw.exec('DELETE FROM manuscripts')
  testDb.raw.exec('DELETE FROM node_cards')
})

const authA = () => ({ Authorization: `Bearer ${tokenA}` })
const authB = () => ({ Authorization: `Bearer ${tokenB}` })

async function createManuscript(overrides: Record<string, unknown> = {}) {
  const res = await supertest(app)
    .post('/api/manuscripts')
    .set(authA())
    .send({ title: '周记', contentHtml: '<p>今天写了点东西</p>', ...overrides })
  return res
}

describe('manuscripts CRUD', () => {
  it('新建后能按 id 读回，列表里也有', async () => {
    const created = await createManuscript()
    expect(created.status).toBe(201)

    const id = created.body.data.id
    const one = await supertest(app).get(`/api/manuscripts/${id}`).set(authA())
    expect(one.status).toBe(200)
    expect(one.body.data.title).toBe('周记')

    const list = await supertest(app).get('/api/manuscripts').set(authA())
    expect(list.status).toBe(200)
    expect(list.body.data.map((m: { id: number }) => m.id)).toContain(id)
  })

  it('保存会刷新 previewText / imageCount / updatedAt', async () => {
    const created = await createManuscript()
    const id = created.body.data.id

    await supertest(app)
      .put(`/api/manuscripts/${id}`)
      .set(authA())
      .send({ contentHtml: '<p>改了</p><img src="/api/files/' + 'a'.repeat(64) + '">' })

    const one = await supertest(app).get(`/api/manuscripts/${id}`).set(authA())
    expect(one.body.data.previewText).toContain('改了')
    expect(one.body.data.imageCount).toBe(1)
  })

  it('删除是软删除：列表与详情都拿不到，但行还在', async () => {
    const created = await createManuscript()
    const id = created.body.data.id

    await supertest(app).delete(`/api/manuscripts/${id}`).set(authA())

    expect((await supertest(app).get(`/api/manuscripts/${id}`).set(authA())).status).toBe(404)
    const list = await supertest(app).get('/api/manuscripts').set(authA())
    expect(list.body.data.map((m: { id: number }) => m.id)).not.toContain(id)
    const row = testDb.raw.prepare('SELECT deleted_at FROM manuscripts WHERE id = ?').get(id) as {
      deleted_at: number | null
    }
    expect(row.deleted_at).not.toBeNull()
  })

  it('按标题/正文搜索', async () => {
    await createManuscript({ title: '苹果笔记', contentHtml: '<p>关于苹果</p>' })
    await createManuscript({ title: '香蕉笔记', contentHtml: '<p>关于香蕉</p>' })

    const res = await supertest(app).get('/api/manuscripts?q=香蕉').set(authA())

    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].title).toBe('香蕉笔记')
  })

  it('拖拽排序：批量写 sortOrder 后列表按手排顺序返回', async () => {
    const c = await createManuscript({ title: 'C' })
    const a = await createManuscript({ title: 'A' })
    const b = await createManuscript({ title: 'B' })

    // 想把顺序排成 A、B、C
    const res = await supertest(app)
      .put('/api/manuscripts/reorder')
      .set(authA())
      .send({
        updates: [
          { id: a.body.data.id, sortOrder: 0 },
          { id: b.body.data.id, sortOrder: 10 },
          { id: c.body.data.id, sortOrder: 20 },
        ],
      })

    expect(res.status).toBe(200)
    expect(res.body.data.updated).toHaveLength(3)

    const list = await supertest(app).get('/api/manuscripts').set(authA())
    expect(list.body.data.map((m: { title: string }) => m.title)).toEqual(['A', 'B', 'C'])
  })

  it('拖拽排序：别人的手稿不会被改动', async () => {
    const theirs = await supertest(app)
      .post('/api/manuscripts')
      .set(authB())
      .send({ title: '别人的稿', contentHtml: '<p>x</p>' })
    const mine = await createManuscript({ title: '我的稿' })

    const res = await supertest(app)
      .put('/api/manuscripts/reorder')
      .set(authA())
      .send({
        updates: [
          { id: theirs.body.data.id, sortOrder: 99 },
          { id: mine.body.data.id, sortOrder: 5 },
        ],
      })

    expect(res.status).toBe(200)
    // 只改到自己的那一篇
    expect(res.body.data.updated).toEqual([mine.body.data.id])

    const theirsAfter = await supertest(app)
      .get(`/api/manuscripts/${theirs.body.data.id}`)
      .set(authB())
    expect(theirsAfter.body.data.sortOrder).toBe(0)
  })

  it('拖拽排序：缺数据或全是非法 id 时返回 400 / 空更新', async () => {
    expect((await supertest(app).put('/api/manuscripts/reorder').set(authA()).send({})).status).toBe(400)
    expect(
      (await supertest(app).put('/api/manuscripts/reorder').set(authA()).send({ updates: [] })).status,
    ).toBe(400)

    const res = await supertest(app)
      .put('/api/manuscripts/reorder')
      .set(authA())
      .send({ updates: [{ id: 'x', sortOrder: 'y' }] })
    expect(res.status).toBe(200)
    expect(res.body.data.updated).toEqual([])
  })

  it('拖拽排序：未登录 401', async () => {
    const res = await supertest(app)
      .put('/api/manuscripts/reorder')
      .send({ updates: [{ id: 1, sortOrder: 0 }] })
    expect(res.status).toBe(401)
  })

  it('隔离：别人的手稿在读取/保存/删除/转换上都返回 404', async () => {    const created = await createManuscript()
    const id = created.body.data.id

    expect((await supertest(app).get(`/api/manuscripts/${id}`).set(authB())).status).toBe(404)
    expect(
      (await supertest(app).put(`/api/manuscripts/${id}`).set(authB()).send({ title: 'x' })).status,
    ).toBe(404)
    expect((await supertest(app).delete(`/api/manuscripts/${id}`).set(authB())).status).toBe(404)
    expect(
      (await supertest(app).post(`/api/manuscripts/${id}/to-node-card`).set(authB()).send({})).status,
    ).toBe(404)

    const listB = await supertest(app).get('/api/manuscripts').set(authB())
    expect(listB.body.data).toHaveLength(0)
  })

  it('未登录一律 401', async () => {
    expect((await supertest(app).get('/api/manuscripts')).status).toBe(401)
    expect((await supertest(app).post('/api/manuscripts').send({ title: 'x' })).status).toBe(401)
  })
})

describe('手稿 → 节点池', () => {
  it('生成卡片：正文原样搬过去，首图作 thumbnail，并记录来源', async () => {
    const sha = 'b'.repeat(64)
    const created = await createManuscript({
      title: '带图手稿',
      contentHtml: `<p>正文</p><img src="/api/files/${sha}">`,
    })
    const id = created.body.data.id

    const res = await supertest(app).post(`/api/manuscripts/${id}/to-node-card`).set(authA()).send({})

    expect(res.status).toBe(201)
    const card = res.body.data
    expect(card.sourceManuscriptId).toBe(id)
    expect(card.sourceKind).toBe('manuscript')
    expect(card.type).toBe('image')
    expect(card.thumbnail).toBe(`/api/files/${sha}`)

    const payload = JSON.parse(card.content)
    expect(payload.content).toContain('<p>正文</p>')
    expect(payload.content).toContain(`/api/files/${sha}`)
    expect(payload.cover).toBe(`/api/files/${sha}`)
    expect(payload.type).toBeUndefined()
    expect(payload.imageUrl).toBeUndefined()
  })

  it('纯文字手稿 → 卡片 type 为 text', async () => {
    const created = await createManuscript({ title: '纯文字', contentHtml: '<p>只有字</p>' })
    const res = await supertest(app)
      .post(`/api/manuscripts/${created.body.data.id}/to-node-card`)
      .set(authA())
      .send({})

    expect(res.body.data.type).toBe('text')
    // 无图卡片 thumbnail 落库为 NULL（drizzle 返回 null），不是 undefined
    expect(res.body.data.thumbnail).toBeNull()
  })

  it('转换是抄送：改手稿不会改已生成的卡片', async () => {
    const created = await createManuscript({ title: '原稿', contentHtml: '<p>第一版</p>' })
    const id = created.body.data.id
    const card = (await supertest(app).post(`/api/manuscripts/${id}/to-node-card`).set(authA()).send({}))
      .body.data

    await supertest(app).put(`/api/manuscripts/${id}`).set(authA()).send({ contentHtml: '<p>第二版</p>' })

    const row = testDb.raw.prepare('SELECT content FROM node_cards WHERE id = ?').get(card.id) as {
      content: string
    }
    expect(row.content).toContain('第一版')
    expect(row.content).not.toContain('第二版')
  })
})

describe('节点池 → 手稿', () => {
  function insertCard(content: string, name = '卡片') {
    const info = testDb.raw
      .prepare(`INSERT INTO node_cards (user_id, name, content, type) VALUES (?, ?, ?, 'text')`)
      .run(userA, name, content)
    return Number(info.lastInsertRowid)
  }

  it('从统一形态卡片还原手稿', async () => {
    const cardId = insertCard(JSON.stringify({ title: '卡片标题', content: '<p>卡片正文</p>' }))

    const res = await supertest(app).post('/api/manuscripts/from-card').set(authA()).send({ cardId })

    expect(res.status).toBe(201)
    expect(res.body.data.title).toBe('卡片标题')
    expect(res.body.data.contentHtml).toBe('<p>卡片正文</p>')
    expect(res.body.data.sourceCardId).toBe(cardId)
  })

  it('老图片卡片（type/imageUrl）也能还原：图折进正文', async () => {
    const sha = 'c'.repeat(64)
    const cardId = insertCard(
      JSON.stringify({ type: 'image', title: '老卡', imageUrl: `/api/files/${sha}` }),
    )

    const res = await supertest(app).post('/api/manuscripts/from-card').set(authA()).send({ cardId })

    expect(res.body.data.contentHtml).toContain(`/api/files/${sha}`)
    expect(res.body.data.imageCount).toBe(1)
  })

  it('别人的卡片不能还原（404）', async () => {
    const cardId = insertCard(JSON.stringify({ title: 'T', content: 'x' }))
    const res = await supertest(app).post('/api/manuscripts/from-card').set(authB()).send({ cardId })
    expect(res.status).toBe(404)
  })
})

describe('转换纯函数', () => {
  it('manuscriptToCardPayload：无标题时用正文首段兜底', () => {
    const payload = manuscriptToCardPayload(
      { id: 1, title: '   ', contentHtml: '<p>第一段文字</p>', userId: 7 },
      null,
    )
    const parsed = JSON.parse(payload.content)
    expect(payload.name).toBe('第一段文字')
    expect(parsed.title).toBe('   ')
    expect(payload.type).toBe('text')
  })

  it('cardToManuscriptPayload：坏 JSON 不抛错，整串当正文', () => {
    const payload = cardToManuscriptPayload({
      id: 9,
      userId: 1,
      name: '坏卡',
      content: 'not json at all',
    })
    expect(payload.title).toBe('坏卡')
    expect(payload.contentHtml).toBe('not json at all')
    expect(payload.sourceCardId).toBe(9)
  })
})

describe('手稿文件夹', () => {
  it('建/列/删，且不跨账号', async () => {
    const created = await supertest(app)
      .post('/api/manuscript-folders')
      .set(authA())
      .send({ name: '灵感' })
    expect(created.status).toBe(201)

    const list = await supertest(app).get('/api/manuscript-folders').set(authA())
    expect(list.body.data.map((f: { name: string }) => f.name)).toContain('灵感')

    const listB = await supertest(app).get('/api/manuscript-folders').set(authB())
    expect(listB.body.data).toHaveLength(0)

    const id = created.body.data.id
    expect(
      (await supertest(app).delete(`/api/manuscript-folders/${id}`).set(authB())).status,
    ).toBe(404)
    expect(
      (await supertest(app).delete(`/api/manuscript-folders/${id}`).set(authA())).status,
    ).toBe(200)
  })

  it('空名字被拒绝', async () => {
    const res = await supertest(app).post('/api/manuscript-folders').set(authA()).send({ name: '   ' })
    expect(res.status).toBe(400)
  })

  it('可以改名与记住折叠状态', async () => {
    const created = await supertest(app).post('/api/manuscript-folders').set(authA()).send({ name: '灵感' })
    const id = created.body.data.id

    const renamed = await supertest(app)
      .put(`/api/manuscript-folders/${id}`)
      .set(authA())
      .send({ name: '灵感库', collapsed: true })
    expect(renamed.status).toBe(200)

    const list = await supertest(app).get('/api/manuscript-folders').set(authA())
    const row = list.body.data.find((f: { id: number }) => f.id === id)
    expect(row.name).toBe('灵感库')
    expect(row.collapsed).toBe(true)

    // 改名同样要挡空名字，且不能跨账号改
    expect(
      (await supertest(app).put(`/api/manuscript-folders/${id}`).set(authA()).send({ name: '  ' })).status,
    ).toBe(400)
    expect(
      (await supertest(app).put(`/api/manuscript-folders/${id}`).set(authB()).send({ name: '抢' })).status,
    ).toBe(404)
  })

  it('新建手稿时目标文件夹必须是自己且存在', async () => {
    const mine = await supertest(app).post('/api/manuscript-folders').set(authA()).send({ name: '我的' })
    const myFolderId = mine.body.data.id
    const theirs = await supertest(app).post('/api/manuscript-folders').set(authB()).send({ name: '别人的' })
    const theirFolderId = theirs.body.data.id

    expect((await createManuscript({ folderId: 999999 })).status).toBe(404)
    expect((await createManuscript({ folderId: theirFolderId })).status).toBe(404)

    const ok = await createManuscript({ folderId: myFolderId })
    expect(ok.status).toBe(201)
    expect(ok.body.data.folderId).toBe(myFolderId)
  })

  it('移动手稿到别人的文件夹被拒绝，移到 null 表示未归档', async () => {
    const mine = await supertest(app).post('/api/manuscript-folders').set(authA()).send({ name: '我的' })
    const theirs = await supertest(app).post('/api/manuscript-folders').set(authB()).send({ name: '别人的' })
    const id = (await createManuscript()).body.data.id

    expect(
      (await supertest(app).put(`/api/manuscripts/${id}`).set(authA()).send({ folderId: theirs.body.data.id }))
        .status,
    ).toBe(404)

    const moved = await supertest(app).put(`/api/manuscripts/${id}`).set(authA()).send({ folderId: mine.body.data.id })
    expect(moved.body.data.folderId).toBe(mine.body.data.id)

    const unfiled = await supertest(app).put(`/api/manuscripts/${id}`).set(authA()).send({ folderId: null })
    expect(unfiled.body.data.folderId).toBeNull()
  })

  it('删除文件夹连带子文件夹与里面的手稿；旁系不受影响（手稿是软删除：行还在、接口拿不到）', async () => {
    const root = await supertest(app).post('/api/manuscript-folders').set(authA()).send({ name: '项目' })
    const rootId = root.body.data.id
    const mid = await supertest(app)
      .post('/api/manuscript-folders')
      .set(authA())
      .send({ name: '技术', parentId: rootId })
    const midId = mid.body.data.id
    const leaf = await supertest(app)
      .post('/api/manuscript-folders')
      .set(authA())
      .send({ name: '配色', parentId: midId })
    const leafId = leaf.body.data.id
    // 另一棵树，确认不会被误删
    const other = await supertest(app).post('/api/manuscript-folders').set(authA()).send({ name: '素材' })
    const otherId = other.body.data.id

    const inRoot = await createManuscript({ title: '在 root', folderId: rootId })
    const inLeaf = await createManuscript({ title: '在 leaf', folderId: leafId })
    const inOther = await createManuscript({ title: '在别的树', folderId: otherId })

    const deleted = await supertest(app).delete(`/api/manuscript-folders/${rootId}`).set(authA())
    expect(deleted.status).toBe(200)
    expect(deleted.body.data.deletedManuscripts).toBe(2)

    const ids = ((await supertest(app).get('/api/manuscript-folders').set(authA())).body.data as Array<{
      id: number
    }>).map((f) => f.id)
    // 整棵子树（父 + 子 + 孙）一起没了，别的树不受影响
    expect(ids).not.toContain(rootId)
    expect(ids).not.toContain(midId)
    expect(ids).not.toContain(leafId)
    expect(ids).toContain(otherId)

    // 子树里的手稿跟着删：列表里看不到、按 id 也打不开
    const list = (await supertest(app).get('/api/manuscripts').set(authA())).body.data as Array<{ id: number }>
    expect(list.map((m) => m.id)).not.toContain(inRoot.body.data.id)
    expect(list.map((m) => m.id)).not.toContain(inLeaf.body.data.id)
    expect((await supertest(app).get(`/api/manuscripts/${inLeaf.body.data.id}`).set(authA())).status).toBe(404)

    // 但行还在（软删除），且别的树里的手稿完好
    expect(
      testDb.raw.prepare('SELECT deleted_at FROM manuscripts WHERE id = ?').get(inLeaf.body.data.id) as {
        deleted_at: number | null
      },
    ).toMatchObject({ deleted_at: expect.any(Number) })
    expect((await supertest(app).get(`/api/manuscripts/${inOther.body.data.id}`).set(authA())).status).toBe(200)
  })

  /**
   * 文件夹拖拽排序：PUT 必须真的认 sortOrder。
   *
   * 这一条是回归防线——之前这个 PUT 只处理 name/collapsed，前端把 sortOrder
   * 发过来会被静默丢掉：界面看起来变了，刷新就打回原样。
   */
  it('PUT 能写 sortOrder，列表按它升序返回', async () => {
    const a = await supertest(app).post('/api/manuscript-folders').set(authA()).send({ name: '甲' })
    const b = await supertest(app).post('/api/manuscript-folders').set(authA()).send({ name: '乙' })
    const idA = a.body.data.id
    const idB = b.body.data.id

    // 甲拖到乙后面：乙 100、甲 200（用大值避开别的用例留下的 0）
    expect((await supertest(app).put(`/api/manuscript-folders/${idA}`).set(authA()).send({ sortOrder: 200 })).status).toBe(200)
    expect((await supertest(app).put(`/api/manuscript-folders/${idB}`).set(authA()).send({ sortOrder: 100 })).status).toBe(200)

    const list = (await supertest(app).get('/api/manuscript-folders').set(authA())).body.data as Array<{
      id: number
      sortOrder: number
    }>
    // 只看本次这两条：库里还有别的用例留下的文件夹
    const mine = list.filter((f) => f.id === idA || f.id === idB)
    expect(mine.map((f) => f.id)).toEqual([idB, idA])
    expect(mine.find((f) => f.id === idA)?.sortOrder).toBe(200)
  })

  it('PUT 的 sortOrder 拒绝非数字（不能把 sort_order 写坏）', async () => {
    const created = await supertest(app).post('/api/manuscript-folders').set(authA()).send({ name: '甲' })
    const id = created.body.data.id

    expect((await supertest(app).put(`/api/manuscript-folders/${id}`).set(authA()).send({ sortOrder: 'abc' })).status).toBe(400)
    expect((await supertest(app).put(`/api/manuscript-folders/${id}`).set(authA()).send({ sortOrder: Infinity })).status).toBe(400)

    // 失败之后原值不能被改动
    const list = (await supertest(app).get('/api/manuscript-folders').set(authA())).body.data as Array<{
      id: number
      sortOrder: number
    }>
    expect(list.find((f) => f.id === id)?.sortOrder).toBe(0)
  })

  it('PUT 的 sortOrder 不能跨账号写别人的文件夹', async () => {
    const mine = await supertest(app).post('/api/manuscript-folders').set(authA()).send({ name: '我的' })
    const id = mine.body.data.id

    expect((await supertest(app).put(`/api/manuscript-folders/${id}`).set(authB()).send({ sortOrder: 99 })).status).toBe(404)
  })
})
