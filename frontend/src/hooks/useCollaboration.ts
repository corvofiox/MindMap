import { useEffect, useRef, useCallback } from 'react'
import { useCanvasStore, setYjsBinding } from '@/store/useCanvasStore'
import { MindMapYjsProvider, defaultWsUrlRoot, type CanvasActiveUser } from '@/services/yjsProvider'
import { bindYjsToStore } from '@/services/yjsBinding'
import { useAuthStore } from '@/store/useAuthStore'

const activeProviders = new Map<number, MindMapYjsProvider>()

export function getActiveYjsProvider(canvasId?: number): MindMapYjsProvider | null {
  if (canvasId !== undefined) return activeProviders.get(canvasId) ?? null
  const first = activeProviders.values().next()
  return first.done ? null : first.value
}

export function isCollabConnected(canvasId?: number): boolean {
  return getActiveYjsProvider(canvasId)?.isConnected() ?? false
}

export function getActiveCollabUsers(canvasId?: number): CanvasActiveUser[] {
  return getActiveYjsProvider(canvasId)?.getActiveUsers() ?? []
}

interface UseCollaborationOptions {
  canvasId: number
  enabled?: boolean
  onRemoteChange?: (canvasId: number) => void
  onKicked?: (reason: string) => void
}

export function useCollaboration({
  canvasId,
  enabled = true,
  onRemoteChange,
  onKicked,
}: UseCollaborationOptions) {
  const onRemoteChangeRef = useRef(onRemoteChange)
  onRemoteChangeRef.current = onRemoteChange
  const onKickedRef = useRef(onKicked)
  onKickedRef.current = onKicked

  useEffect(() => {
    if (!enabled || !canvasId || canvasId <= 0) return

    const token = localStorage.getItem('mindmap_token')
    if (!token) return
    const user = useAuthStore.getState().user
    const userRole = (user as { role?: string })?.role
    const role: 'owner' | 'editor' | 'viewer' =
      userRole === 'viewer' ? 'viewer' : userRole === 'owner' ? 'owner' : 'editor'

    const provider = new MindMapYjsProvider(canvasId, {
      urlRoot: defaultWsUrlRoot(),
      token,
      tokenGetter: () => localStorage.getItem('mindmap_token'),
      role,
    })
    activeProviders.set(canvasId, provider)

    const binding = bindYjsToStore(provider, useCanvasStore.getState())
    setYjsBinding(binding)

    const onSyncedUnsub = provider.onSynced(() => {
      onRemoteChangeRef.current?.(canvasId)
    })

    const onKickedUnsub = provider.onKicked((reason) => {
      onKickedRef.current?.(reason)
    })

    let lastDirty = useCanvasStore.getState().isDirty
    const unsubDirty = useCanvasStore.subscribe((state) => {
      if (state.isDirty !== lastDirty) {
        lastDirty = state.isDirty
        if (state.isDirty) onRemoteChangeRef.current?.(canvasId)
      }
    })

    provider.connect()

    return () => {
      unsubDirty()
      onKickedUnsub()
      onSyncedUnsub()
      // Disconnect the provider FIRST so no new WebSocket messages arrive
      // while the binding is still attached. Otherwise remote updates could
      // fire the observer, call executeCommand with yjsBinding === null,
      // and incorrectly push remote commands into the local undo history.
      provider.disconnect()
      binding.destroy()
      setYjsBinding(null)
      activeProviders.delete(canvasId)
    }
  }, [canvasId, enabled])

  const sendCursor = useCallback((x: number, y: number) => {
    const provider = getActiveYjsProvider(canvasId)
    if (!provider) return
    provider.setLocalAwarenessField('cursor', { x, y })
  }, [canvasId])

  return {
    sendCursor,
    isConnected: () => isCollabConnected(canvasId),
  }
}
