/** images.mjs 测试：PNG/JPEG/WEBP 宽高解析 + 出图尺寸比例映射。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SUPPORTED_SIZES, imageDimensions, pickRenderSize } from '../lib/images.mjs'
import { pngBuf } from './helpers.mjs'

/** 最小 JPEG：SOI + APP0 + SOF0 + EOI */
function jpegBuf(w, h) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 0x03])
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'latin1'),
    Buffer.alloc(9),
    sof,
    Buffer.alloc(9),
    Buffer.from([0xff, 0xd9])
  ])
}

function u32le(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0)
  return b
}

function webpFile(fourcc, data) {
  const chunk = Buffer.concat([Buffer.from(fourcc, 'latin1'), u32le(data.length), data])
  const body = Buffer.concat([Buffer.from('WEBP'), chunk])
  return Buffer.concat([Buffer.from('RIFF'), u32le(body.length), body])
}

/** VP8X 扩展格式 */
function webpVp8xBuf(w, h) {
  const data = Buffer.alloc(10)
  data.writeUIntLE(w - 1, 4, 3)
  data.writeUIntLE(h - 1, 7, 3)
  return webpFile('VP8X', data)
}

/** VP8L 无损格式 */
function webpVp8lBuf(w, h) {
  const data = Buffer.alloc(5)
  data[0] = 0x2f
  data.writeUInt32LE(((w - 1) | ((h - 1) << 14)) >>> 0, 1)
  return webpFile('VP8L', data)
}

/** VP8 有损格式 */
function webpVp8Buf(w, h) {
  const data = Buffer.alloc(10)
  data[3] = 0x9d
  data[4] = 0x01
  data[5] = 0x2a
  data.writeUInt16LE(w & 0x3fff, 6)
  data.writeUInt16LE(h & 0x3fff, 8)
  return webpFile('VP8 ', data)
}

test('imageDimensions：PNG / JPEG / WEBP 三形态', () => {
  assert.deepEqual(imageDimensions(pngBuf(320, 200)), { type: 'png', width: 320, height: 200 })
  assert.deepEqual(imageDimensions(jpegBuf(640, 480)), { type: 'jpeg', width: 640, height: 480 })
  assert.deepEqual(imageDimensions(webpVp8xBuf(1024, 768)), { type: 'webp', width: 1024, height: 768 })
  assert.deepEqual(imageDimensions(webpVp8lBuf(500, 800)), { type: 'webp', width: 500, height: 800 })
  assert.deepEqual(imageDimensions(webpVp8Buf(300, 400)), { type: 'webp', width: 300, height: 400 })
})

test('imageDimensions：非法 / 截断输入返回 null', () => {
  assert.equal(imageDimensions(Buffer.alloc(0)), null)
  assert.equal(imageDimensions(Buffer.from('not an image at all, just text')), null)
  assert.equal(imageDimensions(Buffer.from([0xff, 0xd8, 0xff])), null)
  assert.equal(imageDimensions(pngBuf(8, 8).subarray(0, 20)), null)
  assert.equal(imageDimensions(null), null)
})

test('pickRenderSize：逐档比例映射', () => {
  const cases = [
    [1000, 1000, '1024x1024'],
    [8192, 8192, '1024x1024'],
    [1500, 1000, '1536x1024'],
    [1600, 1200, '1024x768'],
    [1920, 1080, '1792x1024'],
    [2560, 1080, '2560x1080'],
    [900, 1600, '1024x1792'],
    [750, 1000, '768x1024'],
    [800, 1200, '1024x1536'],
    [800, 1000, '1024x1280'],
    [1280, 1024, '1280x1024']
  ]
  for (const [w, h, expected] of cases) {
    assert.equal(pickRenderSize(w, h), expected, `${w}x${h} 应映射为 ${expected}`)
  }
})

test('pickRenderSize：异常输入回退 1024x1024', () => {
  assert.equal(pickRenderSize(0, 100), '1024x1024')
  assert.equal(pickRenderSize(100, 0), '1024x1024')
  assert.equal(pickRenderSize(NaN, 100), '1024x1024')
  assert.equal(pickRenderSize(undefined, undefined), '1024x1024')
  assert.equal(pickRenderSize(-5, -5), '1024x1024')
})

test('SUPPORTED_SIZES：与 ImageGen 枚举一致', () => {
  assert.equal(SUPPORTED_SIZES.length, 10)
  for (const s of SUPPORTED_SIZES) assert.match(s, /^\d+x\d+$/)
})
