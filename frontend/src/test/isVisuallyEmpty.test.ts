/**
 * isVisuallyEmpty —— 决定节点是否显示「双击添加内容」占位符。
 *
 * 统一节点后这里必须区分"真的空"和"只有图片"：一张图没有文字，
 * 但节点显然不是空的。漏判会让图片节点永远显示占位符（真实踩过的坑）。
 */
import { describe, it, expect } from 'vitest'
import { isVisuallyEmpty } from '@/components/canvas/NodeItem'

describe('isVisuallyEmpty', () => {
  it('空串 / 只有空白 / 只有占位 br 视为空', () => {
    expect(isVisuallyEmpty('')).toBe(true)
    expect(isVisuallyEmpty(undefined)).toBe(true)
    expect(isVisuallyEmpty(null)).toBe(true)
    expect(isVisuallyEmpty('<p>   </p>')).toBe(true)
    expect(isVisuallyEmpty('<br>')).toBe(true)
  })

  it('有文字就是非空', () => {
    expect(isVisuallyEmpty('<p>字</p>')).toBe(false)
    expect(isVisuallyEmpty('纯文本')).toBe(false)
  })

  it('只有图片也算非空（统一节点的关键）', () => {
    const sha = 'a'.repeat(64)
    expect(isVisuallyEmpty(`<img src="/api/files/${sha}">`)).toBe(false)
    expect(isVisuallyEmpty('<img src="data:image/png;base64,iVBORw0KGgo=">')).toBe(false)
  })

  it('图片被别的标签包着也算非空', () => {
    const sha = 'b'.repeat(64)
    expect(isVisuallyEmpty(`<p><span><img src="/api/files/${sha}"></span></p>`)).toBe(false)
  })
})
