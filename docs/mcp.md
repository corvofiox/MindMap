# MCP 接入文档

MindMap 通过 [Model Context Protocol](https://modelcontextprotocol.io) 把自己的三个内容域开放给外部 agent：
**画布**（协作、实时）、**笔记本**（账号私有手稿）、**节点池**（账号私有卡片），以及它们之间的搬运操作。

任何支持 MCP 的客户端（Claude Desktop、Cursor、Cline、自研 agent……）都能接进来，用自然语言管理这些内容。

---

## 1. 五分钟接入

### 1.1 生成访问令牌

网页登录 → 右上角头像 → **账号设置** → **访问令牌** → 新建。
令牌形如 `mmp_1a2b3c…`，**明文只显示这一次**，服务端只存 SHA-256 哈希。

- 一个账号最多 25 个有效令牌；
- 可以设有效期，也可以随时撤销；
- 令牌权限 = 该账号的权限（见 §5）。

### 1.2 方式一：HTTP（推荐给远程 agent）

```bash
curl -s http://<你的地址>:8000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer mmp_xxx' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

> ⚠️ **必须同时接受两种媒体类型**：`Accept: application/json, text/event-stream`。
> 只写 `application/json` 会得到 `406 Not Acceptable`（MCP 规范要求），这是接入时最常见的坑。

多数客户端只需要配置 URL + 令牌：

```json
{
  "mcpServers": {
    "mindmap": {
      "url": "http://127.0.0.1:8000/mcp",
      "headers": { "Authorization": "Bearer mmp_xxx" }
    }
  }
}
```

### 1.3 方式二：stdio（本地进程，适合只支持 stdio 的客户端）

`stdio` 入口是一个**透明代理**：它把每条 JSON-RPC 消息转发给正在运行的服务端 `/mcp`。
必须这样做的原因是画布文档（Yjs）只存在于服务端进程里——另起一个进程读数据库会让写入既不实时、又会被服务端下次落盘覆盖。

```json
{
  "mcpServers": {
    "mindmap": {
      "command": "node",
      "args": ["<仓库绝对路径>/backend/dist/mcp/stdio.js"],
      "env": {
        "MINDMAP_API_URL": "http://127.0.0.1:8000",
        "MINDMAP_TOKEN": "mmp_xxx"
      }
    }
  }
}
```

- `MINDMAP_API_URL` 默认 `http://127.0.0.1:3000`（开发端口），生产容器是 `8000`，**必须显式指定**；
- `MINDMAP_TOKEN` 缺失时立即以非零码退出并在 stderr 说明原因；
- stdout 只有 MCP 协议流，诊断信息一律走 stderr（写错 stdout 会直接破坏协议）。

---

## 2. 三个域的关系

| 域 | 归属 | 实时性 | 内容形态 | 删除可恢复性 |
|---|---|---|---|---|
| 画布 | 项目（含协作者） | **实时**，改动立刻推给所有打开的浏览器 | Yjs CRDT 文档，节点/连线/组/域 | 画布删除=**硬删**；节点删除可从 undo 栈恢复 |
| 笔记本 | 账号私有 | 刷新可见 | 富文本 HTML（≤5 MB） | 软删除（行还在，界面不可见） |
| 节点池 | 账号私有 | 刷新可见 | 卡片 JSON 快照（序列化后 ≤5000 字符） | **物理删除** |

三个域的 **ID 不通用**：画布的 `canvasId`、笔记本的 `manuscriptId`、节点池的 `cardId` 是三套命名空间。
文件夹也是三套独立的树：`canvasFolder*`（项目级）、`notebookFolder*`、`poolFolder*`。

---

## 3. 工具目录（55 个）

### 3.1 画布内容（23 个，实时生效）

| 工具 | 说明 |
|---|---|
| `listCanvases` | 列出可访问的画布（起点工具） |
| `getCanvasData` / `getAllNodes` / `getAllConnections` / `getAllGroups` / `getAllDomains` | 读取 |
| `searchNodes` | 按标题/正文搜索 |
| `createNode` / `updateNode` / `batchUpdateNodes` / `deleteNode` | 节点（删除会级联删连线） |
| `createConnection` / `updateConnection` / `deleteConnection` | 连线（重复创建会自动去重） |
| `createGroup` / `updateGroup` / `deleteGroup` | 组 |
| `createDomain` / `updateDomain` / `deleteDomain` | 域 |
| `generateGraphFromJSON` | 一次调用构建整张图（原子写入、只追加） |
| `undo` / `redo` | 只回退**本账号**通过 MCP 做过的改动 |

### 3.2 画布生命周期（8 个）

`canvasCreate` `canvasRename` `canvasMove` `canvasDelete` `canvasFolderList` `canvasFolderCreate` `canvasFolderUpdate` `canvasFolderDelete`

### 3.3 笔记本（9 个）

`notebookList` `notebookGet` `notebookCreate` `notebookUpdate` `notebookDelete` `notebookFolderList` `notebookFolderCreate` `notebookFolderUpdate` `notebookFolderDelete`

### 3.4 节点池（10 个）

`poolList` `poolGet` `poolCreate` `poolUpdate` `poolDelete` `poolNoteUsage` `poolFolderList` `poolFolderCreate` `poolFolderUpdate` `poolFolderDelete`

### 3.5 搬运（4 个）

| 工具 | 语义 | 结果 |
|---|---|---|
| `transferManuscriptToCard` | **搬运** | 手稿从笔记本消失，卡片出现在节点池 |
| `transferCardToManuscript` | **搬运** | 卡片从节点池消失，手稿出现在笔记本 |
| `transferNodeToCard` | **搬运** | 节点与它的连线从画布消失，卡片出现在节点池 |
| `copyCardToCanvas` | **复制** | 画布上多一个节点，卡片保留、`useCount + 1` |

搬运在两个方向上都用事务/先建后删保护：**要么整个搬过去，要么原样不动**。

### 3.6 会话（1 个）

`sessionInfo` —— 当前账号、可访问项目、三个域的条目数、服务端版本、错误码表。开始工作前调一次可以省掉十几次探索式 list 调用。

---

## 4. 错误契约

工具失败时返回 `isError: true`，正文以稳定的机器可读码开头：

```
[E_NOT_FOUND] 手稿 42 不存在
提示：先用 notebookList 获取有效的手稿 ID。
```

| 码 | 含义 | 该怎么处理 |
|---|---|---|
| `E_VALIDATION` | 参数能理解但不合法（空更新、越界、危险 HTML） | 修正参数，不要重试 |
| `E_NOT_FOUND` | 目标不存在，或对当前令牌不可见 | 重新 list 拿有效 ID |
| `E_FORBIDDEN` | 目标存在但当前账号/角色不允许 | 找项目所有者要权限，不要重试 |
| `E_CONFLICT` | 乐观锁冲突（文档在读取后被改过） | **重新读取、合并，再提交** |
| `E_LIMIT` | 命中配额或体积上限 | 拆小，重试同样的请求没用 |
| `E_UNSUPPORTED` | 该操作在此不可用 | 换一条路径 |
| `E_INTERNAL` | 服务端异常 | 稍后重试 |

传输层错误（认证、限流、请求体过大、JSON 解析失败）返回标准 **JSON-RPC error 对象**，不再是 `{success:false}`：

| 场景 | HTTP | JSON-RPC code |
|---|---|---|
| 令牌无效/已撤销/过期 | 401（带 `WWW-Authenticate`） | `-32001` |
| 请求体过大（>10 MB） | 413 | `-32000`，`data.code=E_LIMIT` |
| JSON 解析失败 | 400 | `-32700` |
| 未知方法 | 200 | `-32601` |
| GET/DELETE（本服务为无状态） | 405（带 `Allow: POST`） | `-32000` |
| 限流 | 429 | `-32000`，`data.code=E_LIMIT` |

---

## 5. 权限模型

两层，取交集：

1. **账号在项目里的角色**：`owner` / `editor` 可读写画布；`viewer` **只能读**。
   只读成员用令牌写入会得到 `E_FORBIDDEN`——这条规则与网页端、WebSocket 完全一致。
2. **令牌本身**：目前令牌 = 该账号的全部权限（**尚未支持只读令牌**，见 §10）。
   需要只读 agent 时，请用一个 viewer 角色的账号签发令牌。

笔记本与节点池是账号私有资源：只能看到自己的，越权一律表现为 `E_NOT_FOUND`（不泄露"存在但不属于你"）。

---

## 6. 安全设计

- 令牌只存 SHA-256 哈希，明文仅在创建时返回一次；`mmp_` 前缀便于泄漏后被日志扫描发现。
- 令牌**不能**当 JWT 用（`/api/*` 只认 JWT），反之亦然；两者可独立撤销。
- `/mcp` 不启用 CSRF：凭据是显式 `Authorization` 头，跨站表单无法设置。
- 危险操作要求显式确认：`canvasDelete` / `canvasFolderDelete` / `notebookFolderDelete` / `poolFolderDelete` 必须传 `confirm: true`，并返回实际删除了多少内容。
- 审计：每次工具调用都会写一条 `mcp.call` 到服务端日志（`backend/logs/debug.log`，随部署而变），记录账号、令牌 id、工具名、目标 id、耗时、成功与否。**不记录正文内容**，避免把用户文档抄进日志。
- 撤销栈按账号隔离，且只存在于内存：画布文档被回收后历史清空。

---

## 7. 限额

| 项 | 值 |
|---|---|
| 请求体 | 10 MB |
| 笔记本正文 | 5 MB（HTML） |
| 节点池卡片 | 序列化后 5000 字符 |
| 画布节点 | 建议 ≥ 200×160，浅色背景 |
| 列表分页 | `limit` 默认 50、最大 200；用 `nextOffset` 翻页 |
| 工具调用速率 | 每个账号 300 次/分钟（按账号，不按 IP，避免反代后互相挤占） |
| 令牌数量 | 每账号 25 个有效令牌；铸造限速 20 次/小时 |

---

## 8. 部署注意

- **反向代理**：`/mcp` 是普通 POST，不要开启响应缓冲以外的特殊处理；SSE 未使用（无状态 JSON 模式），不需要关 buffering。
- **`TRUST_PROXY`**：只有在确有反代时才设为 `true`，否则客户端的 `X-Forwarded-For` 会被无条件信任，限流形同虚设。
- **`ALLOWED_ORIGINS`**：`/mcp` 不依赖 cookie，浏览器直连时 CORS 需要 `Authorization` 头（已默认放行）；生产环境不要用 `*`。
- **对外暴露**：令牌就是账号权限，建议把 `/mcp` 限制在内网或加一层网络白名单。

---

## 9. 自测

```bash
# 单元层（协议 + 领域 + 权限矩阵，约 30s）
npm run test:backend:run

# 端到端：真起服务、真令牌、真 HTTP，78 个检查点
npm run build:backend
npm run smoke:mcp

# stdio 代理链路
npm run smoke:mcp:stdio
```

---

## 10. 已知边界 / 后续

- **令牌尚无 scope**：不能签发"只读令牌"。当前用 viewer 账号绕过。
- **工具命名不统一**：画布实体工具沿用早期名字（`listCanvases` / `getAllNodes`），新工具统一用域前缀（`notebook*` / `pool*` / `canvas*`）。改名是 breaking change，留到有明确需求时统一。
- **画布实体写入与 REST 全量快照的关系**：老客户端仍可用 `POST /api/canvases/:id/data` 提交整份快照，该路径在房间不活跃时会删除"快照里没有"的实体；当前前端已改用 Yjs，实际不会触发，但自研脚本不要混用两条路径。
- **undo 历史不持久**：服务端回收画布文档后清空。
