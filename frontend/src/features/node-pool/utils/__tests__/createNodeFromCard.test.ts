/**
 * createNodeFromCard / parseCardNodeData 真实行为测试
 *
 * 覆盖:
 *  - 卡片 JSON 内容 → Node 字段映射(标题/内容/类型/图片/几何/样式)
 *  - 可选字段缺失时的默认值(width 200 / height 120 / fontSize 14 / textAlign left)
 *  - 畸形内容(JSON 解析失败)回退为文本节点
 *  - 空内容 / 'null' / 非对象 JSON 的边界行为
 *  - id 每次调用唯一(同一卡片可重复取出)且内容中的 id 不能污染节点 id
 *  - x/y 由调用方位置决定,内容里的 x/y 被忽略
 *  - 产出的对象满足 Node 类型契约(几何字段为有限数字)
 */
import { describe, it, expect } from 'vitest'
import { createNodeFromCard, parseCardNodeData } from '../createNodeFromCard'
import type { Node, NodeCard } from '@/types'

function makeCard(overrides: Partial<NodeCard> = {}): NodeCard {
  return {
    id: 1,
    userId: 1,
    name: '默认卡片',
    content: '{"title":"内容标题","content":"内容正文"}',
    type: 'text',
    color: '#ffffff',
    tags: null,
    useCount: 0,
    createdBy: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    folderId: null,
    description: null,
    thumbnail: null,
    sortOrder: 0,
    ...overrides,
  }
}

describe('parseCardNodeData', () => {
  it('合法 JSON 内容:原样解析为 Partial<Node>,字段逐一对应', () => {
    const card = makeCard({
      content: JSON.stringify({
        title: 'T',
        content: 'C',
        type: 'text',
        width: 300,
        height: 80,
        color: '#eee',
        fontSize: 20,
        textAlign: 'center',
      }),
    })

    const parsed = parseCardNodeData(card)

    expect(parsed.title).toBe('T')
    expect(parsed.content).toBe('C')
    expect(parsed.type).toBe('text')
    expect(parsed.width).toBe(300)
    expect(parsed.height).toBe(80)
    expect(parsed.color).toBe('#eee')
    expect(parsed.fontSize).toBe(20)
    expect(parsed.textAlign).toBe('center')
  })

  it('畸形 JSON 内容:回退为文本节点(标题取卡片名,保留原始内容)', () => {
    const card = makeCard({ name: '回退卡', content: '{不是合法 JSON' })

    expect(parseCardNodeData(card)).toEqual({
      type: 'text',
      title: '回退卡',
      content: '{不是合法 JSON',
      imageUrl: null,
      width: 200,
      height: 120,
    })
  })

  it('空字符串内容:JSON.parse("") 抛错 → 标题用卡片名,内容为空串', () => {
    const card = makeCard({ name: '名字', content: '' })

    const parsed = parseCardNodeData(card)

    expect(parsed.type).toBe('text')
    expect(parsed.title).toBe('名字')
    expect(parsed.content).toBe('')
    expect(parsed.imageUrl).toBeNull()
  })

  it('卡片名与内容都为空:回退标题为 "未知节点"', () => {
    const card = makeCard({ name: '', content: '' })

    expect(parseCardNodeData(card).title).toBe('未知节点')
  })

  it("内容 'null' 解析出 null(合法 JSON),不抛错", () => {
    expect(parseCardNodeData(makeCard({ content: 'null' }))).toBeNull()
  })

  it('解析不修改入参卡片对象', () => {
    const card = makeCard({ content: '{"title":"X"}' })
    const snapshot = { ...card }

    parseCardNodeData(card)

    expect(card).toEqual(snapshot)
  })
})

describe('createNodeFromCard', () => {
  const POS = { x: 37, y: -91 }

  it('位置来自调用方参数(精确值)', () => {
    const node = createNodeFromCard(makeCard(), POS)

    expect(node.x).toBe(37)
    expect(node.y).toBe(-91)
  })

  it('内容里的 x/y 被忽略,不允许覆盖投放位置', () => {
    const card = makeCard({ content: '{"x":5,"y":6,"title":"T"}' })

    const node = createNodeFromCard(card, { x: 100, y: 200 })

    expect(node.x).toBe(100)
    expect(node.y).toBe(200)
  })

  it('合法 JSON 内容:字段映射进节点', () => {
    const card = makeCard({
      content: JSON.stringify({
        title: '映射标题',
        content: '映射内容',
        type: 'text',
        width: 250,
        height: 90,
        fontSize: 18,
        textAlign: 'right',
        collapsed: true,
        locked: true,
        color: '#123456',
      }),
    })

    const node = createNodeFromCard(card, POS)

    expect(node.title).toBe('映射标题')
    expect(node.content).toBe('映射内容')
    expect(node.type).toBe('text')
    expect(node.width).toBe(250)
    expect(node.height).toBe(90)
    expect(node.fontSize).toBe(18)
    expect(node.textAlign).toBe('right')
    expect(node.collapsed).toBe(true)
    expect(node.locked).toBe(true)
    expect(node.color).toBe('#123456')
  })

  it('图片卡:content 中 type=image 与 imageUrl 原样带入节点', () => {
    const card = makeCard({
      type: 'image',
      content: JSON.stringify({
        type: 'image',
        title: '图',
        imageUrl: 'https://example.com/a.png',
        aspectRatio: 1.5,
        width: 320,
        height: 200,
      }),
    })

    const node = createNodeFromCard(card, POS)

    expect(node.type).toBe('image')
    expect(node.imageUrl).toBe('https://example.com/a.png')
    expect(node.aspectRatio).toBe(1.5)
    expect(node.width).toBe(320)
    expect(node.height).toBe(200)
  })

  it("内容 '{}' 时全部可选字段取默认值", () => {
    const node = createNodeFromCard(makeCard({ content: '{}' }), POS)

    expect(node.width).toBe(200)
    expect(node.height).toBe(120)
    expect(node.title).toBe('')
    expect(node.content).toBe('')
    expect(node.fontSize).toBe(14)
    expect(node.textAlign).toBe('left')
    expect(node.collapsed).toBe(false)
    expect(node.locked).toBe(false)
    expect(node.type).toBeUndefined()
  })

  it('畸形内容走回退路径:标题取卡片名,几何取回退值', () => {
    const card = makeCard({ name: '烂内容', content: 'plain text not json' })

    const node = createNodeFromCard(card, POS)

    expect(node.title).toBe('烂内容')
    expect(node.content).toBe('plain text not json')
    expect(node.type).toBe('text')
    expect(node.width).toBe(200)
    expect(node.height).toBe(120)
  })

  it('内容里自带 id 时不允许污染节点 id(每次生成新 id)', () => {
    const card = makeCard({ content: '{"id":"fixed-id","title":"T"}' })

    const node = createNodeFromCard(card, POS)

    expect(node.id).not.toBe('fixed-id')
    expect(node.id.startsWith('node-')).toBe(true)
  })

  it('同一卡片连续创建 200 个节点,id 全部唯一', () => {
    const card = makeCard()
    const ids = new Set<string>()

    for (let i = 0; i < 200; i++) {
      ids.add(createNodeFromCard(card, POS).id)
    }

    expect(ids.size).toBe(200)
  })

  it('产出的对象满足 Node 契约:必填字段齐全且几何值为有限数字', () => {
    const node = createNodeFromCard(makeCard({ content: '{"title":"T"}' }), POS)

    const required: Array<keyof Node> = [
      'id',
      'x',
      'y',
      'width',
      'height',
      'title',
      'content',
      'fontSize',
      'textAlign',
      'collapsed',
      'locked',
    ]
    for (const key of required) {
      expect(node[key]).not.toBeUndefined()
    }

    expect(typeof node.id).toBe('string')
    expect(Number.isFinite(node.x)).toBe(true)
    expect(Number.isFinite(node.y)).toBe(true)
    expect(Number.isFinite(node.width)).toBe(true)
    expect(Number.isFinite(node.height)).toBe(true)
    expect(Number.isFinite(node.fontSize)).toBe(true)
    expect(['left', 'center', 'right']).toContain(node.textAlign)
    expect(typeof node.collapsed).toBe('boolean')
    expect(typeof node.locked).toBe('boolean')
  })

  it('内容里非法的 textAlign 原样透传(函数不做校验,行为固化)', () => {
    const card = makeCard({ content: '{"textAlign":"justify"}' })

    expect(createNodeFromCard(card, POS).textAlign).toBe('justify')
  })

  it("内容 'null'(合法 JSON)时节点完全取默认值", () => {
    const node = createNodeFromCard(makeCard({ content: 'null' }), POS)

    expect(node.title).toBe('')
    expect(node.width).toBe(200)
    expect(node.height).toBe(120)
  })

  it('不修改入参卡片', () => {
    const card = makeCard()
    const snapshot = { ...card }

    createNodeFromCard(card, POS)

    expect(card).toEqual(snapshot)
  })
})
