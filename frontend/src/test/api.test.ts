// services/api.ts 端点契约测试。
// 只 stub 真正的边界 fetch：被测模块 api.ts 与它的协作者 apiClient 都是真货，
// 因为这一层的全部风险就是"端点写错 / 动词写错 / 信封解包写错"。
// 断言对象是 fetch 实际收到的请求（method / URL / headers / body）与解包后的返回值。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as Y from 'yjs'
import type { ApiClient } from '@/services/apiClient'
import type { NodeDefaults } from '@/types'
import { ensureRoot, entityToYMap } from '@/services/yjs-schema'

type ApiModule = typeof import('@/services/api')
type Route = (init?: RequestInit) => Response | Promise<Response>

interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: BodyInit | null | undefined
}

const CSRF = 'csrf-test'
const TOKEN = 'jwt-test'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

interface FetchOptions {
  routes?: Record<string, Route>
  /** 成功信封里 data 的内容；默认用 "METHOD url" 标记，一次断言同时锁住动词与端点。 */
  data?: (url: string, method: string) => unknown
}

async function freshApi(options: FetchOptions = {}): Promise<{
  api: ApiModule
  client: ApiClient
  requests: RecordedRequest[]
  fetchMock: ReturnType<typeof vi.fn>
}> {
  const requests: RecordedRequest[] = []
  vi.resetModules()
  const api = (await import('@/services/api')) as ApiModule

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    requests.push({
      url,
      method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    })
    const route = options.routes?.[url]
    if (route) return route(init)
    if (url.includes('/api/csrf-token')) return json(200, { success: true, token: CSRF })
    const data = options.data ? options.data(url, method) : `${method} ${url}`
    return json(200, { success: true, data })
  })
  vi.stubGlobal('fetch', fetchMock)
  api.apiClient.setToken(TOKEN)

  return { api, client: api.apiClient, requests, fetchMock }
}

function last(requests: RecordedRequest[]): RecordedRequest {
  const entry = requests[requests.length - 1]
  expect(entry).toBeTruthy()
  return entry as RecordedRequest
}

function asFormData(body: BodyInit | null | undefined): FormData {
  expect(body).toBeInstanceOf(FormData)
  return body as FormData
}

describe('services/api.ts', () => {
  beforeEach(() => {
    localStorage.clear()
    document.cookie = `x-csrf-token=${CSRF}; path=/`
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.cookie = 'x-csrf-token=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'
    localStorage.clear()
  })

  describe('端点契约（URL + 动词 + body + 信封解包）', () => {
    interface Case {
      name: string
      method: string
      url: string
      call: (api: ApiModule) => Promise<unknown>
      body?: string
      /** 包装层吞掉返回值（logout），只断言请求本身。 */
      voidResult?: boolean
    }

    const USER = { id: 1, email: 'a@b.c', nickname: null, avatar: null }
    const cases: Case[] = [
      // Auth
      {
        name: 'register → POST /api/auth/register',
        method: 'POST',
        url: '/api/auth/register',
        call: (api) => api.register({ email: 'a@b.c', password: 'pw123456', nickname: 'n' }),
        body: JSON.stringify({ email: 'a@b.c', password: 'pw123456', nickname: 'n' }),
      },
      {
        name: 'login → POST /api/auth/login',
        method: 'POST',
        url: '/api/auth/login',
        call: (api) => api.login({ email: 'a@b.c', password: 'pw123456' }),
        body: JSON.stringify({ email: 'a@b.c', password: 'pw123456' }),
      },
      {
        name: 'logout → POST /api/auth/logout（无 body）',
        method: 'POST',
        url: '/api/auth/logout',
        call: (api) => api.logout(),
        voidResult: true,
      },
      {
        name: 'refreshToken → POST /api/auth/refresh',
        method: 'POST',
        url: '/api/auth/refresh',
        call: (api) => api.refreshToken(),
      },
      // User
      {
        name: 'getProfile → GET /api/users/profile',
        method: 'GET',
        url: '/api/users/profile',
        call: (api) => api.getProfile(),
      },
      {
        name: 'updateProfile → PUT /api/users/profile',
        method: 'PUT',
        url: '/api/users/profile',
        call: (api) => api.updateProfile({ nickname: '新昵称' }),
        body: JSON.stringify({ nickname: '新昵称' }),
      },
      {
        name: 'changePassword → PUT /api/users/password',
        method: 'PUT',
        url: '/api/users/password',
        call: (api) => api.changePassword({ currentPassword: 'old', newPassword: 'new' }),
        body: JSON.stringify({ currentPassword: 'old', newPassword: 'new' }),
      },
      {
        name: 'deleteAccount → DELETE /api/users/account（带 body）',
        method: 'DELETE',
        url: '/api/users/account',
        call: (api) => api.deleteAccount({ password: 'pw', confirmation: 'pw' }),
        body: JSON.stringify({ password: 'pw', confirmation: 'pw' }),
      },
      // Projects
      {
        name: 'getProjects → GET /api/projects',
        method: 'GET',
        url: '/api/projects',
        call: (api) => api.getProjects(),
      },
      {
        name: 'getProject → GET /api/projects/:id',
        method: 'GET',
        url: '/api/projects/4',
        call: (api) => api.getProject(4),
      },
      {
        name: 'createProject → POST /api/projects',
        method: 'POST',
        url: '/api/projects',
        call: (api) =>
          api.createProject({
            name: '新项目',
            description: null,
            ownerId: 1,
            groupId: null,
            thumbnail: null,
            isPublic: false,
            isCollaborative: true,
          }),
        body: JSON.stringify({
          name: '新项目',
          description: null,
          ownerId: 1,
          groupId: null,
          thumbnail: null,
          isPublic: false,
          isCollaborative: true,
        }),
      },
      {
        name: 'updateProject → PUT /api/projects/:id',
        method: 'PUT',
        url: '/api/projects/4',
        call: (api) => api.updateProject(4, { name: '改名' }),
        body: JSON.stringify({ name: '改名' }),
      },
      {
        name: 'deleteProject → DELETE /api/projects/:id',
        method: 'DELETE',
        url: '/api/projects/4',
        call: (api) => api.deleteProject(4),
      },
      // Canvases
      {
        name: 'getCanvases → GET /api/canvases/:projectId',
        method: 'GET',
        url: '/api/canvases/7',
        call: (api) => api.getCanvases(7),
      },
      {
        name: 'getCanvas → GET /api/canvases/detail/:id（不是 /api/canvases/:id）',
        method: 'GET',
        url: '/api/canvases/detail/7',
        call: (api) => api.getCanvas(7),
      },
      {
        name: 'createCanvas → POST /api/canvases/:projectId',
        method: 'POST',
        url: '/api/canvases/7',
        call: (api) => api.createCanvas(7, { name: '画布A' }),
        body: JSON.stringify({ name: '画布A' }),
      },
      {
        name: 'updateCanvas → PUT /api/canvases/:id',
        method: 'PUT',
        url: '/api/canvases/9',
        call: (api) => api.updateCanvas(9, { name: '画布B', clientVersion: 3 }),
        body: JSON.stringify({ name: '画布B', clientVersion: 3 }),
      },
      {
        name: 'deleteCanvas → DELETE /api/canvases/:id',
        method: 'DELETE',
        url: '/api/canvases/9',
        call: (api) => api.deleteCanvas(9),
      },
      // Folders
      {
        name: 'getFolders → GET /api/canvases/:projectId/folders',
        method: 'GET',
        url: '/api/canvases/7/folders',
        call: (api) => api.getFolders(7),
      },
      {
        name: 'createFolder → POST /api/canvases/:projectId/folders',
        method: 'POST',
        url: '/api/canvases/7/folders',
        call: (api) =>
          api.createFolder(7, { name: '文件夹', projectId: 7, parentId: null, sortOrder: 0 }),
        body: JSON.stringify({ name: '文件夹', projectId: 7, parentId: null, sortOrder: 0 }),
      },
      {
        name: 'updateFolder → PUT /api/canvases/folders/:id',
        method: 'PUT',
        url: '/api/canvases/folders/4',
        call: (api) => api.updateFolder(4, { name: '改名' }),
        body: JSON.stringify({ name: '改名' }),
      },
      {
        name: 'deleteFolder → DELETE /api/canvases/folders/:id',
        method: 'DELETE',
        url: '/api/canvases/folders/4',
        call: (api) => api.deleteFolder(4),
      },
      // Node pool
      {
        name: 'getNodePool → GET /api/users/node-pool',
        method: 'GET',
        url: '/api/users/node-pool',
        call: (api) => api.getNodePool(),
      },
      {
        name: 'addToNodePool → POST /api/users/node-pool',
        method: 'POST',
        url: '/api/users/node-pool',
        call: (api) =>
          api.addToNodePool({
            name: '卡片',
            content: 'c',
            type: 'text',
            color: '#fff',
            tags: null,
            sortOrder: 0,
          }),
        body: JSON.stringify({
          name: '卡片',
          content: 'c',
          type: 'text',
          color: '#fff',
          tags: null,
          sortOrder: 0,
        }),
      },
      {
        name: 'removeFromNodePool → DELETE /api/users/node-pool/:id',
        method: 'DELETE',
        url: '/api/users/node-pool/3',
        call: (api) => api.removeFromNodePool(3),
      },
      {
        name: 'updateNodeCard → PUT /api/users/node-pool/:id',
        method: 'PUT',
        url: '/api/users/node-pool/3',
        call: (api) => api.updateNodeCard(3, { name: '改名' }),
        body: JSON.stringify({ name: '改名' }),
      },
      {
        name: 'incrementNodeCardUseCount → POST /api/users/node-pool/:id/increment-use',
        method: 'POST',
        url: '/api/users/node-pool/3/increment-use',
        call: (api) => api.incrementNodeCardUseCount(3),
      },
      // Node pool folders
      {
        name: 'getNodePoolFolders → GET /api/users/node-pool-folders',
        method: 'GET',
        url: '/api/users/node-pool-folders',
        call: (api) => api.getNodePoolFolders(),
      },
      {
        name: 'createNodePoolFolder → POST /api/users/node-pool-folders',
        method: 'POST',
        url: '/api/users/node-pool-folders',
        call: (api) =>
          api.createNodePoolFolder({
            name: '分组',
            parentId: null,
            sortOrder: 1,
            collapsed: false,
          }),
        body: JSON.stringify({ name: '分组', parentId: null, sortOrder: 1, collapsed: false }),
      },
      {
        name: 'updateNodePoolFolder → PUT /api/users/node-pool-folders/:id',
        method: 'PUT',
        url: '/api/users/node-pool-folders/5',
        call: (api) => api.updateNodePoolFolder(5, { sortOrder: 2 }),
        body: JSON.stringify({ sortOrder: 2 }),
      },
      {
        name: 'deleteNodePoolFolder → DELETE /api/users/node-pool-folders/:id',
        method: 'DELETE',
        url: '/api/users/node-pool-folders/5',
        call: (api) => api.deleteNodePoolFolder(5),
      },
      // User settings
      {
        name: 'getNodeDefaults → GET /api/users/settings/node-defaults',
        method: 'GET',
        url: '/api/users/settings/node-defaults',
        call: (api) => api.getNodeDefaults(),
      },
      {
        name: 'updateNodeDefaults → PUT /api/users/settings/node-defaults',
        method: 'PUT',
        url: '/api/users/settings/node-defaults',
        call: (api) =>
          api.updateNodeDefaults({
            textNode: {
              width: 210,
              height: 160,
              color: '#ffffff',
              fontSize: 14,
              titleAlign: 'left',
              collapsedTitleAlign: 'left',
              contentAlign: 'left',
            },
            imageNode: {
              width: 200,
              height: 160,
              fontSize: 14,
              titleAlign: 'left',
              collapsedTitleAlign: 'left',
            },
          }),
      },
      // Collaboration
      {
        name: 'getProjectMembers → GET /api/collaboration/projects/:id/members',
        method: 'GET',
        url: '/api/collaboration/projects/7/members',
        call: (api) => api.getProjectMembers(7),
      },
      {
        name: 'inviteUserToProject → POST /api/collaboration/projects/:id/invite（默认 role=viewer）',
        method: 'POST',
        url: '/api/collaboration/projects/7/invite',
        call: (api) => api.inviteUserToProject(7, 42),
        body: JSON.stringify({ userId: 42, role: 'viewer' }),
      },
      {
        name: 'inviteUserToProject(editor) → body 里带上 role',
        method: 'POST',
        url: '/api/collaboration/projects/7/invite',
        call: (api) => api.inviteUserToProject(7, 42, 'editor'),
        body: JSON.stringify({ userId: 42, role: 'editor' }),
      },
      {
        name: 'getMyInvitations → GET /api/collaboration/invitations',
        method: 'GET',
        url: '/api/collaboration/invitations',
        call: (api) => api.getMyInvitations(),
      },
      {
        name: 'acceptInvitation → POST /api/collaboration/invitations/:id/accept',
        method: 'POST',
        url: '/api/collaboration/invitations/8/accept',
        call: (api) => api.acceptInvitation(8),
      },
      {
        name: 'rejectInvitation → POST /api/collaboration/invitations/:id/reject',
        method: 'POST',
        url: '/api/collaboration/invitations/8/reject',
        call: (api) => api.rejectInvitation(8),
      },
      {
        name: 'removeProjectMember → DELETE /api/collaboration/projects/:p/members/:u',
        method: 'DELETE',
        url: '/api/collaboration/projects/7/members/42',
        call: (api) => api.removeProjectMember(7, 42),
      },
      {
        name: 'cancelInvitation → DELETE /api/collaboration/invitations/:id',
        method: 'DELETE',
        url: '/api/collaboration/invitations/8',
        call: (api) => api.cancelInvitation(8),
      },
      {
        name: 'updateMemberRole → PUT /api/collaboration/projects/:p/members/:u/role',
        method: 'PUT',
        url: '/api/collaboration/projects/7/members/42/role',
        call: (api) => api.updateMemberRole(7, 42, 'editor'),
        body: JSON.stringify({ role: 'editor' }),
      },
    ]

    cases.forEach((testCase) => {
      it(testCase.name, async () => {
        const { api, requests } = await freshApi()

        if (testCase.voidResult) {
          await expect(testCase.call(api)).resolves.toBeUndefined()
        } else {
          await expect(testCase.call(api)).resolves.toBe(`${testCase.method} ${testCase.url}`)
        }

        const request = last(requests)
        expect(request.url).toBe(testCase.url)
        expect(request.method).toBe(testCase.method)
        if (testCase.body !== undefined) expect(request.body).toBe(testCase.body)
      })
    })

    it('写请求带上 cookie 里的 x-csrf-token，GET 也带 Authorization', async () => {
      const { api, requests } = await freshApi()

      await api.createProject({
        name: 'p',
        description: null,
        ownerId: 1,
        groupId: null,
        thumbnail: null,
        isPublic: false,
        isCollaborative: false,
      })
      await api.getProjects()

      const post = requests[0] as RecordedRequest
      expect(post.headers['x-csrf-token']).toBe(CSRF)
      expect(post.headers['Authorization']).toBe(`Bearer ${TOKEN}`)
      expect(post.headers['Content-Type']).toBe('application/json')
      const get = requests[1] as RecordedRequest
      expect(get.headers['Authorization']).toBe(`Bearer ${TOKEN}`)
    })

    it('searchUsers 把查询词编码进 ?q=', async () => {
      const { api, requests } = await freshApi()

      await expect(api.searchUsers('张三 & co')).resolves.toBe(
        'GET /api/users/search?q=%E5%BC%A0%E4%B8%89%20%26%20co'
      )

      expect(requests[0]?.url).toBe('/api/users/search?q=%E5%BC%A0%E4%B8%89%20%26%20co')
      expect(requests[0]?.method).toBe('GET')
    })

    it('uploadAvatar 发 FormData（字段名 avatar）且不手写 Content-Type', async () => {
      const { api, requests } = await freshApi()

      await api.uploadAvatar(new File(['x'], 'a.png', { type: 'image/png' }))

      const request = last(requests)
      expect(request.url).toBe('/api/users/avatar')
      expect(request.method).toBe('POST')
      expect(request.headers['Content-Type']).toBeUndefined()
      expect(asFormData(request.body).get('avatar')).toBeInstanceOf(File)
    })

    it('uploadImage 发 FormData（字段名 image）到 /api/upload', async () => {
      const { api, requests } = await freshApi()

      await api.uploadImage(new File(['y'], 'b.png', { type: 'image/png' }))

      const request = last(requests)
      expect(request.url).toBe('/api/upload')
      expect(request.method).toBe('POST')
      expect(request.headers['Content-Type']).toBeUndefined()
      expect(asFormData(request.body).get('image')).toBeInstanceOf(File)
    })

    it('logout 总是清掉 apiClient 的 token（即使服务端报错）', async () => {
      const { api, client } = await freshApi({
        routes: {
          '/api/auth/logout': () => json(500, { success: false, error: '服务器内部错误' }),
        },
      })
      expect(client.getToken()).toBe(TOKEN)

      await expect(api.logout()).resolves.toBeUndefined()

      expect(client.getToken()).toBeNull()
      expect(localStorage.getItem('mindmap_token')).toBeNull()
    })

    it('login 只解包出 {user,token}，写 apiClient 是 useAuthStore 的职责', async () => {
      const { api, client } = await freshApi({
        routes: {
          '/api/auth/login': () =>
            json(200, { success: true, data: { user: USER, token: 'jwt-new' } }),
        },
      })

      const response = await api.login({ email: 'a@b.c', password: 'pw' })

      expect(response.token).toBe('jwt-new')
      expect(response.user).toEqual(USER)
      // 这一层不碰凭证：仍是调用前那个 token
      expect(client.getToken()).toBe(TOKEN)
    })
  })

  describe('响应信封解包', () => {
    // 信封的基础语义（success:true 只返回 data / success:false 抛服务端文案 /
    // 404 无 error 回退状态码文案）与 frontend/src/test/apiClient.test.ts 的
    // 「响应信封解包」「错误映射」重复，统一收口在那里，这里不再复述。
    // 本 describe 只保留 apiClient 未覆盖的行为差异。
    it('data:null 的写操作原样解包成 null', async () => {
      const { api } = await freshApi({
        routes: { '/api/projects/4': () => json(200, { success: true, data: null }) },
      })

      await expect(api.deleteProject(4)).resolves.toBeNull()
    })

    it('500 映射为统一服务器错误文案', async () => {
      const { api } = await freshApi({
        routes: { '/api/users/node-pool': () => json(500, { success: false, error: '插入失败' }) },
      })

      // 服务端给了 error 就优先用它，而不是状态码文案
      await expect(
        api.addToNodePool({
          name: 'x',
          content: '',
          type: 'text',
          color: '#fff',
          tags: null,
          sortOrder: 0,
        })
      ).rejects.toThrow('插入失败')
    })
  })

  describe('loadCanvasNodesData', () => {
    const CANVAS_URL = '/api/canvases/detail/5'
    const emptyShape = {
      nodes: [],
      groups: [],
      domains: [],
      connections: [],
      drawings: [],
      version: 0,
    }

    it('优先解码 yjsUpdate（真正的 Yjs 二进制 → 实体对象）', async () => {
      const doc = new Y.Doc()
      const collections = ensureRoot(doc)
      collections.nodes.set('n1', entityToYMap({ id: 'n1', x: 12, title: '节点一' }))
      collections.connections.set('c1', entityToYMap({ id: 'c1', fromNodeId: 'n1' }))
      const yjsUpdate = bytesToBase64(Y.encodeStateAsUpdate(doc))
      doc.destroy()

      const { api } = await freshApi({
        routes: { [CANVAS_URL]: () => json(200, { success: true, data: { id: 5, yjsUpdate } }) },
      })

      const result = await api.loadCanvasNodesData(5)

      expect(result?.nodes).toEqual([{ id: 'n1', x: 12, title: '节点一' }])
      expect(result?.connections).toEqual([{ id: 'c1', fromNodeId: 'n1' }])
      expect(result?.groups).toEqual([])
      expect(result?.version).toBe(0)
    })

    it('没有 yjsUpdate 时回退到 legacy JSON 快照并保留 version', async () => {
      const snapshot = { nodes: [{ id: 'n1' }], version: 7, extra: 'ignored' }
      const yjsData = btoa(JSON.stringify(snapshot))

      const { api } = await freshApi({
        routes: { [CANVAS_URL]: () => json(200, { success: true, data: { id: 5, yjsData } }) },
      })

      await expect(api.loadCanvasNodesData(5)).resolves.toEqual({
        nodes: [{ id: 'n1' }],
        groups: [],
        domains: [],
        connections: [],
        drawings: [],
        version: 7,
      })
    })

    it('version 不是数字时归零', async () => {
      const yjsData = btoa(JSON.stringify({ nodes: [], version: '3' }))

      const { api } = await freshApi({
        routes: { [CANVAS_URL]: () => json(200, { success: true, data: { id: 5, yjsData } }) },
      })

      const result = await api.loadCanvasNodesData(5)

      expect(result?.version).toBe(0)
    })

    it('画布存在但没有任何数据时返回空形状（而不是 null）', async () => {
      const { api } = await freshApi({
        routes: { [CANVAS_URL]: () => json(200, { success: true, data: { id: 5 } }) },
      })

      await expect(api.loadCanvasNodesData(5)).resolves.toEqual(emptyShape)
    })

    it('快照内容非法（base64 垃圾 / JSON 字面量 null）时返回空形状而不是抛出', async () => {
      const routes: Record<string, Route> = {
        [CANVAS_URL]: () =>
          json(200, { success: true, data: { id: 5, yjsData: '@@@not-base64@@@' } }),
      }
      const { api } = await freshApi({ routes })
      await expect(api.loadCanvasNodesData(5)).resolves.toEqual(emptyShape)

      const nullish = await freshApi({
        routes: {
          [CANVAS_URL]: () => json(200, { success: true, data: { id: 5, yjsData: btoa('null') } }),
        },
      })
      await expect(nullish.api.loadCanvasNodesData(5)).resolves.toEqual(emptyShape)
    })

    it('画布接口失败时返回 null', async () => {
      const { api } = await freshApi({
        routes: { [CANVAS_URL]: () => json(403, { success: false, error: '没有权限执行此操作' }) },
      })

      await expect(api.loadCanvasNodesData(5)).resolves.toBeNull()
    })
  })

  describe('默认节点配置的往返', () => {
    const SERVER_DEFAULTS: NodeDefaults = {
      textNode: {
        width: 240,
        height: 180,
        color: '#fef3c7',
        fontSize: 16,
        titleAlign: 'center',
        collapsedTitleAlign: 'center',
        contentAlign: 'center',
      },
      imageNode: {
        width: 240,
        height: 180,
        fontSize: 16,
        titleAlign: 'center',
        collapsedTitleAlign: 'center',
      },
    }

    it('getNodeDefaults / updateNodeDefaults 用的是同一个端点，PUT 把整个配置发出', async () => {
      const { api, requests } = await freshApi({
        routes: {
          '/api/users/settings/node-defaults': () =>
            json(200, { success: true, data: SERVER_DEFAULTS }),
        },
      })

      await expect(api.getNodeDefaults()).resolves.toEqual(SERVER_DEFAULTS)
      await expect(api.updateNodeDefaults(SERVER_DEFAULTS)).resolves.toEqual(SERVER_DEFAULTS)

      expect(requests[0]?.method).toBe('GET')
      expect(requests[1]?.method).toBe('PUT')
      expect(requests[1]?.body).toBe(JSON.stringify(SERVER_DEFAULTS))
    })
  })
})
