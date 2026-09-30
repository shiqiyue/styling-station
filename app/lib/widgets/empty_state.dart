/// 空状态占位：居中提示文案（列表为空 / 加载失败）。
library;

import 'package:flutter/material.dart';

import '../theme.dart';

class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.message, this.icon});

  final String message;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (icon != null) ...[
              Icon(icon, size: 40, color: AppColors.muted),
              const SizedBox(height: 10)
            ],
            Text(message, textAlign: TextAlign.center, style: const TextStyle(color: AppColors.muted))
          ]
        )
      )
    );
  }
}
