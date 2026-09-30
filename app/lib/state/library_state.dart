/// 素材库 / 样板库页面状态：筛选条件 + 列表加载（序号丢弃过期响应）。
library;

import 'package:flutter/foundation.dart';

import '../data/api_client.dart';
import '../data/models.dart';

class LibraryState extends ChangeNotifier {
  LibraryState({required this.api, required this.kind});

  final Api api;
  final LibraryKind kind;

  // 筛选条件
  String scene = '';
  List<String> tags = [];
  String q = '';
  bool includeDeleted = false;

  // 数据
  bool loading = false;
  String? error;
  List<LibraryDoc> items = [];

  // 场景 / 已用标签（GET /api/scenes）
  List<String> scenes = [];
  List<String> knownTags = [];
  String? metaError;

  int _seq = 0;

  Future<void> init() async {
    await Future.wait([_loadMeta(), reload()]);
  }

  Future<void> _loadMeta() async {
    try {
      final meta = await api.scenes();
      scenes = meta.scenes;
      knownTags = kind == LibraryKind.materials ? meta.materialTags : meta.templateTags;
      metaError = null;
    } on ApiException catch (e) {
      metaError = e.message;
    }
    notifyListeners();
  }

  Future<void> reload() async {
    final seq = ++_seq;
    loading = true;
    error = null;
    notifyListeners();
    try {
      final page = await api.listLibrary(
        kind.kind,
        scene: scene,
        tags: tags,
        q: q,
        includeDeleted: includeDeleted,
        limit: 500
      );
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

  void setScene(String v) {
    if (v == scene) return;
    scene = v;
    reload();
  }

  void toggleTag(String t) {
    tags = tags.contains(t) ? tags.where((x) => x != t).toList() : [...tags, t];
    reload();
  }

  void setQuery(String v) {
    if (v == q) return;
    q = v;
    reload();
  }

  void setIncludeDeleted(bool v) {
    if (v == includeDeleted) return;
    includeDeleted = v;
    reload();
  }

  @override
  void dispose() {
    _seq++; // 丢弃在途响应
    super.dispose();
  }
}
