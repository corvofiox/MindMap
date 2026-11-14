/**
 * 笔记本 ⇄ 节点池：搬运，不是复制。
 *
 * 一句需求：卡片从节点池进笔记本变成手稿时，节点池里那张卡要没；手稿进节点池
 * 变成卡片时，笔记本里那篇稿也要没。这个脚本就是拿真浏览器把两个方向都走一遍，
 * 并且用服务端接口核对——**界面看着没了但库里还在**是最容易漏的那种"看着对"。
 *
 * 前置：
 *   1) 服务已起并托管了构建好的前端（默认 http://127.0.0.1:8000）
 *   2) headless Edge 带 CDP（默认 http://127.0.0.1:9223）
 *
 * 用法：
 *   node e2e/notebook-move.mjs
 *   E2E_BASE=http://127.0.0.1:8000 E2E_CDP=http://127.0.0.1:9223 node e2e/notebook-move.mjs
 *
 * 每次跑都用新账号：不动演示数据，可重复。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import WebSocket from '../node_modules/ws/index.js'

const CDP = process.env.E2E_CDP || 'http://127.0.0.1:9223'
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8000'
const PASSWORD = process.env.E2E_PASSWORD || 'E2ePassw0rd!'
const EMAIL = process.env.E2E_EMAIL || `e2e+move+${Date.now()}@mindmap.local`
const NICKNAME = 'E2E 搬运工'
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
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id)
    pending.delete(m.id)
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
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
  fs.writeFileSync(path.join(TMP, `shot-move-${name}.png`), Buffer.from(data, 'base64'))
}

const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
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

const clickText = async (text, scope = 'button, a, [role="menuitem"]') => {
  const rect = await ev(`(() => {
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(scope)}));
    const el = nodes.find((n) => (n.textContent || '').trim() === ${JSON.stringify(text)})
      || nodes.find((n) => (n.textContent || '').includes(${JSON.stringify(text)}));
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
  })()`)
  if (!rect) {
    const seen = await ev(
      `Array.from(document.querySelectorAll(${JSON.stringify(scope)})).slice(0, 20).map((n) => (n.textContent || '').trim().slice(0, 16)).filter(Boolean)`,
    )
    throw new Error(`找不到可点的文案: ${text}｜当前: ${JSON.stringify(seen)}`)
  }
  await click(rect[0], rect[1])
}

const goto = async (url, readyExpr, timeout = 30000) => {
  await send('Page.navigate', { url })
  if (readyExpr) await waitFor(readyExpr, timeout, `就绪: ${readyExpr}`)
  await sleep(300)
}

const setInput = (selector, value) =>
  ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)

const typeText = async (text) => {
  await send('Input.insertText', { text })
  await sleep(150)
}

const bodyHas = (text) => ev(`document.body.innerText.includes(${JSON.stringify(text)})`)

const step = async (name, fn) => {
  try {
    const detail = await fn()
    record(name, true, typeof detail === 'string' ? detail : '')
  } catch (error) {
    record(name, false, error.message)
    await shot(`fail-${name.replace(/[^\w\u4e00-\u9fa5]+/g, '_').slice(0, 40)}`).catch(() => {})
  }
}

/** 服务端视角：手稿列表 / 单篇是否存在 */
const apiManuscripts = () =>
  ev(`(async () => {
    const res = await fetch('/api/manuscripts', {
      headers: { authorization: 'Bearer ' + localStorage.getItem('mindmap_token') },
    });
    const body = await res.json();
    return (body.data || []).map((m) => ({ id: m.id, title: m.title }));
  })()`)

const apiManuscriptStatus = (mid) =>
  ev(`(async () => {
    const res = await fetch('/api/manuscripts/${mid}', {
      headers: { authorization: 'Bearer ' + localStorage.getItem('mindmap_token') },
    });
    return res.status;
  })()`)

/** 服务端视角：节点池卡片 */
const apiCards = () =>
  ev(`(async () => {
    const res = await fetch('/api/users/node-pool', {
      headers: { authorization: 'Bearer ' + localStorage.getItem('mindmap_token') },
    });
    const body = await res.json();
    return (body.data || []).map((c) => ({ id: c.id, name: c.name }));
  })()`)

const draft = `搬运测试稿-${Date.now().toString().slice(-6)}`

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })

// ---------------------------------------------------------------- 0. 新账号
await step('注册新账号 → 落在项目列表', async () => {
  await ev('localStorage.clear(); sessionStorage.clear()')
  await goto(`${BASE}/register`, `!!document.querySelector('#confirmPassword')`)
  await setInput('#email', EMAIL)
  await setInput('#nickname', NICKNAME)
  await setInput('#password', PASSWORD)
  await setInput('#confirmPassword', PASSWORD)
  await clickText('创建账户')
  await waitFor(`location.pathname === '/projects'`, 20000, '注册后进入 /projects')
  return `${EMAIL}`
})

// ---------------------------------------------------------------- 1. 建稿
await step('在笔记本里新建一篇并写下内容（等自动保存）', async () => {
  await goto(`${BASE}/notebook`, `!!document.querySelector('button')`)
  await waitFor(`document.body.innerText.includes('新建手稿')`, 15000, '笔记本页')
  await clickText('新建手稿')
  await waitFor(`/^\\/notebook\\/\\d+$/.test(location.pathname)`, 15000, '打开了新稿')
  await setInput('input[placeholder="手稿标题"]', draft)
  await clickEl('[data-testid="manuscript-editor"]')
  await typeText('这一段要跟着稿子一起搬到节点池。')
  await sleep(2400)
  const listed = await bodyHas(draft)
  if (!listed) throw new Error('列表里没看到刚建的稿')
  return draft
})

// 记录手稿 id，后面用接口核对
const manuscriptId = Number((await ev('location.pathname')).split('/').pop())

// ---------------------------------------------------------------- 2. 手稿 → 卡片
await step('「送入节点池」：提示已移入、回到列表、这篇不再出现在笔记本里', async () => {
  await clickText('送入节点池')
  await waitFor(`document.body.innerText.includes('已移入节点池')`, 20000, '成功提示')
  await waitFor(`location.pathname === '/notebook'`, 10000, '回到笔记本列表')
  // 只看列表行，别被 toast 里的标题骗了（提示语里就带稿名）
  const rows = await ev(
    `Array.from(document.querySelectorAll('[data-row-id]')).map((n) => (n.textContent || '').trim())`,
  )
  if (JSON.stringify(rows ?? []).includes(draft)) throw new Error(`手稿还在列表里：${JSON.stringify(rows)}`)
  return `id=${manuscriptId} · 列表剩 ${rows.length} 行`
})
await shot('01-sent-to-pool')

await step('服务端也认为这篇没了（软删 = 对外的删除）', async () => {
  const listNow = await apiManuscripts()
  if (listNow.some((m) => m.id === manuscriptId)) throw new Error('接口里还有这篇手稿')
  const status = await apiManuscriptStatus(manuscriptId)
  if (status !== 404) throw new Error(`按 id 取应为 404，实际 ${status}`)
  return `GET /api/manuscripts/${manuscriptId} → 404`
})

await step('节点池里出现了这张卡（内容是刚才那段正文）', async () => {
  const cards = await apiCards()
  const mine = cards.filter((c) => c.name.includes(draft) || c.name.includes('这一段要跟着'))
  if (mine.length !== 1) throw new Error(`节点池里应恰好 1 张对应卡片，实际 ${mine.length}：${JSON.stringify(cards)}`)
  return `cardId=${mine[0].id} · ${mine[0].name}`
})

await step('刷新页面后依然如此（不是只改了本地状态）', async () => {
  await goto(`${BASE}/notebook`, `document.body.innerText.includes('新建手稿')`)
  if (await bodyHas(draft)) throw new Error('刷新后手稿又回来了')
  const cards = await apiCards()
  if (!cards.some((c) => c.name.includes(draft))) throw new Error('刷新后卡片不见了')
  return '列表与池子都符合移动语义'
})

// ---------------------------------------------------------------- 3. 卡片 → 手稿
let restoredId = null
await step('「从节点池导入」把卡片还原成手稿：提示已转为手稿并打开', async () => {
  await clickText('从节点池导入')
  const menu = '[data-testid="notebook-pool-import-menu"]'
  await waitFor(`!!document.querySelector('${menu}')`, 10000, '导入菜单')
  await waitFor(`!!document.querySelector('${menu} [data-testid^="pool-card-"]')`, 15000, '菜单里有卡片')
  await clickEl(`${menu} [data-testid^="pool-card-"]`)
  await waitFor(`document.body.innerText.includes('已转为手稿')`, 20000, '还原提示')
  await waitFor(`/^\\/notebook\\/\\d+$/.test(location.pathname)`, 15000, '打开还原出的手稿')
  restoredId = Number((await ev('location.pathname')).split('/').pop())
  return `manuscriptId=${restoredId}`
})
await shot('02-restored-to-notebook')

await step('卡片从节点池消失：菜单里再也点不到它', async () => {
  await clickText('从节点池导入')
  const menu = '[data-testid="notebook-pool-import-menu"]'
  await waitFor(`!!document.querySelector('${menu}')`, 10000, '导入菜单（复查）')
  await sleep(900)
  const left = await ev(`document.querySelectorAll('${menu} [data-testid^="pool-card-"]').length`)
  // 遮罩是 onMouseDown 关的，用真鼠标点空白处（click 事件关不掉）
  await click(700, 700)
  if (left !== 0) throw new Error(`池子里还剩 ${left} 张卡`)
  const cards = await apiCards()
  if (cards.length !== 0) throw new Error(`接口里还有 ${cards.length} 张卡`)
  return '池子空了'
})

await step('正文一路搬回来没丢（标题与文字都在）', async () => {
  const title = await ev(`(document.querySelector('input[placeholder="手稿标题"]') || {}).value || ''`)
  if (!title.includes(draft)) throw new Error(`标题变了：${title}`)
  const text = await ev(`(document.querySelector('[data-testid="manuscript-editor"]') || {}).innerText || ''`)
  if (!text.includes('这一段要跟着稿子一起搬到节点池')) throw new Error(`正文丢了：${text.slice(0, 60)}`)
  return title
})

// ---------------------------------------------------------------- 4. 另一条入口：节点池面板 → 从笔记本导入
const draft2 = `搬运测试稿二-${Date.now().toString().slice(-6)}`
await step('再建一篇（留给节点池面板那条入口）', async () => {
  await goto(`${BASE}/notebook`, `document.body.innerText.includes('新建手稿')`)
  await clickText('新建手稿')
  await waitFor(`/^\\/notebook\\/\\d+$/.test(location.pathname)`, 15000, '打开了新稿')
  await setInput('input[placeholder="手稿标题"]', draft2)
  await clickEl('[data-testid="manuscript-editor"]')
  await typeText('第二条入口也要搬运。')
  await sleep(2400)
  return draft2
})
const manuscriptId2 = Number((await ev('location.pathname')).split('/').pop())

await step('节点池面板「从笔记本导入」：卡片进池，手稿同时从笔记本消失', async () => {
  await goto(`${BASE}/projects`, `!!document.querySelector('header') && document.body.innerText.includes('我的项目')`)
  await waitFor(`document.body.innerText.includes('从笔记本导入')`, 20000, '节点池面板')
  await clickText('从笔记本导入')
  const menu = '[data-testid="notebook-import-menu"]'
  await waitFor(`!!document.querySelector('${menu}')`, 12000, '导入菜单')
  await waitFor(`document.body.innerText.includes(${JSON.stringify(draft2)})`, 15000, '菜单里出现这篇手稿')
  await clickEl(`${menu} button[data-testid^="import-manuscript-"]`)
  await waitFor(`document.body.innerText.includes('已移入节点池')`, 20000, '移动提示')
  return 'toast 已出现'
})
await shot('03-panel-import')

await step('服务端：这篇手稿没了，卡片多了一张', async () => {
  const listNow = await apiManuscripts()
  if (listNow.some((m) => m.id === manuscriptId2)) throw new Error('接口里还有这篇手稿')
  if ((await apiManuscriptStatus(manuscriptId2)) !== 404) throw new Error('按 id 取应为 404')
  const cards = await apiCards()
  if (!cards.some((c) => c.name.includes(draft2))) throw new Error(`卡片没进池：${JSON.stringify(cards)}`)
  return `GET /api/manuscripts/${manuscriptId2} → 404`
})

await step('回笔记本确认列表干净（只剩还原出来的那一篇）', async () => {
  await goto(`${BASE}/notebook`, `document.body.innerText.includes('新建手稿')`)
  const titles = await ev(
    `Array.from(document.querySelectorAll('[data-row-id]')).map((n) => (n.textContent || '').trim())`,
  )
  const joined = JSON.stringify(titles ?? [])
  if (joined.includes(draft2)) throw new Error(`列表里还有第二篇：${joined}`)
  if (!joined.includes(draft)) throw new Error(`还原出来的那篇不见了：${joined}`)
  return joined.slice(0, 140)
})

const failed = results.filter((r) => !r.ok)
console.log('\n=== 汇总 ===')
console.log(`通过 ${results.length - failed.length}/${results.length}`)
for (const f of failed) console.log('  未通过:', f.name, '—', f.detail)
process.exit(failed.length === 0 ? 0 : 1)
