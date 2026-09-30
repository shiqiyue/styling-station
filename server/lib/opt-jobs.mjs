/**
 * 素材图优化任务注册表（Spec: docs/specs/2026-09-30-material-image-optimize-design.md §3.1）。
 * - 内存 Map + 队列，并发固定 1；状态机 queued → running → done|error|cancelled。
 * - 单任务 = runImageEdit(attachments=[该素材原图])；产物先落
 *   files/materials/<mid>/opt-<taskId>.png（非 PNG 则 .jpg）供预览；
 *   adopt → 重命名为下一个空闲编号并 addImage(primary:true)；discard → 删除（幂等）。
 * - 重启即失效：restartCleanup 清掉素材目录下所有 opt-* 残留。
 * - taskId 由 store.newId('o') 生成，所有入口先过 OPT_TASK_ID_RE 防路径注入。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { HttpError } from './http.mjs'
import { imageDimensions, pickRenderSize } from './images.mjs'
import { runImageEdit } from './image-edit.mjs'
import { buildOptimizeInstruction } from './prompt.mjs'

const defaultRenderer = { runImageEdit }

export const OPT_TASK_ID_RE = /^o-\d{14}-[0-9a-f]{4}$/

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const OPT_NOT_FOUND = '优化任务不存在（服务可能已重启），请重新发起'

export function createOptJobs({ store, settings = {}, renderer = defaultRenderer } = {}) {
  const tasks = new Map()
  const pending = []
  let running = 0

  function emit(t, event, data) {
    if (event === 'delta') t.blocks.push({ channel: data.channel, text: data.text })
    for (const fn of t.subs) {
      try {
        fn({ event, data })
      } catch {
        /* 订阅者异常不影响任务 */
      }
    }
  }

  function snapshotOf(t) {
    return {
      taskId: t.id,
      status: t.status,
      queuePosition: t.status === 'queued' ? t.queuePosition : 0,
      blocks: t.blocks.map((b) => ({ ...b }))
    }
  }

  function viewOf(t) {
    return { ...snapshotOf(t), materialId: t.materialId, index: t.index, result: t.result, error: t.error }
  }

  function updateQueuePositions() {
    pending.forEach((id, i) => {
      const t = tasks.get(id)
      if (t && t.status === 'queued') t.queuePosition = i + 1
    })
  }

  function finalize(t, status) {
    t.status = status
    t.queuePosition = 0
    emit(t, 'status', { status, queuePosition: 0 })
    emit(t, 'done', { status })
  }

  function submit({ materialId, index } = {}) {
    const mid = String(materialId || '')
    const doc = store.get('materials', mid) // 不存在 → 404
    if (doc.deleted) throw new HttpError(400, 'INVALID_MATERIAL', '素材不存在或已删除')
    const i = Number(index)
    const img = Number.isInteger(i) && i >= 0 ? doc.images[i] : undefined
    if (!img) throw new HttpError(400, 'IMAGE_NOT_FOUND', '要优化的图片不存在')
    if (!String(settings.arkApiKey || '').trim() || !String(settings.arkModel || '').trim()) {
      throw new HttpError(
        400,
        'ARK_NOT_CONFIGURED',
        '未配置方舟图生图：请在 server/data/settings.json 填写 arkApiKey 与 arkModel 后重启服务'
      )
    }
    const t = {
      id: store.newId('o'),
      status: 'queued',
      queuePosition: pending.length + 1,
      blocks: [],
      subs: new Set(),
      abort: null,
      stopRequested: false,
      materialId: mid,
      index: i,
      sourceFile: img.file,
      result: null,
      error: null
    }
    tasks.set(t.id, t)
    pending.push(t.id)
    pump()
    return t.id
  }

  function subscribe(id, fn) {
    const t = OPT_TASK_ID_RE.test(String(id)) ? tasks.get(id) : null
    if (!t) return () => {}
    try {
      fn({ event: 'snapshot', data: snapshotOf(t) })
    } catch {
      /* 忽略 */
    }
    t.subs.add(fn)
    return () => t.subs.delete(fn)
  }

  function get(id) {
    const t = OPT_TASK_ID_RE.test(String(id)) ? tasks.get(id) : null
    return t ? viewOf(t) : null
  }

  function stop(id) {
    const t = tasks.get(id)
    if (!t) return null
    if (t.status === 'queued') {
      t.stopRequested = true
      const i = pending.indexOf(id)
      if (i >= 0) pending.splice(i, 1)
      finalize(t, 'cancelled')
      updateQueuePositions()
      return 'cancelled'
    }
    if (t.status === 'running') {
      t.stopRequested = true
      try {
        t.abort?.()
      } catch {
        /* 忽略 */
      }
      return 'cancelling'
    }
    return t.status
  }

  /** 删除该任务在素材目录下的临时产物（opt-<taskId>.*） */
  function removeTempFiles(materialId, taskId) {
    const dir = join(store.dataDir, 'files', 'materials', materialId)
    let files = []
    try {
      files = readdirSync(dir)
    } catch {
      return
    }
    for (const f of files) {
      if (!f.startsWith(`opt-${taskId}.`)) continue
      try {
        rmSync(join(dir, f), { force: true })
      } catch {
        /* 忽略 */
      }
    }
  }

  function discard({ materialId, taskId } = {}) {
    const mid = String(materialId || '')
    const id = String(taskId || '')
    const t = OPT_TASK_ID_RE.test(id) ? tasks.get(id) : null
    if (t) {
      if (t.status === 'running') {
        t.stopRequested = true
        try {
          t.abort?.()
        } catch {
          /* 忽略 */
        }
      } else if (t.status === 'queued') {
        const i = pending.indexOf(id)
        if (i >= 0) pending.splice(i, 1)
        updateQueuePositions()
      }
      tasks.delete(id)
    }
    removeTempFiles(mid, id)
    return { ok: true }
  }

  function adopt({ materialId, taskId } = {}) {
    const mid = String(materialId || '')
    const id = String(taskId || '')
    const t = OPT_TASK_ID_RE.test(id) ? tasks.get(id) : null
    if (!t || t.materialId !== mid) throw new HttpError(404, 'OPT_NOT_FOUND', OPT_NOT_FOUND)
    if (t.status !== 'done' || !t.result) throw new HttpError(400, 'OPT_NOT_DONE', '优化未完成，无法采用')
    const src = join(store.dataDir, t.result.file)
    if (!existsSync(src)) throw new HttpError(400, 'OPT_NOT_DONE', '优化结果已失效，无法采用')
    const dir = join(store.dataDir, 'files', 'materials', mid)
    const ext = t.result.file.endsWith('.jpg') ? 'jpg' : 'png'
    const used = new Set(readdirSync(dir).map((f) => Number(f.split('.')[0])).filter((n) => Number.isInteger(n)))
    let n = 1
    while (used.has(n)) n++
    const name = `${n}.${ext}`
    renameSync(src, join(dir, name))
    const entry = store.addImage('materials', mid, {
      file: `files/materials/${mid}/${name}`,
      width: t.result.width,
      height: t.result.height,
      primary: true
    })
    tasks.delete(id)
    return { entry, doc: store.get('materials', mid) }
  }

  async function run(t) {
    t.status = 'running'
    t.queuePosition = 0
    emit(t, 'status', { status: 'running', queuePosition: 0 })
    const workDir = join(store.dataDir, 'work', t.id)
    try {
      const doc = store.get('materials', t.materialId)
      const meta = doc.images[t.index] || {}
      const size = pickRenderSize(Number(meta.width) || 1024, Number(meta.height) || 1024)
      const instruction = buildOptimizeInstruction({ material: doc, size })
      const res = await renderer.runImageEdit({
        settings,
        workDir,
        attachments: [join(store.dataDir, t.sourceFile)],
        editInstruction: instruction,
        size,
        candidateCount: 1,
        registerAbort: (fn) => {
          t.abort = fn
        },
        onEvent: (ev) => emit(t, ev.event, ev.data)
      })
      if (t.stopRequested) {
        finalize(t, 'cancelled')
        return
      }
      if (!res.ok || !res.images?.length) {
        t.error = res.error || '未产出图片'
        emit(t, 'error', { message: t.error })
        finalize(t, 'error')
        return
      }
      const outDir = join(store.dataDir, 'files', 'materials', t.materialId)
      mkdirSync(outDir, { recursive: true })
      const buf = readFileSync(res.images[0])
      const ext = buf.subarray(0, 8).equals(PNG_SIG) ? 'png' : 'jpg'
      const rel = `files/materials/${t.materialId}/opt-${t.id}.${ext}`
      copyFileSync(res.images[0], join(store.dataDir, rel))
      let dim = null
      try {
        dim = imageDimensions(buf)
      } catch {
        /* 按 0 处理 */
      }
      t.result = { file: rel, width: dim?.width || 0, height: dim?.height || 0 }
      emit(t, 'result', { ...t.result })
      finalize(t, 'done')
    } catch (e) {
      if (t.stopRequested) {
        finalize(t, 'cancelled')
        return
      }
      t.error = String(e?.message || e)
      emit(t, 'error', { message: t.error })
      finalize(t, 'error')
    } finally {
      if (!settings.keepWorkDirs) {
        try {
          rmSync(workDir, { recursive: true, force: true })
        } catch {
          /* 忽略清理失败 */
        }
      }
    }
  }

  function pump() {
    while (running < 1 && pending.length) {
      const id = pending.shift()
      const t = tasks.get(id)
      if (!t || t.status !== 'queued') continue
      running++
      run(t).finally(() => {
        running--
        pump()
      })
    }
    updateQueuePositions()
  }

  /** 服务重启：清掉所有 preview 遗留的 opt-* 文件（内存任务已不存在） */
  function restartCleanup() {
    let n = 0
    const base = join(store.dataDir, 'files', 'materials')
    let ids = []
    try {
      ids = readdirSync(base)
    } catch {
      return 0
    }
    for (const id of ids) {
      const dir = join(base, id)
      let files = []
      try {
        files = readdirSync(dir)
      } catch {
        continue
      }
      for (const f of files) {
        if (!f.startsWith('opt-')) continue
        try {
          rmSync(join(dir, f), { force: true })
          n++
        } catch {
          /* 忽略 */
        }
      }
    }
    return n
  }

  function stats() {
    return { running, pending: pending.length }
  }

  return { submit, subscribe, get, stop, discard, adopt, stats, restartCleanup }
}
