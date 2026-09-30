import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:styling_station/data/models.dart';

void main() {
  group('Paged', () {
    test('解析 {total, items} 并跳过坏条目', () {
      final paged = Paged.fromJson(
        jsonDecode('{"total": 3, "items": [{"id": "m-1"}, {"name": "无 id"}, {"id": "m-2"}]}'),
        LibraryDoc.fromJson
      );
      expect(paged.total, 3);
      expect(paged.items.map((e) => e.id), ['m-1', 'm-2']);
    });

    test('非对象输入 → 空页', () {
      final paged = Paged.fromJson(null, LibraryDoc.fromJson);
      expect(paged.total, 0);
      expect(paged.items, isEmpty);
    });
  });

  group('LibraryDoc', () {
    test('完整解析素材（含图片与 hasImage）', () {
      final doc = LibraryDoc.fromJson(jsonDecode('''
        {
          "id": "m-20260930113451-3791", "name": "奶油肌理墙纸", "description": "细腻奶油色",
          "scene": "家居", "tags": ["墙纸", "奶油色"],
          "images": [{"file": "files/materials/x/1.png", "width": 1024, "height": 1024, "primary": true}],
          "createdAt": "2026-09-30T11:34:51.000+08:00", "updatedAt": "2026-09-30T11:34:51.000+08:00",
          "deleted": false, "hasImage": true
        }
      '''));
      expect(doc!.id, 'm-20260930113451-3791');
      expect(doc.tags, ['墙纸', '奶油色']);
      expect(doc.primaryImage!.file, 'files/materials/x/1.png');
      expect(doc.hasImage, isTrue);
    });

    test('缺字段容错：tags 非数组、images 缺失', () {
      final doc = LibraryDoc.fromJson(jsonDecode('{"id": "t-1", "name": "样板", "tags": "坏", "scene": null}'));
      expect(doc!.tags, isEmpty);
      expect(doc.images, isEmpty);
      expect(doc.scene, '');
      expect(doc.hasImage, isFalse);
    });

    test('无 id → null', () {
      expect(LibraryDoc.fromJson(jsonDecode('{"name": "x"}')), isNull);
    });
  });

  group('Preset', () {
    test('样板失效（templateValid=false, template=null）', () {
      final p = Preset.fromJson(jsonDecode('''
        {"id": "p-1", "name": "卧室预设", "templateId": "t-9", "slots": [{"id": "s-1", "name": "墙纸", "tags": ["墙纸"], "positionNote": "四面墙"}],
         "deleted": false, "templateValid": false, "template": null}
      '''));
      expect(p!.templateValid, isFalse);
      expect(p.template, isNull);
      expect(p.slots.single.name, '墙纸');
    });

    test('有效样板 brief 解析', () {
      final p = Preset.fromJson(jsonDecode('''
        {"id": "p-1", "name": "x", "templateId": "t-1", "slots": [],
         "templateValid": true, "template": {"id": "t-1", "name": "北欧卧室", "images": [], "primary": "files/templates/t-1/1.png"}}
      '''));
      expect(p!.template!.primary, 'files/templates/t-1/1.png');
    });
  });

  group('RenderDoc', () {
    test('完整记录解析（含快照与 childrenIds）', () {
      final r = RenderDoc.fromJson(jsonDecode('''
        {
          "id": "r-1", "mode": "preset", "status": "done", "parentId": "r-0",
          "positionNote": "把墙纸贴在四面墙", "candidateCount": 2,
          "results": [{"file": "files/renders/r-1/v1.png", "width": 1024, "height": 1024, "chosen": true, "error": null}],
          "startedAt": "2026-09-30T12:00:00.000+08:00", "finishedAt": "2026-09-30T12:01:00.000+08:00",
          "elapsedMs": 60000, "stderrTail": null,
          "templateSnapshot": {"id": "t-1", "name": "北欧卧室", "description": "", "tags": [], "images": []},
          "presetId": "p-1", "presetSnapshot": {"id": "p-1", "name": "卧室预设"},
          "materialsSnapshot": [{"id": "m-1", "name": "墙纸", "slotId": "s-1", "slotName": "墙纸", "slotPosition": "四面墙", "tags": [], "images": []}],
          "size": "1536x1024", "createdAt": "2026-09-30T12:00:00.000+08:00",
          "childrenIds": ["r-2"]
        }
      '''));
      expect(r!.status, RenderStatus.done);
      expect(r.isFree, isFalse);
      expect(r.results.single.chosen, isTrue);
      expect(r.presetName, '卧室预设');
      expect(r.materialsSnapshot.single.slotName, '墙纸');
      expect(r.childrenIds, ['r-2']);
    });

    test('最小记录：排队中 free 模式', () {
      final r = RenderDoc.fromJson(jsonDecode('{"id": "r-9", "mode": "free", "status": "queued", "candidateCount": 1}'));
      expect(r!.status, RenderStatus.queued);
      expect(r.results, isEmpty);
      expect(r.childrenIds, isEmpty);
      expect(r.parentId, isNull);
    });

    test('未知状态 → unknown；status 缺失同样兜底', () {
      expect(RenderDoc.fromJson(jsonDecode('{"id": "r", "status": "weird"}'))!.status, RenderStatus.unknown);
      expect(RenderStatus.parse(null), RenderStatus.unknown);
      expect(RenderStatus.unknown.terminal, isFalse);
      expect(RenderStatus.stopped.terminal, isTrue);
    });

    test('结果里 error 为字符串时保留', () {
      final r = RenderDoc.fromJson(jsonDecode('''
        {"id": "r-1", "status": "error", "results": [{"file": "files/renders/a.png", "error": "复制失败：x"}]}
      '''));
      expect(r!.results.single.error, '复制失败：x');
    });
  });

  group('Scenes / 推荐 / 自动填充', () {
    test('scenes 聚合解析', () {
      final s = ScenesBundle.fromJson(jsonDecode(
        '{"scenes": ["首饰", "家居"], "tags": {"materials": ["墙纸"], "templates": ["卧室"]}}'
      ));
      expect(s.scenes, ['首饰', '家居']);
      expect(s.templateTags, ['卧室']);
    });

    test('auto-recommend 解析', () {
      final r = RecommendResult.fromJson(jsonDecode(
        '{"recommended": ["m-1"], "candidates": [{"materialId": "m-1", "score": 3.5}, {"materialId": "m-2", "score": 1}]}'
      ));
      expect(r.recommended, ['m-1']);
      expect(r.candidates.first.score, 3.5);
    });

    test('auto-fill 解析（含空推荐插槽）', () {
      final a = AutoFillResult.fromJson(jsonDecode('''
        {"slots": [
          {"slotId": "s-1", "recommended": "m-1", "candidates": []},
          {"slotId": "s-2", "recommended": null, "candidates": []}
        ]}
      '''));
      expect(a.slots.length, 2);
      expect(a.slots[0].recommended, 'm-1');
      expect(a.slots[1].recommended, isNull);
    });
  });
}
