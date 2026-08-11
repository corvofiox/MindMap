import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Project, Canvas, Folder, NodeCard, NodePoolFolder, NodePoolSortOption, NodePoolSortOrder } from '@/types'
import * as api from '@/services/api'
import { ApiError } from '@/services/apiClient'

// 项目筛选状态
export interface ProjectFilters {
  showOwned: boolean
  showCollaborative: boolean
  showRecentUpdated: boolean
}

interface ProjectsState {
  projects: Project[]
  currentProject: Project | null
  currentProjectId: number | null  // 持久化项目ID
  currentMemberRole: 'owner' | 'editor' | 'viewer' | null
  canvases: Canvas[]
  folders: Folder[]
  nodePool: NodeCard[]
  nodePoolFolders: NodePoolFolder[]
  nodePoolSortBy: NodePoolSortOption
  nodePoolSortOrder: NodePoolSortOrder
  isLoading: boolean
  loadingMessage: string  // 当前加载操作的提示信息
  error: string | null
  // 项目筛选
  projectFilters: ProjectFilters

  // Actions
  loadProjects: () => Promise<void>
  setProjectFilters: (filters: Partial<ProjectFilters>) => void
  getFilteredProjects: () => Project[]
  setCurrentProject: (project: Project | null) => Promise<void>
  restoreCurrentProject: () => Promise<void>  // 恢复上次的项目
  loadCanvases: (projectId: number) => Promise<void>
  refreshCanvasesSilent: (projectId: number) => Promise<void>  // 静默刷新画布列表
  loadFolders: (projectId: number) => Promise<void>
  loadNodePool: () => Promise<void>
  loadNodePoolFolders: () => Promise<void>
  createProject: (data: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  updateProject: (id: number, data: Partial<Project>) => Promise<void>
  deleteProject: (id: number) => Promise<void>

  // Canvas actions
  createCanvas: (projectId: number, data: Partial<Canvas>) => Promise<Canvas>
  updateCanvas: (id: number, data: Partial<Canvas> & { clientVersion?: number }, silent?: boolean) => Promise<void>
  deleteCanvas: (id: number) => Promise<void>
  moveCanvasToFolder: (canvasId: number, folderId: number | null, silent?: boolean) => Promise<void>

  // Folder actions
  createFolder: (projectId: number, data: Omit<Folder, 'id' | 'createdAt'>) => Promise<void>
  updateFolder: (id: number, data: Partial<Folder>) => Promise<void>
  deleteFolder: (id: number) => Promise<void>

  // Node pool actions (User-specific)
  addToNodePool: (data: Omit<NodeCard, 'id' | 'createdAt' | 'useCount' | 'userId'>) => Promise<NodeCard>
  removeFromNodePool: (id: number) => Promise<void>
  updateNodeCard: (id: number, data: Partial<NodeCard>) => Promise<void>
  incrementNodeCardUseCount: (id: number) => Promise<void>
  setNodePoolSortBy: (sortBy: NodePoolSortOption) => void
  setNodePoolSortOrder: (order: NodePoolSortOrder) => void

  // Node pool folder actions (User-specific)
  createNodePoolFolder: (data: Omit<NodePoolFolder, 'id' | 'createdAt' | 'children' | 'userId'>) => Promise<void>
  updateNodePoolFolder: (id: number, data: Partial<NodePoolFolder>) => Promise<void>
  deleteNodePoolFolder: (id: number) => Promise<void>
  toggleNodePoolFolderCollapsed: (id: number) => void

  // Batch sort order updates
  reorderNodePoolFolders: (updates: Array<{ id: number; sortOrder: number }>) => Promise<void>
  reorderNodeCards: (updates: Array<{ id: number; sortOrder: number }>) => Promise<void>

  clearError: () => void
  /** 重置内存态(登出/换账号时调用,防止上一账号数据残留渲染) */
  reset: () => void
}

export const useProjectsStore = create<ProjectsState>()(
  persist(
    (set, get) => {
      const handleError = (error: unknown, defaultMessage: string) => {
        const errorMessage = error instanceof Error ? error.message : defaultMessage
        set({
          error: errorMessage,
          isLoading: false,
        })
        throw new Error(errorMessage)
      }

      return {
        projects: [],
        currentProject: null,
        currentProjectId: null,
        currentMemberRole: null,
        canvases: [],
        folders: [],
        nodePool: [],
        nodePoolFolders: [],
        nodePoolSortBy: 'createdAt',
        nodePoolSortOrder: 'desc',
        isLoading: false,
        loadingMessage: '',
        error: null,
        projectFilters: {
          showOwned: false,
          showCollaborative: false,
          showRecentUpdated: false,
        },

        loadProjects: async () => {
          set({ isLoading: true, loadingMessage: '正在加载项目...', error: null })
          try {
            const projects = await api.getProjects()
            set({ projects, isLoading: false, loadingMessage: '' })
          } catch (error) {
            handleError(error, '加载项目失败')
          }
        },

        setProjectFilters: (filters) => {
          set((state) => ({
            projectFilters: { ...state.projectFilters, ...filters }
          }))
        },

        getFilteredProjects: () => {
          const { projects, projectFilters } = get()
          const oneWeekAgo = new Date()
          oneWeekAgo.setDate(oneWeekAgo.getDate() - 7)
          oneWeekAgo.setHours(0, 0, 0, 0)

          return projects.filter(project => {
            // 标记是否满足各类筛选条件
            let matchesOwned = false
            let matchesCollaborative = false
            let matchesRecentUpdated = false

            // 检查是否满足"我拥有的项目"条件
            if (project.memberRole === 'owner') {
              matchesOwned = true
            }

            // 检查是否满足"协作项目"条件
            if (project.isCollaborative) {
              matchesCollaborative = true
            }

            // 检查是否满足"最近一周更新"条件
            const updatedAt = new Date(project.updatedAt)
            if (!isNaN(updatedAt.getTime()) && updatedAt >= oneWeekAgo) {
              matchesRecentUpdated = true
            }

            // 根据用户勾选的筛选条件进行判断
            // 如果勾选了某类筛选，则必须满足该类条件
            let shouldShow = true

            // 如果勾选了"我拥有的项目"，但当前项目不满足，则不显示
            if (projectFilters.showOwned && !matchesOwned) {
              shouldShow = false
            }

            // 如果勾选了"协作项目"，但当前项目不满足，则不显示
            if (projectFilters.showCollaborative && !matchesCollaborative) {
              shouldShow = false
            }

            // 如果勾选了"最近一周更新"，但当前项目不满足，则不显示
            if (projectFilters.showRecentUpdated && !matchesRecentUpdated) {
              shouldShow = false
            }

            // 如果所有筛选都没勾选，显示所有项目
            if (!projectFilters.showOwned && !projectFilters.showCollaborative && !projectFilters.showRecentUpdated) {
              shouldShow = true
            }

            return shouldShow
          })
        },

        setCurrentProject: async (project) => {
          set({
            currentProject: project,
            currentProjectId: project?.id || null,
            currentMemberRole: project?.memberRole || null,
          })
          if (project) {
            await Promise.all([
              get().loadCanvases(project.id),
              get().loadFolders(project.id),
            ])
            // Node pool is user-specific, load separately
            await Promise.all([
              get().loadNodePool(),
              get().loadNodePoolFolders(),
            ])
          }
        },

        restoreCurrentProject: async () => {
          const { currentProjectId, projects } = get()
          if (currentProjectId && projects.length > 0) {
            const project = projects.find(p => p.id === currentProjectId)
            if (project) {
              await get().setCurrentProject(project)
            }
          }
        },

        loadCanvases: async (projectId) => {
          set({ isLoading: true, loadingMessage: '正在加载画布...', error: null })
          try {
            const canvases = await api.getCanvases(projectId)
            set({ canvases, isLoading: false, loadingMessage: '' })
          } catch (error) {
            handleError(error, '加载画布失败')
          }
        },

        refreshCanvasesSilent: async (projectId) => {
          try {
            const canvases = await api.getCanvases(projectId)
            set({ canvases })
          } catch {
            // 静默失败，不更新 loading 状态
          }
        },

        loadFolders: async (projectId) => {
          set({ isLoading: true, loadingMessage: '正在加载文件夹...', error: null })
          try {
            const folders = await api.getFolders(projectId)
            set({ folders, isLoading: false, loadingMessage: '' })
          } catch (error) {
            handleError(error, '加载文件夹失败')
          }
        },

        loadNodePoolFolders: async () => {
          set({ isLoading: true, loadingMessage: '正在加载节点池...', error: null })
          try {
            const folders = await api.getNodePoolFolders()
            set({ nodePoolFolders: folders, isLoading: false, loadingMessage: '' })
          } catch (error) {
            handleError(error, '加载节点池文件夹失败')
          }
        },

        loadNodePool: async () => {
          set({ isLoading: true, loadingMessage: '正在加载节点池...', error: null })
          try {
            const nodePool = await api.getNodePool()
            set({ nodePool, isLoading: false, loadingMessage: '' })
          } catch (error) {
            handleError(error, '加载节点池失败')
          }
        },

        createProject: async (data) => {
          set({ isLoading: true, loadingMessage: '正在创建项目...', error: null })
          try {
            const project = await api.createProject(data)
            set((state) => ({
              projects: [...state.projects, project],
              isLoading: false,
              loadingMessage: '',
            }))
          } catch (error) {
            handleError(error, '创建项目失败')
          }
        },

        updateProject: async (id, data) => {
          set({ isLoading: true, loadingMessage: '正在更新项目...', error: null })
          try {
            const updated = await api.updateProject(id, data)
            set((state) => ({
              projects: state.projects.map((p) => (p.id === id ? updated : p)),
              currentProject: state.currentProject?.id === id ? updated : state.currentProject,
              isLoading: false,
              loadingMessage: '',
            }))
          } catch (error) {
            handleError(error, '更新项目失败')
          }
        },

        deleteProject: async (id) => {
          set({ isLoading: true, loadingMessage: '正在删除项目...', error: null })
          try {
            await api.deleteProject(id)
            set((state) => ({
              projects: state.projects.filter((p) => p.id !== id),
              currentProject: state.currentProject?.id === id ? null : state.currentProject,
              currentProjectId: state.currentProjectId === id ? null : state.currentProjectId,
              isLoading: false,
              loadingMessage: '',
            }))
          } catch (error) {
            handleError(error, '删除项目失败')
          }
        },

        createCanvas: async (projectId, data) => {
          // 生成临时ID
          const tempId = -Date.now()

          // 创建临时画布对象，添加tempId字段用于跟踪
          const tempCanvas: Canvas = {
            id: tempId,
            tempId: tempId,
            name: data.name || '未命名画布',
            sortOrder: data.sortOrder || 0,
            ...data,
            projectId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            folderId: data.folderId || null,
            thumbnail: null
          }

          // 乐观更新：立即添加到本地状态
          set((state) => ({
            canvases: [...state.canvases, tempCanvas],
          }))

          try {
            // 后台执行API请求
            const canvas = await api.createCanvas(projectId, data)

            // 用真实数据替换临时画布，并保留tempId字段用于跟踪
            const updatedCanvas = {
              ...canvas,
              tempId: tempId
            }

            // 用真实数据替换临时画布
            set((state) => ({
              canvases: state.canvases.map(c => c.id === tempId ? updatedCanvas : c),
            }))

            return updatedCanvas
          } catch (error) {
            // API失败：从本地状态移除临时画布
            set((state) => ({
              canvases: state.canvases.filter(c => c.id !== tempId),
            }))

            // handleError 内部会 throw，调用方通过 catch 感知失败（C13 统一错误处理）
            handleError(error, '创建画布失败')
          }
        },

        updateCanvas: async (id, data, silent = false) => {
          if (!silent) {
            set({ isLoading: true, loadingMessage: '正在更新画布...', error: null })
          }
          try {
            const updated = await api.updateCanvas(id, data)
            set((state) => ({
              canvases: state.canvases.map((c) => {
                if (c.id === id) {
                  // updateCanvas API 不返回 activeUsers，保留现有的
                  return { ...updated, activeUsers: c.activeUsers }
                }
                return c
              }),
              isLoading: silent ? state.isLoading : false,
              loadingMessage: silent ? state.loadingMessage : '',
            }))
          } catch (error) {
            // P1: silent 模式（缩略图更新）下的 409 表示画布已被他人更新，
            // 本次缩略图基于过时状态生成，静默丢弃比覆盖更安全，不报错。
            if (silent && error instanceof ApiError && error.status === 409) {
              return
            }
            handleError(error, '更新画布失败')
          }
        },

        deleteCanvas: async (id) => {
          const state = get()

          // 保存原始状态用于回滚
          const originalCanvases = state.canvases

          // 乐观更新：立即从本地状态移除画布
          set((state) => ({
            canvases: state.canvases.filter((c) => c.id !== id),
          }))

          try {
            // 后台执行API请求
            await api.deleteCanvas(id)
          } catch (error) {
            // N9: 回滚前检查当前引用——若失败前有其他操作替换过 canvases 数组,
            // 全量覆盖会丢失中间变更;此时合并回滚(只恢复被删项)
            set((state) => {
              if (state.canvases === originalCanvases) {
                return { canvases: originalCanvases }
              }
              const missing = originalCanvases.filter(
                (c) => c.id === id && !state.canvases.some((cur) => cur.id === c.id)
              )
              return missing.length > 0 ? { canvases: [...state.canvases, ...missing] } : {}
            })

            handleError(error, '删除画布失败')
          }
        },

        moveCanvasToFolder: async (canvasId, folderId, silent = false) => {
          const canvas = get().canvases.find(c => c.id === canvasId)
          if (!canvas) return
          const originalFolderId = canvas.folderId

          // 乐观更新（silent 与非 silent 行为一致，合并两分支）
          set((state) => ({
            canvases: state.canvases.map((c) => (c.id === canvasId ? { ...c, folderId } : c)),
          }))

          try {
            await api.updateCanvas(canvasId, { folderId })
          } catch (error) {
            // N4: silent 与非 silent 一致回滚——失败不恢复 folderId 会让本地
            // UI 与服务器不一致(刷新后画布"跳回"原文件夹,更困惑)。
            // 拖拽到根目录等静默更新失败同样需要恢复本地状态
            const canvases = get().canvases
            set((_state) => ({
              canvases: canvases.map((c) => (c.id === canvasId ? { ...c, folderId: originalFolderId } : c)),
            }))
            if (!silent) {
              handleError(error, '移动画布失败')
            }
          }
        },

        createFolder: async (projectId, data) => {
          // 生成临时ID
          const tempId = -Date.now()

          // 创建临时文件夹对象
          const tempFolder = {
            id: tempId,
            ...data,
            projectId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            parentId: data.parentId || null,
            children: []
          }

          // 乐观更新：立即添加到本地状态
          set((state) => ({
            folders: [...state.folders, tempFolder],
          }))

          try {
            // 后台执行API请求
            const folder = await api.createFolder(projectId, data)

            // 用真实数据替换临时文件夹
            set((state) => ({
              folders: state.folders.map(f => f.id === tempId ? folder : f),
            }))
          } catch (error) {
            // API失败：从本地状态移除临时文件夹
            set((state) => ({
              folders: state.folders.filter(f => f.id !== tempId),
            }))

            handleError(error, '创建文件夹失败')
          }
        },

        updateFolder: async (id, data) => {
          set({ isLoading: true, loadingMessage: '正在更新文件夹...', error: null })
          try {
            const updated = await api.updateFolder(id, data)
            set((state) => ({
              folders: state.folders.map((f) => (f.id === id ? updated : f)),
              isLoading: false,
              loadingMessage: '',
            }))
          } catch (error) {
            handleError(error, '更新文件夹失败')
          }
        },

        deleteFolder: async (id) => {
          const state = get()

          // 收集所有要删除的文件夹ID（包括子文件夹）
          const folderIdsToDelete = new Set<number>()
          const queue: number[] = [id]

          while (queue.length > 0) {
            const currentId = queue.shift()!
            folderIdsToDelete.add(currentId)

            // 查找当前文件夹的所有直接子文件夹
            const children = state.folders.filter((f) => f.parentId === currentId)
            for (const child of children) {
              queue.push(child.id)
            }
          }

          // 保存原始状态用于回滚
          const originalFolders = state.folders
          const originalCanvases = state.canvases

          // 乐观更新：立即从本地状态移除文件夹和相关画布
          set((state) => ({
            folders: state.folders.filter((f) => !folderIdsToDelete.has(f.id)),
            canvases: state.canvases.filter((c) => !folderIdsToDelete.has(c.folderId ?? null)),
          }))

          try {
            // 后台执行API请求
            await api.deleteFolder(id)
          } catch (error) {
            // N9: 回滚前检查当前引用——若失败前有其他操作替换过数组,全量覆盖
            // 会丢失中间变更;此时合并回滚(只恢复被删的文件夹及其画布)
            set((state) => {
              if (state.folders === originalFolders && state.canvases === originalCanvases) {
                return { folders: originalFolders, canvases: originalCanvases }
              }
              const missingFolders = originalFolders.filter(
                (f) => folderIdsToDelete.has(f.id) && !state.folders.some((cur) => cur.id === f.id)
              )
              const missingCanvases = originalCanvases.filter(
                (c) => c.folderId !== null && folderIdsToDelete.has(c.folderId) && !state.canvases.some((cur) => cur.id === c.id)
              )
              return {
                ...(missingFolders.length > 0 ? { folders: [...state.folders, ...missingFolders] } : {}),
                ...(missingCanvases.length > 0 ? { canvases: [...state.canvases, ...missingCanvases] } : {}),
              }
            })

            handleError(error, '删除文件夹失败')
          }
        },

        addToNodePool: async (data) => {
          // 生成临时ID
          const tempId = -Date.now()

          // 创建临时节点卡片对象
          const tempCard = {
            id: tempId,
            userId: 0, // Will be set by server
            ...data,
            createdAt: new Date().toISOString(),
            useCount: 0
          }

          // 乐观更新：立即添加到本地状态
          set((state) => ({
            nodePool: [...state.nodePool, tempCard],
          }))

          try {
            // 后台执行API请求
            const card = await api.addToNodePool(data)

            // 用真实数据替换临时卡片
            set((state) => ({
              nodePool: state.nodePool.map(c => c.id === tempId ? card : c),
            }))

            return card
          } catch (error) {
            // API失败：从本地状态移除临时卡片
            set((state) => ({
              nodePool: state.nodePool.filter(c => c.id !== tempId),
            }))

            // handleError 内部会 throw，此处不再重复抛错（C13 统一错误处理）
            handleError(error, '添加到节点池失败')
          }
        },

        removeFromNodePool: async (id) => {
          const state = get()

          // 保存原始状态用于回滚
          const originalNodePool = state.nodePool

          // 乐观更新：立即从本地状态移除节点卡片
          set((state) => ({
            nodePool: state.nodePool.filter((c) => c.id !== id),
          }))

          try {
            // 后台执行API请求
            await api.removeFromNodePool(id)
          } catch (error) {
            // API失败：回滚到原始状态
            set((_state) => ({
              nodePool: originalNodePool,
            }))

            handleError(error, '从节点池移除失败')
          }
        },

        updateNodeCard: async (id, data) => {
          set({ isLoading: true, loadingMessage: '正在更新节点卡片...', error: null })
          try {
            const updated = await api.updateNodeCard(id, data)
            set((state) => ({
              nodePool: state.nodePool.map((c) => (c.id === id ? updated : c)),
              isLoading: false,
              loadingMessage: '',
            }))
          } catch (error) {
            handleError(error, '更新节点卡片失败')
          }
        },

        incrementNodeCardUseCount: async (id) => {
          try {
            const updated = await api.incrementNodeCardUseCount(id)
            set((state) => ({
              nodePool: state.nodePool.map((c) => (c.id === id ? updated : c)),
            }))
          } catch (error) {
            // Silently fail for non-critical operation
          }
        },

        setNodePoolSortBy: (sortBy) => set({ nodePoolSortBy: sortBy }),

        setNodePoolSortOrder: (order) => set({ nodePoolSortOrder: order }),

        createNodePoolFolder: async (data) => {
          set({ isLoading: true, loadingMessage: '正在创建节点池文件夹...', error: null })
          try {
            const folder = await api.createNodePoolFolder(data)
            set((state) => ({
              nodePoolFolders: [...state.nodePoolFolders, folder],
              isLoading: false,
              loadingMessage: '',
            }))
          } catch (error) {
            handleError(error, '创建节点池文件夹失败')
          }
        },

        updateNodePoolFolder: async (id, data) => {
          set({ isLoading: true, loadingMessage: '正在更新节点池文件夹...', error: null })
          try {
            const updated = await api.updateNodePoolFolder(id, data)
            set((state) => ({
              nodePoolFolders: state.nodePoolFolders.map((f) =>
                f.id === id ? { ...f, ...updated } : f
              ),
              isLoading: false,
              loadingMessage: '',
            }))
          } catch (error) {
            handleError(error, '更新节点池文件夹失败')
          }
        },

        deleteNodePoolFolder: async (id) => {
          set({ isLoading: true, loadingMessage: '正在删除节点池文件夹...', error: null })
          try {
            await api.deleteNodePoolFolder(id)
            set((state) => ({
              nodePoolFolders: state.nodePoolFolders.filter((f) => f.id !== id),
              isLoading: false,
              loadingMessage: '',
            }))
          } catch (error) {
            handleError(error, '删除节点池文件夹失败')
          }
        },

        toggleNodePoolFolderCollapsed: (id) => {
          set((state) => ({
            nodePoolFolders: state.nodePoolFolders.map((f) =>
              f.id === id ? { ...f, collapsed: !f.collapsed } : f
            ),
          }))
        },

        reorderNodePoolFolders: async (updates) => {
          const originalFolders = get().nodePoolFolders
          const folders = get().nodePoolFolders
          const updatedFolders = folders.map(f => {
            const update = updates.find(u => u.id === f.id)
            return update ? { ...f, sortOrder: update.sortOrder } : f
          })
          set({ nodePoolFolders: updatedFolders })

          // N11: Promise.allSettled 替代 Promise.all——单个 update 失败不再全量
          // 回滚(服务器部分成功时全退会让刷新后顺序与本地不一致),
          // 服务器已成功的项保留新顺序,失败项回退原顺序
          const settled = await Promise.allSettled(
            updates.map(u => api.updateNodePoolFolder(u.id, { sortOrder: u.sortOrder }))
          )
          const failed = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          if (failed.length > 0) {
            const failedIds = new Set(
              updates.filter((_, i) => settled[i].status === 'rejected').map(u => u.id)
            )
            set((state) => ({
              nodePoolFolders: state.nodePoolFolders.map(f =>
                failedIds.has(f.id) ? (originalFolders.find(o => o.id === f.id) ?? f) : f
              ),
            }))
            handleError(failed[0].reason, '重新排序节点池文件夹失败')
          }
        },

        reorderNodeCards: async (updates) => {
          const originalNodePool = get().nodePool
          const nodePool = get().nodePool
          const updatedCards = nodePool.map(c => {
            const update = updates.find(u => u.id === c.id)
            return update ? { ...c, sortOrder: update.sortOrder } : c
          })
          set({ nodePool: updatedCards })

          // N11: Promise.allSettled 替代 Promise.all——单个 update 失败不再全量
          // 回滚(服务器部分成功时全退会让刷新后顺序与本地不一致),
          // 服务器已成功的项保留新顺序,失败项回退原顺序
          const settled = await Promise.allSettled(
            updates.map(u => api.updateNodeCard(u.id, { sortOrder: u.sortOrder }))
          )
          const failed = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          if (failed.length > 0) {
            const failedIds = new Set(
              updates.filter((_, i) => settled[i].status === 'rejected').map(u => u.id)
            )
            set((state) => ({
              nodePool: state.nodePool.map(c =>
                failedIds.has(c.id) ? (originalNodePool.find(o => o.id === c.id) ?? c) : c
              ),
            }))
            handleError(failed[0].reason, '重新排序节点卡片失败')
          }
        },

        clearError: () => set({ error: null }),

        // N5: 重置内存态(登出/换账号时调用,防止上一账号的 projects/canvases
        // 等数据残留渲染)。持久化的 currentProjectId 一并清空,避免新账号
        // 恢复旧账号的项目。偏好类字段(nodePoolSortBy/SortOrder/projectFilters)
        // 属于设备级设置,不在重置范围
        reset: () => set({
          projects: [],
          currentProject: null,
          currentProjectId: null,
          currentMemberRole: null,
          canvases: [],
          folders: [],
          nodePool: [],
          nodePoolFolders: [],
          isLoading: false,
          loadingMessage: '',
          error: null,
        }),
      }
    },
    {
      name: 'projects-storage',
      partialize: (state) => ({
        currentProjectId: state.currentProjectId,
      }),
    }
  )
)
