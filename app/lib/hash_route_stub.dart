/// 非 Web 平台空实现：Android 无地址栏，hash 路由恒为空、写入与监听均为 no-op。
library;

String readHashLocation() => '';

String readHashRoute() => '';

void writeHashLocation(String loc) {}

void writeHashRoute(String route) {}

void listenHashRoute(void Function(String route) callback) {}

void reassertHashAfterBoot(void Function() write) {}
