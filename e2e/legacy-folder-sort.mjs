/**
 * 本轮新增的写库路径在"旧库"上也要能跑。
 *
 * 本轮没有加新列（manuscript_folders.sort_order / folders.sort_order 早就存在），
 * 但这两个 PUT 路由是本轮才开始真的接收 sortOrder 的——老库里这两个字段
 * 全是 0，写进去必须生效，而且不能影响已有数据。
 *
 * 用法：起一个指向旧库副本的服务（PORT=8123），再跑本脚本。
 */
const BASE = process.env.LEGACY_BASE || 'http://127.0.0.1:8123'
const SECRET = process.env.LEGACY_JWT_SECRET || 'legacy-test-secret-0123456789abcdef'

const { default: jwt } = await import('../node_modules/jsonwebtoken/index.js')
const token = jwt.sign({ userId: 1 }, SECRET, { expiresIn: '1h' })
const H = { authorization: `Bearer ${token}` }

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const csrfRes = await fetch(`${BASE}/api/csrf-token`, { headers: H })
const csrf = await csrfRes.json()
const cookie = (csrfRes.headers.get('set-cookie') || '').split(';')[0]
const W = { ...H, 'content-type': 'application/json', 'x-csrf-token': csrf.token, cookie }
const put = (p, body) => fetch(`${BASE}${p}`, { method: 'PUT', headers: W, body: JSON.stringify(body) })
const post = (p, body) => fetch(`${BASE}${p}`, { method: 'POST', headers: W, body: JSON.stringify(body) })

// ---- 手稿文件夹：旧库上新建两个、拉开顺序 ----
const fa = await (await post('/api/manuscript-folders', { name: '旧库夹甲' })).json()
const fb = await (await post('/api/manuscript-folders', { name: '旧库夹乙' })).json()
record('旧库能新建手稿文件夹', fa.success === true && fb.success === true, `ids=${fa.data?.id},${fb.data?.id}`)

const faPut = await put(`/api/manuscript-folders/${fa.data.id}`, { sortOrder: 200 })
const fbPut = await put(`/api/manuscript-folders/${fb.data.id}`, { sortOrder: 100 })
record('旧库上手稿文件夹 sortOrder 可写', faPut.status === 200 && fbPut.status === 200)

const folderList = await (await fetch(`${BASE}/api/manuscript-folders`, { headers: H })).json()
const mineFolders = (folderList.data || []).filter((f) => f.id === fa.data.id || f.id === fb.data.id)
record(
  '旧库上手稿文件夹按 sortOrder 返回（乙在甲前）',
  mineFolders.map((f) => f.id).join(',') === `${fb.data.id},${fa.data.id}`,
  `实际=${JSON.stringify(mineFolders.map((f) => ({ id: f.id, sortOrder: f.sortOrder })))}`,
)

// ---- 非数字 sortOrder 必须被拒，且不改原值 ----
const badPut = await put(`/api/manuscript-folders/${fa.data.id}`, { sortOrder: 'abc' })
const afterBad = await (await fetch(`${BASE}/api/manuscript-folders`, { headers: H })).json()
const faNow = (afterBad.data || []).find((f) => f.id === fa.data.id)
record(
  '旧库上非数字 sortOrder 被拒且原值不变',
  badPut.status === 400 && faNow?.sortOrder === 200,
  `status=${badPut.status} sortOrder=${faNow?.sortOrder}`,
)

// ---- 画布文件夹：同样验证 ----
const projects = await (await fetch(`${BASE}/api/projects`, { headers: H })).json()
const projectId = projects.data?.[0]?.id
if (!projectId) {
  record('旧库里有项目可用于画布文件夹验证', false, '没有项目')
} else {
  const ca = await (await post(`/api/canvases/${projectId}/folders`, { name: '旧库画布夹甲' })).json()
  const cb = await (await post(`/api/canvases/${projectId}/folders`, { name: '旧库画布夹乙' })).json()
  record('旧库能新建画布文件夹', ca.success === true && cb.success === true, `ids=${ca.data?.id},${cb.data?.id}`)

  const caPut = await put(`/api/canvases/folders/${ca.data.id}`, { sortOrder: 200 })
  const cbPut = await put(`/api/canvases/folders/${cb.data.id}`, { sortOrder: 100 })
  record('旧库上画布文件夹 sortOrder 可写', caPut.status === 200 && cbPut.status === 200)

  const canvasFolderList = await (await fetch(`${BASE}/api/canvases/${projectId}/folders`, { headers: H })).json()
  const mineCanvasFolders = (canvasFolderList.data || []).filter(
    (f) => f.id === ca.data.id || f.id === cb.data.id,
  )
  record(
    '旧库上画布文件夹按 sortOrder 返回（乙在甲前）',
    mineCanvasFolders.map((f) => f.id).join(',') === `${cb.data.id},${ca.data.id}`,
    `实际=${JSON.stringify(mineCanvasFolders.map((f) => ({ id: f.id, sortOrder: f.sortOrder })))}`,
  )
}

// ---- 老数据没被动过 ----
const manuscripts = await (await fetch(`${BASE}/api/manuscripts`, { headers: H })).json()
record('旧库手稿数量没被这轮改动影响', manuscripts.data.length >= 43, `count=${manuscripts.data.length}`)

const failed = results.filter((r) => !r.ok)
console.log('\n=== 汇总 ===')
console.log(`通过 ${results.length - failed.length}/${results.length}`)
for (const f of failed) console.log('  未通过:', f.name, '—', f.detail)
process.exit(failed.length === 0 ? 0 : 1)
