/**
 * opt-jobs.mjs 测试：注入 fake renderer，覆盖队列、成功产物、失败/取消终态、
 * adopt 重命名与主图切换、discard 中止与幂等、启动清理、入参校验。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_SETTINGS } from '../settings.mjs'
import { createOptJobs } from '../lib/opt-jobs.mjs'
import { createStore } from '../lib/store.mjs'
import { pngBuf } from './helpers.mjs'

async function waitFor(fn, timeoutMs = 4000, stepMs = 10) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, stepMs))
  }
  throw new Error('waitFor 超时')
}

/** 数据目录 + store + 一个带真实 PNG 的素材 */
function setup(patch = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'styling-opt-'))
  const store = createStore({ dataDir })
  const settings = { ...DEFAULT_SETTINGS, arkApiKey: 'test-key', arkModel: 'seedream-test', ...patch }
  const m = store.create('materials', { name: '大理石瓷砖', description: '米白', scene: '瓷砖', tags: ['地面'] })
  const dir = join(dataDir, 'files', 'materials', m.id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '1.png'), pngBuf(8, 8))
  store.addImage('materials', m.id, { file: `files/materials/${m.id}/1.png`, width: 8, height: 8 })
  return { dataDir, store, settings, materialId: m.id, done: () => rmSync(dataDir, { recursive: true, force: true }) }
}

/** happy-path fake renderer：写出 8x8 结果图并回传契约 */
function okRenderer(calls = []) {
  return {
    runImageEdit: async (args) => {
      calls.push(args)
      const out = join(args.workDir, 'ark_images')
      mkdirSync(out, { recursive: true })
      writeFileSync(join(out, 'ark-1.png'), pngBuf(8, 8))
      // 模拟真实通道：delta 在订阅建立之后异步到达
      await new Promise((r) => setTimeout(r, 5))
      args.onEvent?.({ event: 'delta', data: { channel: 'system', text: '图生图通道：方舟 seedream-test' } })
      return {
        ok: true,
        images: [join(out, 'ark-1.png')],
        sessionId: null,
        elapsedMs: 12,
        exitCode: 0,
        stderrTail: '',
        timedOut: false,
        resultText: ''
      }
    }
  }
}

test('opt-jobs：提交 → running → done；产物落 opt-<taskId>.png + 事件序列 + workDir 清理', async () => {
  const { store, settings, materialId, dataDir, done } = setup()
  const calls = []
  const optJobs = createOptJobs({ store, settings, renderer: okRenderer(calls) })
  try {
    const taskId = optJobs.submit({ materialId, index: 0 })
    assert.match(taskId, /^o-\d{14}-[0-9a-f]{4}$/)
    const events = []
    optJobs.subscribe(taskId, (ev) => events.push(ev))
    await waitFor(() => optJobs.get(taskId)?.status === 'done')

    const seq = events.map((e) => e.event)
    assert.equal(seq[0], 'snapshot')
    assert.ok(seq.includes('delta'))
    assert.ok(seq.includes('result'))
    assert.equal(seq[seq.length - 1], 'done')

    const view = optJobs.get(taskId)
    assert.equal(view.result.file, `files/materials/${materialId}/opt-${taskId}.png`)
    assert.ok(existsSync(join(dataDir, view.result.file)))
    assert.equal(view.result.width, 8)
    assert.equal(view.result.height, 8)

    // fake 收到的入参
    assert.equal(calls.length, 1)
    assert.equal(calls[0].attachments.length, 1)
    assert.ok(calls[0].attachments[0].endsWith('1.png'))
    assert.equal(calls[0].candidateCount, 1)
    assert.equal(calls[0].size, '1024x1024') // 8x8 → 1:1
    assert.match(calls[0].editInstruction, /素材图清理/)
    assert.ok(!existsSync(join(dataDir, 'work', taskId)), 'keepWorkDirs=false 时应清理 work 目录')
  } finally {
    done()
  }
})

test('opt-jobs：入参校验（素材不存在/已删除、index 越界、ark 未配置）', () => {
  const { store, settings, materialId, done } = setup()
  const optJobs = createOptJobs({ store, settings, renderer: okRenderer() })
  try {
    assert.throws(() => optJobs.submit({ materialId: 'm-nope', index: 0 }), /素材不存在/)
    assert.throws(() => optJobs.submit({ materialId, index: 5 }), /要优化的图片不存在/)
    assert.throws(() => optJobs.submit({ materialId, index: -1 }), /要优化的图片不存在/)
    const offline = createOptJobs({ store, settings: { ...settings, arkApiKey: '' }, renderer: okRenderer() })
    assert.throws(() => offline.submit({ materialId, index: 0 }), /未配置方舟图生图/)
    store.remove('materials', materialId)
    assert.throws(() => optJobs.submit({ materialId, index: 0 }), /素材不存在或已删除/)
  } finally {
    done()
  }
})

test('opt-jobs：renderer 失败 → error 终态 + error 事件', async () => {
  const { store, settings, materialId, done } = setup()
  const optJobs = createOptJobs({
    store,
    settings,
    renderer: {
      runImageEdit: async () => ({
        ok: false,
        images: [],
        sessionId: null,
        elapsedMs: 5,
        exitCode: 1,
        stderrTail: '',
        timedOut: false,
        resultText: '',
        error: '方舟接口错误（HTTP 500）'
      })
    }
  })
  try {
    const taskId = optJobs.submit({ materialId, index: 0 })
    const events = []
    optJobs.subscribe(taskId, (ev) => events.push(ev))
    await waitFor(() => optJobs.get(taskId)?.status === 'error')
    assert.ok(events.some((e) => e.event === 'error' && /方舟接口错误/.test(e.data.message)))
    assert.equal(optJobs.get(taskId).error, '方舟接口错误（HTTP 500）')
  } finally {
    done()
  }
})

test('opt-jobs：并发 1 —— 第 2 个排队，依次完成', async () => {
  const { store, settings, materialId, done } = setup()
  let release = null
  const optJobs = createOptJobs({
    store,
    settings,
    renderer: {
      runImageEdit: (args) =>
        new Promise((resolve) => {
          release = () => {
            const out = join(args.workDir, 'ark_images')
            mkdirSync(out, { recursive: true })
            writeFileSync(join(out, 'ark-1.png'), pngBuf(8, 8))
            resolve({
              ok: true,
              images: [join(out, 'ark-1.png')],
              sessionId: null,
              elapsedMs: 1,
              exitCode: 0,
              stderrTail: '',
              timedOut: false,
              resultText: ''
            })
          }
        })
    }
  })
  try {
    const t1 = optJobs.submit({ materialId, index: 0 })
    const t2 = optJobs.submit({ materialId, index: 0 })
    await waitFor(() => optJobs.get(t1)?.status === 'running')
    assert.equal(optJobs.get(t2).status, 'queued')
    assert.equal(optJobs.get(t2).queuePosition, 1)
    release()
    await waitFor(() => optJobs.get(t1)?.status === 'done')
    await waitFor(() => optJobs.get(t2)?.status === 'running')
    release()
    await waitFor(() => optJobs.get(t2)?.status === 'done')
  } finally {
    done()
  }
})

test('opt-jobs：discard 运行中任务 → 中止 + 终态取消 + 无产物残留 + 幂等', async () => {
  const { store, settings, materialId, dataDir, done } = setup()
  let aborted = false
  const optJobs = createOptJobs({
    store,
    settings,
    renderer: {
      runImageEdit: (args) =>
        new Promise((resolve) => {
          args.registerAbort(() => {
            aborted = true
            resolve({
              ok: false,
              images: [],
              sessionId: null,
              elapsedMs: 3,
              exitCode: 1,
              stderrTail: '',
              timedOut: false,
              resultText: '',
              error: '已停止'
            })
          })
        })
    }
  })
  try {
    const taskId = optJobs.submit({ materialId, index: 0 })
    await waitFor(() => optJobs.get(taskId)?.status === 'running')
    const r1 = optJobs.discard({ materialId, taskId })
    assert.equal(r1.ok, true)
    assert.equal(aborted, true)
    await waitFor(() => optJobs.get(taskId) === null)
    assert.ok(!existsSync(join(dataDir, `files/materials/${materialId}/opt-${taskId}.png`)))
    const r2 = optJobs.discard({ materialId, taskId }) // 幂等
    assert.equal(r2.ok, true)
  } finally {
    done()
  }
})

test('opt-jobs：adopt → 重命名为下一个编号 + 设为主图 + 原主图降级 + 任务移除', async () => {
  const { store, settings, materialId, dataDir, done } = setup()
  const optJobs = createOptJobs({ store, settings, renderer: okRenderer() })
  try {
    const taskId = optJobs.submit({ materialId, index: 0 })
    await waitFor(() => optJobs.get(taskId)?.status === 'done')

    const { entry, doc } = optJobs.adopt({ materialId, taskId })
    assert.equal(entry.file, `files/materials/${materialId}/2.png`)
    assert.equal(entry.primary, true)
    assert.ok(existsSync(join(dataDir, entry.file)))
    assert.ok(!existsSync(join(dataDir, `files/materials/${materialId}/opt-${taskId}.png`)))
    assert.deepEqual(
      doc.images.map((i) => [i.file.endsWith('1.png'), i.primary]),
      [
        [true, false],
        [false, true]
      ]
    )
    assert.equal(optJobs.get(taskId), null)
  } finally {
    done()
  }
})

test('opt-jobs：adopt 未完成任务 → 400；taskId 非法 → 404', async () => {
  const { store, settings, materialId, done } = setup()
  let release = null
  const optJobs = createOptJobs({
    store,
    settings,
    renderer: {
      runImageEdit: () =>
        new Promise((resolve) => {
          release = resolve
        })
    }
  })
  try {
    const taskId = optJobs.submit({ materialId, index: 0 })
    await waitFor(() => optJobs.get(taskId)?.status === 'running')
    assert.throws(() => optJobs.adopt({ materialId, taskId }), /优化未完成/)
    assert.throws(() => optJobs.adopt({ materialId, taskId: '../etc' }), /优化任务不存在/)
    release({
      ok: false,
      images: [],
      sessionId: null,
      elapsedMs: 1,
      exitCode: 1,
      stderrTail: '',
      timedOut: false,
      resultText: '',
      error: 'x'
    })
    await waitFor(() => optJobs.get(taskId)?.status === 'error')
    assert.equal(optJobs.get(taskId) !== null, true)
  } finally {
    done()
  }
})

test('opt-jobs：restartCleanup 清掉所有 opt-* 残留', () => {
  const { store, settings, materialId, dataDir, done } = setup()
  const optJobs = createOptJobs({ store, settings, renderer: okRenderer() })
  try {
    const dir = join(dataDir, 'files', 'materials', materialId)
    writeFileSync(join(dir, 'opt-o-20260101000000-abcd.png'), pngBuf(8, 8))
    writeFileSync(join(dir, 'opt-o-20260101000000-abcd.jpg'), Buffer.from([1]))
    assert.equal(optJobs.restartCleanup(), 2)
    assert.ok(!readdirSync(dir).some((f) => f.startsWith('opt-')))
    assert.ok(existsSync(join(dir, '1.png'))) // 正式图片不动
  } finally {
    done()
  }
})
