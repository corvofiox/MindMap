import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { nanoid } from 'nanoid'
import type { Theme, Tool, DragMode, NodeCard, Toast, NodeDefaults } from '@/types'
import { STORAGE_KEYS, DEFAULT_NODE_DEFAULTS } from '@/constants'
import { getToastConfig } from '@/config/messageConfig'
import { setupTheme, applyTheme, initThemeListener } from '@/utils/themeManager'
import { updateNodeDefaults } from '@/services/api'
import { logger } from '@/utils/logger'

const getDefaultNodeDefaults = (): NodeDefaults => DEFAULT_NODE_DEFAULTS

export { getDefaultNodeDefaults }

interface UIState {
  // Theme
  theme: Theme
  setTheme: (theme: Theme) => void
  initializeTheme: () => void

  // Sidebar
  sidebarOpen: boolean
  setSidebarOpen: (open: boolean) => void
  toggleSidebar: () => void

  // Node Pool
  nodePoolOpen: boolean
  setNodePoolOpen: (open: boolean) => void
  toggleNodePool: () => void

  // Canvas
  currentTool: Tool
  setCurrentTool: (tool: Tool) => void

  dragMode: DragMode
  setDragMode: (mode: DragMode) => void
  toggleDragMode: () => void

  gridVisible: boolean
  setGridVisible: (visible: boolean) => void
  toggleGrid: () => void

  // Drag Ghost (for node pool copy to canvas)
  dragGhostCard: NodeCard | null
  dragGhostPosition: { x: number; y: number } | null
  setDragGhost: (card: NodeCard | null, position: { x: number; y: number } | null) => void

  // Minimap
  minimapVisible: boolean
  setMinimapVisible: (visible: boolean) => void
  toggleMinimap: () => void

  // Domain Edit Mode
  domainEditMode: boolean
  setDomainEditMode: (enabled: boolean) => void

  // Connection Direction
  connectionDirection: 'directed' | 'bidirectional' | 'undirected'
  setConnectionDirection: (direction: 'directed' | 'bidirectional' | 'undirected') => void

  // Connection Style
  connectionStyle: 'solid' | 'dashed' | 'dotted'
  setConnectionStyle: (style: 'solid' | 'dashed' | 'dotted') => void

  // Connection Type
  connectionType: 'straight' | 'curve' | 'step' | 'orthogonal'
  setConnectionType: (type: 'straight' | 'curve' | 'step' | 'orthogonal') => void

  // Context Menu
  contextMenuOpen: boolean
  contextMenuPosition: { x: number; y: number } | null
  contextMenuTarget: string | null
  openContextMenu: (x: number, y: number, target?: string) => void
  closeContextMenu: () => void

  // Dialogs
  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void

  accountSettingsOpen: boolean
  setAccountSettingsOpen: (open: boolean) => void

  shortcutsOpen: boolean
  setShortcutsOpen: (open: boolean) => void

  searchOpen: boolean
  setSearchOpen: (open: boolean) => void

  commandPaletteOpen: boolean
  setCommandPaletteOpen: (open: boolean) => void

  // Toasts
  toasts: Toast[]
  addToast: (toast: Omit<Toast, 'id'>) => void
  removeToast: (id: string) => void
  addErrorToast: (message: string, title?: string) => void
  addSuccessToast: (message: string, title?: string) => void
  addWarningToast: (message: string, title?: string) => void
  addInfoToast: (message: string, title?: string) => void

  // Loading
  isLoading: boolean
  setLoading: (loading: boolean) => void

// Style Panel
  stylePanelOpen: boolean
  selectedType: 'node' | 'connection' | 'domain' | null
  selectedNodeIds: string[]
  openStylePanel: () => void
  closeStylePanel: () => void
  setSelectedType: (type: 'node' | 'connection' | 'domain' | null) => void
  setSelectedNodeIds: (ids: string[]) => void

  // Node Defaults
  nodeDefaultsOpen: boolean
  setNodeDefaultsOpen: (open: boolean) => void
  nodeDefaults: NodeDefaults
  setNodeDefaults: (defaults: NodeDefaults) => void
  loadNodeDefaults: () => Promise<void>
  saveNodeDefaults: () => Promise<void>
  resetNodeDefaults: () => void

  // Reset for logout
  resetForLogout: () => void

  // Reset for login
  resetForLogin: () => void
}



export const useUIStore = create<UIState>()(
  persist(
    (set, get) => {
      const createToggle = (key: keyof UIState) => () =>
        set((state: UIState) => ({ [key]: !state[key as keyof UIState] }))

      return {
        // Theme
        theme: 'system',
        setTheme: (theme) => {
          set({ theme })
          applyTheme(theme)
        },
        initializeTheme: () => {
          const currentTheme = get().theme
          setupTheme(currentTheme)
        },

        // Sidebar
        sidebarOpen: true,
        setSidebarOpen: (open) => set({ sidebarOpen: open }),
        toggleSidebar: createToggle('sidebarOpen'),

        // Node Pool
        nodePoolOpen: true,
        setNodePoolOpen: (open) => set({ nodePoolOpen: open }),
        toggleNodePool: createToggle('nodePoolOpen'),

        // Canvas
        currentTool: 'select',
        setCurrentTool: (tool) => set({ currentTool: tool }),

        dragMode: 'free',
        setDragMode: (mode) => set({ dragMode: mode }),
        toggleDragMode: () =>
          set((state: UIState) => ({ dragMode: state.dragMode === 'free' ? 'grid' : 'free' })),

        gridVisible: true,
        setGridVisible: (visible) => set({ gridVisible: visible }),
        toggleGrid: createToggle('gridVisible'),

        // Drag Ghost (for node pool copy to canvas)
        dragGhostCard: null,
        dragGhostPosition: null,
        setDragGhost: (card, position) => set({ dragGhostCard: card, dragGhostPosition: position }),

        // Minimap
        minimapVisible: true,
        setMinimapVisible: (visible) => set({ minimapVisible: visible }),
        toggleMinimap: createToggle('minimapVisible'),

        // Domain Edit Mode
        domainEditMode: false,
        setDomainEditMode: (enabled) => set({ domainEditMode: enabled }),

        // Connection Direction
        connectionDirection: 'directed',
        setConnectionDirection: (direction) => set({ connectionDirection: direction }),

        // Connection Style
        connectionStyle: 'solid',
        setConnectionStyle: (style) => set({ connectionStyle: style }),

        // Connection Type
        connectionType: 'straight',
        setConnectionType: (type) => set({ connectionType: type }),

        // Context Menu
        contextMenuOpen: false,
        contextMenuPosition: null,
        contextMenuTarget: null,
        openContextMenu: (x, y, target) =>
          set({
            contextMenuOpen: true,
            contextMenuPosition: { x, y },
            contextMenuTarget: target || null,
          }),
        closeContextMenu: () =>
          set({
            contextMenuOpen: false,
            contextMenuPosition: null,
            contextMenuTarget: null,
          }),

        // Dialogs
        settingsOpen: false,
        setSettingsOpen: (open) => set({ settingsOpen: open }),

        accountSettingsOpen: false,
        setAccountSettingsOpen: (open) => set({ accountSettingsOpen: open }),

        shortcutsOpen: false,
        setShortcutsOpen: (open) => set({ shortcutsOpen: open }),

        searchOpen: false,
        setSearchOpen: (open) => set({ searchOpen: open }),

        commandPaletteOpen: false,
        setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),

        // Toasts
        toasts: [],
        addToast: (toast) => {
          const config = getToastConfig()
          const id = nanoid()
          set((state) => {
            const newToasts = [...state.toasts, { ...toast, id }]
            // 限制最大显示数量
            return { toasts: newToasts.slice(-config.maxToasts) }
          })
          if (toast.duration !== 0) {
            setTimeout(() => {
              get().removeToast(id)
            }, toast.duration || config.defaultDuration)
          }
        },
        removeToast: (id) =>
          set((state) => ({
            toasts: state.toasts.filter((t) => t.id !== id),
          })),
        // Convenience methods for different toast types
        addErrorToast: (message, title = '错误') => {
          get().addToast({ type: 'error', title, message })
        },
        addSuccessToast: (message, title = '成功') => {
          get().addToast({ type: 'success', title, message })
        },
        addWarningToast: (message, title = '警告') => {
          get().addToast({ type: 'warning', title, message })
        },
        addInfoToast: (message, title = '提示') => {
          get().addToast({ type: 'info', title, message })
        },

        // Loading
        isLoading: false,
        setLoading: (loading) => set({ isLoading: loading }),

        // Style Panel
        stylePanelOpen: false,
        selectedType: null,
        selectedNodeIds: [],
        openStylePanel: () => set({ stylePanelOpen: true }),
        closeStylePanel: () => set({ stylePanelOpen: false }),
setSelectedType: (type) => {
          const state = get()
          if (state.stylePanelOpen && state.selectedType !== type) {
            set({ stylePanelOpen: false })
          }
          set({ selectedType: type })
        },
        setSelectedNodeIds: (ids) => set({ selectedNodeIds: ids }),

        // Node Defaults
        nodeDefaultsOpen: false,
        setNodeDefaultsOpen: (open) => set({ nodeDefaultsOpen: open }),
        nodeDefaults: getDefaultNodeDefaults(),
        setNodeDefaults: (defaults) => set({ nodeDefaults: defaults }),
        loadNodeDefaults: async () => {
          try {
            // 确保 apiClient token 已更新
            const authStore = await import('@/store/useAuthStore').then(m => m.useAuthStore)
            const token = authStore.getState().token
            if (!token) {
              logger.warn('未获取到认证令牌，无法加载节点默认配置')
              return
            }

            // 直接使用 apiClient 实例，确保使用最新的 token
            const apiModule = await import('@/services/api')
            const defaults = await apiModule.getNodeDefaults()

            if (defaults && defaults.textNode && defaults.imageNode) {
              set({ nodeDefaults: defaults })
            } else {
              logger.warn('获取到的节点默认配置不完整，使用本地默认值')
            }
          } catch (error) {
            logger.error('加载节点默认配置失败', error)
            // 显示更友好的错误提示
            get().addErrorToast('加载节点默认配置失败，将使用本地默认值', '提示')
          }
        },
        saveNodeDefaults: async () => {
          const { nodeDefaults } = get()
          try {
            await updateNodeDefaults(nodeDefaults)
          } catch (error) {
            get().addErrorToast('保存节点默认配置失败')
          }
        },
        resetNodeDefaults: () => set({ nodeDefaults: getDefaultNodeDefaults() }),

        // Reset for logout
        resetForLogout: () => set({
          nodeDefaults: getDefaultNodeDefaults(),
          nodeDefaultsOpen: false,
        }),

        // Reset for login
        resetForLogin: () => set({
          nodeDefaults: getDefaultNodeDefaults(),
        }),
      }
    },
    {
      name: STORAGE_KEYS.SETTINGS,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        theme: state.theme,
        sidebarOpen: state.sidebarOpen,
        nodePoolOpen: state.nodePoolOpen,
        dragMode: state.dragMode,
        gridVisible: state.gridVisible,
        minimapVisible: state.minimapVisible,
        // nodeDefaults 不持久化，始终从服务器获取当前用户的配置
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          applyTheme(state.theme)
          initThemeListener()
          // 不在这里调用 loadNodeDefaults，因为可能 token 还没准备好
          // 改为在 App.tsx 中，validateToken 成功后调用
        }
      },
    }
  )
)
