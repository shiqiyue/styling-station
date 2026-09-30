/** DOM 小工具：元素创建、弹窗、toast、chips 标签输入、图片上传区。 */

import { api } from './api.js'

/** 创建元素：el('div', { class, text, onclick, value, ... }, [子节点…]) */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null) continue
    if (k === 'class') node.className = v
    else if (k === 'text') node.textContent = v
    else if (k === 'value') node.value = v
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v)
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v)
    else if (k === 'dataset') Object.assign(node.dataset, v)
    else if (typeof v === 'boolean' && k in node) node[k] = v
    else node.setAttribute(k, v)
  }
  appendChildren(node, children)
  return node
}

function appendChildren(node, children) {
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) continue
    if (Array.isArray(child)) appendChildren(node, child)
    else node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
}

export function clear(node) {
  node.textContent = ''
  return node
}

/** 轻提示 */
export function toast(msg, { type = 'info', ms = 3000 } = {}) {
  const root = document.getElementById('toast-root')
  const node = el('div', { class: `toast ${type}` }, msg)
  root.append(node)
  setTimeout(() => node.classList.add('out'), Math.max(0, ms - 300))
  setTimeout(() => node.remove(), ms)
}

/**
 * 弹窗：{ title, body, okText, cancelText, onOk, onCancel, wide }
 * onOk 返回 false 或抛错时保持弹窗打开。
 */
export function modal({ title, body, okText = '保存', cancelText = '取消', onOk, onCancel, wide = false } = {}) {
  const overlay = el('div', { class: 'overlay' })
  const dialog = el('div', { class: `dialog ${wide ? 'wide' : ''}` })
  const bodyWrap = el('div', { class: 'dialog-body' })
  if (body instanceof Node) bodyWrap.append(body)
  else if (typeof body === 'string') bodyWrap.append(el('div', {}, body))

  const okBtn = el('button', { class: 'primary', text: okText })
  const cancelBtn = el('button', { text: cancelText })
  dialog.append(el('div', { class: 'dialog-head' }, title), bodyWrap, el('div', { class: 'dialog-foot' }, [cancelBtn, okBtn]))
  overlay.append(dialog)

  function close() {
    overlay.remove()
    document.removeEventListener('keydown', onKey)
  }
  function onKey(e) {
    if (e.key === 'Escape') {
      onCancel?.()
      close()
    }
  }
  cancelBtn.onclick = () => {
    onCancel?.()
    close()
  }
  okBtn.onclick = async () => {
    if (!onOk) return close()
    okBtn.disabled = true
    try {
      const r = await onOk()
      if (r === false) {
        okBtn.disabled = false
        return
      }
      close()
    } catch (e) {
      okBtn.disabled = false
      toast(e?.message || String(e), { type: 'error' })
    }
  }
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      onCancel?.()
      close()
    }
  })
  document.addEventListener('keydown', onKey)
  document.body.append(overlay)
  okBtn.focus()
  return { overlay, dialog, close, okBtn }
}

/** 确认对话框 → Promise<boolean> */
export function confirmDialog(msg, { okText = '删除', danger = true } = {}) {
  return new Promise((resolve) => {
    let answered = false
    const m = modal({
      title: '请确认',
      body: msg,
      okText,
      onOk: () => {
        answered = true
        resolve(true)
      },
      onCancel: () => {
        if (!answered) resolve(false)
      }
    })
    if (danger) m.okBtn.classList.add('danger')
  })
}

/** 表单字段：field('名称', 控件) */
export function field(label, control, { hint } = {}) {
  return el('label', { class: 'field' }, [
    el('span', { class: 'field-label' }, label),
    control,
    hint ? el('span', { class: 'field-hint' }, hint) : null
  ])
}

/** 简易防抖 */
export function debounce(fn, ms = 250) {
  let timer
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}

/** chips 标签输入：tagInput(value, onChange) → { el, get, set } */
export function tagInput(value = [], onChange, { max = 20, maxLen = 20 } = {}) {
  const list = [...value]
  const chips = el('div', { class: 'chips mini' })
  const input = el('input', { class: 'tag-input', placeholder: '输入标签后回车' })
  const wrap = el('div', { class: 'tag-input-wrap' }, [chips, input])

  function render() {
    clear(chips)
    for (const t of list) {
      chips.append(
        el('span', { class: 'chip on' }, [
          t,
          el(
            'button',
            {
              class: 'chip-x',
              type: 'button',
              onclick: () => {
                const i = list.indexOf(t)
                if (i >= 0) list.splice(i, 1)
                render()
                onChange?.([...list])
              }
            },
            '×'
          )
        ])
      )
    }
  }
  function add() {
    const raw = input.value
    input.value = ''
    for (const piece of raw.split(/[,，、]/)) {
      const t = piece.trim()
      if (!t) continue
      if (t.length > maxLen) {
        toast(`单个标签不超过 ${maxLen} 字符`, { type: 'error' })
        continue
      }
      if (list.includes(t)) continue
      if (list.length >= max) {
        toast(`最多 ${max} 个标签`, { type: 'error' })
        break
      }
      list.push(t)
    }
    render()
    onChange?.([...list])
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      add()
    } else if (e.key === 'Backspace' && !input.value && list.length) {
      list.pop()
      render()
      onChange?.([...list])
    }
  })
  input.addEventListener('blur', () => {
    if (input.value.trim()) add()
  })
  render()
  return {
    el: wrap,
    get: () => [...list],
    set: (v) => {
      list.splice(0, list.length, ...(v || []))
      render()
    }
  }
}

/**
 * 图片上传区：多图、主图标记（第一张）、拖拽、删除。
 * - 提供 uploadPath：上传立即生效（编辑模式），onDelete(index) 返回删除后的 images 数组
 * - 不提供 uploadPath：文件暂存本地（新建模式），调用方用 getPending() 在保存后上传
 */
export function imageUploader({ images = [], pending = [], uploadPath, onDelete, onChange, hint } = {}) {
  const grid = el('div', { class: 'upload-grid' })
  const zone = el('div', { class: 'drop-zone' }, hint || '点击或拖拽图片到这里（支持多张，JPG / PNG / WEBP，单张 ≤10MB）')
  const fileInput = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, style: { display: 'none' } })
  const wrap = el('div', { class: 'uploader' }, [grid, zone, fileInput])

  function renderGrid() {
    clear(grid)
    ;(images || []).forEach((img, i) => {
      grid.append(
        el('div', { class: 'thumb' }, [
          el('img', { src: '/' + img.file, loading: 'lazy', alt: `图 ${i + 1}` }),
          i === 0 ? el('span', { class: 'badge primary-badge' }, '主图') : null,
          el(
            'button',
            {
              class: 'thumb-del',
              type: 'button',
              title: '删除这张图',
              onclick: async () => {
                if (!(await confirmDialog('删除这张图片？', { okText: '删除' }))) return
                try {
                  const next = await onDelete?.(i)
                  if (Array.isArray(next)) {
                    images.splice(0, images.length, ...next)
                    renderGrid()
                  }
                  onChange?.()
                } catch (e) {
                  toast(e.message, { type: 'error' })
                }
              }
            },
            '×'
          )
        ])
      )
    })
    for (const f of pending) {
      const url = URL.createObjectURL(f)
      grid.append(
        el('div', { class: 'thumb pending' }, [
          el('img', { src: url, alt: f.name, onload: () => URL.revokeObjectURL(url) }),
          el(
            'button',
            {
              class: 'thumb-del',
              type: 'button',
              onclick: () => {
                const i = pending.indexOf(f)
                if (i >= 0) pending.splice(i, 1)
                renderGrid()
                onChange?.()
              }
            },
            '×'
          )
        ])
      )
    }
    if (!(images || []).length && !pending.length) {
      grid.append(el('div', { class: 'upload-empty muted' }, '暂无图片'))
    }
  }

  async function handleFiles(fileList) {
    const files = [...fileList].filter((f) => f.type.startsWith('image/'))
    if (!files.length) {
      toast('请选择图片文件（JPG / PNG / WEBP）', { type: 'error' })
      return
    }
    if (uploadPath) {
      for (const f of files) {
        if (f.size > 10 * 1024 * 1024) {
          toast(`${f.name}：超过 10MB，已跳过`, { type: 'error' })
          continue
        }
        try {
          const doc = await api.upload(uploadPath, f)
          images.splice(0, images.length, ...(doc.images || []))
          renderGrid()
          toast(`已上传 ${f.name}`, { type: 'success' })
        } catch (e) {
          toast(`${f.name}：${e.message}`, { type: 'error' })
        }
      }
      onChange?.()
    } else {
      for (const f of files) {
        if (f.size > 10 * 1024 * 1024) {
          toast(`${f.name}：超过 10MB，已跳过`, { type: 'error' })
          continue
        }
        pending.push(f)
      }
      renderGrid()
      onChange?.()
    }
  }

  zone.addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', () => {
    handleFiles(fileInput.files)
    fileInput.value = ''
  })
  zone.addEventListener('dragover', (e) => {
    e.preventDefault()
    zone.classList.add('over')
  })
  zone.addEventListener('dragleave', () => zone.classList.remove('over'))
  zone.addEventListener('drop', (e) => {
    e.preventDefault()
    zone.classList.remove('over')
    handleFiles(e.dataTransfer.files)
  })

  renderGrid()
  return { el: wrap, getPending: () => pending, refresh: renderGrid }
}
