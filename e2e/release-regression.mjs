/**
 * 本轮发版前回归：把**这一版改动过**的核心功能，用真实浏览器 + 真实服务再走一遍。
 *
 * 与 full-flow / folder-delete 的分工：那两个盯「功能整体对不对」，这个盯
 * 「这一版动过的地方有没有被打回原形」——尤其是几个只有真浏览器才看得见的回归：
 *
 *   A. 静态壳：index.html 不缓存、assets 长缓存、CSS 里确实带着本轮焦点修复
 *   B. 笔记本：点正文输入不再出现 UA 蓝框，但纸张原有的淡蓝描边 + 柔光还在；
 *              输入 → 自动保存 → 刷新内容还在
 *   C. 画布：建节点 → 保存 → 删除一个 → 再保存 → 刷新后删掉的不复活
 *            （用户报的那个 bug：显示保存成功、刷新全回来）
 *   D. 节点池 → 画布是**搬运**：右键菜单写「移到画布」、节点落下来不透明、
 *            卡片从池里消失、刷新后仍成立
 *   E. MCP 与界面同源：PAT 通过 /mcp 建的节点，刷新画布就能看见；
 *            poolList 不再返回 useCount
 *
 * 数据每次跑一个新账号（接口播种），断言只看真实 UI 与真实接口。
 * 前置：服务已起并托管构建好的前端（默认 127.0.0.1:8000）+ headless Edge 带 CDP（默认 9223）。
 *
 * 用法：
 *   node e2e/release-regression.mjs
 *   E2E_BASE=http://127.0.0.1:8100 node e2e/release-regression.mjs
 */
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import WebSocket from '../node_modules/ws/index.js'

const require = createRequire(import.meta.url)

const CDP = process.env.E2E_CDP || 'http://127.0.0.1:9223'
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8000'
const PASSWORD = 'E2ePassw0rd!'
const EMAIL = `release+${Date.now()}@mindmap.local`
const TMP = process.env.E2E_OUT || path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp')

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
fs.mkdirSync(TMP, { recursive: true })

const summary = () => {
  const passed = results.filter((r) => r.ok).length
  fs.writeFileSync(
    path.join(TMP, 'release-regression-results.json'),
    JSON.stringify({ base: BASE, passed, total: results.length, results }, null, 2),
  )
  console.log(`\n=== 汇总 ===\n通过 ${passed}/${results.length}`)
  console.log('截图与结果目录: ' + TMP)
  return passed === results.length
}

// ---------------------------------------------------------------- A. 静态壳
async function staticChecks() {
  // A1/A2：index.html 必须每次回源校验，否则用户改了前端却还在跑旧 bundle
  for (const [label, url] of [
    ['A1 根路径 / 不缓存 index.html', `${BASE}/`],
    ['A2 /index.html 同样不缓存', `${BASE}/index.html`],
  ]) {
    const res = await fetch(url)
    const cc = res.headers.get('cache-control') || ''
    record(label, res.status === 200 && /no-cache|no-store/.test(cc), `status=${res.status} cache-control=${cc || '(空)'}`)
  }

  // A3：index.html 引用的 css/js 都能取到（构建完整性：不会出现"壳新资源旧"）
  const html = await (await fetch(`${BASE}/`)).text()
  const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1])
  const bad = []
  for (const ref of refs) {
    const res = await fetch(`${BASE}${ref}`)
    if (res.status !== 200) bad.push(`${ref}=${res.status}`)
  }
  record('A3 index.html 引用的资源全部可取', refs.length > 0 && bad.length === 0, `refs=${refs.length} ${bad.join(',')}`)

  // A4：这一版真正生效的那条修复必须出现在**服务端实际发出的 CSS** 里
  const cssRef = refs.find((r) => r.endsWith('.css'))
  if (!cssRef) {
    record('A4 线上 CSS 带着正文焦点修复', false, 'index.html 里没有 css 引用')
    return
  }
  const css = await (await fetch(`${BASE}${cssRef}`)).text()
  // 打包器会把 rgb()/rgba() 压成 #hex，所以两种写法都要认
  const hasOutline = /\.rich-text-content:focus[^{]*\{[^}]*outline:\s*none\s*!important/.test(css)
  const paperRule = css.match(/\.notebook-paper:focus-within\{([^}]*)\}/)?.[1] || ''
  const hasPaperGlow =
    /border-color:\s*(#bfdbfe|rgb\(191[\s,]+219[\s,]+254\))/.test(paperRule) &&
    /box-shadow:\s*(?!none)/.test(paperRule)
  record(
    'A4 线上 CSS 带着正文焦点修复（且纸张高光没被误删）',
    hasOutline && hasPaperGlow,
    `${cssRef} outline=${hasOutline} paperGlow=${hasPaperGlow}${hasPaperGlow ? '' : ` rule=${paperRule.slice(0, 120)}`}`,
  )

  // A5：MCP 入口在（这一版新加的路由没被发版配置吃掉）
  const mcpProbe = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  })
  record('A5 /mcp 路由在线（未授权 401 而不是 404）', mcpProbe.status === 401, `status=${mcpProbe.status}`)
}

// ---------------------------------------------------------------- 播种
async function seed() {
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, nickname: '发版回归' }),
  })
  const regBody = await reg.json()
  if (!regBody.data?.token) throw new Error('注册失败: ' + JSON.stringify(regBody).slice(0, 200))
  const token = regBody.data.token

  const csrfRes = await fetch(`${BASE}/api/csrf-token`, { headers: { authorization: `Bearer ${token}` } })
  const csrfBody = await csrfRes.json()
  const cookie = (csrfRes.headers.get('set-cookie') || '').split(';')[0]
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    'x-csrf-token': csrfBody.token,
    cookie,
  }
  const post = async (endpoint, body) => {
    const res = await fetch(`${BASE}${endpoint}`, { method: 'POST', headers, body: JSON.stringify(body) })
    const json = await res.json()
    if (!json.success) throw new Error(`${endpoint} 失败: ${JSON.stringify(json).slice(0, 200)}`)
    return json.data
  }

  const project = await post('/api/projects', { name: '发版回归项目' })
  const canvas = await post(`/api/canvases/${project.id}`, { name: '发版回归画布' })

  // 协作画布：isCollaborative=true 才会建立 WS 协作，保存走 /flush 那条路
  const collabProject = await post('/api/projects', { name: '发版回归协作项目', isCollaborative: true })
  const collabCanvas = await post(`/api/canvases/${collabProject.id}`, { name: '发版回归协作画布' })

  const manuscript = await post('/api/manuscripts', {
    title: '发版回归手稿',
    contentHtml: '<p>回归起点正文</p>',
  })
  const card = await post('/api/users/node-pool', {
    name: '待搬卡片',
    content: '<p>卡片正文一起搬</p>',
  })
  const pat = await post('/api/tokens', { name: '发版回归令牌' })

  return {
    token,
    headers,
    canvasId: canvas.id,
    collabCanvasId: collabCanvas.id,
    manuscriptId: manuscript.id,
    cardId: card.id,
    pat: pat.token,
  }
}

// ---------------------------------------------------------------- CDP
const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) throw new Error('没有可用的 CDP page target')
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
await new Promise((r) => ws.once('open', r))

let id = 0
const pend = new Map()
const dialogs = []
let dialogAction = { accept: true, promptText: '' }

const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id
    pend.set(i, { resolve: res, reject: rej })
    ws.send(JSON.stringify({ id: i, method, params }))
    setTimeout(() => {
      if (pend.has(i)) {
        pend.delete(i)
        rej(new Error('timeout ' + method))
      }
    }, 30000)
  })

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.method === 'Page.javascriptDialogOpening') {
    dialogs.push({ type: m.params.type, message: m.params.message })
    const params = { accept: dialogAction.accept !== false }
    if (m.params.type === 'prompt') params.promptText = dialogAction.promptText || ''
    send('Page.handleJavaScriptDialog', params).catch(() => {})
    return
  }
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id)
    pend.delete(m.id)
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
  }
})

const ev = async (expression) => {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''))
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
    await sleep(200)
  }
  throw new Error('等待超时: ' + label)
}

const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(TMP, `release-${name}.png`), Buffer.from(data, 'base64'))
}

const click = async (x, y, clickCount = 1) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount })
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount })
  await sleep(150)
}

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

const pressKey = async (key, code = key, vk = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk })
  await sleep(120)
}

const goto = async (url, readyExpr, timeout = 30000) => {
  await send('Page.navigate', { url })
  if (readyExpr) await waitFor(readyExpr, timeout, `就绪: ${readyExpr}`)
  await sleep(300)
}

const typeText = async (text) => {
  await send('Input.insertText', { text })
  await sleep(150)
}

/**
 * 用户真实入口：项目列表 → 点项目卡片 → 落到它的画布。
 * 直接输 `/canvas/<id>` 也能看图，但 store 里没有项目上下文，
 * 协作模式不会启动，画布不在当前项目列表里时还会被弹回项目页。
 */
const openProjectCanvas = async (projectName, canvasId) => {
  await goto(`${BASE}/projects`, `document.body.innerText.includes('我的项目')`, 25000)
  const clicked = await ev(`(() => {
    // 只认主区域里的项目卡片：左栏（aside）也有同名项目入口，点它只会切换上下文不跳画布。
    const card = Array.from(document.querySelectorAll('div.cursor-pointer'))
      .filter((c) => !c.closest('aside') && c.offsetWidth > 150)
      .find((c) => (c.textContent || '').includes(${JSON.stringify(projectName)}));
    if (!card) return 'no-card';
    card.click();
    return 'clicked';
  })()`)
  if (clicked !== 'clicked') throw new Error(`项目页点不到「${projectName}」: ${clicked}`)

  // 点项目卡片后应用自己决定落在哪张画布；不在目标画布上就从左侧「画布管理」里点它。
  // （从别的画布页回来时，应用有时会先落到 /canvas/new 的"请先选择一个画布"空态。）
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await ev('location.pathname')) === `/canvas/${canvasId}`) break
    const hit = await ev(`(() => {
      const el = document.querySelector('[data-canvas-id="${canvasId}"]');
      if (!el) return false;
      el.click();
      return true;
    })()`)
    await sleep(hit ? 500 : 300)
  }
  await waitFor(`location.pathname === '/canvas/${canvasId}'`, 20000, `进入画布 ${canvasId}`)
  await waitFor(`!!document.querySelector('[data-canvas-container]')`, 20000, '画布容器')
  await sleep(400)
  return canvasId
}

/** 像用户按 F5 一样刷新当前页 */
const reloadCurrent = async (readyExpr) => {
  await send('Page.reload')
  await waitFor(readyExpr, 25000, '刷新后重新就绪')
  await sleep(400)
}

const step = async (name, fn) => {
  try {
    const detail = await fn()
    record(name, true, typeof detail === 'string' ? detail : '')
  } catch (error) {
    record(name, false, error.message)
    // 失败时顺手把现场抓下来：只有消息的话，"掉回登录页"和"节点没出现"看起来一模一样
    let ctx = ''
    try {
      const snap = await ev(`({
        path: location.pathname,
        hasToken: !!localStorage.getItem('mindmap_token'),
        nodes: document.querySelectorAll('.node-item').length,
        body: document.body.innerText.slice(0, 80).replace(/\\s+/g, ' '),
      })`)
      ctx = ` ｜ 现场=${JSON.stringify(snap)}`
    } catch {
      ctx = ' ｜ 现场读取失败'
    }
    results[results.length - 1].detail += ctx
    console.log(`${ctx}`)
    await shot(`fail-${name.replace(/[^\w\u4e00-\u9fa5]+/g, '_').slice(0, 30)}`).catch(() => {})
  }
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })

// ---------------------------------------------------------------- 跑
await step('A. 静态壳与资源（index.html 不缓存、CSS 带焦点修复）', async () => {
  const before = results.length
  await staticChecks()
  const added = results.slice(before)
  const failed = added.filter((r) => !r.ok)
  if (failed.length > 0) throw new Error(failed.map((r) => `${r.name}: ${r.detail}`).join(' | '))
  return added.map((r) => r.detail).join(' ｜ ')
})

let seeded
await step('播种：注册 + 项目 + 画布 + 手稿 + 卡片 + 访问令牌', async () => {
  seeded = await seed()
  return `canvas=${seeded.canvasId} manuscript=${seeded.manuscriptId} card=${seeded.cardId}`
})

// 注入登录态（与 folder-delete 同一套：token 只认 mindmap_token）
await ev(`localStorage.clear(); sessionStorage.clear()`)
await ev(`localStorage.setItem('mindmap_token', ${JSON.stringify(seeded.token)})`)

const editorSel = '.rich-text-content'
const paperSel = '.notebook-paper'
const canvasReadyExpr = `location.pathname === '/canvas/${seeded.canvasId}' && !!document.querySelector('[data-canvas-container]')`
const nodeIds = () => ev(`Array.from(document.querySelectorAll('.node-item')).map((el) => el.getAttribute('data-node-id'))`)
const nodeCount = () => ev(`document.querySelectorAll('.node-item').length`)
const toastText = () =>
  ev(`Array.from(document.querySelectorAll('div.fixed.bottom-4.right-4')).map((el) => el.innerText).join(' \\n ')`)

// ---------------------------------------------------------------- B. 笔记本
await step('B. 笔记本：打开手稿，点正文进入编辑', async () => {
  await goto(`${BASE}/notebook/${seeded.manuscriptId}`, `!!document.querySelector('${editorSel}')`)
  await clickEl(editorSel)
  await waitFor(`document.activeElement && document.activeElement.classList.contains('rich-text-content')`, 8000, '正文获得焦点')
  return '光标已进入正文'
})

await step('B. 笔记本：正文没有 UA 焦点方框（本轮修复点）', async () => {
  const style = await ev(`(() => {
    const ed = document.querySelector('${editorSel}');
    const cs = getComputedStyle(ed);
    return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor, boxShadow: cs.boxShadow };
  })()`)
  const clean = style.outlineStyle === 'none' || style.outlineWidth === '0px'
  if (!clean) throw new Error('正文还带着焦点方框: ' + JSON.stringify(style))
  return JSON.stringify(style)
})

await step('B. 笔记本：纸张原有的描边与柔光还在（没把高光误删）', async () => {
  const style = await ev(`(() => {
    const paper = document.querySelector('${paperSel}');
    if (!paper) return null;
    const cs = getComputedStyle(paper);
    return { borderColor: cs.borderColor, boxShadow: cs.boxShadow };
  })()`)
  if (!style) throw new Error('找不到作业本纸张容器')
  const hasGlow = style.boxShadow && style.boxShadow !== 'none'
  const hasRing = /191,\s*219,\s*254/.test(style.borderColor)
  if (!hasGlow || !hasRing) throw new Error('纸张高光/描边丢了: ' + JSON.stringify(style))
  return `border=${style.borderColor}`
})

await step('B. 笔记本：输入正文 → 自动保存 → 刷新后还在', async () => {
  const marker = `回归正文-${Date.now().toString().slice(-6)}`
  await typeText(marker)
  await waitFor(`document.body.innerText.includes('已保存')`, 15000, '自动保存提示')
  await goto(`${BASE}/notebook/${seeded.manuscriptId}`, `!!document.querySelector('${editorSel}')`)
  await waitFor(`(document.querySelector('${editorSel}')||{}).innerText?.includes(${JSON.stringify(marker)})`, 15000, '刷新后正文')
  return marker
})

// ---------------------------------------------------------------- C. 画布
let idsAfterCreate = []
await step('C. 画布：用「节点」工具点两下，建两个节点', async () => {
  const opened = await openProjectCanvas('发版回归项目', seeded.canvasId)
  if (opened !== seeded.canvasId) throw new Error(`项目点开的是画布 ${opened}，期望 ${seeded.canvasId}`)
  for (const [x, y] of [
    [640, 320],
    [980, 330],
  ]) {
    await clickEl('button[title^="节点 (N)"]')
    await sleep(300)
    await click(x, y)
    await sleep(400)
  }
  await waitFor(`document.querySelectorAll('.node-item').length === 2`, 10000, '两个节点')
  idsAfterCreate = await nodeIds()
  if (idsAfterCreate.length !== 2 || idsAfterCreate.some((v) => !v)) {
    throw new Error('节点 id 不完整: ' + JSON.stringify(idsAfterCreate))
  }
  return idsAfterCreate.join(',')
})

/** 真实点工具栏保存按钮：title 带「保存」，排除查看者提示 */
const clickSave = async () => {
  const rect = await ev(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => {
      const t = b.getAttribute('title') || '';
      return t.includes('保存') && !t.includes('无法保存') && !b.disabled;
    });
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    if (r.width === 0) return null;
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), title: btn.getAttribute('title') };
  })()`)
  if (!rect) throw new Error('找不到可点的保存按钮')
  await click(rect.x, rect.y)
  return rect.title
}

await step('C. 画布：点保存 → 明确提示「已保存」', async () => {
  const title = await clickSave()
  await waitFor(`Array.from(document.querySelectorAll('div.fixed.bottom-4.right-4')).some((el) => el.innerText.includes('已保存'))`, 20000, '已保存提示')
  return `按钮=${title}｜提示=${(await toastText()).replace(/\s+/g, ' ').slice(0, 40)}`
})

await step('C. 画布：刷新后两个节点都在（基线）', async () => {
  await reloadCurrent(canvasReadyExpr)
  await waitFor(`document.querySelectorAll('.node-item').length === 2`, 15000, '刷新后仍是 2 个节点')
  return `节点=${(await nodeIds()).join(',')}`
})

let deletedId = ''
let keptId = ''
await step('C. 画布：选中第二个节点并删除', async () => {
  const ids = await nodeIds()
  deletedId = ids[1]
  keptId = ids[0]
  await pressKey('Escape', 'Escape', 27)
  const center = await ev(`(() => {
    const el = document.querySelector('[data-node-id="${deletedId}"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
  })()`)
  if (!center) throw new Error('删之前找不到节点 ' + deletedId)
  await click(center[0], center[1])
  await waitFor(
    `!Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('title')||'').startsWith('删除选中项'))?.disabled`,
    8000,
    '删除按钮可用（说明选中了）',
  )
  await clickEl('button[title^="删除选中项"]')
  await waitFor(`document.querySelectorAll('.node-item').length === 1`, 8000, '只剩一个节点')
  const left = await nodeIds()
  if (left.includes(deletedId)) throw new Error('删除后节点还在: ' + deletedId)
  return `删 ${deletedId}，留 ${left.join(',')}`
})

let dbUpdatedBefore = null
const dbFile = process.env.E2E_DB
const canvasRow = (canvasId = seeded.canvasId) => {
  if (!dbFile || !fs.existsSync(dbFile)) return null
  try {
    // 延迟加载，没装/没给库文件时不影响其余检查
    const Database = require('better-sqlite3')
    const db = new Database(dbFile, { readonly: true })
    db.pragma('busy_timeout = 3000')
    const row = db.prepare('SELECT updated_at, length(yjs_update) AS len FROM canvases WHERE id = ?').get(canvasId)
    db.close()
    return row || null
  } catch {
    return null
  }
}

await step('C. 画布：删除后保存 → 服务端真的落库', async () => {
  dbUpdatedBefore = canvasRow()
  const title = await clickSave()
  await waitFor(`Array.from(document.querySelectorAll('div.fixed.bottom-4.right-4')).some((el) => el.innerText.includes('已保存'))`, 20000, '已保存提示')
  await sleep(400)
  const after = canvasRow()
  if (dbUpdatedBefore && after) {
    if (!(after.updated_at >= dbUpdatedBefore.updated_at)) {
      throw new Error(`保存后 canvases.updated_at 没前进: ${dbUpdatedBefore.updated_at} → ${after.updated_at}`)
    }
    return `按钮=${title}｜updated_at ${dbUpdatedBefore.updated_at}→${after.updated_at}｜yjs_update ${after.len}B`
  }
  return `按钮=${title}（未提供 E2E_DB，跳过库内核对）`
})

await step('C. 画布：刷新后删掉的节点没有复活（用户报的 bug）', async () => {
  await reloadCurrent(canvasReadyExpr)
  await waitFor(`document.querySelectorAll('.node-item').length === 1`, 15000, '刷新后只剩 1 个节点')
  // 再等一个防抖/周期刷盘窗口，确认不是"刚删还没写到库"
  await sleep(2500)
  await send('Page.reload')
  await waitFor(canvasReadyExpr, 20000, '二次刷新')
  await waitFor(`document.querySelectorAll('.node-item').length === 1`, 15000, '二次刷新后仍是 1 个')
  const ids = await nodeIds()
  if (ids.includes(deletedId)) throw new Error(`被删节点 ${deletedId} 又回来了`)
  if (!ids.includes(keptId)) throw new Error(`没被删的节点 ${keptId} 反而丢了`)
  return `在= ${ids.join(',')} ｜ 删掉的 ${deletedId} 没有回来`
})

// ---------------------------------------------------------------- C2. 协作画布（保存走 /flush）
let liveCollabCanvasId = seeded.collabCanvasId
const collabCanvasReady = `location.pathname === '/canvas/${liveCollabCanvasId}' && !!document.querySelector('[data-canvas-container]')`

await step('C2. 协作画布：从项目页进入 → WS 协作真的连上', async () => {
  liveCollabCanvasId = await openProjectCanvas('发版回归协作项目', seeded.collabCanvasId)
  await waitFor(
    `Array.from(document.querySelectorAll('button')).some((b) => (b.getAttribute('title') || '').includes('协作模式下已实时保存'))`,
    25000,
    '协作模式生效',
  )
  return `canvas=${liveCollabCanvasId} 按钮=协作模式下已实时保存`
})

await step('C2. 协作画布：建两个节点 → 删一个 → 保存走 /flush 且如实提示', async () => {
  for (const [x, y] of [
    [620, 300],
    [960, 320],
  ]) {
    await clickEl('button[title^="节点 (N)"]')
    await sleep(300)
    await click(x, y)
    await sleep(500)
  }
  await waitFor(`document.querySelectorAll('.node-item').length === 2`, 12000, '协作画布两个节点')
  const ids = await nodeIds()
  const doomed = ids[1]

  await pressKey('Escape', 'Escape', 27)
  const center = await ev(`(() => {
    const el = document.querySelector('[data-node-id="${doomed}"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
  })()`)
  if (!center) throw new Error('找不到要删的节点 ' + doomed)
  await click(center[0], center[1])
  await waitFor(
    `!Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('title')||'').startsWith('删除选中项'))?.disabled`,
    8000,
    '删除按钮可用',
  )
  await clickEl('button[title^="删除选中项"]')
  await waitFor(`document.querySelectorAll('.node-item').length === 1`, 8000, '协作画布只剩一个节点')

  const before = canvasRow(liveCollabCanvasId)
  await clickSave()
  await waitFor(
    `Array.from(document.querySelectorAll('div.fixed.bottom-4.right-4')).some((el) => el.innerText.includes('内容已写入服务器'))`,
    20000,
    '「已保存 / 内容已写入服务器」提示',
  )
  const toast = (await toastText()).replace(/\s+/g, ' ')
  if (/保存失败|保存未完成/.test(toast)) throw new Error('保存报了失败: ' + toast)
  await sleep(400)
  const after = canvasRow(liveCollabCanvasId)
  if (before && after && !(after.updated_at >= before.updated_at)) {
    throw new Error(`/flush 后 canvases.updated_at 没前进: ${before.updated_at} → ${after.updated_at}`)
  }
  return `提示=${toast.slice(0, 30)}｜updated_at ${before?.updated_at}→${after?.updated_at}`
})

await step('C2. 协作画布：刷新后删掉的节点同样没有复活', async () => {
  const ready = `location.pathname === '/canvas/${liveCollabCanvasId}' && !!document.querySelector('[data-canvas-container]')`
  await reloadCurrent(ready)
  await waitFor(`document.querySelectorAll('.node-item').length === 1`, 15000, '协作画布刷新后 1 个节点')
  await sleep(1500)
  await reloadCurrent(ready)
  await waitFor(`document.querySelectorAll('.node-item').length === 1`, 15000, '二次刷新后仍是 1 个')
  return '协作路径下删除同样落库'
})

// ---------------------------------------------------------------- D. 卡片搬运
const menuCheck = () =>
  ev(`(() => {
    const item = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '移到画布');
    if (!item) {
      return { found: false, all: Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || '').trim()).filter(Boolean).slice(0, 30) };
    }
    const menu = item.parentElement;
    const labels = Array.from(menu.querySelectorAll('button')).map((b) => (b.textContent || '').trim()).filter(Boolean);
    return { found: true, labels };
  })()`)

const openCardMenu = async () => {
  const opened = await ev(`(() => {
    const panel = document.querySelector('[data-node-pool="true"]');
    if (!panel) return { error: 'no-panel' };
    const leaf = Array.from(panel.querySelectorAll('*'))
      .find((el) => el.children.length === 0 && (el.textContent || '').trim() === '待搬卡片');
    if (!leaf) return { error: 'no-card' };
    const r = (leaf.closest('[title]') || leaf).getBoundingClientRect();
    const x = Math.max(4, Math.min(Math.round(r.x + r.width / 2), window.innerWidth - 8));
    const y = Math.max(4, Math.min(Math.round(r.y + r.height / 2), window.innerHeight - 8));
    leaf.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y }));
    return { ok: true };
  })()`)
  if (opened.error) throw new Error('节点池里找不到卡片: ' + opened.error)
}

await step('D. 节点池：打开面板，能看见种子卡片', async () => {
  // 回到非协作那张画布，后面的搬运与节点数断言都以它为基准
  const opened = await openProjectCanvas('发版回归项目', seeded.canvasId)
  if (opened !== seeded.canvasId) throw new Error(`回到的画布是 ${opened}，期望 ${seeded.canvasId}`)
  await waitFor(`document.querySelectorAll('.node-item').length === 1`, 15000, '回到基准画布')
  const panelOpen = await ev(`!!document.querySelector('[data-node-pool="true"]')`)
  if (!panelOpen) {
    await clickEl('button[title^="切换节点池"]')
    await waitFor(`!!document.querySelector('[data-node-pool="true"]')`, 8000, '节点池面板')
  }
  await waitFor(`document.body.innerText.includes('待搬卡片')`, 10000, '卡片渲染')
  return '面板与卡片都在'
})

await step('D. 节点池：右键菜单写「移到画布」，不再有「复制到画布」', async () => {
  await openCardMenu()
  await sleep(400)
  const menu = await menuCheck()
  if (!menu.found) throw new Error('右键后菜单里没有「移到画布」: ' + JSON.stringify(menu.all))
  const hasCopy = menu.labels.some((t) => t.includes('复制'))
  if (hasCopy) throw new Error('还留着「复制到画布」: ' + JSON.stringify(menu.labels))
  return JSON.stringify(menu.labels)
})

await step('D. 节点池：点「移到画布」→ 节点落在画布上且不透明', async () => {
  const clicked = await ev(`(() => {
    const item = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '移到画布');
    if (!item) return false;
    item.click();
    return true;
  })()`)
  if (!clicked) throw new Error('点不到「移到画布」')
  await waitFor(`document.querySelectorAll('.node-item').length === 2`, 12000, '卡片变成节点')

  const look = await ev(`(() => {
    const nodes = Array.from(document.querySelectorAll('.node-item'));
    const el = nodes[nodes.length - 1];
    let bg = '';
    for (const candidate of [el, ...el.querySelectorAll('*')]) {
      const c = getComputedStyle(candidate).backgroundColor;
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') { bg = c; break }
    }
    return { bg, opacity: getComputedStyle(el).opacity, nodeId: el.getAttribute('data-node-id') };
  })()`)
  if (!look.bg || /rgba\(0, 0, 0, 0\)/.test(look.bg)) throw new Error('节点没有背景色（就是那个半透明 bug）: ' + JSON.stringify(look))
  if (Number(look.opacity) < 1) throw new Error('节点是半透明的: ' + JSON.stringify(look))
  return JSON.stringify(look)
})

await step('D. 节点池：卡片已从池里搬走（接口也不是复制）', async () => {
  const res = await fetch(`${BASE}/api/users/node-pool`, { headers: { authorization: 'Bearer ' + seeded.token } })
  const body = await res.json()
  const ids = (body.data || []).map((c) => c.id)
  if (ids.includes(seeded.cardId)) throw new Error(`卡片 ${seeded.cardId} 还在池里（说明是复制）`)
  return `池内剩 ${ids.length} 张，不含 ${seeded.cardId}`
})

await step('D. 节点池：刷新后节点还在、卡片仍不在', async () => {
  await reloadCurrent(canvasReadyExpr)
  await waitFor(`document.querySelectorAll('.node-item').length === 2`, 15000, '刷新后仍是 2 个节点')
  const res = await fetch(`${BASE}/api/users/node-pool`, { headers: { authorization: 'Bearer ' + seeded.token } })
  const body = await res.json()
  if ((body.data || []).some((c) => c.id === seeded.cardId)) throw new Error('刷新后卡片又回到池里')
  return '搬运语义在刷新后仍成立'
})

// ---------------------------------------------------------------- E. MCP 与界面同源
let rpcId = 0
async function mcpTool(name, args = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer ' + seeded.pat,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  })
  const json = await res.json()
  const text = json?.result?.content?.[0]?.text ?? ''
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    /* 纯文本错误 */
  }
  return { status: res.status, isError: json?.result?.isError === true, text, parsed, json }
}

await step('E. MCP：PAT 通过 /mcp 建节点，刷新画布就能看见', async () => {
  const title = 'MCP 建节点'
  const res = await mcpTool('createNode', { canvasId: seeded.canvasId, title, x: 420, y: 560, color: '#e3f2fd' })
  if (res.isError) throw new Error('createNode 失败: ' + res.text.slice(0, 200))
  await reloadCurrent(canvasReadyExpr)
  await waitFor(`document.body.innerText.includes(${JSON.stringify(title)})`, 15000, '界面出现 MCP 建的节点')
  const count = await nodeCount()
  return `界面节点=${count}，含「${title}」`
})

await step('E. MCP：getAllNodes 与界面节点数一致（同一份权威数据）', async () => {
  const res = await mcpTool('getAllNodes', { canvasId: seeded.canvasId })
  if (res.isError) throw new Error('getAllNodes 失败: ' + res.text.slice(0, 160))
  const nodes = res.parsed?.nodes ?? res.parsed ?? []
  const uiCount = await nodeCount()
  if (!Array.isArray(nodes) || nodes.length !== uiCount) {
    throw new Error(`服务端 ${Array.isArray(nodes) ? nodes.length : '?'} 个 vs 界面 ${uiCount} 个`)
  }
  return `两侧都是 ${uiCount} 个`
})

await step('E. MCP：poolList 不再返回 useCount；poolCreate 的卡片界面能看到', async () => {
  const created = await mcpTool('poolCreate', { title: 'MCP 卡片', text: '来自外部 agent' })
  if (created.isError) throw new Error('poolCreate 失败: ' + created.text.slice(0, 160))

  const listed = await mcpTool('poolList', {})
  const text = listed.text
  if (/"useCount"/.test(text)) throw new Error('poolList 仍然返回 useCount')

  // 界面侧：刷新后打开节点池，应该看到这张卡
  await reloadCurrent(canvasReadyExpr)
  const open = await ev(`!!document.querySelector('[data-node-pool="true"]')`)
  if (!open) await clickEl('button[title^="切换节点池"]')
  await waitFor(`document.body.innerText.includes('MCP 卡片')`, 12000, '界面出现 MCP 建的卡片')
  return 'useCount 已下线，卡片双向可见'
})

await shot('final')
const ok = summary()
ws.close()
process.exit(ok ? 0 : 1)
