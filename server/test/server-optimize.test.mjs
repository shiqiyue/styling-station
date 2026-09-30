/**
 * 素材图优化 HTTP 集成测试：真实服务 + 本地假方舟（b64 响应）。
 * 覆盖：完整链路（发起 → SSE 全事件 → adopt 主图切换 → 文件可取）、
 * 未配置方舟 400、taskId 不存在 404、discard 幂等。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { pngBuf, multipartBody, req, startTestServer } from './helpers.mjs'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 假方舟：任何请求都回一张 16x16 PNG 的 b64 */
async function startFakeArk() {
  const calls = []
  const server = createServer((r, res) => {
    const chunks = []
    r.on('data', (c) => chunks.push(c))
    r.on('end', () => {
      try {
        calls.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        calls.push(null)
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ b64_json: pngBuf(16, 16).toString('base64') }] }))
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

/** 上传一张图到素材（multipart，字段 file） */
async function uploadImage(base, materialId, buf) {
  const boundary = 'styling-opt-test'
  const r = await fetch(`${base}/api/materials/${materialId}/images`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: multipartBody(boundary, 'file', 'tile.png', 'image/png', buf)
  })
  return { status: r.status, data: await r.json() }
}

/** 收集 SSE 至 done（或超时抛错） */
async function collectSse(url, timeoutMs = 8000) {
  const res = await fetch(url, { headers: { Accept: 'text/event-stream' } })
  assert.equal(res.status, 200)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const events = []
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const lines = frame.split('\n')
      const name = lines.find((l) => l.startsWith('event:'))?.slice(6).trim()
      const raw = lines.find((l) => l.startsWith('data:'))?.slice(5).trim()
      if (!name) continue
      let data = null
      try {
        data = raw ? JSON.parse(raw) : null
      } catch {
        data = null
      }
      events.push({ event: name, data })
      if (name === 'done') {
        reader.cancel().catch(() => {})
        return events
      }
    }
  }
  throw new Error('SSE 收集超时')
}

test('素材优化链路：发起 → SSE 全事件 → adopt（新主图 + 原图保留 + 文件可取）', async () => {
  const ark = await startFakeArk()
  const t = await startTestServer({
    settingsPatch: { arkApiKey: 'test-key', arkModel: 'seedream-test', arkBaseUrl: `${ark.base}/api/v3` }
  })
  try {
    const created = await req(t.base, 'POST', '/api/materials', { name: '脏图瓷砖', scene: '瓷砖', tags: ['地面'] })
    const mid = created.data.id
    const up = await uploadImage(t.base, mid, pngBuf(8, 8))
    assert.equal(up.status, 200)
    assert.equal(up.data.images.length, 1)

    const start = await req(t.base, 'POST', `/api/materials/${mid}/optimize`, { index: 0 })
    assert.equal(start.status, 200)
    assert.match(start.data.taskId, /^o-\d{14}-[0-9a-f]{4}$/)

    const events = await collectSse(`${t.base}/api/materials/${mid}/optimize/${start.data.taskId}/stream`)
    const names = events.map((e) => e.event)
    assert.equal(names[0], 'snapshot')
    assert.ok(names.includes('result'))
    assert.equal(names[names.length - 1], 'done')
    const result = events.find((e) => e.event === 'result')
    assert.equal(result.data.file, `files/materials/${mid}/opt-${start.data.taskId}.png`)

    // 假方舟确实收到了请求（prompt 含优化指令）
    assert.equal(ark.calls.length, 1)
    assert.match(ark.calls[0].prompt, /素材图清理/)
    assert.equal(ark.calls[0].image.length, 1)

    const adopted = await req(t.base, 'POST', `/api/materials/${mid}/optimize/${start.data.taskId}/adopt`)
    assert.equal(adopted.status, 200)
    assert.equal(adopted.data.images.length, 2)
    assert.deepEqual(adopted.data.images.map((i) => i.primary), [false, true])
    assert.equal(adopted.data.images[1].file, `files/materials/${mid}/2.png`)
    assert.equal(adopted.data.images[1].width, 16)
    assert.equal(adopted.data.images[1].height, 16)

    const img = await fetch(`${t.base}/${adopted.data.images[1].file}`)
    assert.equal(img.status, 200)
    const buf = Buffer.from(await img.arrayBuffer())
    assert.ok(buf.subarray(0, 8).equals(PNG_SIG))

    // 任务已移除：adopt 再调 404
    const again = await req(t.base, 'POST', `/api/materials/${mid}/optimize/${start.data.taskId}/adopt`)
    assert.equal(again.status, 404)
  } finally {
    await t.close()
    await ark.close()
  }
})

test('素材优化：未配置方舟 → 400 ARK_NOT_CONFIGURED', async () => {
  const t = await startTestServer({ settingsPatch: { arkApiKey: '', arkModel: '' } })
  try {
    const created = await req(t.base, 'POST', '/api/materials', { name: 'x', scene: '瓷砖' })
    const mid = created.data.id
    await uploadImage(t.base, mid, pngBuf(8, 8))
    const r = await req(t.base, 'POST', `/api/materials/${mid}/optimize`, { index: 0 })
    assert.equal(r.status, 400)
    assert.equal(r.data.error.code, 'ARK_NOT_CONFIGURED')
    assert.match(r.data.error.message, /未配置方舟图生图/)
  } finally {
    await t.close()
  }
})

test('素材优化：stream/adopt/discard 的 404 与幂等', async () => {
  const t = await startTestServer()
  try {
    const created = await req(t.base, 'POST', '/api/materials', { name: 'x', scene: '瓷砖' })
    const mid = created.data.id
    const missing = 'o-20260101000000-abcd'
    const s = await fetch(`${t.base}/api/materials/${mid}/optimize/${missing}/stream`)
    assert.equal(s.status, 404)
    const body = await s.json()
    assert.equal(body.error.code, 'OPT_NOT_FOUND')

    // discard 对不存在的任务幂等返回 ok
    const d = await req(t.base, 'POST', `/api/materials/${mid}/optimize/${missing}/discard`)
    assert.equal(d.status, 200)
    assert.equal(d.data.ok, true)

    // 非法 taskId 不会被当作文件路径处理
    const d2 = await req(t.base, 'POST', `/api/materials/${mid}/optimize/..%2F..%2Fetc/discard`)
    assert.equal(d2.status, 200)
    assert.equal(d2.data.ok, true)
  } finally {
    await t.close()
  }
})
