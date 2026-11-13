/**
 * 「点开项目」要落到一张真实画布上。
 *
 * 回归背景：项目卡片与左侧项目切换都曾 `navigate('/canvas/new')`，
 * 而 CanvasPage 从路由里解析不出 id，刚点开项目就显示"请先选择一个画布"。
 * 这里钉住选择/兜底逻辑：有画布进最近的一张，没有就建一张，建不出来返回 null。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  setCurrentProject: vi.fn(async () => undefined),
  createCanvas: vi.fn(async (_projectId: number, _data: unknown) => ({ id: 9 }) as { id: number }),
  canvases: [] as { id: number; updatedAt: string }[],
}))

vi.mock('@/store/useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      setCurrentProject: mocks.setCurrentProject,
      createCanvas: mocks.createCanvas,
      canvases: mocks.canvases,
    }),
  },
}))

const { openProjectCanvas } = await import('@/utils/openProject')

const project = { id: 7, name: '项目' } as never

beforeEach(() => {
  mocks.setCurrentProject.mockClear()
  mocks.createCanvas.mockClear()
  mocks.canvases = []
})

describe('打开项目', () => {
  it('项目里已有画布时，进最近更新的那一张，不新建', async () => {
    mocks.canvases = [
      { id: 3, updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 5, updatedAt: '2026-05-05T00:00:00.000Z' },
      { id: 4, updatedAt: '2026-03-03T00:00:00.000Z' },
    ]

    await expect(openProjectCanvas(project)).resolves.toBe(5)
    expect(mocks.setCurrentProject).toHaveBeenCalledWith(project)
    expect(mocks.createCanvas).not.toHaveBeenCalled()
  })

  it('项目还是空的就先建一张画布再进', async () => {
    await expect(openProjectCanvas(project)).resolves.toBe(9)
    expect(mocks.createCanvas).toHaveBeenCalledWith(7, { name: '未命名画布 1', projectId: 7 })
  })

  it('乐观更新留下的临时画布（负 id）不算已有画布', async () => {
    mocks.canvases = [{ id: -1730000000000, updatedAt: '2026-06-06T00:00:00.000Z' }]

    await expect(openProjectCanvas(project)).resolves.toBe(9)
    expect(mocks.createCanvas).toHaveBeenCalledTimes(1)
  })

  it('建画布失败时返回 null，交给调用方提示', async () => {
    mocks.createCanvas.mockRejectedValueOnce(new Error('网络错误'))

    await expect(openProjectCanvas(project)).resolves.toBeNull()
  })
})
