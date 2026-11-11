/**
 * 真实浏览器冒烟 E2E：headless Edge（CDP）+ 正在运行的本机服务。
 *
 * 覆盖本轮重构的关键用户路径：
 *   登录 → 落在笔记本 → 新建手稿 → 输入自动保存 → 送入节点池 →
 *   进画布建节点 → 双击正文粘贴图片 → 失焦提交 → 换设备（清缓存）重进验证持久化 →
 *   回笔记本从节点池还原成手稿
 *
 * 前置条件：
 *   1) 后端已启动，且把构建好的前端一起托管（默认 http://127.0.0.1:3010）
 *   2) headless Edge 带 CDP 启动：
 *        msedge --headless=new --remote-debugging-port=9222 --user-data-dir=<临时目录> about:blank
 *   3) 已存在测试账号（默认 e2e@test.local / E2ePassw0rd!），可用环境变量覆盖
 *
 * 用法：
 *   node e2e/ui-smoke.mjs
 *   E2E_BASE=http://127.0.0.1:3010 E2E_EMAIL=who@x E2E_PASSWORD=... node e2e/ui-smoke.mjs
 *
 * 说明：不要去掉 Emulation.setDeviceMetricsOverride —— headless 默认视口 500×320，
 * 布局会塌陷，坐标点击全部错位（踩过）。
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import WebSocket from '../node_modules/ws/index.js'

const CDP = process.env.E2E_CDP || 'http://127.0.0.1:9222'
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3010'
const EMAIL = process.env.E2E_EMAIL || 'e2e@test.local'
const PASSWORD = process.env.E2E_PASSWORD || 'E2ePassw0rd!'
const TMP = process.env.E2E_OUT || path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp')
// 1×1 PNG：够验证“上传成功 + 能渲染”，且不依赖外部素材
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
fs.mkdirSync(TMP, { recursive: true })

const list = await (await fetch(`${CDP}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) throw new Error('没有可用的 CDP page target（Edge 是否以 --remote-debugging-port 启动？）')
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
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const i = ++id
  pending.set(i, { resolve, reject })
  ws.send(JSON.stringify({ id: i, method, params }))
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error('timeout ' + method)) } }, 30000)
})
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ''}`)
  return r.result?.value
}
const waitFor = async (expr, timeout = 20000, label = expr) => {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try { if (await ev(expr)) return true } catch { /* 页面切换中 */ }
    await sleep(250)
  }
  throw new Error('等待超时: ' + label)
}
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(TMP, `shot-${name}.png`), Buffer.from(data, 'base64'))
}
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false })

// ---------- 1. 登录 ----------
await send('Page.navigate', { url: `${BASE}/login` })
await sleep(3000)
record('视口 1280×800（headless 默认 500×320 会让布局塌陷）', (await ev('window.innerWidth')) === 1280, '')

if (await ev(`location.pathname === '/login'`)) {
  await waitFor('!!document.querySelector("input")', 10000, '登录表单')
  await ev(`
    (() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const setVal = (el, v) => { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) };
      setVal(inputs[0], ${JSON.stringify(EMAIL)});
      setVal(inputs[1], ${JSON.stringify(PASSWORD)});
      return inputs.length;
    })()
  `)
  await ev(`Array.from(document.querySelectorAll('button')).find(b => /登录/.test(b.textContent)).click()`)
  await waitFor('location.pathname.startsWith("/notebook")', 15000, '登录后进入 /notebook')
}
record('登录后落在笔记本主页', await ev('location.pathname.startsWith("/notebook")'), await ev('location.pathname'))

// ---------- 2. 新建手稿并输入 ----------
await waitFor('/新建手稿/.test(document.body.innerText)', 10000, '新建手稿按钮')
await ev(`Array.from(document.querySelectorAll('button')).find(b => /新建手稿/.test(b.textContent)).click()`)
await sleep(1500)
record('新建手稿并进入编辑页', await ev('location.pathname.startsWith("/notebook/")'), await ev('location.pathname'))

await ev(`
  (() => {
    const input = document.querySelector('input[placeholder="手稿标题"]');
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    s.call(input, 'E2E 手稿标题');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const editor = document.querySelector('[data-testid="manuscript-editor"]');
    editor.focus();
    document.execCommand('insertText', false, '第一段：模拟用户输入。');
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()
`)
await sleep(2500)
record('输入后自动保存', await ev(`/已保存/.test(document.body.innerText)`), '')

// ---------- 3. 送入节点池 ----------
await ev(`Array.from(document.querySelectorAll('button')).find(b => /送入节点池/.test(b.textContent)).click()`)
await sleep(2000)
record('「送入节点池」成功', await ev(`/已送入节点池/.test(document.body.innerText)`), '')

// ---------- 4. 画布建节点 ----------
// 画布 id 取自 URL；测试前用 API 建好一个画布，这里固定用 1（脚本末尾会打印提示）
const CANVAS_ID = process.env.E2E_CANVAS_ID || '1'
await send('Page.navigate', { url: `${BASE}/canvas/${CANVAS_ID}` })
await sleep(5000)
const toolRect = await ev(`(() => { const b = Array.from(document.querySelectorAll('button')).find(x => (x.title||'').startsWith('节点 (N)')); const r = b.getBoundingClientRect(); return [Math.round(r.x+r.width/2), Math.round(r.y+r.height/2)] })()`)
await click(toolRect[0], toolRect[1])
await sleep(500)
await click(950, 300)
await sleep(1500)
const nodeCount = await ev(`document.querySelectorAll('.node-item').length`)
record('选中「节点」工具并在画布点击 → 创建节点', nodeCount > 0, `节点数=${nodeCount}`)

// ---------- 5. 双击正文 → 粘贴图片 ----------
await ev(`(() => { const ns = Array.from(document.querySelectorAll('.node-item')); ns[ns.length-1].querySelector('[data-field="content"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); return true })()`)
await sleep(800)
const pasteResult = await ev(`
  (() => {
    const ed = document.querySelector('[contenteditable="true"]');
    if (!ed) return 'no-editor';
    ed.focus();
    const bin = atob(${JSON.stringify(PNG)});
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'e2e.png', { type: 'image/png' }));
    ed.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    return 'pasted';
  })()
`)
await sleep(5000)
const imgs = await ev(`(() => { const ns = Array.from(document.querySelectorAll('.node-item')); const n = ns[ns.length-1]; return Array.from(n.querySelectorAll('img')).filter(i => (i.getAttribute('src')||'').includes('/api/files/')).map(i => ({ src: i.getAttribute('src').slice(0,44), loaded: i.complete && i.naturalWidth > 0 })) })()`)
record('粘贴图片 → 正文出现 /api/files 图片且加载成功', imgs.length > 0 && imgs.every((i) => i.loaded), `paste=${pasteResult} ${JSON.stringify(imgs).slice(0,180)}`)
await shot('canvas-image')

// ---------- 6. 失焦提交 + 换设备重进验证持久化 ----------
await click(640, 24) // 点页头空白处失焦（画布内点击会新建节点）
await sleep(8000)
await send('Page.navigate', { url: `${BASE}/notebook` })
await sleep(2500)
await ev(`Object.keys(localStorage).filter(k => k.includes('canvas_cache')).forEach(k => localStorage.removeItem(k))`)
await send('Page.navigate', { url: `${BASE}/canvas/${CANVAS_ID}` })
await sleep(9000)
const afterReload = await ev(`Array.from(document.querySelectorAll('img')).filter(i => (i.getAttribute('src')||'').includes('/api/files/')).map(i => ({ src: i.getAttribute('src').slice(0,44), loaded: i.complete && i.naturalWidth > 0 }))`)
record('换设备（清缓存）重进，图片仍在（服务端持久化）', afterReload.length > 0 && afterReload.every((i) => i.loaded), JSON.stringify(afterReload).slice(0,180))
await shot('canvas-reload')

// ---------- 7. 笔记本：从节点池还原 ----------
await send('Page.navigate', { url: `${BASE}/notebook` })
await sleep(4000)
const beforeCount = await ev(`document.querySelectorAll('aside button').length`)
await ev(`Array.from(document.querySelectorAll('button')).find(b => /从节点池导入/.test(b.textContent)).click()`)
await sleep(800)
const menuHasCard = await ev(`/E2E 手稿标题/.test(document.body.innerText)`)
await ev(`
  (() => {
    const items = Array.from(document.querySelectorAll('div[class*="absolute"] button')).filter(b => /E2E 手稿标题/.test(b.textContent));
    if (!items.length) return false;
    items[0].click();
    return true;
  })()
`)
await sleep(3500)
const afterCount = await ev(`document.querySelectorAll('aside button').length`)
record('从节点池还原成手稿并打开', menuHasCard && (await ev('location.pathname.startsWith("/notebook/")')) && afterCount >= beforeCount, `菜单=${menuHasCard} 列表 ${beforeCount}→${afterCount}`)
await shot('notebook-restored')

console.log('\n=== 汇总 ===')
const failed = results.filter((r) => !r.ok)
console.log(`通过 ${results.length - failed.length}/${results.length}`)
for (const f of failed) console.log('  未通过:', f.name, '—', f.detail)
fs.writeFileSync(path.join(TMP, 'results.json'), JSON.stringify(results, null, 2))
console.log('截图与结果目录:', TMP)
process.exit(failed.length === 0 ? 0 : 1)
