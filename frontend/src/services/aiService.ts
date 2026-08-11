// AI 服务 API 接口层
// 支持 DeepSeek、OpenCode Go/Zen 聚合网关、自定义 OpenAI 兼容 API
// 所有请求通过后端代理（/api/ai/*），API 密钥加密存储在服务端，不进入浏览器

import { executeToolCall, getToolsForAI } from './aiTools'
import { apiClient } from './apiClient.js'

export interface AIProvider {
  id: string
  name: string
  description: string
  baseUrl: string
  apiKeyRequired: boolean
  modelsEndpoint: string
  chatEndpoint: string
  parseModels: (response: unknown) => AIModel[]
  parseChatResponse: (response: unknown) => { content: string; reasoningContent?: string; toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }> }
  // 思考模式/强度能力声明（不声明 = 不支持思考，UI 不渲染）
  thinking?: {
    kind: 'deepseek' | 'glm' | 'dynamic'
    effortLevels: string[]
    defaultEffort: string
  }
}

export interface AIModel {
  id: string
  name: string
  description?: string
  contextLength?: number
}

export interface AIConfig {
  provider: string
  /** 已废弃：API 密钥由服务端加密存储，前端不再需要 */
  apiKey?: string
  baseUrl: string
  model: string
  enableThinking?: boolean  // DeepSeek 思考模式
  reasoningEffort?: string  // 思考强度控制（档位由 provider 能力声明决定）
  responseFormat?: 'text' | 'json_object'  // DeepSeek JSON Output 模式
}

// 预设的 AI 提供商配置
export const AI_PROVIDERS: AIProvider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    description: 'DeepSeek 系列模型，支持思考模式、JSON Output、Tool Calls',
    baseUrl: 'https://api.deepseek.com',
    apiKeyRequired: true,
    modelsEndpoint: '/models',
    chatEndpoint: '/chat/completions',
    thinking: { kind: 'deepseek', effortLevels: ['low', 'high', 'max'], defaultEffort: 'high' },
    parseModels: (response: unknown) => {
      const data = response as { data: Array<{ id: string }> }
      return data.data
        .filter((m) => m.id.includes('deepseek'))
        .map((m) => {
          const isV4Pro = m.id.includes('v4-pro')
          const isV4Flash = m.id.includes('v4-flash')
          let description = 'DeepSeek 模型（支持思考模式、工具调用）'
          if (isV4Pro) {
            description = 'DeepSeek V4 Pro（旗舰模型）'
          } else if (isV4Flash) {
            description = 'DeepSeek V4 Flash（快速模型）'
          }
          return {
            id: m.id,
            name: m.id,
            description,
          }
        })
    },
    parseChatResponse: (response: unknown) => {
      const data = response as {
        choices: Array<{
          message: {
            content: string
            reasoning_content?: string
            tool_calls?: Array<{
              id: string
              type: string
              function: { name: string; arguments: string }
            }>
          }
        }>
      }
      const message = data.choices[0]?.message
      const toolCalls = message?.tool_calls?.map((tc) => {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(tc.function.arguments)
        } catch {
          /* malformed JSON from model */
        }
        return { name: tc.function.name, arguments: args }
      })
      return {
        content: message?.content || '',
        reasoningContent: message?.reasoning_content,
        toolCalls,
      }
    },
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    description: 'OpenCode Go 聚合网关，单 Key 访问 Kimi、Qwen、GLM、DeepSeek、MiMo 等开源模型',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    apiKeyRequired: true,
    modelsEndpoint: '/models',
    chatEndpoint: '/chat/completions',
    // dynamic: 实际档位由 resolveThinkingConfig 按模型 ID 匹配硬编码，此处字段仅占位（不用作计算）
    thinking: { kind: 'dynamic', effortLevels: [], defaultEffort: 'high' },
    parseModels: (response: unknown) => {
      const data = response as { data: Array<{ id: string }> }
      return data.data.map((m) => {
        // OpenCode Go 模型可能带 opencode/ 前缀
        const cleanId = m.id.includes('/') ? m.id.split('/').pop() || m.id : m.id
        return {
          id: cleanId,
          name: cleanId,
          description: 'OpenCode Go 模型（聚合网关，支持工具调用）',
        }
      })
    },
    parseChatResponse: (response: unknown) => {
      const data = response as {
        choices: Array<{
          message: {
            content: string
            reasoning_content?: string
            tool_calls?: Array<{
              id: string
              type: string
              function: { name: string; arguments: string }
            }>
          }
        }>
      }
      const message = data.choices[0]?.message
      const toolCalls = message?.tool_calls?.map((tc) => {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(tc.function.arguments)
        } catch {
          /* malformed JSON from model */
        }
        return { name: tc.function.name, arguments: args }
      })
      return {
        content: message?.content || '',
        reasoningContent: message?.reasoning_content,
        toolCalls,
      }
    },
  },
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    description: 'OpenCode Zen 聚合网关，单 Key 访问 GPT、Claude、Gemini 及开源模型',
    baseUrl: 'https://opencode.ai/zen/v1',
    apiKeyRequired: true,
    modelsEndpoint: '/models',
    chatEndpoint: '/chat/completions',
    // dynamic: 实际档位由 resolveThinkingConfig 按模型 ID 匹配硬编码，此处字段仅占位（不用作计算）
    thinking: { kind: 'dynamic', effortLevels: [], defaultEffort: 'high' },
    parseModels: (response: unknown) => {
      const data = response as { data: Array<{ id: string }> }
      return data.data.map((m) => {
        // OpenCode Zen 模型可能带 opencode/ 前缀
        const cleanId = m.id.includes('/') ? m.id.split('/').pop() || m.id : m.id
        return {
          id: cleanId,
          name: cleanId,
          description: 'OpenCode Zen 模型（聚合网关，支持工具调用）',
        }
      })
    },
    parseChatResponse: (response: unknown) => {
      const data = response as {
        choices: Array<{
          message: {
            content: string
            reasoning_content?: string
            tool_calls?: Array<{
              id: string
              type: string
              function: { name: string; arguments: string }
            }>
          }
        }>
      }
      const message = data.choices[0]?.message
      const toolCalls = message?.tool_calls?.map((tc) => {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(tc.function.arguments)
        } catch {
          /* malformed JSON from model */
        }
        return { name: tc.function.name, arguments: args }
      })
      return {
        content: message?.content || '',
        reasoningContent: message?.reasoning_content,
        toolCalls,
      }
    },
  },
  {
    id: 'custom',
    name: '自定义',
    description: '自定义 OpenAI 兼容 API',
    baseUrl: '',
    apiKeyRequired: true,
    modelsEndpoint: '/models',
    chatEndpoint: '/chat/completions',
    parseModels: (response: unknown) => {
      const data = response as { data: Array<{ id: string }> }
      return data.data.map((m) => ({
        id: m.id,
        name: m.id,
        description: '自定义模型',
      }))
    },
    parseChatResponse: (response: unknown) => {
      const data = response as {
        choices: Array<{
          message: {
            content: string
            reasoning_content?: string
            tool_calls?: Array<{
              function: { name: string; arguments: string }
            }>
          }
        }>
      }
      const message = data.choices[0]?.message
      const toolCalls = message?.tool_calls?.map((tc) => {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(tc.function.arguments)
        } catch {
          /* malformed JSON from model */
        }
        return { name: tc.function.name, arguments: args }
      })
      return {
        content: message?.content || '',
        reasoningContent: message?.reasoning_content,
        toolCalls,
      }
    },
  },
]

// 思考配置解析结果
export interface ThinkingConfig {
  kind: 'deepseek' | 'glm'
  effortLevels: string[]
  defaultEffort?: string
}

// 解析 provider 的思考能力声明：
// - kind='deepseek'/'glm' 为静态声明（直连 provider），直接返回
// - kind='dynamic' 为网关类 provider，按模型 ID 动态匹配（deepseek/glm 系模型）
// - 不声明或无匹配模型 → undefined（不渲染 UI、不注入参数）
export function resolveThinkingConfig(provider: AIProvider, modelId: string): ThinkingConfig | undefined {
  if (!provider.thinking) return undefined
  if (provider.thinking.kind === 'deepseek' || provider.thinking.kind === 'glm') {
    return {
      kind: provider.thinking.kind,
      effortLevels: provider.thinking.effortLevels,
      defaultEffort: provider.thinking.defaultEffort,
    }
  }
  // kind === 'dynamic'：按模型 ID 匹配（网关模型）
  const m = (modelId || '').toLowerCase()
  if (m.includes('deepseek')) return { kind: 'deepseek', effortLevels: ['low', 'high', 'max'], defaultEffort: 'high' }
  if (m.includes('glm')) return { kind: 'glm', effortLevels: [], defaultEffort: 'high' }
  return undefined
}

// 思考参数统一映射。
// ⚠️ 关键坑：thinking 与 reasoning_effort 永不同发（网关会 HTTP 400）。
// - deepseek: 关 → thinking disabled；开且无 effort → thinking enabled；开且有 effort → 仅 reasoning_effort
//   （DeepSeek 官方 thinking 默认 enabled，语义等效）
// - glm: 关 → thinking disabled；开 → thinking enabled（无强度概念）
export function buildThinkingParams(
  kind: 'deepseek' | 'glm',
  opts: { enabled: boolean; effort?: string }
): Record<string, unknown> | undefined {
  if (kind === 'deepseek') {
    if (!opts.enabled) return { thinking: { type: 'disabled' } }
    if (opts.effort) return { reasoning_effort: opts.effort }
    return { thinking: { type: 'enabled' } }
  }
  if (kind === 'glm') {
    if (!opts.enabled) return { thinking: { type: 'disabled' } }
    return { thinking: { type: 'enabled' } }
  }
  return undefined
}

// 获取模型列表（通过服务端代理，密钥不进入浏览器）
export async function fetchModels(
  provider: AIProvider,
  _apiKey: string,
  customBaseUrl?: string
): Promise<AIModel[]> {
  await apiClient.ensureCsrfToken()
  const headers = apiClient.getAuthHeaders()

  let response: Response
  try {
    // C10: 连接阶段超时兜底（20s），防止服务端无响应时 fetch 永久挂起
    const controller = new AbortController()
    const connectTimer = setTimeout(() => controller.abort(), 20000)
    try {
      response = await fetch('/api/ai/models', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          providerId: provider.id,
          urlPath: provider.modelsEndpoint,
          baseUrl: customBaseUrl || undefined,
        }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(connectTimer)
    }
  } catch {
    throw new Error('网络连接失败，无法获取模型列表')
  }

  if (!response.ok) {
    let message = `获取模型列表失败 (${response.status})`
    try {
      const data = (await response.json()) as { error?: string }
      if (data?.error) {
        message = data.error
      }
    } catch {
      // ignore parse errors
    }
    throw new Error(message)
  }

  const data = (await response.json()) as { success: boolean; data?: unknown; error?: string }
  if (!data.success) {
    throw new Error(data.error || '获取模型列表失败')
  }
  return provider.parseModels(data.data)
}

// 全局 AbortController 用于中断请求
// C16: 模块级单例是有意设计——当前 UI 同时最多只有一个流式请求（AiSidebar），
// 新请求发起时 abort 旧请求（depth>0 的递归工具轮次不中断外层）。
// 若未来支持多面板并发请求，需要改为 Map<key, AbortController>。
let currentAbortController: AbortController | null = null

// 中断当前请求
export function abortCurrentRequest() {
  if (currentAbortController) {
    currentAbortController.abort()
    currentAbortController = null
  }
}

// 流式输出回调类型
export interface StreamCallbacks {
  onReasoningChunk?: (chunk: string) => void
  onContentChunk?: (chunk: string) => void
  onToolCall?: (toolCall: { name: string; arguments: Record<string, unknown> }) => void
  /** 工具调用完成后回调，传入中间 assistant+tool 消息，需持久化用于后续多轮对话 */
  onToolExchange?: (messages: Array<Record<string, unknown>>) => void
  onComplete?: () => void
  onError?: (error: Error) => void
}

// 发送流式聊天消息
export async function sendStreamChatMessage(
  providerId: string,
  config: AIConfig,
  messages: Array<Record<string, unknown>>,
  callbacks: StreamCallbacks,
  enableTools: boolean = true,
  depth: number = 0,
  failureCount: number = 0
): Promise<void> {
  // 创建新的 AbortController（递归调用时不中断外层请求）
  if (depth === 0) {
    abortCurrentRequest()
  }
  currentAbortController = new AbortController()
  const signal = currentAbortController.signal
  const controller = currentAbortController

  const provider = AI_PROVIDERS.find((p) => p.id === providerId)
  if (!provider) {
    throw new Error('未知的 AI 提供商')
  }

  // 根据供应商决定是否使用 strict 模式
  // DeepSeek 支持 strict 模式，其余 OpenAI 兼容供应商不支持（可能影响指令遵循能力）
  const useStrict = providerId === 'deepseek'
  const tools = enableTools ? getToolsForAI(useStrict) : []

  let urlPath: string
  let body: Record<string, unknown>

  // OpenAI 兼容格式
  // DeepSeek strict 模式需要使用 Beta 端点
  let effectiveUrlPath = provider.chatEndpoint
  if (providerId === 'deepseek' && useStrict) {
    effectiveUrlPath = '/beta' + provider.chatEndpoint
  }
  urlPath = effectiveUrlPath
  body = {
    model: config.model,
    messages: messages,
    stream: true,
  }

  // DeepSeek 特殊处理
  if (providerId === 'deepseek') {
    // 思考模式下不支持 temperature/top_p/presence_penalty/frequency_penalty
    // (上游忽略这些参数,前端已不再发送)

    // JSON Output 模式（DeepSeek 独立特性）
    if (config.responseFormat === 'json_object') {
      body.response_format = { type: 'json_object' }
    }

    // 流式输出包含 usage 信息（仅 DeepSeek 直连，网关请求不新增字段）
    body.stream_options = { include_usage: true }
  }

  // 思考模式/思考强度统一注入（由 provider 能力声明 + 模型 ID 动态解析）
  const thinkingCfg = resolveThinkingConfig(provider, config.model)
  if (thinkingCfg) {
    const params = buildThinkingParams(thinkingCfg.kind, {
      enabled: config.enableThinking !== false,
      effort: config.enableThinking !== false ? config.reasoningEffort : undefined,
    })
    if (params) Object.assign(body, params)
  }


  if (tools.length > 0) {
    body.tools = tools
    body.tool_choice = 'auto'
  }

  const STREAM_IDLE_TIMEOUT_MS = 120000
  // C10: 连接阶段超时（30 秒未收到响应头则视为连接挂起），与空闲超时互补
  const CONNECT_TIMEOUT_MS = 30000
  let timedOut = false
  let connectTimedOut = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, STREAM_IDLE_TIMEOUT_MS)
  }
  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  try {
    await apiClient.ensureCsrfToken()
    let response: Response
    // C10: fetch 挂起保护——连接阶段（响应头未返回）超时即 abort，
    // 避免服务端不响应时请求永久悬挂
    let responseReceived = false
    const connectTimer = setTimeout(() => {
      if (!responseReceived) {
        connectTimedOut = true
        controller.abort()
      }
    }, CONNECT_TIMEOUT_MS)
    try {
      response = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: {
          ...apiClient.getAuthHeaders(),
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify({
          providerId,
          urlPath,
          baseUrl: config.baseUrl || undefined,
          body,
        }),
        signal,
      })
      responseReceived = true
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(connectTimedOut ? '连接超时，请检查网络或服务端状态' : (timedOut ? '请求超时' : '请求已中断'))
      }
      throw new Error('网络连接失败')
    } finally {
      clearTimeout(connectTimer)
    }

    if (!response.ok) {
      let message = `请求失败 (${response.status})`
      try {
        const data = (await response.json()) as { error?: string }
        if (data?.error) {
          message = data.error
        }
      } catch {
        // ignore parse errors
      }
      throw new Error(message)
    }

    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error('无法获取响应流')
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let isDone = false
    let assistantContent = ''
    let assistantReasoningContent = ''
    const toolCalls: Array<{
      id: string
      type: string
      function: { name: string; arguments: string }
    }> = []

    armIdleTimer()
    while (!isDone) {
      const { done, value } = await reader.read()
      if (done) {
        isDone = true
        break
      }

      armIdleTimer()

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        // C11: 兼容 \r\n 行尾与 'data:' 无空格变体（SSE 规范两者皆允许），
        // 否则 [DONE]\r 无法匹配、'data:' 前缀行被整行丢弃
        const trimmedLine = line.replace(/\r$/, '')
        if (trimmedLine.startsWith('data:')) {
          const data = trimmedLine.slice(5).trimStart()
          if (data === '[DONE]') {
            isDone = true
            break
          }

          try {
            const parsed = JSON.parse(data)

            // 上游错误（如 {"error": ...} 响应）：结束流并上报，避免被静默吞掉
            if (parsed && typeof parsed === 'object' && parsed.error) {
              const errorText = typeof parsed.error === 'string'
                ? parsed.error
                : JSON.stringify(parsed.error)
              callbacks.onError?.(new Error(`AI 服务错误：${errorText}`))
              isDone = true
              break
            }


            // OpenAI 格式处理
            const delta = parsed.choices?.[0]?.delta

            if (delta?.reasoning_content) {
              assistantReasoningContent += delta.reasoning_content
              callbacks.onReasoningChunk?.(delta.reasoning_content)
            }

            if (delta?.content) {
              assistantContent += delta.content
              callbacks.onContentChunk?.(delta.content)
            }

            // 收集工具调用信息
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const index = tc.index || 0
                if (!toolCalls[index]) {
                  toolCalls[index] = {
                    id: tc.id || `call_${index}`,
                    type: 'function',
                    function: { name: '', arguments: '' }
                  }
                }
                if (tc.function?.name) {
                  toolCalls[index].function.name = tc.function.name
                }
                if (tc.function?.arguments) {
                  toolCalls[index].function.arguments += tc.function.arguments
                }
                // 通知 UI
                if (tc.function?.name) {
                  let args: Record<string, unknown> = {}
                  try {
                    args = JSON.parse(tc.function.arguments || '{}')
                  } catch {
                    /* partial streaming arguments, will be completed later */
                  }
                  callbacks.onToolCall?.({
                    name: tc.function.name,
                    arguments: args,
                  })
                }
              }
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }
    }

    // 流式读取结束，清除空闲计时器
    clearIdleTimer()

    // 如果有工具调用，执行工具并将结果返回给 AI
    if (toolCalls.length > 0) {
      // 压缩稀疏数组（流式 tool_calls 的 index 可能不连续）
      const calls = toolCalls.filter(() => true)
      // 用户已中断则跳过工具执行
      if (signal.aborted) return
      const toolResults: Array<{ tool: string; result: unknown }> = []

      for (const tc of calls) {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(tc.function.arguments || '{}')
        } catch {
          /* accumulated arguments malformed, fall back to empty */
        }
        // N1: 工具执行期间用户可能已点停止——逐个执行前检查,中止则不再执行剩余工具
        if (signal.aborted) return
        const result = await executeToolCall(
          tc.function.name,
          args
        )
        toolResults.push({ tool: tc.function.name, result })
      }

      // 连续失败保护：任一工具调用失败则累计，连续 10 次失败停止（不再限制总轮数）
      const anyFailed = toolResults.some(
        (r) => (r.result as { success?: boolean } | null | undefined)?.success === false
      )
      const nextFailureCount = anyFailed ? failureCount + 1 : 0
      if (nextFailureCount >= 10) {
        callbacks.onError?.(new Error('连续 10 次工具调用失败，已停止'))
        return
      }


      // OpenAI 格式处理
      // 构建包含工具结果的消息历史
      // DeepSeek 思考模式要求：
      // 1. assistant 消息必须包含 reasoning_content（如果有）
      // 2. assistant 消息必须包含 tool_calls
      // 3. 必须有对应的 tool 消息返回工具执行结果
      const assistantMessage: Record<string, unknown> = {
        role: 'assistant',
        content: assistantContent || '',  // 思考模式下 content 可能为空
      }

      // DeepSeek API 要求在有工具调用时必须包含 reasoning_content 字段
      // 这是思考模式工具调用的关键！
      if (assistantReasoningContent) {
        assistantMessage.reasoning_content = assistantReasoningContent
      }

      // 添加 tool_calls
      assistantMessage.tool_calls = calls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments
        }
      }))

      // 构建 tool 结果消息
      const toolResultMessages = calls.map((tc, index) => ({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(toolResults[index]?.result)
      }))

      // 通知调用方持久化本轮工具交换消息，用于后续多轮对话上下文拼接
      callbacks.onToolExchange?.([assistantMessage, ...toolResultMessages])

      // N1: 递归前再次检查——工具执行期间被中止时不得再发起新请求(递归会新建
      // AbortController,abortCurrentRequest 只中止最内层,外层 signal 不会置位)
      if (signal.aborted) return

      // 递归调用获取最终响应
      // 注意：思考模式下模型可能需要多轮工具调用，所以保持 enableTools=true
      // 直到模型返回最终 content 而没有 tool_calls
      await sendStreamChatMessage(
        providerId,
        config,
        [...messages, assistantMessage, ...toolResultMessages],
        callbacks,
        true,  // 保持工具调用启用，支持多轮思考+工具调用
        depth + 1,  // depth 仅用于顶层 abort 守卫，不再限制轮数
        nextFailureCount
      )
      return
    }

    callbacks.onComplete?.()
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      callbacks.onError?.(new Error(timedOut ? '请求超时' : '请求已中断'))
    } else {
      callbacks.onError?.(error instanceof Error ? error : new Error(String(error)))
    }
  } finally {
    clearIdleTimer()
    if (currentAbortController === controller) {
      currentAbortController = null
    }
  }
}

// 验证 API 密钥（通过服务端代理）
export async function validateApiKey(
  provider: AIProvider,
  _apiKey: string,
  customBaseUrl?: string
): Promise<boolean> {
  try {
    await fetchModels(provider, _apiKey, customBaseUrl)
    return true
  } catch {
    return false
  }
}
