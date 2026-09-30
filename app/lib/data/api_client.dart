/// 服务端 API 封装（全部端点 + 错误映射 + multipart 上传）。
///
/// 契约来源：server/server.mjs、server/lib/http.mjs、server/lib/upload.mjs。
/// 错误统一抛 [ApiException]：`{status, code, message}`（message 已本地化，可直接展示）。
library;

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../config.dart';
import 'models.dart';

/// 读取超时（普通请求）；上传单独放宽。
const _requestTimeout = Duration(seconds: 30);
const _uploadTimeout = Duration(seconds: 120);

class ApiException implements Exception {
  const ApiException({required this.status, required this.code, required this.message});

  /// HTTP 状态码；网络层失败为 0。
  final int status;
  final String code;
  final String message;

  bool get isNetworkError => status == 0;

  @override
  String toString() => 'ApiException($status $code): $message';
}

/// 健康检查信息（GET /api/health）。
class HealthInfo {
  const HealthInfo({
    this.ok = false,
    this.version = '',
    this.cliReady = false,
    this.cliDetail = '',
    this.queueRunning = 0,
    this.queuePending = 0
  });

  final bool ok;
  final String version;

  /// qodercli 是否就绪（未就绪时出图必然失败，界面提示）。
  final bool cliReady;
  final String cliDetail;
  final int queueRunning;
  final int queuePending;

  static HealthInfo fromJson(Object? json) {
    final m = json is Map<String, Object?> ? json : const <String, Object?>{};
    final cli = m['cli'] is Map<String, Object?> ? m['cli'] as Map<String, Object?> : const <String, Object?>{};
    final queue =
        m['queue'] is Map<String, Object?> ? m['queue'] as Map<String, Object?> : const <String, Object?>{};
    final cliError = cli['error'];
    final err = cliError is String && cliError.isNotEmpty ? cliError : '';
    final cliReady = err.isEmpty;
    return HealthInfo(
      ok: m['ok'] == true,
      version: m['version'] is String ? m['version'] as String : '',
      cliReady: cliReady,
      cliDetail: cliReady ? (cli['resolvedFrom'] is String ? cli['resolvedFrom'] as String : '') : err,
      queueRunning: queue['running'] is num ? (queue['running'] as num).toInt() : 0,
      queuePending: queue['pending'] is num ? (queue['pending'] as num).toInt() : 0
    );
  }
}

class Api {
  Api({http.Client? client}) : _client = client ?? http.Client();

  final http.Client _client;

  void close() => _client.close();

  // ---------- 基础 ----------

  Future<HealthInfo> health() async => HealthInfo.fromJson(await _get('/api/health'));

  Future<ScenesBundle> scenes() async => ScenesBundle.fromJson(await _get('/api/scenes'));

  // ---------- 素材 / 样板 ----------

  static const kMaterials = 'materials';
  static const kTemplates = 'templates';

  Future<Paged<LibraryDoc>> listLibrary(
    String kind, {
    String? scene,
    List<String> tags = const [],
    String? q,
    bool includeDeleted = false,
    int? limit,
    int offset = 0
  }) async {
    final query = <String, String>{
      if (scene != null && scene.isNotEmpty) 'scene': scene,
      if (tags.isNotEmpty) 'tags': tags.join(','),
      if (q != null && q.trim().isNotEmpty) 'q': q.trim(),
      if (includeDeleted) 'includeDeleted': '1',
      if (limit != null) 'limit': '$limit',
      'offset': '$offset'
    };
    final json = await _get('/api/$kind', query: query);
    return Paged.fromJson(json, LibraryDoc.fromJson);
  }

  Future<LibraryDoc> createLibrary(
    String kind, {
    required String name,
    String description = '',
    required String scene,
    List<String> tags = const []
  }) async {
    final json = await _post('/api/$kind', {
      'name': name,
      'description': description,
      'scene': scene,
      'tags': tags
    });
    return _must(LibraryDoc.fromJson(json), '创建$kind 返回异常');
  }

  Future<LibraryDoc> getLibrary(String kind, String id) async =>
      _must(LibraryDoc.fromJson(await _get('/api/$kind/$id')), '获取$kind 返回异常');

  Future<LibraryDoc> updateLibrary(
    String kind,
    String id, {
    String? name,
    String? description,
    String? scene,
    List<String>? tags
  }) async {
    final json = await _put('/api/$kind/$id', {
      'name': ?name,
      'description': ?description,
      'scene': ?scene,
      'tags': ?tags
    });
    return _must(LibraryDoc.fromJson(json), '更新$kind 返回异常');
  }

  Future<LibraryDoc> deleteLibrary(String kind, String id) async =>
      _must(LibraryDoc.fromJson(await _delete('/api/$kind/$id')), '删除$kind 返回异常');

  Future<LibraryDoc> undeleteLibrary(String kind, String id) async =>
      _must(LibraryDoc.fromJson(await _post('/api/$kind/$id/undelete')), '恢复$kind 返回异常');

  /// 上传单张图片（multipart，字段名固定 `file`）；返回更新后的文档。
  Future<LibraryDoc> uploadLibraryImage(
    String kind,
    String id, {
    required String filename,
    required List<int> bytes
  }) async {
    final json = await _upload('/api/$kind/$id/images', filename: filename, bytes: bytes);
    return _must(LibraryDoc.fromJson(json), '上传返回异常');
  }

  Future<LibraryDoc> deleteLibraryImage(String kind, String id, int index) async =>
      _must(LibraryDoc.fromJson(await _delete('/api/$kind/$id/images/$index')), '删除图片返回异常');

  // ---------- 预设 ----------

  Future<Paged<Preset>> listPresets({
    String? q,
    bool includeDeleted = false,
    int? limit,
    int offset = 0
  }) async {
    final query = <String, String>{
      if (q != null && q.trim().isNotEmpty) 'q': q.trim(),
      if (includeDeleted) 'includeDeleted': '1',
      if (limit != null) 'limit': '$limit',
      'offset': '$offset'
    };
    final json = await _get('/api/presets', query: query);
    return Paged.fromJson(json, Preset.fromJson);
  }

  Future<Preset> createPreset({
    required String name,
    required String templateId,
    required List<Slot> slots
  }) async {
    final json = await _post('/api/presets', {
      'name': name,
      'templateId': templateId,
      'slots': slots.map((s) => s.toJson()).toList()
    });
    return _must(Preset.fromJson(json), '创建预设返回异常');
  }

  Future<Preset> getPreset(String id) async =>
      _must(Preset.fromJson(await _get('/api/presets/$id')), '获取预设返回异常');

  Future<Preset> updatePreset(
    String id, {
    String? name,
    String? templateId,
    List<Slot>? slots
  }) async {
    final json = await _put('/api/presets/$id', {
      'name': ?name,
      'templateId': ?templateId,
      'slots': ?slots?.map((s) => s.toJson()).toList()
    });
    return _must(Preset.fromJson(json), '更新预设返回异常');
  }

  Future<Preset> deletePreset(String id) async =>
      _must(Preset.fromJson(await _delete('/api/presets/$id')), '删除预设返回异常');

  Future<Preset> undeletePreset(String id) async =>
      _must(Preset.fromJson(await _post('/api/presets/$id/undelete')), '恢复预设返回异常');

  Future<Preset> duplicatePreset(String id) async =>
      _must(Preset.fromJson(await _post('/api/presets/$id/duplicate')), '复制预设返回异常');

  // ---------- 推荐 / 自动填充 ----------

  Future<RecommendResult> autoRecommend({required String templateId, int limit = 6}) async =>
      RecommendResult.fromJson(await _post('/api/renders/auto-recommend', {
        'templateId': templateId,
        'limit': limit
      }));

  Future<AutoFillResult> autoFill(String presetId) async =>
      AutoFillResult.fromJson(await _post('/api/presets/$presetId/auto-fill'));

  // ---------- 素材图优化 ----------

  /// 发起素材图优化 → taskId。
  Future<String> startMaterialOptimize(String materialId, int index) async {
    final json = await _post('/api/materials/$materialId/optimize', {'index': index});
    final m = json is Map<String, Object?> ? json : const <String, Object?>{};
    final id = m['taskId'];
    if (id is! String || id.isEmpty) {
      throw const ApiException(status: 0, code: 'BAD_RESPONSE', message: '发起优化返回异常');
    }
    return id;
  }

  /// 采用优化结果 → 更新后的素材。
  Future<LibraryDoc> adoptOptimize(String materialId, String taskId) async =>
      _must(
        LibraryDoc.fromJson(await _post('/api/materials/$materialId/optimize/$taskId/adopt')),
        '采用优化返回异常'
      );

  /// 放弃优化（幂等；进行中会先中止）。
  Future<void> discardOptimize(String materialId, String taskId) async {
    await _post('/api/materials/$materialId/optimize/$taskId/discard');
  }

  // ---------- 出图 ----------

  /// 组装 free 模式出图请求体。
  static Map<String, Object?> freeRenderBody({
    required String templateId,
    required List<String> materialIds,
    required String positionNote,
    required int candidateCount
  }) => {
    'mode': 'free',
    'templateId': templateId,
    'materialIds': materialIds,
    'positionNote': positionNote,
    'candidateCount': candidateCount
  };

  /// 组装 preset 模式出图请求体。
  static Map<String, Object?> presetRenderBody({
    required String presetId,
    required List<({String slotId, String materialId})> assignments,
    required String positionNote,
    required int candidateCount
  }) => {
    'mode': 'preset',
    'presetId': presetId,
    'assignments': assignments.map((a) => {'slotId': a.slotId, 'materialId': a.materialId}).toList(),
    'positionNote': positionNote,
    'candidateCount': candidateCount
  };

  /// 提交出图 → renderId。
  Future<String> createRender(Map<String, Object?> body) async {
    final json = await _post('/api/renders', body);
    final m = json is Map<String, Object?> ? json : const <String, Object?>{};
    final id = m['renderId'];
    if (id is! String || id.isEmpty) throw const ApiException(status: 0, code: 'BAD_RESPONSE', message: '提交出图返回异常');
    return id;
  }

  Future<Paged<RenderDoc>> listRenders({
    String? templateId,
    String? materialId,
    int? limit,
    int offset = 0
  }) async {
    final query = <String, String>{
      if (templateId != null && templateId.isNotEmpty) 'templateId': templateId,
      if (materialId != null && materialId.isNotEmpty) 'materialId': materialId,
      if (limit != null) 'limit': '$limit',
      'offset': '$offset'
    };
    final json = await _get('/api/renders', query: query);
    return Paged.fromJson(json, RenderDoc.fromJson);
  }

  Future<RenderDoc> getRender(String id) async =>
      _must(RenderDoc.fromJson(await _get('/api/renders/$id')), '获取记录返回异常');

  /// 停止出图 → 最新状态字符串。
  Future<String> stopRender(String id) async {
    final json = await _post('/api/renders/$id/stop');
    final m = json is Map<String, Object?> ? json : const <String, Object?>{};
    return m['status'] is String ? m['status'] as String : 'unknown';
  }

  /// 再出一版 → 新记录 id。
  Future<String> rerunRender(
    String id, {
    String? positionNote,
    int? candidateCount,
    List<String>? materialIds,
    List<({String slotId, String materialId})>? assignments
  }) async {
    final json = await _post('/api/renders/$id/rerun', {
      'positionNote': ?positionNote,
      'candidateCount': ?candidateCount,
      'materialIds': ?materialIds,
      'assignments': ?assignments?.map((a) => {'slotId': a.slotId, 'materialId': a.materialId}).toList()
    });
    final m = json is Map<String, Object?> ? json : const <String, Object?>{};
    final newId = m['renderId'];
    if (newId is! String || newId.isEmpty) throw const ApiException(status: 0, code: 'BAD_RESPONSE', message: '再出一版返回异常');
    return newId;
  }

  /// 选用/取消选用某张候选（index 从 1 起）。
  Future<RenderDoc> setChosen(String renderId, int index, bool chosen) async =>
      _must(
        RenderDoc.fromJson(await _post('/api/renders/$renderId/results/$index/chosen', {'chosen': chosen})),
        '选用返回异常'
      );

  // ---------- 内部 ----------

  static T _must<T>(T? v, String message) =>
      v ?? (throw ApiException(status: 0, code: 'BAD_RESPONSE', message: message));

  Uri _uri(String path, [Map<String, String>? query]) {
    final uri = apiUri(path);
    if (query == null || query.isEmpty) return uri;
    return uri.replace(queryParameters: {...uri.queryParameters, ...query});
  }

  Future<Object?> _get(String path, {Map<String, String>? query}) async {
    final res = await _guard(() => _client.get(_uri(path, query)).timeout(_requestTimeout));
    return _decode(res);
  }

  Future<Object?> _post(String path, [Object? body]) async {
    final res = await _guard(
      () => _client
          .post(_uri(path),
              headers: const {'Content-Type': 'application/json'},
              body: jsonEncode(body ?? const <String, Object?>{}))
          .timeout(_requestTimeout)
    );
    return _decode(res);
  }

  Future<Object?> _put(String path, Object body) async {
    final res = await _guard(
      () => _client
          .put(_uri(path), headers: const {'Content-Type': 'application/json'}, body: jsonEncode(body))
          .timeout(_requestTimeout)
    );
    return _decode(res);
  }

  Future<Object?> _delete(String path) async {
    final res = await _guard(() => _client.delete(_uri(path)).timeout(_requestTimeout));
    return _decode(res);
  }

  Future<Object?> _upload(String path, {required String filename, required List<int> bytes}) async {
    final req = http.MultipartRequest('POST', _uri(path))
      ..files.add(http.MultipartFile.fromBytes('file', bytes, filename: filename));
    final res = await _guard(() async => http.Response.fromStream(await _client.send(req)).timeout(_uploadTimeout));
    return _decode(res);
  }

  /// 网络层异常 → ApiException(status 0)。
  Future<T> _guard<T>(Future<T> Function() run) async {
    try {
      return await run();
    } on ApiException {
      rethrow;
    } on TimeoutException {
      throw const ApiException(status: 0, code: 'TIMEOUT', message: '请求超时，请确认与服务器的网络连通');
    } catch (e) {
      throw ApiException(status: 0, code: 'NETWORK_ERROR', message: '无法连接服务器：$e');
    }
  }

  Object? _decode(http.Response res) {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      final text = utf8.decode(res.bodyBytes);
      if (text.trim().isEmpty) return null;
      try {
        return jsonDecode(text);
      } catch (_) {
        throw const ApiException(status: 0, code: 'BAD_JSON', message: '服务器返回了非 JSON 内容');
      }
    }
    // 错误契约：{ error: { code, message } }
    var message = '请求失败（${res.statusCode}）';
    var code = 'HTTP_${res.statusCode}';
    try {
      final data = jsonDecode(utf8.decode(res.bodyBytes));
      if (data is Map<String, Object?>) {
        final err = data['error'];
        if (err is Map<String, Object?>) {
          if (err['message'] is String && (err['message'] as String).isNotEmpty) {
            message = err['message'] as String;
          }
          if (err['code'] is String && (err['code'] as String).isNotEmpty) {
            code = err['code'] as String;
          }
        }
      }
    } catch (_) {
      /* 非 JSON 错误体，用默认文案 */
    }
    throw ApiException(status: res.statusCode, code: code, message: message);
  }
}
