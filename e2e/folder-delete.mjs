/**
 * 「删除文件夹」专项实操：真浏览器 + 真服务，逐条把这件操作的后果走一遍。
 *
 * 覆盖：
 *   1. 空文件夹          → 弹框写「这个文件夹是空的」，取消就不动
 *   2. 有子文件夹+手稿   → 弹框写清「N 个子文件夹一起删 / M 篇手稿退回未归档」，取消不动
 *   3. 确认删除          → 整棵子树消失、旁系不动、手稿进「未归档」、选中回落到全部
 *   4. 退回未归档的手稿  → 能打开、正文原样（内容不陪葬）
 *   5. 单层文件夹        → 手稿同样退回未归档
 *   6. 刷新页面          → 树与列表跟服务端完全一致（没有幽灵目录）
 *   7. 删完立刻建同名文件夹 → 正常创建，旧子树不会回来
 *
 * 数据全部用接口按固定结构种下（每次跑一个新账号），断言只看 UI 表现。
 * 前置：服务已起并托管构建好的前端（默认 127.0.0.1:8000）+ headless Edge 带 CDP（默认 9223）。
 *
 * 用法：node e2e/folder-delete.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import WebSocket from '../node_modules/ws/index.js'

const CDP = process.env.E2E_CDP || 'http://127.0.0.1:9223'
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8000'
const PASSWORD = 'E2ePassw0rd!'
const EMAIL = `folder+${Date.now()}@mindmap.local`
const TMP = process.env.E2E_OUT || path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp')

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
fs.mkdirSync(TMP, { recursive: true })

// ---------------------------------------------------------------- 接口播种
async function seed() {
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, nickname: '删文件夹测试' }),
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

  const folder = async (name, parentId = null) => {
    const res = await fetch(`${BASE}/api/manuscript-folders`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name, parentId }),
    })
    const body = await res.json()
    if (!body.success) throw new Error(`建文件夹「${name}」失败: ${JSON.stringify(body)}`)
    return body.data.id
  }
  const manuscript = async (title, contentHtml, folderId) => {
    const res = await fetch(`${BASE}/api/manuscripts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title, contentHtml, folderId }),
    })
    const body = await res.json()
    if (!body.success) throw new Error(`建手稿「${title}」失败: ${JSON.stringify(body)}`)
    return body.data.id
  }

  await folder('空箱')
  const parent = await folder('父级')
  const child = await folder('子级', parent)
  const grand = await folder('孙级', child)
  const single = await folder('单层')
  await folder('旁系')
  const opened = await folder('打开着')

  await manuscript('深层手稿', '<p>深层正文还在</p>', grand)
  await manuscript('单层手稿', '<p>单层正文还在</p>', single)
  await manuscript('打开中的手稿', '<p>打开时删它的文件夹</p>', opened)

  // 节点池侧的种子：空文件夹 + 一个带子文件夹和卡片的
  const poolFolder = async (name, parentId = null) => {
    const res = await fetch(`${BASE}/api/users/node-pool-folders`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name, parentId }),
    })
    const body = await res.json()
    if (!body.success) throw new Error(`建池文件夹「${name}」失败: ${JSON.stringify(body)}`)
    return body.data.id
  }
  await poolFolder('空池箱')
  const poolParent = await poolFolder('池父级')
  const poolChild = await poolFolder('池子级', poolParent)
  const cardRes = await fetch(`${BASE}/api/users/node-pool`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: '池卡片', content: '<p>卡片内容还在</p>', folderId: poolChild }),
  })
  const cardBody = await cardRes.json()
  if (!cardBody.success) throw new Error('建池卡片失败: ' + JSON.stringify(cardBody))

  return { token }
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

const waitFor = async (expr, timeout = 15000, label = expr) => {
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
  fs.writeFileSync(path.join(TMP, `folder-${name}.png`), Buffer.from(data, 'base64'))
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

/** 点某个文件夹的删除按钮，返回本次弹框原文（accept 决定确认还是取消） */
const deleteFolder = async (name, accept) => {
  dialogs.length = 0
  dialogAction = { accept }
  const clicked = await ev(`(() => {
    const rows = Array.from(document.querySelectorAll('aside [data-folder-row]'));
    const row = rows.find((r) => r.title === ${JSON.stringify(name)});
    if (!row) return 'no-row';
    const btn = row.querySelector('[aria-label="删除文件夹 ${name}"]');
    if (!btn) return 'no-button';
    btn.click();
    return 'clicked';
  })()`)
  if (clicked !== 'clicked') throw new Error(`点不到「${name}」的删除按钮: ${clicked}`)
  await sleep(1200)
  if (dialogs.length === 0) throw new Error(`点删除「${name}」没有弹确认框`)
  return dialogs[dialogs.length - 1].message
}

const uiFolders = () =>
  ev(`Array.from(document.querySelectorAll('aside [data-folder-row]'))
        .filter((r) => /^\\d+$/.test(r.getAttribute('data-folder-row')))
        .map((r) => r.title)`)

const shortcutCount = (which) =>
  ev(`(() => {
    const row = document.querySelector('aside [data-folder-row="${which}"]');
    if (!row) return null;
    const m = row.innerText.replace(/\\s+/g, ' ').trim().match(/(\\d+)\\s*$/);
    return m ? Number(m[1]) : 0;
  })()`)

const activeRow = () =>
  ev(`(() => {
    const row = Array.from(document.querySelectorAll('aside [data-folder-row]'))
      .find((r) => String(r.className).includes('bg-blue-50'));
    return row ? row.getAttribute('data-folder-row') : null;
  })()`)

const openManuscript = (title) =>
  ev(`(() => {
    const target = Array.from(document.querySelectorAll('aside *'))
      .find((el) => el.children.length === 0 && (el.textContent || '').trim() === ${JSON.stringify(title)});
    if (!target) return false;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  })()`)

/** 节点池：「在面板里对某个文件夹点右键 → 删除」，返回弹框原文 */
const deletePoolFolder = async (name, accept) => {
  dialogs.length = 0
  dialogAction = { accept }
  const point = await ev(`(() => {
    const panel = document.querySelector('[data-node-pool="true"]');
    if (!panel) return { error: 'no-panel' };
    const node = Array.from(panel.querySelectorAll('*'))
      .find((el) => el.children.length === 0 && (el.textContent || '').trim() === ${JSON.stringify(name)});
    if (!node) return { error: 'no-row' };
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`)
  if (point.error) throw new Error(`节点池里找不到「${name}」: ${point.error}`)
  if (point.x <= 0 || point.y <= 0 || point.x >= 1440 || point.y >= 900) {
    throw new Error(`「${name}」不在视口里（点=(${point.x},${point.y})），面板可能还是收起状态`)
  }

  const under = await ev(`(() => {
    const el = document.elementFromPoint(${point.x}, ${point.y});
    return el ? { tag: el.tagName, cls: String(el.className).slice(0, 60), text: (el.textContent || '').trim().slice(0, 20) } : null;
  })()`)

  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'right', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'right', clickCount: 1 })
  await sleep(700)

  const clicked = await ev(`(() => {
    const item = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '删除');
    if (!item) return 'no-item';
    item.click();
    return 'clicked';
  })()`)
  if (clicked !== 'clicked') {
    const menuTexts = await ev(`Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || '').trim()).filter(Boolean).slice(0, 20)`)
    throw new Error(
      `右键菜单里没有「删除」（点=(${point.x},${point.y}) 命中=${JSON.stringify(under)}）: ${JSON.stringify(menuTexts)}`,
    )
  }
  await sleep(1200)
  if (dialogs.length === 0) throw new Error(`节点池删除「${name}」没有弹确认框`)
  const message = dialogs[dialogs.length - 1].message
  // 弹框必须说的是这个文件夹：菜单残留时很容易点到上一次的项
  if (!message.includes(`「${name}」`)) {
    throw new Error(`弹框说的不是「${name}」: ${message}`)
  }
  return message
}

const poolFolders = () =>
  ev(`(async () => {
    const res = await fetch('/api/users/node-pool-folders', {
      headers: { authorization: 'Bearer ' + localStorage.getItem('mindmap_token') },
    });
    const body = await res.json();
    return (body.data || []).map((f) => f.name).sort();
  })()`)

const poolCards = () =>
  ev(`(async () => {
    const res = await fetch('/api/users/node-pool', {
      headers: { authorization: 'Bearer ' + localStorage.getItem('mindmap_token') },
    });
    const body = await res.json();
    return (body.data || []).map((c) => ({ name: c.name, folderId: c.folderId }));
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
await waitFor(`document.body.innerText.includes('空箱')`, 20000, '笔记本与种子文件夹')
await shot('seeded')

await step('空文件夹：弹框说明它是空的，取消后原样保留', async () => {
  const message = await deleteFolder('空箱', false)
  if (!message.includes('这个文件夹是空的')) throw new Error('弹框文案不对: ' + message)
  if (!(await uiFolders()).includes('空箱')) throw new Error('点了取消却把文件夹删了')
  return message
})

await step('有子文件夹与手稿：弹框给出准确数字，取消后一点都不动', async () => {
  const before = await uiFolders()
  const message = await deleteFolder('父级', false)
  if (!message.includes('2 个子文件夹会一起删除')) throw new Error('子文件夹数量没写对: ' + message)
  if (!message.includes('1 篇手稿会退回「未归档」')) throw new Error('手稿数量没写对: ' + message)
  const after = await uiFolders()
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(`取消后树变了: ${JSON.stringify(before)} → ${JSON.stringify(after)}`)
  }
  return message
})

await step('确认删除：整棵子树消失、旁系不动、手稿进未归档、选中回落到全部', async () => {
  // 先选中孙级，验证"选中项落在被删子树里"时的回落
  await ev(`(() => {
    const rows = Array.from(document.querySelectorAll('aside [data-folder-row]'));
    rows.find((r) => r.title === '孙级').click();
    return true;
  })()`)
  await sleep(600)

  const message = await deleteFolder('父级', true)
  await sleep(1500)
  const folders = await uiFolders()
  for (const gone of ['父级', '子级', '孙级']) {
    if (folders.includes(gone)) throw new Error(`「${gone}」没被删掉: ${JSON.stringify(folders)}`)
  }
  if (!folders.includes('旁系')) throw new Error('旁系文件夹被误删: ' + JSON.stringify(folders))
  if (!folders.includes('单层')) throw new Error('兄弟文件夹被误删: ' + JSON.stringify(folders))

  const unfiled = await shortcutCount('unfiled')
  if (unfiled !== 1) throw new Error('手稿没有退回未归档，未归档计数=' + unfiled)

  const active = await activeRow()
  if (active !== 'all') throw new Error('选中项没有回落到全部手稿，当前选中=' + active)

  return `${message}｜剩余=${JSON.stringify(folders)}`
})
await shot('after-cascade')

await step('退回未归档的手稿能打开，正文原样', async () => {
  if (!(await openManuscript('深层手稿'))) throw new Error('列表里找不到「深层手稿」')
  await waitFor(`!!document.querySelector('[data-testid="manuscript-editor"]')`, 10000, '编辑器')
  await sleep(900)
  const content = await ev(`document.querySelector('[data-testid="manuscript-editor"]').innerText`)
  if (!content.includes('深层正文还在')) throw new Error('正文丢了: ' + content.slice(0, 120))
  return content.trim().slice(0, 20)
})
await shot('unfiled-manuscript')

await step('单层文件夹：删掉后手稿同样退回未归档', async () => {
  const message = await deleteFolder('单层', true)
  await sleep(1500)
  const folders = await uiFolders()
  if (folders.includes('单层')) throw new Error('「单层」没被删掉')
  const unfiled = await shortcutCount('unfiled')
  if (unfiled !== 2) throw new Error('未归档数量应为 2，实际=' + unfiled)
  if (!message.includes('1 篇手稿会退回「未归档」')) throw new Error('弹框没提手稿: ' + message)
  if (message.includes('子文件夹')) throw new Error('没有子文件夹却提了子文件夹: ' + message)
  return message
})

await step('刷新页面：树与列表跟服务端完全一致，没有幽灵目录', async () => {
  await send('Page.navigate', { url: `${BASE}/notebook` })
  await waitFor(`document.body.innerText.includes('旁系')`, 20000, '刷新后的文件夹')
  const ui = (await uiFolders()).slice().sort()
  const apiRes = await fetch(`${BASE}/api/manuscript-folders`, {
    headers: { authorization: `Bearer ${seeded.token}` },
  })
  const apiNames = (await apiRes.json()).data.map((f) => f.name).sort()
  if (JSON.stringify(ui) !== JSON.stringify(apiNames)) {
    throw new Error(`界面 ${JSON.stringify(ui)} ≠ 服务端 ${JSON.stringify(apiNames)}`)
  }
  const unfiled = await shortcutCount('unfiled')
  if (unfiled !== 2) throw new Error('刷新后未归档数量不对=' + unfiled)
  return JSON.stringify(ui)
})
await shot('after-reload')

await step('删完立刻建同名文件夹：正常创建，旧子树不会回来', async () => {
  dialogs.length = 0
  dialogAction = { accept: true, promptText: '父级' }
  await ev(`document.querySelector('aside [aria-label="新建文件夹"]').click()`)
  await sleep(1500)
  const folders = await uiFolders()
  if (!folders.includes('父级')) throw new Error('同名文件夹没建出来: ' + JSON.stringify(folders))
  if (folders.includes('子级') || folders.includes('孙级')) {
    throw new Error('旧子树跟着回来了: ' + JSON.stringify(folders))
  }
  // 新建的「父级」应该是叶子（没有展开箭头指向的子行）
  const childRows = await ev(`(() => {
    const rows = Array.from(document.querySelectorAll('aside [data-folder-row]'));
    const row = rows.find((r) => r.title === '父级');
    return row ? Number(row.getAttribute('data-depth')) : -1;
  })()`)
  if (childRows !== 0) throw new Error('同名文件夹的层级不对: depth=' + childRows)
  return JSON.stringify(folders)
})
await shot('recreated')

await step('正在编辑的手稿，删掉它所在的文件夹：编辑不中断、手稿进未归档', async () => {
  if (!(await openManuscript('打开中的手稿'))) throw new Error('列表里找不到「打开中的手稿」')
  await waitFor(`!!document.querySelector('[data-testid="manuscript-editor"]')`, 10000, '编辑器')
  await sleep(900)

  const message = await deleteFolder('打开着', true)
  await sleep(1800)

  const folders = await uiFolders()
  if (folders.includes('打开着')) throw new Error('「打开着」没被删掉')
  const content = await ev(`document.querySelector('[data-testid="manuscript-editor"]').innerText`)
  if (!content.includes('打开时删它的文件夹')) throw new Error('正在编辑的正文被清掉了: ' + content.slice(0, 120))
  const unfiled = await shortcutCount('unfiled')
  if (unfiled !== 3) throw new Error('这篇手稿没有进未归档，未归档计数=' + unfiled)
  if (await ev(`location.pathname.startsWith('/notebook/')`) !== true) {
    throw new Error('删文件夹把当前手稿页面也跳走了: ' + (await ev('location.pathname')))
  }
  return message
})
await shot('deleted-while-open')

// ---------------------------------------------------------------- 节点池侧
await step('节点池：空文件夹删除也要问（以前没有卡片就直接删）', async () => {
  await send('Page.navigate', { url: `${BASE}/projects` })
  await waitFor(`!!document.querySelector('button[title^="切换节点池"]')`, 20000, '项目页顶栏')
  await sleep(800)
  await ev(`document.querySelector('button[title^="切换节点池"]').click()`)
  // 面板一直挂载，靠 transform 滑出/滑入：要等它真的在视口里
  await waitFor(
    `(() => {
      const p = document.querySelector('[data-node-pool="true"]');
      if (!p) return false;
      const r = p.getBoundingClientRect();
      return r.width > 100 && r.x < window.innerWidth - 100;
    })()`,
    10000,
    '节点池面板滑入',
  )
  await sleep(600)

  const message = await deletePoolFolder('空池箱', false)
  if (!message.includes('这个文件夹是空的')) throw new Error('空文件夹的弹框文案不对: ' + message)
  const folders = await poolFolders()
  if (!folders.includes('空池箱')) throw new Error('点了取消却把池文件夹删了: ' + JSON.stringify(folders))
  return message
})

await step('节点池：有子文件夹与卡片时，文案说卡片只是退回未归档', async () => {
  const message = await deletePoolFolder('池父级', false)
  if (!message.includes('1 个子文件夹会一起删除')) throw new Error('子文件夹数量没写对: ' + message)
  if (!message.includes('1 个节点卡片会退回「未归档」（不会删除）')) throw new Error('卡片说法不对: ' + message)
  if (message.includes('将被删除')) throw new Error('还在说卡片会被删: ' + message)
  return message
})

await step('节点池：确认删除后子树消失、卡片退回未归档且内容还在', async () => {
  const message = await deletePoolFolder('池父级', true)
  await sleep(1800)

  const folders = await poolFolders()
  if (folders.includes('池父级') || folders.includes('池子级')) {
    throw new Error('池子树没删干净: ' + JSON.stringify(folders))
  }
  const cards = await poolCards()
  const card = cards.find((c) => c.name === '池卡片')
  if (!card) throw new Error('卡片被一起删了（应该退回未归档）: ' + JSON.stringify(cards))
  if (card.folderId !== null) throw new Error('卡片没有退回未归档，folderId=' + card.folderId)
  if (!(await ev(`document.querySelector('[data-node-pool="true"]').innerText.includes('池卡片')`))) {
    throw new Error('卡片没出现在界面上（本地状态没重新对齐）')
  }
  return message
})
await shot('pool-after-delete')

const failed = results.filter((r) => !r.ok)
console.log('\n=== 汇总 ===')
console.log(`通过 ${results.length - failed.length}/${results.length}`)
for (const f of failed) console.log('  未通过:', f.name, '—', f.detail)
fs.writeFileSync(path.join(TMP, 'folder-delete-results.json'), JSON.stringify(results, null, 2))
console.log('截图与结果目录:', TMP)
ws.close()
process.exit(failed.length === 0 ? 0 : 1)
