import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { AI_PROVIDERS } from '@/services/aiService'
import type { AIModel } from '@/services/aiService'

// 每个提供商的独立配置（API 密钥不再存储在前端，由服务端加密保存）
export interface ProviderConfig {
  baseUrl: string
  model: string
  enableThinking?: boolean
  reasoningEffort?: 'high' | 'max'
  responseFormat?: 'text' | 'json_object'
}

// 所有提供商的配置集合
export type ProviderConfigs = Record<string, ProviderConfig>

interface AIState {
  // 当前选中的提供商
  currentProvider: string
  // 所有提供商的配置
  providerConfigs: ProviderConfigs
  // 可用模型列表
  availableModels: AIModel[]
  // 加载状态
  isLoadingModels: boolean
  // 错误信息
  error: string | null
  // 是否已连接
  isConnected: boolean

  // Actions
  setCurrentProvider: (provider: string) => void
  setProviderConfig: (provider: string, config: Partial<ProviderConfig>) => void
  getProviderConfig: (provider: string) => ProviderConfig
  setAvailableModels: (models: AIModel[]) => void
  setIsLoadingModels: (loading: boolean) => void
  setError: (error: string | null) => void
  setIsConnected: (connected: boolean) => void
  resetConfig: () => void
}

const defaultProviderConfig: ProviderConfig = {
  baseUrl: '',
  model: '',
}

// 获取默认配置，包含各提供商的默认地址
const getDefaultProviderConfigs = (): ProviderConfigs => ({
  deepseek: { ...defaultProviderConfig, baseUrl: 'https://api.deepseek.com' },
  'opencode-go': { ...defaultProviderConfig, baseUrl: 'https://opencode.ai/zen/go/v1' },
  'opencode-zen': { ...defaultProviderConfig, baseUrl: 'https://opencode.ai/zen/v1' },
  custom: { ...defaultProviderConfig, baseUrl: '' },
})

export const useAIStore = create<AIState>()(
  persist(
    (set, get) => ({
      currentProvider: 'deepseek',
      providerConfigs: getDefaultProviderConfigs(),
      availableModels: [],
      isLoadingModels: false,
      error: null,
      isConnected: false,

      setCurrentProvider: (provider) =>
        set({ currentProvider: provider }),

      setProviderConfig: (provider, config) =>
        set((state) => ({
          providerConfigs: {
            ...state.providerConfigs,
            [provider]: {
              ...state.providerConfigs[provider],
              ...config,
            },
          },
        })),

      getProviderConfig: (provider) => {
        const state = get()
        return state.providerConfigs[provider] || { ...defaultProviderConfig }
      },

      setAvailableModels: (models) =>
        set({ availableModels: models }),

      setIsLoadingModels: (loading) =>
        set({ isLoadingModels: loading }),

      setError: (error) =>
        set({ error }),

      setIsConnected: (connected) =>
        set({ isConnected: connected }),

      resetConfig: () =>
        set({
          currentProvider: 'deepseek',
          providerConfigs: getDefaultProviderConfigs(),
          availableModels: [],
          isConnected: false,
          error: null,
        }),
    }),
    {
      // v3: API 密钥改为服务端加密存储，不再持久化到 localStorage
      name: 'ai-config-storage-v3',
      partialize: (state) => ({
        currentProvider: state.currentProvider,
        providerConfigs: state.providerConfigs,
        // isConnected 是会话级运行状态（每次打开侧边栏都会重新验证），
        // 持久化会导致重启后误显示"已连接"，因此不持久化。
      }),
      // 供应商裁剪后迁移兜底：旧 localStorage 中可能残留已删除供应商
      // （moonshot/zhipu/gemini/ollama）。rehydrate 时过滤掉非法配置，
      // currentProvider 非法时回退到 deepseek，避免下拉空白/未知提供商报错。
      merge: (persisted, current) => {
        const persistedState = persisted as Partial<AIState> | undefined
        const validIds = new Set(AI_PROVIDERS.map((p) => p.id))
        const providerConfigs = { ...current.providerConfigs }
        if (persistedState?.providerConfigs && typeof persistedState.providerConfigs === 'object') {
          for (const [id, cfg] of Object.entries(persistedState.providerConfigs)) {
            if (validIds.has(id) && cfg && typeof cfg === 'object') {
              // 剔除已移除字段(temperature/maxTokens):旧 localStorage 数据自愈,
              // 避免残留键被展开进 state 并随 persist 持续回写
              const cfgClean: Partial<ProviderConfig> = { ...(cfg as Partial<ProviderConfig>) }
              delete (cfgClean as Record<string, unknown>).temperature
              delete (cfgClean as Record<string, unknown>).maxTokens
              providerConfigs[id] = {
                ...(providerConfigs[id] || defaultProviderConfig),
                ...cfgClean,
              }
            }
          }
        }
        const currentProvider =
          persistedState?.currentProvider && validIds.has(persistedState.currentProvider)
            ? persistedState.currentProvider
            : current.currentProvider
        return {
          ...current,
          ...persistedState,
          currentProvider,
          providerConfigs,
        }
      },
    }
  )
)
