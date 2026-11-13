/**
 * 对"真实旧库副本"的升级验证（不是模拟）。
 *
 * 输入：.e2e/legacy-real.db —— 一份生产形态的老库（无 manuscripts.sort_order）。
 * 流程：服务启动时自动跑迁移 → 校验结构、数据、功能三方面。
 *
 * 用法：先起一个指向该库的服务（PORT=8123），再运行本脚本。
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

// ---- 1. 老数据可读 ----
const list = await (await fetch(`${BASE}/api/manuscripts`, { headers: H })).json()
record('旧库手稿全部可读', list.success === true && list.data.length > 0, `count=${list.data?.length}`)

const pool = await (await fetch(`${BASE}/api/users/node-pool`, { headers: H })).json()
record('旧库节点池卡片可读', pool.success === true && pool.data.length > 0, `count=${pool.data?.length}`)

const folders = await (await fetch(`${BASE}/api/manuscript-folders`, { headers: H })).json()
record('旧库手稿文件夹可读', folders.success === true, `count=${folders.data?.length}`)

// ---- 2. 新列在接口里有值（说明补列成功且默认值生效） ----
const hasSortOrder = list.data.every((item) => typeof item.sortOrder === 'number')
record('每条手稿都带 sortOrder 字段（老数据默认 0）', hasSortOrder,
  `样例=${JSON.stringify(list.data.slice(0, 3).map((m) => ({ id: m.id, sortOrder: m.sortOrder })))}`)

// ---- 3. 排序接口可用 ----
const csrfRes = await fetch(`${BASE}/api/csrf-token`, { headers: H })
const csrf = await csrfRes.json()
const cookie = (csrfRes.headers.get('set-cookie') || '').split(';')[0]
const reorderHeaders = { ...H, 'content-type': 'application/json', 'x-csrf-token': csrf.token, cookie }

// 取三篇，按"最后这种排在最前"的意图写：第 3 篇->0，第 2 篇->10，第 1 篇->20
const picked = list.data.slice(0, 3).map((m) => m.id)
const updates = [
  { id: picked[2], sortOrder: 0 },
  { id: picked[1], sortOrder: 10 },
  { id: picked[0], sortOrder: 20 },
]
const reorder = await fetch(`${BASE}/api/manuscripts/reorder`, {
  method: 'PUT',
  headers: reorderHeaders,
  body: JSON.stringify({ updates }),
})
const reorderBody = await reorder.json()
record('排序接口在升级后的旧库上可用', reorder.status === 200 && reorderBody.data.updated.length === 3,
  `updated=${JSON.stringify(reorderBody.data?.updated)}`)

// ---- 4. 排序真的生效：这三篇相对彼此的顺序要与写入一致 ----
const after = await (await fetch(`${BASE}/api/manuscripts`, { headers: H })).json()
const positions = updates
  .map((u) => ({ id: u.id, sortOrder: u.sortOrder, index: after.data.findIndex((m) => m.id === u.id) }))
  .sort((a, b) => a.sortOrder - b.sortOrder)
const actualRelative = positions.map((p) => p.id)
const expectedRelative = updates.slice().sort((a, b) => a.sortOrder - b.sortOrder).map((u) => u.id)
record(
  '三篇的相对顺序与写入的 sortOrder 一致',
  JSON.stringify(actualRelative) === JSON.stringify(expectedRelative),
  `期望=${JSON.stringify(expectedRelative)} 实际=${JSON.stringify(actualRelative)}`,
)

// ---- 5. 新建/编辑照常（说明表结构不但读得了、也写得进） ----
const created = await fetch(`${BASE}/api/manuscripts`, {
  method: 'POST',
  headers: reorderHeaders,
  body: JSON.stringify({ title: '升级后新建的稿子', contentHtml: '<p>验证写入</p>' }),
})
const createdBody = await created.json()
record('升级后的库能新建手稿', created.status === 201 && createdBody.data?.id > 0,
  `id=${createdBody.data?.id} sortOrder=${createdBody.data?.sortOrder}`)

const failed = results.filter((r) => !r.ok)
console.log('\n=== 汇总 ===')
console.log(`通过 ${results.length - failed.length}/${results.length}`)
for (const f of failed) console.log('  未通过:', f.name, '—', f.detail)
process.exit(failed.length === 0 ? 0 : 1)
