/// 预设页面状态：列表加载（序号丢弃过期响应）。
library;

import 'package:flutter/foundation.dart';

import '../data/api_client.dart';
import '../data/models.dart';

class PresetsState extends ChangeNotifier {
  PresetsState({required this.api});

  final Api api;

  bool loading = false;
  String? error;
  List<Preset> items = [];

  int _seq = 0;

  Future<void> reload() async {
    final seq = ++_seq;
    loading = true;
    error = null;
    notifyListeners();
    try {
      final page = await api.listPresets(limit: 500);
      if (seq != _seq) return;
      items = page.items;
    } on ApiException catch (e) {
      if (seq != _seq) return;
      items = [];
      error = e.message;
    } finally {
      if (seq == _seq) {
        loading = false;
        notifyListeners();
      }
    }
  }

  @override
  void dispose() {
    _seq++;
    super.dispose();
  }
}
