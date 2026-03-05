// User types
export interface User {
  id: number
  email: string
  nickname: string | null
  avatar: string | null
  createdAt: string
  updatedAt: string
}

// Auth types
export interface LoginCredentials {
  email: string
  password: string
}

export interface RegisterData {
  email: string
  password: string
  nickname?: string
}

export interface AuthResponse {
  user: User
  token: string
}

// Project types
export interface Project {
  id: number
  name: string
  description: string | null
  ownerId: number
  groupId: number | null
  thumbnail: string | null
  isPublic: boolean
  createdAt: string
  updatedAt: string
}

// Folder types
export interface Folder {
  id: number
  name: string
  projectId: number
  parentId: number | null
  sortOrder: number
  createdAt: string
  children?: Folder[]
}

// Canvas types
export interface Canvas {
  id: number
  name: string
  projectId: number
  folderId: number | null
  thumbnail: string | null
  sortOrder: number
  createdAt: string
  updatedAt: string
  previewText?: string
  tempId?: number
}

// Node types
export interface Node {
  id: string
  x: number
  y: number
  width: number
  height: number
  title: string       // 节点标题
  content: string     // 节点文本内容
  color?: string
  fontSize: number
  textAlign: 'left' | 'center' | 'right'  // 统一对齐（向后兼容）
  titleAlign?: 'left' | 'center' | 'right'  // 标题对齐
  collapsedTitleAlign?: 'left' | 'center' | 'right'  // 折叠状态标题对齐
  contentAlign?: 'left' | 'center' | 'right'  // 内容对齐
  collapsed: boolean
  locked: boolean
  expandedHeight?: number  // 保存展开时的高度
  type?: 'text' | 'image'  // 节点类型
  imageUrl?: string        // 图片URL
  aspectRatio?: number     // 图片宽高比
}

// Group types
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

// Domain types
export interface Domain {
  id: string
  name: string
  x: number
  y: number
  width: number
  height: number
  backgroundColor: string
  titleVisible: boolean
  titleColor?: string
  titleFontSize?: number
  titleScale?: number
}

// Connection types
export interface ConnectionBendPoint {
  id: string
  x: number
  y: number
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
  direction: 'directed' | 'bidirectional' | 'undirected'
  label?: string
  bendPoints?: ConnectionBendPoint[]
}

// Node Pool types
export interface NodeCard {
  id: number
  projectId: number
  name: string
  content: string
  type: string
  color: string
  tags: string | null
  useCount: number
  createdBy: number
  createdAt: string
  folderId?: number | null
  description?: string | null
  thumbnail?: string | null
  sortOrder: number
  // Internal unique identifier for drag operations (not persisted)
  _uniqueId?: string
  // Internal deletion flag for temporary cards (not persisted)
  _markedForDeletion?: boolean
}

// Node Pool Folder types
export interface NodePoolFolder {
  id: number
  projectId: number
  name: string
  parentId: number | null
  sortOrder: number
  collapsed: boolean
  createdAt: string
  children?: NodePoolFolder[]
}

// Node Pool sorting types
export type NodePoolSortOption = 'name' | 'createdAt' | 'useCount'
export type NodePoolSortOrder = 'asc' | 'desc'

// Group (Organization) types
export interface OrgGroup {
  id: number
  name: string
  description: string | null
  ownerId: number
  inviteCode: string
  createdAt: string
}

export interface GroupMember {
  id: number
  groupId: number
  userId: number
  role: 'owner' | 'admin' | 'member'
  joinedAt: string
  user?: User
}

// Project member types
export interface ProjectMember {
  id: number
  projectId: number
  userId: number
  role: 'owner' | 'editor' | 'viewer'
  joinedAt: string
  user?: User
}

// Canvas state for Yjs
export interface CanvasState {
  nodes: Map<string, Node>
  groups: Map<string, NodeGroup>
  domains: Map<string, Domain>
  connections: Map<string, Connection>
}

// Awareness data
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

// Tool types
export type Tool = 'select' | 'pan' | 'node' | 'image' | 'domain' | 'group' | 'connection'

// View modes
export type DragMode = 'free' | 'grid'

// Theme types
export type Theme = 'light' | 'dark' | 'system'

// Context menu types
export interface ContextMenuPosition {
  x: number
  y: number
}

export interface ContextMenuItem {
  label: string
  icon?: string
  action: () => void
  shortcut?: string
  disabled?: boolean
  divider?: boolean
}

// Toast types
export interface Toast {
  id: string
  type: 'success' | 'error' | 'warning' | 'info'
  title: string
  message?: string
  duration?: number
  priority?: number
}

export interface ToastOptions {
  type: Toast['type']
  title: string
  message?: string
  duration?: number
  priority?: number
}

// API Response types
export interface ApiResponse<T = any> {
  success: boolean
  data?: T
  error?: string
  message?: string
}

export interface PaginatedResponse<T> {
  data: T[]
  total: number
  page: number
  pageSize: number
}

// Search types
export interface SearchResult {
  type: 'node' | 'group' | 'canvas'
  id: string
  canvasId: number
  canvasName: string
  title: string
  preview: string
  score: number
}

export interface TextNodeDefaults {
  width: number
  height: number
  color: string
  fontSize: number
  titleAlign: 'left' | 'center' | 'right'
  collapsedTitleAlign: 'left' | 'center' | 'right'
  contentAlign: 'left' | 'center' | 'right'
}

export interface ImageNodeDefaults {
  width: number
  height: number
  fontSize: number
  titleAlign: 'left' | 'center' | 'right'
  collapsedTitleAlign: 'left' | 'center' | 'right'
}

export type NodeDefaults = {
  textNode: TextNodeDefaults
  imageNode: ImageNodeDefaults
}

// ============ API Response Types ============
// These types eliminate the need for 'any' in API calls

// Auth API Responses
export interface AuthApiResponse {
  user: User
  token: string
}

// User API Responses
export interface UserApiResponse {
  success: boolean
  data: User
}

export interface UploadAvatarResponse {
  success: boolean
  data: {
    avatar: string
  }
}

export interface ChangePasswordResponse {
  success: boolean
  data: {
    message: string
  }
}

export interface DeleteAccountResponse {
  success: boolean
  data: {
    message: string
  }
}

export interface UploadImageResponse {
  success: boolean
  data: {
    url: string
    filename: string
    mimetype: string
    size: number
  }
}

// Project API Responses
export interface ProjectsApiResponse {
  success: boolean
  data: Project[]
}

export interface ProjectApiResponse {
  success: boolean
  data: Project
}

export interface CreateProjectApiResponse {
  success: boolean
  data: Project
}

export interface UpdateProjectApiResponse {
  success: boolean
  data: Project
}

export interface DeleteProjectApiResponse {
  success: boolean
  data: {
    message: string
  }
}

// Canvas API Responses
export interface CanvasesApiResponse {
  success: boolean
  data: Canvas[]
}

export interface CanvasApiResponse {
  success: boolean
  data: Canvas & {
    yjsData?: string
  }
}

export interface CreateCanvasApiResponse {
  success: boolean
  data: Canvas
}

export interface UpdateCanvasApiResponse {
  success: boolean
  data: Canvas
}

export interface DeleteCanvasApiResponse {
  success: boolean
  data: {
    message: string
  }
}

export interface SaveCanvasDataApiResponse {
  success: boolean
  data: {
    message: string
  }
}

export interface CanvasNodesData {
  nodes: Node[]
  groups: NodeGroup[]
  domains: Domain[]
  connections: Connection[]
  drawings?: unknown[]
}

export interface LoadCanvasNodesDataApiResponse {
  success: boolean
  data: CanvasNodesData | null
}

// Folder API Responses
export interface FoldersApiResponse {
  success: boolean
  data: Folder[]
}

export interface CreateFolderApiResponse {
  success: boolean
  data: Folder
}

export interface UpdateFolderApiResponse {
  success: boolean
  data: Folder
}

export interface DeleteFolderApiResponse {
  success: boolean
  data: {
    message: string
  }
}

// Node Pool API Responses
export interface NodePoolApiResponse {
  success: boolean
  data: NodeCard[]
}

export interface AddNodePoolApiResponse {
  success: boolean
  data: NodeCard
}

export interface UpdateNodeCardApiResponse {
  success: boolean
  data: NodeCard
}

export interface IncrementUseCountApiResponse {
  success: boolean
  data: NodeCard
}

export interface RemoveNodePoolApiResponse {
  success: boolean
  data: {
    message: string
  }
}

export interface NodePoolFoldersApiResponse {
  success: boolean
  data: NodePoolFolder[]
}

export interface CreateNodePoolFolderApiResponse {
  success: boolean
  data: NodePoolFolder
}

export interface UpdateNodePoolFolderApiResponse {
  success: boolean
  data: NodePoolFolder
}

export interface DeleteNodePoolFolderApiResponse {
  success: boolean
  data: {
    message: string
  }
}

// User Settings API Responses
export interface NodeDefaultsApiResponse {
  success: boolean
  data: NodeDefaults
}

export interface UpdateNodeDefaultsApiResponse {
  success: boolean
  data: NodeDefaults
}

