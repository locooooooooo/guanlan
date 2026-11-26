import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DecisionAssertion, FileRecord, ReadingState } from '../src/types/guanlan';
import type { EventDaysResult } from '../src/services/apiTypes';
import type { PackageDoc, TaskPackage } from '../src/utils/taskPackages';
import {
  buildDecisionGaugeModel,
  buildFormatAtlasModel,
  buildPulseComposition,
  buildReadingCoverageModel,
  buildStageFlowModel,
  pickHomeCoverSvgCandidates,
} from '../src/utils/homeInsights';
import HomeView from '../src/components/HomeView';
import { MultiProjectOverviewStrip } from '../src/components/MultiProjectOverviewStrip';

function makeFile(
  id: string,
  relativePath: string,
  format: FileRecord['format'],
  opts: { content?: string; svg?: string } = {}
): FileRecord {
  return {
    file_id: id,
    relative_path: relativePath,
    title: relativePath.split('/').pop() ?? id,
    format,
    current_revision_id: `${id}_r1`,
    revisions: [
      {
        revision_id: `${id}_r1`,
        version_number: 1,
        seq: 1,
        observed_at: '2026-11-20T10:00:00+08:00',
        source_time: '2026-11-20',
        markdownContent: opts.content,
        svgSource: opts.svg,
      },
    ],
  } as unknown as FileRecord;
}

function dayResult(
  groups: Array<{
    date: string;
    count: number;
    by_kind?: Record<string, number>;
    decision_total?: number;
    headline?: string;
  }>
): EventDaysResult {
  return {
    ok: true,
    index_generation: 1,
    order: 'occurred',
    granularity: 'day',
    from: null,
    to: null,
    total: groups.reduce((s, g) => s + g.count, 0),
    hidden_days: 0,
    undated_count: 0,
    groups: groups.map((g) => ({
      date: g.date,
      count: g.count,
      by_kind: g.by_kind ?? {},
      formats: {},
      decisions: [],
      decision_total: g.decision_total,
      decisions_truncated: false,
      samples: g.headline
        ? [
            {
              event_id: `evt_${g.date}`,
              kind: 'appeared',
              headline: g.headline,
              revision_id: null,
              file_id: null,
              file_path: null,
              file_title: null,
              file_role: null,
              format: null,
              occurred_at: g.date,
              occurred_precision: 'day',
              observed_at: `${g.date}T00:00:00Z`,
              time_basis: null,
              action: null,
              decision_id: null,
              code: null,
              status: null,
              ref_count: 0,
              version_count: 0,
              statement_count: 0,
            },
          ]
        : [],
    })),
  } as unknown as EventDaysResult;
}

test('buildPulseComposition：按真实 by_kind 守恒拆分，缺失明细时不捏造', () => {
  const bars = [
    { date: '2026-11-01', count: 10, jumpable: true },
    { date: '2026-11-02', count: 6, jumpable: true },
    { date: '2026-11-03', count: 0, jumpable: true },
  ];
  const eventDays = dayResult([
    {
      date: '2026-11-01',
      count: 10,
      by_kind: { appeared: 3, discovered: 1, decision_changed: 2, revision_updated: 4 },
      decision_total: 2,
      headline: '首次纳入方案 A',
    },
    { date: '2026-11-02', count: 6, by_kind: { appeared: 99 } },
    { date: '2026-11-03', count: 0 },
  ]);

  const model = buildPulseComposition(bars, eventDays);

  assert.equal(model.points.length, 3);
  assert.equal(model.hasAnyBreakdown, true);

  const first = model.points[0];
  assert.equal(first.added, 4);
  assert.equal(first.decision, 2);
  assert.equal(first.evolved, 4);
  assert.equal(first.added + first.decision + first.evolved, first.count, '守恒：拆分之和等于桶计数');
  assert.equal(first.sampleHeadline, '首次纳入方案 A');

  const second = model.points[1];
  assert.equal(second.added, 6, '新增类计数被钳到桶 count 上界');
  assert.equal(second.decision, 0);
  assert.equal(second.evolved, 0);
  assert.equal(second.added + second.decision + second.evolved, second.count);

  const third = model.points[2];
  assert.equal(third.hasKindBreakdown, false, '零计数桶不产生拆分');

  assert.equal(model.totalEvents, 16);
  assert.equal(model.totalAdded, 10);
  assert.equal(model.totalDecision, 2);
  assert.equal(model.totalEvolved, 4);
  assert.equal(model.peakCount, 10);
  assert.equal(model.peakDate, '2026-11-01');
  assert.equal(model.activeBuckets, 2);

  const cumulatives = model.points.map((p) => p.cumulative);
  assert.deepEqual(cumulatives, [10, 16, 16]);
  for (let i = 1; i < model.points.length; i += 1) {
    assert.ok(model.points[i].curveY <= model.points[i - 1].curveY, '累计曲线只升不降');
    assert.ok(model.points[i].curveX > model.points[i - 1].curveX, '曲线点从左到右排布');
  }
  assert.ok(model.cumulativePolyline.length > 0);
  assert.ok(model.cumulativeArea.length > 0);
  assert.ok(model.avgLineBottomPct > 0 && model.avgLineBottomPct < 100);

  const bare = buildPulseComposition(
    [{ date: '2026-11-05', count: 8, jumpable: true }],
    dayResult([{ date: '2026-11-05', count: 8 }])
  );
  assert.equal(bare.hasAnyBreakdown, false);
  assert.equal(bare.points[0].added, 0);
  assert.equal(bare.points[0].decision, 0);
  assert.equal(bare.points[0].evolved, 0);
  assert.equal(bare.points[0].hasKindBreakdown, false);
});

test('buildReadingCoverageModel：三态守恒且圆环弧段不越界', () => {
  const files = [
    makeFile('a', 'docs/a.md', 'md'),
    makeFile('b', 'docs/b.md', 'md'),
    makeFile('c', 'docs/c.md', 'md'),
    makeFile('d', 'docs/d.md', 'md'),
  ];
  const states: Record<string, ReadingState> = {
    a: { last_read_revision_id: 'a_r1' } as ReadingState,
    b: { last_read_revision_id: 'b_old' } as ReadingState,
  };
  const model = buildReadingCoverageModel(files, states);

  assert.equal(model.total, 4);
  assert.equal(
    model.readCount + model.updatedCount + model.unreadCount,
    model.total,
    '守恒：三态之和等于文件总数'
  );
  assert.ok(model.readCount >= 1, '已读到当前版本的文件计入已读');
  assert.ok(model.updatedCount >= 1, '基线落后的文件计入更新待复读');
  assert.ok(model.unreadCount >= 1, '无阅读记录的文件计入未读');
  assert.equal(
    model.slices.reduce((sum, s) => sum + s.count, 0),
    model.total,
    '圆环分段计数之和等于文件总数'
  );

  for (const slice of model.slices) {
    const arcLen = Number(slice.dashArray.split(' ')[0]);
    assert.ok(arcLen >= 0, '弧段长度非负');
    assert.ok(arcLen <= (slice.count > 0 ? 1000 : 0.001), '弧段长度有界');
  }

  const empty = buildReadingCoverageModel([], {});
  assert.equal(empty.total, 0);
  assert.equal(empty.readPct, 0);
});

test('buildDecisionGaugeModel：服务端未决总数高于样本时差额单列，不外推', () => {
  const decisions = [
    { decision_id: 'd1', status: '来源不一致', isCandidateOnly: false },
    { decision_id: 'd2', status: '待确认', isCandidateOnly: false },
    { decision_id: 'd3', status: '已确认', isCandidateOnly: false },
    { decision_id: 'd4', status: '待确认', isCandidateOnly: true },
  ] as unknown as DecisionAssertion[];

  const model = buildDecisionGaugeModel(decisions, 100);
  assert.equal(model.conflictCount, 1);
  assert.equal(model.pendingCount, 1, '候选决策不计入待确认');
  assert.equal(model.resolvedCount, 1);
  assert.equal(model.unresolvedTotal, 100, '优先采用服务端全库未决总数');
  assert.equal(model.unloadedUnresolved, 98, '差额 = 全库未决 − 已加载未决，不拿样本外推');
  assert.equal(model.topUrgentDecisionId, 'd1', '冲突优先于待确认');

  const localOnly = buildDecisionGaugeModel(decisions, null);
  assert.equal(localOnly.unresolvedTotal, 2, '无服务端总数时回退本地未决口径');
  assert.equal(localOnly.unloadedUnresolved, 0);
});

test('buildFormatAtlasModel：主列不超过 5 项且计数守恒，低频格式收拢保留明细', () => {
  const files: FileRecord[] = [
    ...Array.from({ length: 6 }, (_, i) => makeFile(`md${i}`, `d/md${i}.md`, 'md')),
    ...Array.from({ length: 5 }, (_, i) => makeFile(`svg${i}`, `d/svg${i}.svg`, 'svg')),
    ...Array.from({ length: 4 }, (_, i) => makeFile(`pdf${i}`, `d/pdf${i}.pdf`, 'pdf')),
    ...Array.from({ length: 3 }, (_, i) => makeFile(`ts${i}`, `d/ts${i}.ts`, 'ts')),
    makeFile('png1', 'd/a.png', 'png'),
    makeFile('zip1', 'd/a.zip', 'zip'),
  ];
  const model = buildFormatAtlasModel(files, {});

  assert.ok(model.entries.length <= 5, '主列控制在 5 项以内');
  assert.equal(
    model.entries.reduce((sum, e) => sum + e.count, 0),
    files.length,
    '守恒：主列计数之和等于文件总数'
  );
  assert.equal(model.distinctClasses, 6);
  const other = model.entries.find((e) => e.key === 'other');
  assert.ok(other, '低频格式收拢为「其它格式」');
  assert.ok(other!.collapsedDetails && other!.collapsedDetails.length >= 2, '收拢项保留明细');
  assert.equal(
    other!.collapsedDetails!.reduce((sum, d) => sum + d.count, 0),
    other!.count,
    '收拢明细之和等于收拢项计数'
  );

  const small = buildFormatAtlasModel(files.slice(0, 3), {});
  assert.equal(small.entries.length, 1, '单一格式时不制造「其它」项');
  assert.equal(small.entries[0].collapsedDetails, undefined);
});

test('buildStageFlowModel：五阶段槽位齐全，文档计数守恒，待分类仅在需要时出现', () => {
  const doc = (fileId: string, stage: PackageDoc['stage']): PackageDoc => ({
    fileId,
    title: fileId,
    format: 'md',
    stage,
    conclusion: '',
    versionNumber: 1,
  });
  const packages: TaskPackage[] = [
    {
      id: 'p1',
      name: '方案专项',
      kind: 'spec',
      stage: '蓝图',
      docs: [doc('a', '蓝图'), doc('b', '蓝图')],
      eventCount: 2,
      lastActivity: '2026-11-20T00:00:00Z',
      latestConclusion: '',
      readingOrder: [doc('a', '蓝图')],
    },
    {
      id: 'p2',
      name: '交付专项',
      kind: 'spec',
      stage: '交付',
      docs: [doc('c', '交付')],
      eventCount: 1,
      lastActivity: '2026-11-21T00:00:00Z',
      latestConclusion: '',
      readingOrder: [doc('c', '交付')],
    },
  ];
  const model = buildStageFlowModel(packages);
  assert.deepEqual(
    model.nodes.map((n) => n.stage),
    ['蓝图', '计划', '决策', '执行', '交付'],
    '无待分类专项时不追加空槽'
  );
  assert.equal(
    model.nodes.reduce((sum, n) => sum + n.docCount, 0),
    model.totalDocs,
    '守恒：阶段文档计数之和等于专项文档总数'
  );
  assert.equal(model.totalPackages, 2);
  assert.equal(model.dominantStage, '蓝图');
  const blueprint = model.nodes.find((n) => n.stage === '蓝图');
  assert.equal(blueprint?.barWidthPct, 100, '文档最多的阶段占满宽度');
  assert.equal(blueprint?.topPackages[0]?.leadFileId, 'a', '代表专项可直达首份文档');

  const withUnclassified = buildStageFlowModel([
    ...packages,
    {
      id: 'p3',
      name: '散件',
      kind: 'fallback',
      stage: '待分类',
      docs: [doc('d', '待分类')],
      eventCount: 0,
      lastActivity: '',
      latestConclusion: '',
      readingOrder: [],
    },
  ]);
  assert.equal(withUnclassified.nodes.at(-1)?.stage, '待分类', '存在未归类专项时追加待分类槽');
});

test('pickHomeCoverSvgCandidates：每包至多一份、总量封顶、跳过已加载', () => {
  const svgLoaded = makeFile('s1', 'assets/a.svg', 'svg', { svg: '<svg/>' });
  const svgPending = makeFile('s2', 'assets/b.svg', 'svg');
  const svgExtra = makeFile('s3', 'assets/c.svg', 'svg');
  const doc = (fileId: string, format: PackageDoc['format']): PackageDoc => ({
    fileId,
    title: fileId,
    format,
    stage: '蓝图',
    conclusion: '',
    versionNumber: 1,
  });
  const packages: TaskPackage[] = [
    {
      id: 'p1',
      name: '已就绪',
      kind: 'spec',
      stage: '蓝图',
      docs: [doc('s1', 'svg'), doc('s2', 'svg')],
      eventCount: 0,
      lastActivity: '',
      latestConclusion: '',
      readingOrder: [doc('s1', 'svg')],
    },
    {
      id: 'p2',
      name: '待水合',
      kind: 'spec',
      stage: '蓝图',
      docs: [doc('s2', 'svg'), doc('s3', 'svg')],
      eventCount: 0,
      lastActivity: '',
      latestConclusion: '',
      readingOrder: [doc('s2', 'svg')],
    },
    {
      id: 'p3',
      name: '另一份',
      kind: 'spec',
      stage: '蓝图',
      docs: [doc('s3', 'svg')],
      eventCount: 0,
      lastActivity: '',
      latestConclusion: '',
      readingOrder: [doc('s3', 'svg')],
    },
  ];
  const fileById = new Map<string, FileRecord>([
    [svgLoaded.file_id, svgLoaded],
    [svgPending.file_id, svgPending],
    [svgExtra.file_id, svgExtra],
  ]);

  const picked = pickHomeCoverSvgCandidates(packages, fileById, 2);
  assert.ok(picked.length <= 2, '总量受 limit 硬封顶');
  assert.equal(new Set(picked.map((p) => p.fileId)).size, picked.length, '同一文件不重复入队');
  assert.equal(
    picked.some((p) => p.fileId === 's1'),
    false,
    '已加载 svgSource 的文件不进入请求队列'
  );
  assert.equal(picked[0]?.fileId, 's2', '未加载的首份 SVG 优先入队');

  assert.deepEqual(
    pickHomeCoverSvgCandidates(packages, fileById, 1).map((p) => p.fileId),
    ['s2'],
    'limit 封顶：达到上限后不再入队后续专项的候选'
  );

  assert.deepEqual(pickHomeCoverSvgCandidates(packages, fileById, 0), [], 'limit 为 0 时返回空');
});

test('SSR：首页默认渲染构成堆叠与态势环，保留既有直跳锚点', () => {
  const files = [makeFile('a', 'docs/方案/a.md', 'md'), makeFile('b', 'docs/方案/b.md', 'md')];
  const eventDays = dayResult([
    {
      date: '2026-11-20',
      count: 4,
      by_kind: { appeared: 2, revision_updated: 2 },
      headline: '方案初稿纳入',
    },
    {
      date: '2026-11-21',
      count: 2,
      by_kind: { revision_updated: 2 },
    },
  ]);
  const html = renderToStaticMarkup(
    React.createElement(HomeView, {
      files,
      readingStates: {},
      events: [],
      summary: null,
      eventDays,
      recentItems: [],
      decisions: [],
      decisionsUnresolvedTotal: 0,
      onOpenDoc: () => {},
      onResumeReading: () => {},
      onMarkFullyRead: () => {},
      onOpenPackageBoard: () => {},
      onOpenPanorama: () => {},
      onOpenCalendarAt: () => {},
    })
  );

  assert.ok(html.includes('data-home-visual-cockpit'), '态势图谱驾驶舱挂载');
  assert.ok(html.includes('data-home-visual-panel="overview"'), '默认展示态势环');
  assert.ok(
    /<button[^>]*aria-selected="true"[^>]*data-home-trend-mode="stacked"/.test(html),
    '默认构成堆叠模式'
  );
  assert.ok(html.includes('data-home-trend-inspector'), '零遮挡交互明细条挂载');
  assert.ok(html.includes('data-home-trend-stack'), '有 by_kind 明细时渲染堆叠柱');
  assert.ok(html.includes('新增纳入'), '构成图例展示新增纳入');
  assert.ok(html.includes('data-home-trend-bar="2026-11-20"'), '直跳载荷锚点保留');
  assert.ok(html.includes('data-home-trend-avg-line'), '活跃日均参考线挂载');
  assert.ok(
    html.indexOf('data-home-visual-cockpit') < html.indexOf('专项橱窗'),
    '视觉驾驶舱前置在专项橱窗之前，首屏立即可见'
  );
});

test('MultiProjectOverviewStrip：单项目收拢为紧凑条，多项目展开资产占比矩阵', () => {
  const singleProject = {
    project_id: 'p1',
    name: 'workspace',
    root_path: 'F:\\GuanLan\\workspace',
    status: 'ready' as const,
    readonly: false,
    is_scanning: false,
    file_count: 57,
    folder_count: 6,
    pending_decisions_count: 6,
  };
  const compactHtml = renderToStaticMarkup(
    React.createElement(MultiProjectOverviewStrip, {
      overview: {
        projects: [singleProject],
        cross_decisions: [],
        recent_files: [],
        totals: { projects: 1, files: 57, pending_decisions: 6 },
      } as never,
      projects: [singleProject] as never,
      activeProjectId: 'p1',
      onAddProject: () => {},
      onFocusProject: () => {},
      onOpenCrossDecision: () => {},
      onOpenCrossFile: () => {},
    })
  );
  assert.ok(
    compactHtml.includes('data-project-layout="compact"'),
    '单项目无跨项目动态时收拢为单行紧凑工作区条'
  );
  assert.ok(compactHtml.includes('workspace'), '紧凑条保留项目名称');

  const secondProject = {
    ...singleProject,
    project_id: 'p2',
    name: 'archive',
    file_count: 23,
    pending_decisions_count: 0,
  };
  const matrixHtml = renderToStaticMarkup(
    React.createElement(MultiProjectOverviewStrip, {
      overview: {
        projects: [singleProject, secondProject],
        cross_decisions: [],
        recent_files: [],
        totals: { projects: 2, files: 80, pending_decisions: 6 },
      } as never,
      projects: [singleProject, secondProject] as never,
      activeProjectId: 'p1',
      onAddProject: () => {},
      onFocusProject: () => {},
      onOpenCrossDecision: () => {},
      onOpenCrossFile: () => {},
    })
  );
  assert.ok(
    matrixHtml.includes('data-project-layout="grid"'),
    '多项目展开完整卡片矩阵'
  );
  assert.ok(matrixHtml.includes('占全部纳管资产 71%'), '多项目矩阵展示真实资产占比微条');
});
