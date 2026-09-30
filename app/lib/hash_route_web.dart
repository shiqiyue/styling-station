/// Web 实现：读写浏览器地址栏 hash（兼容 `#/materials`、`#/renders/<id>?x=y` 形式）。
library;

import 'dart:async';
import 'dart:js_interop';

import 'package:web/web.dart' as web;

/// 完整 hash 位置（如 `renders/abc?template=t1`；去掉 `#/` 前缀；无 hash 时为空串）。
String readHashLocation() => web.window.location.hash.replaceFirst(RegExp(r'^#/?'), '');

/// 当前路由名（如 `studio`）；无 hash 或空段时返回空串。
/// 解析规则与旧版 app.js 一致：去掉 `#/` 前缀，取 `?` 前、`/` 第一段。
String readHashRoute() => readHashLocation().split('?').first.split('/').first;

/// 写入完整位置（地址变为 `#/<loc>`；值相同时不重复写）。
///
/// 必须用 `history.replaceState`，不能写 `location.hash = ...`：
/// Flutter web 引擎为 `MaterialApp(home:)` 维护单入口浏览器历史，
/// 直接改 hash 会被引擎视为「外部导航」，随后把地址还原回去并触发
/// hashchange，监听它的壳/记录页立刻回退（表现为点击 Tab 没反应）。
/// replaceState 不触发 popstate/hashchange，引擎不会还原；
/// state 原样回传，避免覆盖引擎自己的历史标记。
void writeHashLocation(String loc) {
  final want = '#/$loc';
  if (web.window.location.hash != want) {
    web.window.history.replaceState(web.window.history.state, '', want);
  }
}

/// 写入路由名（`#/<route>`）。
void writeHashRoute(String route) => writeHashLocation(route);

/// 启动后把当前页位置写回地址栏（`write` 回调负责具体写入）。
///
/// 引擎启动时会把地址栏一次性还原为 `/`（单入口历史的初始路由上报，
/// 见 [writeHashLocation]），深链/刷新后地址栏会被清掉。用宏任务
/// （Timer.run）保证在引擎还原之后执行；实测（2026-09-30，headless Chrome
/// CDP）引擎还原先于本回调，写回后连续两次刷新均保持原路由。
void reassertHashAfterBoot(void Function() write) => Timer.run(write);

/// 监听 hashchange（浏览器前进/后退 / 手动改地址），回调参数为解析后的路由名。
void listenHashRoute(void Function(String route) callback) {
  web.window.addEventListener(
    'hashchange',
    ((web.Event _) => callback(readHashRoute())).toJS
  );
}
