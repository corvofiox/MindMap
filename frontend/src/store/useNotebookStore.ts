/**
 * 笔记本状态：手稿列表 + 当前打开的手稿 + 与节点池的转换。
 *
 * 刻意与 useCanvasStore 完全隔离：手稿不参与协作（没有 Y.Doc、没有房间），
 * 也不该被画布的撤销栈/脏标记影响。两边只通过 `api` 层打交道。
 */
import { create } from 'zustand'
import type { Manuscript, ManuscriptSummary, ManuscriptFolder } from '@/services/api'
import type { NodeCard } from '@/types'
import {
  createManuscript,
  createManuscriptFolder,
  deleteManuscript,
  deleteManuscriptFolder,
  getManuscript,
  getManuscriptFolders,
  getManuscripts,
  manuscriptToNodeCard,
  nodeCardToManuscript,
  updateManuscript,
} from '@/services/api'
import { logger } from '@/utils/logger'

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

interface NotebookState {
  manuscripts: ManuscriptSummary[]
  folders: ManuscriptFolder[]
  active: Manuscript | null
  loading: boolean
  saveState: SaveState
  error: string | null
  query: string

  load: (options?: { q?: string; folderId?: number | null }) => Promise<void>
  loadFolders: () => Promise<void>
  open: (id: number) => Promise<void>
  close: () => void
  create: (folderId?: number | null) => Promise<Manuscript | null>
  /** 本地即时更新 + 落库；保存状态由 saveState 暴露给 UI。 */
  save: (patch: { title?: string; contentHtml?: string }) => Promise<void>
  remove: (id: number) => Promise<void>
  /** 收纳：把手稿移到某个文件夹（null = 未归档）。 */
  moveToFolder: (id: number, folderId: number | null) => Promise<void>
  sendToPool: (id: number, folderId?: number | null) => Promise<NodeCard | null>
  restoreFromCard: (cardId: number) => Promise<Manuscript | null>
  /** 收纳：新建手稿夹；parentId 非空时建成子文件夹。 */
  addFolder: (name: string, parentId?: number | null) => Promise<void>
  removeFolder: (id: number) => Promise<void>
}

export const useNotebookStore = create<NotebookState>((set, get) => ({
  manuscripts: [],
  folders: [],
  active: null,
  loading: false,
  saveState: 'idle',
  error: null,
  query: '',

  load: async (options = {}) => {
    set({ loading: true, error: null, ...(options.q !== undefined ? { query: options.q } : {}) })
    try {
      const list = await getManuscripts({
        q: options.q ?? get().query,
        folderId: options.folderId,
      })
      set({ manuscripts: list, loading: false })
    } catch (error) {
      logger.error('[notebook] 加载手稿列表失败', error)
      set({ loading: false, error: error instanceof Error ? error.message : '加载失败' })
    }
  },

  loadFolders: async () => {
    try {
      const folders = await getManuscriptFolders()
      set({ folders })
    } catch (error) {
      logger.error('[notebook] 加载文件夹失败', error)
    }
  },

  open: async (id) => {
    set({ loading: true, error: null })
    try {
      const manuscript = await getManuscript(id)
      set({ active: manuscript, loading: false, saveState: 'idle' })
    } catch (error) {
      logger.error('[notebook] 打开手稿失败', error)
      set({ loading: false, error: error instanceof Error ? error.message : '打开失败', active: null })
    }
  },

  close: () => set({ active: null, saveState: 'idle' }),

  create: async (folderId = null) => {
    try {
      const manuscript = await createManuscript({ title: '未命名手稿', contentHtml: '', folderId })
      set((state) => ({
        manuscripts: [
          {
            id: manuscript.id,
            folderId: manuscript.folderId,
            title: manuscript.title,
            previewText: manuscript.previewText,
            imageCount: manuscript.imageCount,
            createdAt: manuscript.createdAt,
            updatedAt: manuscript.updatedAt,
          },
          ...state.manuscripts,
        ],
        active: manuscript,
        saveState: 'idle',
      }))
      return manuscript
    } catch (error) {
      logger.error('[notebook] 新建手稿失败', error)
      set({ error: error instanceof Error ? error.message : '新建失败' })
      return null
    }
  },

  save: async (patch) => {
    const active = get().active
    if (!active) return

    // 先本地更新，保证输入不卡；落库失败时 saveState=error 提示可重试。
    set({
      active: { ...active, ...patch },
      saveState: 'saving',
    })

    try {
      const saved = await updateManuscript(active.id, patch)
      set((state) => ({
        active: state.active ? { ...state.active, ...saved } : saved,
        saveState: 'saved',
        manuscripts: state.manuscripts.map((item) =>
          item.id === saved.id
            ? {
                ...item,
                title: saved.title,
                previewText: saved.previewText,
                imageCount: saved.imageCount,
                updatedAt: saved.updatedAt,
              }
            : item,
        ),
      }))
    } catch (error) {
      logger.error('[notebook] 保存手稿失败', error)
      set({ saveState: 'error', error: error instanceof Error ? error.message : '保存失败' })
    }
  },

  remove: async (id) => {
    await deleteManuscript(id)
    set((state) => ({
      manuscripts: state.manuscripts.filter((item) => item.id !== id),
      active: state.active?.id === id ? null : state.active,
    }))
  },

  moveToFolder: async (id, folderId) => {
    try {
      const updated = await updateManuscript(id, { folderId })
      set((state) => ({
        manuscripts: state.manuscripts.map((item) =>
          item.id === id ? { ...item, folderId: updated.folderId } : item,
        ),
        active: state.active?.id === id ? { ...state.active, folderId: updated.folderId } : state.active,
      }))
    } catch (error) {
      logger.error('[notebook] 移动到手稿夹失败', error)
      set({ error: error instanceof Error ? error.message : '移动失败' })
    }
  },

  sendToPool: async (id, folderId = null) => {
    try {
      return await manuscriptToNodeCard(id, folderId)
    } catch (error) {
      logger.error('[notebook] 送入节点池失败', error)
      set({ error: error instanceof Error ? error.message : '送入节点池失败' })
      return null
    }
  },

  restoreFromCard: async (cardId) => {
    try {
      const manuscript = await nodeCardToManuscript(cardId)
      set((state) => ({
        manuscripts: [
          {
            id: manuscript.id,
            folderId: manuscript.folderId,
            title: manuscript.title,
            previewText: manuscript.previewText,
            imageCount: manuscript.imageCount,
            createdAt: manuscript.createdAt,
            updatedAt: manuscript.updatedAt,
          },
          ...state.manuscripts,
        ],
        active: manuscript,
      }))
      return manuscript
    } catch (error) {
      logger.error('[notebook] 卡片还原失败', error)
      set({ error: error instanceof Error ? error.message : '还原失败' })
      return null
    }
  },

  addFolder: async (name, parentId = null) => {
    const folder = await createManuscriptFolder({ name, parentId })
    set((state) => ({ folders: [...state.folders, folder] }))
  },

  removeFolder: async (id) => {
    await deleteManuscriptFolder(id)
    set((state) => ({ folders: state.folders.filter((folder) => folder.id !== id) }))
  },
}))
