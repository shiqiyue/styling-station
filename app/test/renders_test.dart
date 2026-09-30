/// 记录页面测试：路由位置解析、列表渲染、详情（状态/快照/候选/版本链）、失败记录 stderr。
/// 全程 MockClient，不依赖网络。
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:styling_station/data/api_client.dart';
import 'package:styling_station/views/renders_view.dart';

Map<String, Object?> _render({
  required String id,
  String status = 'done',
  String mode = 'free',
  String? parentId,
  List<String> childrenIds = const [],
  List<Map<String, Object?>> results = const [],
  String? stderrTail,
  String templateName = '北欧餐桌',
  String? presetName,
  String createdAt = '2026-09-30T10:00:00.000Z'
}) {
  return {
    'id': id,
    'mode': mode,
    'status': status,
    'parentId': parentId,
    'candidateCount': 2,
    'results': results,
    'size': '1024x1024',
    'createdAt': createdAt,
    'childrenIds': childrenIds,
    'stderrTail': stderrTail,
    'templateSnapshot': {'id': 't1', 'name': templateName, 'images': [{'file': 'files/templates/t1/a.png'}], 'tags': ['北欧']},
    if (presetName != null) 'presetSnapshot': {'id': 'p1', 'name': presetName},
    'materialsSnapshot': [
      {'id': 'm1', 'name': '白色花瓶', 'slotName': '桌面摆件', 'slotPosition': '桌面左侧', 'tags': ['陶瓷'], 'images': []}
    ]
  };
}

Api _stubApi() {
  final detail1 = _render(
    id: 'r1',
    childrenIds: ['r2'],
    results: [{'file': 'files/renders/r1/v1.png', 'width': 1024, 'height': 1024, 'chosen': true}]
  );
  final detail2 = _render(id: 'r2', parentId: 'r1', templateName: '北欧餐桌');
  final failed = _render(id: 'r3', status: 'error', stderrTail: 'cli 退出码 1', results: []);
  return Api(
    client: MockClient((req) async {
      final path = req.url.path;
      Object body;
      if (path == '/api/renders') {
        body = {'total': 3, 'items': [detail1, detail2, failed]};
      } else if (path == '/api/renders/r1') {
        body = detail1;
      } else if (path == '/api/renders/r2') {
        body = detail2;
      } else if (path == '/api/renders/r3') {
        body = failed;
      } else if (path == '/api/templates/t1') {
        body = {'id': 't1', 'name': '北欧餐桌', 'images': []};
      } else {
        body = {'total': 0, 'items': []};
      }
      return http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json; charset=utf-8'});
    })
  );
}

Future<void> _pumpView(WidgetTester tester) async {
  tester.view.physicalSize = const Size(900, 900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: RendersView(api: _stubApi()))));
  await tester.pumpAndSettle();
}

void main() {
  test('parseRendersLocation：列表/详情/筛选/非本页', () {
    expect(parseRendersLocation('').id, isNull);
    expect(parseRendersLocation('renders').id, isNull);
    expect(parseRendersLocation('renders/r1').id, 'r1');
    expect(parseRendersLocation('renders?template=t1').template, 't1');
    expect(parseRendersLocation('renders/r1?material=m2').id, 'r1');
    expect(parseRendersLocation('renders/r1?material=m2').material, 'm2');
    // 非本页路由：按列表处理（防御性）
    final other = parseRendersLocation('studio');
    expect(other.id, isNull);
    expect(other.template, '');
  });

  testWidgets('列表：行标题/状态徽标/计数/加载更多', (tester) async {
    await _pumpView(tester);

    expect(find.text('记录'), findsOneWidget);
    expect(find.text('北欧餐桌'), findsWidgets);
    expect(find.text('已完成'), findsWidgets);
    expect(find.text('失败'), findsOneWidget);
    expect(find.text('1 张选用'), findsOneWidget);
    expect(find.textContaining('候选 1/2 张'), findsWidgets);
    // 3 < 20 → 无加载更多按钮
    expect(find.textContaining('加载更多'), findsNothing);
  });

  testWidgets('详情：状态行、快照明细、候选与版本链跳转', (tester) async {
    await _pumpView(tester);

    await tester.tap(find.text('北欧餐桌').first);
    await tester.pumpAndSettle();

    expect(find.text('记录详情'), findsOneWidget);
    expect(find.text('快照明细'), findsOneWidget);
    expect(find.text('候选图'), findsOneWidget);
    expect(find.text('版本链'), findsOneWidget);
    expect(find.text('样板：北欧餐桌'), findsOneWidget);
    expect(find.text('素材：白色花瓶'), findsOneWidget);
    expect(find.text('插槽：桌面摆件'), findsOneWidget);
    expect(find.text('位置：桌面左侧'), findsOneWidget);
    expect(find.text('候选 1'), findsOneWidget);
    expect(find.text('已选用'), findsOneWidget);
    // 版本链：本版 + 子记录按钮（r2 已完成）
    expect(find.textContaining('本版（已完成）'), findsOneWidget);
    expect(find.textContaining('下一版 →（已完成'), findsOneWidget);

    // 跳转下一版 → r2 详情（有 ← 上一版）
    await tester.tap(find.textContaining('下一版 →'));
    await tester.pumpAndSettle();
    expect(find.text('← 上一版'), findsOneWidget);
    expect(find.text('（单版记录）'), findsNothing);

    // 返回列表
    await tester.tap(find.text('返回列表'));
    await tester.pumpAndSettle();
    expect(find.text('记录'), findsOneWidget);
  });

  testWidgets('失败记录详情：展示 stderrTail', (tester) async {
    await _pumpView(tester);

    // 失败行（无候选缩略图）→ 点标题进详情
    await tester.tap(find.text('失败'));
    await tester.pumpAndSettle();
    expect(find.text('cli 退出码 1'), findsOneWidget);
  });
}
