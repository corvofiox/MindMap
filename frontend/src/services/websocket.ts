import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import type { AwarenessUserData, AwarenessState } from '@/types'
import { WS_CONFIG } from '@/constants'

interface WebSocketServiceConfig {
  canvasId: number
  token: string
  onUsersChange?: (users: AwarenessUserData[]) => void
  onCursorsChange?: (cursors: Map<number, AwarenessState>) => void
}

class WebSocketService {
  private doc: Y.Doc | null = null
  private provider: any | null = null
  private config: WebSocketServiceConfig | null = null

  connect(config: WebSocketServiceConfig) {
    this.config = config
    this.disconnect()

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
    this.provider.on('status', (_: { status: string }) => {
    })

    this.provider.on('sync', (_: boolean) => {
    })
  }

  disconnect() {
    this.provider?.destroy()
    this.doc?.destroy()
    this.provider = null
    this.doc = null
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
    return this.provider?.wsconnected || false
  }
}

// Singleton instance
export const wsService = new WebSocketService()
