/// 文件下载：Web 触发浏览器下载；移动端为占位空实现（不引入额外插件）。
library;

export 'download_web.dart' if (dart.library.io) 'download_stub.dart';
