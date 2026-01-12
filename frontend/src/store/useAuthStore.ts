import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User, LoginCredentials, RegisterData } from '@/types'
import * as api from '@/services/api'

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
            const response = await api.login(credentials)
            localStorage.setItem('mindmap_token', response.token)
            // 更新 apiClient 实例的 token
            api.apiClient.setToken(response.token)
            set({
              user: response.user,
              token: response.token,
              isAuthenticated: true,
              isLoading: false,
            })
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : '登录失败'
            set({
              error: errorMessage,
              isLoading: false,
            })
            // Show error toast to user
            import('@/store/useUIStore').then(({ useUIStore }) => {
              useUIStore.getState().addErrorToast(errorMessage, '登录失败')
            })
            throw error
          }
        },

        register: async (data) => {
          set({ isLoading: true, error: null })
          try {
            const response = await api.register(data)
            localStorage.setItem('mindmap_token', response.token)
            // 更新 apiClient 实例的 token
            api.apiClient.setToken(response.token)
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
            import('@/store/useUIStore').then(({ useUIStore }) => {
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
            // Show success toast
            import('@/store/useUIStore').then(({ useUIStore }) => {
              useUIStore.getState().addSuccessToast('个人资料已更新', '更新成功')
            })
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