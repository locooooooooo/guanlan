/**
 * pkgfix · 任务包内容提取与元信息数据层单测（工票 T1~T5）。
 *
 * 守住五件事：
 *  T1 摘要多级回退链：extractCoreSummary 显式核心结论 → 逐章节（跳目录/编号规则等元话语节）
 *     → 原文首段扫描（跳 frontmatter/表格线/系统说明行，2~3 行截断）→ summaryNote；
 *     包级 packageConclusionOf 优先链：00-阅读与派发总览 → PLAN*.md → 01-需求单* →
 *     任意首篇 .md → 任意首篇有结论文档；全部扫完无真实正文才返回空串（数据层不造假）。
 *  T2 formatPackageMetaLine：近 7 天 →「今天 14:20 更新 · N 份资料」；更早 →「11-04 归档」；
 *     无时间 →「刚收录」；严禁「暂无事件」。
 *  T3 packageBadgeLine：版本(docs 当前版最大 versionNumber)+阶段短语真实派生；
 *     无版本数据不造数（空串由 UI 降级）。
 *  T4 taskPackageOf 命名子专项锚定：顶层资产桶下的任务码子段（MECH-WIN-001 …）锚定子专项，
 *     焦点卡/画布分组不再只显示一级大目录名（04-智能体代码）。
 *  T5 stageOfPath basename 决策强信号（决策/待确认/回执/评审）先于关键词顺序表。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DECISION_BASENAME_KEYWORDS,
  dominantStage,
  enrichPackagesWithEvents,
  extractCoreSummary,
  formatPackageMetaLine,
  groupFilesIntoPackages,
  packageBadgeLine,
  stageOfPath,
  taskPackageOf,
} from '../src/utils/taskPackages';
import type { PackageDoc, StageRole, TaskPackage } from '../src/utils/taskPackages';
import { buildCanvasPackageGroups } from '../src/utils/graphEvents';
import type { FileRecord, Revision, TimelineEvent } from '../src/types/guanlan';

// ---------- fixtures ----------

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

function doc(
  stage: StageRole,
  fileId = 'f',
  conclusion = '',
  versionNumber?: number | null
): PackageDoc {
  return { fileId, title: `${fileId}.md`, format: 'md', stage, conclusion, versionNumber };
}

/** 手搓最小 TaskPackage（只用于 formatPackageMetaLine / packageBadgeLine 的字段级断言）。 */
function pkg(over: Partial<TaskPackage> & Pick<TaskPackage, 'docs' | 'stage'>): TaskPackage {
  return {
    id: 'pkg-x',
    name: '包X',
    kind: 'fallback',
    // docs 不在此显式指定：Pick 已使 over.docs 必填，...over 恒提供（TS2783 重复指定）
    eventCount: 0,
    lastActivity: '',
    latestConclusion: '',
    readingOrder: over.docs,
    ...over,
  };
}

function event(
  over: Partial<TimelineEvent> & Pick<TimelineEvent, 'event_id' | 'file_id' | 'observed_at'>
): TimelineEvent {
  return {
    kind: 'modified',
    revision_id: 'r1',
    topic_lane: 'x',
    headline: '',
    detail: '',
    ...over,
  };
}

// ---------- T4 · taskPackageOf 命名子专项锚定 ----------

test('taskPackageOf：顶层资产桶下的命名子专项段锚定子专项（pkgfix T4）', () => {
  // 正例：任务码前缀子段（工票原例「MECH-WIN-001 机械设计工具独立交付」）
  assert.deepEqual(
    taskPackageOf('04-智能体代码/MECH-WIN-001 机械设计工具独立交付/README.md'),
    {
      id: '04-智能体代码/MECH-WIN-001 机械设计工具独立交付',
      name: 'MECH-WIN-001 机械设计工具独立交付',
      kind: 'fallback',
    }
  );
  // win32 反斜杠路径归一化后同样锚定
  assert.deepEqual(
    taskPackageOf('04-智能体代码\\MECH-WIN-001 机械设计工具独立交付\\02-交付图纸.svg'),
    {
      id: '04-智能体代码/MECH-WIN-001 机械设计工具独立交付',
      name: 'MECH-WIN-001 机械设计工具独立交付',
      kind: 'fallback',
    }
  );
  // 反例：小写连字名不是命名子专项——G3 既有口径不变（与 task-packages.test.ts 同款断言）
  assert.deepEqual(taskPackageOf('04-智能体代码/agent-a/README.md'), {
    id: '04-智能体代码',
    name: '04-智能体代码',
    kind: 'fallback',
  });
  // 反例：日期段（数字开头）不锚定
  assert.deepEqual(taskPackageOf('每日开发计划/2026-11-06.md'), {
    id: '每日开发计划',
    name: '每日开发计划',
    kind: 'fallback',
  });
  // 反例：深度 2（顶层段直属文件）不锚定——子段是文件名而非子目录
  assert.deepEqual(taskPackageOf('04-智能体代码/MECH-WIN-001 独立交付.md'), {
    id: '04-智能体代码',
    name: '04-智能体代码',
    kind: 'fallback',
  });
  // 100% 覆盖铁律不破：锚定路径仍有归属、kind 沿用 fallback
  assert.equal(taskPackageOf('04-智能体代码/MECH-WIN-001 机械设计工具独立交付/a/b/c.md').kind, 'fallback');
});

test('taskPackageOf 下游同源：画廊分组与画布 buildCanvasPackageGroups 同步锚定粒度（pkgfix T4 影响面）', () => {
  const files = [
    file({ file_id: 'm1', relative_path: '04-智能体代码/MECH-WIN-001 机械设计工具独立交付/README.md' }),
    file({
      file_id: 'm2',
      relative_path: '04-智能体代码/MECH-WIN-001 机械设计工具独立交付/02-交付图纸.svg',
      format: 'svg',
    }),
    file({ file_id: 'o1', relative_path: '04-智能体代码/OTHER-TOOL-77 代码生成助手/README.md' }),
    file({ file_id: 'g1', relative_path: '04-智能体代码/agent-a/README.md' }),
  ];
  const packages = groupFilesIntoPackages(files);
  // 两个命名子专项各自成包（不再并进「04-智能体代码」大桶），agent-a 仍归顶层段
  assert.deepEqual(
    packages.map((p) => p.id),
    [
      '04-智能体代码',
      '04-智能体代码/MECH-WIN-001 机械设计工具独立交付',
      '04-智能体代码/OTHER-TOOL-77 代码生成助手',
    ]
  );
  assert.equal(
    packages[1]!.name,
    'MECH-WIN-001 机械设计工具独立交付',
    '包名 = 子专项段名（焦点卡锚定展示名）'
  );
  // 画布分组复用同一分组（graphEvents.ts:924 groupFilesIntoPackages）→ 粒度同步传导
  const canvasGroups = buildCanvasPackageGroups(files, []);
  assert.deepEqual(
    canvasGroups.map((g) => g.pkgId),
    packages.map((p) => p.id),
    '画布分组 pkgId 与画廊分组同源同粒度'
  );
  assert.equal(
    canvasGroups.find((g) => g.pkgId === '04-智能体代码/MECH-WIN-001 机械设计工具独立交付')?.name,
    'MECH-WIN-001 机械设计工具独立交付'
  );
});

// ---------- T5 · stageOfPath basename 决策强信号 ----------

test('stageOfPath：basename 决策强信号先于关键词顺序表（pkgfix T5 正例）', () => {
  // 工票原例形态：决策回执（请勾选后回传）——混入执行族词「修改」时旧顺序会高亮到执行
  assert.equal(stageOfPath('01-方案文档/长任务与执行记录/长任务_2026-11-02/修改说明_决策回执（请勾选后回传）.md'), '决策');
  assert.equal(stageOfPath('output/pdm-long006/run-20261109T0928/决策回执（请勾选后回传）.md'), '决策');
  // 交付族词（handoff/验收）同样被强信号压过
  assert.equal(stageOfPath('交付包/handoff-评审确认单.md'), '决策');
  assert.equal(stageOfPath('01-方案文档/发布包/某包_2026-11-01/验收单_待确认.md'), '决策');
  // 强信号压过容器默认（发布包容器默认交付）
  assert.equal(stageOfPath('01-方案文档/发布包/某包_2026-11-01/评审签到表.md'), '决策');
  // 词表锁定（工票逐字口径）
  assert.deepEqual(DECISION_BASENAME_KEYWORDS, ['决策', '待确认', '回执', '评审']);
});

test('stageOfPath：强信号只认 basename；无强信号时既有顺序与容器兜底全不变（pkgfix T5 反例）', () => {
  // 反例：目录段含「评审」不代表文件是决策纸——basename 未命中 → 走既有链 → 待分类
  assert.equal(stageOfPath('评审归档区/notes.txt'), '待分类');
  // 反例：目录段含「决策」不触发——output 容器兜底「执行」仍生效
  assert.equal(stageOfPath('output/决策看板/run-x/notes.md'), '执行');
  // 既有顺序不受影响（无强信号的样本与 task-packages.test.ts 保留断言一致）
  assert.equal(stageOfPath('01-需求长任务卡.md'), '执行'); // 长任务(执行)先于需求(蓝图)
  assert.equal(stageOfPath('03-验收与复验.json'), '交付'); // 验收/复验(交付)
  assert.equal(stageOfPath('PLAN.md'), '计划');
  assert.equal(stageOfPath('00-阅读与派发总览.md'), '蓝图');
});

// ---------- T1 · extractCoreSummary 多级回退链 ----------

test('extractCoreSummary：无标题文档回退原文首段，frontmatter/表格/元话语/目录链接/代码块全跳（pkgfix T1）', () => {
  const f = file({
    file_id: 'pf1',
    relative_path: '04-智能体代码/MECH-WIN-001 机械设计工具独立交付/README.md',
    current_revision_id: 'r1',
    revisions: [
      revision({
        revision_id: 'r1',
        versionNumber: 1,
        observed_at: '2026-11-10T09:00:00+08:00',
        // 无任何 # 标题（parseMarkdownOutline sections 为空的典型「满屏暂无正文摘要」文档）
        markdownContent: [
          '---',
          'title: 使用说明',
          'generated: true',
          '---',
          '',
          '本工具面向机械设计团队，交付独立的参数化建模脚本与操作手册。',
          '',
          '| 模块 | 状态 |',
          '|---|---|',
          '| 建模 | 完成 |',
          '',
          '本文件由系统自动生成，请勿手工编辑。',
          '',
          '编号规则：MECH-YYYYMMDD-序号。',
          '',
          '- [01-需求单](01-需求单.md)',
          '',
          '```',
          '代码块示例行（不是正文）',
          '```',
        ].join('\n'),
        summaryNote: '',
      }),
    ],
  });
  assert.equal(
    extractCoreSummary(f),
    '本工具面向机械设计团队，交付独立的参数化建模脚本与操作手册。',
    '首段真实业务描述被提取，frontmatter/表格行/系统说明行/目录链接/代码块全被跳过'
  );
});

test('extractCoreSummary：首段 2~3 行截断，第 4 行与第二段不入摘要（pkgfix T1）', () => {
  const f = file({
    file_id: 'pf2',
    relative_path: '每日开发计划/无标题笔记.md',
    current_revision_id: 'r1',
    revisions: [
      revision({
        revision_id: 'r1',
        versionNumber: 1,
        observed_at: '2026-11-10T09:00:00+08:00',
        markdownContent: [
          '第一行核心目标说明。',
          '第二行交付范围说明。',
          '第三行验收口径说明。',
          '第四行不应被抓取（超出 3 行截断）。',
          '',
          '第二段正文更不应出现（首段已收口）。',
        ].join('\n'),
      }),
    ],
  });
  const summary = extractCoreSummary(f);
  assert.ok(summary.includes('第一行核心目标说明'), `首行在摘要：${summary}`);
  assert.ok(summary.includes('第三行验收口径说明'), `第三行在摘要（2~3 行口径）：${summary}`);
  assert.ok(!summary.includes('第四行'), `第 4 行被截断：${summary}`);
  assert.ok(!summary.includes('第二段'), `第二段不入摘要：${summary}`);
});

test('extractCoreSummary：全文无真实正文（全 frontmatter/表格/元话语）→ 空串（数据层不造假）', () => {
  const f = file({
    file_id: 'pf3',
    relative_path: '04-智能体代码/某工具/README.md',
    current_revision_id: 'r1',
    revisions: [
      revision({
        revision_id: 'r1',
        versionNumber: 1,
        observed_at: '2026-11-10T09:00:00+08:00',
        markdownContent: [
          '---',
          'title: 使用说明',
          '---',
          '',
          '| 模块 | 状态 |',
          '|---|---|',
          '| 建模 | 完成 |',
          '',
          '本文件由系统自动生成，请勿手工编辑。',
          '',
          '编号规则：MECH-YYYYMMDD-序号。',
        ].join('\n'),
        summaryNote: '',
      }),
    ],
  });
  assert.equal(extractCoreSummary(f), '', '全部层扫完无真实正文 → 诚实空串');
});

test('extractCoreSummary：「## 目录」章节不再抢位；有显式核心结论仍最高优先（pkgfix T1）', () => {
  const common = ['## 目录', '- [01-需求单](01-需求单.md)', '- [02-交付图纸](02-交付图纸.svg)'];
  // ① 无核心结论章节：逐章节回退跳过目录节 → 首个真实业务章节
  const f1 = file({
    file_id: 'pf4',
    relative_path: '01-方案文档/产品需求与任务包/优先链验证_2026-11-10/01-需求单.md',
    current_revision_id: 'r1',
    revisions: [
      revision({
        revision_id: 'r1',
        versionNumber: 1,
        observed_at: '2026-11-10T09:00:00+08:00',
        markdownContent: ['# 总体说明', ...common, '## 方案说明', '采用事件溯源架构统一三域数据。'].join('\n'),
      }),
    ],
  });
  assert.equal(
    extractCoreSummary(f1),
    '采用事件溯源架构统一三域数据。',
    '目录节被跳过（旧实现首个非空 summaryText 会被目录条目抢位）'
  );
  // ② 显式「核心结论」章节仍是最高优先级（既有语义不变）
  const f2 = file({
    file_id: 'pf5',
    relative_path: '01-方案文档/产品需求与任务包/优先链验证_2026-11-10/02-需求书.md',
    current_revision_id: 'r1',
    revisions: [
      revision({
        revision_id: 'r1',
        versionNumber: 1,
        observed_at: '2026-11-10T09:00:00+08:00',
        markdownContent: [
          '# 总体说明',
          ...common,
          '## 方案说明',
          '采用事件溯源架构统一三域数据。',
          '## 核心结论',
          '以本地日历日为唯一时间轴。',
        ].join('\n'),
      }),
    ],
  });
  assert.equal(extractCoreSummary(f2), '以本地日历日为唯一时间轴。');
});

// ---------- T1 · 包级摘要优先链（packageConclusionOf 经 groupFilesIntoPackages 断言） ----------

/** G1 专项包 fixture：每个文件一条「## 核心结论」单行结论。 */
function chainFile(
  fileId: string,
  name: string,
  conclusion: string,
  format: 'md' | 'svg' = 'md',
  svgTexts?: string[]
): FileRecord {
  return file({
    file_id: fileId,
    relative_path: `01-方案文档/产品需求与任务包/优先链验证_2026-11-10/${name}`,
    format,
    current_revision_id: 'r1',
    revisions: [
      revision({
        revision_id: 'r1',
        versionNumber: 1,
        observed_at: '2026-11-10T09:00:00+08:00',
        markdownContent: format === 'md' ? ['# 标题', '## 核心结论', conclusion].join('\n') : undefined,
        svgExtractedTexts: svgTexts,
      }),
    ],
  });
}

test('包摘要优先链：总览 → PLAN → 需求单 → 首篇 md → 首篇有结论文档；全空才空串（pkgfix T1）', () => {
  const base = '01-方案文档/产品需求与任务包/优先链验证_2026-11-10';
  // ① 00-阅读与派发总览最高优先（尽管其余文档更新）
  const withOverview = groupFilesIntoPackages([
    chainFile('a', '04-执行记录.md', '执行结论。'),
    chainFile('b', 'PLAN-主线排期.md', '计划结论。'),
    chainFile('c', '01-需求单.md', '需求单结论。'),
    chainFile('d', '00-阅读与派发总览.md', '总览结论。'),
  ]);
  assert.equal(withOverview[0]!.latestConclusion, '总览结论。', '总览压过 PLAN/需求单/执行记录');

  // ② 无总览 → PLAN*.md
  const withPlan = groupFilesIntoPackages([
    chainFile('a', '04-执行记录.md', '执行结论。'),
    chainFile('b', 'PLAN-主线排期.md', '计划结论。'),
    chainFile('c', '01-需求单.md', '需求单结论。'),
  ]);
  assert.equal(withPlan[0]!.latestConclusion, '计划结论。');

  // ③ 无 PLAN → 01-需求单*
  const withSpec = groupFilesIntoPackages([
    chainFile('a', '04-执行记录.md', '执行结论。'),
    chainFile('c', '01-需求单.md', '需求单结论。'),
  ]);
  assert.equal(withSpec[0]!.latestConclusion, '需求单结论。');

  // ④ 任意首篇 .md（readingOrder：阶段序→标题自然序——执行(04)先于交付(05)）
  const firstMd = groupFilesIntoPackages([
    chainFile('a', '05-交付说明.md', '交付结论。'),
    chainFile('b', '04-执行记录.md', '执行结论。'),
  ]);
  assert.equal(firstMd[0]!.latestConclusion, '执行结论。');

  // ⑤ 无 .md → 任意首篇有结论文档（svg 图形文字也是真实正文，不丢）
  const svgOnly = groupFilesIntoPackages([
    chainFile('s', '02-交付图纸.svg', '', 'svg', ['已验收', '待复验']),
  ]);
  assert.equal(svgOnly[0]!.latestConclusion, '可检索图形文字 (2 处)：已验收 · 待复验');

  // ⑥ 全部文档无正文 → 空串（诚实占位交给 UI）
  const allEmpty = groupFilesIntoPackages([
    file({ file_id: 'x1', relative_path: `${base}/04-执行记录.md` }),
    file({ file_id: 'x2', relative_path: `${base}/05-交付说明.md` }),
  ]);
  assert.equal(allEmpty[0]!.latestConclusion, '');
});

test('enrichPackagesWithEvents：事件最新写入文档的结论仍优先，缺结论回退优先链（pkgfix T1 组合语义）', () => {
  const packages = groupFilesIntoPackages([
    chainFile('a', '00-阅读与派发总览.md', '总览结论。'),
    chainFile('b', '04-执行记录.md', '笔记结论。'),
    file({
      file_id: 'c',
      relative_path: '01-方案文档/产品需求与任务包/优先链验证_2026-11-10/06-附录.md',
    }),
  ]);
  const pkg0 = packages[0]!;
  assert.equal(pkg0.latestConclusion, '总览结论。', '分组基线走优先链');

  // 事件落在执行记录（有结论）→ 事件最新结论覆盖优先链
  const enrichedExec = enrichPackagesWithEvents(packages, [
    event({ event_id: 'e1', file_id: 'b', observed_at: '2026-11-14T10:00:00+08:00' }),
  ]);
  assert.equal(enrichedExec[0]!.latestConclusion, '笔记结论。');

  // 事件落在无正文附录（无结论）→ 保留优先链产物，不回退成空串
  const enrichedAppendix = enrichPackagesWithEvents(packages, [
    event({ event_id: 'e2', file_id: 'c', observed_at: '2026-11-14T10:00:00+08:00' }),
  ]);
  assert.equal(enrichedAppendix[0]!.latestConclusion, '总览结论。');
});

// ---------- T2 · formatPackageMetaLine ----------

test('formatPackageMetaLine：近 7 天相对日+时刻 / 更早归档日期 / 无时间刚收录（pkgfix T2）', () => {
  // now 用本地分量构造（任意时区下 localDay/formatLocalClock 断言均成立）；now 仅测试注入
  const now = new Date(2026, 10, 15, 14, 0, 0); // 本地 2026-11-15 14:00
  const iso = (d: Date) => d.toISOString();
  const docs = [doc('执行'), doc('交付'), doc('蓝图')];

  // 工票原例逐字：今天 14:20 更新 · 20 份资料
  const todayPkg = pkg({
    docs: Array.from({ length: 20 }, () => doc('执行')),
    stage: '执行',
    lastActivity: iso(new Date(2026, 10, 15, 14, 20)),
  });
  assert.equal(formatPackageMetaLine(todayPkg, now), '今天 14:20 更新 · 20 份资料');

  // 昨天与 2~6 天前（相对日+时刻真实计算）
  assert.equal(
    formatPackageMetaLine(
      pkg({ docs, stage: '执行', lastActivity: iso(new Date(2026, 10, 14, 9, 5)) }),
      now
    ),
    '昨天 09:05 更新 · 3 份资料'
  );
  assert.equal(
    formatPackageMetaLine(
      pkg({ docs, stage: '执行', lastActivity: iso(new Date(2026, 10, 12, 22, 10)) }),
      now
    ),
    '3 天前 22:10 更新 · 3 份资料'
  );

  // 更早 → 最近活动日期（工票原例逐字：11-04 归档 · 20 份资料）
  const archived = pkg({
    docs: Array.from({ length: 20 }, () => doc('交付')),
    stage: '交付',
    lastActivity: iso(new Date(2026, 10, 4, 10, 0)),
  });
  assert.equal(formatPackageMetaLine(archived, now), '11-04 归档 · 20 份资料');

  // 纯日期活动串（occurred 只记到日）：无时刻 → 相对日不带钟
  assert.equal(
    formatPackageMetaLine(pkg({ docs, stage: '执行', lastActivity: '2026-11-13' }), now),
    '2 天前 更新 · 3 份资料'
  );

  // 无任何时间 → 刚收录（严禁「暂无事件」）
  assert.equal(formatPackageMetaLine(pkg({ docs, stage: '执行', lastActivity: '' }), now), '刚收录 · 3 份资料');

  // 缺省 now（真实当下）：无时间包的「刚收录」与时钟无关
  assert.equal(
    formatPackageMetaLine(pkg({ docs, stage: '执行', lastActivity: '' })),
    '刚收录 · 3 份资料'
  );

  // 无法解析的串落不到任何一天：按归档形态原样透出（不冒充刚收录）
  assert.equal(
    formatPackageMetaLine(pkg({ docs, stage: '执行', lastActivity: 'undefined-string' }), now),
    'undefined-string 归档 · 3 份资料'
  );
});

// ---------- T3 · packageBadgeLine ----------

test('packageBadgeLine：版本+阶段短语真实派生；无版本数据不造数（pkgfix T3）', () => {
  // 工票原例：交付阶段 + 包内最大版本 v8 →「v8 · 待用户验收」
  const delivered = pkg({
    docs: [doc('执行', 'a', '', 3), doc('交付', 'b', '', 8), doc('执行', 'c', '', 5)],
    stage: '交付',
  });
  assert.equal(dominantStage(delivered.docs), '交付', 'fixture 阶段与 dominantStage 语义一致');
  assert.equal(packageBadgeLine(delivered), 'v8 · 待用户验收');

  // 执行阶段 →「v5 · 执行中」（工票例「执行中 · v5」同一信息，正序统一为 版本 · 短语）
  const executing = pkg({
    docs: [doc('执行', 'a', '', 5)],
    stage: '执行',
  });
  assert.equal(packageBadgeLine(executing), 'v5 · 执行中');

  // 有短语无版本（docs 不带 versionNumber 字段）→ 只出短语，不造版本数
  assert.equal(packageBadgeLine(pkg({ docs: [doc('决策', 'a')], stage: '决策' })), '待拍板');

  // 无版本 + 待分类（无诚实短语）→ 空串由 UI 降级
  assert.equal(packageBadgeLine(pkg({ docs: [doc('待分类', 'a')], stage: '待分类' })), '');

  // 版本全为 null（有字段无数据）→ 同「无版本」处理
  assert.equal(
    packageBadgeLine(pkg({ docs: [doc('执行', 'a', '', null)], stage: '执行' })),
    '执行中'
  );
});

test('packageBadgeLine：真实分组链派生——docs 当前版最大 versionNumber + dominantStage（pkgfix T3）', () => {
  const packages = groupFilesIntoPackages([
    file({
      file_id: 'v1',
      relative_path: '01-方案文档/产品需求与任务包/徽标验证_2026-11-10/01-需求单.md',
      current_revision_id: 'r1',
      revisions: [
        revision({ revision_id: 'r1', versionNumber: 3, observed_at: '2026-11-09T09:00:00+08:00' }),
      ],
    }),
    file({
      file_id: 'v2',
      relative_path: '01-方案文档/产品需求与任务包/徽标验证_2026-11-10/02-交付图纸.svg',
      format: 'svg',
      current_revision_id: 'r1',
      revisions: [
        revision({
          revision_id: 'r1',
          versionNumber: 8,
          observed_at: '2026-11-10T09:00:00+08:00',
          svgExtractedTexts: ['已验收'],
        }),
      ],
    }),
  ]);
  const spec = packages[0]!;
  assert.equal(spec.stage, '交付', '02-交付图纸 → 交付（dominantStage 最远已到达）');
  assert.deepEqual(
    spec.docs.map((d) => d.versionNumber),
    [3, 8],
    'PackageDoc.versionNumber 由当前修订真实填充'
  );
  assert.equal(packageBadgeLine(spec), 'v8 · 待用户验收');

  // 无任何修订 → docs versionNumber 全 null：有阶段短语 → 只出短语（容器兜底蓝图）
  const noRev = groupFilesIntoPackages([
    file({ file_id: 'b1', relative_path: '01-方案文档/产品需求与任务包/徽标验证_2026-11-10/03-附录.md' }),
  ]);
  assert.deepEqual(noRev[0]!.docs.map((d) => d.versionNumber), [null]);
  assert.equal(packageBadgeLine(noRev[0]!), '蓝图制定中', '无版本不造数，但容器兜底阶段短语可用');

  // 真实分组链的空串降级：待分类 + 全无版本（G3 资产桶文件，无容器兜底）
  const bare = groupFilesIntoPackages([
    file({ file_id: 'b2', relative_path: '04-智能体代码/agent-a/zz-工具.md' }),
  ]);
  assert.equal(bare[0]!.stage, '待分类');
  assert.equal(packageBadgeLine(bare[0]!), '', '无版本数据且无阶段短语 → 空串由 UI 降级');
});
