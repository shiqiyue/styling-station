/**
 * 记录视图：列表（缩略图/样板/预设/状态/时间，支持 ?template=&material= 筛选）+ 详情
 * （快照明细、候选图选用/下载、版本链跳转、停止、再出一版）。
 * 详情对未完成任务用 SSE 实时刷新（降级为事件驱动的记录重取）。
 */

import { api, streamRender } from '../lib/api.js'
import { el, clear, toast } from '../lib/dom.js'
import { resultCard } from './studio.js'

const TERMINAL = new Set(['done', 'error', 'stopped'])
const STATUS_LABEL = { queued: '排队中', running: '出图中', done: '已完成', error: '失败', stopped: '已停止' }
const LIST_LIMIT = 20

let unsub = null

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '')
  const qIdx = raw.indexOf('?')
  const path = qIdx >= 0 ? raw.slice(0, qIdx) : raw
  const query = qIdx >= 0 ? raw.slice(qIdx + 1) : ''
  const parts = path.split('/')
  return { id: parts[1] || null, params: new URLSearchParams(query) }
}

function fmtTime(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return iso
  }
}

function statusBadge(status) {
  return el('span', { class: `badge ${status}` }, STATUS_LABEL[status] || status)
}

function modeLabel(rec) {
  return rec.mode === 'preset' ? '预设搭配' : '自由搭配'
}

function titleOf(rec) {
  if (rec.presetSnapshot?.name) return rec.presetSnapshot.name
  return rec.templateSnapshot?.name || '（无样板）'
}

// ---------- 列表 ----------

async function renderList(container, params) {
  const templateId = params.get('template') || ''
  const materialId = params.get('material') || ''

  const head = el('div', { class: 'view-head' }, [
    el('h2', {}, '记录'),
    el('button', { onclick: () => rerender() }, '刷新')
  ])
  container.append(head)

  if (templateId || materialId) {
    const chip = el('div', { class: 'filter-row' }, [el('span', { class: 'filter-label' }, '筛选：')])
    const nameEl = el('span', { class: 'chip on' }, '加载中…')
    chip.append(nameEl)
    container.append(chip)
    // 异步取名称展示
    ;(async () => {
      try {
        if (templateId) {
          const t = await api.get(`/api/templates/${templateId}`)
          nameEl.textContent = `样板：${t.name}`
        } else {
          const m = await api.get(`/api/materials/${materialId}`)
          nameEl.textContent = `素材：${m.name}`
        }
      } catch {
        nameEl.textContent = templateId ? `样板 ${templateId}` : `素材 ${materialId}`
      }
    })()
    const clearBtn = el('button', { onclick: () => (location.hash = '#/renders') }, '清除筛选')
    chip.append(clearBtn)
  }

  const listBox = el('div', { class: 'render-list' })
  const moreBtn = el('button', { style: { display: 'none' } }, '加载更多')
  container.append(listBox, el('div', { style: { marginTop: '12px' } }, moreBtn))

  let offset = 0
  let total = 0
  let loading = false

  async function load(more) {
    if (loading) return
    loading = true
    moreBtn.disabled = true
    if (!more) {
      clear(listBox)
      listBox.append(el('div', { class: 'muted loading' }, '加载中…'))
    }
    const p = new URLSearchParams({ limit: String(LIST_LIMIT), offset: String(offset) })
    if (templateId) p.set('templateId', templateId)
    if (materialId) p.set('materialId', materialId)
    try {
      const data = await api.get(`/api/renders?${p}`)
      total = data.total
      if (!more) clear(listBox)
      if (!data.items.length && offset === 0) {
        listBox.append(el('div', { class: 'empty' }, '还没有出图记录；到「搭配台」生成第一张效果图。'))
      }
      for (const rec of data.items) listBox.append(renderRow(rec))
      offset += data.items.length
      moreBtn.style.display = offset < total ? '' : 'none'
      moreBtn.textContent = `加载更多（已显示 ${offset}/${total}）`
    } catch (e) {
      if (!more) {
        clear(listBox)
        listBox.append(el('div', { class: 'empty' }, e.message))
      } else {
        toast(e.message, { type: 'error' })
      }
    } finally {
      loading = false
      moreBtn.disabled = false
    }
  }
  moreBtn.onclick = () => load(true)

  function renderRow(rec) {
    const first = (rec.results || []).find((r) => !r.error)
    const thumb = first
      ? el('img', { src: '/' + first.file, loading: 'lazy', alt: titleOf(rec) })
      : el('div', { class: 'noimg' }, rec.results?.length ? '无图' : '无候选')
    const chosenCount = (rec.results || []).filter((r) => r.chosen).length
    return el('div', { class: 'render-row', onclick: () => (location.hash = `#/renders/${rec.id}`) }, [
      thumb,
      el('div', { class: 'rr-body' }, [
        el('div', { class: 'rr-title' }, [
          el('span', { class: 'name' }, titleOf(rec)),
          statusBadge(rec.status),
          el('span', { class: 'badge' }, modeLabel(rec)),
          chosenCount ? el('span', { class: 'badge ok' }, `${chosenCount} 张选用`) : null
        ]),
        el('div', { class: 'rr-sub' }, [
          el('span', {}, `样板：${rec.templateSnapshot?.name || '—'}`),
          el('span', {}, `素材 ${(rec.materialsSnapshot || []).length} 个`),
          el('span', {}, `候选 ${(rec.results || []).length}/${rec.candidateCount || 0} 张`),
          el('span', {}, rec.size || ''),
          el('span', {}, fmtTime(rec.createdAt))
        ])
      ])
    ])
  }

  function rerender() {
    location.hash = '#/renders'
    // 已在该路由：直接重载列表
    offset = 0
    load(false)
  }

  await load(false)
}

// ---------- 详情 ----------

async function renderDetail(container, id) {
  let cur = null
  let alive = true

  const statusBox = el('div', { class: 'studio-col-head' })
  const actionsBox = el('div', { class: 'rp-actions' })
  const resultsGrid = el('div', { class: 'results-grid' })
  const snapBox = el('div')
  const chainBox = el('div', { class: 'chain' })

  container.append(
    el('div', { class: 'view-head' }, [
      el('a', { class: 'btn-link', href: '#/renders' }, '← 返回列表'),
      el('h2', {}, '记录详情'),
      el('span', { class: 'spacer' }),
      actionsBox
    ]),
    el('div', { class: 'studio-col' }, [statusBox]),
    el('div', { class: 'studio-col' }, [el('h3', {}, '快照明细'), snapBox]),
    el('div', { class: 'studio-col' }, [el('h3', {}, '候选图'), resultsGrid]),
    el('div', { class: 'studio-col' }, [el('h3', {}, '版本链'), chainBox])
  )

  function paintStatus(rec) {
    clear(statusBox)
    let line = `${titleOf(rec)} · ${modeLabel(rec)}`
    if (rec.templateSnapshot?.name && rec.presetSnapshot?.name) line += `（样板：${rec.templateSnapshot.name}）`
    statusBox.append(el('span', {}, line), statusBadge(rec.status))
    if (rec.status === 'done' && rec.elapsedMs) statusBox.append(el('span', { class: 'muted' }, `耗时 ${(rec.elapsedMs / 1000).toFixed(1)}s`))
    statusBox.append(el('span', { class: 'muted' }, fmtTime(rec.createdAt)))
    statusBox.append(el('span', { class: 'spacer' }))
    if (rec.cliSessionId) statusBox.append(el('span', { class: 'muted' }, `CLI 会话 ${rec.cliSessionId}`))

    clear(actionsBox)
    if (rec.status === 'queued' || rec.status === 'running') {
      actionsBox.append(
        el(
          'button',
          {
            class: 'danger-text',
            onclick: async () => {
              try {
                await api.post(`/api/renders/${id}/stop`, {})
                refetch()
              } catch (e) {
                toast(e.message, { type: 'error' })
              }
            }
          },
          '停止'
        )
      )
    } else {
      actionsBox.append(
        el(
          'button',
          {
            class: 'primary',
            onclick: async () => {
              try {
                const { renderId } = await api.post(`/api/renders/${id}/rerun`, {})
                toast('已提交新版本', { type: 'success' })
                location.hash = `#/renders/${renderId}`
              } catch (e) {
                toast(e.message, { type: 'error' })
              }
            }
          },
          '再出一版'
        )
      )
    }
    if (rec.stderrTail && rec.status === 'error') {
      statusBox.append(el('div', { class: 'rp-error', style: { flexBasis: '100%' } }, rec.stderrTail))
    }
  }

  function paintSnapshot(rec) {
    clear(snapBox)
    const t = rec.templateSnapshot
    if (t) {
      snapBox.append(
        el('div', { class: 'snap-mat' }, [
          t.images?.[0] ? el('img', { src: '/' + t.images[0].file, alt: t.name }) : el('div', { class: 'noimg' }, '无图'),
          el('div', { class: 'sm-body' }, [
            el('div', {}, `样板：${t.name}`),
            el('div', { class: 'tags' }, (t.tags || []).map((x) => el('span', { class: 'tag' }, x)))
          ])
        ])
      )
    }
    for (const m of rec.materialsSnapshot || []) {
      snapBox.append(
        el('div', { class: 'snap-mat' }, [
          m.images?.[0] ? el('img', { src: '/' + m.images[0].file, alt: m.name }) : el('div', { class: 'noimg' }, '无图'),
          el('div', { class: 'sm-body' }, [
            el('div', {}, [
              m.slotName ? el('span', { class: 'badge' }, `插槽：${m.slotName}`) : null,
              ` 素材：${m.name}`
            ]),
            m.slotPosition ? el('div', { class: 'muted' }, `位置：${m.slotPosition}`) : null,
            el('div', { class: 'tags' }, (m.tags || []).map((x) => el('span', { class: 'tag' }, x)))
          ])
        ])
      )
    }
    if (rec.positionNote) snapBox.append(el('div', { class: 'muted' }, `整体位置说明：${rec.positionNote}`))
    snapBox.append(el('div', { class: 'muted' }, `候选张数：${rec.candidateCount} · 尺寸：${rec.size || '—'}`))
  }

  function paintResults(rec) {
    clear(resultsGrid)
    const results = (rec.results || []).filter(Boolean)
    if (!results.length) {
      resultsGrid.append(
        el('div', { class: 'empty' }, rec.status === 'done' ? '本次没有产出候选图' : '候选图生成后会出现在这里')
      )
      return
    }
    results.forEach((r, i) => resultsGrid.append(resultCard(r, i + 1, choose)))

    async function choose(idx, chosen) {
      try {
        const updated = await api.post(`/api/renders/${id}/results/${idx}/chosen`, { chosen })
        if (!alive) return
        cur = updated
        paintResults(cur)
        toast(chosen ? `已选用候选 ${idx}` : '已取消选用', { type: 'success' })
      } catch (e) {
        toast(e.message, { type: 'error' })
      }
    }
  }

  let chainSeq = 0
  async function paintChain(rec) {
    const my = ++chainSeq
    clear(chainBox)
    if (rec.parentId) {
      const node = el('button', { class: 'chain-node', onclick: () => (location.hash = `#/renders/${rec.parentId}`) }, '← 上一版')
      chainBox.append(node)
    }
    chainBox.append(el('span', { class: 'chain-node cur' }, `本版（${STATUS_LABEL[rec.status] || rec.status}）`))
    for (const cid of rec.childrenIds || []) {
      try {
        const child = await api.get(`/api/renders/${cid}`)
        if (!alive || my !== chainSeq) return
        chainBox.append(
          el(
            'button',
            { class: 'chain-node', onclick: () => (location.hash = `#/renders/${cid}`) },
            `下一版 →（${STATUS_LABEL[child.status] || child.status} · ${fmtTime(child.createdAt)}）`
          )
        )
      } catch {
        /* 子记录读取失败则跳过 */
      }
    }
    if (my === chainSeq && !rec.parentId && !(rec.childrenIds || []).length) {
      chainBox.append(el('span', { class: 'muted' }, '（单版记录）'))
    }
  }

  async function refetch() {
    try {
      const rec = await api.get(`/api/renders/${id}`)
      if (!alive) return
      cur = rec
      paintStatus(rec)
      paintResults(rec)
      await paintChain(rec)
      if (TERMINAL.has(rec.status)) {
        unsub = null
      }
    } catch (e) {
      toast(e.message, { type: 'error' })
    }
  }

  // 初始加载
  let rec
  try {
    rec = await api.get(`/api/renders/${id}`)
  } catch (e) {
    container.append(el('div', { class: 'empty' }, e.message))
    return
  }
  cur = rec
  paintStatus(rec)
  paintSnapshot(rec)
  paintResults(rec)
  paintChain(rec)

  // 未完成 → SSE 实时刷新
  if (!TERMINAL.has(rec.status)) {
    let t = null
    const schedule = () => {
      if (t) return
      t = setTimeout(() => {
        t = null
        refetch()
      }, 400)
    }
    unsub = streamRender(id, {
      onEvent: ({ event }) => {
        if (event === 'status' || event === 'result' || event === 'done') schedule()
      }
    })
  }
}

// ---------- 视图 ----------

export const rendersView = {
  async render(container) {
    unsub?.()
    unsub = null
    const { id, params } = parseRoute()
    if (id) await renderDetail(container, id)
    else await renderList(container, params)
  }
}
