/**
 * 图片头解析（PNG / JPEG / WEBP 宽高，只读头部字节）与出图尺寸比例映射。
 * 尺寸枚举与 ImageGen 工具支持列表保持一致（2026-09-30 实测）。
 */

export const SUPPORTED_SIZES = [
  '1024x1024',
  '1536x1024',
  '1024x1536',
  '768x1024',
  '1024x768',
  '1024x1280',
  '1280x1024',
  '1024x1792',
  '1792x1024',
  '2560x1080'
]

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 解析图片宽高 → { type, width, height }；无法识别返回 null */
export function imageDimensions(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null
  if (buf.subarray(0, 8).equals(PNG_SIG)) return pngSize(buf)
  if (buf[0] === 0xff && buf[1] === 0xd8) return jpegSize(buf)
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return webpSize(buf)
  }
  return null
}

function pngSize(buf) {
  if (buf.length < 24) return null
  if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  if (!width || !height) return null
  return { type: 'png', width, height }
}

function jpegSize(buf) {
  let pos = 2
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) return null
    let markerPos = pos
    while (markerPos + 1 < buf.length && buf[markerPos + 1] === 0xff) markerPos++
    const marker = buf[markerPos + 1]
    if (marker === undefined) return null
    pos = markerPos + 2
    // 无长度字段的标记
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    // 到扫描数据还没遇到 SOF，放弃
    if (marker === 0xd9 || marker === 0xda) return null
    if (pos + 2 > buf.length) return null
    const len = buf.readUInt16BE(pos)
    if (len < 2) return null
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    if (isSof) {
      if (pos + 7 > buf.length) return null
      const height = buf.readUInt16BE(pos + 3)
      const width = buf.readUInt16BE(pos + 5)
      if (!width || !height) return null
      return { type: 'jpeg', width, height }
    }
    pos += len
  }
  return null
}

function webpSize(buf) {
  if (buf.length < 25) return null
  const fourcc = buf.subarray(12, 16).toString('latin1')
  if (fourcc === 'VP8X') {
    if (buf.length < 30) return null
    const width = 1 + buf.readUIntLE(24, 3)
    const height = 1 + buf.readUIntLE(27, 3)
    return width && height ? { type: 'webp', width, height } : null
  }
  if (fourcc === 'VP8L') {
    if (buf[20] !== 0x2f) return null
    const bits = buf.readUInt32LE(21)
    const width = (bits & 0x3fff) + 1
    const height = ((bits >> 14) & 0x3fff) + 1
    return { type: 'webp', width, height }
  }
  if (fourcc === 'VP8 ') {
    if (buf.length < 30) return null
    // 帧头：3 字节 frame tag + 起始码 9d 01 2a + 宽(14bit) + 高(14bit)
    if (!(buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a)) return null
    const width = buf.readUInt16LE(26) & 0x3fff
    const height = buf.readUInt16LE(28) & 0x3fff
    return width && height ? { type: 'webp', width, height } : null
  }
  return null
}

/** 按宽高比选择最接近的支持尺寸；比值差相同取面积小者；异常输入回退 1024x1024 */
export function pickRenderSize(width, height) {
  const w = Number(width)
  const h = Number(height)
  const fallback = '1024x1024'
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return fallback
  const ratio = w / h
  let best = null
  for (const size of SUPPORTED_SIZES) {
    const [sw, sh] = size.split('x').map(Number)
    const diff = Math.abs(ratio - sw / sh)
    const area = sw * sh
    if (!best || diff < best.diff - 1e-9 || (Math.abs(diff - best.diff) <= 1e-9 && area < best.area)) {
      best = { size, diff, area }
    }
  }
  return best.size
}
