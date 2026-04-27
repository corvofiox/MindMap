// Shared types between frontend and backend
export * from './constants.js'

export interface APIResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  message?: string
}

export interface User {
  id: number
  email: string
  nickname: string | null
  avatar: string | null
  created_at: string
  updated_at: string
}

export interface Project {
  id: number
  name: string
  description: string | null
  owner_id: number
  group_id: number | null
  thumbnail: string | null
  is_public: boolean
  created_at: string
  updated_at: string
}

export interface Canvas {
  id: number
  name: string
  project_id: number
  folder_id: number | null
  yjs_data?: string
  preview_text?: string
  thumbnail: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

export interface Node {
  id: string
  x: number
  y: number
  width: number
  height: number
  content: string
  color: string
  borderColor: string
  borderWidth: number
  borderRadius: number
  imageUrl?: string
  fontSize: number
  textAlign: 'left' | 'center' | 'right'
  collapsed: boolean
  locked: boolean
}

export interface NodeGroup {
  id: string
  name: string
  description?: string
  x: number
  y: number
  width: number
  height: number
  borderColor: string
  backgroundColor: string
  borderWidth: number
  borderRadius: number
  nodeIds: string[]
  collapsed: boolean
}

export interface Domain {
  id: string
  name: string
  x: number
  y: number
  width: number
  height: number
  backgroundColor: string
  titleVisible: boolean
}

export interface Connection {
  id: string
  fromNodeId: string
  toNodeId: string
  fromPort: 'top' | 'right' | 'bottom' | 'left'
  toPort: 'top' | 'right' | 'bottom' | 'left'
  type: 'straight' | 'curve' | 'step'
  style: 'solid' | 'dashed' | 'dotted'
  color: string
  width: number
  arrowType: 'none' | 'start' | 'end' | 'both'
  label?: string
}

// WebSocket message types
export interface WSMessage {
  type: 'connected' | 'sync' | 'update' | 'awareness'
  data?: unknown
  canvasId?: number
  userId?: number
  senderId?: number
}

export interface AwarenessUserData {
  id: number
  name: string
  color: string
  avatar: string | null
}

export interface AwarenessState {
  user: AwarenessUserData
  cursor?: { x: number; y: number }
  selection?: string[]
  isEditing?: string
}

// Re-export constants
export * from './constants.js'
