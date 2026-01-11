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
  ApiResponse,
} from '@/types'
import { API_ENDPOINTS } from '@/constants'

// Get API base URL from environment
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000'

// API client with authentication
class ApiClient {
  private token: string | null = null

  setToken(token: string | null) {
    this.token = token
    if (token) {
      localStorage.setItem('mindmap_token', token)
    } else {
      localStorage.removeItem('mindmap_token')
    }
  }

  getToken(): string | null {
    if (!this.token) {
      this.token = localStorage.getItem('mindmap_token')
    }
    return this.token
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const token = this.getToken()
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...options.headers,
    }

    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      ...options,
      headers,
    })

    const data: ApiResponse<T> = await response.json()

    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Request failed')
    }

    return data.data as T
  }

  private async requestFormData<T>(
    endpoint: string,
    formData: FormData
  ): Promise<T> {
    const token = this.getToken()
    const headers: HeadersInit = {}

    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers,
      body: formData,
    })

    const data: ApiResponse<T> = await response.json()

    if (!response.ok || !data.success) {
      throw new Error(data.error || 'Request failed')
    }

    return data.data as T
  }
}

// Auth API
export async function register(data: RegisterData): Promise<AuthResponse> {
  const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.AUTH_REGISTER}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  const result: ApiResponse<AuthResponse> = await response.json()
  if (!result.success) throw new Error(result.error || 'Registration failed')
  return result.data!
}

export async function login(credentials: LoginCredentials): Promise<AuthResponse> {
  const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.AUTH_LOGIN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  })
  const result: ApiResponse<AuthResponse> = await response.json()
  if (!result.success) throw new Error(result.error || 'Login failed')
  return result.data!
}

export async function logout(): Promise<void> {
  await fetch(`${API_BASE_URL}${API_ENDPOINTS.AUTH_LOGOUT}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
  })
  localStorage.removeItem('mindmap_token')
}

export async function refreshToken(): Promise<AuthResponse> {
  const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.AUTH_REFRESH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
  })
  const result: ApiResponse<AuthResponse> = await response.json()
  if (!result.success) throw new Error(result.error || 'Token refresh failed')
  return result.data!
}

// User API
export async function getProfile(): Promise<User> {
  const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.USER_PROFILE}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
  })
  const result: ApiResponse<User> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to fetch profile')
  return result.data!
}

export async function updateProfile(data: Partial<User>): Promise<User> {
  const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.USER_PROFILE}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
    body: JSON.stringify(data),
  })
  const result: ApiResponse<User> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to update profile')
  return result.data!
}

export async function uploadAvatar(file: File): Promise<{ avatar: string }> {
  const formData = new FormData()
  formData.append('avatar', file)
  const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.USER_AVATAR}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
    body: formData,
  })
  const result: ApiResponse<{ avatar: string }> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to upload avatar')
  return result.data!
}

export async function changePassword(data: {
  currentPassword: string
  newPassword: string
}): Promise<{ message: string }> {
  const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.USER_PASSWORD}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
    body: JSON.stringify(data),
  })
  const result: ApiResponse<{ message: string }> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to change password')
  return result.data!
}

export async function deleteAccount(data: {
  password: string
  confirmation: string
}): Promise<{ message: string }> {
  const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.USER_DELETE_ACCOUNT}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
    body: JSON.stringify(data),
  })
  const result: ApiResponse<{ message: string }> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to delete account')
  return result.data!
}

export async function uploadImage(file: File): Promise<{ url: string, filename: string, mimetype: string, size: number }> {
  const formData = new FormData()
  formData.append('image', file)
  const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.UPLOAD}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
    body: formData,
  })
  const result: ApiResponse<{ url: string, filename: string, mimetype: string, size: number }> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to upload image')
  return result.data!
}

// Projects API
export async function getProjects(): Promise<Project[]> {
  const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.PROJECTS}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
  })
  const result: ApiResponse<Project[]> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to fetch projects')
  return result.data!
}

export async function getProject(id: number): Promise<Project> {
  const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.PROJECT_BY_ID(id)}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
  })
  const result: ApiResponse<Project> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to fetch project')
  return result.data!
}

export async function createProject(
  data: Omit<Project, 'id' | 'createdAt' | 'updatedAt'>
): Promise<Project> {
  const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.PROJECTS}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
    body: JSON.stringify(data),
  })
  const result: ApiResponse<Project> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to create project')
  return result.data!
}

export async function updateProject(id: number, data: Partial<Project>): Promise<Project> {
  const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.PROJECT_BY_ID(id)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
    body: JSON.stringify(data),
  })
  const result: ApiResponse<Project> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to update project')
  return result.data!
}

export async function deleteProject(id: number): Promise<void> {
  const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.PROJECT_BY_ID(id)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(errorText || `HTTP error! status: ${response.status}`)
  }

  const result: ApiResponse<void> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to delete project')
}

// Canvases API
export async function getCanvases(projectId: number): Promise<Canvas[]> {
  const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.CANVASES(projectId)}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
  })
  const result: ApiResponse<Canvas[]> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to fetch canvases')
  return result.data!
}

export async function getCanvas(id: number): Promise<Canvas & { yjsData?: string }> {
  const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.CANVAS_DETAIL(id)}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
  })
  const result: ApiResponse<Canvas & { yjsData?: string }> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to fetch canvas')
  return result.data!
}

export async function createCanvas(
  projectId: number,
  data: Partial<Canvas>
): Promise<Canvas> {
  const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.CANVASES(projectId)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
    body: JSON.stringify(data),
  })
  const result: ApiResponse<Canvas> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to create canvas')
  return result.data!
}

export async function updateCanvas(id: number, data: Partial<Canvas>): Promise<Canvas> {
  const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.CANVAS_BY_ID(id)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
    body: JSON.stringify(data),
  })
  const result: ApiResponse<Canvas> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to update canvas')
  return result.data!
}

export async function deleteCanvas(id: number): Promise<void> {
  const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.CANVAS_BY_ID(id)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(errorText || `HTTP error! status: ${response.status}`)
  }

  const result: ApiResponse<void> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to delete canvas')
}

export async function saveCanvasData(id: number, yjsData: Uint8Array): Promise<void> {
  const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.CANVAS_BY_ID(id)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
    body: yjsData as any,
  })
  const result: ApiResponse<void> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to save canvas data')
}

/**
 * Save canvas nodes data as JSON (for auto-save feature)
 * Stores the data in yjsData field as a JSON string in base64 encoding
 */
export async function saveCanvasNodesData(id: number, nodesData: {
  nodes: any[]
  groups: any[]
  domains: any[]
  connections: any[]
  drawings?: any[]
}): Promise<void> {
  // Convert to JSON and encode as base64 to store in yjsData field
  // Use proper UTF-8 encoding to handle Unicode characters (like Chinese)
  const jsonString = JSON.stringify(nodesData)
  const utf8Bytes = new TextEncoder().encode(jsonString)
  const binaryString = Array.from(utf8Bytes, byte => String.fromCharCode(byte)).join('')
  const base64Data = btoa(binaryString)

  const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.CANVAS_BY_ID(id)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
    body: JSON.stringify({ yjsData: base64Data }),
  })

  const result: ApiResponse<Canvas> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to save canvas nodes data')
}

/**
 * Load canvas nodes data from yjsData field
 * Returns null if there's an error loading from database
 * Returns empty object if canvas exists but has no data
 */
export async function loadCanvasNodesData(id: number): Promise<{
  nodes: any[]
  groups: any[]
  domains: any[]
  connections: any[]
  drawings?: any[]
} | null> {
  try {
    const canvas = await getCanvas(id)
    const yjsData = (canvas as any).yjsData

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
  const response = await fetch(
    `${API_BASE_URL}${API_ENDPOINTS.CANVASES(projectId)}/folders`,
    {
      headers: {
        Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
      },
    }
  )
  const result: ApiResponse<Folder[]> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to fetch folders')
  return result.data!
}

export async function createFolder(
  projectId: number,
  data: Omit<Folder, 'id' | 'createdAt'>
): Promise<Folder> {
  const response = await fetch(
    `${API_BASE_URL}${API_ENDPOINTS.CANVASES(projectId)}/folders`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
      },
      body: JSON.stringify(data),
    }
  )
  const result: ApiResponse<Folder> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to create folder')
  return result.data!
}

export async function updateFolder(id: number, data: Partial<Folder>): Promise<Folder> {
  const response = await fetch(`${API_BASE_URL}/api/canvases/folders/${id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
    body: JSON.stringify(data),
  })
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(errorText || `HTTP error! status: ${response.status}`)
  }
  const result: ApiResponse<Folder> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to update folder')
  return result.data!
}

export async function deleteFolder(id: number): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/canvases/folders/${id}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
  })
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(errorText || `HTTP error! status: ${response.status}`)
  }
  const result: ApiResponse<void> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to delete folder')
}

// Node Pool API
export async function getNodePool(projectId: number): Promise<NodeCard[]> {
  const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.NODE_POOL(projectId)}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
  })
  const result: ApiResponse<NodeCard[]> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to fetch node pool')
  return result.data!
}

export async function addToNodePool(
  projectId: number,
  data: Omit<NodeCard, 'id' | 'createdAt' | 'useCount'>
): Promise<NodeCard> {
  const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.NODE_POOL(projectId)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
    body: JSON.stringify(data),
  })
  const result: ApiResponse<NodeCard> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to add to node pool')
  return result.data!
}

export async function removeFromNodePool(id: number): Promise<void> {
  const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.NODE_POOL_DELETE(id)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
  })
  const result: ApiResponse<void> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to remove from node pool')
}

export async function updateNodeCard(id: number, data: Partial<NodeCard>): Promise<NodeCard> {
  const response = await fetch(`${API_BASE_URL}/api/projects/node-pool/${id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
    body: JSON.stringify(data),
  })
  const result: ApiResponse<NodeCard> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to update node card')
  return result.data!
}

export async function incrementNodeCardUseCount(id: number): Promise<NodeCard> {
  const response = await fetch(`${API_BASE_URL}/api/projects/node-pool/${id}/increment-use`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
  })
  const result: ApiResponse<NodeCard> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to increment use count')
  return result.data!
}

// Node Pool Folders API
export async function getNodePoolFolders(projectId: number): Promise<NodePoolFolder[]> {
  const response = await fetch(`${API_BASE_URL}/api/projects/${projectId}/node-pool-folders`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
  })
  const result: ApiResponse<NodePoolFolder[]> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to fetch node pool folders')
  return result.data!
}

export async function createNodePoolFolder(
  projectId: number,
  data: Omit<NodePoolFolder, 'id' | 'createdAt' | 'children'>
): Promise<NodePoolFolder> {
  const response = await fetch(`${API_BASE_URL}/api/projects/${projectId}/node-pool-folders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
    body: JSON.stringify(data),
  })
  const result: ApiResponse<NodePoolFolder> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to create node pool folder')
  return result.data!
}

export async function updateNodePoolFolder(id: number, data: Partial<NodePoolFolder>): Promise<NodePoolFolder> {
  const response = await fetch(`${API_BASE_URL}/api/projects/node-pool-folders/${id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
    body: JSON.stringify(data),
  })
  const result: ApiResponse<NodePoolFolder> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to update node pool folder')
  return result.data!
}

export async function deleteNodePoolFolder(id: number): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/projects/node-pool-folders/${id}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${localStorage.getItem('mindmap_token')}`,
    },
  })
  const result: ApiResponse<void> = await response.json()
  if (!result.success) throw new Error(result.error || 'Failed to delete node pool folder')
}
