// AI Proxy Controller
// 服务端代理 AI 提供商请求：密钥加密存储在服务端，浏览器不再接触 API 密钥
// - POST /providers   保存/更新提供商密钥（AES-256-GCM 加密）
// - GET  /providers   查询已配置的提供商（不返回明文密钥）
// - DELETE /providers/:providerId  删除密钥
// - POST /models      代理获取模型列表
// - POST /chat        SSE 流式代理聊天请求（Ollama NDJSON 统一转换为 OpenAI SSE 格式）

import { Router } from 'express'
import type { Response as ExpressResponse } from 'express'
import { db } from '../database/connection.js'
import { aiProviderKeys } from '../database/schema.js'
import { eq, and } from 'drizzle-orm'
import { authenticate, type AuthRequest } from '../middleware/auth.middleware.js'
import { asyncHandler } from '../middleware/error.middleware.js'
import { encryptApiKey, decryptApiKey } from '../utils/aiCrypto.js'
import { logError } from '../utils/logger.js'

// 提供商元信息（仅代理所需的最小信息）
const PROVIDER_META: Record<string, { defaultBaseUrl: string; apiKeyRequired: boolean }> = {
  moonshot: { defaultBaseUrl: 'https://api.moonshot.cn/v1', apiKeyRequired: true },
  deepseek: { defaultBaseUrl: 'https://api.deepseek.com', apiKeyRequired: true },
  zhipu: { defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKeyRequired: true },
  gemini: { defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKeyRequired: true },
  ollama: { defaultBaseUrl: 'http://localhost:11434', apiKeyRequired: false },
  custom: { defaultBaseUrl: '', apiKeyRequired: true },
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1']

function getProviderMeta(providerId: string) {
  return PROVIDER_META[providerId] || null
}

// 解析并校验 base URL
// - 仅允许 http/https
// - http 只能指向本机地址（localhost/127.0.0.1/::1），防止 SSRF 到内网
// - https 允许任意地址
function resolveBaseUrl(
  requestBaseUrl: string | undefined,
  storedBaseUrl: string | undefined,
  meta: { defaultBaseUrl: string }
): string | null {
  const raw = (requestBaseUrl?.trim() || storedBaseUrl?.trim() || meta.defaultBaseUrl).replace(/\/+$/, '')
  if (!raw) return null

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null
  }
  // Node 的 URL.hostname 对 IPv6 返回带括号的 "[::1]"，需去除括号后再比对
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
  if (parsed.protocol === 'http:' && !LOCAL_HOSTS.includes(hostname)) {
    return null
  }
  return raw
}

// 校验代理请求的路径（必须以 / 开头，仅允许安全字符）
function isValidUrlPath(urlPath: unknown): urlPath is string {
  return typeof urlPath === 'string' && urlPath.startsWith('/') && !/\s/.test(urlPath) && !urlPath.includes('..')
}

async function getProviderKey(userId: number, providerId: string) {
  return db.query.aiProviderKeys.findFirst({
    where: and(
      eq(aiProviderKeys.userId, userId),
      eq(aiProviderKeys.providerId, providerId)
    ),
  })
}

function buildUpstreamHeaders(providerId: string, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) {
    if (providerId === 'gemini') {
      headers['x-goog-api-key'] = apiKey
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`
    }
  }
  return headers
}

// 将 Ollama 的 NDJSON 流转换为 OpenAI 兼容的 SSE 格式
async function pipeOllamaStream(
  body: ReadableStream<Uint8Array>,
  res: ExpressResponse
) {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as {
          error?: unknown
          done?: boolean
          message?: {
            content?: string
            reasoning_content?: string
            tool_calls?: Array<{
              id?: string
              function?: { name?: string; arguments?: unknown }
            }>
          }
        }

        if (parsed.error) {
          res.write(`data: ${JSON.stringify({ error: parsed.error })}\n\n`)
          continue
        }

        const delta: Record<string, unknown> = {}
        if (parsed.message?.reasoning_content) {
          delta.reasoning_content = parsed.message.reasoning_content
        }
        if (parsed.message?.content) {
          delta.content = parsed.message.content
        }
        if (parsed.message?.tool_calls && parsed.message.tool_calls.length > 0) {
          delta.tool_calls = parsed.message.tool_calls.map((tc, index) => ({
            index,
            id: tc.id || `call_${index}`,
            type: 'function',
            function: {
              name: tc.function?.name || '',
              arguments: JSON.stringify(tc.function?.arguments || {}),
            },
          }))
        }

        if (Object.keys(delta).length > 0) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
        }
        if (parsed.done) {
          res.write('data: [DONE]\n\n')
        }
      } catch {
        // 忽略无法解析的行
      }
    }
  }
}

// Create router
const router = Router()

// All routes require authentication
router.use(authenticate)

// 查询已配置的提供商
router.get(
  '/providers',
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' })
    }

    const rows = await db.query.aiProviderKeys.findMany({
      where: eq(aiProviderKeys.userId, userId),
    })

    const configured = new Map(rows.map((row) => [row.providerId, row.baseUrl]))
    const data = Object.entries(PROVIDER_META).map(([providerId, meta]) => ({
      providerId,
      // 无需密钥的提供商（如本地 Ollama）始终视为已配置
      configured: !meta.apiKeyRequired || configured.has(providerId),
      baseUrl: configured.get(providerId) || undefined,
    }))

    return res.json({ success: true, data })
  })
)

// 保存/更新提供商密钥（服务端加密存储）
router.post(
  '/providers',
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id
    const { providerId, apiKey, baseUrl } = req.body as {
      providerId?: unknown
      apiKey?: unknown
      baseUrl?: unknown
    }

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' })
    }

    const meta = typeof providerId === 'string' ? getProviderMeta(providerId) : null
    if (!meta || typeof providerId !== 'string') {
      return res.status(400).json({ success: false, error: '未知的 AI 提供商' })
    }

    const trimmedBaseUrl = typeof baseUrl === 'string' && baseUrl.trim() !== ''
      ? baseUrl.trim()
      : undefined

    if (trimmedBaseUrl && !resolveBaseUrl(trimmedBaseUrl, undefined, meta)) {
      return res.status(400).json({ success: false, error: '无效的服务地址（仅支持 https，或 http://localhost）' })
    }

    const existing = await getProviderKey(userId, providerId)

    // 未提供新密钥时：仅允许更新 baseUrl（需已存在密钥）
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      if (existing?.id && trimmedBaseUrl) {
        await db
          .update(aiProviderKeys)
          .set({
            baseUrl: trimmedBaseUrl,
            updatedAt: Math.floor(Date.now() / 1000),
          })
          .where(eq(aiProviderKeys.id, existing.id))
        return res.json({ success: true, data: { providerId, configured: true } })
      }
      return res.status(400).json({ success: false, error: 'API 密钥不能为空' })
    }

    const encrypted = encryptApiKey(apiKey.trim())

    if (existing && existing.id) {
      await db
        .update(aiProviderKeys)
        .set({
          apiKeyEncrypted: encrypted,
          baseUrl: trimmedBaseUrl ?? null,
          updatedAt: Math.floor(Date.now() / 1000),
        })
        .where(eq(aiProviderKeys.id, existing.id))
    } else {
      await db.insert(aiProviderKeys).values({
        userId,
        providerId,
        apiKeyEncrypted: encrypted,
        baseUrl: trimmedBaseUrl ?? null,
        updatedAt: Math.floor(Date.now() / 1000),
      })
    }

    return res.json({ success: true, data: { providerId, configured: true } })
  })
)

// 删除提供商密钥
router.delete(
  '/providers/:providerId',
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id
    const providerId = req.params.providerId

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' })
    }
    if (!getProviderMeta(providerId)) {
      return res.status(400).json({ success: false, error: '未知的 AI 提供商' })
    }

    await db
      .delete(aiProviderKeys)
      .where(
        and(
          eq(aiProviderKeys.userId, userId),
          eq(aiProviderKeys.providerId, providerId)
        )
      )

    return res.json({ success: true })
  })
)

// 代理获取模型列表
router.post(
  '/models',
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id
    const { providerId, urlPath, baseUrl } = req.body as {
      providerId?: unknown
      urlPath?: unknown
      baseUrl?: unknown
    }

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' })
    }

    const meta = typeof providerId === 'string' ? getProviderMeta(providerId) : null
    if (!meta || typeof providerId !== 'string') {
      return res.status(400).json({ success: false, error: '未知的 AI 提供商' })
    }
    if (!isValidUrlPath(urlPath)) {
      return res.status(400).json({ success: false, error: '无效的请求路径' })
    }

    const keyRow = await getProviderKey(userId, providerId)

    let apiKey = ''
    if (meta.apiKeyRequired) {
      if (!keyRow?.apiKeyEncrypted) {
        return res.status(400).json({ success: false, error: 'AI 服务未配置 API 密钥' })
      }
      try {
        apiKey = decryptApiKey(keyRow.apiKeyEncrypted)
      } catch {
        return res.status(400).json({
          success: false,
          error: 'API 密钥解密失败（服务端密钥可能已轮换），请在 AI 服务配置中重新输入密钥',
        })
      }
    }

    const effectiveBaseUrl = resolveBaseUrl(
      typeof baseUrl === 'string' ? baseUrl : undefined,
      keyRow?.baseUrl ?? undefined,
      meta
    )
    if (!effectiveBaseUrl) {
      return res.status(400).json({ success: false, error: '无效的服务地址' })
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20000)

    try {
      const upstream = await fetch(`${effectiveBaseUrl}${urlPath}`, {
        method: 'GET',
        headers: buildUpstreamHeaders(providerId, apiKey),
        signal: controller.signal,
      })

      if (!upstream.ok) {
        const text = (await upstream.text()).slice(0, 500)
        return res.status(502).json({ success: false, error: `获取模型列表失败: ${text}` })
      }

      const data = await upstream.json()
      return res.json({ success: true, data })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return res.status(504).json({ success: false, error: '获取模型列表超时' })
      }
      logError('AI models proxy error', error)
      return res.status(502).json({ success: false, error: '获取模型列表失败，请检查网络或服务地址' })
    } finally {
      clearTimeout(timeout)
    }
  })
)

// SSE 流式代理聊天请求
router.post(
  '/chat',
  asyncHandler(async (req: AuthRequest, res) => {
    const userId = req.user?.id
    const { providerId, urlPath, body, baseUrl } = req.body as {
      providerId?: unknown
      urlPath?: unknown
      body?: unknown
      baseUrl?: unknown
    }

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' })
    }

    const meta = typeof providerId === 'string' ? getProviderMeta(providerId) : null
    if (!meta || typeof providerId !== 'string') {
      return res.status(400).json({ success: false, error: '未知的 AI 提供商' })
    }
    if (!isValidUrlPath(urlPath)) {
      return res.status(400).json({ success: false, error: '无效的请求路径' })
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return res.status(400).json({ success: false, error: '无效的请求体' })
    }

    const keyRow = await getProviderKey(userId, providerId)

    let apiKey = ''
    if (meta.apiKeyRequired) {
      if (!keyRow?.apiKeyEncrypted) {
        return res.status(400).json({ success: false, error: 'AI 服务未配置 API 密钥' })
      }
      try {
        apiKey = decryptApiKey(keyRow.apiKeyEncrypted)
      } catch {
        return res.status(400).json({
          success: false,
          error: 'API 密钥解密失败（服务端密钥可能已轮换），请在 AI 服务配置中重新输入密钥',
        })
      }
    }

    const effectiveBaseUrl = resolveBaseUrl(
      typeof baseUrl === 'string' ? baseUrl : undefined,
      keyRow?.baseUrl ?? undefined,
      meta
    )
    if (!effectiveBaseUrl) {
      return res.status(400).json({ success: false, error: '无效的服务地址' })
    }

    const controller = new AbortController()
    let upstream: Response
    try {
      upstream = await fetch(`${effectiveBaseUrl}${urlPath}`, {
        method: 'POST',
        headers: buildUpstreamHeaders(providerId, apiKey),
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return res.status(504).json({ success: false, error: 'AI 服务请求超时' })
      }
      logError('AI chat proxy fetch error', error)
      return res.status(502).json({ success: false, error: '无法连接 AI 服务，请检查网络或服务地址' })
    }

    if (!upstream.ok) {
      const text = (await upstream.text()).slice(0, 1000)
      return res.status(502).json({ success: false, error: `AI 服务请求失败: ${text}` })
    }

    // Ollama 非流式请求：直接透传原始 JSON，不做 SSE 转换
    if (providerId === 'ollama' && (body as { stream?: unknown }).stream === false) {
      const data = await upstream.json()
      return res.json({ success: true, data })
    }

    if (!upstream.body) {
      return res.status(502).json({ success: false, error: 'AI 服务无响应内容' })
    }

    // 客户端断开时中止上游请求，避免连接泄漏
    req.on('close', () => controller.abort())

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    try {
      if (providerId === 'ollama') {
        await pipeOllamaStream(upstream.body, res)
      } else {
        for await (const chunk of upstream.body) {
          res.write(chunk)
        }
      }
    } catch (error) {
      logError('AI chat proxy stream error', error)
    } finally {
      res.end()
    }
  })
)

export { router as aiProxyRouter }
