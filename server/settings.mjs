/**
 * 配置：首次启动在数据目录生成 settings.json（gitignore），后续读取覆盖默认值。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULT_SETTINGS = {
  port: 4584,
  maxConcurrent: 2,
  renderTimeoutMs: 300000,
  maxUploadMB: 10,
  keepWorkDirs: false,
  qodercliPath: 'qodercli',
  // 出图通道：'qodercli'（默认，文生图）或 'ark'（火山方舟图生图，需填 arkApiKey + arkModel）
  renderChannel: 'qodercli',
  arkBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  arkApiKey: '',
  arkModel: ''
}

export function loadSettings(dataDir) {
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, 'settings.json')
  let saved = {}
  if (existsSync(file)) {
    try {
      saved = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      saved = {}
    }
  }
  const settings = { ...DEFAULT_SETTINGS, ...saved }
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8')
  }
  return settings
}
