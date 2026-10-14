// useAuthStore 真实行为测试：每个用例都 resetModules 后动态 import，
// 拿到全新的 store 实例，从而断言真实的初始状态与真实 action。
// 只 mock 真正的边界（fetch）；store 自身及其 api/apiClient 协作者都是真货。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { User } from '@/types'

type AuthModule = typeof import('@/store/useAuthStore')
type ApiClientModule = typeof import('@/services/apiClient')

const USER: User = {
  id: 1,
  email: 'test@example.com',
  nickname: '测试用户',
  avatar: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const NODE_DEFAULTS = {
  textNode: {
    width: 200,
    height: 160,
    color: '#ffffff',
    fontSize: 14,
    titleAlign: 'left' as const,
    collapsedTitleAlign: 'left' as const,
    contentAlign: 'left' as const,
  },
  imageNode: {
    width: 200,
    height: 160,
    fontSize: 14,
    titleAlign: 'left' as const,
    collapsedTitleAlign: 'left' as const,
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

/** /api/csrf-token 的真实信封是 { success, token }（token 在顶层，不在 data 里）。 */
function csrf(token: string): Response {
  return new Response(JSON.stringify({ success: true, token }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

type Route = (init: RequestInit | undefined) => Response

/** 按 URL 路由的 fetch 假实现；未登记的 URL 直接抛错，避免静默通过。 */
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

/** 默认路由：登录成功 + CSRF + 节点默认配置。 */
function happyRoutes(overrides: Record<string, Route> = {}): Record<string, Route> {
  return {
    '/api/auth/login': () => ok({ user: USER, token: 'jwt-1' }),
    '/api/csrf-token': () => csrf('csrf-1'),
    '/api/users/settings/node-defaults': () => ok(NODE_DEFAULTS),
    '/api/auth/logout': () => ok(null),
    '/api/users/profile': () => ok(USER),
    ...overrides,
  }
}

async function freshAuth(): Promise<{ auth: AuthModule; client: ApiClientModule }> {
  vi.resetModules()
  const auth = (await import('@/store/useAuthStore')) as AuthModule
  const client = (await import('@/services/apiClient')) as ApiClientModule
  return { auth, client }
}

describe('useAuthStore', () => {
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
      const { auth } = await freshAuth()

      const state = auth.useAuthStore.getState()
      expect(state.user).toBeNull()
      expect(state.token).toBeNull()
      expect(state.isAuthenticated).toBe(false)
      expect(state.isLoading).toBe(false)
      expect(state.error).toBeNull()
    })

    it('暴露真实存在的 action（名字与实现一致，而不是 checkAuth/updateUser 这类臆造名）', async () => {
      const { auth } = await freshAuth()

      const state = auth.useAuthStore.getState()
      expect(typeof state.login).toBe('function')
      expect(typeof state.register).toBe('function')
      expect(typeof state.logout).toBe('function')
      expect(typeof state.refreshToken).toBe('function')
      expect(typeof state.updateProfile).toBe('function')
      expect(typeof state.validateToken).toBe('function')
      expect(typeof state.clearError).toBe('function')
    })
  })

  describe('login', () => {
    it('成功后写入 user/token/isAuthenticated，并同步 localStorage 与 apiClient', async () => {
      installRouter(happyRoutes())
      const { auth, client } = await freshAuth()

      await auth.useAuthStore.getState().login({ email: USER.email, password: 'password123' })

      const state = auth.useAuthStore.getState()
      expect(state.user).toEqual(USER)
      expect(state.token).toBe('jwt-1')
      expect(state.isAuthenticated).toBe(true)
      expect(state.isLoading).toBe(false)
      expect(state.error).toBeNull()
      expect(localStorage.getItem('mindmap_token')).toBe('jwt-1')
      expect(client.apiClient.getToken()).toBe('jwt-1')
    })

    it('登录时调用的是真实的 /api/auth/login，并把凭据放进 body', async () => {
      const mock = installRouter(happyRoutes())
      const { auth } = await freshAuth()

      await auth.useAuthStore.getState().login({ email: USER.email, password: 'pw' })

      const loginCall = mock.mock.calls.find(([input]) => String(input) === '/api/auth/login')
      expect(loginCall).toBeTruthy()
      expect(loginCall?.[1]?.method).toBe('POST')
      expect(loginCall?.[1]?.body).toBe(JSON.stringify({ email: USER.email, password: 'pw' }))
    })

    it('失败时写入 error、保持未认证、isLoading 复位，并向上抛出', async () => {
      installRouter(happyRoutes({ '/api/auth/login': () => fail(401, '用户名或密码错误') }))
      const { auth } = await freshAuth()

      await expect(
        auth.useAuthStore.getState().login({ email: USER.email, password: 'wrong' }),
      ).rejects.toThrow('用户名或密码错误')

      const state = auth.useAuthStore.getState()
      expect(state.error).toBe('用户名或密码错误')
      expect(state.isLoading).toBe(false)
      expect(state.isAuthenticated).toBe(false)
      expect(state.user).toBeNull()
      expect(state.token).toBeNull()
      expect(localStorage.getItem('mindmap_token')).toBeNull()
    })

    it('isLoading 为真时重复调用被忽略（不重复发请求）', async () => {
      const mock = installRouter(happyRoutes())
      const { auth } = await freshAuth()
      auth.useAuthStore.setState({ isLoading: true })

      await auth.useAuthStore.getState().login({ email: USER.email, password: 'pw' })

      expect(mock).not.toHaveBeenCalled()
      expect(auth.useAuthStore.getState().token).toBeNull()
    })

    it('clearError 清空 error', async () => {
      const { auth } = await freshAuth()
      auth.useAuthStore.setState({ error: '旧错误' })

      auth.useAuthStore.getState().clearError()

      expect(auth.useAuthStore.getState().error).toBeNull()
    })
  })

  describe('logout', () => {
    it('清空内存状态、apiClient token 与 localStorage', async () => {
      installRouter(happyRoutes())
      const { auth, client } = await freshAuth()
      await auth.useAuthStore.getState().login({ email: USER.email, password: 'password123' })
      expect(client.apiClient.getToken()).toBe('jwt-1')

      await auth.useAuthStore.getState().logout()

      const state = auth.useAuthStore.getState()
      expect(state.user).toBeNull()
      expect(state.token).toBeNull()
      expect(state.isAuthenticated).toBe(false)
      expect(localStorage.getItem('mindmap_token')).toBeNull()
      expect(client.apiClient.getToken()).toBeNull()
    })

    it('即使 logout 接口失败也照样清空本地凭据（finally 分支）', async () => {
      installRouter(happyRoutes({ '/api/auth/logout': () => fail(500, '服务器内部错误') }))
      const { auth, client } = await freshAuth()
      auth.useAuthStore.setState({
        user: USER,
        token: 'jwt-1',
        isAuthenticated: true,
      })
      client.apiClient.setToken('jwt-1')
      localStorage.setItem('mindmap_token', 'jwt-1')

      await auth.useAuthStore.getState().logout()

      const state = auth.useAuthStore.getState()
      expect(state.isAuthenticated).toBe(false)
      expect(state.token).toBeNull()
      expect(localStorage.getItem('mindmap_token')).toBeNull()
      expect(client.apiClient.getToken()).toBeNull()
    })
  })

  describe('validateToken', () => {
    it('无 token 时直接返回 false 且不请求网络', async () => {
      const mock = installRouter(happyRoutes())
      const { auth } = await freshAuth()

      await expect(auth.useAuthStore.getState().validateToken()).resolves.toBe(false)
      expect(mock).not.toHaveBeenCalled()
      expect(auth.useAuthStore.getState().isAuthenticated).toBe(false)
    })

    it('token 有效时拉取 /api/users/profile 并置为已认证', async () => {
      const mock = installRouter(happyRoutes())
      const { auth } = await freshAuth()
      auth.useAuthStore.setState({ token: 'jwt-1' })

      await expect(auth.useAuthStore.getState().validateToken()).resolves.toBe(true)

      expect(mock.mock.calls.map(([input]) => String(input))).toContain('/api/users/profile')
      const state = auth.useAuthStore.getState()
      expect(state.user).toEqual(USER)
      expect(state.isAuthenticated).toBe(true)
    })

    it('token 失效时清空状态、清掉持久化 token 并返回 false', async () => {
      installRouter(happyRoutes({ '/api/users/profile': () => fail(401, '未授权访问，请重新登录') }))
      const { auth, client } = await freshAuth()
      auth.useAuthStore.setState({ token: 'expired', isAuthenticated: true, user: USER })
      localStorage.setItem('mindmap_token', 'expired')
      client.apiClient.setToken('expired')

      await expect(auth.useAuthStore.getState().validateToken()).resolves.toBe(false)

      const state = auth.useAuthStore.getState()
      expect(state.user).toBeNull()
      expect(state.token).toBeNull()
      expect(state.isAuthenticated).toBe(false)
      expect(localStorage.getItem('mindmap_token')).toBeNull()
      expect(client.apiClient.getToken()).toBeNull()
    })
  })

  describe('updateProfile', () => {
    it('未登录时抛出「未授权登录」且不发请求', async () => {
      const mock = installRouter(happyRoutes())
      const { auth } = await freshAuth()

      await expect(auth.useAuthStore.getState().updateProfile({ nickname: 'x' }))
        .rejects.toThrow('未授权登录')
      expect(mock).not.toHaveBeenCalled()
    })

    it('成功后用服务端返回的 user 覆盖本地 user', async () => {
      const updated = { ...USER, nickname: '新昵称' }
      const mock = installRouter(
        happyRoutes({ '/api/users/profile': () => ok(updated) }),
      )
      const { auth } = await freshAuth()
      auth.useAuthStore.setState({ user: USER, token: 'jwt-1', isAuthenticated: true })

      await auth.useAuthStore.getState().updateProfile({ nickname: '新昵称' })

      const state = auth.useAuthStore.getState()
      expect(state.user).toEqual(updated)
      expect(state.isLoading).toBe(false)
      const put = mock.mock.calls.find(([, init]) => init?.method === 'PUT')
      expect(put?.[0]).toBe('/api/users/profile')
      expect(put?.[1]?.body).toBe(JSON.stringify({ nickname: '新昵称' }))
    })

    it('失败时写入 error 并重新抛出，且 isLoading 复位', async () => {
      installRouter(happyRoutes({ '/api/users/profile': () => fail(500, '服务器内部错误') }))
      const { auth } = await freshAuth()
      auth.useAuthStore.setState({ user: USER, token: 'jwt-1', isAuthenticated: true })

      await expect(auth.useAuthStore.getState().updateProfile({ nickname: 'x' }))
        .rejects.toThrow('服务器内部错误')

      const state = auth.useAuthStore.getState()
      expect(state.error).toBe('服务器内部错误')
      expect(state.isLoading).toBe(false)
    })
  })

  describe('refreshToken', () => {
    it('无 token 时不做任何事', async () => {
      const mock = installRouter(happyRoutes())
      const { auth } = await freshAuth()

      await auth.useAuthStore.getState().refreshToken()

      expect(mock).not.toHaveBeenCalled()
    })

    it('成功时替换 token 与 user', async () => {
      installRouter(
        happyRoutes({ '/api/auth/refresh': () => ok({ user: USER, token: 'jwt-2' }) }),
      )
      const { auth, client } = await freshAuth()
      auth.useAuthStore.setState({ token: 'jwt-1', user: USER, isAuthenticated: true })

      await auth.useAuthStore.getState().refreshToken()

      const state = auth.useAuthStore.getState()
      expect(state.token).toBe('jwt-2')
      expect(state.isAuthenticated).toBe(true)
      expect(localStorage.getItem('mindmap_token')).toBe('jwt-2')
      expect(client.apiClient.getToken()).toBe('jwt-2')
    })

    it('失败时清空登录态与持久化 token', async () => {
      installRouter(happyRoutes({ '/api/auth/refresh': () => fail(401, '无效的令牌') }))
      const { auth, client } = await freshAuth()
      auth.useAuthStore.setState({ token: 'jwt-1', user: USER, isAuthenticated: true })
      localStorage.setItem('mindmap_token', 'jwt-1')

      await auth.useAuthStore.getState().refreshToken()

      const state = auth.useAuthStore.getState()
      expect(state.user).toBeNull()
      expect(state.token).toBeNull()
      expect(state.isAuthenticated).toBe(false)
      expect(localStorage.getItem('mindmap_token')).toBeNull()
      expect(client.apiClient.getToken()).toBeNull()
    })
  })
})
