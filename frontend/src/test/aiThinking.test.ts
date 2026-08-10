import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  AI_PROVIDERS,
  resolveThinkingConfig,
  buildThinkingParams,
  sendStreamChatMessage,
} from '../services/aiService'

// Mock apiClient：测试只关心请求 body 构造，不依赖真实 CSRF/鉴权
vi.mock('../services/apiClient.js', () => ({
  apiClient: {
    ensureCsrfToken: vi.fn().mockResolvedValue(undefined),
    getAuthHeaders: vi.fn().mockReturnValue({}),
  },
}))

function providerById(id: string) {
  const p = AI_PROVIDERS.find((p) => p.id === id)
  expect(p).toBeDefined()
  return p!
}

describe('resolveThinkingConfig（provider 能力声明 + 模型 ID 动态匹配）', () => {
  it('deepseek 直连：静态三档 low/high/max，defaultEffort=high', () => {
    const cfg = resolveThinkingConfig(providerById('deepseek'), 'deepseek-chat')
    expect(cfg).toEqual({ kind: 'deepseek', effortLevels: ['low', 'high', 'max'], defaultEffort: 'high' })
  })

  it('opencode-go + deepseek 模型 → kind=deepseek 三档', () => {
    const cfg = resolveThinkingConfig(providerById('opencode-go'), 'deepseek-v4-flash')
    expect(cfg).toEqual({ kind: 'deepseek', effortLevels: ['low', 'high', 'max'], defaultEffort: 'high' })
  })

  it('opencode-go + glm 模型 → kind=glm 空档（无强度概念）', () => {
    const cfg = resolveThinkingConfig(providerById('opencode-go'), 'glm-5.2')
    expect(cfg).toEqual({ kind: 'glm', effortLevels: [], defaultEffort: 'high' })
  })

  it('opencode-go + 无思考能力模型（gpt-5）→ undefined', () => {
    expect(resolveThinkingConfig(providerById('opencode-go'), 'gpt-5')).toBeUndefined()
  })

  it('opencode-go + 空 modelId（对话框首次打开、模型未 fetch）→ undefined', () => {
    expect(resolveThinkingConfig(providerById('opencode-go'), '')).toBeUndefined()
  })

  it('custom（无能力声明）→ undefined，即使模型名含 deepseek', () => {
    expect(resolveThinkingConfig(providerById('custom'), 'deepseek-chat')).toBeUndefined()
  })

  it('opencode-zen 动态匹配大小写不敏感', () => {
    expect(resolveThinkingConfig(providerById('opencode-zen'), 'DeepSeek-V3')?.kind).toBe('deepseek')
    expect(resolveThinkingConfig(providerById('opencode-zen'), 'GLM-4.7')?.kind).toBe('glm')
  })
})

describe('buildThinkingParams（thinking 与 reasoning_effort 永不同发）', () => {
  it('deepseek 关 → thinking disabled，不含 reasoning_effort', () => {
    expect(buildThinkingParams('deepseek', { enabled: false })).toEqual({ thinking: { type: 'disabled' } })
    expect(buildThinkingParams('deepseek', { enabled: false, effort: 'high' })).toEqual({ thinking: { type: 'disabled' } })
  })

  it('deepseek 开且无 effort → thinking enabled', () => {
    expect(buildThinkingParams('deepseek', { enabled: true })).toEqual({ thinking: { type: 'enabled' } })
  })

  it('deepseek 开 + effort=high → reasoning_effort=high 且不含 thinking 键', () => {
    const params = buildThinkingParams('deepseek', { enabled: true, effort: 'high' })
    expect(params).toEqual({ reasoning_effort: 'high' })
    expect(params).not.toHaveProperty('thinking')
  })

  it('deepseek 开 + effort=max → reasoning_effort=max 且不含 thinking 键', () => {
    const params = buildThinkingParams('deepseek', { enabled: true, effort: 'max' })
    expect(params).toEqual({ reasoning_effort: 'max' })
    expect(params).not.toHaveProperty('thinking')
  })

  it('glm 关/开 → thinking disabled/enabled（无强度概念，effort 被忽略）', () => {
    expect(buildThinkingParams('glm', { enabled: false })).toEqual({ thinking: { type: 'disabled' } })
    expect(buildThinkingParams('glm', { enabled: true })).toEqual({ thinking: { type: 'enabled' } })
    expect(buildThinkingParams('glm', { enabled: true, effort: 'high' })).toEqual({ thinking: { type: 'enabled' } })
  })

  it('未知 kind → undefined（防御分支）', () => {
    expect(buildThinkingParams('unknown' as never, { enabled: true, effort: 'high' })).toBeUndefined()
  })
})

describe('sendStreamChatMessage 请求体注入（端到端 body 断言）', () => {
  let lastFetch: { url: string; init: RequestInit } | null = null

  function createSseResponse() {
    const encoder = new TextEncoder()
    const chunks = [
      encoder.encode('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'),
      encoder.encode('data: [DONE]\n\n'),
    ]
    let i = 0
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () =>
            i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined },
          cancel: async () => {},
        }),
      },
    } as unknown as Response
  }

  beforeEach(() => {
    lastFetch = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        lastFetch = { url: String(url), init: init || {} }
        return createSseResponse()
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  async function send(config: Record<string, unknown>) {
    await sendStreamChatMessage(config.provider as string, config as never, [
      { role: 'user', content: 'hi' },
    ], {})
    expect(lastFetch).not.toBeNull()
    return JSON.parse(String(lastFetch!.init.body)) as { body: Record<string, unknown> }
  }

  it('deepseek 直连 + effort=high → 仅 reasoning_effort，无 thinking；保留 stream_options', async () => {
    const req = await send({
      provider: 'deepseek',
      baseUrl: '',
      model: 'deepseek-v4-flash',
      enableThinking: true,
      reasoningEffort: 'high',
    })
    expect(req.body.reasoning_effort).toBe('high')
    expect(req.body).not.toHaveProperty('thinking')
    expect(req.body.stream_options).toEqual({ include_usage: true })
  })

  it('deepseek 直连 + enableThinking=false → thinking disabled，无 reasoning_effort；保留 stream_options', async () => {
    const req = await send({
      provider: 'deepseek',
      baseUrl: '',
      model: 'deepseek-v4-flash',
      enableThinking: false,
      reasoningEffort: 'max',
    })
    expect(req.body.thinking).toEqual({ type: 'disabled' })
    expect(req.body).not.toHaveProperty('reasoning_effort')
    expect(req.body.stream_options).toEqual({ include_usage: true })
  })

  it('deepseek 直连默认（enableThinking 缺省）→ thinking enabled', async () => {
    const req = await send({ provider: 'deepseek', baseUrl: '', model: 'deepseek-v4-flash' })
    expect(req.body.thinking).toEqual({ type: 'enabled' })
    expect(req.body).not.toHaveProperty('reasoning_effort')
  })

  it('deepseek 直连 + enableThinking 缺省 + effort=high → 仅 reasoning_effort（核心回归场景）', async () => {
    const req = await send({ provider: 'deepseek', baseUrl: '', model: 'deepseek-v4-flash', reasoningEffort: 'high' })
    expect(req.body.reasoning_effort).toBe('high')
    expect(req.body).not.toHaveProperty('thinking')
    expect(req.body.stream_options).toEqual({ include_usage: true })
  })

  it('opencode-go + glm-5.2 → thinking enabled，无 reasoning_effort，网关不加 stream_options', async () => {
    const req = await send({
      provider: 'opencode-go',
      baseUrl: '',
      model: 'glm-5.2',
      enableThinking: true,
      reasoningEffort: 'high',
    })
    expect(req.body.thinking).toEqual({ type: 'enabled' })
    expect(req.body).not.toHaveProperty('reasoning_effort')
    expect(req.body).not.toHaveProperty('stream_options')
  })

  it('opencode-go + deepseek 模型 + enableThinking 缺省 → thinking enabled，无 reasoning_effort，网关不加 stream_options', async () => {
    const req = await send({ provider: 'opencode-go', baseUrl: '', model: 'deepseek-v4-flash' })
    expect(req.body.thinking).toEqual({ type: 'enabled' })
    expect(req.body).not.toHaveProperty('reasoning_effort')
    expect(req.body).not.toHaveProperty('stream_options')
  })

  it('opencode-go + deepseek 模型 + enableThinking=false → thinking disabled，无 reasoning_effort，网关不加 stream_options', async () => {
    const req = await send({
      provider: 'opencode-go',
      baseUrl: '',
      model: 'deepseek-v4-flash',
      enableThinking: false,
      reasoningEffort: 'max',
    })
    expect(req.body.thinking).toEqual({ type: 'disabled' })
    expect(req.body).not.toHaveProperty('reasoning_effort')
    expect(req.body).not.toHaveProperty('stream_options')
  })

  it('opencode-zen + deepseek-v4-flash + effort=max → reasoning_effort=max，无 thinking', async () => {
    const req = await send({
      provider: 'opencode-zen',
      baseUrl: '',
      model: 'deepseek-v4-flash',
      enableThinking: true,
      reasoningEffort: 'max',
    })
    expect(req.body.reasoning_effort).toBe('max')
    expect(req.body).not.toHaveProperty('thinking')
  })

  it('opencode-go + gpt-5（无思考能力）→ 不注入 thinking/reasoning_effort', async () => {
    const req = await send({
      provider: 'opencode-go',
      baseUrl: '',
      model: 'gpt-5',
      enableThinking: true,
      reasoningEffort: 'high',
    })
    expect(req.body).not.toHaveProperty('thinking')
    expect(req.body).not.toHaveProperty('reasoning_effort')
  })

  it('custom provider → 不注入 thinking/reasoning_effort', async () => {
    const req = await send({ provider: 'custom', baseUrl: '', model: 'my-model', enableThinking: true })
    expect(req.body).not.toHaveProperty('thinking')
    expect(req.body).not.toHaveProperty('reasoning_effort')
  })
})
