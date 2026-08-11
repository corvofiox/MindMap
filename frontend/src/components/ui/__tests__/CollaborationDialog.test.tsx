import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react'
import { CollaborationDialog } from '../CollaborationDialog'
import { useUIStore } from '@/store/useUIStore'
import { useAuthStore } from '@/store/useAuthStore'
import { useProjectsStore } from '@/store/useProjectsStore'
import { searchUsers, getProjectMembers, getMyInvitations } from '@/services/api'
import type { Project, User } from '@/types'

// R2-2-fix: CollaborationDialog 搜索竞态回归测试——mock 全部 api 依赖
vi.mock('@/services/api', () => ({
  searchUsers: vi.fn(),
  getProjectMembers: vi.fn(),
  inviteUserToProject: vi.fn(),
  removeProjectMember: vi.fn(),
  cancelInvitation: vi.fn(),
  updateMemberRole: vi.fn(),
  getMyInvitations: vi.fn(),
  acceptInvitation: vi.fn(),
  rejectInvitation: vi.fn(),
}))

const me: User = {
  id: 1,
  email: 'me@test.com',
  nickname: 'Me',
  avatar: null,
  createdAt: '',
  updatedAt: '',
}

const targetUser: User = {
  id: 2,
  email: 'target@test.com',
  nickname: 'Target',
  avatar: null,
  createdAt: '',
  updatedAt: '',
}

const mockProject: Project = {
  id: 10,
  name: 'Collab Project',
  description: null,
  ownerId: 1,
  groupId: null,
  thumbnail: null,
  isPublic: false,
  isCollaborative: true,
  createdAt: '',
  updatedAt: '',
  memberRole: 'owner',
}

/**
 * 打开对话框并导航到 search 视图:projects → 点项目卡片 → members → 添加成员。
 * 此阶段用真实计时器 + waitFor 等待异步 effect 落地(组件挂载时的
 * loadMyInvitations / loadCollaborativeProjects / loadProjectMembers)。
 */
async function openSearchView() {
  render(<CollaborationDialog />)
  await waitFor(() => expect(screen.getByText('Collab Project')).toBeTruthy())
  fireEvent.click(screen.getByText('Collab Project'))
  await waitFor(() => expect(screen.getByText('添加成员')).toBeTruthy())
  fireEvent.click(screen.getByText('添加成员'))
  await waitFor(() => expect(screen.getByPlaceholderText('搜索用户...')).toBeTruthy())
}

describe('CollaborationDialog 搜索', () => {
  beforeEach(() => {
    useUIStore.setState({
      collaborationOpen: true,
      addSuccessToast: vi.fn(),
      addErrorToast: vi.fn(),
    })
    useAuthStore.setState({ user: me })
    useProjectsStore.setState({ projects: [mockProject], loadProjects: vi.fn() })
    vi.mocked(getProjectMembers).mockResolvedValue({ ownerId: 1, members: [], invitations: [] })
    vi.mocked(getMyInvitations).mockResolvedValue([])
    vi.mocked(searchUsers).mockReset()
  })

  afterEach(() => {
    // 必须先卸载组件再重置 store:组件挂载期间对 zustand store 的 setState 会
    // 触发 uSES 订阅在 act 外更新,产生 React act 警告(RTL 自动 cleanup 在
    // 本钩子之后才执行,顺序不可依赖)
    cleanup()
    vi.useRealTimers()
    useUIStore.setState({ collaborationOpen: false })
  })

  it('R2-2: 清空输入框后,在途旧搜索响应被 seq 丢弃不落地,且 spinner 复位', async () => {
    await openSearchView()
    // 进入 search 视图后再启用 fake timers,只控制 300ms 搜索防抖
    vi.useFakeTimers()

    const input = screen.getByPlaceholderText('搜索用户...')

    // 第一次搜索:返回受控延迟 Promise(模拟慢响应在途请求)
    let resolveSearch!: (users: User[]) => void
    const deferred = new Promise<User[]>((resolve) => {
      resolveSearch = resolve
    })
    vi.mocked(searchUsers).mockImplementationOnce(() => deferred)

    fireEvent.change(input, { target: { value: 'target' } })
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(searchUsers).toHaveBeenCalledWith('target')
    // 请求在途:spinner 旋转
    expect(document.querySelector('.animate-spin')).not.toBeNull()

    // 清空输入框 → 防抖 300ms → effect 空分支:seq++ / 清空列表 / 复位 spinner
    fireEvent.change(input, { target: { value: '' } })
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(document.querySelector('.animate-spin')).toBeNull()
    expect(screen.getByText('输入邮箱或用户名搜索用户')).not.toBeNull()

    // 在途旧响应此刻才返回 → seq 失配 → 必须被丢弃,不落地覆盖已清空的列表
    await act(async () => {
      resolveSearch([targetUser])
      await deferred
    })
    expect(screen.queryByText('Target')).toBeNull()
    expect(screen.queryByText('target@test.com')).toBeNull()
    expect(document.querySelector('.animate-spin')).toBeNull()
    expect(screen.getByText('输入邮箱或用户名搜索用户')).not.toBeNull()
  })

  it('R2-2: 纯空白 query 不触发搜索,清空结果并复位 spinner(不卡死)', async () => {
    await openSearchView()
    vi.useFakeTimers()

    const input = screen.getByPlaceholderText('搜索用户...')

    let resolveSearch!: (users: User[]) => void
    const deferred = new Promise<User[]>((resolve) => {
      resolveSearch = resolve
    })
    vi.mocked(searchUsers).mockImplementationOnce(() => deferred)

    fireEvent.change(input, { target: { value: 'target' } })
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(searchUsers).toHaveBeenCalledWith('target')
    expect(document.querySelector('.animate-spin')).not.toBeNull()

    // 输入被替换为纯空白 → 300ms 后空分支生效(旧实现:seq 失配 + 空分支不复位
    // isSearching → spinner 永久旋转)
    fireEvent.change(input, { target: { value: '   ' } })
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(document.querySelector('.animate-spin')).toBeNull()
    expect(screen.queryByText('Target')).toBeNull()

    // 旧响应返回 → 同样被 seq 丢弃
    await act(async () => {
      resolveSearch([targetUser])
      await deferred
    })
    expect(screen.queryByText('Target')).toBeNull()
    expect(document.querySelector('.animate-spin')).toBeNull()
  })
})
