import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  basenameOf,
  isToolNoisePath,
  normalizePath,
} from '../src/utils/documentIdentity';



test('B1 向后兼容：draw 形态与 `_` 前缀判定逐字不变（扩展只增不改）', () => {
  assert.equal(isToolNoisePath('output/demo/draw_edge.md'), true);
  assert.equal(isToolNoisePath('output/demo/draw_ms.md'), true);
  assert.equal(isToolNoisePath('01-方案文档/draw.md'), true);
  assert.equal(isToolNoisePath('tools/draw_2.md'), true);
  assert.equal(isToolNoisePath('draw.md'), true, '根级裸 draw 同拦');
  assert.equal(isToolNoisePath('output/demo/draw_edge_验收.md'), true, '即便带交付关键词也拦');
  assert.equal(isToolNoisePath('_tools/xxx.md'), true);
  assert.equal(isToolNoisePath('_qa/冒烟记录.md'), true);
  assert.equal(isToolNoisePath('01-方案文档/drawing-guide 绘图指南.md'), false, 'draw+字母不误拦');
  assert.equal(isToolNoisePath('output/demo/HANDOFF.md'), false, 'output/ 交付物不整体拦');
  assert.equal(isToolNoisePath('01-方案文档/项目计划与需求/路线图.md'), false);
});


test('B2 run-<纯数字≥8> 运行态缓存段拦；带 T 任务包名与短人工 id 不误拦', () => {
  assert.equal(isToolNoisePath('output/mech-win/run-1758123456789/notes.md'), true, 'epoch 毫秒段');
  assert.equal(isToolNoisePath('output/mech-win/run-20261109/plan.md'), true, '纯数字日期段（≥8 位）');
  assert.equal(isToolNoisePath('runs/run-1758123456789/HANDOFF.md'), true, '不限定 output/ 前缀，按段形态判');
  assert.equal(
    isToolNoisePath('output/demo/run-20261114T1000/HANDOFF.md'),
    false,
    '带 T 任务包名不误拦（highValueReading A3 交付物夹具）'
  );
  assert.equal(
    isToolNoisePath('output/pdm-long006/run-20261109T0928/HANDOFF.md'),
    false,
    'task-packages 既有 run-id 夹具同护'
  );
  assert.equal(isToolNoisePath('runs/run-42/PLAN.md'), false, '短人工 run id 不拦');
  assert.equal(isToolNoisePath('01-方案文档/长任务与执行记录/run-长任务.md'), false, '非纯数字后缀不拦');
});


test('B3 长 hex/UUID 段拦（含剥扩展名文件名核），短 hex 与正常词不误拦', () => {
  const uuid = '3f2a8b1c-4d5e-4f6a-8b7c-9d0e1f2a3b4c';
  assert.equal(isToolNoisePath(`output/mech-win/${uuid}/preview.md`), true, '连字符 UUID 目录段');
  assert.equal(isToolNoisePath(`output/mech-win/${uuid}.svg`), true, 'UUID 文件名（剥扩展名后命中）');
  assert.equal(
    isToolNoisePath(`output/mech-win/${'a1b2c3d4'.repeat(8)}/x.md`),
    true,
    '64 位 hex 段（sha256 摘要形态）'
  );
  assert.equal(
    isToolNoisePath(`output/mech-win/${'a1b2c3d4'.repeat(4)}.svg`),
    true,
    '32 位无连字符 UUID 文件名（剥扩展名后命中）'
  );
  assert.equal(isToolNoisePath(`output/mech-win/${'A1B2C3D4'.repeat(4)}/x.md`), true, '大写 hex 同拦');
  assert.equal(isToolNoisePath('output/mech-win/decade/报文.md'), false, '短 hex 词（6 位）不拦');
  assert.equal(
    isToolNoisePath('output/mech-win/a1b2c3d4e5f60718/notes.md'),
    false,
    '16 位短 hex 不拦（保守长阈值：宁可漏放不误伤）'
  );
  assert.equal(isToolNoisePath('01-方案文档/项目计划与需求/路线图.md'), false, '正常中文路径零误伤');
});


test('B4 真实形态：output/…/run-<长数字>/…/<UUID> 全链命中；win32 反斜杠同判', () => {
  const ticketPath =
    'output/mech-win/run-1758123456789/3f2a8b1c-4d5e-4f6a-8b7c-9d0e1f2a3b4c/001-derived-preview.svg';
  assert.equal(isToolNoisePath(ticketPath), true, '运行态缓存路径示例全链命中（run 段 + UUID 段）');
  assert.equal(
    isToolNoisePath(ticketPath.split('/').join('\\')),
    true,
    'win32 反斜杠经 normalizePath 统一后同判'
  );
  assert.equal(isToolNoisePath('output/mech-win/交付包/001-derived-preview.svg'), false);
});


test('B5 既有导出语义零变化：basenameOf 去扩展基名、normalizePath 统一斜杠', () => {
  assert.equal(basenameOf('output/mech-win/001-derived-preview.svg'), '001-derived-preview');
  assert.equal(basenameOf('01-方案文档/项目计划与需求/路线图.md'), '路线图');
  assert.equal(normalizePath('output\\mech-win\\PLAN.md'), 'output/mech-win/PLAN.md');
});
