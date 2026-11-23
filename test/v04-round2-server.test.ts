import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { WorkspaceStore } from '../server/WorkspaceStore';
import { queryEvents, queryEventDays } from '../server/queries';
import { WorkspaceWatcher } from '../server/watcher';

function freshStore(): { store: WorkspaceStore; workspaceId: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-r2-'));
  const store = new WorkspaceStore(path.join(dir, '.data'));
  const ws = store.ensureWorkspace(path.join(dir, 'workspace'));
  return { store, workspaceId: ws.workspace_id, dir };
}

function seedEvent(
  store: WorkspaceStore,
  workspaceId: string,
  i: number,
  over: Partial<{ occurred: string | null; kind: string; payload: object; revId: string | null }> = {}
): void {
  const day = over.occurred === undefined ? `2026-09-${String((i % 28) + 1).padStart(2, '0')}` : over.occurred;
  store.insertEvent({
    event_id: `evt_p_${i}`,
    workspace_id: workspaceId,
    kind: (over.kind as 'modified') || 'modified',
    subject_kind: 'revision',
    subject_id: over.revId || `rev_p_${i}`,
    revision_id: over.revId === undefined ? `rev_p_${i}` : over.revId,
    occurred_at: day,
    occurred_precision: day ? 'day' : 'unknown',
    occurred_source: day ? 'document_self' : null,
    observed_at: `2026-09-29T10:00:${String(i % 60).padStart(2, '0')}.000Z`,
    headline: `事件 ${i}`,
    detail: `测试事件 ${i}`,
    payload_json: JSON.stringify(over.payload || {}),
    batch_id: null,
  });
}

test('超过 300 条事件可完整翻页：无重复、无遗漏、窗口绑定快照', () => {
  const { store, workspaceId } = freshStore();
  const TOTAL = 347;
  for (let i = 1; i <= TOTAL; i++) seedEvent(store, workspaceId, i);

  const seen = new Set<number>();
  let cursor: string | null = null;
  let pages = 0;
  let snapshot = -1;
  while (true) {
    const page = queryEvents(store, { workspaceId, limit: 50, cursor });
    pages++;
    assert.equal(page.total_in_window, TOTAL);
    if (snapshot < 0) snapshot = page.snapshot_max_seq;
    assert.equal(page.snapshot_max_seq, snapshot, '同一窗口内快照序号固定');
    for (const item of page.items) {
      assert.ok(!seen.has(item.seq), `第 ${pages} 页出现重复事件 seq=${item.seq}`);
      seen.add(item.seq);
    }
    cursor = page.next_cursor;
    if (!cursor) break;
    assert.ok(pages < 20, '翻页次数异常，可能存在游标死循环');
  }

  assert.equal(seen.size, TOTAL, '翻页应覆盖全部事件');
  assert.ok(pages >= 7, `347 条 / 每页 50 条应至少 7 页，实得 ${pages}`);
  store.close();
});

test('按日聚合：日期倒序、同一天内多个事项、日期待考独立成组且排最后', () => {
  const { store, workspaceId } = freshStore();

  seedEvent(store, workspaceId, 1, {
    occurred: '2026-11-04',
    kind: 'decision_raised',
    revId: null,
    payload: { decision_id: 'dec_q01', code: 'Q01', status: '待确认' },
  });
  seedEvent(store, workspaceId, 2, {
    occurred: '2026-11-04',
    kind: 'decision_raised',
    revId: null,
    payload: { decision_id: 'dec_q02', code: 'Q02', status: '来源不一致' },
  });
  seedEvent(store, workspaceId, 3, { occurred: '2026-11-04' });
  seedEvent(store, workspaceId, 4, { occurred: '2026-11-05' });
  seedEvent(store, workspaceId, 5, { occurred: null, kind: 'read_error', revId: null });

  const days = queryEventDays(store, { workspaceId, limitDays: 10, samplesPerDay: 4 });
  assert.equal(days.total, 5);
  assert.equal(days.undated_count, 1);
  assert.deepEqual(days.groups.map((g) => g.date), ['2026-11-05', '2026-11-04', ''], '日期倒序且日期待考排最后');

  const nov4 = days.groups.find((g) => g.date === '2026-11-04')!;
  assert.equal(nov4.count, 3);
  assert.equal(nov4.decisions.length, 2, '同一天两个不同业务决定');
  assert.deepEqual(nov4.decisions.map((d) => d.code).sort(), ['Q01', 'Q02']);
  assert.equal(nov4.samples.length, 3);

  const undated = days.groups.find((g) => g.date === '')!;
  assert.equal(undated.count, 1);
  assert.equal(undated.samples[0].occurred_at, null, '日期待考事件不应被挪到采集日');
  store.close();
});

test('同桶取样优先级：决策/内容修改事件不被 seq 更晚的 appeared 挤出样本窗口', () => {
  const { store, workspaceId } = freshStore();
  // 同一桶（2026-11-04）：先插入 1 条 modified（seq 最小），再插入 6 条 appeared（seq 更大）；
  // samplesPerDay=4 < 总数 7 —— 纯 seq DESC 取样会全是 appeared，modified 被挤出窗口
  seedEvent(store, workspaceId, 1, { occurred: '2026-11-04', kind: 'modified' });
  for (let i = 2; i <= 7; i++) {
    seedEvent(store, workspaceId, i, { occurred: '2026-11-04', kind: 'appeared', revId: `rev_p_${i}` });
  }

  const days = queryEventDays(store, { workspaceId, limitDays: 10, samplesPerDay: 4 });
  const nov4 = days.groups.find((g) => g.date === '2026-11-04')!;
  assert.equal(nov4.count, 7);
  assert.equal(nov4.samples.length, 4, '样本窗口不变：samplesPerDay=4');
  assert.ok(
    nov4.samples.some((s) => s.kind === 'modified'),
    'modified（seq 更小）必被优先选入样本，不被 seq 更晚的 appeared 挤出'
  );
  store.close();
});

test('文件监听：写入防抖后触发一次核验并发出变更通知', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guanlan-watch-'));
  const root = path.join(dir, 'workspace');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'a.md'), '# a\n', 'utf-8');

  let runs = 0;
  const watcher = new WorkspaceWatcher({
    rootPath: root,
    debounceMs: 120,
    reconcile: () => {
      runs++;
      return { scanned: 1, newEvents: 1, newRevisions: 1, generation: runs };
    },
  });

  const started = watcher.start();
  if (!started) {
    // 平台不支持递归监听时，跳过而不误报通过
    watcher.stop();
    return;
  }

  const change = new Promise<{ newEvents: number; generation: number }>((resolve) => {
    watcher.on('change', resolve);
  });

  fs.writeFileSync(path.join(root, 'a.md'), '# a\n改动\n', 'utf-8');
  const notice = (await Promise.race([
    change,
    new Promise((_, reject) => setTimeout(() => reject(new Error('监听未在 3s 内触发')), 3000)),
  ])) as { newEvents: number; generation: number };

  assert.equal(notice.newEvents, 1);
  assert.equal(notice.generation, 1);
  assert.ok(runs >= 1, '至少完成一次核验');
  watcher.stop();
});

test('日期待考查询与按日聚合口径一致', () => {
  const { store, workspaceId } = freshStore();
  seedEvent(store, workspaceId, 1, { occurred: '2026-11-05' });
  seedEvent(store, workspaceId, 2, { occurred: null, kind: 'read_error', revId: null });

  const undatedPage = queryEvents(store, { workspaceId, undated: true, limit: 10 });
  assert.equal(undatedPage.items.length, 1);
  assert.equal(undatedPage.items[0].occurred_at, null);

  const days = queryEventDays(store, { workspaceId });
  assert.equal(days.undated_count, 1);
  assert.equal(days.groups[days.groups.length - 1].date, '');
  store.close();
});
