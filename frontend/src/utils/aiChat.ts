// AI 对话消息构建工具（纯函数，供 AiSidebar 使用）

export interface Attachment {
  id: string
  type: 'image' | 'file'
  name: string
  mimeType: string
  size: number
  data?: string // base64 数据（图片）或文本内容（文件）
  url?: string // 图片预览 URL（blob，刷新后失效）
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'divider'
  content: string
  timestamp: number
  reasoningContent?: string // 思维链内容
  hasToolCalls?: boolean // 是否包含工具调用
  /** 工具调用产生的中间消息（assistant+tool），需在后续多轮对话中回传给 API */
  toolExchangeMessages?: Array<Record<string, unknown>>
  isInterrupted?: boolean // 是否被中断
  attachments?: Attachment[] // 附件（图片/文件）
}

// 构建发送给 AI 的消息历史
// - assistant 消息的工具交换消息（assistant+tool）原样展开
// - 有图片附件的消息使用多模态 content 数组
// - 普通 assistant 消息不携带 reasoning_content（工具轮次的思维链已包含在 toolExchangeMessages 中）
export function buildMessageHistory(
  messages: Message[],
  startIndex: number
): Array<Record<string, unknown>> {
  return messages
    .slice(startIndex)
    .filter((m) => m.id !== 'welcome' && m.role !== 'divider')
    .flatMap((m) => {
      // Assistant 消息有工具交换：先输出中间消息，再输出最终 assistant
      if (m.role === 'assistant' && m.toolExchangeMessages && m.toolExchangeMessages.length > 0) {
        return [...m.toolExchangeMessages, { role: 'assistant', content: m.content }]
      }

      // 如果有图片附件，使用多模态格式
      if (m.attachments && m.attachments.some((a) => a.type === 'image' && a.data)) {
        const imageAttachments = m.attachments.filter((a) => a.type === 'image' && a.data)
        const textContent = m.content || ''

        // 构建 content 数组（文本 + 图片）
        const contentParts: Array<{ type: string; text?: string; image_url?: { url: string } }> = []

        if (textContent) {
          contentParts.push({ type: 'text', text: textContent })
        }

        // 添加图片（使用 base64 格式）
        for (const img of imageAttachments) {
          if (img.data && img.mimeType) {
            contentParts.push({
              type: 'image_url',
              image_url: {
                url: `data:${img.mimeType};base64,${img.data}`,
              },
            })
          }
        }

        return { role: m.role, content: contentParts }
      }

      // 普通文本消息
      return {
        role: m.role,
        content: m.content,
      }
    })
}

// 构建当前用户消息（文本 + 文本文件内容 + 图片）
export function buildUserMessage(
  content: string,
  attachments?: Attachment[]
): Record<string, unknown> {
  const userMessage: Record<string, unknown> = { role: 'user' }
  const contentParts: Array<{ type: string; text?: string; image_url?: { url: string } }> = []

  // 添加用户输入文本
  if (content) {
    contentParts.push({ type: 'text', text: content })
  }

  // 添加文本文件内容（在后台传递给 AI，不显示在气泡中）
  const textFiles = (attachments || []).filter((f) => f.type === 'file' && f.data)
  for (const file of textFiles) {
    if (file.data) {
      contentParts.push({
        type: 'text',
        text: `\n\n--- ${file.name} ---\n${file.data}`,
      })
    }
  }

  // 添加图片
  const imageAttachments = (attachments || []).filter((f) => f.type === 'image' && f.data)
  for (const img of imageAttachments) {
    if (img.data && img.mimeType) {
      contentParts.push({
        type: 'image_url',
        image_url: {
          url: `data:${img.mimeType};base64,${img.data}`,
        },
      })
    }
  }

  // 如果有多个部分，使用数组格式；否则使用简单字符串
  if (contentParts.length === 1 && contentParts[0].type === 'text') {
    userMessage.content = contentParts[0].text
  } else if (contentParts.length > 0) {
    userMessage.content = contentParts
  } else {
    userMessage.content = content
  }

  return userMessage
}

// 保存前清理：剥离附件的大体积/失效数据，避免 DB 膨胀
// - 图片 base64 data 移除（刷新后显示占位）
// - blob 预览 URL 移除（刷新后失效，避免裂图）
// - 文本文件内容移除（不持久化大文本）
export function sanitizeMessagesForSave(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (!m.attachments || m.attachments.length === 0) return m
    return {
      ...m,
      attachments: m.attachments.map((a) => {
        if (a.type === 'image') {
          const isBlobUrl = a.url?.startsWith('blob:')
          return { ...a, data: undefined, url: isBlobUrl ? undefined : a.url }
        }
        return { ...a, data: undefined }
      }),
    }
  })
}

// 估算 token 数（粗略近似：约 2 个字符 ≈ 1 token）
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2)
}

// 上下文裁剪：超出预算时移除最早的消息，保证最后一条消息保留
// 并避免以 assistant 消息开头（多数 API 要求首条消息为 user/system）
export function trimMessageHistory(
  history: Array<Record<string, unknown>>,
  maxTokens: number
): Array<Record<string, unknown>> {
  if (history.length <= 1) return history

  let total = 0
  for (const m of history) {
    total += estimateTokens(JSON.stringify(m))
  }
  if (total <= maxTokens) return history

  const result = [...history]
  while (result.length > 1 && total > maxTokens) {
    const removed = result.shift()
    if (removed) {
      total -= estimateTokens(JSON.stringify(removed))
    }
  }

  // 避免以 assistant 消息开头
  while (result.length > 1 && result[0]?.role === 'assistant') {
    result.shift()
  }

  return result
}
