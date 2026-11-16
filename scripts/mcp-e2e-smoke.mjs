/**
 * End-to-end MCP smoke test against a REAL running server.
 *
 * This is deliberately not a unit test: it boots the actual HTTP server with an
 * isolated database, then drives the real `/mcp` endpoint over HTTP with a real
 * personal access token. It is the only check that proves the whole chain works —
 * PAT creation → middleware → rate limit → Streamable HTTP transport → tool →
 * domain layer → SQLite/Yjs → read back through REST — which unit tests with mocked
 * transports cannot establish.
 *
 * Run manually (it is NOT part of the vitest suite, which must stay hermetic):
 *   node scripts/mcp-e2e-smoke.mjs
 *
 * Exits non-zero on the first failed section (it keeps going to report more).
 */
import { spawn } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import Database from 'better-sqlite3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const backendDir = path.join(repoRoot, 'backend')

/** Ask the OS for a free TCP port (then release it). */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

// Deriving WS_PORT as HTTP_PORT + 1 is not safe: an unrelated process on this
// machine may already hold it (a browser bound to 3200 was enough), and the
// server treats the resulting EADDRINUSE as fatal. Ask for two real free ports.
const PORT = await freePort()
const WS_PORT = await freePort()
const BASE = `http://127.0.0.1:${PORT}`

let failures = 0
let checks = 0
function check(label, condition, detail = '') {
  checks++
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures++
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Minimal cookie jar: the CSRF flow needs the cookie echoed back. */
const jars = new Map()
function jarFor(name) {
  if (!jars.has(name)) jars.set(name, new Map())
  return jars.get(name)
}
function rememberCookies(jar, res) {
  const raw = res.headers.getSetCookie?.() ?? []
  for (const c of raw) {
    const [pair] = c.split(';')
    const idx = pair.indexOf('=')
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim())
  }
}
function cookieHeader(jar) {
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}

async function api(method, endpoint, { body, token, csrf, jar } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (jar && jar.size > 0) headers.Cookie = cookieHeader(jar)
  if (token) headers.Authorization = `Bearer ${token}`
  if (csrf) headers['x-csrf-token'] = csrf

  const res = await fetch(`${BASE}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (jar) rememberCookies(jar, res)
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* non-JSON (e.g. HTML) */
  }
  return { status: res.status, json, text }
}

/** POST a JSON-RPC message to /mcp. */
async function mcp(token, message, { headers = {}, raw } = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw ?? JSON.stringify(message),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* leave null */
  }
  return { status: res.status, json, text }
}

let rpcId = 100
/** Call a tool and parse its JSON payload. */
async function tool(token, name, args = {}) {
  const res = await mcp(token, {
    jsonrpc: '2.0',
    id: ++rpcId,
    method: 'tools/call',
    params: { name, arguments: args },
  })
  const text = res.json?.result?.content?.[0]?.text ?? ''
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    /* plain-text error */
  }
  return { status: res.status, isError: res.json?.result?.isError === true, text, parsed, json: res.json }
}

const tmp = mkdtempSync(path.join(tmpdir(), 'mindmap-mcp-e2e-'))
const dbFile = path.join(tmp, 'e2e.db')

/**
 * The audit trail goes to `backend/logs/debug.log` (the logger appends to a file, not
 * stdout), so remember where the file ended before booting and only inspect the newly
 * written bytes — otherwise a stale log from an earlier run could make the check pass.
 */
const logFile = path.join(backendDir, 'logs', 'debug.log')
let logOffset = 0
try {
  logOffset = statSync(logFile).size
} catch {
  logOffset = 0
}
function newLogLines() {
  try {
    return readFileSync(logFile, 'utf8').slice(logOffset)
  } catch {
    return ''
  }
}

console.log(`Booting server on :${PORT} with isolated DB...`)
await assertPortFree()
const server = spawn('node', ['dist/index.js'], {
  cwd: backendDir,
  env: {
    ...process.env,
    PORT: String(PORT),
    WS_PORT: String(WS_PORT),
    NODE_ENV: 'development',
    DB_FILE: dbFile,
    JWT_SECRET: 'e2e-jwt-secret-for-smoke-test-only',
    // Required by getValidatedEnv(): without it the server refuses to boot. The
    // script used to rely on backend/.env, so it failed outright on a clean clone.
    JWT_EXPIRES_IN: '1h',
    CSRF_SECRET: 'e2e-csrf-secret-for-smoke-test-only',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    APP_VERSION: 'e2e-test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let serverLog = ''
server.stdout.on('data', (d) => (serverLog += d.toString()))
server.stderr.on('data', (d) => (serverLog += d.toString()))

async function waitForHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`)
      if (res.ok) return await res.json()
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`server did not become healthy.\n--- server output ---\n${serverLog}`)
}

function cleanup() {
  try {
    server.kill('SIGKILL')
  } catch {
    /* already gone */
  }
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

/** Fail fast with the server's own output if the port is already taken. */
async function assertPortFree() {
  try {
    const res = await fetch(`${BASE}/health`)
    if (res.ok) {
      throw new Error(
        `port ${PORT} is already serving something (${BASE}/health responded). ` +
          `Another server is running — stop it or change PORT in this script.`,
      )
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('already serving')) throw error
    // Connection refused is the expected, healthy case.
  }
}

/** Register a user + mint a PAT; returns the credentials for that account. */
async function makeAccount(name) {
  const jar = jarFor(name)
  const email = `${name}-${Date.now()}@test.local`
  const reg = await api('POST', '/api/auth/register', {
    body: { email, password: 'testtest', nickname: name },
    jar,
  })
  const jwt = reg.json?.data?.token ?? reg.json?.token
  const csrf = (await api('GET', '/api/csrf-token', { jar })).json?.token
  const created = await api('POST', '/api/tokens', {
    body: { name: `${name} agent` },
    token: jwt,
    csrf,
    jar,
  })
  return { email, jwt, csrf, pat: created.json?.data?.token, jar, userId: reg.json?.data?.user?.id }
}

try {
  const health = await waitForHealth()
  console.log(`  server up: version=${health.version}`)
  check('health reports injected APP_VERSION', health.version === 'e2e-test', health.version)

  // ---------------------------------------------------------------- bootstrap
  console.log('\n[1] Bootstrap accounts / project / canvas')
  const alice = await makeAccount('alice')
  check('account + PAT created', typeof alice.pat === 'string' && alice.pat.startsWith('mmp_'))

  const proj = await api('POST', '/api/projects', {
    body: { name: 'E2E Project' },
    token: alice.jwt,
    csrf: alice.csrf,
    jar: alice.jar,
  })
  const projectId = proj.json?.data?.id
  const canvasRes = await api('POST', `/api/canvases/${projectId}`, {
    body: { name: 'E2E Canvas' },
    token: alice.jwt,
    csrf: alice.csrf,
    jar: alice.jar,
  })
  const canvasId = canvasRes.json?.data?.id
  check('project + canvas created', Number.isInteger(projectId) && Number.isInteger(canvasId), JSON.stringify(proj.json))

  const bob = await makeAccount('bob')
  // Bob joins Alice's project as a read-only member. Done through SQL because the
  // invite flow is a two-party UI dance; the permission check under test is the same.
  const db = new Database(dbFile)
  db.pragma('busy_timeout = 3000')
  const bobId = db.prepare('SELECT id FROM users WHERE email = ?').get(bob.email)?.id
  db.prepare('INSERT INTO project_members (project_id, user_id, role, joined_at) VALUES (?,?,?,?)').run(
    projectId,
    bobId,
    'viewer',
    Math.floor(Date.now() / 1000),
  )

  // ------------------------------------------------------------- PAT / protocol
  console.log('\n[2] PAT lifecycle + protocol contract')
  const noAuth = await mcp(null, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } },
  })
  check('unauthenticated /mcp is 401', noAuth.status === 401, `status=${noAuth.status}`)
  check('401 body is JSON-RPC with a code', noAuth.json?.jsonrpc === '2.0' && noAuth.json?.error?.code === -32001, noAuth.text.slice(0, 160))

  const init = await mcp(alice.pat, {
    jsonrpc: '2.0',
    id: 2,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } },
  })
  check('initialize succeeds', init.status === 200 && !!init.json?.result)
  check('server name + version', init.json?.result?.serverInfo?.name === 'mindmap' && init.json?.result?.serverInfo?.version === 'e2e-test', JSON.stringify(init.json?.result?.serverInfo))
  check('instructions mention all three domains', /笔记本/.test(init.json?.result?.instructions ?? '') && /节点池/.test(init.json?.result?.instructions ?? ''))

  const toolsList = await mcp(alice.pat, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
  const tools = toolsList.json?.result?.tools ?? []
  const names = tools.map((t) => t.name)
  check('tools/list advertises 54 tools', names.length === 54, `count=${names.length}`)
  check('no duplicate tool names', new Set(names).size === names.length)
  for (const expected of [
    'notebookList',
    'notebookCreate',
    'poolCreate',
    'canvasCreate',
    'transferManuscriptToCard',
    'moveCardToCanvas',
    'sessionInfo',
  ]) {
    check(`tool present: ${expected}`, names.includes(expected))
  }
  check(
    'every tool declares annotations',
    tools.every((t) => t.annotations && typeof t.annotations.readOnlyHint === 'boolean'),
  )
  const destructive = tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name)
  for (const expected of ['notebookDelete', 'poolDelete', 'canvasDelete', 'canvasFolderDelete']) {
    check(`destructive tool flagged: ${expected}`, destructive.includes(expected))
  }

  const method405 = await fetch(`${BASE}/mcp`, { headers: { Authorization: `Bearer ${alice.pat}`, Accept: 'text/event-stream' } })
  check('GET /mcp is 405 with Allow', method405.status === 405 && (method405.headers.get('allow') ?? '').includes('POST'))

  const parseErr = await mcp(alice.pat, null, { raw: '{"jsonrpc":"2.0",,}' })
  check('malformed JSON is a JSON-RPC parse error', parseErr.status === 400 && parseErr.json?.error?.code === -32700, `${parseErr.status} ${parseErr.text.slice(0, 120)}`)

  // ------------------------------------------------------------------ session
  console.log('\n[3] sessionInfo')
  const info = await tool(alice.pat, 'sessionInfo', {})
  check('sessionInfo succeeds', !info.isError, info.text.slice(0, 160))
  check('sessionInfo reports the project count', info.parsed?.counts?.projects === 1, JSON.stringify(info.parsed?.counts))
  check('sessionInfo exposes the error contract', (info.parsed?.errorContract?.codes ?? []).includes('E_CONFLICT'))

  // ------------------------------------------------------------------ notebook
  console.log('\n[4] Notebook')
  const created = await tool(alice.pat, 'notebookCreate', { title: '第一篇', text: '第一段\n\n第二段' })
  check('notebookCreate succeeds', !created.isError, created.text.slice(0, 200))
  const manuscriptId = created.parsed?.manuscriptId
  check('notebookCreate returns an id', Number.isInteger(manuscriptId))
  check('text is converted to paragraphs', created.parsed?.contentHtml?.includes('<p>'))
  check('previewText is filled', (created.parsed?.previewText ?? '').includes('第一段'))

  const listed = await tool(alice.pat, 'notebookList', { limit: 10 })
  check('notebookList sees it', listed.parsed?.total === 1, JSON.stringify(listed.parsed)?.slice(0, 120))

  // Stale-write protection: the editor may have saved while the agent was thinking.
  db.prepare('UPDATE manuscripts SET updated_at = updated_at + 10 WHERE id = ?').run(manuscriptId)
  const conflict = await tool(alice.pat, 'notebookUpdate', {
    manuscriptId,
    text: 'agent overwrite',
    expectedUpdatedAt: created.parsed?.updatedAt,
  })
  check('stale notebookUpdate is refused with E_CONFLICT', conflict.isError && conflict.text.includes('E_CONFLICT'), conflict.text.slice(0, 160))

  const fresh = await tool(alice.pat, 'notebookGet', { manuscriptId })
  const saved = await tool(alice.pat, 'notebookUpdate', {
    manuscriptId,
    text: '合并后的正文',
    expectedUpdatedAt: fresh.parsed?.updatedAt,
  })
  check('notebookUpdate succeeds with the fresh stamp', !saved.isError, saved.text.slice(0, 160))
  check('正文被替换', saved.parsed?.contentText?.includes('合并后的正文'))

  const unsafe = await tool(alice.pat, 'notebookCreate', { html: '<p onclick="x()">hi</p>' })
  check('hostile html is rejected', unsafe.isError && unsafe.text.includes('E_VALIDATION'), unsafe.text.slice(0, 160))

  const folder = await tool(alice.pat, 'notebookFolderCreate', { name: '剧本' })
  check('notebookFolderCreate succeeds', !folder.isError, folder.text.slice(0, 160))
  const folders = await tool(alice.pat, 'notebookFolderList', {})
  check('folderList shows the new folder', (folders.parsed?.folders ?? []).some((f) => f.folderId === folder.parsed?.folderId))

  // ------------------------------------------------------------------ pool
  console.log('\n[5] Node pool')
  const card = await tool(alice.pat, 'poolCreate', { title: '卖点', text: '轻量\n本地存储', tags: '产品' })
  check('poolCreate succeeds', !card.isError, card.text.slice(0, 200))
  const cardId = card.parsed?.cardId
  check('poolCreate returns an id', Number.isInteger(cardId))

  const tooBig = await tool(alice.pat, 'poolCreate', { title: 'huge', text: 'x'.repeat(6000) })
  check('over-5000-char card is refused with E_LIMIT', tooBig.isError && tooBig.text.includes('E_LIMIT'), tooBig.text.slice(0, 160))

  const poolList = await tool(alice.pat, 'poolList', {})
  check('poolList sees the card', poolList.parsed?.total === 1, JSON.stringify(poolList.parsed)?.slice(0, 120))
  check('poolList search matches the body', (await tool(alice.pat, 'poolList', { q: '本地' })).parsed?.total === 1)

  // ------------------------------------------------------- transfer + canvas
  console.log('\n[6] Transfers and canvas writes')
  check('poolList no longer exposes useCount', !('useCount' in (poolList.parsed?.items?.[0] ?? {})))

  const movedToCanvas = await tool(alice.pat, 'moveCardToCanvas', { canvasId, cardId, x: 40, y: 60 })
  check('moveCardToCanvas succeeds', !movedToCanvas.isError, movedToCanvas.text.slice(0, 200))
  check('card left the pool (MOVE semantics)', (await tool(alice.pat, 'poolList', {})).parsed?.total === 0)
  check('moved card is gone', (await tool(alice.pat, 'poolGet', { cardId })).isError)

  const nodes = await tool(alice.pat, 'getAllNodes', { canvasId })
  check('canvas has the moved node', nodes.parsed?.count === 1, JSON.stringify(nodes.parsed?.count))
  check('node landed at the requested position', nodes.parsed?.nodes?.[0]?.x === 40 && nodes.parsed?.nodes?.[0]?.y === 60)

  const moved = await tool(alice.pat, 'transferNodeToCard', { canvasId, nodeId: nodes.parsed.nodes[0].id })
  check('transferNodeToCard succeeds', !moved.isError, moved.text.slice(0, 200))
  const roundTripCardId = moved.parsed?.cardId
  check('node gone from canvas', (await tool(alice.pat, 'getAllNodes', { canvasId })).parsed?.count === 0)
  check('card added to pool', (await tool(alice.pat, 'poolList', {})).parsed?.total === 1)

  const movedDoc = await tool(alice.pat, 'transferManuscriptToCard', { manuscriptId })
  check('transferManuscriptToCard succeeds', !movedDoc.isError, movedDoc.text.slice(0, 200))
  const docGone = await api('GET', `/api/manuscripts/${manuscriptId}`, { token: alice.jwt, jar: alice.jar })
  check('manuscript is gone through REST too (moved, not copied)', docGone.status === 404, `status=${docGone.status}`)
  check('pool now holds both cards', (await tool(alice.pat, 'poolList', {})).parsed?.total === 2)

  const backToDoc = await tool(alice.pat, 'transferCardToManuscript', { cardId: roundTripCardId })
  check('transferCardToManuscript succeeds', !backToDoc.isError, backToDoc.text.slice(0, 160))
  check('card gone from pool', (await tool(alice.pat, 'poolGet', { cardId: roundTripCardId })).isError)

  // ------------------------------------------------------------ canvas lifecycle
  console.log('\n[7] Canvas lifecycle')
  const newCanvas = await tool(alice.pat, 'canvasCreate', { projectId, name: '临时画布' })
  check('canvasCreate succeeds', !newCanvas.isError, newCanvas.text.slice(0, 160))
  const newCanvasId = newCanvas.parsed?.canvasId
  check('canvasRename works', (await tool(alice.pat, 'canvasRename', { canvasId: newCanvasId, name: '改过名' })).parsed?.name === '改过名')

  const canvasFolder = await tool(alice.pat, 'canvasFolderCreate', { projectId, name: '画布组' })
  check('canvasFolderCreate works', !canvasFolder.isError)
  check(
    'canvasMove works',
    (await tool(alice.pat, 'canvasMove', { canvasId: newCanvasId, folderId: canvasFolder.parsed?.folderId })).parsed?.folderId === canvasFolder.parsed?.folderId,
  )

  const delRefused = await tool(alice.pat, 'canvasDelete', { canvasId: newCanvasId })
  check('canvasDelete without confirm is refused', delRefused.isError && delRefused.text.includes('E_VALIDATION'))
  const delDone = await tool(alice.pat, 'canvasDelete', { canvasId: newCanvasId, confirm: true })
  check('canvasDelete with confirm succeeds', !delDone.isError, delDone.text.slice(0, 160))
  check(
    'deleted canvas disappears from listCanvases',
    !(await tool(alice.pat, 'listCanvases', {})).parsed?.canvases?.some((c) => c.canvasId === newCanvasId),
  )

  // ------------------------------------------------------------- permissions
  console.log('\n[8] Permissions (viewer vs editor)')
  const bobRead = await tool(bob.pat, 'getCanvasData', { canvasId })
  check('viewer can read the shared canvas', !bobRead.isError, bobRead.text.slice(0, 120))
  const bobWrite = await tool(bob.pat, 'createNode', { canvasId, title: 'viewer wrote this' })
  check('viewer CANNOT write through MCP', bobWrite.isError && bobWrite.text.includes('E_FORBIDDEN'), bobWrite.text.slice(0, 200))
  const bobDelete = await tool(bob.pat, 'deleteNode', { canvasId, nodeId: 'whatever' })
  check('viewer cannot delete either', bobDelete.isError)
  const bobOwnDoc = await tool(bob.pat, 'notebookCreate', { text: 'bob 自己的稿子' })
  check('viewer still owns their own notebook', !bobOwnDoc.isError)

  const aliceNode = await tool(alice.pat, 'createNode', { canvasId, title: 'alice node' })
  check('owner can write', !aliceNode.isError)
  const bobUndo = await tool(bob.pat, 'undo', { canvasId })
  check("viewer cannot undo the owner's agent", bobUndo.isError)
  const aliceUndo = await tool(alice.pat, 'undo', { canvasId })
  check('owner can undo their own write', !aliceUndo.isError && aliceUndo.parsed?.changes?.nodes?.removed?.length === 1, aliceUndo.text.slice(0, 200))

  // --------------------------------------------------------------- revocation
  console.log('\n[9] Revocation + audit')
  const tokens = await api('GET', '/api/tokens', { token: alice.jwt, jar: alice.jar })
  const tokenId = tokens.json?.data?.tokens?.find((t) => !t.revokedAt)?.id
  check('token list never exposes the secret', !JSON.stringify(tokens.json).includes(alice.pat))
  const revoked = await api('DELETE', `/api/tokens/${tokenId}`, { token: alice.jwt, csrf: alice.csrf, jar: alice.jar })
  check('revoke succeeds', revoked.status === 200, `status=${revoked.status}`)
  const afterRevoke = await mcp(alice.pat, { jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} })
  check('revoked token is rejected', afterRevoke.status === 401 && afterRevoke.json?.error?.code === -32001)

  await new Promise((r) => setTimeout(r, 300))
  const audit = newLogLines()
  check('audit trail recorded tool calls', audit.includes('mcp.call'))
  // The logger nests its payload as an escaped JSON string, so match on content, not
  // on formatting.
  check('audit trail names a tool', /notebookCreate|poolCreate|canvasCreate/.test(audit))
  check('audit trail carries the calling user', /userId/.test(audit))
  check('plaintext PAT never appears in the server log', !audit.includes(alice.pat) && !serverLog.includes(alice.pat))
  check('audit trail never records document prose', !audit.includes('合并后的正文'))
} catch (error) {
  console.error('\nSMOKE ABORTED:', error)
  console.error('--- server output (tail) ---\n', serverLog.slice(-3000))
  failures++
} finally {
  cleanup()
}

console.log(`\n==== ${checks - failures}/${checks} checks passed ====`)
process.exit(failures ? 1 : 0)
