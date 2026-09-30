import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:styling_station/data/sse_frames.dart';

void main() {
  group('SseFrameParser', () {
    test('六种业务事件都能解析（与服务端 sendSse 格式一致）', () {
      final p = SseFrameParser();
      final frames = p.add(
        'event: snapshot\n'
        'data: ${jsonEncode({"renderId": "r-1", "status": "queued", "queuePosition": 1, "blocks": []})}\n\n'
        'event: delta\n'
        'data: ${jsonEncode({"channel": "thinking", "text": "想"})}\n\n'
        'event: status\n'
        'data: ${jsonEncode({"status": "running", "queuePosition": 0})}\n\n'
        'event: result\n'
        'data: ${jsonEncode({"index": 1, "file": "files/renders/r-1/v1.png", "width": 1024, "height": 1024})}\n\n'
        'event: error\n'
        'data: ${jsonEncode({"message": "出图失败：x"})}\n\n'
        'event: done\n'
        'data: ${jsonEncode({"status": "error"})}\n\n'
      );
      expect(frames.map((f) => f.event).toList(),
          ['snapshot', 'delta', 'status', 'result', 'error', 'done']);
      final delta = jsonDecode(frames[1].data) as Map<String, Object?>;
      expect(delta['channel'], 'thinking');
    });

    test('心跳注释行被忽略，不产生帧', () {
      final p = SseFrameParser();
      expect(p.add(': ping\n\n'), isEmpty);
      final frames = p.add('event: done\ndata: {"status":"done"}\n\n');
      expect(frames.single.event, 'done');
    });

    test('半包：分块到达、跨块补齐', () {
      final p = SseFrameParser();
      expect(p.add('event: result\nda'), isEmpty);
      expect(p.add('ta: {"index": 1, "file"'), isEmpty);
      final frames = p.add(':"a.png"}\n\n');
      expect(frames.single.event, 'result');
      expect(jsonDecode(frames.single.data), {'index': 1, 'file': 'a.png'});
    });

    test('一个块含多帧 + 尾部半帧', () {
      final p = SseFrameParser();
      final frames = p.add('event: status\ndata: {}\n\nevent: snapshot\ndata: {"x": 1}\n\nevent: del');
      expect(frames.length, 2);
      expect(frames[0].event, 'status');
      expect(frames[1].event, 'snapshot');
      // 残帧在下一块完成
      final rest = p.add('ta\ndata: {"channel":"system","text":"ok"}\n\n');
      expect(rest.single.event, 'delta');
    });

    test('\\r\\n 换行容错', () {
      final p = SseFrameParser();
      final frames = p.add('event: done\r\ndata: {"status":"done"}\r\n\r\n');
      expect(frames.single.event, 'done');
    });

    test('data 多行合并；纯注释/空帧返回 null', () {
      expect(SseFrameParser.parseFrame(': ping'), isNull);
      expect(SseFrameParser.parseFrame(''), isNull);
      final f = SseFrameParser.parseFrame('event: x\ndata: a\ndata: b');
      expect(f!.data, 'a\nb');
    });

    test('无 event 名的 data 帧 → message', () {
      final f = SseFrameParser.parseFrame('data: hello');
      expect(f!.event, 'message');
      expect(f.data, 'hello');
    });
  });
}
