/**
 * z-order helpers（shared/src/z-order.ts）的真实行为测试。
 *
 * 这些函数决定画布上节点的绘制先后。测试只断言可观察的数值/顺序，不复制实现
 * ——断言写错或被删掉时，这里必须失败。
 */
import { describe, it, expect } from 'vitest'
import {
  NODE_Z_STEP,
  nodeZIndex,
  compareNodeZIndex,
  sortByZIndex,
  minNodeZIndex,
  maxNodeZIndex,
  nextZIndexAbove,
  nextZIndexBelow,
} from '@shared/z-order'

/** 便于在纯函数测试里构造最小对象；zIndex 可缺省。 */
type TestNode = { id: string; zIndex?: number }

describe('nodeZIndex', () => {
  it('缺省值读作 0，让旧画布保持原顺序', () => {
    expect(nodeZIndex({})).toBe(0)
    expect(nodeZIndex({ zIndex: undefined })).toBe(0)
    expect(nodeZIndex(null)).toBe(0)
    expect(nodeZIndex(undefined)).toBe(0)
  })

  it('保留真实的数值（含负值）', () => {
    expect(nodeZIndex({ zIndex: 2500 })).toBe(2500)
    expect(nodeZIndex({ zIndex: -1000 })).toBe(-1000)
    expect(nodeZIndex({ zIndex: 0 })).toBe(0)
  })

  it('把 NaN / Infinity 当作缺省值，避免污染排序', () => {
    // 协作场景里字段可能被写成非数；若透传会让 compare 返回 NaN，
    // Array.prototype.sort 遇到 NaN 比较函数的行为是未定义的。
    expect(nodeZIndex({ zIndex: Number.NaN })).toBe(0)
    expect(nodeZIndex({ zIndex: Number.POSITIVE_INFINITY })).toBe(0)
    expect(nodeZIndex({ zIndex: Number.NEGATIVE_INFINITY })).toBe(0)
  })
})

describe('compareNodeZIndex', () => {
  it('按数值升序比较', () => {
    expect(compareNodeZIndex({ zIndex: 1000 }, { zIndex: 2000 })).toBeLessThan(0)
    expect(compareNodeZIndex({ zIndex: 2000 }, { zIndex: 1000 })).toBeGreaterThan(0)
    expect(compareNodeZIndex({ zIndex: 1000 }, { zIndex: 1000 })).toBe(0)
  })

  it('缺省字段之间比较为 0，配合稳定排序保持 Map 既有顺序', () => {
    expect(compareNodeZIndex({}, {})).toBe(0)
    expect(compareNodeZIndex({ zIndex: undefined }, {})).toBe(0)
  })

  it('能直接用于 sort，结果是层序升序且等值项保持输入顺序', () => {
    const legacy: TestNode[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const ordered: TestNode[] = [{ id: 'x', zIndex: 3000 }, { id: 'y', zIndex: 1000 }]
    const all = [...ordered, ...legacy]
    const sorted = [...all].sort(compareNodeZIndex)
    // 旧节点(0) 在前，且保持原有相对顺序 a,b,c；再按数值升序 y(1000), x(3000)
    expect(sorted.map((n) => n.id)).toEqual(['a', 'b', 'c', 'y', 'x'])
  })
})

describe('sortByZIndex（画布绘制顺序）', () => {
  it('按 zIndex 升序返回，最后一个画在最上层', () => {
    const out = sortByZIndex([
      { id: 'mid', zIndex: 2000 },
      { id: 'top', zIndex: 3000 },
      { id: 'bottom', zIndex: 1000 },
    ])
    expect(out.map((n) => n.id)).toEqual(['bottom', 'mid', 'top'])
  })

  it('等值项保持迭代顺序（旧画布的视觉兼容）', () => {
    const legacy: TestNode[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const out = sortByZIndex(legacy)
    expect(out.map((n) => n.id)).toEqual(['a', 'b', 'c'])
  })

  it('接受 Map.values() 且不修改原集合', () => {
    const nodes = new Map([
      ['a', { id: 'a', zIndex: 2000 }],
      ['b', { id: 'b', zIndex: 1000 }],
    ])
    const out = sortByZIndex(nodes.values())

    expect(out.map((n) => n.id)).toEqual(['b', 'a'])
    // 原 Map 顺序不变：排序必须发生在渲染的拷贝上
    expect([...nodes.keys()]).toEqual(['a', 'b'])
  })
})

describe('minNodeZIndex / maxNodeZIndex', () => {
  it('空集合返回 0', () => {
    expect(minNodeZIndex([])).toBe(0)
    expect(maxNodeZIndex([])).toBe(0)
  })

  it('忽略缺省值参与极值计算（缺省读作 0）', () => {
    expect(minNodeZIndex([{ zIndex: 5000 }, {}])).toBe(0)
    expect(maxNodeZIndex([{ zIndex: -500 }, {}])).toBe(0)
  })

  it('取真实极值', () => {
    const nodes = [{ zIndex: 2000 }, { zIndex: -3000 }, { zIndex: 500 }]
    expect(minNodeZIndex(nodes)).toBe(-3000)
    expect(maxNodeZIndex(nodes)).toBe(2000)
  })

  it('接受任意可迭代对象（store 里直接传 Map.values()）', () => {
    const map = new Map([
      ['a', { zIndex: 1000 }],
      ['b', { zIndex: 4000 }],
    ])
    expect(maxNodeZIndex(map.values())).toBe(4000)
    expect(minNodeZIndex(map.values())).toBe(1000)
  })
})

describe('nextZIndexAbove / nextZIndexBelow', () => {
  it('空画布的第一个节点落在 STEP 上，不占用 0', () => {
    expect(nextZIndexAbove([])).toBe(NODE_Z_STEP)
  })

  it('置顶 = 当前最大值 + STEP，连续置顶严格递增', () => {
    let nodes: { zIndex?: number }[] = []
    const seen: number[] = []
    for (let i = 0; i < 4; i += 1) {
      const z = nextZIndexAbove(nodes)
      seen.push(z)
      nodes = [...nodes, { zIndex: z }]
    }
    expect(seen).toEqual([1000, 2000, 3000, 4000])
  })

  it('置底 = 当前最小值 - STEP，连续置底严格递减', () => {
    let nodes: { zIndex?: number }[] = []
    const seen: number[] = []
    for (let i = 0; i < 3; i += 1) {
      const z = nextZIndexBelow(nodes)
      seen.push(z)
      nodes = [...nodes, { zIndex: z }]
    }
    expect(seen).toEqual([-1000, -2000, -3000])
  })

  it('旧画布（全部缺省）上置顶仍排在所有旧节点之上', () => {
    const legacy: TestNode[] = [{ id: 'a' }, { id: 'b' }]
    const z = nextZIndexAbove(legacy)
    const sorted = [...legacy, { id: 'new', zIndex: z }].sort(compareNodeZIndex)
    expect(sorted.map((n) => n.id)).toEqual(['a', 'b', 'new'])
  })
})
