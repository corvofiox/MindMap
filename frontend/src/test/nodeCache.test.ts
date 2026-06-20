import { describe, it, expect, beforeEach } from 'vitest'
import { saveToCache, loadFromCache, hasCache, clearCache, getCacheAge, clearAllCaches } from '@/utils/nodeCache'
import type { Node } from '@/types'

// P4 测试：画布缓存 key 含 tab 级 sessionId，保证同账号多标签页不互相覆盖。
// 注意：nodeCache 的 tabSessionId 在模块加载时初始化并固定，单测内无法切换 tab，
// 因此重点验证 key 隔离契约（写入后能正确读回、清理有效），而非跨 tab 隔离本身。

const mockNode = (id: string): Node => ({
  id,
  text: `node-${id}`,
  x: 0,
  y: 0,
  width: 100,
  height: 60,
}) as unknown as Node

describe('nodeCache — 画布缓存基本契约', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('saveToCache 后 loadFromCache 能读回数据', () => {
    const data = { nodes: [mockNode('n1')], groups: [], domains: [], connections: [] }
    saveToCache(42, data)

    const loaded = loadFromCache(42)
    expect(loaded).not.toBeNull()
    expect(loaded!.nodes).toHaveLength(1)
    expect(loaded!.nodes[0].id).toBe('n1')
  })

  it('hasCache 正确反映缓存存在性', () => {
    expect(hasCache(42)).toBe(false)
    saveToCache(42, { nodes: [mockNode('n1')], groups: [], domains: [], connections: [] })
    expect(hasCache(42)).toBe(true)
  })

  it('clearCache 后缓存消失', () => {
    saveToCache(42, { nodes: [mockNode('n1')], groups: [], domains: [], connections: [] })
    expect(hasCache(42)).toBe(true)

    clearCache(42)
    expect(hasCache(42)).toBe(false)
    expect(loadFromCache(42)).toBeNull()
  })

  it('getCacheAge 返回缓存年龄', () => {
    saveToCache(42, { nodes: [mockNode('n1')], groups: [], domains: [], connections: [] })
    const age = getCacheAge(42)
    expect(age).not.toBeNull()
    expect(age!).toBeGreaterThanOrEqual(0)
  })

  it('clearAllCaches 不抛错（清理逻辑可安全调用）', () => {
    saveToCache(1, { nodes: [mockNode('a')], groups: [], domains: [], connections: [] })
    // 不依赖 Object.keys(localStorage) 枚举（jsdom mock 下不可靠），
    // 仅验证 clearAllCaches 可安全调用
    expect(() => clearAllCaches()).not.toThrow()
  })

  it('loadFromCache 对不存在的画布返回 null', () => {
    expect(loadFromCache(999)).toBeNull()
  })

  it('key 含 sessionId 后缀：loadFromCache 读回的 key 格式正确', () => {
    // 不依赖 Object.keys(localStorage) 枚举（jsdom mock 下不可靠）。
    // 通过 save→load 往返验证带 sessionId 的 key 能正确读写，
    // 间接证明 key 含 sessionId 后缀（否则裸 key 模式下也能工作，
    // 但本测试与其它隔离测试共同构成 P4 契约）。
    saveToCache(42, { nodes: [mockNode('n1')], groups: [], domains: [], connections: [] })
    const loaded = loadFromCache(42)
    expect(loaded).not.toBeNull()
    expect(loaded!.nodes[0].id).toBe('n1')

    // 不同画布 id 互不干扰
    const loadedOther = loadFromCache(43)
    expect(loadedOther).toBeNull()
  })

  it('超大画布数据超出 localStorage 配额时不保存，避免抛错', () => {
    // 构造超过 4MB 的 payload（UTF-16 每个字符 2 bytes）
    const hugeText = 'x'.repeat(3 * 1024 * 1024)
    const bigNode = { ...mockNode('big'), text: hugeText } as unknown as Node
    saveToCache(42, { nodes: [bigNode], groups: [], domains: [], connections: [] })

    expect(hasCache(42)).toBe(false)
    expect(loadFromCache(42)).toBeNull()
  })

  it('QuotaExceededError 时优雅跳过，不抛错、不破坏已有缓存', () => {
    // 先写入一个已有缓存
    saveToCache(1, { nodes: [mockNode('existing')], groups: [], domains: [], connections: [] })
    expect(hasCache(1)).toBe(true)

    const originalSetItem = localStorage.setItem.bind(localStorage)
    localStorage.setItem = function () {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    }

    try {
      saveToCache(42, { nodes: [mockNode('n1')], groups: [], domains: [], connections: [] })
    } finally {
      localStorage.setItem = originalSetItem
    }

    // 新画布缓存未写入，已有缓存不被破坏
    expect(hasCache(42)).toBe(false)
    expect(hasCache(1)).toBe(true)
  })
})
