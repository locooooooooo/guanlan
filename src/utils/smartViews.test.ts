import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSmartViewCounts,
  computeSmartViewFiles,
  isSmartViewScope,
  RECENT_ACTIVE_WINDOW_MS,
  SMART_VIEWS,
  smartViewIdSet,
  type SmartViewId,
} from './smartViews';
import type { FileRecord, ReadingState } from '../types/guanlan';
import type { ArtifactStateView } from '../services/apiTypes';

/** C04 行为锁定：五类智能视图成员/计数同源守恒（任务卡 §5 C04 量化验收口径）。 */

const NOW = Date.parse('2026-11-21T12:00:00+08:00');

function file(overrides: Partial<FileRecord> & { fileId: string }): FileRecord {
  return {
    file_id: overrides.fileId,
    relative_path: `${overrides.fileId}.md`,
    title: overrides.title ?? overrides.fileId,
    format: 'md',
    folder: '.',
    role: '方案文档',
    roleProvenance: '规则命中',
    topics: [],
    current_revision_id: `rev_${overrides.fileId}`,
    revisions: [
      {
        revision_id: `rev_${overrides.fileId}`,
        file_id: overrides.fileId,
        versionNumber: 1,
        content_sha256: 'aa',
        observed_at: '2026-11-20T09:00:00+08:00',
        sizeBytes: 10,
        snapshotAvailable: true,
      },
    ],
    coverage: 'full_text',
    ...overrides,
  } as FileRecord;
}

function reading(overrides: Partial<ReadingState> & { fileId: string }): ReadingState {
  return {
    file_id: overrides.fileId,
    scrollPercent: 0,
    isFullyRead: false,
    bookmarked: false,
    updated_at: '2026-11-20T10:00:00+08:00',
    ...overrides,
  };
}

function artifact(
  overrides: Partial<ArtifactStateView> & { fileId: string }
): ArtifactStateView {
  return {
    file_id: overrides.fileId,
    initiative_id: null,
    current_path: `${overrides.fileId}.md`,
    title: overrides.fileId,
    stage: '待分类',
    state: 'draft',
    selected_revision_id: null,
    checklist_done: 0,
    checklist_total: 0,
    pending_p0: 0,
    pending_p1: 0,
    pending_p2: 0,
    last_activity_at: null,
    ...overrides,
  };
}

test('SMART_VIEWS：五类视图清单齐备且 ID 类型守卫成立', () => {
  assert.equal(SMART_VIEWS.length, 5);
  assert.equal(
    SMART_VIEWS.map((v) => v.id).join(','),
    'updated_after_read,awaiting_decision,recent_active,agent_drafts,unassigned'
  );
  assert.equal(isSmartViewScope('awaiting_decision'), true);
  assert.equal(isSmartViewScope('unread'), false);
  assert.equal(isSmartViewScope('bookmarked'), false);
  assert.equal(isSmartViewScope(''), false);
});

test('读后有更新：有基线且当前版更新才计入；never_read / up_to_date 不算', () => {
  const files = [
    file({ fileId: 'read_stale', current_revision_id: 'rev2' }), // 基线 rev1 ≠ rev2 → updated
    file({ fileId: 'never_opened' }),
    file({ fileId: 'up_to_date', current_revision_id: 'rev1' }),
  ];
  const readingStates: Record<string, ReadingState> = {
    read_stale: reading({ fileId: 'read_stale', last_read_revision_id: 'rev1' }),
    up_to_date: reading({ fileId: 'up_to_date', last_read_revision_id: 'rev1' }),
    // never_opened 无阅读态
  };
  const result = computeSmartViewFiles({
    files,
    readingStates,
    artifactsByFileId: null,
    agentDraftFileIds: null,
    nowMs: NOW,
  });
  assert.deepEqual(
    result.updated_after_read.map((f) => f.file_id),
    ['read_stale']
  );
});

test('等我拍板：pending_p0+p1>0 计入，P2-only 不占「等我拍板」', () => {
  const files = [file({ fileId: 'a' }), file({ fileId: 'b' }), file({ fileId: 'c' })];
  const artifacts = new Map<string, ArtifactStateView>([
    ['a', artifact({ fileId: 'a', pending_p0: 1 })],
    ['b', artifact({ fileId: 'b', pending_p1: 2 })],
    ['c', artifact({ fileId: 'c', pending_p2: 3 })],
  ]);
  const result = computeSmartViewFiles({
    files,
    readingStates: {},
    artifactsByFileId: artifacts,
    agentDraftFileIds: null,
    nowMs: NOW,
  });
  assert.deepEqual(
    result.awaiting_decision.map((f) => f.file_id),
    ['a', 'b']
  );
});

test('近 7 天活跃：last_activity_at 窗口边界（7 天整点内算、7 天前一刻不算、非法/缺失诚实不算）', () => {
  const files = [file({ fileId: 'edge_in' }), file({ fileId: 'edge_out' }), file({ fileId: 'bad' })];
  const artifacts = new Map<string, ArtifactStateView>([
    ['edge_in', artifact({ fileId: 'edge_in', last_activity_at: new Date(NOW - RECENT_ACTIVE_WINDOW_MS).toISOString() })],
    ['edge_out', artifact({ fileId: 'edge_out', last_activity_at: new Date(NOW - RECENT_ACTIVE_WINDOW_MS - 1).toISOString() })],
    ['bad', artifact({ fileId: 'bad', last_activity_at: 'not-a-time' })],
  ]);
  const result = computeSmartViewFiles({
    files,
    readingStates: {},
    artifactsByFileId: artifacts,
    agentDraftFileIds: null,
    nowMs: NOW,
  });
  assert.deepEqual(result.recent_active.map((f) => f.file_id), ['edge_in']);
});

test('Agent 待审草案：以草案 file_id 集为准；游离未归属：initiative_id===null', () => {
  const files = [file({ fileId: 'drafted' }), file({ fileId: 'loose' }), file({ fileId: 'owned' })];
  const artifacts = new Map<string, ArtifactStateView>([
    ['drafted', artifact({ fileId: 'drafted', initiative_id: 'init_a' })],
    ['loose', artifact({ fileId: 'loose', initiative_id: null })],
    ['owned', artifact({ fileId: 'owned', initiative_id: 'init_b' })],
  ]);
  const result = computeSmartViewFiles({
    files,
    readingStates: {},
    artifactsByFileId: artifacts,
    agentDraftFileIds: new Set(['drafted']),
    nowMs: NOW,
  });
  assert.deepEqual(result.agent_drafts.map((f) => f.file_id), ['drafted']);
  assert.deepEqual(result.unassigned.map((f) => f.file_id), ['loose']);
});

test('守恒：计数 = computeSmartViewFiles 同一输出的成员长度（误差恒 0）', () => {
  const files = [
    file({ fileId: 'f1' }),
    file({ fileId: 'f2' }),
    file({ fileId: 'f3' }),
  ];
  const artifacts = new Map<string, ArtifactStateView>([
    ['f1', artifact({ fileId: 'f1', pending_p0: 1, initiative_id: null, last_activity_at: new Date(NOW).toISOString() })],
    ['f2', artifact({ fileId: 'f2', pending_p2: 1, initiative_id: 'i1' })],
  ]);
  const readingStates: Record<string, ReadingState> = {
    f3: reading({ fileId: 'f3', last_read_revision_id: 'old' }),
  };
  const draftIds = new Set(['f1']);
  const membership = computeSmartViewFiles({
    files,
    readingStates,
    artifactsByFileId: artifacts,
    agentDraftFileIds: draftIds,
    nowMs: NOW,
  });
  const counts = computeSmartViewCounts(membership);
  for (const { id } of SMART_VIEWS) {
    assert.equal(counts[id], membership[id].length, `视图 ${id} 计数与成员守恒`);
  }
  assert.equal(counts.updated_after_read, 1);
  assert.equal(counts.awaiting_decision, 1);
  assert.equal(counts.recent_active, 1);
  assert.equal(counts.agent_drafts, 1);
  assert.equal(counts.unassigned, 1);
});

test('smartViewIdSet：成员集 O(1) 判定用（App.filteredFiles 消费同源）', () => {
  const files = [file({ fileId: 'x' }), file({ fileId: 'y' })];
  const membership = computeSmartViewFiles({
    files,
    readingStates: {},
    artifactsByFileId: null,
    agentDraftFileIds: new Set(['x', 'y']),
    nowMs: NOW,
  });
  const ids: SmartViewId = 'agent_drafts';
  const set = smartViewIdSet(membership, ids);
  assert.equal(set.has('x'), true);
  assert.equal(set.has('y'), true);
  assert.equal(set.size, 2);
});
