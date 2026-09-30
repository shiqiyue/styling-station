/// 应用壳：五 Tab（素材库 / 样板库 / 预设 / 搭配台 / 记录）。
///
/// - 窄屏（< [kWideBreakpoint]）：底部 NavigationBar；宽屏：左侧 NavigationRail。
/// - Web 同步 hash 路由（`#/materials` 等），Android 为空实现。
/// - IndexedStack + 懒创建：首次进入才构建视图，之后跨 Tab 切换保留状态
///   （搭配台出图面板长连 SSE 不因切 Tab 中断）。
library;

import 'package:flutter/material.dart';

import 'data/api_client.dart';
import 'hash_route.dart';
import 'theme.dart';
import 'views/library_view.dart';
import 'views/presets_view.dart';
import 'views/renders_view.dart';
import 'views/studio_view.dart';

/// 宽屏断点（逻辑像素）。
const double kWideBreakpoint = 640;

class _TabDef {
  const _TabDef(this.route, this.label, this.icon, this.selectedIcon);

  /// hash 路由名（与旧版 web 一致）。
  final String route;
  final String label;
  final IconData icon;
  final IconData selectedIcon;
}

const List<_TabDef> _tabs = [
  _TabDef('materials', '素材库', Icons.inventory_2_outlined, Icons.inventory_2),
  _TabDef('templates', '样板库', Icons.sell_outlined, Icons.sell),
  _TabDef('presets', '预设', Icons.tune, Icons.tune),
  _TabDef('studio', '搭配台', Icons.palette_outlined, Icons.palette),
  _TabDef('renders', '记录', Icons.history, Icons.history)
];

/// 路由名 → Tab 索引；未知路由回落到素材库（0）。
int tabIndexFromRoute(String route) {
  for (var i = 0; i < _tabs.length; i++) {
    if (_tabs[i].route == route) return i;
  }
  return 0;
}

class AppShell extends StatefulWidget {
  const AppShell({super.key, required this.api});

  final Api api;

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  late int _index = tabIndexFromRoute(readHashRoute());

  /// 懒创建缓存：null = 尚未访问过。
  final List<Widget?> _views = List<Widget?>.filled(_tabs.length, null);

  @override
  void initState() {
    super.initState();
    listenHashRoute(_onHashRoute);
  }

  void _onHashRoute(String route) {
    final i = tabIndexFromRoute(route);
    if (i != _index && mounted) setState(() => _index = i);
  }

  void _select(int i) {
    if (i == _index) return;
    setState(() => _index = i);
    writeHashRoute(_tabs[i].route);
  }

  /// 懒创建：未访问过的非当前 Tab 返回占位，首次成为当前 Tab 时才真正构建。
  Widget _viewAt(int i) {
    if (_views[i] != null) return _views[i]!;
    if (i != _index) return const SizedBox.shrink();
    return _views[i] = _buildView(i);
  }

  Widget _buildView(int i) {
    switch (_tabs[i].route) {
      case 'materials':
        return LibraryView(api: widget.api, kind: LibraryKind.materials);
      case 'templates':
        return LibraryView(api: widget.api, kind: LibraryKind.templates);
      case 'presets':
        return PresetsView(api: widget.api);
      case 'studio':
        return StudioView(api: widget.api);
      default:
        return RendersView(api: widget.api);
    }
  }

  @override
  Widget build(BuildContext context) {
    final wide = MediaQuery.sizeOf(context).width >= kWideBreakpoint;
    final body = IndexedStack(
      key: const ValueKey('app-shell-stack'),
      index: _index,
      children: [for (var i = 0; i < _tabs.length; i++) _viewAt(i)]
    );
    if (!wide) {
      return Scaffold(
        appBar: AppBar(title: const Text('搭配台')),
        body: body,
        bottomNavigationBar: NavigationBar(
          selectedIndex: _index,
          onDestinationSelected: _select,
          destinations: [
            for (final t in _tabs)
              NavigationDestination(icon: Icon(t.icon), selectedIcon: Icon(t.selectedIcon), label: t.label)
          ]
        )
      );
    }
    return Scaffold(
      appBar: AppBar(title: const Text('搭配台')),
      body: Row(
        children: [
          NavigationRail(
            selectedIndex: _index,
            onDestinationSelected: _select,
            labelType: NavigationRailLabelType.all,
            leading: const Padding(
              padding: EdgeInsets.symmetric(vertical: 12),
              child: Icon(Icons.auto_awesome, color: AppColors.accent)
            ),
            destinations: [
              for (final t in _tabs)
                NavigationRailDestination(icon: Icon(t.icon), selectedIcon: Icon(t.selectedIcon), label: Text(t.label))
            ]
          ),
          const VerticalDivider(width: 1),
          Expanded(child: body)
        ]
      )
    );
  }
}
