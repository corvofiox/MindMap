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
import type { AuthApiResponse } from '@/types'

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

export interface UploadedFile {
  id: number
  sha256: string
  /** 短 URL（`/api/files/<sha256>`），可直接放进 <img src> */
  url: string
  filename: string
  mimetype: string
  size: number
  deduped: boolean
}

/**
 * 统一节点的图片来源：上传到内容寻址的文件服务，拿回短 URL。
 *
 * 与 `uploadImage` 的区别是关键的——后者返回 base64 data URL，会把节点正文
 * 撑成几 MB 的文本（见 docs/requirements-notebook.md §14.3）。新代码一律走这个。
 */
export async function uploadFile(file: File): Promise<UploadedFile> {
  const formData = new FormData()
  formData.append('image', file)
  return await apiClient.post<UploadedFile>(API_ENDPOINTS.UPLOAD_FILE, formData)
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

// data 允许带 clientVersion（P1：缩略图 PUT 版本检查），它不是 Canvas 字段，
// 仅作为传输层参数透传给后端 PUT /api/canvases/:id。
export async function updateCanvas(id: number, data: Partial<Canvas> & { clientVersion?: number }): Promise<Canvas> {
  return await apiClient.put<Canvas>(API_ENDPOINTS.CANVAS_BY_ID(id), data)
}

export async function deleteCanvas(id: number): Promise<void> {
  return await apiClient.delete<void>(API_ENDPOINTS.CANVAS_BY_ID(id))
}

/**
 * Load canvas nodes data.
 *
 * Post-Yjs-migration order of preference:
 *   1. `yjsUpdate` — Yjs binary state update (base64). Decode → Y.Doc → JSON.
 *   2. `yjsData`   — legacy JSON snapshot (base64). Decode → JSON directly.
 *   3. Empty — canvas has no data yet.
 *
 * Returns null if the canvas itself can't be fetched; returns an empty-shaped
 * object if the canvas exists but has no data.
 */
export async function loadCanvasNodesData(id: number): Promise<{
  nodes: Node[]
  groups: NodeGroup[]
  domains: Domain[]
  connections: Connection[]
  drawings?: unknown[]
  version: number
} | null> {
  const empty = {
    nodes: [],
    groups: [],
    domains: [],
    connections: [],
    drawings: [] as unknown[],
    version: 0,
  }
  try {
    const canvas = await getCanvas(id)
    const yjsUpdate = (canvas as { yjsUpdate?: string }).yjsUpdate
    const yjsData = (canvas as { yjsData?: string }).yjsData

    // Path 1: Yjs binary update.
    if (yjsUpdate) {
      try {
        const Y = await import('yjs')
        const { ensureRoot, ymapToObject } = await import('./yjs-schema')
        const bytes = Uint8Array.from(atob(yjsUpdate), (c) => c.charCodeAt(0))
        const doc = new Y.Doc()
        Y.applyUpdate(doc, bytes)
        const collections = ensureRoot(doc)
        const unwrap = (m: { entries: () => IterableIterator<[string, unknown]> }) =>
          Array.from(m.entries()).map(([, v]) => ymapToObject(v as never))
        const result = {
          nodes: unwrap(collections.nodes) as unknown as Node[],
          groups: unwrap(collections.groups) as unknown as NodeGroup[],
          domains: unwrap(collections.domains) as unknown as Domain[],
          connections: unwrap(collections.connections) as unknown as Connection[],
          drawings: [] as unknown[],
          version: 0,
        }
        doc.destroy()
        return result
      } catch {
        // Fall through to legacy path if Yjs decoding fails.
      }
    }

    // Path 2: legacy JSON snapshot.
    if (yjsData) {
      try {
        const binaryString = atob(yjsData)
        const utf8Bytes = new Uint8Array(binaryString.length)
        for (let i = 0; i < binaryString.length; i++) {
          utf8Bytes[i] = binaryString.charCodeAt(i)
        }
        const jsonString = new TextDecoder().decode(utf8Bytes)
        const data = JSON.parse(jsonString)

        if (data.nodes || data.groups || data.domains || data.connections || data.drawings) {
          return {
            nodes: data.nodes || [],
            groups: data.groups || [],
            domains: data.domains || [],
            connections: data.connections || [],
            drawings: data.drawings || [],
            version: typeof data.version === 'number' ? data.version : 0,
          }
        }
      } catch {
        // fall through to empty
      }
    }

    return empty
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

// AI Conversation / Provider API has been removed along with the built-in AI
// assistant. External agents now drive canvases over MCP (/mcp) using a personal
// access token — see services/personalAccessTokens.ts.

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

// ---- 笔记本（手稿）--------------------------------------------------------
// 账号私有、不协作：纯 REST，没有 Yjs/房间。

export interface ManuscriptSummary {
  id: number
  folderId: number | null
  title: string
  previewText: string | null
  imageCount: number
  /** 手动拖拽排序（同一文件夹内，越小越靠前） */
  sortOrder?: number
  createdAt: number | null
  updatedAt: number | null
}

export interface Manuscript extends ManuscriptSummary {
  contentHtml: string
  sourceCardId: number | null
}

export interface ManuscriptFolder {
  id: number
  userId: number
  name: string
  parentId: number | null
  sortOrder: number
  collapsed: boolean
  createdAt: number | null
}

export async function getManuscripts(params: { q?: string; folderId?: number | null } = {}): Promise<ManuscriptSummary[]> {
  const query = new URLSearchParams()
  if (params.q) query.set('q', params.q)
  if (params.folderId !== undefined && params.folderId !== null) query.set('folderId', String(params.folderId))
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return await apiClient.get<ManuscriptSummary[]>(`${API_ENDPOINTS.MANUSCRIPTS}${suffix}`)
}

export async function getManuscript(id: number): Promise<Manuscript> {
  return await apiClient.get<Manuscript>(`${API_ENDPOINTS.MANUSCRIPTS}/${id}`)
}

export async function createManuscript(data: {
  title?: string
  contentHtml?: string
  folderId?: number | null
}): Promise<Manuscript> {
  return await apiClient.post<Manuscript>(API_ENDPOINTS.MANUSCRIPTS, data)
}

export async function updateManuscript(
  id: number,
  data: { title?: string; contentHtml?: string; folderId?: number | null; sortOrder?: number },
): Promise<Manuscript> {
  return await apiClient.put<Manuscript>(`${API_ENDPOINTS.MANUSCRIPTS}/${id}`, data)
}

/** 批量写手稿排序（拖拽后一次提交，避免逐个请求造成的中间态） */
export async function reorderManuscripts(
  updates: Array<{ id: number; sortOrder: number }>,
): Promise<{ updated: number[] }> {
  return await apiClient.put<{ updated: number[] }>(`${API_ENDPOINTS.MANUSCRIPTS}/reorder`, { updates })
}

export async function deleteManuscript(id: number): Promise<{ id: number }> {
  return await apiClient.delete<{ id: number }>(`${API_ENDPOINTS.MANUSCRIPTS}/${id}`)
}

/**
 * 手稿 → 节点池卡片。
 *
 * 移动语义：服务端在同一事务里建卡片并软删这篇手稿，所以成功后调用方要把它
 * 从笔记本列表里去掉（`useNotebookStore.sendToPool` 已代劳）。
 */
export async function manuscriptToNodeCard(id: number, folderId?: number | null): Promise<NodeCard> {
  return await apiClient.post<NodeCard>(`${API_ENDPOINTS.MANUSCRIPTS}/${id}/to-node-card`, {
    folderId: folderId ?? null,
  })
}

/** 节点池卡片 → 手稿。移动语义：卡片会在服务端同一事务里被删掉。 */
export async function nodeCardToManuscript(cardId: number): Promise<Manuscript> {
  return await apiClient.post<Manuscript>(`${API_ENDPOINTS.MANUSCRIPTS}/from-card`, { cardId })
}

export async function getManuscriptFolders(): Promise<ManuscriptFolder[]> {
  return await apiClient.get<ManuscriptFolder[]>(API_ENDPOINTS.MANUSCRIPT_FOLDERS)
}

export async function createManuscriptFolder(data: { name: string; parentId?: number | null }): Promise<ManuscriptFolder> {
  return await apiClient.post<ManuscriptFolder>(API_ENDPOINTS.MANUSCRIPT_FOLDERS, data)
}

/** 手稿文件夹排序（拖拽后用）。后端只回 { id }，本地顺序按提交值自己排。 */
export async function updateManuscriptFolder(
  id: number,
  data: { name?: string; collapsed?: boolean; sortOrder?: number },
): Promise<{ id: number }> {
  return await apiClient.put<{ id: number }>(`${API_ENDPOINTS.MANUSCRIPT_FOLDERS}/${id}`, data)
}

export async function deleteManuscriptFolder(id: number): Promise<{ id: number }> {
  return await apiClient.delete<{ id: number }>(`${API_ENDPOINTS.MANUSCRIPT_FOLDERS}/${id}`)
}