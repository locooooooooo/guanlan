import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

import {
  CALENDAR_ROW_SCROLL_MARGIN,
  CALENDAR_STICKY_HEADER_H,
  CALENDAR_WINDOW_DEFAULT,
  CalendarBoardView,
  shiftCalendarDay,
  slotHeatDotTier,
} from '../src/components/CalendarBoardView';
import { CalendarSidePanels, latestActiveMonth } from '../src/components/CalendarSidePanels';
import type { FileRecord, TimelineEvent } from '../src/types/guanlan';



let seq = 0;
function file(date: string | null, folder = 'docs'): FileRecord {
  seq += 1;
  return {
    file_id: `f_calfix_${String(seq).padStart(4, '0')}`,
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
    event_id: `ev_calfix_${seq}`,
    kind: 'modified',
    file_id: `f_calfix_x${seq}`,
    revision_id: `r_${seq}`,
    observed_at: '2026-11-15T00:00:00Z',
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


test('表头压行渲染：表头显式 32px 且带锚点，行 scroll-margin-top=33 让出整条表头', () => {
  const files = [file('2026-11-10'), file('2026-11-11')];
  const html = renderToString(
    createElement(CalendarBoardView, { files, events: [], onOpenDocument: () => {} })
  );

  assert.equal(CALENDAR_STICKY_HEADER_H, 32, '表头内容高（实读结构：原由右列 h-8 隐式撑出）');
  assert.equal(CALENDAR_ROW_SCROLL_MARGIN, CALENDAR_STICKY_HEADER_H + 1);

  const headerTag = html.split('<div').find((seg) => seg.includes('data-cal-sticky-header'));
  assert.ok(headerTag, 'sticky 表头带 data-cal-sticky-header 锚点');
  assert.ok(headerTag.includes('height:32px'), '表头高度显式钉在常量上（不再由子节点 h-8 隐式计算）');

  const rowTags = html.split('<div').filter((seg) => seg.includes('data-cal-row='));
  const folderCount = new Set(files.map((f) => f.folder)).size;
  assert.equal(rowTags.length, folderCount + 1, '文件夹行 + 事件刻度行都有行锚点');
  for (const tag of rowTags) {
    assert.ok(
      tag.includes(`scroll-margin-top:${CALENDAR_ROW_SCROLL_MARGIN}px`),
      '每行 scroll-margin-top=33px：锚点滚动落点让出整条表头（首行不再被压掉一半）'
    );
  }
  assert.ok(
    rowTags.some((tag) => tag.includes('data-cal-row="__events__"')),
    '事件刻度行也在锚点覆盖内'
  );
});


test('窗口默认档渲染：默认选中「近 30 天」档，90 天降为可切换档', () => {
  const html = renderToString(
    createElement(CalendarBoardView, { files: [file('2026-11-10')], events: [], onOpenDocument: () => {} })
  );
  assert.ok(
    /data-window-days="30"[^>]*aria-pressed="true"/.test(html) ||
      /aria-pressed="true"[^>]*data-window-days="30"/.test(html),
    '初始档 = 近 30 天（走查 T2）'
  );
  assert.ok(
    /data-window-days="90"[^>]*aria-pressed="false"/.test(html) ||
      /aria-pressed="false"[^>]*data-window-days="90"/.test(html),
    '90 天档存在且未选中'
  );
  const text = html.replace(/<!-- -->/g, '');
  assert.ok(text.includes('近 30 天') && text.includes('近 90 天'), '两档按钮文案齐备');

  assert.ok(
    html.includes('data-calendar-range="2026-10-12"'),
    '默认档轴首日 = 数据末日 - 29 天（calendarWindow 纯函数同套算术）'
  );
});


test('热力点纯函数：slotHeatDotTier 分档边界（颜色深浅与直径映射份数）', () => {
  assert.deepEqual(slotHeatDotTier(4), { mixPct: 25, size: 8 }, '芯片起点 4 份 = 最低档');
  assert.deepEqual(slotHeatDotTier(9), { mixPct: 25, size: 8 });
  assert.deepEqual(slotHeatDotTier(10), { mixPct: 45, size: 10 });
  assert.deepEqual(slotHeatDotTier(29), { mixPct: 45, size: 10 });
  assert.deepEqual(slotHeatDotTier(30), { mixPct: 70, size: 12 });
  assert.deepEqual(slotHeatDotTier(99), { mixPct: 70, size: 12 });
  assert.deepEqual(slotHeatDotTier(100), { mixPct: 100, size: 14 });
  assert.deepEqual(slotHeatDotTier(152), { mixPct: 100, size: 14 }, '走查口径 +152');
  assert.deepEqual(slotHeatDotTier(274), { mixPct: 100, size: 14 }, '走查口径 +274');
  assert.deepEqual(slotHeatDotTier(496), { mixPct: 100, size: 14 }, '走查口径单日最多 496 份封顶档');
});

test('宽窗渲染：90 天档热力点替长文字芯片（数字进 Tooltip/aria），30 天档芯片原样', () => {
  const SLOT_A = '2026-11-01';
  const SLOT_B = '2026-11-05';
  const files = [
    ...Array.from({ length: 152 }, () => file(SLOT_A)),
    ...Array.from({ length: 274 }, () => file(SLOT_B)),
  ];

  const wide = renderToString(
    createElement(CalendarBoardView, {
      files,
      events: [],
      onOpenDocument: () => {},
      initialWindowDays: CALENDAR_WINDOW_DEFAULT,
    })
  );
  assert.ok(
    !wide.includes('>+152</button>') && !wide.includes('>+274</button>'),
    '90 天档不再渲染带长文字的宽圆圈'
  );
  assert.ok(wide.includes('data-slot-dot="152"') && wide.includes('data-slot-dot="274"'), '热力点锚点携带份数');
  assert.equal((wide.match(/width:14px/g) ?? []).length, 2, '两槽均 ≥100 份 → 直径 14px 档');
  assert.ok(
    wide.includes('color-mix(in srgb, var(--accent-iris) 100%, transparent)'),
    '颜色深浅由 --accent-iris 混色比例承载'
  );
  assert.ok(
    wide.includes('aria-label="2026-11-01 共 152 份 · 点击展开当日清单"'),
    '可访问名保留份数（芯片原本靠可见文字命名）'
  );
  assert.ok(
    wide.includes('title="2026-11-05 共 274 份 · 点击展开当日清单"'),
    '具体数字收进 hover Tooltip'
  );
  assert.ok(
    (wide.match(/data-slot-chip=/g) ?? []).length === 2,
    'data-slot-chip 槽锚点保留（点击展开当日清单的入口不变）'
  );

  const compact = renderToString(
    createElement(CalendarBoardView, { files, events: [], onOpenDocument: () => {} })
  );
  assert.ok(
    compact.includes('>+152</button>') && compact.includes('>+274</button>'),
    '30 天档「+N」文字芯片原样保留（tl-cal-01 写死口径不动）'
  );
  assert.ok(!compact.includes('data-slot-dot='), '30 天档不出热力点');
});


test('迷你月历纯函数：latestActiveMonth 取活跃日期集合的最大月份（严禁 2013-10 脏月）', () => {
  assert.equal(
    latestActiveMonth(['2013-10-15', '2013-10-15', '2026-11-06', '2026-11-07']),
    '2026-11',
    '默认定位 = 活跃日期集合的最大月份'
  );
  assert.equal(latestActiveMonth(['2026-11-23', '2013-10-16', '2020-05-01']), '2026-11', '输入不要求有序');
  assert.equal(latestActiveMonth([]), null, '空集合无默认月（上层不渲染月历）');
  assert.equal(latestActiveMonth(['not-a-date', '']), null, '非法输入跳过（防御）');
  assert.equal(latestActiveMonth(['2013-10-16']), '2013-10', '只有脏月时如实返回（月历本身仍按有事件月渲染）');
});

test('迷你月历渲染：降序渲染，默认定位并高亮最新活跃月，2013-10 沉底', () => {
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

  const idxNov = html.indexOf('data-density-month="2026-11"');
  const idxOld = html.indexOf('data-density-month="2013-10"');
  assert.ok(idxNov >= 0 && idxOld >= 0, '两个有事件月份都渲染（tl-cal-02 口径不破坏）');
  assert.ok(
    idxNov < idxOld,
    '渲染序新→旧：最新活跃月 2026-11 在列表头部（默认定位），2013-10 历史脏月沉底'
  );

  assert.ok(
    /data-density-month="2026-11"[^>]*data-density-focus="true"/.test(html),
    '最新活跃月带默认定位高亮锚点'
  );
  assert.ok(
    !/data-density-month="2013-10"[^>]*data-density-focus/.test(html),
    '2013-10 脏月不获高亮'
  );
  assert.equal((html.match(/>最新</g) ?? []).length, 1, '「最新」徽标只出现一次');
});

test('迷你月历折叠口径：>24 个有事件月时常驻最近 24 个，头部仍是最新活跃月', () => {
  const events: TimelineEvent[] = [];
  let y = 2024;
  let m = 6;
  for (let guard = 0; guard < 30; guard += 1) {
    events.push(ev(`${y}-${String(m).padStart(2, '0')}-05`));
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  assert.equal(events.length, 30);
  const html = renderToString(
    createElement(CalendarSidePanels, {
      files: [file('2026-11-10')],
      events,
      recentItems: [],
      onOpenDocument: () => {},
    })
  );

  const months = [...html.matchAll(/data-density-month="(\d{4}-\d{2})"/g)].map((mm) => mm[1]);
  assert.equal(months.length, 24, '未展开时常驻 24 个有事件月（DENSITY_MONTH_CAP 口径不变）');
  assert.equal(months[0], '2026-11', '折叠下头部仍是最新活跃月（默认定位不被折叠吞掉）');
  assert.equal(months[11], '2025-12', '降序排列（新→旧）');
  assert.ok(html.includes('data-density-expand="6"'), '折叠 6 个更早月');
  assert.ok(html.replace(/<!-- -->/g, '').includes('展开更早 6 个月'), '折叠按钮文案如实');
  assert.ok(
    /data-density-month="2026-11"[^>]*data-density-focus="true"/.test(html),
    '最新活跃月获默认定位高亮'
  );
});
