import { useEffect, useRef, useCallback } from 'react'
import { useCanvasStore, setYjsBinding, getYjsBinding } from '@/store/useCanvasStore'
import { MindMapYjsProvider, defaultWsUrlRoot, type CanvasActiveUser } from '@/services/yjsProvider'
import { bindYjsToStore } from '@/services/yjsBinding'
import { useAuthStore } from '@/store/useAuthStore'
import { useProjectsStore } from '@/store/useProjectsStore'
import { apiClient } from '@/services/api'

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
  onKicked?: (reason: string) => void
}

export function useCollaboration({
  canvasId,
  enabled = true,
  onKicked,
}: UseCollaborationOptions) {
  const onKickedRef = useRef(onKicked)
  onKickedRef.current = onKicked
  const currentMemberRole = useProjectsStore((state) => state.currentMemberRole)

  useEffect(() => {
    if (!enabled || !canvasId || canvasId <= 0) return

    const token = apiClient.getToken()
    if (!token) return
    const user = useAuthStore.getState().user
    // Use the project-scoped member role, not the global user.role. The global
    // role is not meaningful inside a project: a platform admin could be just a
    // viewer in someone else's project. If the role has not been loaded yet,
    // fall back to viewer to avoid writing before permissions are confirmed.
    const role: 'owner' | 'editor' | 'viewer' =
      currentMemberRole === 'owner'
        ? 'owner'
        : currentMemberRole === 'editor'
          ? 'editor'
          : 'viewer'

    const provider = new MindMapYjsProvider(canvasId, {
      urlRoot: defaultWsUrlRoot(),
      token,
      tokenGetter: () => apiClient.getToken(),
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
    // Reads from sessionStorage (per-tab) to avoid cross-tab contamination.
    let savedAwareness: Record<string, unknown> | null = null
    try {
      const raw = sessionStorage.getItem(`mindmap_awareness_${canvasId}`)
      if (raw) savedAwareness = JSON.parse(raw) as Record<string, unknown>
    } catch {
      // sessionStorage may throw, ignore
    }
    if (savedAwareness) {
      for (const [key, value] of Object.entries(savedAwareness)) {
        provider.setLocalAwarenessField(key, value)
      }
      try {
        sessionStorage.removeItem(`mindmap_awareness_${canvasId}`)
      } catch {
        // best-effort cleanup
      }
    }

    // Track entity IDs edited locally while the WebSocket handshake is in
    // flight. We compare each store update against the previous state and
    // ignore changes that originate from remote Yjs observers, so only local
    // mutations are recorded. These IDs are passed to syncYDocToLocalState
    // on the first sync to avoid overwriting in-flight local edits with the
    // server snapshot, while still applying server updates to all other
    // entities.
    type CanvasState = ReturnType<typeof useCanvasStore.getState>
    const editedDuringHandshake = new Set<string>()
    const collectEditedIds = (state: CanvasState, prevState: CanvasState) => {
      if (state.nodes !== prevState.nodes) {
        for (const [id, n] of state.nodes) {
          const prev = prevState.nodes.get(id)
          if (!prev || prev !== n) editedDuringHandshake.add(id)
        }
      }
      if (state.groups !== prevState.groups) {
        for (const [id, g] of state.groups) {
          const prev = prevState.groups.get(id)
          if (!prev || prev !== g) editedDuringHandshake.add(id)
        }
      }
      if (state.domains !== prevState.domains) {
        for (const [id, d] of state.domains) {
          const prev = prevState.domains.get(id)
          if (!prev || prev !== d) editedDuringHandshake.add(id)
        }
      }
      if (state.connections !== prevState.connections) {
        for (const [id, c] of state.connections) {
          const prev = prevState.connections.get(id)
          if (!prev || prev !== c) editedDuringHandshake.add(id)
        }
      }
    }

    let handshakeEditsUnsub: (() => void) | null = useCanvasStore.subscribe(
      (state, prevState) => {
        const binding = getYjsBinding()
        if (binding?.isApplyingRemoteChanges) return
        // Ignore bulk loads (API/cache restore) that replace the entire entity
        // map. Those create new object references for every entity and would
        // otherwise be misclassified as local edits during the handshake.
        if (
          (state as CanvasState).bulkLoadVersion !==
          (prevState as CanvasState).bulkLoadVersion
        ) {
          return
        }
        collectEditedIds(state as CanvasState, prevState as CanvasState)
      }
    )

    // isFirstSync guards syncLocalStateToYDoc: on reconnect the local store
    // may still contain entities that were deleted by peers while offline.
    // Re-writing the local store into the doc would resurrect those deletions.
    // syncYDocToLocalState is safe on every sync because it only adds entities
    // the server has but the store lacks.
    let isFirstSync = true
    const onSyncedUnsub = provider.onSynced(() => {
      const binding = getYjsBinding()
      if (binding) {
        // After STEP2 sync the server's root Y.Maps are now authoritative in
        // the local doc. Re-attach observers on those shared types, pull any
        // server-only entities into the store, and (only on the very first
        // connection for this binding) mirror API-loaded local state into the
        // doc so peers see it.
        binding.reconnectObservers()

        // We only need to track edits during the first handshake window.
        // After STEP2, remote observers will drive subsequent updates.
        if (handshakeEditsUnsub) {
          handshakeEditsUnsub()
          handshakeEditsUnsub = null
        }

        // On the first sync, skip removal so API-loaded data for a brand-new
        // canvas is not wiped, and skip refreshing only entities that were
        // edited locally while the handshake was in flight. On reconnects,
        // remove local entities deleted by peers and apply server updates
        // normally.
        binding.syncYDocToLocalState({
          skipRemoval: isFirstSync,
          skipExistingUpdates: isFirstSync ? editedDuringHandshake : false,
        })
        if (isFirstSync) {
          binding.syncLocalStateToYDoc()
          isFirstSync = false
        }
      }
      // Thumbnail generation is driven by the local edit / auto-save /
      // manual-save paths; firing it on every sync (including reconnects)
      // causes a storm of thumbnail PUTs and 409 Conflicts in collaboration
      // mode.
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

    // Thumbnails are generated from the local edit / auto-save path. We
    // intentionally do not trigger thumbnail generation on every remote dirty
    // change, because in collaboration mode both peers would otherwise race to
    // PUT the thumbnail and produce a storm of 409 Conflict responses.

    provider.connect()

    return () => {
      if (handshakeEditsUnsub) {
        handshakeEditsUnsub()
        handshakeEditsUnsub = null
      }
      onRoleChangeUnsub()
      onKickedUnsub()
      onSyncedUnsub()
      // Clear store binding reference first so any subsequent store mutation
      // that calls syncDiffToYDoc becomes a no-op before we touch the Y.Doc.
      // Guard: only null out if this binding is still the active one — prevent
      // race where a new canvas effect set YjsBinding between old cleanup runs.
      if (getYjsBinding() === binding) {
        setYjsBinding(null)
      }
      // Then detach all Y.Doc observers so no callbacks fire on a destroyed doc.
      binding.destroy()
      // Finally disconnect (which internally destroys the Y.Doc and awareness).
      provider.disconnect()
      // Guard: only delete from the shared Map if this cleanup owns the current
      // entry. This prevents a stale effect cleanup from evicting a newer
      // provider that replaced this one (e.g. rapid canvas switches or Strict
      // Mode double-mount races).
      if (activeProviders.get(canvasId) === provider) {
        activeProviders.delete(canvasId)
      }
    }
  }, [canvasId, enabled, currentMemberRole])

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
