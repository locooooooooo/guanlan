import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

import {
  CALENDAR_WINDOW_DEFAULT,
  CALENDAR_WINDOW_SHORT,
  CalendarBoardView,
  OlderSlotList,
  calendarWindow,
  shiftCalendarDay,
} from '../src/components/CalendarBoardView';
import { CalendarSidePanels } from '../src/components/CalendarSidePanels';
import type { FileRecord, TimelineEvent } from '../src/types/guanlan';



let seq = 0;
function file(date: string | null, folder = 'docs'): FileRecord {
  seq += 1;
  return {
    file_id: `f_wf1p1_${String(seq).padStart(5, '0')}`,
    folder,
    title: `文档 ${seq}`,
    relative_path: `${folder}/doc-${seq}.md`,
    format: 'md',
    current_revision_id: `rev_${seq}`,
    coverage: 'full_text',
    revisions: date ? [{ revision_id: `rev_${seq}`, source_time: date }] : [],
  } as unknown as FileRecord;
}

function ev(date: string | null, over: Partial<TimelineEvent> = {}): TimelineEvent {
  seq += 1;
  return {
    event_id: `ev_wf1p1_${seq}`,
    kind: 'modified',
    file_id: `f_wf1p1_x${seq}`,
    revision_id: `r_${seq}`,
    observed_at: '2026-11-12T00:00:00Z',
    source_time: date,
    topic_lane: 'docs',
    headline: `样例事件 ${seq}`,
    detail: '',
    ...over,
  } as unknown as TimelineEvent;
}

function dayRange(start: string, end: string): string[] {
  const out: string[] = [];
  let cur: string | null = start;
  for (let guard = 0; cur !== null && cur <= end && guard < 20000; guard += 1) {
    out.push(cur);
    cur = shiftCalendarDay(cur, 1);
  }
  return out;
}

function countElements(html: string): number {
  return (html.match(/<[a-zA-Z]/g) ?? []).length;
}

const DIRTY_SPAN = dayRange('2013-10-16', '2026-11-12');


test('WF1-P1 calendarWindow：4776 天跨度 → 列数 ≤ 91，older 槽聚合其余全部', () => {
  assert.equal(DIRTY_SPAN.length, 4776, '夹具跨度必须是实测的 4,776 天');

  const win = calendarWindow(DIRTY_SPAN, CALENDAR_WINDOW_DEFAULT);
  assert.equal(CALENDAR_WINDOW_DEFAULT, 90);
  assert.equal(win.windowDays.length, 90, '窗口 90 列（连续日历日）');
  assert.ok(win.windowDays.length + 1 <= 91, '窗口列 + 1 个历史槽 ≤ 91 列');
  assert.equal(win.start, '2026-08-15', '窗口首日 = 末日 - 89 天');
  assert.equal(win.end, '2026-11-12', '窗口末日 = 数据最后一天');

  assert.deepEqual(win.activeDays, DIRTY_SPAN.slice(-90));
  assert.ok(win.olderSlot);
  assert.equal(win.olderSlot.count, 4686);
  assert.equal(win.olderSlot.minDate, '2013-10-16');
  assert.equal(win.olderSlot.maxDate, '2026-08-14');
  assert.equal(
    win.windowDays.length + win.olderSlot.count,
    DIRTY_SPAN.length,
    '窗口 + 历史槽 = 全量，一份日期都不丢'
  );
});

test('WF1-P1 calendarWindow：30 天窗口（可切换档）同样不丢日期', () => {
  const win = calendarWindow(DIRTY_SPAN, CALENDAR_WINDOW_SHORT);
  assert.equal(CALENDAR_WINDOW_SHORT, 30);
  assert.equal(win.windowDays.length, 30);
  assert.equal(win.start, '2026-10-14');
  assert.ok(win.olderSlot);
  assert.equal(win.olderSlot.count, 4746);
  assert.equal(win.windowDays.length + win.olderSlot.count, 4776);
});

test('WF1-P1 calendarWindow：空输入 / 非法值 / 重复乱序 / 短跨度 的边界', () => {
  const empty = calendarWindow([], 90);
  assert.deepEqual(empty, { windowDays: [], start: null, end: null, activeDays: [], olderSlot: null });
  assert.equal(empty.olderSlot, null);

  const sparse = calendarWindow(
    ['2026-11-10', '2026-11-10', '2026-11-12', 'not-a-date', '2026-13-45', ''],
    90
  );
  assert.equal(sparse.windowDays.length, 90, '数据稀疏不缩短窗口列数');
  assert.deepEqual(sparse.activeDays, ['2026-11-10', '2026-11-12']);
  assert.equal(sparse.olderSlot, null, '没有更早日期时不出现历史槽');

  const short = calendarWindow(['2026-11-10', '2026-11-12'], 90);
  assert.equal(short.start, '2026-08-15');
  assert.equal(short.olderSlot, null);

  const bogus = calendarWindow(['2026-11-12'], 0);
  assert.equal(bogus.windowDays.length, 1, '<1 的天数收敛为 1 天窗口');
});

test('WF1-P1 calendarWindow：endDate 早于数据末日时被忽略（不把未来日塞进历史槽）', () => {
  const ignoreEarlier = calendarWindow(['2026-11-12'], 30, '2026-10-01');
  assert.equal(ignoreEarlier.end, '2026-11-12');
  assert.equal(ignoreEarlier.olderSlot, null);

  const honorLater = calendarWindow(['2026-11-12'], 30, '2026-11-20');
  assert.equal(honorLater.end, '2026-11-20');
  assert.equal(honorLater.windowDays.length, 30);
  assert.equal(honorLater.start, '2026-10-22');
});



test('WF1-P1 渲染：默认 30 天档 → 每行周线 4 条、pill 只出窗口内 30 枚，2013 文档进历史槽（走查 T2 新口径）', () => {
  const files = DIRTY_SPAN.map((d) => file(d));
  const html = renderToString(
    createElement(CalendarBoardView, { files, events: [], onOpenDocument: () => {} })
  );

  const weekLines = (html.match(/data-cal-week/g) ?? []).length;
  assert.equal(weekLines, 8, '2 条泳道 × 4 条周线（30 天窗口）');

  assert.ok(html.includes('data-calendar-range="2026-10-14"'), '默认档轴首日 = 2026-10-14');
  assert.equal((html.match(/data-slot-doc-pill/g) ?? []).length, 30);
  const dirtyFileId = files[0].file_id;
  assert.ok(
    !html.includes(`data-slot-doc-pill="${dirtyFileId}"`),
    '2013 脏日期文档不进主轴（归入历史/更早帽）'
  );

  assert.ok(html.includes('data-older-slot="all"'));
  assert.ok(html.includes('data-older-count="4746"'));
  assert.ok(html.includes('data-older-chip="docs"'), '行内历史槽芯片');
  assert.ok(html.replace(/<!-- -->/g, '').includes('>+4746</span>'), '槽头显示聚合总数');
});

test('WF1-P1 渲染：90 天档（initialWindowDays 测试缝）→ 周线 26 条、pill 90 枚、历史槽 4686 份（旧口径覆盖保留）', () => {
  const files = DIRTY_SPAN.map((d) => file(d));
  const html = renderToString(
    createElement(CalendarBoardView, {
      files,
      events: [],
      onOpenDocument: () => {},
      initialWindowDays: CALENDAR_WINDOW_DEFAULT,
    })
  );

  const weekLines = (html.match(/data-cal-week/g) ?? []).length;
  assert.equal(weekLines, 26, '2 条泳道 × 13 条周线（90 天窗口）');

  assert.equal((html.match(/data-slot-doc-pill/g) ?? []).length, 90);
  const dirtyFileId = files[0].file_id;
  assert.ok(
    !html.includes(`data-slot-doc-pill="${dirtyFileId}"`),
    '2013 脏日期文档不进主轴（归入历史/更早帽）'
  );

  assert.ok(html.includes('data-older-slot="all"'));
  assert.ok(html.includes('data-older-count="4686"'));
  assert.ok(html.includes('data-older-chip="docs"'), '行内历史槽芯片');
  assert.ok(html.replace(/<!-- -->/g, '').includes('>+4686</span>'), '槽头显示聚合总数');
});

test('WF1-P1 渲染：同一份最近 90 天数据，多挂 4,686 个更早日，元素数不增长', () => {
  const recent = DIRTY_SPAN.slice(-90).map((d) => file(d, 'docs'));
  const withHistory = DIRTY_SPAN.map((d) => file(d, 'docs'));

  const htmlRecent = renderToString(
    createElement(CalendarBoardView, { files: recent, events: [], onOpenDocument: () => {} })
  );
  const htmlHistory = renderToString(
    createElement(CalendarBoardView, { files: withHistory, events: [], onOpenDocument: () => {} })
  );

  const recentCount = countElements(htmlRecent);
  const historyCount = countElements(htmlHistory);
  assert.ok(recentCount > 0);
  assert.ok(
    historyCount - recentCount <= 20,
    `多 4,686 天只多 ${historyCount - recentCount} 个节点（旧实现会多出 ≈13k 条周线）`
  );
  assert.ok(historyCount < 800, `4776 天输入的元素数 ${historyCount} 仍远低于旧版 15,014`);
});

test('WF1-P1 渲染：EVENTS 行按日聚合（同日 5 条 → 1 个刻度，title 保留全量明细）', () => {
  const files = [file('2026-11-10')];
  const events = [
    ev('2026-11-12'),
    ev('2026-11-12'),
    ev('2026-11-12'),
    ev('2026-11-12'),
    ev('2026-11-12'),
  ];
  const html = renderToString(
    createElement(CalendarBoardView, { files, events, onOpenDocument: () => {} })
  );
  assert.equal((html.match(/data-event-day=/g) ?? []).length, 1, '同日事件只出 1 个刻度');
  assert.ok(html.includes('data-event-count="5"'));
  assert.ok(html.includes('5 条事件'), 'title 带当日条数');
});

test('WF1-P1 渲染：窗口按钮两档齐备，默认选中 30 天档（走查 T2 新口径）且 90 天档仍可选中', () => {
  const html = renderToString(
    createElement(CalendarBoardView, {
      files: [file('2026-11-10')],
      events: [],
      onOpenDocument: () => {},
    })
  );
  assert.ok(html.includes('data-window-days="90"'));
  assert.ok(html.includes('data-window-days="30"'));
  const text = html.replace(/<!-- -->/g, '');
  assert.ok(text.includes('近 90 天') && text.includes('近 30 天'));
  assert.ok(/data-window-days="30"[^>]*aria-pressed="true"/.test(html) || /aria-pressed="true"[^>]*data-window-days="30"/.test(html));
  assert.ok(
    /data-window-days="90"[^>]*aria-pressed="false"/.test(html) || /aria-pressed="false"[^>]*data-window-days="90"/.test(html),
    '90 天档初始未选中'
  );

  const wide = renderToString(
    createElement(CalendarBoardView, {
      files: [file('2026-11-10')],
      events: [],
      onOpenDocument: () => {},
      initialWindowDays: CALENDAR_WINDOW_DEFAULT,
    })
  );
  assert.ok(/data-window-days="90"[^>]*aria-pressed="true"/.test(wide) || /aria-pressed="true"[^>]*data-window-days="90"/.test(wide));
  assert.ok(
    /data-window-days="30"[^>]*aria-pressed="false"/.test(wide) || /aria-pressed="false"[^>]*data-window-days="30"/.test(wide),
    '切到 90 天档后 30 天档未选中'
  );
});


test('WF1-P1 迷你日历：158 个月里只渲染 2 个有事件月，其余 156 个空月只留一行标记', () => {
  const events = [
    ev('2013-10-16'),
    ev('2013-10-16'),
    ev('2013-10-16'),
    ...dayRange('2026-11-01', '2026-11-23').map((d) => ev(d)),
  ];
  const html = renderToString(
    createElement(CalendarSidePanels, {
      files: [file('2026-11-10')],
      events,
      recentItems: [],
      onOpenDocument: () => {},
    })
  );

  const months = (html.match(/data-density-month="/g) ?? []).length;
  assert.equal(months, 2, '只渲染 2013-10 与 2026-11 两个有事件月份');
  assert.ok(html.includes('data-density-month="2013-10"'));
  assert.ok(html.includes('data-density-month="2026-11"'));

  const cells = (html.match(/data-density-cell="/g) ?? []).length;
  assert.equal(cells, 61);
  assert.ok(!html.includes('data-density-cell="2014-'), '0 事件月份一格都不渲染');
  assert.ok(!html.includes('data-density-cell="2026-10-'), '空月不渲染格子');

  const text = html.replace(/<!-- -->/g, '');
  assert.ok(html.includes('data-density-skipped="156"'), '跳过 156 个空月');
  assert.ok(text.includes('跳过 156 个空月'));
  assert.ok(text.includes('2013-11 ~ 2026-10'), '标记里给出被跳过月份的范围');
});

test('WF1-P1 迷你日历：无事件时退化为「暂无事件」且不渲染月份', () => {
  const html = renderToString(
    createElement(CalendarSidePanels, {
      files: [file('2026-11-10')],
      events: [],
      recentItems: [],
      onOpenDocument: () => {},
    })
  );
  assert.ok(html.includes('暂无事件'));
  assert.equal((html.match(/data-density-month="/g) ?? []).length, 0);
});


test('WF1-P1 OlderSlotList：按日期分组渲染（不一次平铺全部文档），超过 60 天显式标注', () => {
  const groups: [string, FileRecord[]][] = dayRange('2013-10-16', '2013-10-16')
    .concat(dayRange('2014-01-01', '2014-03-31'))
    .map((d) => [d, [file(d)]] as [string, FileRecord[]]);
  assert.equal(groups.length, 91, '夹具 91 个更早日期');

  const html = renderToString(
    createElement(OlderSlotList, {
      label: '历史/更早（全部）',
      groups,
      left: 300,
      top: 200,
      onPickDate: () => {},
      onClose: () => {},
    })
  );
  assert.equal((html.match(/data-older-day="/g) ?? []).length, 60, '最多渲染 60 个日期行');
  const text = html.replace(/<!-- -->/g, '');
  assert.ok(text.includes('另有 31 天未列出'), '被折叠的天数如实标注');
  assert.ok(text.includes('91 天 · 91 份'), '头部计数 = 全量');
});
