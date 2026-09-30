# styling-station 实现计划（AI 搭配台）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/specs/2026-09-30-styling-station-design.md` 实现本地 Web「AI 搭配台」：素材库/样板库/预设/搭配台/记录，出图走 qodercli harness + ImageGen。

**Architecture:** 单仓库、Node ≥18 ESM 零第三方依赖。`server/` 为 HTTP+SSE 服务（路由手写、存储 JSON 文件、出图任务队列并发上限 2、子进程调 qodercli）；`web/` 为纯静态前端（原生 JS ES modules + hash 路由）。规格文中所有接口/字段/文案为最终契约，本计划只补充实现落点与测试方式。

**Tech Stack:** Node 20（系统现有 v20.9.0）、node:test、原生 fetch/EventSource、spawn、fs/promises。

**Spec:** `docs/specs/2026-09-30-styling-station-design.md`（实现者必读）

## Global Constraints

- Node ≥18、ESM、**零第三方依赖**（不装任何包；`node_modules` 不出现）。
- Windows 优先：路径用 `node:path`；杀进程树用 `taskkill /T /F`；批处理 `.bat` 用 CRLF 也可，仓库统一 LF（git 已配 autocrlf 警告可忽略）。
- 端口默认 4584；监听 `0.0.0.0`；无登录、无 CORS 头。
- 出图子进程环境必须剔除 `QODER_AGENT_SDK_ENTRYPOINT` 与 `GIT_EXEC_PATH`（复用 web-ask 的 `buildCliEnv`）。
- 所有面向用户的文案为中文；id 前缀 m-/t-/p-/r-。
- 数据目录 `server/data/`（gitignore）；写入一律「临时文件 + rename」。
- 测试：`node --test server/test/`；真实出图仅做一次人工验收，不进入自动测试。
- 复用来源：`D:\project\web-ask\server\lib\qodercli.mjs`、`ai-stream.mjs`、`sse.mjs`（拷贝后按本项目需要微调）。

---

### Task 1: 服务骨架（HTTP 框架 + 静态服务 + health）

**Files:**
- Create: `server/settings.mjs`、`server/lib/http.mjs`、`server/server.mjs`、`server/test/helpers.mjs`、`server/test/health.test.mjs`、`start.bat`
- Create: `server/test/fixtures/`（空目录占位，Task 9 用）

**Interfaces:**
- Produces:
  - `loadSettings(dataDir)` → `{ port:4584, maxConcurrent:2, renderTimeoutMs:300000, maxUploadMB:10, keepWorkDirs:false, qodercliPath:"qodercli" }`（文件不存在则写默认值）
  - `createServer({ dataDir, settings })` → `{ listen(port) → Promise<httpServer>, close(), port }`；`server.mjs` 直接运行时 `createServer({dataDir: <server/data>}).listen(settings.port)`
  - `http.mjs`: `json(res, code, obj)`、`readJsonBody(req, maxBytes)`（返回解析对象，超限抛 `HttpError`）、`class HttpError extends Error { code, status, message }`、`sendError(res, err)`
  - `helpers.mjs`（测试用）: `startTestServer({ settingsPatch })` → `{ base, close, dataDir }`（临时目录 + 端口 0）

- [ ] Step 1: 写失败测试 `health.test.mjs`：起服务 → `GET /api/health` 返回 `{ok:true, version, port, queue:{running:0,pending:0}}`；`GET /` 返回 index.html 内容（Task 11 前可先断言 200 或占位 HTML）；未知路径 404 JSON。
- [ ] Step 2: 跑测试确认失败（模块不存在）。
- [ ] Step 3: 实现 `settings.mjs` / `http.mjs` / `server.mjs`（手写路由表：精确路径 + `:param` 通配；静态服务仅暴露 `web/` 且 `..` 拒绝；MIME 表 html/js/css/png/jpg/webp/svg）。`server.mjs` 同时导出 `createServer`（供测试）并以 `import.meta.url` 判定是否作为主模块启动。
- [ ] Step 4: 跑测试通过；`start.bat` 写 `node "%~dp0server\server.mjs"` 并 `pause`。
- [ ] Step 5: Commit `feat: server skeleton with health endpoint and static hosting`。

### Task 2: store.mjs（JSON 存储 + 原子写 + 软删）

**Files:**
- Create: `server/lib/store.mjs`、`server/test/store.test.mjs`

**Interfaces:**
- Produces: `createStore({ dataDir })` →
  - 通用：`newId(prefix)`（`<prefix>-<yyyyMMddHHmmss>-<4 hex 随机>`）
  - materials/templates：`list(kind, {scene, tags[], q, includeDeleted, limit, offset})`、`create(kind, {name, description, scene, tags})`、`get(kind, id)`、`update(kind, id, patch)`、`remove(kind, id)`（软删）、`undelete(kind, id)`、`addImage(kind, id, meta)`、`removeImage(kind, id, index)`（剩 1 张抛 400；删主图则余下首张变主图）
  - presets：`createPreset({name, templateId, slots})`（slot id `s-<n>` 服务端生成）、`listPresets({q, includeDeleted})`、`getPreset(id)`、`updatePreset(id, patch)`、`removePreset(id)`、`undeletePreset(id)`、`duplicatePreset(id)`
  - renders：`createRender(doc)`、`getRender(id)`、`updateRender(id, patch)`、`listRenders({templateId, materialId, limit, offset})`（倒序）、`renderChildren(parentId)`
  - 聚合：`scenes()`（预置「首饰/瓷砖/服装鞋帽/其他」∪ 库中已用）、`tags(kind)`
  - 校验失败抛 `HttpError`（400，中文 message）。
- 存储布局：`data/library.json` = `{materials:{}, templates:{}, presets:{}, scenes:[...]}`；`data/renders.json` = `{renders:{}}`；**每次写盘用 `store.save()` 统一 flush（变更后调）**，写临时文件 `.tmp` 后 `rename`。

- [ ] Step 1: 测试：create/get/update 字段校验（name 空→400、tags 去重限 20、preset slots 1~10 边界）；软删后 list 不返回、includeDeleted 返回、undelete 恢复；原子写（写后文件存在且可再读）；removeImage 边界。
- [ ] Step 2: 确认失败。
- [ ] Step 3: 实现 store.mjs（内部两个 JSON 惰性加载 + `flush(file)`）。
- [ ] Step 4: 测试通过。
- [ ] Step 5: Commit `feat: JSON store with atomic writes and soft delete`。

### Task 3: images.mjs（尺寸解析 + 出图尺寸映射）

**Files:**
- Create: `server/lib/images.mjs`、`server/test/images.test.mjs`

**Interfaces:**
- Produces: `SUPPORTED_SIZES = ['1024x1024','1536x1024','1024x1536','768x1024','1024x768','1024x1280','1280x1024','1024x1792','1792x1024','2560x1080']`；`imageDimensions(buf)` → `{type:'png'|'jpeg'|'webp', width, height}` 或 `null`（只读头部：PNG IHDR；JPEG 扫 SOF0/2；WEBP `RIFF....WEBP` + VP8/VP8L/VP8X 分支）；`pickRenderSize(w, h)` → 比值差最小、平手取面积小者。
- 测试助手（放 helpers）：`pngBuf(w, h)` 造最小可解析 PNG 头。

- [ ] Step 1: 测试：各类型头解析正确；`pickRenderSize` 逐档（1:1→1024x1024、3:2→1536x1024、16:9→1792x1024、3:4→768x1024、9:16→1024x1792 等）+ 异常输入回退 1024x1024。
- [ ] Step 2: 确认失败 → Step 3 实现 → Step 4 通过。
- [ ] Step 5: Commit `feat: image header parsing and render size mapping`。

### Task 4: upload.mjs（multipart 解析 + 图片校验）

**Files:**
- Create: `server/lib/upload.mjs`、`server/test/upload.test.mjs`

**Interfaces:**
- Produces: `parseMultipart(req, { maxBytes, field = 'file' })` → `Promise<{ filename, contentType, data:Buffer }>`（按 boundary 流式收集，仅保留目标字段；超限抛 400 `文件过大`；非 multipart 抛 400）；`validateImage(buf, { maxBytes })` → `{ type, width, height }`（magic 校验 jpg/png/webp；尺寸解析复用 images.mjs；不合法抛 400 中文原因）。
- 测试助手：`multipartBody(boundary, filename, contentType, buf)` 造请求体，用 `http.request` 对临时 express-less server 或对 parseMultipart 用 duck-type 的 req 流（`Readable.from([...buffers])` + headers）——采用后者更简。

- [ ] Step 1: 测试：正常解析出 buffer 与文件名；超限抛错；boundary 缺失/格式非法抛错；二进制含 CRLF 内容不截断；validateImage 对伪扩展名（.png 但 JPEG 头）给出真实类型、对垃圾数据抛错。
- [ ] Step 2: 确认失败 → Step 3 实现 → Step 4 通过。
- [ ] Step 5: Commit `feat: zero-dependency multipart upload with magic validation`。

### Task 5: 素材 / 样板 API + /api/scenes

**Files:**
- Modify: `server/server.mjs`（挂路由）、`server/lib/http.mjs`
- Create: `server/test/library-api.test.mjs`

**Interfaces:**
- Consumes: store（Task 2）、upload/images（Task 3/4）。
- Produces（契约见 Spec §5.2）：
  - `GET/POST /api/materials`、`GET/PUT/DELETE /api/materials/:id`、`POST /api/materials/:id/undelete`、`POST /api/materials/:id/images`（multipart→写 `data/files/materials/<id>/<n>.<ext>` + store.addImage）、`DELETE /api/materials/:id/images/:index`（同时删文件）
  - templates 同构（`data/files/templates/...`）
  - `GET /api/scenes` → `{scenes, tags:{materials, templates}}`
  - 过滤：`?scene=&tags=a,b`（AND）`&q=&includeDeleted=0&limit=&offset=`

- [ ] Step 1: 集成测试（startTestServer）：建→改→查→筛选（tags AND、q）→软删→恢复；上传 PNG 后 items.images[0] 含 width/height/primary，文件真实落盘；删图边界（剩 1 张拒绝）；无图素材出参 `hasImage:false`（前端角标用，列表出参附 `hasImage`）。
- [ ] Step 2: 确认失败 → Step 3 实现 → Step 4 通过。
- [ ] Step 5: Commit `feat: materials and templates API with image upload`。

### Task 6: 预设 API

**Files:**
- Modify: `server/server.mjs`
- Create: `server/test/presets-api.test.mjs`

**Interfaces:**
- Produces（Spec §5.3）：`GET/POST /api/presets`、`GET/PUT/DELETE /api/presets/:id`、`/undelete`、`/duplicate`；出参附 `templateValid:boolean`（样板存在且未删）与 `template`（轻量：id/name/images/primary），供列表缩略图。

- [ ] Step 1: 集成测试：建（含 2 插槽）→ 查（templateValid true）→ 改 slots（整体替换、id 重生成保持顺序）→ duplicate → 样板软删后 templateValid false → 删除/恢复；slots 超 10/空数组 → 400。
- [ ] Step 2: 确认失败 → Step 3 实现 → Step 4 通过。
- [ ] Step 5: Commit `feat: presets API`。

### Task 7: matcher + auto-recommend + auto-fill

**Files:**
- Create: `server/lib/matcher.mjs`、`server/test/matcher.test.mjs`；Modify: `server/server.mjs`

**Interfaces:**
- Produces: `rankMaterials({ baseTags, scene, materials, limit })` → `[{ materialId, score }]`（打分规则严格按 Spec §7；无图素材剔除；同分 updatedAt 新者先）；`POST /api/renders/auto-recommend {templateId, limit=6}` → `{recommended, candidates}`；`POST /api/presets/:id/auto-fill` → `{slots:[{slotId, recommended, candidates}]}`（无命中 recommended=null，candidates 按同场景兜底排序）。

- [ ] Step 1: 单测打分（命中×2、同场景+1、描述+0.5、排序、剔除无图）＋集成测试两个端点（含无命中插槽 recommended:null）。
- [ ] Step 2: 确认失败 → Step 3 实现 → Step 4 通过。
- [ ] Step 5: Commit `feat: tag matcher and auto recommend/fill endpoints`。

### Task 8: prompt.mjs（出图任务说明组装）

**Files:**
- Create: `server/lib/prompt.mjs`、`server/test/prompt.test.mjs`

**Interfaces:**
- Produces: `SYSTEM_PROMPT`（Spec §6.3 全文，逐字）；`buildTaskPrompt({ mode, template, entries, positionNote, size, candidateCount })`，`entries = [{material, slotName|null, slotPosition|null}]`（Spec §6.2 结构：图1=样板；图2..N=素材带插槽名/位置说明；空说明写「（空，由你按常识自动布位）」；输出要求含尺寸与张数）。
- 文本输入截断：描述 ≤500、单标签 ≤20 已在 store 校验；assert 中再兜底 `truncate(s, n)`。

- [ ] Step 1: 单测：free 模式含样板/素材/尺寸/张数；preset 模式含插槽名与插槽位置说明；空 positionNote 的兜底文案；SYSTEM_PROMPT 含「只输出每张图片的绝对路径」。
- [ ] Step 2: 确认失败 → Step 3 实现 → Step 4 通过。
- [ ] Step 5: Commit `feat: prompt assembly for free and preset modes`。

### Task 9: renderer.mjs + jobs.mjs + stub CLI 夹具

**Files:**
- Create: `server/lib/renderer.mjs`、`server/lib/jobs.mjs`、`server/test/fixtures/fake-qodercli.mjs`、`server/test/renderer.test.mjs`、`server/test/jobs.test.mjs`
- Modify: `server/lib/ai-stream.mjs`（拷贝自 web-ask 后新增 `tool_use` 里 `name==='ImageGen'` 的 `{type:'image-tool'}` 透出可选——不需要则保持原样并仅在 renderer 内统计 tool 次数）；拷贝 `qodercli.mjs` 与 `sse.mjs`。

**Interfaces:**
- Produces:
  - `renderer.runRender({ settings, renderId, workDir, attachments, taskPrompt, onEvent, registerChild })` → `Promise<{ ok, images:[absPath], sessionId, elapsedMs, exitCode, stderrTail }>`；spawn 参数严格按 Spec §6.1（`--tools ImageGen`、`--permission-mode=default`、`--strict-mcp-config --mcp-config '{"mcpServers":{}}'`、`--cwd workDir`、逐附件 `--attachment`、`--output-format=stream-json`）；env 用 `buildCliEnv`；收图 = 扫描 `workDir/vibe_images/*.png`（mtime 序）+ 解析 result 文本绝对路径去重；超时 `settings.renderTimeoutMs` 杀树。
  - `jobs.createJobs({ store, settings, renderer })` → `{ submit(renderDoc) → id, stop(id), get(id), subscribe(id, fn) → unsub, stats(), restartCleanup() }`：内存 Map 状态机（queued→running→done|error|stopped），并发 2 排队，**每步同步 store.updateRender**，事件经内部 emitter 广播 `{event, data}`（SSE 用）；stop 排队中=直接出队置 stopped；运行中=杀树。
  - `fake-qodercli.mjs`：解析 `--cwd/--attachment/-p`；输出 stream-json（system init → assistant thinking → assistant tool_use ImageGen → 写 `vibe_images/out-<n>.png`（内嵌 1x1 真 PNG，或由 `FAKE_PNG_SIZE` 环境变量控制尺寸头）→ assistant text=路径 → result line `{type:'result', result:'<路径>', is_error:false}`）；可用 `FAKE_FAIL=1` 模拟非零退出且无图。

- [ ] Step 1: renderer 测试：指向 fixture（`settings.qodercliPath` 设为 fixture 路径，node 直跑）断言 args 组装（含 --tools ImageGen、附件数）、收图 1 张、sessionId 捕获；`FAKE_FAIL=1` → ok:false + stderrTail。
- [ ] Step 2: jobs 测试：连续提交 3 个任务 → 第 3 个先 queued（queuePosition 1）后 running；subscribe 收到 status/result/done 序列；stop 排队中任务；restartCleanup 将 queued/running 置 stopped。
- [ ] Step 3: 确认失败 → Step 4 实现 renderer/jobs → Step 5 通过。
- [ ] Step 6: Commit `feat: renderer and job queue with stub-CLI tests`。

### Task 10: renders API + SSE（自由 / 预设双模式全链路）

**Files:**
- Modify: `server/server.mjs`
- Create: `server/test/renders-api.test.mjs`

**Interfaces:**
- Produces（Spec §5.4）：
  - `POST /api/renders`：free（`mode:"free", templateId, materialIds[], positionNote, candidateCount`）/ preset（`mode:"preset", presetId, assignments[{slotId,materialId}], positionNote, candidateCount`）；校验按 Spec；创建记录（快照拼装，preset 场景把 slot 名/位置说明写入 materialsSnapshot 与 prompt entries）→ jobs.submit 入队 → `{renderId}`
  - `GET /api/renders/:id/stream`（SSE：snapshot/delta/status/result/error/done + 心跳，snapshot 回放已发生事件——jobs 保留每任务事件缓冲数组）
  - `POST /api/renders/:id/stop`；`POST /api/renders/:id/rerun {materialIds?|assignments?, positionNote?, candidateCount?}`；`POST /api/renders/:id/results/:index/chosen {chosen}`；`GET /api/renders?...`、`GET /api/renders/:id`（含 `childrenIds`）
  - 收图落盘：`data/files/renders/<id>/v<k>.png` 由 jobs 完成后搬运（扫描 workDir/vibe_images）+ 每张完成时 `result` 事件即时推（实现按「run 结束统一收图」+「result 文本中出现路径即先推」双路，简化：run 结束收图后逐张推 result 事件，再 done；与 Spec 允许一致）
  - workDir 清理：`keepWorkDirs:false` 时 done 后删 `data/work/<id>`。

- [ ] Step 1: 集成测试（全走 fake CLI）：free 全链路（建素材/样板+传图 → 提交 → SSE 收 snapshot/status/result/done → 记录 done 且 v1.png 存在）；preset 全链路（断言 prompt 传入含插槽位置说明——fake CLI 把 `-p` 落盘到 cwd 供断言）；校验失败分支（无图素材 400、插槽缺素材 400、板失效 400）；stop；rerun 生成 child；chosen 单选。
- [ ] Step 2: 确认失败 → Step 3 实现 → Step 4 通过。
- [ ] Step 5: Commit `feat: renders API with SSE streaming and dual modes`。

### Task 11: 前端骨架 + 素材库 / 样板库视图

**Files:**
- Create: `web/index.html`、`web/style.css`、`web/app.js`、`web/lib/api.js`、`web/lib/dom.js`、`web/views/materials.js`、`web/views/templates.js`

**Interfaces:**
- `api.js`: `api.get(path)`/`api.post(path, body)`/`api.put`/`api.del`/`api.upload(path, file)`（FormData）+ `streamRender(renderId, {onEvent})`（EventSource，返回 close）
- `app.js`: hash 路由（`#/materials|templates|presets|studio|renders`），`registerView(name, {render(container)})`，顶部 Tab 栏 + `#view` 容器；`dom.js`: `el(tag, props, children)`、`toast(msg)`、`confirmDialog(msg)`、`modal({title, body, onOk})`、`tagInput(value, onChange)`（chips 输入）、`imageUploader(...)`（多图上传 + 主图标记 + 拖拽）
- `materials.js/templates.js`（同构工厂 `createLibraryView(kind)`）：筛选栏（场景下拉来自 `/api/scenes`、标签 chips、搜索、显示已删除）+ 卡片网格（主图、名称、场景、标签、待传图角标、编辑/删除/恢复）+ 编辑弹窗（字段 + 上传区）。

- [ ] Step 1: 无自动测试；实现后启动服务，用浏览器（browser-use evaluate_script，参见 web-ask 经验）冒烟：创建素材→传图→筛选→改→删。
- [ ] Step 2: Commit `feat: web shell with materials and templates views`。

### Task 12: 预设视图

**Files:**
- Create: `web/views/presets.js`；Modify: `web/app.js`（注册路由）

**Interfaces:**
- 列表（名称、样板缩略图、插槽数、编辑/复制/删除、失效角标）+ 编辑器弹窗：选样板（复用库选择器的简化版：筛选+卡片单选）+ 插槽列表（每行：名称输入、标签 chips、位置说明输入、上移/下移/删除）+「添加插槽」（1~10 限制提示）。

- [ ] Step 1: 浏览器冒烟：建预设（2 插槽）→ 编辑排序 → 复制 → 删除。
- [ ] Step 2: Commit `feat: presets view with slot editor`。

### Task 13: 搭配台（自由 + 预设双模式）

**Files:**
- Create: `web/views/studio.js`；Modify: `web/app.js`

**Interfaces:**
- 顶部模式切换；自由模式三栏（样板选择 / 素材多选含筛选与立即上传与自动推荐 / 位置说明+张数+出图）；预设模式（选预设 → 样板预览 + 插槽卡片列表 + 抽屉选素材（按插槽标签预筛选）+ 一键自动填充 + 补充说明）；提交后经 `streamRender` 展示排队/进度（thinking 折叠）/候选图逐张出现（大图、选用、下载、再出一版）。
- 状态在内存 store（切换 Tab 保留当前选择）。

- [ ] Step 1: 浏览器冒烟（配 fake CLI 的本地服务）：自由模式出图全流程 + 预设模式一键填充出图 + 再出一版。
- [ ] Step 2: Commit `feat: studio view with free and preset modes`。

### Task 14: 记录视图

**Files:**
- Create: `web/views/renders.js`；Modify: `web/app.js`

**Interfaces:**
- 列表（缩略图、样板名/预设名、素材数、时间、状态、筛选 by templateId/materialId）；详情（快照明细、候选图、选用标记、版本链父子跳转、停止、再出一版、下载）。

- [ ] Step 1: 浏览器冒烟：从 Task 13 产生的记录进入详情、标记选用、再出一版、查看版本链。
- [ ] Step 2: Commit `feat: renders view with version chain`。

### Task 15: 部署收尾 + 真实 e2e 验收

**Files:**
- Create: `backup.bat`、`README.md`；Modify: `start.bat`（打印内网 IP 与解析结果）、`server/server.mjs`（启动日志同内容）

**Interfaces:**
- `start.bat`/server 启动输出：端口、`http://<ip>:4584`、qodercli 解析结果、数据目录、并发上限。
- README：启动、防火墙放行（`netsh advfirewall firewall add rule name="styling-station" dir=in action=allow protocol=TCP localport=4584`）、备份、排障（stderrTail/日志位置、凭据前提=本机 qodercli 已登录）。

- [ ] Step 1: `node --test server/test/` 全绿。
- [ ] Step 2: 真实 e2e（人工验收，一次）：用 `/tmp/harness-probe` 的两张图（花瓶素材 + 北欧餐桌样板，或自备）经真实 UI/接口跑一次出图，确认：约 30s 出图、记录落盘、页面可看候选图。
- [ ] Step 3: README/backup.bat 手工验证（备份产出目录）。
- [ ] Step 4: Commit `feat: deployment scripts, README and e2e acceptance`。

---

## Self-Review 记录

- **Spec 覆盖**：§3 目录→T1/T5/T9/T11；§4 模型→T2（含 preset）；§5.1→T1/T5；§5.2→T5；§5.3→T6/T7；§5.4→T10；§5.5→T4；§6.1→T9；§6.2/6.3→T8；§6.4→T3；§6.5→T9/T10；§7→T7；§8→T11~T14；§9→T1/T15；§10→各任务测试+stub 全链路；§11 M1~M5↔T1-5/T6-8/T9-10/T11-14/T15；§12→T9(超时杀树)/T15(README)。
- **类型一致性**：`rankMaterials`、`buildTaskPrompt(entries)`、`jobs.submit/subscribe`、`streamRender` 在上下游任务签名一致；store 的 `list(kind,...)`/`create(kind,...)` 与 API 层一致。
- **无占位符**：所有步骤含具体命令或代码落点；UI 视图以「结构+交互清单」给出（实现细节留实现时的 DOM 组装，验收靠浏览器冒烟）。
