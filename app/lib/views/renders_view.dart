/// 记录页面：列表（缩略图/标题/状态/时间，支持 `?template=&material=` 筛选 + 20 条一页
/// 加载更多）与详情（快照明细、候选图选用/下载、版本链上/下版跳转、停止、再出一版）。
///
/// 详情对未完成任务用 SSE 事件（status/result/done）触发 400ms 节流重取；
/// Web 端 hash 与页面状态双向同步（`#/renders`、`#/renders/<id>`，
/// 浏览器前进/后退可用）；Android 无地址栏，导航走内部状态。
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../config.dart';
import '../data/api_client.dart';
import '../data/models.dart';
import '../data/sse.dart';
import '../hash_route.dart';
import '../theme.dart';
import '../widgets/empty_state.dart';
import '../widgets/result_card.dart';
import '../widgets/toast.dart';

const int _kListLimit = 20;

/// 状态文案（列表/详情的徽标）。
String _statusLabel(RenderStatus s) => switch (s) {
      RenderStatus.queued => '排队中',
      RenderStatus.running => '出图中',
      RenderStatus.done => '已完成',
      RenderStatus.error => '失败',
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

/// ISO 时间 → 本地 `yyyy-MM-dd HH:mm:ss`（解析失败原样返回）。
String _fmtTime(String iso) {
  if (iso.isEmpty) return '';
  final dt = DateTime.tryParse(iso);
  if (dt == null) return iso;
  final l = dt.toLocal();
  String p(int v) => v.toString().padLeft(2, '0');
  return '${l.year}-${p(l.month)}-${p(l.day)} ${p(l.hour)}:${p(l.minute)}:${p(l.second)}';
}

/// 记录标题：预设快照名优先，其次样板名。
String _titleOf(RenderDoc r) {
  final preset = r.presetName;
  if (preset != null && preset.isNotEmpty) return preset;
  final tpl = r.templateSnapshot?.name;
  return (tpl != null && tpl.isNotEmpty) ? tpl : '（无样板）';
}

String _modeLabel(RenderDoc r) => r.isFree ? '自由搭配' : '预设搭配';

/// 解析 `renders` 路由位置（`renders/<id>?template=&material=`）→ 详情 id + 筛选。
/// 非本页路由返回空（按列表处理，防御性）。
typedef RendersLocation = ({String? id, String template, String material});

RendersLocation parseRendersLocation(String loc) {
  const empty = (id: null, template: '', material: '');
  if (loc.isEmpty) return empty;
  final qIdx = loc.indexOf('?');
  final path = qIdx >= 0 ? loc.substring(0, qIdx) : loc;
  final query = qIdx >= 0 ? loc.substring(qIdx + 1) : '';
  final parts = path.split('/');
  if (parts[0].isNotEmpty && parts[0] != 'renders') return empty;
  final q = Uri.splitQueryString(query);
  return (
    id: parts.length > 1 && parts[1].isNotEmpty ? parts[1] : null,
    template: q['template'] ?? '',
    material: q['material'] ?? ''
  );
}

class RendersView extends StatefulWidget {
  const RendersView({super.key, required this.api});

  final Api api;

  @override
  State<RendersView> createState() => _RendersViewState();
}

class _RendersViewState extends State<RendersView> {
  // ---------- 路由 ----------
  String? _detailId;
  String _filterTemplate = '';
  String _filterMaterial = '';

  /// 筛选项显示名（'' = 未加载，展示「加载中…」）。
  String _filterName = '';

  // ---------- 列表 ----------
  final List<RenderDoc> _items = [];
  int _total = 0;
  bool _loading = false;
  bool _loadedOnce = false;
  String? _listError;

  // ---------- 详情 ----------
  RenderDoc? _rec;
  String? _detailError;
  bool _detailLoading = false;
  bool _busy = false;
  List<RenderDoc> _children = const [];
  StreamSubscription<RenderEvent>? _sub;
  Timer? _throttle;

  /// 详情代际：切换记录/重取后旧异步结果直接丢弃。
  int _seq = 0;

  @override
  void initState() {
    super.initState();
    _applyLocation(readHashLocation());
    listenHashRoute(_onHashRoute);
    // 首帧后再加载（initState 内 setState 会触发 build 期异常）
    final id = _detailId;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (id != null) {
        _openDetail(id);
      } else {
        _loadFilterName();
        _loadList(reset: true);
      }
    });
  }

  @override
  void dispose() {
    _cancelSub();
    _throttle?.cancel();
    super.dispose();
  }

  // ---------- 路由同步 ----------

  void _applyLocation(String loc) {
    final parsed = parseRendersLocation(loc);
    _detailId = parsed.id;
    _filterTemplate = parsed.template;
    _filterMaterial = parsed.material;
  }

  void _onHashRoute(String route) {
    // 其他 Tab 的路由变化与本页无关；回到本页（含详情/筛选变化）才处理
    if (route.isNotEmpty && route != 'renders') return;
    final before = (_detailId, _filterTemplate, _filterMaterial);
    _applyLocation(readHashLocation());
    final after = (_detailId, _filterTemplate, _filterMaterial);
    if (before == after || !mounted) return;
    setState(() {});
    final id = _detailId;
    if (id != null) {
      _openDetail(id);
    } else {
      _loadFilterName();
      _loadList(reset: true);
    }
  }

  String get _listLocation {
    final q = <String>[
      if (_filterTemplate.isNotEmpty) 'template=${Uri.encodeComponent(_filterTemplate)}',
      if (_filterMaterial.isNotEmpty) 'material=${Uri.encodeComponent(_filterMaterial)}'
    ];
    return q.isEmpty ? 'renders' : 'renders?${q.join('&')}';
  }

  void _goDetail(String id) {
    setState(() => _detailId = id);
    writeHashLocation('renders/${Uri.encodeComponent(id)}');
    _openDetail(id);
  }

  void _goList() {
    setState(() => _detailId = null);
    writeHashLocation(_listLocation);
    _loadList(reset: true);
  }

  void _clearFilter() {
    setState(() {
      _filterTemplate = '';
      _filterMaterial = '';
    });
    writeHashLocation('renders');
    _loadFilterName();
    _loadList(reset: true);
  }

  Future<void> _loadFilterName() async {
    final tid = _filterTemplate;
    final mid = _filterMaterial;
    if (tid.isEmpty && mid.isEmpty) {
      if (mounted && _filterName.isNotEmpty) setState(() => _filterName = '');
      return;
    }
    if (mounted) setState(() => _filterName = '');
    try {
      final doc = tid.isNotEmpty
          ? await widget.api.getLibrary(Api.kTemplates, tid)
          : await widget.api.getLibrary(Api.kMaterials, mid);
      if (mounted) setState(() => _filterName = '${tid.isNotEmpty ? '样板' : '素材'}：${doc.name}');
    } on ApiException {
      if (mounted) setState(() => _filterName = tid.isNotEmpty ? '样板 $tid' : '素材 $mid');
    }
  }

  // ---------- 列表 ----------

  Future<void> _loadList({required bool reset}) async {
    if (_loading) return;
    _loading = true;
    if (reset) {
      _items.clear();
      _total = 0;
      _listError = null;
    }
    if (mounted) setState(() {});
    try {
      final page = await widget.api.listRenders(
        templateId: _filterTemplate.isEmpty ? null : _filterTemplate,
        materialId: _filterMaterial.isEmpty ? null : _filterMaterial,
        limit: _kListLimit,
        offset: reset ? 0 : _items.length
      );
      if (!mounted) return;
      setState(() {
        if (reset) _items.clear();
        _total = page.total;
        _items.addAll(page.items);
        _loadedOnce = true;
        _listError = null;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      if (reset) {
        setState(() => _listError = e.message);
      } else {
        showToast(context, e.message, error: true);
      }
    } finally {
      _loading = false;
      if (mounted) setState(() {});
    }
  }

  // ---------- 详情 ----------

  Future<void> _openDetail(String id) async {
    final my = ++_seq;
    _cancelSub();
    setState(() {
      _detailLoading = true;
      _detailError = null;
      _rec = null;
      _children = const [];
    });
    try {
      final rec = await widget.api.getRender(id);
      if (!mounted || my != _seq) return;
      setState(() {
        _rec = rec;
        _detailLoading = false;
      });
      _maybeSubscribe(rec);
      unawaited(_loadChain(rec));
    } on ApiException catch (e) {
      if (!mounted || my != _seq) return;
      setState(() {
        _detailError = e.message;
        _detailLoading = false;
      });
    }
  }

  /// 版本链「下一版」按钮：逐个取子记录（失败跳过，与旧版一致）。
  Future<void> _loadChain(RenderDoc rec) async {
    final my = _seq;
    if (rec.childrenIds.isEmpty) return;
    final got = <RenderDoc>[];
    for (final cid in rec.childrenIds) {
      try {
        final child = await widget.api.getRender(cid);
        if (!mounted || my != _seq) return;
        got.add(child);
      } on ApiException {
        /* 子记录读取失败则跳过 */
      }
    }
    if (mounted && my == _seq) setState(() => _children = got);
  }

  void _maybeSubscribe(RenderDoc rec) {
    _cancelSub();
    if (rec.status.terminal) return;
    _sub = openRenderEventStream(rec.id).listen(
      (ev) {
        if (ev.event == 'status' || ev.event == 'result' || ev.event == 'done') _scheduleRefetch();
      },
      onError: (Object _) {
        /* 事件流不可用：保留手动刷新与已加载数据 */
      },
      cancelOnError: true
    );
  }

  void _cancelSub() {
    _sub?.cancel();
    _sub = null;
  }

  void _scheduleRefetch() {
    if (_throttle != null) return;
    _throttle = Timer(const Duration(milliseconds: 400), () {
      _throttle = null;
      unawaited(_refetchDetail());
    });
  }

  Future<void> _refetchDetail() async {
    final id = _detailId;
    if (id == null || !mounted) return;
    final my = _seq;
    try {
      final rec = await widget.api.getRender(id);
      if (!mounted || my != _seq) return;
      setState(() => _rec = rec);
      if (rec.status.terminal) {
        _cancelSub();
      } else {
        unawaited(_loadChain(rec));
      }
    } on ApiException catch (e) {
      if (mounted && my == _seq) showToast(context, e.message, error: true);
    }
  }

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

  Future<void> _stop() => _guard(() async {
        await widget.api.stopRender(_rec!.id);
        await _refetchDetail();
      });

  Future<void> _rerun() => _guard(() async {
        final newId = await widget.api.rerunRender(_rec!.id);
        if (!mounted) return;
        showToast(context, '已提交新版本');
        _goDetail(newId);
      });

  Future<void> _choose(int idx, bool chosen) => _guard(() async {
        final updated = await widget.api.setChosen(_rec!.id, idx, chosen);
        if (!mounted) return;
        setState(() => _rec = updated);
        showToast(context, chosen ? '已选用候选 $idx' : '已取消选用');
      });

  // ---------- 构建 ----------

  @override
  Widget build(BuildContext context) {
    return _detailId == null ? _listBody() : _detailBody();
  }

  Widget _listBody() {
    final hasFilter = _filterTemplate.isNotEmpty || _filterMaterial.isNotEmpty;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
        child: Row(children: [
          const Text('记录', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
          const Spacer(),
          OutlinedButton(
            onPressed: _loading ? null : () => _loadList(reset: true),
            child: const Text('刷新')
          )
        ])
      ),
      if (hasFilter)
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
          child: Wrap(
            spacing: 8,
            runSpacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              const Text('筛选：', style: TextStyle(fontSize: 13, color: AppColors.muted)),
              _badge(_filterName.isEmpty ? '加载中…' : _filterName, color: AppColors.accent),
              TextButton(onPressed: _clearFilter, child: const Text('清除筛选'))
            ]
          )
        ),
      Expanded(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
          child: _listContent()
        )
      )
    ]);
  }

  Widget _listContent() {
    if (_listError != null) return EmptyState(message: _listError!);
    if (!_loadedOnce && _loading) {
      return const Center(child: Text('加载中…', style: TextStyle(color: AppColors.muted)));
    }
    if (_items.isEmpty) {
      return const EmptyState(message: '还没有出图记录；到「搭配台」生成第一张效果图。');
    }
    return SingleChildScrollView(
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        for (final rec in _items) _row(rec),
        if (_items.length < _total)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Center(
              child: OutlinedButton(
                onPressed: _loading ? null : () => _loadList(reset: false),
                child: Text('加载更多（已显示 ${_items.length}/$_total）')
              )
            )
          )
      ])
    );
  }

  Widget _row(RenderDoc rec) {
    RenderResult? first;
    for (final r in rec.results) {
      if (r.error == null) {
        first = r;
        break;
      }
    }
    final chosenCount = rec.results.where((r) => r.chosen).length;
    const subStyle = TextStyle(fontSize: 12, color: AppColors.muted);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Material(
        color: AppColors.panel,
        borderRadius: BorderRadius.circular(kRadius),
        child: InkWell(
          borderRadius: BorderRadius.circular(kRadius),
          onTap: () => _goDetail(rec.id),
          child: Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(kRadius),
              border: Border.all(color: AppColors.line)
            ),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              _thumb(first?.file, 72, placeholder: rec.results.isEmpty ? '无候选' : '无图'),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Wrap(
                    spacing: 8,
                    runSpacing: 6,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      Text(_titleOf(rec), style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
                      _badge(_statusLabel(rec.status), color: _statusColor(rec.status)),
                      _badge(_modeLabel(rec)),
                      if (chosenCount > 0) _badge('$chosenCount 张选用', color: const Color(0xFF15803D))
                    ]
                  ),
                  const SizedBox(height: 6),
                  Wrap(spacing: 12, runSpacing: 4, children: [
                    Text('样板：${rec.templateSnapshot?.name ?? '—'}', style: subStyle),
                    Text('素材 ${rec.materialsSnapshot.length} 个', style: subStyle),
                    Text('候选 ${rec.results.length}/${rec.candidateCount} 张', style: subStyle),
                    if (rec.size.isNotEmpty) Text(rec.size, style: subStyle),
                    Text(_fmtTime(rec.createdAt), style: subStyle)
                  ])
                ])
              )
            ])
          )
        )
      )
    );
  }

  // ---------- 详情构建 ----------

  Widget _detailBody() {
    if (_detailLoading) {
      return const Center(child: Text('加载中…', style: TextStyle(color: AppColors.muted)));
    }
    final err = _detailError;
    if (err != null) {
      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
          child: TextButton.icon(
            onPressed: _goList,
            icon: const Icon(Icons.arrow_back, size: 18),
            label: const Text('返回列表')
          )
        ),
        Expanded(child: EmptyState(message: err))
      ]);
    }
    final rec = _rec!;
    return SingleChildScrollView(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            TextButton.icon(
              onPressed: _goList,
              icon: const Icon(Icons.arrow_back, size: 18),
              label: const Text('返回列表')
            ),
            const SizedBox(width: 8),
            const Expanded(
              child: Text('记录详情', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700), overflow: TextOverflow.ellipsis)
            ),
            ..._detailActions(rec)
          ]),
          const SizedBox(height: 12),
          _statusPanel(rec),
          const SizedBox(height: 12),
          _snapshotPanel(rec),
          const SizedBox(height: 12),
          _resultsPanel(rec),
          const SizedBox(height: 12),
          _chainPanel(rec)
        ])
      )
    );
  }

  List<Widget> _detailActions(RenderDoc rec) {
    if (rec.status == RenderStatus.queued || rec.status == RenderStatus.running) {
      return [
        TextButton(
          onPressed: _busy ? null : _stop,
          style: TextButton.styleFrom(foregroundColor: AppColors.danger),
          child: const Text('停止')
        )
      ];
    }
    return [FilledButton(onPressed: _busy ? null : _rerun, child: const Text('再出一版'))];
  }

  Widget _statusPanel(RenderDoc rec) {
    var line = '${_titleOf(rec)} · ${_modeLabel(rec)}';
    final tplName = rec.templateSnapshot?.name ?? '';
    if (tplName.isNotEmpty && (rec.presetName?.isNotEmpty ?? false)) {
      line += '（样板：$tplName）';
    }
    final elapsed = rec.elapsedMs ?? 0;
    return _panel(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Wrap(
          spacing: 10,
          runSpacing: 6,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(line, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
            _badge(_statusLabel(rec.status), color: _statusColor(rec.status)),
            if (rec.status == RenderStatus.done && elapsed > 0)
              Text('耗时 ${(elapsed / 1000).toStringAsFixed(1)}s',
                  style: const TextStyle(fontSize: 12, color: AppColors.muted)),
            Text(_fmtTime(rec.createdAt), style: const TextStyle(fontSize: 12, color: AppColors.muted)),
            if ((rec.cliSessionId ?? '').isNotEmpty)
              Text('CLI 会话 ${rec.cliSessionId}',
                  style: const TextStyle(fontSize: 12, color: AppColors.muted))
          ]
        ),
        if (rec.status == RenderStatus.error && (rec.stderrTail ?? '').isNotEmpty)
          Container(
            margin: const EdgeInsets.only(top: 10),
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: const Color(0xFFFBEEEE),
              borderRadius: BorderRadius.circular(kRadius - 4),
              border: Border.all(color: const Color(0xFFEFD5D5))
            ),
            child: SelectableText(rec.stderrTail!, style: const TextStyle(color: AppColors.danger, fontSize: 12))
          )
      ])
    );
  }

  Widget _snapshotPanel(RenderDoc rec) {
    final t = rec.templateSnapshot;
    const mutedStyle = TextStyle(fontSize: 12, color: AppColors.muted);
    return _panel(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text('快照明细', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
        const SizedBox(height: 10),
        if (t != null)
          _snapRow(image: t.images.isEmpty ? null : t.images.first.file, title: '样板：${t.name}', tags: t.tags),
        for (final m in rec.materialsSnapshot)
          _snapRow(
            image: m.images.isEmpty ? null : m.images.first.file,
            title: '素材：${m.name}',
            slotName: m.slotName,
            positionNote: m.slotPosition,
            tags: m.tags
          ),
        if (rec.positionNote.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text('整体位置说明：${rec.positionNote}', style: mutedStyle)
          ),
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Text('候选张数：${rec.candidateCount} · 尺寸：${rec.size.isEmpty ? '—' : rec.size}', style: mutedStyle)
        )
      ])
    );
  }

  Widget _snapRow({
    String? image,
    required String title,
    String? slotName,
    String? positionNote,
    List<String> tags = const []
  }) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _thumb(image, 56),
        const SizedBox(width: 10),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Wrap(
              spacing: 6,
              runSpacing: 4,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                if (slotName != null && slotName.isNotEmpty) _badge('插槽：$slotName', color: AppColors.accent),
                Text(title, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600))
              ]
            ),
            if (positionNote != null && positionNote.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text('位置：$positionNote', style: const TextStyle(fontSize: 12, color: AppColors.muted))
              ),
            if (tags.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Wrap(spacing: 6, runSpacing: 4, children: [for (final t in tags) _tagChip(t)])
              )
          ])
        )
      ])
    );
  }

  Widget _resultsPanel(RenderDoc rec) {
    return _panel(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          const Text('候选图', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
          const Spacer(),
          Text('${rec.results.length}/${rec.candidateCount} 张',
              style: const TextStyle(fontSize: 12, color: AppColors.muted))
        ]),
        const SizedBox(height: 10),
        if (rec.results.isEmpty)
          Text(
            rec.status == RenderStatus.done ? '本次没有产出候选图' : '候选图生成后会出现在这里',
            style: const TextStyle(fontSize: 13, color: AppColors.muted)
          )
        else
          GridView.builder(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
              maxCrossAxisExtent: 280,
              mainAxisExtent: 330,
              crossAxisSpacing: 12,
              mainAxisSpacing: 12
            ),
            itemCount: rec.results.length,
            itemBuilder: (_, i) => ResultCard(result: rec.results[i], index: i + 1, onChoose: _choose, busy: _busy)
          )
      ])
    );
  }

  Widget _chainPanel(RenderDoc rec) {
    final single = rec.parentId == null && rec.childrenIds.isEmpty && _children.isEmpty;
    return _panel(
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Text('版本链', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
        const SizedBox(height: 10),
        Wrap(spacing: 8, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
          if (rec.parentId != null)
            OutlinedButton(onPressed: () => _goDetail(rec.parentId!), child: const Text('← 上一版')),
          _badge('本版（${_statusLabel(rec.status)}）', color: AppColors.accent),
          for (final child in _children)
            OutlinedButton(
              onPressed: () => _goDetail(child.id),
              child: Text('下一版 →（${_statusLabel(child.status)} · ${_fmtTime(child.createdAt)}）')
            ),
          if (single) const Text('（单版记录）', style: TextStyle(fontSize: 12, color: AppColors.muted))
        ])
      ])
    );
  }

  // ---------- 小组件 ----------

  Widget _panel({required Widget child}) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: AppColors.panel,
        borderRadius: BorderRadius.circular(kRadius),
        border: Border.all(color: AppColors.line)
      ),
      child: child
    );
  }

  Widget _badge(String text, {Color color = AppColors.muted}) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(999)),
      child: Text(text, style: TextStyle(fontSize: 11, color: color))
    );
  }

  Widget _tagChip(String text) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: AppColors.bg,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: AppColors.line)
      ),
      child: Text(text, style: const TextStyle(fontSize: 11, color: AppColors.text))
    );
  }

  Widget _thumb(String? file, double size, {String placeholder = '无图'}) {
    final fallback = Container(
      width: size,
      height: size,
      decoration: BoxDecoration(color: AppColors.bg, borderRadius: BorderRadius.circular(8)),
      alignment: Alignment.center,
      child: Text(placeholder, style: const TextStyle(fontSize: 11, color: AppColors.muted))
    );
    if (file == null || file.isEmpty) return fallback;
    return ClipRRect(
      borderRadius: BorderRadius.circular(8),
      child: Image.network(
        fileUri(file).toString(),
        width: size,
        height: size,
        fit: BoxFit.cover,
        errorBuilder: (_, _, _) => fallback
      )
    );
  }
}
