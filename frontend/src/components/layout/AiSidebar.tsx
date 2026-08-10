import { useState, useRef, useEffect, useCallback, memo } from 'react'
import { Send, X, Sparkles, User, Bot, Trash2, Copy, Check, Plus, FileText, Image as ImageIcon, Settings, RefreshCw, Brain, Square, Eraser } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github-dark.css'
import { useUIStore } from '@/store/useUIStore'
import { useAIStore } from '@/store/useAIStore'
import { useAuthStore } from '@/store/useAuthStore'
import type { User as UserType } from '@/types'
import { AIConfigDialog } from '@/components/ai/AIConfigDialog'
import { sendStreamChatMessage, abortCurrentRequest, type StreamCallbacks, AI_PROVIDERS, validateApiKey } from '@/services/aiService'
import { getAIConversation, saveAIConversation, deleteAIConversation } from '@/services/api'
import { Z_INDEX, DEFAULT_SYSTEM_PROMPT } from '@/constants'
import { useCanvasStore } from '@/store/useCanvasStore'
import {
  buildMessageHistory,
  buildUserMessage,
  sanitizeMessagesForSave,
  trimMessageHistory,
  type Message,
  type Attachment,
} from '@/utils/aiChat'

interface AiSidebarProps {
  open: boolean
}

interface MessageItemProps {
  message: Message
  index: number
  isLoading: boolean
  copiedId: string | null
  expandedReasoning: Set<string>
  user: UserType | null
  onRegenerate: (index: number) => void
  onCopy: (content: string, id: string) => void
  onToggleReasoning: (id: string) => void
}

/**
 * D11: 单条消息渲染组件。React.memo 保证流式输出时（每 chunk 全量
 * setMessages）只有内容变化的那个消息项重渲染，其余消息项 props 引用
 * 不变直接跳过，避免整个消息列表每 chunk 全量重渲染。
 */
const MessageItem = memo(function MessageItem({
  message,
  index,
  isLoading,
  copiedId,
  expandedReasoning,
  user,
  onRegenerate,
  onCopy,
  onToggleReasoning,
}: MessageItemProps) {
  if (message.role === 'divider') {
    // 上下文分隔线
    return (
      <div className="flex items-center gap-2 py-2">
        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-gray-400 to-transparent dark:via-gray-500" />
        <span className="text-xs text-gray-500 dark:text-gray-400 px-2">上下文已清除</span>
        <div className="flex-1 h-px bg-gradient-to-r from-transparent via-gray-400 to-transparent dark:via-gray-500" />
      </div>
    )
  }

  return (
    <div
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
              onClick={() => onToggleReasoning(message.id)}
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
              {message.attachments.filter(a => a.type === 'image').map((img) => {
                // blob URL 刷新后失效，且保存时已剥离 base64 data，此时显示占位而非裂图
                const imageSrc = img.data
                  ? `data:${img.mimeType};base64,${img.data}`
                  : img.url
                return (
                  <div key={img.id} className="relative group/image">
                    {imageSrc ? (
                      <>
                        <img
                          src={imageSrc}
                          alt={img.name}
                          className="max-w-[200px] max-h-[150px] rounded-lg border border-gray-200 dark:border-gray-600 object-cover"
                        />
                        <div className="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-xs px-2 py-1 rounded-b-lg opacity-0 group-hover/image:opacity-100 transition-opacity truncate">
                          {img.name}
                        </div>
                      </>
                    ) : (
                      <div className="max-w-[200px] px-3 py-4 rounded-lg border border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-xs text-gray-400 dark:text-gray-500 flex flex-col items-center gap-1">
                        <ImageIcon className="w-4 h-4" />
                        <span className="truncate max-w-full">{img.name}</span>
                        <span>图片已过期（会话恢复后不再可用）</span>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          {/* 显示文件附件 */}
          {message.attachments && message.attachments.some(a => a.type === 'file') && (
            <div className="mt-2 flex flex-wrap gap-2">
              {message.attachments.filter(a => a.type === 'file').map((file) => (
                <div
                  key={file.id}
                  className="flex items-center gap-2 px-3 py-2 bg-gray-100 dark:bg-gray-700 rounded-lg border border-gray-200 dark:border-gray-600"
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
                onClick={() => onRegenerate(index)}
                disabled={isLoading}
                className="p-1 rounded-full bg-white dark:bg-gray-600 shadow-sm border border-gray-200 dark:border-gray-500 hover:bg-gray-50 dark:hover:bg-gray-500 disabled:opacity-50"
                title="重新回答"
              >
                <RefreshCw className={`w-3 h-3 text-gray-500 dark:text-gray-400 ${isLoading ? 'animate-spin' : ''}`} />
              </button>
              <button
                onClick={() => onCopy(message.content, message.id)}
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
})

export function AiSidebar({ open }: AiSidebarProps) {
  const { setAiSidebarOpen } = useUIStore()
  const { currentProvider, isConnected, getProviderConfig } = useAIStore()
  const { user } = useAuthStore()
  const config = getProviderConfig(currentProvider)
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: isConnected
        ? '你好！我是你的 AI 思维导图助手。我可以帮你：\n\n• 生成思维导图结构\n• 扩展节点内容\n• 优化布局建议\n• 回答相关问题\n\n请告诉我你想创建什么样的思维导图？'
        : '欢迎使用 AI 思维导图助手！\n\n⚠️ 尚未配置 AI 服务\n\n请点击右上角的设置按钮，配置您的 AI 服务提供商和 API 密钥。\n\n支持的提供商：\n• DeepSeek (DeepSeek 系列)\n• OpenCode Go (聚合网关)\n• OpenCode Zen (聚合网关)\n• 自定义 OpenAI 兼容 API',
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

  // N1: 创建欢迎占位消息。切画布时用同一对象同时重置 state 与 ref，
  // 保证两者一致（占位带完整欢迎文案：若用户发消息后防抖保存触发，
  // 占位随消息写入服务端，下次加载显示欢迎语而非空气泡）。
  const createWelcomePlaceholder = (): Message => ({
    id: 'welcome',
    role: 'assistant',
    content: isConnected
      ? '你好！我是你的 AI 思维导图助手。我可以帮你：\n\n• 生成思维导图结构\n• 扩展节点内容\n• 优化布局建议\n• 回答相关问题\n\n请告诉我你想创建什么样的思维导图？'
      : '欢迎使用 AI 思维导图助手！\n\n⚠️ 尚未配置 AI 服务\n\n请点击右上角的设置按钮，配置您的 AI 服务提供商和 API 密钥。\n\n支持的提供商：\n• DeepSeek (DeepSeek 系列)\n• OpenCode Go (聚合网关)\n• OpenCode Zen (聚合网关)\n• 自定义 OpenAI 兼容 API',
    timestamp: Date.now(),
  })

  // 自动滚动到底部（流式输出时用 auto 避免 smooth 动画叠加抖动）
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' })
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

  // 自动验证服务端密钥配置状态（侧边栏每次打开时执行）
  useEffect(() => {
    const autoValidateConnection = async () => {
      const { currentProvider: cp, getProviderConfig: getCfg } = useAIStore.getState()
      const provider = AI_PROVIDERS.find((p) => p.id === cp)
      if (!provider) return

      const cfg = getCfg(cp)
      const hasBaseUrl = cfg.baseUrl || provider.baseUrl

      // 始终尝试验证（密钥存储在服务端），避免连接状态卡死无法自愈
      if (hasBaseUrl) {
        try {
          const isValid = await validateApiKey(provider, '', cfg.baseUrl || undefined)
          if (isValid) {
            useAIStore.getState().setIsConnected(true)
            return
          }
        } catch {
          // 验证失败，继续走未连接逻辑
        }
      }
      useAIStore.getState().setIsConnected(false)
    }

    autoValidateConnection()
  }, [open]) // 每次打开侧边栏时重新验证

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

    // C2: 修复并发加载竞态——不再用 isLoadingConversationRef 全局早退
    // （画布 A 加载在途时切到画布 B 会导致 B 永不加载），改用取消标志 +
    // canvasIdRef 归属校验：await 返回后若已切画布则丢弃结果，防止旧画布
    // 的对话覆写新画布。
    const requestedCanvasId = canvasId
    let cancelled = false
    isLoadingConversationRef.current = true
    lastCanvasIdRef.current = canvasId

    const loadConversation = async () => {
      try {
        const data = await getAIConversation(requestedCanvasId)
        if (cancelled || canvasIdRef.current !== requestedCanvasId) return
        // N2: 加载返回时若用户已发消息（handleSend 同步更新 messagesRef），
        // 丢弃加载结果，避免覆盖用户刚发送的消息。catch 分支的函数式更新
        // 天然只替换 welcome 占位，同样不会覆盖用户消息。
        if (messagesRef.current.some((m) => m.role === 'user')) return
        const { messages: savedMessages, contextDividerIndex: savedIndex } = data
        if (savedMessages && savedMessages.length > 0) {
          setMessages(savedMessages as Message[])
          // 校验 divider index 在有效范围内
          const dividerIndex = savedIndex ?? -1
          setContextDividerIndex(
            dividerIndex >= 0 && dividerIndex < savedMessages.length ? dividerIndex : -1
          )
        } else {
          // 如果没有保存的对话，显示欢迎消息
          setMessages([
            {
              id: 'welcome',
              role: 'assistant',
              content: isConnected
                ? '你好！我是你的 AI 思维导图助手。我可以帮你：\n\n• 生成思维导图结构\n• 扩展节点内容\n• 优化布局建议\n• 回答相关问题\n\n请告诉我你想创建什么样的思维导图？'
                : '欢迎使用 AI 思维导图助手！\n\n⚠️ 尚未配置 AI 服务\n\n请点击右上角的设置按钮，配置您的 AI 服务提供商和 API 密钥。\n\n支持的提供商：\n• DeepSeek (DeepSeek 系列)\n• OpenCode Go (聚合网关)\n• OpenCode Zen (聚合网关)\n• 自定义 OpenAI 兼容 API',
              timestamp: Date.now(),
            },
          ])
          setContextDividerIndex(-1)
        }
      } catch {
        // 加载失败时显示恢复错误提示（已切画布则丢弃）
        if (cancelled || canvasIdRef.current !== requestedCanvasId) return
        setMessages((prev) =>
          prev.length === 1 && prev[0]?.id === 'welcome'
            ? [{ id: 'welcome', role: 'assistant', content: '⚠️ 对话历史加载失败，将使用全新对话。你可以继续与 AI 交流。', timestamp: Date.now() }]
            : prev
        )
      } finally {
        if (!cancelled) {
          isLoadingConversationRef.current = false
        }
      }
    }

    loadConversation()

    return () => {
      cancelled = true
    }
    // 只依赖 canvasId：isConnected 变化不重新加载（避免打断在途加载或重复请求），
    // 欢迎文案中的 isConnected 为加载时刻的快照，可接受。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasId])

  // 保存对话历史到服务器
  // 修复：流式输出期间 messages 高频变化，不能再把"卸载 flush"挂在与 messages 同依赖的 effect cleanup 上，
  // 否则每个流式 chunk 都会触发一次全量保存（限流 + DB 写放大）。
  // 方案：dirty 标记 + 防抖保存；仅在组件卸载/画布切换时显式 flush。
  const messagesRef = useRef(messages)
  const contextDividerIndexRef = useRef(contextDividerIndex)
  const canvasIdRef = useRef(canvasId)
  const dirtyRef = useRef(false)
  // 画布切换中断标记：中断时只标记 interrupted，不写错误文案
  const abortOnSwitchRef = useRef(false)

  // D9: revoke blob URL 帮助函数（blob URL 不 revoke 会持续占用内存）
  const revokeAttachmentUrl = (attachment: Attachment) => {
    if (attachment.url && attachment.url.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(attachment.url)
      } catch {
        // ignore
      }
    }
  }
  const attachedFilesRef = useRef(attachedFiles)
  useEffect(() => {
    attachedFilesRef.current = attachedFiles
  }, [attachedFiles])
  // 组件卸载时 revoke 所有未发送附件的 blob URL
  useEffect(() => {
    return () => {
      attachedFilesRef.current.forEach(revokeAttachmentUrl)
    }
  }, [])

  // 更新 ref 值
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    contextDividerIndexRef.current = contextDividerIndex
  }, [contextDividerIndex])

  useEffect(() => {
    canvasIdRef.current = canvasId
    // C2/D1: 画布切换时立即把消息引用重置为欢迎占位。此时旧的 flush cleanup
    // 已把旧画布的脏数据保存完毕（cleanup 先于本 effect 执行且读到的是旧
    // canvasIdRef/messagesRef），后续 1.5s 防抖保存将基于欢迎占位（无保存
    // 价值），避免旧画布消息覆写新画布的服务端对话记录。真正的消息由
    // loadConversation 异步填充后经 messagesRef 同步 effect 更新。
    // N1: 同时 setMessages([welcome 占位]) 让 state 与 ref 一致——否则
    // 加载失败/无对话时新画布会持续显示旧画布对话，且用户发消息后防抖
    // 保存会把旧画布对话串写到新画布。
    if (canvasId !== null) {
      const placeholder = createWelcomePlaceholder()
      messagesRef.current = [placeholder]
      contextDividerIndexRef.current = -1
      setMessages([placeholder])
    }
  }, [canvasId])

  // 判断是否有值得保存的内容（跳过只有欢迎消息/空占位的状态）
  const hasSaveableContent = (msgs: Message[]): boolean => {
    if (msgs.length <= 1 && msgs[0]?.id === 'welcome') return false
    // 丢弃中断且无内容的空占位（画布切换/中断产生的半成品）
    return !msgs.some(
      (m) => m.role === 'assistant' && m.isInterrupted && !m.content.trim()
    )
  }

  const persistConversation = async () => {
    const currentCanvasId = canvasIdRef.current
    if (!currentCanvasId) return
    const currentMessages = sanitizeMessagesForSave(messagesRef.current)
    if (!hasSaveableContent(currentMessages)) return
    try {
      await saveAIConversation(currentCanvasId, {
        messages: currentMessages,
        contextDividerIndex: contextDividerIndexRef.current,
      })
    } catch {
      // 保存失败，标记为脏以便下次重试
      dirtyRef.current = true
    }
  }

  // 防抖保存：messages 变更后 1.5s 无新变更才保存
  useEffect(() => {
    if (!canvasId) return
    dirtyRef.current = true
    const timeoutId = setTimeout(async () => {
      dirtyRef.current = false
      await persistConversation()
    }, 1500)

    return () => clearTimeout(timeoutId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasId, messages, contextDividerIndex])

  // 画布切换/组件卸载时：中断进行中的请求 + flush 待保存内容
  useEffect(() => {
    if (!canvasId) return
    return () => {
      abortOnSwitchRef.current = true
      abortCurrentRequest()
      if (dirtyRef.current) {
        dirtyRef.current = false
        persistConversation()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasId])

  // 创建流式输出回调（handleSend / handleRegenerate 共用）
  const createStreamCallbacks = (assistantMessageId: string, showEmptyHint: boolean): StreamCallbacks => {
    // C2: 绑定回调创建时的画布。回调执行时若用户已切换画布则整体丢弃——
    // 否则旧画布被中断的流式 chunk 会写入新画布的消息列表，进而被防抖
    // 保存成新画布的对话记录（跨画布串写）。
    const streamCanvasId = canvasIdRef.current
    const isCurrentCanvas = () => canvasIdRef.current === streamCanvasId
    return {
      onReasoningChunk: (chunk) => {
        if (!isCurrentCanvas()) return
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMessageId
              ? { ...m, reasoningContent: (m.reasoningContent || '') + chunk }
              : m
          )
        )
      },
      onContentChunk: (chunk) => {
        if (!isCurrentCanvas()) return
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMessageId
              ? { ...m, content: m.content + chunk }
              : m
          )
        )
      },
      onToolCall: () => {
        if (!isCurrentCanvas()) return
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMessageId
              ? { ...m, hasToolCalls: true }
              : m
          )
        )
      },
      onToolExchange: (exchangeMessages) => {
        if (!isCurrentCanvas()) return
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMessageId
              ? { ...m, toolExchangeMessages: [...(m.toolExchangeMessages || []), ...exchangeMessages] }
              : m
          )
        )
      },
      onComplete: () => {
        if (!isCurrentCanvas()) return
        setIsLoading(false)
        // 如果内容为空，显示提示信息
        if (showEmptyHint) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessageId && m.content === '' && !m.isInterrupted
                ? { ...m, content: '（AI 未返回内容）' }
                : m
            )
          )
        }
      },
      onError: (error) => {
        if (!isCurrentCanvas()) {
          // 已切画布：仅确保 loading 复位，不写任何消息
          setIsLoading(false)
          return
        }
        setIsLoading(false)
        if (abortOnSwitchRef.current) {
          // 画布切换导致的中断：只标记中断，不写错误文案
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessageId
                ? { ...m, isInterrupted: true }
                : m
            )
          )
          return
        }
        if (error.message === '请求已中断' || error.message === '请求超时' || error.message === '连接超时，请检查网络或服务端状态') {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessageId
                ? {
                    ...m,
                    content: m.content + (error.message.startsWith('连接超时') ? '\n\n⏳ 连接超时' : (error.message === '请求超时' ? '\n\n⏳ 请求超时' : '\n\n⏹️ 回答已中断')),
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
  }

  // 发送 AI 请求（handleSend / handleRegenerate 共用）
  // D11: useCallback 保持引用稳定（config 为 store 内稳定对象），
  // 使 MessageItem 的 memo 比较在流式 chunk 期间不被回调变化破坏。
  const runAssistantTurn = useCallback(async (
    messageHistory: Array<Record<string, unknown>>,
    currentUserMessage: Record<string, unknown>
  ) => {
    const assistantMessageId = crypto.randomUUID()
    const assistantMessage: Message = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      reasoningContent: '',
    }
    // N4: ref 与 state 同步追加，保证 ref 始终反映最新消息列表
    messagesRef.current = [...messagesRef.current, assistantMessage]
    setMessages((prev) => [...prev, assistantMessage])

    // 配置未就绪：错误写入占位符，提示用户配置
    if (!isConnected || !config.model) {
      setIsLoading(false)
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMessageId
            ? { ...m, content: '❌ 请求失败：请先配置 AI 服务\n\n请点击右上角设置按钮，配置 AI 服务提供商并测试连接' }
            : m
        )
      )
      return
    }

    // 上下文裁剪：输入侧预算固定 32K（防止长对话请求体超限；与输出长度限制无关）
    const budget = 32000
    const trimmedHistory = trimMessageHistory(messageHistory, budget)

    const systemMessage = {
      role: 'system',
      content: DEFAULT_SYSTEM_PROMPT,
    }

    try {
      await sendStreamChatMessage(
        currentProvider,
        { ...config, provider: currentProvider },
        [systemMessage, ...trimmedHistory, currentUserMessage],
        createStreamCallbacks(assistantMessageId, true)
      )
    } catch (error) {
      // 流式请求本身抛出的错误（如未知提供商）写入占位符
      setIsLoading(false)
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMessageId
            ? { ...m, content: `❌ 请求失败：${errorMessage}\n\n请检查：\n1. AI 服务配置是否正确\n2. API 密钥是否有效\n3. 网络连接是否正常` }
            : m
        )
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProvider, config, isConnected])

  const handleSend = async () => {
    if ((!input.trim() && attachedFiles.length === 0) || isLoading) return

    abortOnSwitchRef.current = false

    // 构建消息内容（仅用户输入，文件内容在后台传递给AI）
    const content = input.trim()

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: content,
      timestamp: Date.now(),
      attachments: attachedFiles.length > 0 ? [...attachedFiles] : undefined,
    }

    setMessages((prev) => [...prev, userMessage])
    setInput('')
    // D9: 附件进入消息后 revoke 其 blob URL（渲染优先使用 base64 data）
    attachedFiles.forEach(revokeAttachmentUrl)
    setAttachedFiles([])
    setIsLoading(true)

    // 构建消息历史（只包含分隔线以下的消息）
    // DeepSeek 思考模式要求：
    // - 工具调用产生的中间 assistant+tool 消息必须完整回传（见 buildMessageHistory）
    // N4: 统一从 messagesRef 读取最新消息，不依赖渲染闭包快照（此时 ref 尚未
    // 包含新 userMessage，新消息由 currentUserMessage 单独传给 API，避免重复）
    const startIndex = contextDividerIndexRef.current >= 0 ? contextDividerIndexRef.current : 0
    const messageHistory = buildMessageHistory(messagesRef.current, startIndex)
    const currentUserMessage = buildUserMessage(content, attachedFiles)

    // N2/N4: 同步更新 messagesRef，保证 loadConversation 返回时能检测到
    // 用户新消息（丢弃加载结果），且后续 handleSend/handleRegenerate 构建
    // 历史都基于最新消息。
    messagesRef.current = [...messagesRef.current, userMessage]

    await runAssistantTurn(messageHistory, currentUserMessage)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  // D11: 稳定回调（memo 组件 prop 引用不变才能跳过重渲染）
  const handleCopy = useCallback(async (content: string, id: string) => {
    if (!navigator.clipboard) return
    try {
      await navigator.clipboard.writeText(content)
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 2000)
    } catch {
      // Copy failed, ignore
    }
  }, [])

  const handleToggleReasoning = useCallback((id: string) => {
    setExpandedReasoning((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  // 重新回答功能
  const handleRegenerate = useCallback(async (messageIndex: number) => {
    // 使用 ref 读取最新消息，保证回调稳定（不依赖每次渲染的 messages）
    const currentMessages = messagesRef.current

    // 找到当前 AI 回复对应的用户消息
    let userMessageIndex = messageIndex - 1
    while (userMessageIndex >= 0 && currentMessages[userMessageIndex].role !== 'user') {
      userMessageIndex--
    }

    if (userMessageIndex < 0) return

    const userMessage = currentMessages[userMessageIndex]

    abortOnSwitchRef.current = false

    // 删除当前 AI 回复及之后的所有消息（ref 与 state 同步，保持消息源一致）
    messagesRef.current = messagesRef.current.slice(0, messageIndex)
    setMessages((prev) => prev.slice(0, messageIndex))
    setIsLoading(true)

    // 构建消息历史（不包括被删除的消息，且只包含分隔线以下的消息）
    const startIndex = contextDividerIndexRef.current >= 0 ? contextDividerIndexRef.current : 0
    const messageHistory = buildMessageHistory(
      currentMessages.slice(0, userMessageIndex),
      startIndex
    )
    const currentUserMessage = buildUserMessage(userMessage.content, userMessage.attachments)

    await runAssistantTurn(messageHistory, currentUserMessage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runAssistantTurn])

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
      // D9: 清空对话时 revoke 未发送附件的 blob URL
      attachedFilesRef.current.forEach(revokeAttachmentUrl)
      setAttachedFiles([])
      setContextDividerIndex(-1)

      // 删除服务器上的对话记录
      if (canvasId) {
        try {
          await deleteAIConversation(canvasId)
        } catch {
          // Failed to delete conversation, ignore
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

    // 处理每个文件（最大 10MB）
    const MAX_FILE_SIZE = 10 * 1024 * 1024
    // D10: 超限文件不再静默跳过，收集后统一提示用户
    const skippedNames: string[] = []
    for (const file of newFiles) {
      if (file.size > MAX_FILE_SIZE) {
        skippedNames.push(file.name)
        continue
      }
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
        } catch {
          continue
        }
      } else if (isTextFile(file)) {
        // 文本文件，读取内容
        try {
          const content = await readTextFile(file)
          attachment.data = content
        } catch {
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

    // D10: 提示被跳过的超大文件
    if (skippedNames.length > 0) {
      useUIStore.getState().addWarningToast(
        `以下文件超过 10MB 已跳过：${skippedNames.join('、')}`,
        '文件过大'
      )
    }

    // 重置 input 值，允许再次选择相同文件
    e.target.value = ''
  }

  // 移除附件
  const handleRemoveFile = (index: number) => {
    setAttachedFiles((prev) => {
      const removed = prev[index]
      if (removed) {
        // D9: 移除附件时 revoke 其 blob URL
        revokeAttachmentUrl(removed)
      }
      return prev.filter((_, i) => i !== index)
    })
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
            aria-label="关闭 AI 侧边栏"
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
          <MessageItem
            key={message.id}
            message={message}
            index={index}
            isLoading={isLoading}
            copiedId={copiedId}
            expandedReasoning={expandedReasoning}
            user={user}
            onRegenerate={handleRegenerate}
            onCopy={handleCopy}
            onToggleReasoning={handleToggleReasoning}
          />
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
                  aria-label="添加附件"
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
                aria-label="AI 对话输入"
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
                  aria-label="发送消息"
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
