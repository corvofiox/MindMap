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

// 上下文裁剪：超出预算时移除最早的消息，尽量保留最后的消息
// 并避免以 assistant/tool 消息开头（多数 API 要求首条消息为 user/system；
// tool 消息前面必须有对应的 assistant tool_calls 消息，单独出现会 400）
// 注意：末尾残留的孤儿 tool（前置 assistant 已被裁掉）也会一并移除，
// 极端预算下结果可能为空数组，由调用方兜底
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
      // C6: 按 assistant+tool 组为单位裁剪——若移除的是带 tool_calls 的
      // assistant 消息，其后续的 role:'tool' 消息立即成为孤儿（前面没有
      // 对应的 assistant），必须一并移除，否则上游 API 会 400。
      if (removed.role === 'assistant' && (removed as Record<string, unknown>).tool_calls) {
        // N2: 条件用 length > 0 而非 length > 1——若 assistant 是倒数第二条、
        // 其 tool 是最后一条,旧条件会因长度只剩 1 而停下,残留孤儿 tool 消息
        while (result.length > 0 && result[0]?.role === 'tool') {
          const t = result.shift()!
          total -= estimateTokens(JSON.stringify(t))
        }
      }
    }
  }

  // 兜底：首条不能是 assistant 或 tool（预算恰好停在 tool 消息上时，
  // 它同样没有前置 assistant，属于孤儿，必须移除）。
  // N2: 条件用 length > 0——最后一条是孤儿 tool 时也要移除(即使结果为空数组),
  // 否则上游 API 会因"tool 前无 assistant"返回 400
  while (result.length > 0 && (result[0]?.role === 'assistant' || result[0]?.role === 'tool')) {
    result.shift()
  }

  return result
}
