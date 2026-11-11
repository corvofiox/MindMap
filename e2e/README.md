# E2E（真实浏览器）

`ui-smoke.mjs` 用 headless Edge + CDP 驱动**真实页面**，对着**真实运行的服务**跑一遍关键用户路径：

| 步骤 | 断言 |
|---|---|
| 登录 | 落在 `/notebook`（而不是旧的 `/projects`） |
| 新建手稿 → 输入标题/正文 | 800ms 防抖后显示「已保存」 |
| 送入节点池 | 出现成功提示 |
| 画布选中「节点」工具并点击 | 真的创建出节点 |
| 双击正文 → 粘贴图片 | 正文出现 `/api/files/...` 的 `<img>`，且图片加载成功（`naturalWidth > 0`） |
| 失焦提交 → 清本地缓存 → 重进画布 | 图片仍在（证明是服务端持久化，不是本地缓存） |
| 笔记本「从节点池导入」 | 卡片能还原成手稿并打开 |

## 前置条件

1. **服务在跑，并且托管了构建好的前端**
   ```bash
   npm run build:frontend
   # backend 启动时会托管 frontend/dist；示例：
   DB_FILE=./e2e.db PORT=3010 WS_PORT=3011 JWT_SECRET=x JWT_EXPIRES_IN=1h \
     node --import tsx backend/src/index.ts
   ```

2. **有一个测试账号和一块画布**
   - 账号默认 `e2e@test.local` / `E2ePassw0rd!`（可用 `E2E_EMAIL` / `E2E_PASSWORD` 覆盖）
   - 画布默认 `id=1`（可用 `E2E_CANVAS_ID` 覆盖）。账号下需要有这个画布，否则画布相关步骤会失败。

3. **headless Edge 带 CDP 启动**
   ```bash
   msedge --headless=new --remote-debugging-port=9222 \
     --user-data-dir=/tmp/edge-e2e --window-size=1280,820 about:blank
   ```

## 运行

```bash
npm run e2e:ui
# 或
E2E_BASE=http://127.0.0.1:3010 E2E_EMAIL=who@x E2E_PASSWORD=... node e2e/ui-smoke.mjs
```

截图与 `results.json` 落在 `e2e/.tmp/`（已 gitignore）。

## 两个别踩的坑

- **必须 `Emulation.setDeviceMetricsOverride`**：headless 默认视口 500×320，布局会塌陷，坐标点击全部错位。
- **画布内容在失焦时才提交**：粘贴完图片必须点别处（用页头空白，别点画布，画布内点击会新建节点），否则内容还没进 store，自然也不会保存。
