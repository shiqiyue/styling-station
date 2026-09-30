/// SSE 门面：Dart VM（Android/桌面）走 dart:io，Web 走 EventSource。
/// 帧解析（sse_frames.dart）为纯函数，两端共用并有单测。
library;

export 'sse_frames.dart';
export 'sse_web.dart' if (dart.library.io) 'sse_io.dart';
