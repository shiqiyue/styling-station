/** upload.mjs 测试：multipart 解析（含二进制/多字段/超限）与图片 magic 校验。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { parseMultipart, validateImage } from '../lib/upload.mjs'
import { HttpError } from '../lib/http.mjs'
import { multipartBody, pngBuf } from './helpers.mjs'

/** duck-type 的请求流：Readable + headers */
function fakeReq(body, contentType) {
  return Object.assign(Readable.from([body]), { headers: { 'content-type': contentType } })
}

function mpCt(boundary) {
  return `multipart/form-data; boundary=${boundary}`
}

function part(boundary, headers, data) {
  return Buffer.concat([Buffer.from(`--${boundary}\r\n${headers}\r\n\r\n`), data, Buffer.from('\r\n')])
}

function throws400(fn, msgPart = '') {
  return assert.rejects(fn, (e) => {
    assert.ok(e instanceof HttpError, `期望 HttpError，实际得到：${e}`)
    assert.equal(e.status, 400)
    assert.ok(e.message.includes(msgPart), `消息应包含「${msgPart}」，实际为「${e.message}」`)
    return true
  })
}

function jpegBuf(w, h) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'latin1'),
    Buffer.alloc(9),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 0x03]),
    Buffer.alloc(9),
    Buffer.from([0xff, 0xd9])
  ])
}

test('parseMultipart：正常解析单文件', async () => {
  const b = 'XBOUNDARYX'
  const png = pngBuf(8, 8)
  const body = multipartBody(b, 'file', 'a.png', 'image/png', png)
  const got = await parseMultipart(fakeReq(body, mpCt(b)), { field: 'file' })
  assert.equal(got.filename, 'a.png')
  assert.equal(got.contentType, 'image/png')
  assert.ok(got.data.equals(png))
})

test('parseMultipart：多个字段时取目标字段', async () => {
  const b = 'XBND'
  const png = pngBuf(4, 4)
  const body = Buffer.concat([
    part(b, 'Content-Disposition: form-data; name="note"\r\nContent-Type: text/plain', Buffer.from('hello')),
    part(b, 'Content-Disposition: form-data; name="file"; filename="x.png"\r\nContent-Type: image/png', png),
    part(b, 'Content-Disposition: form-data; name="other"; filename="y.txt"\r\nContent-Type: text/plain', Buffer.from('no')),
    Buffer.from(`--${b}--\r\n`)
  ])
  const got = await parseMultipart(fakeReq(body, mpCt(b)), { field: 'file' })
  assert.equal(got.filename, 'x.png')
  assert.ok(got.data.equals(png))
})

test('parseMultipart：二进制内容含 CRLF 不截断', async () => {
  const b = 'ZZB'
  const payload = Buffer.concat([Buffer.from('\r\n\r\n--'), pngBuf(4, 4), Buffer.from('\r\n--notaBoundary\r\n')])
  const body = multipartBody(b, 'file', 'b.png', 'image/png', payload)
  const got = await parseMultipart(fakeReq(body, mpCt(b)), { field: 'file' })
  assert.ok(got.data.equals(payload))
})

test('parseMultipart：超限 / 非 multipart / 缺 boundary / 缺字段', async () => {
  const b = 'B1'
  const body = multipartBody(b, 'file', 'a.png', 'image/png', pngBuf(300, 300))
  await throws400(() => parseMultipart(fakeReq(body, mpCt(b)), { maxBytes: body.length - 1 }), '过大')
  await throws400(() => parseMultipart(fakeReq(Buffer.from('{}'), 'application/json'), {}), 'multipart')
  await throws400(() => parseMultipart(fakeReq(body, 'multipart/form-data'), {}), 'boundary')
  await throws400(() => parseMultipart(fakeReq(Buffer.from('not multipart body'), mpCt(b)), {}), '分隔')
  const onlyText = Buffer.concat([
    part(b, 'Content-Disposition: form-data; name="note"\r\nContent-Type: text/plain', Buffer.from('hi')),
    Buffer.from(`--${b}--\r\n`)
  ])
  await throws400(() => parseMultipart(fakeReq(onlyText, mpCt(b)), { field: 'file' }), '未找到')
})

test('validateImage：三形态识别 / 伪扩展名 / 非法数据', () => {
  assert.deepEqual(validateImage(pngBuf(320, 200)), { type: 'png', width: 320, height: 200 })
  // 伪扩展名：文件名 .png 但内容是 JPEG → 给出真实类型
  assert.deepEqual(validateImage(jpegBuf(64, 32)), { type: 'jpeg', width: 64, height: 32 })
  assert.throws(() => validateImage(Buffer.alloc(0)), /为空/)
  assert.throws(() => validateImage(Buffer.from('definitely not an image')), /仅支持/)
  assert.throws(() => validateImage(Buffer.concat([pngBuf(8, 8), Buffer.alloc(2048)]), { maxBytes: 100 }), /过大/)
})
