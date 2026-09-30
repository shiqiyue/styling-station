import 'package:flutter_test/flutter_test.dart';
import 'package:styling_station/config.dart';

void main() {
  group('normalizeBase', () {
    test('去首尾空白与尾部斜杠', () {
      expect(normalizeBase('  http://10.0.0.1:4584/  '), 'http://10.0.0.1:4584');
      expect(normalizeBase('http://10.0.0.1:4584///'), 'http://10.0.0.1:4584');
      expect(normalizeBase('http://10.0.0.1:4584'), 'http://10.0.0.1:4584');
    });

    test('空串保持空串', () {
      expect(normalizeBase(''), '');
      expect(normalizeBase('   '), '');
    });
  });

  group('resolveTarget', () {
    test('Web + 空 base → 同源相对路径', () {
      final t = resolveTarget(isWeb: true, base: '', path: '/api/health');
      expect(t.sameOrigin, isTrue);
      expect(t.url, '/api/health');
    });

    test('Web + 非空 base → 仍然使用 base（显式配置优先）', () {
      final t = resolveTarget(isWeb: true, base: 'http://a:1', path: '/api/health');
      expect(t.sameOrigin, isFalse);
      expect(t.url, 'http://a:1/api/health');
    });

    test('非 Web + base → 拼接，路径自动补前导斜杠', () {
      final t = resolveTarget(isWeb: false, base: 'http://10.224.143.70:4584', path: 'api/health');
      expect(t.sameOrigin, isFalse);
      expect(t.url, 'http://10.224.143.70:4584/api/health');
    });

    test('非 Web + 空 base → 产出畸形 URL（由 configError 在启动时拦截）', () {
      final t = resolveTarget(isWeb: false, base: '', path: '/api/health');
      expect(t.sameOrigin, isFalse);
      expect(t.url, '/api/health'); // 无宿主，仅作兜底
    });
  });

  group('configError（非 Web 运行环境）', () {
    test('SERVER_URL 未注入时给出中文指引', () {
      // 单测环境 non-web 且未注入 SERVER_URL
      expect(configError, isNotNull);
      expect(configError, contains('SERVER_URL'));
      expect(configError, contains('.env'));
    });

    test('serverBase 为空', () {
      expect(serverBase, '');
    });
  });
}
