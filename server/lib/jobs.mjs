/**
 * 出图任务注册表（Spec §6.5）：
 * - 内存 Map 状态机 queued → running → done|error|stopped；并发上限 settings.maxConcurrent，超出按提交顺序排队。
 * - 每步同步 store.updateRender 落盘；事件经订阅者广播（SSE 用）；保留 blocks 供迟连订阅者回放 snapshot。
 * - stop：排队中直接出队置 stopped；运行中杀进程树（或中止方舟请求），已完成的候选保留。
 * - 出图通道按 settings.renderChannel 分发：'qodercli'（默认）走 renderer.runRender，
 *   'ark' 走 renderer.runImageEdit（火山方舟图生图），两者结果契约一致。
 * - restartCleanup：服务重启时把 queued/running 残留标记 stopped。
 */

import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { imageDimensions } from './images.mjs'
import { buildEditInstruction, buildTaskPrompt } from './prompt.mjs'
import { killProcessTree, runRender } from './renderer.mjs'
import { runImageEdit } from './image-edit.mjs'
import { nowIso } from './store.mjs'

const defaultRenderer = { runRender, runImageEdit }

export function createJobs({ store, settings = {}, renderer = defaultRenderer, cli } = {}) {
  const jobs = new Map()
  const pending = []
  let running = 0
  const maxConcurrent = Math.max(1, Number(settings.maxConcurrent) || 2)
  // 出图通道：'qodercli'（默认，文生图）或 'ark'（火山方舟图生图）；改 settings.json 后重启生效
  const renderChannel = settings.renderChannel === 'ark' ? 'ark' : 'qodercli'

  function emit(j, event, data) {
    if (event === 'delta') j.blocks.push({ channel: data.channel, text: data.text })
    for (const fn of j.subs) {
      try {
        fn({ event, data })
      } catch {
        /* 订阅者异常不影响任务 */
      }
    }
  }

  function logLine(j, ev) {
    try {
      appendFileSync(j.logPath, `${nowIso()} [${ev.event}] ${JSON.stringify(ev.data)}\n`)
    } catch {
      /* 日志失败不影响任务 */
    }
  }

  function updateQueuePositions() {
    pending.forEach((id, i) => {
      const j = jobs.get(id)
      if (j && j.status === 'queued') j.queuePosition = i + 1
    })
  }

  function snapshotOf(j) {
    return {
      renderId: j.id,
      status: j.status,
      queuePosition: j.status === 'queued' ? j.queuePosition : 0,
      blocks: j.blocks.map((b) => ({ ...b }))
    }
  }

  function submit(doc) {
    const j = {
      id: doc.id,
      status: 'queued',
      queuePosition: pending.length + 1,
      blocks: [],
      subs: new Set(),
      child: null,
      abort: null,
      stopRequested: false,
      doc
    }
    jobs.set(j.id, j)
    pending.push(j.id)
    store.updateRender(j.id, { status: 'queued' })
    pump()
    return j.id
  }

  function subscribe(id, fn) {
    const j = jobs.get(id)
    if (!j) return () => {}
    try {
      fn({ event: 'snapshot', data: snapshotOf(j) })
    } catch {
      /* 忽略 */
    }
    j.subs.add(fn)
    return () => j.subs.delete(fn)
  }

  function get(id) {
    const j = jobs.get(id)
    return j ? snapshotOf(j) : null
  }

  function stop(id) {
    const j = jobs.get(id)
    if (!j) return null
    if (j.status === 'queued') {
      j.stopRequested = true
      const i = pending.indexOf(id)
      if (i >= 0) pending.splice(i, 1)
      finalize(j, 'stopped', { stderrTail: null })
      updateQueuePositions()
      return 'stopped'
    }
    if (j.status === 'running') {
      j.stopRequested = true
      killProcessTree(j.child)
      j.abort?.() // 图生图通道（方舟）：无子进程，用中止函数取消请求
      return 'stopping'
    }
    return j.status
  }

  function finalize(j, status, patch = {}) {
    j.status = status
    j.queuePosition = 0
    store.updateRender(j.id, { status, finishedAt: nowIso(), ...patch })
    emit(j, 'status', { status, queuePosition: 0 })
    emit(j, 'done', { status })
  }

  function stats() {
    return { running, pending: pending.length }
  }

  function buildAttachments(dataDir, doc) {
    const files = []
    const t = doc.templateSnapshot?.images?.[0]?.file
    if (t) files.push(join(dataDir, t))
    for (const m of doc.materialsSnapshot || []) {
      const f = m.images?.[0]?.file
      if (f) files.push(join(dataDir, f))
    }
    return files
  }

  function copyResults(j, images) {
    const outDir = join(store.dataDir, 'files', 'renders', j.id)
    mkdirSync(outDir, { recursive: true })
    return images.map((abs, i) => {
      const name = `v${i + 1}.png`
      const file = `files/renders/${j.id}/${name}`
      const dest = join(outDir, name)
      try {
        copyFileSync(abs, dest)
        let dim = null
        try {
          dim = imageDimensions(readFileSync(dest))
        } catch {
          /* 读不到按 0 处理 */
        }
        return { file, width: dim?.width || 0, height: dim?.height || 0, chosen: false, error: null }
      } catch (e) {
        return { file, width: 0, height: 0, chosen: false, error: `复制失败：${e.message}` }
      }
    })
  }

  function cleanupWork(j) {
    if (settings.keepWorkDirs) return
    try {
      rmSync(join(store.dataDir, 'work', j.id), { recursive: true, force: true })
    } catch {
      /* 忽略清理失败 */
    }
  }

  async function run(j) {
    j.status = 'running'
    j.queuePosition = 0
    j.startedAt = nowIso()
    j.logPath = join(store.dataDir, 'logs', `${j.id}.log`)
    try {
      mkdirSync(join(store.dataDir, 'logs'), { recursive: true })
    } catch {
      /* 日志目录创建失败不阻塞任务 */
    }
    store.updateRender(j.id, { status: 'running', startedAt: j.startedAt })
    emit(j, 'status', { status: 'running', queuePosition: 0 })

    const doc = j.doc
    const workDir = join(store.dataDir, 'work', j.id)
    const entries = (doc.materialsSnapshot || []).map((m) => ({
      material: m,
      slotName: m.slotName ?? null,
      slotPosition: m.slotPosition ?? null
    }))
    const attachments = buildAttachments(store.dataDir, doc)
    const forward = (ev) => {
      logLine(j, ev)
      emit(j, ev.event, ev.data)
    }

    let res
    if (renderChannel === 'ark') {
      if (typeof renderer.runImageEdit !== 'function') {
        res = {
          ok: false,
          images: [],
          sessionId: null,
          elapsedMs: 0,
          exitCode: null,
          stderrTail: '',
          timedOut: false,
          resultText: '',
          error: '当前 renderer 未实现 runImageEdit'
        }
      } else {
        const editInstruction = buildEditInstruction({
          mode: doc.mode,
          template: doc.templateSnapshot,
          entries,
          positionNote: doc.positionNote,
          size: doc.size
        })
        res = await renderer.runImageEdit({
          settings,
          workDir,
          attachments,
          editInstruction,
          size: doc.size,
          candidateCount: doc.candidateCount,
          registerAbort: (fn) => {
            j.abort = fn
          },
          onEvent: forward
        })
      }
    } else {
      const taskPrompt = buildTaskPrompt({
        mode: doc.mode,
        template: doc.templateSnapshot,
        entries,
        positionNote: doc.positionNote,
        size: doc.size,
        candidateCount: doc.candidateCount
      })
      res = await renderer.runRender({
        settings,
        cli,
        workDir,
        attachments,
        taskPrompt,
        registerChild: (child) => {
          j.child = child
        },
        onEvent: forward
      })
    }

    const basePatch = { cliSessionId: res.sessionId, elapsedMs: res.elapsedMs }

    if (j.stopRequested) {
      const results = res.images?.length ? copyResults(j, res.images) : []
      finalize(j, 'stopped', { ...basePatch, results })
      cleanupWork(j)
      return
    }

    if (res.ok) {
      const results = copyResults(j, res.images)
      store.updateRender(j.id, { ...basePatch, results, stderrTail: res.stderrTail || null })
      results.forEach((r, i) => emit(j, 'result', { index: i + 1, file: r.file, width: r.width, height: r.height }))
      finalize(j, 'done')
      cleanupWork(j)
      return
    }

    // 失败：保留已出成功的候选，记录 reason
    const results = res.images?.length ? copyResults(j, res.images) : []
    const reason = res.timedOut
      ? `出图超时（${settings.renderTimeoutMs}ms）`
      : res.error || '未产出图片'
    store.updateRender(j.id, { ...basePatch, results, stderrTail: res.stderrTail || reason })
    results.forEach((r, i) => emit(j, 'result', { index: i + 1, file: r.file, width: r.width, height: r.height }))
    emit(j, 'error', { message: `出图失败：${reason}` })
    finalize(j, 'error')
    cleanupWork(j)
  }

  function pump() {
    while (running < maxConcurrent && pending.length) {
      const id = pending.shift()
      const j = jobs.get(id)
      if (!j || j.status !== 'queued') continue
      running++
      run(j).finally(() => {
        running--
        pump()
      })
    }
    updateQueuePositions()
  }

  function restartCleanup() {
    let n = 0
    for (const r of store.listRenders({}).items) {
      if (r.status === 'queued' || r.status === 'running') {
        store.updateRender(r.id, { status: 'stopped', finishedAt: nowIso(), stderrTail: '服务重启中断' })
        n++
      }
    }
    return n
  }

  return { submit, stop, get, subscribe, stats, restartCleanup }
}
