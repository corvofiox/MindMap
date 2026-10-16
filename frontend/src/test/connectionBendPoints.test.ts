import { describe, it, expect } from 'vitest'
import {
  calculateOptimalBendPoint,
  findBendPointInsertIndex,
  pointToLineSegmentDistance,
} from '@/utils/connectionBendPoints'
import { computeOptimalPorts } from '@/utils/canvas'

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

  /**
   * computeOptimalPorts（优化连线的唯一算法实现）。
   *
   * 关键约束：恒返回互补端口对（right↔left、top↔bottom）——straight 连线
   * 渲染恒为直线；若对角方位让对端独立取象限，会产生 [top,left] 这类
   * 非互补组合 → S 形。设计取舍见 computeOptimalPorts 注释。
   */
  describe('computeOptimalPorts', () => {
    // 帮助函数：100x160 的测试节点，返回其参数所需形状。
    const node = (x: number, y: number) => ({ x, y, width: 200, height: 160 })

    it('正右方 → right→left', () => {
      expect(computeOptimalPorts(node(100, 100), node(500, 100))).toEqual({
        fromPort: 'right',
        toPort: 'left',
      })
    })

    it('正下方 → bottom→top', () => {
      expect(computeOptimalPorts(node(100, 100), node(100, 500))).toEqual({
        fromPort: 'bottom',
        toPort: 'top',
      })
    })

    it('正左方 → left→right', () => {
      expect(computeOptimalPorts(node(500, 100), node(100, 100))).toEqual({
        fromPort: 'left',
        toPort: 'right',
      })
    })

    it('正上方 → top→bottom', () => {
      expect(computeOptimalPorts(node(100, 500), node(100, 100))).toEqual({
        fromPort: 'top',
        toPort: 'bottom',
      })
    })

    it('斜向目标落在出发节点的对应象限（避开 45° 浮点边界）', () => {
      // 目标在右上方偏上（约 -63°）：from 出发端口 top（向上缘出）。
      const up = computeOptimalPorts(node(100, 500), node(300, 200))
      expect(up.fromPort).toBe('top')
      expect(up.toPort).toBe('bottom')
      // 目标在右下方偏下（约 68°）：from 出发端口 bottom。
      const down = computeOptimalPorts(node(100, 100), node(300, 1000))
      expect(down.fromPort).toBe('bottom')
      expect(down.toPort).toBe('top')
    })

    it('恒返回互补端口对（渲染恒为直线，扫一圈角度）', () => {
      const opposite = {
        top: 'bottom',
        bottom: 'top',
        left: 'right',
        right: 'left',
      } as const
      for (let deg = 0; deg < 360; deg += 5) {
        const rad = (deg * Math.PI) / 180
        const cx = 1000
        const cy = 1000
        const from = node(cx, cy)
        const to = node(cx + Math.cos(rad) * 800, cy + Math.sin(rad) * 800)
        const { fromPort, toPort } = computeOptimalPorts(from, to)
        expect(opposite[fromPort], `deg=${deg}`).toBe(toPort)
      }
    })
  })
})
