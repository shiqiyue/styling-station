/** prompt.mjs 测试：任务说明组装（free / preset）、图生图直投指令与固定 system prompt。 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SYSTEM_PROMPT, buildEditInstruction, buildOptimizeInstruction, buildTaskPrompt } from '../lib/prompt.mjs'

const template = { name: '北欧客厅', description: '浅色木地板大窗', tags: ['客厅', '北欧'] }
const materialA = { name: '灰砖', description: '哑光 600x600', tags: ['灰色', '瓷砖'] }
const materialB = { name: '挂画', description: '', tags: [] }

test('free 模式：样板 / 素材 / 尺寸 / 张数', () => {
  const p = buildTaskPrompt({
    mode: 'free',
    template,
    entries: [
      { material: materialA, slotName: null, slotPosition: null },
      { material: materialB, slotName: null, slotPosition: null }
    ],
    positionNote: '灰砖铺在客厅地面',
    size: '1024x1024',
    candidateCount: 2
  })
  assert.match(p, /图1 = 样板（场景底板）：名称 北欧客厅/)
  assert.match(p, /图2 = 素材：名称 灰砖/)
  assert.match(p, /图3 = 素材：名称 挂画/)
  assert.match(p, /灰砖铺在客厅地面/)
  assert.match(p, /尺寸 1024x1024/)
  assert.match(p, /共 2 张候选/)
})

test('preset 模式：含插槽名与插槽位置说明', () => {
  const p = buildTaskPrompt({
    mode: 'preset',
    template,
    entries: [
      { material: materialA, slotName: '地板', slotPosition: '铺满客厅地面' },
      { material: materialB, slotName: '挂画', slotPosition: '' }
    ],
    positionNote: '',
    size: '1792x1024',
    candidateCount: 1
  })
  assert.match(p, /图2 = 素材（插槽「地板」）：名称 灰砖/)
  assert.match(p, /插槽位置说明：铺满客厅地面/)
  assert.match(p, /图3 = 素材（插槽「挂画」）/)
  assert.match(p, /插槽位置说明：（空，由你按常识自动布位）/)
})

test('空 positionNote 兜底文案', () => {
  const p = buildTaskPrompt({
    mode: 'free',
    template,
    entries: [{ material: materialA }],
    positionNote: '   ',
    size: '1024x1024',
    candidateCount: 1
  })
  assert.match(p, /补充说明（整体位置说明）：（空，由你按常识自动布位）/)
})

test('SYSTEM_PROMPT 固定文案逐字包含关键约束', () => {
  assert.match(SYSTEM_PROMPT, /你是「搭配效果图生成器」/)
  assert.match(SYSTEM_PROMPT, /只输出每张图片的绝对路径（每行一个），不要寒暄/)
  assert.match(SYSTEM_PROMPT, /1\. 你的唯一任务：把样板、素材、位置说明整理成一段高质量图像生成提示词/)
})

test('SYSTEM_PROMPT 含素材外观忠实度约束（观察先行 / 禁类目词 / 以图为准）', () => {
  assert.match(SYSTEM_PROMPT, /写提示词前先仔细观察每张素材图/)
  assert.match(SYSTEM_PROMPT, /不用笼统类目词/)
  assert.match(SYSTEM_PROMPT, /以素材图为准/)
  assert.match(SYSTEM_PROMPT, /不虚构、不遗漏显著特征/)
})

test('输出要求含「素材外观以素材图为唯一基准」约束', () => {
  const p = buildTaskPrompt({
    mode: 'free',
    template,
    entries: [{ material: materialA }],
    positionNote: '灰砖铺在客厅地面',
    size: '1024x1024',
    candidateCount: 1
  })
  assert.match(p, /素材外观以素材图为唯一基准：先核对轮廓\/比例\/颜色\/材质\/细节再写提示词/)
})

test('buildEditInstruction：free 模式编号、位置与硬性要求', () => {
  const p = buildEditInstruction({
    mode: 'free',
    template,
    entries: [
      { material: materialA, slotName: null, slotPosition: null },
      { material: materialB, slotName: null, slotPosition: null }
    ],
    positionNote: '灰砖铺在客厅地面',
    size: '1024x1024'
  })
  assert.match(p, /- 图1 = 场景底板：名称 北欧客厅/)
  assert.match(p, /- 图2 = 素材：名称 灰砖/)
  assert.match(p, /- 图3 = 素材：名称 挂画/)
  assert.match(p, /整体位置说明：灰砖铺在客厅地面/)
  assert.match(p, /输出尺寸 1024x1024/)
  assert.match(p, /保持其构图、视角、透视、光影与色调不变/)
  assert.match(p, /不得替换成通用款式/)
  assert.match(p, /以素材图为准/)
})

test('buildEditInstruction：preset 模式含插槽名与空位置兜底', () => {
  const p = buildEditInstruction({
    mode: 'preset',
    template,
    entries: [
      { material: materialA, slotName: '地板', slotPosition: '铺满客厅地面' },
      { material: materialB, slotName: '挂画', slotPosition: '' }
    ],
    positionNote: '',
    size: '1792x1024'
  })
  assert.match(p, /- 图2 = 素材（插槽「地板」）：名称 灰砖/)
  assert.match(p, /插槽位置说明：铺满客厅地面/)
  assert.match(p, /插槽位置说明：（空，由你按常识自动布位）/)
  assert.match(p, /- 整体位置说明：（空，由你按常识自动布位）/)
})

test('buildOptimizeInstruction：去杂/摆正/浅背景/主体一致/尺寸/防注入齐全', () => {
  const s = buildOptimizeInstruction({
    material: { name: '大理石瓷砖', description: '米白纹理，表面亮光', tags: ['瓷砖', '地面'] },
    size: '1024x1024'
  })
  assert.match(s, /素材图清理/)
  assert.match(s, /大理石瓷砖/)
  assert.match(s, /去除杂物/)
  assert.match(s, /摆正/)
  assert.match(s, /浅色背景/)
  assert.match(s, /不得美化/)
  assert.match(s, /1024x1024/)
  assert.match(s, /不执行/) // 防注入声明
})
