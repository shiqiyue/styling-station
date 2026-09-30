/**
 * 搭配台：自由 / 预设双模式。
 * - 自由：样板单选 + 素材多选（筛选 / 立即上传 / 标签推荐）+ 位置说明 + 张数 → 出图。
 * - 预设：选预设 → 样板预览 + 插槽卡片（抽屉选素材，按插槽标签预筛选）+ 一键自动填充 + 补充说明 → 出图。
 * - 提交后经 SSE 实时展示：排队/出图状态、思考过程（折叠）、候选图（大图/选用/下载/再出一版）。
 * - 选择状态存模块级 state：切换 Tab 保留；出图面板可跨 Tab 恢复并重连。
 */

import { api, streamRender } from '../lib/api.js'
import { el, clear, toast, modal, field, tagInput, imageUploader } from '../lib/dom.js'

const TERMINAL = new Set(['done', 'error', 'stopped'])
const STATUS_LABEL = { queued: '排队中', running: '出图中', done: '已完成', error: '出图失败', stopped: '已停止' }
const MODES = [
  ['free', '自由搭配'],
  ['preset', '预设搭配']
]

const state = {
  mode: 'free',
  free: {
    templateId: null,
    templateBrief: null, // { id, name, scene, file }
    picked: [], // 素材 id，按选择顺序（≤8）
    briefs: {}, // id → { id, name, file }
    tScene: '',
    tQ: '',
    mScene: '',
    mQ: '',
    positionNote: '',
    candidateCount: 1
  },
  preset: {
    presetId: null,
    presetBrief: null, // 预设视图对象（含 template 简报与 slots）
    assignments: {}, // slotId → { id, name, file }
    q: '',
    note: '',
    candidateCount: 1
  },
  render: null // { id, status, queuePosition, blocks, results, error, elapsedMs, parentId }
}

// ---- 模块级运行时引用 ----
let ui = null // 出图面板 DOM 引用（Tab 切换后重建）
let unsub = null
let unsubId = null
let blocksTimer = null
let thinkOpen = false
let toolOpen = false
let scenesCache = null
let matCache = null
let radioSeq = 0
let submitBusy = false
let modeBoxEl = null
let renderWrapEl = null

// ---------- 通用工具 ----------

async function getScenes() {
  if (!scenesCache) {
    try {
      scenesCache = (await api.get('/api/scenes')).scenes || []
    } catch {
      scenesCache = []
    }
  }
  return scenesCache
}

/** 场景下拉（异步填充选项；initial 在填充后回填） */
function makeSceneSelect(initial, onchange) {
  const sel = el('select', {})
  sel.append(el('option', { value: '' }, '全部场景'))
  sel.onchange = () => onchange(sel.value)
  getScenes().then((list) => {
    for (const s of list) sel.append(el('option', { value: s }, s))
    sel.value = initial || ''
  })
  return sel
}

function debounceInput(fn) {
  let t
  return (e) => {
    const v = e.target.value.trim()
    clearTimeout(t)
    t = setTimeout(() => fn(v), 250)
  }
}

function countPicker(get, set) {
  const name = `cc-${++radioSeq}`
  const wrap = el('div', { class: 'radio-line' })
  for (const n of [1, 2, 4]) {
    const input = el('input', { type: 'radio', name, value: String(n), checked: get() === n })
    input.onchange = () => set(n)
    wrap.append(el('label', {}, [input, `${n} 张`]))
  }
  return wrap
}

/** 素材简报缓存（推荐/自动填充用） */
async function ensureMatCache(force = false) {
  if (!matCache || force) {
    const data = await api.get('/api/materials?limit=500')
    matCache = new Map(data.items.map((m) => [m.id, { id: m.id, name: m.name, file: m.images?.[0]?.file || null }]))
  }
  return matCache
}

// ---------- 出图面板 ----------

function statusLine(r) {
  let s = STATUS_LABEL[r.status] || r.status
  if (r.status === 'queued' && r.queuePosition > 0) s += `（第 ${r.queuePosition} 位）`
  if (r.status === 'done' && r.elapsedMs) s += `（耗时 ${(r.elapsedMs / 1000).toFixed(1)}s）`
  return s
}

function details(summary, text, open, onToggle) {
  const d = el('details', { open: !!open })
  d.append(el('summary', {}, summary), el('pre', {}, text))
  d.addEventListener('toggle', () => onToggle(d.open))
  return d
}

function resultCard(res, idx) {
  return el('div', { class: `result-card ${res.chosen ? 'chosen' : ''}` }, [
    el('a', { href: '/' + res.file, target: '_blank' }, el('img', { src: '/' + res.file, loading: 'lazy', alt: `候选 ${idx}` })),
    el('div', { class: 'rc-bar' }, [
      el('span', { class: 'rc-idx' }, `候选 ${idx}`),
      res.chosen ? el('span', { class: 'badge ok' }, '已选用') : null,
      el('span', { class: 'spacer' }),
      el('button', { class: res.chosen ? '' : 'primary', onclick: () => chooseResult(idx, !res.chosen) }, res.chosen ? '取消选用' : '选用'),
      el('a', { class: 'btn-link', href: '/' + res.file, download: `v${idx}.png` }, '下载')
    ])
  ])
}

function repaintRender(part = 'all') {
  if (!ui || !ui.panel.isConnected) return
  const r = state.render
  if (!r) return
  if (part === 'all' || part === 'status') {
    ui.statusText.textContent = statusLine(r)
    ui.statusDot.className = `dot ${r.status}`
    ui.errEl.textContent = r.status === 'error' && r.error ? r.error : ''
    clear(ui.actions)
    if (r.status === 'queued' || r.status === 'running') {
      ui.actions.append(el('button', { class: 'danger-text', onclick: stopCurrent }, '停止'))
    } else if (TERMINAL.has(r.status)) {
      ui.actions.append(el('button', { class: 'primary', onclick: rerunCurrent }, '再出一版'))
      if (r.parentId) ui.actions.append(el('button', { onclick: () => loadRender(r.parentId) }, '查看上一版'))
    }
  }
  if (part === 'all' || part === 'blocks') {
    clear(ui.blocksBox)
    const thinking = r.blocks
      .filter((b) => b.channel === 'thinking')
      .map((b) => b.text)
      .join('\n')
    const logs = r.blocks
      .filter((b) => b.channel !== 'thinking')
      .map((b) => `[${b.channel}] ${b.text}`)
      .join('\n')
    if (thinking) ui.blocksBox.append(details('思考过程', thinking, thinkOpen, (v) => (thinkOpen = v)))
    if (logs) ui.blocksBox.append(details('过程日志', logs, toolOpen, (v) => (toolOpen = v)))
    if (!thinking && !logs && (r.status === 'queued' || r.status === 'running')) {
      ui.blocksBox.append(el('div', { class: 'muted' }, r.status === 'queued' ? '排队中…' : '正在生成…'))
    }
  }
  if (part === 'all' || part === 'results') {
    clear(ui.resultsGrid)
    r.results.forEach((res, i) => {
      if (res) ui.resultsGrid.append(resultCard(res, i + 1))
    })
  }
}

function scheduleBlocksRepaint() {
  if (blocksTimer) return
  blocksTimer = setTimeout(() => {
    blocksTimer = null
    repaintRender('blocks')
  }, 250)
}

function buildRenderPanel() {
  const statusDot = el('span', { class: 'dot' })
  const statusText = el('span', {})
  const actions = el('div', { class: 'rp-actions' })
  const errEl = el('div', { class: 'rp-error' })
  const blocksBox = el('div', { class: 'rp-blocks' })
  const resultsGrid = el('div', { class: 'results-grid' })
  const panel = el('div', { class: 'render-panel' }, [
    el('div', { class: 'rp-head' }, [statusDot, statusText, el('span', { class: 'spacer' }), actions]),
    errEl,
    blocksBox,
    resultsGrid
  ])
  ui = { panel, statusDot, statusText, actions, errEl, blocksBox, resultsGrid }
  repaintRender('all')
  return panel
}

function handleStream({ event, data }) {
  const r = state.render
  if (!r) return
  if (event === 'snapshot') {
    r.status = data.status
    r.queuePosition = data.queuePosition || 0
    if (Array.isArray(data.blocks)) r.blocks = data.blocks
    repaintRender('status')
    repaintRender('blocks')
  } else if (event === 'delta') {
    r.blocks.push({ channel: data.channel, text: data.text })
    if (r.blocks.length > 400) r.blocks.splice(0, r.blocks.length - 400)
    scheduleBlocksRepaint()
  } else if (event === 'status') {
    r.status = data.status
    r.queuePosition = data.queuePosition || 0
    repaintRender('status')
  } else if (event === 'result') {
    r.results[data.index - 1] = { file: data.file, width: data.width, height: data.height, chosen: false }
    repaintRender('results')
  } else if (event === 'error') {
    r.error = data.message
    repaintRender('status')
  } else if (event === 'done') {
    r.status = data.status
    unsub = null
    unsubId = null
    repaintRender('status')
    refreshRecord(r.id)
  }
}

function subscribeRender(id) {
  if (unsub && unsubId === id) return
  unsub?.()
  unsubId = id
  unsub = streamRender(id, { onEvent: handleStream })
}

async function refreshRecord(id) {
  try {
    const rec = await api.get(`/api/renders/${id}`)
    if (state.render?.id !== id) return
    state.render.status = rec.status
    state.render.elapsedMs = rec.elapsedMs
    if (rec.results?.length) {
      state.render.results = rec.results.map((x) => ({ file: x.file, width: x.width, height: x.height, chosen: !!x.chosen }))
    }
    if (rec.status === 'error' && !state.render.error) state.render.error = rec.stderrTail || '出图失败'
    repaintRender('all')
    if (TERMINAL.has(rec.status)) {
      unsub = null
      unsubId = null
    }
  } catch {
    /* 恢复失败不打断页面 */
  }
}

async function loadRender(id) {
  try {
    const rec = await api.get(`/api/renders/${id}`)
    state.render = {
      id,
      status: rec.status,
      queuePosition: 0,
      blocks: [],
      results: (rec.results || []).map((x) => ({ file: x.file, width: x.width, height: x.height, chosen: !!x.chosen })),
      error: rec.status === 'error' ? rec.stderrTail || '出图失败' : null,
      elapsedMs: rec.elapsedMs,
      parentId: rec.parentId || null
    }
    if (!TERMINAL.has(rec.status)) subscribeRender(id)
    repaintRender('all')
  } catch (e) {
    toast(e.message, { type: 'error' })
  }
}

function startRender(renderId, parentId) {
  state.render = { id: renderId, status: 'queued', queuePosition: 1, blocks: [], results: [], error: null, elapsedMs: null, parentId: parentId || null }
  if (renderWrapEl && renderWrapEl.isConnected) {
    renderWrapEl.textContent = ''
    renderWrapEl.append(buildRenderPanel())
    renderWrapEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
  subscribeRender(renderId)
}

async function chooseResult(idx, chosen) {
  if (!state.render) return
  try {
    const rec = await api.post(`/api/renders/${state.render.id}/results/${idx}/chosen`, { chosen })
    state.render.results = rec.results.map((x) => ({ file: x.file, width: x.width, height: x.height, chosen: !!x.chosen }))
    repaintRender('results')
    toast(chosen ? `已选用候选 ${idx}` : '已取消选用', { type: 'success' })
  } catch (e) {
    toast(e.message, { type: 'error' })
  }
}

async function stopCurrent() {
  if (!state.render) return
  try {
    await api.post(`/api/renders/${state.render.id}/stop`, {})
  } catch (e) {
    toast(e.message, { type: 'error' })
  }
}

async function rerunCurrent() {
  if (!state.render || submitBusy) return
  submitBusy = true
  try {
    const { renderId, parentId } = await api.post(`/api/renders/${state.render.id}/rerun`, {})
    startRender(renderId, parentId)
    toast('已按同一配置提交新版本', { type: 'success' })
  } catch (e) {
    toast(e.message, { type: 'error' })
  } finally {
    submitBusy = false
  }
}

// ---------- 视图 ----------

export const studioView = {
  async render(container) {
    const f = state.free
    const p = state.preset
    modeBoxEl = el('div')
    renderWrapEl = el('div')

    const segBox = el('div', { class: 'seg' })
    function paintSeg() {
      clear(segBox)
      for (const [m, label] of MODES) {
        segBox.append(
          el(
            'button',
            {
              class: state.mode === m ? 'on' : '',
              onclick: () => {
                if (state.mode === m) return
                state.mode = m
                paintSeg()
                paintMode()
              }
            },
            label
          )
        )
      }
    }

    container.append(el('div', { class: 'view-head' }, [el('h2', {}, '搭配台'), segBox]), modeBoxEl, renderWrapEl)

    function paintMode() {
      clear(modeBoxEl)
      modeBoxEl.append(state.mode === 'free' ? freePanel() : presetPanel())
    }

    // ---------- 自由模式 ----------
    function freePanel() {
      const box = el('div', { class: 'studio-cols' })

      // ① 样板
      const tplGrid = el('div', { class: 'card-grid studio-grid' })
      let tplSeq = 0
      async function loadTemplates() {
        const my = ++tplSeq
        clear(tplGrid)
        tplGrid.append(el('div', { class: 'muted loading' }, '加载中…'))
        const params = new URLSearchParams({ limit: '200' })
        if (f.tScene) params.set('scene', f.tScene)
        if (f.tQ) params.set('q', f.tQ)
        try {
          const data = await api.get(`/api/templates?${params}`)
          if (my !== tplSeq) return
          clear(tplGrid)
          if (!data.items.length) {
            tplGrid.append(el('div', { class: 'empty' }, '没有符合条件的样板'))
            return
          }
          for (const t of data.items) tplGrid.append(tplCell(t))
        } catch (e) {
          if (my !== tplSeq) return
          clear(tplGrid)
          tplGrid.append(el('div', { class: 'empty' }, e.message))
        }
      }
      function tplCell(t) {
        const sel = f.templateId === t.id
        return el('div', { class: `cell ${sel ? 'selected' : ''}`, title: t.name, onclick: () => selectTemplate(t) }, [
          t.images?.[0] ? el('img', { src: '/' + t.images[0].file, loading: 'lazy', alt: t.name }) : el('div', { class: 'noimg' }, '无图'),
          el('div', { class: 'cell-name' }, t.name),
          sel ? el('span', { class: 'cell-badge' }, '✓') : null
        ])
      }
      function selectTemplate(t) {
        if (!t.images?.length) {
          toast('该样板还没有图片，请先到「样板库」上传', { type: 'error' })
          return
        }
        f.templateId = t.id
        f.templateBrief = { id: t.id, name: t.name, scene: t.scene, file: t.images[0].file }
        loadTemplates()
        paintSidePanel()
      }

      const tplFilter = el('div', { class: 'filter-bar' }, [
        makeSceneSelect(f.tScene, (v) => {
          f.tScene = v
          loadTemplates()
        }),
        el('input', { type: 'search', placeholder: '搜索样板', value: f.tQ, oninput: debounceInput((v) => { f.tQ = v; loadTemplates() }) })
      ])
      box.append(el('div', { class: 'studio-col' }, [el('h3', {}, '① 选择样板'), tplFilter, tplGrid]))

      // ② 素材
      const matGrid = el('div', { class: 'card-grid studio-grid' })
      const badges = new Map() // id → cell 节点
      let matSeq = 0
      async function loadMaterials() {
        const my = ++matSeq
        clear(matGrid)
        badges.clear()
        matGrid.append(el('div', { class: 'muted loading' }, '加载中…'))
        const params = new URLSearchParams({ limit: '300' })
        if (f.mScene) params.set('scene', f.mScene)
        if (f.mQ) params.set('q', f.mQ)
        try {
          const data = await api.get(`/api/materials?${params}`)
          if (my !== matSeq) return
          clear(matGrid)
          if (!data.items.length) {
            matGrid.append(el('div', { class: 'empty' }, '没有符合条件的素材'))
            return
          }
          for (const m of data.items) matGrid.append(matCell(m))
          paintBadges()
        } catch (e) {
          if (my !== matSeq) return
          clear(matGrid)
          matGrid.append(el('div', { class: 'empty' }, e.message))
        }
      }
      function matCell(m) {
        const node = el('div', { class: 'cell', title: m.name, onclick: () => togglePick(m) }, [
          m.images?.[0] ? el('img', { src: '/' + m.images[0].file, loading: 'lazy', alt: m.name }) : el('div', { class: 'noimg' }, '无图'),
          el('div', { class: 'cell-name' }, m.name)
        ])
        badges.set(m.id, node)
        return node
      }
      function paintBadges() {
        for (const [id, node] of badges) {
          const i = f.picked.indexOf(id)
          const old = node.querySelector('.cell-badge')
          if (i >= 0) {
            if (old) old.textContent = String(i + 1)
            else node.append(el('span', { class: 'cell-badge' }, String(i + 1)))
          } else if (old) {
            old.remove()
          }
        }
      }
      function togglePick(m) {
        const i = f.picked.indexOf(m.id)
        if (i >= 0) {
          f.picked.splice(i, 1)
        } else {
          if (f.picked.length >= 8) {
            toast('一次最多搭配 8 个素材', { type: 'error' })
            return
          }
          if (!m.images?.length) {
            toast('该素材还没有图片，请先上传图片再搭配', { type: 'error' })
            return
          }
          f.picked.push(m.id)
          f.briefs[m.id] = { id: m.id, name: m.name, file: m.images[0].file }
        }
        paintBadges()
        paintSidePanel()
      }
      async function autoRecommend() {
        if (!f.templateId) {
          toast('请先选择样板，再按标签推荐素材', { type: 'error' })
          return
        }
        try {
          const { recommended } = await api.post('/api/renders/auto-recommend', { templateId: f.templateId, limit: 6 })
          const cache = await ensureMatCache(true)
          let n = 0
          for (const id of recommended || []) {
            if (f.picked.includes(id) || f.picked.length >= 8) continue
            const b = cache.get(id)
            if (!b) continue
            f.picked.push(id)
            f.briefs[id] = b
            n++
          }
          toast(n ? `已按标签推荐 ${n} 个素材（可手动增减）` : '没有命中标签的素材；可到素材库补充标签')
          paintBadges()
          paintSidePanel()
        } catch (e) {
          toast(e.message, { type: 'error' })
        }
      }

      function openUpload() {
        const name = el('input', { maxlength: 50, placeholder: '例如：胡桃木摆件' })
        const desc = el('textarea', { rows: 2, maxlength: 500, placeholder: '材质、风格…' })
        const sceneInput = el('input', { list: 'studio-scene-list', placeholder: '选择或输入场景' })
        const dl = el('datalist', { id: 'studio-scene-list' })
        getScenes().then((s) => {
          for (const x of s) dl.append(el('option', { value: x }))
        })
        const tags = tagInput([])
        const uploader = imageUploader({ pending: [], hint: '点击或拖拽图片（保存后立即上传并加入搭配）' })
        modal({
          title: '立即上传素材',
          wide: true,
          body: el('div', { class: 'form' }, [
            field('名称', name),
            field('描述', desc),
            field('场景', el('div', { class: 'row' }, [sceneInput, dl])),
            field('标签', tags.el),
            field('图片', uploader.el)
          ]),
          onOk: async () => {
            const payload = { name: name.value.trim(), description: desc.value.trim(), scene: sceneInput.value.trim(), tags: tags.get() }
            if (!payload.name) {
              toast('请填写名称', { type: 'error' })
              return false
            }
            if (!payload.scene) {
              toast('请填写场景', { type: 'error' })
              return false
            }
            const files = uploader.getPending()
            if (!files.length) {
              toast('请选择一张图片', { type: 'error' })
              return false
            }
            const doc = await api.post('/api/materials', payload)
            const uploaded = await api.upload(`/api/materials/${doc.id}/images`, files[0])
            const file = uploaded.images?.[0]?.file || null
            if (!f.picked.includes(doc.id) && f.picked.length < 8 && file) {
              f.picked.push(doc.id)
              f.briefs[doc.id] = { id: doc.id, name: doc.name, file }
            }
            matCache = null
            loadMaterials()
            paintSidePanel()
            toast(`素材「${doc.name}」已上传并加入搭配`, { type: 'success' })
          }
        })
      }

      const mSceneSel = makeSceneSelect(f.mScene, (v) => {
        f.mScene = v
        loadMaterials()
      })
      const matFilter = el('div', { class: 'filter-bar' }, [
        mSceneSel,
        el('input', { type: 'search', placeholder: '搜索素材', value: f.mQ, oninput: debounceInput((v) => { f.mQ = v; loadMaterials() }) })
      ])

      const matHead = el('div', { class: 'studio-col-head' }, [
        el('h3', {}, '② 选择素材'),
        el('span', { class: 'spacer' }),
        el('button', { onclick: openUpload }, '立即上传'),
        el('button', { onclick: autoRecommend }, '标签推荐')
      ])
      box.append(el('div', { class: 'studio-col' }, [matHead, matFilter, matGrid]))

      // ③ 出图设置
      const sideBox = el('div')
      const note = el('textarea', {
        rows: 5,
        maxlength: 1000,
        value: f.positionNote,
        placeholder: '例如：花瓶放餐桌中央；留空则由 AI 按常识布局'
      })
      note.oninput = () => {
        f.positionNote = note.value
      }
      function paintSidePanel() {
        clear(sideBox)
        if (f.templateBrief) {
          sideBox.append(
            el('div', { class: 'picked-item' }, [
              f.templateBrief.file ? el('img', { src: '/' + f.templateBrief.file, alt: '样板' }) : null,
              el('span', { class: 'name' }, `样板：${f.templateBrief.name}`)
            ])
          )
        } else {
          sideBox.append(el('div', { class: 'muted' }, '尚未选择样板'))
        }
        const picked = f.picked.map((id) => f.briefs[id]).filter(Boolean)
        sideBox.append(el('div', { class: 'muted' }, `已选素材 ${picked.length}/8`))
        if (picked.length) {
          const list = el('div', { class: 'picked-list' })
          for (const b of picked) {
            list.append(
              el('div', { class: 'picked-item' }, [
                b.file ? el('img', { src: '/' + b.file, alt: b.name }) : null,
                el('span', { class: 'name' }, b.name),
                el(
                  'button',
                  {
                    title: '移出搭配',
                    onclick: () => {
                      f.picked = f.picked.filter((x) => x !== b.id)
                      paintBadges()
                      paintSidePanel()
                    }
                  },
                  '✕'
                )
              ])
            )
          }
          sideBox.append(list)
        }
      }
      async function submitFree() {
        if (!f.templateId) {
          toast('请先选择样板', { type: 'error' })
          return
        }
        if (!f.picked.length) {
          toast('请至少选择一个素材', { type: 'error' })
          return
        }
        if (submitBusy) return
        submitBusy = true
        try {
          const { renderId } = await api.post('/api/renders', {
            mode: 'free',
            templateId: f.templateId,
            materialIds: [...f.picked],
            positionNote: f.positionNote.trim(),
            candidateCount: f.candidateCount
          })
          startRender(renderId, null)
        } catch (e) {
          toast(e.message, { type: 'error' })
        } finally {
          submitBusy = false
        }
      }

      box.append(
        el('div', { class: 'studio-col' }, [
          el('h3', {}, '③ 出图设置'),
          sideBox,
          field('位置说明', note, { hint: '说明素材应放在样板哪个位置；留空由 AI 自动布局' }),
          field('候选张数', countPicker(() => f.candidateCount, (n) => (f.candidateCount = n)), { hint: '多张候选便于挑选，耗时更长' }),
          el('button', { class: 'primary', onclick: submitFree }, '生成效果图')
        ])
      )

      paintSidePanel()
      loadTemplates()
      loadMaterials()
      return box
    }

    // ---------- 预设模式 ----------
    function presetPanel() {
      const box = el('div')

      // ① 选择预设
      const grid = el('div', { class: 'card-grid studio-grid' })
      let seq = 0
      async function loadPresets() {
        const my = ++seq
        clear(grid)
        grid.append(el('div', { class: 'muted loading' }, '加载中…'))
        const params = new URLSearchParams({ limit: '200' })
        if (p.q) params.set('q', p.q)
        try {
          const data = await api.get(`/api/presets?${params}`)
          if (my !== seq) return
          clear(grid)
          if (!data.items.length) {
            grid.append(el('div', { class: 'empty' }, '还没有预设；先到「预设」Tab 创建。'))
            return
          }
          for (const item of data.items) grid.append(pCell(item))
        } catch (e) {
          if (my !== seq) return
          clear(grid)
          grid.append(el('div', { class: 'empty' }, e.message))
        }
      }
      function pCell(item) {
        const sel = p.presetId === item.id
        return el('div', { class: `cell ${sel ? 'selected' : ''}`, title: item.name, onclick: () => selectPreset(item) }, [
          item.template?.primary
            ? el('img', { src: '/' + item.template.primary, loading: 'lazy', alt: item.name })
            : el('div', { class: 'noimg' }, item.templateValid ? '样板无图' : '样板失效'),
          el('span', { class: 'cell-count' }, `${item.slots.length} 槽`),
          el('div', { class: 'cell-name' }, item.name),
          sel ? el('span', { class: 'cell-badge' }, '✓') : null
        ])
      }
      function selectPreset(item) {
        if (!item.templateValid) {
          toast('该预设的样板已失效，请先到「预设」修复', { type: 'error' })
          return
        }
        if (!item.template?.primary) {
          toast('该预设的样板还没有图片，请先上传', { type: 'error' })
          return
        }
        p.presetId = item.id
        p.presetBrief = item
        p.assignments = {}
        loadPresets()
        paintBody()
      }

      box.append(
        el('div', { class: 'studio-col' }, [
          el('h3', {}, '① 选择预设'),
          el('div', { class: 'filter-bar' }, [
            el('input', { type: 'search', placeholder: '搜索预设', value: p.q, oninput: debounceInput((v) => { p.q = v; loadPresets() }) })
          ]),
          grid
        ])
      )

      // ② 样板预览 + 插槽（③ 出图设置）
      const body = el('div')
      box.append(body)
      function paintBody() {
        clear(body)
        const pb = p.presetBrief
        if (!pb) {
          body.append(el('div', { class: 'studio-empty' }, '先选择上方的一个预设（= 样板 + 插槽标签），再为每个插槽挑素材。'))
          return
        }
        body.append(
          el('div', { class: 'preset-tpl' }, [
            pb.template?.primary ? el('img', { src: '/' + pb.template.primary, alt: pb.template?.name }) : null,
            el('div', {}, [
              el('strong', {}, pb.template?.name || ''),
              el('div', { class: 'muted' }, pb.template?.scene || '')
            ])
          ])
        )
        const assignedN = pb.slots.filter((s) => p.assignments[s.id]).length
        body.append(
          el('div', { class: 'studio-col-head' }, [
            el('h3', {}, '② 填充插槽'),
            el('span', { class: 'muted' }, `${assignedN}/${pb.slots.length} 已填`),
            el('span', { class: 'spacer' }),
            el('button', { onclick: autoFill }, '一键自动填充')
          ])
        )
        const slotCards = el('div', { class: 'slot-cards' })
        pb.slots.forEach((s, i) => slotCards.append(slotCard(s, i + 1)))
        body.append(slotCards)

        // ③ 出图设置
        const note = el('textarea', {
          rows: 3,
          maxlength: 1000,
          value: p.note,
          placeholder: '补充整体位置说明（可留空）'
        })
        note.oninput = () => {
          p.note = note.value
        }
        body.append(
          el('div', { class: 'studio-col' }, [
            el('h3', {}, '③ 出图设置'),
            field('补充说明', note, { hint: '在预设插槽位置说明之外的整体说明；留空由 AI 布局' }),
            field('候选张数', countPicker(() => p.candidateCount, (n) => (p.candidateCount = n))),
            el('button', { class: 'primary', onclick: submitPreset }, '生成效果图')
          ])
        )
      }
      function slotCard(s, idx) {
        const b = p.assignments[s.id]
        return el('div', { class: 'slot-card', onclick: () => openDrawer(s) }, [
          el('div', { class: 'slot-card-head' }, [el('span', { class: 'slot-idx' }, `#${idx}`), el('span', {}, s.name)]),
          s.tags.length ? el('div', { class: 'tags' }, s.tags.map((t) => el('span', { class: 'tag' }, t))) : null,
          s.positionNote ? el('div', { class: 'note' }, s.positionNote) : null,
          el(
            'div',
            { class: 'slot-assign' },
            b
              ? [b.file ? el('img', { src: '/' + b.file, alt: b.name }) : null, el('span', { class: 'name' }, b.name)]
              : el('span', { class: 'empty-slot' }, '未选择素材（点击选择）')
          )
        ])
      }

      async function autoFill() {
        const pb = p.presetBrief
        if (!pb) return
        try {
          const { slots } = await api.post(`/api/presets/${pb.id}/auto-fill`, {})
          const cache = await ensureMatCache(true)
          let n = 0
          for (const s of slots || []) {
            if (!s.recommended || p.assignments[s.slotId]) continue
            const b = cache.get(s.recommended)
            if (!b) continue
            p.assignments[s.slotId] = b
            n++
          }
          toast(n ? `已自动填充 ${n} 个插槽（可点击更换）` : '没有可推荐的素材；请检查插槽标签与素材标签')
          paintBody()
        } catch (e) {
          toast(e.message, { type: 'error' })
        }
      }

      function openDrawer(slot) {
        const overlay = el('div', { class: 'drawer-overlay' })
        const drawer = el('div', { class: 'drawer' })
        const close = () => overlay.remove()
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) close()
        })
        const assigned = p.assignments[slot.id]
        const tagInp = el('input', { type: 'checkbox', checked: slot.tags.length > 0 })
        const head = el('div', { class: 'drawer-head' }, [
          el('h3', {}, `为插槽「${slot.name}」选择素材`),
          assigned
            ? el(
                'button',
                {
                  class: 'danger-text',
                  onclick: () => {
                    delete p.assignments[slot.id]
                    close()
                    paintBody()
                  }
                },
                '清除'
              )
            : null,
          el('button', { onclick: close }, '关闭')
        ])
        const search = el('input', { type: 'search', placeholder: '搜索素材' })
        const sceneSel = makeSceneSelect('', () => load())
        const grid2 = el('div', { class: 'drawer-grid' })
        drawer.append(
          head,
          el('div', { class: 'drawer-body' }, [
            el('div', { class: 'filter-bar' }, [sceneSel, search, el('label', { class: 'toggle' }, [tagInp, '仅匹配插槽标签'])]),
            grid2
          ])
        )
        overlay.append(drawer)
        document.body.append(overlay)

        let seq2 = 0
        async function load() {
          const my = ++seq2
          clear(grid2)
          grid2.append(el('div', { class: 'muted loading' }, '加载中…'))
          const params = new URLSearchParams({ limit: '500' })
          if (sceneSel.value) params.set('scene', sceneSel.value)
          if (search.value.trim()) params.set('q', search.value.trim())
          try {
            const data = await api.get(`/api/materials?${params}`)
            if (my !== seq2) return
            let items = data.items
            if (tagInp.checked && slot.tags.length) {
              items = items.filter((m) => m.tags.some((t) => slot.tags.includes(t)))
            }
            clear(grid2)
            if (!items.length) {
              grid2.append(el('div', { class: 'empty' }, '没有符合条件的素材'))
              return
            }
            for (const m of items) {
              const cur = p.assignments[slot.id]?.id === m.id
              grid2.append(
                el('div', { class: `cell ${cur ? 'selected' : ''}`, title: m.name, onclick: () => assign(m) }, [
                  m.images?.[0] ? el('img', { src: '/' + m.images[0].file, loading: 'lazy', alt: m.name }) : el('div', { class: 'noimg' }, '无图'),
                  el('div', { class: 'cell-name' }, m.name),
                  m.tags.length ? el('div', { class: 'cell-tags' }, m.tags.slice(0, 2).map((t) => el('span', { class: 'tag' }, t))) : null
                ])
              )
            }
          } catch (e) {
            if (my !== seq2) return
            clear(grid2)
            grid2.append(el('div', { class: 'empty' }, e.message))
          }
        }
        function assign(m) {
          if (!m.images?.length) {
            toast('该素材还没有图片，请先上传', { type: 'error' })
            return
          }
          p.assignments[slot.id] = { id: m.id, name: m.name, file: m.images[0].file }
          close()
          paintBody()
        }
        search.oninput = debounceInput(() => load())
        tagInp.onchange = () => load()
        load()
      }

      async function submitPreset() {
        const pb = p.presetBrief
        if (!pb) {
          toast('请先选择预设', { type: 'error' })
          return
        }
        const missing = pb.slots.find((s) => !p.assignments[s.id])
        if (missing) {
          toast(`插槽「${missing.name}」还未选择素材`, { type: 'error' })
          return
        }
        if (submitBusy) return
        submitBusy = true
        try {
          const { renderId } = await api.post('/api/renders', {
            mode: 'preset',
            presetId: pb.id,
            assignments: pb.slots.map((s) => ({ slotId: s.id, materialId: p.assignments[s.id].id })),
            positionNote: p.note.trim(),
            candidateCount: p.candidateCount
          })
          startRender(renderId, null)
        } catch (e) {
          toast(e.message, { type: 'error' })
        } finally {
          submitBusy = false
        }
      }

      paintBody()
      loadPresets()
      return box
    }

    paintSeg()
    paintMode()

    // 恢复出图面板（跨 Tab）
    if (state.render) {
      renderWrapEl.append(buildRenderPanel())
      refreshRecord(state.render.id)
      if (!TERMINAL.has(state.render.status)) subscribeRender(state.render.id)
    }
  }
}
