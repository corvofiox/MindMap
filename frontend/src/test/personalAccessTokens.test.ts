// PAT API 客户端测试：确认三个调用都走共享 apiClient（而不是手写 fetch）——
// 这是认证 + CSRF 头能自动附带的唯一保证。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  listPersonalAccessTokens,
  createPersonalAccessToken,
  revokePersonalAccessToken,
} from '../services/personalAccessTokens'
import { apiClient } from '../services/apiClient.js'

vi.mock('../services/apiClient.js', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}))

const get = vi.mocked(apiClient.get)
const post = vi.mocked(apiClient.post)
const del = vi.mocked(apiClient.delete)

describe('personalAccessTokens service', () => {
  beforeEach(() => {
    get.mockReset()
    post.mockReset()
    del.mockReset()
  })

  it('列表：GET /api/tokens 并解包 data.tokens', async () => {
    get.mockResolvedValue({
      tokens: [
        {
          id: 1,
          name: 'a',
          tokenPrefix: 'mmp_xxx…',
          lastUsedAt: null,
          expiresAt: null,
          createdAt: 1,
          revokedAt: null,
          revoked: false,
        },
      ],
    })

    const tokens = await listPersonalAccessTokens()

    expect(get).toHaveBeenCalledWith('/api/tokens')
    expect(tokens).toHaveLength(1)
    expect(tokens[0].name).toBe('a')
  })

  it('列表：data 缺失时回退为空数组而不是抛错', async () => {
    get.mockResolvedValue(undefined as never)
    await expect(listPersonalAccessTokens()).resolves.toEqual([])
  })

  it('创建：POST /api/tokens，未指定有效期时不发送 expiresInDays（永不过期）', async () => {
    post.mockResolvedValue({
      id: 2,
      name: 'b',
      token: 'mmp_secret',
      tokenPrefix: 'mmp_secret…',
      expiresAt: null,
      createdAt: 1,
    })

    const created = await createPersonalAccessToken({ name: 'b' })

    expect(post).toHaveBeenCalledWith('/api/tokens', { name: 'b' })
    expect(created.token).toBe('mmp_secret')
  })

  it('创建：指定有效期时原样透传 expiresInDays', async () => {
    post.mockResolvedValue({
      id: 3,
      name: 'c',
      token: 'mmp_secret2',
      tokenPrefix: 'mmp_secret…',
      expiresAt: 123,
      createdAt: 1,
    })

    await createPersonalAccessToken({ name: 'c', expiresInDays: 30 })

    expect(post).toHaveBeenCalledWith('/api/tokens', { name: 'c', expiresInDays: 30 })
  })

  it('撤销：DELETE /api/tokens/:id', async () => {
    del.mockResolvedValue(undefined as never)

    await revokePersonalAccessToken(42)

    expect(del).toHaveBeenCalledWith('/api/tokens/42')
  })
})
