/**
 * image-edit.mjs 测试：本地假方舟服务（node:http，真实 HTTP 往返）。
 * 覆盖：请求体核对（model/prompt/image 顺序/鉴权头）、b64 与 url 两种响应、
 * 错误脱敏（不含 API Key）、缺配置零请求、候选串行、中止与超时保留已出候选。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_SETTINGS } from '../settings.mjs'
import { createJobs } from '../lib/jobs.mjs'
import { runImageEdit } from '../lib/image-edit.mjs'
import { createStore } from '../lib/store.mjs'

// 1x1 PNG（有效文件头）
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

const INSTRUCTION = '把素材合成进样板场景。\n- 图1 = 场景底板：样板\n- 图2 = 素材：素材'

/** 本地假方舟：记录每次请求 { method, url, headers, body }，handler(call, req, res) 决定响应 */
async function startFakeArk(handler) {
  const calls = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const buf = Buffer.concat(chunks)
      let body = null
      if (buf.length) {
        try {
          body = JSON.parse(buf.toString('utf8'))
        } catch {
          body = buf.toString('utf8')
        }
      }
      const call = { method: req.method, url: req.url, headers: req.headers, body }
      calls.push(call)
      handler(call, req, res)
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    calls,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.()
        server.close(() => r())
      })
  }
}

/** 两个内容不同的附件（样板在前） */
function setupFiles() {
  const dir = mkdtempSync(join(tmpdir(), 'styling-edit-'))
  const tpl = join(dir, 'tpl.png')
  const mat = join(dir, 'mat.png')
  writeFileSync(tpl, TINY_PNG)
  writeFileSync(mat, Buffer.concat([TINY_PNG, Buffer.from([0])]))
  return { dir, tpl, mat, workDir: join(dir, 'work'), done: () => rmSync(dir, { recursive: true, force: true }) }
}

function settingsOf(patch = {}) {
  return {
    ...DEFAULT_SETTINGS,
    renderChannel: 'ark',
    arkApiKey: 'test-key-123',
    arkModel: 'seedream-test',
    ...patch
  }
}

function jsonOk(data) {
  return (call, req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(data))
  }
}

async function waitFor(fn, timeoutMs = 4000, stepMs = 10) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, stepMs))
  }
  throw new Error('waitFor 超时')
}

test('image-edit：未配置 key/model → 直接报错且零请求', async () => {
  const ark = await startFakeArk(jsonOk({ data: [] }))
  const s = setupFiles()
  try {
    const res = await runImageEdit({
      settings: settingsOf({ arkApiKey: '', arkModel: '', arkBaseUrl: `${ark.base}/api/v3` }),
      workDir: s.workDir,
      attachments: [s.tpl, s.mat],
      editInstruction: INSTRUCTION,
      size: '1024x1024'
    })
    assert.equal(res.ok, false)
    assert.match(res.error, /未配置方舟图生图/)
    assert.equal(ark.calls.length, 0)
  } finally {
    s.done()
    await ark.close()
  }
})

test('image-edit：happy path（b64_json）→ 落盘 + 请求体核对', async () => {
  const ark = await startFakeArk(jsonOk({ data: [{ b64_json: TINY_PNG.toString('base64') }] }))
  const s = setupFiles()
  try {
    const res = await runImageEdit({
      settings: settingsOf({ arkBaseUrl: `${ark.base}/api/v3` }),
      workDir: s.workDir,
      attachments: [s.tpl, s.mat],
      editInstruction: INSTRUCTION,
      size: '1024x1024'
    })
    assert.equal(res.ok, true)
    assert.equal(res.error, undefined)
    assert.equal(res.timedOut, false)
    assert.equal(res.images.length, 1)
    assert.ok(res.images[0].endsWith('ark-1.png'))
    assert.ok(readFileSync(res.images[0]).equals(TINY_PNG))

    const call = ark.calls[0]
    assert.equal(call.method, 'POST')
    assert.equal(call.url, '/api/v3/images/generations')
    assert.equal(call.headers.authorization, 'Bearer test-key-123')
    assert.equal(call.body.model, 'seedream-test')
    assert.equal(call.body.prompt, INSTRUCTION)
    assert.equal(call.body.watermark, false)
    assert.equal(call.body.response_format, 'b64_json')
    assert.equal(call.body.size, '1024x1024')
    assert.equal(call.body.image.length, 2)
    // 顺序 = 图1 样板 → 图2 素材；内容为 Data URI
    assert.ok(call.body.image[0].startsWith('data:image/png;base64,'))
    assert.ok(Buffer.from(call.body.image[0].split(',')[1], 'base64').equals(TINY_PNG))
    assert.ok(
      Buffer.from(call.body.image[1].split(',')[1], 'base64').equals(Buffer.concat([TINY_PNG, Buffer.from([0])]))
    )
  } finally {
    s.done()
    await ark.close()
  }
})

test('image-edit：url 响应 → 下载并落盘', async () => {
  let ark
  ark = await startFakeArk((call, req, res) => {
    if (call.url === '/api/v3/images/generations') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ url: `${ark.base}/out/1.png` }] }))
      return
    }
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(TINY_PNG)
  })
  const s = setupFiles()
  try {
    const res = await runImageEdit({
      settings: settingsOf({ arkBaseUrl: `${ark.base}/api/v3` }),
      workDir: s.workDir,
      attachments: [s.tpl, s.mat],
      editInstruction: INSTRUCTION,
      size: '1024x1024'
    })
    assert.equal(res.ok, true)
    assert.equal(res.images.length, 1)
    assert.ok(readFileSync(res.images[0]).equals(TINY_PNG))
    assert.equal(ark.calls.length, 2)
    assert.equal(ark.calls[1].url, '/out/1.png')
  } finally {
    s.done()
    await ark.close()
  }
})

test('image-edit：HTTP 401 → 报错脱敏（不含 API Key）', async () => {
  const ark = await startFakeArk((call, req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({ error: { code: 'AuthenticationError', message: 'the api key test-key-123 is invalid' } })
    )
  })
  const s = setupFiles()
  try {
    const res = await runImageEdit({
      settings: settingsOf({ arkBaseUrl: `${ark.base}/api/v3` }),
      workDir: s.workDir,
      attachments: [s.tpl, s.mat],
      editInstruction: INSTRUCTION,
      size: '1024x1024'
    })
    assert.equal(res.ok, false)
    assert.match(res.error, /HTTP 401/)
    assert.ok(!res.error.includes('test-key-123'), '错误信息不得包含 API Key')
    assert.match(res.error, /\*\*\*/)
    assert.ok(!res.stderrTail.includes('test-key-123'), 'stderrTail 不得包含 API Key')
  } finally {
    s.done()
    await ark.close()
  }
})

test('image-edit：candidateCount=2 → 串行两次调用、两张产物、第 2 张带候选标注', async () => {
  const ark = await startFakeArk(jsonOk({ data: [{ b64_json: TINY_PNG.toString('base64') }] }))
  const s = setupFiles()
  try {
    const res = await runImageEdit({
      settings: settingsOf({ arkBaseUrl: `${ark.base}/api/v3` }),
      workDir: s.workDir,
      attachments: [s.tpl, s.mat],
      editInstruction: INSTRUCTION,
      size: '1024x1024',
      candidateCount: 2
    })
    assert.equal(res.ok, true)
    assert.equal(res.images.length, 2)
    assert.ok(res.images[0].endsWith('ark-1.png'))
    assert.ok(res.images[1].endsWith('ark-2.png'))
    assert.equal(ark.calls.length, 2)
    assert.ok(ark.calls[0].body.prompt.startsWith(INSTRUCTION))
    assert.match(ark.calls[0].body.prompt, /这是第 1\/2 张候选/)
    assert.match(ark.calls[1].body.prompt, /这是第 2\/2 张候选/)
  } finally {
    s.done()
    await ark.close()
  }
})

test('image-edit：中止 → 已停止，保留已出候选', async () => {
  let held = null
  let ark
  ark = await startFakeArk((call, req, res) => {
    if (ark.calls.length === 1) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ b64_json: TINY_PNG.toString('base64') }] }))
      return
    }
    held = res // 第 2 张挂起，等外部中止
  })
  const s = setupFiles()
  try {
    let abortFn = null
    const pending = runImageEdit({
      settings: settingsOf({ arkBaseUrl: `${ark.base}/api/v3` }),
      workDir: s.workDir,
      attachments: [s.tpl, s.mat],
      editInstruction: INSTRUCTION,
      size: '1024x1024',
      candidateCount: 2,
      registerAbort: (fn) => {
        abortFn = fn
      }
    })
    await waitFor(() => ark.calls.length === 2)
    assert.ok(abortFn, 'registerAbort 应已登记')
    abortFn()
    const res = await pending
    assert.equal(res.ok, false)
    assert.equal(res.error, '已停止')
    assert.equal(res.images.length, 1)
    held = null
  } finally {
    held?.destroy?.()
    s.done()
    await ark.close()
  }
})

test('image-edit：超时 → timedOut，保留已出候选', async () => {
  let ark
  ark = await startFakeArk((call, req, res) => {
    if (ark.calls.length === 1) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ b64_json: TINY_PNG.toString('base64') }] }))
      return
    }
    /* 挂起不响应，等超时 */
  })
  const s = setupFiles()
  try {
    const res = await runImageEdit({
      settings: settingsOf({ arkBaseUrl: `${ark.base}/api/v3`, renderTimeoutMs: 300 }),
      workDir: s.workDir,
      attachments: [s.tpl, s.mat],
      editInstruction: INSTRUCTION,
      size: '1024x1024',
      candidateCount: 2
    })
    assert.equal(res.ok, false)
    assert.equal(res.timedOut, true)
    assert.match(res.error, /出图超时/)
    assert.equal(res.images.length, 1)
  } finally {
    s.done()
    await ark.close()
  }
})

test('image-edit：与 jobs 组合 e2e（真实 renderer，通道=ark，结果落盘为候选）', async () => {
  const ark = await startFakeArk(jsonOk({ data: [{ b64_json: TINY_PNG.toString('base64') }] }))
  const dataDir = mkdtempSync(join(tmpdir(), 'styling-ark-e2e-'))
  const store = createStore({ dataDir })
  const settings = settingsOf({ arkBaseUrl: `${ark.base}/api/v3` })
  const jobs = createJobs({ store, settings })
  try {
    for (const f of ['files/templates/t-x/1.png', 'files/materials/m-x/1.png']) {
      mkdirSync(join(dataDir, f, '..'), { recursive: true })
      writeFileSync(join(dataDir, f), TINY_PNG)
    }
    const doc = store.createRender({
      mode: 'free',
      status: 'queued',
      templateSnapshot: { id: 't-x', name: '样板', images: [{ file: 'files/templates/t-x/1.png' }] },
      materialsSnapshot: [{ id: 'm-x', name: '素材', images: [{ file: 'files/materials/m-x/1.png' }] }],
      positionNote: '',
      candidateCount: 1,
      size: '1024x1024',
      results: [],
      parentId: null
    })
    jobs.submit(doc)
    await waitFor(() => jobs.get(doc.id)?.status === 'done')
    const rec = store.getRender(doc.id)
    assert.equal(rec.status, 'done')
    assert.equal(rec.results.length, 1)
    assert.ok(existsSync(join(dataDir, rec.results[0].file)))
    assert.equal(rec.results[0].width, 1)
    assert.equal(rec.results[0].height, 1)
    assert.equal(ark.calls.length, 1)
    assert.ok(!existsSync(join(dataDir, 'work', doc.id)), 'keepWorkDirs=false 时应清理 work 目录')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    await ark.close()
  }
})

test('image-edit：附件缺失 → 报错且零请求', async () => {
  const ark = await startFakeArk(jsonOk({ data: [] }))
  const s = setupFiles()
  try {
    const res = await runImageEdit({
      settings: settingsOf({ arkBaseUrl: `${ark.base}/api/v3` }),
      workDir: s.workDir,
      attachments: [s.tpl, join(s.dir, 'nope.png')],
      editInstruction: INSTRUCTION,
      size: '1024x1024'
    })
    assert.equal(res.ok, false)
    assert.match(res.error, /附件不存在/)
    assert.equal(ark.calls.length, 0)
  } finally {
    s.done()
    await ark.close()
  }
})
