import { useState, useRef, useEffect } from 'react'
import { Send, X, Sparkles, User, Bot, Trash2, Copy, Check, Plus, FileText, Image as ImageIcon, Settings, RefreshCw, Brain, Square, Eraser } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github-dark.css'
import { useUIStore } from '@/store/useUIStore'
import { useAIStore } from '@/store/useAIStore'
import { useAuthStore } from '@/store/useAuthStore'
import { AIConfigDialog } from '@/components/ai/AIConfigDialog'
import { sendStreamChatMessage, abortCurrentRequest, type StreamCallbacks, AI_PROVIDERS, validateApiKey } from '@/services/aiService'
import { getAIConversation, saveAIConversation, deleteAIConversation } from '@/services/api'
import { Z_INDEX, DEFAULT_SYSTEM_PROMPT } from '@/constants'
import { useCanvasStore } from '@/store/useCanvasStore'

interface Message {
  id: string
  role: 'user' | 'assistant' | 'divider'
  content: string
  timestamp: number
  reasoningContent?: string  // 思维链内容
  isInterrupted?: boolean    // 是否被中断
  attachments?: Attachment[] // 附件（图片/文件）
}

interface Attachment {
  id: string
  type: 'image' | 'file'
  name: string
  mimeType: string
  size: number
  data?: string  // base64 数据（用于图片）
  url?: string   // 图片预览 URL
}

interface AiSidebarProps {
  open: boolean
}

export function AiSidebar({ open }: AiSidebarProps) {
  const { setAiSidebarOpen } = useUIStore()
  const { currentProvider, providerConfigs, isConnected } = useAIStore()
  const { user } = useAuthStore()
  const config = providerConfigs[currentProvider]
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: isConnected
        ? '你好！我是你的 AI 思维导图助手。我可以帮你：\n\n• 生成思维导图结构\n• 扩展节点内容\n• 优化布局建议\n• 回答相关问题\n\n请告诉我你想创建什么样的思维导图？'
        : '欢迎使用 AI 思维导图助手！\n\n⚠️ 尚未配置 AI 服务\n\n请点击右上角的设置按钮，配置您的 AI 服务提供商和 API 密钥。\n\n支持的提供商：\n• DeepSeek (DeepSeek 系列)\n• 智谱 AI (GLM 系列)\n• Google Gemini (Gemini 系列)\n• Ollama (本地模型)\n• 自定义 OpenAI 兼容 API',
      timestamp: Date.now(),
    },
  ])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [showAttachMenu, setShowAttachMenu] = useState(false)
  const [attachedFiles, setAttachedFiles] = useState<Attachment[]>([])
  const [inputHeight, setInputHeight] = useState(120) // 输入区域默认高度
  const [isDragging, setIsDragging] = useState(false)
  const [showConfigDialog, setShowConfigDialog] = useState(false)
  const [expandedReasoning, setExpandedReasoning] = useState<Set<string>>(new Set()) // 展开的思维链
  const [contextDividerIndex, setContextDividerIndex] = useState<number>(-1) // 上下文分隔线索引，-1表示没有分隔线
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const { canvasId } = useCanvasStore()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const lastCanvasIdRef = useRef<number | null>(null)
  const isLoadingConversationRef = useRef(false)
  const attachMenuRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const dragStartYRef = useRef(0)
  const dragStartHeightRef = useRef(0)

  // 自动滚动到底部
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  // 聚焦输入框当侧边栏打开
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [open])

  // 自动验证并恢复已保存的连接状态
  useEffect(() => {
    const autoValidateConnection = async () => {
      const provider = AI_PROVIDERS.find((p) => p.id === currentProvider)
      if (!provider) return

      // 检查配置是否完整
      const hasApiKey = !provider.apiKeyRequired || config.apiKey
      const hasBaseUrl = config.baseUrl || provider.baseUrl

      if (!hasApiKey || !hasBaseUrl) {
        // 配置不完整，标记为未连接
        if (isConnected) {
          useAIStore.getState().setIsConnected(false)
        }
        return
      }

      // 如果已经标记为连接，验证是否仍然有效
      if (isConnected) {
        try {
          const isValid = await validateApiKey(
            provider,
            config.apiKey,
            config.baseUrl || undefined
          )
          if (!isValid) {
            useAIStore.getState().setIsConnected(false)
          }
        } catch {
          useAIStore.getState().setIsConnected(false)
        }
      }
    }

    // 组件加载时执行验证
    autoValidateConnection()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // 只在组件加载时执行

  // 监听画布ID变化，重置加载状态
  useEffect(() => {
    if (canvasId !== lastCanvasIdRef.current) {
      lastCanvasIdRef.current = null
    }
  }, [canvasId])

  // 加载画布的对话历史
  useEffect(() => {
    // 只在画布ID变化时加载，不依赖侧边栏打开状态
    if (!canvasId) return

    // 如果已经加载过这个画布，不再重复加载
    if (lastCanvasIdRef.current === canvasId) {
      return
    }

    const loadConversation = async () => {
      // 避免并发加载
      if (isLoadingConversationRef.current) {
        return
      }

      isLoadingConversationRef.current = true
      lastCanvasIdRef.current = canvasId

      try {
        const data = await getAIConversation(canvasId)
        const { messages: savedMessages, contextDividerIndex: savedIndex } = data
        if (savedMessages && savedMessages.length > 0) {
          setMessages(savedMessages)
          setContextDividerIndex(savedIndex ?? -1)
        } else {
          // 如果没有保存的对话，显示欢迎消息
          setMessages([
            {
              id: 'welcome',
              role: 'assistant',
              content: isConnected
                ? '你好！我是你的 AI 思维导图助手。我可以帮你：\n\n• 生成思维导图结构\n• 扩展节点内容\n• 优化布局建议\n• 回答相关问题\n\n请告诉我你想创建什么样的思维导图？'
                : '欢迎使用 AI 思维导图助手！\n\n⚠️ 尚未配置 AI 服务\n\n请点击右上角的设置按钮，配置您的 AI 服务提供商和 API 密钥。\n\n支持的提供商：\n• DeepSeek (DeepSeek 系列)\n• 智谱 AI (GLM 系列)\n• Google Gemini (Gemini 系列)\n• Ollama (本地模型)\n• 自定义 OpenAI 兼容 API',
              timestamp: Date.now(),
            },
          ])
          setContextDividerIndex(-1)
        }
      } catch (error) {
        console.error('[AI Sidebar] Failed to load conversation:', error)
      } finally {
        isLoadingConversationRef.current = false
      }
    }

    loadConversation()
  }, [canvasId])

  // 保存对话历史到服务器（防抖）
  const messagesRef = useRef(messages)
  const contextDividerIndexRef = useRef(contextDividerIndex)

  // 更新 ref 值
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    contextDividerIndexRef.current = contextDividerIndex
  }, [contextDividerIndex])

  // 使用 ref 进行保存，避免循环依赖
  useEffect(() => {
    if (!canvasId) return

    const timeoutId = setTimeout(async () => {
      const currentMessages = messagesRef.current
      // 只保存非空的对话（超过欢迎消息）
      if (currentMessages.length <= 1 && currentMessages[0]?.id === 'welcome') {
        return
      }

      try {
        await saveAIConversation(canvasId, {
          messages: currentMessages,
          contextDividerIndex: contextDividerIndexRef.current,
        })
      } catch (error) {
        console.error('[AI Sidebar] Failed to save conversation:', error)
      }
    }, 1000) // 1秒防抖

    return () => clearTimeout(timeoutId)
  }, [canvasId, messages, contextDividerIndex])

  const handleSend = async () => {
    if ((!input.trim() && attachedFiles.length === 0) || isLoading) return

    // 构建消息内容（仅用户输入，文件内容在后台传递给AI）
    const content = input.trim()

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: content,
      timestamp: Date.now(),
      attachments: attachedFiles.length > 0 ? [...attachedFiles] : undefined,
    }

    setMessages((prev) => [...prev, userMessage])
    setInput('')
    setAttachedFiles([])
    setIsLoading(true)

    // 调用真实 AI API
    try {
      if (!isConnected || !config.model) {
        throw new Error('请先配置 AI 服务')
      }

      // 构建消息历史（只包含分隔线以下的消息）
      // DeepSeek 思考模式优化：在新一轮对话中只传入上一轮的 content，忽略 reasoning_content
      const startIndex = contextDividerIndex >= 0 ? contextDividerIndex : 0
      const messageHistory = messages
        .slice(startIndex)
        .filter((m) => m.id !== 'welcome' && m.role !== 'divider')
        .map((m) => {
          // 如果有图片附件，使用多模态格式
          if (m.attachments && m.attachments.some(a => a.type === 'image' && a.data)) {
            const imageAttachments = m.attachments.filter(a => a.type === 'image' && a.data)
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
                    url: `data:${img.mimeType};base64,${img.data}`
                  }
                })
              }
            }

            return {
              role: m.role,
              content: contentParts,
            }
          }

          // 普通文本消息 - 只返回 content，不返回 reasoning_content
          // 这是 DeepSeek 思考模式的要求：多轮对话中只保留 content
          return {
            role: m.role,
            content: m.content,
          }
        })

      // 添加系统提示（包含工具调用说明和思维链）
      const systemMessage = {
        role: 'system',
        content: DEFAULT_SYSTEM_PROMPT,
      }

      // 创建助手消息占位符
      const assistantMessageId = (Date.now() + 1).toString()
      const assistantMessage: Message = {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        reasoningContent: '',
      }
      setMessages((prev) => [...prev, assistantMessage])

      // 流式输出回调
      const callbacks: StreamCallbacks = {
        onReasoningChunk: (chunk) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessageId
                ? { ...m, reasoningContent: (m.reasoningContent || '') + chunk }
                : m
            )
          )
        },
        onContentChunk: (chunk) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessageId
                ? { ...m, content: m.content + chunk }
                : m
            )
          )
        },
        onComplete: () => {
          setIsLoading(false)
          // 如果内容为空，显示提示信息
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessageId && m.content === '' && !m.isInterrupted
                ? { ...m, content: '（AI 未返回内容）' }
                : m
            )
          )
        },
        onError: (error) => {
          setIsLoading(false)
          if (error.message === '请求已中断') {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMessageId
                  ? {
                    ...m,
                    content: m.content || '',
                    isInterrupted: true,
                  }
                  : m
              )
            )
          } else {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMessageId
                  ? { ...m, content: `❌ 请求失败：${error.message}\n\n请检查：\n1. AI 服务配置是否正确\n2. API 密钥是否有效\n3. 网络连接是否正常` }
                  : m
              )
            )
          }
        },
      }

      // 构建当前用户消息（支持多模态）
      const currentUserMessage: Record<string, unknown> = { role: 'user' }
      const imageAttachments = attachedFiles.filter(f => f.type === 'image' && f.data)
      const textFiles = attachedFiles.filter(f => f.type === 'file' && f.data)

      // 构建 content 数组（文本 + 图片 + 文本文件内容）
      const contentParts: Array<{ type: string; text?: string; image_url?: { url: string } }> = []

      // 添加用户输入文本
      if (content) {
        contentParts.push({ type: 'text', text: content })
      }

      // 添加文本文件内容（在后台传递给 AI，不显示在气泡中）
      for (const file of textFiles) {
        if (file.data) {
          contentParts.push({
            type: 'text',
            text: `\n\n--- ${file.name} ---\n${file.data}`
          })
        }
      }

      // 添加图片
      for (const img of imageAttachments) {
        if (img.data && img.mimeType) {
          contentParts.push({
            type: 'image_url',
            image_url: {
              url: `data:${img.mimeType};base64,${img.data}`
            }
          })
        }
      }

      // 如果有多个部分，使用数组格式；否则使用简单字符串
      if (contentParts.length === 1 && contentParts[0].type === 'text') {
        currentUserMessage.content = contentParts[0].text
      } else if (contentParts.length > 0) {
        currentUserMessage.content = contentParts
      } else {
        currentUserMessage.content = ''
      }

      // 发送流式请求
      await sendStreamChatMessage(
        currentProvider,
        { ...config, provider: currentProvider },
        [
          systemMessage,
          ...messageHistory,
          currentUserMessage,
        ],
        callbacks
      )
    } catch (error) {
      setIsLoading(false)
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      setMessages((prev) =>
        prev.map((m) =>
          m.id === (Date.now() + 1).toString()
            ? { ...m, content: `❌ 请求失败：${errorMessage}\n\n请检查：\n1. AI 服务配置是否正确\n2. API 密钥是否有效\n3. 网络连接是否正常` }
            : m
        )
      )
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleCopy = async (content: string, id: string) => {
    try {
      await navigator.clipboard.writeText(content)
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 2000)
    } catch (err) {
      console.error('Copy failed:', err)
    }
  }

  // 重新回答功能
  const handleRegenerate = async (messageIndex: number) => {
    // 找到当前 AI 回复对应的用户消息
    let userMessageIndex = messageIndex - 1
    while (userMessageIndex >= 0 && messages[userMessageIndex].role !== 'user') {
      userMessageIndex--
    }

    if (userMessageIndex < 0) return

    const userMessage = messages[userMessageIndex]

    // 删除当前 AI 回复及之后的所有消息
    setMessages((prev) => prev.slice(0, messageIndex))
    setIsLoading(true)

    try {
      if (!isConnected || !config.model) {
        throw new Error('请先配置 AI 服务')
      }

      // 构建消息历史（不包括被删除的消息，且只包含分隔线以下的消息）
      const startIndex = contextDividerIndex >= 0 ? contextDividerIndex : 0
      const messageHistory = messages
        .slice(Math.max(startIndex, 0), userMessageIndex)
        .filter((m) => m.id !== 'welcome' && m.role !== 'divider')
        .map((m) => ({
          role: m.role,
          content: m.content,
        }))

      // 添加系统提示
      const systemMessage = {
        role: 'system',
        content: DEFAULT_SYSTEM_PROMPT,
      }

      // 创建助手消息占位符
      const assistantMessageId = (Date.now() + 1).toString()
      const assistantMessage: Message = {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        reasoningContent: '',
      }
      setMessages((prev) => [...prev, assistantMessage])

      // 流式输出回调
      const callbacks: StreamCallbacks = {
        onReasoningChunk: (chunk) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessageId
                ? { ...m, reasoningContent: (m.reasoningContent || '') + chunk }
                : m
            )
          )
        },
        onContentChunk: (chunk) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessageId
                ? { ...m, content: m.content + chunk }
                : m
            )
          )
        },
        onComplete: () => {
          setIsLoading(false)
        },
        onError: (error) => {
          setIsLoading(false)
          if (error.message === '请求已中断') {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMessageId
                  ? { ...m, content: m.content + '\n\n⏹️ 回答已中断' }
                  : m
              )
            )
          } else {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMessageId
                  ? { ...m, content: `❌ 请求失败：${error.message}\n\n请检查：\n1. AI 服务配置是否正确\n2. API 密钥是否有效\n3. 网络连接是否正常` }
                  : m
              )
            )
          }
        },
      }

      // 构建当前用户消息（包含附件中的文本文件内容）
      const currentUserMessage: Record<string, unknown> = { role: 'user' }

      // 检查是否有附件
      if (userMessage.attachments && userMessage.attachments.length > 0) {
        const contentParts: Array<{ type: string; text?: string; image_url?: { url: string } }> = []

        // 添加用户输入文本
        if (userMessage.content) {
          contentParts.push({ type: 'text', text: userMessage.content })
        }

        // 添加文本文件内容
        const textFiles = userMessage.attachments.filter(f => f.type === 'file' && f.data)
        for (const file of textFiles) {
          if (file.data) {
            contentParts.push({
              type: 'text',
              text: `\n\n--- ${file.name} ---\n${file.data}`
            })
          }
        }

        // 添加图片
        const imageAttachments = userMessage.attachments.filter(f => f.type === 'image' && f.data)
        for (const img of imageAttachments) {
          if (img.data && img.mimeType) {
            contentParts.push({
              type: 'image_url',
              image_url: {
                url: `data:${img.mimeType};base64,${img.data}`
              }
            })
          }
        }

        // 如果有多个部分，使用数组格式；否则使用简单字符串
        if (contentParts.length === 1 && contentParts[0].type === 'text') {
          currentUserMessage.content = contentParts[0].text
        } else if (contentParts.length > 0) {
          currentUserMessage.content = contentParts
        } else {
          currentUserMessage.content = userMessage.content || ''
        }
      } else {
        // 没有附件，使用简单字符串
        currentUserMessage.content = userMessage.content || ''
      }

      // 发送流式请求
      await sendStreamChatMessage(
        currentProvider,
        { ...config, provider: currentProvider },
        [
          systemMessage,
          ...messageHistory,
          currentUserMessage,
        ],
        callbacks
      )
    } catch (error) {
      setIsLoading(false)
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      setMessages((prev) =>
        prev.map((m) =>
          m.id === (Date.now() + 1).toString()
            ? { ...m, content: `❌ 请求失败：${errorMessage}\n\n请检查：\n1. AI 服务配置是否正确\n2. API 密钥是否有效\n3. 网络连接是否正常` }
            : m
        )
      )
    }
  }

  const handleClear = async () => {
    if (confirm('确定要清空所有对话吗？')) {
      // 先清空本地状态
      setMessages([
        {
          id: 'welcome',
          role: 'assistant',
          content: '对话已清空。我是你的 AI 思维导图助手，有什么可以帮你的吗？',
          timestamp: Date.now(),
        },
      ])
      setAttachedFiles([])
      setContextDividerIndex(-1)

      // 删除服务器上的对话记录
      if (canvasId) {
        try {
          await deleteAIConversation(canvasId)
        } catch (error) {
          console.error('[AI Sidebar] Failed to delete conversation:', error)
        }
      }
    }
  }

  // 清除上下文 - 在当前位置添加分隔线
  const handleClearContext = () => {
    const lastMessageIndex = messages.length - 1
    if (lastMessageIndex < 0) return

    // 添加分隔线消息
    const dividerMessage: Message = {
      id: `divider-${Date.now()}`,
      role: 'divider',
      content: '',
      timestamp: Date.now(),
    }

    setMessages((prev) => [...prev, dividerMessage])
    setContextDividerIndex(messages.length)
  }

  // 点击外部关闭附件菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (attachMenuRef.current && !attachMenuRef.current.contains(event.target as Node)) {
        setShowAttachMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // 处理添加文件
  const handleAddFile = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    setShowAttachMenu(false)
    // 使用 setTimeout 确保菜单关闭后再打开文件选择器
    setTimeout(() => {
      // 重置 input 值，确保可以重复选择相同文件
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
      fileInputRef.current?.click()
    }, 0)
  }

  // 处理添加图片
  const handleAddImage = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    setShowAttachMenu(false)
    // 使用 setTimeout 确保菜单关闭后再打开文件选择器
    setTimeout(() => {
      // 重置 input 值，确保可以重复选择相同文件
      if (imageInputRef.current) {
        imageInputRef.current.value = ''
      }
      imageInputRef.current?.click()
    }, 0)
  }

  // 将文件转换为 base64
  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = reader.result as string
        // 移除 data:image/jpeg;base64, 前缀，只保留 base64 数据
        const base64 = result.split(',')[1]
        resolve(base64)
      }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  // 读取文本文件内容
  const readTextFile = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        resolve(reader.result as string)
      }
      reader.onerror = reject
      reader.readAsText(file)
    })
  }

  // 判断是否为文本文件（根据扩展名）
  const isTextFile = (file: File): boolean => {
    const textExtensions = [
      '.txt', '.md', '.json', '.xml', '.csv', '.tsv', '.yaml', '.yml',
      '.ini', '.conf', '.config', '.log', '.properties', '.env', '.sql',
      '.html', '.htm', '.css', '.js', '.jsx', '.ts', '.tsx', '.vue',
      '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs',
      '.rb', '.php', '.swift', '.kt', '.scala', '.r', '.m', '.mm',
      '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.dart', '.lua',
      '.pl', '.pm', '.groovy', '.gradle', '.dockerfile', '.gitignore', '.editorconfig'
    ]
    const ext = file.name.toLowerCase().slice(file.name.lastIndexOf('.'))
    return textExtensions.includes(ext)
  }

  // 处理文件选择
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files

    if (!files || files.length === 0) {
      e.target.value = ''
      return
    }

    const newFiles = Array.from(files)

    // 处理每个文件
    for (const file of newFiles) {
      const isImage = file.type.startsWith('image/')
      const attachmentId = `attach-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`

      const attachment: Attachment = {
        id: attachmentId,
        type: isImage ? 'image' : 'file',
        name: file.name,
        mimeType: file.type,
        size: file.size,
      }

      // 如果是图片，转换为 base64 并创建预览 URL
      if (isImage) {
        try {
          const base64 = await fileToBase64(file)
          attachment.data = base64
          attachment.url = URL.createObjectURL(file)
        } catch (error) {
          console.error('Failed to convert image to base64:', error)
          continue
        }
      } else if (isTextFile(file)) {
        // 文本文件，读取内容
        try {
          const content = await readTextFile(file)
          attachment.data = content
        } catch (error) {
          console.error('Failed to read text file:', error)
          continue
        }
      }

      setAttachedFiles((prev) => {
        // 去重：避免添加同名文件
        const existingKeys = new Set(prev.map(f => `${f.name}-${f.size}`))
        const key = `${file.name}-${file.size}`
        if (existingKeys.has(key)) {
          return prev
        }
        return [...prev, attachment]
      })
    }

    // 重置 input 值，允许再次选择相同文件
    e.target.value = ''
  }

  // 移除附件
  const handleRemoveFile = (index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index))
  }

  // 处理拖动开始
  const handleDragStart = (e: React.MouseEvent) => {
    setIsDragging(true)
    dragStartYRef.current = e.clientY
    dragStartHeightRef.current = inputHeight
    e.preventDefault()
  }

  // 处理拖动中
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return
      const deltaY = dragStartYRef.current - e.clientY
      const newHeight = Math.max(80, Math.min(400, dragStartHeightRef.current + deltaY))
      setInputHeight(newHeight)
    }

    const handleMouseUp = () => {
      setIsDragging(false)
    }

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = 'ns-resize'
      document.body.style.userSelect = 'none'
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isDragging])

  return (
    <aside
      data-ai-sidebar="true"
      className={`w-80 bg-white dark:bg-gray-800 border-l border-gray-200 dark:border-gray-700 flex flex-col transition-all duration-200 fixed right-0 top-14 h-[calc(100vh-3.5rem)] ${open ? 'transform translate-x-0' : 'transform translate-x-full'}`}
      style={{ zIndex: Z_INDEX.NODE_POOL_PANEL }}
    >
      {/* Header */}
      <div className="h-14 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-purple-500" />
          <span className="font-semibold text-gray-900 dark:text-white">AI 助手</span>
          {isConnected && (
            <span className="w-2 h-2 bg-green-500 rounded-full" title="已连接" />
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowConfigDialog(true)}
            className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400"
            title="AI 服务配置"
          >
            <Settings className="w-4 h-4" />
          </button>
          <button
            onClick={handleClear}
            className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400"
            title="清空对话"
          >
            <Trash2 className="w-4 h-4" />
          </button>
          <button
            onClick={() => setAiSidebarOpen(false)}
            className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* 无画布时的提示 */}
        {!canvasId && (
          <div className="flex flex-col items-center justify-center h-full text-center px-6">
            <div className="w-16 h-16 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center mb-4">
              <Sparkles className="w-8 h-8 text-gray-400 dark:text-gray-500" />
            </div>
            <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
              AI 助手
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              请先打开或创建一个画布，即可使用 AI 助手功能
            </p>
            <p className="text-xs text-gray-400 dark:text-gray-500">
              AI 助手可以帮助您生成思维导图结构、扩展节点内容、优化布局等
            </p>
          </div>
        )}
        {canvasId && messages.map((message, index) => (
          message.role === 'divider' ? (
            // 上下文分隔线
            <div key={message.id} className="flex items-center gap-2 py-2">
              <div className="flex-1 h-px bg-gradient-to-r from-transparent via-gray-400 to-transparent dark:via-gray-500" />
              <span className="text-xs text-gray-500 dark:text-gray-400 px-2">上下文已清除</span>
              <div className="flex-1 h-px bg-gradient-to-r from-transparent via-gray-400 to-transparent dark:via-gray-500" />
            </div>
          ) : (
            <div
              key={message.id}
              className={`flex gap-2 ${message.role === 'user' ? 'flex-row-reverse' : ''}`}
            >
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 overflow-hidden ${message.role === 'user'
                  ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                  : 'bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400'
                  }`}
              >
                {message.role === 'user' ? (
                  user?.avatar ? (
                    <img
                      src={user.avatar}
                      alt={user.nickname || '用户'}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <User className="w-4 h-4" />
                  )
                ) : (
                  <Bot className="w-4 h-4" />
                )}
              </div>
              <div className={`flex-1 min-w-0 flex flex-col ${message.role === 'user' ? 'items-end' : 'items-start'}`}>
                {/* 思维链展开区域 - 流式输出时自动展开 */}
                {message.role === 'assistant' && message.reasoningContent && (
                  <div className="w-full max-w-full mb-2">
                    <button
                      onClick={() => {
                        const newExpanded = new Set(expandedReasoning)
                        if (newExpanded.has(message.id)) {
                          newExpanded.delete(message.id)
                        } else {
                          newExpanded.add(message.id)
                        }
                        setExpandedReasoning(newExpanded)
                      }}
                      className="flex items-center gap-1 text-xs text-purple-600 dark:text-purple-400 hover:text-purple-700 dark:hover:text-purple-300 mb-1"
                    >
                      <Brain className="w-3 h-3" />
                      <span>
                        {isLoading && message.content === ''
                          ? '思考中...'
                          : expandedReasoning.has(message.id)
                            ? '隐藏思维链'
                            : '查看思维链'}
                      </span>
                    </button>
                    {/* 只在思考中（内容还未开始输出）时自动展开，或者用户手动展开 */}
                    {(isLoading && message.content === '' || expandedReasoning.has(message.id)) && (
                      <div className="bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-lg px-3 py-2 text-xs text-purple-800 dark:text-purple-200 whitespace-pre-wrap">
                        {message.reasoningContent}
                        {isLoading && message.content === '' && (
                          <span className="inline-block w-2 h-2 bg-purple-400 rounded-full animate-pulse ml-1" />
                        )}
                      </div>
                    )}
                  </div>
                )}
                <div
                  className={`relative group rounded-lg px-3 py-2 text-sm max-w-full break-words ${message.role === 'user'
                    ? 'bg-blue-500 text-white'
                    : message.isInterrupted
                      ? 'bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-100'
                      : 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-gray-100'
                    }`}
                >
                  {message.isInterrupted ? (
                    <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                      <span>⏹</span>
                      <span className="font-medium">回答已中断</span>
                    </div>
                  ) : isLoading && message.content === '' ? (
                    // 回复开始时显示 Loading 样式
                    <div className="flex gap-1">
                      <span className="w-2 h-2 bg-purple-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-2 h-2 bg-purple-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-2 h-2 bg-purple-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  ) : (
                    <div className="markdown-content">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        rehypePlugins={[rehypeHighlight]}
                        components={{
                          // 自定义代码块渲染
                          code({ className, children, ...props }) {
                            const match = /language-(\w+)/.exec(className || '')
                            const isInline = !match && !className
                            return isInline ? (
                              <code className="bg-gray-200 dark:bg-gray-600 px-1 py-0.5 rounded text-sm" {...props}>
                                {children}
                              </code>
                            ) : (
                              <div className="relative group/code">
                                <div className="absolute right-2 top-2 opacity-0 group-hover/code:opacity-100 transition-opacity">
                                  <span className="text-xs text-gray-400">{match?.[1] || 'code'}</span>
                                </div>
                                <pre className="bg-gray-900 text-gray-100 p-3 rounded-lg overflow-x-auto">
                                  <code className={className} {...props}>
                                    {children}
                                  </code>
                                </pre>
                              </div>
                            )
                          },
                          // 自定义段落渲染
                          p({ children }) {
                            return <p className="mb-2 last:mb-0">{children}</p>
                          },
                          // 自定义列表渲染
                          ul({ children }) {
                            return <ul className="list-disc list-inside mb-2">{children}</ul>
                          },
                          ol({ children }) {
                            return <ol className="list-decimal list-inside mb-2">{children}</ol>
                          },
                          // 自定义标题渲染
                          h1({ children }) {
                            return <h1 className="text-lg font-bold mb-2">{children}</h1>
                          },
                          h2({ children }) {
                            return <h2 className="text-base font-bold mb-2">{children}</h2>
                          },
                          h3({ children }) {
                            return <h3 className="text-sm font-bold mb-1">{children}</h3>
                          },
                          // 自定义链接渲染
                          a({ children, href }) {
                            return (
                              <a
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-500 hover:text-blue-600 underline"
                              >
                                {children}
                              </a>
                            )
                          },
                          // 自定义表格渲染
                          table({ children }) {
                            return (
                              <div className="overflow-x-auto mb-2">
                                <table className="border-collapse border border-gray-300 dark:border-gray-600">
                                  {children}
                                </table>
                              </div>
                            )
                          },
                          thead({ children }) {
                            return <thead className="bg-gray-100 dark:bg-gray-700">{children}</thead>
                          },
                          th({ children }) {
                            return (
                              <th className="border border-gray-300 dark:border-gray-600 px-2 py-1 text-left">
                                {children}
                              </th>
                            )
                          },
                          td({ children }) {
                            return (
                              <td className="border border-gray-300 dark:border-gray-600 px-2 py-1">
                                {children}
                              </td>
                            )
                          },
                          // 自定义引用块渲染
                          blockquote({ children }) {
                            return (
                              <blockquote className="border-l-4 border-gray-300 dark:border-gray-600 pl-3 italic mb-2">
                                {children}
                              </blockquote>
                            )
                          },
                          // 自定义水平线渲染
                          hr() {
                            return <hr className="my-2 border-gray-300 dark:border-gray-600" />
                          },
                        }}
                      >
                        {message.content}
                      </ReactMarkdown>
                    </div>
                  )}
                  {/* 显示图片附件 */}
                  {message.attachments && message.attachments.some(a => a.type === 'image') && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {message.attachments.filter(a => a.type === 'image').map((img) => (
                        <div key={img.id} className="relative group/image">
                          <img
                            src={img.url}
                            alt={img.name}
                            className="max-w-[200px] max-h-[150px] rounded-lg border border-gray-200 dark:border-gray-600 object-cover"
                          />
                          <div className="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-xs px-2 py-1 rounded-b-lg opacity-0 group-hover/image:opacity-100 transition-opacity truncate">
                            {img.name}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {/* 显示文件附件 */}
                  {message.attachments && message.attachments.some(a => a.type === 'file') && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {message.attachments.filter(a => a.type === 'file').map((file) => (
                        <div
                          key={file.id}
                          className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-700 rounded-lg border border-gray-200 dark:border-gray-600"
                        >
                          <FileText className="w-4 h-4 text-gray-500" />
                          <span className="text-sm text-gray-700 dark:text-gray-300 max-w-[150px] truncate">
                            {file.name}
                          </span>
                          <span className="text-xs text-gray-400">
                            ({(file.size / 1024).toFixed(1)} KB)
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {message.role === 'assistant' && (
                    <div className="absolute -right-2 -top-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => handleRegenerate(index)}
                        disabled={isLoading}
                        className="p-1 rounded-full bg-white dark:bg-gray-600 shadow-sm border border-gray-200 dark:border-gray-500 hover:bg-gray-50 dark:hover:bg-gray-500 disabled:opacity-50"
                        title="重新回答"
                      >
                        <RefreshCw className={`w-3 h-3 text-gray-500 dark:text-gray-400 ${isLoading ? 'animate-spin' : ''}`} />
                      </button>
                      <button
                        onClick={() => handleCopy(message.content, message.id)}
                        className="p-1 rounded-full bg-white dark:bg-gray-600 shadow-sm border border-gray-200 dark:border-gray-500 hover:bg-gray-50 dark:hover:bg-gray-500"
                        title="复制内容"
                      >
                        {copiedId === message.id ? (
                          <Check className="w-3 h-3 text-green-500" />
                        ) : (
                          <Copy className="w-3 h-3 text-gray-500 dark:text-gray-400" />
                        )}
                      </button>
                    </div>
                  )}
                </div>
                <span className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                  {new Date(message.timestamp).toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>
            </div>
          )
        ))}
        {/* 只在还没有助手消息占位符时显示加载动画 */}
        {canvasId && isLoading && !messages.some(m => m.role === 'assistant' && m.id !== 'welcome' && !m.isInterrupted) && (
          <div className="flex gap-2">
            <div className="w-8 h-8 rounded-full bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center">
              <Bot className="w-4 h-4 text-purple-600 dark:text-purple-400" />
            </div>
            <div className="bg-gray-100 dark:bg-gray-700 rounded-lg px-3 py-2">
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-purple-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-2 h-2 bg-purple-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-2 h-2 bg-purple-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* 附件列表 - 移到滑动手柄上方 */}
      {canvasId && attachedFiles.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 pt-3 pb-2 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          {attachedFiles.map((file, index) => (
            <div
              key={file.id}
              className={`flex items-center gap-1 px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded-md text-xs text-gray-700 dark:text-gray-300 ${file.type === 'image' ? 'max-w-[120px]' : 'max-w-[calc(50%-0.25rem)]'}`}
            >
              {file.type === 'image' ? (
                <>
                  {file.url ? (
                    <img
                      src={file.url}
                      alt={file.name}
                      className="w-6 h-6 rounded object-cover flex-shrink-0"
                    />
                  ) : (
                    <ImageIcon className="w-3 h-3 flex-shrink-0" />
                  )}
                  <span className="truncate">{file.name}</span>
                </>
              ) : (
                <>
                  <FileText className="w-3 h-3 flex-shrink-0" />
                  <span className="truncate">{file.name}</span>
                </>
              )}
              <button
                onClick={() => handleRemoveFile(index)}
                className="ml-1 p-0.5 hover:bg-gray-200 dark:hover:bg-gray-600 rounded flex-shrink-0"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 拖动分隔条 */}
      <div
        onMouseDown={handleDragStart}
        className={`h-1 bg-gray-200 dark:bg-gray-700 hover:bg-purple-400 dark:hover:bg-purple-600 transition-colors cursor-ns-resize flex items-center justify-center ${isDragging ? 'bg-purple-400 dark:bg-purple-600' : ''}`}
        title="拖动调整输入区域高度"
      >
        <div className="w-8 h-0.5 bg-gray-400 dark:bg-gray-500 rounded-full" />
      </div>

      {/* Input */}
      <div
        className="border-t border-gray-200 dark:border-gray-700 flex flex-col"
        style={{ height: `${inputHeight}px`, minHeight: '120px' }}
      >
        {/* 无画布时的禁用遮罩 */}
        {!canvasId && (
          <div className="flex-1 flex flex-col items-center justify-center px-6 py-4">
            <p className="text-sm text-gray-400 dark:text-gray-500 text-center">
              打开画布后即可使用 AI 对话功能
            </p>
          </div>
        )}

        {canvasId && (
          <>
            {/* 输入框区域 - flex-1 占据剩余空间 */}
            <div className="relative flex-1 px-4 py-2 min-h-0">
              {/* + 按钮 */}
              <div className="absolute left-6 bottom-4 z-10" ref={attachMenuRef}>
                <button
                  onClick={() => setShowAttachMenu(!showAttachMenu)}
                  disabled={isLoading}
                  className={`p-1.5 rounded-lg transition-colors ${isLoading
                    ? 'text-gray-300 cursor-not-allowed'
                    : 'text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
                    }`}
                >
                  <Plus className="w-4 h-4" />
                </button>

                {/* 附件菜单 */}
                {showAttachMenu && (
                  <div className="absolute bottom-full left-0 mb-1 w-32 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-50">
                    <button
                      onClick={handleAddFile}
                      className="w-full px-3 py-2 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
                    >
                      <FileText className="w-4 h-4" />
                      添加文件
                    </button>
                    <button
                      onClick={handleAddImage}
                      className="w-full px-3 py-2 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2"
                    >
                      <ImageIcon className="w-4 h-4" />
                      添加图片
                    </button>
                  </div>
                )}
              </div>

              {/* 清除上下文按钮 */}
              <button
                onClick={handleClearContext}
                disabled={isLoading || messages.length <= 1}
                className="absolute left-12 bottom-4 p-1.5 rounded-lg transition-colors z-10 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
                title="清除上下文"
              >
                <Eraser className="w-4 h-4" />
              </button>

              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="输入消息..."
                className="w-full h-full px-10 py-2 bg-gray-100 dark:bg-gray-700 border-0 rounded-lg resize-none text-sm text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:ring-2 focus:ring-purple-500 focus:outline-none"
                disabled={isLoading}
              />
              {isLoading ? (
                // 中断按钮
                <button
                  onClick={() => {
                    abortCurrentRequest()
                    setIsLoading(false)
                  }}
                  className="absolute right-6 bottom-4 p-1.5 rounded-lg transition-colors z-10 bg-red-500 text-white hover:bg-red-600"
                  title="中断回答"
                >
                  <Square className="w-4 h-4" />
                </button>
              ) : (
                // 发送按钮
                <button
                  onClick={handleSend}
                  disabled={!input.trim() && attachedFiles.length === 0}
                  className={`absolute right-6 bottom-4 p-1.5 rounded-lg transition-colors z-10 ${(input.trim() || attachedFiles.length > 0)
                    ? 'bg-purple-500 text-white hover:bg-purple-600'
                    : 'bg-gray-300 dark:bg-gray-600 text-gray-500 cursor-not-allowed'
                    }`}
                >
                  <Send className="w-4 h-4" />
                </button>
              )}
            </div>
          </>
        )}

        {/* 隐藏的文件输入 */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.md,.json,.xml,.csv,.tsv,.yaml,.yml,.ini,.conf,.config,.log,.properties,.env,.sql,.html,.htm,.css,.js,.jsx,.ts,.tsx,.vue,.py,.java,.c,.cpp,.h,.hpp,.cs,.go,.rs,.rb,.php,.swift,.kt,.scala,.r,.m,.mm,.sh,.bash,.zsh,.ps1,.bat,.cmd,.dart,.lua,.pl,.pm,.groovy,.gradle,.dockerfile,.gitignore,.editorconfig"
          multiple
          onChange={handleFileSelect}
          className="hidden"
        />
        <input
          ref={imageInputRef}
          type="file"
          accept="image/png,image/jpeg,image/jpg,image/gif,image/webp,image/svg+xml,image/bmp,image/tiff"
          multiple
          onChange={handleFileSelect}
          className="hidden"
        />

        {/* 提示文字 - 固定在底部 */}
        <p className="text-xs text-gray-400 dark:text-gray-500 px-4 pb-3 pt-1 text-center shrink-0">
          AI 生成的内容仅供参考，请自行验证准确性
        </p>
      </div>

      {/* AI 配置对话框 */}
      <AIConfigDialog
        open={showConfigDialog}
        onClose={() => setShowConfigDialog(false)}
      />
    </aside>
  )
}
