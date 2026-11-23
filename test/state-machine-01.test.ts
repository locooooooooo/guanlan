/**
 * state-machine-01：统一状态机 SSOT 场景测试（方案 F2/F8；AC-01）。
 *
 * 验收口径：专项卡片、专项详情下拉（橱窗筛选词表）、星图节点、文档顶栏四处视图
 * 的状态徽标词与计数全部来自 stateProjection 单一出口——跨视图同词、状态一致性 100%。
 * 形制沿用本仓测试纪律：纯函数与导出常量断言，不渲染 SVG/组件，禁 import .css。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// ── SSOT：词表、迁移、投影 ──
import {
  DOC_STATE_LABEL,
  DECIDED_DECISION_STATUSES,
  DECISION_STATUS_CONFLICT,
  DECISION_STATUS_PENDING,
  GALLERY_FILTERS,
  LATEST_REVISION_SUFFIX,
  STAGE_BADGE_PHRASE,
  TASK_NODE_STATE_LABEL,
  artifactStageBadgeText,
  isUnresolvedDecision,
  nextDocState,
  revisionVersionLabel,
  unresolvedDecisionCount,
} from '../src/utils/stateProjection';
import type { StateSignals } from '../src/utils/stateProjection';
// ── 专项卡片路径（首页/概览橱窗共用） ──
import { packageBadgeLine } from '../src/utils/taskPackages';
import type { TaskPackage } from '../src/utils/taskPackages';
// ── 契约镜像（wire DTO 编译锁 + 状态行词表一致性） ──
import type { ArtifactStateView, InitiativeStateView, StatementDetailDTO, TaskNodeView } from '../src/services/apiTypes';

// ================= AC-01：四视图同词 =================

describe('AC-01 四视图状态徽标同词（stateProjection 单一出口）', () => {
  it('① 专项卡片：packageBadgeLine 由 SSOT 短语组合（v8 · 待用户验收）', () => {
    const pkg: TaskPackage = {
      id: '01-x/p1',
      name: 'P1',
      kind: 'fallback',
      stage: '交付',
      docs: [
        { fileId: 'f1', title: 'doc', format: 'md', stage: '交付', conclusion: '', versionNumber: 8 },
      ],
      eventCount: 0,
      lastActivity: '',
      latestConclusion: '',
      readingOrder: [],
    };
    assert.equal(packageBadgeLine(pkg), `v8 · ${STAGE_BADGE_PHRASE['交付']}`);
    assert.equal(packageBadgeLine(pkg), 'v8 · 待用户验收');
  });

  it('② 专项详情/橱窗筛选：executing/awaiting 胶囊词与卡片短语同源', () => {
    const executing = GALLERY_FILTERS.find((f) => f.key === 'executing');
    const awaiting = GALLERY_FILTERS.find((f) => f.key === 'awaiting');
    assert.ok(executing && awaiting);
    assert.equal(executing.label, STAGE_BADGE_PHRASE['执行']);
    assert.equal(awaiting.label, STAGE_BADGE_PHRASE['交付']);
    // 消灭「待验收 vs 待用户验收」分叉：筛选词必须与卡片徽标短语逐字一致
    assert.equal(awaiting.label, '待用户验收');
  });

  it('③ 星图节点：阶段回退词单一出口（待分类决策卡回退「决策」）', () => {
    assert.equal(artifactStageBadgeText('待分类', true), '决策');
    assert.equal(artifactStageBadgeText('执行', false), '执行');
    assert.equal(artifactStageBadgeText('待分类', false), '');
    // 阶段词与 SSOT 阶段词表同域（六阶段键齐全）
    for (const stage of ['蓝图', '计划', '决策', '执行', '交付', '待分类'] as const) {
      assert.ok(stage in STAGE_BADGE_PHRASE);
    }
  });

  it('④ 文档顶栏：版本「（最新）」后缀单一出口（ReaderView/RightInspector 共用）', () => {
    assert.equal(revisionVersionLabel(8, true), `v8${LATEST_REVISION_SUFFIX}`);
    assert.equal(revisionVersionLabel(8, true), 'v8（最新）');
    assert.equal(revisionVersionLabel(3, false), 'v3');
  });

  it('四视图未决/已定案口径同源（雷达 = 首页卡 A）', () => {
    const decisions = [
      { status: DECISION_STATUS_PENDING, isCandidateOnly: false },
      { status: DECISION_STATUS_CONFLICT, isCandidateOnly: false },
      { status: DECIDED_DECISION_STATUSES[0], isCandidateOnly: false },
    ];
    assert.equal(unresolvedDecisionCount(decisions), 2);
    assert.equal(isUnresolvedDecision(decisions[2]), false);
    assert.deepEqual([...DECIDED_DECISION_STATUSES], ['已确认', '已否决', '已搁置', '已取代']);
  });
});

// ================= 迁移规则回归锁 =================

describe('迁移规则回归锁（镜像 Rust next_artifact_state）', () => {
  const base: StateSignals = {
    pending_p0: 0,
    pending_p1: 0,
    pending_p2: 0,
    checklist_done: 0,
    checklist_total: 0,
    has_selected_revision: false,
    task_running: false,
    last_activity_days: 0,
  };

  it('六态标签词表完整（wire 六态一一对应）', () => {
    assert.deepEqual(Object.keys(DOC_STATE_LABEL).sort(), [
      'approved_revision',
      'archived',
      'delivered',
      'draft',
      'executing',
      'pending_review',
    ].sort());
  });

  it('ApprovedRevision→Executing 边可达（task_running 持久跨轮——阻塞 1 修复口径）', () => {
    assert.equal(nextDocState('approved_revision', { ...base, task_running: true }), 'executing');
  });

  it('Executing→Delivered 需双槽 completed（阻塞 1 收口：不再用泛化 !task_running）', () => {
    const full: Partial<StateSignals> = {
      checklist_done: 6,
      checklist_total: 6,
      exec_slot_completed: true,
      deliver_slot_completed: true,
    };
    assert.equal(nextDocState('executing', { ...base, ...full }), 'delivered');
    assert.equal(nextDocState('executing', { ...base, ...full, task_running: true }), 'delivered');
    assert.equal(nextDocState('executing', { ...base, ...full, deliver_slot_completed: false }), null);
  });

  it('task_node 六态词表（五槽位下拉数据源；suspended_on_hitl 高亮词）', () => {
    assert.deepEqual(Object.keys(TASK_NODE_STATE_LABEL).sort(), [
      'cancelled',
      'completed',
      'failed',
      'queued',
      'running',
      'suspended_on_hitl',
    ].sort());
    assert.equal(TASK_NODE_STATE_LABEL.suspended_on_hitl, '等待人工拍板');
  });
});

// ================= wire DTO 形状编译锁 =================

describe('wire DTO 形状（apiTypes v1.2 新增节编译锁）', () => {
  it('StateOverviewResponse 的 initiative/artifact 行字段齐备（契约 A）', () => {
    const initiative: InitiativeStateView = {
      initiative_id: 'init_x',
      name: '04-智能体代码',
      root_dir: '04-智能体代码',
      current_stage: '执行',
      state: 'executing',
      artifact_count: 3,
      pending_p0: 0,
      pending_p1: 1,
      pending_p2: 2,
      updated_at: '2026-11-18T00:00:00Z',
    };
    const artifact: ArtifactStateView = {
      file_id: 'f_abc',
      initiative_id: 'init_x',
      current_path: '04-智能体代码/03-待确认事项.md',
      title: '03-待确认事项',
      stage: '决策',
      state: 'pending_review',
      selected_revision_id: null,
      checklist_done: 4,
      checklist_total: 6,
      pending_p0: 1,
      pending_p1: 0,
      pending_p2: 0,
      last_activity_at: null,
    };
    // 状态词与 SSOT 词表同域（六态/六阶段互认）
    assert.ok(initiative.state in DOC_STATE_LABEL);
    assert.ok(artifact.state in DOC_STATE_LABEL);
    assert.ok(initiative.current_stage in STAGE_BADGE_PHRASE);
  });

  it('TaskNodeView 槽位行字段齐备，state ∈ task_node 词表（契约 E）', () => {
    const node: TaskNodeView = {
      node_id: 'node_x',
      stage: '决策',
      node_kind: 'await_decision',
      title: '等待人工拍板',
      state: 'suspended_on_hitl',
      depends: ['node_plan'],
      latest_checkpoint_id: null,
      error: null,
    };
    assert.ok(node.state in TASK_NODE_STATE_LABEL);
    assert.equal(TASK_NODE_STATE_LABEL[node.state], '等待人工拍板');
  });

  it('StatementDetailDTO impact 两字段不合并（建议 8）', () => {
    const s: StatementDetailDTO = {
      statement_id: 'stmt_1',
      revision_id: 'rev_1',
      code: 'D-01',
      question: '属性字典与历史更新策略',
      status: '待确认',
      line_start: 42,
      line_end: 46,
      decision_id: null,
      options: ['方案A', '方案B'],
      recommendation: '方案A',
      impact_blocked: ['t1'],
      impact_allowed: ['t2'],
      confirmer_hint: '架构组',
    };
    assert.ok('impact_blocked' in s && 'impact_allowed' in s);
    assert.deepEqual(s.impact_blocked, ['t1']);
    assert.deepEqual(s.impact_allowed, ['t2']);
  });
});

// ================= F1/F2 接线回归锁（AC-01 最后一公里） =================

describe('AC-01 接线回归：/state-overview 有调用方，四视图消费六态词', () => {
  const readSrc = (rel: string): string =>
    readFileSync(new URL(rel, import.meta.url), 'utf8');

  it('F1：App 调用 fetchStateOverview，并把同一份响应下传四处视图', () => {
    // D01-a 拆层后 App 实现 = 装配层 + 单一 Store + 分节组件——联合文本断言（语义不变）
    const app = [
      '../src/App.tsx',
      '../src/stores/useWorkspaceStore.tsx',
      '../src/components/app/AppMainViews.tsx',
      '../src/components/app/AppLibraryStage.tsx',
    ]
      .map((rel) => readSrc(rel))
      .join(String.fromCharCode(10))
    assert.match(app, /fetchStateOverview/, 'App 必须调用 fetchStateOverview');
    assert.match(
      app,
      /setStateOverview\(overview\.ok \? overview\.data : null\)/,
      '响应必须落到 App 级 state（失败置 null，不伪造空投影）'
    );
    const passCount = (app.match(/stateOverview=\{stateOverview\}/g) || []).length;
    assert.ok(
      passCount >= 4,
      `专项卡片 / 星图 / 文档顶栏 / 检查器至少四处透传 stateOverview，实际 ${passCount}`
    );
  });

  it('F2：专项卡片消费六态词与六态胶囊（服务端优先，fallback 保留阶段词）', () => {
    const src = readSrc('../src/components/TaskPackageGallery.tsx');
    for (const token of [
      'indexStateOverview',
      'initiativeStateOfPackage',
      'projectInitiativeState',
      'initiativeStateBadgeLine',
      'docStatePillClass',
      'DOC_STATE_LABEL',
    ]) {
      assert.ok(src.includes(token), `TaskPackageGallery 缺 ${token}`);
    }
  });

  it('F2：文档顶栏 / 专项详情条消费六态词（ReaderView）', () => {
    // D01-a 拆层后阅读器实现 = 装配层 + 行为控制器——联合文本断言（语义不变）
    const src = [
      '../src/components/ReaderView.tsx',
      '../src/components/reader/useReaderController.tsx',
      '../src/components/reader/readerChromeSections.tsx',
    ]
      .map((rel) => readSrc(rel))
      .join('\n');
    for (const token of [
      'indexStateOverview',
      'artifactStateOf',
      'projectInitiativeState',
      'initiativeStateBadgeLine',
      'docStatePillClass',
      'DOC_STATE_LABEL',
    ]) {
      assert.ok(src.includes(token), `ReaderView 缺 ${token}`);
    }
  });

  it('F2：星图节点消费六态词（artifact 行优先，无行回退阶段词）', () => {
    // D01-a 巨石拆层后画布实现 = 装配层 + 行为控制器 + Scene 层——联合文本断言（语义不变）
    const src = [
      '../src/components/GraphCanvasView.tsx',
      '../src/components/graph/useGraphCanvasController.tsx',
      '../src/components/graph/GraphSceneLayer.tsx',
      '../src/components/graph/GraphSceneBackdrop.tsx',
      '../src/components/graph/GraphSceneTrunk.tsx',
      '../src/components/graph/GraphSceneNodes.tsx',
      '../src/components/graph/GraphSceneCards.tsx',
    ]
      .map((rel) => readSrc(rel))
      .join('\n');
    for (const token of [
      'indexStateOverview',
      'artifactStateOf',
      'artifactStageBadgeText',
      'DOC_STATE_LABEL',
    ]) {
      assert.ok(src.includes(token), `GraphCanvasView 缺 ${token}`);
    }
  });

  it('F2：右侧检查器与文档顶栏同源渲染六态徽标', () => {
    const src = readSrc('../src/components/RightInspector.tsx');
    for (const token of ['indexStateOverview', 'artifactStateOf', 'docStatePillClass', 'DOC_STATE_LABEL']) {
      assert.ok(src.includes(token), `RightInspector 缺 ${token}`);
    }
  });
});
