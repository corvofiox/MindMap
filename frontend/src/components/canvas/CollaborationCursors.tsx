import type { AwarenessState } from '@/types'
import { useAuthStore } from '@/store/useAuthStore'

interface CollaborationCursorsProps {
  cursors: Map<number, AwarenessState>
  zoom: number
  panX: number
  panY: number
}

export function CollaborationCursors({ cursors, zoom, panX, panY }: CollaborationCursorsProps) {
  const { user: currentUser } = useAuthStore()

  if (!cursors || cursors.size === 0) return null

  return (
    <svg className="absolute inset-0 pointer-events-none">
      {Array.from(cursors.entries()).map(([userId, state]) => {
        // Skip current user
        if (currentUser && userId === currentUser.id) return null

        const { cursor, user } = state
        if (!cursor || !user) return null

        // Transform canvas coordinates to screen coordinates
        const x = cursor.x * zoom + panX
        const y = cursor.y * zoom + panY

        return (
          <g key={userId} data-collab-cursor={String(userId)} transform={`translate(${x}, ${y})`}>
            {/* Cursor pointer */}
            <path
              d="M 0 0 L 16 12 L 10 14 L 8 20 L 0 0"
              fill={user.color}
              stroke="white"
              strokeWidth="1"
            />
            {/* User name label */}
            <text
              x={16}
              y={-4}
              fill={user.color}
              fontSize="12"
              fontWeight="500"
              className="select-none"
            >
              {user.name}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

interface RemoteSelectionProps {
  selections: Map<number, AwarenessState>
  nodes: Map<string, { x: number; y: number; width: number; height: number }>
  zoom: number
  panX: number
  panY: number
}

export function RemoteSelection({ selections, nodes, zoom, panX, panY }: RemoteSelectionProps) {
  const { user: currentUser } = useAuthStore()

  if (!selections || selections.size === 0) return null

  return (
    <svg className="absolute inset-0 pointer-events-none">
      {Array.from(selections.entries()).map(([userId, state]) => {
        // Skip current user
        if (currentUser && userId === currentUser.id) return null

        const { selection, user } = state
        if (!selection || selection.length === 0 || !user) return null

        return (
          <g key={userId}>
            {selection.map((nodeId) => {
              const node = nodes.get(nodeId)
              if (!node) return null

              const x = node.x * zoom + panX
              const y = node.y * zoom + panY
              const width = node.width * zoom
              const height = node.height * zoom

              return (
                <rect
                  key={nodeId}
                  data-collab-selection={nodeId}
                  x={x}
                  y={y}
                  width={width}
                  height={height}
                  fill="none"
                  stroke={user.color}
                  strokeWidth={2}
                  strokeDasharray="5,5"
                  rx={4}
                  opacity={0.6}
                />
              )
            })}
          </g>
        )
      })}
    </svg>
  )
}

interface UserAvatarsProps {
  users: Array<{ id: number; name: string; color: string; avatar: string | null }>
}

export function UserAvatars({ users }: UserAvatarsProps) {
  if (!users || users.length === 0) return null

  return (
    <div className="absolute top-4 right-4 flex flex-col gap-2" data-collab-avatars="true">
      {users.map((user) => (
        <div
          key={user.id}
          data-collab-avatar={String(user.id)}
          className="flex items-center gap-2 px-3 py-2 rounded-lg glass-panel"
        >
          {user.avatar ? (
            <img
              src={user.avatar}
              alt={user.name}
              className="w-6 h-6 rounded-full"
            />
          ) : (
            <div
              className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium text-white"
              style={{ backgroundColor: user.color }}
            >
              {user.name.charAt(0).toUpperCase()}
            </div>
          )}
          <span className="text-sm font-medium">{user.name}</span>
        </div>
      ))}
    </div>
  )
}
