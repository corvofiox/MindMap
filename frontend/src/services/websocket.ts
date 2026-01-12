import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import type { AwarenessUserData, AwarenessState } from '@/types'
import { WS_CONFIG } from '@/constants'
import { useUIStore } from '@/store/useUIStore'

interface WebSocketServiceConfig {
  canvasId: number
  token: string
  onUsersChange?: (users: AwarenessUserData[]) => void
  onCursorsChange?: (cursors: Map<number, AwarenessState>) => void
  onConnectionChange?: (connected: boolean) => void
}

class WebSocketService {
  private doc: Y.Doc | null = null
  private provider: any | null = null
  private config: WebSocketServiceConfig | null = null
  private reconnectAttempts: number = 0
  private maxReconnectAttempts: number = 5
  private reconnectTimeout: NodeJS.Timeout | null = null
  private reconnectDelay: number = 1000 // Start with 1 second delay
  private connectionStatus: 'connecting' | 'connected' | 'disconnected' | 'error' = 'disconnected'
  private lastStatus: string | null = null

  connect(config: WebSocketServiceConfig) {
    this.config = config
    this.disconnect()
    this.reconnectAttempts = 0
    this.reconnectDelay = 1000
    this.connectionStatus = 'connecting'
    this.notifyConnectionChange()

    // Create Yjs document
    this.doc = new Y.Doc()

    // Create WebSocket provider
    this.provider = new WebsocketProvider(
      `${WS_CONFIG.URL}?canvasId=${config.canvasId}`,
      `canvas-${config.canvasId}`,
      this.doc,
      {
        connect: true,
        params: {
          token: config.token,
        },
      }
    )

    // Set up awareness
    this.provider.awareness.setLocalStateField('user', {
      id: 0, // Will be set from token
      name: '',
      color: '',
      avatar: null,
    })

    // Listen to awareness changes
    this.provider.awareness.on('change', () => {
      const states = this.provider?.awareness.getStates() as Map<number, AwarenessState>
      if (states && config.onCursorsChange) {
        config.onCursorsChange(states)
      }

      const users = Array.from(states || [])
        .map(([_, state]) => state.user)
        .filter(Boolean) as AwarenessUserData[]

      if (config.onUsersChange) {
        config.onUsersChange(users)
      }
    })

    // Handle connection status
    this.provider.on('status', (event: { status: string }) => {
      if (event.status !== this.lastStatus) {
        this.handleStatusChange(event.status)
        this.lastStatus = event.status
      }
    })

    this.provider.on('sync', (synced: boolean) => {
      if (synced && this.connectionStatus === 'connecting') {
        this.connectionStatus = 'connected'
        this.reconnectAttempts = 0
        this.reconnectDelay = 1000
        this.notifyConnectionChange()
      }
    })

    // Handle WebSocket errors
    this.provider.ws?.addEventListener('error', (error: Event) => {
      this.handleWebSocketError(error)
    })

    // Handle WebSocket close
    this.provider.ws?.addEventListener('close', (event: CloseEvent) => {
      this.handleWebSocketClose(event)
    })
  }

  private handleStatusChange(status: string) {
    const addToast = useUIStore.getState().addToast
    
    switch (status) {
      case 'connected':
        this.connectionStatus = 'connected'
        this.notifyConnectionChange()
        if (this.reconnectAttempts > 0) {
          addToast({
            type: 'success',
            title: '连接恢复',
            message: 'WebSocket连接已恢复'
          })
        }
        this.reconnectAttempts = 0
        this.reconnectDelay = 1000
        break
      case 'disconnected':
        this.connectionStatus = 'disconnected'
        this.notifyConnectionChange()
        this.attemptReconnect()
        break
      case 'connecting':
        this.connectionStatus = 'connecting'
        this.notifyConnectionChange()
        break
      default:
        break
    }
  }

  private handleWebSocketError(error: Event) {
    this.connectionStatus = 'error'
    this.notifyConnectionChange()
    this.attemptReconnect()
  }

  private handleWebSocketClose(event: CloseEvent) {
    // Don't attempt to reconnect if we intentionally closed the connection
    if (this.provider) {
      this.connectionStatus = 'disconnected'
      this.notifyConnectionChange()
      this.attemptReconnect()
    }
  }

  private attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts || !this.config) {
      const addToast = useUIStore.getState().addToast
      addToast({
        type: 'error',
        title: '连接失败',
        message: 'WebSocket连接失败，已达到最大重连次数'
      })
      return
    }

    // Exponential backoff with jitter
    const jitter = Math.random() * 1000
    const delay = this.reconnectDelay + jitter

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectAttempts++
      this.reconnectDelay *= 2 // Double the delay for next attempt
      
      if (this.reconnectAttempts === 1) {
        const addToast = useUIStore.getState().addToast
        addToast({
          type: 'warning',
          title: '连接断开',
          message: 'WebSocket连接已断开，正在尝试重连...'
        })
      }

      // Reconnect with current config
      if (this.config) {
        this.connect(this.config)
      }
    }, delay)
  }

  private notifyConnectionChange() {
    if (this.config?.onConnectionChange) {
      this.config.onConnectionChange(this.connectionStatus === 'connected')
    }
  }

  disconnect() {
    // Clear any pending reconnect attempts
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    this.provider?.destroy()
    this.doc?.destroy()
    this.provider = null
    this.doc = null
    this.connectionStatus = 'disconnected'
    this.notifyConnectionChange()
    this.config = null
  }

  getDoc(): Y.Doc | null {
    return this.doc
  }

  getProvider(): any | null {
    return this.provider
  }

  // Get Y data structures
  getNodesMap(): Y.Map<any> | null {
    if (!this.doc) return null
    return this.doc.getMap('nodes')
  }

  getGroupsMap(): Y.Map<any> | null {
    if (!this.doc) return null
    return this.doc.getMap('groups')
  }

  getDomainsMap(): Y.Map<any> | null {
    if (!this.doc) return null
    return this.doc.getMap('domains')
  }

  getConnectionsMap(): Y.Map<any> | null {
    if (!this.doc) return null
    return this.doc.getMap('connections')
  }

  // Awareness methods
  updateCursor(cursor: { x: number; y: number }) {
    if (this.provider) {
      this.provider.awareness.setLocalStateField('cursor', cursor)
    }
  }

  updateSelection(selection: string[]) {
    if (this.provider) {
      this.provider.awareness.setLocalStateField('selection', selection)
    }
  }

  updateEditing(editing: string | null) {
    if (this.provider) {
      this.provider.awareness.setLocalStateField('isEditing', editing || undefined)
    }
  }

  setUser(user: AwarenessUserData) {
    if (this.provider) {
      this.provider.awareness.setLocalStateField('user', user)
    }
  }

  isConnected(): boolean {
    return this.connectionStatus === 'connected' && this.provider?.wsconnected || false
  }

  getConnectionStatus(): 'connecting' | 'connected' | 'disconnected' | 'error' {
    return this.connectionStatus
  }
}

// Singleton instance
export const wsService = new WebSocketService()
