import assert from 'node:assert/strict';
import { test } from 'node:test';

// 1.3：列表「同文件同日多版本」折叠（纯函数口径）
import {
  VERSION_HISTORY_KINDS,
  foldSameFileDayVersions,
  versionFoldCardTitle,
  versionFoldRangeLabel,
} from '../src/utils/graphEvents';
import type { SameFileDayVersionItem } from '../src/utils/graphEvents';

/** 造一条事件：默认 PLAN.md 的 modified，同日 2026-11-12，版本从 20 递减到 1 */
function item(over: Partial<SameFileDayVersionItem> = {}): SameFileDayVersionItem {
  return {
    eventId: 'evt_1',
    fileId: 'file_plan',
    kind: 'modified',
    day: '2026-11-12',
    versionNumber: 1,
    ...over,
  };
}

/** 20 次演进（服务端上新下旧：v20 在最前） */
function planDay(versions: number[], over: Partial<SameFileDayVersionItem> = {}) {
  return versions.map((v, i) =>
    item({ eventId: `evt_v${v}`, versionNumber: v, ...over })
  );
}

test('1.3 同文件同日 20 个版本 → 1 组主卡（v1 → v20 · 今日共 20 次演进）', () => {
  const versions = Array.from({ length: 20 }, (_, i) => 20 - i); // 20,19,…,1
  const items = planDay(versions);
  const { groups, indexToGroup } = foldSameFileDayVersions(items);

  assert.equal(groups.length, 1, '20 行必须折成 1 组');
  const g = groups[0];
  assert.equal(g.count, 20);
  assert.equal(g.versionMin, 1);
  assert.equal(g.versionMax, 20);
  assert.deepEqual(g.indices, versions.map((_, i) => i), '成员顺序保持入参（上新下旧）');
  assert.equal(indexToGroup.size, 20, '20 个下标全部指向该组');

  assert.equal(versionFoldRangeLabel(g), 'v1 → v20 · 今日共 20 次演进');
  assert.equal(
    versionFoldCardTitle('PLAN', g),
    'PLAN 检测到连续更新 (v1 → v20 · 今日共 20 次演进)'
  );
});

test('1.3 单条事件不成组（旧逐行渲染路径逐字不变）', () => {
  const { groups, indexToGroup } = foldSameFileDayVersions([item({ versionNumber: 3 })]);
  assert.equal(groups.length, 0);
  assert.equal(indexToGroup.size, 0);
});

test('1.3 不同文件 / 不同天 / 决策类事件都不折叠', () => {
  const crossFile = foldSameFileDayVersions([
    item({ eventId: 'a', fileId: 'f1', versionNumber: 1 }),
    item({ eventId: 'b', fileId: 'f2', versionNumber: 2 }),
  ]);
  assert.equal(crossFile.groups.length, 0, '不同文件不合并');

  const crossDay = foldSameFileDayVersions([
    item({ eventId: 'a', day: '2026-11-12', versionNumber: 1 }),
    item({ eventId: 'b', day: '2026-11-11', versionNumber: 2 }),
  ]);
  assert.equal(crossDay.groups.length, 0, '不同天不合并（今日共 N 次演进的口径是自然日）');

  const decision = foldSameFileDayVersions([
    item({ eventId: 'a', kind: 'decision_changed', versionNumber: null }),
    item({ eventId: 'b', kind: 'decision_raised', versionNumber: null }),
  ]);
  assert.equal(decision.groups.length, 0, '决策事件语义不同，不折成版本历史');

  assert.deepEqual([...VERSION_HISTORY_KINDS], ['appeared', 'modified']);
});

test('1.3 日期待考（day 为空）与批内事件（day 传空）不参与折叠', () => {
  const undated = foldSameFileDayVersions([
    item({ eventId: 'a', day: '', versionNumber: 1 }),
    item({ eventId: 'b', day: '', versionNumber: 2 }),
  ]);
  assert.equal(undated.groups.length, 0);
});

test('1.3 版本号缺失时只报次数，不猜版本（宁缺勿假）', () => {
  const { groups } = foldSameFileDayVersions([
    item({ eventId: 'a', versionNumber: null }),
    item({ eventId: 'b', versionNumber: null }),
    item({ eventId: 'c', versionNumber: null }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].versionMin, null);
  assert.equal(groups[0].versionMax, null);
  assert.equal(versionFoldRangeLabel(groups[0]), '今日共 3 次演进');
  assert.equal(
    versionFoldCardTitle('PLAN', groups[0]),
    'PLAN 检测到连续更新 (今日共 3 次演进)'
  );
});

test('1.3 多组成组时按首个成员下标排序（落位 = 最新一次演进的既有位置）', () => {
  const items = [
    item({ eventId: 'a1', fileId: 'f1', versionNumber: 2 }),
    item({ eventId: 'b1', fileId: 'f2', versionNumber: 2 }),
    item({ eventId: 'a2', fileId: 'f1', versionNumber: 1 }),
    item({ eventId: 'b2', fileId: 'f2', versionNumber: 1 }),
  ];
  const { groups } = foldSameFileDayVersions(items);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].fileId, 'f1');
  assert.deepEqual(groups[0].indices, [0, 2]);
  assert.equal(groups[1].fileId, 'f2');
  assert.deepEqual(groups[1].indices, [1, 3]);
  assert.deepEqual(groups[0].eventIds, ['a1', 'a2']);
});
