import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSpotlightChanges,
  computeSpotlightDimmedFileIds,
  computeSpotlightSummary,
  shouldIgnoreSpotlightKeys,
  spotlightKindLabel,
  stepSpotlightCursor,
  type SpotlightChangeItem,
} from './readingSpotlight';
import type { FileRecord, ReadingState } from '../types/guanlan';
import type { ArtifactStateView } from '../services/apiTypes';


const NOW = Date.parse('2026-11-21T12:00:00+08:00');

function file(
  overrides: Partial<FileRecord> & { fileId: string; currentRev?: string }
): FileRecord {
  const currentRev = overrides.currentRev ?? `rev_${overrides.fileId}_v2`;
  return {
    file_id: overrides.fileId,
    relative_path: `${overrides.fileId}.md`,
    title: overrides.title ?? overrides.fileId,
    format: 'md',
    folder: '.',
    role: '方案文档',
    roleProvenance: '规则命中',
    topics: [],
    current_revision_id: currentRev,
    revisions: [
      {
        revision_id: `rev_${overrides.fileId}_v1`,
        file_id: overrides.fileId,
        versionNumber: 1,
        content_sha256: 'aa',
        observed_at: '2026-11-19T09:00:00+08:00',
        sizeBytes: 10,
        snapshotAvailable: true,
      },
      {
        revision_id: currentRev,
        file_id: overrides.fileId,
        versionNumber: 2,
        content_sha256: 'bb',
        observed_at: '2026-11-20T10:00:00+08:00',
        sizeBytes: 12,
        snapshotAvailable: true,
      },
    ],
    coverage: 'full_text',
    ...overrides,
  } as FileRecord;
}

function reading(
  overrides: Partial<ReadingState> & { fileId: string; baseline?: string | null }
): ReadingState {
  const baseline = overrides.baseline === undefined ? `rev_${overrides.fileId}_v2` : overrides.baseline;
  return {
    file_id: overrides.fileId,
    scrollPercent: 0.5,
    isFullyRead: false,
    bookmarked: false,
    updated_at: '2026-11-20T11:00:00+08:00',
    ...overrides,
    last_read_revision_id: baseline ?? undefined,
  };
}

function artifact(
  overrides: Partial<ArtifactStateView> & { fileId: string }
): ArtifactStateView {
  return {
    file_id: overrides.fileId,
    initiative_id: 'ini_1',
    current_path: `${overrides.fileId}.md`,
    title: overrides.fileId,
    stage: 'decision',
    state: 'in_progress',
    selected_revision_id: null,
    checklist_done: 0,
    checklist_total: 0,
    pending_p0: 0,
    pending_p1: 0,
    pending_p2: 0,
    last_activity_at: '2026-11-20T12:00:00+08:00',
    ...overrides,
  } as ArtifactStateView;
}

function artifactMap(rows: ArtifactStateView[]): Map<string, ArtifactStateView> {
  return new Map(rows.map((row) => [row.file_id, row]));
}

function derive(args: {
  files: FileRecord[];
  readingStates: Record<string, ReadingState>;
  artifacts?: ArtifactStateView[];
  drafts?: Record<string, string>;
}): SpotlightChangeItem[] {
  return computeSpotlightChanges({
    files: args.files,
    readingStates: args.readingStates,
    artifactsByFileId: args.artifacts ? artifactMap(args.artifacts) : null,
    agentDraftAtByFileId: new Map(Object.entries(args.drafts ?? {})),
    nowMs: NOW,
  });
}

test('聚光灯：读后有更新（新增版本）命中且有基线；当前版未变不命中', () => {
  const changed = file({ fileId: 'a', currentRev: 'rev_a_v3', title: '甲' });
  const untouched = file({ fileId: 'b', title: '乙' });
  const items = derive({
    files: [changed, untouched],
    readingStates: {
      a: reading({ fileId: 'a', baseline: 'rev_a_v1' }),
      b: reading({ fileId: 'b' }),
    },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].file_id, 'a');
  assert.equal(items[0].kind, 'revision_update');
  assert.equal(
    items[0].atMs,
    Date.parse('2026-11-20T10:00:00+08:00'),
    '排序时间 = 当前版 observed_at'
  );
});

test('停机条件护栏：never_read（未读新件/首次收录）绝不进变化清单，两态绝不混同', () => {
  const fresh = file({ fileId: 'fresh', currentRev: 'rev_fresh_v2', title: '丙' });
  const items = derive({
    files: [fresh],
    readingStates: { fresh: reading({ fileId: 'fresh', baseline: null }) },
    artifacts: [artifact({ fileId: 'fresh', pending_p1: 2 })],
    drafts: { fresh: '2026-11-20T13:00:00+08:00' },
  });
  assert.equal(items.length, 0);
});

test('聚光灯：新挂起决定 = 有基线且 pending_p0+p1>0，时间取 last_activity_at', () => {
  const f = file({ fileId: 'd', title: '丁' });
  const items = derive({
    files: [f],
    readingStates: { d: reading({ fileId: 'd' }) },
    artifacts: [artifact({ fileId: 'd', pending_p0: 1 })],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'pending_decision');
  assert.equal(items[0].atMs, Date.parse('2026-11-20T12:00:00+08:00'));
  const none = derive({
    files: [f],
    readingStates: { d: reading({ fileId: 'd' }) },
    artifacts: [artifact({ fileId: 'd' })],
  });
  assert.equal(none.length, 0);
});

test('聚光灯：Agent 新草案按 file_id 集命中，时间取 created_at', () => {
  const f = file({ fileId: 'g', title: '戊' });
  const items = derive({
    files: [f],
    readingStates: { g: reading({ fileId: 'g' }) },
    drafts: { g: '2026-11-21T08:30:00+08:00' },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'agent_draft');
  assert.equal(items[0].atMs, Date.parse('2026-11-21T08:30:00+08:00'));
});

test('聚光灯排序：按时间新→旧，无时间诚实排后；同类同刻 title 平局确定', () => {
  const early = file({ fileId: 'early', title: '乙' });
  const late = file({ fileId: 'late', title: '甲' });
  const noTime = file({ fileId: 'noTime', title: '丙' });
  const items = derive({
    files: [early, late, noTime],
    readingStates: {
      early: reading({ fileId: 'early' }),
      late: reading({ fileId: 'late' }),
      noTime: reading({ fileId: 'noTime' }),
    },
    drafts: {
      early: '2026-11-20T08:00:00+08:00',
      late: '2026-11-21T09:00:00+08:00',
      noTime: 'not-a-date',
    },
  });
  assert.deepEqual(
    items.map((i) => [i.file_id, i.atMs === null]),
    [
      ['late', false],
      ['early', false],
      ['noTime', true],
    ],
    '新→旧，无时间排最后'
  );
  const again = derive({
    files: [early, late, noTime],
    readingStates: {
      early: reading({ fileId: 'early' }),
      late: reading({ fileId: 'late' }),
      noTime: reading({ fileId: 'noTime' }),
    },
    drafts: {
      early: '2026-11-20T08:00:00+08:00',
      late: '2026-11-21T09:00:00+08:00',
      noTime: 'not-a-date',
    },
  });
  assert.deepEqual(again, items);
});

test('聚光灯摘要：M = 处数（同类多文件、同文件多类各自成条）', () => {
  const dual = file({ fileId: 'dual', currentRev: 'rev_dual_v3', title: '双' });
  const single = file({ fileId: 's', title: '单' });
  const items = derive({
    files: [dual, single],
    readingStates: {
      dual: reading({ fileId: 'dual', baseline: 'rev_dual_v1' }),
      s: reading({ fileId: 's' }),
    },
    drafts: { dual: '2026-11-21T07:00:00+08:00' },
  });
  const summary = computeSpotlightSummary(items);
  assert.equal(summary.total, 2, '同文件多类各自成条：版本变更 + 草案');
  assert.equal(summary.byKind.revision_update, 1);
  assert.equal(summary.byKind.agent_draft, 1);
  assert.equal(summary.byKind.pending_decision, 0);
});

test('聚光灯降亮度：已读未变 → 降；未读新件/命中变化 → 不降（骨架绝不吞行动信号）', () => {
  const dimmedFile = file({ fileId: 'dim', title: '旧' });
  const freshFile = file({ fileId: 'fresh', title: '新件' });
  const changedFile = file({ fileId: 'chg', currentRev: 'rev_chg_v3', title: '新版本' });
  const decidedFile = file({ fileId: 'dec', title: '拍板' });
  const items = derive({
    files: [dimmedFile, freshFile, changedFile, decidedFile],
    readingStates: {
      dim: reading({ fileId: 'dim' }),
      fresh: reading({ fileId: 'fresh', baseline: null }),
      chg: reading({ fileId: 'chg', baseline: 'rev_chg_v1' }),
      dec: reading({ fileId: 'dec' }),
    },
    artifacts: [artifact({ fileId: 'dec', pending_p1: 1 })],
  });
  const dimmed = computeSpotlightDimmedFileIds(
    [dimmedFile, freshFile, changedFile, decidedFile],
    {
      dim: reading({ fileId: 'dim' }),
      fresh: reading({ fileId: 'fresh', baseline: null }),
      chg: reading({ fileId: 'chg', baseline: 'rev_chg_v1' }),
      dec: reading({ fileId: 'dec' }),
    },
    items
  );
  assert.deepEqual([...dimmed].sort(), ['dim'], '仅「已读且未变且无读后变化」降亮度');
  assert.ok(!dimmed.has('fresh'), '未读新件（首次收录）不降亮度');
  assert.ok(!dimmed.has('dec'), '挂新决定的已读文件不降（行动信号保留）');
});

test('聚光灯措辞：三类 kind 徽标单一出口', () => {
  assert.equal(spotlightKindLabel('revision_update'), '新增版本');
  assert.equal(spotlightKindLabel('pending_decision'), '新挂起决定');
  assert.equal(spotlightKindLabel('agent_draft'), 'Agent 新草案');
});

test('J/K 守卫：编辑面与浮层打开时让路；普通态放行', () => {
  assert.equal(shouldIgnoreSpotlightKeys(null, false), false);
  assert.equal(shouldIgnoreSpotlightKeys(null, true), true, 'esc 浮层打开让路');
  const input = { tagName: 'INPUT', isContentEditable: false } as HTMLElement;
  const div = { tagName: 'DIV', isContentEditable: false } as HTMLElement;
  const editable = { tagName: 'DIV', isContentEditable: true } as HTMLElement;
  assert.equal(shouldIgnoreSpotlightKeys(input, false), true, '输入框让路');
  assert.equal(shouldIgnoreSpotlightKeys(div, false), false);
  assert.equal(shouldIgnoreSpotlightKeys(editable, false), true, 'contentEditable 让路');
});

test('J/K 步进：循环且 total=0 恒 0；反向越界回绕', () => {
  assert.equal(stepSpotlightCursor(0, 3, 1), 1);
  assert.equal(stepSpotlightCursor(2, 3, 1), 0, '末尾循环到首');
  assert.equal(stepSpotlightCursor(0, 3, -1), 2, '首部反向回绕到末');
  assert.equal(stepSpotlightCursor(1, 0, 1), 0);
});
