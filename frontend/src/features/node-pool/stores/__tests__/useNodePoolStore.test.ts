/**
 * useNodePoolStore 真实行为测试
 *
 * 只 mock 真正的外部:`@/services/api`(网络层)。store 本体、`createNodeFromCard`
 * 工具、乐观更新/回滚逻辑全部走真实实现。
 *
 * 覆盖:
 *  - setCards/getCard/loadNodePool(含失败路径)
 *  - addCard 乐观临时卡(负 id)→ 真实卡替换、操作队列状态、失败回滚
 *  - updateCard 乐观更新 + 服务端响应替换 + 失败回滚 + pending 卡只改本地不入队 API
 *    + 临时卡解析真实 id 后转真实路径 + withCardLock 并发去重
 *  - removeCard 乐观删除 / 失败回滚 / 未知 id 直接返回
 *  - useCard 取出到画布(createNodeFromCard + 偏移)、删除池内卡、失败回滚、
 *    已标记删除的临时卡不可取出、pending 卡与 addCard 完成回调的竞态(D22 系列)
 *  - 文件夹:addFolder/updateFolder/removeFolder/toggleFolderCollapsed(含 in-flight
 *    移除时丢弃真实文件夹)
 *  - 排序:reorderCards(逐个同步 + 失败尽力回滚服务端) / reorderFolders
 *  - validateAndFixState 六项状态自愈
 *  - 选择器:selectAllCards/selectCardsByFolder/selectFoldersByParent/selectFolderTree
 *  - reset/clearError/dragState,以及"该 store 不做任何持久化"
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Node, NodeCard, NodePoolFolder } from '@/types'
import type { Operation } from '../../types/node-pool'
import * as api from '@/services/api'
import { useNodePoolStore, selectAllCards, selectAllFolders, selectCardsByFolder, selectFoldersByParent, selectFolderTree } from '../useNodePoolStore'
import type { NodePoolStore } from '../../types/node-pool'

vi.mock('@/services/api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getNodePool: vi.fn(),
    getNodePoolFolders: vi.fn(),
    addToNodePool: vi.fn(),
    updateNodeCard: vi.fn(),
    removeFromNodePool: vi.fn(),
    createNodePoolFolder: vi.fn(),
    updateNodePoolFolder: vi.fn(),
    deleteNodePoolFolder: vi.fn(),
  }
})

const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>

function makeCard(overrides: Partial<NodeCard> = {}): NodeCard {
  return {
    id: 1,
    userId: 1,
    name: '卡片',
    content: '{"title":"标题"}',
    type: 'text',
    color: '#fff',
    tags: null,
    useCount: 3,
    createdBy: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    folderId: null,
    description: null,
    thumbnail: null,
    sortOrder: 0,
    ...overrides,
  }
}

function makeFolder(overrides: Partial<NodePoolFolder> = {}): NodePoolFolder {
  return {
    id: 10,
    userId: 1,
    name: '文件夹',
    parentId: null,
    sortOrder: 0,
    collapsed: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** 服务端返回的"真实"卡片(与临时卡字段刻意不同,便于断言合并规则)。 */
function serverCard(id: number, overrides: Partial<NodeCard> = {}): NodeCard {
  return makeCard({
    id,
    userId: 7,
    createdBy: 7,
    useCount: 5,
    createdAt: '2020-05-05T05:05:05.000Z',
    ...overrides,
  })
}

/** 让 store 里挂着的 5s/10s 延时清理定时器不影响断言。 */
const emptyState = {
  cardsMap: new Map<number, NodeCard>(),
  foldersMap: new Map<number, NodePoolFolder>(),
  dragState: { active: null, over: null },
  isLoading: false,
  error: null,
  pendingCardIds: new Set<number>(),
  operationQueue: new Map(),
  temporaryCards: new Map(),
  processingOperations: new Set<string>(),
  processingCardIds: new Set<number>(),
  pendingUpdates: new Map<number, Partial<NodeCard>>(),
}

function state() {
  return useNodePoolStore.getState()
}

/** 当前 operationQueue 里所有操作(按 id 索引)。 */
function ops(): Array<{ id: string; type: string; status: string; cardId: number; realCardId: number | null; retryCount: number }> {
  return Array.from(state().operationQueue.values())
}

beforeEach(() => {
  vi.resetAllMocks()
  // 默认返回值:store 里有多处 fire-and-forget 的 `.catch()` 调用,
  // mock 若返回 undefined 会直接 TypeError(而不是被 catch 吞掉)。
  mockApi.removeFromNodePool.mockResolvedValue(undefined)
  mockApi.deleteNodePoolFolder.mockResolvedValue(undefined)
  mockApi.getNodePool.mockResolvedValue([])
  mockApi.getNodePoolFolders.mockResolvedValue([])
  mockApi.updateNodeCard.mockImplementation((id: number, d: Partial<NodeCard>) =>
    Promise.resolve(makeCard({ id, ...d })),
  )
  mockApi.updateNodePoolFolder.mockImplementation((id: number, d: Partial<NodePoolFolder>) =>
    Promise.resolve(makeFolder({ id, ...d })),
  )
  useNodePoolStore.setState(emptyState)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('卡片读写:纯状态动作', () => {
  it('setCards 以 id 建 Map,getCard 命中/未命中', () => {
    useNodePoolStore.getState().setCards([makeCard({ id: 1 }), makeCard({ id: 2, name: '二' })])

    expect(state().cardsMap.size).toBe(2)
    expect(state().getCard(2)?.name).toBe('二')
    expect(state().getCard(999)).toBeUndefined()
  })

  it('setCards 整体替换(旧卡不保留)', () => {
    useNodePoolStore.getState().setCards([makeCard({ id: 1 })])
    useNodePoolStore.getState().setCards([makeCard({ id: 5 })])

    expect(state().getCard(1)).toBeUndefined()
    expect(state().getCard(5)?.id).toBe(5)
  })

  it('setFolders + getFolder', () => {
    useNodePoolStore.getState().setFolders([makeFolder({ id: 10, name: 'A' })])

    expect(state().getFolder(10)?.name).toBe('A')
    expect(state().getFolder(11)).toBeUndefined()
  })

  it('clearError 清掉错误,clearDragState/setDragState 读写拖拽态', () => {
    useNodePoolStore.setState({ error: '出错了' })
    useNodePoolStore.getState().clearError()
    expect(state().error).toBeNull()

    const card = makeCard({ id: 3 })
    useNodePoolStore.getState().setDragState({ active: card, over: null })
    expect(state().dragState.active).toBe(card)
    expect(state().dragState.over).toBeNull()

    useNodePoolStore.getState().clearDragState()
    expect(state().dragState).toEqual({ active: null, over: null })
  })

  it('reset 清空池内数据(但不清 processingCardIds —— 固化当前实现)', () => {
    useNodePoolStore.getState().setCards([makeCard({ id: 1 })])
    useNodePoolStore.setState({ processingCardIds: new Set([1]), error: 'x' })

    useNodePoolStore.getState().reset()

    expect(state().cardsMap.size).toBe(0)
    expect(state().foldersMap.size).toBe(0)
    expect(state().error).toBeNull()
    expect(state().pendingCardIds.size).toBe(0)
    // reset() 的 set 里没有 processingCardIds:锁残留(已知实现细节)
    expect(Array.from(state().processingCardIds)).toEqual([1])
  })
})

describe('loadNodePool', () => {
  it('成功:卡片+文件夹入 Map,isLoading 由 true 归 false', async () => {
    mockApi.getNodePool.mockResolvedValue([makeCard({ id: 1, sortOrder: 2 }), makeCard({ id: 2, sortOrder: 1 })])
    mockApi.getNodePoolFolders.mockResolvedValue([makeFolder({ id: 10 })])

    const loadingPromise = useNodePoolStore.getState().loadNodePool()
    // 首个 await 之前同步置位
    expect(state().isLoading).toBe(true)
    await loadingPromise

    expect(state().isLoading).toBe(false)
    expect(state().error).toBeNull()
    expect(Array.from(state().cardsMap.keys())).toEqual([1, 2])
    expect(state().foldersMap.get(10)?.name).toBe('文件夹')
    expect(mockApi.getNodePool).toHaveBeenCalledTimes(1)
    expect(mockApi.getNodePoolFolders).toHaveBeenCalledTimes(1)
  })

  it('开始前清掉上一次的 error', async () => {
    useNodePoolStore.setState({ error: '旧错误' })
    mockApi.getNodePool.mockResolvedValue([])
    mockApi.getNodePoolFolders.mockResolvedValue([])

    await useNodePoolStore.getState().loadNodePool()

    expect(state().error).toBeNull()
  })

  it('失败:error 写入异常 message,isLoading 归 false,卡片保持为空', async () => {
    mockApi.getNodePool.mockRejectedValue(new Error('网络中断'))

    await useNodePoolStore.getState().loadNodePool()

    expect(state().error).toBe('网络中断')
    expect(state().isLoading).toBe(false)
    expect(state().cardsMap.size).toBe(0)
  })

  it('非 Error 抛出时回退固定文案', async () => {
    mockApi.getNodePool.mockRejectedValue('boom')

    await useNodePoolStore.getState().loadNodePool()

    expect(state().error).toBe('加载节点池失败')
  })
})

describe('addCard:乐观更新与替换', () => {
  const data = {
    name: '新卡片',
    content: '{"title":"N"}',
    type: 'text',
    color: '#abcdef',
    tags: null,
    folderId: null,
    sortOrder: 4,
  }

  it('请求未回时:负 id 临时卡进入 cardsMap + pendingCardIds + temporaryCards,操作置 processing', async () => {
    let resolveAdd: (v: NodeCard) => void = () => {}
    mockApi.addToNodePool.mockImplementation(() => new Promise((r) => { resolveAdd = r }))

    const pending = useNodePoolStore.getState().addCard(data)

    const tempId = Array.from(state().cardsMap.keys())[0]
    expect(tempId).toBeLessThan(0)
    expect(state().pendingCardIds.has(tempId)).toBe(true)
    expect(state().getCard(tempId)?.name).toBe('新卡片')
    expect(state().getCard(tempId)?.id).toBe(tempId)
    expect(state().getCard(tempId)?.useCount).toBe(0)
    expect(state().temporaryCards.get(tempId)?.status).toBe('creating')
    expect(ops().map((o) => o.status)).toEqual(['processing'])
    expect(ops()[0].cardId).toBe(tempId)
    expect(ops()[0].realCardId).toBeNull()

    resolveAdd(serverCard(99))
    await pending

    expect(state().getCard(99)?.name).toBe('新卡片')
    expect(state().getCard(tempId)).toBeUndefined()
    expect(state().pendingCardIds.size).toBe(0)
  })

  it('成功后:真实 id 入池,临时卡记录 realCardId/status=created,操作 completed', async () => {
    mockApi.addToNodePool.mockResolvedValue(serverCard(99, { name: '新卡片', content: data.content, type: 'text', color: data.color, sortOrder: 4 }))

    const created = await useNodePoolStore.getState().addCard(data)

    expect(created.id).toBe(99)
    const real = state().getCard(99)
    expect(real?.name).toBe('新卡片')
    expect(real?.sortOrder).toBe(4)
    // 合并规则:finalCard 保留服务端 id,其余字段以临时卡为准(临时卡值与服务端不同则覆盖)
    expect(real?.userId).toBe(0)
    expect(real?.useCount).toBe(0)
    // 返回值是服务端原始对象(未合并)
    expect(created.userId).toBe(7)
    expect(created.useCount).toBe(5)

    const temp = Array.from(state().temporaryCards.keys())[0]
    expect(state().temporaryCards.get(temp)).toMatchObject({ realCardId: 99, status: 'created' })
    expect(ops()[0]).toMatchObject({ status: 'completed', realCardId: 99, cardId: 99 })
  })

  it('调用的 API 载荷就是传入的 data', async () => {
    mockApi.addToNodePool.mockResolvedValue(serverCard(1))

    await useNodePoolStore.getState().addCard(data)

    expect(mockApi.addToNodePool).toHaveBeenCalledWith(data)
  })

  it('失败:临时卡/pendng/临时映射全部回滚,操作 failed + retryCount=1,抛原错误并写 error', async () => {
    mockApi.addToNodePool.mockRejectedValue(new Error('服务器炸了'))

    await expect(useNodePoolStore.getState().addCard(data)).rejects.toThrow('服务器炸了')

    expect(state().cardsMap.size).toBe(0)
    expect(state().pendingCardIds.size).toBe(0)
    expect(state().temporaryCards.size).toBe(0)
    expect(state().pendingUpdates.size).toBe(0)
    expect(state().processingOperations.size).toBe(0)
    expect(ops()[0]).toMatchObject({ status: 'failed', retryCount: 1 })
    expect(state().error).toBe('服务器炸了')
  })

  it('完成后延时 10s 清理操作与临时卡', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-03T03:03:03.000Z'))
    mockApi.addToNodePool.mockResolvedValue(serverCard(100))

    await useNodePoolStore.getState().addCard(data)

    const tempId = Array.from(state().temporaryCards.keys())[0]
    expect(tempId).toBeLessThan(0)
    expect(ops().length).toBe(1)

    await vi.advanceTimersByTimeAsync(9999)
    expect(ops().length).toBe(1)
    await vi.advanceTimersByTimeAsync(2)
    expect(state().operationQueue.size).toBe(0)
    expect(state().temporaryCards.size).toBe(0)
    vi.useRealTimers()
  })
})

describe('updateCard', () => {
  it('真实卡:乐观合并后以服务端响应为准', async () => {
    useNodePoolStore.getState().setCards([makeCard({ id: 5, name: '旧名', color: '#111' })])
    mockApi.updateNodeCard.mockResolvedValue(makeCard({ id: 5, name: '服务端名', color: '#111' }))

    await useNodePoolStore.getState().updateCard(5, { name: '新名' })

    expect(mockApi.updateNodeCard).toHaveBeenCalledWith(5, { name: '新名' })
    expect(state().getCard(5)?.name).toBe('服务端名')
  })

  it('服务端失败:回滚为原卡片,写 error 并抛出', async () => {
    useNodePoolStore.getState().setCards([makeCard({ id: 5, name: '旧名' })])
    mockApi.updateNodeCard.mockRejectedValue(new Error('更新炸了'))

    await expect(useNodePoolStore.getState().updateCard(5, { name: '新名' })).rejects.toThrow('更新炸了')

    expect(state().getCard(5)?.name).toBe('旧名')
    expect(state().error).toBe('更新炸了')
  })

  it('不存在的 id:直接返回,不调用 API', async () => {
    await useNodePoolStore.getState().updateCard(1234, { name: 'x' })

    expect(mockApi.updateNodeCard).not.toHaveBeenCalled()
    expect(state().error).toBeNull()
  })

  it('pending 临时卡:只改本地 cardsMap + temporaryCards + pendingUpdates,不发请求', async () => {
    let resolveAdd: (v: NodeCard) => void = () => {}
    mockApi.addToNodePool.mockImplementation(() => new Promise((r) => { resolveAdd = r }))

    const addPromise = useNodePoolStore.getState().addCard({
      name: '临时', content: '{}', type: 'text', color: '#fff', tags: null, folderId: null, sortOrder: 0,
    })
    const tempId = Array.from(state().cardsMap.keys())[0]

    await useNodePoolStore.getState().updateCard(tempId, { name: '改名了' })

    expect(mockApi.updateNodeCard).not.toHaveBeenCalled()
    expect(state().getCard(tempId)?.name).toBe('改名了')
    expect(state().temporaryCards.get(tempId)?.card.name).toBe('改名了')
    expect(state().pendingUpdates.get(tempId)).toEqual({ name: '改名了' })

    resolveAdd(serverCard(77, { name: '临时' }))
    await addPromise

    // addCard 完成时把 pendingUpdates 追加到最终卡片并同步服务端
    expect(state().getCard(77)?.name).toBe('改名了')
    expect(state().pendingUpdates.size).toBe(0)
    expect(mockApi.updateNodeCard).toHaveBeenCalledWith(77, { name: '改名了' })
  })

  it('临时卡已拿到 realCardId 时:更新自动转发到真实 id(走 API)', async () => {
    mockApi.addToNodePool.mockResolvedValue(serverCard(88, { name: '临时' }))
    await useNodePoolStore.getState().addCard({
      name: '临时', content: '{}', type: 'text', color: '#fff', tags: null, folderId: null, sortOrder: 0,
    })
    const tempId = Array.from(state().temporaryCards.keys())[0]
    expect(state().temporaryCards.get(tempId)?.realCardId).toBe(88)

    mockApi.updateNodeCard.mockResolvedValue(serverCard(88, { name: '最终名' }))
    await useNodePoolStore.getState().updateCard(tempId, { name: '最终名' })

    expect(mockApi.updateNodeCard).toHaveBeenCalledWith(88, { name: '最终名' })
    expect(state().getCard(88)?.name).toBe('最终名')
  })

  it('cardsMap 里没有但 operationQueue 已记录真实 id 的负 id:解析后转真实路径', async () => {
    useNodePoolStore.getState().setCards([makeCard({ id: 42, name: '真实卡' })])
    useNodePoolStore.setState({
      operationQueue: new Map([['op-x', {
        id: 'op-x', type: 'add' as const, status: 'completed' as const, cardId: -7, realCardId: 42, timestamp: Date.now(), retryCount: 0,
      }]]),
    })
    mockApi.updateNodeCard.mockResolvedValue(serverCard(42, { name: '来自队列解析' }))

    await useNodePoolStore.getState().updateCard(-7, { name: '来自队列解析' })

    expect(mockApi.updateNodeCard).toHaveBeenCalledWith(42, { name: '来自队列解析' })
    expect(state().getCard(42)?.name).toBe('来自队列解析')
  })

  it('负 id 且队列里查不到真实 id:直接返回,不发请求', async () => {
    await useNodePoolStore.getState().updateCard(-8888, { name: 'x' })

    expect(mockApi.updateNodeCard).not.toHaveBeenCalled()
  })

  it('已标记删除的临时卡不可更新(不产生 API 调用)', async () => {
    let resolveAdd: (v: NodeCard) => void = () => {}
    mockApi.addToNodePool.mockImplementation(() => new Promise((r) => { resolveAdd = r }))
    const addPromise = useNodePoolStore.getState().addCard({
      name: '待删', content: '{}', type: 'text', color: '#fff', tags: null, folderId: null, sortOrder: 0,
    })
    const tempId = Array.from(state().cardsMap.keys())[0]

    await useNodePoolStore.getState().removeCard(tempId)
    expect(state().temporaryCards.get(tempId)?.card._markedForDeletion).toBe(true)
    expect(state().cardsMap.has(tempId)).toBe(false)

    await useNodePoolStore.getState().updateCard(tempId, { name: '不该生效' })
    expect(state().pendingUpdates.size).toBe(0)

    resolveAdd(serverCard(91))
    await addPromise
    expect(mockApi.updateNodeCard).not.toHaveBeenCalled()
    expect(state().getCard(91)).toBeUndefined()
  })

  it('同一张卡的并发更新被 processingCardIds 去重(只发一次请求)', async () => {
    useNodePoolStore.getState().setCards([makeCard({ id: 5, name: '旧' })])
    let resolveUpdate: (v: NodeCard) => void = () => {}
    mockApi.updateNodeCard.mockImplementation(() => new Promise((r) => { resolveUpdate = r }))

    const first = useNodePoolStore.getState().updateCard(5, { name: 'A' })
    expect(state().processingCardIds.has(5)).toBe(true)
    const second = useNodePoolStore.getState().updateCard(5, { name: 'B' })

    await second
    expect(mockApi.updateNodeCard).toHaveBeenCalledTimes(1)
    expect(mockApi.updateNodeCard).toHaveBeenCalledWith(5, { name: 'A' })

    resolveUpdate(serverCard(5, { name: 'A' }))
    await first
    expect(state().processingCardIds.has(5)).toBe(false)
  })
})

describe('removeCard', () => {
  it('真实卡:乐观删除 + 调用删除接口 + 操作 completed', async () => {
    useNodePoolStore.getState().setCards([makeCard({ id: 5 })])
    mockApi.removeFromNodePool.mockResolvedValue(undefined)

    await useNodePoolStore.getState().removeCard(5)

    expect(mockApi.removeFromNodePool).toHaveBeenCalledWith(5)
    expect(state().getCard(5)).toBeUndefined()
    expect(ops()[0]).toMatchObject({ type: 'remove', status: 'completed', cardId: 5, realCardId: 5 })
    expect(state().processingOperations.size).toBe(0)
    expect(state().processingCardIds.has(5)).toBe(false)
  })

  it('接口失败:卡片回滚进池,操作 failed,写 error 并抛出', async () => {
    useNodePoolStore.getState().setCards([makeCard({ id: 5, name: '保留' })])
    mockApi.removeFromNodePool.mockRejectedValue(new Error('删不掉'))

    await expect(useNodePoolStore.getState().removeCard(5)).rejects.toThrow('删不掉')

    expect(state().getCard(5)?.name).toBe('保留')
    expect(ops()[0]).toMatchObject({ status: 'failed', retryCount: 1 })
    expect(state().error).toBe('删不掉')
  })

  it('池中不存在的正 id:仍按真实 id 走删除流程(resolveRealCardId 对 id>0 直接返回)', async () => {
    mockApi.removeFromNodePool.mockRejectedValue(new Error('404'))

    await expect(state().removeCard(4242)).rejects.toThrow('404')

    expect(mockApi.removeFromNodePool).toHaveBeenCalledWith(4242)
    expect(ops()[0].cardId).toBe(4242)
    expect(ops()[0].status).toBe('failed')
  })

  it('池中不存在的负 id:直接返回,什么都不做', async () => {
    await state().removeCard(-987654)

    expect(mockApi.removeFromNodePool).not.toHaveBeenCalled()
    expect(state().operationQueue.size).toBe(0)
  })

  it('pending 临时卡:打删除标记且不发删除请求', async () => {
    let resolveAdd: (v: NodeCard) => void = () => {}
    mockApi.addToNodePool.mockImplementation(() => new Promise((r) => { resolveAdd = r }))
    mockApi.removeFromNodePool.mockResolvedValue(undefined)
    const addPromise = useNodePoolStore.getState().addCard({
      name: '刚建的', content: '{}', type: 'text', color: '#fff', tags: null, folderId: null, sortOrder: 0,
    })
    const tempId = Array.from(state().cardsMap.keys())[0]

    await useNodePoolStore.getState().removeCard(tempId)

    expect(mockApi.removeFromNodePool).not.toHaveBeenCalled()
    expect(state().cardsMap.has(tempId)).toBe(false)
    expect(state().temporaryCards.get(tempId)?.card._markedForDeletion).toBe(true)

    resolveAdd(serverCard(60))
    await addPromise

    // addCard 完成回调发现删除标记 → 丢弃服务端真实卡
    expect(state().getCard(60)).toBeUndefined()
    expect(mockApi.removeFromNodePool).toHaveBeenCalledWith(60)
    expect(state().temporaryCards.size).toBe(0)
  })
})

describe('useCard:取出到画布', () => {
  it('真实卡:按 createNodeFromCard 建节点(x/y = 卡内容坐标 +50)并移出池子', async () => {
    useNodePoolStore.getState().setCards([
      makeCard({ id: 5, name: '卡名', content: '{"x":10,"y":20,"title":"内容标题"}' }),
    ])
    mockApi.removeFromNodePool.mockResolvedValue(undefined)
    const addNodeToCanvas = vi.fn()

    await state().useCard(state().getCard(5)!, addNodeToCanvas)

    const node = addNodeToCanvas.mock.calls[0][0] as Node
    expect(addNodeToCanvas).toHaveBeenCalledTimes(1)
    expect(node.x).toBe(60)
    expect(node.y).toBe(70)
    expect(node.title).toBe('内容标题')
    expect(typeof node.id).toBe('string')
    expect(node.id.startsWith('node-')).toBe(true)
    expect(mockApi.removeFromNodePool).toHaveBeenCalledWith(5)
    expect(state().getCard(5)).toBeUndefined()
    expect(ops()[0].status).toBe('completed')
  })

  it('内容没有坐标时节点落在 (50,50)', async () => {
    useNodePoolStore.getState().setCards([makeCard({ id: 6, content: '{"title":"T"}' })])
    mockApi.removeFromNodePool.mockResolvedValue(undefined)
    const addNodeToCanvas = vi.fn()

    await state().useCard(state().getCard(6)!, addNodeToCanvas)

    const node = addNodeToCanvas.mock.calls[0][0] as Node
    expect(node.x).toBe(50)
    expect(node.y).toBe(50)
  })

  it('畸形 JSON 内容:仍然建出文本节点(标题为卡片名)', async () => {
    useNodePoolStore.getState().setCards([makeCard({ id: 7, name: '纯文本卡', content: 'not json' })])
    mockApi.removeFromNodePool.mockResolvedValue(undefined)
    const addNodeToCanvas = vi.fn()

    await state().useCard(state().getCard(7)!, addNodeToCanvas)

    const node = addNodeToCanvas.mock.calls[0][0] as Node
    expect(node.type).toBe('text')
    expect(node.title).toBe('纯文本卡')
    expect(node.content).toBe('not json')
  })

  it('池中不存在该卡:不建节点、不发请求', async () => {
    const addNodeToCanvas = vi.fn()

    await state().useCard(makeCard({ id: 9999 }), addNodeToCanvas)

    expect(addNodeToCanvas).not.toHaveBeenCalled()
    expect(mockApi.removeFromNodePool).not.toHaveBeenCalled()
  })

  it('删除接口失败:卡片回滚到池内,操作 failed,抛错并写 error', async () => {
    useNodePoolStore.getState().setCards([makeCard({ id: 8, name: '别丢' })])
    mockApi.removeFromNodePool.mockRejectedValue(new Error('取出失败'))
    const addNodeToCanvas = vi.fn()

    await expect(state().useCard(state().getCard(8)!, addNodeToCanvas)).rejects.toThrow('取出失败')

    expect(addNodeToCanvas).toHaveBeenCalledTimes(1)
    expect(state().getCard(8)?.name).toBe('别丢')
    expect(ops()[0]).toMatchObject({ status: 'failed', retryCount: 1 })
    expect(state().error).toBe('取出失败')
  })

  it('已标记删除的临时卡不可取出', async () => {
    let resolveAdd: (v: NodeCard) => void = () => {}
    mockApi.addToNodePool.mockImplementation(() => new Promise((r) => { resolveAdd = r }))
    const addPromise = useNodePoolStore.getState().addCard({
      name: '竞态卡', content: '{}', type: 'text', color: '#fff', tags: null, folderId: null, sortOrder: 0,
    })
    const tempId = Array.from(state().cardsMap.keys())[0]
    await state().removeCard(tempId)
    const markedCard = state().temporaryCards.get(tempId)!.card

    const addNodeToCanvas = vi.fn()
    await state().useCard(markedCard, addNodeToCanvas)

    expect(addNodeToCanvas).not.toHaveBeenCalled()
    resolveAdd(serverCard(61))
    await addPromise
    expect(state().getCard(61)).toBeUndefined()
  })

  it('pending 临时卡取出:立即建节点,删除请求延后由 addCard 完成回调补发', async () => {
    let resolveAdd: (v: NodeCard) => void = () => {}
    mockApi.addToNodePool.mockImplementation(() => new Promise((r) => { resolveAdd = r }))
    const addPromise = useNodePoolStore.getState().addCard({
      name: '刚建的', content: '{"title":"Q"}', type: 'text', color: '#fff', tags: null, folderId: null, sortOrder: 0,
    })
    const tempId = Array.from(state().cardsMap.keys())[0]

    const addNodeToCanvas = vi.fn()
    await state().useCard(state().getCard(tempId)!, addNodeToCanvas)

    expect(addNodeToCanvas).toHaveBeenCalledTimes(1)
    expect((addNodeToCanvas.mock.calls[0][0] as Node).title).toBe('Q')
    expect(mockApi.removeFromNodePool).not.toHaveBeenCalled()

    resolveAdd(serverCard(70))
    await addPromise

    expect(state().getCard(70)).toBeUndefined()
    expect(mockApi.removeFromNodePool).toHaveBeenCalledWith(70)
  })

  it('同一张卡并发取出:只建一个节点、只发一次删除请求', async () => {
    useNodePoolStore.getState().setCards([makeCard({ id: 9 })])
    let releaseDelete: () => void = () => {}
    mockApi.removeFromNodePool.mockImplementation(
      () => new Promise<void>((r) => { releaseDelete = () => r() }),
    )

    const addNodeToCanvas = vi.fn()
    const card = state().getCard(9)!
    const first = state().useCard(card, addNodeToCanvas)
    const second = state().useCard(card, addNodeToCanvas)

    await second
    expect(addNodeToCanvas).toHaveBeenCalledTimes(1)
    expect(mockApi.removeFromNodePool).toHaveBeenCalledTimes(1)

    releaseDelete()
    await first
    expect(addNodeToCanvas).toHaveBeenCalledTimes(1)
    expect(mockApi.removeFromNodePool).toHaveBeenCalledTimes(1)
  })

  it('processingCardIds 已锁定的卡片:useCard 走锁内路径时直接返回', async () => {
    useNodePoolStore.getState().setCards([makeCard({ id: 9 })])
    useNodePoolStore.setState({ processingCardIds: new Set([9]) })

    const addNodeToCanvas = vi.fn()
    await state().useCard(state().getCard(9)!, addNodeToCanvas)

    expect(addNodeToCanvas).not.toHaveBeenCalled()
    expect(mockApi.removeFromNodePool).not.toHaveBeenCalled()
  })
})

describe('文件夹动作', () => {
  const folderData = { name: '新文件夹', parentId: null, sortOrder: 2, collapsed: false }

  it('addFolder:乐观插入临时文件夹,成功后换成真实 id', async () => {
    let resolveCreate: (v: NodePoolFolder) => void = () => {}
    mockApi.createNodePoolFolder.mockImplementation(() => new Promise((r) => { resolveCreate = r }))

    const promise = state().addFolder(folderData)
    const tempId = Array.from(state().foldersMap.keys())[0]
    expect(tempId).toBeLessThan(0)
    expect(state().getFolder(tempId)?.name).toBe('新文件夹')
    expect(state().getFolder(tempId)?.children).toEqual([])

    resolveCreate(makeFolder({ id: 12, name: '新文件夹', sortOrder: 2 }))
    const created = await promise

    expect(created.id).toBe(12)
    expect(state().getFolder(tempId)).toBeUndefined()
    expect(state().getFolder(12)).toMatchObject({ name: '新文件夹', sortOrder: 2, children: [] })
    expect(mockApi.createNodePoolFolder).toHaveBeenCalledWith(folderData)
  })

  it('addFolder 失败:临时文件夹消失,写 error,返回 null 而不抛错', async () => {
    mockApi.createNodePoolFolder.mockRejectedValue(new Error('建不了'))

    const result = await state().addFolder(folderData)

    expect(result).toBeNull()
    expect(state().foldersMap.size).toBe(0)
    expect(state().error).toBe('建不了')
  })

  it('addFolder 在请求期间被移除:真实文件夹被丢弃并补发删除(D22)', async () => {
    let resolveCreate: (v: NodePoolFolder) => void = () => {}
    mockApi.createNodePoolFolder.mockImplementation(() => new Promise((r) => { resolveCreate = r }))

    const promise = state().addFolder(folderData)
    const tempId = Array.from(state().foldersMap.keys())[0]

    await state().removeFolder(tempId)
    expect(mockApi.deleteNodePoolFolder).not.toHaveBeenCalled()

    resolveCreate(makeFolder({ id: 13 }))
    await promise

    expect(state().getFolder(13)).toBeUndefined()
    expect(mockApi.deleteNodePoolFolder).toHaveBeenCalledWith(13)
  })

  it('updateFolder(重命名):写回服务端结果并强制 children=[]', async () => {
    useNodePoolStore.getState().setFolders([makeFolder({ id: 10, name: '旧名', children: [makeFolder({ id: 11 })] })])
    mockApi.updateNodePoolFolder.mockResolvedValue(makeFolder({ id: 10, name: '新名' }))

    await state().updateFolder(10, { name: '新名' })

    expect(mockApi.updateNodePoolFolder).toHaveBeenCalledWith(10, { name: '新名' })
    expect(state().getFolder(10)?.name).toBe('新名')
    expect(state().getFolder(10)?.children).toEqual([])
    expect(state().isLoading).toBe(false)
  })

  it('updateFolder 期间文件夹已被移除:不回插,只收 isLoading', async () => {
    useNodePoolStore.getState().setFolders([makeFolder({ id: 10 })])
    let resolveUpdate: (v: NodePoolFolder) => void = () => {}
    mockApi.updateNodePoolFolder.mockImplementation(() => new Promise((r) => { resolveUpdate = r }))

    const promise = state().updateFolder(10, { name: 'X' })
    useNodePoolStore.setState({ foldersMap: new Map() })
    resolveUpdate(makeFolder({ id: 10, name: 'X' }))
    await promise

    expect(state().getFolder(10)).toBeUndefined()
    expect(state().isLoading).toBe(false)
  })

  it('updateFolder 失败:写 error 不抛错', async () => {
    mockApi.updateNodePoolFolder.mockRejectedValue(new Error('改名失败'))

    await state().updateFolder(10, { name: 'X' })

    expect(state().error).toBe('改名失败')
    expect(state().isLoading).toBe(false)
  })

  it('removeFolder:乐观删除 + 调用删除接口', async () => {
    useNodePoolStore.getState().setFolders([makeFolder({ id: 10 }), makeFolder({ id: 11 })])
    mockApi.deleteNodePoolFolder.mockResolvedValue(undefined)

    await state().removeFolder(10)

    expect(mockApi.deleteNodePoolFolder).toHaveBeenCalledWith(10)
    expect(state().getFolder(10)).toBeUndefined()
    expect(state().getFolder(11)?.id).toBe(11)
  })

  it('removeFolder 未知 id:直接返回', async () => {
    await state().removeFolder(999)

    expect(mockApi.deleteNodePoolFolder).not.toHaveBeenCalled()
  })

  it('removeFolder 失败:整个 foldersMap 回滚并抛错', async () => {
    useNodePoolStore.getState().setFolders([makeFolder({ id: 10 })])
    mockApi.deleteNodePoolFolder.mockRejectedValue(new Error('删不掉文件夹'))

    await expect(state().removeFolder(10)).rejects.toThrow('删不掉文件夹')

    expect(state().getFolder(10)?.name).toBe('文件夹')
    expect(state().error).toBe('删不掉文件夹')
  })

  it('toggleFolderCollapsed:翻转 collapsed,未知 id 不动状态', () => {
    useNodePoolStore.getState().setFolders([makeFolder({ id: 10, collapsed: false })])

    state().toggleFolderCollapsed(10)
    expect(state().getFolder(10)?.collapsed).toBe(true)

    state().toggleFolderCollapsed(10)
    expect(state().getFolder(10)?.collapsed).toBe(false)

    state().toggleFolderCollapsed(777)
    expect(state().getFolder(777)).toBeUndefined()
    expect(state().getFolder(10)?.collapsed).toBe(false)
  })
})

describe('排序', () => {
  it('reorderCards:先乐观写入 sortOrder,再逐个同步服务端', async () => {
    useNodePoolStore.getState().setCards([
      makeCard({ id: 1, sortOrder: 0 }),
      makeCard({ id: 2, sortOrder: 10 }),
    ])
    mockApi.updateNodeCard.mockImplementation((id: number, d: Partial<NodeCard>) =>
      Promise.resolve(makeCard({ id, sortOrder: d.sortOrder as number })),
    )

    await state().reorderCards([{ id: 1, sortOrder: 20 }, { id: 2, sortOrder: 0 }])

    expect(selectAllCards(state()).map((c) => [c.id, c.sortOrder])).toEqual([[2, 0], [1, 20]])
    expect(mockApi.updateNodeCard.mock.calls.map((c) => [c[0], c[1]])).toEqual([[1, { sortOrder: 20 }], [2, { sortOrder: 0 }]])
    expect(state().error).toBeNull()
  })

  it('reorderCards:第二个失败 → 本地回滚 + 给服务端补发原始顺序(D21)', async () => {
    useNodePoolStore.getState().setCards([
      makeCard({ id: 1, sortOrder: 0 }),
      makeCard({ id: 2, sortOrder: 10 }),
    ])
    mockApi.updateNodeCard
      .mockImplementationOnce(() => Promise.resolve(makeCard({ id: 1, sortOrder: 20 })))
      .mockImplementationOnce(() => Promise.reject(new Error('排序失败')))
      .mockImplementation((id: number, d: Partial<NodeCard>) =>
        Promise.resolve(makeCard({ id, sortOrder: d.sortOrder as number })),
      )

    await state().reorderCards([{ id: 1, sortOrder: 20 }, { id: 2, sortOrder: 0 }])

    expect(state().error).toBe('排序失败')
    expect(state().getCard(1)?.sortOrder).toBe(0)
    expect(state().getCard(2)?.sortOrder).toBe(10)
    expect(mockApi.updateNodeCard.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [1, { sortOrder: 20 }],
      [2, { sortOrder: 0 }],
      [1, { sortOrder: 0 }],
      [2, { sortOrder: 10 }],
    ])
  })

  it('reorderCards 对池中不存在的 id:本地不写入,但仍向服务端发出请求', async () => {
    mockApi.updateNodeCard.mockResolvedValue(makeCard({ id: 555, sortOrder: 1 }))

    await state().reorderCards([{ id: 555, sortOrder: 1 }])

    expect(state().cardsMap.size).toBe(0)
    expect(mockApi.updateNodeCard).toHaveBeenCalledWith(555, { sortOrder: 1 })
    expect(state().error).toBeNull()
  })

  it('reorderFolders:乐观 + 并发同步', async () => {
    useNodePoolStore.getState().setFolders([
      makeFolder({ id: 1, sortOrder: 0 }),
      makeFolder({ id: 2, sortOrder: 10 }),
    ])
    mockApi.updateNodePoolFolder.mockImplementation((id: number, d: Partial<NodePoolFolder>) =>
      Promise.resolve(makeFolder({ id, sortOrder: d.sortOrder as number })),
    )

    await state().reorderFolders([{ id: 1, sortOrder: 10 }, { id: 2, sortOrder: 0 }])

    expect(selectAllFolders(state()).map((f) => [f.id, f.sortOrder])).toEqual([[2, 0], [1, 10]])
    expect(mockApi.updateNodePoolFolder).toHaveBeenCalledTimes(2)
  })

  it('reorderFolders 失败:写 error 并回滚被重排的文件夹', async () => {
    useNodePoolStore.getState().setFolders([
      makeFolder({ id: 1, sortOrder: 0 }),
      makeFolder({ id: 2, sortOrder: 10 }),
    ])
    mockApi.updateNodePoolFolder.mockRejectedValue(new Error('文件夹排序失败'))

    await state().reorderFolders([{ id: 1, sortOrder: 10 }, { id: 2, sortOrder: 0 }])

    expect(state().error).toBe('文件夹排序失败')
    expect(state().getFolder(1)?.sortOrder).toBe(0)
    expect(state().getFolder(2)?.sortOrder).toBe(10)
  })
})

describe('validateAndFixState:状态自愈', () => {
  type Validatable = NodePoolStore & { validateAndFixState: () => void }

  const fix = () => (useNodePoolStore.getState() as Validatable).validateAndFixState()

  it('Fix1:pending 里既无卡片也无临时卡的 id 被剔除', () => {
    useNodePoolStore.setState({ pendingCardIds: new Set([123]) })

    fix()

    expect(state().pendingCardIds.has(123)).toBe(false)
  })

  it('Fix2:临时卡存在但 pending 未登记 → 补登记', () => {
    const card = makeCard({ id: -1 })
    useNodePoolStore.setState({
      cardsMap: new Map([[-1, card]]),
      temporaryCards: new Map([[-1, { card, operationId: 'op-a', status: 'creating', realCardId: null }]]),
      operationQueue: new Map(),
    })

    // operationQueue 里没 op-a,Fix3 也会一并清掉孤儿临时卡
    useNodePoolStore.setState({
      operationQueue: new Map([['op-a', {
        id: 'op-a', type: 'add', status: 'processing', cardId: -1, realCardId: null, timestamp: Date.now(), retryCount: 0,
      }]]),
    })

    fix()

    expect(state().pendingCardIds.has(-1)).toBe(true)
    expect(state().temporaryCards.has(-1)).toBe(true)
    expect(state().getCard(-1)).toBeDefined()
    expect(state().getCard(-1)?.id).toBe(-1)
  })

  it('Fix3:没有对应操作的孤儿临时卡被彻底移除', () => {
    const card = makeCard({ id: -2 })
    useNodePoolStore.setState({
      cardsMap: new Map([[-2, card]]),
      pendingCardIds: new Set([-2]),
      temporaryCards: new Map([[-2, { card, operationId: 'op-missing', status: 'creating', realCardId: null }]]),
      pendingUpdates: new Map([[-2, { name: 'x' }]]),
    })

    fix()

    expect(state().getCard(-2)).toBeUndefined()
    expect(state().temporaryCards.size).toBe(0)
    expect(state().pendingCardIds.size).toBe(0)
    expect(state().pendingUpdates.size).toBe(0)
  })

  it('Fix4:completed/failed 且超过 60s 的操作被清理,新鲜的保留', () => {
    const old = { id: 'op-old', type: 'remove' as const, status: 'completed' as const, cardId: 1, realCardId: 1, timestamp: Date.now() - 61000, retryCount: 0 }
    const fresh = { id: 'op-fresh', type: 'remove' as const, status: 'failed' as const, cardId: 2, realCardId: 2, timestamp: Date.now() - 1000, retryCount: 0 }
    useNodePoolStore.setState({ operationQueue: new Map<string, Operation>([[old.id, old], [fresh.id, fresh]]) })

    fix()

    expect(state().operationQueue.has('op-old')).toBe(false)
    expect(state().operationQueue.has('op-fresh')).toBe(true)
  })

  it('Fix4 不动还在 processing 的老操作', () => {
    const stuckProcessing = { id: 'op-stuck', type: 'remove' as const, status: 'processing' as const, cardId: 1, realCardId: 1, timestamp: Date.now() - 120000, retryCount: 0 }
    useNodePoolStore.setState({
      operationQueue: new Map([[stuckProcessing.id, stuckProcessing]]),
      processingOperations: new Set(['op-stuck']),
    })

    fix()

    expect(state().operationQueue.has('op-stuck')).toBe(true)
    expect(state().processingOperations.has('op-stuck')).toBe(true)
  })

  it('Fix5:processingOperations 中指向不存在/非 processing 操作的 id 被清除', () => {
    useNodePoolStore.setState({
      operationQueue: new Map([['op-done', {
        id: 'op-done', type: 'add' as const, status: 'completed' as const, cardId: 1, realCardId: 1, timestamp: Date.now(), retryCount: 0,
      }]]),
      processingOperations: new Set(['op-done', 'op-ghost']),
    })

    fix()

    expect(Array.from(state().processingOperations)).toEqual([])
    expect(state().operationQueue.has('op-done')).toBe(true)
  })

  it('Fix6:pendingUpdates 里指向已消失 id 的条目被删除', () => {
    const card = makeCard({ id: -3 })
    useNodePoolStore.setState({
      cardsMap: new Map([[-3, card]]),
      pendingUpdates: new Map([[-3, { name: '保留' }], [-4, { name: '丢弃' }]]),
      temporaryCards: new Map([[-3, { card, operationId: 'op-x', status: 'created', realCardId: 5 }]]),
      operationQueue: new Map([['op-x', {
        id: 'op-x', type: 'add' as const, status: 'completed' as const, cardId: -3, realCardId: 5, timestamp: Date.now(), retryCount: 0,
      }]]),
      pendingCardIds: new Set([-3]),
    })

    fix()

    expect(state().pendingUpdates.has(-3)).toBe(true)
    expect(state().pendingUpdates.has(-4)).toBe(false)
  })
})

describe('选择器', () => {
  beforeEach(() => {
    useNodePoolStore.getState().setCards([
      makeCard({ id: 1, folderId: null, sortOrder: 20 }),
      makeCard({ id: 2, folderId: null, sortOrder: 5 }),
      makeCard({ id: 3, folderId: 10, sortOrder: 1 }),
      makeCard({ id: 4, folderId: undefined, sortOrder: 0 }),
    ])
    useNodePoolStore.getState().setFolders([
      makeFolder({ id: 10, parentId: null, sortOrder: 2 }),
      makeFolder({ id: 11, parentId: null, sortOrder: 1 }),
      makeFolder({ id: 12, parentId: 10, sortOrder: 0 }),
    ])
  })

  it('selectAllCards 按 sortOrder 升序', () => {
    expect(selectAllCards(state()).map((c) => c.id)).toEqual([4, 3, 2, 1])
  })

  it('selectAllFolders 按 sortOrder 升序', () => {
    expect(selectAllFolders(state()).map((f) => f.id)).toEqual([12, 11, 10])
  })

  it('selectCardsByFolder(null) 只含显式 folderId=null 的卡(固化 undefined 不入根的行为)', () => {
    expect(selectCardsByFolder(state(), null).map((c) => c.id)).toEqual([2, 1])
    expect(selectCardsByFolder(state(), 10).map((c) => c.id)).toEqual([3])
    expect(selectCardsByFolder(state(), 999)).toEqual([])
  })

  it('selectFoldersByParent(null) 只取根文件夹并按 sortOrder', () => {
    expect(selectFoldersByParent(state(), null).map((f) => f.id)).toEqual([11, 10])
    expect(selectFoldersByParent(state(), 10).map((f) => f.id)).toEqual([12])
  })

  it('selectFolderTree 递归嵌套 children', () => {
    const tree = selectFolderTree(state())

    expect(tree.map((f) => f.id)).toEqual([11, 10])
    expect(tree[0].children).toEqual([])
    expect(tree[1].children.map((c) => c.id)).toEqual([12])
    expect(tree[1].children[0].children).toEqual([])
  })
})

describe('持久化边界', () => {
  it('store 动作不写 localStorage(无 persist 中间件,刷新即丢)', async () => {
    const setItemSpy = vi.mocked(window.localStorage.setItem)
    setItemSpy.mockClear()
    mockApi.updateNodeCard.mockResolvedValue(makeCard({ id: 5, name: '新名' }))
    mockApi.getNodePool.mockResolvedValue([])
    mockApi.getNodePoolFolders.mockResolvedValue([])

    useNodePoolStore.getState().setCards([makeCard({ id: 5, name: '旧名' })])
    useNodePoolStore.getState().setFolders([makeFolder({ id: 10, collapsed: true })])
    await state().updateCard(5, { name: '新名' })
    state().toggleFolderCollapsed(10)
    await state().loadNodePool()

    expect(setItemSpy).not.toHaveBeenCalled()
  })
})
