import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User, LoginCredentials, RegisterData } from '@/types'
import * as api from '@/services/api'
import { loadUIStore } from '@/utils/moduleLoader'
import { clearAllStorage } from '@/utils/clearStorage'
import { logger } from '@/utils/logger'

const TOKEN_KEY = 'mindmap_token'

const safeStorage = {
  getItem: (key: string): string | null => {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  setItem: (key: string, value: string): void => {
    try {
      localStorage.setItem(key, value)
    } catch {
      // Storage may be unavailable or quota exceeded; ignore.
    }
  },
  removeItem: (key: string): void => {
    try {
      localStorage.removeItem(key)
    } catch {
      // Storage may be unavailable; ignore.
    }
  },
}

interface AuthState {
  user: User | null
  token: string | null
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null
  isHydrated: boolean // Track if persist has been restored

  // Actions
  login: (credentials: LoginCredentials) => Promise<void>
  register: (data: RegisterData) => Promise<void>
  logout: () => Promise<void>
  refreshToken: () => Promise<void>
  updateProfile: (data: Partial<User>) => Promise<void>
  validateToken: () => Promise<boolean>
  clearError: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => {
      const handleError = (error: unknown, defaultMessage: string) => {
        const errorMessage = error instanceof Error ? error.message : defaultMessage
        set({
          error: errorMessage,
          isLoading: false,
        })
      }

      return {
        user: null,
        token: null,
        isAuthenticated: false,
        isLoading: false,
        error: null,
        isHydrated: false,

        validateToken: async () => {
          // token 单一来源为 apiClient/localStorage('mindmap_token')，
          // 这里按 内存 → apiClient → localStorage 的顺序兜底读取。
          const token = get().token || api.apiClient.getToken() || safeStorage.getItem(TOKEN_KEY)
          if (!token) {
            set({ user: null, token: null, isAuthenticated: false })
            api.apiClient.setToken(null)
            return false
          }

          try {
            api.apiClient.setToken(token)
            // 更新 user 为服务端返回的最新资料（此前返回值被丢弃）
            const profile = await api.getProfile()

            try {
              await api.apiClient.getCsrfTokenFromServer()
            } catch (csrfError) {
              logger.error('Failed to fetch CSRF token', csrfError)
            }

            safeStorage.setItem(TOKEN_KEY, token)
            set({ user: profile, token, isAuthenticated: true })
            return true
          } catch {
            safeStorage.removeItem(TOKEN_KEY)
            set({ user: null, token: null, isAuthenticated: false })
            api.apiClient.setToken(null)
            return false
          }
        },

        login: async (credentials) => {
          if (get().isLoading) return
          set({ isLoading: true, error: null })
          try {
            const oldToken = safeStorage.getItem(TOKEN_KEY)
            const response = await api.login(credentials)

            if (oldToken && oldToken !== response.token) {
              clearAllStorage()
            }

            // 更新 apiClient 实例的 token
            api.apiClient.setToken(response.token)
            safeStorage.setItem(TOKEN_KEY, response.token)

            // 获取 CSRF token
            try {
              await api.apiClient.getCsrfTokenFromServer()
            } catch (csrfError) {
              logger.error('Failed to fetch CSRF token', csrfError)
            }

            set({
              user: response.user,
              token: response.token,
              isAuthenticated: true,
              isLoading: false,
            })

            // 重置并加载 UI Store 的节点默认配置
            const uiModule = await loadUIStore() as {
              useUIStore: {
                getState: () => {
                  resetForLogin: () => void
                  loadNodeDefaults: () => Promise<void>
                }
              }
            }

            const uiStore = uiModule.useUIStore.getState()

            uiStore.resetForLogin()

            await uiStore.loadNodeDefaults()
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '登录失败'
            set({
              error: errorMessage,
              isLoading: false,
            })
            throw error
          }
        },

        register: async (data) => {
          if (get().isLoading) return
          set({ isLoading: true, error: null })
          try {
            const oldToken = safeStorage.getItem(TOKEN_KEY)
            const response = await api.register(data)

            if (oldToken && oldToken !== response.token) {
              clearAllStorage()
            }

            safeStorage.setItem(TOKEN_KEY, response.token)
            // 更新 apiClient 实例的 token
            api.apiClient.setToken(response.token)

            // 获取 CSRF token
            try {
              await api.apiClient.getCsrfTokenFromServer()
            } catch (csrfError) {
              logger.error('Failed to fetch CSRF token', csrfError)
            }

            set({
              user: response.user,
              token: response.token,
              isAuthenticated: true,
              isLoading: false,
            })
          } catch (error) {
            handleError(error, '注册失败')
            throw error
          }
        },

        logout: async () => {
          try {
            await api.logout()
          } catch (error) {
            // Silently fail - no need to show error for logout
          } finally {
            safeStorage.removeItem(TOKEN_KEY)
            // 更新 apiClient 实例的 token
            api.apiClient.setToken(null)

            loadUIStore().then(({ useUIStore }) => {
              useUIStore.getState().resetForLogout()
            }).catch(err => {
              logger.error('Failed to reset UI store on logout', err)
            })

            // N5: 重置各内存 store,防止换账号后上一账号的数据残留渲染
            // (如 ProjectsPage 挂载时 loadProjects 失败,旧账号的
            // projects/canvases 列表仍会渲染)
            Promise.all([
              import('@/store/useProjectsStore'),
              import('@/store/useCanvasStore'),
              import('@/features/node-pool/stores/useNodePoolStore'),
              import('@/store/useAIStore'),
            ]).then(([projectsModule, canvasModule, nodePoolModule, aiModule]) => {
              projectsModule.useProjectsStore.getState().reset()
              canvasModule.useCanvasStore.getState().clearCanvas()
              nodePoolModule.useNodePoolStore.getState().reset()
              aiModule.useAIStore.getState().resetConfig()
            }).catch(err => {
              logger.error('Failed to reset memory stores on logout', err)
            })

            set({
              user: null,
              token: null,
              isAuthenticated: false,
            })
          }
        },

        refreshToken: async () => {
          const { token } = get()
          if (!token) return

          try {
            const response = await api.refreshToken()
            safeStorage.setItem(TOKEN_KEY, response.token)
            // 更新 apiClient 实例的 token
            api.apiClient.setToken(response.token)
            set({
              user: response.user,
              token: response.token,
              isAuthenticated: true,
            })
          } catch (error) {
            // Show warning toast for token refresh failure
            loadUIStore().then(({ useUIStore }) => {
              useUIStore.getState().addWarningToast('会话已过期，请重新登录', '会话提醒')
            }).catch(err => {
              logger.error('Failed to load UI store during token refresh', err)
            })
            safeStorage.removeItem(TOKEN_KEY)
            // 更新 apiClient 实例的 token
            api.apiClient.setToken(null)
            set({
              user: null,
              token: null,
              isAuthenticated: false,
            })
          }
        },

        updateProfile: async (data) => {
          const { user } = get()
          if (!user) throw new Error('未授权登录')

          set({ isLoading: true, error: null })
          try {
            const updatedUser = await api.updateProfile(data)
            set({ user: updatedUser, isLoading: false })
          } catch (error) {
            handleError(error, '更新个人资料失败')
            // N3: handleError 只写 error 状态不抛错,必须 rethrow 让调用方感知
            // 失败(否则 AccountSettingsDialog 的 try 会继续走成功分支误弹"保存成功")
            throw error
          }
        },

        clearError: () => set({ error: null }),
      }
    },
    {
      name: 'mindmap-auth',
      partialize: (state: AuthState) => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
      // token 统一以 apiClient/localStorage('mindmap_token') 为唯一持久化来源，
      // 不再信任 zustand 持久化副本，避免双存储不一致（如旧版本残留的过期 token）。
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AuthState>
        return {
          ...current,
          ...p,
          token: current.token,
        }
      },
      onRehydrateStorage: (state) => {
        // This function is called after rehydration
        // We need to mark the state as hydrated
        if (state) {
          state.isHydrated = true
        }
      },
    }
  )
)