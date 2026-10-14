import { describe, it, expect } from 'vitest'
import { sanitizeHTML, stripHTML, containsHTML, safeHTML } from '@/utils/sanitizeHTML'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * sanitizeHTML / safeHTML / stripHTML / containsHTML 的真实行为测试。
 *
 * 被测模块只有一个：@/utils/sanitizeHTML（DOMParser 白名单式净化器）。
 * 本文件不断言"净化器不可能执行脚本"这类恒真命题——jsdom 的 innerHTML
 * 赋值本来就不执行 <script>，拿它当"安全性证据"是假测试。
 * 真正可判定的契约是**输出串的结构**：把净化结果再解析一次，
 * 输出里不允许出现白名单外的标签、不允许出现任何事件处理属性或 URL 属性。
 * 破坏净化器（放宽标签白名单 / 放宽属性白名单 / 关掉 style 值过滤）时，
 * 这些断言必须变红——本文件末尾的源码守卫测试也各自对应一条变异验证。
 *
 * 为什么不断言"alert 没被调用"：实测本 jsdom 环境对 innerHTML 注入的
 * <script>、onerror、createElement('script')+appendChild 一律不执行
 * （对照组全部为 0 次调用）。拿"没有执行"当安全证据是恒真断言，
 * 因此本文件只断言可判定的结构性质。
 *
 * 实测发现（不是假设，来自跑出来的结果，见各 it.fails 用例与注释）：
 *  1. sanitizeHTML 对"白名单外且带子节点/自闭合"的元素会抛 DOMException
 *     NotFoundError（unwrap 循环用 insertBefore 移动子节点后，又对已脱管的
 *     节点调用 removeChild）。<script>、<img>、<a>、<style>、<iframe> 全抛。
 *     安全上不出事是因为 NodeCardItem 用的出口是 safeHTML（try/catch 兜底），
 *     代价是丢格式；直接调 sanitizeHTML 的调用方会崩。
 *  2. 兜底路径 stripHTML 会把 <script> 的文本内容当正文吐出来。
 *  3. 二次解析（mXSS）在 <plaintext> / <xmp> / <math>…<style> 这类
 *     "原文本元素"上会漏出可执行标签——净化结果本身含 <script>。
 */

/** 净化器源码里声明的标签白名单（测试侧的独立副本，用来产生可失败的断言） */
const EXPECTED_ALLOWED_TAGS = [
  'p', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'strike',
  'sub', 'sup', 'mark', 'small', 'del', 'ins',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'div', 'br', 'hr',
  'code', 'pre',
  'blockquote',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
]

/** 净化后绝不允许出现的标签（执行/注入载体） */
const NEVER_TAGS = [
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form',
  'link', 'meta', 'base', 'svg', 'math', 'template', 'plaintext', 'xmp',
  'noembed', 'noframes', 'noscript', 'textarea', 'title', 'input', 'button',
  'select', 'option', 'img', 'audio', 'video', 'source', 'marquee', 'details',
  'applet', 'body', 'html', 'head', 'font', 'a',
]

const DANGEROUS_SCHEME = /(javascript|vbscript|livescript|data)\s*:/i

function styleProps(styleValue: string): string[] {
  return styleValue
    .split(';')
    .map((d) => d.split(':')[0].trim().toLowerCase())
    .filter(Boolean)
}

interface Finding {
  where: string
  reason: string
}

/**
 * 把净化结果当作"将被 dangerouslySetInnerHTML 注入的字符串"再解析一次，
 * 找出结构上的注入面。这是本文件唯一的安全性判据。
 */
function audit(html: string): Finding[] {
  const host = document.createElement('div')
  host.innerHTML = html
  const findings: Finding[] = []

  const visit = (root: ParentNode | DocumentFragment, prefix: string) => {
    Array.from(root.querySelectorAll('*')).forEach((el) => {
      const tag = el.tagName.toLowerCase()
      const where = `${prefix}/${tag}`

      if (NEVER_TAGS.includes(tag)) {
        findings.push({ where, reason: `白名单外标签存活: <${tag}>` })
      }
      if (!EXPECTED_ALLOWED_TAGS.includes(tag)) {
        findings.push({ where, reason: `未知标签存活: <${tag}>` })
      }

      Array.from(el.attributes).forEach((attr) => {
        const name = attr.name.toLowerCase()
        const ok =
          name === 'class' ||
          name === 'style' ||
          ((tag === 'td' || tag === 'th') && (name === 'colspan' || name === 'rowspan'))
        if (!ok) {
          findings.push({ where, reason: `非白名单属性存活: ${attr.name}="${attr.value}"` })
        }
        if (/^on[a-z]/.test(name)) {
          findings.push({ where, reason: `事件处理属性存活: ${attr.name}` })
        }
        if (name !== 'class' && DANGEROUS_SCHEME.test(attr.value)) {
          findings.push({ where, reason: `危险协议在属性值里: ${attr.name}="${attr.value}"` })
        }
        if (name === 'style') {
          if (DANGEROUS_SCHEME.test(attr.value)) {
            findings.push({ where, reason: `危险协议在 style 里: ${attr.value}` })
          }
          if (/(expression\s*\(|behaviou?r\s*:|binding\s*:|-moz-binding)/i.test(attr.value)) {
            findings.push({ where, reason: `危险 CSS 函数/属性: ${attr.value}` })
          }
          styleProps(attr.value).forEach((prop) => {
            if (prop !== 'expression' && !prop.startsWith('-')) return
            findings.push({ where, reason: `可疑 CSS 属性: ${prop}` })
          })
        }
      })

      if (tag === 'template') {
        visit((el as HTMLTemplateElement).content, `${where}[template]`)
      }
    })
  }

  visit(host, '')
  return findings
}

/** 归一化输出串，便于做"整串相等"断言 */
function sanitize(html: string): string {
  return sanitizeHTML(html)
}

/** 断言净化结果结构安全，并返回该结果 */
function expectSafe(html: string): string {
  const out = safeHTML(html)
  const findings = audit(out)
  expect(findings).toEqual([])
  return out
}

describe('sanitizeHTML — 标签白名单（净化 + 保真）', () => {
  it('保留富文本编辑器真正产出的格式标签，逐串相等', () => {
    expect(sanitize('<p>keep <strong>bold</strong> and <em>italic</em></p>')).toBe(
      '<p>keep <strong>bold</strong> and <em>italic</em></p>',
    )
    expect(sanitize('<p>a</p><p>b</p>')).toBe('<p>a</p><p>b</p>')
    expect(sanitize('<ul><li>x</li></ul>')).toBe('<ul><li>x</li></ul>')
    expect(sanitize('<blockquote><p>q</p></blockquote>')).toBe('<blockquote><p>q</p></blockquote>')
    expect(sanitize('<pre><code>let a = 1</code></pre>')).toBe('<pre><code>let a = 1</code></pre>')
    expect(sanitize('<h1>T</h1><h6>T</h6>')).toBe('<h1>T</h1><h6>T</h6>')
    expect(
      sanitize('<sub>s</sub><sup>s</sup><mark>m</mark><small>sm</small><del>d</del><ins>i</ins><s>s</s><strike>t</strike><b>B</b><i>I</i><u>U</u>'),
    ).toBe(
      '<sub>s</sub><sup>s</sup><mark>m</mark><small>sm</small><del>d</del><ins>i</ins><s>s</s><strike>t</strike><b>B</b><i>I</i><u>U</u>',
    )
    expect(sanitize('<br>')).toBe('<br>')
    expect(sanitize('<hr>')).toBe('<hr>')
    expect(sanitize('<div><span>嵌套</span></div>')).toBe('<div><span>嵌套</span></div>')
  })

  it('表格里 td/th 的 colspan/rowspan 被保留，width 等其它属性被剥掉', () => {
    expect(
      sanitize('<table><tbody><tr><td colspan="2" rowspan="3">c</td></tr></tbody></table>'),
    ).toBe('<table><tbody><tr><td colspan="2" rowspan="3">c</td></tr></tbody></table>')

    expect(
      sanitize('<table><thead><tr><th colspan="9" width="100" align="left">h</th></tr></thead></table>'),
    ).toBe('<table><thead><tr><th colspan="9">h</th></tr></thead></table>')
  })

  it('裸 <td>（不在 table 上下文）被解析器丢弃，只剩文本', () => {
    // 白名单允许 td，但 HTML 解析器会在没有 table 祖先时丢掉单元格标签本身；
    // 记下来防止有人误以为 "td 一定存活"。
    expect(sanitize('<td colspan="2" width="100">c</td>')).toBe('c')
  })

  it('白名单外标签的 unwrap 干净完成（修复前抛 NotFoundError，直接调用方会崩）', () => {
    const unwrapThrows = [
      '<script>alert(1)</script>',
      '<b><script>alert(1)</script></b>',
      '<p><script>alert(1)</script></p>',
      '<a href="x">click</a>',
      '<font color="red">legacy</font>',
      '<outer><p>inner</p></outer>',
      '<img src="a.png" alt="pic">',
      '<style>body{display:none}</style>',
      '<iframe src="x"></iframe>',
    ]
    // 修复前：unwrap 循环对已脱管的 <script> 再调 removeChild → NotFoundError，
    // 直接调 sanitizeHTML 的调用方全崩，只有 safeHTML 的兜底救场（代价是丢格式）。
    // 修复后：解包不抛、文本保留、危险标签消失。逐个断言精确输出。
    const expectedOutputs: Record<string, string> = {
      '<script>alert(1)</script>': 'alert(1)',
      '<b><script>alert(1)</script></b>': '<b>alert(1)</b>',
      '<p><script>alert(1)</script></p>': '<p>alert(1)</p>',
      '<a href="x">click</a>': 'click',
      '<font color="red">legacy</font>': 'legacy',
      '<outer><p>inner</p></outer>': '<p>inner</p>',
      '<img src="a.png" alt="pic">': '',
      '<style>body{display:none}</style>': 'body{display:none}',
      '<iframe src="x"></iframe>': '',
    }
    unwrapThrows.forEach((payload) => {
      expect(() => sanitize(payload)).not.toThrow()
      expect(sanitize(payload)).toBe(expectedOutputs[payload])
    })
  })

  it('纯文本、空串、已转义文本原样保留', () => {
    expect(sanitize('plain text no markup')).toBe('plain text no markup')
    expect(sanitize('')).toBe('')
    expect(sanitize('   \n\t ')).toBe('   \n\t ')
    expect(sanitize('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    )
    expect(sanitize('<p>3 &lt; 5 &amp; 6 &gt; 2</p>')).toBe('<p>3 &lt; 5 &amp; 6 &gt; 2</p>')
    // 双重转义只解一层，不会被"解码"成新标签
    expect(sanitize('<p>&amp;lt;script&amp;gt;</p>')).toBe('<p>&amp;lt;script&amp;gt;</p>')
    expect(audit(sanitize('<p>&amp;lt;script&amp;gt;</p>'))).toEqual([])
  })

  it('实体编码的标签不会变成真标签：十进制/十六进制/命名三种写法都留在文本层', () => {
    const hex = sanitize('<p>&#x3c;script&#x3e;alert(1)&#x3c;/script&#x3e;</p>')
    const dec = sanitize('<p>&#60;script&#62;alert(1)&#60;/script&#62;</p>')
    expect(hex).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
    expect(dec).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
    // 关键：输出里不存在 script 元素（被再次解析仍是文本）
    expect(audit(hex)).toEqual([])
    expect(audit(dec)).toEqual([])
    expect(hex).not.toBe('<p><script>alert(1)</script></p>')
  })

  it('注释会存活在输出里（当前行为，钉住）', () => {
    expect(sanitize('<!--x-->')).toBe('<!--x-->')
    expect(sanitize('<!-- comment --><p>after</p>')).toBe('<!-- comment --><p>after</p>')
    expect(sanitize('<![CDATA[raw]]><p>x</p>')).toBe('<!--[CDATA[raw]]--><p>x</p>')
  })

  it('浏览器解析纠错后的结构仍然安全（错配标签闭合）', () => {
    expect(sanitize('<p>a<b>b</p>c</b>')).toBe('<p>a<b>b</b></p><b>c</b>')
    expect(sanitize('<p>unclosed <b>bold')).toBe('<p>unclosed <b>bold</b></p>')
    expect(expectSafe('<p>unclosed <b>bold')).toBe('<p>unclosed <b>bold</b></p>')
  })

  it('emoji / 不换行空格等非 ASCII 内容不被破坏', () => {
    expect(sanitize('<p>emoji 😀 &nbsp; nl</p>')).toBe('<p>emoji 😀 &nbsp; nl</p>')
    expect(sanitize('<p>中文 <strong>粗体</strong></p>')).toBe('<p>中文 <strong>粗体</strong></p>')
  })
})

describe('sanitizeHTML — 事件处理属性（含混淆写法）', () => {
  const handlerPayloads: Array<[string, string, string]> = [
    ['普通 onclick', '<p onclick="alert(1)">hi</p>', '<p>hi</p>'],
    ['全大写 ONCLICK', '<p ONCLICK="alert(1)">hi</p>', '<p>hi</p>'],
    ['大小写混排 OnClIcK', '<p OnClIcK="alert(1)">hi</p>', '<p>hi</p>'],
    ['onerror', '<p onerror="alert(1)">hi</p>', '<p>hi</p>'],
    ['onload', '<p onload="alert(1)">hi</p>', '<p>hi</p>'],
    ['onmouseover 无引号', '<p onmouseover=alert(1)>hi</p>', '<p>hi</p>'],
    ['on 与 = 之间空格', '<p on error="alert(1)">hi</p>', '<p>hi</p>'],
    ['属性名中间插空格（解析成 on + click）', '<p on click="alert(1)">hi</p>', '<p>hi</p>'],
    ['tab 分隔 onerror\\t=\\t', '<p onerror\t=\t"alert(1)">hi</p>', '<p>hi</p>'],
    ['换行分隔 onerror=\\n"', '<p onerror=\n"alert(1)">hi</p>', '<p>hi</p>'],
    ['连字符写法 on-error', '<p on-error="alert(1)">hi</p>', '<p>hi</p>'],
    ['onfocus 无引号', '<p onfocus=alert(1)>hi</p>', '<p>hi</p>'],
    ['ontoggle', '<p ontoggle=alert(1)>hi</p>', '<p>hi</p>'],
    ['onanimationstart 长名字', '<p onanimationstart="alert(1)">hi</p>', '<p>hi</p>'],
    ['id/name/rel/title 也要清掉', '<p id="x" name="y" rel="z" title="t">t</p>', '<p>t</p>'],
    ['data-* 属性', '<p data-foo="1">t</p>', '<p>t</p>'],
    ['srcdoc 属性（内嵌文档注入）', '<p srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;">t</p>', '<p>t</p>'],
    ['contenteditable / tabindex（钓鱼面）', '<p contenteditable="true" tabindex="0">edit</p>', '<p>edit</p>'],
    ['formaction（可指向 javascript:）', '<p formaction="javascript:alert(1)">t</p>', '<p>t</p>'],
  ]

  handlerPayloads.forEach(([label, payload, expected]) => {
    it(`剥掉属性后保留元素与文本: ${label}`, () => {
      const out = sanitize(payload)
      expect(out).toBe(expected)

      const host = document.createElement('div')
      host.innerHTML = out
      const p = host.querySelector('p')
      expect(p).not.toBeNull()
      expect(p!.attributes.length).toBe(0)
      expect(audit(out)).toEqual([])
    })
  })

  it('事件属性被移除后，整串必须等于无属性版本', () => {
    expect(sanitize('<p onclick="alert(1)">hi</p>')).toBe('<p>hi</p>')
    expect(sanitize('<p ONERROR="alert(1)">hi</p>')).toBe('<p>hi</p>')
    expect(sanitize('<span class="a b" style="color:red" data-x="1" onclick="evil()">keep</span>')).toBe(
      '<span class="a b" style="color:red">keep</span>',
    )
    expect(sanitize('<p title="javascript:alert(1)">s</p>')).toBe('<p>s</p>')
  })

  it('class 保留但内容不被改写（应用依赖 class 做样式）', () => {
    expect(sanitize('<span class="bg-yellow-200 dark:bg-yellow-800">x</span>')).toBe(
      '<span class="bg-yellow-200 dark:bg-yellow-800">x</span>',
    )
  })

  it('元素不在白名单时，其事件属性随元素一起消失（不泄漏 handler 文本）', () => {
    expect(stripHTML(safeHTML('<input onfocus=alert(1) autofocus>'))).toBe('')
    expect(safeHTML('<audio src=x onerror=alert(1)>')).toBe('')
    expect(safeHTML('<video><source onerror="alert(1)"></video>')).toBe('')
    expect(safeHTML('<details open ontoggle=alert(1)>')).toBe('')
    expectSafe('<audio src=x onerror=alert(1)>')
    expectSafe('<video><source onerror="alert(1)"></video>')
  })
})

describe('sanitizeHTML — style 属性过滤（CSS 注入面）', () => {
  it('保留白名单内的 CSS 属性，大小写与顺序不敏感', () => {
    expect(sanitize('<p style="color:red">red</p>')).toBe('<p style="color:red">red</p>')
    expect(sanitize('<div style="COLOR: #ff0000; font-size: 14px">x</div>')).toBe(
      '<div style="COLOR: #ff0000; font-size: 14px">x</div>',
    )
    expect(sanitize('<div style="color:red;position:absolute;float:left;font-weight:bold">x</div>')).toBe(
      '<div style="color:red; font-weight:bold">x</div>',
    )
    expect(sanitize('<div style="color:red;">x</div>')).toBe('<div style="color:red">x</div>')
  })

  it('expression() 被剔除，同一条 style 里合法属性保留', () => {
    expect(sanitize('<div style="color:red;width:expression(alert(1))">x</div>')).toBe(
      '<div style="color:red">x</div>',
    )
    expect(sanitize('<div style="width:EXPRESSION(alert(1));color:red">x</div>')).toBe(
      '<div style="color:red">x</div>',
    )
    expect(sanitize('<div style="width:expression(alert(1))">x</div>')).toBe('<div>x</div>')
  })

  it('值里含 javascript:/vbscript:/data: 的声明被剔除', () => {
    expect(sanitize('<div style="color:url(javascript:alert(1))">x</div>')).toBe('<div>x</div>')
    expect(sanitize('<div style="color:javascript:alert(1)">x</div>')).toBe('<div>x</div>')
    expect(sanitize('<div style="background:url(vbscript:x)">x</div>')).toBe('<div>x</div>')
    expect(sanitize('<div style="background:url(data:image/png;base64,AAA)">x</div>')).toBe('<div>x</div>')
    // 实体写法：DOM 取值时已解码成 javascript:，仍被拦住
    expect(sanitize('<div style="color:url(&#106;avascript:alert(1))">x</div>')).toBe('<div>x</div>')
  })

  it('白名单外的 CSS 属性一律剔除（behavior/-o-link/-moz-binding/position 都不在名单里）', () => {
    expect(sanitize('<div style="behavior:url(xss.htc)">x</div>')).toBe('<div>x</div>')
    expect(sanitize('<div style="-o-link:javascript:alert(1)">x</div>')).toBe('<div>x</div>')
    expect(sanitize('<div style="-moz-binding:url(evil.xml#xss)">x</div>')).toBe('<div>x</div>')
    expect(sanitize('<div style="position:absolute;left:0">x</div>')).toBe('<div>x</div>')
    expect(sanitize('<div style="background:url(http://a/b.png)">x</div>')).toBe('<div>x</div>')
  })

  it('畸形声明被丢弃，不会产生半个属性', () => {
    expect(sanitize('<div style="color">x</div>')).toBe('<div>x</div>')
    expect(sanitize('<div style="">x</div>')).toBe('<div>x</div>')
    expect(sanitize('<div style=";;;">x</div>')).toBe('<div>x</div>')
  })

  it('净化后的 style 再解析一次，属性只可能是白名单里的', () => {
    const nasty = [
      '<div style="color:red;behavior:url(x);width:expression(alert(1))">x</div>',
      '<div style="background:javascript:alert(1)">x</div>',
      '<div style="color:red/*@x*/;background:url(vbscript:x)">x</div>',
    ]
    nasty.forEach((payload) => {
      const out = sanitize(payload)
      const host = document.createElement('div')
      host.innerHTML = out
      const el = host.querySelector('[style]')
      if (el) {
        styleProps(el.getAttribute('style') || '').forEach((prop) => {
          expect([
            'color', 'background-color', 'font-size', 'font-weight', 'font-style',
            'text-decoration', 'text-align', 'line-height', 'letter-spacing',
            'word-spacing', 'padding', 'margin', 'border', 'display',
          ]).toContain(prop)
        })
      }
      expect(audit(out)).toEqual([])
    })
  })

  it('跨换行的协议名已被剔除（修复前 /javascript:/i 漏掉换行拆开的协议名）', () => {
    // CSS 里换行是空白：浏览器解析时 "java\nscript:" 拼回 javascript:...
    // 修复后 sanitizeStyle 对空白剥离后的副本做危险值检查，声明被剔除。
    const out = sanitize('<span style="color:java\nscript:alert(1)">x</span>')
    expect(out).toBe('<span>x</span>')
  })

  it('钉住当前行为：普通 javascript: 值被剔除（与上一条对照，证明换行不再是绕过点）', () => {
    expect(sanitize('<span style="color:javascript:alert(1)">x</span>')).toBe('<span>x</span>')
  })
})

/** 净化结果里可接受的结构（class/style 之外的属性一律视为注入面） */
interface AuditVector {
  label: string
  payload: string
}

const NEUTRALISED_VECTORS: AuditVector[] = [
  { label: '小写 script', payload: '<script>alert(1)</script>' },
  { label: '大写 SCRIPT', payload: '<SCRIPT>alert(1)</SCRIPT>' },
  { label: '大小写混排 ScRiPt', payload: '<ScRiPt>alert(1)</ScRiPt>' },
  { label: '带 type 的 script', payload: '<script type="text/javascript">alert(1)</script>' },
  { label: '带 src 外链 script', payload: '<script src="//evil.com/x.js"></script>' },
  { label: '自闭合 script', payload: '<script/>' },
  { label: '空参数 script', payload: '<script >alert(1)</script>' },
  { label: '换行参数 script', payload: '<script\n>alert(1)</script>' },
  { label: 'script 嵌在 p 内', payload: '<p><script>alert(1)</script></p>' },
  { label: 'script 嵌在 b 内', payload: '<b><script>alert(1)</script></b>' },
  { label: '重组式 <scr<script>ipt>', payload: '<scr<script>ipt>alert(1)</script>' },
  { label: '注释拼接 <<script>', payload: '<<script>alert(1)//<;</script>' },
  { label: 'NUL 字节拆分标签', payload: '<scri\x00pt>alert(1)</script>' },
  { label: 'svg 内 script', payload: '<svg><script>alert(1)</script></svg>' },
  { label: 'iframe + javascript:', payload: '<iframe src="javascript:alert(1)"></iframe>' },
  { label: 'iframe srcdoc', payload: '<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>' },
  { label: 'object', payload: '<object data="x"></object>' },
  { label: 'object + param', payload: '<object><param name="data" value="x"></param></object>' },
  { label: 'embed', payload: '<embed src="x.swf" type="application/x-shockwave-flash">' },
  { label: 'form + javascript action', payload: '<form action="javascript:alert(1)"><button type="submit">go</button></form>' },
  { label: 'link', payload: '<link rel="stylesheet" href="evil.css">' },
  { label: 'meta refresh', payload: '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">' },
  { label: 'base', payload: '<base href="javascript:alert(1)">' },
  { label: 'style 标签', payload: '<style>* { color: red }</style>' },
  { label: 'style 里藏 javascript url', payload: '<style>* { background: url(javascript:alert(1)) }</style>' },
  { label: 'img + onerror', payload: '<img src=x onerror=alert(1)>' },
  { label: 'a + javascript:', payload: '<a href="javascript:alert(1)">click</a>' },
  { label: 'a + 前导空格协议', payload: '<a href="  JaVaScRiPt:alert(1)">click</a>' },
  { label: 'a + 实体协议', payload: '<a href="&#106;avascript:alert(1)">click</a>' },
  { label: 'a + data:text/html', payload: '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>' },
  { label: 'a + vbscript', payload: '<a href="vbscript:msgbox(1)">x</a>' },
  { label: 'textarea', payload: '<textarea>anything</textarea>' },
  { label: 'title 标签', payload: '<title>t</title>' },
  { label: 'template', payload: '<template><img src=x onerror=alert(1)></template>' },
  { label: 'select/option', payload: '<select><option>a</option></select>' },
  { label: 'marquee onstart', payload: '<marquee onstart=alert(1)>x</marquee>' },
  { label: 'input autofocus onfocus', payload: '<input onfocus=alert(1) autofocus>' },
  { label: 'isindex', payload: '<isindex>' },
  { label: 'frameset', payload: '<frameset><frame src="x"></frameset>' },
  { label: 'body onload', payload: '<body onload=alert(1)>text</body>' },
  { label: 'font 遗留标签', payload: '<font color="red">legacy</font>' },
  { label: '实体写法 &lt;script&gt;', payload: '&lt;script&gt;alert(1)&lt;/script&gt;' },
  { label: '&Tab; 前缀 + script', payload: '&Tab;<script>alert(1)</script>' },
  { label: 'p + onclick', payload: '<p onclick="alert(1)">hi</p>' },
  { label: 'span + style + javascript', payload: '<span style="background:url(javascript:alert(1))">x</span>' },
  { label: 'table + td 恶意 style', payload: '<table><tbody><tr><td style="width:expression(alert(1))">c</td></tr></tbody></table>' },
]

describe('safeHTML — 出口安全契约（NodeCardItem 真正用的函数）', () => {
  NEUTRALISED_VECTORS.forEach(({ label, payload }) => {
    it(`净化后的输出再解析没有任何注入面: ${label}`, () => {
      const out = safeHTML(payload)
      expect(audit(out)).toEqual([])
    })
  })

  it('净化后的合法富文本仍完整保真（安全性不以破坏格式为代价）', () => {
    const benign = '<p class="lead" style="color:red">普通 <strong>富文本</strong> 内容<br>第二行</p>'
    expect(safeHTML(benign)).toBe(benign)
    expect(audit(safeHTML(benign))).toEqual([])
  })
})

describe('safeHTML — 已证实的绕过（mXSS / 兜底路径），修复后这些用例会变红', () => {
  /**
   * 修复前这 4 条是净化器的真实漏洞：sanitizeHTML 抛 NotFoundError →
   * safeHTML 兜底 stripHTML → 而 stripHTML 的返回值**没有再转义**就被
   * NodeCardItem 塞进 dangerouslySetInnerHTML，"文本"里的标签被重新解析成真元素。
   * 修复后（unwrap 逐子消毒 + 不再抛错）：四个向量的输出全部惰性，
   * 用常规用例钉住（净化器回归时它们会变红）。
   */
  const bypassVectors: AuditVector[] = [
    {
      label: '<plaintext> 之后全部内容被当作正文，<script> 原样回吐',
      payload: '<plaintext><script>alert(1)</script>',
    },
    {
      label: '<xmp> 原文本元素让 img+onerror 逃过属性清洗',
      payload: '<xmp><img src=x onerror=alert(1)></xmp>',
    },
    {
      label: '<math>…<style> 的原文本被当 HTML 重放',
      payload:
        '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>',
    },
    {
      label: '<noscript> 属性截断让 <p title> 复活',
      payload: '<noscript><p title="</noscript><img src=x onerror=alert(1)>">x</p></noscript>',
    },
  ]

  bypassVectors.forEach(({ label, payload }) => {
    it(`出口应当无注入面: ${label}`, () => {
      expect(audit(safeHTML(payload))).toEqual([])
    })
  })

  it('修复后的 4 条绕过输出逐字钉住（防止行为悄悄漂移）', () => {
    // 全部输出惰性：标签被 unwrap，文本被转义，无任何可执行结构。
    const scriptOut = safeHTML('<plaintext><script>alert(1)</script>')
    expect(scriptOut).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
    const host = document.createElement('div')
    host.innerHTML = scriptOut
    expect(host.querySelector('script')).toBeNull()

    const imgOut = safeHTML('<xmp><img src=x onerror=alert(1)></xmp>')
    expect(imgOut).toBe('&lt;img src=x onerror=alert(1)&gt;')
    host.innerHTML = imgOut
    expect(host.querySelector('img[onerror]')).toBeNull()

    const mathOut = safeHTML(
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>',
    )
    // 修复前这里是裸 <img onerror>（unwrap 从不重访被提升的子树，mXSS）；
    // 修复后 img 标记是转义文本，只剩空 table。
    expect(mathOut).toBe('&lt;img src=x onerror=alert(1)&gt;<table></table>')

    const noscriptOut = safeHTML('<noscript><p title="</noscript><img src=x onerror=alert(1)>">x</p></noscript>')
    expect(noscriptOut).toBe('&lt;p title=""&gt;x<p></p>')
  })
})
describe('safeHTML — 主路径 vs 兜底路径契约', () => {
  it('无危险内容时 safeHTML === sanitizeHTML（走主路径，不是兜底）', () => {
    const benign = '<p>普通 <strong>富文本</strong> 内容</p>'
    expect(safeHTML(benign)).toBe(sanitizeHTML(benign))
    expect(safeHTML(benign)).toBe(benign)
  })

  it('白名单内标签 + 危险标签混排：主路径保留格式、剔除危险标签（修复前走兜底丢格式）', () => {
    const out = safeHTML('<p>keep</p><script>alert(1)</script>')
    // 修复前：sanitizeHTML 抛 NotFoundError → 兜底把 <p> 也剥了（'keepalert(1)'）。
    // 修复后：主路径完成净化——<p> 保留，<script> 的文本提升为正文。
    expect(out).toBe('<p>keep</p>alert(1)')
    const host = document.createElement('div')
    host.innerHTML = out
    expect(host.querySelector('script')).toBeNull()
    expect(host.querySelector('p')).not.toBeNull()
  })

  it('safeHTML 对非字符串/假值一律返回空串', () => {
    expect(safeHTML('')).toBe('')
    expect(safeHTML(null as unknown as string)).toBe('')
    expect(safeHTML(undefined as unknown as string)).toBe('')
    expect(safeHTML(123 as unknown as string)).toBe('')
    expect(safeHTML({ toString: () => '<script>a</script>' } as unknown as string)).toBe('')
  })

  it('深度嵌套不被截断且 safeHTML 不抛错（净化器无递归上限）', () => {
    const deep = `${'<b>'.repeat(2000)}x${'</b>'.repeat(2000)}`
    const out = safeHTML(deep)
    expect(out).toBe(sanitizeHTML(deep))
    expect(out.length).toBe(14001)
    expect(out.startsWith('<b><b><b>')).toBe(true)
    expect(out.endsWith('</b></b></b>')).toBe(true)
  })

  it('超长输入：合法内容完整通过，白名单外内容解包且不抛错', () => {
    // 规模取 2000：语义断言（不截断/不抛/净化干净）在 2k 已完全成立。
    // 更大的规模测的是 jsdom 的 DOM 成本而非净化器——jsdom 的
    // insertBefore/removeChild 是 O(位置)（实测纯 DOM 解包 4k→0.8s、8k→2.9s），
    // 真实浏览器是 O(1) 链表操作，线性完成。
    expect(safeHTML('<p>a</p>'.repeat(2000)).length).toBe(16000)

    const out = safeHTML('<font>a</font>'.repeat(2000))
    expect(out).toBe('a'.repeat(2000))
    expect(audit(out)).toEqual([])
  })

  it('script 文本当正文输出（修复后走主路径，标签被 unwrap 且文本保留）', () => {
    // 修复前这些输入让 sanitizeHTML 抛错 → 兜底 stripHTML（格式全丢）。
    // 修复后走主路径：<script> 解包、文本提升为正文、合法标签保留。
    expect(safeHTML('<script>alert(1)</script>')).toBe('alert(1)')
    expect(safeHTML('<p><script>alert(1)</script></p>')).toBe('<p>alert(1)</p>')
    expect(safeHTML('<b>bold</b><script>boom()</script>')).toBe('<b>bold</b>boom()')
    expect(safeHTML('<scr<script>ipt>alert(1)</script>')).toBe('ipt&gt;alert(1)')
    expect(safeHTML('<style>* { color: red }</style>')).toBe('* { color: red }')
  })
})

describe('stripHTML — 纯文本抽取', () => {
  it('丢弃全部标签只留文本', () => {
    expect(stripHTML('<p>a</p><p>b</p>')).toBe('ab')
    expect(stripHTML('<div><span>x <b>y</b> z</span></div>')).toBe('x y z')
    expect(stripHTML('hello')).toBe('hello')
    expect(stripHTML('')).toBe('')
    expect(stripHTML('<br>')).toBe('')
    expect(stripHTML('中文<br>换行')).toBe('中文换行')
  })

  it('解一次实体（文本用途下正确）', () => {
    expect(stripHTML('a&amp;b')).toBe('a&b')
    expect(stripHTML('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')).toBe('<script>alert(1)</script>')
    expect(stripHTML('<p>emoji 😀 &nbsp; nl</p>')).toBe('emoji 😀 \u00a0 nl')
  })

  it('script/style 的内容作为文本被抽出（不当 HTML 用即可）', () => {
    expect(stripHTML('<script>alert(1)</script>')).toBe('alert(1)')
    expect(stripHTML('<div><script>evil()</script>ok</div>')).toBe('evil()ok')
    expect(stripHTML('<style>a{b:c}</style>text')).toBe('a{b:c}text')
  })

  it('null 输入被 jsdom 吞成空串，undefined 输入返回 "undefined"（钉住当前行为）', () => {
    expect(stripHTML(null as unknown as string)).toBe('')
    expect(stripHTML(undefined as unknown as string)).toBe('undefined')
  })
})

describe('containsHTML — 判定是否含标签', () => {
  it('含成对/自闭合标签时为 true', () => {
    expect(containsHTML('<p>x</p>')).toBe(true)
    expect(containsHTML('<P>x</P>')).toBe(true)
    expect(containsHTML('<br>')).toBe(true)
    expect(containsHTML('<h1>x</h1>')).toBe(true)
    expect(containsHTML('text <b>bold</b> more')).toBe(true)
    expect(containsHTML(' <b>x</b>')).toBe(true)
    expect(containsHTML('<a><b>x</a>')).toBe(true)
    expect(containsHTML('<script>alert(1)</script>')).toBe(true)
  })

  it('只有尖括号/未闭合/注释/非字母起始时为 false', () => {
    expect(containsHTML('')).toBe(false)
    expect(containsHTML('plain')).toBe(false)
    expect(containsHTML('3 < 5')).toBe(false)
    expect(containsHTML('<p')).toBe(false)
    expect(containsHTML('< div >')).toBe(false)
    expect(containsHTML('<!-- c -->')).toBe(false)
    expect(containsHTML('<1>x</1>')).toBe(false)
    expect(containsHTML('</p>')).toBe(false)
    expect(containsHTML('a > b')).toBe(false)
  })

  it('非字符串输入不抛错（正则把 null/undefined 转成字面量文本）', () => {
    expect(containsHTML(null as unknown as string)).toBe(false)
    expect(containsHTML(undefined as unknown as string)).toBe(false)
    expect(containsHTML(12 as unknown as string)).toBe(false)
  })
})

describe('源码守卫：白名单本身不许被放宽', () => {
  // 相对本文件解析，不依赖 vitest 的 cwd（根目录 npm run test:run 会 cd 进 frontend，
  // 但单文件调试时 cwd 可能是仓库根，用 process.cwd() 会误报）。
  const here = path.dirname(fileURLToPath(import.meta.url))
  const sourcePath = path.resolve(here, '..', 'sanitizeHTML.ts')
  const source = fs.readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n')

  /** 取出某个声明的块体（换行符无关），并去掉 // 注释行，防止注释掉的条目被算进来 */
  function blockBody(re: RegExp, label: string): string {
    const match = source.match(re)
    expect(match, label).not.toBeNull()
    const body = (match?.[1] as string) ?? ''
    return body
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
  }

  /** 按起止标记切源码（标记本身不存在时用例直接失败，不会静默切出空串） */
  function section(startMarker: string, endMarker: string): string {
    const start = source.indexOf(startMarker)
    expect(start, `源码里找不到 ${startMarker}`).toBeGreaterThan(-1)
    const end = source.indexOf(endMarker, start + startMarker.length)
    expect(end, `源码里找不到 ${endMarker}`).toBeGreaterThan(start)
    return source.slice(start, end)
  }

  function quoted(body: string): string[] {
    return Array.from(body.matchAll(/'([^']+)'/g)).map((m) => m[1])
  }

  it('ALLOWED_TAGS 恰好是已审计的那一份白名单，不含任何可执行/注入标签', () => {
    const body = blockBody(/const ALLOWED_TAGS = new Set\(\[([\s\S]*?)\]\)/, 'ALLOWED_TAGS')
    const tags = quoted(body)
    expect(tags.length).toBe(EXPECTED_ALLOWED_TAGS.length)
    expect([...tags].sort()).toEqual([...EXPECTED_ALLOWED_TAGS].sort())
    expect(tags.filter((t) => NEVER_TAGS.includes(t))).toEqual([])
  })

  it('ALLOWED_ATTRIBUTES 里不存在 href/src/srcdoc/action/formaction/target/on* 等属性', () => {
    const body = blockBody(/const ALLOWED_ATTRIBUTES[\s\S]*?=\s*\{([\s\S]*?)\n\}/, 'ALLOWED_ATTRIBUTES')
    const attrs = quoted(body)
    expect(attrs).toContain('class')
    expect(attrs).toContain('style')
    expect(attrs).toContain('colspan')
    expect(attrs.filter((a) => /^(on[a-z]|href|src|srcdoc|action|formaction|target|data-)/i.test(a))).toEqual([])
  })

  it('ALLOWED_STYLES 不含 background/behavior/binding/-moz-binding/position 之类可执行属性', () => {
    const body = blockBody(/const ALLOWED_STYLES = new Set\(\[([\s\S]*?)\]\)/, 'ALLOWED_STYLES')
    const props = quoted(body)
    expect(props).toContain('color')
    expect(props.filter((p) => ['background', 'behavior', 'binding', '-moz-binding', 'position', 'width'].includes(p))).toEqual([])
  })

  it('style 值过滤保留了 expression / javascript: / vbscript: / data: 四条规则', () => {
    const body = blockBody(/const dangerousPatterns = \[([\s\S]*?)\]/, 'dangerousPatterns')
    expect(body).toContain('expression')
    expect(body).toContain('javascript:')
    expect(body).toContain('vbscript:')
    expect(body).toContain('data:')
    expect(body).toContain('behavior')
    expect(body).toContain('binding')
  })

  it('style 属性必须真的过 sanitizeStyle（不是把原始 style 直接写回）', () => {
    const body = section('const sanitizeNode = (node: Node)', '// Start sanitization')
    expect(body).toContain('sanitizeStyle(attr.value)')
    expect(body).toContain('element.removeAttribute')
    // 白名单判定必须真的读 ALLOWED_TAGS / ALLOWED_ATTRIBUTES，而不是恒真
    expect(body).toContain('ALLOWED_TAGS.has')
    expect(body).toContain('allowedAttrs.has(attr.name)')
  })

  it('safeHTML 的兜底是 stripHTML（不会把异常吞成"原样返回输入"）', () => {
    const start = source.indexOf('export function safeHTML')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start)
    expect(body).toContain('sanitizeHTML(html)')
    expect(body).toContain('stripHTML(html)')
    expect(body).not.toContain('return html\n')
  })

  it('sanitizeStyle 的返回值真的被用于 setAttribute（不是丢弃过滤结果）', () => {
    const body = section('const sanitizedStyle = sanitizeStyle', '} else {')
    expect(body).toContain("element.setAttribute('style', sanitizedStyle)")
  })
})
