/// 出图面板：状态行（排队位次/耗时）、停止/再出一版、思考过程与过程日志折叠、
/// 候选卡片（查看大图 / 选用 / Web 下载）。
library;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';

import '../config.dart';
import '../data/api_client.dart';
import '../data/models.dart';
import '../download.dart';
import '../state/render_session.dart';
import '../theme.dart';
import '../widgets/toast.dart';

/// 出图状态文案（对齐旧版状态机文案，失败显示“出图失败”）。
String _statusLabel(RenderStatus s) => switch (s) {
      RenderStatus.queued => '排队中',
      RenderStatus.running => '出图中',
      RenderStatus.done => '已完成',
      RenderStatus.error => '出图失败',
      RenderStatus.stopped => '已停止',
      RenderStatus.unknown => '未知'
    };

Color _statusColor(RenderStatus s) => switch (s) {
      RenderStatus.queued => AppColors.warn,
      RenderStatus.running => AppColors.accent,
      RenderStatus.done => const Color(0xFF15803D),
      RenderStatus.error => AppColors.danger,
      RenderStatus.stopped => AppColors.muted,
      RenderStatus.unknown => AppColors.muted
    };

class RenderPanel extends StatefulWidget {
  const RenderPanel({super.key, required this.session});

  final RenderSession session;

  @override
  State<RenderPanel> createState() => _RenderPanelState();
}

class _RenderPanelState extends State<RenderPanel> {
  bool _thinkOpen = false;
  bool _toolOpen = false;
  bool _busy = false;

  RenderSession get _s => widget.session;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _s,
      builder: (context, _) {
        if (!_s.active) return const SizedBox.shrink();
        return Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: AppColors.panel,
            borderRadius: BorderRadius.circular(kRadius),
            border: Border.all(color: AppColors.line)
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            _head(),
            if (_s.error != null)
              Container(
                margin: const EdgeInsets.only(top: 10),
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: const Color(0xFFFBEEEE),
                  borderRadius: BorderRadius.circular(kRadius - 4),
                  border: Border.all(color: const Color(0xFFEFD5D5))
                ),
                child: Text(_s.error!, style: const TextStyle(color: AppColors.danger, fontSize: 13))
              ),
            ..._blocks(),
            ..._results(context)
          ])
        );
      }
    );
  }

  Widget _head() {
    final s = _s;
    final text = StringBuffer(_statusLabel(s.status));
    if (s.status == RenderStatus.queued && s.queuePosition > 0) {
      text.write('（第 ${s.queuePosition} 位）');
    }
    if (s.status == RenderStatus.done && (s.elapsedMs ?? 0) > 0) {
      text.write('（耗时 ${(s.elapsedMs! / 1000).toStringAsFixed(1)}s）');
    }
    return Row(children: [
      Container(width: 10, height: 10, decoration: BoxDecoration(shape: BoxShape.circle, color: _statusColor(s.status))),
      const SizedBox(width: 8),
      Text('$text', style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
      const Spacer(),
      ..._actions()
    ]);
  }

  List<Widget> _actions() {
    final s = _s;
    if (s.running) {
      return [
        TextButton(
          onPressed: _busy ? null : _stop,
          style: TextButton.styleFrom(foregroundColor: AppColors.danger),
          child: const Text('停止')
        )
      ];
    }
    if (s.status.terminal) {
      return [
        if (s.parentId != null) ...[
          OutlinedButton(onPressed: _busy ? null : _loadParent, child: const Text('查看上一版')),
          const SizedBox(width: 8)
        ],
        FilledButton(onPressed: _busy ? null : _rerun, child: const Text('再出一版'))
      ];
    }
    return const [];
  }

  List<Widget> _blocks() {
    final s = _s;
    final thinking = [
      for (final b in s.blocks)
        if (b.channel == 'thinking') b.text
    ].join('\n');
    final logs = [
      for (final b in s.blocks)
        if (b.channel != 'thinking') '[${b.channel}] ${b.text}'
    ].join('\n');
    if (thinking.isEmpty && logs.isEmpty) {
      if (s.running) {
        return [
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(s.status == RenderStatus.queued ? '排队中…' : '正在生成…',
                style: const TextStyle(color: AppColors.muted, fontSize: 13))
          )
        ];
      }
      return const [];
    }
    return [
      if (thinking.isNotEmpty)
        _section('思考过程', thinking, _thinkOpen, (v) => setState(() => _thinkOpen = v)),
      if (logs.isNotEmpty) _section('过程日志', logs, _toolOpen, (v) => setState(() => _toolOpen = v))
    ];
  }

  Widget _section(String title, String text, bool open, ValueChanged<bool> onToggle) {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      InkWell(
        onTap: () => onToggle(!open),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Row(children: [
            Icon(open ? Icons.expand_less : Icons.expand_more, size: 18, color: AppColors.muted),
            const SizedBox(width: 6),
            Text(title, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600))
          ])
        )
      ),
      if (open)
        Container(
          margin: const EdgeInsets.only(bottom: 8),
          padding: const EdgeInsets.all(10),
          constraints: const BoxConstraints(maxHeight: 260),
          decoration: BoxDecoration(color: AppColors.bg, borderRadius: BorderRadius.circular(kRadius - 4)),
          child: SingleChildScrollView(
            child: SelectableText(text, style: const TextStyle(fontSize: 12, height: 1.5))
          )
        )
    ]);
  }

  List<Widget> _results(BuildContext context) {
    final s = _s;
    final total = s.results.length;
    final items = <Widget>[];
    for (var i = 0; i < total; i++) {
      final r = s.results[i];
      if (r == null) continue;
      items.add(_resultCard(context, r, i + 1));
    }
    if (items.isEmpty) return const [];
    return [
      const SizedBox(height: 4),
      LayoutBuilder(
        builder: (context, c) => GridView.builder(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
            maxCrossAxisExtent: 280,
            mainAxisExtent: 330,
            crossAxisSpacing: 12,
            mainAxisSpacing: 12
          ),
          itemCount: items.length,
          itemBuilder: (_, i) => items[i]
        )
      )
    ];
  }

  Widget _resultCard(BuildContext context, RenderResult res, int idx) {
    final url = fileUri(res.file).toString();
    return Container(
      decoration: BoxDecoration(
        color: AppColors.panel,
        borderRadius: BorderRadius.circular(kRadius - 2),
        border: Border.all(color: res.chosen ? AppColors.accent : AppColors.line, width: res.chosen ? 2 : 1)
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Expanded(
          child: GestureDetector(
            onTap: () => _viewImage(url, '候选 $idx'),
            child: Container(
              color: AppColors.bg,
              child: Image.network(url, fit: BoxFit.contain, errorBuilder: (_, _, _) =>
                  const Center(child: Text('图片加载失败', style: TextStyle(color: AppColors.muted, fontSize: 12))))
            )
          )
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
          child: Row(children: [
            Text('候选 $idx', style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
            if (res.chosen)
              Container(
                margin: const EdgeInsets.only(left: 6),
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                decoration: BoxDecoration(color: AppColors.accentSoft, borderRadius: BorderRadius.circular(999)),
                child: const Text('已选用', style: TextStyle(fontSize: 11, color: AppColors.accent))
              ),
            const Spacer(),
            if (kIsWeb) ...[
              TextButton(
                onPressed: () => downloadFile(url, 'v$idx.png'),
                style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
                child: const Text('下载', style: TextStyle(fontSize: 12))
              ),
              const SizedBox(width: 4)
            ],
            res.chosen
                ? OutlinedButton(
                    onPressed: () => _choose(idx, false),
                    style: OutlinedButton.styleFrom(visualDensity: VisualDensity.compact),
                    child: const Text('取消选用', style: TextStyle(fontSize: 12))
                  )
                : FilledButton(
                    onPressed: () => _choose(idx, true),
                    style: FilledButton.styleFrom(visualDensity: VisualDensity.compact),
                    child: const Text('选用', style: TextStyle(fontSize: 12))
                  )
          ])
        )
      ])
    );
  }

  // ---------- 操作 ----------

  Future<void> _guard(Future<void> Function() run) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await run();
    } on ApiException catch (e) {
      if (mounted) showToast(context, e.message, error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _stop() => _guard(_s.stop);

  Future<void> _rerun() => _guard(() async {
        await _s.rerun();
        if (mounted) showToast(context, '已按同一配置提交新版本');
      });

  Future<void> _loadParent() => _guard(() => _s.load(_s.parentId!));

  Future<void> _choose(int idx, bool chosen) => _guard(() async {
        await _s.choose(idx, chosen);
        if (mounted) showToast(context, chosen ? '已选用候选 $idx' : '已取消选用');
      });

  void _viewImage(String url, String title) {
    showDialog<void>(
      context: context,
      builder: (ctx) => Dialog(
        insetPadding: const EdgeInsets.all(20),
        backgroundColor: Colors.black,
        child: Stack(children: [
          Padding(
            padding: const EdgeInsets.all(8),
            child: InteractiveViewer(
              minScale: 0.5,
              maxScale: 5,
              child: Center(child: Image.network(url, fit: BoxFit.contain))
            )
          ),
          Positioned(
            top: 4,
            right: 4,
            child: IconButton(
              onPressed: () => Navigator.of(ctx).pop(),
              icon: const Icon(Icons.close, color: Colors.white),
              tooltip: '关闭'
            )
          )
        ])
      )
    );
  }
}
