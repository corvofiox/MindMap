// AI 服务 API 接口层
// 支持 DeepSeek、智谱 GLM、Gemini、Ollama 等主流推理服务

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
}

// 预设的 AI 提供商配置
export const AI_PROVIDERS: AIProvider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    description: 'DeepSeek 系列模型',
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
        .map((m) => ({
          id: m.id,
          name: m.id,
          description: 'DeepSeek 模型',
        }))
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
    description: '智谱 GLM 系列模型',
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
        .map((m) => ({
          id: m.id,
          name: m.id,
          description: '智谱 GLM 模型',
        }))
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
        candidates: Array<{ content: { parts: Array<{ text: string }> }; reasoning_content?: string }>
      }
      return {
        content: data.candidates?.[0]?.content?.parts?.[0]?.text || '',
        reasoningContent: data.candidates?.[0]?.reasoning_content,
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
  config: {
    apiKey: string
    baseUrl: string
    model: string
    temperature: number
    maxTokens: number
  },
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

  const tools = enableTools ? getToolsForAI() : []

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
    url = `${baseUrl}${provider.chatEndpoint}`
    body = {
      model: config.model,
      messages: messages,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
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
    const { content, reasoningContent, toolCalls } = provider.parseChatResponse(data)

    // 执行工具调用
    const toolResults: Array<{ tool: string; result: unknown }> = []
    if (toolCalls && toolCalls.length > 0) {
      for (const toolCall of toolCalls) {
        const result = await executeToolCall(toolCall.name, toolCall.arguments)
        toolResults.push({ tool: toolCall.name, result })
      }

      // 将工具结果返回给 AI 继续处理
      if (toolResults.length > 0) {
        const toolResultMessage = {
          role: 'tool',
          content: JSON.stringify(toolResults),
        }

        // 递归调用获取最终响应
        const finalResponse = await sendChatMessageWithTools(
          providerId,
          config,
          [...messages, { role: 'assistant', content }, { role: 'user', content: `工具执行结果：${JSON.stringify(toolResults, null, 2)}\n\n请根据这些结果继续回答。` }],
          false // 不再启用工具调用，避免循环
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
  config: {
    apiKey: string
    baseUrl: string
    model: string
    temperature: number
    maxTokens: number
  },
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
  const tools = enableTools ? getToolsForAI() : []
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
    url = `${baseUrl}${provider.chatEndpoint}`
    body = {
      model: config.model,
      messages: messages,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      stream: true,
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
    const toolCalls: Array<{
      id: string
      type: string
      function: { name: string; arguments: string }
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
                  // 处理文本内容
                  if (part.text) {
                    assistantContent += part.text
                    callbacks.onContentChunk?.(part.text)
                  }

                  // 处理 Gemini 工具调用
                  if (part.functionCall) {
                    const fc = part.functionCall
                    toolCalls.push({
                      id: fc.name,
                      type: 'function',
                      function: {
                        name: fc.name,
                        arguments: JSON.stringify(fc.args || {})
                      }
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
            parts: toolCalls.map(tc => ({
              functionCall: {
                name: tc.function.name,
                args: JSON.parse(tc.function.arguments || '{}')
              }
            }))
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
