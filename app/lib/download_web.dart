/// Web 下载实现：创建带 `download` 属性的 <a> 并触发点击（同源文件直接下载）。
library;

import 'package:web/web.dart' as web;

void downloadFile(String url, String filename) {
  final a = web.HTMLAnchorElement()
    ..href = url
    ..download = filename;
  a.click();
}
