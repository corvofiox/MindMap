// AI Proxy Controller
// 服务端代理 AI 提供商请求：密钥加密存储在服务端，浏览器不再接触 API 密钥
// - POST /providers   保存/更新提供商密钥（AES-256-GCM 加密）
// - GET  /providers   查询已配置的提供商（不返回明文密钥）
// - DELETE /providers/:providerId  删除密钥
// - POST /models      代理获取模型列表
// - POST /chat        SSE 流式代理聊天请求（Ollama NDJSON 统一转换为 OpenAI SSE 格式）

import { Router } from 'express'
import type { Response as ExpressResponse } from 'express'
import dns from 'dns/promises'
import type { LookupOptions, LookupAddress } from 'dns'
import net from 'net'
import { Agent } from 'undici'
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

// A2 SSRF 加固：拒绝私网/回环/链路本地/云元数据/多播等受限地址段。
// 同时覆盖 IPv4、IPv6 与 IPv4-mapped IPv6 形式。
function isRestrictedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p))
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true // 0.0.0.0/8, 10/8, 回环
  if (a === 169 && b === 254) return true // 链路本地 169.254/16（含云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
  if (a === 192 && b === 168) return true // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10（含阿里云元数据 100.100.100.200）
  if (a === 198 && (b === 18 || b === 19)) return true // 基准测试 198.18/15
  if (a >= 224) return true // 多播 + 保留
  return false
}

/** 将 IPv6 地址完整展开为 8 组 4 位十六进制（处理 :: 压缩），失败返回 null。 */
function expandIpv6(ip: string): string[] | null {
  const zoneIdx = ip.indexOf('%')
  if (zoneIdx !== -1) ip = ip.slice(0, zoneIdx)
  // #8 纵深防御：IPv6 允许以点分 IPv4 结尾（RFC 4291 §2.2.3），如
  // ::ffff:127.0.0.1、::127.0.0.1、64:ff9b::127.0.0.1。WHATWG URL 规范
  // 化通常会把它们转成十六进制（::ffff:7f00:1），但直接拿原始输入调用本
  // 函数（或上游未来变化）时不能依赖该规范化——先把尾段 IPv4 折算成两个
  // 十六进制组，后续按纯 IPv6 组展开。
  const v4Match = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip)
  if (v4Match) {
    const v4 = v4Match[1].split('.').map((p) => Number(p))
    if (v4.some((p) => p > 255)) return null
    ip =
      ip.slice(0, v4Match.index) +
      ((v4[0] << 8) | v4[1]).toString(16) +
      ':' +
      ((v4[2] << 8) | v4[3]).toString(16)
  }
  const [head, tail] = ip.split('::')
  const headParts = head ? head.split(':') : []
  const tailParts = tail ? tail.split(':') : []
  const missing = 8 - headParts.length - tailParts.length
  if (missing < 0) return null
  const all = [...headParts, ...Array(missing).fill('0'), ...tailParts]
  if (all.length !== 8 || all.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null
  return all.map((p) => p.padStart(4, '0'))
}

function isRestrictedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  const groups = expandIpv6(lower)
  if (groups) {
    // IPv4-mapped IPv6（::ffff:a.b.c.d / ::ffff:x:x）：
    // 前 5 组全 0、第 6 组 ffff → 后 32 位按 IPv4 判定。
    // 注意：WHATWG URL 会把 ::ffff:127.0.0.1 规范化为 ::ffff:7f00:1（十六进制），
    // 因此必须用展开后的十六进制组判断，点分正则匹配不到规范化形式。
    const isMapped =
      groups.slice(0, 5).every((g) => g === '0000') && groups[5] === 'ffff'
    if (isMapped) {
      const hi = parseInt(groups[6], 16)
      const lo = parseInt(groups[7], 16)
      const v4 = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
      return isRestrictedIpv4(v4)
    }
    // IPv4-compatible（::a.b.c.d 前 96 位全 0，已弃用但仍存在）按 IPv4 判定
    if (groups.slice(0, 6).every((g) => g === '0000')) {
      const hi = parseInt(groups[6], 16)
      const lo = parseInt(groups[7], 16)
      const v4 = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
      return isRestrictedIpv4(v4)
    }
    // R5 #4: NAT64 前缀（RFC 6052）——压缩形式 64:ff9b: 已在下方字符串
    // 兜底命中，但带前导零的形式 0064:ff9b:（WHATWG URL 解析不会去除
    // IPv6 组的前导零，[0064:ff9b::1] 会原样到达）匹配不到。展开后的
    // 首组为 '0064'、次组以 'ff9b' 开头（覆盖 well-known 64:ff9b::/96
    // 与本地用 64:ff9b:1::/48 变体）即视为受限：NAT64 前缀可把内网
    // IPv4 映射进来（如 64:ff9b::7f00:1 → 127.0.0.1），必须拒绝。
    if (groups[0] === '0064' && groups[1].startsWith('ff9b')) return true
    // #2: 链路本地 fe80::/10（fe80-febf）与站点本地 fec0::/10（fec0-feff）
    // 恰好无缝拼成 fe80::/9（fe80-feff），用 /9 位掩码 0xff80 一次判定，
    // 覆盖整个区间——旧的 startsWith('fe80')/('fec0') 只匹配前缀字面量，
    // fe81::/fe8f::/fec1::/fed0:: 等段内地址会被漏掉。
    // （注意不能用 0xffc0 掩码 + 0xfe80 比较：fec0 & 0xffc0 = fec0 ≠ fe80，
    // 那样会漏掉整个站点本地段。）
    if ((parseInt(groups[0], 16) & 0xff80) === 0xfe80) return true
  } else {
    // expandIpv6 失败（非标准格式）时按字符串前缀兜底：解析首组十六进制，
    // 仍用 /9 位掩码覆盖链路本地 + 站点本地全段。
    const firstSeg = lower.split(':')[0]
    if (/^[0-9a-f]{1,4}$/.test(firstSeg)) {
      const first = parseInt(firstSeg, 16)
      if (!Number.isNaN(first) && (first & 0xff80) === 0xfe80) return true
    }
  }
  if (lower === '::1' || lower === '::') return true // 回环 / 未指定
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // ULA fc00::/7
  // R5 #4: 字符串兜底同时覆盖压缩与前导零形式（expandIpv6 失败时）
  if (lower.startsWith('64:ff9b:') || lower.startsWith('0064:ff9b:')) return true // NAT64 前缀
  if (lower.startsWith('ff')) return true // 多播
  return false
}

function isRestrictedIp(ip: string): boolean {
  const family = net.isIP(ip)
  if (family === 4) return isRestrictedIpv4(ip)
  if (family === 6) return isRestrictedIpv6(ip)
  return false
}

// R4 #4: 回环地址判定（含 IPv4-mapped IPv6 形式）——https 协议下回环地址
// 是合法的本地 https 端点（如 https://localhost:8443），与 http 回环同等
// 信任级别，应放行；其余受限段仍拒绝。
function isLoopbackIp(ip: string): boolean {
  const family = net.isIP(ip)
  if (family === 4) {
    return ip.startsWith('127.')
  }
  if (family === 6) {
    const lower = ip.toLowerCase()
    if (lower === '::1') return true
    const groups = expandIpv6(lower)
    if (!groups) return false
    const isMapped =
      groups.slice(0, 5).every((g) => g === '0000') && groups[5] === 'ffff'
    if (isMapped) {
      const hi = parseInt(groups[6], 16)
      const lo = parseInt(groups[7], 16)
      const v4 = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
      return v4.startsWith('127.')
    }
    return false
  }
  return false
}

// R5 #2: DNS rebinding TOCTOU 修复。旧实现中 resolveBaseUrl 用
// dns.lookup(all:true) 校验域名解析结果后，随后的 fetch 会对同一域名
// 再次发起系统 DNS 解析——攻击者可在"校验通过"与"实际建连"之间把域名
// 改指向内网地址，绕过 SSRF 防护。修复：把校验阶段得到的 IP 列表原样
// 锁进 undici Agent 的 connect.lookup，fetch 建连时不再向系统 DNS 查询，
// 直接用已校验的 IP；lookup 收到非锁定 hostname 一律报错（fail-closed）。
interface ResolvedBaseUrl {
  url: string
  hostname: string
  /** 已校验的解析结果（仅 https 域名场景非空）；为空表示无需锁 DNS */
  addresses: string[]
}

const pinnedAgents = new Map<string, Agent>()
// R8-fix: 缓存容量上限 + FIFO 驱逐——防止用户配置大量唯一域名/地址组合时
// pinnedAgents Map 无限累积(每个条目持有一个 undici Agent,长期运行内存增长)
const PINNED_AGENTS_MAX = 100

function createPinnedAgent(hostname: string, addresses: string[]): Agent {
  const key = `${hostname}|${addresses.join(',')}`
  let agent = pinnedAgents.get(key)
  if (agent) return agent
  agent = new Agent({
    connect: {
      lookup: (
        h: string,
        options: LookupOptions,
        callback: (
          err: NodeJS.ErrnoException | null,
          address?: string | LookupAddress[],
          family?: number
        ) => void,
      ) => {
        if (h !== hostname) {
          // fail-closed：任何非锁定 hostname 一律拒绝，杜绝意外二次解析
          callback(new Error(`Pinned lookup rejected unexpected hostname: ${h}`))
          return
        }
        const pinned = addresses.map((addr) => ({ address: addr, family: net.isIP(addr) }))
        if (options.all) {
          callback(null, pinned)
          return
        }
        const first = pinned[0]
        callback(null, first.address, first.family)
      },
    },
  })
  pinnedAgents.set(key, agent)
  // FIFO 驱逐:超过上限时删除最早插入的条目(Agent 不再被引用后由 GC 回收)
  if (pinnedAgents.size > PINNED_AGENTS_MAX) {
    const oldestKey = pinnedAgents.keys().next().value
    if (oldestKey !== undefined) {
      pinnedAgents.delete(oldestKey)
    }
  }
  return agent
}

// Node 内建 fetch 的 RequestInit.dispatcher 用的是其捆绑 undici 版本的
// Dispatcher 类型（与独立安装的 undici Agent 类型存在签名差异），但
// 运行时协议完全兼容（实测：Node 20 全局 fetch 会真实使用传入的
// dispatcher，connect.lookup 以 { all: true } 被调用并锁定解析结果）。
function pinnedDispatcher(hostname: string, addresses: string[]): RequestInit['dispatcher'] {
  return createPinnedAgent(hostname, addresses) as unknown as RequestInit['dispatcher']
}

// 解析并校验 base URL
// - 仅允许 http/https
// - http 只能指向本机地址（localhost/127.0.0.1/::1），防止 SSRF 到内网
// - https 同样拒绝私网/回环/链路本地/元数据地址段：IP 字面量直接判定，
//   域名经 dns.lookup 校验解析结果（DNS rebinding 防护），任一地址落入
//   受限段即拒绝；解析失败按失败关闭处理（拒绝）
// - 返回的 addresses 是"已校验"的解析结果，调用方必须把它锁进 fetch
//   的连接 lookup（见 createPinnedAgent），杜绝校验后的二次解析（R5 #2）
async function resolveBaseUrl(
  requestBaseUrl: string | undefined,
  storedBaseUrl: string | undefined,
  meta: { defaultBaseUrl: string }
): Promise<ResolvedBaseUrl | null> {
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
  if (parsed.protocol === 'https:') {
    if (net.isIP(hostname) !== 0) {
      // IP 字面量：回环地址放行（本地 https 端点，与 http 回环同等信任），
      // 其余受限段仍拒绝
      if (!isLoopbackIp(hostname) && isRestrictedIp(hostname)) return null
      return { url: raw, hostname, addresses: [] }
    } else {
      // 域名：解析后校验最终 IP——任一非回环受限地址即拒绝；
      // https://localhost 解析到 127.0.0.1/::1 是合法的本地 https 端点
      let addresses: string[] = []
      try {
        const result = await dns.lookup(hostname, { all: true })
        addresses = result.map((r) => r.address)
      } catch {
        return null // 解析失败 → 失败关闭
      }
      if (
        addresses.length === 0 ||
        addresses.some((addr) => !isLoopbackIp(addr) && isRestrictedIp(addr))
      ) {
        return null
      }
      // 关键：把已校验的 IP 结果返回给调用方，fetch 时必须锁定使用
      return { url: raw, hostname, addresses }
    }
  }
  return { url: raw, hostname, addresses: [] }
}

// 上游返回 3xx 重定向时直接拒绝（配合 fetch redirect:'manual'）。
// 否则 fetch 默认跟随重定向，302 → http://127.0.0.1 会被真实请求，SSRF 直达内网。
function isRedirectStatus(status: number | undefined): boolean {
  return typeof status === 'number' && status >= 300 && status < 400
}

// A9：上游错误响应体回显收敛——截断到 200 字符并压缩空白，避免把内网探测
// 结果大段回显给客户端，同时保留可用的错误定位信息。
function sanitizeUpstreamErrorText(text: string): string {
  return text.slice(0, 200).replace(/\s+/g, ' ').trim()
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
  res: ExpressResponse,
  // R4 #7: 每个数据块到达时回调（用于重置流式 idle 超时）
  onActivity?: () => void,
) {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of body) {
    onActivity?.()
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

    if (trimmedBaseUrl && !(await resolveBaseUrl(trimmedBaseUrl, undefined, meta))) {
      // R4 #4: 文案如实描述当前策略——公网 https 或本机 http(s) 回环
      return res.status(400).json({ success: false, error: '无效的服务地址（仅支持公网 https 地址，或 http(s)://localhost 本机地址）' })
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

    const effectiveBaseUrl = await resolveBaseUrl(
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
      // R5 #2: 域名场景把已校验的 IP 锁进 undici Agent 的 connect.lookup，
      // fetch 建连不再二次解析 DNS（杜绝校验与建连之间的 DNS rebinding）
      const upstream = await fetch(`${effectiveBaseUrl.url}${urlPath}`, {
        method: 'GET',
        headers: buildUpstreamHeaders(providerId, apiKey),
        signal: controller.signal,
        redirect: 'manual',
        ...(effectiveBaseUrl.addresses.length > 0
          ? { dispatcher: pinnedDispatcher(effectiveBaseUrl.hostname, effectiveBaseUrl.addresses) }
          : {}),
      })

      // A2: 3xx 重定向不跟随，直接 502
      if (isRedirectStatus(upstream.status)) {
        return res.status(502).json({ success: false, error: '获取模型列表失败：上游返回重定向' })
      }

      if (!upstream.ok) {
        const text = sanitizeUpstreamErrorText(await upstream.text())
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

    const effectiveBaseUrl = await resolveBaseUrl(
      typeof baseUrl === 'string' ? baseUrl : undefined,
      keyRow?.baseUrl ?? undefined,
      meta
    )
    if (!effectiveBaseUrl) {
      return res.status(400).json({ success: false, error: '无效的服务地址' })
    }

    const controller = new AbortController()
    // A8: 响应头超时——上游 30s 未返回响应头即中止，防止连接悬挂
    const headerTimeout = setTimeout(() => controller.abort(), 30000)
    let upstream: Response
    try {
      // R5 #2: 与 /models 一致——域名场景锁定已校验 IP，杜绝二次解析
      upstream = await fetch(`${effectiveBaseUrl.url}${urlPath}`, {
        method: 'POST',
        headers: buildUpstreamHeaders(providerId, apiKey),
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'manual',
        ...(effectiveBaseUrl.addresses.length > 0
          ? { dispatcher: pinnedDispatcher(effectiveBaseUrl.hostname, effectiveBaseUrl.addresses) }
          : {}),
      })
    } catch (error) {
      clearTimeout(headerTimeout)
      if (error instanceof Error && error.name === 'AbortError') {
        return res.status(504).json({ success: false, error: 'AI 服务请求超时' })
      }
      logError('AI chat proxy fetch error', error)
      return res.status(502).json({ success: false, error: '无法连接 AI 服务，请检查网络或服务地址' })
    }
    clearTimeout(headerTimeout)

    // A2: 3xx 重定向不跟随，直接 502
    if (isRedirectStatus(upstream.status)) {
      return res.status(502).json({ success: false, error: 'AI 服务请求失败：上游返回重定向' })
    }

    if (!upstream.ok) {
      const text = sanitizeUpstreamErrorText(await upstream.text())
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

    // R4 #7: SSE 流式阶段 idle 超时——响应头已到达但 60s 无任何数据块时
    // 中止上游，防止上游半死连接（不再推数据也不关闭）永久悬挂占用连接。
    // 每次收到数据块都会重置定时器，正常持续输出的长流不受影响。
    // R5 #6: idle 超时 abort 后向客户端写一个 SSE error 事件再 end——
    // 客户端能明确感知"上游超时被断开"，而不是收到一个无结尾的静默截断
    // （前端可据此提示用户重试）。客户端主动断开（req close）触发的 abort
    // 不写（响应已不可写，且无接收方）。
    const STREAM_IDLE_TIMEOUT_MS = 60_000
    let streamIdleTimer: ReturnType<typeof setTimeout> | null = null
    let streamIdleTimedOut = false
    const resetStreamIdleTimer = () => {
      if (streamIdleTimer) clearTimeout(streamIdleTimer)
      streamIdleTimer = setTimeout(() => {
        streamIdleTimedOut = true
        controller.abort()
      }, STREAM_IDLE_TIMEOUT_MS)
    }
    resetStreamIdleTimer()

    try {
      if (providerId === 'ollama') {
        await pipeOllamaStream(upstream.body, res, resetStreamIdleTimer)
      } else {
        for await (const chunk of upstream.body) {
          resetStreamIdleTimer()
          res.write(chunk)
        }
      }
    } catch (error) {
      // idle 超时触发的 abort 会在此抛出 AbortError，属预期行为
      logError('AI chat proxy stream error', error)
      if (streamIdleTimedOut && !res.writableEnded && !res.destroyed) {
        try {
          res.write(
            `data: ${JSON.stringify({ error: 'AI 服务响应超时，连接已断开' })}\n\n`
          )
        } catch {
          // 写入失败（客户端已断开）则忽略
        }
      }
    } finally {
      if (streamIdleTimer) clearTimeout(streamIdleTimer)
      if (!res.writableEnded && !res.destroyed) {
        res.end()
      }
    }
  })
)

export { router as aiProxyRouter }
