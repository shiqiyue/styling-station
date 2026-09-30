/// 素材图优化入口测试：素材编辑模式显示魔棒、点击打开优化弹窗、
/// 流失败时进入失败态、关闭流程调 discard 并关闭弹窗。
/// 全程 MockClient（SSE 在测试环境走 400 替身 HTTP，故直接进入失败态）。
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:styling_station/data/api_client.dart';
import 'package:styling_station/data/models.dart';
import 'package:styling_station/widgets/image_picker_field.dart';

http.Response _json200(Object body) =>
    http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json; charset=utf-8'});

Api _stubApi(List<http.Request> log) {
  return Api(
    client: MockClient((req) async {
      log.add(req);
      switch (req.url.path) {
        case '/api/materials/m1/optimize':
          return _json200({'taskId': 'o-20260930120000-abcd'});
        case '/api/materials/m1/optimize/o-20260930120000-abcd/discard':
          return _json200({'ok': true});
        default:
          return _json200({'ok': true});
      }
    })
  );
}

Future<void> _pumpField(WidgetTester tester, Api api, String kind, String? docId) async {
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(
      body: ImagePickerField(
        api: api,
        kind: kind,
        docId: docId,
        images: const [ImageRef(file: 'files/materials/m1/1.png')],
        pending: const [],
        onChanged: () {}
      )
    )
  ));
  await tester.pump();
}

void main() {
  testWidgets('素材编辑模式：显示魔棒；样板模式不显示', (tester) async {
    await _pumpField(tester, _stubApi([]), 'materials', 'm1');
    expect(find.byIcon(Icons.auto_fix_high), findsOneWidget);

    await _pumpField(tester, _stubApi([]), 'templates', 't1');
    expect(find.byIcon(Icons.auto_fix_high), findsNothing);

    await _pumpField(tester, _stubApi([]), 'materials', null); // 新建模式
    expect(find.byIcon(Icons.auto_fix_high), findsNothing);
  });

  testWidgets('点击魔棒：打开弹窗（发起请求）→ 流失败进入失败态 → 关闭调 discard 并收起', (tester) async {
    final log = <http.Request>[];
    await _pumpField(tester, _stubApi(log), 'materials', 'm1');

    await tester.tap(find.byIcon(Icons.auto_fix_high));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    // 弹窗打开 + 已发起优化
    expect(find.text('素材图优化'), findsOneWidget);
    expect(log.any((r) => r.method == 'POST' && r.url.path == '/api/materials/m1/optimize'), isTrue);

    // 测试环境的替身 HTTP 对 SSE 返回 400 → 失败态（出现「关闭」「重试」）
    for (var i = 0; i < 5 && find.text('关闭').evaluate().isEmpty; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.text('重试'), findsOneWidget);
    expect(find.textContaining('失败'), findsWidgets);

    // 关闭 → discard 调用 + 弹窗收起（含退场动画）
    await tester.tap(find.text('关闭'));
    await tester.pumpAndSettle();
    expect(find.text('素材图优化'), findsNothing);
    expect(log.any((r) => r.method == 'POST' && r.url.path.endsWith('/discard')), isTrue);
  });
}
