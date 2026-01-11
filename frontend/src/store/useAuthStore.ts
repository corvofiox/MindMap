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
    (set, get) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,

      validateToken: async () => {
        const token = get().token || localStorage.getItem('mindmap_token')
        if (!token) {
          set({ user: null, token: null, isAuthenticated: false })
          return false
        }

        try {
          await api.getProfile()
          return true
        } catch {
          localStorage.removeItem('mindmap_token')
          set({ user: null, token: null, isAuthenticated: false })
          return false
        }
      },

      login: async (credentials) => {
        set({ isLoading: true, error: null })
        try {
          const response = await api.login(credentials)
          localStorage.setItem('mindmap_token', response.token)
          set({
            user: response.user,
            token: response.token,
            isAuthenticated: true,
            isLoading: false,
          })
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Login failed',
            isLoading: false,
          })
          throw error
        }
      },

      register: async (data) => {
        set({ isLoading: true, error: null })
        try {
          const response = await api.register(data)
          localStorage.setItem('mindmap_token', response.token)
          set({
            user: response.user,
            token: response.token,
            isAuthenticated: true,
            isLoading: false,
          })
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Registration failed',
            isLoading: false,
          })
          throw error
        }
      },

      logout: async () => {
        try {
          await api.logout()
        } catch (error) {
          // Silently fail
        } finally {
          localStorage.removeItem('mindmap_token')
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
          set({
            user: response.user,
            token: response.token,
            isAuthenticated: true,
          })
        } catch (error) {
          set({
            user: null,
            token: null,
            isAuthenticated: false,
          })
        }
      },

      updateProfile: async (data) => {
        const { user } = get()
        if (!user) throw new Error('Not authenticated')

        set({ isLoading: true, error: null })
        try {
          const updatedUser = await api.updateProfile(data)
          set({ user: updatedUser, isLoading: false })
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Update failed',
            isLoading: false,
          })
          throw error
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'mindmap-auth',
      partialize: (state) => ({
        user: state.user,
        token: state.token,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
)
