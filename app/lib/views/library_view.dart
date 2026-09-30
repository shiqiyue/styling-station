/// 素材库 / 样板库（参数化同构视图）：筛选栏（场景/搜索/已删除/标签 chips）
/// + 卡片网格（编辑/删除/恢复）+ 新建/编辑弹窗（字段 + 图片上传）。
/// 对齐基准：web/views/library.js + web/lib/dom.js。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../config.dart';
import '../data/api_client.dart';
import '../data/models.dart';
import '../state/library_state.dart';
import '../theme.dart';
import '../widgets/app_modal.dart';
import '../widgets/empty_state.dart';
import '../widgets/image_picker_field.dart';
import '../widgets/tag_input.dart';
import '../widgets/toast.dart';

export '../data/models.dart' show LibraryKind;

class LibraryView extends StatefulWidget {
  const LibraryView({super.key, required this.api, required this.kind});

  final Api api;
  final LibraryKind kind;

  @override
  State<LibraryView> createState() => _LibraryViewState();
}

class _LibraryViewState extends State<LibraryView> {
  late final LibraryState _state = LibraryState(api: widget.api, kind: widget.kind);
  final TextEditingController _searchCtrl = TextEditingController();
  Timer? _searchTimer;

  String get _noun => widget.kind.noun;
  String get _kind => widget.kind.kind;

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    await _state.init();
    if (!mounted) return;
    final err = _state.metaError;
    if (err != null) showToast(context, err, error: true);
  }

  @override
  void dispose() {
    _searchTimer?.cancel();
    _searchCtrl.dispose();
    _state.dispose();
    super.dispose();
  }

  void _onSearchChanged(String v) {
    _searchTimer?.cancel();
    _searchTimer = Timer(const Duration(milliseconds: 250), () {
      if (mounted) _state.setQuery(v.trim());
    });
  }

  Future<void> _openEditor(LibraryDoc? item) async {
    final key = GlobalKey<LibraryEditorState>();
    final submitted = await showAppModal(
      context,
      title: item == null ? '新建$_noun' : '编辑$_noun',
      wide: true,
      body: LibraryEditor(key: key, api: widget.api, kind: widget.kind, item: item, scenes: _state.scenes),
      onSubmit: () => key.currentState!.submit()
    );
    if (submitted && mounted) await _state.reload();
  }

  Future<void> _delete(LibraryDoc item) async {
    final ok = await confirmDialog(context, '删除$_noun「${item.name}」？删除后可在「显示已删除」里恢复。');
    if (!ok || !mounted) return;
    try {
      await widget.api.deleteLibrary(_kind, item.id);
      if (!mounted) return;
      showToast(context, '已删除');
      await _state.reload();
    } on ApiException catch (e) {
      if (mounted) showToast(context, e.message, error: true);
    }
  }

  Future<void> _restore(LibraryDoc item) async {
    try {
      await widget.api.undeleteLibrary(_kind, item.id);
      if (!mounted) return;
      showToast(context, '已恢复「${item.name}」');
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
        children: [_head(), _filterBar(), _tagsRow(), if (_state.loading && _state.items.isNotEmpty) const LinearProgressIndicator(minHeight: 2), Expanded(child: _body())]
      )
    );
  }

  Widget _head() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
      child: Row(
        children: [
          Text('$_noun库', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
          const Spacer(),
          FilledButton(onPressed: () => _openEditor(null), child: Text('新建$_noun'))
        ]
      )
    );
  }

  Widget _filterBar() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
      child: Wrap(
        spacing: 12,
        runSpacing: 8,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          SizedBox(
            width: 180,
            child: DropdownButtonFormField<String>(
              initialValue: _state.scene,
              isDense: true,
              items: [
                const DropdownMenuItem(value: '', child: Text('全部场景')),
                for (final s in _state.scenes) DropdownMenuItem(value: s, child: Text(s, overflow: TextOverflow.ellipsis))
              ],
              onChanged: (v) => _state.setScene(v ?? '')
            )
          ),
          SizedBox(
            width: 260,
            child: TextField(
              controller: _searchCtrl,
              onChanged: _onSearchChanged,
              decoration: InputDecoration(
                hintText: '搜索$_noun名称/描述',
                prefixIcon: const Icon(Icons.search, size: 18),
                suffixIcon: _searchCtrl.text.isEmpty
                    ? null
                    : IconButton(
                        icon: const Icon(Icons.clear, size: 16),
                        onPressed: () {
                          _searchCtrl.clear();
                          _searchTimer?.cancel();
                          _state.setQuery('');
                        }
                      )
              )
            )
          ),
          InkWell(
            onTap: () => _state.setIncludeDeleted(!_state.includeDeleted),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Checkbox(
                  value: _state.includeDeleted,
                  visualDensity: VisualDensity.compact,
                  onChanged: (v) => _state.setIncludeDeleted(v ?? false)
                ),
                const Text('显示已删除')
              ]
            )
          )
        ]
      )
    );
  }

  Widget _tagsRow() {
    final tags = _state.knownTags;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.only(top: 8),
            child: Text('标签：', style: TextStyle(color: AppColors.muted, fontSize: 13))
          ),
          Expanded(
            child: tags.isEmpty
                ? const Padding(
                    padding: EdgeInsets.only(top: 8),
                    child: Text('暂无已用标签', style: TextStyle(color: AppColors.muted, fontSize: 13))
                  )
                : Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: [
                      for (final t in tags)
                        FilterChip(
                          label: Text(t, style: const TextStyle(fontSize: 12)),
                          selected: _state.tags.contains(t),
                          showCheckmark: false,
                          visualDensity: VisualDensity.compact,
                          selectedColor: AppColors.accentSoft,
                          onSelected: (_) => _state.toggleTag(t)
                        )
                    ]
                  )
          )
        ]
      )
    );
  }

  Widget _body() {
    if (_state.error != null) return EmptyState(message: _state.error!, icon: Icons.error_outline);
    if (_state.loading && _state.items.isEmpty) return const Center(child: CircularProgressIndicator());
    if (_state.items.isEmpty) {
      return EmptyState(message: '没有符合条件的$_noun；点右上角「新建$_noun」添加。', icon: Icons.inbox_outlined);
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

  Widget _card(LibraryDoc item) {
    return Card(
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(height: 150, width: double.infinity, child: _thumb(item)),
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
                          item.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontWeight: FontWeight.w600)
                        )
                      ),
                      if (item.deleted)
                        const _MiniBadge(text: '已删除', color: AppColors.danger)
                      else if (item.images.isEmpty)
                        const _MiniBadge(text: '待传图', color: AppColors.warn)
                    ]
                  ),
                  const SizedBox(height: 4),
                  Text(
                    [item.scene, ...item.tags.take(5)].where((s) => s.isNotEmpty).join(' · '),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 12, color: AppColors.muted)
                  ),
                  const Spacer(),
                  Row(
                    children: item.deleted
                        ? [
                            TextButton(
                              style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
                              onPressed: () => _restore(item),
                              child: const Text('恢复')
                            )
                          ]
                        : [
                            TextButton(
                              style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
                              onPressed: () => _openEditor(item),
                              child: const Text('编辑')
                            ),
                            TextButton(
                              style: TextButton.styleFrom(
                                visualDensity: VisualDensity.compact,
                                foregroundColor: AppColors.danger
                              ),
                              onPressed: () => _delete(item),
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

  Widget _thumb(LibraryDoc item) {
    final img = item.primaryImage;
    if (img == null) {
      return Container(
        color: AppColors.bg,
        alignment: Alignment.center,
        child: const Text('无图片', style: TextStyle(color: AppColors.muted, fontSize: 12))
      );
    }
    return Image.network(
      fileUri(img.file).toString(),
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
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(999)
      ),
      child: Text(text, style: TextStyle(fontSize: 11, color: color))
    );
  }
}

/// 新建 / 编辑弹窗正文；提交逻辑由外壳（showAppModal）经 GlobalKey 调用 [submit]。
class LibraryEditor extends StatefulWidget {
  const LibraryEditor({super.key, required this.api, required this.kind, this.item, required this.scenes});

  final Api api;
  final LibraryKind kind;
  final LibraryDoc? item;
  final List<String> scenes;

  @override
  State<LibraryEditor> createState() => LibraryEditorState();
}

class LibraryEditorState extends State<LibraryEditor> {
  late final TextEditingController _name = TextEditingController(text: widget.item?.name ?? '');
  late final TextEditingController _desc = TextEditingController(text: widget.item?.description ?? '');
  late final TextEditingController _scene = TextEditingController(text: widget.item?.scene ?? '');
  late List<String> _tags = [...(widget.item?.tags ?? const <String>[])];
  late final List<ImageRef> _images = [...(widget.item?.images ?? const <ImageRef>[])];
  final List<PendingImage> _pending = [];

  bool get _isNew => widget.item == null;

  @override
  void dispose() {
    _name.dispose();
    _desc.dispose();
    _scene.dispose();
    super.dispose();
  }

  /// 提交：校验失败返回 false（弹窗保持打开）；接口错误抛出交给弹窗外壳 toast。
  Future<bool> submit() async {
    final label = widget.kind.noun;
    final payload = (
      name: _name.text.trim(),
      description: _desc.text.trim(),
      scene: _scene.text.trim(),
      tags: _tags
    );
    if (payload.name.isEmpty) {
      showToast(context, '请填写名称', error: true);
      return false;
    }
    if (payload.scene.isEmpty) {
      showToast(context, '请填写场景', error: true);
      return false;
    }
    if (_isNew) {
      final doc = await widget.api.createLibrary(
        widget.kind.kind,
        name: payload.name,
        description: payload.description,
        scene: payload.scene,
        tags: payload.tags
      );
      var done = 0;
      for (final f in _pending) {
        try {
          await widget.api.uploadLibraryImage(widget.kind.kind, doc.id, filename: f.name, bytes: f.bytes);
          done++;
        } on ApiException catch (e) {
          if (mounted) showToast(context, '${f.name}：${e.message}', error: true);
        }
      }
      if (mounted) {
        showToast(context, '$label「${doc.name}」已创建${done > 0 ? '，上传 $done 张图片' : ''}');
      }
    } else {
      await widget.api.updateLibrary(
        widget.kind.kind,
        widget.item!.id,
        name: payload.name,
        description: payload.description,
        scene: payload.scene,
        tags: payload.tags
      );
      if (mounted) showToast(context, '已保存');
    }
    return true;
  }

  @override
  Widget build(BuildContext context) {
    final label = widget.kind.noun;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        _field(
          '名称',
          TextField(
            controller: _name,
            inputFormatters: [LengthLimitingTextInputFormatter(50)],
            decoration: InputDecoration(hintText: label == '素材' ? '例如：胡桃木摆件' : '例如：奶油风卧室')
          )
        ),
        _field(
          '描述',
          TextField(
            controller: _desc,
            maxLines: 3,
            inputFormatters: [LengthLimitingTextInputFormatter(500)],
            decoration: const InputDecoration(hintText: '形状/颜色/材质等外观特征（写具体，出图越像）')
          )
        ),
        _field(
          '场景',
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TextField(controller: _scene, decoration: const InputDecoration(hintText: '选择或输入场景')),
              if (widget.scenes.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: [
                      for (final s in widget.scenes)
                        ActionChip(
                          label: Text(s, style: const TextStyle(fontSize: 12)),
                          visualDensity: VisualDensity.compact,
                          onPressed: () => setState(() => _scene.text = s)
                        )
                    ]
                  )
                )
            ]
          )
        ),
        _field('标签', TagInput(initialValue: _tags, onChanged: (v) => _tags = v)),
        _field(
          '图片',
          ImagePickerField(
            api: widget.api,
            kind: widget.kind.kind,
            docId: widget.item?.id,
            images: _images,
            pending: _pending,
            onChanged: () => setState(() {})
          )
        )
      ]
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
