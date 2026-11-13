import { useProjectsStore } from '@/store/useProjectsStore'
import type { Project } from '@/types'

/**
 * 「打开项目」= 进它最近更新的一张画布；一张都没有就先建一张。
 *
 * 为什么要有这个函数：项目卡片与左侧项目切换曾经都直接 `navigate('/canvas/new')`，
 * 而 `/canvas/new` 并不是一个真实画布——CanvasPage 从路由里解析不出数字 id，
 * 于是刚点开项目就落在「请先选择一个画布」的空页面上。
 *
 * 返回真正打开的画布 id；失败返回 null（调用方负责提示）。
 */
export async function openProjectCanvas(project: Project): Promise<number | null> {
  const store = useProjectsStore.getState()
  await store.setCurrentProject(project)

  const canvases = useProjectsStore.getState().canvases
  const latest = canvases
    .filter((canvas) => canvas.id > 0)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]
  if (latest) return latest.id

  const created = await store
    .createCanvas(project.id, { name: '未命名画布 1', projectId: project.id })
    .catch(() => null)
  return created && created.id > 0 ? created.id : null
}
