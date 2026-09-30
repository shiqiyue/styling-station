/**
 * 出图通道：火山方舟 Seedream「图生图 / 图片编辑」（直接调 API 合成，不走 CLI）。
 *
 * 与 renderer.runRender 返回同一契约（jobs 无感切换）：
 *   { ok, images, sessionId, elapsedMs, exitCode, stderrTail, timedOut, resultText, error? }
 *
 * 请求（2026-09-30 设计；字段名取自第三方镜像文档，联调时以官方文档为准）：
 *   POST {settings.arkBaseUrl}/images/generations
 *   Authorization: Bearer {settings.arkApiKey}
 *   { model, prompt, image: [dataUrl, ...], size, response_format: 'b64_json', watermark: false }
 *   image 数组顺序 = 图1 样板 → 图2..N 素材（与 buildEditInstruction 的编号一致）。
 * 待联调确认：image 多图字段的精确形状、size 精确像素的接受范围、模型 ID 写法。
 *
 * - 候选逐张串行（每次请求产出一张）；整体超时 settings.renderTimeoutMs 触发 abort。
 * - registerAbort 登记「立即中止」函数（jobs.stop 调用）；中止/超时保留已出候选。
 * - 产物写 <workDir>/ark_images/ark-<n>.png（非 PNG 数据自动改 .jpg 后缀）。
 * - 所有对外错误信息脱敏：绝不包含 arkApiKey。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

const STDERR_TAIL_MAX = 2000
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const EXT_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff'
}

function mimeOf(file) {
  return EXT_MIME[extname(file).toLowerCase()] || 'image/png'
}

/** 脱敏：错误信息中不得出现 API Key */
function scrub(text, key) {
  const t = String(text ?? '')
  return key ? t.split(key).join('***') : t
}

/**
 * @param {object} args
 * @param {object} args.settings settings.json（arkBaseUrl / arkApiKey / arkModel / renderTimeoutMs）
 * @param {string} args.workDir 本次出图的独立工作目录（产物落 ark_images/）
 * @param {string[]} [args.attachments] 附件绝对路径列表（图1 样板 + 图2..N 素材）
 * @param {string} args.editInstruction 直投图像模型的指令（buildEditInstruction）
 * @param {string} [args.size] 尺寸（如 '1024x1024'，透传）
 * @param {number} [args.candidateCount] 候选张数（逐张串行请求）
 * @param {(ev:{event:string,data:object})=>void} [args.onEvent] 增量事件转发（SSE 用）
 * @param {(fn:()=>void)=>void} [args.registerAbort] 中止函数登记（供外部停止）
 * @returns {Promise<{ok:boolean, images:string[], sessionId:string|null, elapsedMs:number,
 *   exitCode:number|null, stderrTail:string, timedOut:boolean, resultText:string, error?:string}>}
 */
export function runImageEdit({
  settings = {},
  workDir,
  attachments = [],
  editInstruction = '',
  size = '',
  candidateCount = 1,
  onEvent,
  registerAbort
} = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    const base = {
      ok: false,
      images: [],
      sessionId: null,
      elapsedMs: 0,
      exitCode: null,
      stderrTail: '',
      timedOut: false,
      resultText: ''
    }

    const apiKey = String(settings.arkApiKey || '').trim()
    const model = String(settings.arkModel || '').trim()
    const baseUrl = String(settings.arkBaseUrl || '').trim().replace(/\/+$/, '')
    const safe = (msg) => scrub(msg, apiKey)

    if (!apiKey || !model) {
      resolve({ ...base, error: '未配置方舟图生图：请在 server/data/settings.json 填写 arkApiKey 与 arkModel 后重启服务' })
      return
    }
    if (!baseUrl) {
      resolve({ ...base, error: '未配置 arkBaseUrl（settings.json）' })
      return
    }
    if (!attachments.length) {
      resolve({ ...base, error: '没有可用的参考图（样板/素材缺图）' })
      return
    }

    const timeoutMs = Math.max(50, Number(settings.renderTimeoutMs) || 300000)
    const deadline = started + timeoutMs
    const wanted = Math.max(1, Math.min(10, Number(candidateCount) || 1))

    const images = []
    const stderrLines = []
    let aborted = false
    let timedOut = false
    let currentAbort = null
    let killTimer = null

    const emitSystem = (text) => onEvent?.({ event: 'delta', data: { channel: 'system', text } })
    const finish = (patch) =>
      resolve({
        ...base,
        images,
        elapsedMs: Date.now() - started,
        stderrTail: stderrLines.join('\n').slice(-STDERR_TAIL_MAX),
        ...patch
      })

    const armTimeout = () => {
      clearTimeout(killTimer)
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        timedOut = true
        try {
          currentAbort?.abort()
        } catch {
          /* 忽略 */
        }
        return
      }
      killTimer = setTimeout(() => {
        timedOut = true
        try {
          currentAbort?.abort()
        } catch {
          /* 忽略 */
        }
      }, remaining)
    }

    registerAbort?.(() => {
      aborted = true
      try {
        currentAbort?.abort()
      } catch {
        /* 忽略 */
      }
    })

    ;(async () => {
      try {
        mkdirSync(join(workDir, 'ark_images'), { recursive: true })
        const dataUrls = attachments.map((f) => {
          if (!existsSync(f)) throw new Error(`附件不存在：${f}`)
          const buf = readFileSync(f)
          return `data:${mimeOf(f)};base64,${buf.toString('base64')}`
        })
        emitSystem(`图生图通道：方舟 ${model}（尺寸 ${size || '默认'}，共 ${wanted} 张候选）`)

        for (let n = 1; n <= wanted; n++) {
          if (aborted || timedOut) break
          const prompt =
            wanted > 1
              ? `${editInstruction}\n（这是第 ${n}/${wanted} 张候选：可与其余候选在取景、光影氛围上有轻微差异；素材外观与摆放必须严格一致。）`
              : editInstruction
          emitSystem(`候选 ${n}/${wanted}：生成中…`)
          currentAbort = new AbortController()
          armTimeout()

          const res = await fetch(`${baseUrl}/images/generations`, {
            method: 'POST',
            headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              model,
              prompt,
              image: dataUrls,
              size: size || undefined,
              response_format: 'b64_json',
              watermark: false
            }),
            signal: currentAbort.signal
          })
          if (!res.ok) {
            const text = await res.text().catch(() => '')
            throw new Error(safe(`方舟接口错误（HTTP ${res.status}）：${text.slice(0, 300) || '无响应体'}`))
          }
          const text = await res.text()
          let payload = null
          try {
            payload = JSON.parse(text)
          } catch {
            throw new Error(safe(`方舟响应解析失败：${text.slice(0, 300)}`))
          }
          const item = payload?.data?.[0]
          if (!item) throw new Error(safe(`方舟响应缺少 data[0]：${JSON.stringify(payload).slice(0, 300)}`))

          let bytes = null
          if (item.b64_json) {
            const raw = String(item.b64_json)
            bytes = Buffer.from(raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw, 'base64')
          } else if (item.url) {
            armTimeout()
            const r2 = await fetch(String(item.url), { signal: currentAbort.signal })
            if (!r2.ok) throw new Error(`下载方舟结果失败（HTTP ${r2.status}）`)
            bytes = Buffer.from(await r2.arrayBuffer())
          }
          if (!bytes || !bytes.length) throw new Error('方舟未返回图片数据（b64_json/url 均缺失）')

          const file = join(workDir, 'ark_images', bytes.subarray(0, 8).equals(PNG_SIG) ? `ark-${n}.png` : `ark-${n}.jpg`)
          writeFileSync(file, bytes)
          images.push(file)
          emitSystem(`候选 ${n}/${wanted}：完成`)
        }

        clearTimeout(killTimer)
        const ok = !aborted && !timedOut && images.length > 0
        if (ok) emitSystem(`图生图完成：共 ${images.length} 张`)
        const patch = { ok, timedOut, exitCode: ok ? 0 : 1 }
        if (images.length) patch.resultText = images.join('\n')
        if (!ok && aborted) patch.error = '已停止'
        else if (!ok && timedOut) patch.error = safe(`出图超时（${timeoutMs}ms）`)
        else if (!ok) patch.error = '未产出图片'
        finish(patch)
      } catch (e) {
        clearTimeout(killTimer)
        if (aborted) {
          finish({ error: '已停止', timedOut: false })
          return
        }
        if (timedOut) {
          finish({ timedOut: true, error: safe(`出图超时（${timeoutMs}ms）`) })
          return
        }
        const msg = safe(e?.message || String(e))
        stderrLines.push(msg)
        finish({ error: msg })
      }
    })()
  })
}
