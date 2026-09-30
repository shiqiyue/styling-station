/**
 * 零依赖 multipart/form-data 解析 + 图片校验。
 * - 请求体整体收集（上限 maxBytes，默认 12MB），再按 boundary 切分；
 *   二进制安全：以「\r\n--boundary」锚定分隔，不做任何文本转码。
 * - 文件名不使用客户端值（调用方落盘时自行重写为 <n>.<ext>）；此处仅回传供参考。
 */

import { HttpError } from './http.mjs'
import { imageDimensions } from './images.mjs'

/** 解析 multipart 请求，返回目标字段的文件 → { filename, contentType, data } */
export async function parseMultipart(req, { maxBytes = 12 * 1024 * 1024, field = 'file' } = {}) {
  const contentType = String(req.headers?.['content-type'] || '')
  const m = /^multipart\/form-data\s*;.*boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  if (!m) throw new HttpError(400, 'INVALID_UPLOAD', '请求须为 multipart/form-data 且带 boundary')
  const boundary = (m[1] || m[2] || '').trim()
  if (!boundary) throw new HttpError(400, 'INVALID_UPLOAD', 'multipart 缺少 boundary')

  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new HttpError(400, 'FILE_TOO_LARGE', '文件过大')
    chunks.push(chunk)
  }
  return extractFile(Buffer.concat(chunks), boundary, field)
}

function extractFile(body, boundary, field) {
  const bStart = Buffer.from(`--${boundary}`)
  const bSep = Buffer.from(`\r\n--${boundary}`)
  let pos = body.indexOf(bStart)
  if (pos < 0) throw new HttpError(400, 'INVALID_UPLOAD', '请求体缺少 boundary 分隔')
  pos += bStart.length
  while (pos < body.length) {
    // 结束标记 "--"
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2
    const headerEnd = body.indexOf('\r\n\r\n', pos)
    if (headerEnd < 0) throw new HttpError(400, 'INVALID_UPLOAD', 'multipart 头部不完整')
    const headerText = body.subarray(pos, headerEnd).toString('utf8')
    const dataStart = headerEnd + 4
    const next = body.indexOf(bSep, dataStart)
    if (next < 0) throw new HttpError(400, 'INVALID_UPLOAD', 'multipart 数据不完整')
    const nameMatch = /name="([^"]*)"/i.exec(headerText)
    const fileMatch = /filename="([^"]*)"/i.exec(headerText)
    if (nameMatch && nameMatch[1] === field && fileMatch) {
      const ctMatch = /content-type:\s*([^\r\n;]+)/i.exec(headerText)
      return {
        filename: fileMatch[1],
        contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
        data: body.subarray(dataStart, next)
      }
    }
    pos = next + bSep.length
  }
  throw new HttpError(400, 'INVALID_UPLOAD', `未找到字段 ${field} 的文件`)
}

/** 校验图片数据：magic 识别（返回真实类型）+ 尺寸解析。不合法抛 400。 */
export function validateImage(buf, { maxBytes = 10 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new HttpError(400, 'INVALID_IMAGE', '图片数据为空')
  if (buf.length > maxBytes) throw new HttpError(400, 'FILE_TOO_LARGE', '文件过大')
  const dim = imageDimensions(buf)
  if (!dim) throw new HttpError(400, 'INVALID_IMAGE', '仅支持 JPG / PNG / WEBP 图片')
  return dim
}
