import type {
  User,
  AuthResponse,
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
} from '@/types'
import { API_ENDPOINTS } from '@/constants'
import { apiClient } from './apiClient'

// Export apiClient for use in auth store
export { apiClient }

// Auth API
export async function register(data: RegisterData): Promise<AuthResponse> {
  return await apiClient.post<AuthResponse>(API_ENDPOINTS.AUTH_REGISTER, data)
}

export async function login(credentials: LoginCredentials): Promise<AuthResponse> {
  return await apiClient.post<AuthResponse>(API_ENDPOINTS.AUTH_LOGIN, credentials)
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

export async function refreshToken(): Promise<AuthResponse> {
  return await apiClient.post<AuthResponse>(API_ENDPOINTS.AUTH_REFRESH)
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
    } catch (e) {
      return {
        nodes: [],
        groups: [],
        domains: [],
        connections: [],
        drawings: [],
      }
    }
  } catch (error) {
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

// Node Pool API
export async function getNodePool(projectId: number): Promise<NodeCard[]> {
  return await apiClient.get<NodeCard[]>(API_ENDPOINTS.NODE_POOL(projectId))
}

export async function addToNodePool(
  projectId: number,
  data: Omit<NodeCard, 'id' | 'createdAt' | 'useCount'>
): Promise<NodeCard> {
  return await apiClient.post<NodeCard>(API_ENDPOINTS.NODE_POOL(projectId), data)
}

export async function removeFromNodePool(id: number): Promise<void> {
  return await apiClient.delete<void>(API_ENDPOINTS.NODE_POOL_DELETE(id))
}

export async function updateNodeCard(id: number, data: Partial<NodeCard>): Promise<NodeCard> {
  return await apiClient.put<NodeCard>(`/api/projects/node-pool/${id}`, data)
}

export async function incrementNodeCardUseCount(id: number): Promise<NodeCard> {
  return await apiClient.post<NodeCard>(`/api/projects/node-pool/${id}/increment-use`)
}

// Node Pool Folders API
export async function getNodePoolFolders(projectId: number): Promise<NodePoolFolder[]> {
  return await apiClient.get<NodePoolFolder[]>(`/api/projects/${projectId}/node-pool-folders`)
}

export async function createNodePoolFolder(
  projectId: number,
  data: Omit<NodePoolFolder, 'id' | 'createdAt' | 'children'>
): Promise<NodePoolFolder> {
  return await apiClient.post<NodePoolFolder>(`/api/projects/${projectId}/node-pool-folders`, data)
}

export async function updateNodePoolFolder(id: number, data: Partial<NodePoolFolder>): Promise<NodePoolFolder> {
  return await apiClient.put<NodePoolFolder>(`/api/projects/node-pool-folders/${id}`, data)
}

export async function deleteNodePoolFolder(id: number): Promise<void> {
  return await apiClient.delete<void>(`/api/projects/node-pool-folders/${id}`)
}
