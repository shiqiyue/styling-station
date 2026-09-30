/// 出图会话：SSE 订阅（六事件）+ 2 秒轮询降级 + delta 节流合并。
///
/// 语义对齐旧版 web `views/studio.js` 的出图面板状态：
/// - snapshot / delta / status / result / error / done 六事件驱动；
/// - delta 累计进 [blocks]（上限 400 条，超出丢最旧），250ms 合并通知一次；
/// - `done` → 拉一次详情补齐耗时与选用标记；
/// - SSE 流不可用（如 EventSource 构造失败 / 记录不存在）→ 2 秒轮询详情降级；
/// - 会话由视图持有，视图经 IndexedStack 跨 Tab 保留 → 出图进行中切换 Tab 不断连。
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../data/api_client.dart';
import '../data/models.dart';
import '../data/sse.dart';

/// 过程块（思考过程 / 工具日志）。
typedef RenderBlock = ({String channel, String text});

Object? _mapGet(Object? m, String key) => m is Map<String, Object?> ? m[key] : null;

String _str(Object? v, [String fallback = '']) => v is String ? v : fallback;

int _int(Object? v, [int fallback = 0]) => v is num ? v.toInt() : fallback;

class RenderSession extends ChangeNotifier {
  RenderSession(this.api);

  final Api api;

  /// 当前会话的渲染 id（null = 尚未开始）。
  String? id;
  RenderStatus status = RenderStatus.unknown;
  int queuePosition = 0;
  List<RenderBlock> blocks = [];
  List<RenderResult?> results = [];
  String? error;
  int? elapsedMs;
  String? parentId;

  StreamSubscription<RenderEvent>? _sub;
  Timer? _blocksTimer;
  Timer? _pollTimer;

  /// 世代号：切换目标/释放后，旧流事件一律忽略。
  int _gen = 0;

  bool get active => id != null;

  bool get running => status == RenderStatus.queued || status == RenderStatus.running;

  // ---------- 生命周期 ----------

  /// 提交新出图后立即进入会话（排队态），随后由事件驱动。
  void start(String renderId, {String? parent}) {
    _gen++;
    _cancelSub();
    _stopPolling();
    id = renderId;
    status = RenderStatus.queued;
    queuePosition = 1;
    blocks = [];
    results = [];
    error = null;
    elapsedMs = null;
    parentId = parent;
    notifyListeners();
    _subscribe();
  }

  /// 载入既有记录（查看上一版 / 恢复会话）；失败时抛 [ApiException] 由调用方提示。
  Future<void> load(String renderId) async {
    final rec = await api.getRender(renderId);
    _gen++;
    _cancelSub();
    _stopPolling();
    id = renderId;
    status = rec.status;
    queuePosition = 0;
    blocks = [];
    results = [for (final r in rec.results) r];
    error = rec.status == RenderStatus.error ? (rec.stderrTail ?? '出图失败') : null;
    elapsedMs = rec.elapsedMs;
    parentId = rec.parentId;
    if (!status.terminal) _subscribe();
    notifyListeners();
  }

  @override
  void dispose() {
    _gen++;
    _cancelSub();
    _stopPolling();
    _blocksTimer?.cancel();
    super.dispose();
  }

  // ---------- 操作 ----------

  /// 停止当前出图；状态经事件驱动更新。
  Future<void> stop() async {
    final myId = id;
    if (myId == null) return;
    await api.stopRender(myId);
  }

  /// 再出一版：提交重跑并按新记录进入会话。
  Future<void> rerun() async {
    final myId = id;
    if (myId == null) return;
    final newId = await api.rerunRender(myId);
    start(newId, parent: myId);
  }

  /// 选用/取消选用某张候选（index 从 1 起）。
  Future<void> choose(int index, bool chosen) async {
    final myId = id;
    if (myId == null) return;
    final rec = await api.setChosen(myId, index, chosen);
    results = [for (final r in rec.results) r];
    notifyListeners();
  }

  /// 拉一次详情（done 后补齐耗时/选用；轮询降级路径同样走这里）。
  Future<void> refresh() async {
    final myId = id;
    if (myId == null) return;
    final g = _gen;
    try {
      final rec = await api.getRender(myId);
      if (g != _gen || id != myId) return;
      status = rec.status;
      queuePosition = 0;
      elapsedMs = rec.elapsedMs;
      if (rec.results.isNotEmpty) results = [for (final r in rec.results) r];
      if (rec.status == RenderStatus.error && error == null) error = rec.stderrTail ?? '出图失败';
      if (status.terminal) {
        _cancelSub();
        _stopPolling();
      }
      notifyListeners();
    } on ApiException catch (e) {
      if (g != _gen || id != myId) return;
      if (e.status == 404) {
        // 记录不存在：轮询没有意义
        error ??= '出图记录不存在';
        _stopPolling();
        notifyListeners();
      }
    }
  }

  // ---------- SSE ----------

  void _subscribe() {
    final myId = id;
    if (myId == null) return;
    final g = _gen;
    _sub = openRenderEventStream(myId).listen(
      (e) {
        if (g != _gen) return;
        _onEvent(e);
      },
      onError: (Object _) {
        if (g != _gen) return;
        // 流不可用（罕见）：降级为 2 秒轮询详情
        _startPolling();
      }
    );
  }

  void _cancelSub() {
    final sub = _sub;
    _sub = null;
    unawaited(sub?.cancel());
  }

  void _onEvent(RenderEvent e) {
    final data = e.data;
    switch (e.event) {
      case 'snapshot':
        status = RenderStatus.parse(_mapGet(data, 'status'));
        queuePosition = _int(_mapGet(data, 'queuePosition'));
        final raw = _mapGet(data, 'blocks');
        if (raw is List) {
          blocks = [
            for (final b in raw)
              if (b is Map<String, Object?>)
                (channel: _str(b['channel'], 'system'), text: _str(b['text']))
          ];
        }
        notifyListeners();
      case 'delta':
        blocks.add((
          channel: _str(_mapGet(data, 'channel'), 'system'),
          text: _str(_mapGet(data, 'text'))
        ));
        if (blocks.length > 400) blocks.removeRange(0, blocks.length - 400);
        _scheduleBlocksNotify();
      case 'status':
        status = RenderStatus.parse(_mapGet(data, 'status'));
        queuePosition = _int(_mapGet(data, 'queuePosition'));
        notifyListeners();
      case 'result':
        final idx = _int(_mapGet(data, 'index'), 1);
        final file = _str(_mapGet(data, 'file'));
        if (idx < 1 || file.isEmpty) return;
        while (results.length < idx) {
          results.add(null);
        }
        results[idx - 1] = RenderResult(
          file: file,
          width: _int(_mapGet(data, 'width')),
          height: _int(_mapGet(data, 'height'))
        );
        notifyListeners();
      case 'error':
        error = _str(_mapGet(data, 'message'), '出图失败');
        notifyListeners();
      case 'done':
        status = RenderStatus.parse(_mapGet(data, 'status'));
        queuePosition = 0;
        _cancelSub();
        notifyListeners();
        unawaited(refresh());
    }
  }

  /// delta 节流：250ms 内多次到达只通知一次。
  void _scheduleBlocksNotify() {
    if (_blocksTimer != null) return;
    _blocksTimer = Timer(const Duration(milliseconds: 250), () {
      _blocksTimer = null;
      notifyListeners();
    });
  }

  // ---------- 轮询降级 ----------

  void _startPolling() {
    if (_pollTimer != null) return;
    _pollTimer = Timer.periodic(const Duration(seconds: 2), (_) => unawaited(refresh()));
    unawaited(refresh());
  }

  void _stopPolling() {
    _pollTimer?.cancel();
    _pollTimer = null;
  }
}
