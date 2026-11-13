/**
 * 拖拽影子的内容判定。
 *
 * 回归背景（2026-11-13 真机复现）：节点池卡片只要带图，拖拽影子就整块换成
 * 一张图——"文字 + 图（图在文字下面）"的卡片拖起来只剩图片，用户以为文字丢了。
 * 落进画布后正文其实是完整的，错的是影子。
 *
 * 规则：有没有文字决定形态，不是有没有图。有文字就排文字（图在正文里），
 * 只有"整段内容没有任何文字"时才退化成图片占位。
 */
import { describe, it, expect } from 'vitest'
import { describeGhostContent, htmlHasText } from '@/features/drag-sort/ghostContent'

const IMG = '<img src="/api/files/' + 'a'.repeat(64) + '">'

describe('htmlHasText', () => {
  it('只有图片、换行、空段落时判定为没有文字', () => {
    expect(htmlHasText('')).toBe(false)
    expect(htmlHasText('<br>')).toBe(false)
    expect(htmlHasText(IMG)).toBe(false)
    expect(htmlHasText(`<p>${IMG}</p><p><br></p>`)).toBe(false)
    expect(htmlHasText('&nbsp;&nbsp;')).toBe(false)
  })

  it('有任何可见字符就判定为有文字', () => {
    expect(htmlHasText('<p>图在下面</p>')).toBe(true)
    expect(htmlHasText(`<p>说明</p><p>${IMG}</p>`)).toBe(true)
    expect(htmlHasText('a')).toBe(true)
  })
})

describe('describeGhostContent', () => {
  it('文字在上、图片在下：影子走文字形态（这正是被修掉的 bug）', () => {
    const result = describeGhostContent({
      content: `<p>先是一段文字</p><p>第二段文字</p><p>${IMG}</p>`,
      cover: '/api/files/' + 'a'.repeat(64),
    })

    expect(result.isImageOnly).toBe(false)
    expect(result.text).toContain('先是一段文字')
    expect(result.text).toContain('第二段文字')
  })

  it('纯图片内容：才退化成图片形态', () => {
    const result = describeGhostContent({
      content: `<p>${IMG}</p>`,
      cover: '/api/files/' + 'a'.repeat(64),
    })

    expect(result.isImageOnly).toBe(true)
    expect(result.imageSrc).toBe('/api/files/' + 'a'.repeat(64))
  })

  it('正文为空但有 cover：图片形态', () => {
    const result = describeGhostContent({ content: '', cover: '/api/files/x' })
    expect(result.isImageOnly).toBe(true)
  })

  it('既没有文字也没有图：文字形态（不渲染空 img）', () => {
    const result = describeGhostContent({ content: '' })
    expect(result.isImageOnly).toBe(false)
    expect(result.imageSrc).toBeNull()
    expect(result.text).toBe('')
  })

  it('只有空白与换行的正文不算文字', () => {
    const result = describeGhostContent({ content: '<p> </p><br>', cover: '/api/files/x' })
    expect(result.isImageOnly).toBe(true)
  })

  it('cover 缺失时回退到 imageUrl / thumbnail', () => {
    expect(describeGhostContent({ content: IMG, imageUrl: '/api/files/u' }).imageSrc).toBe('/api/files/u')
    expect(describeGhostContent({ content: IMG, thumbnail: '/api/files/t' }).imageSrc).toBe('/api/files/t')
  })

  it('正文纯文本预览去掉标签、折叠空白', () => {
    const result = describeGhostContent({ content: '<p>甲</p><p>乙</p>  丙' })
    expect(result.text).toBe('甲 乙 丙')
  })
})
