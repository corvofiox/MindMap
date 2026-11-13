# E2E（真实浏览器）

两个脚本，都是用 headless Edge + CDP 驱动**真实页面**、对着**真实运行的服务**跑：

| 脚本 | 定位 |
|---|---|
| `full-flow.mjs` | **全量模拟用户**：注册 → 项目 → 画布 → 节点池 → 笔记本 → 退出/再登录，23 个检查点 |
| `ui-smoke.mjs` | 更早的冒烟：登录、手稿、图片粘贴与持久化（图片那条是 full-flow 没覆盖的） |

## full-flow.mjs 覆盖什么

| 步骤 | 断言 |
|---|---|
| 未登录访问 `/` | 落到 `/login` |
| 注册新账号 | 落在 `/projects`（主页面就是项目列表） |
| 项目页顶栏 | 笔记本入口在「搜索/协作/设置/账号」那一批的最左，且与工具按钮之间有分隔线 |
| 新建项目 → 点项目卡片 | 进的是**真实画布** `/canvas/<id>`，不是 `/canvas/new` 那种空页 |
| 画布建节点 | 节点落在点击位置、且在视口内 |
| 画布富文本 | 加粗 / 标题 2 / 颜色三种格式都真的写进 `<h*>` 与 `color`，且点工具栏不会退出编辑 |
| 节点池 | 标题与「从笔记本导入」同一行；能新建文件夹 |
| 笔记本 | 新建手稿、输入、自动保存显示「已保存」、加粗生效 |
| 文件夹 | 新建「素材」→ 在其下新建「配色」→ 把手稿移进「素材」→ 删「素材」后「配色」上移一层、手稿变未归档 |
| 搜索 | 搜不到给空态文案，搜得到命中 |
| 双向导入 | 手稿送入节点池 → 从节点池导入里能看到、悬浮出预览、点一下还原成手稿 |
| 顶栏与弹窗 | 思维导图回 `/projects`、左上角 logo 回 `/projects`、Ctrl+K 命令面板是中文、设置/账号设置弹窗能开且 Esc 能关 |
| 退出 → 再登录 | 回到 `/projects`，刷新后项目与画布节点都还在 |

## 前置条件

1. **服务在跑，并且托管了构建好的前端**
   ```bash
   npm run build:frontend
   # backend 启动时会托管 frontend/dist；示例：
   NODE_ENV=production PORT=8000 WS_PORT=8000 DB_FILE=./mindmap.db \
     CSRF_SECRET=xxx JWT_SECRET=xxx ALLOWED_ORIGINS=http://127.0.0.1:8000 \
     node --import tsx backend/src/index.ts
   ```

   ⚠️ **`NODE_ENV=production` 时必须给 `CSRF_SECRET`**：缺了它 `/api/csrf-token` 直接 500，
   登录/注册全部卡住，而页面看起来只是"点了没反应"。

2. **headless Edge 带 CDP 启动**
   ```bash
   msedge --headless=new --remote-debugging-port=9223 \
     --user-data-dir=<临时目录> about:blank
   ```

3. `full-flow.mjs` 每次运行都会注册一个新账号（`e2e+<时间戳>@mindmap.local`），
   所以不需要预先准备账号，也不会污染已有数据。

## 运行

```bash
node e2e/full-flow.mjs
E2E_BASE=http://127.0.0.1:8000 E2E_CDP=http://127.0.0.1:9223 node e2e/full-flow.mjs

npm run e2e:ui           # ui-smoke（需要预先存在的账号与画布）
```

截图与 `*-results.json` 落在 `e2e/.tmp/`（已 gitignore）。

## 几个别踩的坑

- **必须 `Emulation.setDeviceMetricsOverride`**：headless 默认视口 500×320，布局会塌陷，坐标点击全部错位。
- **导航后不能只等 `location.pathname`**：`Page.navigate` 会先提交 URL，此时 DOM 还是上一页，
  后续选择器全部落空。要等页面特有的元素（`goto(url, readyExpr)`）。
- **原生 `prompt`/`confirm` 必须先排应答再点按钮**：弹窗在点击时就同步阻塞，
  点完再 push 只能拿到空答复（新建文件夹会静默失败）。
- **画布内容在失焦时才提交**：粘贴完图片要点别处（用页头空白，别点画布，画布内点击会新建节点）。
