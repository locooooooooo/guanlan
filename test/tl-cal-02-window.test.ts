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

/**
 * WF1-P1 · 日历主轴窗口化（性能急救 1.1）
 *
 * 背景（ask 提供的实测）：3 份同内容 PDF 的 file_mtime 落在 2013-10-15，旧轴取
 * 「全体文档最早版本 ∪ 全体事件 ∪ 今天」的全局极值 → 2013-10-16~2026-11-12 共 4,776 天；
 * 每行 682 条周线 × 18 泳道 + 4,776 个刻度，SSR 实测 15,014 元素 / 1.86MB markup，
 * 右侧迷你日历 4,776 格里 4,750 格 0 事件（158 个月里 151 个整月空）。
 *
 * 本文件两层断言：
 * ① 纯函数 calendarWindow：4776 天输入 → 列数 ≤ 91，older 槽聚合其余全部（本文件最重要的一条）；
 * ② renderToString 结构断言：DOM 不随跨度增长（同一份数据 +4,686 个更早日，元素数不增）。
 *
 * 注：本轮按角色约束**未执行**测试命令（禁止运行 tsc/单测/构建），断言由静态核对 + 独立日期算术给出。
 *
 * CALFIX-01 改写登记（升级裁决 A 授权）：走查 T2 将组件默认窗口档 90→30，本文件两处
 * 锚定旧默认值的断言（原 :157-181「默认 90 天渲染计数」与 :222-236「默认选中 90 天档」）
 * 已按新口径改写；90 天档覆盖经 initialWindowDays 测试缝保留（不是删覆盖）。
 * 全量枚举结果见改写段前的注释——其余断言不锚定默认档，未改动。
 */

// ---------- 夹具 ----------

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
    observed_at: '2026-11-12T00:00:00Z', // 采集时间，事件定位禁用
    source_time: date,
    topic_lane: 'docs',
    headline: `样例事件 ${seq}`,
    detail: '',
    ...over,
  } as unknown as TimelineEvent;
}

/** 逐日枚举（本地日历日，跨月/跨年安全） */
function dayRange(start: string, end: string): string[] {
  const out: string[] = [];
  let cur: string | null = start;
  for (let guard = 0; cur !== null && cur <= end && guard < 20000; guard += 1) {
    out.push(cur);
    cur = shiftCalendarDay(cur, 1);
  }
  return out;
}

/** 元素数（开标签计数；SSR 串里每个元素恰好一个 `<tag`） */
function countElements(html: string): number {
  return (html.match(/<[a-zA-Z]/g) ?? []).length;
}

/** 4776 天脏跨度：2013-10-16 ~ 2026-11-12（与真实工作区实测跨度逐日一致） */
const DIRTY_SPAN = dayRange('2013-10-16', '2026-11-12');

// ---------- ① 纯函数：4776 天 → 窗口 ≤ 91 列 + 其余全部进 older 槽 ----------

test('WF1-P1 calendarWindow：4776 天跨度 → 列数 ≤ 91，older 槽聚合其余全部', () => {
  assert.equal(DIRTY_SPAN.length, 4776, '夹具跨度必须是实测的 4,776 天');

  const win = calendarWindow(DIRTY_SPAN, CALENDAR_WINDOW_DEFAULT);
  assert.equal(CALENDAR_WINDOW_DEFAULT, 90);
  assert.equal(win.windowDays.length, 90, '窗口 90 列（连续日历日）');
  assert.ok(win.windowDays.length + 1 <= 91, '窗口列 + 1 个历史槽 ≤ 91 列');
  assert.equal(win.start, '2026-08-15', '窗口首日 = 末日 - 89 天');
  assert.equal(win.end, '2026-11-12', '窗口末日 = 数据最后一天');

  // 窗口内实际有数据的日 = 最后 90 天
  assert.deepEqual(win.activeDays, DIRTY_SPAN.slice(-90));
  // older 槽 = 其余全部（按日期去重计数），首尾日期如实
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

  // 非法日期与重复值被清洗；只有 2 个数据日时窗口仍是 90 列（列 = 日历日，不是数据点）
  const sparse = calendarWindow(
    ['2026-11-10', '2026-11-10', '2026-11-12', 'not-a-date', '2026-13-45', ''],
    90
  );
  assert.equal(sparse.windowDays.length, 90, '数据稀疏不缩短窗口列数');
  assert.deepEqual(sparse.activeDays, ['2026-11-10', '2026-11-12']);
  assert.equal(sparse.olderSlot, null, '没有更早日期时不出现历史槽');

  // 跨度短于窗口时不产生 older 槽
  const short = calendarWindow(['2026-11-10', '2026-11-12'], 90);
  assert.equal(short.start, '2026-08-15');
  assert.equal(short.olderSlot, null);

  // 非法窗口天数按默认 90 处理
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

// ---------- ② 渲染层：DOM 不随全量跨度增长 ----------

// 【升级裁决 A 改写段】本文件锚定「组件默认 90 天」的断言全量枚举（动刀前 sweep）：
// · 原 :157-181（渲染计数按默认 90 写死）与 :222-236（默认选中 90 天档）→ 按新口径改写；
// · 「元素数不增长」（原 :183-203）是相对断言（historyCount-recentCount ≤ 20），两档默认下
//   都成立，未改；EVENTS 行测试（原 :205-220）夹具日期 2026-11-10/12 落在任何 ≥30 天窗口内，
//   未改；迷你月历/OlderSlotList 测试（:240 起）与主轴窗口档无关，未改；
// · 纯函数测试（:86-153）全部显式传 windowDays，不经过组件默认值，未改。

test('WF1-P1 渲染：默认 30 天档 → 每行周线 4 条、pill 只出窗口内 30 枚，2013 文档进历史槽（走查 T2 新口径）', () => {
  const files = DIRTY_SPAN.map((d) => file(d));
  const html = renderToString(
    createElement(CalendarBoardView, { files, events: [], onOpenDocument: () => {} })
  );

  // 期望值推导（与组件同一套算术，非估算）：
  // · 窗口首日 = 2026-11-12 - 29 = 2026-10-14（上方 calendarWindow 30 天档纯函数已断言 start）；
  // · 周线：2026-10-14 为周三（getDay=3，独立 node 实算），循环 i=(8-3)%7=5 步进 7
  //   → 每泳道 4 条 × 2 条泳道（1 文件夹行 + EVENTS 行）= 8 条；
  // · older 槽 = 4776 - 30 = 4746（与上方 30 天档纯函数断言同值）。
  const weekLines = (html.match(/data-cal-week/g) ?? []).length;
  assert.equal(weekLines, 8, '2 条泳道 × 4 条周线（30 天窗口）');

  assert.ok(html.includes('data-calendar-range="2026-10-14"'), '默认档轴首日 = 2026-10-14');
  // 只渲染窗口内的 30 枚 pill；2013 的文档一枚都不在轴上
  assert.equal((html.match(/data-slot-doc-pill/g) ?? []).length, 30);
  const dirtyFileId = files[0].file_id; // 2013-10-16
  assert.ok(
    !html.includes(`data-slot-doc-pill="${dirtyFileId}"`),
    '2013 脏日期文档不进主轴（归入历史/更早帽）'
  );

  // 历史槽：其余 4,746 份聚合到 1 个芯片
  assert.ok(html.includes('data-older-slot="all"'));
  assert.ok(html.includes('data-older-count="4746"'));
  assert.ok(html.includes('data-older-chip="docs"'), '行内历史槽芯片');
  // React SSR 会在文本与表达式之间插入 <!-- -->，剥离后再做逐字比对
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

  // 周线：1 个文件夹行 + EVENTS 行 = 2 条泳道 × 13 条（旧版每行 682 条）
  const weekLines = (html.match(/data-cal-week/g) ?? []).length;
  assert.equal(weekLines, 26, '2 条泳道 × 13 条周线（90 天窗口）');

  // 只渲染窗口内的 90 枚 pill；2013 的文档一枚都不在轴上
  assert.equal((html.match(/data-slot-doc-pill/g) ?? []).length, 90);
  const dirtyFileId = files[0].file_id; // 2013-10-16
  assert.ok(
    !html.includes(`data-slot-doc-pill="${dirtyFileId}"`),
    '2013 脏日期文档不进主轴（归入历史/更早帽）'
  );

  // 历史槽：全部 4,686 份聚合到 1 个芯片
  assert.ok(html.includes('data-older-slot="all"'));
  assert.ok(html.includes('data-older-count="4686"'));
  assert.ok(html.includes('data-older-chip="docs"'), '行内历史槽芯片');
  // React SSR 会在文本与表达式之间插入 <!-- -->，剥离后再做逐字比对
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
  // 仅仅多出「历史槽列 + 1 枚芯片 + 1 枚槽头 + 图例」这十来个节点
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
  // 默认档改为 30 天（走查 T2）：初始 aria-pressed 落在 30（SSR 会输出 aria-pressed="true"）
  assert.ok(/data-window-days="30"[^>]*aria-pressed="true"/.test(html) || /aria-pressed="true"[^>]*data-window-days="30"/.test(html));
  assert.ok(
    /data-window-days="90"[^>]*aria-pressed="false"/.test(html) || /aria-pressed="false"[^>]*data-window-days="90"/.test(html),
    '90 天档初始未选中'
  );

  // 90 天档仍可选中（保旧窗口路径覆盖而非删覆盖）：经 initialWindowDays 测试缝渲染 90 初值。
  // 注：node:test + react-dom/server 无 DOM，onClick 的 setWindowDays 一行接线无法在此
  // 真点击模拟（登记 deviations）；缝渲染证明 90 天档的选中态与渲染路径完好。
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

// ---------- ③ 右侧迷你日历：0 事件月份不渲染格子 ----------

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

  // 2013-10 有 31 格、2026-11 有 30 格（共 61 格，旧实现 4,776 格）
  const cells = (html.match(/data-density-cell="/g) ?? []).length;
  assert.equal(cells, 61);
  assert.ok(!html.includes('data-density-cell="2014-'), '0 事件月份一格都不渲染');
  assert.ok(!html.includes('data-density-cell="2026-10-'), '空月不渲染格子');

  // 空月不是悄悄消失，而是给出一行计数标记（剥离 React SSR 的 <!-- --> 后再逐字比对）
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

// ---------- ④ 历史槽清单：按日期分组、超 60 天显式标注 ----------

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
