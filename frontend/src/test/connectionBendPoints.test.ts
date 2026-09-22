import { describe, it, expect } from 'vitest'
import {
  calculateOptimalBendPoint,
  findBendPointInsertIndex,
  pointToLineSegmentDistance,
} from '@/utils/connectionBendPoints'

/**
 * 弯折点插入索引的几何语义。
 *
 * 这些用例存在的理由：索引决定新点在 bendPoints 数组里的位置，而对端渲染折线
 * 完全按数组顺序连点 —— 索引算错 / 写文档时不按索引插入，就会让**别人**看到
 * 一条折返（交叉）的线，而写点的人本地看是对的。
 */
describe('connectionBendPoints', () => {
  describe('pointToLineSegmentDistance', () => {
    it('returns the perpendicular distance for a point above the segment', () => {
      expect(pointToLineSegmentDistance(50, 130, 0, 100, 100, 100)).toBeCloseTo(30)
    })

    it('clamps to the endpoints outside the segment', () => {
      const beyondStart = pointToLineSegmentDistance(-50, 100, 0, 100, 100, 100)
      expect(beyondStart).toBeCloseTo(50)
    })

    it('handles a degenerate (zero-length) segment', () => {
      expect(pointToLineSegmentDistance(30, 140, 10, 100, 10, 100)).toBeCloseTo(Math.sqrt(400 + 1600))
    })
  })

  describe('calculateOptimalBendPoint', () => {
    it('places the point a third of the way along when the line is long', () => {
      expect(calculateOptimalBendPoint(100, 100, 700, 100)).toEqual({ x: 300, y: 100 })
    })

    it('places the point at the midpoint when the line is short', () => {
      expect(calculateOptimalBendPoint(100, 100, 180, 100)).toEqual({ x: 140, y: 100 })
    })
  })

  describe('findBendPointInsertIndex', () => {
    // 一条水平直线：起点在左（x=100），终点在右（x=500）。
    const from = { x: 100, y: 100 }
    const to = { x: 500, y: 100 }

    it('returns 0 when there are no bend points yet', () => {
      expect(findBendPointInsertIndex(200, 100, from.x, from.y, to.x, to.y, [])).toBe(0)
    })

    it('returns 1 when clicking the far half of a line whose existing point is nearer the start', () => {
      const bpLeft = { x: 200, y: 100 }
      expect(findBendPointInsertIndex(400, 100, from.x, from.y, to.x, to.y, [bpLeft])).toBe(1)
    })

    it('returns 0 when the new point belongs before the existing one', () => {
      // 已有的点更靠终点（右侧），新点在左半部分 —— 它必须排在前面。
      // 这个 0 是整条链路的要害：写文档时必须真的插到索引 0，追加到末尾就会
      // 让对端把 [左点, 右点] 看成 [右点, 左点]，画出折返交叉。
      const bpRight = { x: 400, y: 100 }
      expect(findBendPointInsertIndex(200, 100, from.x, from.y, to.x, to.y, [bpRight])).toBe(0)
    })

    it('picks the closest segment when the polyline has several points', () => {
      const points = [{ x: 200, y: 300 }, { x: 300, y: 100 }]
      // 折线为 (100,100) → (200,300) → (300,100) → (500,100)，共 3 段。
      // 点击 (250,200) 正好落在第 2 段（索引 1）上。
      expect(findBendPointInsertIndex(250, 200, from.x, from.y, to.x, to.y, points)).toBe(1)
      // 点击 (400,60) 离第 3 段（索引 2）最近。
      expect(findBendPointInsertIndex(400, 60, from.x, from.y, to.x, to.y, points)).toBe(2)
    })

    // 用户实际遇到的构造：连线方向是"从右到左"（起点在右、终点在左）。
    // 先在左半部分打一个点，再在右半部分打点 —— 第二个点的索引是 0。
    it('returns 0 for a right-to-left line when the new point is nearer the start', () => {
      const rtlFrom = { x: 500, y: 100 }
      const rtlTo = { x: 100, y: 100 }
      const bpLeftHalf = { x: 200, y: 100 }
      expect(
        findBendPointInsertIndex(400, 100, rtlFrom.x, rtlFrom.y, rtlTo.x, rtlTo.y, [bpLeftHalf]),
      ).toBe(0)
    })
  })
})
