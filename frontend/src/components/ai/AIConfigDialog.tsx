import { useState, useEffect, useCallback } from 'react'
import { X, Check, RefreshCw, AlertCircle, Settings, Brain, Braces, Trash2 } from 'lucide-react'
import { AI_PROVIDERS, fetchModels, validateApiKey } from '@/services/aiService'
import { useAIStore, type ProviderConfig } from '@/store/useAIStore'
import { getAIProviders, saveAIProviderKey, deleteAIProviderKey, type AIProviderStatus } from '@/services/api'

interface AIConfigDialogProps {
  open: boolean
  onClose: () => void
}

export function AIConfigDialog({ open, onClose }: AIConfigDialogProps) {
  const {
    currentProvider,
    availableModels,
    isLoadingModels,
    error,
    setCurrentProvider,
    setProviderConfig,
    getProviderConfig,
    setAvailableModels,
    setIsLoadingModels,
    setError,
    setIsConnected,
    resetConfig,
  } = useAIStore()

  // 本地状态，用于当前编辑的提供商配置
  const [localProvider, setLocalProvider] = useState(currentProvider)
  const [localConfig, setLocalConfig] = useState<ProviderConfig>(getProviderConfig(currentProvider))
  const [apiKeyInput, setApiKeyInput] = useState('') // 用户新输入的密钥（不持久化到前端存储）
  const [isTesting, setIsTesting] = useState(false)
  const [testResult, setTestResult] = useState<boolean | null>(null)
  // 服务端密钥配置状态
  const [providerStatuses, setProviderStatuses] = useState<Record<string, AIProviderStatus>>({})

  const provider = AI_PROVIDERS.find((p) => p.id === localProvider)

  // 加载服务端密钥配置状态
  const loadProviderStatuses = useCallback(async () => {
    try {
      const statuses = await getAIProviders()
      setProviderStatuses(
        statuses.reduce<Record<string, AIProviderStatus>>((acc, s) => {
          acc[s.providerId] = s
          return acc
        }, {})
      )
    } catch {
      setProviderStatuses({})
    }
  }, [])

  // 当对话框打开时同步本地配置 + 加载服务端密钥状态
  useEffect(() => {
    if (open) {
      setLocalProvider(currentProvider)
      setLocalConfig(getProviderConfig(currentProvider))
      setApiKeyInput('')
      setTestResult(null)
      loadProviderStatuses()
    }
  }, [open, currentProvider, getProviderConfig, loadProviderStatuses])

  // 当切换提供商时，加载该提供商的配置
  const handleProviderChange = (newProvider: string) => {
    // 先保存当前提供商的配置
    setProviderConfig(localProvider, localConfig)
    // 切换到新提供商
    setLocalProvider(newProvider)
    // 加载新提供商的配置
    const newConfig = getProviderConfig(newProvider)
    setLocalConfig(newConfig)
    setApiKeyInput('')
    setTestResult(null)
    setAvailableModels([])
  }

  // 如果用户输入了新密钥，先保存到服务端
  const ensureKeySaved = async (): Promise<boolean> => {
    if (apiKeyInput.trim() === '') {
      return true
    }
    try {
      await saveAIProviderKey(localProvider, apiKeyInput.trim(), localConfig.baseUrl || undefined)
      setApiKeyInput('')
      await loadProviderStatuses()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存 API 密钥失败')
      return false
    }
  }

  // 获取模型列表
  const handleFetchModels = async () => {
    if (!provider) return

    // 检查是否需要 API Key（服务端已配置或本次输入）
    const isConfigured = providerStatuses[localProvider]?.configured
    if (provider.apiKeyRequired && !isConfigured && !apiKeyInput.trim()) {
      setError('请输入 API 密钥')
      return
    }

    setIsLoadingModels(true)
    setError(null)

    try {
      const saved = await ensureKeySaved()
      if (!saved) return

      const models = await fetchModels(
        provider,
        '',
        localConfig.baseUrl || undefined
      )
      setAvailableModels(models)
      // 如果当前选中的模型不在列表中，选择第一个
      if (models.length > 0 && !models.find((m) => m.id === localConfig.model)) {
        setLocalConfig((prev) => ({ ...prev, model: models[0].id }))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取模型列表失败')
    } finally {
      setIsLoadingModels(false)
    }
  }

  // 测试连接
  const handleTestConnection = async () => {
    if (!provider) return

    const isConfigured = providerStatuses[localProvider]?.configured
    if (provider.apiKeyRequired && !isConfigured && !apiKeyInput.trim()) {
      setError('请输入 API 密钥')
      return
    }

    setIsTesting(true)
    setTestResult(null)
    setError(null)

    try {
      const saved = await ensureKeySaved()
      if (!saved) return

      const isValid = await validateApiKey(
        provider,
        '',
        localConfig.baseUrl || undefined
      )
      setTestResult(isValid)
      if (isValid) {
        // 测试成功后自动获取模型列表
        await handleFetchModels()
      }
    } catch (err) {
      setTestResult(false)
      setError(err instanceof Error ? err.message : '连接测试失败')
    } finally {
      setIsTesting(false)
    }
  }

  // 删除服务端密钥
  const handleDeleteKey = async () => {
    if (!confirm('确定要删除该提供商的 API 密钥吗？')) return
    try {
      await deleteAIProviderKey(localProvider)
      setApiKeyInput('')
      setTestResult(null)
      await loadProviderStatuses()
      setIsConnected(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除密钥失败')
    }
  }

  // 保存配置
  const handleSave = async () => {
    // 保存密钥到服务端（如有输入）
    const saved = await ensureKeySaved()
    if (!saved) return

    // 保存当前提供商的配置
    setProviderConfig(localProvider, localConfig)
    // 设置当前选中的提供商
    setCurrentProvider(localProvider)

    // 如果测试已通过，标记为已连接
    if (testResult === true) {
      setIsConnected(true)
    }

    onClose()
  }

  // 自动测试并获取模型列表（当服务端已配置且测试尚未进行时）
  useEffect(() => {
    const autoConnect = async () => {
      if (!provider) return
      if (!open) return // 只在对话框打开时执行

      const isConfigured = providerStatuses[localProvider]?.configured
      const hasBaseUrl = localConfig.baseUrl || provider.baseUrl

      if (isConfigured && hasBaseUrl && !testResult) {
        // 自动测试连接
        setIsTesting(true)
        try {
          const isValid = await validateApiKey(
            provider,
            '',
            localConfig.baseUrl || undefined
          )
          setTestResult(isValid)
          if (isValid) {
            // 连接成功，自动获取模型列表
            const models = await fetchModels(
              provider,
              '',
              localConfig.baseUrl || undefined
            )
            setAvailableModels(models)
            // 如果当前没有选中的模型，自动选择第一个
            if (models.length > 0 && !models.find((m) => m.id === localConfig.model)) {
              setLocalConfig((prev) => ({ ...prev, model: models[0].id }))
            }
          }
        } catch {
          setTestResult(false)
        } finally {
          setIsTesting(false)
        }
      }
    }

    autoConnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, localProvider, providerStatuses])

  if (!open) return null

  const isProviderConfigured = providerStatuses[localProvider]?.configured === true

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-md mx-4 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <Settings className="w-5 h-5 text-purple-500" />
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              AI 服务配置
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg text-gray-500 dark:text-gray-400"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-4 space-y-4 overflow-y-auto flex-1">
          {/* 提供商选择 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              AI 提供商
            </label>
            <select
              value={localProvider}
              onChange={(e) => handleProviderChange(e.target.value)}
              className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-purple-500 focus:outline-none"
            >
              {AI_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} - {p.description}
                </option>
              ))}
            </select>
          </div>

          {/* API 密钥 */}
          {provider?.apiKeyRequired && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  API 密钥
                </label>
                {isProviderConfigured && (
                  <button
                    onClick={handleDeleteKey}
                    className="text-xs text-red-500 hover:text-red-600 flex items-center gap-1"
                    title="删除服务端保存的密钥"
                  >
                    <Trash2 className="w-3 h-3" />
                    删除密钥
                  </button>
                )}
              </div>
              <input
                type="password"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder={isProviderConfigured ? '已配置（留空使用现有密钥）' : 'sk-...'}
                className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-purple-500 focus:outline-none"
              />
              {isProviderConfigured && apiKeyInput.trim() === '' && (
                <p className="text-xs text-green-600 dark:text-green-400 mt-1">
                  ✓ 密钥已安全存储在服务器（AES-256 加密）
                </p>
              )}
            </div>
          )}

          {/* 自定义 Base URL */}
          {['custom', 'opencode-go', 'opencode-zen'].includes(localProvider) && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                服务地址
              </label>
              <input
                type="text"
                value={localConfig.baseUrl}
                onChange={(e) =>
                  setLocalConfig((prev) => ({ ...prev, baseUrl: e.target.value }))
                }
                placeholder={provider?.baseUrl}
                className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-purple-500 focus:outline-none"
              />
            </div>
          )}

          {/* 测试连接按钮 */}
          <button
            onClick={handleTestConnection}
            disabled={isTesting || (provider?.apiKeyRequired && !isProviderConfigured && !apiKeyInput.trim())}
            className={`w-full py-2 px-4 rounded-lg text-sm font-medium flex items-center justify-center gap-2 ${
              testResult === true
                ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                : testResult === false
                ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
                : 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 hover:bg-purple-200 dark:hover:bg-purple-900/50'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {isTesting ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                测试中...
              </>
            ) : testResult === true ? (
              <>
                <Check className="w-4 h-4" />
                连接成功
              </>
            ) : testResult === false ? (
              <>
                <AlertCircle className="w-4 h-4" />
                连接失败
              </>
            ) : (
              '测试连接'
            )}
          </button>

          {/* 模型选择 */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                模型
              </label>
              <button
                onClick={handleFetchModels}
                disabled={isLoadingModels || !testResult}
                className="text-xs text-purple-600 dark:text-purple-400 hover:text-purple-700 dark:hover:text-purple-300 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
              >
                <RefreshCw className={`w-3 h-3 ${isLoadingModels ? 'animate-spin' : ''}`} />
                {isLoadingModels ? '获取中...' : '刷新列表'}
              </button>
            </div>
            <select
              value={localConfig.model}
              onChange={(e) =>
                setLocalConfig((prev) => ({ ...prev, model: e.target.value }))
              }
              disabled={availableModels.length === 0}
              className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-purple-500 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {availableModels.length === 0 ? (
                <option value="">请先测试连接获取模型列表</option>
              ) : (
                availableModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} {m.description ? `(${m.description})` : ''}
                  </option>
                ))
              )}
            </select>
          </div>

          {/* DeepSeek 思考模式设置 */}
          {localProvider === 'deepseek' && (
            <div className="space-y-3 p-3 bg-purple-50 dark:bg-purple-900/20 rounded-lg border border-purple-200 dark:border-purple-800">
              <div className="flex items-center gap-2 text-sm font-medium text-purple-700 dark:text-purple-300">
                <Brain className="w-4 h-4" />
                思考模式
              </div>
              <div className="flex items-center justify-between">
                <label className="text-sm text-gray-600 dark:text-gray-400">
                  启用思考模式
                </label>
                <button
                  type="button"
                  role="switch"
                  aria-checked={localConfig.enableThinking !== false}
                  onClick={() =>
                    setLocalConfig((prev) => ({
                      ...prev,
                      enableThinking: prev.enableThinking === false ? true : false,
                    }))
                  }
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                    localConfig.enableThinking !== false
                      ? 'bg-purple-500'
                      : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      localConfig.enableThinking !== false ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
              {localConfig.enableThinking !== false && (
                <div className="flex items-center justify-between">
                  <label className="text-sm text-gray-600 dark:text-gray-400">
                    思考强度
                  </label>
                  <select
                    value={localConfig.reasoningEffort || 'high'}
                    onChange={(e) =>
                      setLocalConfig((prev) => ({
                        ...prev,
                        reasoningEffort: e.target.value as 'high' | 'max',
                      }))
                    }
                    className="px-2 py-1 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-purple-500 focus:outline-none"
                  >
                    <option value="high">High（默认）</option>
                    <option value="max">Max（深度推理）</option>
                  </select>
                </div>
              )}
              {localConfig.enableThinking !== false && (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  温度、最大 Token 等参数已移除,由上游 API 默认值控制
                </p>
              )}
            </div>
          )}

          {/* JSON Output 模式（DeepSeek） */}
          {localProvider === 'deepseek' && (
            <div className="space-y-3 p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg border border-amber-200 dark:border-amber-800">
              <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-300">
                <Braces className="w-4 h-4" />
                输出格式
              </div>
              <div className="flex items-center justify-between">
                <label className="text-sm text-gray-600 dark:text-gray-400">
                  JSON Output 模式
                </label>
                <button
                  type="button"
                  role="switch"
                  aria-checked={localConfig.responseFormat === 'json_object'}
                  onClick={() =>
                    setLocalConfig((prev) => ({
                      ...prev,
                      responseFormat: prev.responseFormat === 'json_object' ? 'text' : 'json_object',
                    }))
                  }
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                    localConfig.responseFormat === 'json_object'
                      ? 'bg-amber-500'
                      : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      localConfig.responseFormat === 'json_object' ? 'translate-x-4' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </div>
              {localConfig.responseFormat === 'json_object' && (
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  启用后模型将输出 JSON 格式，需在提示词中说明 JSON 结构
                </p>
              )}
            </div>
          )}

          {/* 错误提示 */}
          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-600 dark:text-red-400">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 dark:border-gray-700">
          <button
            onClick={() => { if (confirm('确定要重置所有 AI 配置吗？此操作不可撤销。')) resetConfig() }}
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
          >
            重置配置
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={!testResult}
              className="px-4 py-2 text-sm bg-purple-500 text-white rounded-lg hover:bg-purple-600 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              保存配置
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
