/// 搭配台冒烟测试：双模式切换、无图样板拦截、提交前校验、候选张数选择。
/// 全程 MockClient，不依赖网络。
library;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:styling_station/data/api_client.dart';
import 'package:styling_station/views/studio_view.dart';

/// 一台样板（有图）、一台样板（无图）、一个素材。
Api _stubApi() {
  return Api(
    client: MockClient((req) async {
      Object body;
      switch (req.url.path) {
        case '/api/scenes':
          body = {'scenes': ['卧室'], 'tags': {'materials': [], 'templates': []}};
        case '/api/templates':
          body = {
            'total': 2,
            'items': [
              {'id': 't1', 'name': '北欧餐桌', 'images': [{'file': 'files/templates/t1/a.png'}], 'primary': 'files/templates/t1/a.png'},
              {'id': 't2', 'name': '无图样板', 'images': []}
            ]
          };
        case '/api/materials':
          body = {
            'total': 1,
            'items': [
              {'id': 'm1', 'name': '白色花瓶', 'images': [{'file': 'files/materials/m1/a.png'}], 'primary': 'files/materials/m1/a.png'}
            ]
          };
        case '/api/presets':
          body = {'total': 0, 'items': []};
        default:
          body = {'total': 0, 'items': []};
      }
      return http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json; charset=utf-8'});
    })
  );
}

Future<void> _pumpStudio(WidgetTester tester) async {
  tester.view.physicalSize = const Size(1400, 900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: StudioView(api: _stubApi()))));
  // 首帧 postFrame 触发的三次加载
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('自由模式：三块面板、默认 1 张、样板与素材就绪', (tester) async {
    await _pumpStudio(tester);

    expect(find.text('① 选择样板'), findsOneWidget);
    expect(find.text('② 选择素材'), findsOneWidget);
    expect(find.text('③ 出图设置'), findsOneWidget);
    expect(find.text('北欧餐桌'), findsOneWidget);
    expect(find.text('白色花瓶'), findsOneWidget);
    expect(find.text('1 张'), findsOneWidget);
    expect(find.text('生成效果图'), findsOneWidget);
  });

  testWidgets('无图样板：点击被拦截并提示', (tester) async {
    await _pumpStudio(tester);

    await tester.tap(find.text('无图样板'));
    await tester.pump();

    expect(find.text('该样板还没有图片，请先到「样板库」上传'), findsOneWidget);
  });

  testWidgets('选样板与素材：徽标与计数更新，未选素材提交被拦截', (tester) async {
    await _pumpStudio(tester);

    await tester.tap(find.text('北欧餐桌'));
    await tester.pump();
    expect(find.text('样板：北欧餐桌'), findsOneWidget);

    await tester.tap(find.text('生成效果图'));
    await tester.pump();
    expect(find.text('请至少选择一个素材'), findsOneWidget);

    await tester.tap(find.text('白色花瓶'));
    await tester.pump();
    expect(find.textContaining('已选素材 1/8'), findsOneWidget);
  });

  testWidgets('切换预设模式：显示预设面板', (tester) async {
    await _pumpStudio(tester);

    await tester.tap(find.text('预设搭配'));
    await tester.pumpAndSettle();

    expect(find.text('① 选择预设'), findsOneWidget);
    expect(find.text('还没有预设；先到「预设」Tab 创建。'), findsOneWidget);

    await tester.tap(find.text('自由搭配'));
    await tester.pumpAndSettle();
    expect(find.text('① 选择样板'), findsOneWidget);
  });
}
