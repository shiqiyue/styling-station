/// 应用入口：MaterialApp + 配置兜底页。
///
/// Android 构建若未在 `app/.env` 配置 SERVER_URL，启动即显示错误页（fail fast），
/// 提示重新打包；Web 构建同源，无需配置。
library;

import 'package:flutter/material.dart';

import 'config.dart';
import 'data/api_client.dart';
import 'shell.dart';
import 'theme.dart';

void main() {
  runApp(StylingStationApp(api: Api(), configProblem: configError));
}

class StylingStationApp extends StatelessWidget {
  const StylingStationApp({super.key, required this.api, this.configProblem});

  final Api api;

  /// 非 null 时展示错误页（Android 未配置 SERVER_URL 的场景）。
  final String? configProblem;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '搭配台',
      theme: buildAppTheme(),
      debugShowCheckedModeBanner: false,
      home: configProblem == null ? AppShell(api: api) : _ConfigErrorPage(message: configProblem!)
    );
  }
}

class _ConfigErrorPage extends StatelessWidget {
  const _ConfigErrorPage({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.settings_outlined, size: 48, color: AppColors.warn),
                const SizedBox(height: 16),
                const Text('配置缺失', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700)),
                const SizedBox(height: 8),
                Text(message, textAlign: TextAlign.center, style: const TextStyle(color: AppColors.muted))
              ]
            )
          )
        )
      )
    );
  }
}
