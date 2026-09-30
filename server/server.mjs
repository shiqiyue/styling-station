/**
 * styling-station 服务入口：HTTP 路由 + 静态服务 + SSE。
 * 契约见 docs/specs/2026-09-30-styling-station-design.md（§5、§9）。
 */

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, normalize, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { networkInterfaces } from 'node:os'

import { loadSettings } from './settings.mjs'
import { json, sendError, HttpError, readJsonBody } from './lib/http.mjs'
import { resolveQoderCliSpawn } from './lib/qodercli.mjs'
import { createStore, nowIso } from './lib/store.mjs'
import { parseMultipart, validateImage } from './lib/upload.mjs'
import { rankMaterials } from './lib/matcher.mjs'
import { createJobs } from './lib/jobs.mjs'
import { createOptJobs } from './lib/opt-jobs.mjs'
import { sendSse, startHeartbeat } from './lib/sse.mjs'
import { pickRenderSize } from './lib/images.mjs'

export const VERSION = '0.1.0'
const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url))
// Flutter Web 构建产物：存在则优先提供（切回旧界面 = 移走该目录，零配置）
const APP_WEB_DIR = fileURLToPath(new URL('../app/build/web/', import.meta.url))
const webRoot = existsSync(join(APP_WEB_DIR, 'index.html')) ? APP_WEB_DIR : WEB_DIR

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.bin': 'application/octet-stream',
  '.mem': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
  '.symbols': 'text/plain; charset=utf-8'
}

/** 匹配 :param 与尾部 *（catch-all） */
function matchPattern(pattern, pathname) {
  const pSeg = pattern.split('/').filter(Boolean)
  const uSeg = pathname.split('/').filter(Boolean)
  const params = {}
  for (let i = 0; i < pSeg.length; i++) {
    const p = pSeg[i]
    if (p === '*') {
      params['*'] = uSeg.slice(i).join('/')
      return params
    }
    const u = uSeg[i]
    if (u === undefined) return null
    if (p.startsWith(':')) {
      params[p.slice(1)] = decodeURIComponent(u)
      continue
    }
    if (p !== u) return null
  }
  if (uSeg.length !== pSeg.length) return null
  return params
}

export function createServer({ dataDir, settings } = {}) {
  settings = settings || loadSettings(dataDir)
  const cli = resolveQoderCliSpawn({ qodercliPath: settings.qodercliPath })
  const store = createStore({ dataDir })
  const jobs = createJobs({ store, settings, cli })
  jobs.restartCleanup() // 服务重启：把残留 queued/running 记录标记 stopped
  const optJobs = createOptJobs({ store, settings })
  optJobs.restartCleanup() // 服务重启：清掉素材目录里的优化临时产物（opt-*）
  const routes = []
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler })

  let actualPort = settings.port

  // ---------- 路由：基础 ----------
  route('GET', '/api/health', (req, res) => {
    json(res, 200, {
      ok: true,
      version: VERSION,
      port: actualPort,
      cli: cli.error ? { error: cli.error } : { command: cli.command, resolvedFrom: cli.resolvedFrom },
      queue: queueStats()
    })
  })

  route('GET', '/api/scenes', (req, res) => {
    json(res, 200, {
      scenes: store.scenes(),
      tags: { materials: store.tags('materials'), templates: store.tags('templates') }
    })
  })

  // ---------- 路由：素材 / 样板（契约 §5.2） ----------
  const parseListQuery = (url) => ({
    scene: url.searchParams.get('scene') || undefined,
    tags: (url.searchParams.get('tags') || '').split(',').map((s) => s.trim()).filter(Boolean),
    q: url.searchParams.get('q') || undefined,
    includeDeleted: ['1', 'true'].includes(url.searchParams.get('includeDeleted')),
    limit: url.searchParams.get('limit') ?? undefined,
    offset: url.searchParams.get('offset') ?? 0
  })

  for (const kind of ['materials', 'templates']) {
    route('GET', `/api/${kind}`, (req, res, params, url) => json(res, 200, store.list(kind, parseListQuery(url))))
    route('POST', `/api/${kind}`, async (req, res) => json(res, 200, store.create(kind, await readJsonBody(req))))
    route('GET', `/api/${kind}/:id`, (req, res, params) => json(res, 200, store.get(kind, params.id)))
    route('PUT', `/api/${kind}/:id`, async (req, res, params) =>
      json(res, 200, store.update(kind, params.id, await readJsonBody(req)))
    )
    route('DELETE', `/api/${kind}/:id`, (req, res, params) => json(res, 200, store.remove(kind, params.id)))
    route('POST', `/api/${kind}/:id/undelete`, (req, res, params) => json(res, 200, store.undelete(kind, params.id)))

    route('POST', `/api/${kind}/:id/images`, async (req, res, params) => {
      store.get(kind, params.id) // 存在性检查
      const maxUpload = settings.maxUploadMB * 1024 * 1024
      const { data } = await parseMultipart(req, { maxBytes: maxUpload + 2 * 1024 * 1024, field: 'file' })
      const dim = validateImage(data, { maxBytes: maxUpload })
      const ext = dim.type === 'jpeg' ? 'jpg' : dim.type
      const dir = join(dataDir, 'files', kind, params.id)
      mkdirSync(dir, { recursive: true })
      const used = new Set(readdirSync(dir).map((f) => Number(f.split('.')[0])).filter((n) => Number.isInteger(n)))
      let n = 1
      while (used.has(n)) n++
      const name = `${n}.${ext}`
      writeFileSync(join(dir, name), data)
      store.addImage(kind, params.id, { file: `files/${kind}/${params.id}/${name}`, width: dim.width, height: dim.height })
      json(res, 200, store.get(kind, params.id))
    })

    route('DELETE', `/api/${kind}/:id/images/:index`, (req, res, params) => {
      const doc = store.get(kind, params.id)
      const img = doc.images[Number(params.index)]
      if (!img) throw new HttpError(400, 'IMAGE_NOT_FOUND', '要删除的图片不存在')
      const updated = store.removeImage(kind, params.id, params.index)
      rmSync(join(dataDir, img.file), { force: true })
      json(res, 200, updated)
    })
  }

  // ---------- 路由：素材图优化（Spec: material-image-optimize-design §2） ----------
  const OPT_TERMINAL = new Set(['done', 'error', 'cancelled'])

  route('POST', '/api/materials/:id/optimize', async (req, res, params) => {
    const body = await readJsonBody(req)
    json(res, 200, { taskId: optJobs.submit({ materialId: params.id, index: body.index }) })
  })

  route('GET', '/api/materials/:id/optimize/:taskId/stream', (req, res, params) => {
    const view = optJobs.get(params.taskId)
    if (!view || view.materialId !== params.id) {
      throw new HttpError(404, 'OPT_NOT_FOUND', '优化任务不存在（服务可能已重启），请重新发起')
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    })
    const hb = startHeartbeat(res)
    const unsub = optJobs.subscribe(params.taskId, ({ event, data }) => sendSse(res, event, data))
    if (OPT_TERMINAL.has(view.status)) {
      // 终态任务连接即补发收尾（前端可能错过 done）
      if (view.status === 'done' && view.result) sendSse(res, 'result', view.result)
      sendSse(res, 'status', { status: view.status, queuePosition: 0 })
      if (view.status === 'error') sendSse(res, 'error', { message: view.error || '优化失败' })
      sendSse(res, 'done', { status: view.status })
    }
    req.on('close', () => {
      clearInterval(hb)
      unsub()
    })
  })

  route('POST', '/api/materials/:id/optimize/:taskId/adopt', (req, res, params) => {
    const { doc } = optJobs.adopt({ materialId: params.id, taskId: params.taskId })
    json(res, 200, doc)
  })

  route('POST', '/api/materials/:id/optimize/:taskId/discard', (req, res, params) => {
    json(res, 200, optJobs.discard({ materialId: params.id, taskId: params.taskId }))
  })

  // ---------- 路由：预设（契约 §5.3） ----------
  route('GET', '/api/presets', (req, res, params, url) => {
    const qp = parseListQuery(url)
    json(res, 200, store.listPresets(qp))
  })
  route('POST', '/api/presets', async (req, res) => json(res, 200, store.createPreset(await readJsonBody(req))))
  route('GET', '/api/presets/:id', (req, res, params) => json(res, 200, store.getPreset(params.id)))
  route('PUT', '/api/presets/:id', async (req, res, params) =>
    json(res, 200, store.updatePreset(params.id, await readJsonBody(req)))
  )
  route('DELETE', '/api/presets/:id', (req, res, params) => json(res, 200, store.removePreset(params.id)))
  route('POST', '/api/presets/:id/undelete', (req, res, params) => json(res, 200, store.undeletePreset(params.id)))
  route('POST', '/api/presets/:id/duplicate', (req, res, params) => json(res, 200, store.duplicatePreset(params.id)))

  // ---------- 路由：标签推荐（契约 §5.4 / §7） ----------
  const toCandidate = (r) => ({ materialId: r.materialId, score: r.score })

  route('POST', '/api/renders/auto-recommend', async (req, res) => {
    const body = await readJsonBody(req)
    const t = store.get('templates', body.templateId)
    const limit = Number(body.limit) > 0 ? Number(body.limit) : 6
    const materials = store.list('materials', {}).items
    const ranked = rankMaterials({ baseTags: t.tags, scene: t.scene, materials })
    json(res, 200, {
      recommended: ranked.filter((r) => r.tagHits > 0).slice(0, limit).map((r) => r.materialId),
      candidates: ranked.map(toCandidate)
    })
  })

  route('POST', '/api/presets/:id/auto-fill', (req, res, params) => {
    const p = store.getPreset(params.id)
    const t = store.get('templates', p.templateId) // 样板失效时 404（与出图校验一致）
    const materials = store.list('materials', {}).items
    const slots = p.slots.map((slot) => {
      const ranked = rankMaterials({ baseTags: slot.tags, scene: t.scene, materials })
      const hit = ranked.find((r) => r.tagHits > 0)
      return {
        slotId: slot.id,
        recommended: hit ? hit.materialId : null,
        candidates: ranked.map(toCandidate)
      }
    })
    json(res, 200, { slots })
  })

  // ---------- 路由：搭配与出图（契约 §5.4） ----------
  const CANDIDATE_COUNTS = [1, 2, 4]
  const TERMINAL_STATUS = new Set(['done', 'error', 'stopped'])

  function requireImage(doc, label) {
    const img = doc.images?.[0]
    if (!img) throw new HttpError(400, 'NO_IMAGE', `${label}「${doc.name}」还没有图片，请先上传`)
    return img
  }

  function snapshotTemplate(t) {
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      tags: [...t.tags],
      images: t.images.map((i) => ({ ...i }))
    }
  }

  function snapshotMaterial(m, slot = {}) {
    return {
      id: m.id,
      name: m.name,
      description: m.description,
      tags: [...m.tags],
      images: m.images.map((i) => ({ ...i })),
      slotId: slot.slotId ?? null,
      slotName: slot.slotName ?? null,
      slotPosition: slot.slotPosition ?? null
    }
  }

  /** 组装一条 queued 出图记录（free/preset 共用；rerun 复用同一校验） */
  function assembleRender(body, parentId = null) {
    const mode = body.mode
    if (mode !== 'free' && mode !== 'preset') throw new HttpError(400, 'INVALID_MODE', 'mode 必须为 free 或 preset')
    const candidateCount = Number(body.candidateCount)
    if (!CANDIDATE_COUNTS.includes(candidateCount)) {
      throw new HttpError(400, 'BAD_CANDIDATE_COUNT', '候选张数只能为 1、2 或 4')
    }
    const positionNote = String(body.positionNote ?? '').trim()
    if (positionNote.length > 1000) throw new HttpError(400, 'POSITION_NOTE_TOO_LONG', '位置说明过长（最多 1000 字符）')

    const common = {
      mode,
      status: 'queued',
      parentId,
      positionNote,
      candidateCount,
      results: [],
      cliSessionId: null,
      startedAt: null,
      finishedAt: null,
      elapsedMs: null,
      stderrTail: null
    }

    if (mode === 'free') {
      const t = store.get('templates', body.templateId)
      if (t.deleted) throw new HttpError(400, 'INVALID_TEMPLATE', '样板不存在或已删除')
      const primary = requireImage(t, '样板')
      const ids = Array.isArray(body.materialIds) ? body.materialIds : []
      if (!ids.length) throw new HttpError(400, 'NO_MATERIALS', '请至少选择一个素材')
      if (ids.length > 8) throw new HttpError(400, 'TOO_MANY_MATERIALS', '一次最多搭配 8 个素材')
      const materials = ids.map((id) => {
        const m = store.get('materials', id)
        if (m.deleted) throw new HttpError(400, 'INVALID_MATERIAL', `素材不存在或已删除：${id}`)
        requireImage(m, '素材')
        return snapshotMaterial(m)
      })
      return store.createRender({
        ...common,
        templateSnapshot: snapshotTemplate(t),
        presetId: null,
        presetSnapshot: null,
        materialsSnapshot: materials,
        size: pickRenderSize(primary.width, primary.height)
      })
    }

    // preset 模式
    const p = store.getPreset(body.presetId)
    if (p.deleted) throw new HttpError(400, 'INVALID_PRESET', '预设不存在或已删除')
    if (!p.templateValid) throw new HttpError(400, 'INVALID_TEMPLATE', '预设对应的样板已失效，请先修复样板')
    const t = store.get('templates', p.templateId)
    const primary = requireImage(t, '样板')
    const assignments = Array.isArray(body.assignments) ? body.assignments : []
    const bySlot = new Map()
    for (const a of assignments) {
      if (!a || typeof a.slotId !== 'string') continue
      if (bySlot.has(a.slotId)) throw new HttpError(400, 'SLOT_DUPLICATE', '同一个插槽重复填了素材')
      bySlot.set(a.slotId, a.materialId)
    }
    const slotIds = new Set(p.slots.map((s) => s.id))
    for (const a of assignments) {
      if (a && a.slotId && !slotIds.has(a.slotId)) {
        throw new HttpError(400, 'SLOT_UNKNOWN', `预设里没有这个插槽：${a.slotId}`)
      }
    }
    const materials = p.slots.map((slot) => {
      const mid = bySlot.get(slot.id)
      if (!mid) throw new HttpError(400, 'SLOT_MISSING_MATERIAL', `插槽「${slot.name}」未选择素材`)
      const m = store.get('materials', mid)
      if (m.deleted) throw new HttpError(400, 'INVALID_MATERIAL', `素材不存在或已删除：${mid}`)
      requireImage(m, '素材')
      return snapshotMaterial(m, { slotId: slot.id, slotName: slot.name, slotPosition: slot.positionNote || null })
    })
    return store.createRender({
      ...common,
      templateSnapshot: snapshotTemplate(t),
      presetId: p.id,
      presetSnapshot: { id: p.id, name: p.name },
      materialsSnapshot: materials,
      size: pickRenderSize(primary.width, primary.height)
    })
  }

  route('POST', '/api/renders', async (req, res) => {
    const doc = assembleRender(await readJsonBody(req))
    jobs.submit(doc)
    json(res, 200, { renderId: doc.id })
  })

  route('GET', '/api/renders', (req, res, params, url) => {
    json(
      res,
      200,
      store.listRenders({
        templateId: url.searchParams.get('templateId') || undefined,
        materialId: url.searchParams.get('materialId') || undefined,
        limit: url.searchParams.get('limit') ?? undefined,
        offset: url.searchParams.get('offset') ?? 0
      })
    )
  })

  route('GET', '/api/renders/:id/stream', (req, res, params) => {
    const rec = store.getRender(params.id)
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    })
    const hb = startHeartbeat(res)
    const j = jobs.get(params.id)

    if (!j) {
      // 重启后无内存任务：纯回放记录终态
      sendSse(res, 'snapshot', { renderId: rec.id, status: rec.status, queuePosition: 0, blocks: [] })
      ;(rec.results || []).forEach((r, i) =>
        sendSse(res, 'result', { index: i + 1, file: r.file, width: r.width, height: r.height })
      )
      if (rec.status === 'error') sendSse(res, 'error', { message: rec.stderrTail || '出图失败' })
      sendSse(res, 'done', { status: rec.status })
      clearInterval(hb)
      res.end()
      return
    }

    const unsub = jobs.subscribe(params.id, ({ event, data }) => sendSse(res, event, data))
    // 已产出候选补发（晚连/重连；前端按 index 去重）
    const now = store.getRender(params.id)
    ;(now.results || []).forEach((r, i) =>
      sendSse(res, 'result', { index: i + 1, file: r.file, width: r.width, height: r.height })
    )
    // 终态任务补发收尾事件（避免连接过晚错过 done）
    if (TERMINAL_STATUS.has(j.status)) {
      sendSse(res, 'status', { status: j.status, queuePosition: 0 })
      if (j.status === 'error') sendSse(res, 'error', { message: now.stderrTail || '出图失败' })
      sendSse(res, 'done', { status: j.status })
    }
    req.on('close', () => {
      clearInterval(hb)
      unsub()
    })
  })

  route('POST', '/api/renders/:id/stop', (req, res, params) => {
    const rec = store.getRender(params.id)
    const r = jobs.stop(params.id)
    if (!r && !TERMINAL_STATUS.has(rec.status)) {
      // 重启后残留（无内存任务）：直接标记停止
      store.updateRender(params.id, { status: 'stopped', finishedAt: nowIso(), stderrTail: '已停止' })
      json(res, 200, { status: 'stopped' })
      return
    }
    json(res, 200, { status: r || rec.status })
  })

  route('POST', '/api/renders/:id/rerun', async (req, res, params) => {
    const body = await readJsonBody(req)
    const old = store.getRender(params.id)
    const next = {
      mode: old.mode,
      positionNote: body.positionNote ?? old.positionNote ?? '',
      candidateCount: body.candidateCount ?? old.candidateCount ?? 1
    }
    if (old.mode === 'free') {
      next.templateId = old.templateSnapshot?.id
      next.materialIds = Array.isArray(body.materialIds)
        ? body.materialIds
        : (old.materialsSnapshot || []).map((m) => m.id)
    } else {
      next.presetId = old.presetId
      next.assignments = Array.isArray(body.assignments)
        ? body.assignments
        : (old.materialsSnapshot || []).filter((m) => m.slotId).map((m) => ({ slotId: m.slotId, materialId: m.id }))
    }
    const doc = assembleRender(next, old.id)
    jobs.submit(doc)
    json(res, 200, { renderId: doc.id, parentId: old.id })
  })

  route('POST', '/api/renders/:id/results/:index/chosen', async (req, res, params) => {
    const body = await readJsonBody(req)
    const rec = store.getRender(params.id)
    const idx = Number(params.index)
    const results = rec.results || []
    if (!Number.isInteger(idx) || idx < 1 || idx > results.length) {
      throw new HttpError(400, 'RESULT_NOT_FOUND', '候选图不存在')
    }
    const chosen = body.chosen !== false
    const updated = results.map((r, i) => {
      if (chosen) return { ...r, chosen: i === idx - 1 }
      return i === idx - 1 ? { ...r, chosen: false } : { ...r }
    })
    json(res, 200, store.updateRender(params.id, { results: updated }))
  })

  route('GET', '/api/renders/:id', (req, res, params) => {
    const rec = store.getRender(params.id)
    json(res, 200, { ...rec, childrenIds: store.renderChildren(rec.id).map((c) => c.id) })
  })

  function queueStats() {
    return jobs.stats()
  }

  // ---------- 静态与文件 ----------
  async function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1)
    let root = webRoot
    let target = rel
    if (rel.startsWith('files/')) {
      // 数据图片：仅允许 data/files/ 下（Task 5 起使用）
      root = join(dataDir, 'files')
      target = rel.slice('files/'.length)
    }
    const full = normalize(join(root, target))
    const guard = root.endsWith('\\') || root.endsWith('/') ? root : root + (process.platform === 'win32' ? '\\' : '/')
    if (!full.startsWith(normalize(guard))) throw new HttpError(403, 'FORBIDDEN', '非法路径')
    let data
    try {
      data = await readFile(full)
    } catch {
      throw new HttpError(404, 'NOT_FOUND', '资源不存在')
    }
    const type = MIME[extname(full).toLowerCase()] || 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store' })
    res.end(req.method === 'HEAD' ? undefined : data)
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const pathname = url.pathname
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue
        const params = matchPattern(r.pattern, pathname)
        if (params) return await r.handler(req, res, params, url)
      }
      if (pathname.startsWith('/api/')) throw new HttpError(404, 'NOT_FOUND', `接口不存在：${req.method} ${pathname}`)
      if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, pathname)
      throw new HttpError(404, 'NOT_FOUND', '路径不存在')
    } catch (err) {
      sendError(res, err)
    }
  })

  return {
    listen(port = settings.port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '0.0.0.0', () => {
          actualPort = server.address().port
          resolve(actualPort)
        })
      })
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()))
    },
    get port() {
      return actualPort
    },
    settings,
    dataDir,
    cli
  }
}

// ---------- 直接运行入口 ----------
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isMain) {
  const dataDir = fileURLToPath(new URL('./data/', import.meta.url))
  const settings = loadSettings(dataDir)
  const srv = createServer({ dataDir, settings })
  const port = await srv.listen(settings.port)
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address)
  console.log('==========================================')
  console.log('  styling-station 搭配台 已启动')
  console.log('==========================================')
  console.log(`  本机访问：http://127.0.0.1:${port}`)
  for (const ip of ips) console.log(`  内网访问：http://${ip}:${port}`)
  console.log(`  数据目录：${dataDir}`)
  console.log(`  出图并发：${settings.maxConcurrent}`)
  console.log(srv.cli.error ? `  qodercli：未就绪（${srv.cli.error}）` : `  qodercli：${srv.cli.resolvedFrom}`)
  console.log('  提示：同事通过上面的「内网访问」地址使用；防火墙首次需放行该端口（见 README）。')
}
