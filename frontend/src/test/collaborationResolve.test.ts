import { describe, it, expect } from 'vitest'
import { resolveCanvasIsCollaborative } from '@/utils/collaboration'

const canvases = [
  { id: 1, projectId: 10 }, // 私人项目画布
  { id: 2, projectId: 20 }, // 协作项目画布
  { id: -3, tempId: -3, projectId: 20 }, // 协作项目中新建中的临时画布
]

const projects = [
  { id: 10, isCollaborative: false },
  { id: 20, isCollaborative: true },
]

describe('resolveCanvasIsCollaborative', () => {
  it('私人项目画布 → false(不启用协作,修复回归: 私人项目显示房间人数/禁手动保存)', () => {
    expect(resolveCanvasIsCollaborative(canvases, projects, 1)).toBe(false)
  })

  it('协作项目画布 → true', () => {
    expect(resolveCanvasIsCollaborative(canvases, projects, 2)).toBe(true)
  })

  it('协作项目中的临时画布(tempId 匹配) → true', () => {
    expect(resolveCanvasIsCollaborative(canvases, projects, -3)).toBe(true)
  })

  it('null / 非法 id → false', () => {
    expect(resolveCanvasIsCollaborative(canvases, projects, null)).toBe(false)
    expect(resolveCanvasIsCollaborative(canvases, projects, 0)).toBe(false)
  })

  it('画布不存在 → false', () => {
    expect(resolveCanvasIsCollaborative(canvases, projects, 999)).toBe(false)
  })

  it('画布存在但项目不在列表中(projects 未加载完) → false(安全缺省: 不误连 WS)', () => {
    expect(resolveCanvasIsCollaborative(canvases, [], 2)).toBe(false)
  })
})
