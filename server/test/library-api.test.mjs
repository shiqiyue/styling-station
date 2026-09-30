/** 素材 / 样板 API 集成测试（真实服务 + 临时数据目录）。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { multipartBody, pngBuf, req, startTestServer } from './helpers.mjs'

async function uploadPng(base, kind, id, buf, filename = 'x.png') {
  const boundary = 'TESTBOUNDARY123'
  const r = await fetch(`${base}/api/${kind}/${id}/images`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: multipartBody(boundary, 'file', filename, 'image/png', buf)
  })
  return { status: r.status, data: await r.json() }
}

test('素材 CRUD / 筛选 / 软删恢复', async () => {
  const { base, close } = await startTestServer()
  try {
    const c1 = await req(base, 'POST', '/api/materials', { name: '白砖', description: '哑光面', scene: '瓷砖', tags: ['客厅', '灰色'] })
    assert.equal(c1.status, 200)
    const id = c1.data.id

    const list = await req(base, 'GET', '/api/materials')
    assert.equal(list.data.total, 1)
    assert.equal(list.data.items[0].hasImage, false)

    const put = await req(base, 'PUT', `/api/materials/${id}`, { name: '白砖2', scene: '瓷砖', tags: ['客厅'] })
    assert.equal(put.data.name, '白砖2')

    assert.equal((await req(base, 'GET', '/api/materials?tags=客厅,灰色')).data.total, 0)
    assert.equal((await req(base, 'GET', '/api/materials?tags=客厅&q=白砖')).data.total, 1)
    assert.equal((await req(base, 'GET', '/api/materials?scene=瓷砖')).data.total, 1)
    assert.equal((await req(base, 'GET', '/api/materials?scene=首饰')).data.total, 0)

    const del = await req(base, 'DELETE', `/api/materials/${id}`)
    assert.equal(del.data.deleted, true)
    assert.equal((await req(base, 'GET', '/api/materials')).data.total, 0)
    assert.equal((await req(base, 'GET', '/api/materials?includeDeleted=1')).data.total, 1)
    assert.equal((await req(base, 'POST', `/api/materials/${id}/undelete`)).data.deleted, false)
    assert.equal((await req(base, 'GET', '/api/materials')).data.total, 1)

    const bad = await req(base, 'POST', '/api/materials', { name: '', scene: 'x' })
    assert.equal(bad.status, 400)
    assert.ok(bad.data.error.message.includes('名称'))
    assert.equal((await req(base, 'GET', '/api/materials/m-nope')).status, 404)
  } finally {
    await close()
  }
})

test('图片上传：解析宽高 / 真实落盘 / 静态可访问 / 列表 hasImage', async () => {
  const { base, dataDir, close } = await startTestServer()
  try {
    const c = await req(base, 'POST', '/api/materials', { name: '花瓶', scene: '首饰' })
    const id = c.data.id

    const up = await uploadPng(base, 'materials', id, pngBuf(320, 200))
    assert.equal(up.status, 200)
    assert.equal(up.data.images.length, 1)
    assert.equal(up.data.images[0].primary, true)
    assert.equal(up.data.images[0].width, 320)
    assert.equal(up.data.images[0].height, 200)

    const rel = up.data.images[0].file
    assert.match(rel, new RegExp(`^files/materials/${id}/1\\.png$`))
    assert.ok(existsSync(join(dataDir, rel)), '图片应真实落盘')

    const img = await fetch(`${base}/${rel}`)
    assert.equal(img.status, 200)
    assert.equal(img.headers.get('content-type'), 'image/png')

    assert.equal((await req(base, 'GET', '/api/materials')).data.items[0].hasImage, true)

    const up2 = await uploadPng(base, 'materials', id, pngBuf(100, 100))
    assert.equal(up2.data.images.length, 2)
    assert.equal(up2.data.images[1].primary, false)
    assert.match(up2.data.images[1].file, new RegExp(`^files/materials/${id}/2\\.png$`))

    // 垃圾数据伪装成 PNG → 400
    const boundary = 'B'
    const bad = await fetch(`${base}/api/materials/${id}/images`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: multipartBody(boundary, 'file', 'fake.png', 'image/png', Buffer.from('this is not an image'))
    })
    assert.equal(bad.status, 400)
    assert.ok((await bad.json()).error.message.includes('仅支持'))
  } finally {
    await close()
  }
})

test('删图：删主图自动递补 / 剩 1 张拒绝 / 越界拒绝 / 文件被移除', async () => {
  const { base, dataDir, close } = await startTestServer()
  try {
    const c = await req(base, 'POST', '/api/materials', { name: 'x', scene: '其他' })
    const id = c.data.id
    const first = await uploadPng(base, 'materials', id, pngBuf(8, 8))
    await uploadPng(base, 'materials', id, pngBuf(8, 8))
    const firstRel = first.data.images[0].file

    const d0 = await req(base, 'DELETE', `/api/materials/${id}/images/0`)
    assert.equal(d0.status, 200)
    assert.equal(d0.data.images.length, 1)
    assert.equal(d0.data.images[0].primary, true)
    assert.ok(!existsSync(join(dataDir, firstRel)), '被删图片文件应从磁盘移除')

    assert.equal((await req(base, 'DELETE', `/api/materials/${id}/images/0`)).status, 400)
    assert.equal((await req(base, 'DELETE', `/api/materials/${id}/images/9`)).status, 400)
  } finally {
    await close()
  }
})

test('templates 同构 + /api/scenes 聚合', async () => {
  const { base, close } = await startTestServer()
  try {
    const t = await req(base, 'POST', '/api/templates', { name: '卧室', scene: '其他', tags: ['北欧'] })
    assert.equal(t.status, 200)
    assert.match(t.data.id, /^t-/)
    await req(base, 'POST', '/api/materials', { name: '壁纸', scene: '墙纸', tags: ['现代'] })

    const scenes = await req(base, 'GET', '/api/scenes')
    assert.deepEqual(scenes.data.scenes, ['首饰', '瓷砖', '服装鞋帽', '其他', '墙纸'])
    assert.deepEqual(scenes.data.tags.materials, ['现代'])
    assert.deepEqual(scenes.data.tags.templates, ['北欧'])

    const tl = await req(base, 'GET', '/api/templates')
    assert.equal(tl.data.items[0].hasImage, false)
    assert.equal((await req(base, 'POST', '/api/templates/t-nope/undelete')).status, 404)
  } finally {
    await close()
  }
})
