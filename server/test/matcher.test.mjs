/** matcher.mjs 单测（打分规则 §7）+ auto-recommend / auto-fill 集成测试。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { rankMaterials } from '../lib/matcher.mjs'
import { multipartBody, pngBuf, req, startTestServer } from './helpers.mjs'

function mk(id, { tags = [], scene = '其他', name = null, description = '', withImage = true, updatedAt = '2026-01-01T00:00:00.000+08:00' } = {}) {
  return {
    id,
    name: name ?? id,
    description,
    scene,
    tags,
    images: withImage ? [{ file: `files/materials/${id}/1.png`, primary: true }] : [],
    updatedAt
  }
}

test('rankMaterials：命中×2 / 同场景+1 / 名称描述+0.5', () => {
  const materials = [
    mk('a', { tags: ['客厅', '灰色'], scene: '瓷砖' }),
    mk('b', { tags: ['客厅'], scene: '瓷砖' }),
    mk('c', { tags: ['客厅'], scene: '首饰' }),
    mk('d', { tags: [], scene: '瓷砖' }),
    mk('e', { tags: ['客厅'], scene: '其他', name: '客厅专用' }),
    mk('f', { tags: ['客厅'], scene: '其他', description: '适合客厅的灰色调' })
  ]
  const ranked = rankMaterials({ baseTags: ['客厅', '灰色'], scene: '瓷砖', materials })
  const score = Object.fromEntries(ranked.map((r) => [r.materialId, r.score]))
  assert.equal(score.a, 2 * 2 + 1) // 两个标签命中 + 同场景
  assert.equal(score.b, 2 + 1)
  assert.equal(score.c, 2)
  assert.equal(score.d, 1)
  assert.equal(score.e, 2 + 0.5) // 名称命中「客厅」
  assert.equal(score.f, 2 + 0.5 + 0.5) // 描述同时命中「客厅」与「灰色」
  // 降序（b 与 f 同分，updatedAt 相同按插入顺序稳定）
  assert.deepEqual(ranked.map((r) => r.materialId), ['a', 'b', 'f', 'e', 'c', 'd'])
})

test('rankMaterials：剔除无图 / 同分按 updatedAt 新者先 / limit 截断', () => {
  const materials = [
    mk('old', { tags: ['x'], updatedAt: '2026-01-01T00:00:00.000+08:00' }),
    mk('new', { tags: ['x'], updatedAt: '2026-06-01T00:00:00.000+08:00' }),
    mk('noimg', { tags: ['x'], withImage: false, updatedAt: '2026-12-01T00:00:00.000+08:00' })
  ]
  const ranked = rankMaterials({ baseTags: ['x'], scene: '', materials })
  assert.deepEqual(ranked.map((r) => r.materialId), ['new', 'old'])
  const limited = rankMaterials({ baseTags: ['x'], scene: '', materials, limit: 1 })
  assert.deepEqual(limited.map((r) => r.materialId), ['new'])
})

async function seed(base) {
  const t = await req(base, 'POST', '/api/templates', { name: '客厅样板', scene: '瓷砖', tags: ['客厅', '灰色'] })
  const tId = t.data.id
  const boundary = 'B'
  await fetch(`${base}/api/templates/${tId}/images`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: multipartBody(boundary, 'file', 't.png', 'image/png', pngBuf(8, 8))
  })
  const mA = await req(base, 'POST', '/api/materials', { name: 'A', scene: '瓷砖', tags: ['客厅', '灰色'] })
  const mB = await req(base, 'POST', '/api/materials', { name: 'B', scene: '瓷砖', tags: ['客厅'] })
  const mC = await req(base, 'POST', '/api/materials', { name: 'C', scene: '首饰', tags: ['客厅'] }) // 无图
  const mD = await req(base, 'POST', '/api/materials', { name: 'D', scene: '瓷砖', tags: [] })
  for (const id of [mA.data.id, mB.data.id, mD.data.id]) {
    await fetch(`${base}/api/materials/${id}/images`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: multipartBody(boundary, 'file', 'm.png', 'image/png', pngBuf(8, 8))
    })
  }
  return { tId, mA: mA.data.id, mB: mB.data.id, mC: mC.data.id, mD: mD.data.id }
}

test('POST /api/renders/auto-recommend：打分排序 / 剔除无图 / limit', async () => {
  const { base, close } = await startTestServer()
  try {
    const { tId, mA, mB, mC, mD } = await seed(base)
    const r = await req(base, 'POST', '/api/renders/auto-recommend', { templateId: tId, limit: 2 })
    assert.equal(r.status, 200)
    assert.deepEqual(r.data.recommended, [mA, mB])
    const ids = r.data.candidates.map((c) => c.materialId)
    assert.ok(!ids.includes(mC), '无图素材应被剔除')
    assert.deepEqual(ids, [mA, mB, mD])
    assert.equal(r.data.candidates[0].score, 5)
  } finally {
    await close()
  }
})

test('POST /api/presets/:id/auto-fill：逐插槽推荐 / 无命中 recommended:null', async () => {
  const { base, close } = await startTestServer()
  try {
    const { tId, mA, mB, mD } = await seed(base)
    const p = await req(base, 'POST', '/api/presets', {
      name: '客厅预设',
      templateId: tId,
      slots: [
        { name: '主材', tags: ['灰色'], positionNote: '' },
        { name: '无命中', tags: ['不存在的标签'], positionNote: '' }
      ]
    })
    const r = await req(base, 'POST', `/api/presets/${p.data.id}/auto-fill`, {})
    assert.equal(r.status, 200)
    const [s1, s2] = r.data.slots
    assert.equal(s1.slotId, 's-1')
    assert.equal(s1.recommended, mA)
    assert.ok(s1.candidates.some((c) => c.materialId === mB))
    assert.equal(s2.slotId, 's-2')
    assert.equal(s2.recommended, null)
    // 兜底候选：同场景优先（D/B/A 均有同场景分，无图 C 剔除）
    assert.ok(s2.candidates.length >= 3)
    assert.ok(!s2.candidates.some((c) => c.materialId === 'x'))
    assert.ok(s2.candidates.map((c) => c.materialId).includes(mD))
  } finally {
    await close()
  }
})
