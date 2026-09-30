/** 预设 API 集成测试。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pngBuf, multipartBody, req, startTestServer } from './helpers.mjs'

async function makeTemplate(base, name = '卧室') {
  const t = await req(base, 'POST', '/api/templates', { name, scene: '其他', tags: ['北欧'] })
  const boundary = 'TB'
  await fetch(`${base}/api/templates/${t.data.id}/images`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: multipartBody(boundary, 'file', 't.png', 'image/png', pngBuf(8, 8))
  })
  return t.data.id
}

test('预设：建 / 查 / 改 slots / duplicate / 软删恢复', async () => {
  const { base, close } = await startTestServer()
  try {
    const tId = await makeTemplate(base)

    const c = await req(base, 'POST', '/api/presets', {
      name: '现代卧室',
      templateId: tId,
      slots: [
        { name: '墙纸', tags: ['墙纸', '现代'], positionNote: '贴在床头背景墙上' },
        { name: '地板', tags: ['地板'], positionNote: '' }
      ]
    })
    assert.equal(c.status, 200)
    const p = c.data
    assert.match(p.id, /^p-/)
    assert.deepEqual(p.slots.map((s) => s.id), ['s-1', 's-2'])
    assert.equal(p.templateValid, true)
    assert.equal(p.template.id, tId)
    assert.ok(p.template.primary, '样板轻量信息应带首图')

    const got = await req(base, 'GET', `/api/presets/${p.id}`)
    assert.equal(got.data.name, '现代卧室')

    const list = await req(base, 'GET', '/api/presets')
    assert.equal(list.data.total, 1)
    assert.equal(list.data.items[0].templateValid, true)

    // 整体替换 slots：id 重生成保持顺序
    const put = await req(base, 'PUT', `/api/presets/${p.id}`, {
      slots: [
        { name: '地板', tags: [], positionNote: '铺满地面' },
        { name: '墙纸', tags: [], positionNote: '' },
        { name: '窗帘', tags: ['布艺'], positionNote: '挂在窗边' }
      ]
    })
    assert.deepEqual(put.data.slots.map((s) => s.id), ['s-1', 's-2', 's-3'])
    assert.deepEqual(put.data.slots.map((s) => s.name), ['地板', '墙纸', '窗帘'])

    const dup = await req(base, 'POST', `/api/presets/${p.id}/duplicate`)
    assert.equal(dup.data.name, '现代卧室 副本')
    assert.equal((await req(base, 'GET', '/api/presets')).data.total, 2)

    // 样板软删 → templateValid false
    await req(base, 'DELETE', `/api/templates/${tId}`)
    const afterDel = await req(base, 'GET', `/api/presets/${p.id}`)
    assert.equal(afterDel.data.templateValid, false)
    assert.equal(afterDel.data.template, null)
    // 恢复样板 → 有效
    await req(base, 'POST', `/api/templates/${tId}/undelete`)
    assert.equal((await req(base, 'GET', `/api/presets/${p.id}`)).data.templateValid, true)

    // 预设软删 / 恢复 / q 搜索
    await req(base, 'DELETE', `/api/presets/${p.id}`)
    assert.equal((await req(base, 'GET', '/api/presets')).data.total, 1)
    assert.equal((await req(base, 'GET', '/api/presets?includeDeleted=1')).data.total, 2)
    await req(base, 'POST', `/api/presets/${p.id}/undelete`)
    assert.equal((await req(base, 'GET', '/api/presets?q=副本')).data.total, 1)
    assert.equal((await req(base, 'GET', '/api/presets?q=现代')).data.total, 2)
  } finally {
    await close()
  }
})

test('预设校验：slots 边界 / 名称 / 样板无效', async () => {
  const { base, close } = await startTestServer()
  try {
    const tId = await makeTemplate(base)

    const empty = await req(base, 'POST', '/api/presets', { name: 'x', templateId: tId, slots: [] })
    assert.equal(empty.status, 400)
    assert.ok(empty.data.error.message.includes('插槽'))

    const many = await req(base, 'POST', '/api/presets', {
      name: 'x',
      templateId: tId,
      slots: Array.from({ length: 11 }, (_, i) => ({ name: `s${i}`, tags: [], positionNote: '' }))
    })
    assert.equal(many.status, 400)

    const badName = await req(base, 'POST', '/api/presets', { name: '', templateId: tId, slots: [{ name: 'ok' }] })
    assert.equal(badName.status, 400)

    const badSlotName = await req(base, 'POST', '/api/presets', {
      name: 'x',
      templateId: tId,
      slots: [{ name: 'x'.repeat(21), tags: [], positionNote: '' }]
    })
    assert.equal(badSlotName.status, 400)

    const badTemplate = await req(base, 'POST', '/api/presets', { name: 'x', templateId: 't-nope', slots: [{ name: 'ok' }] })
    assert.equal(badTemplate.status, 400)
    assert.ok(badTemplate.data.error.message.includes('样板'))

    assert.equal((await req(base, 'GET', '/api/presets/p-nope')).status, 404)
  } finally {
    await close()
  }
})
