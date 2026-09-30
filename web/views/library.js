/** 素材库 / 样板库同构视图工厂：筛选栏 + 卡片网格 + 编辑弹窗（字段 + 图片上传）。 */

import { api } from '../lib/api.js'
import { el, clear, toast, confirmDialog, modal, tagInput, imageUploader } from '../lib/dom.js'

export function createLibraryView(kind) {
  const label = kind === 'materials' ? '素材' : '样板'
  const view = { state: { scene: '', tags: [], q: '', includeDeleted: false } }

  view.render = async function render(container) {
    const state = view.state
    let meta = { scenes: [], tags: { materials: [], templates: [] } }
    try {
      meta = await api.get('/api/scenes')
    } catch (e) {
      toast(e.message, { type: 'error' })
    }
    const knownTags = meta.tags?.[kind] || []

    // ---------- 筛选栏 ----------
    const sceneSel = el('select', {}, [
      el('option', { value: '' }, '全部场景'),
      ...(meta.scenes || []).map((s) => el('option', { value: s }, s))
    ])
    sceneSel.value = state.scene
    sceneSel.onchange = () => {
      state.scene = sceneSel.value
      reload()
    }

    const search = el('input', { type: 'search', placeholder: `搜索${label}名称/描述`, value: state.q })
    let searchTimer
    search.oninput = () => {
      clearTimeout(searchTimer)
      searchTimer = setTimeout(() => {
        state.q = search.value.trim()
        reload()
      }, 250)
    }

    const delToggle = el('label', { class: 'toggle' }, [
      el('input', {
        type: 'checkbox',
        checked: state.includeDeleted,
        onchange: (e) => {
          state.includeDeleted = e.target.checked
          reload()
        }
      }),
      '显示已删除'
    ])

    const chips = el('div', { class: 'chips' })
    function renderChips() {
      clear(chips)
      if (!knownTags.length) {
        chips.append(el('span', { class: 'muted' }, '暂无已用标签'))
        return
      }
      for (const t of knownTags) {
        const on = state.tags.includes(t)
        chips.append(
          el(
            'button',
            {
              class: `chip ${on ? 'on' : ''}`,
              onclick: () => {
                state.tags = on ? state.tags.filter((x) => x !== t) : [...state.tags, t]
                renderChips()
                reload()
              }
            },
            t
          )
        )
      }
    }
    renderChips()

    const grid = el('div', { class: 'card-grid' })

    container.append(
      el('div', { class: 'view-head' }, [
        el('h2', {}, `${label}库`),
        el('button', { class: 'primary', onclick: () => openEditor(null) }, `新建${label}`)
      ]),
      el('div', { class: 'filter-bar' }, [sceneSel, search, delToggle]),
      el('div', { class: 'filter-row' }, [el('span', { class: 'filter-label' }, '标签：'), chips]),
      grid
    )

    // ---------- 数据 ----------
    let reloadSeq = 0
    async function reload() {
      const seq = ++reloadSeq
      clear(grid)
      grid.append(el('div', { class: 'muted loading' }, '加载中…'))
      const params = new URLSearchParams()
      if (state.scene) params.set('scene', state.scene)
      if (state.tags.length) params.set('tags', state.tags.join(','))
      if (state.q) params.set('q', state.q)
      if (state.includeDeleted) params.set('includeDeleted', '1')
      params.set('limit', '500')
      try {
        const data = await api.get(`/api/${kind}?${params}`)
        if (seq !== reloadSeq) return // 已有更新的筛选请求
        clear(grid)
        if (!data.items.length) {
          grid.append(el('div', { class: 'empty' }, `没有符合条件的${label}；点右上角「新建${label}」添加。`))
          return
        }
        for (const item of data.items) grid.append(card(item))
      } catch (e) {
        if (seq !== reloadSeq) return
        clear(grid)
        grid.append(el('div', { class: 'empty' }, e.message))
      }
    }

    function card(item) {
      const img = item.images?.[0]
      const thumb = img
        ? el('img', { src: '/' + img.file, loading: 'lazy', alt: item.name })
        : el('div', { class: 'noimg' }, '无图片')

      const actions = []
      if (item.deleted) {
        actions.push(
          el(
            'button',
            {
              onclick: async () => {
                try {
                  await api.post(`/api/${kind}/${item.id}/undelete`)
                  toast(`已恢复「${item.name}」`, { type: 'success' })
                  reload()
                } catch (e) {
                  toast(e.message, { type: 'error' })
                }
              }
            },
            '恢复'
          )
        )
      } else {
        actions.push(
          el('button', { onclick: () => openEditor(item) }, '编辑'),
          el(
            'button',
            {
              class: 'danger-text',
              onclick: async () => {
                if (!(await confirmDialog(`删除${label}「${item.name}」？删除后可在「显示已删除」里恢复。`))) return
                try {
                  await api.del(`/api/${kind}/${item.id}`)
                  toast('已删除', { type: 'success' })
                  reload()
                } catch (e) {
                  toast(e.message, { type: 'error' })
                }
              }
            },
            '删除'
          )
        )
      }

      return el('div', { class: `card ${item.deleted ? 'is-deleted' : ''}` }, [
        el('div', { class: 'card-thumb' }, thumb),
        el('div', { class: 'card-body' }, [
          el('div', { class: 'card-title' }, [
            el('span', { class: 'name' }, item.name),
            item.deleted ? el('span', { class: 'badge deleted' }, '已删除') : null,
            !item.deleted && !item.images?.length ? el('span', { class: 'badge warn' }, '待传图') : null
          ]),
          el('div', { class: 'card-sub' }, [
            el('span', { class: 'scene' }, item.scene),
            ...item.tags.slice(0, 5).map((t) => el('span', { class: 'tag' }, t))
          ]),
          el('div', { class: 'card-actions' }, actions)
        ])
      ])
    }

    // ---------- 编辑弹窗 ----------
    function openEditor(item) {
      const isNew = !item
      const name = el('input', { value: item?.name || '', maxlength: 50, placeholder: label === '素材' ? '例如：胡桃木摆件' : '例如：奶油风卧室' })
      const desc = el('textarea', { rows: 3, maxlength: 500, placeholder: '材质、风格、用途…' }, item?.description || '')
      const sceneInput = el('input', { value: item?.scene || '', list: 'scene-datalist', placeholder: '选择或输入场景' })
      const sceneList = el('datalist', { id: 'scene-datalist' }, (meta.scenes || []).map((s) => el('option', { value: s })))
      const tags = tagInput(item?.tags || [])

      let uploader
      if (isNew) {
        uploader = imageUploader({ pending: [], hint: '点击或拖拽图片到这里（先暂存，保存后自动上传）' })
      } else {
        uploader = imageUploader({
          images: [...(item.images || [])],
          uploadPath: `/api/${kind}/${item.id}/images`,
          onDelete: async (i) => {
            const doc = await api.del(`/api/${kind}/${item.id}/images/${i}`)
            item.images = doc.images
            return doc.images
          }
        })
      }

      const form = el('div', { class: 'form' }, [
        field('名称', name),
        field('描述', desc),
        field('场景', el('div', { class: 'row' }, [sceneInput, sceneList])),
        field('标签', tags.el),
        field('图片', uploader.el)
      ])

      modal({
        title: isNew ? `新建${label}` : `编辑${label}`,
        body: form,
        wide: true,
        onOk: async () => {
          const payload = {
            name: name.value.trim(),
            description: desc.value.trim(),
            scene: sceneInput.value.trim(),
            tags: tags.get()
          }
          if (!payload.name) {
            toast('请填写名称', { type: 'error' })
            return false
          }
          if (!payload.scene) {
            toast('请填写场景', { type: 'error' })
            return false
          }
          if (isNew) {
            const doc = await api.post(`/api/${kind}`, payload)
            const pendingFiles = uploader.getPending()
            let done = 0
            for (const f of pendingFiles) {
              try {
                await api.upload(`/api/${kind}/${doc.id}/images`, f)
                done++
              } catch (e) {
                toast(`${f.name}：${e.message}`, { type: 'error' })
              }
            }
            toast(`${label}「${doc.name}」已创建${done ? `，上传 ${done} 张图片` : ''}`, { type: 'success' })
          } else {
            await api.put(`/api/${kind}/${item.id}`, payload)
            toast('已保存', { type: 'success' })
          }
          await reload()
        }
      })
    }

    function field(text, control) {
      return el('label', { class: 'field' }, [el('span', { class: 'field-label' }, text), control])
    }

    await reload()
  }

  return view
}
