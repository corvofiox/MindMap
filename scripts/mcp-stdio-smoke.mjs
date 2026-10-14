/**
 * End-to-end smoke test for the stdio MCP transport.
 *
 * Verifies that `dist/mcp/stdio.js` is a working proxy: it must speak MCP over
 * stdin/stdout while forwarding to a running server, and it must keep diagnostics
 * off stdout (a stray write there corrupts the protocol stream).
 *
 * Run manually (needs a built backend):
 *   node scripts/mcp-stdio-smoke.mjs
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

let failures = 0
function check(label, condition, detail = '') {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures++
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

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

const PORT = await freePort()
const WS_PORT = await freePort()
const BASE = `http://127.0.0.1:${PORT}`
const tmp = mkdtempSync(path.join(tmpdir(), 'mindmap-stdio-e2e-'))

const cookieJar = new Map()
function rememberCookies(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';')
    const i = pair.indexOf('=')
    if (i > 0) cookieJar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
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
  if (cookieJar.size) headers['Cookie'] = cookieHeader()
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
    /* non-JSON */
  }
  return { status: res.status, json }
}

const server = spawn('node', ['dist/index.js'], {
  cwd: backendDir,
  env: {
    ...process.env,
    PORT: String(PORT),
    WS_PORT: String(WS_PORT),
    NODE_ENV: 'development',
    DB_FILE: path.join(tmp, 'stdio.db'),
    JWT_SECRET: 'stdio-e2e-jwt',
    CSRF_SECRET: 'stdio-e2e-csrf',
    ALLOWED_ORIGINS: 'http://localhost:5173',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
server.stdout.on('data', (d) => (serverLog += d))
server.stderr.on('data', (d) => (serverLog += d))

/** The stdio proxy child, plus a line-oriented reader for its stdout. */
let proxy = null
const stdoutLines = []
const stderrText = []
function startProxy(token) {
  proxy = spawn('node', ['dist/mcp/stdio.js'], {
    cwd: backendDir,
    env: {
      ...process.env,
      MINDMAP_API_URL: BASE,
      MINDMAP_TOKEN: token,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buf = ''
  proxy.stdout.on('data', (d) => {
    buf += d.toString()
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (line) stdoutLines.push(line)
    }
  })
  proxy.stderr.on('data', (d) => stderrText.push(d.toString()))
}

function send(msg) {
  proxy.stdin.write(JSON.stringify(msg) + '\n')
}

async function waitForReply(id, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const line of stdoutLines) {
      try {
        const parsed = JSON.parse(line)
        if (parsed.id === id) return parsed
      } catch {
        /* not a JSON-RPC line */
      }
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}

function cleanup() {
  try {
    proxy?.kill('SIGKILL')
  } catch {
    /* gone */
  }
  try {
    server.kill('SIGKILL')
  } catch {
    /* gone */
  }
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

try {
  const deadline = Date.now() + 30000
  let up = false
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) {
        up = true
        break
      }
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  if (!up) throw new Error(`server never became healthy.\n${serverLog}`)
  console.log('  server up')

  // Bootstrap a user + canvas + token.
  const email = `stdio-${Date.now()}@test.local`
  const reg = await api('POST', '/api/auth/register', {
    body: { email, password: 'testtest', nickname: 'Stdio' },
  })
  const jwt = reg.json?.data?.token ?? reg.json?.token
  const csrf = (await api('GET', '/api/csrf-token')).json?.token
  const proj = await api('POST', '/api/projects', { body: { name: 'Stdio P' }, token: jwt, csrf })
  const projectId = proj.json?.data?.id ?? proj.json?.id
  const canvas = await api('POST', `/api/canvases/${projectId}`, {
    body: { name: 'Stdio C' },
    token: jwt,
    csrf,
  })
  const canvasId = canvas.json?.data?.id ?? canvas.json?.id
  const tokenRes = await api('POST', '/api/tokens', { body: { name: 'stdio agent' }, token: jwt, csrf })
  const pat = tokenRes.json?.data?.token
  check('bootstrap complete', Number.isInteger(canvasId) && typeof pat === 'string')

  // ---- missing token must fail loudly, not hang ----
  console.log('\n[1] Missing MINDMAP_TOKEN')
  const noToken = spawn('node', ['dist/mcp/stdio.js'], {
    cwd: backendDir,
    env: { ...process.env, MINDMAP_API_URL: BASE, MINDMAP_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const noTokenErr = await new Promise((resolve) => {
    let out = ''
    noToken.stderr.on('data', (d) => (out += d))
    noToken.on('exit', (code) => resolve({ code, out }))
    setTimeout(() => {
      noToken.kill('SIGKILL')
      resolve({ code: 'timeout', out })
    }, 8000)
  })
  check('exits non-zero without a token', noTokenErr.code === 1, `code=${noTokenErr.code}`)
  check('explains the missing token on stderr', noTokenErr.out.includes('MINDMAP_TOKEN'))

  // ---- happy path over stdio ----
  console.log('\n[2] MCP over stdio')
  startProxy(pat)
  await new Promise((r) => setTimeout(r, 800))

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'stdio-e2e', version: '1' },
    },
  })
  const init = await waitForReply(1)
  check('initialize over stdio', !!init?.result, JSON.stringify(init)?.slice(0, 200))
  check('server name is mindmap', init?.result?.serverInfo?.name === 'mindmap')

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  const tools = await waitForReply(2)
  const names = (tools?.result?.tools ?? []).map((t) => t.name)
  check('tools/list over stdio', names.length > 0, `count=${names.length}`)
  check('createNode discoverable over stdio', names.includes('createNode'))

  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'createNode', arguments: { canvasId, title: '来自 stdio', x: 10, y: 20 } },
  })
  const created = await waitForReply(3)
  const createdPayload = created?.result?.content?.[0]?.text
  let createdParsed = null
  try {
    createdParsed = JSON.parse(createdPayload)
  } catch {
    /* null */
  }
  check('createNode over stdio', typeof createdParsed?.nodeId === 'string', String(createdPayload)?.slice(0, 200))

  // The stdio write must be visible to the HTTP transport too — same server, same doc.
  const httpRead = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${pat}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: { name: 'getAllNodes', arguments: { canvasId } },
    }),
  })
  const httpJson = await httpRead.json()
  const httpPayload = httpJson?.result?.content?.[0]?.text
  check(
    'stdio write is visible over HTTP (same authoritative doc)',
    typeof httpPayload === 'string' && httpPayload.includes('来自 stdio'),
    String(httpPayload)?.slice(0, 200),
  )

  // ---- stdout purity ----
  console.log('\n[3] stdout purity')
  const allStdout = stdoutLines.join('\n')
  check(
    'every stdout line is valid JSON-RPC',
    stdoutLines.every((l) => {
      try {
        const p = JSON.parse(l)
        return typeof p === 'object' && p !== null
      } catch {
        return false
      }
    }),
  )
  check('no diagnostics leaked to stdout', !allStdout.includes('[mindmap-mcp]'))
  check('diagnostics went to stderr', stderrText.join('').includes('[mindmap-mcp]'))

  // ---- invalid token surfaces as an error, not a silent hang ----
  console.log('\n[4] Invalid token')
  proxy.kill('SIGKILL')
  await new Promise((r) => setTimeout(r, 300))
  stdoutLines.length = 0
  stderrText.length = 0
  startProxy('mmp_not-a-real-token')
  await new Promise((r) => setTimeout(r, 800))
  send({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} })
  await new Promise((r) => setTimeout(r, 2500))
  check(
    'invalid token reported on stderr',
    stderrText.join('').includes('401'),
    stderrText.join('').slice(0, 200),
  )
} catch (error) {
  failures++
  console.log(`\nFATAL: ${error.message}`)
} finally {
  console.log('\n' + '='.repeat(60))
  if (failures === 0) console.log('ALL STDIO CHECKS PASSED')
  else console.log(`${failures} STDIO CHECK(S) FAILED`)
  cleanup()
  process.exit(failures === 0 ? 0 : 1)
}
