/// Web 实现：读写浏览器地址栏 hash（兼容 `#/materials` 形式的旧路由）。
library;

import 'dart:js_interop';

import 'package:web/web.dart' as web;

/// 当前路由名（如 `studio`）；无 hash 或空段时返回空串。
/// 解析规则与旧版 app.js 一致：去掉 `#/` 前缀，取 `?` 前、`/` 第一段。
String readHashRoute() {
  final raw = web.window.location.hash;
  final stripped = raw.replaceFirst(RegExp(r'^#/?'), '');
  return stripped.split('?').first.split('/').first;
}

/// 写入路由名（浏览地址变为 `#/<route>`；值相同时不重复写，避免多余历史记录）。
void writeHashRoute(String route) {
  final want = '#/$route';
  if (web.window.location.hash != want) {
    web.window.location.hash = want;
  }
}

/// 监听 hashchange（浏览器前进/后退 / 手动改地址），回调参数为解析后的路由名。
void listenHashRoute(void Function(String route) callback) {
  web.window.addEventListener(
    'hashchange',
    ((web.Event _) => callback(readHashRoute())).toJS
  );
}
