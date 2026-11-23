import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildVersionChain,
  computeSectionDiff,
  detectDateDisorder,
  formatObservedAt,
  listBaselineSections,
  resolvePrevNode,
} from './documentDiff';
import {
  eventCardStamp,
  eventFilterDay,
  formatLocalStamp,
  localDay,
} from './timeFormat';
import type { FileHistory, FileHistoryRevision } from '../services/workspaceClient';

function revision(over: Partial<FileHistoryRevision> & Pick<FileHistoryRevision, 'revision_id' | 'seq'>): FileHistoryRevision {
  return {
    prev_revision_id: null,
    content_hash: 'hash',
    size_bytes: 1024,
    observed_at: '2026-11-05T11:13:00+08:00',
    occurred_at: null,
    occurred_precision: 'second',
    occurred_source: null,
    snapshot_available: true,
    ...over,
  };
}

function historyOf(revisions: FileHistoryRevision[]): FileHistory {
  return {
    ok: true,
    file: {
      file_id: 'f1',
      current_path: 'closeout/PLAN.md',
      title: 'PLAN',
      format: 'md',
      role: '方案',
      status: 'active',
      first_observed_at: '2026-11-05T11:13:00+08:00',
      last_observed_at: '2026-11-07T02:53:00+08:00',
      last_revision_id: revisions.at(-1)?.revision_id ?? null,
    },
    revisions,
    events: [],
    statements: [],
    edges: [],
  };
}

test('computeSectionDiff：修改按行级 LCS 统计 +3/-1，未变章节与未变文档头部不出现', () => {
  const oldDoc = ['# P', '## 甲', 'A', 'B', '## 乙', 'C', 'D'].join('\n');
  const newDoc = ['# P', '## 甲', 'A', 'C', 'D', 'E', '## 乙', 'C', 'D'].join('\n');
  const changes = computeSectionDiff(oldDoc, newDoc);
  assert.equal(changes.length, 1);
  const change = changes[0]!;
  assert.equal(change.kind, '修改');
  assert.equal(change.title, '甲');
  assert.equal(change.added, 3);
  assert.equal(change.removed, 1);
  assert.equal(change.line, 2);
  assert.equal(change.end, 6);
  assert.ok(!changes.some((c) => c.title === '乙'), '未变章节绝不产出');
  assert.ok(!changes.some((c) => c.title === '文档头部'), '未变文档头部不产出');
});

test('computeSectionDiff：新增含标题行计入 added；整章删除章节名取旧版、行范围用旧版', () => {
  const oldDoc = ['# P', '## 甲', 'A', '## 乙', 'B'].join('\n');
  const newDoc = ['# P', '## 甲2', 'A', '## 乙', 'B', '## 丙', 'C'].join('\n');
  const changes = computeSectionDiff(oldDoc, newDoc);
  const renamed = changes.filter((c) => c.title === '甲' || c.title === '甲2');
  assert.deepEqual(renamed.map((c) => [c.kind, c.title]), [['删除', '甲'], ['新增', '甲2']]);
  const removed = changes.find((c) => c.kind === '删除')!;
  assert.equal(removed.line, 2);
  assert.equal(removed.end, 3);
  assert.equal(removed.removed, 2);
  const added = changes.find((c) => c.kind === '新增' && c.title === '丙')!;
  assert.equal(added.line, 6);
  assert.equal(added.end, 7);
  assert.equal(added.added, 2, '新增章节含标题行在内计入 added');
});

test('computeSectionDiff：首个标题前内容归虚拟章节「文档头部」参与 Diff 对齐', () => {
  const oldDoc = ['# P', '前言一', '## 甲', 'A'].join('\n');
  const newDoc = ['# P', '前言一', '前言二', '## 甲', 'A'].join('\n');
  const changes = computeSectionDiff(oldDoc, newDoc);
  assert.equal(changes.length, 1);
  const change = changes[0]!;
  assert.equal(change.title, '文档头部');
  assert.equal(change.kind, '修改');
  assert.equal(change.added, 1);
  assert.equal(change.removed, 0);
  assert.equal(change.line, 1);
});

test('buildVersionChain：主序 seq 降序（上新下旧）、prev 沿修订链相接、无父版即初始基线', () => {
  const chain = buildVersionChain(historyOf([
    revision({
      revision_id: 'r1', seq: 1, occurred_at: '2026-11-05',
      occurred_precision: 'day', occurred_source: 'document_self',
    }),
    revision({
      revision_id: 'r2', seq: 2, observed_at: '2026-11-06T18:20:00+08:00',
      occurred_at: '2026-11-06T18:20:00+08:00', occurred_source: 'document_self',
      prev_revision_id: 'r1', snapshot_available: false,
    }),
    revision({
      revision_id: 'r3', seq: 3, observed_at: '2026-11-07T02:53:00+08:00',
      occurred_at: '2026-11-07T02:53:00+08:00', occurred_source: 'document_self',
      prev_revision_id: 'r2',
    }),
  ]));
  assert.deepEqual(chain.map((node) => [node.label, node.observedAtLabel]),
    [['v3', '11-07 02:53'], ['v2', '11-06 18:20'], ['v1', '11-05']]);
  assert.equal(chain[0]!.anchorAt, '2026-11-07T02:53:00+08:00');
  assert.deepEqual(chain.map((node) => node.isBaseline), [false, false, true]);
  assert.equal(chain[0]!.snapshotAvailable, true);
  assert.equal(chain[1]!.snapshotAvailable, false);
  assert.deepEqual(chain.map((node) => node.prevRevisionId), ['r2', 'r1', null]);
  assert.equal(chain[2]!.precisionDay, true);
  assert.equal(chain[2]!.timeBasis, '文档自述');

  const tied = buildVersionChain(historyOf([
    revision({ revision_id: 'a', seq: 1, occurred_at: '2026-11-05T11:13:00+08:00' }),
    revision({ revision_id: 'b', seq: 2, occurred_at: '2026-11-05T11:13:00+08:00' }),
  ]));
  assert.deepEqual(tied.map((node) => node.revisionId), ['b', 'a'], '主序仍是 seq 降序（与锚点无关）');

  assert.deepEqual(buildVersionChain(historyOf([])).map((node) => node.label), []);
});

test('TA-01 逆序 fixture：occurred 日与 seq 相反时链仍为 v6→…→v1，prev 沿修订链、仅 v1 为基线', () => {
  // occurred 日随 seq 递减（材料日期"逆序"），模拟文档自述日期早于晚收录的版本
  const reversed = Array.from({ length: 6 }, (_, i) => {
    const seq = i + 1;
    const day = String(7 - seq).padStart(2, '0');
    return revision({
      revision_id: `r${seq}`,
      seq,
      occurred_at: `2026-11-${day}`,
      occurred_precision: 'day',
      occurred_source: 'document_self',
      prev_revision_id: seq > 1 ? `r${seq - 1}` : null,
    });
  });
  const chain = buildVersionChain(historyOf(reversed));
  assert.deepEqual(chain.map((node) => node.label), ['v6', 'v5', 'v4', 'v3', 'v2', 'v1']);
  assert.deepEqual(chain.map((node) => node.prevRevisionId), ['r5', 'r4', 'r3', 'r2', 'r1', null]);
  assert.deepEqual(
    chain.map((node) => chain.find((other) => other.revisionId === node.prevRevisionId)?.label ?? null),
    ['v5', 'v4', 'v3', 'v2', 'v1', null],
    'v6.prev=v5 … v2.prev=v1、v1.prev=null'
  );
  assert.deepEqual(chain.map((node) => node.isBaseline), [false, false, false, false, false, true]);
  assert.equal(detectDateDisorder(chain), true, '上方日期早于下方日期 → 口径矛盾');

  // 对照：seq 与 occurred 同序 → 不报矛盾
  const ordered = Array.from({ length: 6 }, (_, i) => {
    const seq = i + 1;
    return revision({
      revision_id: `r${seq}`,
      seq,
      occurred_at: `2026-11-${String(seq).padStart(2, '0')}`,
      occurred_precision: 'day',
      occurred_source: 'document_self',
      prev_revision_id: seq > 1 ? `r${seq - 1}` : null,
    });
  });
  assert.equal(detectDateDisorder(buildVersionChain(historyOf(ordered))), false);
});

test('TA-01 悬空 prev：prev_revision_id 不在集合时回退 seq 前驱，resolvePrevNode 不落 baseline', () => {
  const revs = Array.from({ length: 5 }, (_, i) => {
    const seq = i + 1;
    return revision({
      revision_id: `r${seq}`,
      seq,
      occurred_at: `2026-11-${String(seq).padStart(2, '0')}`,
      occurred_precision: 'day',
      occurred_source: 'document_self',
      prev_revision_id: seq === 5 ? 'r9' : seq > 1 ? `r${seq - 1}` : null,
    });
  });
  const chain = buildVersionChain(historyOf(revs));
  const r5 = chain.find((node) => node.revisionId === 'r5')!;
  assert.equal(r5.prevRevisionId, 'r4', '悬空父版回退 seq 前驱');
  assert.equal(r5.isBaseline, false, '悬空父版不得被误标初始基线');

  const prevNode = resolvePrevNode(chain, r5);
  assert.ok(prevNode, 'resolvePrevNode 必须给出父版，selView 不进入 baseline');
  assert.equal(prevNode!.revisionId, 'r4');
  assert.equal(resolvePrevNode(chain, chain[chain.length - 1]!), null, '链首（v1）无父版');
});

test('formatObservedAt：含时刻取本地 MM-DD HH:mm；纯日期取 MM-DD（是否仅日期由 precisionDay 判定）', () => {
  assert.equal(formatObservedAt('2026-11-07T02:53:00+08:00'), '11-07 02:53');
  assert.equal(formatObservedAt('2026-11-05'), '11-05');
  assert.equal(formatObservedAt('2026-11-05').includes(' '), false, '纯日期不得产生尾空格');
});

test('listBaselineSections：文档头部与顶层章节均入清单并带行范围', () => {
  const sections = listBaselineSections(['# P', '前言', '## 甲', 'A', '## 乙', 'B'].join('\n'));
  assert.deepEqual(sections.map((s) => [s.title, s.line, s.end]),
    [['文档头部', 1, 2], ['甲', 3, 4], ['乙', 5, 6]]);
});

// ---------- TA-03 时间口径统一 ----------

test('timeFormat.formatLocalStamp：含时刻按本地时区输出 MM-DD HH:mm，纯日期取 MM-DD 且无尾空格', () => {
  assert.equal(formatLocalStamp('2026-11-09T01:30:00.000Z', 'Asia/Shanghai'), '11-09 09:30');
  assert.equal(formatLocalStamp('2026-11-02'), '11-02');
  assert.equal(formatLocalStamp('2026-11-02').includes(' '), false, '纯日期绝不允许尾空格');
  assert.equal(formatLocalStamp('2026-11-02T00:30:00+08:00', 'Asia/Shanghai'), '11-02 00:30');
});

test('timeFormat.localDay：含时刻按本地日历日，纯日期原样（不参与时区换算）', () => {
  assert.equal(localDay('2026-11-02T20:00:00.000Z', 'Asia/Shanghai'), '2026-11-03');
  assert.equal(localDay('2026-11-02'), '2026-11-02');
});

test('eventCardStamp：occurred 口径取 occurred 并标三值依据，缺失回退采集，observed 口径恒采集', () => {
  const observedAt = '2026-11-02T10:00:00.000Z';
  const self = eventCardStamp(
    {
      observed_at: observedAt,
      source_time: '2026-11-05T09:00:00+08:00',
      occurred_source: 'document_self',
      occurred_precision: 'second',
    },
    'occurred'
  );
  assert.equal(self.stamp, formatLocalStamp('2026-11-05T09:00:00+08:00'));
  assert.equal(self.raw, '2026-11-05T09:00:00+08:00');
  assert.equal(self.basis, '文档自述');
  assert.equal(self.fromOccurred, true);
  assert.equal(self.dayOnly, false);

  const mtime = eventCardStamp(
    { observed_at: observedAt, source_time: '2026-11-05', occurred_source: 'file_mtime' },
    'occurred'
  );
  assert.equal(mtime.basis, '文件时间');

  const missingOccurred = eventCardStamp({ observed_at: observedAt }, 'occurred');
  assert.equal(missingOccurred.raw, observedAt, 'occurred 缺失时卡片显示 observed');
  assert.equal(missingOccurred.basis, '采集');
  assert.equal(missingOccurred.fromOccurred, false);

  const observedOrder = eventCardStamp(
    { observed_at: observedAt, source_time: '2026-11-05', occurred_source: 'document_self' },
    'observed'
  );
  assert.equal(observedOrder.raw, observedAt);
  assert.equal(observedOrder.basis, '采集');
  assert.equal(observedOrder.stamp, formatLocalStamp(observedAt));
});

test('eventCardStamp：occurred_precision=day 只输出日期，并标记「仅日期」', () => {
  const day = eventCardStamp(
    {
      observed_at: '2026-11-06T10:00:00.000Z',
      source_time: '2026-11-05',
      occurred_source: 'document_self',
      occurred_precision: 'day',
    },
    'occurred'
  );
  assert.equal(day.stamp, '11-05');
  assert.equal(day.dayOnly, true);
  assert.equal(day.day, '2026-11-05');
});

test('离线兜底：日期筛选随 eventOrder 单口径（occurred→发生日、observed→观察日）', () => {
  const filter = '2026-11-02';
  // 观察在 11-02、材料记载 11-05：occurred 口径必须按 11-05 归属，不能被观察日“捞回”
  const crossed = {
    observed_at: '2026-11-02T10:00:00+08:00',
    source_time: '2026-11-05',
    occurred_precision: 'day',
    occurred_source: 'document_self',
  };
  // 观察在 11-05、材料记载 11-02：observed 口径必须按 11-05 归属
  const mirrored = {
    observed_at: '2026-11-05T10:00:00+08:00',
    source_time: '2026-11-02',
    occurred_precision: 'day',
    occurred_source: 'document_self',
  };

  assert.equal(eventFilterDay(crossed, 'occurred'), '2026-11-05');
  assert.notEqual(eventFilterDay(crossed, 'occurred'), filter, 'observed=11-02 / occurred=11-05 不得命中 11-02');

  const same = {
    observed_at: '2026-11-02T10:00:00+08:00',
    source_time: '2026-11-02',
    occurred_precision: 'day',
    occurred_source: 'document_self',
  };
  assert.equal(eventFilterDay(same, 'occurred'), filter, 'occurred=11-02 的事件保留');
  assert.equal(eventCardStamp(same, 'occurred').day, filter, '卡片日期与筛选日一致');

  assert.equal(eventFilterDay(crossed, 'observed'), filter, 'observed 口径按观察日命中');
  assert.equal(eventFilterDay(mirrored, 'observed'), '2026-11-05');
  assert.notEqual(eventFilterDay(mirrored, 'observed'), filter, 'observed=11-05 不得命中 11-02');
});

// occurred 口径下事件没有 occurred_at（日期待考）时不归属任何具体日，避免被采集日“补位”
test('离线兜底：occurred 口径下日期待考事件不落入任何具体日筛选', () => {
  const undated = { observed_at: '2026-11-02T10:00:00+08:00' };
  assert.equal(eventFilterDay(undated, 'occurred'), null);
  assert.equal(eventFilterDay(undated, 'observed'), '2026-11-02');
});
