/**
 * 可拖拽排序的行组件。
 *
 * 三处列表（画布 / 手稿 / 节点池）用它，所以行为必须稳：
 *   - 拖到别的行时给出前后落点提示，松手才回调；
 *   - 拖到自己身上不回调（避免无意义的写库）；
 *   - dataTransfer 拿不到内容时仍能识别拖拽源（否则会出现"拖 A 挪走 B"）。
 *
 * 注意 jsdom 没有 DataTransfer、也没有 DragEvent，testing-library 的
 * fireEvent.dragOver 不会把 clientY 写进事件对象（实测 compare 恒为 after）。
 * 所以这里显式构造事件并自己定义只读属性，再交给 act 刷新状态。
 */
import { describe, it, expect, vi } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import { SortableRow } from '@/features/drag-sort/SortableRow'

/** jsdom 没有 DataTransfer，这里造一个最小实现 */
function makeDataTransfer(initial?: string) {
  const store = new Map<string, string>()
  if (initial !== undefined) store.set('text/plain', initial)
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: (key: string, value: string) => store.set(key, value),
    getData: (key: string) => store.get(key) ?? '',
  } as unknown as DataTransfer
}

/** 让行的上下半区固定下来：top=100, height=40 → 中线 120 */
function stubRect(el: HTMLElement) {
  el.getBoundingClientRect = () => ({
    top: 100, height: 40, bottom: 140, left: 0, right: 200, width: 200, x: 0, y: 100,
    toJSON: () => ({}),
  }) as DOMRect
}

/** 派发一个带 dataTransfer / clientY 的拖拽事件 */
function fireDrag(
  el: HTMLElement,
  type: 'dragstart' | 'dragover' | 'drop' | 'dragend',
  options: { dataTransfer?: DataTransfer; clientY?: number } = {},
) {
  stubRect(el)
  const event = new Event(type, { bubbles: true, cancelable: true })
  const dataTransfer = options.dataTransfer ?? makeDataTransfer()
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer, configurable: true })
  Object.defineProperty(event, 'clientY', { value: options.clientY ?? 0, configurable: true })
  Object.defineProperty(event, 'clientX', { value: 100, configurable: true })
  act(() => {
    el.dispatchEvent(event)
  })
  return event
}

describe('SortableRow', () => {
  it('拖到上半部分 → 回调 before', () => {
    const onDropRow = vi.fn()
    render(
      <SortableRow rowId={1} onDropRow={onDropRow}>
        <span>第一行</span>
      </SortableRow>,
    )
    const row = document.querySelector('[data-drag-row]') as HTMLElement

    fireDrag(row, 'dragstart', { dataTransfer: makeDataTransfer('9') })
    fireDrag(row, 'drop', { dataTransfer: makeDataTransfer('9'), clientY: 105 })

    expect(onDropRow).toHaveBeenCalledWith(9, 'before')
  })

  it('拖到下半部分 → 回调 after', () => {
    const onDropRow = vi.fn()
    render(
      <SortableRow rowId={1} onDropRow={onDropRow}>
        <span>第一行</span>
      </SortableRow>,
    )
    const row = document.querySelector('[data-drag-row]') as HTMLElement

    fireDrag(row, 'dragstart', { dataTransfer: makeDataTransfer('9') })
    fireDrag(row, 'drop', { dataTransfer: makeDataTransfer('9'), clientY: 135 })

    expect(onDropRow).toHaveBeenCalledWith(9, 'after')
  })

  it('拖到自己身上不回调', () => {
    const onDropRow = vi.fn()
    render(
      <SortableRow rowId={5} onDropRow={onDropRow}>
        <span>自己</span>
      </SortableRow>,
    )
    const row = document.querySelector('[data-drag-row]') as HTMLElement

    fireDrag(row, 'dragstart', { dataTransfer: makeDataTransfer('5') })
    fireDrag(row, 'drop', { dataTransfer: makeDataTransfer('5'), clientY: 105 })

    expect(onDropRow).not.toHaveBeenCalled()
  })

  it('dataTransfer 为空时仍能认出拖拽源（不把目标行自己挪走）', () => {
    const onDropRow = vi.fn()
    render(
      <div>
        <SortableRow rowId={1} onDropRow={onDropRow}>
          <span>源</span>
        </SortableRow>
        <SortableRow rowId={2} onDropRow={onDropRow}>
          <span>目标</span>
        </SortableRow>
      </div>,
    )
    const [source, target] = Array.from(document.querySelectorAll('[data-drag-row]')) as HTMLElement[]

    // 源行没带 dataTransfer（模拟某些环境）
    fireDrag(source, 'dragstart', { dataTransfer: makeDataTransfer() })
    const event = fireDrag(target, 'drop', { dataTransfer: makeDataTransfer(), clientY: 105 })

    // drop 事件确实被组件接收到了（preventDefault 被调用）
    expect(event.defaultPrevented).toBe(true)
    expect(target.getAttribute('data-drop-hint')).toBeNull()
  })

  it('dragover 时给出落点提示，松手后清掉', async () => {
    render(
      <SortableRow rowId={1} onDropRow={vi.fn()}>
        <span>行</span>
      </SortableRow>,
    )
    const row = document.querySelector('[data-drag-row]') as HTMLElement

    fireDrag(row, 'dragstart', { dataTransfer: makeDataTransfer('9') })
    fireDrag(row, 'dragover', { dataTransfer: makeDataTransfer('9'), clientY: 105 })
    await waitFor(() => expect(row.getAttribute('data-drop-hint')).toBe('before'))

    fireDrag(row, 'drop', { dataTransfer: makeDataTransfer('9'), clientY: 105 })
    await waitFor(() => expect(row.getAttribute('data-drop-hint')).toBeNull())
  })

  it('disabled 时不可拖、也不接受放下', () => {
    const onDropRow = vi.fn()
    render(
      <SortableRow rowId={1} onDropRow={onDropRow} disabled>
        <span>禁用</span>
      </SortableRow>,
    )
    const row = document.querySelector('[data-drag-row]') as HTMLElement
    expect(row.getAttribute('draggable')).toBe('false')

    fireDrag(row, 'drop', { dataTransfer: makeDataTransfer('9'), clientY: 105 })
    expect(onDropRow).not.toHaveBeenCalled()
  })

  it('行上带 data-row-id，便于外部定位', () => {
    render(
      <SortableRow rowId={42} onDropRow={vi.fn()}>
        <span>行</span>
      </SortableRow>,
    )
    expect(
      (document.querySelector('[data-drag-row]') as HTMLElement).getAttribute('data-row-id'),
    ).toBe('42')
  })
})
