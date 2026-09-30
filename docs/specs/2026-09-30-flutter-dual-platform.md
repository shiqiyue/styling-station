# styling-station 增补规格：Flutter 双端前端（Web + Android）

- 日期：2026-09-30
- 状态：已实施（验收通过，见 §7）
- 关系：本文是 `2026-09-30-styling-station-design.md` 的前端形态增补；后端（Node 服务 / JSON API / SSE / 数据文件）不变，仅 4 处小改（§6）。
- 范围：把原生 JS SPA（`web/`，约 2900 行）重写为 **Flutter** 一套代码，同时产出 **Android APK** 与 **Web 构建产物**。

## 1. 背景与决策

旧前端只能跑在浏览器里。诉求：同一套界面既能编译成安卓 App 直接装到手机，又能作为网页在内网访问。

| 决策点 | 结论 | 说明 |
|---|---|---|
| 技术路线 | Dart + Flutter 重写（非 WebView 套壳、非 React Native） | 一套代码双端产物；原生控件体验 |
| Web 端 | 也用 Flutter 构建产物 | Node 服务优先托管 `app/build/web`；旧 `web/` 保留可回滚 |
| 服务器地址 | 写 `app/.env`，**编译期注入**（`--dart-define-from-file`） | Web 由服务自身托管天然同源，无需地址；Android 必须内置地址 |
| 后端 | 完全保持 | 仅新增静态托管探测与 MIME 补全 |

## 2. 目录结构（新增 `app/`）

```
app/
├── .env / .env.example        # SERVER_URL=http://<内网IP>:4584（.env 不入库）
├── lib/
│   ├── main.dart              # MaterialApp + 配置缺失错误页
│   ├── shell.dart             # 五 Tab 壳：窄屏 NavigationBar / 宽屏 NavigationRail，视图懒创建
│   ├── config.dart            # dart-define 读取 + 同源/远程 URI 解析（纯函数可测）
│   ├── theme.dart             # 复刻 style.css 设计变量（同色板、圆角 12）
│   ├── hash_route*.dart       # Web hash 路由（`#/renders/<id>`）；非 Web 空实现
│   ├── download*.dart         # Web 候选图下载（a[download]）；非 Web 空实现
│   ├── data/
│   │   ├── models.dart        # 素材/样板/预设/记录/快照模型与宽松解析
│   │   ├── api_client.dart    # 全部端点封装、错误映射、multipart 上传（字段 file）
│   │   └── sse*.dart          # SSE：Android dart:io 流式解析（断线 2s 重连）/ Web EventSource
│   ├── state/                 # ChangeNotifier 状态（无 provider 依赖）
│   ├── widgets/               # 弹窗/toast/标签输入/图片选择/候选卡片/空状态等
│   └── views/                 # library / presets / studio(+render_panel) / renders
├── assets/fonts/              # 思源黑体 CN SubsetOTF Regular+Bold（OFL-1.1，断外网中文正常）
├── assets/icon/               # 应用图标源图（flutter_launcher_icons 生成 mipmap + Web 图标）
└── test/                      # 单测与冒烟（模型/错误映射/SSE 帧/路由/列表与详情）
```

根目录新增 `build-android.bat`、`build-web.bat`（GBK + CRLF，见 `.gitattributes`）。

## 3. 关键机制

- **配置注入**：`String.fromEnvironment('SERVER_URL')`；Web 空值 → 同源相对路径；Android 空值 → 启动即错误页（fail fast，提示改 `app/.env` 重新打包）。
- **SSE 双实现**：条件导出（`export 'sse_web.dart' if (dart.library.io) 'sse_io.dart'`）；帧解析为纯函数（`sse_frames.dart`，单测覆盖六事件+心跳+半包）；Android 断开 2s 重连，Web 依赖 EventSource 自动重连（服务端重连即补发快照）。
- **出图面板**：六事件（snapshot/delta/status/result/error/done）；delta 节流合并（250ms）；跨 Tab 保留长连（壳层 IndexedStack 懒创建 + 状态保留）；事件流不可用时降级 2s 轮询。
- **记录页面**：列表 20 条分页 + `?template=&material=` 筛选；详情未完成任务用 SSE 事件触发 400ms 节流重取；版本链取子记录展示状态与时间；Web 端 hash 双向同步（深链/前进后退），Android 内部状态导航。
- **平台差异**：下载按钮仅 Web 显示；Web 上传即 `<input type=file multiple>`（无相机/画质参数），Android 走系统照片选择器（支持相机、多选与丢帧恢复）。
- **安卓清单**：`INTERNET` 权限（release 默认不含）+ `android:usesCleartextTraffic="true"`（内网 HTTP）。
- **Web 引导本地化**：`web/index.html` 内联 loader 指定本地 `canvasKitBaseUrl`、`fontFallbackBaseUrl`，关闭 Service Worker（防旧产物缓存）；`--no-web-resources-cdn` 构建。

## 4. 构建链（重建前端时）

1. 工具链：Flutter SDK（本机 `D:\flutter`）、JDK 17、Android SDK；国内镜像变量 `PUB_HOSTED_URL` / `FLUTTER_STORAGE_BASE_URL`，Gradle 发行包与 Maven 仓库已换成国内镜像（`app/android/**`）。
2. Web：`build-web.bat` → `app/build/web` → 重启服务即生效；**回滚** = 删除或改名 `app/build/web` 后重启（服务自动回退旧 `web/`）。
3. 安卓：`build-android.bat` → `dist\搭配台.apk`（改服务器地址：编辑 `app/.env` 后重跑）。首次构建需下载 Flutter 引擎/Gradle/Maven 依赖（约 3.5–4.5GB）。
4. 换机器构建需改两个 bat 顶部的工具链路径（`PATH` / `JAVA_HOME` / `ANDROID_HOME`），或提交 PR 改成探测。

## 5. 能力对齐基准

以旧版 `web/views/*.js` 行为逐条对齐：素材/样板库（场景/搜索 250ms 防抖/标签筛选、已删除恢复、≤50 名称/≤500 描述/≤20×20 标签、新建先暂存后逐张上传）、预设（插槽编辑器 1–10、失效徽标、复制/删除/恢复）、搭配台（自由模式 ≤8 素材带序号、无图拦截、标签推荐 limit 6；预设模式搜索、插槽抽屉、仅匹配插槽标签、一键自动填充）、记录（分页、筛选、快照明细、版本链、stderrTail）。

## 6. 服务端改动（仅 4 处）

1. 引入 `existsSync`；2. 新增 `APP_WEB_DIR = ../app/build/web/` 并按存在性计算 `webRoot`；3. 静态托管改用 `webRoot`（`files/`、路由、SSE 不动）；4. MIME 表补 `.wasm` / `.otf/.ttf/.woff2` / `.bin/.mem/.map/.symbols`。

## 7. 验证记录（2026-09-30）

- `dart analyze lib test` 0 issue；`flutter test` 52/52（含 shell 冒烟、模型、错误映射、SSE 帧、studio/renders 页面行为）。
- `node --test server/test/` 61/61 回归通过。
- 两个构建脚本端到端成功：APK `dist\搭配台.apk`（64.9MB，`aapt2 dump badging`：包名 `com.stylingstation.styling_station`、label「搭配台」、INTERNET 权限、targetSdk 36；解包确认两款中文字体与自适应图标在内）；`build/web` 含本地 canvaskit 与图标。
- 浏览器冒烟（127.0.0.1:4584）：Flutter 应用完整启动（标题「搭配台」、无控制台错误）；请求清单全部指向本机（canvaskit/字体/`/api/scenes`/`/api/materials`/素材缩略图均 200）→ 断外网可用。
- 回滚验证：移走 `app/build/web` 重启 → `/` 回到旧界面；恢复后重启 → `/` 为新界面。

## 8. 已知限制

- 不构建 iOS（Windows 环境）；无模拟器镜像，真机手势/照片选择器/长连耗电由用户真机验收。
- 安卓无画质参数（相机与相册均为原图上传，超过 `maxUploadMB` 时服务端拒绝并提示）。
- 候选图「下载」仅 Web 提供；安卓端保存到相册（分享面板）留作后续版本（需新增依赖并真机验证）。
- 旧 `web/` 暂保留作回滚，不删除（后续版本再定）。
