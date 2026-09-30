/**
 * qodercli 解析：避免 shell:true 的引号问题，统一落到「可执行文件 / node + 脚本」直调。
 * 另提供子进程 env 清洗：Qoder 会话注入的 SDK 标记会让 qodercli 误入 SDK 自检（sdk_invalid_args）。
 * 来源：D:\project\web-ask\server\lib\qodercli.mjs（新增 ~/.qoder 默认位置兜底）。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

function splitPathEnv(pathEnv) {
  return String(pathEnv || '').split(';').map((s) => s.trim()).filter(Boolean)
}

export function resolveQoderCliSpawn({
  qodercliPath = 'qodercli',
  pathEnv = process.env.PATH || '',
  exists = existsSync,
  readFile = readFileSync,
  stat = statSync,
  nodeBin = process.execPath,
  home = homedir()
} = {}) {
  const candidates = []
  if (qodercliPath && qodercliPath !== 'qodercli') candidates.push(qodercliPath)
  for (const dir of splitPathEnv(pathEnv)) {
    candidates.push(join(dir, 'qodercli.exe'))
    candidates.push(join(dir, 'qodercli.cmd'))
    candidates.push(join(dir, 'qodercli'))
  }
  // 本机 Qoder 默认安装位置兜底
  candidates.push(join(home, '.qoder', 'bin', 'qodercli', 'qodercli.exe'))
  candidates.push(join(home, '.qoder', 'bin', 'qodercli', 'qodercli'))

  for (const file of candidates) {
    if (!exists(file)) continue
    // 同名目录会遮蔽真实可执行文件（如 PATH 中 ...\bin\qodercli 为目录）：跳过，继续扫描
    let isFile = false
    try {
      isFile = stat(file).isFile()
    } catch {
      /* 无法 stat 的候选按缺失处理 */
    }
    if (!isFile) continue
    const base = file.toLowerCase()
    if (base.endsWith('.exe')) return { command: file, prefixArgs: [], resolvedFrom: file }
    if (base.endsWith('.js') || base.endsWith('.mjs')) return { command: nodeBin, prefixArgs: [file], resolvedFrom: file }
    if (base.endsWith('.cmd')) {
      const entry = join(dirname(file), 'node_modules', '@qoder-ai', 'qodercli', 'bin', 'qodercli')
      if (exists(entry)) return { command: nodeBin, prefixArgs: [entry], resolvedFrom: entry }
      return { error: `找到 ${file} 但未找到其 JS 入口 ${entry}；请在 settings.json 中把 qodercliPath 指向实际入口文件` }
    }
    let head = ''
    try {
      head = readFile(file).slice(0, 64).toString('utf8')
    } catch {
      /* 读不到按未知形态处理 */
    }
    if (head.startsWith('#!') && head.includes('node')) return { command: nodeBin, prefixArgs: [file], resolvedFrom: file }
    return { error: `${file} 不是可识别的 qodercli 形态（.exe / .cmd / node 入口脚本）` }
  }
  return { error: '未找到 qodercli：请安装并加入 PATH，或在 data/settings.json 中设置 qodercliPath 完整路径' }
}

/** 子进程环境：删除会破坏 qodercli / 子进程 git 的继承变量 */
export function buildCliEnv(base = process.env) {
  const env = { ...base }
  delete env.QODER_AGENT_SDK_ENTRYPOINT
  delete env.GIT_EXEC_PATH
  return env
}
