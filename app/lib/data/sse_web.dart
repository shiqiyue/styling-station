/// SSE 订阅（Web，package:web EventSource 实现）。
///
/// - 浏览器 EventSource 自带断线重连：服务端重连即补发快照与候选，无需额外逻辑；
/// - `done` 帧到达 → 主动 close 并结束流；
/// - EventSource 不可用（罕见）→ 流立刻 error，由界面降级 2s 轮询。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:js_interop';

import 'package:web/web.dart' as web;

import '../config.dart';

/// 与看板约定一致的渲染事件：event ∈ snapshot/delta/status/result/error/done。
typedef RenderEvent = ({String event, Object? data});

const kRenderEventNames = ['snapshot', 'delta', 'status', 'result', 'error', 'done'];

/// 打开任意 SSE 事件流（取消订阅即断开）。
Stream<RenderEvent> openEventStream(String path) {
  final ctrl = StreamController<RenderEvent>();
  web.EventSource? es;
  try {
    es = web.EventSource(apiUri(path).toString());
  } catch (e) {
    ctrl.addError(StateError('事件流不可用：$e'));
    ctrl.close();
    return ctrl.stream;
  }
  final source = es;
  for (final name in kRenderEventNames) {
    source.addEventListener(
        name,
        ((web.Event e) {
          Object? data;
          final raw = (e as web.MessageEvent).data;
          if (raw.isA<JSString>()) {
            final text = (raw as JSString).toDart;
            if (text.isNotEmpty) {
              try {
                data = jsonDecode(text);
              } catch (_) {
                data = null; // 坏帧忽略数据体
              }
            }
          }
          if (!ctrl.isClosed) {
            ctrl.add((event: name, data: data));
            if (name == 'done') {
              source.close();
              ctrl.close();
            }
          }
        }).toJS);
  }
  // 传输层错误交给 EventSource 自动重连；服务端补发快照
  ctrl.onCancel = () {
    source.close();
  };
  return ctrl.stream;
}

/// 出图记录事件流（兼容入口，语义不变）。
Stream<RenderEvent> openRenderEventStream(String renderId) =>
    openEventStream('/api/renders/$renderId/stream');
