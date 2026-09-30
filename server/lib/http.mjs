/**
 * HTTP 小工具：统一 JSON 响应、请求体解析、统一错误形态。
 * 错误契约：{ error: { code, message } }（message 为中文）。
 */

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function json(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

export function sendError(res, err) {
  if (err instanceof HttpError) {
    json(res, err.status, { error: { code: err.code, message: err.message } })
    return
  }
  console.error('[server] 未处理异常：', err)
  json(res, 500, { error: { code: 'INTERNAL', message: `服务器内部错误：${err?.message || err}` } })
}

export async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new HttpError(413, 'BODY_TOO_LARGE', '请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new HttpError(400, 'BAD_JSON', '请求体不是合法 JSON')
  }
}
