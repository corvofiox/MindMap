/**
 * 笔记本状态：手稿列表 + 当前打开的手稿 + 与节点池的转换。
 *
 * 刻意与 useCanvasStore 完全隔离：手稿不参与协作（没有 Y.Doc、没有房间），
 * 也不该被画布的撤销栈/脏标记影响。两边只通过 `api` 层打交道。
 */
import { create } from 'zustand'
import type { Manuscript, ManuscriptSummary, ManuscriptFolder, ManuscriptCounts } from '@/services/api'
import type { NodeCard } from '@/types'
import {
  createManuscript,
  createManuscriptFolder,
  deleteManuscript,
  deleteManuscriptFolder,
  getManuscript,
  getManuscriptCounts,
  getManuscriptFolders,
  getManuscripts,
  manuscriptToNodeCard,
  nodeCardToManuscript,
  reorderManuscripts,
  updateManuscript,
  updateManuscriptFolder,
} from '@/services/api'
import { computeReorder } from '@/features/drag-sort/reorder'
import { collectSubtreeIds, type FolderSelection } from '@/features/notebook/NotebookFolderTree'
import { logger } from '@/utils/logger'

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

/** 列表范围：'all' 只用于搜索（跨全部手稿）。 */
export type NotebookScope = FolderSelection | 'all'

/** 一页取多少条。与后端 PAGE_DEFAULT/PAGE_MAX 对齐。 */
export const PAGE_SIZE = 200

/**
 * 把左栏范围翻译成请求参数。
 *
 * 「选中父文件夹要连同子孙一起列出」这件事由前端做：它本来就有整棵树，
 * 服务端只按 id 集合过滤，不用再实现一遍层级逻辑。
 */
export function scopeToQuery(
  scope: NotebookScope,
  folders: ManuscriptFolder[],
): { folderId?: number | null; folderIds?: number[] } {
  if (scope === 'all') return {}
  if (scope === 'unfiled') return { folderId: null }
  const ids = Array.from(collectSubtreeIds(folders, scope))
  return { folderIds: ids.length > 0 ? ids : [scope] }
}

/** 某个归属是否落在当前范围内（移动之后决定这一行该不该留在列表里）。 */
function scopeContains(scope: NotebookScope, folderId: number | null, folders: ManuscriptFolder[]): boolean {
  if (scope === 'all') return true
  if (scope === 'unfiled') return folderId === null
  if (folderId === null) return false
  return collectSubtreeIds(folders, scope).has(folderId)
}

interface NotebookState {
  manuscripts: ManuscriptSummary[]
  folders: ManuscriptFolder[]
  active: Manuscript | null
  /**
   * 列表是否在加载（首次进入、搜索、刷新）。**只**给侧栏的骨架屏用。
   *
   * 切换手稿时不能碰这个标志：以前 open() 也写 loading，而侧栏拿它决定
   * "显示骨架屏还是列表"——于是每点一篇手稿，左侧整个列表就被骨架屏替换
   * 一下，视觉上闪一下，很突兀。列表数据没变，列表就不该渲染成加载态。
   */
  loading: boolean
  /**
   * 列表是否成功加载过至少一次。
   *
   * 存在的意义只有一个：区分"首屏还没东西"和"正在重新取"。
   * 搜索框每改一次关键词都会走 load()，如果每次都拿 loading 去渲染骨架屏，
   * 骨架屏会插在列表上方、把整列往下推 158px——敲字时就是"狂闪"。
   * 加载过一次之后，刷新期间保留旧行不动，等结果回来原位替换。
   */
  loaded: boolean
  /** 当前查询条件下的总条数（不受分页限制）。左栏"共 N 篇"用它。 */
  total: number
  /** 还有下一页：左栏滚到底据此决定要不要继续取 */
  hasMore: boolean
  /** 正在取下一页（与首屏 loading 分开，避免滚到底时整列表变成加载态） */
  loadingMore: boolean
  /** 各文件夹的条数，来自服务端 GROUP BY。徽标不能数"已经加载的那一页"。 */
  counts: ManuscriptCounts | null
  /** 当前列表范围（内部用；搜索词非空时按 'all' 处理） */
  scope: NotebookScope
  saveState: SaveState
  error: string | null
  query: string

  /** 取第一页。scope 变了（点文件夹）或关键词变了（搜索）都要重新走这里。 */
  load: (options?: { q?: string; scope?: NotebookScope }) => Promise<void>
  /** 取下一页并追加。滚到底触发。 */
  loadMore: () => Promise<void>
  /** 拉各文件夹的条数。 */
  loadCounts: () => Promise<void>
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

/**
 * 列表请求的序号，用来丢弃"先发后到"的过期响应。
 *
 * 放在模块作用域而不是 state 里：它只服务于 load() 内部的竞态判定，
 * 不需要触发渲染，也不该让别处的组件依赖它。
 */
let loadSeq = 0

export const useNotebookStore = create<NotebookState>((set, get) => ({
  manuscripts: [],
  folders: [],
  active: null,
  loading: false,
  loaded: false,
  total: 0,
  hasMore: false,
  loadingMore: false,
  counts: null,
  scope: 'unfiled',
  saveState: 'idle',
  error: null,
  query: '',

  load: async (options = {}) => {
    // 每次取列表都领一个序号：搜索框敲得快时会有多个请求同时在路上，
    // 先发后到的那次会把新结果覆盖回旧结果（列表"跳回去"）。
    // 只有最后一次请求有权写 state。
    const seq = ++loadSeq
    const scope = options.scope ?? get().scope
    const q = options.q ?? get().query
    // 搜索跨全部手稿：有关键词时不带文件夹范围，否则"在某个文件夹里搜不到别处"。
    const { folders } = get()
    const range = q ? {} : scopeToQuery(scope, folders)

    set({ loading: true, error: null, query: q, scope })
    try {
      const page = await getManuscripts({ ...range, q: q || undefined, limit: PAGE_SIZE, offset: 0 })
      if (seq !== loadSeq) return
      set({
        manuscripts: page.items,
        total: page.total,
        hasMore: page.hasMore,
        loading: false,
        loaded: true,
      })
    } catch (error) {
      if (seq !== loadSeq) return
      logger.error('[notebook] 加载手稿列表失败', error)
      set({ loading: false, error: error instanceof Error ? error.message : '加载失败' })
    }
  },

  loadMore: async () => {
    const { hasMore, loadingMore, loading, manuscripts, query, scope, folders } = get()
    if (!hasMore || loadingMore || loading) return
    const seq = loadSeq
    const range = query ? {} : scopeToQuery(scope, folders)
    set({ loadingMore: true })
    try {
      const page = await getManuscripts({
        ...range,
        q: query || undefined,
        limit: PAGE_SIZE,
        offset: manuscripts.length,
      })
      // 期间换过范围/搜索词：这次结果作废，但要把 loadingMore 放掉，否则再也翻不动
      if (seq !== loadSeq) {
        set({ loadingMore: false })
        return
      }
      set((state) => ({
        manuscripts: [...state.manuscripts, ...page.items],
        total: page.total,
        hasMore: page.hasMore,
        loadingMore: false,
      }))
    } catch (error) {
      if (seq !== loadSeq) {
        set({ loadingMore: false })
        return
      }
      logger.error('[notebook] 加载下一页失败', error)
      set({ loadingMore: false, error: error instanceof Error ? error.message : '加载失败' })
    }
  },

  loadCounts: async () => {
    try {
      set({ counts: await getManuscriptCounts() })
    } catch (error) {
      logger.error('[notebook] 加载手稿计数失败', error)
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
    // 只影响正文区，不碰列表的 loading：侧栏的骨架屏由 load() 独占，
    // 切换手稿时列表数据没变，不该被替换成加载态（会闪一下）。
    set({ error: null })
    try {
      const manuscript = await getManuscript(id)
      set({ active: manuscript, saveState: 'idle' })
    } catch (error) {
      logger.error('[notebook] 打开手稿失败', error)
      set({ error: error instanceof Error ? error.message : '打开失败', active: null })
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
        total: state.total + 1,
        active: manuscript,
        saveState: 'idle',
      }))
      void get().loadCounts()
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
      // 真的从列表里删掉一条才减总数；调用方可能重复调
      total: state.manuscripts.some((item) => item.id === id)
        ? Math.max(0, state.total - 1)
        : state.total,
      active: state.active?.id === id ? null : state.active,
    }))
    void get().loadCounts()
  },

  moveToFolder: async (id, folderId) => {
    try {
      const updated = await updateManuscript(id, { folderId })
      const { scope, folders } = get()
      // 移到当前范围之外（比如从头看未归档，把它收进某个夹）就该从列表里消失，
      // 否则它会一直挂在原地，点开才发现归属早变了。
      const stays = scopeContains(scope, updated.folderId ?? null, folders)
      set((state) => ({
        manuscripts: stays
          ? state.manuscripts.map((item) =>
              item.id === id ? { ...item, folderId: updated.folderId } : item,
            )
          : state.manuscripts.filter((item) => item.id !== id),
        total: stays ? state.total : Math.max(0, state.total - 1),
        active: state.active?.id === id ? { ...state.active, folderId: updated.folderId } : state.active,
      }))
      void get().loadCounts()
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
        total: state.total + 1,
        active: manuscript,
      }))
      void get().loadCounts()
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
    void get().loadCounts()
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
