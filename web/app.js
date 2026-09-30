/** 前端入口：hash 路由（#/materials|templates|presets|studio|renders）+ 顶部 Tab。 */

import { el } from './lib/dom.js'
import { materialsView } from './views/materials.js'
import { templatesView } from './views/templates.js'
import { presetsView } from './views/presets.js'
import { studioView } from './views/studio.js'

const views = new Map()
export function registerView(name, view) {
  views.set(name, view)
}

const TABS = [
  { name: 'materials', label: '素材库' },
  { name: 'templates', label: '样板库' },
  { name: 'presets', label: '预设' },
  { name: 'studio', label: '搭配台' },
  { name: 'renders', label: '记录' }
]

registerView('materials', materialsView)
registerView('templates', templatesView)
registerView('presets', presetsView)
registerView('studio', studioView)

const tabsEl = document.getElementById('tabs')
const viewEl = document.getElementById('view')

function renderTabs(active) {
  tabsEl.textContent = ''
  for (const t of TABS) {
    const enabled = views.has(t.name)
    const cls = `tab ${active === t.name ? 'active' : ''} ${enabled ? '' : 'disabled'}`
    tabsEl.append(
      enabled ? el('a', { class: cls, href: `#/${t.name}` }, t.label) : el('span', { class: cls, title: '即将开放' }, t.label)
    )
  }
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '')
  return raw.split('/')[0] || 'materials'
}

async function route() {
  const name = parseHash()
  const view = views.get(name)
  if (!view) {
    location.hash = '#/materials'
    return
  }
  renderTabs(name)
  viewEl.textContent = ''
  try {
    await view.render(viewEl)
  } catch (e) {
    viewEl.append(el('div', { class: 'empty' }, `页面加载失败：${e?.message || e}`))
  }
}

window.addEventListener('hashchange', route)
route()
