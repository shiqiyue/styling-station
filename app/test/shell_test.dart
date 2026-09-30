/// 应用壳冒烟测试：五 Tab 导航（窄屏 NavigationBar / 宽屏 NavigationRail）、
/// 切换正确、配置缺失错误页。
library;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:styling_station/data/api_client.dart';
import 'package:styling_station/main.dart';
import 'package:styling_station/shell.dart';

/// 占位/真实视图的 GET 都返回空列表；本测试不依赖网络。
Api _stubApi() => Api(
  client: MockClient((req) async => http.Response('{"total":0,"items":[]}', 200))
);

/// 应用壳的 IndexedStack 带固定 Key（下拉按钮等内部也会用 IndexedStack）。
const _stackKey = ValueKey('app-shell-stack');

int _stackIndex(WidgetTester tester) =>
    tester.widget<IndexedStack>(find.byKey(_stackKey)).index ?? -1;

Finder _navText(String label) => find.descendant(
  of: find.byType(NavigationBar),
  matching: find.text(label)
);

Finder _railText(String label) => find.descendant(
  of: find.byType(NavigationRail),
  matching: find.text(label)
);

void main() {
  test('tabIndexFromRoute：已知路由映射，未知回落素材库', () {
    expect(tabIndexFromRoute('materials'), 0);
    expect(tabIndexFromRoute('templates'), 1);
    expect(tabIndexFromRoute('presets'), 2);
    expect(tabIndexFromRoute('studio'), 3);
    expect(tabIndexFromRoute('renders'), 4);
    expect(tabIndexFromRoute('nope'), 0);
    expect(tabIndexFromRoute(''), 0);
  });

  testWidgets('窄屏：底部导航 5 个目的地，可切换', (tester) async {
    tester.view.physicalSize = const Size(400, 800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(StylingStationApp(api: _stubApi()));

    expect(find.byType(NavigationBar), findsOneWidget);
    expect(find.byType(NavigationRail), findsNothing);
    final bar = tester.widget<NavigationBar>(find.byType(NavigationBar));
    expect(bar.destinations.length, 5);
    expect(_stackIndex(tester), 0);

    await tester.tap(_navText('搭配台'));
    await tester.pump();
    expect(_stackIndex(tester), 3);

    await tester.tap(_navText('记录'));
    await tester.pump();
    expect(_stackIndex(tester), 4);

    await tester.tap(_navText('样板库'));
    await tester.pump();
    expect(_stackIndex(tester), 1);
  });

  testWidgets('宽屏：左侧 NavigationRail，可切换', (tester) async {
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(StylingStationApp(api: _stubApi()));

    expect(find.byType(NavigationRail), findsOneWidget);
    expect(find.byType(NavigationBar), findsNothing);

    await tester.tap(_railText('预设'));
    await tester.pump();
    expect(_stackIndex(tester), 2);

    await tester.tap(_railText('素材库'));
    await tester.pump();
    expect(_stackIndex(tester), 0);
  });

  testWidgets('配置缺失：显示错误页而非主界面', (tester) async {
    await tester.pumpWidget(
      StylingStationApp(api: _stubApi(), configProblem: '未配置服务器地址。请修改 app/.env 后重新打包。')
    );

    expect(find.text('配置缺失'), findsOneWidget);
    expect(find.textContaining('未配置服务器地址'), findsOneWidget);
    expect(find.byType(NavigationBar), findsNothing);
    expect(find.byKey(_stackKey), findsNothing);
  });
}
