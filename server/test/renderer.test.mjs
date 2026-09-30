/** renderer.mjs 测试：走 fake CLI 断言参数组装、收图、事件、失败与超时。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_SETTINGS } from '../settings.mjs'
import { extractImagePaths, runRender } from '../lib/renderer.mjs'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-qodercli.mjs', import.meta.url))

function withEnv(env, fn) {
  const saved = {}
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
}

function withWork() {
  const dir = mkdtempSync(join(tmpdir(), 'styling-render-'))
  const workDir = join(dir, 'work')
  return { dir, workDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const settings = () => ({ ...DEFAULT_SETTINGS, qodercliPath: FIXTURE })

test('runRender：参数组装 / 收图 / sessionId / 事件', async () => {
  const { workDir, cleanup } = withWork()
  try {
    const events = []
    const r = await runRender({
      settings: settings(),
      workDir,
      attachments: ['C:/imgs/t.png', 'C:/imgs/m1.png', 'C:/imgs/m2.png'],
      taskPrompt: '测试任务内容：把素材放进去',
      onEvent: (e) => events.push(e)
    })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.exitCode, 0)
    assert.equal(r.images.length, 1)
    assert.ok(r.images[0].endsWith(join('vibe_images', 'out-1.png')))
    assert.equal(r.sessionId, 'fake-session-0001')
    assert.ok(r.elapsedMs >= 0)

    const argsFile = JSON.parse(readFileSync(join(workDir, 'fake-cli-args.json'), 'utf8'))
    const { argv } = argsFile
    assert.equal(argv[argv.indexOf('--tools') + 1], 'ImageGen')
    assert.ok(argv.includes('--permission-mode=default'))
    assert.ok(argv.includes('--strict-mcp-config'))
    assert.equal(argv[argv.indexOf('--mcp-config') + 1], '{"mcpServers":{}}')
    assert.ok(argv.includes('--output-format=stream-json'))
    assert.equal(argv[argv.indexOf('--cwd') + 1], workDir)
    assert.deepEqual(argsFile.attachments, ['C:/imgs/t.png', 'C:/imgs/m1.png', 'C:/imgs/m2.png'])
    assert.match(readFileSync(join(workDir, 'task-prompt.txt'), 'utf8'), /测试任务内容/)

    const channels = events.filter((e) => e.event === 'delta').map((e) => e.data.channel)
    assert.ok(channels.includes('thinking'))
    assert.ok(channels.includes('tool'))
    assert.ok(channels.includes('system'))
  } finally {
    cleanup()
  }
})

test('runRender：多张出图按 mtime 收集', async () => {
  const { workDir, cleanup } = withWork()
  try {
    await withEnv({ FAKE_PNG_COUNT: '2' }, async () => {
      const r = await runRender({ settings: settings(), workDir, attachments: [], taskPrompt: 'x' })
      assert.equal(r.ok, true, JSON.stringify(r))
      assert.equal(r.images.length, 2)
      assert.ok(r.images[0].endsWith('out-1.png'))
      assert.ok(r.images[1].endsWith('out-2.png'))
    })
  } finally {
    cleanup()
  }
})

test('runRender：CLI 失败 → ok:false + stderrTail', async () => {
  const { workDir, cleanup } = withWork()
  try {
    await withEnv({ FAKE_FAIL: '1' }, async () => {
      const r = await runRender({ settings: settings(), workDir, attachments: [], taskPrompt: 'x' })
      assert.equal(r.ok, false)
      assert.equal(r.exitCode, 3)
      assert.equal(r.images.length, 0)
      assert.match(r.stderrTail, /fake cli 故障输出/)
    })
  } finally {
    cleanup()
  }
})

test('runRender：超时杀进程', async () => {
  const { workDir, cleanup } = withWork()
  try {
    await withEnv({ FAKE_HANG: '1' }, async () => {
      const r = await runRender({
        settings: { ...settings(), renderTimeoutMs: 300 },
        workDir,
        attachments: [],
        taskPrompt: 'x'
      })
      assert.equal(r.ok, false)
      assert.equal(r.timedOut, true)
      assert.equal(r.images.length, 0)
    })
  } finally {
    cleanup()
  }
})

test('extractImagePaths：Windows / POSIX 路径', () => {
  const paths = extractImagePaths(
    '已生成：\r\nC:\\data\\work\\r-1\\vibe_images\\a.png\n/tmp/work/b.png\n没有路径的行'
  )
  assert.deepEqual(paths, ['C:\\data\\work\\r-1\\vibe_images\\a.png', '/tmp/work/b.png'])
})
