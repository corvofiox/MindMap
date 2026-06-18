import { useEffect, useRef, useCallback } from 'react'
import { useCanvasStore, setYjsBinding, getYjsBinding } from '@/store/useCanvasStore'
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

    // Restore saved awareness state (cursor/selection/editingId) from before
    // disconnect, if this is a reconnection. The saved state is applied to the
    // new provider's awareness before connect(), so when sendLocalAwareness()
    // fires automatically after sync completes, the restored state is broadcast
    // to peers immediately — no 'invisible cursor' gap after reconnect.
    const savedAwareness = MindMapYjsProvider.savedAwarenessStates.get(canvasId)
    if (savedAwareness) {
      for (const [key, value] of Object.entries(savedAwareness)) {
        provider.setLocalAwarenessField(key, value)
      }
      MindMapYjsProvider.savedAwarenessStates.delete(canvasId)
    }

    const onSyncedUnsub = provider.onSynced(() => {
      onRemoteChangeRef.current?.(canvasId)
    })

    const onKickedUnsub = provider.onKicked((reason) => {
      onKickedRef.current?.(reason)
    })

    // Listen for local role changes (viewer↔editor). When the server
    // broadcasts a user-role-changed event for the local user, update the
    // provider so wireLocalDocUpdates dynamically adjusts whether it
    // forwards doc mutations.
    const localUserId = user?.id ?? null
    const onRoleChangeUnsub = provider.onRoleChange((userId, role) => {
      if (localUserId !== null && userId === localUserId) {
        provider.setRole(role === 'viewer' ? 'viewer' : 'editor')
      }
    })

    let lastDirty = useCanvasStore.getState().isDirty
    const unsubDirty = useCanvasStore.subscribe((state) => {
      if (state.isDirty !== lastDirty) {
        lastDirty = state.isDirty
        if (state.isDirty) {
          // Only trigger onRemoteChange for remote-originated dirty changes.
          // The Yjs binding sets isApplyingRemoteChanges=true during observer
          // replay (synchronous within Zustand set()), so we can check it here.
          // Local edits get thumbnails via the auto-save path instead.
          const binding = getYjsBinding()
          if (binding?.isApplyingRemoteChanges) {
            onRemoteChangeRef.current?.(canvasId)
          }
        }
      }
    })

    provider.connect()

    return () => {
      unsubDirty()
      onRoleChangeUnsub()
      onKickedUnsub()
      onSyncedUnsub()
      // Clear store binding reference first so any subsequent store mutation
      // that calls syncDiffToYDoc becomes a no-op before we touch the Y.Doc.
      setYjsBinding(null)
      // Then detach all Y.Doc observers so no callbacks fire on a destroyed doc.
      binding.destroy()
      // Finally disconnect (which internally destroys the Y.Doc and awareness).
      provider.disconnect()
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
