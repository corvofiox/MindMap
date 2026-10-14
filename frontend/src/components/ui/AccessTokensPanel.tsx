import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Copy, Key, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useUIStore } from '@/store/useUIStore'
import {
  createPersonalAccessToken,
  listPersonalAccessTokens,
  revokePersonalAccessToken,
  type CreatedPersonalAccessToken,
  type PersonalAccessToken,
} from '@/services/personalAccessTokens'
import { logger } from '@/utils/logger'

/**
 * 访问令牌（Personal Access Token）面板。
 *
 * 外部 agent 用这里的令牌访问 `/mcp`。三件必须做对的事：
 *  1. 明文令牌只在创建响应里出现一次，之后永远拿不回来 —— 创建成功后立刻
 *     用醒目告警 + 可复制字段展示，且列表里不再出现明文；
 *  2. 撤销是不可逆的，必须二次确认；
 *  3. 令牌只在创建时明文展示，任何情况下都不落 localStorage / 日志。
 */

/** Unix 秒 → 本地日期字符串；`null` 返回占位文案。 */
function formatTimestamp(seconds: number | null, fallback: string): string {
  if (seconds === null || seconds === undefined) return fallback
  const date = new Date(seconds * 1000)
  if (Number.isNaN(date.getTime())) return fallback
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 令牌是否已过期（仅用于展示；服务端才是权威）。 */
function isExpired(token: PersonalAccessToken): boolean {
  if (token.expiresAt === null) return false
  return token.expiresAt * 1000 <= Date.now()
}

/** Vite 开发端口：此时前端 5173、后端 3000，需要显式换成 API 端口。 */
const VITE_DEV_PORT = '5173'
/** 开发环境的后端端口。 */
const DEV_API_PORT = '3000'

/**
 * MCP 端点的展示地址。
 *
 * 开发时页面在 5173、API 在 3000，必须替换端口；生产（Docker）前后端共用
 * 同一端口，直接用当前 origin 即可 —— 无脑替换成 3000 会在 Docker 下给出错地址。
 */
function resolveMcpUrl(): string {
  const { protocol, hostname, port, origin } = window.location
  if (port === VITE_DEV_PORT) {
    return `${protocol}//${hostname}:${DEV_API_PORT}/mcp`
  }
  return `${origin}/mcp`
}

interface CopyState {
  copied: boolean
}

export function AccessTokensPanel() {
  const { addSuccessToast, addErrorToast } = useUIStore()

  const [tokens, setTokens] = useState<PersonalAccessToken[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [expiresInDays, setExpiresInDays] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  // 明文令牌只在创建后存在于此；关闭/刷新后不再保留
  const [createdToken, setCreatedToken] = useState<CreatedPersonalAccessToken | null>(null)
  const [copyState, setCopyState] = useState<CopyState>({ copied: false })

  const [pendingRevokeId, setPendingRevokeId] = useState<number | null>(null)
  const [revokingId, setRevokingId] = useState<number | null>(null)

  // "已复制" 复位定时器；卸载时清掉，避免对已卸载组件 setState
  const copyResetTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current)
        copyResetTimerRef.current = null
      }
    }
  }, [])

  const loadTokens = useCallback(async () => {
    setIsLoading(true)
    setLoadError(null)
    try {
      const list = await listPersonalAccessTokens()
      setTokens(list)
    } catch (error) {
      const message = error instanceof Error ? error.message : '加载访问令牌失败'
      setLoadError(message)
      logger.error('加载访问令牌失败', error)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadTokens()
  }, [loadTokens])

  const handleCreate = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      addErrorToast('请填写令牌名称')
      return
    }

    // 留空 ⇒ 永不过期；填了就必须是 1~3650 的整数（与后端校验一致）
    let days: number | undefined
    if (expiresInDays.trim() !== '') {
      const parsed = Number(expiresInDays)
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 3650) {
        addErrorToast('有效期必须是 1 到 3650 之间的整数天数')
        return
      }
      days = parsed
    }

    setIsCreating(true)
    try {
      const created = await createPersonalAccessToken({ name: trimmed, expiresInDays: days })
      setCreatedToken(created)
      setCopyState({ copied: false })
      setName('')
      setExpiresInDays('')
      addSuccessToast('访问令牌已创建，请立即复制保存')
      await loadTokens()
    } catch (error) {
      addErrorToast(error instanceof Error ? error.message : '创建访问令牌失败')
    } finally {
      setIsCreating(false)
    }
  }

  const handleCopy = async (text: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        throw new Error('Clipboard API unavailable')
      }
      setCopyState({ copied: true })
      addSuccessToast('令牌已复制到剪贴板')
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current)
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        copyResetTimerRef.current = null
        setCopyState({ copied: false })
      }, 2000)
    } catch (error) {
      logger.error('复制令牌失败', error)
      addErrorToast('复制失败，请手动选中文本复制')
    }
  }

  const handleRevoke = async (id: number) => {
    setRevokingId(id)
    try {
      await revokePersonalAccessToken(id)
      addSuccessToast('访问令牌已撤销')
      setPendingRevokeId(null)
      // 撤销的令牌不会从列表消失（保留审计记录），因此刷新以拿到 revoked 状态
      await loadTokens()
    } catch (error) {
      addErrorToast(error instanceof Error ? error.message : '撤销访问令牌失败')
    } finally {
      setRevokingId(null)
    }
  }

  const mcpUrl = resolveMcpUrl()

  return (
    <div className="space-y-6">
      {/* 新建令牌 */}
      <section>
        <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-1">访问令牌</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          外部 agent 通过 MCP 访问你的画布时，使用这里的令牌进行认证。令牌只存哈希，
          明文仅在创建时显示一次。
        </p>

        <div className="p-4 bg-gray-50 dark:bg-gray-900/40 rounded-lg space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px] gap-3">
            <div>
              <label
                htmlFor="access-token-name"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                名称
              </label>
              <input
                id="access-token-name"
                type="text"
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isCreating) void handleCreate()
                }}
                className="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-900 dark:text-white"
                placeholder="例如：Claude Desktop"
              />
            </div>

            <div>
              <label
                htmlFor="access-token-expiry"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                有效期（天）
              </label>
              <input
                id="access-token-expiry"
                type="number"
                min={1}
                max={3650}
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
                className="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-900 dark:text-white"
                placeholder="留空=永不过期"
              />
            </div>
          </div>

          <div className="flex justify-end">
            <button
              onClick={handleCreate}
              disabled={isCreating || !name.trim()}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 text-white font-medium rounded-lg transition-colors flex items-center gap-2"
            >
              {isCreating ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
              创建令牌
            </button>
          </div>
        </div>
      </section>

      {/* 明文令牌只显示这一次 */}
      {createdToken && (
        <section
          role="alert"
          className="p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700 rounded-lg space-y-3"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div>
              <h4 className="font-medium text-amber-900 dark:text-amber-100">
                请立即复制并妥善保存
              </h4>
              <p className="text-sm text-amber-800 dark:text-amber-200 mt-1">
                这是令牌明文唯一一次显示。关闭本窗口后将无法再次查看，只能重新创建。
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={createdToken.token}
              aria-label="新创建的访问令牌"
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 px-3 py-2 bg-white dark:bg-gray-900 border border-amber-300 dark:border-amber-700 rounded-lg font-mono text-sm text-gray-900 dark:text-amber-100"
            />
            <button
              onClick={() => handleCopy(createdToken.token)}
              className="px-3 py-2 bg-amber-600 hover:bg-amber-700 text-white font-medium rounded-lg transition-colors flex items-center gap-2 shrink-0"
            >
              {copyState.copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copyState.copied ? '已复制' : '复制'}
            </button>
          </div>

          <div className="text-xs text-amber-800 dark:text-amber-200">
            名称：{createdToken.name} · 前缀：{createdToken.tokenPrefix} · 有效期：
            {formatTimestamp(createdToken.expiresAt, '永不过期')}
          </div>

          <div className="flex justify-end">
            <button
              onClick={() => {
                // 明文只留在创建结果里，用户确认保存后立刻从内存清除
                setCreatedToken(null)
                setCopyState({ copied: false })
              }}
              className="px-3 py-1.5 text-sm font-medium text-amber-900 dark:text-amber-100 hover:bg-amber-100 dark:hover:bg-amber-900/40 rounded-lg transition-colors"
            >
              我已保存，关闭提示
            </button>
          </div>
        </section>
      )}

      {/* 令牌列表 */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">
            已有令牌（{tokens.length}）
          </h4>
          <button
            onClick={() => void loadTokens()}
            disabled={isLoading}
            className="p-1.5 rounded text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
            aria-label="刷新令牌列表"
            title="刷新"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {isLoading && tokens.length === 0 && (
          <div className="flex items-center justify-center py-8 text-gray-500 dark:text-gray-400">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            加载中...
          </div>
        )}

        {!isLoading && loadError && (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">
            {loadError}
          </div>
        )}

        {!isLoading && !loadError && tokens.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 text-center text-gray-500 dark:text-gray-400">
            <Key className="w-8 h-8 mb-2 opacity-50" />
            <p className="text-sm">还没有访问令牌，创建一个即可让外部 agent 接入。</p>
          </div>
        )}

        <ul className="space-y-2">
          {tokens.map((token) => {
            const expired = isExpired(token)
            const isConfirming = pendingRevokeId === token.id
            const isRevoking = revokingId === token.id

            return (
              <li
                key={token.id}
                className={`p-3 border rounded-lg ${
                  token.revoked
                    ? 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 opacity-70'
                    : 'border-gray-200 dark:border-gray-700'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`font-medium truncate ${
                          token.revoked
                            ? 'text-gray-500 dark:text-gray-400 line-through'
                            : 'text-gray-900 dark:text-white'
                        }`}
                      >
                        {token.name}
                      </span>

                      {token.revoked && (
                        <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300">
                          已撤销
                        </span>
                      )}
                      {!token.revoked && expired && (
                        <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300">
                          已过期
                        </span>
                      )}
                    </div>

                    <div className="mt-1 font-mono text-xs text-gray-500 dark:text-gray-400">
                      {token.tokenPrefix}
                    </div>

                    <dl className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
                      <div>
                        <dt className="inline">创建：</dt>
                        <dd className="inline">{formatTimestamp(token.createdAt, '未知')}</dd>
                      </div>
                      <div>
                        <dt className="inline">最近使用：</dt>
                        <dd className="inline">{formatTimestamp(token.lastUsedAt, '从未使用')}</dd>
                      </div>
                      <div>
                        <dt className="inline">有效期：</dt>
                        <dd className="inline">{formatTimestamp(token.expiresAt, '永不过期')}</dd>
                      </div>
                    </dl>

                    {token.revoked && token.revokedAt !== null && (
                      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                        撤销于 {formatTimestamp(token.revokedAt, '未知')}
                      </p>
                    )}
                  </div>

                  {!token.revoked && (
                    <div className="shrink-0">
                      {isConfirming ? (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-red-600 dark:text-red-400 whitespace-nowrap">
                            确认撤销？
                          </span>
                          <button
                            onClick={() => void handleRevoke(token.id)}
                            disabled={isRevoking}
                            className="px-2 py-1 text-xs font-medium bg-red-600 hover:bg-red-700 disabled:bg-gray-400 text-white rounded transition-colors flex items-center gap-1"
                          >
                            {isRevoking && <Loader2 className="w-3 h-3 animate-spin" />}
                            撤销
                          </button>
                          <button
                            onClick={() => setPendingRevokeId(null)}
                            disabled={isRevoking}
                            className="px-2 py-1 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
                          >
                            取消
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setPendingRevokeId(token.id)}
                          className="px-2 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors flex items-center gap-1"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          撤销
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      </section>

      {/* MCP 接入说明 */}
      <section className="p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
        <h4 className="text-sm font-medium text-blue-900 dark:text-blue-100 mb-2">
          如何用令牌接入 MCP
        </h4>
        <p className="text-sm text-blue-800 dark:text-blue-200 mb-2">
          远程 / HTTP 客户端直接连接 MCP 端点，并在请求头带上令牌：
        </p>
        <pre className="p-2 bg-white dark:bg-gray-900 rounded border border-blue-200 dark:border-blue-800 text-xs font-mono text-gray-800 dark:text-gray-200 overflow-x-auto">
          {`POST ${mcpUrl}
Authorization: Bearer <令牌>`}
        </pre>
        <p className="text-sm text-blue-800 dark:text-blue-200 mt-3 mb-2">
          本地 stdio 客户端（如 Claude Desktop）使用内置代理，通过环境变量传入令牌与地址：
        </p>
        <pre className="p-2 bg-white dark:bg-gray-900 rounded border border-blue-200 dark:border-blue-800 text-xs font-mono text-gray-800 dark:text-gray-200 overflow-x-auto">
          {`{
  "mcpServers": {
    "mindmap": {
      "command": "node",
      "args": ["backend/dist/mcp/stdio.js"],
      "env": {
        "MINDMAP_API_URL": "http://127.0.0.1:3000",
        "MINDMAP_TOKEN": "<令牌>"
      }
    }
  }
}`}
        </pre>
        <p className="text-xs text-blue-700 dark:text-blue-300 mt-2">
          令牌等同于你的账号权限，请勿分享或提交到代码仓库；怀疑泄露时立即撤销并重建。
        </p>
      </section>
    </div>
  )
}
