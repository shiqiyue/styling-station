/// 记录页面（出图历史 + 详情 + 版本链）。
///
/// 功能填充见任务 #21；当前为导航壳占位。
library;

import 'package:flutter/material.dart';

import '../data/api_client.dart';

class RendersView extends StatelessWidget {
  const RendersView({super.key, required this.api});

  final Api api;

  @override
  Widget build(BuildContext context) {
    return const Center(child: Text('记录'));
  }
}
