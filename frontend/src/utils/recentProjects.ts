import type { Project } from '@/types'

const STORAGE_KEY = 'mindmap_recent_projects'
const MAX_RECENT_COUNT = 5

export interface RecentProject {
  id: number
  name: string
  description?: string | null
  isCollaborative: boolean
  memberRole: 'owner' | 'editor' | 'viewer'
  visitedAt: number
}

/**
 * 获取最近访问的项目列表
 */
export function getRecentProjects(): RecentProject[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return []
    const projects = JSON.parse(stored) as RecentProject[]
    // 过滤掉超过30天的记录
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
    return projects.filter(p => p.visitedAt > thirtyDaysAgo)
  } catch {
    return []
  }
}

/**
 * 添加项目到最近访问列表
 */
export function addRecentProject(project: Project) {
  try {
    const recent = getRecentProjects()
    // 移除已存在的相同项目
    const filtered = recent.filter(p => p.id !== project.id)
    // 添加新项目到开头
    const newRecent: RecentProject = {
      id: project.id,
      name: project.name,
      description: project.description,
      isCollaborative: project.isCollaborative,
      memberRole: project.memberRole || 'owner',
      visitedAt: Date.now(),
    }
    filtered.unshift(newRecent)
    // 只保留最近5个
    const trimmed = filtered.slice(0, MAX_RECENT_COUNT)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
  } catch {
    // 忽略存储错误
  }
}

/**
 * 清除最近访问列表
 */
export function clearRecentProjects() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // 忽略错误
  }
}

/**
 * 格式化相对时间
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp

  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  const week = 7 * day

  if (diff < minute) {
    return '刚刚'
  } else if (diff < hour) {
    const minutes = Math.floor(diff / minute)
    return `${minutes}分钟前`
  } else if (diff < day) {
    const hours = Math.floor(diff / hour)
    return `${hours}小时前`
  } else if (diff < week) {
    const days = Math.floor(diff / day)
    return `${days}天前`
  } else {
    const date = new Date(timestamp)
    return `${date.getMonth() + 1}/${date.getDate()}`
  }
}
