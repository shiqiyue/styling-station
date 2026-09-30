/// 标签 chips 输入：回车/逗号（中英文/顿号）提交，去重，≤[max] 个、单个 ≤[maxLen] 字符；
/// 输入框为空时按退格删除最后一个标签。行为对齐旧版 web `tagInput`。
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme.dart';
import 'toast.dart';

class TagInput extends StatefulWidget {
  const TagInput({
    super.key,
    this.initialValue = const [],
    this.onChanged,
    this.max = 20,
    this.maxLen = 20,
    this.hintText = '输入标签后回车'
  });

  final List<String> initialValue;
  final ValueChanged<List<String>>? onChanged;
  final int max;
  final int maxLen;
  final String hintText;

  @override
  State<TagInput> createState() => TagInputState();
}

class TagInputState extends State<TagInput> {
  late final List<String> _tags = [...widget.initialValue];
  final TextEditingController _controller = TextEditingController();
  final FocusNode _focus = FocusNode();

  List<String> get value => [..._tags];

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _notify() => widget.onChanged?.call([..._tags]);

  void _commitRaw(String raw) {
    for (final piece in raw.split(RegExp(r'[,，、]'))) {
      final t = piece.trim();
      if (t.isEmpty) continue;
      if (t.length > widget.maxLen) {
        showToast(context, '单个标签不超过 ${widget.maxLen} 字符', error: true);
        continue;
      }
      if (_tags.contains(t)) continue;
      if (_tags.length >= widget.max) {
        showToast(context, '最多 ${widget.max} 个标签', error: true);
        break;
      }
      _tags.add(t);
    }
  }

  void _add() {
    _commitRaw(_controller.text);
    _controller.clear();
    setState(_notify);
  }

  void _remove(String t) {
    _tags.remove(t);
    setState(_notify);
  }

  void _onChanged(String v) {
    // 输入逗号即提交（与旧版 keydown ',' 行为一致）
    if (v.contains(',') || v.contains('，') || v.contains('、')) {
      _commitRaw(v);
      _controller.clear();
      setState(_notify);
    }
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is KeyDownEvent &&
        event.logicalKey == LogicalKeyboardKey.backspace &&
        _controller.text.isEmpty &&
        _tags.isNotEmpty) {
      _remove(_tags.last);
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_tags.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final t in _tags)
                  Container(
                    padding: const EdgeInsets.fromLTRB(10, 4, 4, 4),
                    decoration: BoxDecoration(
                      color: AppColors.accentSoft,
                      borderRadius: BorderRadius.circular(999)
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(t, style: const TextStyle(fontSize: 12, color: AppColors.accent)),
                        const SizedBox(width: 2),
                        InkWell(
                          onTap: () => _remove(t),
                          borderRadius: BorderRadius.circular(999),
                          child: const Padding(
                            padding: EdgeInsets.all(2),
                            child: Icon(Icons.close, size: 14, color: AppColors.accent)
                          )
                        )
                      ]
                    )
                  )
              ]
            )
          ),
        Focus(
          canRequestFocus: false,
          skipTraversal: true,
          onKeyEvent: _onKey,
          child: TextField(
            controller: _controller,
            focusNode: _focus,
            textInputAction: TextInputAction.done,
            onChanged: _onChanged,
            onSubmitted: (_) => _add(),
            decoration: InputDecoration(hintText: widget.hintText)
          )
        )
      ]
    );
  }
}
