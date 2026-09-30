/// 弹窗套件：提交型弹窗（保存/取消 + 忙碌态）与确认框。
/// 语义对齐旧版 web `lib/dom.js` 的 modal / confirmDialog：
/// onSubmit 返回 false 或抛错时弹窗保持打开；抛错同时 toast 错误信息。
library;

import 'package:flutter/material.dart';

import '../data/api_client.dart';
import '../theme.dart';
import 'toast.dart';

/// 提交型弹窗 → 是否提交成功（取消/未提交返回 false）。
Future<bool> showAppModal(
  BuildContext context, {
  required String title,
  required Widget body,
  required Future<bool> Function() onSubmit,
  String okText = '保存',
  String cancelText = '取消',
  bool wide = false
}) async {
  final result = await showDialog<bool>(
    context: context,
    builder: (ctx) => _AppModalDialog(
      title: title,
      body: body,
      onSubmit: onSubmit,
      okText: okText,
      cancelText: cancelText,
      wide: wide
    )
  );
  return result == true;
}

class _AppModalDialog extends StatefulWidget {
  const _AppModalDialog({
    required this.title,
    required this.body,
    required this.onSubmit,
    required this.okText,
    required this.cancelText,
    required this.wide
  });

  final String title;
  final Widget body;
  final Future<bool> Function() onSubmit;
  final String okText;
  final String cancelText;
  final bool wide;

  @override
  State<_AppModalDialog> createState() => _AppModalDialogState();
}

class _AppModalDialogState extends State<_AppModalDialog> {
  bool _busy = false;

  Future<void> _ok() async {
    setState(() => _busy = true);
    var submitted = false;
    try {
      submitted = await widget.onSubmit();
    } on ApiException catch (e) {
      if (mounted) showToast(context, e.message, error: true);
    } catch (e) {
      if (mounted) showToast(context, '$e', error: true);
    }
    if (!mounted) return;
    setState(() => _busy = false);
    if (submitted) Navigator.of(context).pop(true);
  }

  @override
  Widget build(BuildContext context) {
    return Dialog(
      insetPadding: const EdgeInsets.all(24),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: widget.wide ? 640 : 480),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 12),
              child: Text(widget.title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700))
            ),
            const Divider(height: 1),
            Flexible(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
                child: widget.body
              )
            ),
            const Divider(height: 1),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    onPressed: _busy ? null : () => Navigator.of(context).pop(false),
                    child: Text(widget.cancelText)
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    onPressed: _busy ? null : _ok,
                    child: _busy
                        ? const SizedBox(
                            width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                        : Text(widget.okText)
                  )
                ]
              )
            )
          ]
        )
      )
    );
  }
}

/// 确认框 → true（确认）/ false（取消）。
Future<bool> confirmDialog(
  BuildContext context,
  String message, {
  String okText = '删除',
  bool danger = true
}) async {
  final r = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text('请确认'),
      content: Text(message),
      actions: [
        TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('取消')),
        FilledButton(
          style: danger ? FilledButton.styleFrom(backgroundColor: AppColors.danger) : null,
          onPressed: () => Navigator.of(ctx).pop(true),
          child: Text(okText)
        )
      ]
    )
  );
  return r == true;
}
