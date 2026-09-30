/** 测试助手：临时数据目录起真实服务（端口 0），并造最小可解析图片。 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

import { createServer } from '../server.mjs'
import { DEFAULT_SETTINGS } from '../settings.mjs'

export async function startTestServer({ settingsPatch = {} } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'styling-test-'))
  const settings = { ...DEFAULT_SETTINGS, ...settingsPatch }
  const srv = createServer({ dataDir, settings })
  const port = await srv.listen(0)
  return {
    base: `http://127.0.0.1:${port}`,
    dataDir,
    srv,
    close: async () => {
      await srv.close()
      rmSync(dataDir, { recursive: true, force: true })
    }
  }
}

/** 生成一张 w×h 的最小合法 PNG（纯色，便于浏览器/解析器识别）。 */
export function pngBuf(w = 8, h = 8) {
  const raw = Buffer.alloc((w * 3 + 1) * h, 0)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0 // filter: none
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3
      raw[o] = 200
      raw[o + 1] = 200
      raw[o + 2] = 210
    }
  }
  const crc32 = (buf) => {
    let c = ~0
    for (const b of buf) {
      c ^= b
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
    return ~c >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const typeBuf = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
    return Buffer.concat([len, typeBuf, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** 造 multipart/form-data 请求体。 */
export function multipartBody(boundary, field, filename, contentType, data) {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ])
}

/** 便捷 JSON 请求 */
export async function req(base, method, path, body, extraHeaders = {}) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? extraHeaders : { 'Content-Type': 'application/json', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await r.text()
  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { status: r.status, data }
}
