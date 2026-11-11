/**
 * 统一节点归一化（shared/src/node.ts）的真实行为测试。
 *
 * 这一层是"老数据仍然能渲染"的唯一保证：迁移没跑到的画布、localStorage 里的
 * 旧缓存、老节点池卡片，都靠它在这里折成 content/cover。
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeNode,
  extractFirstImageUrl,
  htmlToPlainText,
  nodeHasImage,
} from '@shared/node'

const SHA = 'b'.repeat(64)

describe('normalizeNode', () => {
  it('老图片节点：imageUrl 折成正文 <img> 与 cover，并丢掉已废弃字段', () => {
    const legacy = {
      id: 'n1',
      type: 'image' as const,
      imageUrl: '/api/files/' + SHA,
      aspectRatio: 1.5,
      title: '图',
      content: '',
    }

    const node = normalizeNode(legacy)

    expect(node.content).toBe(`<img src="/api/files/${SHA}" alt="">`)
    expect(node.cover).toBe(`/api/files/${SHA}`)
    expect(node.title).toBe('图')
    expect(node).not.toHaveProperty('type')
    expect(node).not.toHaveProperty('imageUrl')
    expect(node).not.toHaveProperty('aspectRatio')
  })

  it('老图片节点已有正文时：保留正文，只补 cover', () => {
    const node = normalizeNode({
      type: 'image',
      imageUrl: '/api/files/' + SHA,
      content: '<p>说明文字</p>',
    })

    expect(node.content).toBe('<p>说明文字</p>')
    expect(node.cover).toBe(`/api/files/${SHA}`)
  })

  it('纯文字节点：不产生 cover，也不改动 content', () => {
    const node = normalizeNode({ content: '<p>只有字</p>', title: 'T' })

    expect(node.content).toBe('<p>只有字</p>')
    expect(node.cover).toBeUndefined()
    expect(node).not.toHaveProperty('type')
  })

  it('content 里已有 <img> 但缺 cover 时，从正文推导', () => {
    const node = normalizeNode({ content: `<p>a</p><img src="/api/files/${SHA}" alt="">` })
    expect(node.cover).toBe(`/api/files/${SHA}`)
  })

  it('显式 cover 优先于正文里的第一张图', () => {
    const node = normalizeNode({
      content: `<img src="/api/files/${SHA}" alt="">`,
      cover: '/api/files/' + 'c'.repeat(64),
    })
    expect(node.cover).toBe('/api/files/' + 'c'.repeat(64))
  })

  it('空字符串 imageUrl 不算图片', () => {
    const node = normalizeNode({ imageUrl: '', content: '' })
    expect(node.content).toBe('')
    expect(node.cover).toBeUndefined()
  })

  it('不修改入参（Yjs diff 与撤销快照都依赖对象不可变）', () => {
    const legacy = { id: 'n', imageUrl: '/api/files/' + SHA, type: 'image' as const }
    const snapshot = { ...legacy }

    normalizeNode(legacy)

    expect(legacy).toEqual(snapshot)
  })

  it('缺失 content 时补空串，避免下游拿到 undefined', () => {
    expect(normalizeNode({}).content).toBe('')
  })
})

describe('extractFirstImageUrl', () => {
  it('取出第一个 img 的 src，忽略后续', () => {
    expect(
      extractFirstImageUrl('<img src="/api/files/aaa"><img src="/api/files/bbb">'),
    ).toBe('/api/files/aaa')
  })

  it('单引号/无属性顺序差异也能识别', () => {
    expect(extractFirstImageUrl("<img alt='x' src='/api/files/ccc'>")).toBe('/api/files/ccc')
  })

  it('没有图片时返回 null', () => {
    expect(extractFirstImageUrl('<p>无图</p>')).toBeNull()
    expect(extractFirstImageUrl('')).toBeNull()
    expect(extractFirstImageUrl(null)).toBeNull()
  })
})

describe('htmlToPlainText', () => {
  it('去标签、解实体、折叠空白', () => {
    expect(htmlToPlainText('<p>a  &amp;  b</p>\n<p>c</p>')).toBe('a & b c')
  })

  it('丢弃 script/style 的内容而不是把它们当正文', () => {
    expect(htmlToPlainText('<style>.x{color:red}</style><p>正文</p>')).toBe('正文')
  })
})

describe('nodeHasImage', () => {
  it('cover / 老 imageUrl / 正文里的 img 任一成立就算有图', () => {
    expect(nodeHasImage({ cover: '/api/files/' + SHA })).toBe(true)
    expect(nodeHasImage({ imageUrl: 'data:image/png;base64,xx' })).toBe(true)
    expect(nodeHasImage({ content: '<img src="/api/files/x">' })).toBe(true)
  })

  it('纯文字或空值不算有图', () => {
    expect(nodeHasImage({ content: '<p>字</p>' })).toBe(false)
    expect(nodeHasImage({})).toBe(false)
    expect(nodeHasImage(null)).toBe(false)
  })
})
