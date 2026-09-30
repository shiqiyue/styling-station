/// 预设页面：列表（含样板失效/已删除徽标、复制/删除/恢复）
/// + 编辑器（选样板 + 1~10 个插槽：名称/标签/位置说明/上移下移删除）。
/// 对齐基准：web/views/presets.js。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../config.dart';
import '../data/api_client.dart';
import '../data/models.dart';
import '../state/presets_state.dart';
import '../theme.dart';
import '../widgets/app_modal.dart';
import '../widgets/empty_state.dart';
import '../widgets/tag_input.dart';
import '../widgets/toast.dart';

class PresetsView extends StatefulWidget {
  const PresetsView({super.key, required this.api});

  final Api api;

  @override
  State<PresetsView> createState() => _PresetsViewState();
}

class _PresetsViewState extends State<PresetsView> {
  late final PresetsState _state = PresetsState(api: widget.api);

  @override
  void initState() {
    super.initState();
    _state.reload();
  }

  @override
  void dispose() {
    _state.dispose();
    super.dispose();
  }

  Future<void> _openEditor(Preset? preset) async {
    final key = GlobalKey<PresetEditorState>();
    final submitted = await showAppModal(
      context,
      title: preset == null ? '新建预设' : '编辑预设',
      wide: true,
      body: PresetEditor(key: key, api: widget.api, preset: preset),
      onSubmit: () => key.currentState!.submit()
    );
    if (submitted && mounted) await _state.reload();
  }

  Future<void> _duplicate(Preset p) async {
    try {
      final copy = await widget.api.duplicatePreset(p.id);
      if (!mounted) return;
      showToast(context, '已复制为「${copy.name}」');
      await _state.reload();
    } on ApiException catch (e) {
      if (mounted) showToast(context, e.message, error: true);
    }
  }

  Future<void> _delete(Preset p) async {
    final ok = await confirmDialog(context, '删除预设「${p.name}」？');
    if (!ok || !mounted) return;
    try {
      await widget.api.deletePreset(p.id);
      if (!mounted) return;
      showToast(context, '已删除');
      await _state.reload();
    } on ApiException catch (e) {
      if (mounted) showToast(context, e.message, error: true);
    }
  }

  Future<void> _restore(Preset p) async {
    try {
      await widget.api.undeletePreset(p.id);
      if (!mounted) return;
      showToast(context, '已恢复「${p.name}」');
      await _state.reload();
    } on ApiException catch (e) {
      if (mounted) showToast(context, e.message, error: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _state,
      builder: (context, _) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
            child: Row(
              children: [
                const Text('预设', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                const Spacer(),
                FilledButton(onPressed: () => _openEditor(null), child: const Text('新建预设'))
              ]
            )
          ),
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Text(
              '预设 = 一个样板 + 若干插槽（每个插槽配好标签与位置说明）；搭配台按预设一键填充。',
              style: TextStyle(fontSize: 13, color: AppColors.muted)
            )
          ),
          if (_state.loading && _state.items.isNotEmpty) const LinearProgressIndicator(minHeight: 2),
          Expanded(child: _body())
        ]
      )
    );
  }

  Widget _body() {
    if (_state.error != null) return EmptyState(message: _state.error!, icon: Icons.error_outline);
    if (_state.loading && _state.items.isEmpty) return const Center(child: CircularProgressIndicator());
    if (_state.items.isEmpty) {
      return const EmptyState(message: '还没有预设；点「新建预设」选择样板并添加插槽。', icon: Icons.tune);
    }
    return RefreshIndicator(
      onRefresh: _state.reload,
      child: GridView.builder(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
        gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
          maxCrossAxisExtent: 260,
          mainAxisSpacing: 12,
          crossAxisSpacing: 12,
          mainAxisExtent: 300
        ),
        itemCount: _state.items.length,
        itemBuilder: (_, i) => _card(_state.items[i])
      )
    );
  }

  Widget _card(Preset p) {
    return Card(
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(height: 150, width: double.infinity, child: _thumb(p)),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(10, 8, 10, 6),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          p.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontWeight: FontWeight.w600)
                        )
                      ),
                      if (!p.templateValid)
                        const _MiniBadge(text: '样板失效', color: AppColors.danger)
                      else if (p.deleted)
                        const _MiniBadge(text: '已删除', color: AppColors.danger)
                    ]
                  ),
                  const SizedBox(height: 4),
                  Text(
                    '${p.slots.length} 个插槽${p.template != null ? ' · ${p.template!.name}' : ''}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 12, color: AppColors.muted)
                  ),
                  const SizedBox(height: 4),
                  Text(
                    p.slots.map((s) => s.name).join(' · '),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 12, color: AppColors.muted)
                  ),
                  const Spacer(),
                  Row(
                    children: p.deleted
                        ? [
                            TextButton(
                              style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
                              onPressed: () => _restore(p),
                              child: const Text('恢复')
                            )
                          ]
                        : [
                            TextButton(
                              style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
                              onPressed: () => _openEditor(p),
                              child: const Text('编辑')
                            ),
                            TextButton(
                              style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
                              onPressed: () => _duplicate(p),
                              child: const Text('复制')
                            ),
                            TextButton(
                              style: TextButton.styleFrom(
                                visualDensity: VisualDensity.compact,
                                foregroundColor: AppColors.danger
                              ),
                              onPressed: () => _delete(p),
                              child: const Text('删除')
                            )
                          ]
                  )
                ]
              )
            )
          )
        ]
      )
    );
  }

  Widget _thumb(Preset p) {
    final primary = p.template?.primary;
    if (primary == null) {
      return Container(
        color: AppColors.bg,
        alignment: Alignment.center,
        child: Text(
          p.templateValid ? '样板无图' : '样板失效',
          style: const TextStyle(color: AppColors.muted, fontSize: 12)
        )
      );
    }
    return Image.network(
      fileUri(primary).toString(),
      fit: BoxFit.cover,
      errorBuilder: (_, _, _) => Container(
        color: AppColors.bg,
        alignment: Alignment.center,
        child: const Icon(Icons.broken_image_outlined, color: AppColors.muted)
      )
    );
  }
}

class _MiniBadge extends StatelessWidget {
  const _MiniBadge({required this.text, required this.color});

  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(left: 6),
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.1), borderRadius: BorderRadius.circular(999)),
      child: Text(text, style: TextStyle(fontSize: 11, color: color))
    );
  }
}

/// 插槽草稿（编辑器内部状态；提交时映射为 [Slot]，id 由服务端按位置重排）。
class _SlotDraft {
  _SlotDraft(this.key);

  final int key;
  final TextEditingController name = TextEditingController();
  final TextEditingController note = TextEditingController();
  List<String> tags = [];

  void dispose() {
    name.dispose();
    note.dispose();
  }
}

/// 预设编辑器正文；提交逻辑由外壳（showAppModal）经 GlobalKey 调用 [submit]。
class PresetEditor extends StatefulWidget {
  const PresetEditor({super.key, required this.api, this.preset});

  final Api api;
  final Preset? preset;

  @override
  State<PresetEditor> createState() => PresetEditorState();
}

class PresetEditorState extends State<PresetEditor> {
  late final TextEditingController _name = TextEditingController(text: widget.preset?.name ?? '');
  TemplateBrief? _template;
  late final List<_SlotDraft> _slots;
  int _nextKey = 1;

  bool get _isNew => widget.preset == null;

  @override
  void initState() {
    super.initState();
    _template = widget.preset?.template;
    _slots = [
      for (final s in widget.preset?.slots ?? const <Slot>[])
        _SlotDraft(_nextKey++)
          ..name.text = s.name
          ..note.text = s.positionNote
          ..tags = [...s.tags]
    ];
  }

  @override
  void dispose() {
    _name.dispose();
    for (final s in _slots) {
      s.dispose();
    }
    super.dispose();
  }

  Future<bool> submit() async {
    final name = _name.text.trim();
    if (name.isEmpty) {
      showToast(context, '请填写预设名称', error: true);
      return false;
    }
    final template = _template;
    if (template == null) {
      showToast(context, '请先选择样板', error: true);
      return false;
    }
    if (_slots.isEmpty) {
      showToast(context, '至少添加 1 个插槽', error: true);
      return false;
    }
    final slots = [
      for (var i = 0; i < _slots.length; i++)
        Slot(
          id: 's-${i + 1}',
          name: _slots[i].name.text.trim().isEmpty ? '插槽 ${i + 1}' : _slots[i].name.text.trim(),
          tags: _slots[i].tags,
          positionNote: _slots[i].note.text.trim()
        )
    ];
    if (_isNew) {
      await widget.api.createPreset(name: name, templateId: template.id, slots: slots);
      if (mounted) showToast(context, '预设「$name」已创建');
    } else {
      await widget.api.updatePreset(widget.preset!.id, name: name, templateId: template.id, slots: slots);
      if (mounted) showToast(context, '已保存');
    }
    return true;
  }

  Future<void> _pickTemplate() async {
    final picked = await showDialog<TemplateBrief>(
      context: context,
      builder: (_) => _TemplatePickerDialog(api: widget.api, currentId: _template?.id)
    );
    if (picked != null && mounted) setState(() => _template = picked);
  }

  void _addSlot() {
    if (_slots.length >= 10) {
      showToast(context, '最多 10 个插槽', error: true);
      return;
    }
    setState(() => _slots.add(_SlotDraft(_nextKey++)));
  }

  void _removeSlot(int i) {
    setState(() => _slots.removeAt(i).dispose());
  }

  void _swap(int a, int b) {
    setState(() {
      final t = _slots[a];
      _slots[a] = _slots[b];
      _slots[b] = t;
    });
  }

  @override
  Widget build(BuildContext context) {
    final template = _template;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        _field(
          '预设名称',
          TextField(
            controller: _name,
            inputFormatters: [LengthLimitingTextInputFormatter(50)],
            decoration: const InputDecoration(hintText: '例如：卧室基础搭配')
          )
        ),
        _field(
          '样板（场景底板）',
          template == null
              ? OutlinedButton.icon(
                  onPressed: _pickTemplate,
                  icon: const Icon(Icons.image_outlined, size: 18),
                  label: const Text('选择样板')
                )
              : Row(
                  children: [
                    ClipRRect(
                      borderRadius: BorderRadius.circular(8),
                      child: SizedBox(
                        width: 56,
                        height: 56,
                        child: template.primary == null
                            ? Container(
                                color: AppColors.bg,
                                alignment: Alignment.center,
                                child: const Text('无图', style: TextStyle(fontSize: 11, color: AppColors.muted))
                              )
                            : Image.network(fileUri(template.primary!).toString(), fit: BoxFit.cover)
                      )
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(template.name, style: const TextStyle(fontWeight: FontWeight.w600)),
                          if (template.primary == null)
                            const Text(
                              '（该样板暂无图片，出图前需上传）',
                              style: TextStyle(fontSize: 12, color: AppColors.warn)
                            )
                        ]
                      )
                    ),
                    OutlinedButton(onPressed: _pickTemplate, child: const Text('更换样板'))
                  ]
                )
        ),
        _field(
          '插槽列表',
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (_slots.isEmpty)
                const Padding(
                  padding: EdgeInsets.only(bottom: 8),
                  child: Text(
                    '还没有插槽，点下方「添加插槽」（1~10 个）',
                    style: TextStyle(fontSize: 13, color: AppColors.muted)
                  )
                ),
              for (var i = 0; i < _slots.length; i++) _slotRow(i),
              OutlinedButton.icon(
                onPressed: _slots.length >= 10 ? null : _addSlot,
                icon: const Icon(Icons.add, size: 18),
                label: const Text('添加插槽')
              )
            ]
          ),
          hint: '每个插槽对应一个素材位置；插槽标签用于自动填充与推荐'
        )
      ]
    );
  }

  Widget _slotRow(int i) {
    final d = _slots[i];
    return Container(
      key: ValueKey(d.key),
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: AppColors.bg,
        borderRadius: BorderRadius.circular(kRadius - 4),
        border: Border.all(color: AppColors.line)
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text('#${i + 1}', style: const TextStyle(color: AppColors.muted, fontSize: 13)),
              const SizedBox(width: 8),
              Expanded(
                child: TextField(
                  controller: d.name,
                  inputFormatters: [LengthLimitingTextInputFormatter(20)],
                  decoration: const InputDecoration(hintText: '插槽名称（如：墙纸）')
                )
              ),
              IconButton(
                visualDensity: VisualDensity.compact,
                tooltip: '上移',
                onPressed: i == 0 ? null : () => _swap(i, i - 1),
                icon: const Icon(Icons.arrow_upward, size: 18)
              ),
              IconButton(
                visualDensity: VisualDensity.compact,
                tooltip: '下移',
                onPressed: i == _slots.length - 1 ? null : () => _swap(i, i + 1),
                icon: const Icon(Icons.arrow_downward, size: 18)
              ),
              IconButton(
                visualDensity: VisualDensity.compact,
                tooltip: '删除插槽',
                onPressed: () => _removeSlot(i),
                icon: const Icon(Icons.close, size: 18, color: AppColors.danger)
              )
            ]
          ),
          const SizedBox(height: 8),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Padding(
                padding: EdgeInsets.only(top: 10),
                child: Text('标签：', style: TextStyle(fontSize: 13, color: AppColors.muted))
              ),
              Expanded(
                child: TagInput(initialValue: d.tags, max: 10, onChanged: (v) => d.tags = v)
              )
            ]
          ),
          const SizedBox(height: 8),
          TextField(
            controller: d.note,
            inputFormatters: [LengthLimitingTextInputFormatter(200)],
            decoration: const InputDecoration(hintText: '位置说明（如：卧室右侧墙面）')
          )
        ]
      )
    );
  }

  Widget _field(String label, Widget control, {String? hint}) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          control,
          if (hint != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(hint, style: const TextStyle(fontSize: 12, color: AppColors.muted))
            )
        ]
      )
    );
  }
}

/// 样板选择弹窗：场景筛选 + 250ms 搜索 + 卡片单选；
/// 无图样板不可选（toast 提示）。点选后返回 [TemplateBrief]。
class _TemplatePickerDialog extends StatefulWidget {
  const _TemplatePickerDialog({required this.api, this.currentId});

  final Api api;
  final String? currentId;

  @override
  State<_TemplatePickerDialog> createState() => _TemplatePickerDialogState();
}

class _TemplatePickerDialogState extends State<_TemplatePickerDialog> {
  final TextEditingController _searchCtrl = TextEditingController();
  Timer? _searchTimer;
  String _scene = '';
  String _q = '';
  List<String> _scenes = [];
  List<LibraryDoc> _items = [];
  bool _loading = true;
  String? _error;

  int _seq = 0;

  @override
  void initState() {
    super.initState();
    _loadScenes();
    _load();
  }

  @override
  void dispose() {
    _searchTimer?.cancel();
    _searchCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadScenes() async {
    try {
      final meta = await widget.api.scenes();
      if (mounted) setState(() => _scenes = meta.scenes);
    } on ApiException {
      /* 场景不可用时仍可搜索 */
    }
  }

  Future<void> _load() async {
    final seq = ++_seq;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final page = await widget.api.listLibrary(
        Api.kTemplates,
        scene: _scene,
        q: _q,
        limit: 200
      );
      if (!mounted || seq != _seq) return;
      setState(() {
        _items = page.items;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted || seq != _seq) return;
      setState(() {
        _items = [];
        _error = e.message;
        _loading = false;
      });
    }
  }

  void _onSearch(String v) {
    _searchTimer?.cancel();
    _searchTimer = Timer(const Duration(milliseconds: 250), () {
      _q = v.trim();
      _load();
    });
  }

  void _choose(LibraryDoc t) {
    if (t.images.isEmpty) {
      showToast(context, '该样板还没有图片，请先到「样板库」上传', error: true);
      return;
    }
    Navigator.of(context).pop(
      TemplateBrief(id: t.id, name: t.name, images: t.images, primary: t.images.first.file)
    );
  }

  @override
  Widget build(BuildContext context) {
    return Dialog(
      insetPadding: const EdgeInsets.all(24),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 640),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 16, 20, 12),
              child: Text('选择样板', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700))
            ),
            const Divider(height: 1),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 4),
              child: Wrap(
                spacing: 12,
                runSpacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  SizedBox(
                    width: 160,
                    child: DropdownButtonFormField<String>(
                      initialValue: _scene,
                      isDense: true,
                      items: [
                        const DropdownMenuItem(value: '', child: Text('全部场景')),
                        for (final s in _scenes) DropdownMenuItem(value: s, child: Text(s, overflow: TextOverflow.ellipsis))
                      ],
                      onChanged: (v) {
                        _scene = v ?? '';
                        _load();
                      }
                    )
                  ),
                  SizedBox(
                    width: 220,
                    child: TextField(
                      controller: _searchCtrl,
                      onChanged: _onSearch,
                      decoration: const InputDecoration(
                        hintText: '搜索样板名称/描述',
                        prefixIcon: Icon(Icons.search, size: 18)
                      )
                    )
                  )
                ]
              )
            ),
            Flexible(child: SizedBox(height: 380, child: _grid())),
            const Divider(height: 1),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('关闭'))
                ]
              )
            )
          ]
        )
      )
    );
  }

  Widget _grid() {
    if (_error != null) return EmptyState(message: _error!, icon: Icons.error_outline);
    if (_loading && _items.isEmpty) return const Center(child: CircularProgressIndicator());
    if (_items.isEmpty) return const EmptyState(message: '没有符合条件的样板', icon: Icons.inbox_outlined);
    return GridView.builder(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 8),
      gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
        maxCrossAxisExtent: 200,
        mainAxisSpacing: 10,
        crossAxisSpacing: 10,
        mainAxisExtent: 190
      ),
      itemCount: _items.length,
      itemBuilder: (_, i) {
        final t = _items[i];
        final selected = t.id == widget.currentId;
        return InkWell(
          onTap: () => _choose(t),
          borderRadius: BorderRadius.circular(kRadius - 4),
          child: Container(
            decoration: BoxDecoration(
              color: AppColors.panel,
              borderRadius: BorderRadius.circular(kRadius - 4),
              border: Border.all(color: selected ? AppColors.accent : AppColors.line, width: selected ? 2 : 1)
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ClipRRect(
                  borderRadius: const BorderRadius.vertical(top: Radius.circular(kRadius - 4)),
                  child: SizedBox(
                    height: 110,
                    width: double.infinity,
                    child: t.images.isEmpty
                        ? Container(
                            color: AppColors.bg,
                            alignment: Alignment.center,
                            child: const Text('无图', style: TextStyle(fontSize: 12, color: AppColors.muted))
                          )
                        : Image.network(fileUri(t.images.first.file).toString(), fit: BoxFit.cover)
                  )
                ),
                Padding(
                  padding: const EdgeInsets.all(8),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(t.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600)),
                      Text(t.scene, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: AppColors.muted))
                    ]
                  )
                )
              ]
            )
          )
        );
      }
    );
  }
}
