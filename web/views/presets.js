/** 预设视图：列表 + 编辑器（选样板 + 插槽编辑：名称/标签/位置说明/排序）。 */

import { api } from '../lib/api.js'
import { el, clear, toast, confirmDialog, modal, field, tagInput, debounce } from '../lib/dom.js'

export const presetsView = {
  async render(container) {
    const grid = el('div', { class: 'card-grid' })
    container.append(
      el('div', { class: 'view-head' }, [
        el('h2', {}, '预设'),
        el('button', { class: 'primary', onclick: () => openEditor(null) }, '新建预设')
      ]),
      el('p', { class: 'muted view-desc' }, '预设 = 一个样板 + 若干插槽（每个插槽配好标签与位置说明）；搭配台按预设一键填充。'),
      grid
    )

    let seq = 0
    async function reload() {
      const my = ++seq
      clear(grid)
      grid.append(el('div', { class: 'muted loading' }, '加载中…'))
      try {
        const data = await api.get('/api/presets?limit=500')
        if (my !== seq) return
        clear(grid)
        if (!data.items.length) {
          grid.append(el('div', { class: 'empty' }, '还没有预设；点「新建预设」选择样板并添加插槽。'))
          return
        }
        for (const p of data.items) grid.append(card(p))
      } catch (e) {
        if (my !== seq) return
        clear(grid)
        grid.append(el('div', { class: 'empty' }, e.message))
      }
    }

    function card(p) {
      const thumb = p.template?.primary
        ? el('img', { src: '/' + p.template.primary, loading: 'lazy', alt: p.name })
        : el('div', { class: 'noimg' }, p.templateValid ? '样板无图' : '样板失效')

      const actions = []
      if (p.deleted) {
        actions.push(
          el(
            'button',
            {
              onclick: async () => {
                try {
                  await api.post(`/api/presets/${p.id}/undelete`)
                  toast(`已恢复「${p.name}」`, { type: 'success' })
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
          el('button', { onclick: () => openEditor(p) }, '编辑'),
          el(
            'button',
            {
              onclick: async () => {
                try {
                  const copy = await api.post(`/api/presets/${p.id}/duplicate`)
                  toast(`已复制为「${copy.name}」`, { type: 'success' })
                  reload()
                } catch (e) {
                  toast(e.message, { type: 'error' })
                }
              }
            },
            '复制'
          ),
          el(
            'button',
            {
              class: 'danger-text',
              onclick: async () => {
                if (!(await confirmDialog(`删除预设「${p.name}」？`))) return
                try {
                  await api.del(`/api/presets/${p.id}`)
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

      return el('div', { class: `card ${p.deleted ? 'is-deleted' : ''}` }, [
        el('div', { class: 'card-thumb' }, thumb),
        el('div', { class: 'card-body' }, [
          el('div', { class: 'card-title' }, [
            el('span', { class: 'name' }, p.name),
            !p.templateValid ? el('span', { class: 'badge deleted' }, '样板失效') : null,
            p.deleted ? el('span', { class: 'badge deleted' }, '已删除') : null
          ]),
          el('div', { class: 'card-sub' }, [
            el('span', { class: 'scene' }, `${p.slots.length} 个插槽`),
            el('span', { class: 'tag', title: p.template?.name || '' }, p.template?.name || '')
          ]),
          el('div', { class: 'slot-summary' }, p.slots.map((s) => el('span', { class: 'tag' }, s.name))),
          el('div', { class: 'card-actions' }, actions)
        ])
      ])
    }

    // ---------- 编辑器 ----------
    function openEditor(p) {
      const isNew = !p
      const nameInput = el('input', { value: p?.name || '', maxlength: 50, placeholder: '例如：卧室基础搭配' })
      let templateId = p?.templateId || null
      let templateBrief = p?.template || null // { id, name, images, primary }

      // 样板选择（简化版库选择器：筛选 + 卡片单选）
      const tplBox = el('div', { class: 'tpl-box' })
      function renderTpl() {
        clear(tplBox)
        if (templateId) {
          tplBox.append(
            templateBrief?.primary
              ? el('img', { class: 'tpl-thumb', src: '/' + templateBrief.primary, alt: templateBrief.name })
              : el('div', { class: 'tpl-thumb noimg' }, '无图'),
            el('div', { class: 'tpl-meta' }, [
              el('strong', {}, templateBrief?.name || templateId),
              el('span', { class: 'muted' }, templateBrief?.primary ? '' : '（该样板暂无图片，出图前需上传）')
            ]),
            el('button', { type: 'button', onclick: openPicker }, '更换样板')
          )
        } else {
          tplBox.append(el('button', { type: 'button', onclick: openPicker }, '选择样板'))
        }
      }

      async function openPicker() {
        const state = { scene: '', q: '' }
        let meta = { scenes: [] }
        try {
          meta = await api.get('/api/scenes')
        } catch {
          /* 场景筛选不可用时仍可搜索 */
        }
        const sceneSel = el('select', {}, [
          el('option', { value: '' }, '全部场景'),
          ...(meta.scenes || []).map((s) => el('option', { value: s }, s))
        ])
        const search = el('input', { type: 'search', placeholder: '搜索样板名称/描述' })
        const pickGrid = el('div', { class: 'picker-grid' })

        async function load() {
          const params = new URLSearchParams({ limit: '200' })
          if (state.scene) params.set('scene', state.scene)
          if (state.q) params.set('q', state.q)
          try {
            const data = await api.get(`/api/templates?${params}`)
            clear(pickGrid)
            if (!data.items.length) {
              pickGrid.append(el('div', { class: 'empty' }, '没有符合条件的样板'))
              return
            }
            for (const t of data.items) {
              pickGrid.append(
                el(
                  'div',
                  {
                    class: `picker-cell ${t.id === templateId ? 'selected' : ''}`,
                    onclick: () => {
                      if (!t.images?.length) {
                        toast('该样板还没有图片，请先到「样板库」上传', { type: 'error' })
                        return
                      }
                      templateId = t.id
                      templateBrief = { id: t.id, name: t.name, primary: t.images[0].file }
                      renderTpl()
                      picker.close()
                    }
                  },
                  [
                    t.images?.[0] ? el('img', { src: '/' + t.images[0].file, loading: 'lazy' }) : el('div', { class: 'noimg' }, '无图'),
                    el('span', { class: 'picker-name' }, t.name),
                    el('span', { class: 'muted' }, t.scene)
                  ]
                )
              )
            }
          } catch (e) {
            clear(pickGrid)
            pickGrid.append(el('div', { class: 'empty' }, e.message))
          }
        }

        sceneSel.onchange = () => {
          state.scene = sceneSel.value
          load()
        }
        search.oninput = debounce(() => {
          state.q = search.value.trim()
          load()
        }, 250)

        const picker = modal({
          title: '选择样板',
          wide: true,
          okText: '关闭',
          body: el('div', {}, [el('div', { class: 'filter-bar' }, [sceneSel, search]), pickGrid]),
          onOk: () => true
        })
        await load()
      }

      // 插槽列表
      const slots = (p?.slots || []).map((s) => ({ name: s.name, tags: [...s.tags], positionNote: s.positionNote || '' }))
      const slotList = el('div', { class: 'slot-list' })
      const addBtn = el('button', { type: 'button' }, '添加插槽')
      addBtn.onclick = () => {
        if (slots.length >= 10) {
          toast('最多 10 个插槽', { type: 'error' })
          return
        }
        slots.push({ name: '', tags: [], positionNote: '' })
        renderSlots()
      }

      function swap(a, b) {
        const t = slots[a]
        slots[a] = slots[b]
        slots[b] = t
        renderSlots()
      }

      function renderSlots() {
        clear(slotList)
        slots.forEach((s, i) => {
          const nameI = el('input', { value: s.name, maxlength: 20, placeholder: `插槽名称（如：墙纸）` })
          nameI.oninput = () => {
            s.name = nameI.value
          }
          const tags = tagInput(s.tags, (v) => {
            s.tags = v
          }, { max: 10 })
          const posI = el('input', { value: s.positionNote, maxlength: 200, placeholder: '位置说明（如：卧室右侧墙面）' })
          posI.oninput = () => {
            s.positionNote = posI.value
          }
          slotList.append(
            el('div', { class: 'slot-row' }, [
              el('div', { class: 'slot-head' }, [
                el('span', { class: 'slot-idx' }, `#${i + 1}`),
                nameI,
                el('div', { class: 'slot-btns' }, [
                  el('button', { type: 'button', title: '上移', disabled: i === 0, onclick: () => swap(i, i - 1) }, '↑'),
                  el('button', { type: 'button', title: '下移', disabled: i === slots.length - 1, onclick: () => swap(i, i + 1) }, '↓'),
                  el('button', { type: 'button', class: 'danger-text', title: '删除插槽', onclick: () => { slots.splice(i, 1); renderSlots() } }, '✕')
                ])
              ]),
              el('div', { class: 'slot-line' }, [el('span', { class: 'muted' }, '标签：'), tags.el]),
              posI
            ])
          )
        })
        if (!slots.length) slotList.append(el('div', { class: 'muted' }, '还没有插槽，点下方「添加插槽」（1~10 个）'))
        addBtn.disabled = slots.length >= 10
      }

      renderTpl()
      renderSlots()

      modal({
        title: isNew ? '新建预设' : '编辑预设',
        wide: true,
        body: el('div', { class: 'form' }, [
          field('预设名称', nameInput),
          field('样板（场景底板）', tplBox),
          field('插槽列表', el('div', { class: 'slot-wrap' }, [slotList, addBtn]), { hint: '每个插槽对应一个素材位置；插槽标签用于自动填充与推荐' })
        ]),
        onOk: async () => {
          const name = nameInput.value.trim()
          if (!name) {
            toast('请填写预设名称', { type: 'error' })
            return false
          }
          if (!templateId) {
            toast('请先选择样板', { type: 'error' })
            return false
          }
          if (!slots.length) {
            toast('至少添加 1 个插槽', { type: 'error' })
            return false
          }
          const payload = {
            name,
            templateId,
            slots: slots.map((s, i) => ({
              name: (s.name || '').trim() || `插槽 ${i + 1}`,
              tags: s.tags,
              positionNote: (s.positionNote || '').trim()
            }))
          }
          if (isNew) {
            await api.post('/api/presets', payload)
            toast(`预设「${name}」已创建`, { type: 'success' })
          } else {
            await api.put(`/api/presets/${p.id}`, payload)
            toast('已保存', { type: 'success' })
          }
          await reload()
        }
      })
    }

    await reload()
  }
}
