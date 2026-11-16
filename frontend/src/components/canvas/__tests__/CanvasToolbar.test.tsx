import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { CanvasToolbar } from '../CanvasToolbar'
import { useCanvasStore } from '@/store/useCanvasStore'
import { useUIStore } from '@/store/useUIStore'

/**
 * 工具栏「保存」按钮的两条路径。
 *
 * 协作模式这里曾经有一个坑：按钮只弹一句「已实时保存」就 return，根本没调 onSave。
 * 而 WS 同步进的只是服务端内存里的 Yjs doc，落库是防抖 + 1s 周期刷盘——用户看到
 * "已保存"就刷新时，最后一段改动可能还没写进 yjs_update（"显示保存成功、刷新后
 * 内容回退"）。现在两种模式都必须真的走一次 onSave（协作模式下它内部触发 /flush）。
 */
describe('CanvasToolbar 保存按钮', () => {
  let addToast: ReturnType<typeof vi.fn>

  const clickSave = () => {
    const button = document.querySelector('button[title*="保存"]') as HTMLButtonElement | null
    expect(button).not.toBeNull()
    fireEvent.click(button as HTMLButtonElement)
    return button as HTMLButtonElement
  }

  beforeEach(() => {
    addToast = vi.fn()
    useUIStore.setState({ addToast: addToast as unknown as (toast: { title: string }) => void })
    useCanvasStore.setState({
      selectedIds: [],
      nodes: new Map(),
      groups: new Map(),
      domains: new Map(),
      connections: new Map(),
      zoom: 1,
      panX: 0,
      panY: 0,
    } as never)
  })

  it('非协作模式：点保存真的调 onSave，成功后提示「保存成功」', async () => {
    const onSave = vi.fn().mockResolvedValue(true)
    render(<CanvasToolbar onSave={onSave} isViewer={false} isCollabConnected={false} />)

    clickSave()

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(addToast).toHaveBeenCalled())
    expect(addToast.mock.calls[0][0]).toMatchObject({ type: 'success', title: '保存成功' })
  })

  it('协作模式：点保存同样调 onSave（不再只弹「已实时保存」就返回）', async () => {
    const onSave = vi.fn().mockResolvedValue(true)
    render(<CanvasToolbar onSave={onSave} isViewer={false} isCollabConnected />)

    clickSave()

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    // 成功提示由 onSave 内部（handleManualSave）负责，工具栏不再叠第二条
    expect(addToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: '保存成功' }))
    expect(addToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: '已实时保存' }))
  })

  it('onSave 报失败（返回 false）时不谎报成功', async () => {
    const onSave = vi.fn().mockResolvedValue(false)
    render(<CanvasToolbar onSave={onSave} isViewer={false} isCollabConnected={false} />)

    clickSave()

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(addToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: '保存成功' }))
  })
})
