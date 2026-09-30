/// 素材图优化弹窗：发起任务 → 订阅 SSE 进度 → 原图/优化图对比 → 采用或放弃。
///
/// - 返回 [LibraryDoc]：已采用（调用方应刷新图片列表）；null：未采用或中止。
/// - 运行中关闭（X/系统返回）需确认，确认后中止并丢弃；已完成未决策关闭 = 放弃（删除临时产物）。
/// - SSE 断流/任务失效（如服务重启）→ 失败态，可重试（重新发起）。
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../config.dart';
import '../data/api_client.dart';
import '../data/models.dart';
import '../data/sse.dart';
import '../theme.dart';
import 'app_modal.dart';
import 'toast.dart';

Future<LibraryDoc?> showOptimizeDialog(
  BuildContext context, {
  required Api api,
  required String materialId,
  required int index,
  required String originalFile
}) {
  return showDialog<LibraryDoc>(
    context: context,
    barrierDismissible: false,
    builder: (ctx) => _OptimizeDialog(
      api: api,
      materialId: materialId,
      index: index,
      originalFile: originalFile
    )
  );
}

enum _Phase { starting, running, done, failed }

class _OptimizeDialog extends StatefulWidget {
  const _OptimizeDialog({
    required this.api,
    required this.materialId,
    required this.index,
    required this.originalFile
  });

  final Api api;
  final String materialId;
  final int index;
  final String originalFile;

  @override
  State<_OptimizeDialog> createState() => _OptimizeDialogState();
}

class _OptimizeDialogState extends State<_OptimizeDialog> {
  _Phase _phase = _Phase.starting;
  String? _taskId;
  String _progress = '';
  String? _resultFile;
  String? _error;
  bool _busy = false; // 采用/放弃请求进行中
  StreamSubscription<RenderEvent>? _sub;
  bool _finished = false; // 已决定去留（防重复处理）

  @override
  void initState() {
    super.initState();
    _start();
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  Future<void> _start() async {
    setState(() {
      _phase = _Phase.starting;
      _progress = '';
      _resultFile = null;
      _error = null;
    });
    try {
      final taskId = await widget.api.startMaterialOptimize(widget.materialId, widget.index);
      _taskId = taskId;
      if (!mounted) return;
      _sub = openEventStream('/api/materials/${widget.materialId}/optimize/$taskId/stream').listen(
        _onEvent,
        onError: (Object e) {
          if (!mounted || _finished) return;
          setState(() {
            _phase = _Phase.failed;
            _error = '连接优化进度失败：$e';
          });
        }
      );
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _phase = _Phase.failed;
        _error = e.message;
      });
    }
  }

  void _onEvent(RenderEvent ev) {
    if (!mounted || _finished) return;
    final data = ev.data is Map<String, Object?> ? ev.data as Map<String, Object?> : const <String, Object?>{};
    switch (ev.event) {
      case 'snapshot':
        final status = data['status'] is String ? data['status'] as String : '';
        if (status == 'running') setState(() => _phase = _Phase.running);
      case 'delta':
        final text = data['text'] is String ? data['text'] as String : '';
        if (text.isNotEmpty) {
          setState(() {
            _phase = _Phase.running;
            _progress = '$_progress$text\n';
          });
        }
      case 'result':
        setState(() {
          _resultFile = data['file'] is String ? data['file'] as String : null;
        });
      case 'error':
        setState(() => _error = data['message'] is String ? data['message'] as String : '优化失败');
      case 'done':
        final status = data['status'] is String ? data['status'] as String : '';
        if (status == 'done' && _resultFile != null) {
          setState(() => _phase = _Phase.done);
        } else if (status == 'cancelled') {
          // 取消流程中（自己触发的）——若弹窗仍在，直接关闭
          if (!_finished) Navigator.of(context).pop(null);
        } else {
          setState(() {
            _phase = _Phase.failed;
            _error ??= '优化失败';
          });
        }
    }
  }

  /// 放弃并关闭（对运行中任务会先中止；幂等）。
  Future<void> _discardAndClose() async {
    if (_busy) return;
    _busy = true;
    final taskId = _taskId;
    if (taskId != null) {
      try {
        await widget.api.discardOptimize(widget.materialId, taskId);
      } catch (_) {
        /* 幂等接口，失败不阻塞关闭 */
      }
    }
    _busy = false;
    _finished = true;
    if (mounted) Navigator.of(context).pop(null);
  }

  Future<void> _adopt() async {
    final taskId = _taskId;
    if (taskId == null || _busy) return;
    setState(() => _busy = true);
    try {
      final doc = await widget.api.adoptOptimize(widget.materialId, taskId);
      _finished = true;
      if (mounted) Navigator.of(context).pop(doc);
    } on ApiException catch (e) {
      if (mounted) showToast(context, e.message, error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 关闭请求（X / 系统返回）：运行中需确认。
  Future<void> _onCloseRequested() async {
    if (_finished) return;
    if (_phase == _Phase.starting || _phase == _Phase.running) {
      final ok = await confirmDialog(context, '优化还在进行，关闭将中止并丢弃本次优化。确定关闭吗？', okText: '关闭');
      if (!ok || !mounted) return;
    }
    await _discardAndClose();
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _onCloseRequested();
      },
      child: Dialog(
        insetPadding: const EdgeInsets.all(24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 12, 8, 12),
                child: Row(
                  children: [
                    const Expanded(
                      child: Text('素材图优化', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700))
                    ),
                    IconButton(
                      onPressed: _busy ? null : _onCloseRequested,
                      icon: const Icon(Icons.close, size: 20),
                      tooltip: '关闭'
                    )
                  ]
                )
              ),
              const Divider(height: 1),
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 18, 20, 18),
                child: _body()
              ),
              const Divider(height: 1),
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
                child: _actions()
              )
            ]
          )
        )
      )
    );
  }

  Widget _body() {
    switch (_phase) {
      case _Phase.starting:
      case _Phase.running:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Row(
              children: [
                SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
                SizedBox(width: 10),
                Text('正在优化（去杂 + 摆正）…')
              ]
            ),
            if (_progress.isNotEmpty)
              Container(
                margin: const EdgeInsets.only(top: 12),
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(color: AppColors.bg, borderRadius: BorderRadius.circular(8)),
                child: Text(_progress.trimRight(),
                    style: const TextStyle(fontSize: 12, color: AppColors.muted))
              ),
            const SizedBox(height: 10),
            const Text('通常需要 10~60 秒；完成后先预览对比，再决定是否采用。',
                style: TextStyle(fontSize: 12, color: AppColors.muted))
          ]
        );
      case _Phase.done:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(child: _preview('原图', widget.originalFile)),
                const SizedBox(width: 12),
                Expanded(child: _preview('优化后', _resultFile ?? ''))
              ]
            ),
            const SizedBox(height: 10),
            const Text('「采用」会把优化图加为素材图片并设为主图（原图保留）。',
                style: TextStyle(fontSize: 12, color: AppColors.muted))
          ]
        );
      case _Phase.failed:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(_error ?? '优化失败', style: const TextStyle(color: AppColors.danger)),
            const SizedBox(height: 10),
            const Text('可重试（会重新发起一次优化），或关闭。',
                style: TextStyle(fontSize: 12, color: AppColors.muted))
          ]
        );
    }
  }

  Widget _preview(String label, String file) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
        const SizedBox(height: 6),
        ClipRRect(
          borderRadius: BorderRadius.circular(8),
          child: file.isEmpty
              ? Container(height: 160, color: AppColors.bg)
              : Image.network(
                  fileUri(file).toString(),
                  height: 160,
                  width: double.infinity,
                  fit: BoxFit.contain,
                  errorBuilder: (_, _, _) => Container(
                    height: 160,
                    color: AppColors.bg,
                    alignment: Alignment.center,
                    child: const Icon(Icons.broken_image_outlined, color: AppColors.muted)
                  )
                )
        )
      ]
    );
  }

  Widget _actions() {
    if (_busy) {
      return const Align(
        alignment: Alignment.centerRight,
        child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
      );
    }
    switch (_phase) {
      case _Phase.starting:
      case _Phase.running:
        return Align(
          alignment: Alignment.centerRight,
          child: TextButton(onPressed: _discardAndClose, child: const Text('取消优化'))
        );
      case _Phase.done:
        return Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            TextButton(onPressed: _discardAndClose, child: const Text('放弃')),
            const SizedBox(width: 8),
            FilledButton(onPressed: _adopt, child: const Text('采用'))
          ]
        );
      case _Phase.failed:
        return Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            TextButton(onPressed: _discardAndClose, child: const Text('关闭')),
            const SizedBox(width: 8),
            FilledButton(onPressed: _start, child: const Text('重试'))
          ]
        );
    }
  }
}
