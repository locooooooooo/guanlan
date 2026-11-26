import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  computeHighValueReading,
  highValueReadingHeading,
  isToolNoisePath,
} from './highValueReading';
import { stageOfPath } from './taskPackages';
import type { FileFormat, FileRecord, ReadingState, Revision } from '../types/guanlan';



let seq = 0;

function revision(
  over: Partial<Revision> & Pick<Revision, 'revision_id' | 'observed_at'>
): Revision {
  return {
    file_id: 'f',
    versionNumber: 1,
    content_sha256: 'hash',
    sizeBytes: 1024,
    snapshotAvailable: true,
    summaryNote: '',
    ...over,
  };
}

interface FileOpts {
  title?: string;
  format?: FileFormat;
  revisions?: Revision[];
}

function file(relativePath: string, opts: FileOpts = {}): FileRecord {
  seq += 1;
  const id = `f_hv_${String(seq).padStart(3, '0')}`;
  return {
    file_id: id,
    relative_path: relativePath,
    title: opts.title ?? relativePath,
    format: opts.format ?? 'md',
    folder: '',
    role: '其他',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: opts.revisions?.[opts.revisions.length - 1]?.revision_id ?? `rev_${id}`,
    revisions: opts.revisions ?? [],
    coverage: 'filename_only',
  };
}

function state(baselineOf?: string): ReadingState {
  return {
    file_id: 'f_placeholder',
    scrollPercent: 0,
    isFullyRead: false,
    bookmarked: false,
    updated_at: '2026-11-14T09:00:00+08:00',
    ...(baselineOf ? { last_read_revision_id: baselineOf } : {}),
  };
}


test('isToolNoisePath：draw 形态段全拦，drawing-guide 与 output/ 正常文档不误拦', () => {
  assert.equal(isToolNoisePath('output/demo/draw_edge.md'), true);
  assert.equal(isToolNoisePath('output/demo/draw_ms.md'), true);
  assert.equal(isToolNoisePath('01-方案文档/draw.md'), true);
  assert.equal(isToolNoisePath('tools/draw_2.md'), true);
  assert.equal(isToolNoisePath('draw.md'), true, '根级裸 draw 同拦');
  assert.equal(isToolNoisePath('output/demo/draw_edge_验收.md'), true, '即便带交付关键词也拦：先噪音后分类');
  assert.equal(isToolNoisePath('_tools/xxx.md'), true);
  assert.equal(isToolNoisePath('_qa/冒烟记录.md'), true);
  assert.equal(isToolNoisePath('01-方案文档/drawing-guide 绘图指南.md'), false, 'A1 反例');
  assert.equal(isToolNoisePath('output/demo/HANDOFF.md'), false, 'output/ 交付物不拦');
  assert.equal(isToolNoisePath('01-方案文档/项目计划与需求/路线图.md'), false);
});

test('聚合：四例 draw 噪音全不入 entries/pendingCount，drawing-guide 计划文档正常入列', () => {
  const noise = [
    file('output/demo/draw_edge.md'),
    file('output/demo/draw_ms.md'),
    file('01-方案文档/draw.md'),
    file('tools/draw_2.md'),
  ];
  const guide = file('01-方案文档/项目计划与需求/drawing-guide 绘图指南.md', { title: '绘图指南' });
  const keeper = file('01-方案文档/项目计划与需求/路线图.md');

  const stats = computeHighValueReading([...noise, guide, keeper], {});

  assert.equal(stats.pendingCount, 2, '噪音 4 份全拦，只余 guide 与 keeper');
  assert.equal(stats.entries.length, 2);
  const ids = new Set(stats.entries.map((e) => e.fileId));
  for (const n of noise) {
    assert.equal(ids.has(n.file_id), false, `噪音 ${n.relative_path} 不入 entries`);
  }
  assert.ok(ids.has(guide.file_id), 'drawing-guide 未被误拦');
  assert.ok(ids.has(keeper.file_id));
  assert.equal(stats.scannedCount, 6, 'scannedCount 为噪音过滤前参与判定的全量（含 4 份噪音）');
});

test('A2 聚合：`_` 前缀目录排除——无噪音过滤本应记划，证明拦在噪音层', () => {
  const toolsPlan = file('_tools/项目计划.md');
  assert.equal(stageOfPath(toolsPlan.relative_path), '计划', '前置事实：分类层本会判为高价值');
  assert.equal(isToolNoisePath('_tools/项目计划.md'), true, '排除原因只能是 `_` 前缀目录');
  const keeper = file('01-方案文档/项目计划与需求/路线图.md');

  const stats = computeHighValueReading([toolsPlan, keeper], {});

  assert.deepEqual(stats.entries.map((e) => e.fileId), [keeper.file_id], '仅 keeper 入列');
  assert.equal(stats.pendingCount, 1);
});

test('A3 高价值命中：计划/决策/交付各一例入 entries；执行/蓝图/待分类不入', () => {
  const plan = file('01-方案文档/项目计划与需求/路线图.md');
  const decision = file('docs/待确认事项-登录边界.md');
  const deliver = file('output/demo/run-20261114T1000/HANDOFF.md');
  const exec = file('01-方案文档/长任务与执行记录/执行记录.md');
  const blueprint = file('01-方案文档/产品需求与任务包/需求总览.md');
  const misc = file('misc/随手笔记.md');

  const stats = computeHighValueReading([plan, decision, deliver, exec, blueprint, misc], {});

  assert.equal(stats.pendingCount, 3);
  const byId = new Map(stats.entries.map((e) => [e.fileId, e]));
  assert.equal(byId.get(plan.file_id)!.category, '计划');
  assert.equal(byId.get(decision.file_id)!.category, '决策');
  assert.equal(byId.get(deliver.file_id)!.category, '交付');
  for (const outside of [exec, blueprint, misc]) {
    assert.equal(byId.has(outside.file_id), false, `${outside.relative_path} 非高价值不入`);
  }
});

test('A4 未读口径：never_read 与 updated_since_last_read 记待阅，up_to_date 不入（真实判定）', () => {
  const neverDoc = file('docs/待确认-支付通道.md');
  const updatedDoc = file('01-方案文档/项目计划与需求/排期.md', {
    revisions: [
      revision({ revision_id: 'rv-old', observed_at: '2026-11-01T09:00:00+08:00', markdownContent: '# 排期 v1' }),
      revision({ revision_id: 'rv-new', observed_at: '2026-11-13T09:00:00+08:00', markdownContent: '# 排期 v2' }),
    ],
  });
  const upToDate = file('output/demo/HANDOFF.md', {
    revisions: [revision({ revision_id: 'rv-cur', observed_at: '2026-11-12T09:00:00+08:00' })],
  });

  const stats = computeHighValueReading([neverDoc, updatedDoc, upToDate], {
    [updatedDoc.file_id]: state('rv-old'),
    [upToDate.file_id]: state('rv-cur'),
  });

  const ids = new Set(stats.entries.map((e) => e.fileId));
  assert.ok(ids.has(neverDoc.file_id), 'never_read 记待阅');
  assert.ok(ids.has(updatedDoc.file_id), 'updated_since_last_read 记待阅');
  assert.equal(ids.has(upToDate.file_id), false, 'up_to_date（高价值已读）不进 entries');
  assert.equal(stats.pendingCount, 2);
  for (const entry of stats.entries) {
    assert.equal(entry.readStatus, 'unread', 'entries 只收待阅，readStatus 恒 unread');
  }
});

test('A5 pendingCount === entries.length 且全量不截断：5 份高价值待阅 → 5', () => {
  const five = [1, 2, 3, 4, 5].map((n) => file(`01-方案文档/项目计划与需求/doc-${n}.md`));
  const stats = computeHighValueReading(five, {});
  assert.equal(stats.pendingCount, 5);
  assert.equal(stats.entries.length, 5);
  assert.equal(stats.pendingCount, stats.entries.length, '全量计数：统计层不截断，展示层自行取前几条');
});

test('A6 排序：决策>交付>计划，同级 observed_at 降序、无版本置尾、同值按路径升序', () => {
  const planEmptyB = file('docs/b-plan.md');
  const planEmptyA = file('docs/a-plan.md');
  const deliver = file('output/demo/HANDOFF.md', {
    revisions: [revision({ revision_id: 'rv-d', observed_at: '2026-11-14T09:00:00+08:00' })],
  });
  const decisionOld = file('docs/待确认-支付.md', {
    revisions: [revision({ revision_id: 'rv-o', observed_at: '2026-11-12T09:00:00+08:00' })],
  });
  const planTimed = file('01-方案文档/项目计划与需求/路线图.md', {
    revisions: [revision({ revision_id: 'rv-p', observed_at: '2026-11-15T09:00:00+08:00' })],
  });
  const decisionNew = file('docs/待确认-登录.md', {
    revisions: [revision({ revision_id: 'rv-n', observed_at: '2026-11-13T09:00:00+08:00' })],
  });

  const stats = computeHighValueReading(
    [planEmptyB, planEmptyA, deliver, decisionOld, planTimed, decisionNew],
    {}
  );

  assert.deepEqual(
    stats.entries.map((e) => e.fileId),
    [
      decisionNew.file_id,
      decisionOld.file_id,
      deliver.file_id,
      planTimed.file_id,
      planEmptyA.file_id,
      planEmptyB.file_id,
    ],
    '类别优先级 > observed_at 降序 > 无版本置尾 > 路径升序'
  );
  assert.equal(stats.entries[0].latestObservedAt, '2026-11-13T09:00:00+08:00');
  assert.equal(stats.entries[4].latestObservedAt, '', '无版本文档 latestObservedAt 如实为空串');
  assert.equal(stats.entries[5].latestObservedAt, '');
});

test('A7 dirPrefix：重名两份各自返回末段目录前缀，无冲突为空（悬浮岛同式）', () => {
  const a = file('runs/run-A/PLAN.md', { title: 'PLAN' });
  const b = file('runs/run-B/PLAN.md', { title: 'PLAN' });
  const solo = file('docs/独一无二的计划.md', { title: '独一无二' });

  const stats = computeHighValueReading([a, b, solo], {});

  const byId = new Map(stats.entries.map((e) => [e.fileId, e]));
  assert.equal(byId.get(a.file_id)!.dirPrefix, 'run-A', '重名拷贝以末段目录互相可指认');
  assert.equal(byId.get(b.file_id)!.dirPrefix, 'run-B');
  assert.equal(byId.get(solo.file_id)!.dirPrefix, '', '无同名冲突不加前缀');
});

test('A8 highValueReadingHeading：全角括号逐字，N=0 仍返回整句', () => {
  assert.equal(highValueReadingHeading({ pendingCount: 3 }), '近期待阅：核心方案与决策（3 份）');
  assert.equal(highValueReadingHeading({ pendingCount: 0 }), '近期待阅：核心方案与决策（0 份）');
});

test('A9 空数组：返回全 0 与空 entries，不炸、不造数', () => {
  const stats = computeHighValueReading([], {});
  assert.deepEqual(
    { pendingCount: stats.pendingCount, entries: stats.entries, scannedCount: stats.scannedCount },
    { pendingCount: 0, entries: [], scannedCount: 0 }
  );
});
