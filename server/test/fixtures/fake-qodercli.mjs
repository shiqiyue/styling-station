#!/usr/bin/env node
/**
 * 测试夹具：模拟 qodercli --output-format=stream-json 与出图行为。
 * - 把 argv/附件 落盘到 --cwd/fake-cli-args.json、把 -p 正文落盘到 --cwd/task-prompt.txt（供断言）
 * - 输出：system/init → assistant(thinking) → assistant(tool_use ImageGen) → user(tool_result)
 *   → assistant(text=路径) → result（与实测事件形态一致）
 * - 图片落 --cwd/vibe_images/out-<n>.png（内嵌 1x1 真 PNG）
 * 环境变量：
 *   FAKE_PNG_COUNT  出图张数（默认 1）
 *   FAKE_DELAY_MS   每步间隔毫秒（默认 5）
 *   FAKE_FAIL=1     出图前非零退出
 *   FAKE_HANG=1     永不自行退出（配合超时/停止测试）
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const argOf = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : null
}
const cwd = argOf('--cwd')
const prompt = argOf('-p')
const attachments = argv.reduce((acc, a, i) => (a === '--attachment' ? acc.concat(argv[i + 1]) : acc), [])

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

if (cwd) {
  writeFileSync(join(cwd, 'fake-cli-args.json'), JSON.stringify({ argv, attachments }), 'utf8')
  if (prompt != null) writeFileSync(join(cwd, 'task-prompt.txt'), prompt, 'utf8')
}

async function main() {
  const delay = Number(process.env.FAKE_DELAY_MS || 5)
  emit({ type: 'system', subtype: 'init', session_id: 'fake-session-0001' })
  if (process.env.FAKE_HANG === '1') {
    setInterval(() => {}, 1000)
    return
  }
  await sleep(delay)
  emit({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '正在分析样板与素材…' }] } })
  await sleep(delay)
  if (process.env.FAKE_FAIL === '1') {
    process.stderr.write('fake cli 故障输出\n')
    process.exit(3)
  }
  const count = Number(process.env.FAKE_PNG_COUNT || 1)
  const dir = join(cwd, 'vibe_images')
  mkdirSync(dir, { recursive: true })
  const paths = []
  for (let i = 1; i <= count; i++) {
    emit({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'ImageGen', input: { name: `效果图-${i}`, size: '1024x1024' } }] }
    })
    await sleep(delay)
    const file = join(dir, `out-${i}.png`)
    writeFileSync(file, PNG_1x1)
    paths.push(file)
    emit({ type: 'user', message: { content: [{ type: 'tool_result', content: `已生成：${file}` }] } })
    await sleep(delay)
  }
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: paths.join('\n') }] } })
  emit({ type: 'result', result: paths.join('\n'), is_error: false, duration_ms: 123 })
  process.exit(0)
}

main().catch((e) => {
  process.stderr.write(String(e?.stack || e) + '\n')
  process.exit(1)
})
