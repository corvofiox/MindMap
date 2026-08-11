import { useState, useCallback, useEffect, useRef } from 'react'
import { Search, X, UserPlus, Loader2, Crown, Edit3, Eye, Clock, XCircle, Check, ChevronDown, ChevronLeft, Plus } from 'lucide-react'
import { Dialog } from './Dialog'
import { useUIStore } from '@/store/useUIStore'
import { useAuthStore } from '@/store/useAuthStore'
import { useProjectsStore } from '@/store/useProjectsStore'
import {
  searchUsers,
  getProjectMembers,
  inviteUserToProject,
  removeProjectMember,
  cancelInvitation,
  updateMemberRole,
  getMyInvitations,
  acceptInvitation,
  rejectInvitation,
} from '@/services/api'
import type { User } from '@/types'
import type { ProjectMember, ProjectInvitation, MyInvitation } from '@/types'
import clsx from 'clsx'

type ViewType = 'projects' | 'members' | 'search'
type TabType = 'collaborative' | 'invitations'

interface CollaborativeProject {
  id: number
  name: string
  ownerId: number
  memberCount: number
  isOwner: boolean
}

export function CollaborationDialog() {
  const { collaborationOpen, setCollaborationOpen, addSuccessToast, addErrorToast } = useUIStore()
  const { user: currentUser } = useAuthStore()
  const { projects, loadProjects } = useProjectsStore()

  const [view, setView] = useState<ViewType>('projects')
  const [activeTab, setActiveTab] = useState<TabType>('collaborative')
  const [selectedProject, setSelectedProject] = useState<CollaborativeProject | null>(null)

  const [collaborativeProjects, setCollaborativeProjects] = useState<CollaborativeProject[]>([])
  const [isLoadingProjects, setIsLoadingProjects] = useState(false)

  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<User[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  const [members, setMembers] = useState<ProjectMember[]>([])
  const [invitations, setInvitations] = useState<ProjectInvitation[]>([])
  const [myInvitations, setMyInvitations] = useState<MyInvitation[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [roleDropdownOpen, setRoleDropdownOpen] = useState<number | null>(null)
  const [invitedUsers, setInvitedUsers] = useState<Map<number, 'editor' | 'viewer'>>(new Map())

  const loadCollaborativeProjects = useCallback(async () => {
    setIsLoadingProjects(true)
    try {
      const projectsData = projects || []
      const collaborativeList: CollaborativeProject[] = []

      for (const project of projectsData) {
        // 只显示标记为协作项目的项目
        if (!project.isCollaborative) continue

        try {
          const data = await getProjectMembers(project.id)
          const isOwner = data.ownerId === currentUser?.id

          collaborativeList.push({
            id: project.id,
            name: project.name,
            ownerId: data.ownerId,
            memberCount: data.members.length,
            isOwner,
          })
        } catch {
          // Skip projects we can't access
        }
      }

      setCollaborativeProjects(collaborativeList)
    } catch (error) {
      addErrorToast(error instanceof Error ? error.message : '加载项目列表失败')
    } finally {
      setIsLoadingProjects(false)
    }
  }, [projects, currentUser?.id, addErrorToast])

  const loadProjectMembers = useCallback(async (projectId: number) => {
    setIsLoading(true)
    try {
      const data = await getProjectMembers(projectId)
      setMembers(data.members)
      setInvitations(data.invitations)
    } catch (error) {
      addErrorToast(error instanceof Error ? error.message : '加载成员列表失败')
    } finally {
      setIsLoading(false)
    }
  }, [addErrorToast])

  const loadMyInvitations = useCallback(async () => {
    try {
      const data = await getMyInvitations()
      setMyInvitations(data)
    } catch (error) {
      // silently fail
    }
  }, [])

  useEffect(() => {
    if (collaborationOpen) {
      loadProjects()
      loadMyInvitations()
    }
  }, [collaborationOpen, loadProjects, loadMyInvitations])

  useEffect(() => {
    if (collaborationOpen && projects && projects.length > 0) {
      loadCollaborativeProjects()
    }
  }, [collaborationOpen, projects, loadCollaborativeProjects])

  useEffect(() => {
    if (selectedProject?.id) {
      loadProjectMembers(selectedProject.id)
    }
  }, [selectedProject?.id, loadProjectMembers])

  // N10: 请求序号——300ms 防抖挡不住慢响应:旧 query 的响应晚到时若已有
  // 更新的搜索请求,直接丢弃,避免旧结果覆盖新结果
  const searchSeqRef = useRef(0)

  const handleSearch = useCallback(async (query: string) => {
    if (!query.trim()) {
      // R2-2-fix: 空/纯空白 query 早退——递增 seq 使在途旧请求过期,并复位
      // isSearching。正常路径下 debounce effect 已拦截空 query(见下方 effect),
      // 此分支为防御性保留,防止未来出现绕过 effect 的调用路径时
      // 重蹈"seq 递增后旧请求 finally 失配不复位 spinner"的回归。
      ++searchSeqRef.current
      setSearchResults([])
      setSearchError(null)
      setIsSearching(false)
      return
    }

    const seq = ++searchSeqRef.current
    setIsSearching(true)
    setSearchError(null)

    try {
      const results = await searchUsers(query)
      if (seq !== searchSeqRef.current) return // 过期响应,丢弃
      const existingUserIds = new Set([
        ...members.map(m => m.userId),
        currentUser?.id,
      ])
      const filteredResults = results.filter(u => !existingUserIds.has(u.id))
      setSearchResults(filteredResults)
    } catch (error) {
      if (seq !== searchSeqRef.current) return // 过期响应,丢弃
      setSearchError(error instanceof Error ? error.message : '搜索失败')
      setSearchResults([])
    } finally {
      if (seq === searchSeqRef.current) setIsSearching(false)
    }
  }, [members, currentUser?.id])

  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchQuery.trim() && view === 'search') {
        handleSearch(searchQuery)
      } else if (!searchQuery.trim() && view === 'search') {
        // R2-2-fix: 空/纯空白 query(清空输入框)在 effect 层直接处理——
        // 递增 seq 使在途旧请求过期(旧响应 seq 失配被丢弃,不落地覆盖
        // 已清空的列表),同时复位 isSearching 防止 spinner 卡死。
        // 原因:handleSearch 唯一调用点带 `searchQuery &&` 守卫,空字符串
        // 永不调用 handleSearch,旧实现把空分支写在 handleSearch 内只对
        // 纯空白字符串可达;且该分支递增 seq 后,旧请求 finally 因 seq
        // 失配不复位 isSearching,空分支自身也不复位 → spinner 永久旋转。
        ++searchSeqRef.current
        setSearchResults([])
        setSearchError(null)
        setIsSearching(false)
      }
    }, 300)

    return () => clearTimeout(timer)
  }, [searchQuery, handleSearch, view])

  const handleInvite = async (user: User, role: 'editor' | 'viewer' = 'viewer') => {
    if (!selectedProject?.id) return

    try {
      const newInvitation = await inviteUserToProject(selectedProject.id, user.id, role)
      setInvitations(prev => [...prev, newInvitation])
      setInvitedUsers(prev => new Map(prev).set(user.id, role))
      addSuccessToast(`已向 ${getUserDisplayName(user)} 发送邀请`)
    } catch (error) {
      addErrorToast(error instanceof Error ? error.message : '邀请失败')
    }
  }

  const handleRemoveMember = async (userId: number) => {
    if (!selectedProject?.id) return

    try {
      await removeProjectMember(selectedProject.id, userId)
      setMembers(prev => prev.filter(m => m.userId !== userId))
      addSuccessToast('成员已移除')
    } catch (error) {
      addErrorToast(error instanceof Error ? error.message : '移除失败')
    }
  }

  const handleCancelInvitation = async (invitationId: number) => {
    try {
      await cancelInvitation(invitationId)
      setInvitations(prev => prev.filter(i => i.id !== invitationId))
      addSuccessToast('邀请已取消')
    } catch (error) {
      addErrorToast(error instanceof Error ? error.message : '取消失败')
    }
  }

  const handleUpdateRole = async (userId: number, role: 'editor' | 'viewer') => {
    if (!selectedProject?.id) return

    try {
      await updateMemberRole(selectedProject.id, userId, role)
      setMembers(prev => prev.map(m => m.userId === userId ? { ...m, role } : m))
      addSuccessToast('角色已更新')
    } catch (error) {
      addErrorToast(error instanceof Error ? error.message : '更新失败')
    }
    setRoleDropdownOpen(null)
  }

  const handleAcceptInvitation = async (invitationId: number) => {
    try {
      await acceptInvitation(invitationId)
      setMyInvitations(prev => prev.filter(i => i.id !== invitationId))
      addSuccessToast('已接受邀请')
      // 重新加载项目列表以获取新加入的协作项目
      await loadProjects()
      loadCollaborativeProjects()
    } catch (error) {
      addErrorToast(error instanceof Error ? error.message : '接受失败')
    }
  }

  const handleRejectInvitation = async (invitationId: number) => {
    try {
      await rejectInvitation(invitationId)
      setMyInvitations(prev => prev.filter(i => i.id !== invitationId))
      addSuccessToast('已拒绝邀请')
    } catch (error) {
      addErrorToast(error instanceof Error ? error.message : '拒绝失败')
    }
  }

  const handleAddProject = async (projectId: number) => {
    const project = projects?.find(p => p.id === projectId)
    if (!project) return

    setCollaborativeProjects(prev => {
      const exists = prev.some(p => p.id === projectId)
      if (exists) return prev
      return [...prev, {
        id: project.id,
        name: project.name,
        ownerId: currentUser?.id || 0,
        memberCount: 0,
        isOwner: true,
      }]
    })
    addSuccessToast(`已添加项目「${project.name}」到协作列表`)
  }

  const handleSelectProject = (project: CollaborativeProject) => {
    setSelectedProject(project)
    setView('members')
  }

  const handleBack = () => {
    if (view === 'search') {
      setView('members')
      setSearchQuery('')
      setSearchResults([])
      setInvitedUsers(new Map())
    } else if (view === 'members') {
      setSelectedProject(null)
      setView('projects')
      setInvitedUsers(new Map())
      loadCollaborativeProjects()
    } else {
      setView('projects')
    }
  }

  const handleClose = () => {
    setCollaborationOpen(false)
    setView('projects')
    setActiveTab('collaborative')
    setSelectedProject(null)
    setSearchQuery('')
    setSearchResults([])
    setSearchError(null)
    setInvitedUsers(new Map())
  }

  const getUserDisplayName = (user: { nickname: string | null; email: string }) => {
    return user.nickname || user.email.split('@')[0]
  }

  const getUserInitial = (user: { nickname: string | null; email: string }) => {
    const name = getUserDisplayName(user)
    return name.charAt(0).toUpperCase()
  }

  const getRoleIcon = (role: string) => {
    switch (role) {
      case 'owner':
        return <Crown className="w-3.5 h-3.5 text-yellow-500" />
      case 'editor':
        return <Edit3 className="w-3.5 h-3.5 text-blue-500" />
      default:
        return <Eye className="w-3.5 h-3.5 text-gray-400" />
    }
  }

  const getRoleLabel = (role: string) => {
    switch (role) {
      case 'owner':
        return '所有者'
      case 'editor':
        return '编辑者'
      default:
        return '查看者'
    }
  }

  const pendingInvitationsCount = myInvitations.length

  // 只显示标记为协作项目但还未添加到协作列表的项目
  const projectsNotInCollaborative = projects?.filter(
    p => !collaborativeProjects.some(cp => cp.id === p.id) && p.ownerId === currentUser?.id && p.isCollaborative
  ) || []

  return (
    <Dialog
      open={collaborationOpen}
      onClose={handleClose}
      title={
        <div className="flex items-center gap-2">
          {view !== 'projects' && (
            <button
              onClick={handleBack}
              className="p-1 -ml-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          )}
          {view === 'projects' && <UserPlus className="w-5 h-5 text-blue-500" />}
          {view === 'members' && selectedProject && (
            <span className="truncate max-w-[200px]">{selectedProject.name}</span>
          )}
          {view === 'search' && <span>添加成员</span>}
          {view === 'projects' && <span>实时协作</span>}
        </div>
      }
      className="max-w-md"
    >
      <div className="space-y-4 min-h-[300px]">
        {/* Projects List View */}
        {view === 'projects' && (
          <>
            <div className="flex border-b border-gray-200 dark:border-gray-700">
              <button
                onClick={() => setActiveTab('collaborative')}
                className={clsx(
                  'px-4 py-2 text-sm font-medium transition-colors relative',
                  activeTab === 'collaborative'
                    ? 'text-blue-600 dark:text-blue-400'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                )}
              >
                协作项目
                {activeTab === 'collaborative' && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500" />
                )}
              </button>
              <button
                onClick={() => setActiveTab('invitations')}
                className={clsx(
                  'px-4 py-2 text-sm font-medium transition-colors relative',
                  activeTab === 'invitations'
                    ? 'text-blue-600 dark:text-blue-400'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                )}
              >
                我的邀请
                {pendingInvitationsCount > 0 && (
                  <span className="ml-1.5 px-1.5 py-0.5 text-xs bg-red-500 text-white rounded-full">
                    {pendingInvitationsCount}
                  </span>
                )}
                {activeTab === 'invitations' && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500" />
                )}
              </button>
            </div>

            {activeTab === 'collaborative' && (
              <>
                {isLoadingProjects ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-6 h-6 text-gray-400 animate-spin" />
                  </div>
                ) : (
                  <>
                    <div className="space-y-2">
                      {collaborativeProjects.length === 0 ? (
                        <div className="text-sm text-gray-500 dark:text-gray-400 text-center py-8">
                          暂无协作项目，添加一个项目开始协作
                        </div>
                      ) : (
                        <div className="border border-gray-200 dark:border-gray-700 rounded-lg divide-y divide-gray-200 dark:divide-gray-700">
                          {collaborativeProjects.map((project) => (
                            <button
                              key={project.id}
                              onClick={() => handleSelectProject(project)}
                              className="w-full flex items-center justify-between p-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                            >
                              <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center text-white text-sm font-medium">
                                  {project.name.charAt(0).toUpperCase()}
                                </div>
                                <div className="text-left">
                                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                                    {project.name}
                                  </div>
                                  <div className="text-xs text-gray-500 dark:text-gray-400">
                                    {project.memberCount} 名成员
                                    {project.isOwner ? ' · 所有者' : ''}
                                  </div>
                                </div>
                              </div>
                              <ChevronDown className="w-4 h-4 text-gray-400 -rotate-90" />
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {projectsNotInCollaborative.length > 0 && (
                      <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
                        <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                          添加你的项目
                        </div>
                        <div className="max-h-32 overflow-y-auto space-y-1">
                          {projectsNotInCollaborative.slice(0, 5).map((project) => (
                            <button
                              key={project.id}
                              onClick={() => handleAddProject(project.id)}
                              className="w-full flex items-center justify-between p-2 text-sm rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                            >
                              <span className="text-gray-700 dark:text-gray-300 truncate">
                                {project.name}
                              </span>
                              <Plus className="w-4 h-4 text-gray-400" />
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            {activeTab === 'invitations' && (
              <div className="space-y-3">
                {myInvitations.length === 0 ? (
                  <div className="text-sm text-gray-500 dark:text-gray-400 text-center py-8">
                    暂无待处理的邀请
                  </div>
                ) : (
                  <div className="border border-gray-200 dark:border-gray-700 rounded-lg divide-y divide-gray-200 dark:divide-gray-700">
                    {myInvitations.map((invitation) => (
                      <div
                        key={invitation.id}
                        className="flex items-center justify-between p-3"
                      >
                        <div className="flex items-center gap-3">
                          {invitation.inviter.avatar ? (
                            <img
                              src={invitation.inviter.avatar}
                              alt={getUserDisplayName(invitation.inviter)}
                              className="w-8 h-8 rounded-full object-cover"
                            />
                          ) : (
                            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center text-white text-sm font-medium">
                              {getUserInitial(invitation.inviter)}
                            </div>
                          )}
                          <div>
                            <div className="text-sm text-gray-900 dark:text-gray-100">
                              <span className="font-medium">{getUserDisplayName(invitation.inviter)}</span>
                              {' '}邀请你加入{' '}
                              <span className="font-medium">{invitation.project.name}</span>
                            </div>
                            <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                              <span className="flex items-center gap-1">
                                {getRoleIcon(invitation.role)}
                                {getRoleLabel(invitation.role)}
                              </span>
                              {invitation.createdAt && (
                                <>
                                  <span>·</span>
                                  <span>{new Date(invitation.createdAt).toLocaleDateString()}</span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleRejectInvitation(invitation.id)}
                            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                          >
                            拒绝
                          </button>
                          <button
                            onClick={() => handleAcceptInvitation(invitation.id)}
                            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors"
                          >
                            <Check className="w-3.5 h-3.5" />
                            接受
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Members View */}
        {view === 'members' && selectedProject && (
          <>
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 text-gray-400 animate-spin" />
              </div>
            ) : (
              <div className="space-y-3">
                {selectedProject.isOwner && (
                  <button
                    onClick={() => {
                      setView('search')
                      setSearchQuery('')
                      setSearchResults([])
                    }}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 border border-dashed border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:border-blue-500 hover:text-blue-500 transition-colors"
                  >
                    <UserPlus className="w-4 h-4" />
                    添加成员
                  </button>
                )}

                <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  成员 ({members.length + invitations.length})
                </div>

                {members.length === 0 && invitations.length === 0 ? (
                  <div className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">
                    暂无成员
                  </div>
                ) : (
                  <div className="border border-gray-200 dark:border-gray-700 rounded-lg divide-y divide-gray-200 dark:divide-gray-700">
                    {members.map((member) => (
                      <div
                        key={member.id}
                        className="flex items-center justify-between p-3"
                      >
                        <div className="flex items-center gap-3">
                          {member.user.avatar ? (
                            <img
                              src={member.user.avatar}
                              alt={getUserDisplayName(member.user)}
                              className="w-8 h-8 rounded-full object-cover"
                            />
                          ) : (
                            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center text-white text-sm font-medium">
                              {getUserInitial(member.user)}
                            </div>
                          )}
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                                {getUserDisplayName(member.user)}
                              </span>
                              {member.isOwner && (
                                <span className="px-1.5 py-0.5 text-xs bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 rounded">
                                  所有者
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-gray-500 dark:text-gray-400">
                              {member.user.email}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {!member.isOwner && selectedProject.isOwner ? (
                            <div className="relative">
                              <button
                                onClick={() => setRoleDropdownOpen(roleDropdownOpen === member.userId ? null : member.userId)}
                                className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                              >
                                {getRoleIcon(member.role)}
                                {getRoleLabel(member.role)}
                                <ChevronDown className="w-3 h-3" />
                              </button>
                              {roleDropdownOpen === member.userId && (
                                <div className="absolute right-0 top-full mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-10 min-w-[120px]">
                                  <button
                                    onClick={() => handleUpdateRole(member.userId, 'editor')}
                                    className="flex items-center gap-2 w-full px-3 py-2 text-xs text-left hover:bg-gray-100 dark:hover:bg-gray-700"
                                  >
                                    <Edit3 className="w-3.5 h-3.5 text-blue-500" />
                                    编辑者
                                  </button>
                                  <button
                                    onClick={() => handleUpdateRole(member.userId, 'viewer')}
                                    className="flex items-center gap-2 w-full px-3 py-2 text-xs text-left hover:bg-gray-100 dark:hover:bg-gray-700"
                                  >
                                    <Eye className="w-3.5 h-3.5 text-gray-400" />
                                    查看者
                                  </button>
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="flex items-center gap-1 px-2 py-1 text-xs text-gray-500 dark:text-gray-400">
                              {getRoleIcon(member.role)}
                              {getRoleLabel(member.role)}
                            </div>
                          )}
                          {!member.isOwner && selectedProject.isOwner && (
                            <button
                              onClick={() => handleRemoveMember(member.userId)}
                              className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400 hover:text-red-500 transition-colors"
                              title="移除"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}

                    {invitations.map((invitation) => (
                      <div
                        key={invitation.id}
                        className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800/50"
                      >
                        <div className="flex items-center gap-3">
                          {invitation.invitee.avatar ? (
                            <img
                              src={invitation.invitee.avatar}
                              alt={getUserDisplayName(invitation.invitee)}
                              className="w-8 h-8 rounded-full object-cover opacity-75"
                            />
                          ) : (
                            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center text-white text-sm font-medium opacity-75">
                              {getUserInitial(invitation.invitee)}
                            </div>
                          )}
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-gray-600 dark:text-gray-400">
                                {getUserDisplayName(invitation.invitee)}
                              </span>
                              {invitation.status === 'pending' && (
                                <span className="flex items-center gap-1 px-1.5 py-0.5 text-xs bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 rounded">
                                  <Clock className="w-3 h-3" />
                                  待接受
                                </span>
                              )}
                              {invitation.status === 'rejected' && (
                                <span className="flex items-center gap-1 px-1.5 py-0.5 text-xs bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 rounded">
                                  <XCircle className="w-3 h-3" />
                                  已拒绝
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-gray-400 dark:text-gray-500">
                              {invitation.invitee.email}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 dark:text-gray-500">
                            {getRoleIcon(invitation.role)}
                            {getRoleLabel(invitation.role)}
                          </div>
                          {selectedProject.isOwner && (
                            <button
                              onClick={() => handleCancelInvitation(invitation.id)}
                              className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400 hover:text-red-500 transition-colors"
                              title="取消邀请"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Search View */}
        {view === 'search' && (
          <>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="搜索用户..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                autoFocus
              />
              {isSearching && (
                <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 animate-spin" />
              )}
            </div>

            {searchError && (
              <div className="text-sm text-red-500 dark:text-red-400">
                {searchError}
              </div>
            )}

            {searchResults.length > 0 && (
              <div className="border border-gray-200 dark:border-gray-700 rounded-lg max-h-64 overflow-y-auto">
                {searchResults.map((user) => {
                  const invitedRole = invitedUsers.get(user.id)
                  const existingInvitation = invitations.find(i => i.inviteeId === user.id && i.status === 'pending')
                  const isInvited = invitedRole !== undefined || existingInvitation !== undefined
                  const displayRole = invitedRole || existingInvitation?.role

                  return (
                    <div
                      key={user.id}
                      className="flex items-center justify-between p-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700 last:border-b-0"
                    >
                      <div className="flex items-center gap-3">
                        {user.avatar ? (
                          <img
                            src={user.avatar}
                            alt={getUserDisplayName(user)}
                            className="w-8 h-8 rounded-full object-cover"
                          />
                        ) : (
                          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center text-white text-sm font-medium">
                            {getUserInitial(user)}
                          </div>
                        )}
                        <div>
                          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                            {getUserDisplayName(user)}
                          </div>
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            {user.email}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {isInvited ? (
                          <span className={clsx(
                            'px-2 py-1 text-xs font-medium rounded',
                            displayRole === 'editor'
                              ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
                              : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
                          )}>
                            {displayRole === 'editor' ? '已发送编辑邀请' : '已发送查看邀请'}
                          </span>
                        ) : (
                          <>
                            <button
                              onClick={() => handleInvite(user, 'viewer')}
                              className="px-2 py-1 text-xs font-medium rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                            >
                              邀请查看
                            </button>
                            <button
                              onClick={() => handleInvite(user, 'editor')}
                              className="px-2 py-1 text-xs font-medium rounded bg-blue-500 hover:bg-blue-600 text-white transition-colors"
                            >
                              邀请编辑
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {searchQuery && !isSearching && searchResults.length === 0 && !searchError && (
              <div className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">
                未找到匹配的用户
              </div>
            )}

            {!searchQuery && (
              <div className="text-sm text-gray-500 dark:text-gray-400 text-center py-8">
                输入邮箱或用户名搜索用户
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  )
}
