/** renders API 集成测试：自由/预设双模式全链路（fake CLI）+ SSE + stop/rerun/chosen。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startTestServer, pngBuf, multipartBody, req } from './helpers.mjs'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-qodercli.mjs', import.meta.url))

/** 临时设置环境变量（返回恢复函数；node:test 每个文件独立进程，文件内串行执行） */
function withEnv(env) {
  const saved = {}
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

async function uploadImage(base, kind, id, w = 8, h = 8) {
  const boundary = '----stylingtest' + Math.random().toString(16).slice(2)
  const body = multipartBody(boundary, 'file', 'test.png', 'image/png', pngBuf(w, h))
  const r = await fetch(`${base}/api/${kind}/${id}/images`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body
  })
  if (r.status !== 200) assert.fail(`上传图片失败：${await r.text()}`)
  return r.json()
}

async function makeMaterial(base, { noImage = false, ...patch } = {}) {
  const { data } = await req(base, 'POST', '/api/materials', {
    name: '素材',
    description: '',
    scene: '其他',
    tags: [],
    ...patch
  })
  if (!noImage) await uploadImage(base, 'materials', data.id)
  return data
}

async function makeTemplate(base, { noImage = false, ...patch } = {}) {
  const { data } = await req(base, 'POST', '/api/templates', {
    name: '样板',
    description: '',
    scene: '其他',
    tags: [],
    ...patch
  })
  if (!noImage) await uploadImage(base, 'templates', data.id)
  return data
}

/** 消费 SSE 流直到谓词命中或超时，返回已收到的事件数组 */
async function sseUntil(base, renderId, predicate, timeoutMs = 15000) {
  const ctrl = new AbortController()
  const events = []
  try {
    const res = await fetch(`${base}/api/renders/${renderId}/stream`, { signal: ctrl.signal })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/)
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const r = await Promise.race([
        reader
          .read()
          .then((x) => ({ kind: 'read', x }))
          .catch(() => ({ kind: 'err' })),
        new Promise((r2) => setTimeout(() => r2({ kind: 'tick' }), 100))
      ])
      if (r.kind === 'err') break
      if (r.kind === 'tick') continue
      if (r.x.done) break
      buf += dec.decode(r.x.value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (!frame || frame.startsWith(':')) continue // 心跳
        const lines = frame.split('\n')
        const evName = lines.find((l) => l.startsWith('event: '))?.slice(7)
        const dataLine = lines.find((l) => l.startsWith('data: '))
        if (!evName) continue
        const ev = { event: evName, data: dataLine ? JSON.parse(dataLine.slice(6)) : null }
        events.push(ev)
        if (predicate(ev, events)) return events
      }
    }
    return events
  } finally {
    ctrl.abort()
  }
}

/** 轮询等待记录达到指定状态 */
async function waitStatus(base, id, status, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { data } = await req(base, 'GET', `/api/renders/${id}`)
    if (data.status === status) return data
    await new Promise((r) => setTimeout(r, 40))
  }
  throw new Error(`等待状态 ${status} 超时（${id}）`)
}

test('renders：free 全链路（SSE snapshot/status/result/done + 落盘 + 队列归零）', async () => {
  const restore = withEnv({ FAKE_PNG_COUNT: '1' })
  const srv = await startTestServer({ settingsPatch: { qodercliPath: FIXTURE } })
  try {
    const m = await makeMaterial(srv.base)
    const t = await makeTemplate(srv.base)
    const { status, data } = await req(srv.base, 'POST', '/api/renders', {
      mode: 'free',
      templateId: t.id,
      materialIds: [m.id],
      positionNote: '把素材放在画面正中',
      candidateCount: 1
    })
    assert.equal(status, 200)
    assert.ok(data.renderId)

    const events = await sseUntil(srv.base, data.renderId, (ev) => ev.event === 'done')
    const seq = events.map((e) => e.event)
    assert.ok(seq.includes('snapshot'), `缺少 snapshot：${seq.join(',')}`)
    assert.ok(seq.includes('status'), `缺少 status：${seq.join(',')}`)
    assert.ok(seq.includes('result'), `缺少 result：${seq.join(',')}`)
    assert.equal(seq[seq.length - 1], 'done')

    const rec = (await req(srv.base, 'GET', `/api/renders/${data.renderId}`)).data
    assert.equal(rec.status, 'done')
    assert.equal(rec.mode, 'free')
    assert.equal(rec.results.length, 1)
    assert.ok(rec.results[0].file.startsWith(`files/renders/${data.renderId}/v1`))
    assert.ok(existsSync(join(srv.dataDir, rec.results[0].file)), 'v1.png 应落盘')
    assert.equal(rec.size, '1024x1024')
    assert.equal(rec.materialsSnapshot[0].id, m.id)
    assert.equal(rec.templateSnapshot.id, t.id)
    assert.ok(Array.isArray(rec.childrenIds))

    const health = (await req(srv.base, 'GET', '/api/health')).data
    assert.equal(health.queue.running, 0)
    assert.equal(health.queue.pending, 0)
  } finally {
    restore()
    await srv.close()
  }
})

test('renders：preset 全链路（快照带插槽名/位置；-p 正文落盘可断言）', async () => {
  const restore = withEnv({ FAKE_PNG_COUNT: '1' })
  const srv = await startTestServer({ settingsPatch: { qodercliPath: FIXTURE, keepWorkDirs: true } })
  try {
    const m = await makeMaterial(srv.base, { name: '素色墙纸', tags: ['现代'] })
    const t = await makeTemplate(srv.base, { name: '卧室样板', tags: ['卧室'] })
    const preset = (
      await req(srv.base, 'POST', '/api/presets', {
        name: '卧室预设',
        templateId: t.id,
        slots: [
          { name: '墙纸', tags: ['现代'], positionNote: '卧室右侧墙面' },
          { name: '地板', tags: [], positionNote: '' }
        ]
      })
    ).data
    const s1 = preset.slots[0].id
    const s2 = preset.slots[1].id

    const { status, data } = await req(srv.base, 'POST', '/api/renders', {
      mode: 'preset',
      presetId: preset.id,
      assignments: [
        { slotId: s1, materialId: m.id },
        { slotId: s2, materialId: m.id }
      ],
      positionNote: '',
      candidateCount: 1
    })
    assert.equal(status, 200)
    await sseUntil(srv.base, data.renderId, (ev) => ev.event === 'done')

    const rec = (await req(srv.base, 'GET', `/api/renders/${data.renderId}`)).data
    assert.equal(rec.status, 'done')
    assert.equal(rec.mode, 'preset')
    assert.equal(rec.presetSnapshot.id, preset.id)
    assert.equal(rec.materialsSnapshot[0].slotName, '墙纸')
    assert.equal(rec.materialsSnapshot[0].slotPosition, '卧室右侧墙面')
    assert.equal(rec.materialsSnapshot[1].slotName, '地板')

    // fake CLI 把 -p 正文写入 workDir：断言插槽名与插槽位置说明进入任务说明
    const prompt = readFileSync(join(srv.dataDir, 'work', data.renderId, 'task-prompt.txt'), 'utf8')
    assert.match(prompt, /插槽「墙纸」/)
    assert.match(prompt, /插槽位置说明：卧室右侧墙面/)
    assert.match(prompt, /插槽「地板」/)

    // 清理：记录中保留 workDir（keepWorkDirs=true）
  } finally {
    restore()
    await srv.close()
  }
})

test('renders：校验失败分支（无图素材/无图样板/超限/插槽缺素材/板失效）', async () => {
  const srv = await startTestServer({ settingsPatch: { qodercliPath: FIXTURE } })
  try {
    const t = await makeTemplate(srv.base)
    const withImg = await makeMaterial(srv.base)
    const bare = await makeMaterial(srv.base, { noImage: true })

    // 无图素材 → 400
    let r = await req(srv.base, 'POST', '/api/renders', {
      mode: 'free',
      templateId: t.id,
      materialIds: [bare.id],
      candidateCount: 1
    })
    assert.equal(r.status, 400)

    // 无图样板 → 400
    const bareT = await makeTemplate(srv.base, { noImage: true })
    r = await req(srv.base, 'POST', '/api/renders', {
      mode: 'free',
      templateId: bareT.id,
      materialIds: [withImg.id],
      candidateCount: 1
    })
    assert.equal(r.status, 400)

    // 素材超限（9 个）→ 400
    const ids = []
    for (let i = 0; i < 9; i++) ids.push((await makeMaterial(srv.base, { noImage: true })).id)
    r = await req(srv.base, 'POST', '/api/renders', {
      mode: 'free',
      templateId: t.id,
      materialIds: ids,
      candidateCount: 1
    })
    assert.equal(r.status, 400)

    // positionNote 超长 → 400
    r = await req(srv.base, 'POST', '/api/renders', {
      mode: 'free',
      templateId: t.id,
      materialIds: [withImg.id],
      candidateCount: 1,
      positionNote: 'x'.repeat(1001)
    })
    assert.equal(r.status, 400)

    // 候选张数非法 → 400
    r = await req(srv.base, 'POST', '/api/renders', {
      mode: 'free',
      templateId: t.id,
      materialIds: [withImg.id],
      candidateCount: 3
    })
    assert.equal(r.status, 400)

    // 预设：插槽缺素材 → 400
    const preset = (
      await req(srv.base, 'POST', '/api/presets', {
        name: '预设',
        templateId: t.id,
        slots: [
          { name: 'A', tags: [], positionNote: '' },
          { name: 'B', tags: [], positionNote: '' }
        ]
      })
    ).data
    r = await req(srv.base, 'POST', '/api/renders', {
      mode: 'preset',
      presetId: preset.id,
      assignments: [{ slotId: preset.slots[0].id, materialId: withImg.id }],
      candidateCount: 1
    })
    assert.equal(r.status, 400)

    // 预设：样板失效（样板被删）→ 400
    await req(srv.base, 'DELETE', `/api/templates/${t.id}`)
    r = await req(srv.base, 'POST', '/api/renders', {
      mode: 'preset',
      presetId: preset.id,
      assignments: [
        { slotId: preset.slots[0].id, materialId: withImg.id },
        { slotId: preset.slots[1].id, materialId: withImg.id }
      ],
      candidateCount: 1
    })
    assert.equal(r.status, 400)
  } finally {
    await srv.close()
  }
})

test('renders：stop 终止运行中任务', async () => {
  const restore = withEnv({ FAKE_PNG_COUNT: '1', FAKE_DELAY_MS: '500' })
  const srv = await startTestServer({ settingsPatch: { qodercliPath: FIXTURE } })
  try {
    const m = await makeMaterial(srv.base)
    const t = await makeTemplate(srv.base)
    const { data } = await req(srv.base, 'POST', '/api/renders', {
      mode: 'free',
      templateId: t.id,
      materialIds: [m.id],
      candidateCount: 1
    })
    const stopRes = await req(srv.base, 'POST', `/api/renders/${data.renderId}/stop`)
    assert.equal(stopRes.status, 200)
    assert.ok(['stopped', 'stopping'].includes(stopRes.data.status))
    const rec = await waitStatus(srv.base, data.renderId, 'stopped')
    assert.equal(rec.status, 'stopped')
  } finally {
    restore()
    await srv.close()
  }
})

test('renders：rerun 生成子记录（parentId/childrenIds + 参数覆盖）', async () => {
  const restore = withEnv({ FAKE_PNG_COUNT: '1' })
  const srv = await startTestServer({ settingsPatch: { qodercliPath: FIXTURE } })
  try {
    const m = await makeMaterial(srv.base)
    const t = await makeTemplate(srv.base)
    const { data } = await req(srv.base, 'POST', '/api/renders', {
      mode: 'free',
      templateId: t.id,
      materialIds: [m.id],
      candidateCount: 1
    })
    await waitStatus(srv.base, data.renderId, 'done')

    const rr = await req(srv.base, 'POST', `/api/renders/${data.renderId}/rerun`, { candidateCount: 2 })
    assert.equal(rr.status, 200)
    assert.ok(rr.data.renderId)
    assert.notEqual(rr.data.renderId, data.renderId)

    const child = await waitStatus(srv.base, rr.data.renderId, 'done')
    assert.equal(child.parentId, data.renderId)
    assert.equal(child.candidateCount, 2)
    assert.deepEqual(child.materialsSnapshot.map((x) => x.id), [m.id])

    const parent = (await req(srv.base, 'GET', `/api/renders/${data.renderId}`)).data
    assert.deepEqual(parent.childrenIds, [rr.data.renderId])

    const list = (await req(srv.base, 'GET', `/api/renders?templateId=${t.id}`)).data
    assert.ok(list.total >= 2)
  } finally {
    restore()
    await srv.close()
  }
})

test('renders：chosen 单选（标记另一张自动取消）', async () => {
  const restore = withEnv({ FAKE_PNG_COUNT: '2' })
  const srv = await startTestServer({ settingsPatch: { qodercliPath: FIXTURE } })
  try {
    const m = await makeMaterial(srv.base)
    const t = await makeTemplate(srv.base)
    const { data } = await req(srv.base, 'POST', '/api/renders', {
      mode: 'free',
      templateId: t.id,
      materialIds: [m.id],
      candidateCount: 2
    })
    const rec = await waitStatus(srv.base, data.renderId, 'done')
    assert.equal(rec.results.length, 2)

    let r = await req(srv.base, 'POST', `/api/renders/${data.renderId}/results/2/chosen`, { chosen: true })
    assert.equal(r.status, 200)
    assert.equal(r.data.results[1].chosen, true)
    assert.equal(r.data.results[0].chosen, false)

    r = await req(srv.base, 'POST', `/api/renders/${data.renderId}/results/1/chosen`, { chosen: true })
    assert.equal(r.data.results[0].chosen, true)
    assert.equal(r.data.results[1].chosen, false)

    r = await req(srv.base, 'POST', `/api/renders/${data.renderId}/results/1/chosen`, { chosen: false })
    assert.equal(r.data.results[0].chosen, false)

    // 越界 index → 400
    r = await req(srv.base, 'POST', `/api/renders/${data.renderId}/results/5/chosen`, { chosen: true })
    assert.equal(r.status, 400)
  } finally {
    restore()
    await srv.close()
  }
})
