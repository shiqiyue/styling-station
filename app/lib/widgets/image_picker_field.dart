/// 图片上传区：多选、缩略图、主图标记（第一张）、删除（含 LAST_IMAGE 等接口错误展示）。
///
/// - [docId] == null（新建模式）：选中的文件先暂存进 [pending]，保存时由调用方上传；
/// - [docId] != null（编辑模式）：选中即上传（单张失败单独提示），删除走接口；
/// - [images] / [pending] 由调用方持有，本组件按旧版 uploader 的引用语义直接更新列表，
///   然后调用 [onChanged] 通知调用方重建。
library;

import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../config.dart';
import '../data/api_client.dart';
import '../data/models.dart';
import '../theme.dart';
import 'app_modal.dart';
import 'optimize_dialog.dart';
import 'toast.dart';

/// 待上传图片（新建模式的本地暂存）。
class PendingImage {
  const PendingImage({required this.name, required this.bytes});

  final String name;
  final Uint8List bytes;
}

class ImagePickerField extends StatefulWidget {
  const ImagePickerField({
    super.key,
    required this.api,
    required this.kind,
    this.docId,
    required this.images,
    required this.pending,
    required this.onChanged
  });

  final Api api;

  /// 'materials' / 'templates'。
  final String kind;

  /// 非空 = 编辑模式（上传即生效）。
  final String? docId;

  final List<ImageRef> images;
  final List<PendingImage> pending;
  final VoidCallback onChanged;

  static const int maxBytes = 10 * 1024 * 1024;

  @override
  State<ImagePickerField> createState() => _ImagePickerFieldState();
}

class _ImagePickerFieldState extends State<ImagePickerField> {
  final ImagePicker _picker = ImagePicker();
  bool _picking = false;

  @override
  void initState() {
    super.initState();
    _recoverLostData();
  }

  /// Android 选择期间 Activity 被回收时，恢复上次选择结果（image_picker 官方建议）。
  Future<void> _recoverLostData() async {
    try {
      final resp = await _picker.retrieveLostData();
      if (resp.isEmpty) return;
      final files = resp.files;
      if (files == null || files.isEmpty) return;
      await _acceptPicked(files);
    } catch (_) {
      /* 无插件实现（测试/桌面）时忽略 */
    }
  }

  Future<void> _pick() async {
    if (_picking) return;
    setState(() => _picking = true);
    try {
      final files = await _picker.pickMultiImage();
      if (mounted) await _acceptPicked(files);
    } catch (e) {
      if (mounted) showToast(context, '选择图片失败：$e', error: true);
    } finally {
      if (mounted) setState(() => _picking = false);
    }
  }

  Future<void> _acceptPicked(List<XFile> files) async {
    var changed = false;
    for (final f in files) {
      final bytes = await f.readAsBytes();
      if (bytes.length > ImagePickerField.maxBytes) {
        if (mounted) showToast(context, '${f.name}：超过 10MB，已跳过', error: true);
        continue;
      }
      final docId = widget.docId;
      if (docId == null) {
        widget.pending.add(PendingImage(name: f.name, bytes: bytes));
        changed = true;
      } else {
        try {
          final doc = await widget.api.uploadLibraryImage(widget.kind, docId, filename: f.name, bytes: bytes);
          widget.images
            ..clear()
            ..addAll(doc.images);
          changed = true;
          if (mounted) showToast(context, '已上传 ${f.name}');
        } on ApiException catch (e) {
          if (mounted) showToast(context, '${f.name}：${e.message}', error: true);
        }
      }
    }
    if (changed && mounted) widget.onChanged();
  }

  Future<void> _deleteExisting(int index) async {
    final ok = await confirmDialog(context, '删除这张图片？');
    if (!ok || !mounted) return;
    try {
      final doc = await widget.api.deleteLibraryImage(widget.kind, widget.docId!, index);
      widget.images
        ..clear()
        ..addAll(doc.images);
      widget.onChanged();
    } on ApiException catch (e) {
      if (mounted) showToast(context, e.message, error: true);
    }
  }

  void _removePending(int index) {
    widget.pending.removeAt(index);
    widget.onChanged();
  }

  /// 打开素材图优化弹窗；采用后刷新图片列表。
  Future<void> _optimize(int index) async {
    final doc = await showOptimizeDialog(
      context,
      api: widget.api,
      materialId: widget.docId!,
      index: index,
      originalFile: widget.images[index].file
    );
    if (doc == null || !mounted) return;
    widget.images
      ..clear()
      ..addAll(doc.images);
    widget.onChanged();
    showToast(context, '已采用优化图（设为主图）');
  }

  @override
  Widget build(BuildContext context) {
    final thumbs = <Widget>[
      for (var i = 0; i < widget.images.length; i++)
        _thumb(
          image: Image.network(
            fileUri(widget.images[i].file).toString(),
            fit: BoxFit.cover,
            errorBuilder: (_, _, _) => const _ThumbError()
          ),
          isPrimary: i == 0,
          onDelete: () => _deleteExisting(i),
          onOptimize: widget.docId != null && widget.kind == Api.kMaterials ? () => _optimize(i) : null
        ),
      for (var i = 0; i < widget.pending.length; i++)
        _thumb(
          image: Image.memory(widget.pending[i].bytes, fit: BoxFit.cover),
          isPrimary: widget.images.isEmpty && i == 0,
          onDelete: () => _removePending(i)
        )
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (thumbs.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Wrap(spacing: 8, runSpacing: 8, children: thumbs)
          ),
        OutlinedButton.icon(
          onPressed: _picking ? null : _pick,
          icon: _picking
              ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
              : const Icon(Icons.add_photo_alternate_outlined, size: 18),
          label: const Text('添加图片')
        ),
        const SizedBox(height: 6),
        const Text(
          '支持多张，JPG / PNG / WEBP，单张 ≤10MB；第一张为主图',
          style: TextStyle(fontSize: 12, color: AppColors.muted)
        )
      ]
    );
  }

  Widget _thumb({
    required Widget image,
    required bool isPrimary,
    required VoidCallback onDelete,
    VoidCallback? onOptimize
  }) {
    return SizedBox(
      width: 84,
      height: 84,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Positioned.fill(
            child: ClipRRect(borderRadius: BorderRadius.circular(8), child: image)
          ),
          if (isPrimary)
            Positioned(
              left: 4,
              top: 4,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                decoration: BoxDecoration(
                  color: AppColors.accent,
                  borderRadius: BorderRadius.circular(999)
                ),
                child: const Text('主图', style: TextStyle(fontSize: 10, color: Colors.white))
              )
            ),
          Positioned(
            right: -6,
            top: -6,
            child: Material(
              color: AppColors.text.withValues(alpha: 0.75),
              shape: const CircleBorder(),
              child: InkWell(
                onTap: onDelete,
                customBorder: const CircleBorder(),
                child: const Padding(padding: EdgeInsets.all(4), child: Icon(Icons.close, size: 14, color: Colors.white))
              )
            )
          ),
          if (onOptimize != null)
            Positioned(
              left: 4,
              bottom: 4,
              child: Material(
                color: AppColors.accent,
                shape: const CircleBorder(),
                child: InkWell(
                  onTap: onOptimize,
                  customBorder: const CircleBorder(),
                  child: const Padding(
                    padding: EdgeInsets.all(5),
                    child: Icon(Icons.auto_fix_high, size: 15, color: Colors.white)
                  )
                )
              )
            )
        ]
      )
    );
  }
}

class _ThumbError extends StatelessWidget {
  const _ThumbError();

  @override
  Widget build(BuildContext context) {
    return Container(
      color: AppColors.bg,
      alignment: Alignment.center,
      child: const Icon(Icons.broken_image_outlined, color: AppColors.muted)
    );
  }
}
