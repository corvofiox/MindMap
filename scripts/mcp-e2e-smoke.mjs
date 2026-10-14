/**
 * End-to-end MCP smoke test against a REAL running server.
 *
 * This is deliberately not a unit test: it boots the actual HTTP server with an
 * isolated database, then drives the real `/mcp` endpoint over HTTP with a real
 * personal access token. It is the only check that proves the whole chain works —
 * PAT creation → middleware → Streamable HTTP transport → tool → Yjs doc → read
 * back — which unit tests with mocked transports cannot establish.
 *
 * Run manually (it is NOT part of the vitest suite, which must stay hermetic):
 *   node scripts/mcp-e2e-smoke.mjs
 *
 * Exits non-zero on the first failed expectation.
 */
import { spawn } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { createServer } from 'net'
import { tmpdir } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

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
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures++
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Minimal cookie jar: the CSRF flow needs the cookie echoed back. */
const cookieJar = new Map()
function rememberCookies(res) {
  const raw = res.headers.getSetCookie?.() ?? []
  for (const c of raw) {
    const [pair] = c.split(';')
    const idx = pair.indexOf('=')
    if (idx > 0) cookieJar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim())
  }
}
function cookieHeader() {
  return Array.from(cookieJar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}

async function api(method, endpoint, { body, token, csrf } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (cookieJar.size > 0) headers['Cookie'] = cookieHeader()
  if (token) headers['Authorization'] = `Bearer ${token}`
  if (csrf) headers['x-csrf-token'] = csrf

  const res = await fetch(`${BASE}${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  rememberCookies(res)
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
async function mcp(token, message) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(message),
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

const tmp = mkdtempSync(path.join(tmpdir(), 'mindmap-mcp-e2e-'))
const dbFile = path.join(tmp, 'e2e.db')

console.log('Booting server with isolated DB...')
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

try {
  const health = await waitForHealth()
  console.log(`  server up: version=${health.version}`)
  check('health reports injected APP_VERSION', health.version === 'e2e-test', health.version)

  // ---- bootstrap a user, project and canvas through the public API ----
  console.log('\n[1] Bootstrap user / project / canvas')
  const email = `e2e-${Date.now()}@test.local`
  const reg = await api('POST', '/api/auth/register', {
    body: { email, password: 'testtest', nickname: 'E2E' },
  })
  check('register returns 201/200', reg.status === 200 || reg.status === 201, `status=${reg.status}`)
  const jwt = reg.json?.data?.token ?? reg.json?.token
  check('register returns a JWT', typeof jwt === 'string' && jwt.length > 0)

  const csrfRes = await api('GET', '/api/csrf-token')
  const csrf = csrfRes.json?.token
  check('csrf token issued', typeof csrf === 'string' && csrf.length > 0)

  const proj = await api('POST', '/api/projects', {
    body: { name: 'E2E Project' },
    token: jwt,
    csrf,
  })
  check('project created', proj.status === 200 || proj.status === 201, `status=${proj.status}`)
  const projectId = proj.json?.data?.id ?? proj.json?.id
  check('project id returned', Number.isInteger(projectId), JSON.stringify(proj.json))

  const canvas = await api('POST', `/api/canvases/${projectId}`, {
    body: { name: 'E2E Canvas' },
    token: jwt,
    csrf,
  })
  check('canvas created', canvas.status === 200 || canvas.status === 201, `status=${canvas.status}`)
  const canvasId = canvas.json?.data?.id ?? canvas.json?.id
  check('canvas id returned', Number.isInteger(canvasId), JSON.stringify(canvas.json))

  // ---- PAT lifecycle ----
  console.log('\n[2] Personal access token lifecycle')
  const created = await api('POST', '/api/tokens', {
    body: { name: 'e2e agent' },
    token: jwt,
    csrf,
  })
  check('token created (201)', created.status === 201, `status=${created.status}`)
  const pat = created.json?.data?.token
  const tokenId = created.json?.data?.id
  check('plaintext token returned once', typeof pat === 'string' && pat.startsWith('mmp_'))
  check('token id returned', Number.isInteger(tokenId))

  const listed = await api('GET', '/api/tokens', { token: jwt })
  check('token list succeeds', listed.status === 200)
  const listedTokens = listed.json?.data?.tokens ?? []
  check('listed token does not expose the secret', !JSON.stringify(listedTokens).includes(pat))
  check(
    'listed token shows a prefix',
    listedTokens.some((t) => typeof t.tokenPrefix === 'string' && t.tokenPrefix.includes('mmp_')),
  )

  // ---- MCP protocol over HTTP ----
  console.log('\n[3] MCP protocol')
  const noAuth = await mcp(null, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } },
  })
  check('unauthenticated /mcp is rejected 401', noAuth.status === 401, `status=${noAuth.status}`)

  const badAuth = await mcp('mmp_definitely-not-a-real-token', {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } },
  })
  check('invalid token is rejected 401', badAuth.status === 401, `status=${badAuth.status}`)

  const init = await mcp(pat, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '1' },
    },
  })
  check('initialize succeeds', init.status === 200 && !!init.json?.result, JSON.stringify(init.json)?.slice(0, 300))
  check(
    'initialize reports server name',
    init.json?.result?.serverInfo?.name === 'mindmap',
    JSON.stringify(init.json?.result?.serverInfo),
  )
  check(
    'initialize advertises instructions',
    typeof init.json?.result?.instructions === 'string' && init.json.result.instructions.length > 0,
  )

  const toolsList = await mcp(pat, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  const toolNames = (toolsList.json?.result?.tools ?? []).map((t) => t.name)
  check('tools/list returns tools', toolNames.length > 0, `count=${toolNames.length}`)
  for (const expected of [
    'listCanvases',
    'getCanvasData',
    'createNode',
    'updateNode',
    'deleteNode',
    'createConnection',
    'generateGraphFromJSON',
    'undo',
    'redo',
  ]) {
    check(`tool present: ${expected}`, toolNames.includes(expected))
  }

  const listCanvases = await mcp(pat, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'listCanvases', arguments: {} },
  })
  const listPayload = listCanvases.json?.result?.content?.[0]?.text
  let listParsed = null
  try {
    listParsed = JSON.parse(listPayload)
  } catch {
    /* leave null */
  }
  check('listCanvases is callable', !!listParsed, String(listPayload)?.slice(0, 200))
  check(
    'listCanvases includes the created canvas',
    (listParsed?.canvases ?? []).some((c) => c.canvasId === canvasId),
    JSON.stringify(listParsed)?.slice(0, 300),
  )

  // ---- a real write, then read it back ----
  console.log('\n[4] Canvas write through MCP')
  const created2 = await mcp(pat, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'generateGraphFromJSON',
      arguments: {
        canvasId,
        data: {
          nodes: [
            { title: 'Alpha', x: 0, y: 0 },
            { title: 'Beta', x: 400, y: 0 },
          ],
          connections: [{ from: 'Alpha', to: 'Beta', label: 'rel' }],
        },
      },
    },
  })
  const graphText = created2.json?.result?.content?.[0]?.text
  let graphParsed = null
  try {
    graphParsed = JSON.parse(graphText)
  } catch {
    /* leave null */
  }
  check('generateGraphFromJSON succeeded', graphParsed?.nodesCreated === 2, String(graphText)?.slice(0, 300))
  check('one connection created', graphParsed?.connectionsCreated === 1)

  const readBack = await mcp(pat, {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'getCanvasData', arguments: { canvasId } },
  })
  let readParsed = null
  try {
    readParsed = JSON.parse(readBack.json?.result?.content?.[0]?.text)
  } catch {
    /* leave null */
  }
  check('canvas has 2 nodes after write', readParsed?.counts?.nodes === 2, JSON.stringify(readParsed?.counts))
  check('canvas has 1 connection after write', readParsed?.counts?.connections === 1)

  // The write must be visible through the REST API too — this is what proves the
  // MCP write landed in the same authoritative store the web UI reads.
  // Note the route is /api/canvases/detail/:id (there is no GET /api/canvases/:id).
  const restCanvas = await api('GET', `/api/canvases/detail/${canvasId}`, { token: jwt })
  check('REST detail read succeeds', restCanvas.status === 200, `status=${restCanvas.status}`)
  // Persistence is debounced (~100ms) plus a 1s periodic flush, so poll briefly
  // rather than asserting on the first read.
  let restYjs = restCanvas.json?.data?.yjsUpdate
  for (let attempt = 0; attempt < 40 && typeof restYjs !== 'string'; attempt++) {
    await new Promise((r) => setTimeout(r, 250))
    const again = await api('GET', `/api/canvases/detail/${canvasId}`, { token: jwt })
    restYjs = again.json?.data?.yjsUpdate
  }
  check('REST detail carries the yjs doc', typeof restYjs === 'string' && restYjs.length > 0)
  if (typeof restYjs === 'string') {
    const decoded = Buffer.from(restYjs, 'base64').toString('latin1')
    check(
      'persisted Yjs doc contains the MCP-written node titles',
      decoded.includes('Alpha') && decoded.includes('Beta'),
    )
  }

  // ---- undo / redo over MCP ----
  console.log('\n[5] Undo / redo')
  const undo = await mcp(pat, {
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'undo', arguments: { canvasId } },
  })
  check('undo succeeded', !undo.json?.result?.isError, JSON.stringify(undo.json)?.slice(0, 300))
  const afterUndo = await mcp(pat, {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'getCanvasData', arguments: { canvasId } },
  })
  let afterUndoParsed = null
  try {
    afterUndoParsed = JSON.parse(afterUndo.json?.result?.content?.[0]?.text)
  } catch {
    /* leave null */
  }
  check('undo removed the graph', afterUndoParsed?.counts?.nodes === 0, JSON.stringify(afterUndoParsed?.counts))

  const redo = await mcp(pat, {
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: { name: 'redo', arguments: { canvasId } },
  })
  check('redo succeeded', !redo.json?.result?.isError, JSON.stringify(redo.json)?.slice(0, 300))

  // ---- revocation takes effect ----
  console.log('\n[6] Revocation')
  const revoked = await api('DELETE', `/api/tokens/${tokenId}`, { token: jwt, csrf })
  check('revoke succeeds', revoked.status === 200, `status=${revoked.status}`)

  const afterRevoke = await mcp(pat, {
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/list',
    params: {},
  })
  check('revoked token is rejected 401', afterRevoke.status === 401, `status=${afterRevoke.status}`)

  // ---- GET is not a valid MCP call in stateless mode ----
  // Use a fresh valid token: the one above is revoked, and authenticateMcp runs
  // before the method check, so a revoked token correctly yields 401 instead.
  const fresh = await api('POST', '/api/tokens', {
    body: { name: 'e2e agent 2' },
    token: jwt,
    csrf,
  })
  const freshPat = fresh.json?.data?.token
  const getRes = await fetch(`${BASE}/mcp`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${freshPat}` },
  })
  check('GET /mcp returns 405 with a valid token', getRes.status === 405, `status=${getRes.status}`)
} catch (error) {
  failures++
  console.log(`\nFATAL: ${error.message}`)
} finally {
  console.log('\n' + '='.repeat(60))
  if (failures === 0) {
    console.log('ALL E2E CHECKS PASSED')
  } else {
    console.log(`${failures} E2E CHECK(S) FAILED`)
    if (serverLog) {
      console.log('\n--- last server output ---')
      console.log(serverLog.split('\n').slice(-30).join('\n'))
    }
  }
  cleanup()
  process.exit(failures === 0 ? 0 : 1)
}
