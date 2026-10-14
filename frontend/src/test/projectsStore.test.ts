// useProjectsStore 真实行为测试：每个用例 vi.resetModules() 后动态 import，
// 拿到全新的 store 实例，断言真实的初始状态与真实 action 造成的状态迁移。
// 只 mock 真正的边界（fetch）；store、api.ts、apiClient 协作者全是真货，
// 因此每个 action 走的是真实 URL 与真实 {success,data} 信封。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Canvas, Folder, NodeCard, NodePoolFolder, Project } from '@/types'

type ProjectsModule = typeof import('@/store/useProjectsStore')
type ProjectsStore = ProjectsModule['useProjectsStore']

const ISO = '2026-01-01T00:00:00.000Z'
const RECENT = new Date(Date.now() - 60_000).toISOString()

const PROJECT: Project = {
  id: 1,
  name: '项目一',
  description: null,
  ownerId: 1,
  groupId: null,
  thumbnail: null,
  isPublic: false,
  isCollaborative: false,
  createdAt: ISO,
  updatedAt: RECENT,
  memberRole: 'owner',
}

// 协作项目 + 更新时间在两周前（用于验证筛选语义）
const SHARED: Project = {
  ...PROJECT,
  id: 2,
  name: '协作项目',
  isCollaborative: true,
  memberRole: 'editor',
  updatedAt: '2020-05-05T00:00:00.000Z',
}

const CANVAS_A: Canvas = {
  id: 11,
  name: '画布A',
  projectId: 1,
  folderId: null,
  thumbnail: null,
  sortOrder: 0,
  createdAt: ISO,
  updatedAt: ISO,
}

const CANVAS_B: Canvas = { ...CANVAS_A, id: 12, name: '画布B' }
const CANVAS_IN_FOLDER: Canvas = { ...CANVAS_A, id: 13, name: '画布C', folderId: 21 }

const FOLDER_ROOT: Folder = {
  id: 21,
  name: '文件夹',
  projectId: 1,
  parentId: null,
  sortOrder: 0,
  createdAt: ISO,
}

const FOLDER_CHILD: Folder = { ...FOLDER_ROOT, id: 22, name: '子文件夹', parentId: 21 }

const CARD: NodeCard = {
  id: 31,
  userId: 1,
  name: '卡片',
  content: '内容',
  type: 'text',
  color: '#ffffff',
  tags: null,
  useCount: 2,
  createdBy: 1,
  createdAt: ISO,
  sortOrder: 0,
}

const POOL_FOLDER: NodePoolFolder = {
  id: 41,
  userId: 1,
  name: '节点池分组',
  parentId: null,
  sortOrder: 0,
  collapsed: false,
  createdAt: ISO,
}

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function fail(status: number, error: string): Response {
  return new Response(JSON.stringify({ success: false, error }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

type Route = (init?: RequestInit) => Response | Promise<Response>

/** 未登记的 URL 直接抛错，防止 action 静默打到一个没人断言的端点。 */
function installRouter(routes: Record<string, Route>) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const route = routes[url]
    if (!route) throw new Error(`unexpected fetch: ${url}`)
    return route(init)
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

const HOME = '/api/projects'
const CANVASES = '/api/canvases/1'
const FOLDERS = '/api/canvases/1/folders'
const NODE_POOL = '/api/users/node-pool'
const NODE_POOL_FOLDERS = '/api/users/node-pool-folders'

/** 打开项目 1 所需的全部路由；另为项目 2 的画布/文件夹补上等价响应。 */
function baseRoutes(overrides: Record<string, Route> = {}): Record<string, Route> {
  return {
    [HOME]: () => ok([PROJECT, SHARED]),
    [CANVASES]: () => ok([CANVAS_A, CANVAS_B]),
    [FOLDERS]: () => ok([FOLDER_ROOT, FOLDER_CHILD]),
    '/api/canvases/2': () => ok([{ ...CANVAS_B, projectId: 2 }]),
    '/api/canvases/2/folders': () => ok([]),
    [NODE_POOL]: () => ok([CARD]),
    [NODE_POOL_FOLDERS]: () => ok([POOL_FOLDER]),
    ...overrides,
  }
}

async function freshStore(routes: Record<string, Route> = {}): Promise<{
  store: ProjectsStore
  fetchMock: ReturnType<typeof installRouter>
}> {
  const fetchMock = installRouter(baseRoutes(routes))
  vi.resetModules()
  const module = (await import('@/store/useProjectsStore')) as ProjectsModule
  return { store: module.useProjectsStore, fetchMock }
}

describe('useProjectsStore', () => {
  beforeEach(() => {
    localStorage.clear()
    document.cookie = 'x-csrf-token=test; path=/'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe('初始状态', () => {
    it('全新实例的默认字段', async () => {
      const { store } = await freshStore()

      const state = store.getState()
      expect(state.projects).toEqual([])
      expect(state.currentProject).toBeNull()
      expect(state.currentProjectId).toBeNull()
      expect(state.currentMemberRole).toBeNull()
      expect(state.canvases).toEqual([])
      expect(state.folders).toEqual([])
      expect(state.nodePool).toEqual([])
      expect(state.nodePoolFolders).toEqual([])
      expect(state.nodePoolSortBy).toBe('createdAt')
      expect(state.nodePoolSortOrder).toBe('desc')
      expect(state.isLoading).toBe(false)
      expect(state.loadingMessage).toBe('')
      expect(state.error).toBeNull()
      expect(state.projectFilters).toEqual({
        showOwned: false,
        showCollaborative: false,
        showRecentUpdated: false,
      })
    })

    it('真实存在的 action 名（不是臆造的 selectCanvas/currentCanvas 之类）', async () => {
      const { store } = await freshStore()

      const state = store.getState()
      expect(typeof state.loadProjects).toBe('function')
      expect(typeof state.setCurrentProject).toBe('function')
      expect(typeof state.restoreCurrentProject).toBe('function')
      expect(typeof state.createCanvas).toBe('function')
      expect(typeof state.moveCanvasToFolder).toBe('function')
      expect(typeof state.deleteFolder).toBe('function')
      expect(typeof state.reorderNodeCards).toBe('function')
      expect(typeof state.reset).toBe('function')
      expect('currentCanvas' in state).toBe(false)
      expect('selectCanvas' in state).toBe(false)
    })
  })

  describe('loadProjects', () => {
    it('成功后写入服务端列表并复位 loading/loadingMessage/error', async () => {
      const { store } = await freshStore()

      await store.getState().loadProjects()

      const state = store.getState()
      expect(state.projects).toEqual([PROJECT, SHARED])
      expect(state.isLoading).toBe(false)
      expect(state.loadingMessage).toBe('')
      expect(state.error).toBeNull()
    })

    it('请求打到真实的 GET /api/projects', async () => {
      const { store, fetchMock } = await freshStore()

      await store.getState().loadProjects()

      const get = fetchMock.mock.calls.find(([input]) => String(input) === HOME)
      expect(get).toBeTruthy()
      expect(get?.[1]?.method).toBe('GET')
    })

    it('接口 500 时 error 写入服务端文案、列表保持空、isLoading 复位并向上抛出', async () => {
      const { store } = await freshStore({ [HOME]: () => fail(500, '服务器内部错误') })

      await expect(store.getState().loadProjects()).rejects.toThrow('服务器内部错误')

      const state = store.getState()
      expect(state.error).toBe('服务器内部错误')
      expect(state.projects).toEqual([])
      expect(state.isLoading).toBe(false)
      // 真实行为：handleError 复位 isLoading 却不清 loadingMessage，
      // 失败提示会一直挂在界面上（钉住现状，改动这里会被发现）
      expect(state.loadingMessage).toBe('正在加载项目...')
    })

    it('接口返回 success:false 时同样进入 error 分支', async () => {
      const { store } = await freshStore({ [HOME]: () => fail(200, '数据库不可用') })

      await expect(store.getState().loadProjects()).rejects.toThrow('数据库不可用')
      expect(store.getState().projects).toEqual([])
    })

    it('clearError 只清 error，不动其它状态', async () => {
      const { store } = await freshStore()
      store.setState({ error: '旧错误', projects: [PROJECT] })

      store.getState().clearError()

      expect(store.getState().error).toBeNull()
      expect(store.getState().projects).toEqual([PROJECT])
    })
  })

  describe('筛选（setProjectFilters / getFilteredProjects）', () => {
    it('一个都没勾选时返回全部项目', async () => {
      const { store } = await freshStore()
      store.setState({ projects: [PROJECT, SHARED] })

      expect(store.getState().getFilteredProjects()).toEqual([PROJECT, SHARED])
    })

    it('勾选「我拥有的」只保留 owner 项目', async () => {
      const { store } = await freshStore()
      store.setState({ projects: [PROJECT, SHARED] })

      store.getState().setProjectFilters({ showOwned: true })

      expect(store.getState().projectFilters).toEqual({
        showOwned: true,
        showCollaborative: false,
        showRecentUpdated: false,
      })
      expect(store.getState().getFilteredProjects()).toEqual([PROJECT])
    })

    it('勾选「协作项目」只保留 isCollaborative 的项目', async () => {
      const { store } = await freshStore()
      store.setState({ projects: [PROJECT, SHARED] })

      store.getState().setProjectFilters({ showCollaborative: true })

      expect(store.getState().getFilteredProjects()).toEqual([SHARED])
    })

    it('勾选「最近一周更新」按 updatedAt 过滤', async () => {
      const { store } = await freshStore()
      store.setState({ projects: [PROJECT, SHARED] })

      store.getState().setProjectFilters({ showRecentUpdated: true })

      expect(store.getState().getFilteredProjects()).toEqual([PROJECT])
    })

    it('多个勾选项按 AND 组合（owner 且近一周 → 空集）', async () => {
      const { store } = await freshStore()
      store.setState({ projects: [PROJECT, SHARED] })

      store.getState().setProjectFilters({ showOwned: true, showCollaborative: true })

      expect(store.getState().getFilteredProjects()).toEqual([])
    })

    it('updatedAt 非法的项目在「最近一周」筛选下被排除', async () => {
      const { store } = await freshStore()
      store.setState({ projects: [{ ...PROJECT, updatedAt: '不是日期' }, SHARED] })

      store.getState().setProjectFilters({ showRecentUpdated: true })

      expect(store.getState().getFilteredProjects()).toEqual([])
    })
  })

  describe('setCurrentProject / loadCanvases / loadFolders', () => {
    it('选中项目时联动画布、文件夹、节点池，并写入角色与持久化 id', async () => {
      const { store } = await freshStore()

      await store.getState().setCurrentProject(PROJECT)

      const state = store.getState()
      expect(state.currentProject).toEqual(PROJECT)
      expect(state.currentProjectId).toBe(1)
      expect(state.currentMemberRole).toBe('owner')
      expect(state.canvases).toEqual([CANVAS_A, CANVAS_B])
      expect(state.folders).toEqual([FOLDER_ROOT, FOLDER_CHILD])
      expect(state.nodePool).toEqual([CARD])
      expect(state.nodePoolFolders).toEqual([POOL_FOLDER])
    })

    it('setCurrentProject(null) 只清选中项，不重新请求', async () => {
      const { store, fetchMock } = await freshStore()
      await store.getState().setCurrentProject(PROJECT)
      fetchMock.mockClear()

      await store.getState().setCurrentProject(null)

      expect(fetchMock).not.toHaveBeenCalled()
      const state = store.getState()
      expect(state.currentProject).toBeNull()
      expect(state.currentProjectId).toBeNull()
      expect(state.currentMemberRole).toBeNull()
      // 画布/文件夹列表不会被 null 选择清空
      expect(state.canvases).toEqual([CANVAS_A, CANVAS_B])
    })

    it('memberRole 缺失的项目不会写出角色', async () => {
      const { store } = await freshStore()

      await store.getState().setCurrentProject({ ...PROJECT, memberRole: undefined })

      expect(store.getState().currentMemberRole).toBeNull()
    })

    it('currentProjectId 会被 persist 落盘（partialize 只含这一个字段）', async () => {
      const { store } = await freshStore()

      await store.getState().setCurrentProject(PROJECT)

      const raw = localStorage.getItem('projects-storage')
      expect(raw).toBeTruthy()
      const saved = JSON.parse(raw as string) as { state?: Record<string, unknown> }
      expect(saved.state).toEqual({ currentProjectId: 1 })
    })

    it('loadCanvases 失败时 error 写入、列表保持原值并向上抛出', async () => {
      const { store } = await freshStore({ [CANVASES]: () => fail(500, '加载失败') })
      store.setState({ canvases: [CANVAS_A], error: null })

      await expect(store.getState().loadCanvases(1)).rejects.toThrow('加载失败')

      const state = store.getState()
      expect(state.error).toBe('加载失败')
      expect(state.canvases).toEqual([CANVAS_A])
      expect(state.isLoading).toBe(false)
    })

    it('loadFolders 成功写入文件夹列表', async () => {
      const { store } = await freshStore({ [FOLDERS]: () => ok([FOLDER_ROOT]) })

      await store.getState().loadFolders(1)

      expect(store.getState().folders).toEqual([FOLDER_ROOT])
    })

    it('loadNodePool / loadNodePoolFolders 各自写入对应列表', async () => {
      const { store } = await freshStore({
        [NODE_POOL]: () => ok([CARD, { ...CARD, id: 32 }]),
        [NODE_POOL_FOLDERS]: () => ok([{ ...POOL_FOLDER, collapsed: true }]),
      })

      await store.getState().loadNodePool()
      await store.getState().loadNodePoolFolders()

      expect(store.getState().nodePool.map((c) => c.id)).toEqual([31, 32])
      expect(store.getState().nodePoolFolders).toEqual([{ ...POOL_FOLDER, collapsed: true }])
    })

    it('refreshCanvasesSilent 成功时更新列表但不触碰 loading/error', async () => {
      const fresh = { ...CANVAS_A, name: '远端改名' }
      const { store } = await freshStore({ [CANVASES]: () => ok([fresh]) })
      store.setState({ canvases: [CANVAS_A], isLoading: false, loadingMessage: '', error: null })

      await store.getState().refreshCanvasesSilent(1)

      const state = store.getState()
      expect(state.canvases).toEqual([fresh])
      expect(state.isLoading).toBe(false)
      expect(state.error).toBeNull()
    })

    it('refreshCanvasesSilent 失败时静默：列表与 error 都不变', async () => {
      const { store } = await freshStore({ [CANVASES]: () => fail(500, '炸了') })
      store.setState({ canvases: [CANVAS_A], error: null })

      await expect(store.getState().refreshCanvasesSilent(1)).resolves.toBeUndefined()

      expect(store.getState().canvases).toEqual([CANVAS_A])
      expect(store.getState().error).toBeNull()
    })
  })

  describe('restoreCurrentProject', () => {
    it('持久化的 id 仍在列表里时恢复该项目', async () => {
      const { store } = await freshStore()
      store.setState({ projects: [PROJECT, SHARED], currentProjectId: 2 })

      await store.getState().restoreCurrentProject()

      expect(store.getState().currentProject).toEqual(SHARED)
      expect(store.getState().currentMemberRole).toBe('editor')
    })

    it('列表里没有该 id 时什么都不做（不发请求、不改选中）', async () => {
      const { store, fetchMock } = await freshStore()
      store.setState({ projects: [PROJECT], currentProjectId: 999 })
      fetchMock.mockClear()

      await store.getState().restoreCurrentProject()

      expect(store.getState().currentProject).toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('没有持久化 id 时不发请求', async () => {
      const { store, fetchMock } = await freshStore()
      store.setState({ projects: [PROJECT], currentProjectId: null })
      fetchMock.mockClear()

      await store.getState().restoreCurrentProject()

      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('项目增删改', () => {
    it('createProject 追加服务端返回的项目', async () => {
      const created: Project = { ...PROJECT, id: 3, name: '新项目' }
      const { store, fetchMock } = await freshStore({
        [HOME]: (init) => (init?.method === 'POST' ? ok(created) : ok([])),
      })
      store.setState({ projects: [PROJECT] })

      await store.getState().createProject({
        name: '新项目',
        description: null,
        ownerId: 1,
        groupId: null,
        thumbnail: null,
        isPublic: false,
        isCollaborative: false,
      })

      const state = store.getState()
      expect(state.projects).toEqual([PROJECT, created])
      expect(state.isLoading).toBe(false)
      expect(state.loadingMessage).toBe('')
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
      expect(post?.[0]).toBe(HOME)
      expect(post?.[1]?.body).toBe(
        JSON.stringify({
          name: '新项目',
          description: null,
          ownerId: 1,
          groupId: null,
          thumbnail: null,
          isPublic: false,
          isCollaborative: false,
        })
      )
    })

    it('createProject 失败时列表不变、error 写入并抛出', async () => {
      const { store } = await freshStore({ [HOME]: () => fail(400, '名称不能为空') })
      store.setState({ projects: [PROJECT] })

      await expect(
        store.getState().createProject({
          name: '',
          description: null,
          ownerId: 1,
          groupId: null,
          thumbnail: null,
          isPublic: false,
          isCollaborative: false,
        })
      ).rejects.toThrow('名称不能为空')

      expect(store.getState().projects).toEqual([PROJECT])
      expect(store.getState().error).toBe('名称不能为空')
      expect(store.getState().isLoading).toBe(false)
    })

    it('updateProject 替换列表项并同步 currentProject', async () => {
      const updated: Project = { ...PROJECT, name: '改名了' }
      const { store } = await freshStore({ '/api/projects/1': () => ok(updated) })
      store.setState({ projects: [PROJECT, SHARED], currentProject: PROJECT })

      await store.getState().updateProject(1, { name: '改名了' })

      const state = store.getState()
      expect(state.projects[0]).toEqual(updated)
      expect(state.projects[1]).toEqual(SHARED)
      expect(state.currentProject).toEqual(updated)
      expect(state.isLoading).toBe(false)
    })

    it('updateProject 不影响别的 currentProject', async () => {
      const updated: Project = { ...SHARED, name: '协作改名' }
      const { store } = await freshStore({ '/api/projects/2': () => ok(updated) })
      store.setState({ projects: [PROJECT, SHARED], currentProject: PROJECT })

      await store.getState().updateProject(2, { name: '协作改名' })

      expect(store.getState().currentProject).toEqual(PROJECT)
    })

    it('updateProject 失败时列表原样、error 写入并抛出', async () => {
      const { store } = await freshStore({
        '/api/projects/1': () => fail(403, '没有权限执行此操作'),
      })
      store.setState({ projects: [PROJECT], error: null })

      await expect(store.getState().updateProject(1, { name: 'x' })).rejects.toThrow(
        '没有权限执行此操作'
      )

      expect(store.getState().projects).toEqual([PROJECT])
      expect(store.getState().error).toBe('没有权限执行此操作')
    })

    it('deleteProject 移除列表项并清掉选中的项目与 id', async () => {
      const { store } = await freshStore({ '/api/projects/1': () => ok(null) })
      store.setState({ projects: [PROJECT, SHARED], currentProject: PROJECT, currentProjectId: 1 })

      await store.getState().deleteProject(1)

      const state = store.getState()
      expect(state.projects).toEqual([SHARED])
      expect(state.currentProject).toBeNull()
      expect(state.currentProjectId).toBeNull()
      expect(state.isLoading).toBe(false)
    })

    it('deleteProject 不删除当前选中的其它项目', async () => {
      const { store } = await freshStore({ '/api/projects/1': () => ok(null) })
      store.setState({ projects: [PROJECT, SHARED], currentProject: SHARED, currentProjectId: 2 })

      await store.getState().deleteProject(1)

      expect(store.getState().currentProject).toEqual(SHARED)
      expect(store.getState().currentProjectId).toBe(2)
    })

    it('deleteProject 失败时项目仍在列表', async () => {
      const { store } = await freshStore({ '/api/projects/1': () => fail(500, '删除失败') })
      store.setState({ projects: [PROJECT, SHARED], error: null })

      await expect(store.getState().deleteProject(1)).rejects.toThrow('删除失败')

      expect(store.getState().projects).toEqual([PROJECT, SHARED])
      expect(store.getState().error).toBe('删除失败')
    })
  })

  describe('画布操作（乐观更新）', () => {
    it('createCanvas 成功后临时项被真实数据替换，并返回带 tempId 的画布', async () => {
      const created: Canvas = { ...CANVAS_A, id: 101, name: '新画布' }
      const { store, fetchMock } = await freshStore({ [CANVASES]: () => ok(created) })
      store.setState({ canvases: [CANVAS_A] })

      const returned = await store.getState().createCanvas(1, { name: '新画布' })

      const state = store.getState()
      expect(state.canvases).toHaveLength(1 + 1)
      expect(state.canvases[0]).toEqual(CANVAS_A)
      expect(state.canvases[1]?.id).toBe(101)
      expect(state.canvases[1]?.name).toBe('新画布')
      expect(state.canvases[1]?.tempId).toBeLessThan(0)
      expect(returned?.id).toBe(101)
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) => String(input) === CANVASES && init?.method === 'POST'
        )
      ).toBe(true)
    })

    it('createCanvas 请求期间的乐观临时画布用默认名与兜底字段', async () => {
      const created: Canvas = { ...CANVAS_A, id: 102 }
      let release: ((value: Response) => void) | null = null
      const gate = new Promise<Response>((resolve) => (release = resolve))
      const { store } = await freshStore({ [CANVASES]: () => gate })

      const pending = store.getState().createCanvas(1, {})
      // 等 fetch 真正被调用（apiClient 在发请求前还有 CSRF 检查的微任务链）
      await vi.waitFor(() => expect(release).toBeInstanceOf(Function))

      const optimistic = store.getState().canvases[0] as Canvas
      expect(store.getState().canvases).toHaveLength(1)
      expect(optimistic.name).toBe('未命名画布')
      expect(optimistic.folderId).toBeNull()
      expect(optimistic.thumbnail).toBeNull()
      expect(optimistic.projectId).toBe(1)
      expect(optimistic.id).toBeLessThan(0)
      expect(optimistic.tempId).toBe(optimistic.id)

      release?.(ok(created))
      const returned = await pending

      // 真实数据替换临时项，tempId 保留用于跟踪
      expect(store.getState().canvases).toEqual([{ ...created, tempId: optimistic.id }])
      expect(returned?.id).toBe(102)
    })

    it('createCanvas 失败时撤回临时画布、写入 error 并抛出', async () => {
      const { store } = await freshStore({ [CANVASES]: () => fail(500, '创建画布失败') })
      store.setState({ canvases: [CANVAS_A], error: null })

      await expect(store.getState().createCanvas(1, { name: 'x' })).rejects.toThrow('创建画布失败')

      const state = store.getState()
      expect(state.canvases).toEqual([CANVAS_A])
      expect(state.error).toBe('创建画布失败')
    })

    it('updateCanvas 用服务端数据替换该项并保留 activeUsers', async () => {
      const remote: Canvas = { ...CANVAS_A, name: '改名', thumbnail: 'data:img' }
      const activeUsers = [
        {
          userId: 2,
          email: 'b@b.c',
          nickname: 'B',
          avatar: null,
          role: 'editor' as const,
          joinedAt: 1,
        },
      ]
      const { store } = await freshStore({ '/api/canvases/11': () => ok(remote) })
      store.setState({ canvases: [{ ...CANVAS_A, activeUsers }] })

      await store.getState().updateCanvas(11, { name: '改名', thumbnail: 'data:img' })

      expect(store.getState().canvases[0]).toEqual({ ...remote, activeUsers })
      expect(store.getState().isLoading).toBe(false)
    })

    it('updateCanvas(silent) 不清 loading，也不报错', async () => {
      const { store } = await freshStore({
        '/api/canvases/11': () => ok({ ...CANVAS_A, name: 'x' }),
      })
      store.setState({ canvases: [CANVAS_A], isLoading: true, loadingMessage: '正在保存' })

      await store.getState().updateCanvas(11, { thumbnail: 't' }, true)

      expect(store.getState().isLoading).toBe(true)
      expect(store.getState().loadingMessage).toBe('正在保存')
    })

    it('updateCanvas(silent) 遇 409 冲突时静默丢弃、不改列表、不写 error', async () => {
      const { store } = await freshStore({
        '/api/canvases/11': () => fail(409, '版本冲突：画布数据已被其他用户更新，请刷新后重试'),
      })
      store.setState({
        canvases: [CANVAS_A],
        error: null,
        isLoading: true,
        loadingMessage: '保存缩略图',
      })

      await expect(
        store.getState().updateCanvas(11, { thumbnail: 't' }, true)
      ).resolves.toBeUndefined()

      const state = store.getState()
      expect(state.canvases).toEqual([CANVAS_A])
      expect(state.error).toBeNull()
      expect(state.isLoading).toBe(true)
    })

    it('updateCanvas 非 silent 遇 409 会抛出并写入 error', async () => {
      const { store } = await freshStore({
        '/api/canvases/11': () => fail(409, '版本冲突：画布数据已被其他用户更新，请刷新后重试'),
      })
      store.setState({ canvases: [CANVAS_A], error: null })

      await expect(store.getState().updateCanvas(11, { name: 'x' })).rejects.toThrow('版本冲突')
      expect(store.getState().error).toContain('版本冲突')
    })

    it('deleteCanvas 成功后移除该项', async () => {
      const { store } = await freshStore({ '/api/canvases/11': () => ok(null) })
      store.setState({ canvases: [CANVAS_A, CANVAS_B] })

      await store.getState().deleteCanvas(11)

      expect(store.getState().canvases).toEqual([CANVAS_B])
    })

    it('deleteCanvas 失败时合并回滚被删项（追加到末尾，N9 语义）', async () => {
      const { store } = await freshStore({ '/api/canvases/11': () => fail(500, '删除画布失败') })
      store.setState({ canvases: [CANVAS_A, CANVAS_B], error: null })

      await expect(store.getState().deleteCanvas(11)).rejects.toThrow('删除画布失败')

      const ids = store.getState().canvases.map((c) => c.id)
      expect(ids).toEqual([12, 11])
      expect(store.getState().error).toBe('删除画布失败')
    })

    it('moveCanvasToFolder 成功时乐观更新落地为新的 folderId', async () => {
      const { store } = await freshStore({ '/api/canvases/11': () => ok(CANVAS_A) })
      store.setState({ canvases: [CANVAS_A] })

      await store.getState().moveCanvasToFolder(11, 21)

      expect(store.getState().canvases[0]?.folderId).toBe(21)
    })

    it('moveCanvasToFolder 失败时回滚 folderId 并抛出', async () => {
      const { store } = await freshStore({ '/api/canvases/11': () => fail(500, '移动画布失败') })
      store.setState({ canvases: [CANVAS_A], error: null })

      await expect(store.getState().moveCanvasToFolder(11, 21)).rejects.toThrow('移动画布失败')

      const state = store.getState()
      expect(state.canvases[0]?.folderId).toBeNull()
      expect(state.error).toBe('移动画布失败')
    })

    it('moveCanvasToFolder(silent) 失败时回滚但不抛出', async () => {
      const { store } = await freshStore({ '/api/canvases/11': () => fail(500, '失败') })
      store.setState({ canvases: [CANVAS_IN_FOLDER], error: null })

      await expect(store.getState().moveCanvasToFolder(13, null, true)).resolves.toBeUndefined()

      const state = store.getState()
      expect(state.canvases[0]?.folderId).toBe(21)
      expect(state.error).toBeNull()
    })

    it('moveCanvasToFolder 对不存在的画布直接返回，不发请求', async () => {
      const { store, fetchMock } = await freshStore()
      store.setState({ canvases: [] })
      fetchMock.mockClear()

      await store.getState().moveCanvasToFolder(999, 1)

      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('文件夹操作', () => {
    it('createFolder 成功后用真实文件夹替换临时项', async () => {
      const created: Folder = { ...FOLDER_ROOT, id: 51, name: '新文件夹' }
      const { store } = await freshStore({ [FOLDERS]: () => ok(created) })
      store.setState({ folders: [FOLDER_ROOT] })

      await store.getState().createFolder(1, {
        name: '新文件夹',
        projectId: 1,
        parentId: null,
        sortOrder: 0,
      })

      expect(store.getState().folders).toEqual([FOLDER_ROOT, created])
    })

    it('createFolder 失败时移除临时项并抛出', async () => {
      const { store } = await freshStore({ [FOLDERS]: () => fail(500, '创建文件夹失败') })
      store.setState({ folders: [FOLDER_ROOT], error: null })

      await expect(
        store.getState().createFolder(1, { name: 'x', projectId: 1, parentId: null, sortOrder: 0 })
      ).rejects.toThrow('创建文件夹失败')

      expect(store.getState().folders).toEqual([FOLDER_ROOT])
    })

    it('updateFolder 替换对应项', async () => {
      const updated: Folder = { ...FOLDER_ROOT, name: '改名' }
      const { store } = await freshStore({ '/api/canvases/folders/21': () => ok(updated) })
      store.setState({ folders: [FOLDER_ROOT, FOLDER_CHILD] })

      await store.getState().updateFolder(21, { name: '改名' })

      expect(store.getState().folders).toEqual([updated, FOLDER_CHILD])
    })

    it('deleteFolder 递归删除子文件夹以及夹内的画布', async () => {
      const { store } = await freshStore({ '/api/canvases/folders/21': () => ok(null) })
      store.setState({
        folders: [FOLDER_ROOT, FOLDER_CHILD],
        canvases: [CANVAS_A, CANVAS_IN_FOLDER],
      })

      await store.getState().deleteFolder(21)

      const state = store.getState()
      expect(state.folders).toEqual([])
      expect(state.canvases).toEqual([CANVAS_A])
      expect(state.isLoading).toBe(false)
    })

    it('deleteFolder 失败时把文件夹与画布都合并回来', async () => {
      const { store } = await freshStore({
        '/api/canvases/folders/21': () => fail(500, '删除文件夹失败'),
      })
      store.setState({
        folders: [FOLDER_ROOT, FOLDER_CHILD],
        canvases: [CANVAS_A, CANVAS_IN_FOLDER],
        error: null,
      })

      await expect(store.getState().deleteFolder(21)).rejects.toThrow('删除文件夹失败')

      const state = store.getState()
      expect(state.folders.map((f) => f.id).sort((a, b) => a - b)).toEqual([21, 22])
      expect(state.canvases.map((c) => c.id).sort((a, b) => a - b)).toEqual([11, 13])
      expect(state.error).toBe('删除文件夹失败')
    })
  })

  describe('节点池', () => {
    it('addToNodePool 成功后用真实卡片替换临时卡片并返回它', async () => {
      const created: NodeCard = { ...CARD, id: 61 }
      const { store } = await freshStore({ [NODE_POOL]: () => ok(created) })
      store.setState({ nodePool: [] })

      const returned = await store.getState().addToNodePool({
        name: '卡片',
        content: '内容',
        type: 'text',
        color: '#ffffff',
        tags: null,
        createdBy: 1,
        sortOrder: 0,
      })

      expect(store.getState().nodePool).toEqual([created])
      expect(returned).toEqual(created)
    })

    it('addToNodePool 失败时撤回临时卡片并抛出', async () => {
      const { store } = await freshStore({ [NODE_POOL]: () => fail(500, '添加失败') })
      store.setState({ nodePool: [CARD], error: null })

      await expect(
        store.getState().addToNodePool({
          name: 'x',
          content: '',
          type: 'text',
          color: '#fff',
          tags: null,
          createdBy: 1,
          sortOrder: 0,
        })
      ).rejects.toThrow('添加失败')

      expect(store.getState().nodePool).toEqual([CARD])
      expect(store.getState().error).toBe('添加失败')
    })

    it('removeFromNodePool 成功移除', async () => {
      const { store } = await freshStore({ '/api/users/node-pool/31': () => ok(null) })
      store.setState({ nodePool: [CARD, { ...CARD, id: 32 }] })

      await store.getState().removeFromNodePool(31)

      expect(store.getState().nodePool).toEqual([{ ...CARD, id: 32 }])
    })

    it('removeFromNodePool 失败时整体回滚（顺序保持）', async () => {
      const { store } = await freshStore({ '/api/users/node-pool/31': () => fail(500, '移除失败') })
      store.setState({ nodePool: [CARD, { ...CARD, id: 32 }], error: null })

      await expect(store.getState().removeFromNodePool(31)).rejects.toThrow('移除失败')

      expect(store.getState().nodePool).toEqual([CARD, { ...CARD, id: 32 }])
    })

    it('updateNodeCard 替换对应卡片', async () => {
      const updated: NodeCard = { ...CARD, name: '改名' }
      const { store } = await freshStore({ '/api/users/node-pool/31': () => ok(updated) })
      store.setState({ nodePool: [CARD] })

      await store.getState().updateNodeCard(31, { name: '改名' })

      expect(store.getState().nodePool).toEqual([updated])
    })

    it('incrementNodeCardUseCount 成功写入服务端计数', async () => {
      const updated: NodeCard = { ...CARD, useCount: 3 }
      const { store } = await freshStore({
        '/api/users/node-pool/31/increment-use': () => ok(updated),
      })
      store.setState({ nodePool: [CARD] })

      await store.getState().incrementNodeCardUseCount(31)

      expect(store.getState().nodePool).toEqual([updated])
    })

    it('incrementNodeCardUseCount 失败时静默（非关键操作，不写 error）', async () => {
      const { store } = await freshStore({
        '/api/users/node-pool/31/increment-use': () => fail(500, '炸了'),
      })
      store.setState({ nodePool: [CARD], error: null })

      await expect(store.getState().incrementNodeCardUseCount(31)).resolves.toBeUndefined()

      expect(store.getState().nodePool).toEqual([CARD])
      expect(store.getState().error).toBeNull()
    })

    it('排序字段只改自己那一个', async () => {
      const { store } = await freshStore()

      store.getState().setNodePoolSortBy('useCount')
      store.getState().setNodePoolSortOrder('asc')

      const state = store.getState()
      expect(state.nodePoolSortBy).toBe('useCount')
      expect(state.nodePoolSortOrder).toBe('asc')
    })

    it('reorderNodeCards 全部成功时保留新顺序', async () => {
      const { store } = await freshStore({
        '/api/users/node-pool/31': () => ok({ ...CARD, sortOrder: 9 }),
        '/api/users/node-pool/32': () => ok({ ...CARD, id: 32, sortOrder: 8 }),
      })
      store.setState({ nodePool: [CARD, { ...CARD, id: 32, sortOrder: 0 }] })

      await store.getState().reorderNodeCards([
        { id: 31, sortOrder: 9 },
        { id: 32, sortOrder: 8 },
      ])

      expect(store.getState().nodePool.map((c) => c.sortOrder)).toEqual([9, 8])
      expect(store.getState().error).toBeNull()
    })

    it('reorderNodeCards 部分失败时只回退失败项（N11）', async () => {
      const { store } = await freshStore({
        '/api/users/node-pool/31': () => ok({ ...CARD, sortOrder: 9 }),
        '/api/users/node-pool/32': () => fail(500, '排序失败'),
      })
      store.setState({ nodePool: [CARD, { ...CARD, id: 32, sortOrder: 1 }] })

      await expect(
        store.getState().reorderNodeCards([
          { id: 31, sortOrder: 9 },
          { id: 32, sortOrder: 8 },
        ])
      ).rejects.toThrow('排序失败')

      const state = store.getState()
      expect(state.nodePool.map((c) => c.sortOrder)).toEqual([9, 1])
      expect(state.error).toBe('排序失败')
    })

    it('reorderNodePoolFolders 部分失败时只回退失败项', async () => {
      const other: NodePoolFolder = { ...POOL_FOLDER, id: 42, sortOrder: 1 }
      const { store } = await freshStore({
        '/api/users/node-pool-folders/41': () => ok({ ...POOL_FOLDER, sortOrder: 9 }),
        '/api/users/node-pool-folders/42': () => fail(500, '文件夹排序失败'),
      })
      store.setState({ nodePoolFolders: [POOL_FOLDER, other] })

      await expect(
        store.getState().reorderNodePoolFolders([
          { id: 41, sortOrder: 9 },
          { id: 42, sortOrder: 8 },
        ])
      ).rejects.toThrow('文件夹排序失败')

      expect(store.getState().nodePoolFolders.map((f) => f.sortOrder)).toEqual([9, 1])
    })

    it('createNodePoolFolder 追加服务端返回的分组', async () => {
      const created: NodePoolFolder = { ...POOL_FOLDER, id: 43 }
      const { store } = await freshStore({ [NODE_POOL_FOLDERS]: () => ok(created) })
      store.setState({ nodePoolFolders: [] })

      await store
        .getState()
        .createNodePoolFolder({ name: '分组', parentId: null, sortOrder: 0, collapsed: false })

      expect(store.getState().nodePoolFolders).toEqual([created])
    })

    it('updateNodePoolFolder 合并而非整体替换', async () => {
      const partial = { name: '改名' } as Partial<NodePoolFolder>
      const { store } = await freshStore({ '/api/users/node-pool-folders/41': () => ok(partial) })
      store.setState({ nodePoolFolders: [POOL_FOLDER] })

      await store.getState().updateNodePoolFolder(41, { name: '改名' })

      expect(store.getState().nodePoolFolders).toEqual([{ ...POOL_FOLDER, name: '改名' }])
    })

    it('deleteNodePoolFolder 移除该项', async () => {
      const { store } = await freshStore({ '/api/users/node-pool-folders/41': () => ok(null) })
      store.setState({ nodePoolFolders: [POOL_FOLDER] })

      await store.getState().deleteNodePoolFolder(41)

      expect(store.getState().nodePoolFolders).toEqual([])
    })

    it('deleteNodePoolFolder 失败时列表不变并写入 error', async () => {
      const { store } = await freshStore({
        '/api/users/node-pool-folders/41': () => fail(500, '删除失败'),
      })
      store.setState({ nodePoolFolders: [POOL_FOLDER], error: null })

      await expect(store.getState().deleteNodePoolFolder(41)).rejects.toThrow('删除失败')

      expect(store.getState().nodePoolFolders).toEqual([POOL_FOLDER])
      expect(store.getState().error).toBe('删除失败')
    })

    it('toggleNodePoolFolderCollapsed 只翻转目标分组', async () => {
      const { store } = await freshStore()
      store.setState({
        nodePoolFolders: [POOL_FOLDER, { ...POOL_FOLDER, id: 42, collapsed: true }],
      })

      store.getState().toggleNodePoolFolderCollapsed(41)

      const state = store.getState()
      expect(state.nodePoolFolders[0]?.collapsed).toBe(true)
      expect(state.nodePoolFolders[1]?.collapsed).toBe(true)

      store.getState().toggleNodePoolFolderCollapsed(41)
      expect(store.getState().nodePoolFolders[0]?.collapsed).toBe(false)
    })
  })

  describe('reset', () => {
    it('清空所有内存数据与持久化 id，但保留设备级偏好', async () => {
      const { store } = await freshStore()
      await store.getState().setCurrentProject(PROJECT)
      store.getState().setNodePoolSortBy('name')
      store.getState().setNodePoolSortOrder('asc')
      store.getState().setProjectFilters({ showOwned: true })
      store.setState({ error: '遗留错误', isLoading: true, loadingMessage: '正在加载' })

      store.getState().reset()

      const state = store.getState()
      expect(state.projects).toEqual([])
      expect(state.currentProject).toBeNull()
      expect(state.currentProjectId).toBeNull()
      expect(state.currentMemberRole).toBeNull()
      expect(state.canvases).toEqual([])
      expect(state.folders).toEqual([])
      expect(state.nodePool).toEqual([])
      expect(state.nodePoolFolders).toEqual([])
      expect(state.isLoading).toBe(false)
      expect(state.loadingMessage).toBe('')
      expect(state.error).toBeNull()
      // 偏好类字段属于设备级设置，reset 不该动它们
      expect(state.nodePoolSortBy).toBe('name')
      expect(state.nodePoolSortOrder).toBe('asc')
      expect(state.projectFilters).toEqual({
        showOwned: true,
        showCollaborative: false,
        showRecentUpdated: false,
      })
    })
  })
})
