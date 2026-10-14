/**
 * MCP over stdio — a local entry point for agents that launch a subprocess.
 *
 * IMPORTANT: this process does NOT touch the canvas itself. It is a transparent
 * proxy that forwards each JSON-RPC message to the running HTTP server's `/mcp`
 * endpoint and writes the reply back to stdout.
 *
 * Why proxying instead of running the tools in-process: the canvas is an
 * in-memory Yjs doc owned by the *server* process, and the WebSocket room's
 * broadcast handler lives there too. A separate process would load its own copy
 * of the doc from SQLite, so its edits would (a) never reach open browsers and
 * (b) be overwritten by the server's next persist. Forwarding to the server keeps
 * a single writer, so stdio edits appear live exactly like HTTP ones.
 *
 * Framing: MCP over stdio is newline-delimited JSON, and the HTTP endpoint runs in
 * stateless JSON mode, so one inbound line maps to one POST and at most one
 * outbound line. That makes a byte-level forward correct without interpreting the
 * protocol — which is deliberate: no per-method knowledge means tools added later
 * need no change here, and the proxy cannot drift from the real server.
 *
 * Configure with:
 *   MINDMAP_API_URL  base URL of the server (default http://127.0.0.1:3000)
 *   MINDMAP_TOKEN    a personal access token created in the web UI
 *
 * Everything diagnostic goes to stderr: stdout carries the MCP protocol stream,
 * and a stray write there would corrupt it.
 */
import readline from 'readline'

function logStderr(message: string): void {
  process.stderr.write(`[mindmap-mcp] ${message}\n`)
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000'

interface ProxyConfig {
  endpoint: string
  token: string
}

function resolveConfig(): ProxyConfig {
  const baseUrl = (process.env.MINDMAP_API_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const token = (process.env.MINDMAP_TOKEN || '').trim()

  if (!token) {
    logStderr('缺少 MINDMAP_TOKEN 环境变量。')
    logStderr('请在 MindMap 网页端「账号设置 → 访问令牌」创建令牌，然后写入 MCP 客户端配置，例如：')
    logStderr('  "env": { "MINDMAP_API_URL": "http://127.0.0.1:3000", "MINDMAP_TOKEN": "mmp_..." }')
    process.exit(1)
  }

  return { endpoint: `${baseUrl}/mcp`, token }
}

/**
 * Forward one JSON-RPC message and emit the reply.
 *
 * A notification (no `id`) yields an empty body, which is not written to stdout —
 * emitting a blank line would be parsed as a malformed message.
 */
async function forward(config: ProxyConfig, line: string): Promise<void> {
  let response: Response
  try {
    response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Streamable HTTP requires the client to accept both JSON and SSE.
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${config.token}`,
      },
      body: line,
    })
  } catch (error) {
    logStderr(`无法连接 ${config.endpoint}：${error instanceof Error ? error.message : String(error)}`)
    logStderr('请确认 MindMap 服务已启动且 MINDMAP_API_URL 正确。')
    return
  }

  if (response.status === 401) {
    logStderr('令牌无效或已被撤销（HTTP 401）。请在网页端重新生成访问令牌。')
    return
  }

  const text = await response.text()
  if (!text.trim()) {
    // Notification accepted (202) or no content — nothing to relay.
    if (!response.ok && response.status !== 202) {
      logStderr(`上游返回 HTTP ${response.status}（无内容）`)
    }
    return
  }

  // The endpoint is configured for JSON responses, so the body is one JSON-RPC
  // message. Guard the SSE case anyway so a future config change degrades loudly
  // rather than writing an unparseable stream to stdout.
  if (text.startsWith('event:') || text.startsWith('data:')) {
    for (const chunk of text.split('\n')) {
      const trimmed = chunk.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice('data:'.length).trim()
      if (payload && payload !== '[DONE]') process.stdout.write(`${payload}\n`)
    }
    return
  }

  process.stdout.write(`${text.trim()}\n`)
}

async function main(): Promise<void> {
  const config = resolveConfig()
  logStderr(`stdio 代理已启动 → ${config.endpoint}`)

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

  // Serialise forwarding: MCP allows concurrent requests, but processing lines
  // one at a time keeps replies ordered and bounds memory on a burst. Responses
  // are matched to requests by JSON-RPC id, so ordering is not correctness-critical.
  let queue: Promise<void> = Promise.resolve()

  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    queue = queue.then(() => forward(config, trimmed))
  })

  rl.on('close', () => {
    // stdin closed => the agent is done with us.
    process.exit(0)
  })
}

main().catch((error) => {
  logStderr(`启动失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
