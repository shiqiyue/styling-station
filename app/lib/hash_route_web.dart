/// Web 实现：读写浏览器地址栏 hash（兼容 `#/materials`、`#/renders/<id>?x=y` 形式）。
library;

import 'dart:js_interop';

import 'package:web/web.dart' as web;

/// 完整 hash 位置（如 `renders/abc?template=t1`；去掉 `#/` 前缀；无 hash 时为空串）。
String readHashLocation() => web.window.location.hash.replaceFirst(RegExp(r'^#/?'), '');

/// 当前路由名（如 `studio`）；无 hash 或空段时返回空串。
/// 解析规则与旧版 app.js 一致：去掉 `#/` 前缀，取 `?` 前、`/` 第一段。
String readHashRoute() => readHashLocation().split('?').first.split('/').first;

/// 写入完整位置（地址变为 `#/<loc>`；值相同时不重复写，避免多余历史记录）。
void writeHashLocation(String loc) {
  final want = '#/$loc';
  if (web.window.location.hash != want) {
    web.window.location.hash = want;
  }
}

/// 写入路由名（`#/<route>`）。
void writeHashRoute(String route) => writeHashLocation(route);

/// 监听 hashchange（浏览器前进/后退 / 手动改地址），回调参数为解析后的路由名。
void listenHashRoute(void Function(String route) callback) {
  web.window.addEventListener(
    'hashchange',
    ((web.Event _) => callback(readHashRoute())).toJS
  );
}
