# 需求分析：笔记本 ↔ 思维导图 双模态改造

> 状态：已评审 v2（2026-11-11 第一轮答复后修订）
> 编写依据：2026-11-11 当前 `develop`（v1.9.22）代码事实
> 本文只做需求与方案分析，不含实现细节。

---

## 0. 一句话

把「打开就是一墙项目列表」改成「打开就是我的笔记本」，并在笔记本与思维导图之间建立**手稿 ⇄ 节点**的双向通道；笔记本按账号私有，思维导图维持现有的项目/协作模型。

---

## 1. 现状盘点（代码事实）

| 事实 | 证据 | 对本需求的含义 |
|---|---|---|
| 主页面是项目列表 | `frontend/src/App.tsx:65-69`：`/` → `/projects`，另有 `/canvas/:canvasId` | 需要一个真正的「主页」概念与重定向迁移 |
| 只有三个业务页面 | `LoginPage` / `ProjectsPage` / `CanvasPage` | 笔记本是第 4 个页面，且要成为默认入口 |
| 数据层级 | `projects` → `folders` → `canvases`；画布内容在 Yjs 文档里 | 笔记本不应硬塞进这个层级（项目是可分享的） |
| **节点池已按账号隔离** | `node_cards.user_id`、`node_pool_folders.user_id`（`schema.ts:104-130`） | **这是唯一的「账号隔离」先例**，笔记本应照抄这个模型 |
| 节点池卡片 = 序列化的画布节点 | `CanvasPage.tsx:4034-4043`：`content: JSON.stringify(node)`；反向 `createNodeFromCard.ts:7-19` | 双向转换已有半条通路，可直接复用 |
| 节点只有两种类型 | `type?: 'text' \| 'image'`（`types/index.ts:96`） | **天然不支持「图文混排」**，是本次最大的模型冲突 |
| 节点正文是富文本 HTML | `NodeItem.tsx:1867` `cleanHtmlContent` + `dangerouslySetInnerHTML`；`utils/sanitizeHTML.ts` 白名单 | 手稿编辑器必须共用同一套白名单，否则转换丢样式或引 XSS |
| 图片是 **base64 data URL**，不落盘 | `upload.controller.ts:132-147`：`url: dataUrl` | 含图手稿会显著放大存储与同步体积；复制会成倍膨胀 |
| `files` 表存在但已废置 | `schema.ts:142-151` | 若要做图床化，表结构是现成的 |
| 协作是 Yjs + WebSocket，项目可分享 | `project_members` / `project_invitations`；WS 路由 | 笔记本若也要协作，成本远高于只做私有 |
| MCP 只覆盖画布 | `mcp/tools.ts` 共 23 个工具，无节点池/笔记本 | 本期是否要 AI 参与，需要单独决定 |

---

## 2. 目标与非目标

### 目标
1. 主页变成**笔记本**：以账号为边界的文字记录空间，能写、能找、能整理。
2. 笔记本 ↔ 思维导图**常驻切换入口**，不丢当前上下文。
3. 手稿 → 节点池：一篇手稿变成可复用节点卡片，**类型按内容自动判定**。
4. 节点池 → 手稿：卡片还原成手稿，回到笔记本。

### 非目标（本期明确不做）
- 笔记本的多人实时协作与分享（手稿私有）。
- 手稿的跨账号迁移/公开链接。
- 网页剪藏、OCR、AI 摘要（可作为后续增量）。
- 重构现有画布协作与节点池拖拽交互。

---

## 3. 术语定义（先对齐，避免各说各话）

| 术语 | 定义 | 与现有代码的关系 |
|---|---|---|
| **笔记本 Notebook** | 账号私有的容器，装着若干手稿 | 新概念，类比 `node_pool_folders` 的私有性 |
| **手稿 Manuscript** | 一篇可编辑的富文本文档（标题 + 正文） | 新实体 |
| **节点卡片 NodeCard** | 节点池里的一张卡，可拖进画布 | 已存在（`node_cards`） |
| **画布节点 Node** | 画布上的一个方块（文字或图片） | 已存在 |
| **送入 Sent** | 手稿 → 卡片的一次转换产物 | 新增动作 |
| **还原 Restored** | 卡片 → 手稿的一次转换产物 | 新增动作 |

> 「收录」一词在需求里出现，但没有明确形态。若指的是**从网页/剪贴板采集正文**，那是采集能力（clipper），与「手写记录」是两条不同功能线，需要单独确认（见 §9-Q7）。

---

## 4. 功能需求

### FR-1 笔记本主页面（账号隔离）
- FR-1.1 列表：显示当前账号的全部手稿，按最近编辑排序；空状态引导新建。
- FR-1.2 增删改查：新建、重命名、删除（回收站或二次确认，需定）、复制。
- FR-1.3 组织：文件夹/标签二选一或都做（建议先做文件夹，复用 `node_pool_folders` 形态）。
- FR-1.4 搜索：按标题 + 正文全文（`preview_text` 冗余列，参考 `canvases.preview_text`）。
- FR-1.5 编辑：富文本（标题层级、加粗/斜体/列表/引用/代码、插图、撤销重做）。
- FR-1.6 保存：自动保存 + 明确的保存状态（保存中/已保存/失败重试），不能静默丢稿。
- FR-1.7 隔离：任何手稿接口只能命中 `user_id = 当前登录账号`；他人资源一律 404（不泄露存在性）。

### FR-2 双模态切换入口
- FR-2.1 常驻入口：侧栏顶部或顶栏左侧的「笔记本 / 思维导图」分段控件，两态可见。
- FR-2.2 深链接：`/notebook`、`/notebook/:id`、`/maps`（原 projects）、`/canvas/:id` 均可直接打开。
- FR-2.3 记忆：切换回上次停留的模态（`localStorage` + 服务端 `settings` 兜底）。
- FR-2.4 不打断：在画布编辑中切换时，先落盘再跳转，避免未保存数据丢失。

### FR-3 手稿 → 节点池
- FR-3.1 入口：列表项操作、编辑器内「送入节点池」按钮。
- FR-3.2 产物：一张 `node_cards` 记录（`user_id` = 当前账号，`folder_id` 可选）。
- FR-3.3 **类型自动判定**：
  - 手稿内**无任何图片** → 卡片 `type = 'text'`，正文进入 `content` 的 HTML。
  - 手稿内**含至少一张图片** → 卡片 `type = 'image'`，并把首图作为 `imageUrl`/`thumbnail`。
  - 判定必须在**清洗后的 HTML** 上做（`<img>` 是否存活于白名单），否则判定与真实内容不一致。
- FR-3.4 命名：优先手稿标题，回退正文首行非空文本，再回退「未命名手稿」。
- FR-3.5 溯源：卡片记录来源手稿 id（便于"从哪来"提示与后续同步策略）。
- FR-3.6 幂等提示：同一手稿重复送入不静默产生重复卡片，需提示或更新已有关联卡片。

### FR-4 节点池 → 手稿
- FR-4.1 入口：卡片右键菜单/多选批量。
- FR-4.2 产物：新 `manuscript`，标题取卡片 `name`（或节点 `title`），正文取节点 `content` 的 HTML。
- FR-4.3 图片卡片：`type='image'` 的卡片还原为手稿时，图片以 `<img>` 内联进正文（走同一白名单）。
- FR-4.4 溯源：手稿记录来源卡片 id。
- FR-4.5 不覆盖：默认总是新建手稿，不静默覆盖已有同名稿件。

### FR-5 一致性语义（核心决策，见 §5-D3）
- FR-5.1 转换是**一次性复制**还是**双向绑定**，必须明确到交互文案（「复制到」vs「同步到」）。
- FR-5.2 若做绑定：任一侧编辑后另一侧如何更新（手动同步按钮 / 自动回写 / 冲突提示）。

### FR-6 与现有节点池功能的衔接
- FR-6.1 手稿生成的卡片与「从画布拖入节点池」的卡片在同一个池子里，交互一致（拖拽、搜索、排序、文件夹）。
- FR-6.2 卡片来源可视化（来自手稿 / 来自画布），否则用户分不清同池异源的卡片。

---

## 5. 关键设计难点（本次改造的实质）

### D1：节点模型是「文字 XOR 图片」，手稿天然图文混排 ⚠️最高优先

现状：`type='text'` 的节点渲染 `content`（HTML，`dangerouslySetInnerHTML`）；`type='image'` 的节点渲染 `imageUrl`。**没有一种节点能同时正文 + 图片**。

| 方案 | 做法 | 优点 | 代价 |
|---|---|---|---|
| **A1 单节点，图片内联** | 放宽 `Node.content` 白名单允许 `<img>`，一篇手稿 = 一个 text 节点 | 用户心智最简单（一篇稿=一个节点） | 节点体积暴涨（base64），富文本编辑器与画布渲染都要支持 img；现 `type` 判定失去意义 |
| **A2 拆分为多节点 + 自动成组** | 按标题/段落切分，文字→text 节点、图→image 节点，转换后自动建 group | 完全贴合现有节点模型，不改协作与渲染 | 「一篇手稿」变成「一堆节点」，需要切分规则与用户预期管理 |
| **A3 主节点 + 附属节点** | 首个段落→主节点，其余（含图）→附属节点，用连线串起来 | 视觉上像一篇稿展开 | 连线/布局算法要定，易成一团乱麻 |

**建议**：以 **A2** 为默认路径（不动现有节点模型、可逆性最好），把 **A1** 作为「快送单节点」选项保留给短稿。但这直接决定 FR-3.3 的类型判定语义，需要拍板。

### D2：类型判定规则本身有歧义
「只含文字 / 含图片」在 A1 与 A2 下含义完全不同：
- A1：`含图 → type='image'`，可 image 节点只认 `imageUrl`，**正文会丢** → 不可接受，必须扩展模型。
- A2：`含图 → 拆出 image 节点 + text 节点`，`type` 由每个切片自身内容决定，语义自洽。

结论：**先把 D1 定了，FR-3.3 才有可实现的定义**。

### D3：转换是「复制」还是「绑定」
- 纯复制：实现最简单，符合现有 `moveNodeToPool` 的"移出画布"语义；但双向漂移无人知晓。
- 双向绑定：需要 `manuscript ↔ card` 的关联表 + 冲突策略；与现有 Yjs 协作模型叠加后复杂度陡增。

**建议本期只做复制 + 溯源字段**（可逆但不同步），绑定留到 M2 之后单独评估。

### D4：账号隔离与共享项目的边界
- 手稿私有，卡片私有（`user_id`）。
- 但卡片可拖进**别人的共享项目**：卡片内容是复制品，不泄露手稿本体，可接受。
- 反向不成立：协作者无法把"你的卡片"还原到"我的笔记本"（卡片不属于他）。需要在 UI 上明确「只有卡片所有者能还原」。
- 需要明确：**手稿被删除后，已生成的卡片是否保留**（建议保留，仅清空溯源字段）。

### D5：存储形态
- 手稿是单文档、无协作需求 → 用 `canvases` + Yjs 那套明显过重（要维护 doc、WS 房间、快照合并三条防线）。
- 建议新表 `manuscripts`，REST 保存（自动保存有节流的坑，参考 `CanvasPage.tsx:506-511` 里 keepalive 64KB 上限的教训）。
- 预留 `yjs_update` 列，未来要做协作时才启用，避免二次迁移。

### D6：图片是 base64 内联，转换会成倍膨胀
- 现状：每张图 ≤5MB，以 data URL 存进 `node.imageUrl` / 卡片 `content`。
- 一次往返（手稿→卡→节点）就是 3 份 base64。含图手稿很容易到几十 MB。
- 三个选项：
  1. 维持现状，接受膨胀（简单，但 DB 与 WS 都会痛）；
  2. 转存对象/文件：启用已废置的 `files` 表 + `/api/files/:id`，手稿与卡片只存 URL（推荐，长期正确）；
  3. 转换时复用同一 data URL 字符串（省内存不省存储）。

**建议**：本期先按 1 落地，但**把 `imageUrl` 的取值抽象成「可替换的引用」**，为 2 留出改造点。

---

## 6. 数据模型草案

```sql
-- 手稿（账号私有）
manuscripts (
  id INTEGER PK,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id INTEGER NULL REFERENCES manuscript_folders(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  content_html TEXT NOT NULL,        -- 与节点同一套白名单
  preview_text TEXT,                 -- 列表/搜索用，去标签后的纯文本
  image_count INTEGER DEFAULT 0,     -- 供列表图标与判定复用
  source_card_id INTEGER NULL,       -- 从卡片还原而来时记录
  yjs_update TEXT NULL,              -- 预留协作
  created_at / updated_at,
  deleted_at INTEGER NULL            -- 软删除
);
CREATE INDEX idx_manuscripts_user_updated ON manuscripts(user_id, updated_at DESC);

manuscript_folders (
  id, user_id, name, parent_id, sort_order, collapsed, created_at
);

-- 卡片侧只加两列（不建关联表，避免绑定语义）
ALTER TABLE node_cards ADD COLUMN source_manuscript_id INTEGER NULL;
ALTER TABLE node_cards ADD COLUMN source_kind TEXT NULL;  -- 'canvas' | 'manuscript'
```

迁移方式沿用现有 `migration.ts` 的"检测列是否存在再 ALTER"模式（`schema.ts` 里 `node_cards` 加 `user_id` 那次就是先例）。

---

## 7. 接口草案（REST，均需 `authenticate` + CSRF）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/users/manuscripts?q=&folderId=&cursor=` | 列表/搜索，强制 `user_id` 过滤 |
| POST | `/api/users/manuscripts` | 新建 |
| GET/PUT/DELETE | `/api/users/manuscripts/:id` | 单篇读写、软删除 |
| POST | `/api/users/manuscripts/:id/to-node-card` | 送入节点池（体：`folderId?`、`mode?`） |
| POST | `/api/users/node-pool/:id/to-manuscript` | 还原为手稿 |
| CRUD | `/api/users/manuscript-folders` | 复用节点池文件夹的实现范式 |

约定：越权一律 **404**（与现有 `user.controller.ts` 的 node-pool 校验一致）。

---

## 8. 前端信息架构

**路由不动 `/projects`（2026-11-11 修正）**：思维导图列表的地址、书签、分享链接全部保持原样，
只把根路径的默认落点从 `/projects` 改成 `/notebook`，并新增 `/notebook*`。

```
/                     → 重定向到 /notebook
/notebook             → 手稿列表 + 编辑区（新主页，左侧列表 / 中间大块编辑区）
/notebook/:id         → 同上，选中并打开该手稿
/projects             → 原样保留（思维导图/项目列表）
/canvas/:canvasId     → 原样保留
```

- 侧栏顶部新增「笔记本 / 思维导图」分段器，两态互跳；`/projects` 与 `/canvas/*` 完全不受影响。
- 新增 `useNotebookStore`（拉列表、选中、自动保存队列），与 `useNodePoolStore` 通过既有 `api` 层交互，不互相直接调用。
- 转换入口两处：手稿列表项菜单、编辑器工具栏；反向在节点池卡片右键。

---

## 9. 待拍板问题（按影响排序）

| # | 问题 | 影响 |
|---|---|---|
| Q1 | 一篇手稿 → **一个节点** 还是 **多个节点**？（D1 的 A1/A2/A3） | 决定类型判定语义、节点模型是否要改、工作量差 2~3 倍 |
| Q2 | 含图手稿的图片：继续 base64 内联，还是先做图床化？ | 决定 DB/同步体积与是否需要 `files` 表改造 |
| Q3 | 转换是复制还是双向绑定？ | 决定要不要关联表与冲突策略 |
| Q4 | 手稿是否也要协作/分享？ | 决定存储（REST vs Yjs）与权限模型 |
| Q5 | 「主页面」是**手稿列表**，还是**直接打开最近一篇**？ | 决定 IA 与 `/` 的重定向目标 |
| Q6 | 原 `/projects` 是否降级为「思维导图」子页？入口是否保留独立 URL？ | 决定路由与侧栏结构、老书签兼容 |
| Q7 | 「收录」是否包含网页剪藏/粘贴采集？ | 若包含，是独立模块，工作量单独评估 |
| Q8 | 是否给 MCP 增加笔记本/转换工具（AI 直接从手稿生成节点）？ | 决定 `mcp/tools.ts` 的扩展面与令牌权限边界 |

---

## 10. 里程碑建议（每期可独立上线）

| 期 | 内容 | 依赖 |
|---|---|---|
| **M1** | 手稿 CRUD + 列表/搜索 + 主页切换 + 双模态入口 | 无（可先上线，立即有价值） |
| **M2** | 手稿 → 卡片（仅纯文字，`type=text`） | M1 |
| **M3** | 卡片 → 手稿（纯文字） | M2 |
| **M4** | 含图判定与拆分/成组（按 Q1 结论落地） | Q1、Q2 |
| **M5** | 绑定同步（若 Q3 选绑定）、批量操作、MCP 暴露 | Q3、Q8 |

---

## 11. 验收标准（可自动化断言）

1. **隔离**：账号 A 的手稿，账号 B 调 GET/PUT/DELETE/to-node-card 全部 404，且 B 的列表不含 A 的任何记录。
2. **判定**：给定 N 篇只含文字、M 篇含 1 张图、K 篇含多图的手稿，转换后卡片 `type` 与 `image_count` 完全符合 Q1 确定的规则。
3. **往返保真**：手稿 → 卡片 → 手稿，去标签后文字逐字相同，图片数量相同。
4. **不静默丢失**：自动保存失败时 UI 必须出现可重试的错误态（不是 console-only）。
5. **不污染画布**：节点池操作不产生任何 `canvases`/Yjs 写入（防止回归到"进池即丢内容"）。
6. **转换幂等性**：同一手稿重复送入，按 FR-3.6 的约定行为可断言。

---

## 12. 风险清单

| 风险 | 说明 | 缓解 |
|---|---|---|
| 富文本双份实现 | 节点与手稿各自一套编辑器，白名单漂移会导致转换丢格式/XSS | 抽 `shared` 的白名单与清洗函数，两边共用并有单测 |
| base64 膨胀 | 见 D6 | Q2 决定；先抽象引用 |
| 主页迁移打断老用户 | 书签/习惯从 `/projects` 变为 `/notebook` | 保留 `/projects` 重定向；首启引导 |
| 转换语义误解 | 用户以为"绑定了"，改一处以为另一处会变 | 文案明确「复制」；绑定另设开关 |
| 手稿编辑器与画布编辑器争抢快捷键 | 两套 contentEditable | 各页独立键盘域，禁止全局快捷键跨页 |

---

## 13. 评审结论（2026-11-11 第一轮）

| # | 决定 | 对方案的影响 |
|---|---|---|
| **Q1** | **合并 text / image 为统一节点**，节点不再有"类型"，图片成为正文里的一种内容块 | 原 FR-3.3 的「按文字/图片自动判定类型」**整条需求作废**——没有类型可判。转换退化为纯 HTML 搬运，确定性大幅提高。代价是必须新增 §14 的图片链路改造 |
| **Q4** | 手稿不协作、按账号私有 | 存储走 REST 表，不用 Yjs；排除 D5 的协作分支与 Q3 的并发冲突分支 |
| **Q5** | 左列表 + 中间大块编辑区（双栏工作台） | 笔记本页需要独立布局，不复用画布的三栏 shell |
| **Q8** | MCP 将整体重构 | 统一节点属于 MCP 的字段契约范畴，**MCP 重构必须排在节点模型定型之后**，否则要改两遍 |
| Q2 / Q3 / Q6 / Q7 | 提问方要求解释 | 见 §16 名词解释 |

### 由此产生的结论：转换不需要「判定」

统一节点后，手稿 → 卡片的动作是：

```
手稿 HTML（同一套白名单） --原样搬运--> 卡片 content
                              └-- 首图 URL --> 卡片 thumbnail（供列表/拖拽影子用）
```

不再有"这篇稿子算文字还是图片"的分支。§4 的 FR-3.3、§11 验收标准第 2 条相应作废。

---

## 14. 统一节点：设计与图片链路（本次最大改动）

### 14.1 目标模型

```
Node {
  id, x, y, width, height
  title                                   // 标题（纯文本）
  content                                 // 富文本 HTML，可含 <img>
  titleAlign / contentAlign / collapsedTitleAlign
  collapsed, locked
  cover?                                  // 封面：内容里第一张图的 URL
  zIndex
}
```
- `type` 字段废弃（老数据保留不读，避免一次性重写 Yjs）。
- `imageUrl` / `aspectRatio` 废弃，迁移期读 `imageUrl` 回填 `content` 与 `cover`。
- 节点高度不再由图片宽高比推导：图片是正文里的块，高度由内容撑开（仍可手动拉伸）。

### 14.2 图片如何进入节点（三条入口，汇到同一个上传函数）

| 入口 | 触发 | 处理 |
|---|---|---|
| 粘贴 | contentEditable 内 `paste` | 从 `clipboardData.files/items` 取图 → 上传 → 光标处插入 `<img>` |
| 拖入 | 节点上 `drop` | 取 `dataTransfer.files` → 上传 → 插入到落点 |
| 工具栏 | 「插入图片」按钮 | 文件选择器 → 上传 → 插入 |

三条入口必须复用同一个 `insertImage(nodeId, file)`，否则撤销栈与光标行为会各写一套。

### 14.3 存储：必须先做图床化，否则统一节点会比现在更糟

现状 `upload.controller.ts:132-147` 返回 base64 data URL，图片直接内联进字段。统一节点后图片进入 `content`，后果：
- 一张 2MB 图 ≈ 2.7MB base64 进入 Yjs 文档；
- 每次字段 diff、每次 undo 快照、每次 REST 全量保存（keepalive 有 64KB 上限，见 `CanvasPage.tsx:506`）、每次缩略图 worker 都要复制它；
- 协作时每个客户端都要同步这 2.7MB。

方案：
1. 启用已废置的 `files` 表（`schema.ts:142`），磁盘落 `UPLOAD_DIR`；
2. `POST /api/files` 落盘 + 落表，返回 `{ id, url: '/api/files/<id>' }`；
3. `GET /api/files/:id` 鉴权（登录可读 + 不可枚举随机 id 为下限，见 R3）；
4. `content` 里存 `<img src="/api/files/<id>" data-file-id>`，不再存 base64；
5. 删除时按 `data-file-id` 做引用计数或定期 GC 清孤儿。

兼容：老的 data URL 原样保留可渲染（浏览器直接支持），不做批量重写；老 `type='image'` 节点读取时懒迁移为 `content='<img src=imageUrl>'` + `cover=imageUrl`。

### 14.4 与手稿/节点池的衔接

- 手稿与节点共用同一套 `sanitizeHTML` 白名单（必须含 `img[src]` 与 `data-file-id`），否则图片会被清洗掉。
- 手稿 → 卡片：只搬 HTML 字符串，图片是短 URL，体积与图片数量无关。
- 卡片 → 手稿：反向同理。
- 卡片缩略图/拖拽影子读 `cover`，不必解析 HTML。

### 14.5 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| contentEditable 插图 | 光标位置、撤销栈、浏览器差异 | 统一 `insertImage` + Range API 封装，配组件测试 |
| 图片加载失败 | 鉴权失效/文件被 GC | 占位块 + 重试 |
| 老数据双形态共存 | 期间节点可能同时有 content 与 imageUrl | 读取侧定义唯一优先级，写入侧只写新形态 |
| 体积失控 | 用户塞 20 张 5MB 图进一个节点 | 单节点图片数量/总字节上限 + 提示 |
| MCP 契约变动 | `createNode` 的 type/imageUrl 参数与统一模型冲突 | 与 Q8 的 MCP 重构合并处理 |

---

## 15. 修订后的待确认项

| # | 问题 | 影响 |
|---|---|---|
| **R1** | 图床化是否本期就做？（§14.3） | 不做的话统一节点的同步/存储代价不可接受，建议列为前置 |
| **R2** | `type` 字段：直接删除 / 保留不读 / 保留为派生值 | 决定迁移与 MCP 契约 |
| **R3** | 图片访问权限：登录即可读（简单） vs 严格按引用授权（安全） | 决定 `GET /api/files/:id` 的实现与性能 |
| **R4** | 单节点图片上限（张数/总字节） | 防体积失控 |
| **R5** | 老 `type='image'` 节点：读到即懒迁移 vs 一次性批量迁移 | 一次性迁移要重写所有 Yjs 文档，风险高 |

---

## 16. 名词解释（评审时被问到）

**图床化**：现在图片被转成一长串 `data:image/png;base64,...` 直接塞进节点字段；图床化是"图片单独存成文件，正文里只放一个短链接"。类比：不是把照片贴在信纸上，而是照片进相册、信纸上写"见第 3 页"。好处是节点变小、同步快、一张图多处引用只存一份；代价是多一张表、一个下载接口、权限校验与孤儿文件清理。

**复制 vs 绑定**（Q3）：手稿转卡片是"另存一份"还是"两者连一根线"。复制 = 之后各改各的（像导出 PDF）；绑定 = 改手稿卡片跟着变（像 Excel 的"粘贴链接"）。绑定要处理两边同时改的冲突，叠加 Yjs 后显著复杂。本期因 Q4（不协作）已可排除绑定。

**路由降级**（Q6）：现在网址是 `/projects`（项目列表）。主页改成笔记本后，"思维导图列表"要挪到别的路径（建议 `/maps`），而老的 `/projects` 书签要不要还能打开——保留一个自动跳转就是"兼容降级"。

**网页剪藏 / 粘贴采集**（Q7）：
- 剪藏 = 浏览器插件或"粘贴一个网址"，服务器抓那页正文（去广告导航）存成手稿。要插件 + 抓取服务。
- 粘贴采集 = 网页上选中文字 Ctrl+C，笔记本里 Ctrl+V，自动把网页 HTML 转成手稿格式（保留标题、加粗、链接、图片），而不是粘成一坨纯文本。只需一个 paste 处理器。

两者成本差一个数量级，本期建议只做后者。
---

## 17. 迁移设计（对应 R2 / R5：一次性迁移 + 兼容）

### 17.0 为什么迁移比新功能难

现有数据有三种落点，改动必须同时覆盖且不能丢内容：

| 形态 | 位置 | 现状 |
|---|---|---|
| 画布节点 | `canvases.yjs_update`（Yjs 二进制，节点在 `root.nodes` 的 `Y.Map` 里） | `type` / `imageUrl` / `aspectRatio` |
| 节点池卡片 | `node_cards.content`（`JSON.stringify(node)`） | 同上 |
| 图片 | 内联在 `imageUrl` / 卡片 content 里的 `data:` URL | 无独立文件 |

### 17.1 三类改动

| 代号 | 改动 | 落点 |
|---|---|---|
| **M1** | 节点结构：`type`/`imageUrl`/`aspectRatio` → `content`/`cover` | `yjs_update` 与 `node_cards.content` |
| **M2** | 图片落地：`data:` URL → `files` 表 + `/api/files/:id` | 同上 + 磁盘新增文件 |
| **M3** | 卡片元数据：DB 列 `type` 停用；新增 `source_manuscript_id` / `source_kind` | `node_cards` 表 |

「数据库方便存什么」的结论：**存短 URL，二进制落盘**。SQLite(better-sqlite3) 把 base64 存 TEXT 能跑，但每次读写都要整段搬运，库文件会随图片线性膨胀；`files` 表本来就是这个用途（`schema.ts:142`，含 filename/path/size/mimeType）。

### 17.2 顺序约束：M2 必须在 M1 之前

若先改结构，节点里会同时存在「老 base64 `<img>`」与「新 URL `<img>`」两种形态，改写逻辑要处理多态，且同一批文档要重写两次。先把图片抽出去，M1 就退化成字段搬移 + 字符串替换。

### 17.3 执行时机

`index.ts` 现有启动顺序：`initDatabase` → `initializeDb` → `migrateCanvasesToYjs` →（**在这里插入**）→ WS/REST `listen`。

必须在 `listen` 之前：此刻没有任何活跃 Y.Doc 房间（`canvas-state.ts` 的房间是懒加载的），改写不会与实时协作打架。

### 17.4 迁移账本（新增表）

```sql
applied_migrations (
  name TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
)
```
每个步骤一个 name：`202611-node-unify:images` / `:nodes` / `:cards`。重复启动直接跳过；比"猜内容形态"可靠，回滚时也有据可查。

### 17.5 安全网（改写前必做）

```sql
canvas_yjs_backup (
  canvas_id INTEGER PRIMARY KEY,
  yjs_update TEXT NOT NULL,
  created_at INTEGER NOT NULL
)
```
- 第一次改写某画布前写入（`INSERT OR IGNORE`），单画布只留一份原始态
- 观察期 7 天后清理
- 提供手动回滚脚本：按备份列还原 `yjs_update`

### 17.6 图片抽取规则（M2）

- 识别 `data:<mime>;base64,<payload>`；去重键 = `sha256(payload)`
- `files` 表加列 `sha256 TEXT UNIQUE`（列迁移沿用现有 PRAGMA 检测模式）
- 同 hash 已存在 → 复用其 id，不重复写盘
- 否则写 `UPLOAD_DIR/<sha256前16位>.<ext>` + 插表 → `/api/files/<id>`
- 超 5MB 的历史大图**不迁移，保留原 data URL** 并记日志，避免整批失败

### 17.7 结构与字段改写（M1，Y.Doc 与卡片 JSON 同规则）

```
for each node:
  if imageUrl 是 data URL  -> 抽取为 url + fileId
  if type === 'image' && imageUrl:
        content = `<img src="${url}" data-file-id="${id}">`
        cover   = url
  if content 内含 data: 图片 -> 逐个替换为 url
  delete type / imageUrl / aspectRatio
```

### 17.8 兼容期（迁移跑完仍保留一段时间）

- `shared` 提供 `normalizeNode(raw)`：有 `imageUrl` 无 `cover` 时补齐 `content`/`cover`
- 前端 store 读 localStorage 缓存（`nodeCache`）与后端 MCP 输出都过一遍
- 观察期确认无老形态后删除该函数

### 17.9 验证

1. **dry-run**：只统计不写——画布数 / 节点数 / 图片数 / 总字节 / 去重后文件数，先看量级
2. 抽样断言：随机 20 个画布，节点数一致、图片引用数一致、无 `data:` 残留
3. 冒烟：起容器 `curl /health`，打开一个含图画布，正文与缩略图都在
4. 回滚演练：先在数据库副本上跑一遍回滚脚本

### 17.10 分批与可观测

- 单画布一个事务；失败只跳过该画布并记日志，不中断全局
- 每 50 个画布打印一次 `migrated/total`
- 首次启动可能明显变慢（大库 + 大量图片），日志必须能看出进度，避免被误判为卡死

### 17.11 回滚边界

- 结构改写可回滚（备份列）
- **已落盘的图片不回滚**：文件留在磁盘，回滚后节点重新指向 base64；孤儿文件交给 GC
- 回滚脚本只还原 `yjs_update`，不碰 `files` 与磁盘

### 17.12 涉及文件（预估）

| 层 | 文件 |
|---|---|
| 迁移 | 新增 `backend/src/database/migrate-node-unify.ts`（照 `migrate-to-yjs.ts` 的骨架） |
| 表结构 | `backend/src/database/schema.ts`、`migration.ts`（加列/建表） |
| 文件服务 | 新增 `backend/src/controllers/file.controller.ts`；改 `upload.controller.ts` 返回短 URL |
| 文档读写 | `backend/src/websocket/yjs-schema.ts`（`writeEntityToYMap` 无需改，字段通用） |
| 兼容 | `shared/src/node.ts`（`normalizeNode`） |
| 前端 | `NodeItem.tsx`（`insertImage`）、`canvasExport.ts`、`createNodeFromCard.ts`、`nodeCache.ts` |
| 卡片 | `useNodePoolStore.ts`、`NodeCardItem.tsx`（读 `cover` 而非 `imageUrl`） |
---

## 18. 服务器 GC：清理孤儿数据

### 18.1 孤儿一定会产生

引入 `files` 表之后，图片与「引用它的文档」是两处存储，任何一个写入路径都可能单边失效：

| 场景 | 结果 |
|---|---|
| 用户从节点正文里删掉一张图 | 文件还在，没人引用 |
| 删节点 / 删画布 / 清空回收站 | 同上，且批量 |
| 协作中别人删掉了图，本地只是收到 diff | 同上，且没有"删除"这个动作可挂钩 |
| 同一张图被两个节点引用，删掉其中一个 | 不能删文件，但也没人记账 |
| 上传成功、写库失败 / 写库成功、插入正文前关页 | 文件在磁盘，DB 里可能连行都没有 |
| 迁移把 base64 抽成文件后，原节点被回滚 | 文件留下 |

### 18.2 为什么不用引用计数

`files.ref_count` 看起来最直接，但在这个项目里不可靠：

- 引用是**嵌在 HTML 字符串和 CRDT 文档里的**（`<img src="/api/files/12">`），不是外键。用户手改正文、撤销重做、协作合并都会绕过计数。
- Yjs 的 undo/redo 会让"删了又撤"来回振荡。
- 少减一次就泄漏，多减一次就**删掉还在用的图**——后者是不可接受的故障。

**结论：用标记-清扫（mark & sweep），不依赖写入路径自觉。**

### 18.3 方案：标记 → 宽限 → 回收站 → 清扫

三阶段状态机，`files` 表加列：

```sql
ALTER TABLE files ADD COLUMN sha256 TEXT;          -- 去重键（M2 引入）
ALTER TABLE files ADD COLUMN created_at INTEGER;   -- 已有
ALTER TABLE files ADD COLUMN orphaned_at INTEGER;  -- 首次判定为孤儿的时间
ALTER TABLE files ADD COLUMN deleted_at INTEGER;   -- 硬删除时间（行保留供审计）
```

| 阶段 | 动作 | 目的 |
|---|---|---|
| **标记** | 扫描全部引用源，算出 live set；不在 set 内、且 `created_at < now - 24h` 的文件置 `orphaned_at` | 宽限期避开"刚上传、还没插进正文"的窗口 |
| **回收站** | `orphaned_at` 超过保留期（默认 7 天）且再次扫描仍未命中 → 文件移入 `UPLOAD_DIR/.trash/`，置 `deleted_at` | 给误删/回滚留后路 |
| **清扫** | `deleted_at` 超过 7 天 → 删文件与本行 | 最终回收 |

每一步都可独立重跑；`--dry-run` 只打印不落盘。

### 18.4 引用源与提取规则

| 来源 | 读取方式 |
|---|---|
| `canvases.yjs_update` | 解码 Y.Doc → `root.nodes` 每个节点的 `content` 与 `cover` |
| `canvases` 在回收站的行 | **同样算作 live**（见 18.5） |
| `node_cards.content` | JSON 解析后取 `content` / `cover` / `thumbnail` |
| `manuscripts.content_html` | 直接正则扫描 |

提取：同时匹配两种形态——
- `src="/api/files/<id>"`（含绝对域名形式 `/api/files/<id>?v=...`）
- `data-file-id="<id>"`（防止 src 被外部改写后丢失归属）

### 18.5 必须处理的边界

1. **回收站里的画布不算死**。`canvas_recycle_bin` 有 `expires_at`，到期前用户可恢复；若把它们当死数据清扫，恢复后图片全裂。规则：回收站内一律视为 live，过期行被真正删除后才进入清扫视野。
2. **去重共享**。同一 `sha256` 被多份文档引用时，live set 是"文件 id 的集合"，天然只算一次——这正是引用计数最容易算错的地方。
3. **上传未落库**。宽限期覆盖；另外把上传流程改成"先插行（status=pending）→ 写盘 → 置 ready"，失败可被 GC 兜住。
4. **缩略图**。`canvases.thumbnail` / 卡片 `thumbnail` 目前是 data URL，不进 `files`，不参与 GC；若将来也落地，需加入扫描源。
5. **导出/导入**。导出的 JSON 里带的是 URL；如果用户导出后删了画布再导入，URL 对应的文件可能已被清扫。缓解：导出时把引用文件"钉住"（一个 `pinned_at` 列），或导出成内联 base64。**本期选择后者**（导出文件自包含，避免长期钉住）。

### 18.6 并发与安全阀

- **单实例互斥**：`gc_runs(id, started_at, finished_at, scanned, orphaned, deleted, bytes)`，用未结束行做锁，防止重叠执行。
- **时间水位线**：扫描开始时记 `T0`；只清扫 `created_at < T0 - 24h` 的文件。这样即便扫描期间有人插入新引用，也不会误删。
- **删除前二次确认**：对候选集再做一次 id 定向复查（只查这些 id 是否出现在任意引用源），确认后才进回收站。
- **硬性上限**：单次清扫若超过 `MAX_DELETE`（默认 500 个 / 1GB），中止并告警——异常大的数字通常意味着扫描漏了某个引用源，宁可停下。
- **只删不猜**：任何解析失败的文档（Yjs 解码失败、卡片 JSON 损坏）都当作"含未知引用"，**跳过整轮清扫**并告警。宁可留着垃圾，也不能删活图。

### 18.7 触发方式

| 方式 | 用途 |
|---|---|
| `npm run gc:files -- --dry-run` | 上线前看量级，只读 |
| `npm run gc:files` | 手动执行（部署窗口内） |
| 容器内 cron / 定时任务（可选） | 每晚跑一次；默认**不开启**，先手动观察一段时间再决定 |

不做 HTTP 管理端点，避免被未授权调用；运维走 CLI + 容器。

### 18.8 观测

每轮输出：扫描画布数 / 卡片数 / 手稿数、live 文件数、新判定孤儿数、回收站移入数、物理删除数与字节数、耗时。孤儿增长曲线是判断"某处引用没扫到"的唯一信号。

### 18.9 与迁移的顺序

- GC 只在 **M2 迁移完成之后**才有意义（之前没有 `files` 行可清）。
- 迁移自身产生的文件与节点引用是同一事务里写的，不会给 GC 制造假孤儿。
- 迁移的 `canvas_yjs_backup` 里含旧 base64，**不参与 GC**（它不引用 `files`），观察期结束后随备份表一起删。

---

## 19. 下一步（详细设计 → 实施）

已确认的边界：统一节点（无 `type`）、图床化必做、迁移必做、手稿不协作、路由只改根落点、采集只做粘贴（A）。

建议的实施顺序（每步可独立合并、可回滚）：

| 步 | 内容 | 依赖 |
|---|---|---|
| **P1** | `files` 表改造 + `/api/files` 上传/读取 + 上传接口返回短 URL（保留旧 data URL 兼容） | 无 |
| **P2** | 统一节点读取侧：`normalizeNode` + 渲染支持 `content` 内 `<img>` + `insertImage` 三入口 | P1 |
| **P3** | `migrate-node-unify`（M2 抽图 → M1 结构）+ dry-run + 备份表 + 回滚脚本 | P1、P2 |
| **P4** | GC 三阶段 + CLI + dry-run | P3 |
| **P5** | 手稿表与 CRUD + 笔记本页（左列表/中编辑区）+ 根路由切换 | 独立 |
| **P6** | 手稿 ⇄ 节点池转换（复制语义 + 溯源字段） | P5 |
| **P7** | 粘贴采集（A） | P5 |
| **P8** | 导出导入自包含（内联 base64） | P2 |
| **P9** | MCP 重构（独立大模块，排在节点模型定型后） | P2 |
---

## 20. 实施进度（2026-11-11）

| 步 | 内容 | 状态 |
|---|---|---|
| **P1** | `files` 表 + `/api/files` 上传/读取（sha256 能力 URL、去重、ETag） | ✅ 已实现（11 条测试） |
| **P2** | 统一节点读取侧：`normalizeNode` + `<img>` 白名单 + 粘贴/拖入/工具栏三入口 | ✅ 已实现（15 条归一化测试 + 守卫收紧） |
| **P3** | 迁移 M2→M1、dry-run、备份表、回滚 | ✅ 已实现（7 条测试 + CLI 冒烟） |
| **P4** | GC 三阶段 + CLI + 互斥 + fail-closed | ✅ 已实现（10 条测试 + CLI 冒烟） |
| **P5** | 手稿表/CRUD + 笔记本页 + 路由切换 | ✅ 已实现（API 16 + store 11 + 页面 6） |
| **P6** | 手稿 ⇄ 节点池（抄送语义 + 溯源列） | ✅ 已实现（含在 P5 的测试里） |
| **P7** | 粘贴采集（保留网页 HTML 结构并过白名单） | ✅ 已实现（页面测试覆盖） |
| **P8** | 导出导入自包含（内联 base64） | ⏳ 未做 |
| **P9** | MCP 整体重构 | 🔶 仅做了统一节点的收发兼容；按约定作为独立大模块另开 |

补充说明：

- `type` 字段：迁移后不再写入，老数据在读取侧由 `normalizeNode` 折成 content/cover。
- 卡片仍保留粗粒度 `type`（有图/无图），只为兼容节点池列表的缩略图样式。
- 迁移与 GC 都必须在 HTTP/WS `listen` 之前完成（迁移），GC 则走 CLI，不给 HTTP 端点。
- 已知待补：导出文件目前仍带 `/api/files/...` 短 URL，跨实例导入会裂图（P8）。