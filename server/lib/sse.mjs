/** SSE 写出：统一 `event:/data:` 帧 + 注释心跳。 */

export function sendSse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

export function startHeartbeat(res, intervalMs = 15000) {
  return setInterval(() => res.write(': ping\n\n'), intervalMs)
}
