/// 搭配台：自由 / 预设双模式（行为对齐旧版 web `views/studio.js`）。
///
/// - 自由：样板单选（无图拦截）+ 素材多选（≤8，序号徽标、筛选 / 立即上传 / 标签推荐）
///   + 位置说明 + 候选张数 → 出图；
/// - 预设：选预设（失效/无图拦截）→ 样板预览 + 插槽卡片（弹窗选素材，可按插槽标签过滤）
///   + 一键自动填充 + 补充说明 → 出图；
/// - 出图过程由 [RenderSession] 经 SSE 实时驱动（面板见 render_panel.dart）；
///   视图经 IndexedStack 跨 Tab 保留，出图进行中切 Tab 不断连。
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../config.dart';
import '../data/api_client.dart';
import '../data/models.dart';
import '../state/render_session.dart';
import '../theme.dart';
import '../widgets/app_modal.dart';
import '../widgets/empty_state.dart';
import '../widgets/image_picker_field.dart';
import '../widgets/tag_input.dart';
import '../widgets/toast.dart';
import 'render_panel.dart';

/// 保真度预期说明（ImageGen 为文生图，素材靠 AI 观察描述还原，非像素级合成）。
const String kFidelityHint =
    'AI 概念效果图：素材外观尽量贴近原图但不保证完全一致（形状细节可能轻微漂移）；素材描述写具体、多出几版挑选可提高相似度。';

class StudioView extends StatefulWidget {
  const StudioView({super.key, required this.api});

  final Api api;

  @override
  State<StudioView> createState() => _StudioViewState();
}

/// 素材简报（推荐 / 自动填充 / 已选列表 / 插槽指派共用）。
class _MatBrief {
  const _MatBrief({required this.id, required this.name, this.file});

  final String id;
  final String name;
  final String? file;
}

class _StudioViewState extends State<StudioView> {
  late final RenderSession _session = RenderSession(widget.api);
  final ScrollController _scroll = ScrollController();
  final GlobalKey _panelKey = GlobalKey();

  String _mode = 'free';

  // ---------- 自由模式状态 ----------
  String? _tplId;
  _MatBrief? _tplBrief;
  final List<String> _picked = [];
  final Map<String, _MatBrief> _briefs = {};
  String _tScene = '';
  String _mScene = '';
  final TextEditingController _tQuery = TextEditingController();
  final TextEditingController _mQuery = TextEditingController();
  final TextEditingController _freeNote = TextEditingController();
  int _freeCount = 1;

  List<LibraryDoc> _templates = const [];
  bool _tplLoading = false;
  String? _tplError;
  int _tplSeq = 0;

  List<LibraryDoc> _materials = const [];
  bool _matLoading = false;
  String? _matError;
  int _matSeq = 0;

  // ---------- 预设模式状态 ----------
  Preset? _preset;
  final Map<String, _MatBrief> _assign = {};
  final TextEditingController _presetQuery = TextEditingController();
  final TextEditingController _presetNote = TextEditingController();
  int _presetCount = 1;
  List<Preset> _presets = const [];
  bool _presetLoading = false;
  String? _presetError;
  int _presetSeq = 0;
  bool _presetLoaded = false;

  // ---------- 公共 ----------
  List<String> _scenes = const [];
  Map<String, _MatBrief>? _matCache;
  Timer? _tTimer;
  Timer? _mTimer;
  Timer? _pTimer;
  bool _submitBusy = false;

  @override
  void initState() {
    super.initState();
    // 首帧后再加载（initState 内 setState 会触发 build 期异常）
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _loadScenes();
      _loadTemplates();
      _loadMaterials();
    });
  }

  @override
  void dispose() {
    _tTimer?.cancel();
    _mTimer?.cancel();
    _pTimer?.cancel();
    _tQuery.dispose();
    _mQuery.dispose();
    _freeNote.dispose();
    _presetQuery.dispose();
    _presetNote.dispose();
    _session.dispose();
    _scroll.dispose();
    super.dispose();
  }

  // ---------- 数据加载 ----------

  Future<void> _loadScenes() async {
    try {
      final s = await widget.api.scenes();
      if (mounted) setState(() => _scenes = s.scenes);
    } on ApiException {
      /* 场景筛选不可用不影响搜索 */
    }
  }

  Future<void> _loadTemplates() async {
    final my = ++_tplSeq;
    setState(() {
      _tplLoading = true;
      _tplError = null;
    });
    try {
      final data = await widget.api
          .listLibrary(Api.kTemplates, scene: _tScene, q: _tQuery.text.trim(), limit: 200);
      if (my != _tplSeq || !mounted) return;
      setState(() {
        _templates = data.items;
        _tplLoading = false;
      });
    } on ApiException catch (e) {
      if (my != _tplSeq || !mounted) return;
      setState(() {
        _tplError = e.message;
        _tplLoading = false;
      });
    }
  }

  Future<void> _loadMaterials() async {
    final my = ++_matSeq;
    setState(() {
      _matLoading = true;
      _matError = null;
    });
    try {
      final data = await widget.api
          .listLibrary(Api.kMaterials, scene: _mScene, q: _mQuery.text.trim(), limit: 300);
      if (my != _matSeq || !mounted) return;
      setState(() {
        _materials = data.items;
        _matLoading = false;
      });
    } on ApiException catch (e) {
      if (my != _matSeq || !mounted) return;
      setState(() {
        _matError = e.message;
        _matLoading = false;
      });
    }
  }

  Future<void> _loadPresets() async {
    final my = ++_presetSeq;
    setState(() {
      _presetLoading = true;
      _presetError = null;
    });
    try {
      final data = await widget.api.listPresets(q: _presetQuery.text.trim(), limit: 200);
      if (my != _presetSeq || !mounted) return;
      setState(() {
        _presets = data.items;
        _presetLoading = false;
      });
    } on ApiException catch (e) {
      if (my != _presetSeq || !mounted) return;
      setState(() {
        _presetError = e.message;
        _presetLoading = false;
      });
    }
  }

  /// 素材简报缓存（推荐 / 自动填充用）。
  Future<Map<String, _MatBrief>> _ensureMatCache({bool force = false}) async {
    var cache = _matCache;
    if (cache == null || force) {
      final data = await widget.api.listLibrary(Api.kMaterials, limit: 500);
      cache = {
        for (final m in data.items) m.id: _MatBrief(id: m.id, name: m.name, file: m.primaryImage?.file)
      };
      _matCache = cache;
    }
    return cache;
  }

  void _switchMode(String m) {
    if (_mode == m) return;
    setState(() => _mode = m);
    if (m == 'preset' && !_presetLoaded) {
      _presetLoaded = true;
      _loadPresets();
    }
  }

  // ---------- 自由模式：选择动作 ----------

  void _selectTemplate(LibraryDoc t) {
    if (t.images.isEmpty) {
      showToast(context, '该样板还没有图片，请先到「样板库」上传', error: true);
      return;
    }
    setState(() {
      _tplId = t.id;
      _tplBrief = _MatBrief(id: t.id, name: t.name, file: t.images.first.file);
    });
  }

  void _togglePick(LibraryDoc m) {
    final i = _picked.indexOf(m.id);
    if (i >= 0) {
      setState(() => _picked.removeAt(i));
      return;
    }
    if (_picked.length >= 8) {
      showToast(context, '一次最多搭配 8 个素材', error: true);
      return;
    }
    if (m.images.isEmpty) {
      showToast(context, '该素材还没有图片，请先上传图片再搭配', error: true);
      return;
    }
    setState(() {
      _picked.add(m.id);
      _briefs[m.id] = _MatBrief(id: m.id, name: m.name, file: m.images.first.file);
    });
  }

  Future<void> _autoRecommend() async {
    final tplId = _tplId;
    if (tplId == null) {
      showToast(context, '请先选择样板，再按标签推荐素材', error: true);
      return;
    }
    try {
      final res = await widget.api.autoRecommend(templateId: tplId, limit: 6);
      final cache = await _ensureMatCache(force: true);
      if (!mounted) return;
      var n = 0;
      setState(() {
        for (final id in res.recommended) {
          if (_picked.contains(id) || _picked.length >= 8) continue;
          final b = cache[id];
          if (b == null) continue;
          _picked.add(id);
          _briefs[id] = b;
          n++;
        }
      });
      showToast(context, n > 0 ? '已按标签推荐 $n 个素材（可手动增减）' : '没有命中标签的素材；可到素材库补充标签');
    } on ApiException catch (e) {
      if (mounted) showToast(context, e.message, error: true);
    }
  }

  Future<void> _openUpload() async {
    final name = TextEditingController();
    final desc = TextEditingController();
    final scene = TextEditingController();
    final tagsKey = GlobalKey<TagInputState>();
    final pending = <PendingImage>[];

    await showAppModal(
      context,
      title: '立即上传素材',
      wide: true,
      okText: '保存并加入',
      body: StatefulBuilder(
        builder: (ctx, setLocal) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          _field('名称', TextField(
            controller: name,
            maxLength: 50,
            decoration: const InputDecoration(hintText: '例如：胡桃木摆件', counterText: '')
          )),
          _field('描述', TextField(
            controller: desc,
            maxLength: 500,
            maxLines: 2,
            decoration: const InputDecoration(hintText: '形状/颜色/材质等外观特征（写具体，出图越像）', counterText: '')
          )),
          _field(
            '场景',
            Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              TextField(controller: scene, decoration: const InputDecoration(hintText: '选择或输入场景')),
              if (_scenes.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: [
                      for (final s in _scenes)
                        ActionChip(
                          label: Text(s, style: const TextStyle(fontSize: 12)),
                          visualDensity: VisualDensity.compact,
                          onPressed: () => setLocal(() => scene.text = s)
                        )
                    ]
                  )
                )
            ])
          ),
          _field('标签', TagInput(key: tagsKey)),
          _field(
            '图片',
            ImagePickerField(
              api: widget.api,
              kind: Api.kMaterials,
              images: const [],
              pending: pending,
              onChanged: () => setLocal(() {})
            )
          )
        ])
      ),
      onSubmit: () async {
        final pName = name.text.trim();
        final pScene = scene.text.trim();
        if (pName.isEmpty) {
          showToast(context, '请填写名称', error: true);
          return false;
        }
        if (pScene.isEmpty) {
          showToast(context, '请填写场景', error: true);
          return false;
        }
        if (pending.isEmpty) {
          showToast(context, '请选择一张图片', error: true);
          return false;
        }
        final doc = await widget.api.createLibrary(
          Api.kMaterials,
          name: pName,
          description: desc.text.trim(),
          scene: pScene,
          tags: tagsKey.currentState?.value ?? const []
        );
        final first = pending.first;
        final uploaded = await widget.api.uploadLibraryImage(
          Api.kMaterials,
          doc.id,
          filename: first.name,
          bytes: first.bytes
        );
        final file = uploaded.primaryImage?.file;
        if (mounted) {
          setState(() {
            if (!_picked.contains(doc.id) && _picked.length < 8 && file != null) {
              _picked.add(doc.id);
              _briefs[doc.id] = _MatBrief(id: doc.id, name: doc.name, file: file);
            }
          });
        }
        _matCache = null;
        unawaited(_loadMaterials());
        if (mounted) showToast(context, '素材「${doc.name}」已上传并加入搭配');
        return true;
      }
    );

    name.dispose();
    desc.dispose();
    scene.dispose();
  }

  // ---------- 出图 ----------

  void _startRender(String renderId, {String? parentId}) {
    _session.start(renderId, parent: parentId);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final ctx = _panelKey.currentContext;
      if (ctx != null) {
        Scrollable.ensureVisible(ctx, duration: const Duration(milliseconds: 250));
      }
    });
  }

  Future<void> _submitFree() async {
    final tplId = _tplId;
    if (tplId == null) {
      showToast(context, '请先选择样板', error: true);
      return;
    }
    if (_picked.isEmpty) {
      showToast(context, '请至少选择一个素材', error: true);
      return;
    }
    if (_submitBusy) return;
    _submitBusy = true;
    try {
      final renderId = await widget.api.createRender(Api.freeRenderBody(
        templateId: tplId,
        materialIds: [..._picked],
        positionNote: _freeNote.text.trim(),
        candidateCount: _freeCount
      ));
      _startRender(renderId);
    } on ApiException catch (e) {
      if (mounted) showToast(context, e.message, error: true);
    } finally {
      _submitBusy = false;
    }
  }

  Future<void> _submitPreset() async {
    final p = _preset;
    if (p == null) {
      showToast(context, '请先选择预设', error: true);
      return;
    }
    for (final s in p.slots) {
      if (!_assign.containsKey(s.id)) {
        showToast(context, '插槽「${s.name}」还未选择素材', error: true);
        return;
      }
    }
    if (_submitBusy) return;
    _submitBusy = true;
    try {
      final renderId = await widget.api.createRender(Api.presetRenderBody(
        presetId: p.id,
        assignments: [
          for (final s in p.slots) (slotId: s.id, materialId: _assign[s.id]!.id)
        ],
        positionNote: _presetNote.text.trim(),
        candidateCount: _presetCount
      ));
      _startRender(renderId);
    } on ApiException catch (e) {
      if (mounted) showToast(context, e.message, error: true);
    } finally {
      _submitBusy = false;
    }
  }

  // ---------- 预设模式：选择动作 ----------

  void _selectPreset(Preset p) {
    if (!p.templateValid) {
      showToast(context, '该预设的样板已失效，请先到「预设」修复', error: true);
      return;
    }
    if (p.template?.primary == null) {
      showToast(context, '该预设的样板还没有图片，请先上传', error: true);
      return;
    }
    setState(() {
      _preset = p;
      _assign.clear();
    });
  }

  Future<void> _autoFill() async {
    final p = _preset;
    if (p == null) return;
    try {
      final res = await widget.api.autoFill(p.id);
      final cache = await _ensureMatCache(force: true);
      if (!mounted) return;
      var n = 0;
      setState(() {
        for (final fill in res.slots) {
          final rec = fill.recommended;
          if (rec == null || _assign.containsKey(fill.slotId)) continue;
          final b = cache[rec];
          if (b == null) continue;
          _assign[fill.slotId] = b;
          n++;
        }
      });
      showToast(context, n > 0 ? '已自动填充 $n 个插槽（可点击更换）' : '没有可推荐的素材；请检查插槽标签与素材标签');
    } on ApiException catch (e) {
      if (mounted) showToast(context, e.message, error: true);
    }
  }

  Future<void> _openSlotPicker(Slot slot) async {
    final result = await showDialog<_SlotPick>(
      context: context,
      builder: (_) => _SlotPickerDialog(
        api: widget.api,
        slot: slot,
        assignedId: _assign[slot.id]?.id,
        scenes: _scenes
      )
    );
    if (result == null || !mounted) return;
    setState(() {
      if (result.clear) {
        _assign.remove(slot.id);
      } else if (result.brief != null) {
        _assign[slot.id] = result.brief!;
      }
    });
  }

  // ---------- 构建 ----------

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, c) {
      final wide = c.maxWidth >= 960;
      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        _head(),
        Expanded(
          child: SingleChildScrollView(
            controller: _scroll,
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
            child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              _mode == 'free' ? _freeBody(wide, c.maxHeight) : _presetBody(wide, c.maxHeight),
              const SizedBox(height: 14),
              RenderPanel(key: _panelKey, session: _session)
            ])
          )
        )
      ]);
    });
  }

  Widget _head() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 10),
      child: Row(children: [
        const Text('搭配台', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
        const SizedBox(width: 16),
        SegmentedButton<String>(
          segments: const [
            ButtonSegment(value: 'free', label: Text('自由搭配')),
            ButtonSegment(value: 'preset', label: Text('预设搭配'))
          ],
          selected: {_mode},
          onSelectionChanged: (s) => _switchMode(s.first),
          showSelectedIcon: false,
          style: const ButtonStyle(visualDensity: VisualDensity.compact)
        )
      ])
    );
  }

  // ---------- 自由模式 ----------

  Widget _freeBody(bool wide, double maxHeight) {
    if (wide) {
      final h = (maxHeight - 170).clamp(320.0, double.infinity);
      return SizedBox(
        height: h,
        child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Expanded(child: _templatePanel()),
          const SizedBox(width: 14),
          Expanded(child: _materialPanel()),
          const SizedBox(width: 14),
          Expanded(child: _freeSettingsPanel())
        ])
      );
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      SizedBox(height: 430, child: _templatePanel()),
      const SizedBox(height: 16),
      SizedBox(height: 470, child: _materialPanel()),
      const SizedBox(height: 16),
      _freeSettingsPanel()
    ]);
  }

  Widget _templatePanel() {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      _panelTitle('① 选择样板'),
      const SizedBox(height: 8),
      Wrap(spacing: 10, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
        _sceneSelect(_scenes, _tScene, (v) {
          setState(() => _tScene = v);
          _loadTemplates();
        }),
        _searchField(_tQuery, '搜索样板', (v) {
          _tTimer?.cancel();
          _tTimer = Timer(const Duration(milliseconds: 250), _loadTemplates);
        })
      ]),
      const SizedBox(height: 8),
      Expanded(child: _templateGrid())
    ]);
  }

  Widget _templateGrid() {
    if (_tplError != null) return EmptyState(message: _tplError!);
    if (_tplLoading && _templates.isEmpty) {
      return const Center(child: Text('加载中…', style: TextStyle(color: AppColors.muted)));
    }
    if (_templates.isEmpty) return const EmptyState(message: '没有符合条件的样板');
    return GridView.builder(
      padding: EdgeInsets.zero,
      gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
        maxCrossAxisExtent: 150,
        mainAxisExtent: 168,
        crossAxisSpacing: 10,
        mainAxisSpacing: 10
      ),
      itemCount: _templates.length,
      itemBuilder: (_, i) {
        final t = _templates[i];
        final sel = _tplId == t.id;
        return _pickCell(
          title: t.name,
          imageFile: t.primaryImage?.file,
          badge: sel ? '✓' : null,
          selected: sel,
          onTap: () => _selectTemplate(t)
        );
      }
    );
  }

  Widget _materialPanel() {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Row(children: [
        _panelTitle('② 选择素材'),
        const Spacer(),
        OutlinedButton(
          onPressed: _openUpload,
          style: OutlinedButton.styleFrom(visualDensity: VisualDensity.compact),
          child: const Text('立即上传', style: TextStyle(fontSize: 13))
        ),
        const SizedBox(width: 8),
        OutlinedButton(
          onPressed: _autoRecommend,
          style: OutlinedButton.styleFrom(visualDensity: VisualDensity.compact),
          child: const Text('标签推荐', style: TextStyle(fontSize: 13))
        )
      ]),
      const SizedBox(height: 8),
      Wrap(spacing: 10, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
        _sceneSelect(_scenes, _mScene, (v) {
          setState(() => _mScene = v);
          _loadMaterials();
        }),
        _searchField(_mQuery, '搜索素材', (v) {
          _mTimer?.cancel();
          _mTimer = Timer(const Duration(milliseconds: 250), _loadMaterials);
        })
      ]),
      const SizedBox(height: 8),
      Expanded(child: _materialGrid())
    ]);
  }

  Widget _materialGrid() {
    if (_matError != null) return EmptyState(message: _matError!);
    if (_matLoading && _materials.isEmpty) {
      return const Center(child: Text('加载中…', style: TextStyle(color: AppColors.muted)));
    }
    if (_materials.isEmpty) return const EmptyState(message: '没有符合条件的素材');
    return GridView.builder(
      padding: EdgeInsets.zero,
      gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
        maxCrossAxisExtent: 150,
        mainAxisExtent: 168,
        crossAxisSpacing: 10,
        mainAxisSpacing: 10
      ),
      itemCount: _materials.length,
      itemBuilder: (_, i) {
        final m = _materials[i];
        final order = _picked.indexOf(m.id);
        return _pickCell(
          title: m.name,
          imageFile: m.primaryImage?.file,
          badge: order >= 0 ? '${order + 1}' : null,
          selected: order >= 0,
          onTap: () => _togglePick(m)
        );
      }
    );
  }

  Widget _freeSettingsPanel() {
    return SingleChildScrollView(
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        _panelTitle('③ 出图设置'),
        const SizedBox(height: 10),
        _pickedPreview(),
        const SizedBox(height: 8),
        _field(
          '位置说明',
          TextField(
            controller: _freeNote,
            maxLines: 5,
            maxLength: 1000,
            decoration: const InputDecoration(
              hintText: '例如：花瓶放餐桌中央；留空则由 AI 按常识布局',
              counterText: ''
            )
          ),
          hint: '说明素材应放在样板哪个位置；留空由 AI 自动布局'
        ),
        _field(
          '候选张数',
          _countPicker(_freeCount, (n) => setState(() => _freeCount = n)),
          hint: '多张候选便于挑选，耗时更长'
        ),
        const SizedBox(height: 4),
        FilledButton(onPressed: _submitBusy ? null : _submitFree, child: const Text('生成效果图')),
        const SizedBox(height: 10),
        const Text(kFidelityHint, style: TextStyle(fontSize: 12, color: AppColors.muted, height: 1.5))
      ])
    );
  }

  Widget _pickedPreview() {
    final picked = [
      for (final id in _picked)
        if (_briefs[id] != null) _briefs[id]!
    ];
    final tpl = _tplBrief;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (tpl != null)
        Container(
          padding: const EdgeInsets.all(8),
          margin: const EdgeInsets.only(bottom: 8),
          decoration: BoxDecoration(
            color: AppColors.panel,
            border: Border.all(color: AppColors.line),
            borderRadius: BorderRadius.circular(kRadius - 4)
          ),
          child: Row(children: [
            if (tpl.file != null) _thumb(tpl.file!, 40),
            if (tpl.file != null) const SizedBox(width: 8),
            Expanded(
              child: Text('样板：${tpl.name}',
                  maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600))
            )
          ])
        )
      else
        const Padding(
          padding: EdgeInsets.only(bottom: 8),
          child: Text('尚未选择样板', style: TextStyle(color: AppColors.muted, fontSize: 13))
        ),
      Text('已选素材 ${picked.length}/8', style: const TextStyle(color: AppColors.muted, fontSize: 13)),
      const SizedBox(height: 6),
      for (final b in picked)
        Padding(
          padding: const EdgeInsets.only(bottom: 6),
          child: Row(children: [
            if (b.file != null) _thumb(b.file!, 36),
            if (b.file != null) const SizedBox(width: 8),
            Expanded(child: Text(b.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13))),
            IconButton(
              onPressed: () => setState(() => _picked.remove(b.id)),
              tooltip: '移出搭配',
              visualDensity: VisualDensity.compact,
              icon: const Icon(Icons.close, size: 16)
            )
          ])
        )
    ]);
  }

  // ---------- 预设模式 ----------

  Widget _presetBody(bool wide, double maxHeight) {
    if (wide) {
      final h = (maxHeight - 170).clamp(320.0, double.infinity);
      return SizedBox(
        height: h,
        child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Expanded(flex: 2, child: _presetPickerPanel()),
          const SizedBox(width: 14),
          Expanded(flex: 3, child: _presetDetail())
        ])
      );
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      SizedBox(height: 400, child: _presetPickerPanel()),
      const SizedBox(height: 16),
      _presetDetail()
    ]);
  }

  Widget _presetPickerPanel() {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      _panelTitle('① 选择预设'),
      const SizedBox(height: 8),
      Wrap(spacing: 10, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
        _searchField(_presetQuery, '搜索预设', (v) {
          _pTimer?.cancel();
          _pTimer = Timer(const Duration(milliseconds: 250), _loadPresets);
        })
      ]),
      const SizedBox(height: 8),
      Expanded(child: _presetGrid())
    ]);
  }

  Widget _presetGrid() {
    if (_presetError != null) return EmptyState(message: _presetError!);
    if (_presetLoading && _presets.isEmpty) {
      return const Center(child: Text('加载中…', style: TextStyle(color: AppColors.muted)));
    }
    if (_presets.isEmpty) return const EmptyState(message: '还没有预设；先到「预设」Tab 创建。');
    return GridView.builder(
      padding: EdgeInsets.zero,
      gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
        maxCrossAxisExtent: 170,
        mainAxisExtent: 190,
        crossAxisSpacing: 10,
        mainAxisSpacing: 10
      ),
      itemCount: _presets.length,
      itemBuilder: (_, i) {
        final p = _presets[i];
        final sel = _preset?.id == p.id;
        return _pickCell(
          title: p.name,
          imageFile: p.template?.primary,
          fallback: p.templateValid ? '样板无图' : '样板失效',
          sub: '${p.slots.length} 个插槽 · ${p.template?.name ?? ''}',
          badge: sel ? '✓' : null,
          selected: sel,
          onTap: () => _selectPreset(p)
        );
      }
    );
  }

  Widget _presetDetail() {
    final p = _preset;
    if (p == null) {
      return const EmptyState(message: '先选择上方的一个预设（= 样板 + 插槽标签），再为每个插槽挑素材。');
    }
    final assignedN = p.slots.where((s) => _assign.containsKey(s.id)).length;
    final primary = p.template?.primary;
    return SingleChildScrollView(
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Container(
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
            color: AppColors.panel,
            border: Border.all(color: AppColors.line),
            borderRadius: BorderRadius.circular(kRadius - 4)
          ),
          child: Row(children: [
            if (primary != null) _thumb(primary, 56),
            if (primary != null) const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(p.template?.name ?? '', style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
                Text('${p.slots.length} 个插槽', style: const TextStyle(color: AppColors.muted, fontSize: 12))
              ])
            )
          ])
        ),
        const SizedBox(height: 14),
        Row(children: [
          _panelTitle('② 填充插槽'),
          const SizedBox(width: 10),
          Text('$assignedN/${p.slots.length} 已填', style: const TextStyle(color: AppColors.muted, fontSize: 13)),
          const Spacer(),
          OutlinedButton(
            onPressed: _autoFill,
            style: OutlinedButton.styleFrom(visualDensity: VisualDensity.compact),
            child: const Text('一键自动填充', style: TextStyle(fontSize: 13))
          )
        ]),
        const SizedBox(height: 10),
        Wrap(
          spacing: 12,
          runSpacing: 12,
          children: [
            for (var i = 0; i < p.slots.length; i++)
              SizedBox(width: 280, child: _slotCard(p.slots[i], i + 1))
          ]
        ),
        const SizedBox(height: 14),
        _panelTitle('③ 出图设置'),
        const SizedBox(height: 8),
        _field(
          '补充说明',
          TextField(
            controller: _presetNote,
            maxLines: 3,
            maxLength: 1000,
            decoration: const InputDecoration(hintText: '补充整体位置说明（可留空）', counterText: '')
          ),
          hint: '在预设插槽位置说明之外的整体说明；留空由 AI 布局'
        ),
        _field('候选张数', _countPicker(_presetCount, (n) => setState(() => _presetCount = n))),
        const SizedBox(height: 4),
        FilledButton(onPressed: _submitBusy ? null : _submitPreset, child: const Text('生成效果图')),
        const SizedBox(height: 10),
        const Text(kFidelityHint, style: TextStyle(fontSize: 12, color: AppColors.muted, height: 1.5))
      ])
    );
  }

  Widget _slotCard(Slot s, int idx) {
    final b = _assign[s.id];
    return Material(
      color: AppColors.panel,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(kRadius - 2),
        side: const BorderSide(color: AppColors.line)
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => _openSlotPicker(s),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Container(
                width: 22,
                height: 22,
                alignment: Alignment.center,
                decoration: BoxDecoration(color: AppColors.accentSoft, borderRadius: BorderRadius.circular(999)),
                child: Text('$idx', style: const TextStyle(fontSize: 11, color: AppColors.accent, fontWeight: FontWeight.w600))
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(s.name,
                    maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600))
              )
            ]),
            if (s.tags.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Wrap(
                  spacing: 4,
                  runSpacing: 4,
                  children: [for (final t in s.tags) _tagChip(t)]
                )
              ),
            if (s.positionNote.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(s.positionNote,
                    maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(color: AppColors.muted, fontSize: 12))
              ),
            const Divider(height: 16),
            Row(children: [
              if (b == null)
                const Expanded(
                  child: Text('未选择素材（点击选择）', style: TextStyle(color: AppColors.accent, fontSize: 13))
                )
              else ...[
                if (b.file != null) _thumb(b.file!, 32),
                if (b.file != null) const SizedBox(width: 8),
                Expanded(child: Text(b.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13)))
              ]
            ])
          ])
        )
      )
    );
  }

  // ---------- 小组件 ----------

  Widget _panelTitle(String text) =>
      Text(text, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700));

  Widget _thumb(String file, double size) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(6),
      child: Image.network(
        fileUri(file).toString(),
        width: size,
        height: size,
        fit: BoxFit.cover,
        errorBuilder: (_, _, _) => Container(
          width: size,
          height: size,
          color: AppColors.bg,
          child: const Icon(Icons.broken_image_outlined, size: 16, color: AppColors.muted)
        )
      )
    );
  }
}

// ---------- 顶层小组件（主视图与弹窗共用） ----------

Widget _field(String label, Widget control, {String? hint}) {
  return Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text(label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
      const SizedBox(height: 6),
      control,
      if (hint != null)
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Text(hint, style: const TextStyle(fontSize: 12, color: AppColors.muted))
        )
    ])
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

/// 场景下拉：选项随 [scenes] 异步填充；当前值不在选项内时回落「全部场景」。
Widget _sceneSelect(List<String> scenes, String value, ValueChanged<String> onChanged) {
  final safe = (value.isEmpty || scenes.contains(value)) ? value : '';
  return SizedBox(
    width: 160,
    child: Container(
      height: 40,
      padding: const EdgeInsets.symmetric(horizontal: 10),
      decoration: BoxDecoration(
        color: AppColors.panel,
        border: Border.all(color: AppColors.line),
        borderRadius: BorderRadius.circular(kRadius - 4)
      ),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<String>(
          value: safe,
          isDense: true,
          isExpanded: true,
          style: const TextStyle(fontSize: 14, color: AppColors.text),
          items: [
            const DropdownMenuItem(value: '', child: Text('全部场景', overflow: TextOverflow.ellipsis)),
            for (final s in scenes)
              DropdownMenuItem(value: s, child: Text(s, overflow: TextOverflow.ellipsis))
          ],
          onChanged: (v) => onChanged(v ?? '')
        )
      )
    )
  );
}

/// 搜索框（前缀图标 + 有内容时显示清除按钮）；防抖由调用方接线。
Widget _searchField(TextEditingController ctrl, String hint, ValueChanged<String> onChanged) {
  return SizedBox(
    width: 220,
    child: ValueListenableBuilder<TextEditingValue>(
      valueListenable: ctrl,
      builder: (_, v, _) => TextField(
        controller: ctrl,
        onChanged: onChanged,
        decoration: InputDecoration(
          hintText: hint,
          prefixIcon: const Icon(Icons.search, size: 18),
          suffixIcon: v.text.isEmpty
              ? null
              : IconButton(
                  icon: const Icon(Icons.clear, size: 16),
                  onPressed: () {
                    ctrl.clear();
                    onChanged('');
                  }
                )
        )
      )
    )
  );
}

Widget _countPicker(int value, ValueChanged<int> onChanged) {
  return SegmentedButton<int>(
    segments: const [
      ButtonSegment(value: 1, label: Text('1 张')),
      ButtonSegment(value: 2, label: Text('2 张')),
      ButtonSegment(value: 4, label: Text('4 张'))
    ],
    selected: {value},
    onSelectionChanged: (s) => onChanged(s.first),
    showSelectedIcon: false,
    style: const ButtonStyle(visualDensity: VisualDensity.compact)
  );
}

/// 选择卡片（样板 / 素材 / 预设 / 抽屉素材共用）。
Widget _pickCell({
  required String title,
  String? imageFile,
  String? fallback,
  String? sub,
  String? badge,
  List<String> tags = const [],
  bool selected = false,
  required VoidCallback onTap
}) {
  return Material(
    color: AppColors.panel,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(kRadius - 2),
      side: BorderSide(color: selected ? AppColors.accent : AppColors.line, width: selected ? 2 : 1)
    ),
    clipBehavior: Clip.antiAlias,
    child: InkWell(
      onTap: onTap,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Expanded(
          child: Stack(fit: StackFit.expand, children: [
            if (imageFile != null)
              Image.network(
                fileUri(imageFile).toString(),
                fit: BoxFit.cover,
                loadingBuilder: (_, child, p) => p == null ? child : Container(color: AppColors.bg),
                errorBuilder: (_, _, _) => Container(
                  color: AppColors.bg,
                  alignment: Alignment.center,
                  child: const Text('图片加载失败', style: TextStyle(color: AppColors.muted, fontSize: 11))
                )
              )
            else
              Container(
                color: AppColors.bg,
                alignment: Alignment.center,
                child: Text(fallback ?? '无图', style: const TextStyle(color: AppColors.muted, fontSize: 12))
              ),
            if (badge != null)
              Positioned(
                top: 6,
                right: 6,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                  decoration: BoxDecoration(
                    color: AppColors.accent,
                    borderRadius: BorderRadius.circular(999)
                  ),
                  child: Text(badge, style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w600))
                )
              )
          ])
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
            if (sub != null)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Text(sub, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: AppColors.muted, fontSize: 11))
              ),
            if (tags.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Wrap(spacing: 4, runSpacing: 4, children: [for (final t in tags) _tagChip(t)])
              )
          ])
        )
      ])
    )
  );
}

// ---------- 插槽素材选择弹窗 ----------

class _SlotPick {
  const _SlotPick.assign(_MatBrief this.brief) : clear = false;

  const _SlotPick.clear()
      : brief = null,
        clear = true;

  final _MatBrief? brief;
  final bool clear;
}

class _SlotPickerDialog extends StatefulWidget {
  const _SlotPickerDialog({
    required this.api,
    required this.slot,
    required this.scenes,
    this.assignedId
  });

  final Api api;
  final Slot slot;
  final List<String> scenes;
  final String? assignedId;

  @override
  State<_SlotPickerDialog> createState() => _SlotPickerDialogState();
}

class _SlotPickerDialogState extends State<_SlotPickerDialog> {
  final TextEditingController _query = TextEditingController();
  String _scene = '';
  late bool _tagOnly = widget.slot.tags.isNotEmpty;
  List<LibraryDoc> _items = const [];
  bool _loading = false;
  String? _error;
  int _seq = 0;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void dispose() {
    _timer?.cancel();
    _query.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final my = ++_seq;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await widget.api
          .listLibrary(Api.kMaterials, scene: _scene, q: _query.text.trim(), limit: 500);
      if (my != _seq || !mounted) return;
      setState(() {
        var items = data.items;
        if (_tagOnly && widget.slot.tags.isNotEmpty) {
          items = [
            for (final m in items)
              if (m.tags.any(widget.slot.tags.contains)) m
          ];
        }
        _items = items;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (my != _seq || !mounted) return;
      setState(() {
        _error = e.message;
        _loading = false;
      });
    }
  }

  void _assign(LibraryDoc m) {
    if (m.images.isEmpty) {
      showToast(context, '该素材还没有图片，请先上传', error: true);
      return;
    }
    Navigator.of(context)
        .pop(_SlotPick.assign(_MatBrief(id: m.id, name: m.name, file: m.images.first.file)));
  }

  @override
  Widget build(BuildContext context) {
    final slot = widget.slot;
    return Dialog(
      insetPadding: const EdgeInsets.all(24),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 840, maxHeight: 640),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 14, 12, 10),
            child: Row(children: [
              Expanded(
                child: Text('为插槽「${slot.name}」选择素材',
                    maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700))
              ),
              if (widget.assignedId != null)
                TextButton(
                  onPressed: () => Navigator.of(context).pop(const _SlotPick.clear()),
                  style: TextButton.styleFrom(foregroundColor: AppColors.danger),
                  child: const Text('清除')
                ),
              TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('关闭'))
            ])
          ),
          const Divider(height: 1),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 12, 20, 8),
            child: Wrap(spacing: 10, runSpacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
              _sceneSelect(widget.scenes, _scene, (v) {
                setState(() => _scene = v);
                _load();
              }),
              _searchField(_query, '搜索素材', (v) {
                _timer?.cancel();
                _timer = Timer(const Duration(milliseconds: 250), _load);
              }),
              if (slot.tags.isNotEmpty)
                InkWell(
                  onTap: () {
                    setState(() => _tagOnly = !_tagOnly);
                    _load();
                  },
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    Checkbox(
                      value: _tagOnly,
                      visualDensity: VisualDensity.compact,
                      onChanged: (v) {
                        setState(() => _tagOnly = v ?? false);
                        _load();
                      }
                    ),
                    const Text('仅匹配插槽标签')
                  ])
                )
            ])
          ),
          Expanded(child: Padding(padding: const EdgeInsets.fromLTRB(20, 0, 20, 16), child: _body()))
        ])
      )
    );
  }

  Widget _body() {
    if (_error != null) return EmptyState(message: _error!);
    if (_loading && _items.isEmpty) {
      return const Center(child: Text('加载中…', style: TextStyle(color: AppColors.muted)));
    }
    if (_items.isEmpty) return const EmptyState(message: '没有符合条件的素材');
    return GridView.builder(
      padding: EdgeInsets.zero,
      gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
        maxCrossAxisExtent: 170,
        mainAxisExtent: 200,
        crossAxisSpacing: 10,
        mainAxisSpacing: 10
      ),
      itemCount: _items.length,
      itemBuilder: (_, i) {
        final m = _items[i];
        return _pickCell(
          title: m.name,
          imageFile: m.primaryImage?.file,
          tags: m.tags.take(2).toList(),
          selected: m.id == widget.assignedId,
          onTap: () => _assign(m)
        );
      }
    );
  }
}
