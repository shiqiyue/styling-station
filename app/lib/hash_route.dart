/// hash 路由读写：Web 用 `location.hash`（`#/studio` 等，与旧版 web 路由一致）；
/// 其他平台为空实现（Android 无地址栏，恒默认 Tab）。
///
/// 与 sse.dart 相同的条件导出模式：默认 Web 实现，`dart:io` 平台用空实现。
library;

export 'hash_route_web.dart' if (dart.library.io) 'hash_route_stub.dart';
