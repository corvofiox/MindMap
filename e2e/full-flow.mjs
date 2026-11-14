/**
 * 全量「模拟用户」E2E：真 Edge（CDP）打真服务，从注册一路点到退出登录。
 *
 * 覆盖这一轮返工涉及的所有用户可见路径：
 *   注册 → 落在项目页（主页面就是 /projects）→ 顶栏那一批按钮 →
 *   新建项目 → 进画布 → 建节点 / 富文本（加粗·标题·颜色）→ 节点池开合 →
 *   笔记本（新建 · 输入 · 自动保存 · 富文本 · 文件夹增删移 · 搜索 · 双向导入）→
 *   思维导图回项目页 → 设置 / 账号弹窗 → 命令面板 → 退出登录 → 再登录。
 *
 * 前置：
 *   1) 服务已起，且托管了构建好的前端（默认 http://127.0.0.1:8000）
 *   2) headless Edge 带 CDP 启动：
 *      msedge --headless=new --remote-debugging-port=9223 --user-data-dir=<临时目录> about:blank
 *
 * 用法：
 *   node e2e/full-flow.mjs
 *   E2E_BASE=http://127.0.0.1:8000 E2E_CDP=http://127.0.0.1:9223 node e2e/full-flow.mjs
 *
 * 注意：不要去掉 Emulation.setDeviceMetricsOverride —— headless 默认视口 500×320，
 * 布局会塌陷，坐标点击全部错位（踩过）。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import WebSocket from '../node_modules/ws/index.js'

const CDP = process.env.E2E_CDP || 'http://127.0.0.1:9223'
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8000'
const PASSWORD = process.env.E2E_PASSWORD || 'E2ePassw0rd!'
// 每次跑都用一个新账号：数据干净、可重复，也不会污染演示账号
const EMAIL = process.env.E2E_EMAIL || `e2e+${Date.now()}@mindmap.local`
const NICKNAME = 'E2E 测试员'
const TMP = process.env.E2E_OUT || path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp')

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  return ok
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
fs.mkdirSync(TMP, { recursive: true })

const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) throw new Error('没有可用的 CDP page target（Edge 是否带 --remote-debugging-port 启动？）')
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
await new Promise((r) => ws.once('open', r))

let id = 0
const pending = new Map()
/** 排队应答原生弹窗：prompt 文本、confirm 是否确定 */
const dialogQueue = []

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id)
    pending.delete(m.id)
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
    return
  }
  if (m.method === 'Page.javascriptDialogOpening') {
    const spec = dialogQueue.shift()
    const params = { accept: spec ? spec.accept !== false : true }
    if (m.params.type === 'prompt' && spec && spec.text !== undefined) params.promptText = spec.text
    send('Page.handleJavaScriptDialog', params).catch(() => {})
  }
})

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const i = ++id
    pending.set(i, { resolve, reject })
    ws.send(JSON.stringify({ id: i, method, params }))
    setTimeout(() => {
      if (pending.has(i)) {
        pending.delete(i)
        reject(new Error('timeout ' + method))
      }
    }, 30000)
  })

const ev = async (expression) => {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  if (r.exceptionDetails) {
    throw new Error(`${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ''}`)
  }
  return r.result?.value
}

const waitFor = async (expr, timeout = 20000, label = expr) => {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      if (await ev(expr)) return true
    } catch {
      /* 页面切换中 */
    }
    await sleep(250)
  }
  throw new Error('等待超时: ' + label)
}

const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(TMP, `shot-${name}.png`), Buffer.from(data, 'base64'))
}

const click = async (x, y, clickCount = 1) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount })
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount })
  await sleep(120)
}

/** 用真实鼠标点一个元素（先滚动到视野内，取中心点） */
const clickEl = async (selector) => {
  const rect = await ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
  })()`)
  if (!rect) throw new Error('点不到元素: ' + selector)
  await click(rect[0], rect[1])
}

/** 按可视文案找按钮并真实点击 */
const clickText = async (text, scope = 'button, a, [role="menuitem"], [role="option"]') => {
  const rect = await ev(`(() => {
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(scope)}));
    const el = nodes.find((n) => (n.textContent || '').trim() === ${JSON.stringify(text)})
      || nodes.find((n) => (n.textContent || '').includes(${JSON.stringify(text)}));
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const hit = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
    // 被遮罩/弹层挡住时点下去是白点一下，直接报出来比等超时好查
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), hit: !!hit && (hit === el || el.contains(hit)) };
  })()`)
  if (!rect) {
    const seen = await ev(`Array.from(document.querySelectorAll(${JSON.stringify(scope)})).slice(0, 24).map((n) => (n.textContent || '').trim().slice(0, 18)).filter(Boolean)`)
    throw new Error(`找不到可点的文案: ${text}｜当前可点文案: ${JSON.stringify(seen)}`)
  }
  if (!rect.hit) throw new Error(`「${text}」被别的东西挡住了（点下去会落空）`)
  await click(rect.x, rect.y)
}

/**
 * 导航并等页面真的就绪。
 * 只等 location.pathname 是不够的：Page.navigate 会先提交 URL，
 * 此时 DOM 还是上一页，后续选择器全部落空（踩过）。
 */
const goto = async (url, readyExpr, timeout = 30000) => {
  await send('Page.navigate', { url })
  if (readyExpr) await waitFor(readyExpr, timeout, `就绪: ${readyExpr}`)
  await sleep(300)
}

/** React 受控输入：走原生 setter + input 事件 */
const setInput = (selector, value) =>
  ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)

const pressKey = async (key, code = key, modifiers = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: 0, modifiers })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: 0, modifiers })
  await sleep(150)
}

/** 像用户一样往焦点里打字（CDP 文本输入，会触发 input 事件） */
const typeText = async (text) => {
  await send('Input.insertText', { text })
  await sleep(150)
}

const pathIs = (p) => ev('location.pathname') === p
const bodyHas = (text) => ev(`document.body.innerText.includes(${JSON.stringify(text)})`)

/** 一步一组断言；抛错只记录失败，流程继续往下走 */
const step = async (name, fn) => {
  try {
    const detail = await fn()
    record(name, true, typeof detail === 'string' ? detail : '')
  } catch (error) {
    record(name, false, error.message)
    await shot(`fail-${name.replace(/[^\w\u4e00-\u9fa5]+/g, '_').slice(0, 40)}`).catch(() => {})
  }
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
})

// ---------------------------------------------------------------- 1. 未登录
await step('未登录访问根路径 → 登录页', async () => {
  await ev('localStorage.clear(); sessionStorage.clear()')
  await goto(`${BASE}/`, `location.pathname === '/login' && !!document.querySelector('#email')`)
  return await ev('location.pathname')
})
await shot('01-login')

// ---------------------------------------------------------------- 2. 注册
await step('注册新账号 → 落在项目列表（主页面是 projects）', async () => {
  await goto(`${BASE}/register`, `!!document.querySelector('#confirmPassword')`)
  await setInput('#email', EMAIL)
  await setInput('#nickname', NICKNAME)
  await setInput('#password', PASSWORD)
  await setInput('#confirmPassword', PASSWORD)
  await clickText('创建账户')
  await waitFor(`location.pathname === '/projects'`, 20000, '注册后进入 /projects')
  return `${await ev('location.pathname')} · ${EMAIL}`
})

// ---------------------------------------------------------------- 3. 项目页
await step('项目页：标题、新建项目、右上角那一批按钮', async () => {
  await waitFor(`document.body.innerText.includes('我的项目')`, 10000, '我的项目')
  const layout = await ev(`(() => {
    const header = document.querySelector('header');
    const notebook = document.querySelector('[aria-label="打开笔记本"]');
    const search = document.querySelector('[title^="搜索节点"]');
    const separator = header && header.querySelector('[role="separator"]');
    const settings = document.querySelector('[title^="设置"]');
    const account = document.querySelector('[aria-label="账号菜单"]');
    return {
      inHeader: !!notebook && header.contains(notebook),
      order: !!notebook && !!search && !!(notebook.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING),
      separated: !!separator && !!notebook && !!(notebook.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING)
        && !!search && !!(separator.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING),
      settings: !!settings, account: !!account,
      newProject: Array.from(document.querySelectorAll('button')).some((b) => b.textContent.includes('新建项目')),
    };
  })()`)
  if (!layout.inHeader || !layout.order || !layout.separated) throw new Error('顶栏按钮位置不对: ' + JSON.stringify(layout))
  if (!layout.settings || !layout.account || !layout.newProject) throw new Error('缺少入口: ' + JSON.stringify(layout))
  return JSON.stringify(layout)
})
await shot('02-projects')

// ---------------------------------------------------------------- 4. 新建项目 → 画布
await step('新建项目并进入画布', async () => {
  await clickText('新建项目')
  await waitFor(`!!document.querySelector('input[placeholder="项目名称"]')`, 8000, '项目名输入框')
  await setInput('input[placeholder="项目名称"]', 'E2E 全流程项目')
  await clickText('创建')
  await waitFor(`document.body.innerText.includes('E2E 全流程项目')`, 15000, '项目卡片出现')
  await clickText('E2E 全流程项目', 'h3, div[class*="cursor-pointer"], div')
  // 点项目 = 进它的一张真实画布（不是 /canvas/new）
  await waitFor(`/^\\/canvas\\/\\d+$/.test(location.pathname)`, 30000, '进入具体画布')
  await waitFor(`!!document.querySelector('[data-canvas-container]')`, 25000, '画布容器')
  return await ev('location.pathname')
})
const CANVAS_PATH = await ev('location.pathname')
await shot('03-canvas')

// ---------------------------------------------------------------- 5. 画布建节点
await step('画布：选「节点」工具并点击画布，创建节点', async () => {
  await clickEl('button[title^="节点 (N)"]')
  await sleep(400)
  await click(700, 300)
  await waitFor(`document.querySelectorAll('.node-item').length > 0`, 10000, '节点出现')
  const rect = await ev(`(() => {
    const el = Array.from(document.querySelectorAll('.node-item')).pop();
    const r = el.getBoundingClientRect();
    return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
  })()`)
  // 节点应该落在点击处（左边/上边对齐点击点），并且确实在视口里
  if (rect[0] > 720 || rect[1] > 320 || rect[0] + rect[2] < 700 || rect[1] + rect[3] < 300) {
    throw new Error('新建节点不在点击位置: ' + JSON.stringify(rect))
  }
  if (rect[0] < 0 || rect[1] < 0 || rect[0] + rect[2] > 1440 || rect[1] + rect[3] > 900) {
    throw new Error('新建节点跑到视口外: ' + JSON.stringify(rect))
  }
  return `节点数=${await ev(`document.querySelectorAll('.node-item').length`)} rect=${JSON.stringify(rect)}`
})

// ---------------------------------------------------------------- 6. 画布富文本
await step('画布：双击正文输入文字，工具栏加粗 / 标题 2 / 颜色', async () => {
  // 真实双击节点正文（点节点中部，避开边上的连接点）
  await click(760, 360)
  await click(760, 360)
  await click(760, 360, 2)
  await waitFor(`!!document.querySelector('[contenteditable="true"]')`, 8000, '进入编辑')
  await ev(`(() => {
    const ed = document.querySelector('[contenteditable="true"]');
    ed.focus();
    const range = document.createRange();
    range.selectNodeContents(ed);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  })()`)
  await typeText('E2E 画布正文')
  await sleep(400)

  const toolbarBox = () =>
    ev(`(() => {
      const t = document.querySelector('[data-rich-text-toolbar="true"]');
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    })()`)

  const first = await toolbarBox()
  if (!first) throw new Error('进入编辑后没有出现浮动工具栏')
  if (first[1] < 0 || first[1] + first[3] > 900) throw new Error('工具栏跑出视口: ' + JSON.stringify(first))

  const selectAll = () =>
    ev(`(() => {
      const ed = document.querySelector('[contenteditable="true"]');
      if (!ed) return false;
      ed.focus();
      const range = document.createRange();
      range.selectNodeContents(ed);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    })()`)

  // 加粗
  await selectAll()
  await clickEl('[data-rich-text-toolbar="true"] [aria-label="加粗 (Ctrl+B)"]')
  await sleep(500)
  const afterBold = await ev(`(() => ({
    toolbar: !!document.querySelector('[data-rich-text-toolbar="true"]'),
    editing: !!document.querySelector('[contenteditable="true"]'),
    html: (document.querySelector('[data-field="content"]') || {}).innerHTML || '',
  }))()`)
  if (!afterBold.editing) throw new Error('点一次工具栏就退出了编辑: ' + JSON.stringify(afterBold).slice(0, 200))
  if (!/<(b|strong)>/i.test(afterBold.html)) throw new Error('加粗没生效: ' + afterBold.html.slice(0, 200))

  // 标题 2
  await selectAll()
  await clickEl('[data-rich-text-toolbar="true"] [aria-label="标题 2"]')
  await sleep(500)
  const afterH2 = await ev(`(document.querySelector('[data-field="content"]') || {}).innerHTML || ''`)
  if (!/<h2[>\s]/i.test(afterH2)) throw new Error('标题 2 没生效: ' + afterH2.slice(0, 200))

  // 颜色（浏览器可能落成 <font color> 或 <span style="color: …">，两种都算）
  await selectAll()
  await clickEl('[data-rich-text-toolbar="true"] [aria-label="文字颜色"]')
  await sleep(300)
  await clickEl('[data-rich-text-toolbar="true"] [aria-label="颜色 #dc2626"]')
  const readMarkup = () => ev(`(document.querySelector('[data-field="content"]') || {}).innerHTML || ''`)
  const colorRe = /color\s*[:=]\s*["']?\s*(rgb\(220,\s*38,\s*38\)|#dc2626)/i
  let markup = await readMarkup()
  for (let i = 0; i < 20 && !colorRe.test(markup); i += 1) {
    await sleep(250)
    markup = await readMarkup()
  }
  if (!colorRe.test(markup)) throw new Error('颜色没生效: ' + markup)
  if (!markup.includes('E2E 画布正文')) throw new Error('文字丢了: ' + markup)
  return 'bold+h2+color 全部生效'
})
await shot('04-canvas-richtext')

// ---------------------------------------------------------------- 7. 节点池
await step('节点池：打开面板，标题与「从笔记本导入」同一行', async () => {
  await clickEl('button[title^="切换节点池"]')
  await waitFor(`!!document.querySelector('[data-node-pool="true"]')`, 8000, '节点池面板')
  await waitFor(
    `getComputedStyle(document.querySelector('[data-node-pool="true"]')).transform !== 'matrix(1, 0, 0, 1, 288, 0)'`,
    8000,
    '面板滑入',
  )
  const layout = await ev(`(() => {
    const panel = document.querySelector('[data-node-pool="true"]');
    const title = panel.querySelector('h2');
    const trigger = Array.from(panel.querySelectorAll('button')).find((b) => b.textContent.includes('从笔记本导入'));
    if (!title || !trigger) return null;
    const titleBox = title.getBoundingClientRect();
    const btnBox = trigger.getBoundingClientRect();
    return {
      sameRow: Math.abs((titleBox.top + titleBox.height / 2) - (btnBox.top + btnBox.height / 2)) < 8,
      title: title.textContent.trim(),
      trigger: trigger.textContent.trim(),
    };
  })()`)
  if (!layout || !layout.sameRow) throw new Error('标题与导入按钮不在同一行: ' + JSON.stringify(layout))
  return JSON.stringify(layout)
})
await shot('05-nodepool')

await step('节点池：新建文件夹成功', async () => {
  await ev(`(() => {
    const panel = document.querySelector('[data-node-pool="true"]');
    const btn = Array.from(panel.querySelectorAll('button')).find((b) => b.title === '新建文件夹');
    btn.click();
    return true;
  })()`)
  await waitFor(`!!document.querySelector('input[placeholder="文件夹名称..."]')`, 8000, '文件夹输入框')
  await setInput('input[placeholder="文件夹名称..."]', 'E2E 池文件夹')
  await ev(`(() => {
    const input = document.querySelector('input[placeholder="文件夹名称..."]');
    const box = input.parentElement;
    const btn = Array.from(box.querySelectorAll('button')).find((b) => /创建|确定|新增/.test(b.textContent) || b.title.includes('创建'));
    btn.click();
    return true;
  })()`)
  await waitFor(`document.querySelector('[data-node-pool="true"]').innerText.includes('E2E 池文件夹')`, 10000, '文件夹出现')
  return 'E2E 池文件夹'
})

// ---------------------------------------------------------------- 8. 笔记本
await step('顶栏「笔记本」入口 → 笔记本页', async () => {
  await clickEl('[aria-label="打开笔记本"]')
  await waitFor(`location.pathname.startsWith('/notebook')`, 15000, '进入笔记本')
  await waitFor(`document.body.innerText.includes('从节点池导入')`, 10000, '笔记本顶栏')
  return await ev('location.pathname')
})
await shot('06-notebook-empty')

await step('新建手稿并输入正文，自动保存', async () => {
  await clickText('新建手稿')
  await waitFor(`location.pathname.match(/\\/notebook\\/\\d+/)`, 15000, '新开一篇手稿')
  await waitFor(`!!document.querySelector('[data-testid="manuscript-editor"]')`, 10000, '编辑器')
  // 标题
  await setInput('input[placeholder="手稿标题"]', 'E2E 全流程手稿')
  // 正文
  await clickEl('[data-testid="manuscript-editor"]')
  await typeText('第一段：模拟用户输入。')
  await sleep(2500)
  await waitFor(`document.body.innerText.includes('已保存')`, 15000, '自动保存成功')
  const chars = await ev(`document.body.innerText.match(/(\\d+)\\s*字/)?.[1] ?? '0'`)
  return `字数=${chars}`
})
await shot('07-notebook-editing')

await step('笔记本富文本：选中文字加粗', async () => {
  await ev(`(() => {
    const ed = document.querySelector('[data-testid="manuscript-editor"]');
    ed.focus();
    const range = document.createRange();
    range.selectNodeContents(ed);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  })()`)
  await sleep(400)
  await clickEl('[data-rich-text-toolbar="true"][data-variant="docked"] [aria-label="加粗 (Ctrl+B)"]')
  await sleep(800)
  const html = await ev(`document.querySelector('[data-testid="manuscript-editor"]').innerHTML`)
  if (!/<(b|strong)>/i.test(html)) throw new Error('加粗没生效: ' + html)
  return html.slice(0, 80)
})

await step('文件夹：新建「素材」并把文件夹选中后新建子文件夹「配色」', async () => {
  // prompt 是原生阻塞弹窗：必须先把应答排进队列，再点按钮（点完才排就来不及）
  dialogQueue.push({ accept: true, text: '素材' })
  await clickEl('[aria-label="新建文件夹"]')
  await waitFor(`document.querySelector('aside').innerText.includes('素材')`, 10000, '素材出现')

  // 在「素材」上新建子文件夹（同样先把 prompt 应答排好）
  dialogQueue.push({ accept: true, text: '配色' })
  const created = await ev(`(() => {
    const rows = Array.from(document.querySelectorAll('aside [data-folder-row]'));
    const target = rows.find((r) => r.title === '素材');
    if (!target) return false;
    const btn = target.querySelector('[aria-label^="在 素材 下新建子文件夹"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`)
  if (!created) throw new Error('找不到"新建子文件夹"按钮')
  await sleep(600)
  await waitFor(`document.querySelector('aside').innerText.includes('配色')`, 10000, '配色出现')
  return '素材 / 配色'
})

await step('移动手稿到「素材」文件夹（两级菜单）', async () => {
  await clickEl('[aria-label="更多操作"]')
  await waitFor(`!!document.querySelector('[data-testid="notebook-item-menu"]')`, 8000, '列表项菜单')
  await clickText('移动到', '[data-testid="notebook-item-menu"] button, [data-testid="notebook-item-menu"] div[role="button"]')
  await waitFor(`!!document.querySelector('[data-testid="notebook-move-menu"]')`, 8000, '子菜单')
  await clickText('素材', '[data-testid="notebook-move-menu"] button')
  await sleep(1500)
  const counts = await ev(`(() => {
    const rows = Array.from(document.querySelectorAll('aside [data-folder-row]'));
    return rows.map((r) => r.innerText.replace(/\\s+/g, ' ').trim());
  })()`)
  if (!counts.some((t) => /素材/.test(t) && /\b1\b/.test(t))) throw new Error('素材计数不对: ' + JSON.stringify(counts))
  return JSON.stringify(counts)
})
await shot('08-notebook-folders')

await step('搜索：输入关键词后只剩匹配的手稿', async () => {
  await setInput('input[placeholder="搜索标题或正文"]', '不存在的关键词xyz')
  await sleep(1500)
  const empty = await bodyHas('没有匹配的手稿')
  await setInput('input[placeholder="搜索标题或正文"]', 'E2E')
  await sleep(1500)
  const found = await bodyHas('E2E 全流程手稿')
  if (!empty) throw new Error('搜不到时没有空态文案')
  if (!found) throw new Error('搜得到时列表里没有这篇')
  await setInput('input[placeholder="搜索标题或正文"]', '')
  await sleep(800)
  return '空态 + 命中都对'
})

await step('删文件夹：整棵子树连手稿一起删', async () => {
  // 先把当前手稿移进「素材」，再删「素材」——手稿应该跟着一起没
  await clickEl('[aria-label="更多操作"]')
  await waitFor(`!!document.querySelector('[data-testid="notebook-item-menu"]')`, 8000, '列表项菜单')
  await clickText('移动到', '[data-testid="notebook-item-menu"] button, [data-testid="notebook-item-menu"] div[role="button"]')
  await waitFor(`!!document.querySelector('[data-testid="notebook-move-menu"]')`, 8000, '子菜单')
  await clickText('素材', '[data-testid="notebook-move-menu"] button')
  await sleep(1200)

  dialogQueue.push({ accept: true })
  await ev(`(() => {
    const rows = Array.from(document.querySelectorAll('aside [data-folder-row]'));
    const target = rows.find((r) => r.title === '素材');
    target.querySelector('[aria-label="删除文件夹 素材"]').click();
    return true;
  })()`)
  await sleep(2500)

  const state = await ev(`(() => {
    const rows = Array.from(document.querySelectorAll('aside [data-folder-row]'));
    return {
      folders: rows.map((r) => r.title).filter(Boolean),
      text: document.querySelector('aside').innerText,
    };
  })()`)
  if (state.folders.includes('素材')) throw new Error('「素材」没被删掉: ' + JSON.stringify(state.folders))
  if (state.folders.includes('配色')) throw new Error('子文件夹「配色」没有跟着删掉: ' + JSON.stringify(state.folders))
  if (/E2E 全流程手稿/.test(state.text)) throw new Error('里面的手稿没跟着删: ' + state.text.slice(0, 200))
  // 未归档里也不该出现它（那是"退回未归档"的旧行为）
  const unfiledCount = await ev(`(() => {
    const row = Array.from(document.querySelectorAll('aside [data-folder-row]')).find((r) => r.getAttribute('data-folder-row') === 'unfiled');
    return row ? row.innerText.replace(/\\s+/g, ' ').trim() : '';
  })()`)
  if (/未归档 [1-9]/.test(unfiledCount)) throw new Error('手稿被放进了未归档（应一起删）: ' + unfiledCount)
  return JSON.stringify(state.folders)
})
await shot('09-notebook-after-delete')

// ---------------------------------------------------------------- 9. 双向导入
await step('重新建一篇手稿（上一篇随文件夹删了）', async () => {
  await clickText('新建手稿')
  await waitFor(`location.pathname.match(/\\/notebook\\/\\d+/)`, 15000, '新开一篇手稿')
  await waitFor(`!!document.querySelector('[data-testid="manuscript-editor"]')`, 10000, '编辑器')
  await setInput('input[placeholder="手稿标题"]', 'E2E 送池手稿')
  await clickEl('[data-testid="manuscript-editor"]')
  await typeText('这篇要送去节点池。')
  await sleep(2200)
  return 'E2E 送池手稿'
})

await step('「送入节点池」把手稿移进节点池（笔记本里同时消失）', async () => {
  await clickText('送入节点池')
  await waitFor(`document.body.innerText.includes('已移入节点池')`, 20000, '成功提示')
  // 移动语义：源必须跟着走，人也不能停在 /notebook/:id 盯着一条已被删的稿
  await waitFor(`location.pathname === '/notebook'`, 10000, '回到笔记本列表')
  // 只看列表行：toast 文案里也带着稿名，用 innerText 判断会误报
  const rows = await ev(
    `Array.from(document.querySelectorAll('[data-row-id]')).map((n) => (n.textContent || '').trim())`,
  )
  if (JSON.stringify(rows ?? []).includes('E2E 送池手稿')) {
    throw new Error(`手稿还在笔记本列表里（应该是移动，不是复制）：${JSON.stringify(rows)}`)
  }
  return 'toast 已出现，手稿已从列表消失'
})
await shot('10-notebook-sent')

await step('「从节点池导入」：看得到刚送的卡片，悬浮出预览，点一下还原成手稿', async () => {
  await clickText('从节点池导入')
  const menu = `[data-testid="notebook-pool-import-menu"]`
  await waitFor(`!!document.querySelector('${menu}')`, 10000, '导入菜单')
  await waitFor(`!!document.querySelector('${menu} [data-testid^="pool-card-"]')`, 15000, '菜单里出现卡片')

  // 悬浮预览
  await ev(`(() => {
    const row = document.querySelector('${menu} [data-testid^="pool-card-"]');
    row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    return true;
  })()`)
  await waitFor(`!!document.querySelector('[data-testid="notebook-pool-import-preview"]')`, 8000, '悬浮预览')
  await shot('11-pool-import-preview')

  const before = await ev('location.pathname')
  await clickEl(`${menu} [data-testid^="pool-card-"]`)
  await waitFor(`document.body.innerText.includes('已转为手稿')`, 20000, '还原成功提示')
  await waitFor(`location.pathname !== ${JSON.stringify(before)}`, 15000, '打开了新的手稿')

  // 卡片也被搬走了：再打开菜单，池子里不该还留着它
  await clickText('从节点池导入')
  await waitFor(`!!document.querySelector('${menu}')`, 10000, '导入菜单（复查）')
  await sleep(800)
  const left = await ev(`document.querySelectorAll('${menu} [data-testid^="pool-card-"]').length`)
  // 遮罩是 onMouseDown 关的，必须发真鼠标事件（document.body.click() 关不掉，菜单会挡后续点击）
  await click(700, 700)
  await waitFor(`!document.querySelector('${menu}')`, 8000, '导入菜单已关闭')
  if (left !== 0) throw new Error(`卡片还在节点池里：剩 ${left} 张`)
  return `${before} → ${await ev('location.pathname')} · 池里已无卡片`
})
await shot('12-notebook-restored')

// ---------------------------------------------------------------- 10. 回项目页
await step('「思维导图」回到项目列表', async () => {
  await clickText('思维导图')
  await waitFor(`location.pathname === '/projects'`, 15000, '回到 /projects')
  return await ev('location.pathname')
})

// ---------------------------------------------------------------- 11. 顶栏与弹窗
await step('左上角 logo 回项目入口（在画布页点）', async () => {
  await goto(`${BASE}${CANVAS_PATH}`, `!!document.querySelector('header') && document.querySelectorAll('.node-item').length > 0`)
  const clicked = await ev(`(() => {
    const header = document.querySelector('header');
    const logo = Array.from(header.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === 'MindMap');
    if (!logo) return false;
    logo.click();
    return true;
  })()`)
  if (!clicked) throw new Error('找不到左上角 logo 按钮')
  await waitFor(`location.pathname === '/projects'`, 15000, 'logo → /projects')
  return await ev('location.pathname')
})

await step('命令面板（Ctrl+K）是中文命令', async () => {
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2,
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2,
  })
  await waitFor(`!!document.querySelector('input[placeholder="输入命令名称…"]')`, 10000, '命令面板')
  const text = await ev(`document.body.innerText`)
  if (!text.includes('新建画布') || !text.includes('导出画布 JSON')) throw new Error('命令面板没中文化: ' + text.slice(0, 200))
  await pressKey('Escape', 'Escape')
  await sleep(400)
  return '中文命令齐备'
})

await step('设置菜单与账号设置弹窗都能打开', async () => {
  // 设置是个下拉：应用设置 / 节点设置 / 快捷键
  await clickEl('button[title^="设置"]')
  await sleep(400)
  await clickText('应用设置')
  await waitFor(`document.querySelectorAll('[role="dialog"]').length > 0`, 10000, '设置弹窗')
  const settingsOpen = await ev(`document.querySelectorAll('[role="dialog"]').length > 0`)
  await pressKey('Escape', 'Escape')
  await sleep(600)

  await clickEl('[aria-label="账号菜单"]')
  await sleep(400)
  await clickText('账号设置')
  await waitFor(`document.querySelectorAll('[role="dialog"]').length > 0`, 10000, '账号设置弹窗')
  const accountOpen = await ev(`document.querySelectorAll('[role="dialog"]').length > 0`)
  await pressKey('Escape', 'Escape')
  await sleep(400)
  if (!settingsOpen || !accountOpen) throw new Error(`settings=${settingsOpen} account=${accountOpen}`)
  return `settings=${settingsOpen} account=${accountOpen}`
})
await shot('12-dialogs')

// ---------------------------------------------------------------- 12. 退出 / 再登录
await step('退出登录 → 登录页 → 再登录回项目列表', async () => {
  await clickEl('[aria-label="账号菜单"]')
  await sleep(400)
  await clickText('退出登录')
  await waitFor(`location.pathname === '/login'`, 15000, '退出后回登录页')

  await setInput('#email', EMAIL)
  await setInput('#password', PASSWORD)
  await clickText('登录')
  await waitFor(`location.pathname === '/projects'`, 20000, '再登录回 /projects')
  return await ev('location.pathname')
})
await shot('13-relogin')

// ---------------------------------------------------------------- 13. 持久化
await step('刷新后仍是登录态，且数据都在', async () => {
  await goto(`${BASE}/`, `location.pathname === '/projects'`, 25000)
  await waitFor(`document.body.innerText.includes('E2E 全流程项目')`, 15000, '项目还在')
  await goto(`${BASE}${CANVAS_PATH}`, `document.querySelectorAll('.node-item').length > 0`, 30000)
  const nodes = await ev(`document.querySelectorAll('.node-item').length`)
  const text = await ev(`document.body.innerText.includes('E2E 画布正文')`)
  if (!text) throw new Error('节点文字没恢复')
  return `节点数=${nodes}`
})
await shot('14-persisted')

// ---------------------------------------------------------------- 汇总
const failed = results.filter((r) => !r.ok)
console.log('\n=== 汇总 ===')
console.log(`通过 ${results.length - failed.length}/${results.length}`)
for (const f of failed) console.log('  未通过:', f.name, '—', f.detail)
fs.writeFileSync(path.join(TMP, 'full-flow-results.json'), JSON.stringify(results, null, 2))
console.log('截图与结果目录:', TMP)
ws.close()
process.exit(failed.length === 0 ? 0 : 1)
