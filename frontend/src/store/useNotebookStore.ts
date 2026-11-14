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
  reorderManuscripts,
  updateManuscript,
  updateManuscriptFolder,
} from '@/services/api'
import { computeReorder } from '@/features/drag-sort/reorder'
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
  /**
   * 只从本地列表抹掉一条（服务端那行已经不在）。
   *
   * 用在"移动"之后：手稿转成卡片时服务端已软删，界面上必须同步消失，
   * 否则列表里会留一个点开就 404 的幽灵条目。
   */
  forget: (id: number) => void
  /** 收纳：把手稿移到某个文件夹（null = 未归档）。 */
  moveToFolder: (id: number, folderId: number | null) => Promise<void>
  /** 拖拽排序：把 movedId 放到 targetId 的前/后，并落库 */
  reorder: (movedId: number, targetId: number, position: 'before' | 'after') => Promise<void>
  sendToPool: (id: number, folderId?: number | null) => Promise<NodeCard | null>
  restoreFromCard: (cardId: number) => Promise<Manuscript | null>
  /** 收纳：新建手稿夹；parentId 非空时建成子文件夹。 */
  addFolder: (name: string, parentId?: number | null) => Promise<void>
  removeFolder: (id: number) => Promise<void>
  /** 拖拽排序：把文件夹 movedId 放到 targetId 的前/后（同一父级内），并落库 */
  reorderFolders: (movedId: number, targetId: number, position: 'before' | 'after') => Promise<void>
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
    get().forget(id)
  },

  forget: (id) => {
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

  reorder: async (movedId, targetId, position) => {
    const { manuscripts } = get()
    const moved = manuscripts.find((item) => item.id === movedId)
    const target = manuscripts.find((item) => item.id === targetId)
    if (!moved || !target) return
    // 只在同一分组内重排：跨文件夹的拖拽走 moveToFolder，混在一起会让顺序无意义
    if (moved.folderId !== target.folderId) return

    const siblings = manuscripts.filter((item) => item.folderId === target.folderId)
    const updates = computeReorder(
      siblings.map((item) => ({ id: item.id, sortOrder: item.sortOrder ?? 0 })),
      movedId,
      targetId,
      position,
    )
    if (updates.length === 0) return

    const previous = manuscripts
    const orderOf = new Map(updates.map((update) => [update.id, update.sortOrder]))
    const next = manuscripts
      .map((item) => (orderOf.has(item.id) ? { ...item, sortOrder: orderOf.get(item.id) } : item))
      // 本地立刻按新顺序排好，不等服务端
      .sort((a, b) => {
        if (a.folderId !== b.folderId) return 0
        return (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
      })
    set({ manuscripts: next })

    try {
      await reorderManuscripts(updates)
    } catch (error) {
      logger.error('[notebook] 手稿排序失败', error)
      // 回滚：顺序是可见状态，写库失败还留着新顺序会误导
      set({ manuscripts: previous, error: error instanceof Error ? error.message : '排序失败' })
    }
  },

  sendToPool: async (id, folderId = null) => {
    try {
      // 转换本身是纯搬运；服务端会把这篇手稿软删，本地列表由调用方用 forget()
      // 跟进（要先改路由再清状态，见 NotebookPage.handleSendToPool）。
      return await manuscriptToNodeCard(id, folderId)
    } catch (error) {
      logger.error('[notebook] 送入节点池失败', error)
      set({ error: error instanceof Error ? error.message : '送入节点池失败' })
      return null
    }
  },

  restoreFromCard: async (cardId) => {
    try {
      // 移动语义：服务端建好手稿就把那张卡片删了，调用方负责刷新节点池
      // （节点池状态在 useNodePoolStore，这里不跨 store 直接改）
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
    // 删文件夹会改变别的行的归属（子文件夹上移、里面的手稿变成未归档），
    // 只在本地删掉这一条会留下过期的层级与落点，直接按服务端重新对齐。
    await get().loadFolders()
    await get().load()
  },

  /**
   * 文件夹拖拽排序：同一父级内重排。
   *
   * 跨父级的拖拽不该走这里（那会变成"既改归属又改顺序"，失败时没法只回滚一半）；
   * 这里遇到不同父级直接返回，不做任何写库。
   */
  reorderFolders: async (movedId, targetId, position) => {
    const folders = get().folders
    const moved = folders.find((item) => item.id === movedId)
    const target = folders.find((item) => item.id === targetId)
    if (!moved || !target) return
    if ((moved.parentId ?? null) !== (target.parentId ?? null)) return

    const siblings = folders.filter((item) => (item.parentId ?? null) === (target.parentId ?? null))
    const updates = computeReorder(
      siblings.map((item) => ({ id: item.id, sortOrder: item.sortOrder ?? 0 })),
      movedId,
      targetId,
      position,
    )
    if (updates.length === 0) return

    const previous = folders
    const orderOf = new Map(updates.map((update) => [update.id, update.sortOrder]))
    set((state) => ({
      folders: state.folders.map((item) =>
        orderOf.has(item.id) ? { ...item, sortOrder: orderOf.get(item.id)! } : item,
      ),
    }))

    try {
      await Promise.all(
        updates.map((update) => updateManuscriptFolder(update.id, { sortOrder: update.sortOrder })),
      )
    } catch (error) {
      // 部分成功时只回退失败项：全量回退会与服务端已写入的顺序打架
      set({ folders: previous, error: error instanceof Error ? error.message : '文件夹排序失败' })
      logger.error('[notebook] 文件夹排序失败', error)
      throw error
    }
  },
}))
