/**
 * styling-station 服务入口：HTTP 路由 + 静态服务 + SSE。
 * 契约见 docs/specs/2026-09-30-styling-station-design.md（§5、§9）。
 */

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, normalize, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { networkInterfaces } from 'node:os'

import { loadSettings } from './settings.mjs'
import { json, sendError, HttpError, readJsonBody } from './lib/http.mjs'
import { resolveQoderCliSpawn } from './lib/qodercli.mjs'
import { createStore } from './lib/store.mjs'
import { parseMultipart, validateImage } from './lib/upload.mjs'

export const VERSION = '0.1.0'
const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url))

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
  '.ico': 'image/x-icon'
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

  // 由后续任务在 createServer 内继续注册路由：
  //   Task 6：/api/presets
  //   Task 7：/api/renders/auto-recommend、/api/presets/:id/auto-fill
  //   Task 10：/api/renders（含 SSE / stop / rerun / chosen）
  function queueStats() {
    return { running: 0, pending: 0 }
  }

  // ---------- 静态与文件 ----------
  async function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1)
    let root = WEB_DIR
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
