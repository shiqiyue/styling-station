/**
 * JSON 存储：素材 / 样板 / 预设 / 记录。
 * - 数据文件：data/library.json（materials/templates/presets/scenes）、data/renders.json（renders）。
 * - 写入一律「临时文件 + rename」原子替换；单进程小规模场景用同步 IO。
 * - 对外返回结构化拷贝，调用方只能通过本模块方法改数据。
 * - 校验失败统一抛 HttpError(400/404, code, 中文 message)。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { HttpError } from './http.mjs'

export const PRESET_SCENES = ['首饰', '瓷砖', '服装鞋帽', '其他']

const KIND_LABEL = { materials: '素材', templates: '样板' }
const MAX_NAME = 50
const MAX_DESCRIPTION = 500
const MAX_TAGS = 20
const MAX_TAG_LEN = 20
const MAX_PRESET_NAME = 50
const MAX_SLOT_NAME = 20
const MAX_SLOT_TAGS = 10
const MAX_SLOT_NOTE = 200
const MAX_SLOTS = 10

const clone = (v) => structuredClone(v)
const str = (v) => (typeof v === 'string' ? v : '')
const pad = (n, len = 2) => String(n).padStart(len, '0')

/** 本地时区 ISO 时间（含毫秒），如 2026-09-30T15:30:12.345+08:00 */
export function nowIso(date = new Date()) {
  const off = -date.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/** id：<prefix>-<yyyyMMddHHmmss>-<4 hex 随机> */
export function newId(prefix) {
  const d = new Date()
  const ts =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const rand = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')
  return `${prefix}-${ts}-${rand}`
}

function normalizeName(raw, { max = MAX_NAME, label = '名称' } = {}) {
  const name = str(raw).trim()
  if (!name) throw new HttpError(400, 'INVALID_NAME', `${label}不能为空`)
  if (name.length > max) throw new HttpError(400, 'INVALID_NAME', `${label}不能超过 ${max} 个字符`)
  return name
}

function normalizeDescription(raw) {
  const d = str(raw).trim()
  if (d.length > MAX_DESCRIPTION) throw new HttpError(400, 'INVALID_DESCRIPTION', `描述不能超过 ${MAX_DESCRIPTION} 个字符`)
  return d
}

function normalizeScene(raw) {
  const s = str(raw).trim()
  if (!s) throw new HttpError(400, 'INVALID_SCENE', '场景不能为空')
  return s
}

function normalizeTags(raw, { max = MAX_TAGS, maxLen = MAX_TAG_LEN, label = '标签' } = {}) {
  if (raw == null) return []
  if (!Array.isArray(raw)) throw new HttpError(400, 'INVALID_TAGS', `${label}须为数组`)
  const out = []
  for (const t of raw) {
    const v = str(t).trim()
    if (!v) continue
    if (v.length > maxLen) throw new HttpError(400, 'INVALID_TAGS', `单个${label}不能超过 ${maxLen} 个字符`)
    if (!out.includes(v)) out.push(v)
  }
  if (out.length > max) throw new HttpError(400, 'INVALID_TAGS', `${label}数量不能超过 ${max} 个`)
  return out
}

function normalizeSlots(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_SLOTS) {
    throw new HttpError(400, 'INVALID_SLOTS', `插槽数量须为 1~${MAX_SLOTS} 个`)
  }
  return raw.map((s, i) => {
    const name = normalizeName(s?.name, { max: MAX_SLOT_NAME, label: '插槽名称' })
    const tags = normalizeTags(s?.tags, { max: MAX_SLOT_TAGS, label: '插槽标签' })
    const note = str(s?.positionNote).trim()
    if (note.length > MAX_SLOT_NOTE) {
      throw new HttpError(400, 'INVALID_SLOT_NOTE', `插槽位置说明不能超过 ${MAX_SLOT_NOTE} 个字符`)
    }
    return { id: `s-${i + 1}`, name, tags, positionNote: note }
  })
}

export function createStore({ dataDir }) {
  mkdirSync(dataDir, { recursive: true })
  const libraryPath = join(dataDir, 'library.json')
  const rendersPath = join(dataDir, 'renders.json')

  function load(path, makeDefault) {
    try {
      const txt = readFileSync(path, 'utf8')
      if (!txt.trim()) return makeDefault()
      return JSON.parse(txt)
    } catch (e) {
      if (e.code === 'ENOENT') return makeDefault()
      throw new Error(`数据文件读取失败（${path}）：${e.message}`)
    }
  }

  const library = load(libraryPath, () => ({ materials: {}, templates: {}, presets: {}, scenes: [] }))
  const renders = load(rendersPath, () => ({ renders: {} }))
  library.materials ||= {}
  library.templates ||= {}
  library.presets ||= {}
  library.scenes = Array.isArray(library.scenes) ? library.scenes : []
  renders.renders ||= {}

  function flush(path, data) {
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, path)
  }

  /** 统一落盘（library + renders 一起 flush） */
  function save() {
    flush(libraryPath, library)
    flush(rendersPath, renders)
  }

  const buckets = { materials: library.materials, templates: library.templates }

  function bucket(kind) {
    const b = buckets[kind]
    if (!b) throw new Error(`未知集合：${kind}`)
    return b
  }

  function mustGet(kind, id) {
    const doc = bucket(kind)[id]
    if (!doc) throw new HttpError(404, 'NOT_FOUND', `${KIND_LABEL[kind]}不存在：${id}`)
    return doc
  }

  function registerScene(scene) {
    if (!PRESET_SCENES.includes(scene) && !library.scenes.includes(scene)) library.scenes.push(scene)
  }

  function paginate(items, limit, offset = 0) {
    const off = Math.max(0, Number(offset) || 0)
    if (limit == null || limit === '') return items.slice(off)
    const lim = Math.max(0, Number(limit) || 0)
    return items.slice(off, off + lim)
  }

  // ---------- 素材 / 样板 ----------

  function create(kind, { name, description = '', scene, tags } = {}) {
    const now = nowIso()
    const doc = {
      id: newId(kind === 'materials' ? 'm' : 't'),
      name: normalizeName(name),
      description: normalizeDescription(description),
      scene: normalizeScene(scene),
      tags: normalizeTags(tags),
      images: [],
      createdAt: now,
      updatedAt: now,
      deleted: false
    }
    registerScene(doc.scene)
    bucket(kind)[doc.id] = doc
    save()
    return clone(doc)
  }

  function get(kind, id) {
    return clone(mustGet(kind, id))
  }

  function update(kind, id, patch = {}) {
    const doc = mustGet(kind, id)
    if ('name' in patch) doc.name = normalizeName(patch.name)
    if ('description' in patch) doc.description = normalizeDescription(patch.description)
    if ('scene' in patch) {
      doc.scene = normalizeScene(patch.scene)
      registerScene(doc.scene)
    }
    if ('tags' in patch) doc.tags = normalizeTags(patch.tags)
    doc.updatedAt = nowIso()
    save()
    return clone(doc)
  }

  function remove(kind, id) {
    const doc = mustGet(kind, id)
    doc.deleted = true
    doc.updatedAt = nowIso()
    save()
    return clone(doc)
  }

  function undelete(kind, id) {
    const doc = mustGet(kind, id)
    doc.deleted = false
    doc.updatedAt = nowIso()
    save()
    return clone(doc)
  }

  function list(kind, { scene, tags, q, includeDeleted = false, limit, offset = 0 } = {}) {
    const sceneFilter = str(scene).trim()
    const tagFilter = Array.isArray(tags) ? tags.filter(Boolean) : []
    const kw = str(q).trim().toLowerCase()
    const items = Object.values(bucket(kind)).filter((d) => {
      if (!includeDeleted && d.deleted) return false
      if (sceneFilter && d.scene !== sceneFilter) return false
      if (tagFilter.length && !tagFilter.every((t) => d.tags.includes(t))) return false
      if (kw && !(d.name.toLowerCase().includes(kw) || (d.description || '').toLowerCase().includes(kw))) return false
      return true
    })
    items.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '') || b.id.localeCompare(a.id))
    const page = paginate(items, limit, offset)
    return { total: items.length, items: page.map((d) => ({ ...clone(d), hasImage: d.images.length > 0 })) }
  }

  function addImage(kind, id, meta = {}) {
    const doc = mustGet(kind, id)
    const file = str(meta.file)
    if (!file) throw new HttpError(400, 'INVALID_IMAGE', '图片文件路径不能为空')
    const entry = {
      file,
      width: Number(meta.width) || 0,
      height: Number(meta.height) || 0,
      primary: doc.images.length === 0
    }
    doc.images.push(entry)
    doc.updatedAt = nowIso()
    save()
    return clone(entry)
  }

  function removeImage(kind, id, index) {
    const doc = mustGet(kind, id)
    const i = Number(index)
    if (!Number.isInteger(i) || i < 0 || i >= doc.images.length) {
      throw new HttpError(400, 'IMAGE_NOT_FOUND', '要删除的图片不存在')
    }
    if (doc.images.length <= 1) throw new HttpError(400, 'LAST_IMAGE', '至少保留 1 张图片')
    doc.images.splice(i, 1)
    if (!doc.images.some((im) => im.primary)) doc.images[0].primary = true
    doc.updatedAt = nowIso()
    save()
    return clone(doc)
  }

  // ---------- 预设 ----------

  function templateBrief(templateId) {
    const t = library.templates[templateId]
    if (!t || t.deleted) return null
    return { id: t.id, name: t.name, images: clone(t.images), primary: t.images[0]?.file || null }
  }

  function presetView(p) {
    const template = templateBrief(p.templateId)
    return { ...clone(p), templateValid: !!template, template }
  }

  function mustGetPreset(id) {
    const p = library.presets[id]
    if (!p) throw new HttpError(404, 'NOT_FOUND', `预设不存在：${id}`)
    return p
  }

  function mustTemplate(templateId) {
    const t = library.templates[str(templateId)]
    if (!t || t.deleted) throw new HttpError(400, 'INVALID_TEMPLATE', '样板不存在或已删除')
    return t
  }

  function createPreset({ name, templateId, slots } = {}) {
    const t = mustTemplate(templateId)
    const now = nowIso()
    const doc = {
      id: newId('p'),
      name: normalizeName(name, { max: MAX_PRESET_NAME, label: '预设名称' }),
      templateId: t.id,
      slots: normalizeSlots(slots),
      createdAt: now,
      updatedAt: now,
      deleted: false
    }
    library.presets[doc.id] = doc
    save()
    return presetView(doc)
  }

  function listPresets({ q, includeDeleted = false, limit, offset = 0 } = {}) {
    const kw = str(q).trim().toLowerCase()
    const items = Object.values(library.presets).filter((p) => {
      if (!includeDeleted && p.deleted) return false
      if (kw && !p.name.toLowerCase().includes(kw)) return false
      return true
    })
    items.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '') || b.id.localeCompare(a.id))
    const page = paginate(items, limit, offset)
    return { total: items.length, items: page.map((p) => presetView(p)) }
  }

  function getPreset(id) {
    return presetView(mustGetPreset(id))
  }

  function updatePreset(id, patch = {}) {
    const p = mustGetPreset(id)
    if ('name' in patch) p.name = normalizeName(patch.name, { max: MAX_PRESET_NAME, label: '预设名称' })
    if ('templateId' in patch) p.templateId = mustTemplate(patch.templateId).id
    if ('slots' in patch) p.slots = normalizeSlots(patch.slots)
    p.updatedAt = nowIso()
    save()
    return presetView(p)
  }

  function removePreset(id) {
    const p = mustGetPreset(id)
    p.deleted = true
    p.updatedAt = nowIso()
    save()
    return presetView(p)
  }

  function undeletePreset(id) {
    const p = mustGetPreset(id)
    p.deleted = false
    p.updatedAt = nowIso()
    save()
    return presetView(p)
  }

  function duplicatePreset(id) {
    const src = mustGetPreset(id)
    const base = src.name.length > MAX_PRESET_NAME - 3 ? src.name.slice(0, MAX_PRESET_NAME - 3) : src.name
    const now = nowIso()
    const doc = {
      id: newId('p'),
      name: `${base} 副本`,
      templateId: src.templateId,
      slots: src.slots.map((s, i) => ({ ...s, id: `s-${i + 1}`, tags: [...s.tags] })),
      createdAt: now,
      updatedAt: now,
      deleted: false
    }
    library.presets[doc.id] = doc
    save()
    return presetView(doc)
  }

  // ---------- 记录 ----------

  function createRender(doc = {}) {
    const record = { ...clone(doc), id: doc.id || newId('r'), createdAt: doc.createdAt || nowIso() }
    renders.renders[record.id] = record
    save()
    return clone(record)
  }

  function getRender(id) {
    const r = renders.renders[id]
    if (!r) throw new HttpError(404, 'NOT_FOUND', `记录不存在：${id}`)
    return clone(r)
  }

  function updateRender(id, patch = {}) {
    const r = renders.renders[id]
    if (!r) throw new HttpError(404, 'NOT_FOUND', `记录不存在：${id}`)
    Object.assign(r, clone(patch))
    save()
    return clone(r)
  }

  function listRenders({ templateId, materialId, limit, offset = 0 } = {}) {
    const items = Object.values(renders.renders).filter((r) => {
      if (templateId && r.templateSnapshot?.id !== templateId) return false
      if (materialId && !(r.materialsSnapshot || []).some((m) => m.id === materialId)) return false
      return true
    })
    items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || b.id.localeCompare(a.id))
    const page = paginate(items, limit, offset)
    return { total: items.length, items: page.map(clone) }
  }

  function renderChildren(parentId) {
    return Object.values(renders.renders)
      .filter((r) => r.parentId === parentId)
      .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || a.id.localeCompare(b.id))
      .map((r) => ({ id: r.id, createdAt: r.createdAt, status: r.status }))
  }

  // ---------- 聚合 ----------

  function scenes() {
    const used = [...Object.values(library.materials), ...Object.values(library.templates)]
      .filter((d) => !d.deleted)
      .map((d) => d.scene)
    return [...new Set([...PRESET_SCENES, ...library.scenes, ...used])]
  }

  function tags(kind) {
    const set = new Set()
    for (const d of Object.values(bucket(kind))) {
      if (d.deleted) continue
      for (const t of d.tags) set.add(t)
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'zh'))
  }

  return {
    dataDir,
    newId,
    save,
    list,
    create,
    get,
    update,
    remove,
    undelete,
    addImage,
    removeImage,
    createPreset,
    listPresets,
    getPreset,
    updatePreset,
    removePreset,
    undeletePreset,
    duplicatePreset,
    createRender,
    getRender,
    updateRender,
    listRenders,
    renderChildren,
    scenes,
    tags
  }
}
