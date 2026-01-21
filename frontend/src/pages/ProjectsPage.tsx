import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, FolderOpen, Trash2, Edit3, Save, X } from 'lucide-react'
import { useProjectsStore } from '@/store/useProjectsStore'
import { useUIStore } from '@/store/useUIStore'
import { useAuthStore } from '@/store/useAuthStore'
import { Project } from '@/types'
import { Z_INDEX } from '@/constants'

interface EditState {
  id: number | null
  name: string
  description: string
}

interface DeleteConfirmState {
  id: number | null
  name: string
}

export function ProjectsPage() {
  const navigate = useNavigate()
  const { projects, loadProjects, createProject, deleteProject, updateProject, setCurrentProject, restoreCurrentProject, isLoading, loadingMessage } = useProjectsStore()
  const { addToast } = useUIStore()
  const { user } = useAuthStore()

  const [showNewProject, setShowNewProject] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectDesc, setNewProjectDesc] = useState('')
  const [editState, setEditState] = useState<EditState>({ id: null, name: '', description: '' })
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState>({ id: null, name: '' })

  useEffect(() => {
    const init = async () => {
      await loadProjects()
      await restoreCurrentProject()
    }
    init()
  }, [loadProjects, restoreCurrentProject])

  const handleCreateProject = async () => {
    if (!newProjectName.trim()) {
      addToast({ type: 'warning', title: '需要项目名称', message: '请输入项目名称' })
      return
    }

    try {
      await createProject({
        name: newProjectName,
        description: newProjectDesc || null,
        ownerId: user?.id || 1,
        groupId: null,
        thumbnail: null,
        isPublic: false,
      })
      setShowNewProject(false)
      setNewProjectName('')
      setNewProjectDesc('')
      addToast({ type: 'success', title: '项目已创建', message: '您的项目已创建成功' })
    } catch (error) {
      addToast({ type: 'error', title: '创建失败', message: error instanceof Error ? error.message : '未知错误' })
    }
  }

  const handleStartEdit = (project: Project) => {
    setEditState({ id: project.id, name: project.name, description: project.description || '' })
  }

  const handleSaveEdit = async (projectId: number) => {
    if (!editState.name.trim()) {
      addToast({ type: 'warning', title: '需要项目名称', message: '请输入项目名称' })
      return
    }

    try {
      await updateProject(projectId, {
        name: editState.name,
        description: editState.description || null,
      })
      setEditState({ id: null, name: '', description: '' })
      addToast({ type: 'success', title: '项目已更新', message: '项目信息已保存' })
    } catch (error) {
      addToast({ type: 'error', title: '更新失败', message: error instanceof Error ? error.message : '未知错误' })
    }
  }

  const handleCancelEdit = () => {
    setEditState({ id: null, name: '', description: '' })
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



  return (
    <div className="h-full bg-gray-50 dark:bg-gray-900 flex flex-col">
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
        {projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <FolderOpen className="w-16 h-16 text-gray-400 mb-4" />
            <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
              还没有项目
            </h3>
            <p className="text-gray-600 dark:text-gray-400 mb-4">
              创建您的第一个项目开始使用
            </p>
            <button
              onClick={() => setShowNewProject(true)}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
            >
              <Plus className="w-5 h-5" />
              创建项目
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {projects.map((project) => {
              const isEditing = editState.id === project.id

              return (
                <div
                  key={project.id}
                  onClick={() => handleOpenProject(project)}
                  className="group bg-white dark:bg-gray-800 rounded-xl shadow-sm hover:shadow-lg transition-all duration-300 cursor-pointer border-2 border-gray-200 dark:border-gray-600 w-full min-w-[200px] max-w-[200px] overflow-hidden hover:-translate-y-1"
                >
                  <div className="p-3 relative bg-gradient-to-br from-white to-gray-50 dark:from-gray-800 dark:to-gray-900">
                    <div className="flex items-start justify-between gap-2 mb-2">
                      {isEditing ? (
                        <input
                          type="text"
                          value={editState.name}
                          onChange={(e) => setEditState(prev => ({ ...prev, name: e.target.value }))}
                          onClick={(e) => e.stopPropagation()}
                          className="flex-1 px-3 py-1.5 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-gray-900 dark:text-white font-semibold text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none shadow-sm"
                          autoFocus
                        />
                      ) : (
                        <h3 className="font-semibold text-gray-900 dark:text-white text-sm flex-1 truncate leading-tight tracking-tight">
                          {project.name}
                        </h3>
                      )}
                      <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300" onClick={(e) => e.stopPropagation()}>
                        {isEditing ? (
                          <>
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
                          </>
                        ) : (
                          <button
                            onClick={() => handleStartEdit(project)}
                            className="p-1.5 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 hover:text-indigo-600 dark:hover:text-indigo-400 transition-all duration-200 hover:scale-105"
                            title="编辑"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    {isEditing ? (
                      <textarea
                        value={editState.description}
                        onChange={(e) => setEditState(prev => ({ ...prev, description: e.target.value }))}
                        onClick={(e) => e.stopPropagation()}
                        rows={2}
                        className="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-gray-600 dark:text-gray-300 text-xs focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none shadow-sm resize-none"
                        placeholder="添加项目描述..."
                      />
                    ) : (
                      <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed min-h-[2rem] max-h-[2rem] overflow-hidden line-clamp-2">
                        {project.description || '暂无描述'}
                      </p>
                    )}

                    <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-700 space-y-0.5">
                      <div className="flex items-center gap-1 text-[10px] text-gray-400 dark:text-gray-500">
                        <span>创建：{formatDate(project.createdAt)}</span>
                      </div>
                      <div className="flex items-center gap-1 text-[10px] text-gray-400 dark:text-gray-500">
                        <span>更新：{formatDate(project.updatedAt)}</span>
                      </div>
                    </div>

                    {/* 删除按钮 - 定位到右下角 */}
                    {!isEditing && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteConfirm({ id: project.id, name: project.name });
                        }}
                        className="absolute bottom-3 right-3 p-1.5 rounded-lg text-gray-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all duration-200 opacity-0 group-hover:opacity-100 hover:scale-110"
                        title="删除"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
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
    </div>
  )
}
