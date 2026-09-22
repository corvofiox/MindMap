import { describe, it, expect, beforeEach } from 'vitest'
import { queryCurrentColor, execFormatCommand } from '@/utils/richTextCommands'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 富文本颜色识别：**默认颜色的文字不能被判成"已改颜色"**。
 *
 * 历史 bug：判断"元素有没有显式文字颜色"用的是
 *   style.match(/color\s*:\s*([^;]+)/i)
 * 这个正则没有左边界，`background-color: #fff` 里的 `color:` 也会命中。
 * 而节点卡片恰好带内联 background-color，且"划选"路径会从文本节点一路向上遍历
 * 到根（不像光标路径会在 contenteditable 处停下）——于是用户刚打出来的默认文字，
 * 一划选就被判成"有颜色"，工具栏颜色按钮直接亮起。
 */
function setup(editorInnerHtml: string, cardStyle: string) {
  document.body.innerHTML = ''
  const card = document.createElement('div')
  card.setAttribute('style', cardStyle)
  const editor = document.createElement('div')
  editor.setAttribute('contenteditable', 'true')
  editor.setAttribute('style', 'outline: none')
  editor.innerHTML = editorInnerHtml
  card.appendChild(editor)
  document.body.appendChild(card)
  return { card, editor }
}

function selectAll(node: Node) {
  const range = document.createRange()
  range.selectNodeContents(node)
  const sel = window.getSelection()
  if (!sel) throw new Error('jsdom 没有 Selection')
  sel.removeAllRanges()
  sel.addRange(range)
}

function collapseInto(node: Node, offset: number) {
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  const sel = window.getSelection()
  if (!sel) throw new Error('jsdom 没有 Selection')
  sel.removeAllRanges()
  sel.addRange(range)
}

describe('richTextCommands / 颜色识别', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  describe('queryCurrentColor（划选路径）', () => {
    // 节点卡片的背景色是内联的（NodeItem: backgroundColor: node.color），
    // 它绝对不能影响"文字颜色"的判断。
    it.each([
      ['#ffffff', '#ffffff'],
      ['#dbeafe', '#dbeafe'],
      ['rgb(255, 255, 255)', 'rgb(255, 255, 255)'],
      ['rgb(219, 234, 254)', 'rgb(219, 234, 254)'],
    ])('卡片背景色 %s 不影响默认文字颜色判定', (_label, cardColor) => {
      const { editor } = setup('<p>默认颜色的文字</p>', `background-color: ${cardColor}`)
      selectAll(editor)
      expect(queryCurrentColor()).toBeNull()
    })

    it('祖先的 border-color / caret-color / background-color 都不算文字颜色', () => {
      const { editor } = setup(
        '<p>默认颜色的文字</p>',
        'border-color: #ef4444; caret-color: #22c55e; background-color: #fef9c3',
      )
      selectAll(editor)
      expect(queryCurrentColor()).toBeNull()
    })

    it('选区内的 span 带 background-color 也不算文字颜色', () => {
      const { editor } = setup(
        '<p><span style="background-color: #fef08a">高亮文字</span></p>',
        'background-color: #ffffff',
      )
      selectAll(editor)
      expect(queryCurrentColor()).toBeNull()
    })

    it('仍然能识别真正设置过的文字颜色（防止改过头）', () => {
      const { editor } = setup(
        '<p><span style="color: #dc2626">红色文字</span></p>',
        'background-color: #ffffff',
      )
      selectAll(editor)
      expect(queryCurrentColor()).toBe('#dc2626')
    })

    it('文字颜色与卡片背景色同时存在时，只认文字颜色', () => {
      const { editor } = setup(
        '<p><span style="color: rgb(37, 99, 235); background-color: #fef08a">蓝色文字</span></p>',
        'background-color: #ffffff',
      )
      selectAll(editor)
      expect(queryCurrentColor()).toBe('#2563eb')
    })

    it('不越过 contenteditable 边界去取祖先的颜色（与光标路径一致）', () => {
      const { card, editor } = setup('<p>默认颜色的文字</p>', 'background-color: #ffffff')
      card.setAttribute('style', 'background-color: #ffffff; color: #ff0000')
      selectAll(editor)
      expect(queryCurrentColor()).toBeNull()
    })
  })

  describe('removeForeColor（光标路径）', () => {
    it('只移除文字颜色，保留 background-color', () => {
      const { editor } = setup(
        '<p><span style="color: #dc2626; background-color: #fef08a">文字</span></p>',
        'background-color: #ffffff',
      )
      const span = editor.querySelector('span') as HTMLElement
      collapseInto(span.firstChild as Node, 1)

      expect(execFormatCommand('removeForeColor')).toBe(true)
      expect(span.style.color).toBe('')
      expect(span.style.backgroundColor).toBe('rgb(254, 240, 138)')
    })

    it('span 只有 background-color 时不做任何修改', () => {
      const { editor } = setup(
        '<p><span style="background-color: #fef08a">高亮文字</span></p>',
        'background-color: #ffffff',
      )
      const span = editor.querySelector('span') as HTMLElement
      collapseInto(span.firstChild as Node, 1)

      execFormatCommand('removeForeColor')
      expect(span.getAttribute('style')).toBe('background-color: #fef08a')
    })
  })
})

/**
 * 源码守卫：判断"样式里的文字颜色"必须走 CSSOM（`el.style.color`），
 * 不能用字符串子串/正则匹配 —— `background-color` / `border-color` / `caret-color`
 * 都含 `color:`，而节点卡片本身带内联 background-color，一匹配就把卡片背景色
 * 当成了文字颜色。同类 mistake 别再写第二遍。
 */
describe('源码守卫：不得用字符串匹配判断样式里的文字颜色', () => {
  const forbidden: Array<{ re: RegExp; why: string }> = [
    { re: /\.includes\(\s*['"]color['"]\s*\)/, why: "includes('color') 会命中 background-color" },
    { re: /(?:match|replace)\(\s*\/color\\s\*:/, why: '正则 /color\\s*:/ 没有左边界，会命中 background-color' },
  ]

  function collectFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'coverage') continue
        collectFiles(full, out)
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full)
      }
    }
    return out
  }

  it('src 里没有这类写法（注释除外）', () => {
    const offenders: string[] = []
    for (const file of collectFiles(path.resolve(__dirname, '..'))) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
      lines.forEach((line, i) => {
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
        for (const { re, why } of forbidden) {
          if (re.test(line)) {
            offenders.push(`${path.relative(process.cwd(), file)}:${i + 1}  ${why}`)
          }
        }
      })
    }
    expect(offenders, `请改用 getInlineTextColor()（富文本）或 element.style.color：\n${offenders.join('\n')}`).toEqual([])
  })
})
