import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AIModel } from '@/services/aiService'

// 每个提供商的独立配置
export interface ProviderConfig {
  apiKey: string
  baseUrl: string
  model: string
  temperature: number
  maxTokens: number
  enableThinking?: boolean
  reasoningEffort?: 'high' | 'max'
  responseFormat?: 'text' | 'json_object'
  glmConfig?: {
    thinking?: { type: 'enabled' | 'disabled' }
    toolStream?: boolean
    clearThinking?: boolean
  }
  moonshotConfig?: {
    partial?: boolean
    name?: string
  }
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
  apiKey: '',
  baseUrl: '',
  model: '',
  temperature: 0.7,
  maxTokens: 4096,
}

// 获取默认配置，包含各提供商的默认地址
const getDefaultProviderConfigs = (): ProviderConfigs => ({
  moonshot: { ...defaultProviderConfig, baseUrl: 'https://api.moonshot.cn/v1' },
  deepseek: { ...defaultProviderConfig, baseUrl: 'https://api.deepseek.com' },
  zhipu: { ...defaultProviderConfig, baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  gemini: { ...defaultProviderConfig, baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  ollama: { ...defaultProviderConfig, baseUrl: 'http://localhost:11434' },
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
      name: 'ai-config-storage-v2',
      partialize: (state) => ({
        currentProvider: state.currentProvider,
        providerConfigs: state.providerConfigs,
        isConnected: state.isConnected,
      }),
    }
  )
)
