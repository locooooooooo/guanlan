import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DOC_STATE_LABEL,
  DOC_STATE_ORDER,
  DOC_STATE_PILL_CLASS,
  DECIDED_DECISION_STATUSES,
  DECISION_STATUS_CONFLICT,
  DECISION_STATUS_PENDING,
  GALLERY_FILTERS,
  STAGE_BADGE_PHRASE,
  STAGE_DOC_STATE,
  artifactStageBadgeText,
  artifactStateOf,
  docStatePillClass,
  indexStateOverview,
  initiativeStateBadgeLine,
  initiativeStateOfPackage,
  isUnresolvedDecision,
  nextDocState,
  projectArtifactState,
  projectInitiativeState,
  revisionVersionLabel,
  stageBadgeLine,
  taskNodeStateLabel,
  unresolvedDecisionCount,
  STATEMENT_STATUS_LABEL,
  TASK_NODE_STATE_LABEL,
} from './stateProjection';
import type { DocState, StateSignals } from './stateProjection';
import type { StateOverviewResponse } from '../services/apiTypes';
import { packageBadgeLine } from './taskPackages';
import type { TaskPackage } from './taskPackages';


const baseSignals: StateSignals = {
  pending_p0: 0,
  pending_p1: 0,
  pending_p2: 0,
  checklist_done: 0,
  checklist_total: 0,
  has_selected_revision: false,
  task_running: false,
  last_activity_days: 0,
};

function expectMove(current: DocState, patch: Partial<StateSignals>, expected: DocState | null) {
  assert.equal(nextDocState(current, { ...baseSignals, ...patch }), expected, `${current}`);
}

describe('nextDocState 六态迁移穷举', () => {
  it('Draft→PendingReview 当未决 P0/P1>0；否则保持', () => {
    expectMove('draft', { pending_p1: 1 }, 'pending_review');
    expectMove('draft', { pending_p0: 2 }, 'pending_review');
    expectMove('draft', { pending_p2: 3 }, null);
    expectMove('draft', {}, null);
  });

  it('PendingReview→ApprovedRevision 当 p0=p1=0 且有选中修订', () => {
    expectMove(
      'pending_review',
      { has_selected_revision: true },
      'approved_revision'
    );
    expectMove('pending_review', { has_selected_revision: false }, null);
    expectMove('pending_review', { has_selected_revision: true, pending_p1: 1 }, null);
    expectMove('pending_review', { has_selected_revision: true, pending_p0: 1 }, null);
  });

  it('ApprovedRevision→Executing 当 task_running（执行槽/交付槽 running，持久跨轮）', () => {
    expectMove('approved_revision', { task_running: true }, 'executing');
    expectMove('approved_revision', { task_running: false }, null);
  });

  it('Executing→Delivered 收敛为具体槽位判据：清单满 + 未决零 + 双槽 completed', () => {
    const full = {
      checklist_done: 6,
      checklist_total: 6,
      exec_slot_completed: true,
      deliver_slot_completed: true,
    };
    expectMove('executing', full, 'delivered');
    expectMove('executing', { ...full, checklist_done: 5 }, null);
    expectMove('executing', { ...full, checklist_total: 0, checklist_done: 0 }, null);
    expectMove('executing', { ...full, exec_slot_completed: false }, null);
    expectMove('executing', { ...full, deliver_slot_completed: false }, null);
    expectMove('executing', { ...full, pending_p1: 1 }, 'pending_review');
  });

  it('Delivered→Archived 当 user_accepted 或超期 30 天', () => {
    expectMove('delivered', { user_accepted: true }, 'archived');
    expectMove('delivered', { last_activity_days: 31 }, 'archived');
    expectMove('delivered', { last_activity_days: 30 }, null);
    expectMove('delivered', {}, null);
  });

  it('逆向回流唯一边：executing/delivered 引入未决 P0/P1 → PendingReview（优先于正向）', () => {
    expectMove('executing', { pending_p0: 1 }, 'pending_review');
    expectMove('delivered', { pending_p1: 1 }, 'pending_review');
    expectMove('delivered', { pending_p1: 1, last_activity_days: 99 }, 'pending_review');
    expectMove('approved_revision', { pending_p1: 1 }, null);
    expectMove('executing', { pending_p2: 2 }, null);
    expectMove('delivered', { pending_p2: 2 }, null);
  });

  it('Archived 终态：任何信号都不迁移（唯一离开通道=人工重开，不在本函数）', () => {
    expectMove('archived', { pending_p0: 5, task_running: true, user_accepted: true }, null);
    expectMove('archived', { last_activity_days: 999 }, null);
  });

  it('纯函数幂等：同输入重算结果稳定（running 持久性的声明式语义）', () => {
    const signals: StateSignals = { ...baseSignals, task_running: true };
    const first = nextDocState('approved_revision', signals);
    assert.equal(first, 'executing');
    for (let i = 0; i < 3; i++) {
      assert.equal(nextDocState('approved_revision', signals), first);
    }
  });
});


describe('词表与映射', () => {
  it('DOC_STATE_LABEL 六态词表逐字', () => {
    assert.deepEqual(DOC_STATE_LABEL, {
      draft: '草稿',
      pending_review: '待用户确认',
      approved_revision: '选中修订',
      executing: '执行中',
      delivered: '已交付',
      archived: '已归档',
    });
    assert.equal(DOC_STATE_ORDER.length, 6);
    assert.equal(Object.keys(STAGE_DOC_STATE).length, 6);
    assert.equal(Object.keys(DOC_STATE_PILL_CLASS).length, 6);
    for (const state of DOC_STATE_ORDER) {
      assert.ok(docStatePillClass(state).includes('rounded-full'));
    }
  });

  it('STAGE_BADGE_PHRASE 回退词表与现状逐字一致', () => {
    assert.deepEqual(STAGE_BADGE_PHRASE, {
      蓝图: '蓝图制定中',
      计划: '计划制定中',
      决策: '待拍板',
      执行: '执行中',
      交付: '待用户验收',
      待分类: '',
    });
  });

  it('stageBadgeLine 组合唯一出口：「v8 · 短语」/「v8」/「短语」/空串降级', () => {
    assert.equal(stageBadgeLine('交付', 8), 'v8 · 待用户验收');
    assert.equal(stageBadgeLine('待分类', 8), 'v8');
    assert.equal(stageBadgeLine('决策', null), '待拍板');
    assert.equal(stageBadgeLine('待分类', null), '');
    assert.equal(stageBadgeLine('待分类', undefined), '');
  });

  it('initiativeStateBadgeLine：服务端六态词路径', () => {
    assert.equal(initiativeStateBadgeLine('delivered', 8), 'v8 · 已交付');
    assert.equal(initiativeStateBadgeLine('pending_review'), '待用户确认');
    assert.equal(initiativeStateBadgeLine('draft', null), '草稿');
  });
});


describe('projectInitiativeState 双层投影', () => {
  it('服务端视图优先：逐字段采信（含未决计数）', () => {
    const p = projectInitiativeState(
      {
        state: 'executing',
        current_stage: '执行',
        pending_p0: 1,
        pending_p1: 2,
        pending_p2: 3,
      },
      { stage: '决策' }
    );
    assert.deepEqual(p, {
      state: 'executing',
      stage: '执行',
      source: 'server',
      pendingP0: 1,
      pendingP1: 2,
      pendingP2: 3,
    });
  });

  it('断连回退 dominantStage：阶段→六态走 STAGE_DOC_STATE，未决计数如实 null', () => {
    for (const [stage, expectedState] of [
      ['蓝图', 'draft'],
      ['计划', 'draft'],
      ['决策', 'pending_review'],
      ['执行', 'executing'],
      ['交付', 'delivered'],
      ['待分类', 'draft'],
    ] as const) {
      const p = projectInitiativeState(null, { stage });
      assert.equal(p.state, expectedState, stage);
      assert.equal(p.stage, stage);
      assert.equal(p.source, 'fallback');
      assert.equal(p.pendingP0, null);
      assert.equal(p.pendingP1, null);
      assert.equal(p.pendingP2, null);
    }
    assert.equal(projectInitiativeState(undefined, { stage: '决策' }).source, 'fallback');
  });
});


const overviewFixture = (): StateOverviewResponse => ({
  ok: true,
  index_generation: 7,
  generated_at: '2026-11-18T10:00:00Z',
  initiatives: [
    {
      initiative_id: 'init_alpha',
      name: '01-方案文档',
      root_dir: '01-方案文档',
      current_stage: '执行',
      state: 'executing',
      artifact_count: 2,
      pending_p0: 1,
      pending_p1: 2,
      pending_p2: 0,
      updated_at: '2026-11-18T09:00:00Z',
    },
    {
      initiative_id: 'init_beta',
      name: '04-智能体代码',
      root_dir: '04-智能体代码',
      current_stage: '决策',
      state: 'pending_review',
      artifact_count: 1,
      pending_p0: 0,
      pending_p1: 1,
      pending_p2: 0,
      updated_at: '2026-11-18T09:00:00Z',
    },
  ],
  artifacts: [
    {
      file_id: 'f_alpha_plan',
      initiative_id: 'init_alpha',
      current_path: '01-方案文档/p1/PLAN.md',
      title: 'PLAN',
      stage: '计划',
      state: 'approved_revision',
      selected_revision_id: 'rev_1',
      checklist_done: 2,
      checklist_total: 2,
      pending_p0: 0,
      pending_p1: 0,
      pending_p2: 0,
      last_activity_at: '2026-11-18T09:00:00Z',
    },
    {
      file_id: 'f_alpha_exec',
      initiative_id: 'init_alpha',
      current_path: '01-方案文档/p1/执行记录.md',
      title: '执行记录',
      stage: '执行',
      state: 'executing',
      selected_revision_id: null,
      checklist_done: 1,
      checklist_total: 3,
      pending_p0: 0,
      pending_p1: 0,
      pending_p2: 0,
      last_activity_at: '2026-11-18T09:00:00Z',
    },
    {
      file_id: 'f_beta_dec',
      initiative_id: 'init_beta',
      current_path: '04-智能体代码/待确认.md',
      title: '待确认',
      stage: '决策',
      state: 'pending_review',
      selected_revision_id: null,
      checklist_done: 0,
      checklist_total: 0,
      pending_p0: 0,
      pending_p1: 1,
      pending_p2: 0,
      last_activity_at: '2026-11-18T09:00:00Z',
    },
  ],
});

describe('/state-overview 前端索引（专项卡片 / 星图 / 顶栏共享）', () => {
  it('空响应 → null（视图回退既有阶段词，不造空投影）', () => {
    assert.equal(indexStateOverview(null), null);
    assert.equal(indexStateOverview(undefined), null);
  });

  it('按 file_id / initiative_id / root_dir 建常数索引', () => {
    const index = indexStateOverview(overviewFixture());
    assert.ok(index);
    assert.equal(index.artifactsByFileId.size, 3);
    assert.equal(index.initiativesById.size, 2);
    assert.equal(index.initiativesByRootDir.size, 2);
    assert.equal(index.artifactsByFileId.get('f_alpha_plan')?.state, 'approved_revision');
    assert.equal(index.initiativesByRootDir.get('01-方案文档')?.initiative_id, 'init_alpha');
  });

  it('文档级六态：artifactStateOf 命中/未命中', () => {
    const index = indexStateOverview(overviewFixture());
    assert.equal(artifactStateOf(index, 'f_alpha_exec')?.state, 'executing');
    assert.equal(artifactStateOf(index, 'f_missing'), null);
    assert.equal(artifactStateOf(null, 'f_alpha_exec'), null);
  });

  it('专项包解析：包内 artifact 行同指一个 initiative → 直接采信', () => {
    const index = indexStateOverview(overviewFixture());
    const row = initiativeStateOfPackage(index, {
      id: '任意/包',
      docs: [{ fileId: 'f_alpha_plan' }, { fileId: 'f_alpha_exec' }],
    });
    assert.equal(row?.initiative_id, 'init_alpha');
    assert.equal(row?.state, 'executing');
  });

  it('专项包解析：无 artifact 行 → 包 id 首段匹配 root_dir', () => {
    const index = indexStateOverview(overviewFixture());
    const row = initiativeStateOfPackage(index, {
      id: '04-智能体代码/OFF-PROD-001',
      docs: [{ fileId: 'f_unknown' }],
    });
    assert.equal(row?.initiative_id, 'init_beta');
    assert.equal(row?.state, 'pending_review');
  });

  it('专项包解析：多专项混包按 root_dir 兜底；根级/非专项域 → null', () => {
    const index = indexStateOverview(overviewFixture());
    assert.equal(
      initiativeStateOfPackage(index, {
        id: '01-方案文档/p1',
        docs: [{ fileId: 'f_alpha_plan' }, { fileId: 'f_beta_dec' }],
      })?.initiative_id,
      'init_alpha'
    );
    assert.equal(
      initiativeStateOfPackage(index, { id: '__root__', docs: [{ fileId: 'f_unknown' }] }),
      null
    );
    assert.equal(
      initiativeStateOfPackage(index, { id: 'output/run', docs: [{ fileId: 'f_unknown' }] }),
      null
    );
  });

  it('文档级双层投影：服务端行优先；无行按阶段回退六态', () => {
    const index = indexStateOverview(overviewFixture());
    const artifact = artifactStateOf(index, 'f_alpha_plan');
    assert.deepEqual(projectArtifactState(artifact, '交付'), {
      state: 'approved_revision',
      source: 'server',
    });
    assert.deepEqual(projectArtifactState(null, '交付'), {
      state: 'delivered',
      source: 'fallback',
    });
    assert.deepEqual(projectArtifactState(undefined, '待分类'), {
      state: 'draft',
      source: 'fallback',
    });
  });
});


describe('星图与任务节点词表', () => {
  it('artifactStageBadgeText：阶段词 / 待分类决策卡回退「决策」/ 其余空串', () => {
    assert.equal(artifactStageBadgeText('执行', false), '执行');
    assert.equal(artifactStageBadgeText('待分类', true), '决策');
    assert.equal(artifactStageBadgeText(null, true), '决策');
    assert.equal(artifactStageBadgeText(undefined, true), '决策');
    assert.equal(artifactStageBadgeText('待分类', false), '');
    assert.equal(artifactStageBadgeText(null, false), '');
  });

  it('taskNodeStateLabel 六态词表；未知词原样透传', () => {
    assert.equal(TASK_NODE_STATE_LABEL.queued, '排队中');
    assert.equal(TASK_NODE_STATE_LABEL.running, '进行中');
    assert.equal(TASK_NODE_STATE_LABEL.completed, '已完成');
    assert.equal(TASK_NODE_STATE_LABEL.suspended_on_hitl, '等待人工拍板');
    assert.equal(TASK_NODE_STATE_LABEL.cancelled, '已取消');
    assert.equal(TASK_NODE_STATE_LABEL.failed, '失败');
    assert.equal(taskNodeStateLabel('suspended_on_hitl'), '等待人工拍板');
    assert.equal(taskNodeStateLabel('mystery_state'), 'mystery_state');
  });
});


describe('决策未决口径（DecisionRadar/HomeView 收敛）', () => {
  const fixture = [
    { decision_id: 'd1', status: '待确认', isCandidateOnly: false },
    { decision_id: 'd2', status: '来源不一致', isCandidateOnly: false },
    { decision_id: 'd3', status: '已确认', isCandidateOnly: false },
    { decision_id: 'd4', status: '已取代', isCandidateOnly: false },
    { decision_id: 'd5', status: '待确认', isCandidateOnly: true },
    { decision_id: 'd6', status: '状态未知', isCandidateOnly: false },
  ];

  it('unresolvedDecisionCount = 待确认 + 来源不一致，排除候选', () => {
    assert.equal(unresolvedDecisionCount(fixture), 2);
    assert.equal(isUnresolvedDecision(fixture[0]), true);
    assert.equal(isUnresolvedDecision(fixture[1]), true);
    assert.equal(isUnresolvedDecision(fixture[2]), false);
    assert.equal(isUnresolvedDecision(fixture[4]), false);
  });

  it('DECIDED_DECISION_STATUSES 与雷达原词表逐字一致', () => {
    assert.deepEqual([...DECIDED_DECISION_STATUSES], ['已确认', '已否决', '已搁置', '已取代']);
    assert.equal(DECISION_STATUS_PENDING, '待确认');
    assert.equal(DECISION_STATUS_CONFLICT, '来源不一致');
  });
});


describe('版本后缀与 wire 词映射', () => {
  it('revisionVersionLabel：末版带（最新），非末版仅版本号', () => {
    assert.equal(revisionVersionLabel(8, true), 'v8（最新）');
    assert.equal(revisionVersionLabel(8, false), 'v8');
    assert.equal(revisionVersionLabel(1, true), 'v1（最新）');
  });

  it('STATEMENT_STATUS_LABEL wire→库内中文词映射表', () => {
    assert.deepEqual(STATEMENT_STATUS_LABEL, {
      pending: '待确认',
      confirmed: '已确认',
      rejected: '已否决',
      shelved: '已搁置',
      superseded: '已取代',
    });
  });

  it('GALLERY_FILTERS：executing/awaiting 词直接取 STAGE_BADGE_PHRASE（同源不分叉）', () => {
    assert.deepEqual(
      GALLERY_FILTERS.map((f) => f.label),
      ['全部专项', '执行中', '待用户验收', '核心蓝图', '图纸库']
    );
    assert.equal(GALLERY_FILTERS[1].label, STAGE_BADGE_PHRASE['执行']);
    assert.equal(GALLERY_FILTERS[2].label, STAGE_BADGE_PHRASE['交付']);
  });
});


describe('packageBadgeLine 经 SSOT 组合', () => {
  const pkgOf = (stage: TaskPackage['stage'], version?: number | null): TaskPackage => ({
    id: 'p1',
    name: 'P1',
    kind: 'fallback',
    stage,
    docs: [
      {
        fileId: 'f1',
        title: 'doc',
        format: 'md',
        stage,
        conclusion: '',
        versionNumber: version ?? null,
      },
    ],
    eventCount: 0,
    lastActivity: '',
    latestConclusion: '',
    readingOrder: [],
  });

  it('输出与回退路径逐字一致（v8 · 待用户验收）', () => {
    assert.equal(packageBadgeLine(pkgOf('交付', 8)), 'v8 · 待用户验收');
    assert.equal(packageBadgeLine(pkgOf('待分类', 3)), 'v3');
    assert.equal(packageBadgeLine(pkgOf('决策', null)), '待拍板');
    assert.equal(packageBadgeLine(pkgOf('待分类', null)), '');
  });

  it('版本取包内最大 versionNumber', () => {
    const pkg = pkgOf('执行', 2);
    pkg.docs.push({ fileId: 'f2', title: 'doc2', format: 'md', stage: '执行', conclusion: '', versionNumber: 9 });
    assert.equal(packageBadgeLine(pkg), 'v9 · 执行中');
  });
});
