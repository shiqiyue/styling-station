/// SSE 订阅（Android / 桌面临时场景，dart:io 实现）。
///
/// 与浏览器 EventSource 对齐语义：
/// - 连接失败/中断 → 2 秒后自动重连（服务端重连即补发快照与已产出候选）；
/// - 收到 `done` 帧 → 正常结束（不再重连）；
/// - HTTP 非 200（如记录不存在）→ 以 [ApiException] 终止流。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../config.dart';
import 'api_client.dart' show ApiException;
import 'sse_frames.dart';

/// 与看板约定一致的渲染事件：event ∈ snapshot/delta/status/result/error/done。
typedef RenderEvent = ({String event, Object? data});

const _reconnectDelay = Duration(seconds: 2);

/// 打开任意 SSE 事件流（自动重连；订阅取消即断开）。
Stream<RenderEvent> openEventStream(String path) async* {
  final uri = apiUri(path);
  while (true) {
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 8);
    var retry = true;
    try {
      final req = await client.getUrl(uri);
      req.headers.set('Accept', 'text/event-stream');
      req.headers.set('Cache-Control', 'no-store');
      final res = await req.close();
      if (res.statusCode != HttpStatus.ok) {
        // 记录不存在/服务器错误：重连无意义，终止
        await res.drain<void>();
        throw ApiException(
          status: res.statusCode,
          code: 'STREAM_HTTP_${res.statusCode}',
          message: res.statusCode == HttpStatus.notFound ? '出图记录不存在' : '订阅出图进度失败（${res.statusCode}）'
        );
      }
      final parser = SseFrameParser();
      await for (final chunk in res.transform(utf8.decoder)) {
        for (final frame in parser.add(chunk)) {
          var done = false;
          Object? data;
          if (frame.data.isNotEmpty) {
            try {
              data = jsonDecode(frame.data);
            } catch (_) {
              data = null; // 坏帧忽略数据体
            }
          }
          yield (event: frame.event, data: data);
          if (frame.event == 'done') {
            done = true;
            retry = false;
          }
          if (done) return;
        }
      }
      // 流自然结束（未收 done）→ 服务端断开 → 重连
    } on ApiException {
      rethrow;
    } on SocketException {
      // 网络暂不可达 → 重连
    } on HttpException {
      // 连接被中断 → 重连
    } finally {
      client.close(force: true);
    }
    if (!retry) return;
    await Future<void>.delayed(_reconnectDelay);
  }
}

/// 出图记录事件流（兼容入口，语义不变）。
Stream<RenderEvent> openRenderEventStream(String renderId) =>
    openEventStream('/api/renders/$renderId/stream');
