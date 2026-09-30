/** API 封装：JSON 请求 + 上传 + 出图 SSE。 */

async function toError(res) {
  let msg = `请求失败（${res.status}）`
  try {
    const data = await res.json()
    if (data?.error?.message) msg = data.error.message
  } catch {
    /* 非 JSON 响应 */
  }
  const err = new Error(msg)
  err.status = res.status
  return err
}

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  if (!res.ok) throw await toError(res)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  put: (path, body = {}) => request('PUT', path, body),
  del: (path) => request('DELETE', path),
  /** 上传单张图片（multipart，字段 file） */
  async upload(path, file) {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(path, { method: 'POST', body: fd })
    if (!res.ok) throw await toError(res)
    return res.json()
  }
}

/** 订阅出图 SSE：onEvent({event,data})；done 后自动关闭；返回 {close} */
export function streamRender(renderId, { onEvent } = {}) {
  const es = new EventSource(`/api/renders/${renderId}/stream`)
  for (const name of ['snapshot', 'delta', 'status', 'result', 'error', 'done']) {
    es.addEventListener(name, (e) => {
      let data = null
      try {
        data = e.data ? JSON.parse(e.data) : null
      } catch {
        /* 忽略坏帧 */
      }
      try {
        onEvent?.({ event: name, data })
      } catch (err) {
        console.error('[stream] onEvent 异常：', err)
      }
      if (name === 'done') es.close()
    })
  }
  es.onerror = () => {
    /* 网络抖动：EventSource 自动重连；服务端快照会全量回放 */
  }
  return { close: () => es.close() }
}
