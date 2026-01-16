import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Project, Canvas, Folder, NodeCard, NodePoolFolder, NodePoolSortOption, NodePoolSortOrder } from '@/types'
import * as api from '@/services/api'
import { loadUIStore } from '@/utils/moduleLoader'

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
  createCanvas: (projectId: number, data: Partial<Canvas>) => Promise<void>
  updateCanvas: (id: number, data: Partial<Canvas>) => Promise<void>
  deleteCanvas: (id: number) => Promise<void>
  moveCanvasToFolder: (canvasId: number, folderId: number | null) => Promise<void>

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
        // Show error toast to user
        loadUIStore().then(({ useUIStore }) => {
          useUIStore.getState().addErrorToast(errorMessage, '操作失败')
        })
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
          set({ isLoading: true, loadingMessage: '正在创建画布...', error: null })
          try {
            const canvas = await api.createCanvas(projectId, data)
            set((state) => ({
              canvases: [...state.canvases, canvas],
              isLoading: false,
              loadingMessage: '',
            }))
          } catch (error) {
            handleError(error, '创建画布失败')
          }
        },

        updateCanvas: async (id, data) => {
          set({ isLoading: true, loadingMessage: '正在更新画布...', error: null })
          try {
            const updated = await api.updateCanvas(id, data)
            set((state) => ({
              canvases: state.canvases.map((c) => (c.id === id ? updated : c)),
              isLoading: false,
              loadingMessage: '',
            }))
          } catch (error) {
            handleError(error, '更新画布失败')
          }
        },

        deleteCanvas: async (id) => {
          set({ isLoading: true, loadingMessage: '正在删除画布...', error: null })
          try {
            await api.deleteCanvas(id)
            set((state) => ({
              canvases: state.canvases.filter((c) => c.id !== id),
              isLoading: false,
              loadingMessage: '',
            }))
          } catch (error) {
            handleError(error, '删除画布失败')
          }
        },

        moveCanvasToFolder: async (canvasId, folderId) => {
          set({ isLoading: true, loadingMessage: '正在移动画布...', error: null })
          try {
            await api.updateCanvas(canvasId, { folderId })
            set((state) => ({
              canvases: state.canvases.map((c) => (c.id === canvasId ? { ...c, folderId } : c)),
              isLoading: false,
              loadingMessage: '',
            }))
          } catch (error) {
            handleError(error, '移动画布失败')
          }
        },

        createFolder: async (projectId, data) => {
          set({ isLoading: true, loadingMessage: '正在创建文件夹...', error: null })
          try {
            const folder = await api.createFolder(projectId, data)
            set((state) => ({
              folders: [...state.folders, folder],
              isLoading: false,
              loadingMessage: '',
            }))
          } catch (error) {
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
          set({ isLoading: true, loadingMessage: '正在删除文件夹...', error: null })
          try {
            await api.deleteFolder(id)
            set((state) => {
              // Collect all folder IDs to delete (including subfolders)
              const folderIdsToDelete = new Set<number>()
              const queue: number[] = [id]

              while (queue.length > 0) {
                const currentId = queue.shift()!
                folderIdsToDelete.add(currentId)

                // Find all immediate children of current folder
                const children = state.folders.filter((f) => f.parentId === currentId)
                for (const child of children) {
                  queue.push(child.id)
                }
              }

              // Remove all deleted folders and their canvases
              return {
                folders: state.folders.filter((f) => !folderIdsToDelete.has(f.id)),
                canvases: state.canvases.filter((c) => !folderIdsToDelete.has(c.folderId!)),
                isLoading: false,
                loadingMessage: '',
              }
            })
          } catch (error) {
            handleError(error, '删除文件夹失败')
          }
        },

        addToNodePool: async (projectId, data) => {
          set({ isLoading: true, loadingMessage: '正在添加到节点池...', error: null })
          try {
            const card = await api.addToNodePool(projectId, data)
            set((state) => ({
              nodePool: [...state.nodePool, card],
              isLoading: false,
              loadingMessage: '',
            }))
            return card
          } catch (error) {
            handleError(error, '添加到节点池失败')
            throw error
          }
        },

        removeFromNodePool: async (id) => {
          set({ isLoading: true, loadingMessage: '正在从节点池移除...', error: null })
          try {
            await api.removeFromNodePool(id)
            set((state) => ({
              nodePool: state.nodePool.filter((c) => c.id !== id),
              isLoading: false,
              loadingMessage: '',
            }))
          } catch (error) {
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
