import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { WorkspaceStore } from '../server/WorkspaceStore';
import { queryEvents, eventTimeRange } from '../server/queries';

/**
 * 分页游标绑定筛选与首次查询时的最大事件序号；
 * 分页期间有新增事件，同一分页窗口完整且无重复，刷新后可看到新增记录。
 */

function freshStore(): { store: WorkspaceStore; workspaceId: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-evq-'));
  const store = new WorkspaceStore(path.join(dir, '.data'));
  const ws = store.ensureWorkspace(path.join(dir, 'workspace'));
  return { store, workspaceId: ws.workspace_id };
}

function seed(store: WorkspaceStore, workspaceId: string, count: number): void {
  for (let i = 1; i <= count; i++) {
    const day = String(i).padStart(2, '0');
    store.insertEvent({
      event_id: `evt_seed_${i}`,
      workspace_id: workspaceId,
      kind: i % 3 === 0 ? 'workspace_baseline' : 'modified',
      subject_kind: 'revision',
      subject_id: `rev_seed_${i}`,
      revision_id: null,
      occurred_at: `2026-10-${day}`,
      occurred_precision: 'day',
      occurred_source: 'document_self',
      observed_at: `2026-10-${day}T10:00:00.000Z`,
      headline: `事件 ${i}`,
      detail: `第 ${i} 条测试事件`,
      payload_json: '{}',
      batch_id: null,
    });
  }
}

test('分页：游标续页完整、无重复，且绑定首次查询的快照序号', () => {
  const { store, workspaceId } = freshStore();
  seed(store, workspaceId, 7);

  const page1 = queryEvents(store, { workspaceId, limit: 3 });
  assert.equal(page1.items.length, 3);
  assert.equal(page1.has_more, true);
  assert.ok(page1.next_cursor, '首页应给出下一页游标');
  assert.equal(page1.total_in_window, 7);
  assert.equal(page1.snapshot_max_seq, store.maxEventSeq(workspaceId));

  const seen = new Set<number>(page1.items.map((i) => i.seq));

  const page2 = queryEvents(store, {
    workspaceId,
    limit: 3,
    cursor: page1.next_cursor,
  });
  assert.equal(page2.items.length, 3);
  for (const item of page2.items) {
    assert.ok(!seen.has(item.seq), '翻页不得重复同一条事件');
    seen.add(item.seq);
  }
  assert.equal(page2.next_cursor === null || page2.next_cursor !== undefined, true);

  const page3 = queryEvents(store, {
    workspaceId,
    limit: 3,
    cursor: page2.next_cursor,
  });
  assert.equal(page3.items.length, 1);
  assert.equal(page3.has_more, false);
  assert.equal(page3.next_cursor, null);
  for (const item of page3.items) {
    assert.ok(!seen.has(item.seq), '末页不得重复');
    seen.add(item.seq);
  }
  assert.equal(seen.size, 7, '分页应覆盖窗口内全部事件且无重复');

  store.close();
});

test('分页期间新增事件：旧游标窗口保持完整，新事件通过 newer_count 提示', () => {
  const { store, workspaceId } = freshStore();
  seed(store, workspaceId, 5);

  const page1 = queryEvents(store, { workspaceId, limit: 2 });
  assert.equal(page1.newer_count, 0);

  // 分页期间写入一条新事件（发生时间更晚）
  store.insertEvent({
    event_id: 'evt_new_1',
    workspace_id: workspaceId,
    kind: 'modified',
    subject_kind: 'revision',
    subject_id: 'rev_new_1',
    revision_id: null,
    occurred_at: '2026-11-06',
    occurred_precision: 'day',
    occurred_source: 'document_self',
    observed_at: '2026-11-06T10:00:00.000Z',
    headline: '分页期间新增',
    detail: '不应出现在旧游标窗口',
    payload_json: '{}',
    batch_id: null,
  });

  const page2 = queryEvents(store, {
    workspaceId,
    limit: 10,
    cursor: page1.next_cursor,
  });
  assert.ok(
    page2.items.every((i) => i.event_id !== 'evt_new_1'),
    '旧游标绑定快照，新事件不得插进当前分页窗口'
  );
  assert.equal(page2.newer_count, 1, '应提示有新变化');
  // 旧窗口内剩余 3 条
  assert.equal(page2.items.length, 3);
  assert.equal(page2.snapshot_max_seq, page1.snapshot_max_seq);

  // 刷新后（无游标）新事件进入新窗口
  const refreshed = queryEvents(store, { workspaceId, limit: 10 });
  assert.equal(refreshed.items[0].event_id, 'evt_new_1', '刷新后新事件应排在前面');
  assert.equal(refreshed.newer_count, 0);

  store.close();
});

test('游标与筛选不一致时拒绝复用（INDEX_STALE）', () => {
  const { store, workspaceId } = freshStore();
  seed(store, workspaceId, 4);
  const page1 = queryEvents(store, { workspaceId, limit: 2 });

  assert.throws(
    () =>
      queryEvents(store, {
        workspaceId,
        limit: 2,
        kinds: ['workspace_baseline'],
        cursor: page1.next_cursor,
      }),
    (error: unknown) => (error as { code?: string }).code === 'INDEX_STALE'
  );

  store.close();
});

test('日期窗口、日期待考与时间范围来自真实事件', () => {
  const { store, workspaceId } = freshStore();
  seed(store, workspaceId, 3);

  // 一条无发生时间的事件：进入「日期待考」
  store.insertEvent({
    event_id: 'evt_undated',
    workspace_id: workspaceId,
    kind: 'read_error',
    subject_kind: 'file',
    subject_id: 'path:x',
    revision_id: null,
    occurred_at: null,
    occurred_precision: 'unknown',
    occurred_source: null,
    observed_at: '2026-11-06T12:00:00.000Z',
    headline: '读取问题',
    detail: '无发生时间',
    payload_json: '{}',
    batch_id: null,
  });

  const range = eventTimeRange(store, workspaceId);
  assert.equal(range.occurredMin, '2026-10-01');
  assert.equal(range.occurredMax, '2026-10-03');
  assert.equal(range.undatedCount, 1);

  const window = queryEvents(store, {
    workspaceId,
    from: '2026-10-02',
    to: '2026-10-03',
    limit: 10,
  });
  assert.equal(window.items.length, 2, '日期窗口应只返回区间内事件');
  assert.equal(window.total_in_window, 2);

  const undated = queryEvents(store, { workspaceId, undated: true, limit: 10 });
  assert.equal(undated.items.length, 1);
  assert.equal(undated.items[0].event_id, 'evt_undated');

  const byObserved = queryEvents(store, { workspaceId, order: 'observed', limit: 10 });
  assert.equal(byObserved.window.order, 'observed');
  assert.equal(byObserved.items[0].event_id, 'evt_undated', '按采集口径时最新观察的在最前');

  store.close();
});

/**
 * 含时刻的 occurred_at（UTC ISO）按服务端本地日历日归属日期窗口；
 * 纯日期 occurred_at 必须短路、不参与时区换算。
 * 期望值由 Node 的 Date 本地字段独立算出（走 Intl 之外的 JS 路径），
 * 与服务端 SQLite 的 date(...,'localtime') 求值路径不同，避免同义反复。
 */
test('本地日窗口：UTC 20:00 的 occurred_at 归入本地次日，纯日期仍在原日', () => {
  const { store, workspaceId } = freshStore();
  const occurredIso = '2026-11-02T20:00:00.000Z';

  store.insertEvent({
    event_id: 'evt_local_day',
    workspace_id: workspaceId,
    kind: 'modified',
    subject_kind: 'file',
    subject_id: 'path:local-day.md',
    revision_id: null,
    occurred_at: occurredIso,
    occurred_precision: 'second',
    occurred_source: 'document_self',
    observed_at: occurredIso,
    headline: '跨零点事件',
    detail: 'UTC 20:00 在本机 +08 下已是次日 04:00',
    payload_json: '{}',
    batch_id: null,
  });
  store.insertEvent({
    event_id: 'evt_pure_day',
    workspace_id: workspaceId,
    kind: 'modified',
    subject_kind: 'file',
    subject_id: 'path:pure-day.md',
    revision_id: null,
    occurred_at: '2026-11-02',
    occurred_precision: 'day',
    occurred_source: 'document_self',
    observed_at: '2026-11-02T03:00:00.000Z',
    headline: '纯日期事件',
    detail: '材料只记载到日',
    payload_json: '{}',
    batch_id: null,
  });

  const d = new Date(occurredIso);
  const localDay = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
  const utcDay = occurredIso.slice(0, 10);
  assert.notEqual(
    localDay,
    utcDay,
    '本机需为非 UTC 时区（观澜为本机 +08 应用），否则本地化与 UTC 同值无法区分'
  );

  const localWindow = queryEvents(store, {
    workspaceId,
    from: localDay,
    to: localDay,
    limit: 10,
  });
  assert.deepEqual(
    localWindow.items.map((item) => item.event_id),
    ['evt_local_day'],
    'occurred_at 的 UTC 20:00 应归入本地次日窗口'
  );

  const utcWindow = queryEvents(store, {
    workspaceId,
    from: utcDay,
    to: utcDay,
    limit: 10,
  });
  assert.ok(
    !utcWindow.items.some((item) => item.event_id === 'evt_local_day'),
    '同一事件不得再按 UTC 日归属'
  );
  const pure = utcWindow.items.find((item) => item.event_id === 'evt_pure_day');
  assert.ok(pure, '纯日期事件仍应在 2026-11-02 返回');
  assert.equal(pure.occurred_at, '2026-11-02');

  store.close();
});
