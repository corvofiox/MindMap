import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Project, Canvas, Folder, NodeCard, NodePoolFolder, NodePoolSortOption, NodePoolSortOrder } from '@/types'
import * as api from '@/services/api'

interface ProjectsState {
  projects: Project[]
  currentProject: Project | null
  currentProjectId: number | null  // 持久化项目ID
  canvases: Canvas[]
  folders: Folder[]
  nodePool: NodeCard[]
  nodePoolFolders: NodePoolFolder[]
  nodePoolSortBy: NodePoolSortOption
  nodePoolSortOrder: NodePoolSortOrder
  isLoading: boolean
  loadingMessage: string  // 当前加载操作的提示信息
  error: string | null

  // Actions
  loadProjects: () => Promise<void>
  setCurrentProject: (project: Project | null) => Promise<void>
  restoreCurrentProject: () => Promise<void>  // 恢复上次的项目
  loadCanvases: (projectId: number) => Promise<void>
  loadFolders: (projectId: number) => Promise<void>
  loadNodePool: (projectId: number) => Promise<void>
  loadNodePoolFolders: (projectId: number) => Promise<void>
  createProject: (data: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>
  updateProject: (id: number, data: Partial<Project>) => Promise<void>
  deleteProject: (id: number) => Promise<void>

  // Canvas actions
  createCanvas: (projectId: number, data: Partial<Canvas>) => Promise<Canvas | null>
  updateCanvas: (id: number, data: Partial<Canvas>, silent?: boolean) => Promise<void>
  deleteCanvas: (id: number) => Promise<void>
  moveCanvasToFolder: (canvasId: number, folderId: number | null, silent?: boolean) => Promise<void>

  // Folder actions
  createFolder: (projectId: number, data: Omit<Folder, 'id' | 'createdAt'>) => Promise<void>
  updateFolder: (id: number, data: Partial<Folder>) => Promise<void>
  deleteFolder: (id: number) => Promise<void>

  // Node pool actions
  addToNodePool: (projectId: number, data: Omit<NodeCard, 'id' | 'createdAt' | 'useCount'>) => Promise<NodeCard>
  removeFromNodePool: (id: number) => Promise<void>
  updateNodeCard: (id: number, data: Partial<NodeCard>) => Promise<void>
  incrementNodeCardUseCount: (id: number) => Promise<void>
  setNodePoolSortBy: (sortBy: NodePoolSortOption) => void
  setNodePoolSortOrder: (order: NodePoolSortOrder) => void

  // Node pool folder actions
  createNodePoolFolder: (projectId: number, data: Omit<NodePoolFolder, 'id' | 'createdAt' | 'children'>) => Promise<void>
  updateNodePoolFolder: (id: number, data: Partial<NodePoolFolder>) => Promise<void>
  deleteNodePoolFolder: (id: number) => Promise<void>
  toggleNodePoolFolderCollapsed: (id: number) => void

  // Batch sort order updates
  reorderNodePoolFolders: (updates: Array<{ id: number; sortOrder: number }>) => Promise<void>
  reorderNodeCards: (updates: Array<{ id: number; sortOrder: number }>) => Promise<void>

  clearError: () => void
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
        canvases: [],
        folders: [],
        nodePool: [],
        nodePoolFolders: [],
        nodePoolSortBy: 'createdAt',
        nodePoolSortOrder: 'desc',
        isLoading: false,
        loadingMessage: '',
        error: null,

        loadProjects: async () => {
          set({ isLoading: true, loadingMessage: '正在加载项目...', error: null })
          try {
            const projects = await api.getProjects()
            set({ projects, isLoading: false, loadingMessage: '' })
          } catch (error) {
            handleError(error, '加载项目失败')
          }
        },

        setCurrentProject: async (project) => {
          set({
            currentProject: project,
            currentProjectId: project?.id || null
          })
          if (project) {
            await Promise.all([
              get().loadCanvases(project.id),
              get().loadFolders(project.id),
              get().loadNodePool(project.id),
              get().loadNodePoolFolders(project.id),
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

        loadFolders: async (projectId) => {
          set({ isLoading: true, loadingMessage: '正在加载文件夹...', error: null })
          try {
            const folders = await api.getFolders(projectId)
            set({ folders, isLoading: false, loadingMessage: '' })
          } catch (error) {
            handleError(error, '加载文件夹失败')
          }
        },

        loadNodePoolFolders: async (projectId) => {
          set({ isLoading: true, loadingMessage: '正在加载节点池...', error: null })
          try {
            const folders = await api.getNodePoolFolders(projectId)
            set({ nodePoolFolders: folders, isLoading: false, loadingMessage: '' })
          } catch (error) {
            handleError(error, '加载节点池文件夹失败')
          }
        },

        loadNodePool: async (projectId) => {
          set({ isLoading: true, loadingMessage: '正在加载节点池...', error: null })
          try {
            const nodePool = await api.getNodePool(projectId)
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
            
            handleError(error, '创建画布失败')
            return null
          }
        },

        updateCanvas: async (id, data, silent = false) => {
          if (!silent) {
            set({ isLoading: true, loadingMessage: '正在更新画布...', error: null })
          }
          try {
            const updated = await api.updateCanvas(id, data)
            set((state) => ({
              canvases: state.canvases.map((c) => (c.id === id ? updated : c)),
              isLoading: silent ? state.isLoading : false,
              loadingMessage: silent ? state.loadingMessage : '',
            }))
          } catch (error) {
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
            // API失败：回滚到原始状态
            set((state) => ({
              canvases: originalCanvases,
            }))
            
            handleError(error, '删除画布失败')
          }
        },

        moveCanvasToFolder: async (canvasId, folderId, silent = false) => {
          const canvas = get().canvases.find(c => c.id === canvasId)
          if (!canvas) return
          const originalFolderId = canvas.folderId

          if (!silent) {
            set((state) => ({
              canvases: state.canvases.map((c) => (c.id === canvasId ? { ...c, folderId } : c)),
            }))
          } else {
            set((state) => ({
              canvases: state.canvases.map((c) => (c.id === canvasId ? { ...c, folderId } : c)),
            }))
          }

          try {
            await api.updateCanvas(canvasId, { folderId })
          } catch (error) {
            if (!silent) {
              set((state) => ({
                canvases: state.canvases.map((c) => (c.id === canvasId ? { ...c, folderId: originalFolderId } : c)),
              }))
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
            canvases: state.canvases.filter((c) => !folderIdsToDelete.has(c.folderId!)),
          }))
          
          try {
            // 后台执行API请求
            await api.deleteFolder(id)
          } catch (error) {
            // API失败：回滚到原始状态
            set((state) => ({
              folders: originalFolders,
              canvases: originalCanvases,
            }))
            
            handleError(error, '删除文件夹失败')
          }
        },

        addToNodePool: async (projectId, data) => {
          // 生成临时ID
          const tempId = -Date.now()
          
          // 创建临时节点卡片对象
          const tempCard = {
            id: tempId,
            ...data,
            projectId,
            createdAt: new Date().toISOString(),
            useCount: 0
          }
          
          // 乐观更新：立即添加到本地状态
          set((state) => ({
            nodePool: [...state.nodePool, tempCard],
          }))
          
          try {
            // 后台执行API请求
            const card = await api.addToNodePool(projectId, data)
            
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
            
            handleError(error, '添加到节点池失败')
            throw error
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
            set((state) => ({
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

        createNodePoolFolder: async (projectId, data) => {
          set({ isLoading: true, loadingMessage: '正在创建节点池文件夹...', error: null })
          try {
            const folder = await api.createNodePoolFolder(projectId, data)
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
          const folders = get().nodePoolFolders
          const updatedFolders = folders.map(f => {
            const update = updates.find(u => u.id === f.id)
            return update ? { ...f, sortOrder: update.sortOrder } : f
          })
          set({ nodePoolFolders: updatedFolders })

          try {
            await Promise.all(
              updates.map(u => api.updateNodePoolFolder(u.id, { sortOrder: u.sortOrder }))
            )
          } catch (error) {
            handleError(error, '重新排序节点池文件夹失败')
          }
        },

        reorderNodeCards: async (updates) => {
          const nodePool = get().nodePool
          const updatedCards = nodePool.map(c => {
            const update = updates.find(u => u.id === c.id)
            return update ? { ...c, sortOrder: update.sortOrder } : c
          })
          set({ nodePool: updatedCards })

          try {
            await Promise.all(
              updates.map(u => api.updateNodeCard(u.id, { sortOrder: u.sortOrder }))
            )
          } catch (error) {
            handleError(error, '重新排序节点卡片失败')
          }
        },

        clearError: () => set({ error: null }),
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
