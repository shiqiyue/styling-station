import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.mjs'

test('GET /api/health 返回 ok 与基础信息', async () => {
  const s = await startTestServer()
  try {
    const r = await fetch(`${s.base}/api/health`)
    assert.equal(r.status, 200)
    const j = await r.json()
    assert.equal(j.ok, true)
    assert.equal(j.port, s.srv.port)
    assert.deepEqual(j.queue, { running: 0, pending: 0 })
    assert.ok(j.cli && (j.cli.command || j.cli.error), 'cli 字段应有 command 或 error')
  } finally {
    await s.close()
  }
})

test('GET / 返回 index.html 占位页', async () => {
  const s = await startTestServer()
  try {
    const r = await fetch(`${s.base}/`)
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type'), /text\/html/)
    const html = await r.text()
    assert.match(html, /搭配台/)
  } finally {
    await s.close()
  }
})

test('未知 API 返回 404 JSON 错误', async () => {
  const s = await startTestServer()
  try {
    const r = await fetch(`${s.base}/api/nope`)
    assert.equal(r.status, 404)
    const j = await r.json()
    assert.equal(j.error.code, 'NOT_FOUND')
    assert.ok(j.error.message.includes('接口不存在'))
  } finally {
    await s.close()
  }
})

test('静态路径穿越被拒绝', async () => {
  const s = await startTestServer()
  try {
    const r = await fetch(`${s.base}/..%2fserver%2fserver.mjs`)
    assert.ok([403, 404].includes(r.status), `应拒绝穿越，实际 ${r.status}`)
  } finally {
    await s.close()
  }
})
