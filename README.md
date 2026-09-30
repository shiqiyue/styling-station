# 搭配台（styling-station）

AI 搭配效果图小工具：维护**素材库**与**样板库**，用「自由搭配」或「预设搭配」组装一次出图任务，由本机 **qodercli**（harness）调用图像生成，输出效果图并保存记录。适合在内网小范围共享使用（无登录、共享同一套资源库与出图账号）。

## 前提

- 本机已安装 **Node.js ≥ 18**（本项目零第三方依赖，无需 npm install）。
- 本机已安装并**已登录** **qodercli**（出图统一走本机 qodercli 的账号；后台服务不会弹登录，登录状态来自命令行使用同一账号时的凭据）。
  - 若 qodercli 不在 PATH：可用 `server/data/settings.json` 的 `qodercliPath` 指向入口文件（`.exe` / `.cmd` / 对应 node 脚本）。
  - 默认安装位置 `%USERPROFILE%\.qoder\bin\qodercli\qodercli.exe` 会被自动探测。

## 启动

双击 `start.bat`（或 `node server\server.mjs`）。控制台会打印：

```
本机访问：http://127.0.0.1:4584
内网访问：http://<你的内网IP>:4584
数据目录：...\server\data
出图并发：2
qodercli：<解析到的入口路径>
```

同事用「内网访问」地址打开即可。

### 防火墙放行（首次一次即可，需管理员）

```bat
netsh advfirewall firewall add rule name="styling-station" dir=in action=allow protocol=TCP localport=4584
```

## 界面

- **素材库 / 样板库**：名称、描述、场景、标签、图片；支持筛选（场景/标签/关键词）与软删除恢复。
- **预设**：一个样板 + 若干插槽（每槽：名称 + 标签 + 位置说明）；插槽标签用于自动填充推荐。
- **搭配台**：
  - 自由模式：选样板 → 多选素材（可筛选、可「立即上传」、可「标签推荐」自动挑）→ 位置说明 + 候选张数（1/2/4）→ 出图；实时展示排队/进度/思考过程，候选图可选用、下载、再出一版。
  - 预设模式：选预设 → 一键自动填充（按插槽标签推荐）或逐个插槽从抽屉挑选 → 补充说明 → 出图。
- **记录**：全部出图记录；详情含快照明细、候选图选用、版本链（上一版/下一版）跳转、停止与再出一版；支持按 `#/renders?template=<id>` 或 `#/renders?material=<id>` 筛选。

出图尺寸跟随样板图片比例（映射到生成器支持的固定档位）。

## 数据与配置（全部在 `server/data/` 下）

| 路径 | 内容 |
| --- | --- |
| `library.json` | 素材 / 样板 / 预设 |
| `renders.json` | 出图记录（含快照与候选图） |
| `files/` | 全部图片（素材、样板、效果图） |
| `settings.json` | 配置（首次启动自动生成） |
| `logs/<renderId>.log` | 每次出图的完整事件日志（排障用） |
| `work/<renderId>/` | 出图工作目录（默认完成后清理；`keepWorkDirs=true` 保留） |

`settings.json` 可配置项：

```json
{
  "port": 4584,
  "maxConcurrent": 2,
  "renderTimeoutMs": 300000,
  "maxUploadMB": 10,
  "keepWorkDirs": false,
  "qodercliPath": "qodercli"
}
```

修改后重启服务生效。

## 备份

双击 `backup.bat` → 生成 `backups\styling-station-<时间>.zip`（包含全部数据与图片）。还原：解压覆盖回 `server\data` 后重启。

## 排障

- **出图失败**：打开记录详情看错误信息（stderrTail），或查 `server/data/logs/<renderId>.log`；保留 `keepWorkDirs=true` 可进一步查看 `work/<renderId>/task-prompt.txt`（送入 harness 的完整提示词）。
- **提示「未找到 qodercli」**：按上文设置 `qodercliPath`；确认命令行下 `qodercli -p "hi"` 本身可用。
- **出图要登录 / 提示认证**：先在命令行用 qodercli 登录一次（与后台服务同一账号）。
- **端口被占用**：改 `settings.json` 的 `port` 后重启。
- **出图很慢或超时**：`renderTimeoutMs` 默认 5 分钟；并发由 `maxConcurrent` 控制（默认 2，超出的任务会排队）。
- **同事打不开**：确认防火墙规则已放行，且两台机器在同一内网；服务需保持这个窗口开着。
