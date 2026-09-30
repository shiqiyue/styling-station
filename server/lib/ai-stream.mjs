/**
 * qodercli --output-format=stream-json 行 → 结构化事件。
 * 事件实测形态（2026-09-29）：
 *   system/init（含 session_id）｜ assistant（content[]: thinking/text/tool_use）｜ user（tool_result）｜ result
 * 其余（hook_*、artifacts_update 等）按未知跳过，保持向前兼容。
 */

import { StringDecoder } from 'node:string_decoder'

const TOOL_TEXT_MAX = 2000

function safeJson(v) {
  try {
    const s = JSON.stringify(v ?? {})
    return s.length > TOOL_TEXT_MAX ? s.slice(0, TOOL_TEXT_MAX) + '…' : s
  } catch {
    return String(v ?? '')
  }
}

function safeText(v) {
  const s = typeof v === 'string' ? v : safeJson(v)
  return s.length > TOOL_TEXT_MAX ? s.slice(0, TOOL_TEXT_MAX) + '…' : s
}

export function createStreamParser({ onEvent } = {}) {
  let buf = ''
  const decoder = new StringDecoder('utf8')

  const emitLine = (line) => {
    const s = line.trim()
    if (!s) return
    let j
    try {
      j = JSON.parse(s)
    } catch {
      onEvent?.({ type: 'raw', text: line })
      return
    }
    if (j.type === 'system') {
      if (j.subtype === 'init' && j.session_id) onEvent?.({ type: 'session', sessionId: j.session_id })
      return
    }
    if (j.type === 'assistant') {
      for (const b of Array.isArray(j.message?.content) ? j.message.content : []) {
        if (b?.type === 'text' && b.text) onEvent?.({ type: 'block', channel: 'answer', text: b.text })
        else if (b?.type === 'thinking' && b.thinking) onEvent?.({ type: 'block', channel: 'thinking', text: b.thinking })
        else if (b?.type === 'tool_use') onEvent?.({ type: 'block', channel: 'tool', text: `${b.name || '?'} ${safeJson(b.input)}` })
      }
      return
    }
    if (j.type === 'user') {
      for (const b of Array.isArray(j.message?.content) ? j.message.content : []) {
        if (b?.type === 'tool_result') onEvent?.({ type: 'block', channel: 'tool', text: safeText(b.content) })
      }
      return
    }
    if (j.type === 'result') {
      onEvent?.({ type: 'result', text: String(j.result ?? ''), isError: !!j.is_error })
    }
  }

  return {
    push(chunk) {
      buf += typeof chunk === 'string' ? chunk : decoder.write(chunk)
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() || ''
      for (const line of lines) emitLine(line)
    },
    flush() {
      if (buf.trim()) {
        emitLine(buf)
        buf = ''
      }
    }
  }
}
