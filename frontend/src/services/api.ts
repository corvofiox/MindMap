import type {
  User,
  LoginCredentials,
  RegisterData,
  Project,
  Canvas,
  Folder,
  NodeCard,
  NodePoolFolder,
  Node,
  NodeGroup,
  Domain,
  Connection,
  NodeDefaults,
} from '@/types'
import { API_ENDPOINTS } from '@/constants'
import { apiClient } from './apiClient.js'

// Export apiClient for use in auth store
export { apiClient }

// Import API response types
import type {
  AuthApiResponse,
  UploadAvatarResponse,
  ChangePasswordResponse,
  DeleteAccountResponse,
  UploadImageResponse,
} from '@/types'

// Auth API
export async function register(data: RegisterData): Promise<AuthApiResponse> {
  return await apiClient.post<AuthApiResponse>(API_ENDPOINTS.AUTH_REGISTER, data)
}

export async function login(credentials: LoginCredentials): Promise<AuthApiResponse> {
  return await apiClient.post<AuthApiResponse>(API_ENDPOINTS.AUTH_LOGIN, credentials)
}

export async function logout(): Promise<void> {
  try {
    await apiClient.post<void>(API_ENDPOINTS.AUTH_LOGOUT)
  } catch (error) {
    // Silently fail - no need to show error for logout
  } finally {
    apiClient.setToken(null)
  }
}

export async function refreshToken(): Promise<AuthApiResponse> {
  return await apiClient.post<AuthApiResponse>(API_ENDPOINTS.AUTH_REFRESH)
}

// User API
export async function getProfile(): Promise<User> {
  return await apiClient.get<User>(API_ENDPOINTS.USER_PROFILE)
}

export async function updateProfile(data: Partial<User>): Promise<User> {
  return await apiClient.put<User>(API_ENDPOINTS.USER_PROFILE, data)
}

export async function uploadAvatar(file: File): Promise<{ avatar: string }> {
  const formData = new FormData()
  formData.append('avatar', file)
  return await apiClient.post<{ avatar: string }>(API_ENDPOINTS.USER_AVATAR, formData)
}

export async function changePassword(data: {
  currentPassword: string
  newPassword: string
}): Promise<{ message: string }> {
  return await apiClient.put<{ message: string }>(API_ENDPOINTS.USER_PASSWORD, data)
}

export async function deleteAccount(data: {
  password: string
  confirmation: string
}): Promise<{ message: string }> {
  return await apiClient.delete<{ message: string }>(API_ENDPOINTS.USER_DELETE_ACCOUNT, data)
}

export async function searchUsers(query: string): Promise<User[]> {
  return await apiClient.get<User[]>(`${API_ENDPOINTS.USER_SEARCH}?q=${encodeURIComponent(query)}`)
}

export async function uploadImage(file: File): Promise<{ url: string, filename: string, mimetype: string, size: number }> {
  const formData = new FormData()
  formData.append('image', file)
  return await apiClient.post<{ url: string, filename: string, mimetype: string, size: number }>(API_ENDPOINTS.UPLOAD, formData)
}

// Projects API
export async function getProjects(): Promise<Project[]> {
  return await apiClient.get<Project[]>(API_ENDPOINTS.PROJECTS)
}

export async function getProject(id: number): Promise<Project> {
  return await apiClient.get<Project>(API_ENDPOINTS.PROJECT_BY_ID(id))
}

export async function createProject(
  data: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>
): Promise<Project> {
  return await apiClient.post<Project>(API_ENDPOINTS.PROJECTS, data)
}

export async function updateProject(id: number, data: Partial<Project>): Promise<Project> {
  return await apiClient.put<Project>(API_ENDPOINTS.PROJECT_BY_ID(id), data)
}

export async function deleteProject(id: number): Promise<void> {
  return await apiClient.delete<void>(API_ENDPOINTS.PROJECT_BY_ID(id))
}

// Canvases API
export async function getCanvases(projectId: number): Promise<Canvas[]> {
  return await apiClient.get<Canvas[]>(API_ENDPOINTS.CANVASES(projectId))
}

export async function getCanvas(id: number): Promise<Canvas & { yjsData?: string }> {
  return await apiClient.get<Canvas & { yjsData?: string }>(API_ENDPOINTS.CANVAS_DETAIL(id))
}

export async function createCanvas(
  projectId: number,
  data: Partial<Canvas>
): Promise<Canvas> {
  return await apiClient.post<Canvas>(API_ENDPOINTS.CANVASES(projectId), data)
}

export async function updateCanvas(id: number, data: Partial<Canvas>): Promise<Canvas> {
  return await apiClient.put<Canvas>(API_ENDPOINTS.CANVAS_BY_ID(id), data)
}

export async function deleteCanvas(id: number): Promise<void> {
  return await apiClient.delete<void>(API_ENDPOINTS.CANVAS_BY_ID(id))
}

export async function saveCanvasData(id: number, yjsData: Uint8Array): Promise<void> {
  return await apiClient.put<void>(API_ENDPOINTS.CANVAS_BY_ID(id), yjsData, 'application/octet-stream')
}

/**
 * Save canvas nodes data as JSON (for auto-save feature)
 * Stores the data in yjsData field as a JSON string in base64 encoding
 */
export async function saveCanvasNodesData(id: number, nodesData: {
  nodes: Node[]
  groups: NodeGroup[]
  domains: Domain[]
  connections: Connection[]
  drawings?: unknown[]
}): Promise<void> {
  // Convert to JSON and encode as base64 to store in yjsData field
  // Use proper UTF-8 encoding to handle Unicode characters (like Chinese)
  const jsonString = JSON.stringify(nodesData)
  const utf8Bytes = new TextEncoder().encode(jsonString)
  const binaryString = Array.from(utf8Bytes, byte => String.fromCharCode(byte)).join('')
  const base64Data = btoa(binaryString)

  return await apiClient.put<void>(API_ENDPOINTS.CANVAS_BY_ID(id), { yjsData: base64Data })
}

/**
 * Load canvas nodes data from yjsData field
 * Returns null if there's an error loading from database
 * Returns empty object if canvas exists but has no data
 */
export async function loadCanvasNodesData(id: number): Promise<{
  nodes: Node[]
  groups: NodeGroup[]
  domains: Domain[]
  connections: Connection[]
  drawings?: unknown[]
} | null> {
  try {
    const canvas = await getCanvas(id)
    const yjsData = (canvas as { yjsData?: string }).yjsData

    if (!yjsData) {
      return {
        nodes: [],
        groups: [],
        domains: [],
        connections: [],
        drawings: [],
      }
    }

    // Try to decode as base64 JSON
    try {
      // Decode base64 to binary string
      const binaryString = atob(yjsData)
      // Convert binary string to Uint8Array (UTF-8 bytes)
      const utf8Bytes = new Uint8Array(binaryString.length)
      for (let i = 0; i < binaryString.length; i++) {
        utf8Bytes[i] = binaryString.charCodeAt(i)
      }
      // Decode UTF-8 bytes to string
      const jsonString = new TextDecoder().decode(utf8Bytes)
      const data = JSON.parse(jsonString)

      // Check if it has the expected structure
      if (data.nodes || data.groups || data.domains || data.connections || data.drawings) {
        return {
          nodes: data.nodes || [],
          groups: data.groups || [],
          domains: data.domains || [],
          connections: data.connections || [],
          drawings: data.drawings || [],
        }
      } else {
        return {
          nodes: [],
          groups: [],
          domains: [],
          connections: [],
          drawings: [],
        }
      }
    } catch {
      return {
        nodes: [],
        groups: [],
        domains: [],
        connections: [],
        drawings: [],
      }
    }
  } catch {
    return null
  }
}

// Folders API
export async function getFolders(projectId: number): Promise<Folder[]> {
  return await apiClient.get<Folder[]>(`${API_ENDPOINTS.CANVASES(projectId)}/folders`)
}

export async function createFolder(
  projectId: number,
  data: Omit<Folder, 'id' | 'createdAt'>
): Promise<Folder> {
  return await apiClient.post<Folder>(`${API_ENDPOINTS.CANVASES(projectId)}/folders`, data)
}

export async function updateFolder(id: number, data: Partial<Folder>): Promise<Folder> {
  return await apiClient.put<Folder>(`/api/canvases/folders/${id}`, data)
}

export async function deleteFolder(id: number): Promise<void> {
  return await apiClient.delete<void>(`/api/canvases/folders/${id}`)
}

// Node Pool API (User-specific)
export async function getNodePool(): Promise<NodeCard[]> {
  return await apiClient.get<NodeCard[]>(API_ENDPOINTS.NODE_POOL)
}

export async function addToNodePool(
  data: Omit<NodeCard, 'id' | 'createdAt' | 'useCount' | 'userId' | 'createdBy'>
): Promise<NodeCard> {
  return await apiClient.post<NodeCard>(API_ENDPOINTS.NODE_POOL, data)
}

export async function removeFromNodePool(id: number): Promise<void> {
  return await apiClient.delete<void>(API_ENDPOINTS.NODE_POOL_DELETE(id))
}

export async function updateNodeCard(id: number, data: Partial<NodeCard>): Promise<NodeCard> {
  return await apiClient.put<NodeCard>(API_ENDPOINTS.NODE_POOL_UPDATE(id), data)
}

export async function incrementNodeCardUseCount(id: number): Promise<NodeCard> {
  return await apiClient.post<NodeCard>(API_ENDPOINTS.NODE_POOL_INCREMENT_USE(id))
}

// Node Pool Folders API (User-specific)
export async function getNodePoolFolders(): Promise<NodePoolFolder[]> {
  return await apiClient.get<NodePoolFolder[]>(API_ENDPOINTS.NODE_POOL_FOLDERS)
}

export async function createNodePoolFolder(
  data: Omit<NodePoolFolder, 'id' | 'createdAt' | 'children' | 'userId'>
): Promise<NodePoolFolder> {
  return await apiClient.post<NodePoolFolder>(API_ENDPOINTS.NODE_POOL_FOLDERS, data)
}

export async function updateNodePoolFolder(id: number, data: Partial<NodePoolFolder>): Promise<NodePoolFolder> {
  return await apiClient.put<NodePoolFolder>(API_ENDPOINTS.NODE_POOL_FOLDER_BY_ID(id), data)
}

export async function deleteNodePoolFolder(id: number): Promise<void> {
  return await apiClient.delete<void>(API_ENDPOINTS.NODE_POOL_FOLDER_BY_ID(id))
}

// AI Conversation API
interface ConversationMessage {
  id: string
  role: 'user' | 'assistant' | 'divider'
  content: string
  timestamp: number
  reasoningContent?: string
  hasToolCalls?: boolean
  toolExchangeMessages?: Array<Record<string, unknown>>
  isInterrupted?: boolean
}

interface ConversationData {
  messages: ConversationMessage[]
  contextDividerIndex: number
}

export async function getAIConversation(canvasId: number): Promise<ConversationData> {
  return await apiClient.get<ConversationData>(`/api/ai/conversation/${canvasId}`)
}

export async function saveAIConversation(canvasId: number, data: ConversationData): Promise<void> {
  await apiClient.post<void>(`/api/ai/conversation/${canvasId}`, data)
}

export async function deleteAIConversation(canvasId: number): Promise<void> {
  await apiClient.delete<void>(`/api/ai/conversation/${canvasId}`)
}

// User Settings API
export async function getNodeDefaults(): Promise<NodeDefaults> {
  return await apiClient.get<NodeDefaults>('/api/users/settings/node-defaults')
}

export async function updateNodeDefaults(data: NodeDefaults): Promise<NodeDefaults> {
  return await apiClient.put<NodeDefaults>('/api/users/settings/node-defaults', data)
}

// Collaboration API
export async function getProjectMembers(projectId: number): Promise<{
  members: import('@/types').ProjectMember[]
  invitations: import('@/types').ProjectInvitation[]
  ownerId: number
}> {
  return await apiClient.get(API_ENDPOINTS.COLLABORATION_PROJECT_MEMBERS(projectId))
}

export async function inviteUserToProject(projectId: number, userId: number, role: 'editor' | 'viewer' = 'viewer'): Promise<import('@/types').ProjectInvitation> {
  return await apiClient.post(API_ENDPOINTS.COLLABORATION_INVITE(projectId), { userId, role })
}

export async function getMyInvitations(): Promise<import('@/types').MyInvitation[]> {
  return await apiClient.get(API_ENDPOINTS.COLLABORATION_INVITATIONS)
}

export async function acceptInvitation(invitationId: number): Promise<{ message: string }> {
  return await apiClient.post(API_ENDPOINTS.COLLABORATION_ACCEPT(invitationId))
}

export async function rejectInvitation(invitationId: number): Promise<{ message: string }> {
  return await apiClient.post(API_ENDPOINTS.COLLABORATION_REJECT(invitationId))
}

export async function removeProjectMember(projectId: number, userId: number): Promise<{ message: string }> {
  return await apiClient.delete(API_ENDPOINTS.COLLABORATION_REMOVE_MEMBER(projectId, userId))
}

export async function cancelInvitation(invitationId: number): Promise<{ message: string }> {
  return await apiClient.delete(API_ENDPOINTS.COLLABORATION_CANCEL_INVITATION(invitationId))
}

export async function updateMemberRole(projectId: number, userId: number, role: 'editor' | 'viewer'): Promise<import('@/types').ProjectMember> {
  return await apiClient.put(API_ENDPOINTS.COLLABORATION_UPDATE_ROLE(projectId, userId), { role })
}
