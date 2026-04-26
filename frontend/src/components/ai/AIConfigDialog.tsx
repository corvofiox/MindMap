import { useState, useEffect } from 'react'
import { X, Check, RefreshCw, AlertCircle, Settings } from 'lucide-react'
import { AI_PROVIDERS, fetchModels, validateApiKey } from '@/services/aiService'
import { useAIStore, type ProviderConfig } from '@/store/useAIStore'

interface AIConfigDialogProps {
  open: boolean
  onClose: () => void
}

export function AIConfigDialog({ open, onClose }: AIConfigDialogProps) {
  const {
    currentProvider,
    providerConfigs,
    availableModels,
    isLoadingModels,
    error,
    isConnected,
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
  const [isTesting, setIsTesting] = useState(false)
  const [testResult, setTestResult] = useState<boolean | null>(null)

  const provider = AI_PROVIDERS.find((p) => p.id === localProvider)

  // 当对话框打开时同步本地配置
  useEffect(() => {
    if (open) {
      setLocalProvider(currentProvider)
      setLocalConfig(getProviderConfig(currentProvider))
      setTestResult(null)
    }
  }, [open, currentProvider, getProviderConfig])

  // 当切换提供商时，加载该提供商的配置
  const handleProviderChange = (newProvider: string) => {
    // 先保存当前提供商的配置
    setProviderConfig(localProvider, localConfig)
    // 切换到新提供商
    setLocalProvider(newProvider)
    // 加载新提供商的配置
    const newConfig = getProviderConfig(newProvider)
    setLocalConfig(newConfig)
    setTestResult(null)
    setAvailableModels([])
  }

  // 获取模型列表
  const handleFetchModels = async () => {
    if (!provider) return

    // 检查是否需要 API Key
    if (provider.apiKeyRequired && !localConfig.apiKey) {
      setError('请输入 API 密钥')
      return
    }

    setIsLoadingModels(true)
    setError(null)

    try {
      const models = await fetchModels(
        provider,
        localConfig.apiKey,
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

    if (provider.apiKeyRequired && !localConfig.apiKey) {
      setError('请输入 API 密钥')
      return
    }

    setIsTesting(true)
    setTestResult(null)
    setError(null)

    try {
      const isValid = await validateApiKey(
        provider,
        localConfig.apiKey,
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

  // 保存配置
  const handleSave = async () => {
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

  // 自动测试并获取模型列表（当配置完整时）
  useEffect(() => {
    const autoConnect = async () => {
      if (!provider) return
      if (!open) return // 只在对话框打开时执行

      // 检查配置是否完整
      const hasApiKey = !provider.apiKeyRequired || localConfig.apiKey
      const hasBaseUrl = localConfig.baseUrl || provider.baseUrl

      if (hasApiKey && hasBaseUrl && !testResult) {
        // 自动测试连接
        setIsTesting(true)
        try {
          const isValid = await validateApiKey(
            provider,
            localConfig.apiKey,
            localConfig.baseUrl || undefined
          )
          setTestResult(isValid)
          if (isValid) {
            // 连接成功，自动获取模型列表
            const models = await fetchModels(
              provider,
              localConfig.apiKey,
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
  }, [open, localProvider])

  if (!open) return null

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-md mx-4">
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
        <div className="px-6 py-4 space-y-4">
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
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                API 密钥
              </label>
              <input
                type="password"
                value={localConfig.apiKey}
                onChange={(e) =>
                  setLocalConfig((prev) => ({ ...prev, apiKey: e.target.value }))
                }
                placeholder="sk-..."
                className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-purple-500 focus:outline-none"
              />
            </div>
          )}

          {/* 自定义 Base URL */}
          {(localProvider === 'custom' || localProvider === 'ollama') && (
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
            disabled={isTesting || (provider?.apiKeyRequired && !localConfig.apiKey)}
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

          {/* 高级设置 */}
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1 h-5">
                温度
              </label>
              <input
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={localConfig.temperature}
                onChange={(e) =>
                  setLocalConfig((prev) => ({
                    ...prev,
                    temperature: parseFloat(e.target.value),
                  }))
                }
                className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-purple-500 focus:outline-none"
              />
            </div>
            <div className="flex flex-col">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1 h-5">
                最大 Token
              </label>
              <input
                type="number"
                min={100}
                max={65536}
                step={100}
                value={localConfig.maxTokens}
                onChange={(e) =>
                  setLocalConfig((prev) => ({
                    ...prev,
                    maxTokens: parseInt(e.target.value),
                  }))
                }
                className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-purple-500 focus:outline-none"
              />
            </div>
          </div>

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
            onClick={resetConfig}
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
