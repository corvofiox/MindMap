/**
 * 拖拽排序 / 拖入文件夹 / 拖拽影子——真机实操。
 *
 * 前置：服务已起并托管构建好的前端 + headless Edge（CDP 9223）。
 * 数据全部用接口按固定结构种下（每次跑一个新账号）。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import WebSocket from '../node_modules/ws/index.js'

const CDP = process.env.E2E_CDP || 'http://127.0.0.1:9223'
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8000'
const PASSWORD = 'E2ePassw0rd!'
const EMAIL = `drag+${Date.now()}@mindmap.local`
const TMP = process.env.E2E_OUT || path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp')

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
fs.mkdirSync(TMP, { recursive: true })

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// ---------------------------------------------------------------- 播种
async function seed() {
  const reg = await (await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, nickname: '拖拽测试' }),
  })).json()
  const token = reg.data.token
  const userId = reg.data.user.id
  const csrfRes = await fetch(`${BASE}/api/csrf-token`, { headers: { authorization: `Bearer ${token}` } })
  const csrf = await csrfRes.json()
  const cookie = (csrfRes.headers.get('set-cookie') || '').split(';')[0]
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    'x-csrf-token': csrf.token,
    cookie,
  }
  const post = async (p, body) =>
    (await fetch(`${BASE}${p}`, { method: 'POST', headers, body: JSON.stringify(body) })).json()

  const project = await post('/api/projects', {
    name: '拖拽项目', ownerId: userId, groupId: null, thumbnail: null, isPublic: false,
  })
  const projectId = project.data.id
  await post(`/api/canvases/${projectId}`, { name: '画布甲', projectId })
  await post(`/api/canvases/${projectId}`, { name: '画布乙', projectId })
  await post(`/api/canvases/${projectId}`, { name: '画布丙', projectId })

  await post('/api/manuscripts', { title: '稿甲', contentHtml: '<p>甲</p>', folderId: null })
  await post('/api/manuscripts', { title: '稿乙', contentHtml: '<p>乙</p>', folderId: null })
  await post('/api/manuscripts', { title: '稿丙', contentHtml: '<p>丙</p>', folderId: null })

  // 节点池：一张"文字在上、图在下面"的卡片 + 一张纯文字卡片 + 一个文件夹
  await post('/api/users/node-pool', {
    name: '文字加图卡片',
    content: JSON.stringify({
      title: '文字加图卡片',
      content: `<p>先是一段文字</p><p>第二段文字</p><p><img src="data:image/png;base64,${PNG_B64}"></p>`,
      cover: `data:image/png;base64,${PNG_B64}`,
    }),
    type: 'image',
    color: '#ffffff',
    folderId: null,
  })
  await post('/api/users/node-pool', {
    name: '纯文字卡片',
    content: JSON.stringify({ title: '纯文字卡片', content: '<p>只有文字</p>' }),
    type: 'text',
    color: '#ffffff',
    folderId: null,
  })
  await post('/api/users/node-pool-folders', { name: '目标文件夹' })

  // 拖拽排序要用：三张卡（甲乙丙）+ 两个文件夹
  await post('/api/users/node-pool', {
    name: '排序卡甲',
    content: JSON.stringify({ title: '排序卡甲', content: '<p>甲</p>' }),
    type: 'text',
    color: '#ffffff',
    folderId: null,
  })
  await post('/api/users/node-pool', {
    name: '排序卡乙',
    content: JSON.stringify({ title: '排序卡乙', content: '<p>乙</p>' }),
    type: 'text',
    color: '#ffffff',
    folderId: null,
  })
  await post('/api/users/node-pool', {
    name: '排序卡丙',
    content: JSON.stringify({ title: '排序卡丙', content: '<p>丙</p>' }),
    type: 'text',
    color: '#ffffff',
    folderId: null,
  })
  await post('/api/users/node-pool-folders', { name: '排序夹甲' })
  await post('/api/users/node-pool-folders', { name: '排序夹乙' })
  await post('/api/users/node-pool-folders', { name: '排序夹丙' })

  // 画布/手稿的文件夹树（拖拽排序对象）
  await post(`/api/canvases/${projectId}/folders`, { name: '画布夹甲', parentId: null })
  await post(`/api/canvases/${projectId}/folders`, { name: '画布夹乙', parentId: null })
  await post('/api/manuscript-folders', { name: '手稿夹甲' })
  await post('/api/manuscript-folders', { name: '手稿夹乙' })

  return { token, projectId, headers, post }
}

/** 单独再建一张"文字在上、图在下"的卡片（保证反复运行时前提成立） */
async function seedCard(auth, name, headersOverride) {
  const headers = headersOverride ?? auth.headers
  const post = auth.post
  await post('/api/users/node-pool', {
    name,
    content: JSON.stringify({
      title: name,
      content: `<p>先是一段文字</p><p>第二段文字</p><p><img src="data:image/png;base64,${PNG_B64}"></p>`,
      cover: `data:image/png;base64,${PNG_B64}`,
    }),
    type: 'image',
    color: '#ffffff',
    folderId: null,
  })
  return headers
}

// ---------------------------------------------------------------- CDP
const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) throw new Error('没有可用的 CDP page target')
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
await new Promise((r) => ws.once('open', r))

let id = 0
const pend = new Map()
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id
    pend.set(i, { resolve: res, reject: rej })
    ws.send(JSON.stringify({ id: i, method, params }))
    setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout ' + method)) } }, 30000)
  })
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id)
    pend.delete(m.id)
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
  }
})
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''))
  }
  return r.result?.value
}
const waitFor = async (expr, timeout = 20000, label = expr) => {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try { if (await ev(expr)) return true } catch { /* 页面切换 */ }
    await sleep(200)
  }
  throw new Error('等待超时: ' + label)
}
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(TMP, `drag-${name}.png`), Buffer.from(data, 'base64'))
}
const step = async (name, fn) => {
  try {
    const detail = await fn()
    record(name, true, typeof detail === 'string' ? detail : '')
  } catch (error) {
    record(name, false, error.message)
    await shot(`fail-${name.replace(/[^\w\u4e00-\u9fa5]+/g, '_').slice(0, 30)}`).catch(() => {})
  }
}

const mouse = (type, x, y) =>
  send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1,
  })

/** 真实鼠标拖拽（用于节点池/画布这类 mousedown 驱动的拖拽） */
async function mouseDrag(x1, y1, x2, y2, opts = {}) {
  const { steps = 12, shotAt } = opts
  await mouse('mouseMoved', x1, y1)
  await mouse('mousePressed', x1, y1)
  await sleep(150)
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps
    await mouse('mouseMoved', Math.round(x1 + (x2 - x1) * t), Math.round(y1 + (y2 - y1) * t))
    await sleep(45)
  }
  if (shotAt) await shot(shotAt)
  await mouse('mouseReleased', x2, y2)
  await sleep(1200)
}

/**
 * HTML5 拖放（列表行用的是 draggable）
 */
const html5Drag = (fromSelector, toSelector, position = 'before') =>
  ev(`(() => {
    const from = document.querySelector(${JSON.stringify(fromSelector)});
    const to = document.querySelector(${JSON.stringify(toSelector)});
    if (!from || !to) return { error: 'missing', from: !!from, to: !!to };
    const dt = new DataTransfer();
    const fire = (el, type) => {
      const rect = el.getBoundingClientRect();
      const clientY = ${JSON.stringify(position)} === 'before' ? rect.top + rect.height * 0.25 : rect.top + rect.height * 0.75;
      el.dispatchEvent(new DragEvent(type, {
        bubbles: true, cancelable: true, dataTransfer: dt,
        clientX: rect.left + rect.width / 2, clientY,
      }));
    };
    fire(from, 'dragstart');
    fire(to, 'dragover');
    fire(to, 'drop');
    fire(from, 'dragend');
    return { ok: true };
  })()`)

/**
 * 按"文本匹配"把 A 拖到 B 的上/下半部（HTML5 拖放）。
 *
 * 比 html5Drag 多一步：按 textContent 过滤——同一个选择器会命中一堆行，
 * 只有其中两行是本次要动的（文件夹树就是这样）。
 *
 * 载荷**不预先灌进去**：让组件自己的 onDragStart 去 setData，
 * 这样顺带验证了拖拽载荷的编码是对的（文件夹带 `folder:` 前缀，画布是纯数字）。
 */
const html5DragByText = (selector, fromText, toText, position = 'after') =>
  ev(`(() => {
    const all = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const pick = (needle) => all.find((el) => (el.innerText || '').includes(needle));
    const from = pick(${JSON.stringify(fromText)});
    const to = pick(${JSON.stringify(toText)});
    if (!from || !to) return { error: 'missing', from: !!from, to: !!to, texts: all.map((e) => (e.innerText || '').split('\\n')[0]) };
    if (from === to) return { error: 'same-element' };
    const dt = new DataTransfer();
    const fire = (el, type, clientY) => {
      const rect = el.getBoundingClientRect();
      el.dispatchEvent(new DragEvent(type, {
        bubbles: true, cancelable: true, dataTransfer: dt,
        clientX: rect.left + rect.width / 2,
        clientY: clientY ?? (rect.top + rect.height / 2),
      }));
    };
    fire(from, 'dragstart');
    const payload = dt.getData('text/plain');
    const rect = to.getBoundingClientRect();
    const y = ${JSON.stringify(position)} === 'before' ? rect.top + rect.height * 0.25 : rect.top + rect.height * 0.75;
    fire(to, 'dragover', y);
    fire(to, 'drop', y);
    fire(from, 'dragend');
    return { ok: true, payload };
  })()`)

const rowRect = (selector) =>
  ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), top: Math.round(r.top), bottom: Math.round(r.bottom) };
  })()`)

/** 按标题找手稿行 */
const manuscriptRowSelector = (title) =>
  `aside [data-drag-row]` // 具体筛选在下面用 JS 做

const manuscriptOrder = () =>
  ev(`(() => {
    const out = [];
    document.querySelectorAll('aside [data-drag-row]').forEach((el) => {
      const t = (el.innerText || '').split('\\n')[0].trim();
      if (/^稿[甲乙丙]/.test(t)) out.push(t.slice(0, 2));
    });
    return out;
  })()`)

// ---------------------------------------------------------------- 开跑
const seeded = await seed()
await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })

await send('Page.navigate', { url: `${BASE}/login` })
await sleep(2000)
await ev(`localStorage.setItem('mindmap_token', ${JSON.stringify(seeded.token)})`)
await send('Page.navigate', { url: `${BASE}/notebook` })
await waitFor(`document.body.innerText.includes('稿甲')`, 20000, '笔记本与种子手稿')

await shot('notebook-before')

await step('手稿列表：把第一行拖到第三行上/下方，顺序真的变了', async () => {
  const before = await manuscriptOrder()
  if (before.join('') !== '稿甲稿乙稿丙') throw new Error('初始顺序不对: ' + JSON.stringify(before))

  // 拖 稿甲（第一行）到 稿丙（第三行）下方
  const rows = await ev(`(() => {
    const els = Array.from(document.querySelectorAll('aside [data-drag-row]'))
      .filter((el) => /^稿[甲乙丙]/.test((el.innerText || '').trim()));
    return els.map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.getAttribute('data-row-id'), y: Math.round(r.top + r.height / 2), bottom: Math.round(r.bottom), top: Math.round(r.top) };
    });
  })()`)
  if (rows.length < 3) throw new Error('手稿行不足: ' + JSON.stringify(rows))

  const dragResult = await ev(`(() => {
    const els = Array.from(document.querySelectorAll('aside [data-drag-row]'))
      .filter((el) => /^稿[甲乙丙]/.test((el.innerText || '').trim()));
    const from = els[0];
    const to = els[2];
    if (!from || !to) return { error: 'missing' };
    const dt = new DataTransfer();
    const fire = (el, type, clientY) => {
      const rect = el.getBoundingClientRect();
      el.dispatchEvent(new DragEvent(type, {
        bubbles: true, cancelable: true, dataTransfer: dt,
        clientX: rect.left + rect.width / 2,
        clientY: clientY ?? (rect.top + rect.height / 2),
      }));
    };
    fire(from, 'dragstart');
    // 落在第三行的下半部分 → 插到它后面
    const rect = to.getBoundingClientRect();
    fire(to, 'dragover', rect.top + rect.height * 0.8);
    fire(to, 'drop', rect.top + rect.height * 0.8);
    fire(from, 'dragend');
    return { ok: true };
  })()`)
  if (dragResult?.error) throw new Error('拖放失败: ' + JSON.stringify(dragResult))

  await sleep(1800)
  const after = await manuscriptOrder()
  if (after.join('') === before.join('')) throw new Error('顺序没有变化: ' + JSON.stringify(after))
  return `${JSON.stringify(before)} → ${JSON.stringify(after)}`
})
await shot('notebook-after')

await step('手稿顺序落库：刷新后仍是新顺序', async () => {
  const beforeReload = await manuscriptOrder()
  await send('Page.navigate', { url: `${BASE}/notebook` })
  await waitFor(`document.body.innerText.includes('稿')`, 20000, '刷新后的笔记本')
  await sleep(1500)
  const afterReload = await manuscriptOrder()
  if (afterReload.join('') !== beforeReload.join('')) {
    throw new Error(`刷新后顺序变了: ${JSON.stringify(beforeReload)} → ${JSON.stringify(afterReload)}`)
  }
  return JSON.stringify(afterReload)
})

// ---------------------------------------------------------------- 手稿文件夹排序
await send('Page.navigate', { url: `${BASE}/notebook` })
await waitFor(`document.body.innerText.includes('手稿夹甲')`, 20000, '手稿文件夹树')
await sleep(1200)

const folderRowOrder = (prefix) =>
  ev(`(() => {
    const out = [];
    document.querySelectorAll('[data-folder-row]').forEach((el) => {
      const t = (el.innerText || '').split('\\n')[0].trim();
      if (new RegExp('^' + ${JSON.stringify(prefix)}).test(t)) out.push({ id: el.getAttribute('data-folder-row'), name: t });
    });
    return out;
  })()`)

await step('手稿文件夹：把「手稿夹甲」拖到「手稿夹乙」下方，顺序真的变了', async () => {
  const before = await folderRowOrder('手稿夹')
  if (before.map((f) => f.name).join(',') !== '手稿夹甲,手稿夹乙') {
    throw new Error('初始文件夹顺序不对: ' + JSON.stringify(before))
  }

  const dragResult = await html5DragByText('[data-folder-row]', '手稿夹甲', '手稿夹乙', 'after')
  if (dragResult?.error) throw new Error('拖放失败: ' + JSON.stringify(dragResult))
  if (!/^folder:/.test(String(dragResult.payload || ''))) {
    throw new Error('文件夹拖拽载荷没有前缀: ' + JSON.stringify(dragResult.payload))
  }

  await sleep(1800)
  const after = await folderRowOrder('手稿夹')
  if (after.map((f) => f.name).join(',') !== '手稿夹乙,手稿夹甲') {
    throw new Error('文件夹顺序没变: ' + JSON.stringify(after))
  }
  return `${JSON.stringify(before.map((f) => f.name))} → ${JSON.stringify(after.map((f) => f.name))}`
})

await step('手稿文件夹顺序落库：刷新后仍是新顺序', async () => {
  await send('Page.navigate', { url: `${BASE}/notebook` })
  await waitFor(`document.body.innerText.includes('手稿夹乙')`, 20000, '刷新后的文件夹树')
  await sleep(1500)
  const after = await folderRowOrder('手稿夹')
  if (after.map((f) => f.name).join(',') !== '手稿夹乙,手稿夹甲') {
    throw new Error('刷新后文件夹顺序变了: ' + JSON.stringify(after))
  }
  return JSON.stringify(after.map((f) => f.name))
})

// ---------------------------------------------------------------- 画布列表
await send('Page.navigate', { url: `${BASE}/projects` })
await waitFor(`document.body.innerText.includes('拖拽项目')`, 20000, '项目页')
await sleep(1200)

await step('画布列表：拖动画布调顺序', async () => {
  // 画布列表只在"进入某个项目"后出现在左栏；点项目卡片进画布
  const opened = await ev(`(() => {
    const nodes = Array.from(document.querySelectorAll('*'));
    const title = nodes.find((el) => el.children.length === 0 && (el.textContent || '').trim() === '拖拽项目');
    if (!title) return 'no-title';
    let el = title;
    while (el && el !== document.body) {
      if (el.onclick || el.getAttribute('role') === 'button' || /cursor-pointer/.test(String(el.className))) {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return 'clicked';
      }
      el = el.parentElement;
    }
    return 'no-clickable';
  })()`)
  if (opened !== 'clicked') throw new Error('打不开项目: ' + opened)
  await waitFor(`/^\\/canvas\\/\\d+$/.test(location.pathname)`, 25000, '进入画布')
  await sleep(2500)

  const readCanvases = () => ev(`(() => {
    const out = [];
    document.querySelectorAll('[data-canvas-id]').forEach((el) => {
      const t = (el.innerText || '').trim();
      const m = t.match(/画布[甲乙丙]/);
      if (m) out.push(m[0]);
    });
    return out;
  })()`)

  let before = await readCanvases()
  if (before.length < 2) {
    // 侧栏可能被收起：展开再读
    await ev(`document.querySelector('button[title^="切换侧边栏"]')?.click()`)
    await sleep(1500)
    before = await readCanvases()
  }
  if (before.length < 2) throw new Error('画布行不足: ' + JSON.stringify(before))

  const dragResult = await ev(`(() => {
    const els = Array.from(document.querySelectorAll('[data-canvas-id]'))
      .filter((el) => /画布[甲乙丙]/.test((el.innerText || '').trim()));
    const from = els[0];
    const to = els[els.length - 1];
    if (!from || !to || from === to) return { error: 'missing' };
    const dt = new DataTransfer();
    const fire = (el, type, clientY) => {
      const rect = el.getBoundingClientRect();
      el.dispatchEvent(new DragEvent(type, {
        bubbles: true, cancelable: true, dataTransfer: dt,
        clientX: rect.left + rect.width / 2,
        clientY: clientY ?? (rect.top + rect.height / 2),
      }));
    };
    fire(from, 'dragstart');
    const rect = to.getBoundingClientRect();
    fire(to, 'dragover', rect.top + rect.height * 0.8);
    fire(to, 'drop', rect.top + rect.height * 0.8);
    fire(from, 'dragend');
    return { ok: true };
  })()`)
  if (dragResult?.error) throw new Error('拖放失败: ' + JSON.stringify(dragResult))

  await sleep(2000)
  const after = await readCanvases()
  if (after.join('') === before.join('')) throw new Error('画布顺序没有变化: ' + JSON.stringify(after))
  return `${JSON.stringify(before)} → ${JSON.stringify(after)}`
})
await shot('canvas-order')

// ---------------------------------------------------------------- 节点池拖拽影子
await step('节点池：「文字+图」卡片拖到画布，影子保留文字（不再只剩图片）', async () => {
  // 这个用例的前提是"池里有那张卡、画布是空的"。
  // 反复运行时会破坏前提，所以先补一张新卡并清空当前画布里的节点。
  const cardName = `文字加图卡片-${Date.now()}`
  await seedCard(seeded, cardName)

  if (!(await ev(`/^\\/canvas\\/\\d+$/.test(location.pathname)`))) {
    throw new Error('不在画布页: ' + (await ev('location.pathname')))
  }
  await waitFor(`!!document.querySelector('[data-canvas-container]')`, 20000, '画布容器')

  // 打开节点池（面板靠 transform 滑入，要等它真的在视口里）
  await ev(`document.querySelector('button[title^="切换节点池"]')?.click()`)
  await waitFor(
    `(() => {
      const p = document.querySelector('[data-node-pool="true"]');
      if (!p) return false;
      const r = p.getBoundingClientRect();
      return r.width > 100 && r.x < window.innerWidth - 100;
    })()`,
    15000,
    '节点池面板滑入',
  )
  // 面板要重新拉一次数据才会出现刚建的卡片：整页重进最省事，也最接近用户的真实操作
  await send('Page.navigate', { url: `${BASE}${await ev('location.pathname')}` })
  await waitFor(`!!document.querySelector('[data-canvas-container]')`, 25000, '画布重新加载')
  await sleep(1200)
  await ev(`document.querySelector('button[title^="切换节点池"]')?.click()`)
  await waitFor(
    `(() => {
      const p = document.querySelector('[data-node-pool="true"]');
      if (!p) return false;
      const r = p.getBoundingClientRect();
      return r.width > 100 && r.x < window.innerWidth - 100;
    })()`,
    15000,
    '节点池面板滑入',
  )
  await waitFor(
    `Array.from(document.querySelectorAll('[data-pool-card-id]'))
       .some((x) => (x.innerText || '').includes(${JSON.stringify(cardName)}))`,
    15000,
    '新卡片出现在面板里',
  )

  const beforeNodes = await ev(`document.querySelectorAll('.node-item').length`)

  const cardRect = await ev(`(() => {
    const el = Array.from(document.querySelectorAll('[data-pool-card-id]'))
      .find((x) => (x.innerText || '').includes(${JSON.stringify(cardName)}));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`)
  if (!cardRect) {
    const names = await ev(`Array.from(document.querySelectorAll('[data-pool-card-id]')).map((x) => (x.innerText || '').split('\\n')[0])`)
    throw new Error('找不到刚建的卡片，池内现有: ' + JSON.stringify(names))
  }

  const canvasRect = await rowRect('[data-canvas-container]')
  if (!canvasRect) throw new Error('找不到画布容器')

  // 真实鼠标拖到画布中央，中途截图看影子
  await mouseDrag(cardRect.x, cardRect.y, canvasRect.x, canvasRect.y, { shotAt: 'ghost-midway' })

  await waitFor(`document.querySelectorAll('.node-item').length > ${beforeNodes}`, 20000, '节点落到画布')
  // 等缩略图/落库完成
  await sleep(2500)
  const dropped = await ev(`(() => {
    const nodes = Array.from(document.querySelectorAll('.node-item'));
    if (nodes.length === 0) return { error: 'no-node' };
    const el = nodes[nodes.length - 1];
    return {
      count: nodes.length,
      text: (el.querySelector('[data-field="content"]') || {}).innerText || '',
      html: (el.querySelector('[data-field="content"]') || {}).innerHTML || '',
    };
  })()`)
  if (dropped?.error) throw new Error('节点没有落到画布: ' + JSON.stringify(dropped))
  if (!dropped.text.includes('先是一段文字')) {
    throw new Error('落下来的节点丢了文字: ' + JSON.stringify(dropped).slice(0, 300))
  }
  if (!dropped.html.includes('<img')) throw new Error('落下来的节点丢了图片')
  return `文字与图片都在（节点数 ${beforeNodes} → ${dropped.count}）`
})

// ---------------------------------------------------------------- 节点池卡片 / 文件夹排序
await step('节点池卡片：在池内把「排序卡甲」拖到「排序卡乙」下方，顺序真的变了', async () => {
  // 面板此时是开着的（上一步刚用它拖到画布）
  const readCards = () => ev(`(() => {
    const out = [];
    document.querySelectorAll('[data-pool-card-id]').forEach((el) => {
      const name = (el.innerText || '').split('\\n')[0].trim();
      if (!/^排序卡[甲乙丙]/.test(name)) return;
      const r = el.getBoundingClientRect();
      out.push({ id: el.getAttribute('data-pool-card-id'), name, top: Math.round(r.top), x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), bottom: Math.round(r.bottom) });
    });
    return out.sort((a, b) => a.top - b.top);
  })()`)

  let before = await readCards()
  if (before.length < 3) throw new Error('排序卡不足: ' + JSON.stringify(before))
  if (before.map((c) => c.name).join(',') !== '排序卡甲,排序卡乙,排序卡丙') {
    throw new Error('初始卡片顺序不对: ' + JSON.stringify(before.map((c) => c.name)))
  }

  // 卡片走 mousedown 拖拽，必须用真实鼠标
  await mouseDrag(before[0].x, before[0].y, before[1].x, before[1].bottom - 6)

  // 写库是异步的，给一点时间再读
  await sleep(2000)
  const after = await readCards()
  if (after.map((c) => c.name).join(',') !== '排序卡乙,排序卡甲,排序卡丙') {
    throw new Error(`卡片顺序没变: ${JSON.stringify(before.map((c) => c.name))} → ${JSON.stringify(after.map((c) => c.name))}`)
  }
  return `${JSON.stringify(before.map((c) => c.name))} → ${JSON.stringify(after.map((c) => c.name))}`
})

await step('节点池卡片顺序落库：刷新后仍是新顺序', async () => {
  const canvasPath = await ev('location.pathname')
  await send('Page.navigate', { url: `${BASE}${canvasPath}` })
  await waitFor(`!!document.querySelector('[data-canvas-container]')`, 25000, '画布重新加载')
  await sleep(1200)
  await ev(`document.querySelector('button[title^="切换节点池"]')?.click()`)
  await waitFor(
    `(() => {
      const p = document.querySelector('[data-node-pool="true"]');
      if (!p) return false;
      const r = p.getBoundingClientRect();
      return r.width > 100 && r.right <= window.innerWidth + 1;
    })()`,
    15000,
    '节点池面板滑入',
  )
  await sleep(1500)

  const order = await ev(`(() => {
    const out = [];
    document.querySelectorAll('[data-pool-card-id]').forEach((el) => {
      const name = (el.innerText || '').split('\\n')[0].trim();
      if (!/^排序卡[甲乙丙]/.test(name)) return;
      out.push({ name, top: Math.round(el.getBoundingClientRect().top) });
    });
    return out.sort((a, b) => a.top - b.top).map((c) => c.name);
  })()`)
  if (order.join(',') !== '排序卡乙,排序卡甲,排序卡丙') {
    throw new Error('刷新后卡片顺序变了: ' + JSON.stringify(order))
  }
  return JSON.stringify(order)
})

await step('节点池文件夹：把「排序夹甲」拖到「排序夹乙」下方，顺序真的变了', async () => {
  const folderOrder = () => ev(`(() => {
    const seen = new Set();
    const out = [];
    document.querySelectorAll('[data-folder-id]').forEach((el) => {
      const name = (el.innerText || '').split('\\n')[0].trim();
      if (!/^排序夹[甲乙丙]/.test(name)) return;
      if (seen.has(name)) return;
      seen.add(name);
      out.push({ id: el.getAttribute('data-folder-id'), name, top: Math.round(el.getBoundingClientRect().top) });
    });
    return out.sort((a, b) => a.top - b.top);
  })()`)

  const before = await folderOrder()
  if (before.map((f) => f.name).join(',') !== '排序夹甲,排序夹乙,排序夹丙') {
    throw new Error('初始文件夹顺序不对: ' + JSON.stringify(before))
  }

  const dragResult = await html5DragByText('[data-folder-id]', '排序夹甲', '排序夹乙', 'after')
  if (dragResult?.error) throw new Error('拖放失败: ' + JSON.stringify(dragResult))
  if (!/^folder:/.test(String(dragResult.payload || ''))) {
    throw new Error('文件夹拖拽载荷没有前缀: ' + JSON.stringify(dragResult.payload))
  }

  await sleep(2000)
  const after = await folderOrder()
  if (after.map((f) => f.name).join(',') !== '排序夹乙,排序夹甲,排序夹丙') {
    throw new Error(`文件夹顺序没变: ${JSON.stringify(before.map((f) => f.name))} → ${JSON.stringify(after.map((f) => f.name))}`)
  }
  return `${JSON.stringify(before.map((f) => f.name))} → ${JSON.stringify(after.map((f) => f.name))}`
})

// ---------------------------------------------------------------- 画布文件夹排序
await step('画布文件夹：把「画布夹甲」拖到「画布夹乙」下方，顺序真的变了', async () => {
  // 画布左侧栏的文件夹树
  const canvasFolderOrder = () => ev(`(() => {
    const out = [];
    document.querySelectorAll('[data-folder-item]').forEach((el) => {
      const t = (el.innerText || '').split('\\n')[0].trim();
      if (!/^画布夹[甲乙]/.test(t)) return;
      out.push({ name: t, top: Math.round(el.getBoundingClientRect().top) });
    });
    return out.sort((a, b) => a.top - b.top).map((f) => f.name);
  })()`)

  let before = await canvasFolderOrder()
  if (before.length < 2) {
    // 侧栏可能被收起：展开再读
    await ev(`document.querySelector('button[title^="切换侧边栏"]')?.click()`)
    await sleep(1500)
    before = await canvasFolderOrder()
  }
  if (before.join(',') !== '画布夹甲,画布夹乙') {
    throw new Error('初始画布文件夹顺序不对: ' + JSON.stringify(before))
  }

  const dragResult = await html5DragByText('[data-folder-item] > div[draggable]', '画布夹甲', '画布夹乙', 'after')
  if (dragResult?.error) {
    // 兜底：选择器命不中时退回按 data-folder-item 找
    const retry = await ev(`(() => {
      const els = Array.from(document.querySelectorAll('[data-folder-item]')).filter((el) => /^画布夹[甲乙]/.test((el.innerText || '').trim()));
      if (els.length < 2) return { error: 'insufficient', n: els.length };
      const from = els[0], to = els[1];
      const dt = new DataTransfer();
      const fire = (node, type, clientY) => {
        const r = node.getBoundingClientRect();
        node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width/2, clientY: clientY ?? (r.top + r.height/2) }));
      };
      fire(from, 'dragstart');
      const payload = dt.getData('text/plain');
      const r2 = to.getBoundingClientRect();
      fire(to, 'dragover', r2.top + r2.height * 0.75);
      fire(to, 'drop', r2.top + r2.height * 0.75);
      fire(from, 'dragend');
      return { ok: true, payload };
    })()`)
    if (retry?.error) throw new Error('画布文件夹拖放失败: ' + JSON.stringify(retry) + ' / ' + JSON.stringify(dragResult))
    if (!/^folder:/.test(String(retry.payload || ''))) {
      throw new Error('画布文件夹拖拽载荷没有前缀: ' + JSON.stringify(retry.payload))
    }
  } else if (!/^folder:/.test(String(dragResult.payload || ''))) {
    throw new Error('画布文件夹拖拽载荷没有前缀: ' + JSON.stringify(dragResult.payload))
  }

  await sleep(2000)
  const after = await canvasFolderOrder()
  if (after.join(',') !== '画布夹乙,画布夹甲') {
    throw new Error(`画布文件夹顺序没变: ${JSON.stringify(before)} → ${JSON.stringify(after)}`)
  }
  return `${JSON.stringify(before)} → ${JSON.stringify(after)}`
})

await step('画布文件夹顺序落库：刷新后仍是新顺序', async () => {
  const canvasPath = await ev('location.pathname')
  await send('Page.navigate', { url: `${BASE}${canvasPath}` })
  await waitFor(`!!document.querySelector('[data-canvas-container]')`, 25000, '画布重新加载')
  await sleep(2000)
  const after = await ev(`(() => {
    const out = [];
    document.querySelectorAll('[data-folder-item]').forEach((el) => {
      const t = (el.innerText || '').split('\\n')[0].trim();
      if (!/^画布夹[甲乙]/.test(t)) return;
      out.push({ name: t, top: Math.round(el.getBoundingClientRect().top) });
    });
    return out.sort((a, b) => a.top - b.top).map((f) => f.name);
  })()`)
  if (after.join(',') !== '画布夹乙,画布夹甲') {
    throw new Error('刷新后画布文件夹顺序变了: ' + JSON.stringify(after))
  }
  return JSON.stringify(after)
})

const failed = results.filter((r) => !r.ok)
console.log('\n=== 汇总 ===')
console.log(`通过 ${results.length - failed.length}/${results.length}`)
for (const f of failed) console.log('  未通过:', f.name, '—', f.detail)
fs.writeFileSync(path.join(TMP, 'drag-results.json'), JSON.stringify(results, null, 2))
console.log('截图与结果目录:', TMP)
ws.close()
process.exit(failed.length === 0 ? 0 : 1)
