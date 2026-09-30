/// 候选图卡片与图片预览弹层（搭配台出图面板 / 记录详情共用）。
library;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';

import '../config.dart';
import '../data/models.dart';
import '../download.dart';
import '../theme.dart';

/// 单张候选图卡片：缩略图（点开大图）、序号、选用/取消选用、Web 下载。
class ResultCard extends StatelessWidget {
  const ResultCard({
    super.key,
    required this.result,
    required this.index,
    required this.onChoose,
    this.busy = false
  });

  final RenderResult result;

  /// 候选序号（1 起，与后端 index 一致）。
  final int index;
  final Future<void> Function(int index, bool chosen) onChoose;

  /// 忙碌中禁用按钮。
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final url = fileUri(result.file).toString();
    return Container(
      decoration: BoxDecoration(
        color: AppColors.panel,
        borderRadius: BorderRadius.circular(kRadius - 2),
        border: Border.all(color: result.chosen ? AppColors.accent : AppColors.line, width: result.chosen ? 2 : 1)
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Expanded(
          child: GestureDetector(
            onTap: () => showImagePreview(context, url, '候选 $index'),
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
            Text('候选 $index', style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
            if (result.chosen)
              Container(
                margin: const EdgeInsets.only(left: 6),
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                decoration: BoxDecoration(color: AppColors.accentSoft, borderRadius: BorderRadius.circular(999)),
                child: const Text('已选用', style: TextStyle(fontSize: 11, color: AppColors.accent))
              ),
            const Spacer(),
            if (kIsWeb) ...[
              TextButton(
                onPressed: () => downloadFile(url, 'v$index.png'),
                style: TextButton.styleFrom(visualDensity: VisualDensity.compact),
                child: const Text('下载', style: TextStyle(fontSize: 12))
              ),
              const SizedBox(width: 4)
            ],
            result.chosen
                ? OutlinedButton(
                    onPressed: busy ? null : () => onChoose(index, false),
                    style: OutlinedButton.styleFrom(visualDensity: VisualDensity.compact),
                    child: const Text('取消选用', style: TextStyle(fontSize: 12))
                  )
                : FilledButton(
                    onPressed: busy ? null : () => onChoose(index, true),
                    style: FilledButton.styleFrom(visualDensity: VisualDensity.compact),
                    child: const Text('选用', style: TextStyle(fontSize: 12))
                  )
          ])
        )
      ])
    );
  }
}

/// 大图预览：黑底 + 可缩放，右上角关闭。
void showImagePreview(BuildContext context, String url, String title) {
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
