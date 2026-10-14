// useUIStore 真实行为测试：每个用例 vi.resetModules() 后动态 import 全新的 store。
// 不 mock 被测模块；主题走真实 DOM（documentElement.classList），持久化走真实
// localStorage（setup.ts 的内存实现），toast 计时用 fake timers 驱动真实 setTimeout。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { NodeDefaults, Toast } from '@/types'

type UIModule = typeof import('@/store/useUIStore')
type AuthModule = typeof import('@/store/useAuthStore')

const SETTINGS_KEY = 'mindmap_settings'

const CUSTOM_DEFAULTS: NodeDefaults = {
  textNode: {
    width: 300,
    height: 200,
    color: '#fef3c7',
    fontSize: 18,
    titleAlign: 'center',
    collapsedTitleAlign: 'center',
    contentAlign: 'center',
  },
  imageNode: {
    width: 300,
    height: 200,
    fontSize: 18,
    titleAlign: 'center',
    collapsedTitleAlign: 'center',
  },
}

const SERVER_DEFAULTS: NodeDefaults = {
  textNode: {
    width: 240,
    height: 180,
    color: '#dbeafe',
    fontSize: 16,
    titleAlign: 'left',
    collapsedTitleAlign: 'left',
    contentAlign: 'left',
  },
  imageNode: {
    width: 240,
    height: 180,
    fontSize: 16,
    titleAlign: 'left',
    collapsedTitleAlign: 'left',
  },
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

type Route = (init?: RequestInit) => Response

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

async function freshUI(routes: Record<string, Route> = {}): Promise<{
  ui: UIModule
  auth: AuthModule
  fetchMock: ReturnType<typeof installRouter>
}> {
  installRouter(routes)
  vi.resetModules()
  const ui = (await import('@/store/useUIStore')) as UIModule
  const auth = (await import('@/store/useAuthStore')) as AuthModule
  return { ui, auth, fetchMock: vi.mocked(fetch) }
}

function toasts(state: { toasts: Toast[] }): Toast[] {
  return state.toasts
}

describe('useUIStore', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
    document.cookie = 'x-csrf-token=test; path=/'
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.documentElement.classList.remove('dark')
  })

  describe('初始状态与当前形状', () => {
    it('面板/画布字段的真实默认值', async () => {
      const { ui } = await freshUI()

      const state = ui.useUIStore.getState()
      expect(state.theme).toBe('system')
      expect(state.sidebarOpen).toBe(true)
      expect(state.nodePoolOpen).toBe(true)
      expect(state.currentTool).toBe('select')
      expect(state.dragMode).toBe('free')
      expect(state.gridVisible).toBe(true)
      expect(state.zoomStep).toBe(0.1)
      expect(state.minimapVisible).toBe(true)
      expect(state.quickEditMode).toBe(false)
      expect(state.relationshipHighlightMode).toBe(false)
      expect(state.connectionDirection).toBe('directed')
      expect(state.connectionStyle).toBe('solid')
      expect(state.connectionType).toBe('straight')
      expect(state.stylePanelOpen).toBe(false)
      expect(state.selectedType).toBeNull()
      expect(state.selectedNodeIds).toEqual([])
      expect(state.toasts).toEqual([])
      expect(state.isLoading).toBe(false)
    })

    it('AI 侧边栏已被移除：当前形状里不存在这些字段', async () => {
      const { ui } = await freshUI()

      const state = ui.useUIStore.getState()
      expect('aiSidebarOpen' in state).toBe(false)
      expect('toggleAiSidebar' in state).toBe(false)
      expect('activePanel' in state).toBe(false)
    })

    it('minimapFrame 初始值是 panelOffset 常量（16 / 173）', async () => {
      const { ui } = await freshUI()

      expect(ui.useUIStore.getState().minimapFrame).toEqual({ top: 16, height: 173 })

      ui.useUIStore.getState().setMinimapFrame({ top: 64, height: 90 })
      expect(ui.useUIStore.getState().minimapFrame).toEqual({ top: 64, height: 90 })
    })
  })

  describe('面板开关与相互独立性', () => {
    it('setSidebarOpen / toggleSidebar 直接写入与翻转', async () => {
      const { ui } = await freshUI()
      const store = ui.useUIStore

      store.getState().setSidebarOpen(false)
      expect(store.getState().sidebarOpen).toBe(false)

      store.getState().toggleSidebar()
      expect(store.getState().sidebarOpen).toBe(true)

      store.getState().toggleSidebar()
      expect(store.getState().sidebarOpen).toBe(false)
    })

    it('sidebar 与 nodePool 互不影响（当前实现无互斥；AI 侧栏移除后的形状）', async () => {
      const { ui } = await freshUI()
      const store = ui.useUIStore

      store.getState().toggleNodePool()
      expect(store.getState().nodePoolOpen).toBe(false)
      expect(store.getState().sidebarOpen).toBe(true)

      store.getState().toggleSidebar()
      expect(store.getState().sidebarOpen).toBe(false)
      expect(store.getState().nodePoolOpen).toBe(false)

      store.getState().setNodePoolOpen(true)
      expect(store.getState().nodePoolOpen).toBe(true)
      expect(store.getState().sidebarOpen).toBe(false)
    })

    it('grid / minimap / quickEdit / relationshipHighlight 的 toggle 各自只翻转自己', async () => {
      const { ui } = await freshUI()
      const store = ui.useUIStore

      store.getState().toggleGrid()
      store.getState().toggleMinimap()
      store.getState().toggleQuickEditMode()
      store.getState().toggleRelationshipHighlightMode()

      const state = store.getState()
      expect(state.gridVisible).toBe(false)
      expect(state.minimapVisible).toBe(false)
      expect(state.quickEditMode).toBe(true)
      expect(state.relationshipHighlightMode).toBe(true)
      expect(state.sidebarOpen).toBe(true)
      expect(state.nodePoolOpen).toBe(true)

      store.getState().setRelationshipHighlightMode(false)
      expect(store.getState().relationshipHighlightMode).toBe(false)
    })

    it('toggleDragMode 在 free/grid 之间来回切换', async () => {
      const { ui } = await freshUI()
      const store = ui.useUIStore

      store.getState().toggleDragMode()
      expect(store.getState().dragMode).toBe('grid')
      store.getState().toggleDragMode()
      expect(store.getState().dragMode).toBe('free')
    })

    it('setZoomStep 把步长夹在 0.01~0.5', async () => {
      const { ui } = await freshUI()
      const store = ui.useUIStore

      store.getState().setZoomStep(2)
      expect(store.getState().zoomStep).toBe(0.5)
      store.getState().setZoomStep(0.001)
      expect(store.getState().zoomStep).toBe(0.01)
      store.getState().setZoomStep(0.25)
      expect(store.getState().zoomStep).toBe(0.25)
    })
  })

  describe('样式面板与选中类型', () => {
    it('open/closeStylePanel 只切换 stylePanelOpen', async () => {
      const { ui } = await freshUI()
      const store = ui.useUIStore

      store.getState().openStylePanel()
      expect(store.getState().stylePanelOpen).toBe(true)
      store.getState().closeStylePanel()
      expect(store.getState().stylePanelOpen).toBe(false)
    })

    it('面板打开时切换选中类型会关掉面板，同类型重复设置则保持打开', async () => {
      const { ui } = await freshUI()
      const store = ui.useUIStore

      store.getState().setSelectedType('node')
      expect(store.getState().stylePanelOpen).toBe(false)
      expect(store.getState().selectedType).toBe('node')

      store.getState().openStylePanel()
      store.getState().setSelectedType('node')
      expect(store.getState().stylePanelOpen).toBe(true)

      store.getState().setSelectedType('connection')
      expect(store.getState().stylePanelOpen).toBe(false)
      expect(store.getState().selectedType).toBe('connection')
    })

    it('面板关闭时改选中类型不动 stylePanelOpen', async () => {
      const { ui } = await freshUI()
      const store = ui.useUIStore
      expect(store.getState().stylePanelOpen).toBe(false)

      store.getState().setSelectedType('domain')

      expect(store.getState().selectedType).toBe('domain')
      expect(store.getState().stylePanelOpen).toBe(false)
    })

    it('setSelectedNodeIds 原样写入 ids', async () => {
      const { ui } = await freshUI()

      ui.useUIStore.getState().setSelectedNodeIds(['a', 'b'])

      expect(ui.useUIStore.getState().selectedNodeIds).toEqual(['a', 'b'])
    })
  })

  describe('右键菜单', () => {
    it('openContextMenu 记录位置与可选 target；closeContextMenu 三者一起清空', async () => {
      const { ui } = await freshUI()
      const store = ui.useUIStore

      store.getState().openContextMenu(12, 34)
      expect(store.getState().contextMenuOpen).toBe(true)
      expect(store.getState().contextMenuPosition).toEqual({ x: 12, y: 34 })
      expect(store.getState().contextMenuTarget).toBeNull()

      store.getState().openContextMenu(1, 2, 'node-9')
      expect(store.getState().contextMenuTarget).toBe('node-9')

      store.getState().closeContextMenu()
      const state = store.getState()
      expect(state.contextMenuOpen).toBe(false)
      expect(state.contextMenuPosition).toBeNull()
      expect(state.contextMenuTarget).toBeNull()
    })
  })

  describe('对话框开关', () => {
    it('每个对话框独立打开/关闭，互不串扰', async () => {
      const { ui } = await freshUI()
      const store = ui.useUIStore
      const dialogs = [
        ['settingsOpen', 'setSettingsOpen'],
        ['accountSettingsOpen', 'setAccountSettingsOpen'],
        ['shortcutsOpen', 'setShortcutsOpen'],
        ['searchOpen', 'setSearchOpen'],
        ['commandPaletteOpen', 'setCommandPaletteOpen'],
        ['collaborationOpen', 'setCollaborationOpen'],
        ['nodeSearchOpen', 'setNodeSearchOpen'],
      ] as const

      for (const [field, setter] of dialogs) {
        expect(store.getState()[field]).toBe(false)
        store.getState()[setter](true)
        expect(store.getState()[field]).toBe(true)
      }
      for (const [field, setter] of dialogs) {
        store.getState()[setter](false)
        expect(store.getState()[field]).toBe(false)
      }
    })
  })

  describe('拖拽中转状态', () => {
    it('画布→节点池与节点池→画布的 setter 都写回原值并可清空', async () => {
      const { ui } = await freshUI()
      const store = ui.useUIStore
      const node = {
        id: 'n1',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        title: 't',
        content: 'c',
        fontSize: 14,
        textAlign: 'left' as const,
        collapsed: false,
        locked: false,
      }
      const card = {
        id: 3,
        userId: 1,
        name: '卡片',
        content: '',
        type: 'text',
        color: '#fff',
        tags: null,
        useCount: 0,
        createdBy: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        sortOrder: 0,
      }

      store.getState().setDraggingNodeFromCanvas({ nodeId: 'n1', nodeData: node })
      store.getState().setIsOverNodePool(true)
      store.getState().setCanvasDragGhostPosition({ x: 5, y: 6 })
      store.getState().setDraggingCardFromPool(card)
      store.getState().setIsOverCanvas(true)
      store.getState().setPoolDragGhostPosition({ x: 7, y: 8 })
      store.getState().setOverFolderId(21)

      let state = store.getState()
      expect(state.draggingNodeFromCanvas).toEqual({ nodeId: 'n1', nodeData: node })
      expect(state.isOverNodePool).toBe(true)
      expect(state.canvasDragGhostPosition).toEqual({ x: 5, y: 6 })
      expect(state.draggingCardFromPool).toEqual(card)
      expect(state.isOverCanvas).toBe(true)
      expect(state.poolDragGhostPosition).toEqual({ x: 7, y: 8 })
      expect(state.overFolderId).toBe(21)

      store.getState().setDraggingNodeFromCanvas(null)
      store.getState().setDraggingCardFromPool(null)
      store.getState().setCanvasDragGhostPosition(null)
      store.getState().setPoolDragGhostPosition(null)
      store.getState().setOverFolderId(null)
      store.getState().setIsOverNodePool(false)
      store.getState().setIsOverCanvas(false)

      state = store.getState()
      expect(state.draggingNodeFromCanvas).toBeNull()
      expect(state.draggingCardFromPool).toBeNull()
      expect(state.canvasDragGhostPosition).toBeNull()
      expect(state.poolDragGhostPosition).toBeNull()
      expect(state.overFolderId).toBeNull()
      expect(state.isOverNodePool).toBe(false)
      expect(state.isOverCanvas).toBe(false)
    })

    it('setLoading / setCurrentTool / 连线三件套', async () => {
      const { ui } = await freshUI()
      const store = ui.useUIStore

      store.getState().setLoading(true)
      expect(store.getState().isLoading).toBe(true)

      store.getState().setCurrentTool('connection')
      expect(store.getState().currentTool).toBe('connection')

      store.getState().setConnectionDirection('bidirectional')
      store.getState().setConnectionStyle('dashed')
      store.getState().setConnectionType('step')

      const state = store.getState()
      expect(state.connectionDirection).toBe('bidirectional')
      expect(state.connectionStyle).toBe('dashed')
      expect(state.connectionType).toBe('step')
    })
  })

  describe('主题（真实 DOM 副作用）', () => {
    // setup.ts 的 matchMedia 桩把 matches 做成了函数（恒真值），themeManager 读的是
    // 属性，所以这里换成属性版桩，让 system 主题的解析结果可控。
    function stubSystemTheme(dark: boolean): void {
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: (query: string) => ({
          matches: dark,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }),
      })
    }

    it('setTheme(dark) 写入状态并给 <html> 加 dark 类', async () => {
      const { ui } = await freshUI()

      ui.useUIStore.getState().setTheme('dark')

      expect(ui.useUIStore.getState().theme).toBe('dark')
      expect(document.documentElement.classList.contains('dark')).toBe(true)
    })

    it('setTheme(light) 移除 dark 类', async () => {
      const { ui } = await freshUI()
      ui.useUIStore.getState().setTheme('dark')
      expect(document.documentElement.classList.contains('dark')).toBe(true)

      ui.useUIStore.getState().setTheme('light')

      expect(ui.useUIStore.getState().theme).toBe('light')
      expect(document.documentElement.classList.contains('dark')).toBe(false)
    })

    it('setTheme(system) 跟随系统偏好：dark→加类，light→去类', async () => {
      stubSystemTheme(true)
      const { ui } = await freshUI()

      ui.useUIStore.getState().setTheme('system')
      expect(ui.useUIStore.getState().theme).toBe('system')
      expect(document.documentElement.classList.contains('dark')).toBe(true)

      stubSystemTheme(false)
      ui.useUIStore.getState().setTheme('light')
      expect(document.documentElement.classList.contains('dark')).toBe(false)
      ui.useUIStore.getState().setTheme('system')
      expect(document.documentElement.classList.contains('dark')).toBe(false)
    })

    it('initializeTheme 按当前存储的主题刷新 DOM（而不是固定 light）', async () => {
      const { ui } = await freshUI()
      ui.useUIStore.setState({ theme: 'dark' })
      document.documentElement.classList.remove('dark')

      ui.useUIStore.getState().initializeTheme()

      expect(document.documentElement.classList.contains('dark')).toBe(true)
    })
  })

  describe('toast 生命周期', () => {
    it('addToast 分配 id，默认 3000ms 后自动移除（2999ms 时仍在）', async () => {
      const { ui } = await freshUI()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

      ui.useUIStore.getState().addToast({ type: 'success', title: 'ok', message: 'm' })

      const toast = toasts(ui.useUIStore.getState())[0] as Toast
      expect(toast).toBeTruthy()
      expect(toast.id).toBeTruthy()
      expect(toast.type).toBe('success')
      expect(toast.title).toBe('ok')
      expect(toast.message).toBe('m')

      vi.advanceTimersByTime(2999)
      expect(toasts(ui.useUIStore.getState())).toHaveLength(1)
      vi.advanceTimersByTime(1)
      expect(toasts(ui.useUIStore.getState())).toHaveLength(0)
    })

    it('duration 精确控制存活时间', async () => {
      const { ui } = await freshUI()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

      ui.useUIStore.getState().addToast({ type: 'info', title: 't', duration: 5000 })

      vi.advanceTimersByTime(4999)
      expect(toasts(ui.useUIStore.getState())).toHaveLength(1)
      vi.advanceTimersByTime(1)
      expect(toasts(ui.useUIStore.getState())).toHaveLength(0)
    })

    it('duration:0 的 toast 永不自动消失，只能 removeToast', async () => {
      const { ui } = await freshUI()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

      ui.useUIStore.getState().addToast({ type: 'warning', title: 'sticky', duration: 0 })
      const id = toasts(ui.useUIStore.getState())[0]?.id as string

      vi.advanceTimersByTime(60000)
      expect(toasts(ui.useUIStore.getState())).toHaveLength(1)

      ui.useUIStore.getState().removeToast(id)
      expect(toasts(ui.useUIStore.getState())).toHaveLength(0)
    })

    it('超过 maxToasts(5) 时丢弃最旧的', async () => {
      const { ui } = await freshUI()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

      for (let i = 0; i < 7; i++) {
        ui.useUIStore.getState().addToast({ type: 'info', title: `t${i}`, duration: 0 })
      }

      const list = toasts(ui.useUIStore.getState())
      expect(list).toHaveLength(5)
      expect(list.map((t) => t.title)).toEqual(['t2', 't3', 't4', 't5', 't6'])
    })

    it('removeToast 只删指定 id，其余保序', async () => {
      const { ui } = await freshUI()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const store = ui.useUIStore
      store.getState().addToast({ type: 'info', title: 'a', duration: 0 })
      store.getState().addToast({ type: 'info', title: 'b', duration: 0 })
      store.getState().addToast({ type: 'info', title: 'c', duration: 0 })
      const idB = toasts(store.getState())[1]?.id as string

      store.getState().removeToast(idB)

      expect(toasts(store.getState()).map((t) => t.title)).toEqual(['a', 'c'])
    })

    it('四个便捷方法带各自默认中文标题，显式标题可覆盖', async () => {
      const { ui } = await freshUI()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const store = ui.useUIStore

      store.getState().addErrorToast('出错了')
      store.getState().addSuccessToast('好了')
      store.getState().addWarningToast('小心')
      store.getState().addInfoToast('说一下')

      const list = toasts(store.getState())
      expect(list).toHaveLength(4)
      expect(list.map((t) => [t.type, t.title, t.message])).toEqual([
        ['error', '错误', '出错了'],
        ['success', '成功', '好了'],
        ['warning', '警告', '小心'],
        ['info', '提示', '说一下'],
      ])
      expect(new Set(list.map((t) => t.id)).size).toBe(4)

      store.getState().addErrorToast('m', '自定义标题')
      const extra = toasts(store.getState())[4] as Toast
      expect(extra.title).toBe('自定义标题')
      expect(extra.type).toBe('error')
    })
  })

  describe('节点默认配置', () => {
    it('初始值就是共享默认（200x160/#ffffff/fontSize 14）', async () => {
      const { ui } = await freshUI()

      const defaults = ui.useUIStore.getState().nodeDefaults
      expect(defaults.textNode.width).toBe(200)
      expect(defaults.textNode.color).toBe('#ffffff')
      expect(defaults.textNode.fontSize).toBe(14)
      expect(defaults.imageNode.height).toBe(160)
    })

    it('setNodeDefaults / resetNodeDefaults 真实替换与还原', async () => {
      const { ui } = await freshUI()
      const store = ui.useUIStore

      store.getState().setNodeDefaults(CUSTOM_DEFAULTS)
      expect(store.getState().nodeDefaults).toEqual(CUSTOM_DEFAULTS)

      store.getState().resetNodeDefaults()
      expect(store.getState().nodeDefaults.textNode.color).toBe('#ffffff')
      expect(store.getState().nodeDefaults.textNode.width).toBe(200)
    })

    it('loadNodeDefaults：无 token 时不请求、不改状态', async () => {
      const { ui, fetchMock } = await freshUI({
        '/api/users/settings/node-defaults': () => ok(SERVER_DEFAULTS),
      })
      ui.useUIStore.setState({ nodeDefaults: CUSTOM_DEFAULTS })
      fetchMock.mockClear()

      await ui.useUIStore.getState().loadNodeDefaults()

      expect(fetchMock).not.toHaveBeenCalled()
      expect(ui.useUIStore.getState().nodeDefaults).toEqual(CUSTOM_DEFAULTS)
      expect(ui.useUIStore.getState().toasts).toEqual([])
    })

    it('loadNodeDefaults：有 token 时用真实 GET 拉取并写入', async () => {
      const { ui, auth, fetchMock } = await freshUI({
        '/api/users/settings/node-defaults': () => ok(SERVER_DEFAULTS),
      })
      auth.useAuthStore.setState({ token: 'jwt-1' })

      await ui.useUIStore.getState().loadNodeDefaults()

      expect(ui.useUIStore.getState().nodeDefaults).toEqual(SERVER_DEFAULTS)
      const get = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input) === '/api/users/settings/node-defaults' && init?.method === 'GET'
      )
      expect(get).toBeTruthy()
    })

    it('loadNodeDefaults：响应缺 imageNode 时保持旧值并警告', async () => {
      const { ui, auth } = await freshUI({
        '/api/users/settings/node-defaults': () => ok({ textNode: SERVER_DEFAULTS.textNode }),
      })
      auth.useAuthStore.setState({ token: 'jwt-1' })
      ui.useUIStore.setState({ nodeDefaults: CUSTOM_DEFAULTS })

      await ui.useUIStore.getState().loadNodeDefaults()

      expect(ui.useUIStore.getState().nodeDefaults).toEqual(CUSTOM_DEFAULTS)
    })

    it('loadNodeDefaults：接口失败时保住旧值并加一条 error toast', async () => {
      const { ui, auth } = await freshUI({
        '/api/users/settings/node-defaults': () => fail(500, '服务器内部错误'),
      })
      auth.useAuthStore.setState({ token: 'jwt-1' })
      ui.useUIStore.setState({ nodeDefaults: CUSTOM_DEFAULTS })

      await ui.useUIStore.getState().loadNodeDefaults()

      expect(ui.useUIStore.getState().nodeDefaults).toEqual(CUSTOM_DEFAULTS)
      const list = toasts(ui.useUIStore.getState())
      expect(list).toHaveLength(1)
      expect(list[0]?.type).toBe('error')
      expect(list[0]?.message).toBe('加载节点默认配置失败，将使用本地默认值')
      expect(list[0]?.title).toBe('提示')
    })

    it('saveNodeDefaults 把当前配置 PUT 到 settings 端点', async () => {
      const { ui, fetchMock } = await freshUI({
        '/api/users/settings/node-defaults': () => ok(CUSTOM_DEFAULTS),
      })
      ui.useUIStore.setState({ nodeDefaults: CUSTOM_DEFAULTS })

      await expect(ui.useUIStore.getState().saveNodeDefaults()).resolves.toBeUndefined()

      const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')
      expect(put?.[0]).toBe('/api/users/settings/node-defaults')
      expect(JSON.parse(put?.[1]?.body as string)).toEqual(CUSTOM_DEFAULTS)
    })

    it('saveNodeDefaults 失败时向上抛出（N3：不吞错）', async () => {
      const { ui } = await freshUI({
        '/api/users/settings/node-defaults': () => fail(500, '保存失败'),
      })

      await expect(ui.useUIStore.getState().saveNodeDefaults()).rejects.toThrow('保存失败')
    })
  })

  describe('resetForLogout / resetForLogin', () => {
    it('resetForLogout 把 nodeDefaults 还原为默认值并关掉默认配置弹窗', async () => {
      const { ui } = await freshUI()
      const store = ui.useUIStore
      store.getState().setNodeDefaults(CUSTOM_DEFAULTS)
      store.getState().setNodeDefaultsOpen(true)

      store.getState().resetForLogout()

      const state = store.getState()
      expect(state.nodeDefaults.textNode.color).toBe('#ffffff')
      expect(state.nodeDefaults.textNode.width).toBe(200)
      expect(state.nodeDefaults.imageNode.fontSize).toBe(14)
      expect(state.nodeDefaultsOpen).toBe(false)
    })

    it('resetForLogout 的当前契约：只清这两个字段，其余内存态不动', async () => {
      const { ui } = await freshUI()
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const store = ui.useUIStore
      store.getState().addToast({ type: 'info', title: 'sticky', duration: 0 })
      store.getState().openContextMenu(1, 2, 'node-1')
      store.getState().setSidebarOpen(false)
      store.getState().setNodeDefaults(CUSTOM_DEFAULTS)
      const toastBefore = toasts(store.getState())

      store.getState().resetForLogout()

      const state = store.getState()
      expect(state.toasts).toEqual(toastBefore)
      expect(state.contextMenuOpen).toBe(true)
      expect(state.sidebarOpen).toBe(false)
      // 这两个是被清的（防止上面的"不变"断言恒真）
      expect(state.nodeDefaultsOpen).toBe(false)
      expect(state.nodeDefaults).not.toEqual(CUSTOM_DEFAULTS)
    })

    it('resetForLogin 只还原 nodeDefaults，不动弹窗开关', async () => {
      const { ui } = await freshUI()
      const store = ui.useUIStore
      store.getState().setNodeDefaults(CUSTOM_DEFAULTS)
      store.getState().setNodeDefaultsOpen(true)

      store.getState().resetForLogin()

      expect(store.getState().nodeDefaults.textNode.width).toBe(200)
      expect(store.getState().nodeDefaultsOpen).toBe(true)
    })
  })

  describe('持久化（真实 localStorage 读写）', () => {
    it('partialize 恰好落盘这 9 个偏好字段（nodeDefaults/toasts 不落盘）', async () => {
      const { ui } = await freshUI()
      const store = ui.useUIStore
      store.setState({
        theme: 'dark',
        sidebarOpen: false,
        nodePoolOpen: false,
        dragMode: 'grid',
        gridVisible: false,
        minimapVisible: false,
        quickEditMode: true,
        relationshipHighlightMode: true,
        zoomStep: 0.25,
        nodeDefaults: CUSTOM_DEFAULTS,
        toasts: [{ id: 't1', type: 'info', title: '不落盘' }],
        contextMenuOpen: true,
      })

      const raw = localStorage.getItem(SETTINGS_KEY)
      expect(raw).toBeTruthy()
      const saved = JSON.parse(raw as string) as { state?: Record<string, unknown> }
      expect(saved.state).toEqual({
        theme: 'dark',
        sidebarOpen: false,
        nodePoolOpen: false,
        dragMode: 'grid',
        gridVisible: false,
        minimapVisible: false,
        quickEditMode: true,
        relationshipHighlightMode: true,
        zoomStep: 0.25,
      })
    })

    it('新建 store 时从 localStorage 恢复偏好，并立即应用持久化主题', async () => {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({ state: { theme: 'dark', sidebarOpen: false, zoomStep: 0.3 } })
      )
      vi.resetModules()
      const ui = (await import('@/store/useUIStore')) as UIModule

      const state = ui.useUIStore.getState()
      expect(state.theme).toBe('dark')
      expect(state.sidebarOpen).toBe(false)
      expect(state.zoomStep).toBe(0.3)
      // 未持久化的字段回到代码默认值
      expect(state.gridVisible).toBe(true)
      expect(state.nodePoolOpen).toBe(true)
      // onRehydrateStorage 真的把 dark 类加到 <html>
      expect(document.documentElement.classList.contains('dark')).toBe(true)
    })
  })
})
