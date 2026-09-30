/** jobs.mjs 测试：并发排队、事件序列、停止、失败、重启清理（全走 fake CLI）。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_SETTINGS } from '../settings.mjs'
import { createJobs } from '../lib/jobs.mjs'
import { createStore } from '../lib/store.mjs'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-qodercli.mjs', import.meta.url))

function setup(settingsPatch = {}, env = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'styling-jobs-'))
  const store = createStore({ dataDir })
  const settings = { ...DEFAULT_SETTINGS, qodercliPath: FIXTURE, ...settingsPatch }
  const jobs = createJobs({ store, settings })
  const saved = {}
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
  return {
    dataDir,
    store,
    jobs,
    done: () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      rmSync(dataDir, { recursive: true, force: true })
    }
  }
}

function makeDoc(store, patch = {}) {
  return store.createRender({
    mode: 'free',
    status: 'queued',
    templateSnapshot: { id: 't-x', name: '样板', images: [{ file: 'files/templates/t-x/1.png' }] },
    materialsSnapshot: [{ id: 'm-x', name: '素材', images: [{ file: 'files/materials/m-x/1.png' }] }],
    positionNote: '',
    candidateCount: 1,
    size: '1024x1024',
    results: [],
    parentId: null,
    ...patch
  })
}

async function waitFor(fn, timeoutMs = 8000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, stepMs))
  }
  throw new Error('waitFor 超时')
}

test('jobs：提交 → running → done；收图落盘 + 事件序列 + workDir 清理', async () => {
  const { store, jobs, dataDir, done } = setup({}, { FAKE_PNG_COUNT: '2' })
  try {
    const doc = makeDoc(store, { candidateCount: 2 })
    jobs.submit(doc)
    const events = []
    jobs.subscribe(doc.id, (ev) => events.push(ev))
    await waitFor(() => jobs.get(doc.id)?.status === 'done')

    const seq = events.map((e) => e.event)
    assert.ok(seq.includes('snapshot'))
    assert.ok(seq.includes('status'))
    assert.ok(seq.includes('delta'))
    assert.equal(seq.filter((e) => e === 'result').length, 2)
    assert.equal(seq[seq.length - 1], 'done')

    const rec = store.getRender(doc.id)
    assert.equal(rec.status, 'done')
    assert.equal(rec.results.length, 2)
    assert.ok(existsSync(join(dataDir, rec.results[0].file)))
    assert.equal(rec.results[0].width, 1)
    assert.equal(rec.results[0].height, 1)
    assert.equal(rec.cliSessionId, 'fake-session-0001')
    assert.ok(rec.elapsedMs >= 0)
    assert.ok(rec.finishedAt)
    assert.ok(!existsSync(join(dataDir, 'work', doc.id)), 'keepWorkDirs=false 时应清理 work 目录')
    assert.ok(existsSync(join(dataDir, 'logs', `${doc.id}.log`)))
  } finally {
    done()
  }
})

test('jobs：并发上限排队（第 2 个 queued 位置 1，随后依次完成）', async () => {
  const { store, jobs, done } = setup({ maxConcurrent: 1 }, { FAKE_DELAY_MS: '60' })
  try {
    const d1 = makeDoc(store)
    const d2 = makeDoc(store)
    jobs.submit(d1)
    jobs.submit(d2)
    assert.equal(jobs.get(d1.id).status, 'running')
    assert.equal(jobs.get(d2.id).status, 'queued')
    assert.equal(jobs.get(d2.id).queuePosition, 1)

    const events2 = []
    jobs.subscribe(d2.id, (ev) => events2.push(ev))
    assert.equal(events2[0].event, 'snapshot')
    assert.equal(events2[0].data.status, 'queued')

    await waitFor(() => jobs.get(d1.id)?.status === 'done')
    await waitFor(() => jobs.get(d2.id)?.status === 'done')
    assert.ok(events2.some((e) => e.event === 'status' && e.data.status === 'running'))
    assert.equal(store.getRender(d2.id).status, 'done')
    assert.equal(jobs.stats().running, 0)
    assert.equal(jobs.stats().pending, 0)
  } finally {
    done()
  }
})

test('jobs：停止排队中任务 → stopped 且不会启动', async () => {
  const { store, jobs, done } = setup({ maxConcurrent: 1 }, { FAKE_DELAY_MS: '80' })
  try {
    const d1 = makeDoc(store)
    const d2 = makeDoc(store)
    jobs.submit(d1)
    jobs.submit(d2)
    assert.equal(jobs.stop(d2.id), 'stopped')
    assert.equal(jobs.get(d2.id).status, 'stopped')
    assert.equal(store.getRender(d2.id).status, 'stopped')

    await waitFor(() => jobs.get(d1.id)?.status === 'done')
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(jobs.get(d2.id).status, 'stopped')
    assert.equal(store.getRender(d2.id).results.length, 0)
  } finally {
    done()
  }
})

test('jobs：停止运行中任务 → 子进程被杀，记录 stopped', async () => {
  const { store, jobs, done } = setup({}, { FAKE_DELAY_MS: '400' })
  try {
    const doc = makeDoc(store)
    jobs.submit(doc)
    await waitFor(() => jobs.get(doc.id)?.status === 'running')
    await new Promise((r) => setTimeout(r, 150))
    jobs.stop(doc.id)
    await waitFor(() => jobs.get(doc.id)?.status === 'stopped')
    assert.equal(store.getRender(doc.id).status, 'stopped')
  } finally {
    done()
  }
})

test('jobs：CLI 失败 → error + stderrTail 落盘', async () => {
  const { store, jobs, done } = setup({}, { FAKE_FAIL: '1' })
  try {
    const doc = makeDoc(store)
    jobs.submit(doc)
    const events = []
    jobs.subscribe(doc.id, (ev) => events.push(ev))
    await waitFor(() => jobs.get(doc.id)?.status === 'error')
    const rec = store.getRender(doc.id)
    assert.equal(rec.status, 'error')
    assert.match(rec.stderrTail, /fake cli 故障输出/)
    assert.ok(events.some((e) => e.event === 'error'))
  } finally {
    done()
  }
})

test('jobs：restartCleanup 把 queued/running 残留标记 stopped', () => {
  const { store, jobs, done } = setup()
  try {
    const r1 = makeDoc(store, { status: 'running' })
    const r2 = makeDoc(store, { status: 'queued' })
    const r3 = makeDoc(store, { status: 'done' })
    assert.equal(jobs.restartCleanup(), 2)
    assert.equal(store.getRender(r1.id).status, 'stopped')
    assert.equal(store.getRender(r2.id).status, 'stopped')
    assert.equal(store.getRender(r2.id).stderrTail, '服务重启中断')
    assert.equal(store.getRender(r3.id).status, 'done')
  } finally {
    done()
  }
})
