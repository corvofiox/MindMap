import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, FolderOpen, Trash2, Edit3, Save, X, GitBranch, Users, Zap, ArrowUp, Crown, Eye, Edit2, Users2, Lock, Filter, SearchX, DownloadCloud } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useProjectsStore } from '@/store/useProjectsStore'
import { useUIStore } from '@/store/useUIStore'
import { useAuthStore } from '@/store/useAuthStore'
import type { Project } from '@/types'
import { Z_INDEX } from '@/constants'
import { addRecentProject } from '@/utils/recentProjects'

interface EditState {
  id: number | null
  name: string
  description: string
  isCollaborative: boolean
}

interface DeleteConfirmState {
  id: number | null
  name: string
}

interface CollaborativeSwitchState {
  id: number | null
  name: string
  isSwitchingToPrivate: boolean
}

export function ProjectsPage() {
  const navigate = useNavigate()
  const { projects, getFilteredProjects, loadProjects, createProject, deleteProject, updateProject, setCurrentProject, restoreCurrentProject, isLoading, loadingMessage, setProjectFilters } = useProjectsStore()
  const { addToast, nodePoolOpen, aiSidebarOpen } = useUIStore()
  const { user } = useAuthStore()

  const rightOffset = aiSidebarOpen ? '20.5rem' : nodePoolOpen ? '18.25rem' : '0'

  // 使用筛选后的项目列表
  const filteredProjects = getFilteredProjects()

  const [showNewProject, setShowNewProject] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectDesc, setNewProjectDesc] = useState('')
  const [newProjectCollaborative, setNewProjectCollaborative] = useState(false)
  const [editState, setEditState] = useState<EditState>({ id: null, name: '', description: '', isCollaborative: false })
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState>({ id: null, name: '' })
  const [collaborativeSwitchConfirm, setCollaborativeSwitchConfirm] = useState<CollaborativeSwitchState>({ id: null, name: '', isSwitchingToPrivate: false })

  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; project: Project | null }>({ x: 0, y: 0, project: null })
  const contextMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const init = async () => {
      await loadProjects()
      await restoreCurrentProject()
    }
    init()
  }, [loadProjects, restoreCurrentProject])

  const handleCreateProject = async () => {
    // 未登录时拒绝创建，避免 ownerId 硬编码兜底（D20）
    if (!user) {
      addToast({ type: 'warning', title: '请先登录', message: '登录后才能创建项目' })
      return
    }

    if (!newProjectName.trim()) {
      addToast({ type: 'warning', title: '需要项目名称', message: '请输入项目名称' })
      return
    }

    try {
      await createProject({
        name: newProjectName,
        description: newProjectDesc || null,
        ownerId: user.id,
        groupId: null,
        thumbnail: null,
        isPublic: false,
        isCollaborative: newProjectCollaborative,
      })
      setShowNewProject(false)
      setNewProjectName('')
      setNewProjectDesc('')
      setNewProjectCollaborative(false)
      addToast({ type: 'success', title: '项目已创建', message: '您的项目已创建成功' })
    } catch (error) {
      addToast({ type: 'error', title: '创建失败', message: error instanceof Error ? error.message : '未知错误' })
    }
  }

  const handleStartEdit = (project: Project) => {
    setEditState({
      id: project.id,
      name: project.name,
      description: project.description || '',
      isCollaborative: project.isCollaborative || false
    })
  }

  const handleSaveEdit = async (projectId: number) => {
    if (!editState.name.trim()) {
      addToast({ type: 'warning', title: '需要项目名称', message: '请输入项目名称' })
      return
    }

    const originalProject = projects.find(p => p.id === projectId)
    const wasCollaborative = originalProject?.isCollaborative || false
    const willBeCollaborative = editState.isCollaborative

    if (wasCollaborative && !willBeCollaborative) {
      setCollaborativeSwitchConfirm({
        id: projectId,
        name: editState.name,
        isSwitchingToPrivate: true
      })
      return
    }

    await performUpdateProject(projectId)
  }

  const performUpdateProject = async (projectId: number) => {
    try {
      await updateProject(projectId, {
        name: editState.name,
        description: editState.description || null,
        isCollaborative: editState.isCollaborative,
      })
      setEditState({ id: null, name: '', description: '', isCollaborative: false })
      addToast({ type: 'success', title: '项目已更新', message: '项目信息已保存' })
    } catch (error) {
      addToast({ type: 'error', title: '更新失败', message: error instanceof Error ? error.message : '未知错误' })
    }
  }

  const handleConfirmCollaborativeSwitch = async () => {
    if (!collaborativeSwitchConfirm.id) return

    try {
      await updateProject(collaborativeSwitchConfirm.id, {
        name: editState.name,
        description: editState.description || null,
        isCollaborative: false,
      })
      setEditState({ id: null, name: '', description: '', isCollaborative: false })
      setCollaborativeSwitchConfirm({ id: null, name: '', isSwitchingToPrivate: false })
      addToast({ type: 'success', title: '项目已更新', message: '项目已切换为私人项目，协作期间的数据已保留' })
    } catch (error) {
      addToast({ type: 'error', title: '更新失败', message: error instanceof Error ? error.message : '未知错误' })
    }
  }

  const handleCancelCollaborativeSwitch = () => {
    setCollaborativeSwitchConfirm({ id: null, name: '', isSwitchingToPrivate: false })
  }

  const handleCancelEdit = () => {
    setEditState({ id: null, name: '', description: '', isCollaborative: false })
  }

  const handleDeleteProject = async () => {
    if (!deleteConfirm.id) return

    try {
      await deleteProject(deleteConfirm.id)
      setDeleteConfirm({ id: null, name: '' })
      addToast({ type: 'success', title: '项目已删除', message: '项目已被删除' })
    } catch (error) {
      addToast({ type: 'error', title: '删除失败', message: error instanceof Error ? error.message : '未知错误' })
    }
  }

  const handleOpenProject = async (project: Project) => {
    if (editState.id === project.id) return
    // 记录到最近访问
    addRecentProject(project)
    await setCurrentProject(project)
    navigate(`/canvas/new`)
  }

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })
  }

  // 处理右键菜单
  const handleContextMenu = useCallback((e: React.MouseEvent, project: Project) => {
    e.preventDefault()
    // 仅对所有者显示右键菜单
    if (project.memberRole !== 'owner') return
    setContextMenu({ x: e.clientX, y: e.clientY, project })
  }, [])

  // 关闭右键菜单
  const closeContextMenu = useCallback(() => {
    setContextMenu({ x: 0, y: 0, project: null })
  }, [])

  // 处理编辑项目
  const handleEditFromContextMenu = useCallback(() => {
    if (contextMenu.project) {
      handleStartEdit(contextMenu.project)
    }
    closeContextMenu()
  }, [contextMenu.project])

  // 处理删除项目
  const handleDeleteFromContextMenu = useCallback(() => {
    if (contextMenu.project) {
      setDeleteConfirm({ id: contextMenu.project.id, name: contextMenu.project.name })
    }
    closeContextMenu()
  }, [contextMenu.project])

  // 点击外部关闭右键菜单
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        closeContextMenu()
      }
    }
    if (contextMenu.project) {
      document.addEventListener('click', handleClickOutside)
      return () => document.removeEventListener('click', handleClickOutside)
    }
  }, [contextMenu.project, closeContextMenu])

  return (
    <div
      className="h-full bg-gray-50 dark:bg-gray-900 flex flex-col transition-all duration-200"
      style={{ marginRight: rightOffset }}
    >
      {/* Loading overlay */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-100/50 dark:bg-gray-900/50 backdrop-blur-sm transition-opacity duration-300" style={{ zIndex: Z_INDEX.DIALOG }}>
          <div className="text-center bg-white dark:bg-gray-800 p-6 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700">
            <div className="inline-block animate-spin rounded-full h-10 w-10 border-4 border-gray-300 border-t-blue-500 mb-3"></div>
            <p className="text-sm font-medium text-gray-600 dark:text-gray-400">{loadingMessage || '正在处理...'}</p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-8 py-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
              我的项目
            </h1>
            <p className="text-gray-600 dark:text-gray-400 mt-1">
              创建和管理您的思维导图项目
            </p>
          </div>

          <button
            onClick={() => setShowNewProject(true)}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
          >
            <Plus className="w-5 h-5" />
            新建项目
          </button>
        </div>

        {showNewProject && (
          <div className="mt-6 p-4 bg-gray-100 dark:bg-gray-700 rounded-lg">
            <h3 className="font-medium text-gray-900 dark:text-white mb-3">创建新项目</h3>
            <div className="space-y-3">
              <input
                type="text"
                placeholder="项目名称"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500"
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && handleCreateProject()}
              />
              <textarea
                placeholder="描述（可选）"
                value={newProjectDesc}
                onChange={(e) => setNewProjectDesc(e.target.value)}
                rows={2}
                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 resize-none"
              />
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={newProjectCollaborative}
                  onChange={(e) => setNewProjectCollaborative(e.target.checked)}
                  className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">协作项目（启用实时协作功能）</span>
              </label>
              <div className="flex gap-2">
                <button
                  onClick={handleCreateProject}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
                >
                  创建
                </button>
                <button
                  onClick={() => setShowNewProject(false)}
                  className="px-4 py-2 bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 text-gray-800 dark:text-white font-medium rounded-lg transition-colors"
                >
                  取消
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Projects Grid */}
      <div className="flex-1 overflow-y-auto p-8">
        {filteredProjects.length === 0 && projects.length === 0 ? (
          // 用户没有任何项目 - 显示引导创建的空状态
          <div className="flex flex-col items-center justify-center h-full text-center max-w-2xl mx-auto">
            <div className="relative">
              <div className="absolute inset-0 bg-blue-500/10 rounded-full blur-3xl" />
              <div className="relative flex items-center justify-center w-24 h-24 mb-6">
                <FolderOpen className="w-16 h-16 text-gray-400" />
              </div>
            </div>
            <h3 className="text-2xl font-bold text-gray-900 dark:text-white mb-3">
              还没有项目
            </h3>
            <p className="text-gray-600 dark:text-gray-400 mb-8 text-base">
              开始创建您的第一个思维导图项目
            </p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8 w-full">
              <div className="bg-white dark:bg-gray-800 rounded-xl p-5 border border-gray-200 dark:border-gray-700 shadow-sm hover:shadow-md transition-shadow">
                <div className="w-10 h-10 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center mb-3 mx-auto">
                  <GitBranch className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                </div>
                <h4 className="font-semibold text-gray-900 dark:text-white mb-2 text-sm">思维导图</h4>
                <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">可视化思维结构，快速理清复杂问题</p>
              </div>

              <div className="bg-white dark:bg-gray-800 rounded-xl p-5 border border-gray-200 dark:border-gray-700 shadow-sm hover:shadow-md transition-shadow">
                <div className="w-10 h-10 rounded-lg bg-green-100 dark:bg-green-900/30 flex items-center justify-center mb-3 mx-auto">
                  <Users className="w-5 h-5 text-green-600 dark:text-green-400" />
                </div>
                <h4 className="font-semibold text-gray-900 dark:text-white mb-2 text-sm">实时协作</h4>
                <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">与团队成员同步编辑，提升工作效率</p>
              </div>

              <div className="bg-white dark:bg-gray-800 rounded-xl p-5 border border-gray-200 dark:border-gray-700 shadow-sm hover:shadow-md transition-shadow">
                <div className="w-10 h-10 rounded-lg bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center mb-3 mx-auto">
                  <Zap className="w-5 h-5 text-purple-600 dark:text-purple-400" />
                </div>
                <h4 className="font-semibold text-gray-900 dark:text-white mb-2 text-sm">快速上手</h4>
                <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">简单直观的界面，轻松创建导图</p>
              </div>
            </div>

            <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-700">
              <ArrowUp className="w-4 h-4 text-blue-500 dark:text-blue-400 animate-bounce" />
              <span>点击右上角的 <span className="font-semibold text-gray-700 dark:text-gray-300">"新建项目"</span> 按钮开始</span>
            </div>
          </div>
        ) : filteredProjects.length === 0 && projects.length > 0 ? (
          // 筛选结果为空但用户有项目 - 显示筛选无结果提示
          <div className="flex flex-col items-center justify-center h-full text-center max-w-md mx-auto">
            <div className="relative mb-6">
              <div className="absolute inset-0 bg-gray-500/10 rounded-full blur-2xl" />
              <div className="relative flex items-center justify-center w-20 h-20 rounded-full bg-gray-100 dark:bg-gray-800">
                <SearchX className="w-10 h-10 text-gray-400 dark:text-gray-500" />
              </div>
            </div>
            <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
              未找到符合条件的项目
            </h3>
            <p className="text-gray-500 dark:text-gray-400 mb-6 text-sm">
              当前筛选条件下没有匹配的项目，请尝试调整筛选条件
            </p>
            <button
              onClick={() => setProjectFilters({ showOwned: false, showCollaborative: false, showRecentUpdated: false })}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
            >
              <Filter className="w-4 h-4" />
              清除筛选条件
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-6 content-start">
            {filteredProjects.map((project) => {
              const isEditing = editState.id === project.id
              const isOwner = project.memberRole === 'owner'
              const isEditor = project.memberRole === 'editor'
              const isViewer = project.memberRole === 'viewer'

              return (
                <div
                  key={project.id}
                  onClick={() => handleOpenProject(project)}
                  onContextMenu={(e) => handleContextMenu(e, project)}
                  className="group bg-white dark:bg-gray-800 rounded-xl shadow-sm hover:shadow-xl transition-all duration-300 cursor-pointer border-2 border-gray-200 dark:border-gray-600 overflow-hidden hover:-translate-y-1 hover:z-10 relative flex flex-col w-[220px] h-[180px] flex-shrink-0"
                >
                  {/* 协作标识 - 所有卡片统一显示顶部条，本地项目使用透明色 */}
                  <div className={`
                    absolute top-0 left-0 right-0 h-0.5
                    ${!isOwner ? 'bg-blue-500' : 'bg-transparent'}
                  `} />

                  <div className="p-2.5 pt-3 relative bg-gradient-to-br from-white to-gray-50 dark:from-gray-800 dark:to-gray-900 flex flex-col h-full">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      {isEditing ? (
                        <>
                          <input
                            type="text"
                            value={editState.name}
                            onChange={(e) => setEditState(prev => ({ ...prev, name: e.target.value }))}
                            onClick={(e) => e.stopPropagation()}
                            className="flex-1 px-3 py-1.5 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-gray-900 dark:text-white font-semibold text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none shadow-sm min-w-0"
                            autoFocus
                          />
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              onClick={() => handleSaveEdit(project.id)}
                              className="p-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/30 transition-all duration-200 hover:scale-105"
                              title="保存"
                            >
                              <Save className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={handleCancelEdit}
                              className="p-1.5 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-600 transition-all duration-200 hover:scale-105"
                              title="取消"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="flex items-center gap-1.5 flex-1 min-w-0">
                            {project.isCollaborative ? (
                              <>
                                {isOwner ? (
                                  <Crown className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
                                ) : isEditor ? (
                                  <Edit2 className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
                                ) : (
                                  <Eye className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
                                )}
                              </>
                            ) : (
                              <Lock className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                            )}
                            <h3 className="font-semibold text-gray-900 dark:text-white text-sm truncate leading-tight tracking-tight">
                              {project.name}
                            </h3>
                          </div>
                          {isOwner ? (
                            <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300" onClick={(e) => e.stopPropagation()}>
                              <button
                                onClick={() => handleStartEdit(project)}
                                className="p-1.5 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 hover:text-indigo-600 dark:hover:text-indigo-400 transition-all duration-200 hover:scale-105"
                                title="编辑"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ) : (
                            <div
                              className="flex items-center gap-0.5 flex-shrink-0 p-1.5 rounded-lg bg-blue-50 dark:bg-blue-900/30 text-blue-500 dark:text-blue-400"
                              title="远程同步项目"
                            >
                              <DownloadCloud className="w-3.5 h-3.5" />
                            </div>
                          )}
                        </>
                      )}
                    </div>

                    {isEditing ? (
                      <div className="flex-1 min-h-0">
                        <textarea
                          value={editState.description}
                          onChange={(e) => setEditState(prev => ({ ...prev, description: e.target.value }))}
                          onClick={(e) => e.stopPropagation()}
                          className="w-full h-full px-2 py-1 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-gray-600 dark:text-gray-300 text-xs focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none shadow-sm resize-none"
                          placeholder="添加项目描述..."
                        />
                      </div>
                    ) : (
                      <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed max-h-[3.75rem] overflow-hidden line-clamp-3 break-all">
                        {project.description || '暂无描述'}
                      </p>
                    )}

                    <div className="mt-auto pt-1.5 border-t border-gray-100 dark:border-gray-700">
                      <div className="flex items-center justify-between text-[10px] text-gray-400 dark:text-gray-500 h-[18px]">
                        <div className="flex items-center gap-1">
                          <span>创建：{formatDate(project.createdAt)}</span>
                        </div>
                        {isEditing ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setEditState(prev => ({ ...prev, isCollaborative: !prev.isCollaborative }))
                            }}
                            className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-medium transition-all duration-200 ${editState.isCollaborative
                              ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                              : 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400'
                              }`}
                          >
                            <Users2 className="w-3 h-3" />
                            {editState.isCollaborative ? '协作项目' : '私人项目'}
                          </button>
                        ) : (
                          <span className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-medium ${project.isCollaborative
                            ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                            : 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400'
                            }`}>
                            <Users2 className="w-3 h-3" />
                            {project.isCollaborative ? '协作项目' : '私人项目'}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-gray-400 dark:text-gray-500 h-[18px]">
                        <span>更新：{formatDate(project.updatedAt)}</span>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {deleteConfirm.id && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" style={{ zIndex: Z_INDEX.DIALOG }}>
          <div
            className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl max-w-md w-full p-6 animate-in fade-in zoom-in duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-4 mb-4">
              <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center flex-shrink-0">
                <Trash2 className="w-6 h-6 text-red-600 dark:text-red-400" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">确认删除项目</h3>
                <p className="text-gray-600 dark:text-gray-400">此操作无法撤销</p>
              </div>
            </div>
            <p className="text-gray-700 dark:text-gray-300 mb-6">
              确定要删除项目 <span className="font-semibold text-gray-900 dark:text-white">"{deleteConfirm.name}"</span> 吗？所有关联的数据将被永久删除。
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setDeleteConfirm({ id: null, name: '' })}
                className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg font-medium transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleDeleteProject}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition-colors"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {collaborativeSwitchConfirm.isSwitchingToPrivate && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" style={{ zIndex: Z_INDEX.DIALOG }}>
          <div
            className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl max-w-md w-full p-6 animate-in fade-in zoom-in duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-4 mb-4">
              <div className="w-12 h-12 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center flex-shrink-0">
                <Lock className="w-6 h-6 text-amber-600 dark:text-amber-400" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">切换为私人项目</h3>
                <p className="text-gray-600 dark:text-gray-400">协作功能将被关闭</p>
              </div>
            </div>
            <div className="mb-6 space-y-3">
              <p className="text-gray-700 dark:text-gray-300">
                确定要将项目 <span className="font-semibold text-gray-900 dark:text-white">"{collaborativeSwitchConfirm.name}"</span> 切换为私人项目吗？
              </p>
              <div className="bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3 text-sm text-amber-700 dark:text-amber-300">
                <p className="font-medium mb-1">注意事项：</p>
                <ul className="list-disc list-inside space-y-1 text-xs">
                  <li>协作成员将无法继续编辑此项目</li>
                  <li>协作期间编辑的内容将被保留</li>
                  <li>如需再次协作，可随时切换回协作模式</li>
                </ul>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={handleCancelCollaborativeSwitch}
                className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg font-medium transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleConfirmCollaborativeSwitch}
                className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-lg font-medium transition-colors"
              >
                确认切换
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 右键菜单 */}
      {contextMenu.project && createPortal(
        <div
          ref={contextMenuRef}
          className="fixed bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 py-1 min-w-[140px] z-50"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={handleEditFromContextMenu}
            className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2 transition-colors"
          >
            <Edit3 className="w-4 h-4" />
            编辑项目
          </button>
          <div className="h-px bg-gray-200 dark:bg-gray-700 my-1" />
          <button
            onClick={handleDeleteFromContextMenu}
            className="w-full px-4 py-2 text-left text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-2 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            删除项目
          </button>
        </div>,
        document.body
      )}
    </div>
  )
}
