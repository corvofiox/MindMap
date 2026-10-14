import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { AccessTokensPanel } from '../AccessTokensPanel'
import { useUIStore } from '@/store/useUIStore'
import {
  createPersonalAccessToken,
  listPersonalAccessTokens,
  revokePersonalAccessToken,
  type CreatedPersonalAccessToken,
  type PersonalAccessToken,
} from '@/services/personalAccessTokens'

vi.mock('@/services/personalAccessTokens', () => ({
  listPersonalAccessTokens: vi.fn(),
  createPersonalAccessToken: vi.fn(),
  revokePersonalAccessToken: vi.fn(),
}))

/** 2026-01-02T03:04:05Z，用于让"创建时间"断言与运行时时区无关。 */
const CREATED_AT = Math.floor(Date.UTC(2026, 0, 2, 3, 4, 5) / 1000)

function makeToken(overrides: Partial<PersonalAccessToken> = {}): PersonalAccessToken {
  return {
    id: 1,
    name: 'Claude Desktop',
    tokenPrefix: 'mmp_1a2b3c4d…',
    lastUsedAt: null,
    expiresAt: null,
    createdAt: CREATED_AT,
    revokedAt: null,
    revoked: false,
    ...overrides,
  }
}

const CREATED: CreatedPersonalAccessToken = {
  id: 9,
  name: '新令牌',
  token: 'mmp_deadbeefdeadbeefdeadbeefdeadbeef',
  tokenPrefix: 'mmp_deadbeef…',
  expiresAt: null,
  createdAt: CREATED_AT,
}

/** 明文令牌在 DOM 里出现的次数（文本框 value + 文本节点）。 */
function countPlaintextOccurrences(plaintext: string): number {
  let count = 0
  document.querySelectorAll('input, textarea').forEach((el) => {
    const input = el as HTMLInputElement
    if (input.value && input.value.includes(plaintext)) count += 1
  })
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    if (node.textContent && node.textContent.includes(plaintext)) count += 1
    node = walker.nextNode()
  }
  return count
}

describe('AccessTokensPanel', () => {
  beforeEach(() => {
    vi.mocked(listPersonalAccessTokens).mockReset()
    vi.mocked(createPersonalAccessToken).mockReset()
    vi.mocked(revokePersonalAccessToken).mockReset()
    useUIStore.setState({
      addToast: vi.fn(),
      addSuccessToast: vi.fn(),
      addErrorToast: vi.fn(),
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('渲染令牌列表：名称、前缀、创建时间、从未使用、永不过期', async () => {
    vi.mocked(listPersonalAccessTokens).mockResolvedValue([makeToken()])

    render(<AccessTokensPanel />)

    await waitFor(() => expect(screen.getByText('Claude Desktop')).toBeTruthy())
    expect(screen.getByText('mmp_1a2b3c4d…')).toBeTruthy()
    expect(screen.getByText('从未使用')).toBeTruthy()
    expect(screen.getByText('永不过期')).toBeTruthy()
    // 创建时间渲染为本地时间；只断言年份，避免依赖运行时时区
    expect(
      screen.getByText(new RegExp(`^${new Date(CREATED_AT * 1000).getFullYear()}/`))
    ).toBeTruthy()
  })

  it('已撤销令牌显示「已撤销」状态且不再提供撤销按钮；已过期令牌显示「已过期」', async () => {
    const revoked = makeToken({
      id: 1,
      name: '旧令牌',
      revoked: true,
      revokedAt: CREATED_AT,
    })
    const expired = makeToken({
      id: 2,
      name: '过期令牌',
      expiresAt: Math.floor(Date.now() / 1000) - 86400,
    })
    const active = makeToken({ id: 3, name: '可用令牌' })
    vi.mocked(listPersonalAccessTokens).mockResolvedValue([revoked, expired, active])

    render(<AccessTokensPanel />)

    await waitFor(() => expect(screen.getByText('旧令牌')).toBeTruthy())
    expect(screen.getByText('已撤销')).toBeTruthy()
    expect(screen.getByText('已过期')).toBeTruthy()
    // 已撤销的行不可再撤销；未撤销的两行（含已过期，仍可清理）各有一个入口
    expect(screen.getAllByRole('button', { name: /撤销/ })).toHaveLength(2)
  })

  it('创建令牌后明文只显示一次，关闭提示后不再出现', async () => {
    vi.mocked(listPersonalAccessTokens).mockResolvedValue([])
    vi.mocked(createPersonalAccessToken).mockResolvedValue(CREATED)

    render(<AccessTokensPanel />)
    await waitFor(() => expect(listPersonalAccessTokens).toHaveBeenCalled())

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新令牌' } })
    fireEvent.click(screen.getByRole('button', { name: /创建令牌/ }))

    await waitFor(() => expect(screen.getByDisplayValue(CREATED.token)).toBeTruthy())
    // 明文恰好出现一次，且带"仅显示一次"的告警
    expect(countPlaintextOccurrences(CREATED.token)).toBe(1)
    expect(screen.getByText(/唯一一次显示/)).toBeTruthy()
    expect(createPersonalAccessToken).toHaveBeenCalledWith({
      name: '新令牌',
      expiresInDays: undefined,
    })

    fireEvent.click(screen.getByRole('button', { name: '我已保存，关闭提示' }))

    // 明文从 DOM 中彻底消失，且不会因为列表刷新而重新出现
    expect(screen.queryByDisplayValue(CREATED.token)).toBeNull()
    expect(countPlaintextOccurrences(CREATED.token)).toBe(0)
  })

  it('创建时可指定有效期，非法天数被前端拦截且不发请求', async () => {
    vi.mocked(listPersonalAccessTokens).mockResolvedValue([])

    render(<AccessTokensPanel />)
    await waitFor(() => expect(listPersonalAccessTokens).toHaveBeenCalled())

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '限期令牌' } })
    fireEvent.change(screen.getByLabelText('有效期（天）'), { target: { value: '9999' } })
    fireEvent.click(screen.getByRole('button', { name: /创建令牌/ }))

    expect(createPersonalAccessToken).not.toHaveBeenCalled()

    vi.mocked(createPersonalAccessToken).mockResolvedValue(CREATED)
    fireEvent.change(screen.getByLabelText('有效期（天）'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: /创建令牌/ }))

    await waitFor(() =>
      expect(createPersonalAccessToken).toHaveBeenCalledWith({
        name: '限期令牌',
        expiresInDays: 30,
      })
    )
  })

  it('撤销需要二次确认，取消后不调用接口', async () => {
    vi.mocked(listPersonalAccessTokens).mockResolvedValue([makeToken()])
    vi.mocked(revokePersonalAccessToken).mockResolvedValue(undefined)

    render(<AccessTokensPanel />)
    await waitFor(() => expect(screen.getByText('Claude Desktop')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /撤销/ }))
    expect(screen.getByText('确认撤销？')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(revokePersonalAccessToken).not.toHaveBeenCalled()
    expect(screen.queryByText('确认撤销？')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /撤销/ }))
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))

    await waitFor(() => expect(revokePersonalAccessToken).toHaveBeenCalledWith(1))
    // 撤销后重新拉取列表（行被保留，靠 revoked 标记体现）
    await waitFor(() => expect(listPersonalAccessTokens).toHaveBeenCalledTimes(2))
  })

  it('复制按钮把明文写入剪贴板', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    vi.mocked(listPersonalAccessTokens).mockResolvedValue([])
    vi.mocked(createPersonalAccessToken).mockResolvedValue(CREATED)

    render(<AccessTokensPanel />)
    await waitFor(() => expect(listPersonalAccessTokens).toHaveBeenCalled())

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新令牌' } })
    fireEvent.click(screen.getByRole('button', { name: /创建令牌/ }))
    await waitFor(() => expect(screen.getByDisplayValue(CREATED.token)).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /复制/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CREATED.token))
  })

  it('接口失败时展示错误信息而不是空列表', async () => {
    vi.mocked(listPersonalAccessTokens).mockRejectedValue(new Error('网络连接失败'))

    render(<AccessTokensPanel />)

    await waitFor(() => expect(screen.getByText('网络连接失败')).toBeTruthy())
  })
})
