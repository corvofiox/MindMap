// AI 服务 API 接口层
// 支持 DeepSeek、智谱 GLM、Moonshot Kimi、Gemini、Ollama 等主流推理服务

import { executeToolCall, getToolsForAI, getToolsForGemini } from './aiTools'

export interface AIProvider {
  id: string
  name: string
  description: string
  baseUrl: string
  apiKeyRequired: boolean
  modelsEndpoint: string
  chatEndpoint: string
  headers: (apiKey: string) => Record<string, string>
  parseModels: (response: unknown) => AIModel[]
  parseChatResponse: (response: unknown) => { content: string; reasoningContent?: string; toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }> }
}

export interface AIModel {
  id: string
  name: string
  description?: string
  contextLength?: number
}

export interface AIConfig {
  provider: string
  apiKey: string
  baseUrl: string
  model: string
  temperature: number
  maxTokens: number
  enableThinking?: boolean  // DeepSeek/GLM 思考模式
  reasoningEffort?: 'high' | 'max'  // DeepSeek 思考强度控制
  responseFormat?: 'text' | 'json_object'  // DeepSeek/GLM/Moonshot JSON Output 模式
  // GLM 特有配置
  glmConfig?: {
    thinking?: { type: 'enabled' | 'disabled' }  // GLM 深度思考模式
    toolStream?: boolean  // GLM 工具调用流式输出
    clearThinking?: boolean  // GLM 是否清除历史思考内容（保留式思考）
  }
  // Moonshot 特有配置
  moonshotConfig?: {
    partial?: boolean  // Partial Mode：预填模型回复来引导输出
    name?: string  // Partial Mode 中的角色名称，用于强化角色扮演一致性
  }
}

// 预设的 AI 提供商配置
export const AI_PROVIDERS: AIProvider[] = [
  {
    id: 'moonshot',
    name: 'Moonshot AI',
    description: 'Moonshot Kimi 系列模型，支持工具调用、流式输出、深度思考模式',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKeyRequired: true,
    modelsEndpoint: '/models',
    chatEndpoint: '/chat/completions',
    headers: (apiKey) => ({
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }),
    parseModels: (response: unknown) => {
      const data = response as { data: Array<{ id: string; owned_by?: string }> }
      return data.data
        .filter((m) => m.id.includes('kimi'))
        .map((m) => {
          // 根据模型ID判断支持的特性
          const supportsThinking = m.id.includes('kimi-k2') || m.id.includes('kimi-k1.5')
          const supportsToolUse = !m.id.includes('kimi-k1') // k1.5 不支持工具调用
          return {
            id: m.id,
            name: m.id,
            description: supportsThinking
              ? (supportsToolUse ? 'Kimi 模型（支持深度思考、工具调用）' : 'Kimi 模型（支持深度思考）')
              : (supportsToolUse ? 'Kimi 模型（支持工具调用）' : 'Kimi 模型'),
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
      const toolCalls = message?.tool_calls?.map((tc) => ({
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      }))
      return {
        content: message?.content || '',
        reasoningContent: message?.reasoning_content,
        toolCalls,
      }
    },
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    description: 'DeepSeek 系列模型，支持思考模式、JSON Output、Tool Calls',
    baseUrl: 'https://api.deepseek.com',
    apiKeyRequired: true,
    modelsEndpoint: '/models',
    chatEndpoint: '/chat/completions',
    headers: (apiKey) => ({
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }),
    parseModels: (response: unknown) => {
      const data = response as { data: Array<{ id: string }> }
      return data.data
        .filter((m) => m.id.includes('deepseek'))
        .map((m) => {
          const isReasoner = m.id.includes('reasoner')
          const isV4Pro = m.id.includes('v4-pro') || m.id === 'deepseek-v3'
          const isChat = m.id.includes('chat')
          let description = 'DeepSeek 模型'
          if (isReasoner) {
            description = 'DeepSeek 思考模型（默认启用思考模式）'
          } else if (isV4Pro) {
            description = 'DeepSeek 模型（支持思考模式、工具调用）'
          } else if (isChat) {
            description = 'DeepSeek 对话模型'
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
      const toolCalls = message?.tool_calls?.map((tc) => ({
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      }))
      return {
        content: message?.content || '',
        reasoningContent: message?.reasoning_content,
        toolCalls,
      }
    },
  },
  {
    id: 'zhipu',
    name: '智谱 AI',
    description: '智谱 GLM 系列模型，支持深度思考、工具调用流式输出、结构化输出',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyRequired: true,
    modelsEndpoint: '/models',
    chatEndpoint: '/chat/completions',
    headers: (apiKey) => ({
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }),
    parseModels: (response: unknown) => {
      const data = response as { data: Array<{ id: string }> }
      return data.data
        .filter((m) => m.id.includes('glm'))
        .map((m) => {
          // 根据模型ID判断支持的特性
          const supportsThinking = m.id.includes('glm-5') || m.id.includes('glm-4.7') ||
            m.id.includes('glm-4.6') || m.id.includes('glm-4.5')
          // GLM-5、GLM-4.7、GLM-4.6 支持工具流式输出
          const supportsToolStream = m.id.includes('glm-5') || m.id.includes('glm-4.7') || m.id.includes('glm-4.6')
          return {
            id: m.id,
            name: m.id,
            description: supportsThinking
              ? (supportsToolStream ? 'GLM 模型（支持深度思考、工具流式输出）' : 'GLM 模型（支持深度思考）')
              : '智谱 GLM 模型',
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
      const toolCalls = message?.tool_calls?.map((tc) => ({
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      }))
      return {
        content: message?.content || '',
        reasoningContent: message?.reasoning_content,
        toolCalls,
      }
    },
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    description: 'Google Gemini 系列模型',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyRequired: true,
    modelsEndpoint: '/models',
    chatEndpoint: '/models/{model}:generateContent',
    headers: (apiKey) => ({
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    }),
    parseModels: (response: unknown) => {
      const data = response as { models: Array<{ name: string; displayName?: string; description?: string }> }
      return data.models
        .filter((m) => m.name.includes('gemini'))
        .map((m) => ({
          id: m.name.replace('models/', ''),
          name: m.displayName || m.name.replace('models/', ''),
          description: m.description || 'Google Gemini 模型',
        }))
    },
    parseChatResponse: (response: unknown) => {
      const data = response as {
        candidates: Array<{
          content: {
            parts: Array<{ text: string; thought?: boolean }>
          }
        }>
      }

      const candidate = data.candidates?.[0]
      const parts = candidate?.content?.parts

      if (!parts || parts.length === 0) {
        return { content: '' }
      }

      // 分离思考内容和普通内容
      let reasoningContent = ''
      let content = ''

      for (const part of parts) {
        if (part.thought) {
          reasoningContent += part.text
        } else {
          content += part.text
        }
      }

      return {
        content: content.trim(),
        reasoningContent: reasoningContent.trim() || undefined
      }
    },
  },
  {
    id: 'ollama',
    name: 'Ollama',
    description: '本地 Ollama 服务',
    baseUrl: 'http://localhost:11434',
    apiKeyRequired: false,
    modelsEndpoint: '/api/tags',
    chatEndpoint: '/api/chat',
    headers: () => ({
      'Content-Type': 'application/json',
    }),
    parseModels: (response: unknown) => {
      const data = response as { models: Array<{ name: string; size: number }> }
      return data.models.map((m) => ({
        id: m.name,
        name: m.name,
        description: `Size: ${(m.size / 1e9).toFixed(2)} GB`,
      }))
    },
    parseChatResponse: (response: unknown) => {
      const data = response as { message: { content: string; reasoning_content?: string } }
      return {
        content: data.message?.content || '',
        reasoningContent: data.message?.reasoning_content,
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
    headers: (apiKey) => ({
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }),
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
      const toolCalls = message?.tool_calls?.map((tc) => ({
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      }))
      return {
        content: message?.content || '',
        reasoningContent: message?.reasoning_content,
        toolCalls,
      }
    },
  },
]

// 获取模型列表
export async function fetchModels(
  provider: AIProvider,
  apiKey: string,
  customBaseUrl?: string
): Promise<AIModel[]> {
  const baseUrl = customBaseUrl || provider.baseUrl
  const url = `${baseUrl}${provider.modelsEndpoint}`

  const response = await fetch(url, {
    method: 'GET',
    headers: provider.headers(apiKey),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`获取模型列表失败: ${error}`)
  }

  const data = await response.json()
  return provider.parseModels(data)
}

// 全局 AbortController 用于中断请求
let currentAbortController: AbortController | null = null

// 中断当前请求
export function abortCurrentRequest() {
  if (currentAbortController) {
    currentAbortController.abort()
    currentAbortController = null
  }
}

// 发送聊天消息（支持工具调用和中断）
export async function sendChatMessageWithTools(
  providerId: string,
  config: AIConfig,
  messages: Array<Record<string, unknown>>,
  enableTools: boolean = true
): Promise<{ content: string; reasoningContent?: string; toolResults?: Array<{ tool: string; result: unknown }> }> {
  // 创建新的 AbortController
  abortCurrentRequest() // 先中断之前的请求
  currentAbortController = new AbortController()
  const signal = currentAbortController.signal

  const provider = AI_PROVIDERS.find((p) => p.id === providerId)
  if (!provider) {
    throw new Error('未知的 AI 提供商')
  }

  const baseUrl = config.baseUrl || provider.baseUrl
  let url: string
  let body: Record<string, unknown>

  // 根据供应商决定是否使用 strict 模式
  // DeepSeek 支持 strict 模式，GLM 等不支持（可能影响指令遵循能力）
  const useStrict = providerId === 'deepseek'
  const tools = enableTools ? getToolsForAI(useStrict) : []

  // 根据不同提供商构建请求体和 URL
  if (providerId === 'gemini') {
    // Gemini 特殊处理
    url = `${baseUrl}/models/${config.model}:generateContent`
    // 分离 system message 和对话消息
    const systemMessage = messages.find((m) => m.role === 'system')
    const chatMessages = messages.filter((m) => m.role !== 'system')

    body = {
      contents: chatMessages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      generationConfig: {
        temperature: config.temperature,
        maxOutputTokens: config.maxTokens,
      },
    }

    if (systemMessage) {
      (body as Record<string, unknown>).systemInstruction = {
        parts: [{ text: systemMessage.content }],
      }
    }
  } else if (providerId === 'anthropic') {
    url = `${baseUrl}${provider.chatEndpoint}`
    body = {
      model: config.model,
      max_tokens: config.maxTokens,
      temperature: config.temperature,
      messages: messages.map((m) => ({
        role: m.role === 'system' ? 'user' : m.role,
        content: m.content,
      })),
    }
  } else if (providerId === 'ollama') {
    url = `${baseUrl}${provider.chatEndpoint}`
    body = {
      model: config.model,
      messages: messages,
      stream: false,
      options: {
        temperature: config.temperature,
        num_predict: config.maxTokens,
      },
    }
  } else {
    // OpenAI 兼容格式（支持工具调用）
    let effectiveBaseUrl = baseUrl
    // DeepSeek strict 模式需要使用 Beta 端点
    if (providerId === 'deepseek' && useStrict) {
      effectiveBaseUrl = baseUrl.replace(/\/beta$/, '').replace(/\/$/, '') + '/beta'
    }
    url = `${effectiveBaseUrl}${provider.chatEndpoint}`
    body = {
      model: config.model,
      messages: messages,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
    }

    // DeepSeek 特殊处理
    if (providerId === 'deepseek') {
      const supportsThinking = config.model === 'deepseek-reasoner' ||
        config.model.includes('v4-pro') || config.model === 'deepseek-v3'
      const isThinkingEnabled = supportsThinking && config.enableThinking !== false

      // 思考模式下不支持 temperature、top_p、presence_penalty、frequency_penalty
      if (isThinkingEnabled) {
        delete (body as Record<string, unknown>).temperature
        delete (body as Record<string, unknown>).top_p
        delete (body as Record<string, unknown>).presence_penalty
        delete (body as Record<string, unknown>).frequency_penalty
      }

      // JSON Output 模式
      if (config.responseFormat === 'json_object') {
        (body as Record<string, unknown>).response_format = { type: 'json_object' }
      }

      // 思考模式控制（顶级参数，非 extra_body）
      if (config.enableThinking === false) {
        // 明确禁用思考（适用于所有模型）
        (body as Record<string, unknown>).thinking = { type: 'disabled' }
      } else if (supportsThinking && config.model !== 'deepseek-reasoner') {
        // 支持思考的非 reasoner 模型，默认启用思考
        (body as Record<string, unknown>).thinking = { type: 'enabled' }
      }

      // 思考强度控制（顶级参数）
      if (isThinkingEnabled && config.reasoningEffort) {
        (body as Record<string, unknown>).reasoning_effort = config.reasoningEffort
      }
    }

    // GLM 特殊处理
    if (providerId === 'zhipu') {
      // GLM 深度思考模式
      // GLM-5、GLM-4.7 默认开启思考，不需要显式设置
      // 只在需要禁用思考或设置特定参数时才设置
      if (config.glmConfig?.thinking) {
        (body as Record<string, unknown>).thinking = config.glmConfig.thinking
      } else if (config.enableThinking === false) {
        // 明确禁用思考模式
        (body as Record<string, unknown>).thinking = { type: 'disabled' }
      }
      // 注意：不设置 thinking 时，GLM-5/4.7 默认开启思考

      // GLM 保留式思考 (Preserved Thinking)
      // 在工具调用之间保留 reasoning_content，保持推理连贯性
      if (config.glmConfig?.clearThinking === false) {
        const thinkingBody = (body as Record<string, unknown>).thinking as Record<string, unknown> || {}
        thinkingBody.clear_thinking = false
          ; (body as Record<string, unknown>).thinking = thinkingBody
      }

      // JSON Output 模式（结构化输出）
      if (config.responseFormat === 'json_object') {
        (body as Record<string, unknown>).response_format = { type: 'json_object' }
      }
    }

    // Moonshot 特殊处理
    if (providerId === 'moonshot') {
      // Moonshot 兼容 OpenAI SDK，支持工具调用、JSON Output
      // kimi-k2 系列支持深度思考，kimi-k1.5 也支持但不支持工具调用
      const supportsToolUse = !config.model.includes('kimi-k1')

      // 某些 Moonshot 模型（如 kimi-k2/k2.5 系列、kimi-k1.5 系列）只支持 temperature: 1
      // 如果用户设置了其他值，需要强制设置为 1
      if (config.model.includes('kimi-k2') || config.model.includes('kimi-k1')) {
        (body as Record<string, unknown>).temperature = 1
      }

      // JSON Output 模式
      if (config.responseFormat === 'json_object') {
        (body as Record<string, unknown>).response_format = { type: 'json_object' }
      }

      // 注意：Moonshot 的 reasoning_content 是模型自动返回的，不需要额外参数开启
      // 工具调用只在支持的模型上启用
      if (!supportsToolUse && tools.length > 0) {
        // k1.5 不支持工具调用，移除工具
        delete (body as Record<string, unknown>).tools
        delete (body as Record<string, unknown>).tool_choice
      }

      // Partial Mode：预填模型回复来引导输出
      // 参考：https://platform.moonshot.cn/docs/api/partial
      if (config.moonshotConfig?.partial) {
        // 检查最后一条消息是否是 assistant 角色
        const lastMessage = messages[messages.length - 1]
        if (lastMessage && lastMessage.role === 'assistant') {
          (lastMessage as Record<string, unknown>).partial = true
          // 可选：添加 name 字段强化角色一致性
          if (config.moonshotConfig.name) {
            (lastMessage as Record<string, unknown>).name = config.moonshotConfig.name
          }
        }
      }
    }

    // 添加工具定义
    if (tools.length > 0) {
      (body as Record<string, unknown>).tools = tools
        ; (body as Record<string, unknown>).tool_choice = 'auto'
    }
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: provider.headers(config.apiKey),
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`请求失败: ${error}`)
    }

    const data = await response.json()
    const rawMessage = (data as { choices: Array<{ message: Record<string, unknown> }> }).choices?.[0]?.message
    const { content, reasoningContent, toolCalls } = provider.parseChatResponse(data)

    // 执行工具调用
    const toolResults: Array<{ tool: string; result: unknown }> = []
    if (toolCalls && toolCalls.length > 0) {
      for (const toolCall of toolCalls) {
        const result = await executeToolCall(toolCall.name, toolCall.arguments)
        toolResults.push({ tool: toolCall.name, result })
      }

      // 将工具结果返回给 AI 继续处理
      // 使用标准 OpenAI tool_calls + role:tool 格式
      if (toolResults.length > 0) {
        const assistantMessage: Record<string, unknown> = {
          role: 'assistant',
          content: content || '',
        }

        // DeepSeek 思考模式要求：工具调用轮次必须回传 reasoning_content
        if (reasoningContent) {
          assistantMessage.reasoning_content = reasoningContent
        }

        // 从原始响应中提取 tool_calls（包含 id）
        const rawToolCalls = (rawMessage?.tool_calls as Array<{
          id: string
          type: string
          function: { name: string; arguments: string }
        }>) || []

        assistantMessage.tool_calls = rawToolCalls.length > 0
          ? rawToolCalls
          : toolCalls.map((tc, idx) => ({
            id: `call_${idx}`,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          }))

        // 构建 role:tool 消息（每条工具调用对应一条 tool 消息）
        const toolResultMessages = toolCalls.map((tc, idx) => ({
          role: 'tool',
          tool_call_id: rawToolCalls[idx]?.id || `call_${idx}`,
          content: JSON.stringify(toolResults[idx]?.result),
        }))

        // 递归调用获取最终响应
        const finalResponse = await sendChatMessageWithTools(
          providerId,
          config,
          [...messages, assistantMessage, ...toolResultMessages],
          true
        )

        // 合并思维链内容
        return {
          ...finalResponse,
          reasoningContent: reasoningContent || finalResponse.reasoningContent,
        }
      }
    }

    return { content, reasoningContent, toolResults: toolResults.length > 0 ? toolResults : undefined }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('请求已中断')
    }
    throw error
  } finally {
    currentAbortController = null
  }
}

// 流式输出回调类型
export interface StreamCallbacks {
  onReasoningChunk?: (chunk: string) => void
  onContentChunk?: (chunk: string) => void
  onToolCall?: (toolCall: { name: string; arguments: Record<string, unknown> }) => void
  onComplete?: () => void
  onError?: (error: Error) => void
}

// 发送流式聊天消息
export async function sendStreamChatMessage(
  providerId: string,
  config: AIConfig,
  messages: Array<Record<string, unknown>>,
  callbacks: StreamCallbacks,
  enableTools: boolean = true
): Promise<void> {
  // 创建新的 AbortController
  abortCurrentRequest()
  currentAbortController = new AbortController()
  const signal = currentAbortController.signal

  const provider = AI_PROVIDERS.find((p) => p.id === providerId)
  if (!provider) {
    throw new Error('未知的 AI 提供商')
  }

  const baseUrl = config.baseUrl || provider.baseUrl
  // 根据供应商决定是否使用 strict 模式
  // DeepSeek 支持 strict 模式，GLM 等不支持（可能影响指令遵循能力）
  const useStrict = providerId === 'deepseek'
  const tools = enableTools ? getToolsForAI(useStrict) : []
  const geminiTools = enableTools ? getToolsForGemini() : []

  let url: string
  let body: Record<string, unknown>
  let headers: Record<string, string>

  // Gemini 特殊处理
  if (providerId === 'gemini') {
    url = `${baseUrl}/models/${config.model}:streamGenerateContent?alt=sse`
    const systemMessage = messages.find((m) => m.role === 'system')
    const chatMessages = messages.filter((m) => m.role !== 'system')

    // 转换消息为 Gemini 格式
    const geminiContents = chatMessages.map((m) => {
      const role = m.role === 'assistant' ? 'model' : 'user'

      // 处理多模态消息（content 是数组）
      if (Array.isArray(m.content)) {
        const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = []

        for (const part of m.content) {
          if (part.type === 'text' && part.text) {
            parts.push({ text: part.text })
          } else if (part.type === 'image_url' && part.image_url?.url) {
            // 解析 data:image/jpeg;base64,xxx 格式
            const url = part.image_url.url
            const match = url.match(/^data:([^;]+);base64,(.+)$/)
            if (match) {
              parts.push({
                inlineData: {
                  mimeType: match[1],
                  data: match[2]
                }
              })
            }
          }
        }

        return { role, parts }
      }

      // 普通文本消息
      return {
        role,
        parts: [{ text: m.content || '' }],
      }
    })

    body = {
      contents: geminiContents,
      generationConfig: {
        temperature: config.temperature,
        maxOutputTokens: config.maxTokens,
      },
    }

    if (systemMessage) {
      (body as Record<string, unknown>).systemInstruction = {
        parts: [{ text: systemMessage.content }],
      }
    }

    // 添加 Gemini 格式的工具定义
    if (geminiTools.length > 0) {
      body.tools = geminiTools.map(tool => ({
        functionDeclarations: [tool]
      }))
    }

    headers = provider.headers(config.apiKey)
  } else {
    // OpenAI 兼容格式
    let effectiveBaseUrl = baseUrl
    // DeepSeek strict 模式需要使用 Beta 端点
    if (providerId === 'deepseek' && useStrict) {
      effectiveBaseUrl = baseUrl.replace(/\/beta$/, '').replace(/\/$/, '') + '/beta'
    }
    url = `${effectiveBaseUrl}${provider.chatEndpoint}`
    body = {
      model: config.model,
      messages: messages,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      stream: true,
    }

    // DeepSeek 特殊处理
    if (providerId === 'deepseek') {
      const supportsThinking = config.model === 'deepseek-reasoner' ||
        config.model.includes('v4-pro') || config.model === 'deepseek-v3'
      const isThinkingEnabled = supportsThinking && config.enableThinking !== false

      // 思考模式下不支持 temperature、top_p、presence_penalty、frequency_penalty
      if (isThinkingEnabled) {
        delete body.temperature
        delete body.top_p
        delete body.presence_penalty
        delete body.frequency_penalty
      }

      // JSON Output 模式
      if (config.responseFormat === 'json_object') {
        body.response_format = { type: 'json_object' }
      }

      // 思考模式控制（顶级参数，非 extra_body）
      if (config.enableThinking === false) {
        // 明确禁用思考（适用于所有模型）
        body.thinking = { type: 'disabled' }
      } else if (supportsThinking && config.model !== 'deepseek-reasoner') {
        // 支持思考的非 reasoner 模型，默认启用思考
        body.thinking = { type: 'enabled' }
      }

      // 思考强度控制（顶级参数）
      if (isThinkingEnabled && config.reasoningEffort) {
        body.reasoning_effort = config.reasoningEffort
      }

      // 流式输出包含 usage 信息
      body.stream_options = { include_usage: true }
    }

    // GLM 特殊处理
    if (providerId === 'zhipu') {
      // GLM 深度思考模式
      // GLM-5、GLM-4.7 默认开启思考，不需要显式设置
      // 只在需要禁用思考或设置特定参数时才设置
      if (config.glmConfig?.thinking) {
        body.thinking = config.glmConfig.thinking
      } else if (config.enableThinking === false) {
        // 明确禁用思考模式
        body.thinking = { type: 'disabled' }
      }
      // 注意：不设置 thinking 时，GLM-5/4.7 默认开启思考

      // GLM 保留式思考 (Preserved Thinking)
      // 在工具调用之间保留 reasoning_content，保持推理连贯性
      // clear_thinking: false 表示保留历史思考内容
      if (config.glmConfig?.clearThinking === false) {
        if (!body.thinking) {
          body.thinking = {}
        }
        (body.thinking as Record<string, unknown>).clear_thinking = false
      }

      // GLM 工具调用流式输出（GLM-5、GLM-4.7、GLM-4.6 支持）
      const supportsToolStream = config.model.includes('glm-5') ||
        config.model.includes('glm-4.7') ||
        config.model.includes('glm-4.6')
      if (supportsToolStream && tools.length > 0) {
        // 默认启用，除非明确禁用
        if (config.glmConfig?.toolStream !== false) {
          body.tool_stream = true
        }
      }

      // JSON Output 模式（结构化输出）
      if (config.responseFormat === 'json_object') {
        body.response_format = { type: 'json_object' }
      }
    }

    // Moonshot 流式处理
    if (providerId === 'moonshot') {
      // Moonshot 兼容 OpenAI SDK，支持工具调用、JSON Output
      // kimi-k2 系列支持深度思考，kimi-k1.5 也支持但不支持工具调用
      const supportsToolUse = !config.model.includes('kimi-k1')

      // 某些 Moonshot 模型（如 kimi-k2/k2.5 系列、kimi-k1.5 系列）只支持 temperature: 1
      // 如果用户设置了其他值，需要强制设置为 1
      if (config.model.includes('kimi-k2') || config.model.includes('kimi-k1')) {
        body.temperature = 1
      }

      // JSON Output 模式
      if (config.responseFormat === 'json_object') {
        body.response_format = { type: 'json_object' }
      }

      // 注意：Moonshot 的 reasoning_content 是模型自动返回的，不需要额外参数开启
      // 工具调用只在支持的模型上启用
      if (!supportsToolUse && tools.length > 0) {
        // k1.5 不支持工具调用，移除工具
        delete body.tools
        delete body.tool_choice
      }

      // Partial Mode：预填模型回复来引导输出
      // 参考：https://platform.moonshot.cn/docs/api/partial
      if (config.moonshotConfig?.partial) {
        // 检查最后一条消息是否是 assistant 角色
        const lastMessage = messages[messages.length - 1]
        if (lastMessage && lastMessage.role === 'assistant') {
          (lastMessage as Record<string, unknown>).partial = true
          // 可选：添加 name 字段强化角色一致性
          if (config.moonshotConfig.name) {
            (lastMessage as Record<string, unknown>).name = config.moonshotConfig.name
          }
        }
      }
    }

    if (tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }

    headers = {
      ...provider.headers(config.apiKey),
      'Accept': 'text/event-stream',
    }
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
      signal,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`请求失败: ${error}`)
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
    const geminiThoughtSignatures: string[] = [] // 存储 Gemini 的 thoughtSignature
    const toolCalls: Array<{
      id: string
      type: string
      function: { name: string; arguments: string }
      thoughtSignature?: string
    }> = []

    while (!isDone) {
      const { done, value } = await reader.read()
      if (done) {
        isDone = true
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6)
          if (data === '[DONE]') {
            isDone = true
            break
          }

          try {
            const parsed = JSON.parse(data)

            // Gemini 格式处理
            if (providerId === 'gemini') {
              const candidate = parsed.candidates?.[0]
              const parts = candidate?.content?.parts

              if (parts && parts.length > 0) {
                for (const part of parts) {
                  // 处理思考内容 (thought: true)
                  if (part.thought && part.text) {
                    assistantReasoningContent += part.text
                    callbacks.onReasoningChunk?.(part.text)
                  }
                  // 处理普通文本内容
                  else if (part.text && !part.thought) {
                    assistantContent += part.text
                    callbacks.onContentChunk?.(part.text)
                  }

                  // 处理 Gemini 工具调用
                  if (part.functionCall) {
                    const fc = part.functionCall
                    // 保存 thoughtSignature 用于后续函数调用
                    if (fc.thoughtSignature) {
                      geminiThoughtSignatures.push(fc.thoughtSignature)
                    }
                    toolCalls.push({
                      id: fc.name,
                      type: 'function',
                      function: {
                        name: fc.name,
                        arguments: JSON.stringify(fc.args || {})
                      },
                      thoughtSignature: fc.thoughtSignature
                    })
                    callbacks.onToolCall?.({
                      name: fc.name,
                      arguments: fc.args || {},
                    })
                  }
                }
              }
              continue
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
                  callbacks.onToolCall?.({
                    name: tc.function.name,
                    arguments: JSON.parse(tc.function.arguments || '{}'),
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

    // 如果有工具调用，执行工具并将结果返回给 AI
    if (toolCalls.length > 0) {
      const toolResults: Array<{ tool: string; result: unknown }> = []

      for (const tc of toolCalls) {
        const result = await executeToolCall(
          tc.function.name,
          JSON.parse(tc.function.arguments || '{}')
        )
        toolResults.push({ tool: tc.function.name, result })
      }

      // Gemini 特殊处理
      if (providerId === 'gemini') {
        // Gemini 工具结果格式
        // functionResponse 的 response 需要是一个对象，包含 content 或其他字段
        const toolResultParts = toolResults.map((tr, index) => ({
          functionResponse: {
            name: toolCalls[index].function.name,
            response: {
              // Gemini 要求 response 对象包含特定字段
              // 将工具结果作为 JSON 字符串放入 content 字段
              content: JSON.stringify(tr.result)
            }
          }
        }))

        // 构建 Gemini 格式的消息
        const geminiMessages = [
          ...messages,
          {
            role: 'model',
            parts: toolCalls.map(tc => {
              const part: Record<string, unknown> = {
                functionCall: {
                  name: tc.function.name,
                  args: JSON.parse(tc.function.arguments || '{}')
                }
              }
              // 添加 thoughtSignature 如果有的话
              if (tc.thoughtSignature) {
                part.thoughtSignature = tc.thoughtSignature
              }
              return part
            })
          },
          {
            role: 'user',
            parts: toolResultParts
          }
        ]

        await sendStreamChatMessage(
          providerId,
          config,
          geminiMessages,
          callbacks,
          true
        )
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
      assistantMessage.tool_calls = toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments
        }
      }))

      // 构建 tool 结果消息
      const toolResultMessages = toolCalls.map((tc, index) => ({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(toolResults[index]?.result)
      }))

      // 递归调用获取最终响应
      // 注意：思考模式下模型可能需要多轮工具调用，所以保持 enableTools=true
      // 直到模型返回最终 content 而没有 tool_calls
      await sendStreamChatMessage(
        providerId,
        config,
        [...messages, assistantMessage, ...toolResultMessages],
        callbacks,
        true  // 保持工具调用启用，支持多轮思考+工具调用
      )
      return
    }

    callbacks.onComplete?.()
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      callbacks.onError?.(new Error('请求已中断'))
    } else {
      callbacks.onError?.(error instanceof Error ? error : new Error(String(error)))
    }
  } finally {
    currentAbortController = null
  }
}

// 验证 API 密钥
export async function validateApiKey(
  provider: AIProvider,
  apiKey: string,
  customBaseUrl?: string
): Promise<boolean> {
  try {
    await fetchModels(provider, apiKey, customBaseUrl)
    return true
  } catch {
    return false
  }
}
