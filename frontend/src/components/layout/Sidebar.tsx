import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Plus, Folder, FolderOpen, FolderPlus, FileText, Trash2, MoreVertical, Edit2, Check, X, FolderKanban, Calendar, ChevronRight, ChevronDown, Crown, Eye, Edit3, Users, BarChart3, Filter, Tag, Clock, PieChart, Lock } from 'lucide-react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useProjectsStore } from '@/store/useProjectsStore'
import { useUIStore } from '@/store/useUIStore'
import { useCanvasStore } from '@/store/useCanvasStore'
import clsx from 'clsx'
import { createPortal } from 'react-dom'
import { Z_INDEX } from '@/constants'
import { getRecentProjects, formatRelativeTime, type RecentProject } from '@/utils/recentProjects'

interface SidebarProps {
  open: boolean
}

export function Sidebar({ open }: SidebarProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const canvasIdMatch = location.pathname.match(/\/canvas\/(\d+)/)
  const activeCanvasId = canvasIdMatch ? parseInt(canvasIdMatch[1]) : null
  const { projects, projectFilters, setProjectFilters, getFilteredProjects, canvases, folders, currentProject, createCanvas, createFolder, updateProject, deleteProject, setCurrentProject, loadProjects, moveCanvasToFolder, isLoading, loadingMessage, currentMemberRole, loadCanvases, refreshCanvasesSilent } = useProjectsStore()
  const { addToast } = useUIStore()
  const { setCanvasId } = useCanvasStore()

  const isViewer = currentMemberRole === 'viewer'

  const isProjectsPage = location.pathname === '/projects'

  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<number>>(new Set())

  const [draggedCanvasId, setDraggedCanvasId] = useState<number | null>(null)
  const [dragOverFolderId, setDragOverFolderId] = useState<number | null>(null)
  const [isRootDragOver, setIsRootDragOver] = useState(false)

  const [editingProjectId, setEditingProjectId] = useState<number | null>(null)
  const [editProjectName, setEditProjectName] = useState('')
  const [editProjectDesc, setEditProjectDesc] = useState('')
  const [showProjectMenu, setShowProjectMenu] = useState<number | null>(null)
  const projectMenuRef = useRef<HTMLDivElement>(null)

  const [showNewFolderInput, setShowNewFolderInput] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')

  useEffect(() => {
    if (!currentProject?.id) return

    const interval = setInterval(() => {
      refreshCanvasesSilent(currentProject.id)
    }, 5000)

    return () => clearInterval(interval)
  }, [currentProject?.id, refreshCanvasesSilent])

  // 计算项目统计数据
  const projectStats = useMemo(() => {
    const total = projects.length
    const owned = projects.filter(p => p.memberRole === 'owner').length
    const collaborative = projects.filter(p => p.isCollaborative).length
    const oneWeekAgo = new Date()
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7)
    oneWeekAgo.setHours(0, 0, 0, 0)
    const recentUpdated = projects.filter(p => {
      const updatedAt = new Date(p.updatedAt)
      if (isNaN(updatedAt.getTime())) return false
      return updatedAt >= oneWeekAgo
    }).length
    return { total, owned, collaborative, recentUpdated }
  }, [projects])

  // 获取筛选后的项目数量
  const filteredProjectCount = useMemo(() => {
    return getFilteredProjects().length
  }, [projects, projectFilters, getFilteredProjects])

  // 最近访问的项目（过滤掉已删除的项目）
  const recentProjects = useMemo(() => {
    if (!isProjectsPage) return []
    const allRecent = getRecentProjects()
    // 只保留仍然存在的项目
    return allRecent.filter(recent => projects.some(p => p.id === recent.id))
  }, [isProjectsPage, projects])

  // 处理打开最近访问的项目
  const handleOpenRecentProject = (recentProject: RecentProject) => {
    const project = projects.find(p => p.id === recentProject.id)
    if (project) {
      setCurrentProject(project)
      navigate(`/canvas/new`)
    }
  }

  const rootCanvases = canvases.filter((c) => !c.folderId)

  const handleCreateCanvas = async () => {
    if (!currentProject) {
      addToast({ type: 'warning', title: '未选择项目', message: '请先选择一个项目' })
      return
    }

    try {
      await createCanvas(currentProject.id, {
        name: `未命名画布 ${canvases.length + 1}`,
        projectId: currentProject.id,
      })
    } catch (error) {
      addToast({ type: 'error', title: '创建画布失败', message: error instanceof Error ? error.message : '未知错误' })
    }
  }

  const handleCreateFolder = async () => {
    const name = newFolderName.trim()
    if (!name) {
      addToast({ type: 'warning', title: '名称不能为空', message: '请输入文件夹名称' })
      return
    }

    if (!currentProject) {
      addToast({ type: 'warning', title: '未选择项目', message: '请先选择一个项目' })
      return
    }

    try {
      await createFolder(currentProject.id, {
        name,
        projectId: currentProject.id,
        parentId: null,
        sortOrder: folders.length,
      })
      setNewFolderName('')
      setShowNewFolderInput(false)
    } catch (error) {
      addToast({ type: 'error', title: '创建文件夹失败', message: error instanceof Error ? error.message : '未知错误' })
    }
  }

  // 切换文件夹展开状态
  const handleToggleFolder = (folderId: number) => {
    setExpandedFolderIds(prev => {
      const newSet = new Set(prev)
      if (newSet.has(folderId)) {
        newSet.delete(folderId)
      } else {
        newSet.add(folderId)
      }
      return newSet
    })
  }

  // 拖拽结束
  const handleDragEnd = () => {
    setDraggedCanvasId(null)
    setDragOverFolderId(null)
    setIsRootDragOver(false)
  }

  // 拖拽进入文件夹
  const handleDragOverFolder = (e: React.DragEvent, folderId: number) => {
    e.preventDefault()
    e.stopPropagation()
    if (draggedCanvasId) {
      setDragOverFolderId(folderId)
      setIsRootDragOver(false)
    }
  }

  // 拖拽离开文件夹
  const handleDragLeaveFolder = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOverFolderId(null)
    // 恢复根目录区域的高亮状态
    if (draggedCanvasId) {
      setIsRootDragOver(true)
    }
  }

  // 拖拽进入根目录
  const handleDragOverRoot = (e: React.DragEvent) => {
    e.preventDefault()
    if (draggedCanvasId && !dragOverFolderId) {
      setIsRootDragOver(true)
    }
  }

  // 拖拽离开根目录
  const handleDragLeaveRoot = (e: React.DragEvent) => {
    e.preventDefault()
    setIsRootDragOver(false)
  }

  // 拖拽放置到文件夹
  const handleDropOnFolder = (e: React.DragEvent, folderId: number) => {
    e.preventDefault()
    e.stopPropagation()
    if (draggedCanvasId) {
      const canvas = canvases.find(c => c.id === draggedCanvasId)
      if (canvas && canvas.folderId === folderId) {
        // 画布已经在该文件夹内，不触发移动
        setDraggedCanvasId(null)
        setDragOverFolderId(null)
        return
      }
      // 乐观更新：立即更新UI状态
      moveCanvasToFolder(draggedCanvasId, folderId, true)
    }
    setDraggedCanvasId(null)
    setDragOverFolderId(null)
  }

  // 拖拽放置到根目录
  const handleDropOnRoot = (e: React.DragEvent) => {
    e.preventDefault()
    if (draggedCanvasId) {
      const canvas = canvases.find(c => c.id === draggedCanvasId)
      if (canvas && canvas.folderId === null) {
        // 画布已经在根目录，不触发移动
        setDraggedCanvasId(null)
        setDragOverFolderId(null)
        setIsRootDragOver(false)
        return
      }
      // 乐观更新：立即更新UI状态
      moveCanvasToFolder(draggedCanvasId, null, true)
    }
    setDraggedCanvasId(null)
    setDragOverFolderId(null)
    setIsRootDragOver(false)
  }

  // 检测拖拽释放位置并处理
  const handleGlobalDragEnd = useCallback((e: DragEvent) => {
    if (!draggedCanvasId) return

    // 移除全局监听器
    document.removeEventListener('dragend', handleGlobalDragEnd)
    document.removeEventListener('dragover', handleGlobalDragOver)

    // 检查释放位置是否在 sidebar 内容区域内
    const target = e.target as HTMLElement
    const sidebar = document.querySelector('[data-sidebar-content]')
    if (sidebar && sidebar.contains(target)) {
      // 释放在 sidebar 内但不是文件夹上，则移动到根目录
      const folderElement = target.closest('[data-folder-item]')
      if (!folderElement) {
        const canvas = canvases.find(c => c.id === draggedCanvasId)
        if (canvas && canvas.folderId === null) {
          // 画布已经在根目录，不触发移动
          setDraggedCanvasId(null)
          setDragOverFolderId(null)
          setIsRootDragOver(false)
          return
        }
        // 乐观更新：立即更新UI状态
        moveCanvasToFolder(draggedCanvasId, null, true)
      }
    }

    setDraggedCanvasId(null)
    setDragOverFolderId(null)
    setIsRootDragOver(false)
  }, [draggedCanvasId, canvases])

  // 全局拖拽结束处理
  const handleGlobalDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
  }, [])

  // 包装拖拽开始以添加全局监听
  const handleDragStartWithGlobal = (canvasId: number) => {
    setDraggedCanvasId(canvasId)
    document.addEventListener('dragend', handleGlobalDragEnd)
    document.addEventListener('dragover', handleGlobalDragOver)
  }

  // 加载项目列表
  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  // 点击外部关闭项目菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (projectMenuRef.current && !projectMenuRef.current.contains(event.target as Node)) {
        setShowProjectMenu(null)
      }
    }

    if (showProjectMenu !== null) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showProjectMenu])

  const handleSelectProject = async (project: any) => {
    await setCurrentProject(project)
    navigate(`/canvas/new`)
  }

  const handleBackToProjects = () => {
    setCurrentProject(null)
    setCanvasId(null)
    navigate('/projects')
  }

  const handleStartEditProject = (project: any) => {
    setEditProjectName(project.name)
    setEditProjectDesc(project.description || '')
    setEditingProjectId(project.id)
    setShowProjectMenu(null)
  }

  const handleSaveProject = async () => {
    if (!editProjectName.trim()) {
      addToast({ type: 'warning', title: '名称不能为空', message: '请输入项目名称' })
      return
    }

    if (!editingProjectId) return

    try {
      await updateProject(editingProjectId, {
        name: editProjectName.trim(),
        description: editProjectDesc.trim() || null,
      })
      addToast({ type: 'success', title: '已更新', message: '项目信息已更新' })
      setEditingProjectId(null)
    } catch (error) {
      addToast({ type: 'error', title: '更新失败', message: error instanceof Error ? error.message : '未知错误' })
    }
  }

  const handleCancelEditProject = () => {
    setEditingProjectId(null)
    setEditProjectName('')
    setEditProjectDesc('')
  }

  const handleDeleteProject = async (project: any) => {
    if (!confirm(`确定要删除项目"${project.name}"吗？项目内的所有画布和文件夹也将被删除。此操作不可恢复。`)) {
      return
    }

    try {
      await deleteProject(project.id)
      addToast({ type: 'success', title: '已删除', message: '项目已被删除' })
      setShowProjectMenu(null)
    } catch (error) {
      addToast({ type: 'error', title: '删除失败', message: error instanceof Error ? error.message : '未知错误' })
    }
  }

  return (
    <>
      {/* Loading overlay - Fixed position to cover screen */}
      {isLoading && (
        <div className="fixed inset-0 flex items-center justify-center bg-gray-100/50 dark:bg-gray-900/50 backdrop-blur-sm transition-opacity duration-300" style={{ zIndex: Z_INDEX.DIALOG }}>
          <div className="text-center bg-white dark:bg-gray-800 p-6 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700">
            <div className="inline-block animate-spin rounded-full h-10 w-10 border-4 border-gray-300 border-t-blue-500 mb-3" />
            <p className="text-sm font-medium text-gray-600 dark:text-gray-400">{loadingMessage || '正在处理...'}</p>
          </div>
        </div>
      )}

      <aside
        className={clsx(
          'bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col transition-all duration-200 overflow-hidden fixed left-0 top-14 h-[calc(100vh-3.5rem)] z-40',
          open ? 'w-64 transform translate-x-0' : 'w-64 transform -translate-x-full'
        )}
      >
        {isProjectsPage || !currentProject ? (
          // 项目筛选与统计面板
          <>
            <div className="relative h-14 flex-shrink-0 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
              <div className="h-full flex items-center px-4">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-md">
                    <BarChart3 className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h2 className="font-bold text-gray-900 dark:text-white text-base tracking-wide">项目概览</h2>
                    <p className="text-[10px] text-gray-500 dark:text-gray-400 font-medium tracking-wider">DASHBOARD</p>
                  </div>
                </div>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-6">
              {projects.length === 0 ? (
                <div className="text-center py-8">
                  <FolderKanban className="w-12 h-12 text-gray-400 mx-auto mb-3" />
                  <p className="text-sm text-gray-600 dark:text-gray-400">还没有项目</p>
                </div>
              ) : (
                <>
                  {/* 项目统计 */}
                  <div className="bg-gradient-to-br from-slate-50 to-gray-50 dark:from-slate-900/20 dark:to-gray-900/20 rounded-xl p-4 border border-slate-200 dark:border-slate-800/30">
                    <div className="flex items-center gap-2 mb-3">
                      <PieChart className="w-4 h-4 text-slate-600 dark:text-slate-400" />
                      <h3 className="font-semibold text-gray-900 dark:text-white text-sm">项目统计</h3>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-white dark:bg-gray-800 rounded-lg p-3 text-center shadow-sm">
                        <div className="text-2xl font-bold text-slate-700 dark:text-slate-300">{projectStats.total}</div>
                        <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-1">总项目</div>
                      </div>
                      <div className="bg-white dark:bg-gray-800 rounded-lg p-3 text-center shadow-sm">
                        <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{projectStats.owned}</div>
                        <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-1">私人项目</div>
                      </div>
                      <div className="bg-white dark:bg-gray-800 rounded-lg p-3 text-center shadow-sm">
                        <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">{projectStats.collaborative}</div>
                        <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-1">协作项目</div>
                      </div>
                      <div className="bg-white dark:bg-gray-800 rounded-lg p-3 text-center shadow-sm">
                        <div className="text-2xl font-bold text-purple-600 dark:text-purple-400">{projectStats.recentUpdated}</div>
                        <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-1">本周更新</div>
                      </div>
                    </div>
                  </div>

                  {/* 快速筛选 */}
                  <div className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-200 dark:border-gray-700">
                    <div className="flex items-center gap-2 mb-3">
                      <Filter className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                      <h3 className="font-semibold text-gray-900 dark:text-white text-sm">快速筛选</h3>
                    </div>
                    <div className="space-y-2">
                      <label className="flex items-center gap-2 cursor-pointer p-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
                        <input
                          type="checkbox"
                          checked={projectFilters.showOwned}
                          onChange={(e) => setProjectFilters({ showOwned: e.target.checked })}
                          className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                        />
                        <span className="text-sm text-gray-700 dark:text-gray-300">我拥有的项目</span>
                        <span className="ml-auto text-xs text-gray-400 dark:text-gray-500">({projectStats.owned})</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer p-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
                        <input
                          type="checkbox"
                          checked={projectFilters.showCollaborative}
                          onChange={(e) => setProjectFilters({ showCollaborative: e.target.checked })}
                          className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                        />
                        <span className="text-sm text-gray-700 dark:text-gray-300">协作项目</span>
                        <span className="ml-auto text-xs text-gray-400 dark:text-gray-500">({projectStats.collaborative})</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer p-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
                        <input
                          type="checkbox"
                          checked={projectFilters.showRecentUpdated}
                          onChange={(e) => setProjectFilters({ showRecentUpdated: e.target.checked })}
                          className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                        />
                        <span className="text-sm text-gray-700 dark:text-gray-300">最近一周更新</span>
                        <span className="ml-auto text-xs text-gray-400 dark:text-gray-500">({projectStats.recentUpdated})</span>
                      </label>
                    </div>
                    <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700">
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        当前显示: <span className="font-medium text-gray-900 dark:text-white">{filteredProjectCount}</span> 个项目
                      </div>
                    </div>
                  </div>

                  {/* 最近访问 */}
                  <div className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-200 dark:border-gray-700">
                    <div className="flex items-center gap-2 mb-3">
                      <Clock className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                      <h3 className="font-semibold text-gray-900 dark:text-white text-sm">最近访问</h3>
                    </div>
                    {recentProjects.length === 0 ? (
                      <div className="text-center py-4 text-gray-400 dark:text-gray-500 text-sm">
                        暂无访问记录
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {recentProjects.map((recentProject) => {
                          // 从 projects 数组获取最新的项目数据
                          const latestProject = projects.find(p => p.id === recentProject.id)
                          const isCollaborative = latestProject?.isCollaborative ?? recentProject.isCollaborative
                          const projectName = latestProject?.name ?? recentProject.name

                          return (
                            <div
                              key={recentProject.id}
                              onClick={() => handleOpenRecentProject(recentProject)}
                              className="flex items-center gap-2 p-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer transition-colors group"
                            >
                              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center flex-shrink-0">
                                <FolderKanban className="w-4 h-4 text-white" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1">
                                  <span className="text-sm text-gray-700 dark:text-gray-300 truncate font-medium">
                                    {projectName}
                                  </span>
                                  <span className={`text-[10px] px-1 py-0.5 rounded flex-shrink-0 ${isCollaborative
                                    ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                                    : 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400'
                                    }`}>
                                    {isCollaborative ? '协作' : '私人'}
                                  </span>
                                </div>
                                <div className="text-[10px] text-gray-400 dark:text-gray-500">
                                  {formatRelativeTime(recentProject.visitedAt)}
                                </div>
                              </div>
                              <ChevronRight className="w-4 h-4 text-gray-300 dark:text-gray-600 group-hover:text-gray-500 dark:group-hover:text-gray-400 transition-colors" />
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </>
        ) : (
          // 项目和画布管理视图
          <>
            {/* 项目信息区域 */}
            <div className="border-b border-gray-200 dark:border-gray-700">
              <div className="p-4">
                <div className="flex items-center justify-between mb-3">
                  <button
                    onClick={handleBackToProjects}
                    className="flex items-center gap-1 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
                  >
                    <FolderKanban className="w-4 h-4" />
                    返回项目列表
                  </button>
                </div>
                <div className="rounded-xl p-3 border bg-gradient-to-br from-blue-600/10 to-indigo-600/10 dark:from-blue-600/20 dark:to-indigo-600/20 border-blue-100 dark:border-blue-900/30 min-h-[100px] flex flex-col">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full animate-pulse bg-blue-500" />
                      <span className="text-[10px] font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400">
                        {currentProject?.isCollaborative ? '协作项目' : '我的项目'}
                      </span>
                    </div>
                    {currentProject?.isCollaborative ? (
                      <div className="flex items-center gap-1">
                        {currentMemberRole === 'owner' ? (
                          <Crown className="w-3.5 h-3.5 text-blue-500" />
                        ) : currentMemberRole === 'editor' ? (
                          <Edit3 className="w-3.5 h-3.5 text-blue-500" />
                        ) : (
                          <Eye className="w-3.5 h-3.5 text-blue-500" />
                        )}
                        <span className="text-[10px] font-medium text-blue-600 dark:text-blue-400">
                          {currentMemberRole === 'owner' ? '所有者' : currentMemberRole === 'editor' ? '编辑者' : '查看者'}
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1">
                        <Lock className="w-3.5 h-3.5 text-emerald-500" />
                        <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                          私人
                        </span>
                      </div>
                    )}
                  </div>
                  <h3 className="font-bold text-gray-900 dark:text-gray-100 truncate text-sm">
                    {currentProject.name}
                  </h3>
                  <p className="text-[11px] text-gray-500 dark:text-gray-400 mt-1 line-clamp-2 leading-relaxed flex-1">
                    {currentProject.description || '暂无描述'}
                  </p>
                </div>
              </div>
            </div>

            {/* 画布管理区域 */}
            <div className='flex-1 flex flex-col min-h-0'>
              <div className="relative h-12 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between px-4 flex-shrink-0">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-md">
                    <FileText className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h2 className="font-bold text-gray-900 dark:text-white text-base tracking-wide">画布管理</h2>
                    <p className="text-[10px] text-gray-500 dark:text-gray-400 font-medium tracking-wider">CANVASES</p>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {!isViewer && (
                    <>
                      <button
                        onClick={() => setShowNewFolderInput(!showNewFolderInput)}
                        className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400 transition-colors"
                        title="新建文件夹"
                      >
                        <FolderPlus className="w-4 h-4" />
                      </button>
                      <button
                        onClick={handleCreateCanvas}
                        className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-400 transition-colors"
                        title="新建画布"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* 新建文件夹输入框 */}
              {showNewFolderInput && (
                <div className="p-3 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
                  <div className="flex gap-2 items-center">
                    <input
                      type="text"
                      placeholder="文件夹名称..."
                      value={newFolderName}
                      onChange={(e) => setNewFolderName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          handleCreateFolder()
                        } else if (e.key === 'Escape') {
                          setShowNewFolderInput(false)
                          setNewFolderName('')
                        }
                      }}
                      className="flex-1 min-w-0 px-2 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 border-0 rounded focus:ring-2 focus:ring-blue-500 text-gray-800 dark:text-white"
                    />
                    <button
                      onClick={handleCreateFolder}
                      className="flex-shrink-0 px-3 py-1.5 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 whitespace-nowrap"
                    >
                      创建
                    </button>
                    <button
                      onClick={() => {
                        setShowNewFolderInput(false)
                        setNewFolderName('')
                      }}
                      className="flex-shrink-0 p-1.5 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}

              <div
                className={clsx(
                  'flex-1 overflow-y-auto custom-scrollbar p-3 transition-all duration-200',
                  isRootDragOver && !dragOverFolderId && 'bg-blue-50 dark:bg-blue-900/20'
                )}
                style={isRootDragOver && !dragOverFolderId ? {
                  border: '2px solid rgba(59, 130, 246, 0.5)',
                  borderRadius: '8px'
                } : {}}
                data-sidebar-content
                onDragOver={(e) => {
                  handleDragOverRoot(e);
                  e.stopPropagation();
                }}
                onDragLeave={handleDragLeaveRoot}
                onDrop={handleDropOnRoot}
              >
                {/* 文件夹列表 */}
                {folders
                  .filter(f => !f.parentId)
                  .sort((a, b) => a.sortOrder - b.sortOrder)
                  .map((folder) => (
                    <FolderItem
                      key={folder.id}
                      folder={folder}
                      canvases={canvases}
                      activeCanvasId={activeCanvasId}
                      isExpanded={expandedFolderIds.has(folder.id)}
                      onToggle={handleToggleFolder}
                      draggedCanvasId={draggedCanvasId}
                      dragOverFolderId={dragOverFolderId}
                      onDragOverFolder={handleDragOverFolder}
                      onDragLeaveFolder={handleDragLeaveFolder}
                      onDropOnFolder={handleDropOnFolder}
                      onDragStart={handleDragStartWithGlobal}
                      onDragEnd={handleDragEnd}
                      isViewer={isViewer}
                    />
                  ))}

                {/* 根目录画布 */}
                {rootCanvases.length > 0 ? (
                  rootCanvases
                    .sort((a, b) => a.sortOrder - b.sortOrder)
                    .map((canvas) => (
                      <CanvasItem
                        key={canvas.id}
                        canvas={canvas}
                        isActive={activeCanvasId === canvas.id}
                        isDragging={draggedCanvasId === canvas.id}
                        onDragStart={handleDragStartWithGlobal}
                        onDragEnd={handleDragEnd}
                        isViewer={isViewer}
                      />
                    ))
                ) : (
                  <div className={clsx(
                    'text-center py-4 text-sm rounded-lg transition-all duration-200',
                    isRootDragOver
                      ? 'text-blue-500 bg-blue-50 dark:bg-blue-900/20'
                      : 'text-gray-400'
                  )}>
                    暂无画布
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </aside>
    </>
  )
}

function FolderItem({
  folder,
  canvases,
  activeCanvasId,
  isExpanded,
  onToggle,
  draggedCanvasId,
  dragOverFolderId,
  onDragOverFolder,
  onDragLeaveFolder,
  onDropOnFolder,
  onDragStart,
  onDragEnd,
  isViewer,
}: {
  folder: any
  canvases: any[]
  activeCanvasId: number | null
  isExpanded: boolean
  onToggle: (folderId: number) => void
  draggedCanvasId: number | null
  dragOverFolderId: number | null
  onDragOverFolder: (e: React.DragEvent, folderId: number) => void
  onDragLeaveFolder: (e: React.DragEvent) => void
  onDropOnFolder: (e: React.DragEvent, folderId: number) => void
  onDragStart: (canvasId: number) => void
  onDragEnd: () => void
  isViewer: boolean
}) {
  const { updateFolder, deleteFolder } = useProjectsStore()
  const { addToast } = useUIStore()
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(folder.name)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭右键菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(event.target as Node)) {
        setContextMenu(null)
      }
    }

    if (contextMenu) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [contextMenu])

  // 进入编辑模式时聚焦输入框
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleToggle = () => {
    if (!isEditing) {
      onToggle(folder.id)
    }
  }

  const handleStartEdit = () => {
    setEditName(folder.name)
    setIsEditing(true)
    setContextMenu(null)
  }

  const handleSaveEdit = async () => {
    if (!editName.trim()) {
      addToast({ type: 'warning', title: '名称不能为空', message: '请输入文件夹名称' })
      return
    }

    if (editName === folder.name) {
      setIsEditing(false)
      return
    }

    try {
      await updateFolder(folder.id, { name: editName.trim() })
      addToast({ type: 'success', title: '已重命名', message: '文件夹名称已更新' })
    } catch (error) {
      addToast({ type: 'error', title: '重命名失败', message: error instanceof Error ? error.message : '未知错误' })
    }
    setIsEditing(false)
  }

  const handleCancelEdit = () => {
    setEditName(folder.name)
    setIsEditing(false)
  }

  const handleDelete = async () => {
    // Get all folders from store to count descendants
    const { folders: allFolders } = useProjectsStore.getState()

    // Count all descendant folders
    const countDescendantFolders = (parentId: number): number => {
      let count = 0
      const children = allFolders.filter((f) => f.parentId === parentId)
      for (const child of children) {
        count += 1 + countDescendantFolders(child.id)
      }
      return count
    }

    // Count canvases in this folder and all subfolders
    const countCanvasesInFolderTree = (parentId: number): number => {
      let count = canvases.filter((c) => c.folderId === parentId).length
      const children = allFolders.filter((f) => f.parentId === parentId)
      for (const child of children) {
        count += countCanvasesInFolderTree(child.id)
      }
      return count
    }

    const subfolderCount = countDescendantFolders(folder.id)
    const totalCanvasCount = countCanvasesInFolderTree(folder.id)

    // If folder is empty, delete directly without confirmation
    if (subfolderCount === 0 && totalCanvasCount === 0) {
      try {
        await deleteFolder(folder.id)
        addToast({
          type: 'success',
          title: '已删除',
          message: '文件夹已被删除',
        })
      } catch (error) {
        addToast({ type: 'error', title: '删除失败', message: error instanceof Error ? error.message : '未知错误' })
      }
      return
    }

    // If folder has content, show confirmation dialog
    const parts = []
    if (subfolderCount > 0) {
      parts.push(`${subfolderCount} 个子文件夹`)
    }
    if (totalCanvasCount > 0) {
      parts.push(`${totalCanvasCount} 个画布`)
    }
    const confirmMessage = `确定要删除文件夹"${folder.name}"吗？${parts.join('和')}也将被删除。此操作不可恢复。`

    if (!confirm(confirmMessage)) {
      return
    }

    try {
      await deleteFolder(folder.id)
      addToast({
        type: 'success',
        title: '已删除',
        message: subfolderCount > 0
          ? `文件夹及其 ${subfolderCount} 个子文件夹已被删除`
          : '文件夹已被删除',
      })
    } catch (error) {
      addToast({ type: 'error', title: '删除失败', message: error instanceof Error ? error.message : '未知错误' })
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSaveEdit()
    } else if (e.key === 'Escape') {
      handleCancelEdit()
    }
  }

  const folderCanvases = canvases.filter((c) => c.folderId === folder.id)

  return (
    <div className="mb-2">
      {isEditing ? (
        // 编辑模式
        <div className="flex items-center gap-1 px-2 py-1.5 rounded bg-blue-50 dark:bg-blue-900/30">
          <Folder className="w-4 h-4 text-gray-400 flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 min-w-0 text-sm bg-transparent border-b border-blue-500 outline-none text-gray-700 dark:text-gray-300 px-1"
          />
          <div className="flex items-center gap-0.5 flex-shrink-0">
            <button
              onClick={handleSaveEdit}
              className="p-1 rounded hover:bg-green-100 dark:hover:bg-green-900/30 text-green-600 dark:text-green-400"
              title="保存"
            >
              <Check className="w-3 h-3" />
            </button>
            <button
              onClick={handleCancelEdit}
              className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400"
              title="取消"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      ) : (
        // 查看模式
        <div className="relative group" data-folder-item>
          <div
            onClick={handleToggle}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setContextMenu({ x: e.clientX, y: e.clientY })
            }}
            onDragOver={(e) => onDragOverFolder(e, folder.id)}
            onDragLeave={onDragLeaveFolder}
            onDrop={(e) => onDropOnFolder(e, folder.id)}
            className={clsx(
              'w-full flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer transition-all duration-200',
              dragOverFolderId === folder.id
                ? 'bg-blue-100 dark:bg-blue-900/40 ring-2 ring-blue-500 ring-opacity-50 scale-[1.02] shadow-sm'
                : 'hover:bg-gray-100 dark:hover:bg-gray-700'
            )}
          >
            {folderCanvases.length > 0 && (
              <div onClick={(e) => e.stopPropagation()}>
                {isExpanded ? (
                  <ChevronDown className="w-3.5 h-3.5 text-gray-500" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-gray-500" />
                )}
              </div>
            )}
            <div onClick={(e) => e.stopPropagation()}>
              {isExpanded ? (
                <FolderOpen className={clsx('w-4 h-4', dragOverFolderId === folder.id ? 'text-blue-600' : 'text-blue-500')} />
              ) : (
                <Folder className={clsx('w-4 h-4', dragOverFolderId === folder.id ? 'text-blue-500' : 'text-gray-400 dark:text-gray-500')} />
              )}
            </div>
            <span className={clsx(
              'text-sm flex-1 truncate font-medium transition-colors duration-200',
              dragOverFolderId === folder.id ? 'text-blue-700 dark:text-blue-300' : 'text-gray-700 dark:text-gray-300'
            )}>{folder.name}</span>
            <span className={clsx(
              'text-[10px] font-bold transition-colors duration-200',
              dragOverFolderId === folder.id
                ? 'text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-900/50'
                : 'text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-700/50'
            )}>
              {folderCanvases.length}
            </span>
          </div>

          {isExpanded && (
            <div
              className={clsx(
                'ml-4 pl-3 mt-1 space-y-0.5 rounded-lg transition-all duration-200',
                dragOverFolderId === folder.id
                  ? 'bg-blue-50 dark:bg-blue-900/30 border-l-2 border-blue-400 dark:border-blue-600'
                  : 'border-l border-gray-100 dark:border-gray-700/50'
              )}
              onDragOver={(e) => onDragOverFolder(e, folder.id)}
              onDragLeave={onDragLeaveFolder}
              onDrop={(e) => onDropOnFolder(e, folder.id)}
            >
              {folderCanvases.map((canvas) => (
                <CanvasItem
                  key={canvas.id}
                  canvas={canvas}
                  isActive={activeCanvasId === canvas.id}
                  isDragging={draggedCanvasId === canvas.id}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  isViewer={isViewer}
                />
              ))}
              {folderCanvases.length === 0 && (
                <div className={clsx(
                  'text-center py-4 text-sm rounded-lg transition-all duration-200',
                  dragOverFolderId === folder.id
                    ? 'text-blue-500 bg-blue-50 dark:bg-blue-900/20'
                    : 'text-gray-400'
                )}>
                  空文件夹
                </div>
              )}
            </div>
          )}

          {/* 右键菜单 */}
          {contextMenu && createPortal(
            <div
              ref={contextMenuRef}
              className="fixed bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 min-w-[120px]"
              style={{
                left: contextMenu.x,
                top: contextMenu.y,
                zIndex: Z_INDEX.CONTEXT_MENU,
              }}
            >
              <button
                onClick={() => {
                  handleStartEdit()
                  setContextMenu(null)
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <Edit2 className="w-3 h-3" />
                重命名
              </button>
              <button
                onClick={() => {
                  handleDelete()
                  setContextMenu(null)
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30"
              >
                <Trash2 className="w-3 h-3" />
                删除
              </button>
            </div>,
            document.body
          )}
        </div>
      )}
    </div>
  )
}

function CanvasItem({
  canvas,
  isActive,
  isDragging,
  onDragStart,
  onDragEnd,
  isViewer,
}: {
  canvas: any
  isActive?: boolean
  isDragging?: boolean
  onDragStart?: (canvasId: number) => void
  onDragEnd?: () => void
  isViewer?: boolean
}) {
  const navigate = useNavigate()
  const { updateCanvas, deleteCanvas, folders } = useProjectsStore()
  const { addToast } = useUIStore()
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(canvas.name)
  const [showContextMenu, setShowContextMenu] = useState(false)
  const [showMoveMenu, setShowMoveMenu] = useState(false)
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 })
  const inputRef = useRef<HTMLInputElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(event.target as Node)) {
        setShowContextMenu(false)
        setShowMoveMenu(false)
      }
    }

    if (showContextMenu) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showContextMenu])

  // 进入编辑模式时聚焦输入框
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleStartEdit = () => {
    setEditName(canvas.name)
    setIsEditing(true)
    setShowContextMenu(false)
  }

  const handleSaveEdit = async () => {
    if (!editName.trim()) {
      addToast({ type: 'warning', title: '名称不能为空', message: '请输入画布名称' })
      return
    }

    if (editName === canvas.name) {
      setIsEditing(false)
      return
    }

    try {
      await updateCanvas(canvas.id, { name: editName.trim() }, true)
      addToast({ type: 'success', title: '已重命名', message: '画布名称已更新' })
    } catch (error) {
      addToast({ type: 'error', title: '重命名失败', message: error instanceof Error ? error.message : '未知错误' })
    }
    setIsEditing(false)
  }

  const handleCancelEdit = () => {
    setEditName(canvas.name)
    setIsEditing(false)
  }

  const handleDelete = async () => {
    if (!confirm(`确定要删除画布"${canvas.name}"吗？此操作不可恢复。`)) {
      return
    }

    try {
      await deleteCanvas(canvas.id)
      addToast({ type: 'success', title: '已删除', message: '画布已被删除' })
      setShowContextMenu(false)

      // 如果删除的是当前活跃的画布，导航到新建画布页面
      if (isActive) {
        navigate('/canvas/new')
      }
    } catch (error) {
      addToast({ type: 'error', title: '删除失败', message: error instanceof Error ? error.message : '未知错误' })
    }
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (isViewer) return
    setContextMenuPosition({ x: e.clientX, y: e.clientY })
    setShowContextMenu(true)
    setShowMoveMenu(false)
  }

  const handleMoveToFolder = async (targetFolderId: number | null) => {
    try {
      await updateCanvas(canvas.id, { folderId: targetFolderId })
      const folderName = targetFolderId ? folders.find(f => f.id === targetFolderId)?.name : '根目录'
      addToast({ type: 'success', title: '已移动', message: `画布已移动到"${folderName}"` })
      setShowContextMenu(false)
      setShowMoveMenu(false)
    } catch (error) {
      addToast({ type: 'error', title: '移动失败', message: error instanceof Error ? error.message : '未知错误' })
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSaveEdit()
    } else if (e.key === 'Escape') {
      handleCancelEdit()
    }
  }

  return (
    <div className="relative group mb-2">
      {isEditing ? (
        // 编辑模式
        <div className="p-2 rounded bg-blue-50 dark:bg-blue-900/30">
          <input
            ref={inputRef}
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={handleKeyDown}
            className="w-full text-sm bg-white dark:bg-gray-800 border border-blue-500 rounded px-2 py-1.5 outline-none text-gray-700 dark:text-gray-300 mb-2"
            placeholder="画布名称"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={handleSaveEdit}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1 text-sm bg-green-600 hover:bg-green-700 text-white rounded transition-colors"
            >
              <Check className="w-3 h-3" />
              保存
            </button>
            <button
              onClick={handleCancelEdit}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1 text-sm bg-gray-400 hover:bg-gray-500 text-white rounded transition-colors"
            >
              <X className="w-3 h-3" />
              取消
            </button>
          </div>
        </div>
      ) : (
        // 查看模式 - 缩略图卡片
        <>
          <div
            draggable={!!onDragStart && !isViewer}
            onDragStart={() => onDragStart?.(canvas.id)}
            onDragEnd={onDragEnd}
            onContextMenu={handleContextMenu}
            className={clsx(
              'relative rounded-lg border bg-white dark:bg-gray-800 hover:shadow-lg transition-all cursor-pointer group overflow-hidden',
              isActive
                ? 'border-blue-500 ring-2 ring-blue-500/20 shadow-blue-500/10'
                : 'border-gray-200 dark:border-gray-700 hover:border-blue-400 dark:hover:border-blue-500',
              isDragging && 'opacity-50 rotate-1 scale-[1.02] shadow-lg ring-2 ring-blue-400',
              onDragStart ? 'cursor-move' : 'cursor-pointer'
            )}
          >
            {isActive && (
              <div className="absolute top-2 right-2 z-10">
                <div className="bg-blue-500 text-white text-[10px] font-extrabold px-1.5 py-0.5 rounded shadow-sm flex items-center gap-1">
                  <div className="w-1 h-1 rounded-full bg-white animate-pulse" />
                  使用中
                </div>
              </div>
            )}
            {/* 缩略图区域 */}
            <div
              onClick={() => navigate(`/canvas/${canvas.id}`)}
              className="aspect-video bg-gradient-to-br from-gray-100 to-gray-200 dark:from-gray-700 dark:to-gray-800 rounded-t-lg relative overflow-hidden"
            >
              {canvas.thumbnail ? (
                <img
                  src={canvas.thumbnail}
                  alt={canvas.name}
                  className="w-full h-full object-cover"
                  onDragStart={(e) => e.preventDefault()}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <FileText className="w-8 h-8 text-gray-400 dark:text-gray-600" />
                </div>
              )}

              {/* 活跃用户指示器 */}
              {canvas.activeUsers && canvas.activeUsers.length > 0 && (
                <div className="absolute bottom-2 left-2 flex items-center gap-1 bg-black/60 backdrop-blur-sm rounded-full px-2 py-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                  <Users className="w-3 h-3 text-white" />
                  <span className="text-[10px] text-white font-medium">
                    {canvas.activeUsers.length}
                  </span>
                </div>
              )}

              {/* 悬停时的遮罩 */}
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                <span className="text-white opacity-0 group-hover:opacity-100 transition-opacity text-sm font-medium">
                  打开画布
                </span>
              </div>
            </div>

            {/* 画布信息 */}
            <div className="p-2">
              <h4
                onClick={() => navigate(`/canvas/${canvas.id}`)}
                className="text-sm font-medium text-gray-900 dark:text-white truncate pr-6"
              >
                {canvas.name}
              </h4>
              {canvas.updatedAt && (
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {new Date(canvas.updatedAt).toLocaleDateString()}
                </p>
              )}
            </div>

            {/* 右键菜单 */}
            {showContextMenu && createPortal(
              <div
                ref={contextMenuRef}
                className="fixed bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 min-w-[160px]"
                style={{
                  left: contextMenuPosition.x,
                  top: contextMenuPosition.y,
                  zIndex: Z_INDEX.CONTEXT_MENU,
                }}
                onContextMenu={(e) => e.preventDefault()}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setShowMoveMenu(!showMoveMenu)
                  }}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <div className="flex items-center gap-2">
                    <Folder className="w-3 h-3" />
                    移动到
                  </div>
                  <span className="text-gray-400">›</span>
                </button>

                {showMoveMenu && (
                  <div className="border-t border-gray-200 dark:border-gray-700">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleMoveToFolder(null)
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      <span className="w-3 h-3" />
                      根目录
                    </button>
                    {folders.map((folder) => (
                      <button
                        key={folder.id}
                        onClick={(e) => {
                          e.stopPropagation()
                          handleMoveToFolder(folder.id)
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                      >
                        <Folder className="w-3 h-3" />
                        {folder.name}
                      </button>
                    ))}
                  </div>
                )}

                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleStartEdit()
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <Edit2 className="w-3 h-3" />
                  重命名
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleDelete()
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30"
                >
                  <Trash2 className="w-3 h-3" />
                  删除
                </button>
              </div>,
              document.body
            )}
          </div>
        </>
      )}
    </div>
  )
}
