/**
 * 出图通道：spawn qodercli harness（Spec §6.1），解析 stream-json，收集产物。
 * - 参数数组直传（不带 shell）；环境剔除 QODER_AGENT_SDK_ENTRYPOINT / GIT_EXEC_PATH（buildCliEnv）。
 * - 收图双保险：扫描 <workDir>/vibe_images/*.png（mtime 序）+ result 文本中的绝对路径去重。
 * - 超时用 settings.renderTimeoutMs 杀进程树（Windows taskkill /T /F）。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { buildCliEnv, resolveQoderCliSpawn } from './qodercli.mjs'
import { createStreamParser } from './ai-stream.mjs'
import { SYSTEM_PROMPT } from './prompt.mjs'

const STDERR_TAIL_MAX = 2000

export function killProcessTree(child) {
  if (!child || child.exitCode !== null || child.killed) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    } catch {
      /* 忽略：进程可能已退出 */
    }
  } else {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 忽略 */
    }
  }
}

/** 扫描 workDir/vibe_images 下的 png，按 mtime 升序（≈生成顺序） */
export function scanVibeImages(workDir) {
  const dir = join(workDir, 'vibe_images')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.png'))
    .map((f) => {
      const p = join(dir, f)
      let mtime = 0
      try {
        mtime = statSync(p).mtimeMs
      } catch {
        /* 忽略 */
      }
      return { path: p, mtime }
    })
    .sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path))
    .map((e) => e.path)
}

/** 从 result 文本中提取 .png 绝对路径（Windows / POSIX） */
export function extractImagePaths(text) {
  const out = []
  const re = /[A-Za-z]:\\[^\s"'<>|?*\r\n]+?\.png|\/[^\s"'<>|?*\r\n]+?\.png/g
  let m
  while ((m = re.exec(String(text || '')))) out.push(m[0])
  return out
}

/**
 * @param {object} args
 * @param {object} args.settings settings.json（renderTimeoutMs 等）
 * @param {object} [args.cli] resolveQoderCliSpawn 结果；缺省按 settings.qodercliPath 解析
 * @param {string} args.workDir 本次出图的独立工作目录（作为 CLI cwd）
 * @param {string[]} [args.attachments] 附件绝对路径列表（样板图 + 素材图）
 * @param {string} args.taskPrompt -p 正文
 * @param {(ev:{event:string,data:object})=>void} [args.onEvent] 增量事件转发（SSE 用）
 * @param {(child)=>void} [args.registerChild] 子进程登记（供外部停止）
 * @returns {Promise<{ok:boolean, images:string[], sessionId:string|null, elapsedMs:number,
 *   exitCode:number|null, stderrTail:string, timedOut:boolean, resultText:string, error?:string}>}
 */
export function runRender({ settings = {}, cli, workDir, attachments = [], taskPrompt, onEvent, registerChild } = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    const base = {
      ok: false,
      images: [],
      sessionId: null,
      elapsedMs: 0,
      exitCode: null,
      stderrTail: '',
      timedOut: false,
      resultText: ''
    }
    const resolved = cli || resolveQoderCliSpawn({ qodercliPath: settings.qodercliPath || 'qodercli' })
    if (resolved.error) {
      resolve({ ...base, error: resolved.error })
      return
    }

    mkdirSync(workDir, { recursive: true })
    const args = [
      '-p', taskPrompt,
      '--append-system-prompt', SYSTEM_PROMPT,
      '--tools', 'ImageGen',
      '--permission-mode=default',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--cwd', workDir,
      ...attachments.flatMap((f) => ['--attachment', f]),
      '--output-format=stream-json'
    ]

    let child
    try {
      child = spawn(resolved.command, [...(resolved.prefixArgs || []), ...args], {
        cwd: workDir,
        env: buildCliEnv(process.env),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (e) {
      resolve({ ...base, error: `无法启动 qodercli：${e.message}` })
      return
    }
    registerChild?.(child)

    let stderr = ''
    let timedOut = false
    const timer = setTimeout(
      () => {
        timedOut = true
        killProcessTree(child)
      },
      Math.max(50, Number(settings.renderTimeoutMs) || 300000)
    )

    const parser = createStreamParser({
      onEvent: (ev) => {
        if (ev.type === 'session') {
          base.sessionId = ev.sessionId
          onEvent?.({ event: 'delta', data: { channel: 'system', text: `CLI 会话建立：${ev.sessionId}` } })
        } else if (ev.type === 'block') {
          const channel = ev.channel === 'answer' ? 'system' : ev.channel
          onEvent?.({ event: 'delta', data: { channel, text: ev.text } })
        } else if (ev.type === 'result') {
          base.resultText = ev.text
          onEvent?.({ event: 'delta', data: { channel: 'system', text: `任务输出结束（${ev.isError ? '异常' : '成功'}）` } })
        }
      }
    })

    child.stdout.on('data', (chunk) => parser.push(chunk))
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > STDERR_TAIL_MAX * 2) stderr = stderr.slice(-STDERR_TAIL_MAX * 2)
    })

    let settled = false
    const finish = (patch) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...base, ...patch })
    }

    child.on('error', (e) => {
      finish({ error: `qodercli 进程错误：${e.message}`, elapsedMs: Date.now() - started, stderrTail: stderr.slice(-STDERR_TAIL_MAX) })
    })

    child.on('close', (code) => {
      parser.flush()
      const scanned = scanVibeImages(workDir)
      const seen = new Set(scanned.map((p) => p.toLowerCase()))
      const images = [...scanned]
      for (const p of extractImagePaths(base.resultText)) {
        if (seen.has(p.toLowerCase())) continue
        try {
          if (existsSync(p) && statSync(p).isFile()) {
            images.push(p)
            seen.add(p.toLowerCase())
          }
        } catch {
          /* 忽略读取异常 */
        }
      }
      finish({
        exitCode: code,
        timedOut,
        elapsedMs: Date.now() - started,
        stderrTail: stderr.slice(-STDERR_TAIL_MAX),
        images,
        ok: !timedOut && code === 0 && images.length > 0
      })
    })
  })
}
