/**
 * useNotebookStore —— 笔记本的加载/保存/转换编排。
 *
 * 只 mock 网络层（@/services/api），store 本体与状态流转都是真实的：
 * 保存状态机（idle→saving→saved/error）、列表与当前稿的联动、抄送语义的
 * 调用参数都在这里钉住。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/services/api', async () => {
  const actual = await vi.importActual<typeof import('@/services/api')>('@/services/api')
  return {
    ...actual,
    getManuscripts: vi.fn(),
    getManuscript: vi.fn(),
    createManuscript: vi.fn(),
    updateManuscript: vi.fn(),
    deleteManuscript: vi.fn(),
    manuscriptToNodeCard: vi.fn(),
    nodeCardToManuscript: vi.fn(),
    getManuscriptFolders: vi.fn(),
  }
})

const api = await import('@/services/api')
const { useNotebookStore } = await import('@/store/useNotebookStore')

function summary(id: number, title = `稿 ${id}`) {
  return {
    id,
    folderId: null,
    title,
    previewText: '预览',
    imageCount: 0,
    createdAt: 0,
    updatedAt: 0,
  }
}

function manuscript(id: number, title = `稿 ${id}`, contentHtml = '<p>正文</p>') {
  return { ...summary(id, title), contentHtml, sourceCardId: null }
}

beforeEach(() => {
  vi.clearAllMocks()
  useNotebookStore.setState({
    manuscripts: [],
    folders: [],
    active: null,
    loading: false,
    saveState: 'idle',
    error: null,
    query: '',
  })
})

describe('加载与打开', () => {
  it('load 把列表写进 store，并带上搜索词', async () => {
    vi.mocked(api.getManuscripts).mockResolvedValue([summary(1), summary(2)])

    await useNotebookStore.getState().load({ q: '关键词' })

    expect(api.getManuscripts).toHaveBeenCalledWith({ q: '关键词', folderId: undefined })
    expect(useNotebookStore.getState().manuscripts).toHaveLength(2)
    expect(useNotebookStore.getState().query).toBe('关键词')
  })

  it('load 失败时记录 error 而不是抛出去', async () => {
    vi.mocked(api.getManuscripts).mockRejectedValue(new Error('网络炸了'))

    await useNotebookStore.getState().load()

    expect(useNotebookStore.getState().error).toBe('网络炸了')
    expect(useNotebookStore.getState().loading).toBe(false)
  })

  it('open 拉取详情并设为当前稿', async () => {
    vi.mocked(api.getManuscript).mockResolvedValue(manuscript(5, '标题', '<p>内容</p>'))

    await useNotebookStore.getState().open(5)

    expect(api.getManuscript).toHaveBeenCalledWith(5)
    expect(useNotebookStore.getState().active?.title).toBe('标题')
    expect(useNotebookStore.getState().saveState).toBe('idle')
  })

  it('open 失败时清空 active，避免显示上一位的内容', async () => {
    useNotebookStore.setState({ active: manuscript(1) })
    vi.mocked(api.getManuscript).mockRejectedValue(new Error('404'))

    await useNotebookStore.getState().open(99)

    expect(useNotebookStore.getState().active).toBeNull()
    expect(useNotebookStore.getState().error).toBe('404')
  })
})

describe('保存', () => {
  it('成功：本地先更新，落库后状态为 saved 且列表同步', async () => {
    useNotebookStore.setState({ active: manuscript(3, '旧标题'), manuscripts: [summary(3, '旧标题')] })
    vi.mocked(api.updateManuscript).mockResolvedValue({
      ...manuscript(3, '新标题'),
      previewText: '新预览',
    })

    await useNotebookStore.getState().save({ title: '新标题' })

    expect(api.updateManuscript).toHaveBeenCalledWith(3, { title: '新标题' })
    expect(useNotebookStore.getState().active?.title).toBe('新标题')
    expect(useNotebookStore.getState().saveState).toBe('saved')
    expect(useNotebookStore.getState().manuscripts[0].title).toBe('新标题')
  })

  it('失败：状态为 error，本地内容不丢（还能重试）', async () => {
    useNotebookStore.setState({ active: manuscript(3, '旧标题') })
    vi.mocked(api.updateManuscript).mockRejectedValue(new Error('500'))

    await useNotebookStore.getState().save({ contentHtml: '<p>新内容</p>' })

    const state = useNotebookStore.getState()
    expect(state.saveState).toBe('error')
    expect(state.active?.contentHtml).toBe('<p>新内容</p>')
  })

  it('没有打开的稿时是空操作（不误发请求）', async () => {
    await useNotebookStore.getState().save({ title: 'x' })
    expect(api.updateManuscript).not.toHaveBeenCalled()
  })
})

describe('新建 / 删除', () => {
  it('create 把新稿放到列表首位并设为当前', async () => {
    useNotebookStore.setState({ manuscripts: [summary(1)] })
    vi.mocked(api.createManuscript).mockResolvedValue(manuscript(9, '未命名手稿', ''))

    const created = await useNotebookStore.getState().create()

    expect(created?.id).toBe(9)
    expect(useNotebookStore.getState().active?.id).toBe(9)
    expect(useNotebookStore.getState().manuscripts[0].id).toBe(9)
  })

  it('delete 移除列表项，若删的是当前稿则清空 active', async () => {
    useNotebookStore.setState({ manuscripts: [summary(1), summary(2)], active: manuscript(2) })
    vi.mocked(api.deleteManuscript).mockResolvedValue({ id: 2 })

    await useNotebookStore.getState().remove(2)

    expect(useNotebookStore.getState().manuscripts.map((m) => m.id)).toEqual([1])
    expect(useNotebookStore.getState().active).toBeNull()
  })
})

describe('与节点池的双向转换', () => {
  it('sendToPool 透传手稿 id 与目标文件夹', async () => {
    vi.mocked(api.manuscriptToNodeCard).mockResolvedValue({ id: 77, name: '卡片' } as never)

    const card = await useNotebookStore.getState().sendToPool(12, 3)

    expect(api.manuscriptToNodeCard).toHaveBeenCalledWith(12, 3)
    expect(card?.id).toBe(77)
  })

  it('restoreFromCard 把还原出的手稿插到列表首位并打开', async () => {
    vi.mocked(api.nodeCardToManuscript).mockResolvedValue(manuscript(21, '从卡片来的'))

    const created = await useNotebookStore.getState().restoreFromCard(77)

    expect(api.nodeCardToManuscript).toHaveBeenCalledWith(77)
    expect(created?.id).toBe(21)
    expect(useNotebookStore.getState().active?.title).toBe('从卡片来的')
    expect(useNotebookStore.getState().manuscripts[0].id).toBe(21)
  })
})
