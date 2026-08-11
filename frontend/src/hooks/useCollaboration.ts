import { useEffect, useRef, useCallback } from 'react'
import { useCanvasStore, setYjsBinding, getYjsBinding } from '@/store/useCanvasStore'
import { MindMapYjsProvider, defaultWsUrlRoot, type CanvasActiveUser } from '@/services/yjsProvider'
import { bindYjsToStore } from '@/services/yjsBinding'
import { useAuthStore } from '@/store/useAuthStore'
import { useProjectsStore } from '@/store/useProjectsStore'
import { apiClient } from '@/services/api'

const activeProviders = new Map<number, MindMapYjsProvider>()

// R5 #4: interactionMaxMs 此前从未被任何调用方透传,bindYjsToStore 的
// INTERACTION_MAX_MS 恒为默认值(死配置)。这里定义统一常量并通过 options
// 显式传入,让绑定层的交互超时兜底时长可被集中调整(默认 10s;长拖拽场景
// 或低性能设备可调大)。
const COLLAB_INTERACTION_MAX_MS = 10000

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
      userId: user?.id ?? null,
    })
    activeProviders.set(canvasId, provider)

    const binding = bindYjsToStore(provider, useCanvasStore.getState(), {
      interactionMaxMs: COLLAB_INTERACTION_MAX_MS,
    })
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
        // R2-4: 握手窗口内被本地删除的实体（store 中已不存在，正向循环收集不到）
        // 也记入集合——syncLocalEditsToYDoc 会从 doc 删除并声明，防止实体残留
        // doc、重连/重载后复活。批量替换（setCanvasData）已由上方 bulkLoadVersion
        // 守卫排除；clearCanvas 类清空不 bump bulkLoadVersion，但实体 id 为
        // 前缀+时间戳+随机串（generateId），跨画布 doc 无同 id 实体，doc 扫描
        // 找不到即无副作用。
        for (const id of prevState.nodes.keys()) {
          if (!state.nodes.has(id)) editedDuringHandshake.add(id)
        }
      }
      if (state.groups !== prevState.groups) {
        for (const [id, g] of state.groups) {
          const prev = prevState.groups.get(id)
          if (!prev || prev !== g) editedDuringHandshake.add(id)
        }
        for (const id of prevState.groups.keys()) {
          if (!state.groups.has(id)) editedDuringHandshake.add(id)
        }
      }
      if (state.domains !== prevState.domains) {
        for (const [id, d] of state.domains) {
          const prev = prevState.domains.get(id)
          if (!prev || prev !== d) editedDuringHandshake.add(id)
        }
        for (const id of prevState.domains.keys()) {
          if (!state.domains.has(id)) editedDuringHandshake.add(id)
        }
      }
      if (state.connections !== prevState.connections) {
        for (const [id, c] of state.connections) {
          const prev = prevState.connections.get(id)
          if (!prev || prev !== c) editedDuringHandshake.add(id)
        }
        for (const id of prevState.connections.keys()) {
          if (!state.connections.has(id)) editedDuringHandshake.add(id)
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
        // R2-4: 握手窗口内的本地编辑/删除先写回 doc。applyDiff 在 STEP2 前丢弃
        // store→doc diff，syncLocalStateToYDoc 又只补缺失实体——对已存在实体的
        // 编辑/删除会永远上不了行。syncLocalEditsToYDoc 在 doc→store 镜像之前
        // 执行：被删实体先从 doc 删除并声明（recordLocalDeletion），下方
        // syncYDocToLocalState 的 C14 守卫（isLocalDeletion → 跳过）就不会把
        // 已声明删除的实体重新加回 store（防止瞬时复活）。
        if (isFirstSync && editedDuringHandshake.size > 0) {
          binding.syncLocalEditsToYDoc(editedDuringHandshake)
        }
        // If the server doc is empty but the local store still has entities,
        // syncYDocToLocalState already mirrors local state back into the doc
        // and returns true; skip the redundant syncLocalStateToYDoc() call.
        const emptyDocMirrored = binding.syncYDocToLocalState({
          skipRemoval: isFirstSync,
          skipExistingUpdates: isFirstSync ? editedDuringHandshake : false,
        })
        if (isFirstSync) {
          if (!emptyDocMirrored) {
            binding.syncLocalStateToYDoc()
          }
          isFirstSync = false
        }
      }
      // M8: 缩略图只由本地编辑（isDirty）驱动——自动保存 tick 在协作分支
      // 里生成缩略图后清 dirty。远端变更（applyRemote*）不置 dirty（见
      // yjsBinding），因此不会触发缩略图；每次同步/重连也不生成，避免
      // 双端竞速 PUT 造成 409 风暴。
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

    // M8: 缩略图由本地编辑 / 自动保存路径驱动。远端变更在 yjsBinding 的
    // applyRemote* 中以 markDirty=false 应用（不置 isDirty），因此不会触发
    // 缩略图生成——否则协作双方会互相触发 PUT，产生 409 风暴。

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
