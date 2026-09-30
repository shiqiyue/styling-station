/** store.mjs 测试：CRUD、校验、软删、原子写、图片与预设边界、记录。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/store.mjs'
import { HttpError } from '../lib/http.mjs'

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'styling-store-'))
  const store = createStore({ dataDir: dir })
  return { dir, store, done: () => rmSync(dir, { recursive: true, force: true }) }
}

function throws400(fn, msgPart = '') {
  assert.throws(fn, (e) => {
    assert.ok(e instanceof HttpError, `期望 HttpError，实际得到：${e}`)
    assert.equal(e.status, 400)
    assert.ok(e.message.includes(msgPart), `消息应包含「${msgPart}」，实际为「${e.message}」`)
    return true
  })
}

test('create/get：默认值与 id 前缀', () => {
  const { store, done } = tmpStore()
  const m = store.create('materials', { name: ' 白瓷花瓶 ', description: '', scene: '首饰', tags: ['客厅'] })
  assert.match(m.id, /^m-\d{14}-[0-9a-f]{4}$/)
  assert.equal(m.name, '白瓷花瓶')
  assert.deepEqual(m.images, [])
  assert.equal(m.deleted, false)
  assert.ok(m.createdAt && m.updatedAt)
  assert.deepEqual(store.get('materials', m.id), m)
  const t = store.create('templates', { name: '卧室', scene: '其他' })
  assert.match(t.id, /^t-\d{14}-[0-9a-f]{4}$/)
  done()
})

test('create 校验：name/description/scene/tags 边界', () => {
  const { store, done } = tmpStore()
  throws400(() => store.create('materials', { name: '   ', scene: '其他' }), '名称')
  throws400(() => store.create('materials', { name: 'x'.repeat(51), scene: '其他' }), '名称')
  throws400(() => store.create('materials', { name: 'ok', description: 'x'.repeat(501), scene: '其他' }), '描述')
  throws400(() => store.create('materials', { name: 'ok', scene: '' }), '场景')
  throws400(
    () => store.create('materials', { name: 'ok', scene: '其他', tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }),
    '标签'
  )
  throws400(() => store.create('materials', { name: 'ok', scene: '其他', tags: ['x'.repeat(21)] }), '标签')
  const m = store.create('materials', { name: 'ok', scene: '其他', tags: [' 蓝 ', '蓝', '', '蓝釉'] })
  assert.deepEqual(m.tags, ['蓝', '蓝釉'])
  done()
})

test('update：改字段 / 校验 / 404', () => {
  const { store, done } = tmpStore()
  const m = store.create('materials', { name: 'a', description: '旧', scene: '瓷砖' })
  const upd = store.update('materials', m.id, { name: 'b', tags: ['地面'] })
  assert.equal(upd.name, 'b')
  assert.equal(upd.description, '旧')
  assert.deepEqual(upd.tags, ['地面'])
  throws400(() => store.update('materials', m.id, { name: '' }), '名称')
  assert.throws(() => store.update('materials', 'm-nope', { name: 'x' }), /不存在/)
  done()
})

test('list：筛选 / 搜索 / 分页 / hasImage', () => {
  const { store, done } = tmpStore()
  const a = store.create('materials', { name: '白砖', description: '哑光面', scene: '瓷砖', tags: ['客厅', '灰色'] })
  const b = store.create('materials', { name: '木地板', description: '复合', scene: '瓷砖', tags: ['客厅'] })
  const c = store.create('materials', { name: '项链', scene: '首饰', tags: ['金色'] })
  store.addImage('materials', c.id, { file: 'files/materials/x/1.png', width: 8, height: 8 })

  assert.equal(store.list('materials', {}).total, 3)
  const byScene = store.list('materials', { scene: '瓷砖' })
  assert.deepEqual(byScene.items.map((i) => i.id).sort(), [a.id, b.id].sort())
  const byTags = store.list('materials', { tags: ['客厅', '灰色'] })
  assert.deepEqual(byTags.items.map((i) => i.id), [a.id])
  const byQ = store.list('materials', { q: '哑光' })
  assert.deepEqual(byQ.items.map((i) => i.id), [a.id])
  assert.equal(byQ.items[0].hasImage, false)
  const paged = store.list('materials', { limit: 2, offset: 1 })
  assert.equal(paged.total, 3)
  assert.equal(paged.items.length, 2)
  const hasImg = store.list('materials', { q: '项链' })
  assert.equal(hasImg.items[0].hasImage, true)
  done()
})

test('list：更新后倒序置顶', async () => {
  const { store, done } = tmpStore()
  const a = store.create('materials', { name: 'A', scene: '其他' })
  store.create('materials', { name: 'B', scene: '其他' })
  await new Promise((r) => setTimeout(r, 5))
  store.update('materials', a.id, { name: 'A2' })
  assert.equal(store.list('materials', {}).items[0].id, a.id)
  done()
})

test('软删 / 恢复 / includeDeleted', () => {
  const { store, done } = tmpStore()
  const m = store.create('materials', { name: 'x', scene: '其他' })
  store.remove('materials', m.id)
  assert.equal(store.list('materials', {}).total, 0)
  assert.equal(store.list('materials', { includeDeleted: true }).total, 1)
  assert.equal(store.get('materials', m.id).deleted, true)
  store.undelete('materials', m.id)
  assert.equal(store.list('materials', {}).total, 1)
  assert.throws(() => store.remove('materials', 'm-nope'), /不存在/)
  done()
})

test('原子写：落盘可回读、无 .tmp 残留', () => {
  const { dir, store, done } = tmpStore()
  const m = store.create('materials', { name: '持久化', scene: '其他' })
  const lib = JSON.parse(readFileSync(join(dir, 'library.json'), 'utf8'))
  assert.ok(lib.materials[m.id])
  assert.ok(existsSync(join(dir, 'renders.json')))
  assert.equal(readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0)
  const store2 = createStore({ dataDir: dir })
  assert.equal(store2.get('materials', m.id).name, '持久化')
  done()
})

test('addImage / removeImage 边界', () => {
  const { store, done } = tmpStore()
  const m = store.create('materials', { name: 'x', scene: '其他' })
  const i1 = store.addImage('materials', m.id, { file: 'files/materials/m/1.png', width: 8, height: 8 })
  assert.equal(i1.primary, true)
  const i2 = store.addImage('materials', m.id, { file: 'files/materials/m/2.png', width: 8, height: 8 })
  assert.equal(i2.primary, false)
  // 删主图 → 余下首张自动变主图
  store.removeImage('materials', m.id, 0)
  const after = store.get('materials', m.id)
  assert.equal(after.images.length, 1)
  assert.equal(after.images[0].primary, true)
  // 剩 1 张再删 → 400
  throws400(() => store.removeImage('materials', m.id, 0), '至少')
  // 越界
  throws400(() => store.removeImage('materials', m.id, 5), '不存在')
  done()
})

test('preset：创建校验 / 插槽 id / 整体替换 / templateValid', () => {
  const { store, done } = tmpStore()
  const t = store.create('templates', { name: '卧室', scene: '其他' })
  const p = store.createPreset({
    name: '现代卧室',
    templateId: t.id,
    slots: [
      { name: '墙纸', tags: ['墙纸'], positionNote: '床头上方' },
      { name: '地板', tags: [], positionNote: '' }
    ]
  })
  assert.match(p.id, /^p-\d{14}-[0-9a-f]{4}$/)
  assert.deepEqual(p.slots.map((s) => s.id), ['s-1', 's-2'])
  assert.equal(p.templateValid, true)
  assert.equal(p.template.id, t.id)
  assert.equal(p.template.primary, null)

  throws400(() => store.createPreset({ name: 'x', templateId: t.id, slots: [] }), '插槽')
  throws400(
    () =>
      store.createPreset({
        name: 'x',
        templateId: t.id,
        slots: Array.from({ length: 11 }, (_, i) => ({ name: `s${i}`, tags: [], positionNote: '' }))
      }),
    '插槽'
  )
  throws400(() => store.createPreset({ name: 'x', templateId: t.id, slots: [{ name: '', tags: [] }] }), '插槽名称')
  throws400(() => store.createPreset({ name: 'x', templateId: t.id, slots: [{ name: 'ok', tags: ['x'.repeat(21)] }] }), '标签')
  throws400(
    () =>
      store.createPreset({
        name: 'x',
        templateId: t.id,
        slots: [{ name: 'ok', tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }]
      }),
    '标签'
  )
  throws400(() => store.createPreset({ name: 'x', templateId: t.id, slots: [{ name: 'ok', positionNote: 'x'.repeat(201) }] }), '位置说明')
  throws400(() => store.createPreset({ name: 'x', templateId: 't-nope', slots: [{ name: 'ok' }] }), '样板')

  // 整体替换 slots：顺序变化、id 重生成
  const up = store.updatePreset(p.id, {
    slots: [
      { name: '地板', tags: [], positionNote: '' },
      { name: '墙纸', tags: [], positionNote: '' }
    ]
  })
  assert.deepEqual(up.slots.map((s) => s.name), ['地板', '墙纸'])
  assert.deepEqual(up.slots.map((s) => s.id), ['s-1', 's-2'])

  // 样板软删 → 失效；恢复 → 有效
  store.remove('templates', t.id)
  assert.equal(store.getPreset(p.id).templateValid, false)
  assert.equal(store.getPreset(p.id).template, null)
  store.undelete('templates', t.id)
  assert.equal(store.getPreset(p.id).templateValid, true)
  done()
})

test('preset：duplicate / 软删恢复 / 列表筛选', () => {
  const { store, done } = tmpStore()
  const t = store.create('templates', { name: '卧室', scene: '其他' })
  const p = store.createPreset({ name: '现代卧室', templateId: t.id, slots: [{ name: '墙纸' }] })
  const dup = store.duplicatePreset(p.id)
  assert.notEqual(dup.id, p.id)
  assert.equal(dup.name, '现代卧室 副本')
  assert.deepEqual(dup.slots.map((s) => s.id), ['s-1'])
  assert.equal(store.listPresets({ q: '现代' }).total, 2)
  store.removePreset(p.id)
  assert.equal(store.listPresets({}).total, 1)
  assert.equal(store.listPresets({ includeDeleted: true }).total, 2)
  store.undeletePreset(p.id)
  assert.equal(store.listPresets({}).total, 2)
  assert.throws(() => store.getPreset('p-nope'), /不存在/)
  done()
})

test('render：创建 / 更新 / 列表筛选 / 版本链', () => {
  const { store, done } = tmpStore()
  const r1 = store.createRender({
    mode: 'free',
    status: 'queued',
    templateSnapshot: { id: 't-1', name: '样板' },
    materialsSnapshot: [{ id: 'm-1', name: '素材' }],
    results: []
  })
  assert.match(r1.id, /^r-\d{14}-[0-9a-f]{4}$/)
  assert.ok(r1.createdAt)
  const r2 = store.createRender({
    mode: 'free',
    status: 'queued',
    parentId: r1.id,
    templateSnapshot: { id: 't-1' },
    materialsSnapshot: [{ id: 'm-2' }],
    results: []
  })
  store.updateRender(r1.id, { status: 'done', elapsedMs: 1234 })
  assert.equal(store.getRender(r1.id).status, 'done')
  assert.throws(() => store.getRender('r-nope'), /不存在/)
  assert.equal(store.listRenders({ templateId: 't-1' }).total, 2)
  assert.deepEqual(store.listRenders({ materialId: 'm-2' }).items.map((i) => i.id), [r2.id])
  const kids = store.renderChildren(r1.id)
  assert.deepEqual(kids.map((k) => k.id), [r2.id])
  assert.equal(kids[0].status, 'queued')
  done()
})

test('scenes / tags 聚合', () => {
  const { store, done } = tmpStore()
  assert.deepEqual(store.scenes().slice(0, 4), ['首饰', '瓷砖', '服装鞋帽', '其他'])
  const m = store.create('materials', { name: 'a', scene: '灯具', tags: ['暖光'] })
  assert.ok(store.scenes().includes('灯具'))
  assert.deepEqual(store.tags('materials'), ['暖光'])
  store.create('templates', { name: 'b', scene: '其他', tags: ['客厅'] })
  assert.deepEqual(store.tags('templates'), ['客厅'])
  store.remove('materials', m.id)
  assert.deepEqual(store.tags('materials'), [])
  done()
})

test('addImage：显式 primary 提升为主图并降级既有主图；缺省行为向后兼容', () => {
  const { store, done } = tmpStore()
  try {
    const m = store.create('materials', { name: 'a', scene: '瓷砖' })
    store.addImage('materials', m.id, { file: 'files/materials/x/1.png' })
    store.addImage('materials', m.id, { file: 'files/materials/x/2.png' })
    let doc = store.get('materials', m.id)
    assert.deepEqual(doc.images.map((i) => i.primary), [true, false]) // 旧行为不变

    store.addImage('materials', m.id, { file: 'files/materials/x/3.png', primary: true })
    doc = store.get('materials', m.id)
    assert.deepEqual(doc.images.map((i) => i.primary), [false, false, true])
    assert.equal(doc.images[2].width, 0) // 缺省 width/height 行为不变
  } finally {
    done()
  }
})
