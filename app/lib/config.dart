/// 服务器地址配置。
///
/// 地址来源：编译期注入（`--dart-define-from-file=.env` → `SERVER_URL=...`）。
/// - Web 构建：由 Node 服务器自身托管，天然同源 → 允许为空，走相对路径。
/// - Android 构建：地址为空时失败要快（启动即错误页），提示改 `app/.env` 重新打包。
library;

import 'package:flutter/foundation.dart' show kIsWeb;

/// 编译期注入的原始值（未配置时为空串）。
const String kRawServerUrl = String.fromEnvironment('SERVER_URL');

/// 归一化：去首尾空白、去尾部斜杠。
String normalizeBase(String raw) => raw.trim().replaceAll(RegExp(r'/+$'), '');

/// 路径目标解析结果：[sameOrigin] 为 true 时表示走当前页面同源相对路径（Web 未配置场景）。
typedef UrlTarget = ({bool sameOrigin, String url});

/// 纯函数：决定某 API 路径的最终目标（便于两端分支单测）。
UrlTarget resolveTarget({required bool isWeb, required String base, required String path}) {
  final p = path.startsWith('/') ? path : '/$path';
  if (isWeb && base.isEmpty) return (sameOrigin: true, url: p);
  return (sameOrigin: false, url: '$base$p');
}

/// 归一化后的基础地址。
String get serverBase => normalizeBase(kRawServerUrl);

/// 配置错误说明（null = 可正常使用）。
String? get configError {
  if (kIsWeb) return null; // Web 同源，无需地址
  if (serverBase.isEmpty) {
    return '未配置服务器地址。\n请把 app/.env 里的 SERVER_URL 填成这台机器的内网地址，'
        '然后重新运行 build-android.bat 打包。';
  }
  return null;
}

/// API 路径 → 完整 Uri。
Uri apiUri(String path) {
  final t = resolveTarget(isWeb: kIsWeb, base: serverBase, path: path);
  if (t.sameOrigin) return Uri.base.resolve(t.url);
  return Uri.parse(t.url);
}

/// 数据图片路径（`files/...`）→ 完整 Uri（含 Android 远程服务器前缀）。
Uri fileUri(String file) => apiUri(file.startsWith('/') ? file : '/$file');
