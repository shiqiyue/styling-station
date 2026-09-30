/**
 * 标签打分推荐（Spec §7，简单可解释）：
 * - 基础分 = baseTags ∩ 素材标签 的命中数 × 2（自由模式 baseTags=样板标签；预设模式=插槽标签）
 * - 同 scene 加 1 分
 * - 名称/描述包含某个 baseTag 词，每个 +0.5（弱信号）
 * - 无图素材不进候选；得分降序、同分 updatedAt 新者优先
 */

export function rankMaterials({ baseTags = [], scene = '', materials = [], limit } = {}) {
  const tags = (Array.isArray(baseTags) ? baseTags : []).filter(Boolean)
  const scored = []
  for (const m of materials) {
    const hasImage = (m.images?.length > 0) || m.hasImage === true
    if (!hasImage) continue
    const mTags = Array.isArray(m.tags) ? m.tags : []
    let tagHits = 0
    for (const t of tags) if (mTags.includes(t)) tagHits++
    const sameScene = !!scene && m.scene === scene
    let score = tagHits * 2 + (sameScene ? 1 : 0)
    const text = `${m.name || ''} ${m.description || ''}`
    for (const t of tags) if (text.includes(t)) score += 0.5
    scored.push({ materialId: m.id, score, tagHits, sameScene, updatedAt: m.updatedAt || '' })
  }
  scored.sort(
    (a, b) => b.score - a.score || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
  )
  if (limit == null || limit === '') return scored
  return scored.slice(0, Math.max(0, Number(limit) || 0))
}
