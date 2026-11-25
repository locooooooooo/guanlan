import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CALENDAR_EVENT_PAGE_LIMIT,
  CALENDAR_EVENT_WINDOW_DAYS,
  calendarWindowEventQuery,
} from '../src/utils/calendarEventWindow';

/**
 * 日历事件取数窗口：
 *
 * 背景：进入日历曾沿事件游标自动续拉到没有下一页。5.6 万文件的工作区里那是
 * 数千次请求，每页都并进累计事件表并重渲整棵树。现在只取最近 90 天的一页
 * （≤200 条）；更早历史由列表态的「加载更多」显式触发。
 */

function readSrc(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), 'utf8');
}

test('日历窗口恰好覆盖 90 个本地日，只取一页', () => {
  const q = calendarWindowEventQuery(new Date(2026, 10, 25)); // 2026-11-25（本地）
  assert.equal(q.to, '2026-11-25');
  assert.equal(q.from, '2026-08-28', '含首尾共 90 天');
  assert.equal(q.limit, CALENDAR_EVENT_PAGE_LIMIT);
  assert.ok(q.limit <= 200, '单页上限不超过服务端单页上限');
  assert.equal(q.order, 'occurred');
  assert.equal(q.undated, false);

  const days =
    (Date.parse(`${q.to}T00:00:00`) - Date.parse(`${q.from}T00:00:00`)) / 86_400_000 + 1;
  assert.equal(days, CALENDAR_EVENT_WINDOW_DAYS);
});

test('自定义窗口长度含首尾，非正长度收敛为单日', () => {
  const single = calendarWindowEventQuery(new Date(2026, 0, 1), 1);
  assert.equal(single.from, single.to);
  assert.equal(single.from, '2026-01-01');

  const zero = calendarWindowEventQuery(new Date(2026, 0, 1), 0);
  assert.equal(zero.from, zero.to, '窗口长度不得为 0 或负数');
});

test('工作区 Store 不再沿游标排空历史，只发一次窗口内的取数', () => {
  const src = readSrc('stores/useWorkspaceStore.tsx');
  assert.ok(
    src.includes('calendarWindowEventQuery(new Date())'),
    '进入日历应发一次窗口内的取数'
  );
  assert.ok(
    !src.includes('calendarAutoFill'),
    '进入日历不得再自动续拉到取尽（会灌满累计事件表）'
  );
});
