/// 搭配台页面（自由/预设双模式 + 出图面板）。
///
/// 功能填充见任务 #20；当前为导航壳占位。
library;

import 'package:flutter/material.dart';

import '../data/api_client.dart';

class StudioView extends StatelessWidget {
  const StudioView({super.key, required this.api});

  final Api api;

  @override
  Widget build(BuildContext context) {
    return const Center(child: Text('搭配台'));
  }
}
