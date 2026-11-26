import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildDayLanes,
  dayMergeLabel,
  dominantStage,
  enrichPackagesWithEvents,
  extractCoreSummary,
  groupFilesIntoPackages,
  mergeDayRevisions,
  stageOfPath,
  taskPackageOf,
} from '../src/utils/taskPackages';
import type { PackageDoc, StageRole } from '../src/utils/taskPackages';
import type { EventDayItem } from '../src/services/workspaceClient';
import type { FileRecord, Revision, TimelineEvent } from '../src/types/guanlan';


function revision(
  over: Partial<Revision> & Pick<Revision, 'revision_id' | 'versionNumber' | 'observed_at'>
): Revision {
  return {
    file_id: 'f',
    content_sha256: 'hash',
    sizeBytes: 1024,
    snapshotAvailable: true,
    summaryNote: '',
    ...over,
  };
}

function file(
  over: Partial<FileRecord> & Pick<FileRecord, 'file_id' | 'relative_path'>
): FileRecord {
  return {
    title: '文档',
    format: 'md',
    folder: 'x',
    role: '其他',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: 'r1',
    revisions: [],
    coverage: 'filename_only',
    ...over,
  };
}

function dayItem(over: Partial<EventDayItem> = {}): EventDayItem {
  return {
    event_id: 'evt_1',
    kind: 'modified',
    headline: '',
    revision_id: null,
    file_id: null,
    file_path: null,
    file_title: null,
    file_role: null,
    format: 'md',
    occurred_at: null,
    occurred_precision: 'day',
    observed_at: '2026-11-06T10:00:00+08:00',
    time_basis: null,
    action: null,
    decision_id: null,
    code: null,
    status: null,
    ref_count: 0,
    version_count: 1,
    statement_count: 0,
    ...over,
  };
}

function event(over: Partial<TimelineEvent> & Pick<TimelineEvent, 'event_id' | 'file_id' | 'observed_at'>): TimelineEvent {
  return {
    kind: 'modified',
    revision_id: 'r1',
    topic_lane: 'x',
    headline: '',
    detail: '',
    ...over,
  };
}

function doc(stage: StageRole, fileId = 'f', conclusion = ''): PackageDoc {
  return { fileId, title: 't', format: 'md', stage, conclusion };
}


test('taskPackageOf：6 个真实路径样例逐字断言 id/name/kind', () => {
  const cases: Array<[string, string, string, string]> = [
    [
      '01-方案文档/产品需求与任务包/PDM四专项需求核对_2026-11-04/01-需求单.md',
      '01-方案文档/产品需求与任务包/PDM四专项需求核对_2026-11-04',
      'PDM四专项需求核对_2026-11-04',
      'spec',
    ],
    [
      'output/pdm-long006/run-20261109T0928/HANDOFF.md',
      'output/pdm-long006/run-20261109T0928',
      'run-20261109T0928',
      'run',
    ],
    [
      'output/office-collab/OFF-PROD-001/run-20261109T0928/HANDOFF.md',
      'output/office-collab/OFF-PROD-001',
      'OFF-PROD-001',
      'run',
    ],
    ['每日开发计划/2026-11-06.md', '每日开发计划', '每日开发计划', 'fallback'],
    ['04-智能体代码/agent-a/README.md', '04-智能体代码', '04-智能体代码', 'fallback'],
    ['README.md', '__root__', '工作区根', 'fallback'],
  ];
  for (const [path, id, name, kind] of cases) {
    assert.deepEqual(taskPackageOf(path), { id, name, kind }, `path=${path}`);
  }
});

test('任务包覆盖 100%：边界路径均有归属且永不返回 null', () => {
  assert.deepEqual(taskPackageOf('01-方案文档/产品需求与任务包/foo.md'), {
    id: '01-方案文档',
    name: '01-方案文档',
    kind: 'fallback',
  });
  assert.deepEqual(taskPackageOf('output/pdm-long006/run-20261109T0928.md'), {
    id: 'output',
    name: 'output',
    kind: 'fallback',
  });
  assert.deepEqual(taskPackageOf('a/b/c/d/e.md'), { id: 'a', name: 'a', kind: 'fallback' });
  assert.deepEqual(taskPackageOf('x'), { id: '__root__', name: '工作区根', kind: 'fallback' });
  assert.deepEqual(taskPackageOf(''), { id: '__root__', name: '工作区根', kind: 'fallback' });
  assert.deepEqual(
    taskPackageOf('01-方案文档\\产品需求与任务包\\PDM四专项需求核对_2026-11-04\\01-需求单.md'),
    {
      id: '01-方案文档/产品需求与任务包/PDM四专项需求核对_2026-11-04',
      name: 'PDM四专项需求核对_2026-11-04',
      kind: 'spec',
    }
  );
  assert.deepEqual(taskPackageOf('output\\pdm-long006\\run-20261109T0928\\HANDOFF.md'), {
    id: 'output/pdm-long006/run-20261109T0928',
    name: 'run-20261109T0928',
    kind: 'run',
  });
});


test('stageOfPath：重叠词样本按优先级锁定（执行/决策/交付先于蓝图）', () => {
  const cases: Array<[string, StageRole]> = [
    ['01-需求长任务卡.md', '执行'],
    ['03-验收与决策.json', '决策'],
    ['01-执行回执.md', '决策'],
    ['02-交付状态.svg', '交付'],
    ['04-执行路线.svg', '执行'],
    ['PLAN.md', '计划'],
    ['03-待确认事项.md', '决策'],
    ['决策回执.md', '决策'],
    ['00-阅读与派发总览.md', '蓝图'],
    ['01-需求单.md', '蓝图'],
    ['01-交付与复验.md', '交付'],
  ];
  for (const [path, stage] of cases) {
    assert.equal(stageOfPath(path), stage, `path=${path}`);
  }
});

test('stageOfPath：关键词未命中时按容器兜底，无容器→待分类', () => {
  assert.equal(stageOfPath('01-方案文档/产品需求与任务包/PDM四专项需求核对_2026-11-04/04-附录.md'), '蓝图');
  assert.equal(stageOfPath('01-方案文档/项目计划与需求/某项目_2026-11-01/00-目录.md'), '计划');
  assert.equal(stageOfPath('01-方案文档/汇报与整理/办公协同产品化迭代_2026-11-03/00-目录.md'), '交付');
  assert.equal(stageOfPath('01-方案文档/发布包/某包_2026-11-01/00-目录.md'), '交付');
  assert.equal(stageOfPath('01-方案文档/长任务与执行记录/某长任务_2026-11-02/00-记录.md'), '执行');
  assert.equal(stageOfPath('output/pdm-long006/run-20261109T0928/notes.txt'), '执行');
  assert.equal(stageOfPath('04-智能体代码/agent-a/main.ts'), '待分类');
  assert.equal(stageOfPath('README.md'), '待分类');
});


test('dominantStage：最远已到达阶段；有待确认无交付→决策；待分类不计数', () => {
  assert.equal(dominantStage([doc('蓝图')]), '蓝图');
  assert.equal(dominantStage([doc('蓝图'), doc('计划')]), '计划');
  assert.equal(dominantStage([doc('蓝图'), doc('决策')]), '决策');
  assert.equal(dominantStage([doc('计划'), doc('执行'), doc('决策')]), '执行');
  assert.equal(dominantStage([doc('决策'), doc('交付')]), '交付');
  assert.equal(dominantStage([doc('待分类'), doc('蓝图')]), '蓝图', '待分类文档不计数');
  assert.equal(dominantStage([doc('待分类')]), '待分类');
  assert.equal(dominantStage([]), '待分类');
});


test('extractCoreSummary：md 取「核心结论」章节 summaryText', () => {
  const f = file({
    file_id: 'f1',
    relative_path: '01-方案文档/产品需求与任务包/PDM四专项需求核对_2026-11-04/01-需求单.md',
    format: 'md',
    current_revision_id: 'r1',
    revisions: [
      revision({
        revision_id: 'r1',
        versionNumber: 1,
        observed_at: '2026-11-06T09:00:00+08:00',
        markdownContent: [
          '# PDM四专项需求核对',
          '## 背景',
          '背景行',
          '## 核心结论',
          '这是核心结论第一行',
          '这是核心结论第二行',
          '## 附录',
          '附录内容',
        ].join('\n'),
        summaryNote: '概要备注兜底',
      }),
    ],
  });
  assert.equal(extractCoreSummary(f), '这是核心结论第一行 这是核心结论第二行');
});

test('extractCoreSummary：无「核心结论」回退首节 summaryText；再回退 summaryNote', () => {
  const f1 = file({
    file_id: 'f2',
    relative_path: '每日开发计划/2026-11-06.md',
    format: 'md',
    current_revision_id: 'r1',
    revisions: [
      revision({
        revision_id: 'r1',
        versionNumber: 1,
        observed_at: '2026-11-06T09:00:00+08:00',
        markdownContent: ['# 每日开发计划', '## 今日安排', '安排第一行', '安排第二行', '## 收尾', '收尾行'].join('\n'),
        summaryNote: '概要备注兜底',
      }),
    ],
  });
  assert.equal(extractCoreSummary(f1), '安排第一行 安排第二行', '回退 sections[0].summaryText');

  const f2 = file({
    file_id: 'f3',
    relative_path: 'README.md',
    format: 'md',
    current_revision_id: 'r1',
    revisions: [
      revision({
        revision_id: 'r1',
        versionNumber: 1,
        observed_at: '2026-11-06T09:00:00+08:00',
        markdownContent: '# 仅标题\n',
        summaryNote: '备注兜底',
      }),
    ],
  });
  assert.equal(extractCoreSummary(f2), '备注兜底');

  const f3 = file({ file_id: 'f4', relative_path: 'x.md', current_revision_id: 'r1', revisions: [] });
  assert.equal(extractCoreSummary(f3), '');
});

test('extractCoreSummary：svg 可检索图形文字前 3 条；pdf 首页文本兜底', () => {
  const svg = file({
    file_id: 'f5',
    relative_path: '01-方案文档/汇报与整理/办公协同产品化迭代_2026-11-03/02-交付状态.svg',
    format: 'svg',
    current_revision_id: 'r1',
    revisions: [
      revision({
        revision_id: 'r1',
        versionNumber: 1,
        observed_at: '2026-11-06T09:00:00+08:00',
        svgExtractedTexts: ['已验收', '流程正常', '待复验', '第四处'],
      }),
    ],
  });
  assert.equal(extractCoreSummary(svg), '可检索图形文字 (4 处)：已验收 · 流程正常 · 待复验');

  const pdf = file({
    file_id: 'f6',
    relative_path: 'x/验收报告.pdf',
    format: 'pdf',
    current_revision_id: 'r1',
    pdfStatusReason: '扫描件无文本层',
    revisions: [
      revision({
        revision_id: 'r1',
        versionNumber: 1,
        observed_at: '2026-11-06T09:00:00+08:00',
        pdfPages: [{ pageNumber: 1, heading: '', extractedText: 'PDF首行文本', visualSummary: '' }],
        summaryNote: 'note',
      }),
    ],
  });
  assert.equal(extractCoreSummary(pdf), 'PDF首行文本');
});


test('groupFilesIntoPackages：按 id 排序稳定，包内 docs 按阅读顺序，结论/占位正确', () => {
  const files = [
    file({
      file_id: 'f1',
      relative_path: '01-方案文档/产品需求与任务包/PDM四专项需求核对_2026-11-04/01-需求单.md',
      current_revision_id: 'r1',
      revisions: [
        revision({
          revision_id: 'r1',
          versionNumber: 1,
          observed_at: '2026-11-06T09:00:00+08:00',
          markdownContent: ['# 需求单', '## 核心结论', '需求单结论行'].join('\n'),
        }),
      ],
    }),
    file({ file_id: 'f2', relative_path: '01-方案文档/产品需求与任务包/PDM四专项需求核对_2026-11-04/03-待确认事项.md' }),
    file({ file_id: 'f3', relative_path: '01-方案文档/产品需求与任务包/PDM四专项需求核对_2026-11-04/01-交付与复验.md' }),
    file({ file_id: 'f4', relative_path: 'output/pdm-long006/run-20261109T0928/HANDOFF.md' }),
    file({ file_id: 'f5', relative_path: 'README.md' }),
  ];
  const packages = groupFilesIntoPackages(files);
  assert.deepEqual(
    packages.map((p) => p.id),
    [
      '01-方案文档/产品需求与任务包/PDM四专项需求核对_2026-11-04',
      '__root__',
      'output/pdm-long006/run-20261109T0928',
    ]
  );

  const spec = packages[0]!;
  assert.equal(spec.name, 'PDM四专项需求核对_2026-11-04');
  assert.equal(spec.kind, 'spec');
  assert.equal(spec.stage, '交付');
  assert.deepEqual(spec.docs.map((d) => d.fileId), ['f1', 'f2', 'f3']);
  assert.deepEqual(spec.docs.map((d) => d.stage), ['蓝图', '决策', '交付']);
  assert.deepEqual(spec.readingOrder.map((d) => d.fileId), ['f1', 'f2', 'f3']);
  assert.equal(spec.docs[0]!.conclusion, '需求单结论行');
  assert.equal(spec.latestConclusion, '需求单结论行');
  assert.equal(spec.eventCount, 0, '占位');
  assert.equal(spec.lastActivity, '', '占位');

  const run = packages[2]!;
  assert.equal(run.name, 'run-20261109T0928');
  assert.equal(run.kind, 'run');
  assert.equal(run.stage, '交付');

  const root = packages[1]!;
  assert.equal(root.kind, 'fallback');
  assert.equal(root.name, '工作区根');
});


test('groupFilesIntoPackages：draw_*/`_` 前缀段噪音不进包 docs，包计数/封面候选/画布 docCount 同源排除', () => {
  const files = [
    file({
      file_id: 's1',
      relative_path: '01-方案文档/产品需求与任务包/PDM四专项需求核对_2026-11-04/01-需求单.md',
    }),
    file({
      file_id: 's2',
      relative_path: '01-方案文档/产品需求与任务包/PDM四专项需求核对_2026-11-04/02-交付图纸.svg',
      format: 'svg',
    }),
    file({
      file_id: 'n1',
      relative_path: '01-方案文档/产品需求与任务包/PDM四专项需求核对_2026-11-04/draw_edge.md',
    }),
    file({
      file_id: 'n2',
      relative_path: '01-方案文档/产品需求与任务包/PDM四专项需求核对_2026-11-04/draw_ms.md',
    }),
    file({ file_id: 'r1', relative_path: 'output/pdm-long006/run-20261109T0928/HANDOFF.md' }),
    file({
      file_id: 'r2',
      relative_path: 'output/pdm-long006/run-20261109T0928/03-图纸.svg',
      format: 'svg',
    }),
    file({
      file_id: 'n3',
      relative_path: 'output/pdm-long006/run-20261109T0928/draw_2.svg',
      format: 'svg',
    }),
    file({
      file_id: 'r3',
      relative_path: 'output/pdm-long006/run-20261109T0928/drawing-guide.md',
    }),
    file({ file_id: 'n4', relative_path: '_tools/inspect.md' }),
    file({ file_id: 'n5', relative_path: 'output/ghost-proj/run-x/draw_edge.md' }),
  ];
  const packages = groupFilesIntoPackages(files);

  assert.equal(
    packages.some((p) => p.id === 'output/ghost-proj/run-x'),
    false,
    '成员全为噪音的桶不产包'
  );

  const spec = packages.find((p) => p.id === '01-方案文档/产品需求与任务包/PDM四专项需求核对_2026-11-04')!;
  assert.deepEqual(spec.docs.map((d) => d.fileId), ['s1', 's2']);
  assert.deepEqual(
    spec.docs.filter((d) => d.format === 'svg').map((d) => d.fileId),
    ['s2']
  );

  const run = packages.find((p) => p.id === 'output/pdm-long006/run-20261109T0928')!;
  assert.deepEqual(run.docs.map((d) => d.fileId), ['r2', 'r3', 'r1']);
  assert.deepEqual(run.readingOrder.map((d) => d.fileId), run.docs.map((d) => d.fileId));
});

test('enrichPackagesWithEvents：事件计数、最新活动时间、最新结论回填，不改输入', () => {
  const files = [
    file({
      file_id: 'f1',
      relative_path: '01-方案文档/产品需求与任务包/PDM四专项需求核对_2026-11-04/01-需求单.md',
      current_revision_id: 'r2',
      revisions: [
        revision({
          revision_id: 'r1',
          versionNumber: 1,
          observed_at: '2026-11-05T09:00:00+08:00',
          markdownContent: ['# 需求单', '## 核心结论', '结论旧版'].join('\n'),
        }),
        revision({
          revision_id: 'r2',
          versionNumber: 2,
          observed_at: '2026-11-06T09:00:00+08:00',
          markdownContent: ['# 需求单', '## 核心结论', '结论新版'].join('\n'),
        }),
      ],
    }),
    file({ file_id: 'f4', relative_path: 'output/pdm-long006/run-20261109T0928/HANDOFF.md' }),
  ];
  const packages = groupFilesIntoPackages(files);
  const events: TimelineEvent[] = [
    event({ event_id: 'e1', file_id: 'f1', observed_at: '2026-11-05T10:00:00+08:00' }),
    event({ event_id: 'e2', file_id: 'f1', observed_at: '2026-11-06T10:00:00+08:00' }),
    event({ event_id: 'e3', file_id: 'f4', observed_at: '2026-11-07T10:00:00+08:00' }),
  ];
  const enriched = enrichPackagesWithEvents(packages, events);

  assert.notEqual(enriched, packages, '不得原地修改输入数组');
  assert.equal(packages[0]!.eventCount, 0, '输入对象未被改写');

  const spec = enriched.find((p) => p.id === '01-方案文档/产品需求与任务包/PDM四专项需求核对_2026-11-04')!;
  assert.equal(spec.eventCount, 2);
  assert.equal(spec.lastActivity, '2026-11-06T10:00:00+08:00');
  assert.equal(spec.latestConclusion, '结论新版');

  const run = enriched.find((p) => p.id === 'output/pdm-long006/run-20261109T0928')!;
  assert.equal(run.eventCount, 1);
  assert.equal(run.lastActivity, '2026-11-07T10:00:00+08:00');
  assert.equal(run.latestConclusion, '', 'HANDOFF 无版本内容 → 无结论');
});


test('mergeDayRevisions：三版今日 → v1→v3 · 今日演进 2 次（DoD 逐字口径）', () => {
  const samples: EventDayItem[] = [
    dayItem({ event_id: 'e1', file_id: 'f1', revision_id: 'r1', occurred_at: '2026-11-06', observed_at: '2026-11-06T09:00:00+08:00', headline: '初稿' }),
    dayItem({ event_id: 'e2', file_id: 'f1', revision_id: 'r2', occurred_at: '2026-11-06', observed_at: '2026-11-06T11:00:00+08:00', headline: '补需求' }),
    dayItem({ event_id: 'e3', file_id: 'f1', revision_id: 'r3', occurred_at: '2026-11-06', observed_at: '2026-11-06T14:00:00+08:00', headline: '定稿' }),
  ];
  const resolve = (rid: string | null): number | null =>
    rid === 'r1' ? 1 : rid === 'r2' ? 2 : rid === 'r3' ? 3 : null;

  const merges = mergeDayRevisions(samples, resolve);
  assert.equal(merges.length, 1);
  const m = merges[0]!;
  assert.equal(m.fileId, 'f1');
  assert.equal(m.day, '2026-11-06');
  assert.equal(m.vFirst, 1);
  assert.equal(m.vLast, 3);
  assert.equal(m.evolutionCount, 2);
  assert.equal(m.headline, '定稿', '取最后一次(observed_at 最大)事件 headline');
  assert.deepEqual(m.revisionIds, ['r1', 'r2', 'r3']);
  assert.equal(m.eventCount, 3);
  assert.equal(m.merged, true);
  assert.equal(dayMergeLabel(m), 'v1 → v3 · 今日演进 2 次');
});

test('mergeDayRevisions：单事件原样（merged=false）；跨日仅末版 evolutionCount=0', () => {
  const resolve = (rid: string | null): number | null => (rid === 'r3' ? 3 : null);

  const single = mergeDayRevisions(
    [dayItem({ event_id: 'e1', file_id: 'f1', revision_id: 'r3', observed_at: '2026-11-06T09:00:00+08:00' })],
    resolve
  )[0]!;
  assert.equal(single.merged, false);
  assert.equal(single.eventCount, 1);
  assert.equal(single.evolutionCount, 0);
  assert.equal(single.vFirst, 3);
  assert.equal(single.vLast, 3);
  assert.equal(dayMergeLabel(single), '', '单事件不产生合并标签');

  const lastOnly = mergeDayRevisions(
    [dayItem({ event_id: 'e1', file_id: 'f1', revision_id: 'r3', observed_at: '2026-11-06T09:00:00+08:00' })],
    resolve
  )[0]!;
  assert.equal(lastOnly.evolutionCount, 0);
});

test('mergeDayRevisions/dayMergeLabel：多文件分组、同日同版本、仅末版/全不可解析', () => {
  const resolve = (rid: string | null): number | null =>
    rid === 'r2' ? 2 : rid === 'r3' ? 3 : null;

  const merges = mergeDayRevisions(
    [
      dayItem({ event_id: 'e1', file_id: 'f1', revision_id: 'r3', observed_at: '2026-11-06T09:00:00+08:00' }),
      dayItem({ event_id: 'e2', file_id: 'f2', revision_id: 'r2', observed_at: '2026-11-06T10:00:00+08:00' }),
    ],
    resolve
  );
  assert.deepEqual(merges.map((m) => m.fileId), ['f1', 'f2']);

  const sameVersion = mergeDayRevisions(
    [
      dayItem({ event_id: 'e1', file_id: 'f1', revision_id: 'r3', observed_at: '2026-11-06T09:00:00+08:00' }),
      dayItem({ event_id: 'e2', file_id: 'f1', revision_id: 'r3', observed_at: '2026-11-06T11:00:00+08:00' }),
    ],
    resolve
  )[0]!;
  assert.equal(sameVersion.merged, true);
  assert.equal(sameVersion.evolutionCount, 0);
  assert.equal(sameVersion.vFirst, 3);
  assert.equal(sameVersion.vLast, 3);
  assert.deepEqual(sameVersion.revisionIds, ['r3']);
  assert.equal(dayMergeLabel(sameVersion), 'v3');

  const onlyLast = mergeDayRevisions(
    [
      dayItem({ event_id: 'e1', file_id: 'f1', revision_id: 'rX', observed_at: '2026-11-06T09:00:00+08:00' }),
      dayItem({ event_id: 'e2', file_id: 'f1', revision_id: 'r3', observed_at: '2026-11-06T11:00:00+08:00' }),
    ],
    resolve
  )[0]!;
  assert.equal(onlyLast.vFirst, null);
  assert.equal(onlyLast.vLast, 3);
  assert.equal(onlyLast.merged, true);
  assert.equal(dayMergeLabel(onlyLast), 'v3');

  const none = mergeDayRevisions(
    [
      dayItem({ event_id: 'e1', file_id: 'f1', revision_id: 'rX', observed_at: '2026-11-06T09:00:00+08:00' }),
      dayItem({ event_id: 'e2', file_id: 'f1', revision_id: 'rY', observed_at: '2026-11-06T11:00:00+08:00' }),
    ],
    resolve
  )[0]!;
  assert.equal(none.vFirst, null);
  assert.equal(none.vLast, null);
  assert.equal(none.merged, true);
  assert.equal(none.evolutionCount, 1, '去重 revision_id 计数仍如实');
  assert.equal(dayMergeLabel(none), '');
});

test('mergeDayRevisions：file_id 为 null 的事件不构成文件日桶（跳过）', () => {
  const merges = mergeDayRevisions(
    [
      dayItem({ event_id: 'e1', file_id: null, revision_id: null, observed_at: '2026-11-06T09:00:00+08:00' }),
      dayItem({ event_id: 'e2', file_id: 'f1', revision_id: 'r3', observed_at: '2026-11-06T10:00:00+08:00' }),
    ],
    () => 3
  );
  assert.deepEqual(merges.map((m) => m.fileId), ['f1']);
});


test('buildDayLanes：单包五槽，决策槽有 card、交付槽 card=null（DoD3 泳道）', () => {
  const files = [
    file({ file_id: 'f2', relative_path: '01-方案文档/产品需求与任务包/PDM四专项需求核对_2026-11-04/03-待确认事项.md' }),
    file({ file_id: 'f3', relative_path: '01-方案文档/产品需求与任务包/PDM四专项需求核对_2026-11-04/01-交付与复验.md' }),
  ];
  const packages = groupFilesIntoPackages(files);
  const samples: EventDayItem[] = [
    dayItem({ event_id: 'e1', file_id: 'f2', revision_id: 'r1', headline: '提问1', observed_at: '2026-11-06T09:00:00+08:00' }),
    dayItem({ event_id: 'e2', file_id: 'f2', revision_id: 'r3', headline: '提问3', observed_at: '2026-11-06T11:00:00+08:00' }),
  ];
  const resolve = (rid: string | null): number | null => (rid === 'r1' ? 1 : rid === 'r3' ? 3 : null);

  const lanes = buildDayLanes(packages, files, new Map([['2026-11-06', samples]]), resolve);
  assert.equal(lanes.length, 1);
  const lane = lanes[0]!;
  assert.equal(lane.date, '2026-11-06');
  assert.deepEqual(lane.slots.map((s) => s.role), ['蓝图', '计划', '决策', '执行', '交付'], '五阶段槽位固定顺序');
  assert.equal(lane.package.id, '01-方案文档/产品需求与任务包/PDM四专项需求核对_2026-11-04');
  assert.equal(lane.package.stage, '交付');

  const decision = lane.slots[2]!;
  assert.equal(decision.role, '决策');
  assert.equal(decision.doc?.fileId, 'f2');
  assert.ok(decision.card, '决策槽当日有 card');
  assert.equal(decision.card!.vFirst, 1);
  assert.equal(decision.card!.vLast, 3);
  assert.equal(decision.card!.evolutionCount, 1);
  assert.equal(decision.card!.headline, '提问3', '取最后一次 headline');
  assert.equal(dayMergeLabel(decision.card!), 'v1 → v3 · 今日演进 1 次');

  const delivery = lane.slots[4]!;
  assert.equal(delivery.doc?.fileId, 'f3');
  assert.equal(delivery.card, null);

  assert.equal(lane.slots[0]!.doc, null);
  assert.equal(lane.slots[0]!.card, null);
  assert.equal(lane.slots[1]!.doc, null);
  assert.equal(lane.slots[3]!.doc, null);
});

test('buildDayLanes：多日 map 每包每出一条泳道，日期取 map 键', () => {
  const files = [
    file({ file_id: 'f2', relative_path: '01-方案文档/产品需求与任务包/PDM四专项需求核对_2026-11-04/03-待确认事项.md' }),
    file({ file_id: 'f4', relative_path: 'output/pdm-long006/run-20261109T0928/HANDOFF.md' }),
  ];
  const packages = groupFilesIntoPackages(files);
  const resolve = (rid: string | null): number | null => (rid === 'r1' ? 1 : null);
  const lanes = buildDayLanes(
    packages,
    files,
    new Map([
      [
        '2026-11-06',
        [dayItem({ event_id: 'e1', file_id: 'f2', revision_id: 'r1', observed_at: '2026-11-06T09:00:00+08:00' })],
      ],
      [
        '2026-11-07',
        [dayItem({ event_id: 'e2', file_id: 'f4', revision_id: 'rX', observed_at: '2026-11-07T09:00:00+08:00' })],
      ],
    ]),
    resolve
  );
  assert.deepEqual(
    lanes.map((l) => `${l.date}|${l.package.id}`),
    [
      '2026-11-06|01-方案文档/产品需求与任务包/PDM四专项需求核对_2026-11-04',
      '2026-11-06|output/pdm-long006/run-20261109T0928',
      '2026-11-07|01-方案文档/产品需求与任务包/PDM四专项需求核对_2026-11-04',
      '2026-11-07|output/pdm-long006/run-20261109T0928',
    ]
  );
  const runLane = lanes.find((l) => l.date === '2026-11-07' && l.package.kind === 'run')!;
  assert.equal(runLane.slots[4]!.doc?.fileId, 'f4');
  assert.ok(runLane.slots[4]!.card);
  assert.equal(dayMergeLabel(runLane.slots[4]!.card!), '');
});
