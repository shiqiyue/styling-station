/// SSE 帧解析（纯函数，单测覆盖）。
///
/// 服务端帧格式（server/lib/sse.mjs）：
/// - 事件帧：`event: <name>\ndata: <json>\n\n`
/// - 心跳：`: ping\n\n`（注释行，忽略）
library;

/// 单个完整帧：[data] 为原始字符串（未做 JSON 解析）。
typedef SseFrame = ({String event, String data});

/// 增量解析器：add(chunk) 返回本次凑齐的完整帧；
/// 半包残留在缓冲区，下一块补齐（跨块 UTF-8 由外层 decoder 处理）。
class SseFrameParser {
  String _buf = '';

  /// 追加数据块（可为多帧、半帧或空），返回解析出的完整帧。
  List<SseFrame> add(String chunk) {
    if (chunk.isEmpty) return const [];
    // 容忍 \r\n 换行（本服务端只发 \n，防御性归一）
    _buf += chunk.replaceAll('\r\n', '\n');
    final frames = <SseFrame>[];
    while (true) {
      final idx = _buf.indexOf('\n\n');
      if (idx < 0) break;
      final raw = _buf.substring(0, idx);
      _buf = _buf.substring(idx + 2);
      final frame = parseFrame(raw);
      if (frame != null) frames.add(frame);
    }
    return frames;
  }

  /// 解析单个原始帧文本；纯注释帧/空帧返回 null。
  static SseFrame? parseFrame(String raw) {
    var event = '';
    final dataLines = <String>[];
    for (final line in raw.split('\n')) {
      if (line.isEmpty) continue;
      if (line.startsWith(':')) continue; // 心跳等注释行
      if (line.startsWith('event:')) {
        event = line.substring('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        var v = line.substring('data:'.length);
        if (v.startsWith(' ')) v = v.substring(1);
        dataLines.add(v);
      }
    }
    if (event.isEmpty && dataLines.isEmpty) return null;
    if (event.isEmpty) event = 'message';
    return (event: event, data: dataLines.join('\n'));
  }
}
