import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User, LoginCredentials, RegisterData, NodeDefaults } from '@/types'
import * as api from '@/services/api'
import { loadUIStore } from '@/utils/moduleLoader'
import { clearAllStorage } from '@/utils/clearStorage'

interface AuthState {
  user: User | null
  token: string | null
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null

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

        validateToken: async () => {
          const token = get().token || localStorage.getItem('mindmap_token')
          if (!token) {
            set({ user: null, token: null, isAuthenticated: false })
            // 更新 apiClient 实例的 token
            api.apiClient.setToken(null)
            return false
          }

          try {
            // 更新 apiClient 实例的 token
            api.apiClient.setToken(token)
            await api.getProfile()

            // 获取 CSRF token
            try {
              await api.apiClient.getCsrfTokenFromServer()
            } catch (csrfError) {
              console.error('Failed to fetch CSRF token:', csrfError)
            }

            set({ token, isAuthenticated: true })
            return true
          } catch {
            localStorage.removeItem('mindmap_token')
            set({ user: null, token: null, isAuthenticated: false })
            // 更新 apiClient 实例的 token
            api.apiClient.setToken(null)
            return false
          }
        },

        login: async (credentials) => {
          set({ isLoading: true, error: null })
          try {
            const oldToken = localStorage.getItem('mindmap_token')
            const response = await api.login(credentials)

            if (oldToken && oldToken !== response.token) {
              clearAllStorage()
            }

            // 更新 apiClient 实例的 token
            api.apiClient.setToken(response.token)
            localStorage.setItem('mindmap_token', response.token)

            // 获取 CSRF token
            try {
              await api.apiClient.getCsrfTokenFromServer()
            } catch (csrfError) {
              console.error('Failed to fetch CSRF token:', csrfError)
            }

            set({
              user: response.user,
              token: response.token,
              isAuthenticated: true,
              isLoading: false,
            })

            // 重置并加载 UI Store 的节点默认配置
            // 使用异步加载，确保 apiClient token 已完全更新
            const uiModule = await loadUIStore() as { 
              getDefaultNodeDefaults: () => NodeDefaults; 
              useUIStore: {
                getState: () => {
                  setState: (state: Partial<{ nodeDefaults: NodeDefaults; nodeDefaultsOpen: boolean }>) => void;
                  loadNodeDefaults: () => Promise<void>;
                };
              } 
            }
            
            // 获取 store 实例
            const uiStore = uiModule.useUIStore.getState();
            
            // 更新节点默认配置
            uiStore.setState({
              nodeDefaults: uiModule.getDefaultNodeDefaults(),
            })
            
            // 延迟执行，确保所有状态已更新
            setTimeout(() => {
              uiStore.loadNodeDefaults().catch(err => {
                console.error('Failed to load node defaults after login:', err)
              })
            }, 100)
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
          set({ isLoading: true, error: null })
          try {
            const oldToken = localStorage.getItem('mindmap_token')
            const response = await api.register(data)

            if (oldToken && oldToken !== response.token) {
              clearAllStorage()
            }

            localStorage.setItem('mindmap_token', response.token)
            // 更新 apiClient 实例的 token
            api.apiClient.setToken(response.token)

            // 获取 CSRF token
            try {
              await api.apiClient.getCsrfTokenFromServer()
            } catch (csrfError) {
              console.error('Failed to fetch CSRF token:', csrfError)
            }

            set({
              user: response.user,
              token: response.token,
              isAuthenticated: true,
              isLoading: false,
            })
          } catch (error) {
            handleError(error, '注册失败')
          }
        },

        logout: async () => {
          try {
            await api.logout()
          } catch (error) {
            // Silently fail - no need to show error for logout
          } finally {
            localStorage.removeItem('mindmap_token')
            // 更新 apiClient 实例的 token
            api.apiClient.setToken(null)
            // 重置 UI Store 的节点默认配置
            const uiModuleLogout = await loadUIStore() as { 
              getDefaultNodeDefaults: () => NodeDefaults; 
              useUIStore: {
                getState: () => {
                  setState: (state: Partial<{ nodeDefaults: NodeDefaults; nodeDefaultsOpen: boolean }>) => void;
                  loadNodeDefaults: () => Promise<void>;
                };
              } 
            }
            const uiStoreLogout = uiModuleLogout.useUIStore.getState();
            uiStoreLogout.setState({
              nodeDefaults: uiModuleLogout.getDefaultNodeDefaults(),
              nodeDefaultsOpen: false,
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
            localStorage.setItem('mindmap_token', response.token)
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
            })
            localStorage.removeItem('mindmap_token')
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
          }
        },

        clearError: () => set({ error: null }),
      }
    },
    {
      name: 'mindmap-auth',
      partialize: (state: AuthState) => ({
        user: state.user,
        token: state.token,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
)