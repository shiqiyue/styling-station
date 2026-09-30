import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:styling_station/data/api_client.dart';

http.Response _json200(Object body) =>
    http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json; charset=utf-8'});

void main() {
  group('错误映射', () {
    test('服务端错误信封 {error:{code,message}} → ApiException', () async {
      final api = Api(
        client: MockClient((req) async => http.Response(
              jsonEncode({
                'error': {'code': 'INVALID_NAME', 'message': '名称不能为空'}
              }),
              400,
              headers: {'content-type': 'application/json'}
            ))
      );
      await expectLater(
        api.createLibrary('materials', name: '', scene: '家居'),
        throwsA(isA<ApiException>()
            .having((e) => e.status, 'status', 400)
            .having((e) => e.code, 'code', 'INVALID_NAME')
            .having((e) => e.message, 'message', '名称不能为空'))
      );
    });

    test('非 JSON 错误体 → 默认文案', () async {
      final api = Api(client: MockClient((req) async => http.Response('oops', 502)));
      await expectLater(
        api.health(),
        throwsA(isA<ApiException>().having((e) => e.message, 'message', contains('502')))
      );
    });

    test('网络层异常（ClientException）→ status 0 NETWORK_ERROR', () async {
      final api = Api(
        client: MockClient((req) async => throw http.ClientException('Connection refused'))
      );
      await expectLater(
        api.health(),
        throwsA(isA<ApiException>()
            .having((e) => e.status, 'status', 0)
            .having((e) => e.code, 'code', 'NETWORK_ERROR'))
      );
    });
  });

  group('列表查询参数', () {
    test('素材列表拼接 scene/tags/q/includeDeleted/limit/offset', () async {
      late Uri captured;
      final api = Api(
        client: MockClient((req) async {
          captured = req.url;
          return _json200({'total': 0, 'items': []});
        })
      );
      final page = await api.listLibrary('materials',
          scene: '家居', tags: ['墙纸', '奶油色'], q: ' 奶油 ', includeDeleted: true, limit: 20, offset: 40);
      expect(page.total, 0);
      final qp = captured.queryParameters;
      expect(qp['scene'], '家居');
      expect(qp['tags'], '墙纸,奶油色');
      expect(qp['q'], '奶油');
      expect(qp['includeDeleted'], '1');
      expect(qp['limit'], '20');
      expect(qp['offset'], '40');
    });
  });

  group('multipart 上传', () {
    test('字段名固定 file、带 filename、字节内容完整', () async {
      late http.Request captured;
      final api = Api(
        client: MockClient((req) async {
          captured = req;
          return _json200({'id': 'm-1', 'name': 'x', 'scene': 'y', 'images': [], 'tags': []});
        })
      );
      final doc = await api.uploadLibraryImage('materials', 'm-1',
          filename: 'photo.png', bytes: [137, 80, 78, 71, 1, 2, 3]);
      expect(doc.id, 'm-1');

      final contentType = captured.headers['content-type'] ?? '';
      expect(contentType, startsWith('multipart/form-data; boundary='));
      final body = utf8.decode(captured.bodyBytes, allowMalformed: true);
      expect(body, contains('name="file"'));
      expect(body, contains('filename="photo.png"'));
      expect(body, contains('\r\n\r\n'));
      // 字节安全：PNG magic 原样出现
      expect(captured.bodyBytes.indexOf(137), greaterThanOrEqualTo(0));
    });
  });

  group('出图端点', () {
    test('createRender 解析 renderId；缺失时 BAD_RESPONSE', () async {
      final ok = Api(client: MockClient((req) async => _json200({'renderId': 'r-1'})));
      expect(await ok.createRender(Api.freeRenderBody(
        templateId: 't-1',
        materialIds: ['m-1'],
        positionNote: '',
        candidateCount: 1
      )), 'r-1');

      final bad = Api(client: MockClient((req) async => _json200({'nope': true})));
      await expectLater(
        bad.createRender(const {}),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', 'BAD_RESPONSE'))
      );
    });

    test('free/preset 请求体组装', () {
      final free = Api.freeRenderBody(
          templateId: 't-1', materialIds: ['m-1', 'm-2'], positionNote: '放桌上', candidateCount: 4);
      expect(free['mode'], 'free');
      expect(free['materialIds'], ['m-1', 'm-2']);

      final preset = Api.presetRenderBody(
        presetId: 'p-1',
        assignments: [(slotId: 's-1', materialId: 'm-1')],
        positionNote: '',
        candidateCount: 2
      );
      expect(preset['mode'], 'preset');
      expect((preset['assignments'] as List).single, {'slotId': 's-1', 'materialId': 'm-1'});
    });

    test('stopRender 返回状态字符串', () async {
      final api = Api(client: MockClient((req) async => _json200({'status': 'stopping'})));
      expect(await api.stopRender('r-1'), 'stopping');
    });

    test('setChosen 解析更新后的记录', () async {
      final api = Api(
        client: MockClient((req) async {
          expect(req.url.path, '/api/renders/r-1/results/2/chosen');
          expect(jsonDecode(req.body), {'chosen': true});
          return _json200({
            'id': 'r-1',
            'status': 'done',
            'results': [
              {'file': 'a.png', 'chosen': false},
              {'file': 'b.png', 'chosen': true}
            ]
          });
        })
      );
      final doc = await api.setChosen('r-1', 2, true);
      expect(doc.results[1].chosen, isTrue);
    });
  });

  group('health', () {
    test('cli 就绪与未就绪两种形态', () async {
      final ready = Api(client: MockClient((req) async => _json200({
            'ok': true,
            'version': '0.1.0',
            'cli': {'command': 'qodercli', 'resolvedFrom': 'PATH'},
            'queue': {'running': 1, 'pending': 2}
          })));
      final h1 = await ready.health();
      expect(h1.cliReady, isTrue);
      expect(h1.queuePending, 2);

      final broken = Api(client: MockClient((req) async => _json200({
            'ok': true,
            'version': '0.1.0',
            'cli': {'error': '未找到 qodercli'},
            'queue': {'running': 0, 'pending': 0}
          })));
      final h2 = await broken.health();
      expect(h2.cliReady, isFalse);
      expect(h2.cliDetail, '未找到 qodercli');
    });
  });

  group('renders 列表筛选参数', () {
    test('templateId/materialId/offset 透传', () async {
      late Uri captured;
      final api = Api(
        client: MockClient((req) async {
          captured = req.url;
          return _json200({'total': 0, 'items': []});
        })
      );
      await api.listRenders(templateId: 't-1', materialId: 'm-1', limit: 20, offset: 20);
      expect(captured.queryParameters['templateId'], 't-1');
      expect(captured.queryParameters['materialId'], 'm-1');
      expect(captured.queryParameters['limit'], '20');
      expect(captured.queryParameters['offset'], '20');
    });
  });
}
