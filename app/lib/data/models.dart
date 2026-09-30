/// 服务端 JSON 实体模型（契约见 docs/specs/2026-09-30-styling-station-design.md §5）。
///
/// 解析策略：宽容读取——字段缺失/类型不符时取安全默认值，绝不抛出；
/// 只在 id 缺失时返回 null（调用方跳过该条）。
library;

// ---------- 基础 ----------

List<String> _strList(Object? v) =>
    v is List ? v.whereType<String>().map((s) => s).toList(growable: false) : const [];

String _str(Object? v, [String fallback = '']) => v is String ? v : fallback;

int _int(Object? v, [int fallback = 0]) => v is num ? v.toInt() : fallback;

bool _bool(Object? v, [bool fallback = false]) => v is bool ? v : fallback;

/// 服务端统一列表响应 `{total, items}`。
class Paged<T> {
  const Paged({required this.total, required this.items});

  final int total;
  final List<T> items;

  static Paged<T> fromJson<T>(Object? json, T? Function(Map<String, Object?>) parse) {
    final m = json is Map<String, Object?> ? json : const <String, Object?>{};
    final raw = m['items'];
    final items = <T>[];
    if (raw is List) {
      for (final e in raw) {
        if (e is Map<String, Object?>) {
          final parsed = parse(e);
          if (parsed != null) items.add(parsed);
        }
      }
    }
    return Paged(total: _int(m['total'], items.length), items: items);
  }
}

/// 素材库 / 样板库（同构视图的两端）。
enum LibraryKind {
  materials('materials', '素材'),
  templates('templates', '样板');

  const LibraryKind(this.kind, this.noun);

  /// API 路径段（materials / templates）。
  final String kind;

  /// 中文名词（“素材/样板”），用于文案拼接。
  final String noun;
}

// ---------- 图片 ----------

/// 素材/样板图片条目。
class ImageRef {
  const ImageRef({
    required this.file,
    this.width = 0,
    this.height = 0,
    this.primary = false
  });

  /// 相对路径，如 `files/materials/<id>/1.png`。
  final String file;
  final int width;
  final int height;
  final bool primary;

  static ImageRef? fromJson(Object? json) {
    if (json is! Map<String, Object?>) return null;
    final file = _str(json['file']);
    if (file.isEmpty) return null;
    return ImageRef(
      file: file,
      width: _int(json['width']),
      height: _int(json['height']),
      primary: _bool(json['primary'])
    );
  }

  static List<ImageRef> listFromJson(Object? json) {
    if (json is! List) return const [];
    return json.map(ImageRef.fromJson).whereType<ImageRef>().toList(growable: false);
  }
}

// ---------- 素材 / 样板 ----------

/// 素材与样板共用同一结构（服务端同构，页面按 kind 参数化）。
class LibraryDoc {
  const LibraryDoc({
    required this.id,
    required this.name,
    this.description = '',
    this.scene = '',
    this.tags = const [],
    this.images = const [],
    this.createdAt = '',
    this.updatedAt = '',
    this.deleted = false,
    this.hasImage = false
  });

  final String id;
  final String name;
  final String description;
  final String scene;
  final List<String> tags;
  final List<ImageRef> images;
  final String createdAt;
  final String updatedAt;
  final bool deleted;

  /// 列表接口附带；无图素材不可搭配。
  final bool hasImage;

  ImageRef? get primaryImage => images.isEmpty ? null : images.first;

  static LibraryDoc? fromJson(Object? json) {
    if (json is! Map<String, Object?>) return null;
    final id = _str(json['id']);
    if (id.isEmpty) return null;
    final images = ImageRef.listFromJson(json['images']);
    return LibraryDoc(
      id: id,
      name: _str(json['name']),
      description: _str(json['description']),
      scene: _str(json['scene']),
      tags: _strList(json['tags']),
      images: images,
      createdAt: _str(json['createdAt']),
      updatedAt: _str(json['updatedAt']),
      deleted: _bool(json['deleted']),
      hasImage: _bool(json['hasImage'], images.isNotEmpty)
    );
  }
}

/// 场景与标签聚合（GET /api/scenes）。
class ScenesBundle {
  const ScenesBundle({this.scenes = const [], this.materialTags = const [], this.templateTags = const []});

  final List<String> scenes;
  final List<String> materialTags;
  final List<String> templateTags;

  static ScenesBundle fromJson(Object? json) {
    if (json is! Map<String, Object?>) return const ScenesBundle();
    final tags = json['tags'];
    final tagMap = tags is Map<String, Object?> ? tags : const <String, Object?>{};
    return ScenesBundle(
      scenes: _strList(json['scenes']),
      materialTags: _strList(tagMap['materials']),
      templateTags: _strList(tagMap['templates'])
    );
  }
}

// ---------- 预设 ----------

/// 预设插槽：名称 + 标签 + 位置说明。
class Slot {
  const Slot({required this.id, required this.name, this.tags = const [], this.positionNote = ''});

  final String id;
  final String name;
  final List<String> tags;
  final String positionNote;

  static Slot? fromJson(Object? json) {
    if (json is! Map<String, Object?>) return null;
    final id = _str(json['id']);
    if (id.isEmpty) return null;
    return Slot(
      id: id,
      name: _str(json['name']),
      tags: _strList(json['tags']),
      positionNote: _str(json['positionNote'])
    );
  }

  Map<String, Object?> toJson() => {'id': id, 'name': name, 'tags': tags, 'positionNote': positionNote};
}

/// 预设所引用样板的摘要（失效时为 null）。
class TemplateBrief {
  const TemplateBrief({required this.id, required this.name, this.images = const [], this.primary});

  final String id;
  final String name;
  final List<ImageRef> images;

  /// 主图相对路径（服务端直接给出，可能为空）。
  final String? primary;

  static TemplateBrief? fromJson(Object? json) {
    if (json is! Map<String, Object?>) return null;
    final id = _str(json['id']);
    if (id.isEmpty) return null;
    final primary = json['primary'];
    return TemplateBrief(
      id: id,
      name: _str(json['name']),
      images: ImageRef.listFromJson(json['images']),
      primary: primary is String && primary.isNotEmpty ? primary : null
    );
  }
}

/// 预设：样板 + 1~10 个插槽。
class Preset {
  const Preset({
    required this.id,
    required this.name,
    required this.templateId,
    this.slots = const [],
    this.createdAt = '',
    this.updatedAt = '',
    this.deleted = false,
    this.templateValid = false,
    this.template
  });

  final String id;
  final String name;
  final String templateId;
  final List<Slot> slots;
  final String createdAt;
  final String updatedAt;
  final bool deleted;

  /// 样板是否仍有效（被删/不存在时为 false，界面打「样板失效」徽标）。
  final bool templateValid;
  final TemplateBrief? template;

  static Preset? fromJson(Object? json) {
    if (json is! Map<String, Object?>) return null;
    final id = _str(json['id']);
    if (id.isEmpty) return null;
    final slots = <Slot>[];
    final rawSlots = json['slots'];
    if (rawSlots is List) {
      for (final s in rawSlots) {
        final slot = Slot.fromJson(s);
        if (slot != null) slots.add(slot);
      }
    }
    return Preset(
      id: id,
      name: _str(json['name']),
      templateId: _str(json['templateId']),
      slots: slots,
      createdAt: _str(json['createdAt']),
      updatedAt: _str(json['updatedAt']),
      deleted: _bool(json['deleted']),
      templateValid: _bool(json['templateValid']),
      template: TemplateBrief.fromJson(json['template'])
    );
  }
}

// ---------- 出图记录 ----------

/// 出图状态机（服务端 §6.5）。
enum RenderStatus {
  queued,
  running,
  done,
  error,
  stopped,
  unknown;

  static RenderStatus parse(Object? v) => switch (v) {
        'queued' => RenderStatus.queued,
        'running' => RenderStatus.running,
        'done' => RenderStatus.done,
        'error' => RenderStatus.error,
        'stopped' => RenderStatus.stopped,
        _ => RenderStatus.unknown
      };

  bool get terminal =>
      this == RenderStatus.done || this == RenderStatus.error || this == RenderStatus.stopped;

  String get label => switch (this) {
        RenderStatus.queued => '排队中',
        RenderStatus.running => '出图中',
        RenderStatus.done => '已完成',
        RenderStatus.error => '失败',
        RenderStatus.stopped => '已停止',
        RenderStatus.unknown => '未知'
      };
}

/// 出图候选结果。
class RenderResult {
  const RenderResult({
    required this.file,
    this.width = 0,
    this.height = 0,
    this.chosen = false,
    this.error
  });

  final String file;
  final int width;
  final int height;
  final bool chosen;
  final String? error;

  static RenderResult? fromJson(Object? json) {
    if (json is! Map<String, Object?>) return null;
    final file = _str(json['file']);
    if (file.isEmpty) return null;
    final error = json['error'];
    return RenderResult(
      file: file,
      width: _int(json['width']),
      height: _int(json['height']),
      chosen: _bool(json['chosen']),
      error: error is String && error.isNotEmpty ? error : null
    );
  }
}

/// 历史快照条目（样板快照 / 素材快照共用；slot* 仅素材快照有）。
class SnapshotItem {
  const SnapshotItem({
    required this.id,
    required this.name,
    this.description = '',
    this.tags = const [],
    this.images = const [],
    this.slotId,
    this.slotName,
    this.slotPosition
  });

  final String id;
  final String name;
  final String description;
  final List<String> tags;
  final List<ImageRef> images;
  final String? slotId;
  final String? slotName;
  final String? slotPosition;

  static SnapshotItem? fromJson(Object? json) {
    if (json is! Map<String, Object?>) return null;
    final id = _str(json['id']);
    if (id.isEmpty) return null;
    return SnapshotItem(
      id: id,
      name: _str(json['name']),
      description: _str(json['description']),
      tags: _strList(json['tags']),
      images: ImageRef.listFromJson(json['images']),
      slotId: json['slotId'] is String ? json['slotId'] as String : null,
      slotName: json['slotName'] is String ? json['slotName'] as String : null,
      slotPosition: json['slotPosition'] is String ? json['slotPosition'] as String : null
    );
  }

  static List<SnapshotItem> listFromJson(Object? json) {
    if (json is! List) return const [];
    return json.map(SnapshotItem.fromJson).whereType<SnapshotItem>().toList(growable: false);
  }
}

/// 出图记录（含快照，可回溯、可再出一版）。
class RenderDoc {
  const RenderDoc({
    required this.id,
    required this.mode,
    required this.status,
    this.parentId,
    this.positionNote = '',
    this.candidateCount = 1,
    this.results = const [],
    this.cliSessionId,
    this.startedAt,
    this.finishedAt,
    this.elapsedMs,
    this.stderrTail,
    this.templateSnapshot,
    this.presetId,
    this.presetName,
    this.materialsSnapshot = const [],
    this.size = '',
    this.createdAt = '',
    this.childrenIds = const []
  });

  /// 'free' | 'preset'
  final String mode;
  final RenderStatus status;
  final String id;
  final String? parentId;
  final String positionNote;
  final int candidateCount;
  final List<RenderResult> results;
  final String? cliSessionId;
  final String? startedAt;
  final String? finishedAt;
  final int? elapsedMs;

  /// 失败时的 stderr 摘要。
  final String? stderrTail;
  final SnapshotItem? templateSnapshot;
  final String? presetId;
  final String? presetName;
  final List<SnapshotItem> materialsSnapshot;
  final String size;
  final String createdAt;

  /// 仅详情接口返回。
  final List<String> childrenIds;

  bool get isFree => mode == 'free';

  static RenderDoc? fromJson(Object? json) {
    if (json is! Map<String, Object?>) return null;
    final id = _str(json['id']);
    if (id.isEmpty) return null;
    final rawResults = json['results'];
    final results = <RenderResult>[];
    if (rawResults is List) {
      for (final r in rawResults) {
        final item = RenderResult.fromJson(r);
        if (item != null) results.add(item);
      }
    }
    final presetSnap = json['presetSnapshot'];
    final presetMap = presetSnap is Map<String, Object?> ? presetSnap : null;
    final status = RenderStatus.parse(json['status']);
    final mode = _str(json['mode'], 'free');
    return RenderDoc(
      id: id,
      mode: mode.isEmpty ? 'free' : mode,
      status: status,
      parentId: json['parentId'] is String ? json['parentId'] as String : null,
      positionNote: _str(json['positionNote']),
      candidateCount: _int(json['candidateCount'], 1),
      results: results,
      cliSessionId: json['cliSessionId'] is String ? json['cliSessionId'] as String : null,
      startedAt: json['startedAt'] is String ? json['startedAt'] as String : null,
      finishedAt: json['finishedAt'] is String ? json['finishedAt'] as String : null,
      elapsedMs: json['elapsedMs'] is num ? (json['elapsedMs'] as num).toInt() : null,
      stderrTail: json['stderrTail'] is String ? json['stderrTail'] as String : null,
      templateSnapshot: SnapshotItem.fromJson(json['templateSnapshot']),
      presetId: json['presetId'] is String ? json['presetId'] as String : null,
      presetName: presetMap != null ? _str(presetMap['name']) : null,
      materialsSnapshot: SnapshotItem.listFromJson(json['materialsSnapshot']),
      size: _str(json['size']),
      createdAt: _str(json['createdAt']),
      childrenIds: _strList(json['childrenIds'])
    );
  }
}

// ---------- 推荐 / 自动填充 ----------

class Candidate {
  const Candidate({required this.materialId, this.score = 0});

  final String materialId;
  final double score;

  static Candidate? fromJson(Object? json) {
    if (json is! Map<String, Object?>) return null;
    final id = _str(json['materialId']);
    if (id.isEmpty) return null;
    return Candidate(materialId: id, score: json['score'] is num ? (json['score'] as num).toDouble() : 0);
  }

  static List<Candidate> listFromJson(Object? json) {
    if (json is! List) return const [];
    return json.map(Candidate.fromJson).whereType<Candidate>().toList(growable: false);
  }
}

/// POST /api/renders/auto-recommend 响应。
class RecommendResult {
  const RecommendResult({this.recommended = const [], this.candidates = const []});

  final List<String> recommended;
  final List<Candidate> candidates;

  static RecommendResult fromJson(Object? json) {
    if (json is! Map<String, Object?>) return const RecommendResult();
    return RecommendResult(
      recommended: _strList(json['recommended']),
      candidates: Candidate.listFromJson(json['candidates'])
    );
  }
}

/// 单个插槽的自动填充建议。
class SlotFill {
  const SlotFill({required this.slotId, this.recommended, this.candidates = const []});

  final String slotId;
  final String? recommended;
  final List<Candidate> candidates;

  static SlotFill? fromJson(Object? json) {
    if (json is! Map<String, Object?>) return null;
    final slotId = _str(json['slotId']);
    if (slotId.isEmpty) return null;
    final rec = json['recommended'];
    return SlotFill(
      slotId: slotId,
      recommended: rec is String && rec.isNotEmpty ? rec : null,
      candidates: Candidate.listFromJson(json['candidates'])
    );
  }
}

/// POST /api/presets/:id/auto-fill 响应。
class AutoFillResult {
  const AutoFillResult({this.slots = const []});

  final List<SlotFill> slots;

  static AutoFillResult fromJson(Object? json) {
    final m = json is Map<String, Object?> ? json : const <String, Object?>{};
    final raw = m['slots'];
    final slots = <SlotFill>[];
    if (raw is List) {
      for (final s in raw) {
        final fill = SlotFill.fromJson(s);
        if (fill != null) slots.add(fill);
      }
    }
    return AutoFillResult(slots: slots);
  }
}
