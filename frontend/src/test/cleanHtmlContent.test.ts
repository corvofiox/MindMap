/**
 * NodeItem 的提交期清洗器（cleanHtmlContent）。
 *
 * 背景：项目里有两套清洗——
 *   - sanitizeHTML：渲染期（dangerouslySetInnerHTML）用，白名单较宽；
 *   - cleanHtmlContent：编辑提交时（失焦 → saveContent）用，白名单较窄。
 * 统一节点把图片放进正文后，只改 sanitizeHTML 是不够的：提交时 cleanHtmlContent
 * 会把 <img> 整块剥掉，表现为"图插进去了，一点别处就没了"。
 *
 * 这里钉住：提交期必须保留安全图片、丢掉不安全来源，同时不倒退原有的文字格式。
 */
import { describe, it, expect } from 'vitest'
import { cleanHtmlContent } from '@/components/canvas/NodeItem'

const SHA = 'a'.repeat(64)

describe('cleanHtmlContent（提交期清洗）', () => {
  it('保留 /api/files 的图片，并保留 data-file-id', () => {
    const out = cleanHtmlContent(`<p>x</p><img src="/api/files/${SHA}" data-file-id="7" alt="图">`)

    expect(out).toContain('/api/files/' + SHA)
    expect(out).toContain('data-file-id="7"')
    expect(out).toContain('alt="图"')
  })

  it('保留 base64 内联图（迁移期兼容）', () => {
    const out = cleanHtmlContent('<img src="data:image/png;base64,iVBORw0KGgo=">')
    expect(out).toContain('data:image/png;base64,')
  })

  it('丢弃危险/外链图片，而不是留下空壳', () => {
    for (const src of ['javascript:alert(1)', 'https://evil.example/a.png', 'blob:http://x/y', '/api/files/notahash']) {
      const out = cleanHtmlContent(`<p>keep</p><img src="${src}">`)
      expect(out, src).not.toContain('<img')
      expect(out, src).toContain('keep')
    }
  })

  it('危险图片不会连带删除周围的文字格式', () => {
    const out = cleanHtmlContent('<b>粗体</b><img src="javascript:alert(1)"><i>斜体</i>')
    expect(out).toContain('<b>粗体</b>')
    expect(out).toContain('<i>斜体</i>')
    expect(out).not.toContain('<img')
  })

  it('仍然剥掉 script 与事件属性', () => {
    const out = cleanHtmlContent('<p onclick="x()">t</p><script>alert(1)</script>')
    expect(out).not.toContain('script')
    expect(out).not.toContain('onclick')
  })

  it('保留标题 / 引用 / 列表——工具栏提供的块级格式不能在保存时被拆成纯文本', () => {
    for (const [tag, html] of [
      ['h1', '<h1>大标题</h1>'],
      ['h2', '<h2>中标题</h2>'],
      ['h3', '<h3>小标题</h3>'],
      ['blockquote', '<blockquote>引用一句</blockquote>'],
      ['ul', '<ul><li>一</li><li>二</li></ul>'],
      ['ol', '<ol><li>甲</li></ol>'],
    ] as const) {
      const out = cleanHtmlContent(html)
      expect(out, tag).toContain(`<${tag}`)
      expect(out, tag).not.toMatch(new RegExp(`</?${tag}>.*<br>.*</${tag}>`, 'i'))
    }
  })

  it('标题里的行内格式与颜色一起保留', () => {
    const out = cleanHtmlContent('<h2><b>粗</b><span style="color: #dc2626">红</span></h2>')
    expect(out).toContain('<h2')
    expect(out).toContain('<b>粗</b>')
    expect(out).toContain('color: #dc2626')
  })
})
