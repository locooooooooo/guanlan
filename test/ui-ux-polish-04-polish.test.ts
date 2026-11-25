import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import HomeView, {
  HOME_TREND_BAR_LIMIT,
  buildChronosTodaySummary,
  buildHomeTrendBars,
  chronosBadgeLine,
  chronosOrderLabel,
  isExactDayDate,
  latestJumpableTrendDate,
} from '../src/components/HomeView';
import FeaturedFocusCards from '../src/components/FeaturedFocusCards';
import type { FeaturedDecisionItem } from '../src/components/FeaturedFocusCards';
import type { EventDayGroup, EventDaysResult } from '../src/services/workspaceClient';
import { localDay } from '../src/utils/timeFormat';
import { AppBanners } from '../src/components/app/AppBanners';
import GlassSkeleton, {
  ChronosEmptyState,
  ChronosLineArt,
  skeletonLineWidths,
} from '../src/components/ui/GlassSkeleton';
import ReadingIsland, {
  IslandRing,
  ReadingIslandPanel,
  islandRingDashOffset,
} from '../src/components/ReadingIsland';
import { TopHeader } from '../src/components/TopHeader';
import { EMPTY_WORKSPACE_CONFIG } from '../src/stores/useWorkspaceStore';
import type { WorkspaceStoreCtx } from '../src/stores/useWorkspaceStore';
import type { FileRecord, ReadingState, WorkspaceConfig } from '../src/types/guanlan';
import { computeReadingIslandStats } from '../src/utils/readingIslandStats';

/**
 * 今日观澜首页「司辰今日徽记」与事件走势柱图交互直跳。
 *
 * ① 柱模型纯函数：'' 日期待考桶恒排除、升序取最近 24 桶、只有 day 粒度 + 精确
 *    YYYY-MM-DD 桶可作直跳载荷（week/month 聚合桶诚实禁跳）、count 负值/NaN 钳 0；
 * ② 司辰徽记纯函数：今日新增/演进真实拆分（新增分类与 computeTrunkAccumulation
 *    同一语义出处：appeared/discovered/workspace_baseline）、未命中日诚实降级、
 *    occurred/observed 口径透传绝不混写；
 * ③ SSR 徽记：真实派生摘要渲染、口径显式声明、缺今日桶不出编造数字、绝不复读
 *    meta 胶囊的资产/项目/待拍板统计（信息降密 + 首页不堆统计大数字）；
 * ④ SSR 柱图：day 粒度全柱 button 化（data-home-trend-bar 承载精确 YYYY-MM-DD）、
 *    悬停浮窗「点击前往该日」、近 24 桶截断、聚合桶零按钮零日历直跳；
 * ⑤ 接线（源码级）：柱图/徽记点击精确透传日期；AppMainViews 直跳走 setActiveDate
 *    锁定语义（绝不走「再点同值即清空」的 handleSelectCanvasDate toggle）；日历落点
 *    同步右侧聚焦卡；日历侧既有直跳契约原样保留；
 * ⑥ 交错入场节奏：首页区块 --glx-stagger 唯一递进（0,2,3,4,5，无并列重叠拍）；
 * ⑦ 动效契约：两文件引用的 glx-* 类全部「声明 + reduce 降级」双登记（本轮零新增
 *    动效类）；柱生长只有 glx-bar-rise 的 scaleY，柱高保持 inline 视觉量非动画量；
 *    徽记轻摇走 motion-safe 门控的组件侧变换（不进共享动效层）；
 * ⑧ 令牌纪律：徽记文字 AA 深档（--ink-soft/--ink-strong，--ink-faint 与
 *    --accent-iris 裸值零入）；五段轨底轨收编 --glass-hairline；零 will-change；
 *    首页数据区禁飞类零引用；
 * ⑨ 橱窗微光：MiniDecisionCard 接入既有 glx-sheen-card 与箭头 hover 点亮；
 *    既有签名与 data-feature-card/count 既有锚点零回退。
 */

/** 读 src/ 下源文件（相对 test/ 目录，须带 ../src/ 前缀） */
function readSrc(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), 'utf8');
}

const noop = (): void => {};

function dayGroup(date: string, count: number, byKind: Record<string, number> = {}): EventDayGroup {
  return { date, count, by_kind: byKind, formats: {}, decisions: [], samples: [] };
}

function daysResult(
  granularity: EventDaysResult['granularity'],
  groups: EventDayGroup[],
  order: EventDaysResult['order'] = 'occurred'
): EventDaysResult {
  return {
    ok: true,
    index_generation: 1,
    order,
    granularity,
    from: null,
    to: null,
    groups,
    total: groups.reduce((acc, g) => acc + g.count, 0),
    hidden_days: 0,
    undated_count: 0,
  };
}

/** 本地日历日字符串（相对今天偏移 N 天，YYYY-MM-DD，与 lastSevenDays 同一套本地拼接） */
function localDayStr(offsetFromToday: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetFromToday);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

/** 今日本地日历日（与 HomeView 内 today 同一口径：localDay(ISO) 不引 UTC 日界） */
const TODAY = localDay(new Date().toISOString());
assert.equal(TODAY, localDayStr(0), '测试时钟与 localDay 口径一致（无 UTC 漂移）');

function renderHome(
  eventDays: EventDaysResult | null,
  overrides: Record<string, unknown> = {}
): string {
  return renderToStaticMarkup(
    createElement(HomeView, {
      files: [],
      readingStates: {},
      events: [],
      summary: null,
      eventDays,
      recentItems: [],
      onOpenDoc: noop,
      onResumeReading: noop,
      onMarkFullyRead: noop,
      onOpenPackageBoard: noop,
      onOpenPanorama: noop,
      ...overrides,
    })
  );
}

// ───────────────────────── ① 柱模型纯函数 ─────────────────────────

test('柱模型纯函数：日期待考桶排除、升序取最近 24 桶、day 粒度才可直跳、count 钳 0', () => {
  // 25 个历史 day 桶（-25..-1）+ 今日峰值桶 = 26 组 → 只留最近 24 桶
  const groups: EventDayGroup[] = [];
  for (let i = 0; i < 25; i += 1) groups.push(dayGroup(localDayStr(i - 25), i + 1));
  groups.push(dayGroup(TODAY, 30));
  groups.push(dayGroup('', 99)); // 日期待考桶混入：恒排除（既有契约，不进图）

  const dayBars = buildHomeTrendBars(daysResult('day', groups));
  assert.equal(dayBars.length, HOME_TREND_BAR_LIMIT, '近 24 桶截断');
  assert.equal(dayBars.some((b) => b.date === ''), false, '日期待考桶不进图');
  assert.equal(dayBars[0].date, localDayStr(-23), '升序且截掉最旧两桶');
  assert.equal(dayBars[dayBars.length - 1].date, TODAY, '最新桶=今天');
  assert.ok(dayBars.every((b) => b.jumpable && isExactDayDate(b.date)), 'day 粒度全柱可直跳');
  assert.equal(dayBars[dayBars.length - 1].count, 30, 'count 真实透传');
  assert.ok(
    dayBars.every((b, i) => i === 0 || dayBars[i - 1].date < b.date),
    '严格升序（上新下旧阅读方向）'
  );

  // week / month 聚合桶：日期键即便形如 YYYY-MM-DD 也不可作直跳载荷（apiTypes 契约：
  // 只有 day 粒度能定位到某日）
  for (const granularity of ['week', 'month'] as const) {
    const bars = buildHomeTrendBars(daysResult(granularity, groups));
    assert.equal(bars.length, HOME_TREND_BAR_LIMIT, `${granularity} 桶照常进图`);
    assert.ok(bars.every((b) => !b.jumpable), `${granularity} 聚合桶诚实禁跳`);
  }

  // count 负值 / NaN 钳 0（诚实下界，不炸不造负柱）
  const clamped = buildHomeTrendBars(
    daysResult('day', [dayGroup('2026-11-01', -5), dayGroup('2026-11-02', Number.NaN)])
  );
  assert.deepEqual(clamped.map((b) => b.count), [0, 0]);

  // null / 空 groups：诚实空数组
  assert.deepEqual(buildHomeTrendBars(null), []);
  assert.deepEqual(buildHomeTrendBars(daysResult('day', [])), []);
});

test('精确日校验纯函数：伪日期/未补零/空串拒绝，闰年真实历法放行', () => {
  assert.equal(isExactDayDate('2026-11-23'), true);
  assert.equal(isExactDayDate('2024-02-29'), true, '闰日放行');
  assert.equal(isExactDayDate('2026-02-29'), false, '平年伪日期拒绝');
  assert.equal(isExactDayDate('2026-02-30'), false, '2 月 30 日拒绝');
  assert.equal(isExactDayDate('2026-13-01'), false, '13 月拒绝');
  assert.equal(isExactDayDate('2026-00-10'), false, '0 月拒绝');
  assert.equal(isExactDayDate('2026-11-00'), false, '0 日拒绝');
  assert.equal(isExactDayDate('2026-2-03'), false, '未补零拒绝');
  assert.equal(isExactDayDate('20261123'), false);
  assert.equal(isExactDayDate('abcd-ef-gh'), false);
  assert.equal(isExactDayDate(''), false, '日期待考恒不可直跳');
  assert.equal(isExactDayDate('2026-11-23 '), false, '尾随空白拒绝');
});

// ───────────────────── ② 司辰徽记纯函数 ─────────────────────

test('徽记摘要纯函数：新增/演进真实拆分（与时光沉淀引擎同分类）、未命中诚实降级、口径透传', () => {
  // appeared2 + discovered1 + workspace_baseline1 = 新增 4；revision_updated3 = 演进 3
  const found = buildChronosTodaySummary(
    daysResult(
      'day',
      [dayGroup(TODAY, 7, { appeared: 2, discovered: 1, workspace_baseline: 1, revision_updated: 3 })],
      'occurred'
    ),
    TODAY
  );
  assert.equal(found.found, true);
  assert.equal(found.dayCount, 7);
  assert.equal(found.addedCount, 4);
  assert.equal(found.modifiedCount, 3);
  assert.equal(found.order, 'occurred');
  assert.equal(chronosBadgeLine(found), '今日新增 4 · 演进 3');
  assert.equal(chronosOrderLabel('occurred'), '业务发生');

  // observed 口径透传（徽记显式声明「系统采集」，双口径绝不混写）
  const observed = buildChronosTodaySummary(
    daysResult('day', [dayGroup(TODAY, 2, { appeared: 2 })], 'observed'),
    TODAY
  );
  assert.equal(observed.order, 'observed');
  assert.equal(chronosOrderLabel(observed.order), '系统采集');

  // clamp：新增类计数超过桶 count 时 added ≤ dayCount，演进归 0
  const clamped = buildChronosTodaySummary(daysResult('day', [dayGroup(TODAY, 5, { appeared: 9 })]), TODAY);
  assert.equal(clamped.addedCount, 5);
  assert.equal(clamped.modifiedCount, 0);

  // by_kind 缺失 → added 0 / 全量记演进（兜底不炸、不造新增数）
  const bare = buildChronosTodaySummary(daysResult('day', [dayGroup(TODAY, 6)]), TODAY);
  assert.equal(bare.addedCount, 0);
  assert.equal(bare.modifiedCount, 6);

  // 零事件日：found 但诚实零文案
  const zeroDay = buildChronosTodaySummary(daysResult('day', [dayGroup(TODAY, 0)]), TODAY);
  assert.equal(zeroDay.found, true);
  assert.equal(chronosBadgeLine(zeroDay), '今日暂无新动态');

  // 无今日桶 / 非日粒度 / null：诚实降级，绝不显示编造的新增/演进
  for (const miss of [
    buildChronosTodaySummary(daysResult('day', [dayGroup('2026-01-01', 3)]), TODAY),
    buildChronosTodaySummary(daysResult('week', [dayGroup(TODAY, 9, { appeared: 9 })]), TODAY),
    buildChronosTodaySummary(daysResult('month', []), TODAY),
    buildChronosTodaySummary(null, TODAY),
  ]) {
    assert.equal(miss.found, false);
    assert.equal(miss.addedCount, 0);
    assert.equal(miss.modifiedCount, 0);
    assert.equal(chronosBadgeLine(miss), '今日暂无新动态');
  }
  assert.equal(buildChronosTodaySummary(null, TODAY).order, null);
  assert.equal(chronosOrderLabel(null), '');
});

test('日历次级落点纯函数：最近一个有事件的直跳日；聚合桶/全零/空集诚实回 null', () => {
  const bars = [
    { date: '2026-11-01', count: 3, jumpable: true },
    { date: '2026-11-02', count: 0, jumpable: true },
    { date: '2026-11-03', count: 5, jumpable: false },
    { date: '2026-11-04', count: 2, jumpable: true },
  ];
  assert.equal(latestJumpableTrendDate(bars), '2026-11-04', '取最近可跳且有事件的日');
  assert.equal(
    latestJumpableTrendDate([
      { date: '2026-11-01', count: 4, jumpable: false },
      { date: '2026-11-02', count: 6, jumpable: false },
    ]),
    null,
    '只有聚合桶时不落点'
  );
  assert.equal(latestJumpableTrendDate([{ date: '2026-11-01', count: 0, jumpable: true }]), null);
  assert.equal(latestJumpableTrendDate([]), null);
});

// ───────────────── ③ SSR：司辰今日徽记 ─────────────────

test('SSR 徽记：真实派生摘要 + 口径显式声明 + 直跳目的地；缺今日桶诚实降级；绝不复读 meta 统计', () => {
  const html = renderHome(
    daysResult('day', [dayGroup(TODAY, 3, { appeared: 2, revision_updated: 1 })], 'occurred')
  );
  assert.ok(html.includes('data-chronos-badge="today"'), '徽记锚点 today 态');
  assert.ok(html.includes('data-chronos-order="occurred"'), '口径随渲染透出');
  assert.ok(html.includes('今日新增 2 · 演进 1'), '摘要文案逐字');
  assert.ok(html.includes('（按业务发生口径统计）'), 'aria 口径声明');
  assert.ok(html.includes('点击前往全景星图今日切片'), '直飞目的地声明');
  assert.ok(html.includes('motion-safe:hover:-rotate-2'), '悬停轻摇（motion-safe 门控）');
  assert.ok(html.includes('tabular-nums'), '摘要数字等宽唯一出口');

  // 未命中：day 粒度但无今日桶 → idle 诚实降级，不伪造计数
  const idle = renderHome(daysResult('day', [dayGroup('2026-01-01', 3)]));
  assert.ok(idle.includes('data-chronos-badge="idle"'), '降级态锚点');
  assert.ok(idle.includes('今日暂无新动态'), '诚实降级文案');
  assert.ok(!idle.includes('今日新增'), '降级态零编造的新增数字');
  assert.ok(!idle.includes('演进 '), '降级态零编造的演进数字');

  // 徽记与 meta 胶囊分工：徽记段绝不重复资产/项目/待拍板统计（信息降密红线）
  const badgeChunk = html.slice(html.indexOf('data-chronos-badge'));
  assert.ok(!badgeChunk.includes('份资产'), '徽记不重复资产计数');
  assert.ok(!badgeChunk.includes('项待拍板'), '徽记不重复待拍板计数');
  assert.ok(!badgeChunk.includes('个项目'), '徽记不重复项目计数');
  assert.ok(html.includes('份资产') && html.includes('项待拍板') === false, 'meta 胶囊保留既有口径（零待拍板时不出拍板数）');
});

// ───────────────── ④ SSR：柱图可点击时光入口 ─────────────────

test('SSR 柱图：day 粒度全柱 button 化（精确 YYYY-MM-DD 载荷）、点击前往该日、近 24 桶、日历次级入口', () => {
  const groups: EventDayGroup[] = [];
  for (let i = 0; i < 25; i += 1) groups.push(dayGroup(localDayStr(i - 25), i + 1));
  groups.push(dayGroup(TODAY, 30, { appeared: 5 }));
  const html = renderHome(daysResult('day', groups), { onOpenCalendarAt: noop });

  assert.equal(
    (html.match(/data-home-trend-bar="/g) ?? []).length,
    24,
    '恰 24 根柱（近 24 桶截断）'
  );
  assert.equal(
    (html.match(/data-home-trend-jumpable="true"/g) ?? []).length,
    24,
    'day 粒度全柱可直跳'
  );
  assert.ok(html.includes(`data-home-trend-bar="${TODAY}"`), '今日柱带精确日期载荷');
  assert.ok(
    html.includes(`aria-label="${TODAY} · 30 条事件，点击前往该日全景星图"`),
    '峰值柱 aria 语义（日期 + 当日事件数 + 去向）'
  );
  assert.ok(html.includes('点击前往该日'), '悬停浮窗升级为时光入口文案');
  assert.ok(!html.includes('聚合桶不可直跳'), 'day 粒度无禁跳柱');
  assert.ok(
    html.includes(`data-home-trend-calendar-jump="${TODAY}"`),
    '日历次级入口落点=最近活跃直跳日'
  );
  assert.ok(html.includes(`日历看 ${TODAY.slice(5)}`), '日历入口文案带精确日期');
  // 既有基线锚点不回退：三格统计条不增格
  assert.ok(html.includes('aria-label="事件走势"'), '走势区 aria 锚点');
  for (const cell of ['活跃时段', '日均节奏', '单日峰值']) {
    assert.equal(
      (html.match(new RegExp(cell, 'g')) ?? []).length,
      1,
      `统计格「${cell}」恰好一枚（不得再增格）`
    );
  }
  assert.ok(html.includes('grid-cols-3'), '三格布局不变');
  assert.ok(html.includes('近 24 天 · 352 条'), '区间胶囊口径（3..25 + 30 = 352）');
  assert.ok(html.includes('峰值 30 条/日'), '峰值口径不变');
});

test('SSR 柱图诚实禁跳：week/month 聚合桶零按钮、零「点击前往该日」、零日历直跳入口', () => {
  const weekHtml = renderHome(
    daysResult('week', [dayGroup('2026-11-16', 4), dayGroup('2026-11-23', 9)])
  );
  assert.equal(
    (weekHtml.match(/data-home-trend-jumpable="false"/g) ?? []).length,
    2,
    '聚合桶全部诚实禁跳'
  );
  assert.ok(!weekHtml.includes('data-home-trend-jumpable="true"'), '零可跳柱');
  assert.ok(!weekHtml.includes('点击前往该日'), '禁跳桶不出直跳文案');
  assert.ok(weekHtml.includes('聚合桶不可直跳'), '悬停浮窗如实说明不可直跳');
  assert.ok(!weekHtml.includes('data-home-trend-calendar-jump'), '无直跳日即无日历入口');
  assert.ok(weekHtml.includes('近 2 桶 · 13 条'), '非 day 粒度区间胶囊按桶计数');

  const monthHtml = renderHome(daysResult('month', [dayGroup('2026-11-01', 2)]));
  assert.ok(!monthHtml.includes('data-home-trend-jumpable="true"'), 'month 桶同样禁跳');
});

test('SSR 柱图零数据：诚实空态与「等待数据」胶囊不变，零柱零入口', () => {
  const empty = renderHome(daysResult('day', [dayGroup('', 99)]));
  assert.ok(empty.includes('暂无按日聚合的事件数据'), '全待考桶 = 诚实空态');
  assert.ok(!empty.includes('data-home-trend-bar='), '零柱');
  const nullData = renderHome(null);
  assert.ok(nullData.includes('等待数据'), '无数据胶囊');
  assert.ok(!nullData.includes('data-home-trend-calendar-jump'), '无数据不出日历入口');
});

// ───────────────── ⑤ 接线（源码级，SSR 无法模拟点击） ─────────────────

test('接线（源码级）：柱图/徽记/日历入口精确透传 YYYY-MM-DD；AppMainViews 锁定语义 ≠ toggle', () => {
  const homeSrc = readSrc('components/HomeView.tsx');
  assert.ok(
    homeSrc.includes('onOpenPanoramaAt ? onOpenPanoramaAt(g.date) : onOpenPanorama()'),
    '柱图点击精确透传 g.date（缺省降级为无日期全景入口）'
  );
  assert.ok(
    homeSrc.includes('onOpenPanoramaAt(chronos.date)'),
    '徽记点击直飞司辰星图今日切片'
  );
  assert.ok(
    homeSrc.includes('onOpenCalendarAt(calendarJumpDate)'),
    '日历次级入口透传精确日期'
  );

  const viewsSrc = readSrc('components/app/AppMainViews.tsx');
  assert.ok(
    viewsSrc.includes('onOpenPanoramaAt={handleJumpFromHomeToStarMap}') &&
      viewsSrc.includes('onOpenCalendarAt={handleJumpFromHomeToCalendar}'),
    'HomeView 直跳回调接线落位'
  );
  const starHandler = viewsSrc.slice(
    viewsSrc.indexOf('const handleJumpFromHomeToStarMap'),
    viewsSrc.indexOf('const handleJumpFromHomeToCalendar')
  );
  assert.ok(starHandler.includes('setActiveDate(date);'), '星图直跳 = setActiveDate 锁定');
  assert.ok(starHandler.includes("setActiveTab('panorama');"), '切全景页签');
  assert.ok(starHandler.includes("setPanoramaMode('canvas');"), '落星图画布态');
  assert.ok(
    !starHandler.includes('handleSelectCanvasDate'),
    '直跳绝不走 toggle（再点同值即清空的语义只属于画布内自点）'
  );
  const calHandler = viewsSrc.slice(viewsSrc.indexOf('const handleJumpFromHomeToCalendar'));
  assert.ok(calHandler.includes('setActiveDate(date);'), '日历直跳同样锁定 activeDate');
  assert.ok(
    calHandler.includes('setCalendarFocusedDate(date);'),
    '右侧「当日沉淀聚焦卡」同步锁定'
  );
  assert.ok(calHandler.includes("setPanoramaMode('calendar');"), '落日历态');
  assert.ok(
    viewsSrc.includes('handleSelectCanvasDate(date);'),
    '日历侧既有直跳契约（calendar→starmap）原样保留'
  );
});

// ───────────────── ⑥ 交错入场节奏 ─────────────────

test('交错入场节奏：首页区块 --glx-stagger 唯一递进（0,2,3,4,5，消灭并列重叠拍）', () => {
  const html = renderHome(null);
  const staggers = [...html.matchAll(/--glx-stagger:(\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(
    staggers,
    [0, 2, 3, 4, 5],
    '问候头/专题橱窗/任务包橱窗/近期待阅/走势与近7天 依序递进，无并列 1'
  );
  assert.ok(html.includes('glx-hero-reveal'), '区块入场复用既有 glx-hero-reveal 预设');
});

// ───────────────── ⑦ 动效契约（声明 + reduce 双登记） ─────────────────

test('动效契约：两文件引用的 glx-* 类全部「声明 + reduce 降级」双登记；零新增动效类欠账', () => {
  const motionCss = readFileSync(
    fileURLToPath(new URL('../src/styles/motion.css', import.meta.url)),
    'utf8'
  );
  const reduceSection = motionCss.slice(
    motionCss.indexOf('@media (prefers-reduced-motion: reduce)')
  );
  const used = new Set<string>();
  for (const src of [readSrc('components/HomeView.tsx'), readSrc('components/FeaturedFocusCards.tsx')]) {
    // (?<!-)：排除 --glx-stagger / --glx-bar-idx 等交错延迟自定义属性（非类名）
    for (const m of src.matchAll(/(?<![-\w])glx-[a-z0-9-]+/g)) used.add(m[0]);
  }
  assert.ok(used.size >= 5, `应覆盖既有共享动效类（实收 ${used.size} 类）`);
  // glx-fan-stage 是纯父级 hover 触发器（自身无动画/过渡），子层 glx-fan-front/back
  // 已逐类降级——登记豁免，与 motion.css §4 块一「逐类降级」口径一致。
  const parentTriggerOnly = new Set(['glx-fan-stage']);
  for (const cls of used) {
    assert.ok(motionCss.includes(`.${cls}`), `motion.css 应声明 .${cls}`);
    if (!parentTriggerOnly.has(cls)) {
      assert.ok(reduceSection.includes(`.${cls}`), `prefers-reduced-motion 应降级 .${cls}`);
    }
  }
  // 零新增动效类：motion.css 不引入司辰徽记私类（轻摇走组件侧 motion-safe 变换）
  assert.ok(!motionCss.includes('chronos'), 'motion.css 零 chronos 私类');
  const homeSrc = readSrc('components/HomeView.tsx');
  assert.ok(
    homeSrc.includes('motion-safe:transition-transform') &&
      homeSrc.includes('motion-safe:hover:-rotate-2'),
    '徽记轻摇 = motion-safe 门控的组件侧变换（不进共享动效层）'
  );
  assert.ok(!homeSrc.includes('animation:'), 'HomeView 零内联 animation（复用共享层预设）');
});

test('柱生长动效：只有既有 glx-bar-rise 的 scaleY（纯 transform），柱高保持 inline 视觉量非动画量', () => {
  const motionCss = readFileSync(
    fileURLToPath(new URL('../src/styles/motion.css', import.meta.url)),
    'utf8'
  );
  const kfStart = motionCss.indexOf('@keyframes glx-bar-rise');
  assert.ok(kfStart >= 0, 'glx-bar-rise 关键帧存在');
  const kfBody = motionCss.slice(kfStart, motionCss.indexOf('.glx-bar-rise {', kfStart));
  assert.ok(kfBody.includes('scaleY'), '柱生长走 scaleY');
  assert.ok(kfBody.includes('opacity'), '柱生长带淡入');
  assert.ok(
    !/\b(width|height|top|left)\s*:/.test(kfBody),
    '柱生长禁 width/height/top/left 布局动画'
  );
  const homeSrc = readSrc('components/HomeView.tsx');
  assert.ok(homeSrc.includes('height: `${heightPct}%`'), '柱高保持 inline height:%（视觉量）');
  assert.ok(homeSrc.includes("'--glx-bar-idx'"), '柱间交错仍走 --glx-bar-idx 延迟');
  // 数据区禁飞：首页柱图区零位移入场类
  assert.ok(!homeSrc.includes('glx-card-in') && !homeSrc.includes('glx-row-in'), '数据区禁飞类零引用');
});

// ───────────────── ⑧ 令牌与对比度纪律 ─────────────────

test('令牌纪律：徽记文字 AA 深档、iris 裸值与 --ink-faint 零入徽记；底轨收编 --glass-hairline；零 will-change', () => {
  const homeSrc = readSrc('components/HomeView.tsx');
  const badgeChunk = homeSrc.slice(
    homeSrc.indexOf('data-chronos-badge'),
    homeSrc.indexOf('</button>', homeSrc.indexOf('data-chronos-badge'))
  );
  assert.ok(badgeChunk.includes('var(--ink-soft)'), '徽记正文 --ink-soft（浅玻璃 AA 达标）');
  assert.ok(badgeChunk.includes('var(--ink-strong)'), 'hover 升 --ink-strong');
  assert.ok(!badgeChunk.includes('var(--ink-faint)'), '徽记文字禁 --ink-faint（<24px 红线）');
  assert.ok(
    !badgeChunk.includes('var(--accent-iris)'),
    '徽记禁 --accent-iris 裸值（4.17 禁作文字）'
  );
  assert.ok(
    badgeChunk.includes('var(--accent-iris-deep)'),
    '图标/箭头走 --accent-iris-deep（5.18 合法交互色）'
  );
  assert.ok(
    !badgeChunk.includes('--cv-') && !badgeChunk.includes('#F3F4F6') && !badgeChunk.includes('#C4B5FD'),
    '暗域亮色零入浅卡徽记'
  );

  const cardsSrc = readSrc('components/FeaturedFocusCards.tsx');
  assert.ok(!cardsSrc.includes('rgba(38, 36, 61, 0.08)'), '五段轨底轨硬写 rgba 退役');
  assert.ok(cardsSrc.includes("'var(--glass-hairline)'"), '底轨收编 --glass-hairline 令牌');
  assert.ok(
    !homeSrc.includes('will-change') && !cardsSrc.includes('will-change'),
    '两文件零 will-change'
  );
});

// ───────────────── ⑨ 橱窗微光与既有契约 ─────────────────

test('橱窗微光：MiniDecisionCard 接入既有 glx-sheen-card 扫光与箭头 hover 点亮；既有签名与既有锚点零回退', () => {
  const decisionItems: FeaturedDecisionItem[] = [
    { decisionId: 'd1', question: '是否采用新比例带？', status: '待确认' },
  ];
  const html = renderToStaticMarkup(
    createElement(FeaturedFocusCards, {
      decisionItems,
      decisionCount: 1,
      activePackage: null,
      onOpenDecision: noop,
      onOpenPackageBoard: noop,
    })
  );
  assert.ok(html.includes('data-feature-card="decision"'), '卡 A 锚点不回退');
  assert.ok(html.includes('data-feature-card="package"'), '卡 B 锚点不回退');
  assert.ok(html.includes('data-feature-count="decision"'), '决策计数锚点不回退');
  assert.ok(html.includes('data-feature-count="package"') === false, '无活跃专项时卡 B 计数锚点不出（诚实空态）');
  assert.ok(html.includes('glx-sheen-card'), '卡 A/B 扫光（既有）');
  assert.ok(html.includes('group/mini glx-sheen-card'), '斜叠微卡接入扫光');
  assert.ok(
    html.includes('group-hover/mini:text-[color:var(--accent-iris-deep)]'),
    '箭头 hover 点亮（微光回应）'
  );

  // 活跃专项态：五段轨走令牌底轨，卡 B 计数锚点恢复
  const pkgHtml = renderToStaticMarkup(
    createElement(FeaturedFocusCards, {
      decisionItems,
      decisionCount: 1,
      activePackage: {
        id: 'p1',
        name: '琉璃收口专项',
        stage: '交付',
        docCount: 3,
        awaitingAcceptance: 1,
        badgeLine: 'v8 · 待用户验收',
      },
      onOpenDecision: noop,
      onOpenPackageBoard: noop,
    })
  );
  assert.ok(pkgHtml.includes('data-feature-count="package"'), '待验收计数锚点');
  assert.ok(pkgHtml.includes('v8 · 待用户验收'), '徽标行真实派生透传');

  // C1 签名冻结：props 五字段原样保留
  const src = readSrc('components/FeaturedFocusCards.tsx');
  for (const token of [
    'decisionItems',
    'decisionCount',
    'activePackage',
    'onOpenDecision',
    'onOpenPackageBoard',
  ]) {
    assert.ok(src.includes(token), `C1 冻结字段保留：${token}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 全局顶栏减负分组 / 阅读岛动效激活 / 琉璃骨架屏体系
//
// ① 骨架行宽纯函数（GlassSkeleton.skeletonLineWidths）：首行满宽逐行收窄、
//    56% 下限、0/负/NaN/∞ 单行兜底；
// ② GlassSkeleton / ChronosEmptyState SSR：琉璃条 + glx-skeleton 流光载体 +
//    aria-hidden 纯视觉占位（诚实播报归调用方 role="status"）；
// ③ 动效契约：四文件引用的 glx-* 类「声明 + reduce 降级」双登记；
//    glx-skeleton-sweep 关键帧只动 transform（禁 background-position 流光、
//    禁布局属性、禁写死 ms、零 will-change）；reduce 下流光层 display:none；
// ④ 阅读岛：环生长纯函数 offset=100-percent 双端钳位（与 glx-ring-draw 目标
//    同源，周长 100 ≠ 日历侧 82）；三环全部接入描边生长 + 悬停微亮；
//    展开面板 glx-t-panel 两段式弹簧滑出（anim-spring-pop 跨域借用退役）；
// ⑤ 顶栏减负分组：核心行动组（检索 ⌘K · 未决决策 · 批阅）/ 静默工具组
//    （同步状态微点 · 证据篮 · ? · 设置）SSR 分区锚点 + 右区唯一发丝隔线；
// ⑥ 冷启动首扫：裸旋转图标 → 琉璃骨架；role="status" 与诚实文案保留；
//    dataError 错误态零骨架（骨架不吞真实错误态）。
// ═══════════════════════════════════════════════════════════════════════════

// ───────────────── ① 骨架行宽纯函数 ─────────────────

test('骨架行宽纯函数：首行满宽逐行收窄（56% 下限），0/负数/NaN/∞ 单行兜底', () => {
  assert.deepEqual(skeletonLineWidths(3), ['100%', '89%', '78%'], '首行满宽、步长 11% 递减');
  assert.deepEqual(skeletonLineWidths(1), ['100%']);

  const long = skeletonLineWidths(6);
  assert.equal(long.length, 6);
  assert.equal(long[long.length - 1], '56%', '尾行收在下限 56%（长骨架不缩成发丝）');
  assert.equal(long[3], '67%', '触底前严格递减');
  for (let i = 1; i < long.length; i += 1) {
    const prev = Number.parseInt(long[i - 1], 10);
    const cur = Number.parseInt(long[i], 10);
    assert.ok(prev >= cur, `第 ${i} 行单调不增`);
    assert.ok(cur >= 56, `第 ${i} 行不低于下限 56%`);
  }

  assert.deepEqual(skeletonLineWidths(0), ['100%'], '0 行单行兜底');
  assert.deepEqual(skeletonLineWidths(-2), ['100%'], '负数单行兜底');
  assert.deepEqual(skeletonLineWidths(Number.NaN), ['100%'], 'NaN 单行兜底不炸');
  assert.deepEqual(skeletonLineWidths(Number.POSITIVE_INFINITY), ['100%'], '∞ 单行兜底不炸');
});

// ───────────────── ② GlassSkeleton / 线稿空态 SSR ─────────────────

test('GlassSkeleton SSR：琉璃条 + glx-skeleton 流光载体 + aria-hidden 纯视觉占位；头像位变体', () => {
  const html = renderToStaticMarkup(createElement(GlassSkeleton, { lines: 3 }));
  assert.ok(html.includes('data-glass-skeleton=""'), '骨架容器锚点');
  assert.ok(html.includes('aria-hidden="true"'), '纯视觉占位（诚实播报归调用方 role=status）');
  assert.equal(
    html.split('glx-skeleton block').length - 1,
    3,
    '3 行琉璃条全部挂 glx-skeleton 流光载体'
  );
  assert.ok(html.includes('width:100%'), '首行满宽 inline 视觉量');
  assert.ok(html.includes('width:89%') && html.includes('width:78%'), '行宽由纯函数决定');
  assert.ok(
    html.includes('color-mix(in_srgb,currentColor_14%'),
    '条底随容器文字色 tint（壳层/纸面/夜航三语境轨道均可见，固定白条在浅纸面隐形）'
  );
  assert.ok(!html.includes('animate-spin'), '骨架本体零旋转零动画（流光是 CSS 伪元素层）');

  const avatar = renderToStaticMarkup(createElement(GlassSkeleton, { lines: 2, avatar: true }));
  assert.equal(avatar.split('glx-skeleton block').length - 1, 4, '头像位（圆 + 短题行）+ 2 行');
  assert.ok(avatar.includes('h-9 w-9'), '头像位圆形占位');

  const src = readSrc('components/ui/GlassSkeleton.tsx');
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!codeOnly.includes('will-change'), '零 will-change');
  assert.ok(!codeOnly.includes('background-position'), '流光禁 background-position（布局式流光违契约）');
  assert.ok(!codeOnly.includes('var(--ink-faint)'), '空态文字禁 --ink-faint（<24px 红线）');
});

test('司辰线稿空态 SSR：单点双圈涟漪线稿（澜青桥色）+ 诚实句双层文字，纯静态零动画', () => {
  const html = renderToStaticMarkup(
    createElement(ChronosEmptyState, { title: '暂无沉淀', hint: '首个版本入库后点亮' })
  );
  assert.ok(html.includes('data-chronos-empty=""'), '空态容器锚点');
  assert.ok(html.includes('data-chronos-lineart=""'), '线稿锚点');
  assert.ok(html.includes('var(--canvas-bridge)'), '线稿走澜青桥色（空态语法）');
  assert.ok(html.includes('opacity="0.31"') && html.includes('opacity="0.59"'), '双圈衰减 α .59/.31');
  assert.ok(html.includes('暂无沉淀') && html.includes('首个版本入库后点亮'), '诚实句透传');
  assert.ok(html.includes('var(--ink-strong)') && html.includes('var(--ink-soft)'), '文字双层 AA 档');
  const lineArt = renderToStaticMarkup(createElement(ChronosLineArt, {}));
  assert.ok(!lineArt.includes('animate'), '线稿纯静态（呼吸语法只属未读/新变化提示）');
});

// ───────────────── ③ 动效契约（声明 + reduce 双登记） ─────────────────

test('动效契约：四文件引用的 glx-* 类「声明 + reduce 降级」双登记；骨架流光只动 transform、零写死 ms', () => {
  const motionCss = readFileSync(
    fileURLToPath(new URL('../src/styles/motion.css', import.meta.url)),
    'utf8'
  );
  const reduceSection = motionCss.slice(
    motionCss.indexOf('@media (prefers-reduced-motion: reduce)')
  );
  const used = new Set<string>();
  for (const src of [
    readSrc('components/TopHeader.tsx'),
    readSrc('components/ReadingIsland.tsx'),
    readSrc('components/ui/GlassSkeleton.tsx'),
    readSrc('components/app/AppBanners.tsx'),
  ]) {
    // (?<!-)：排除 --glx-ring-offset 等交错/参数自定义属性（非类名）
    for (const m of src.matchAll(/(?<![-\w])glx-[a-z0-9-]+/g)) used.add(m[0]);
  }
  assert.ok(used.has('glx-skeleton'), '本轮新增骨架流光载体类');
  assert.ok(used.has('glx-ring-draw') && used.has('glx-t-panel'), '阅读岛复用既有共享类');
  for (const cls of used) {
    assert.ok(motionCss.includes(`.${cls}`), `motion.css 应声明 .${cls}`);
    assert.ok(reduceSection.includes(`.${cls}`), `prefers-reduced-motion 应降级 .${cls}`);
  }

  // 流光关键帧：只动 transform；§3.29 段（剥注释后的代码级）零布局属性、
  // 零 background-position、零写死 ms（时长只消费 --dur-pan 令牌倍乘）、零 will-change。
  const u11Section = motionCss
    .slice(motionCss.indexOf('§3.29'), motionCss.indexOf('§4 prefers-reduced-motion'))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const kfStart = u11Section.indexOf('@keyframes glx-skeleton-sweep');
  assert.ok(kfStart >= 0, 'glx-skeleton-sweep 关键帧存在');
  const kfBody = u11Section.slice(kfStart, u11Section.indexOf('}\n\n.glx-skeleton {', kfStart));
  assert.ok(kfBody.includes('translateX'), '流光是 translateX 扫光（合成器友好）');
  assert.ok(!/\b(width|height|top|left)\s*:/.test(kfBody), '流光禁 width/height/top/left 布局动画');
  assert.ok(!u11Section.includes('background-position'), '流光禁 background-position');
  assert.ok(!/\d+ms/.test(u11Section), '§3.29 段零写死 ms（时长只消费令牌倍乘）');
  assert.ok(u11Section.includes('calc(var(--dur-pan) * 6)'), '扫光时长走 --dur-pan 令牌倍乘');
  assert.ok(!u11Section.includes('will-change'), '零新增常驻 will-change');

  // reduce 覆盖形态：流光纯装饰层 display:none（骨架本体零动画无需停帧）
  const reduceSkeletonIdx = reduceSection.indexOf('.glx-skeleton::after');
  assert.ok(reduceSkeletonIdx >= 0, 'reduce 块登记骨架流光层');
  const reduceSkeletonBlock = reduceSection.slice(
    reduceSkeletonIdx,
    reduceSection.indexOf('}', reduceSkeletonIdx)
  );
  assert.ok(reduceSkeletonBlock.includes('display: none'), 'reduce 下流光层整层隐藏');
});

// ───────────────── ④ 阅读岛：环生长 + 悬停微亮 + 面板弹簧滑出 ─────────────────

test('环生长纯函数：周长 100 口径 offset=100-percent 双端钳位（与 glx-ring-draw 目标同源）', () => {
  assert.equal(islandRingDashOffset(33), 67, '33% → offset 67（周长 100 ≠ 日历侧 82，不同源）');
  assert.equal(islandRingDashOffset(100), 0, '满环 offset 0');
  assert.equal(islandRingDashOffset(0), 100);
  assert.equal(islandRingDashOffset(120), 0, '>100 钳满弧');
  assert.equal(islandRingDashOffset(-5), 100, '负值钳零弧');
  assert.equal(islandRingDashOffset(Number.NaN), 100, 'NaN 钳零弧（不炸不画负）');
});

test('三环描边生长 SSR：glx-ring-draw + --glx-ring-offset 与 attribute 同源；0% 环零弧；悬停微亮接线', () => {
  const ring = renderToStaticMarkup(
    createElement(IslandRing, {
      label: '已读',
      percent: 33,
      count: 1,
      total: 3,
      color: '#56643A',
      icon: null,
    })
  );
  assert.ok(ring.includes('glx-ring-draw'), '接入既有描边生长动效类');
  assert.ok(ring.includes('--glx-ring-offset:67'), '生长目标显式对齐周长 100（不显式写会画成满弧）');
  assert.ok(ring.includes('stroke-dashoffset="67"'), 'attribute 与 CSS 变量同一纯函数出处');
  assert.ok(ring.includes('stroke-dasharray="100"'));
  assert.ok(
    ring.includes('group-hover/island-pill:opacity-100') && ring.includes('motion-safe:transition-opacity'),
    '悬停微亮 = motion-safe 门控的组件侧变换'
  );

  const zero = renderToStaticMarkup(
    createElement(IslandRing, {
      label: '已落盘',
      percent: 0,
      count: 0,
      total: 3,
      color: '#6D5BD0',
      icon: null,
    })
  );
  assert.ok(!zero.includes('stroke-dasharray'), '0% 只画轨道（既有契约）');
  assert.ok(!zero.includes('glx-ring-draw'), '0% 无进度弧即无生长动画载体');

  const full = renderToStaticMarkup(
    createElement(IslandRing, {
      label: '已读',
      percent: 100,
      count: 3,
      total: 3,
      color: '#56643A',
      icon: null,
    })
  );
  assert.ok(full.includes('stroke-dashoffset="0"'), '100% 满弧（既有契约）');
  assert.ok(full.includes('--glx-ring-offset:0'));
});

// 岛夹具（与 reading-island.test.ts 同构的极小 FileRecord/ReadingState）
let islandSeq = 0;
function islandFile(opts: { persisted?: boolean } = {}): FileRecord {
  islandSeq += 1;
  const revId = `rev_u11_${String(islandSeq).padStart(2, '0')}`;
  return {
    file_id: `f_u11_${String(islandSeq).padStart(2, '0')}`,
    folder: 'docs',
    title: `文档 ${islandSeq}`,
    relative_path: `docs/u11-${islandSeq}.md`,
    format: 'md',
    coverage: 'full_text',
    role: '说明',
    current_revision_id: revId,
    revisions: [
      {
        revision_id: revId,
        versionNumber: 1,
        observed_at: '2026-11-01T10:00:00+08:00',
        snapshotAvailable: opts.persisted ?? true,
        summaryNote: '',
      },
    ],
  } as unknown as FileRecord;
}

function islandStates(): { files: FileRecord[]; states: Record<string, ReadingState> } {
  const readDoc = islandFile();
  const neverDoc = islandFile();
  const evictedDoc = islandFile({ persisted: false });
  return {
    files: [readDoc, neverDoc, evictedDoc],
    states: {
      [readDoc.file_id]: {
        file_id: readDoc.file_id,
        scrollPercent: 100,
        isFullyRead: true,
        bookmarked: false,
        updated_at: '2026-11-10T09:00:00+08:00',
        last_read_revision_id: readDoc.current_revision_id,
      },
    },
  };
}

test('岛收起态 SSR：inline 态三环描边生长，header 态走极简静默图标，收起态零面板', () => {
  const { files, states } = islandStates();
  const inlineHtml = renderToStaticMarkup(
    createElement(ReadingIsland, {
      placement: 'inline',
      files,
      readingStates: states,
      quota: { usedTotalMiB: 12, maxTotalMiB: 50 } as WorkspaceConfig['quota'],
      onOpenDoc: () => {},
    })
  );
  assert.equal((inlineHtml.match(/glx-ring-draw/g) ?? []).length, 3, 'inline 态三环全部描边生长');
  assert.ok(inlineHtml.includes('group/island-pill'), '胶囊挂 group/island-pill（微亮触发器）');
  assert.ok(inlineHtml.includes('aria-expanded="false"'), '收起态语义不变');
  assert.equal(inlineHtml.split('data-island-panel').length - 1, 0, '收起态不渲染面板');
  assert.equal(inlineHtml.split('data-island-ring').length - 1, 3, '三环锚点在位');

  const headerHtml = renderToStaticMarkup(
    createElement(ReadingIsland, {
      placement: 'header',
      files,
      readingStates: states,
      quota: { usedTotalMiB: 12, maxTotalMiB: 50 } as WorkspaceConfig['quota'],
      onOpenDoc: () => {},
    })
  );
  assert.ok(headerHtml.includes('data-island-pill=""'), '顶栏触发器在位');
  assert.equal(headerHtml.split('data-island-ring').length - 1, 0, '顶栏精简为静默单图标，不再堆砌三环');
});

test('展开面板 SSR：glx-t-panel 两段式弹簧滑出（anim-spring-pop 退役）；琉璃材质与既有锚点不回退', () => {
  const { files, states } = islandStates();
  const stats = computeReadingIslandStats(files, states);
  const html = renderToStaticMarkup(
    createElement(ReadingIslandPanel, {
      stats,
      quota: { usedTotalMiB: 12, maxTotalMiB: 50 } as WorkspaceConfig['quota'],
      onOpenDoc: () => {},
      onClose: () => {},
    })
  );
  assert.ok(html.includes('data-island-panel'), '面板容器锚点');
  assert.ok(html.includes('glx-t-panel'), '弹簧滑出走 glx-t-panel 双轨');
  assert.ok(html.includes('glass-pop'), '琉璃浮层材质保留（inset 高光 + blur + 双层深影）');
  assert.ok(!html.includes('anim-spring-pop'), '340ms 画布例外档退役，不再跨域借用');
  // 两段式首帧：SSR（无 rAF）输出右侧偏移态，浏览器第二帧翻转终态
  assert.ok(html.includes('transform:translateX(16px)'), '首帧偏移态（自右缘滑入）');
  assert.ok(html.includes('opacity:0'), '首帧透明态');
  // 既有结构锚点零回退（reading-island.test.ts 深锁，此处抽查）
  assert.equal(html.split('data-island-doc-row').length - 1, 3, '清单行数不回退');
  assert.ok(html.includes('data-island-section="已读"') && html.includes('data-island-section="未读"'));
});

// ───────────────── ⑤ 顶栏减负分组 ─────────────────

function headerBaseProps() {
  return {
    activeTab: 'home' as const,
    onSelectTab: () => {},
    searchQuery: '',
    onSearchChange: () => {},
    searchHits: [],
    onSelectSearchHit: () => {},
    unreadFilesCount: 0,
    contextBasketCount: 0,
    eventCount: 2,
    decisions: [],
    onOpenDecision: () => {},
    config: EMPTY_WORKSPACE_CONFIG,
    scanSummary: '',
    dataError: '',
    files: [],
    sidebarFilters: {
      quickScope: 'all' as const,
      folder: 'all',
      format: 'all' as const,
      role: 'all' as const,
      topic: 'all',
    },
    onUpdateSidebarFilters: () => {},
    onResetSidebarFilters: () => {},
    libraryMode: 'read' as const,
    onLibraryModeChange: () => {},
    onOpenSettings: () => {},
    onOpenMcpConsole: () => {},
    onOpenContextDrawer: () => {},
  };
}

test('顶栏减负分组 SSR：核心行动组（检索·未决决策·批阅）/ 静默工具组（同步·证据篮·?·设置）+ 右区唯一发丝隔线', () => {
  const html = renderToStaticMarkup(
    createElement(TopHeader, {
      ...headerBaseProps(),
      dataSource: 'real' as const,
      onOpenReviewBoard: () => {},
      reviewBoardAttentionCount: 2,
    })
  );

  assert.equal(
    (html.match(/data-header-cluster="primary"/g) ?? []).length,
    1,
    '核心行动组锚点恰一枚'
  );
  assert.equal(
    (html.match(/data-header-cluster="utility"/g) ?? []).length,
    1,
    '静默工具组锚点恰一枚'
  );
  assert.equal((html.match(/data-header-divider/g) ?? []).length, 1, '右区唯一簇间发丝隔线');

  // 源序：核心行动组 → 隔线 → 静默工具组
  const idxPrimary = html.indexOf('data-header-cluster="primary"');
  const idxDivider = html.indexOf('data-header-divider');
  const idxUtility = html.indexOf('data-header-cluster="utility"');
  assert.ok(idxPrimary < idxDivider && idxDivider < idxUtility, '分组源序：行动组 | 隔线 | 工具组');

  const primaryChunk = html.slice(idxPrimary, idxDivider);
  assert.ok(primaryChunk.includes('aria-label="搜索文件、内容或编号"'), '检索框在核心行动组');
  assert.ok(primaryChunk.includes('⌘K'), '检索 ⌘K 快捷键提示在核心行动组');
  assert.ok(primaryChunk.includes('未决决策'), '未决决策雷达在核心行动组');
  assert.ok(primaryChunk.includes('data-topheader-review-board') && primaryChunk.includes('批阅'), '批阅在核心行动组');

  const utilityChunk = html.slice(idxDivider);
  assert.ok(utilityChunk.includes('已同步'), '同步状态微点在静默工具组');
  assert.ok(utilityChunk.includes('证据篮'), '证据篮在静默工具组');
  assert.ok(utilityChunk.includes('aria-label="帮助"'), '? 帮助在静默工具组');
  assert.ok(utilityChunk.includes('项目设置'), '设置在静默工具组');
  assert.ok(!utilityChunk.includes('data-topheader-review-board'), '批阅绝不落静默组');
  assert.ok(!primaryChunk.includes('证据篮'), '证据篮绝不落核心组');
});

test('顶栏分组源码契约：library 筛选随检索同簇；遥测胶囊整块搬迁不拆；徽标脉冲接线原样', () => {
  const headerSrc = readSrc('components/TopHeader.tsx');
  const idxPrimary = headerSrc.indexOf('data-header-cluster="primary"');
  const idxDivider = headerSrc.indexOf('data-header-divider');
  const idxUtility = headerSrc.indexOf('data-header-cluster="utility"');
  assert.ok(idxPrimary > 0 && idxDivider > idxPrimary && idxUtility > idxDivider, '分区结构源码序');

  const filterIdx = headerSrc.indexOf('<FilterDropdown');
  assert.ok(filterIdx > idxPrimary && filterIdx < idxDivider, 'library 筛选下拉随检索同入核心行动组');
  const telemetryIdx = headerSrc.indexOf('{renderTelemetryCluster()}');
  assert.ok(telemetryIdx > idxUtility, '遥测胶囊整块搬迁进静默工具组（不拆内部结构）');
  const radarIdx = headerSrc.indexOf('<DecisionRadar');
  assert.ok(radarIdx > idxPrimary && radarIdx < idxDivider, '决策雷达入核心行动组');

  // 徽标脉冲接线原样保留（证据篮搬簇不搬语义）
  assert.ok(headerSrc.includes("basketPulseSeq > 0 ? 'glx-badge-pop'"));
  assert.ok(headerSrc.includes('data-context-basket-badge'));
});

// ───────────────── ⑥ 冷启动首扫琉璃骨架 ─────────────────

function bannerCtx(overrides: Record<string, unknown> = {}): WorkspaceStoreCtx {
  return {
    rescanState: 'idle',
    rescanError: null,
    handleRescan: async () => {},
    l4aProgress: null,
    hitlClearedAt: null,
    deliveredInitiative: null,
    deliveredInitiatives: [],
    initiativeLifecycle: null,
    runInitiativeLifecycle: async () => {},
    activeInitiative: null,
    changeNotice: null,
    refreshEvents: async () => {},
    dataSource: 'loading',
    files: [],
    dataError: null,
    activeTab: 'home',
    // 挂载点消费：阅读岛（files>0 时渲染）直连 store 真实 readingStates 与 config.quota
    config: EMPTY_WORKSPACE_CONFIG,
    readingStates: {},
    ...overrides,
  } as unknown as WorkspaceStoreCtx;
}

test('冷启动首扫 SSR：裸旋转图标升级琉璃骨架 + 司辰线稿；role=status 与诚实文案逐字保留', () => {
  const html = renderToStaticMarkup(createElement(AppBanners, { ctx: bannerCtx() }));
  assert.ok(html.includes('role="status"'), '诚实加载语义容器保留');
  assert.ok(html.includes('正在读取工作区快照…'), '主文案逐字保留');
  assert.ok(
    html.includes('期间首页卡片与星图 / 列表 / 日历为空属正常；数据就绪后自动填充。'),
    '说明文案逐字保留'
  );
  assert.ok(html.includes('data-glass-skeleton'), '琉璃骨架占位');
  assert.equal(html.split('glx-skeleton block').length - 1, 3, '三行骨架条');
  assert.ok(html.includes('data-chronos-lineart'), '司辰线稿静态语法');
  assert.ok(!html.includes('animate-spin'), '裸旋转图标退役');

  // 骨架不吞真实错误态：dataError 非空时整个首扫块不渲染（错误照旧如实透出）
  const errHtml = renderToStaticMarkup(
    createElement(AppBanners, { ctx: bannerCtx({ dataError: '读取失败' }) })
  );
  assert.ok(!errHtml.includes('data-glass-skeleton'), '错误态零骨架');
  assert.ok(!errHtml.includes('正在读取工作区快照…'), '错误态零加载文案');

  // 非 home 页签 / 已有文件时首扫占位照旧不渲染（既有门控原样）
  const libHtml = renderToStaticMarkup(
    createElement(AppBanners, { ctx: bannerCtx({ activeTab: 'library' }) })
  );
  assert.ok(!libHtml.includes('data-glass-skeleton'));
});

test('阅读岛挂载：收编入 TopHeader 静默工具组零遮挡（AppBanners 退役右缘 fixed 压盖）+ 续读复用 openDocResumeReading', () => {
  // 原 AppBanners 右缘 fixed 亮白悬浮条压盖日历侧栏/时光机右栏，已收编为 TopHeader 横向紧凑微胶囊 + coss Sheet inset
  const bannersSrc = readSrc('components/app/AppBanners.tsx');
  assert.ok(!bannersSrc.includes('<ReadingIsland'), 'AppBanners 不再挂右缘 fixed 压盖岛');
  const headerSrc = readSrc('components/TopHeader.tsx');
  assert.ok(headerSrc.includes('<ReadingIsland'), '阅读与存档微胶囊挂载在 TopHeader 静默工具组');
  assert.ok(
    headerSrc.includes('readingIslandFiles.length > 0'),
    'files 为空（首扫 loading 期）不渲染微胶囊（数据就绪后出现）'
  );
  const appSrc = readSrc('App.tsx');
  assert.ok(
    appSrc.includes('readingIslandFiles={ctx.files}') &&
      appSrc.includes('readingStates={ctx.readingStates}') &&
      appSrc.includes('ctx.openDocResumeReading(fileId)'),
    'App 聚合口径直连 store 真实 files/readingStates 与 openDocResumeReading（零造数）'
  );

  // SSR：files 为空时 TopHeader 不渲染胶囊；数据就绪后渲染横向微胶囊（默认收起态）
  const emptyHeaderHtml = renderToStaticMarkup(
    createElement(TopHeader, {
      ...headerBaseProps(),
      dataSource: 'real' as const,
      readingIslandFiles: [],
      readingStates: {},
      onOpenDocFromIsland: () => {},
    })
  );
  assert.ok(!emptyHeaderHtml.includes('data-island-pill'), '空文件期微胶囊缺席');
  const readyHeaderHtml = renderToStaticMarkup(
    createElement(TopHeader, {
      ...headerBaseProps(),
      dataSource: 'real' as const,
      readingIslandFiles: [islandFile()],
      readingStates: {},
      onOpenDocFromIsland: () => {},
    })
  );
  assert.ok(readyHeaderHtml.includes('data-island-pill'), '数据就绪后顶栏微胶囊出现（零右缘遮挡）');
  assert.ok(readyHeaderHtml.includes('阅读与存档'), '顶栏静默触发器带完整可读说明');
  assert.ok(readyHeaderHtml.includes('aria-expanded="false"'), '默认收起态');
});

test('三处裸旋转替换收编：阅读器冷加载与文件历史两处琉璃骨架，诚实语义零删减', () => {
  // ② 阅读器冷加载（readerMarkdownSection.tsx bodyPhase==='loading' 块）
  const readerSrc = readSrc('components/reader/readerMarkdownSection.tsx');
  const loadingIdx = readerSrc.indexOf("bodyPhase === 'loading'");
  assert.ok(loadingIdx > 0);
  const loadingBlock = readerSrc.slice(loadingIdx, readerSrc.indexOf(") : (", loadingIdx));
  assert.ok(loadingBlock.includes('<GlassSkeleton'), '冷加载块挂琉璃骨架');
  assert.ok(!loadingBlock.includes('Loader2'), '裸旋转图标退役');
  assert.ok(loadingBlock.includes('role="status"'), '诚实加载语义容器保留');
  for (const copy of [
    '正在按版本读取正文（首次对账期间可能较慢）…',
    '文档框架已就绪，正文到达后自动显示',
    'revision={currentRev.revision_id}',
  ]) {
    assert.ok(loadingBlock.includes(copy), `诚实文案/可诊断信息保留：${copy}`);
  }
  // 决策回执「保存中…」按钮 spinner 属功能流保留（animate-spin 功能流范畴）
  assert.ok(readerSrc.includes('Loader2'), '按钮内操作反馈 spinner 不在本轮收编范围');

  // ③ 文件历史抽屉（版本链拉取 + 版本正文预览两处）
  const timelineSrc = readSrc('components/FileTimelineDrawer.tsx');
  assert.ok(!timelineSrc.includes('Loader2'), 'FileTimelineDrawer 裸旋转全退役');
  assert.equal(timelineSrc.split('<GlassSkeleton').length - 1, 2, '版本链拉取与版本正文预览两处');
  assert.ok(timelineSrc.includes('正在读取版本链与相关事件…'), '拉取文案逐字保留');
  assert.ok(timelineSrc.includes('正在按版本读取正文…'), '预览文案逐字保留');
  assert.equal(
    timelineSrc.split('role="status"').length - 1,
    2,
    '两处 loading 块均带诚实加载语义'
  );
  // 错误态不被骨架吞：error / previewError 分支原样在场
  assert.ok(timelineSrc.includes('!loading && error'), '版本链错误态分支保留');
  assert.ok(timelineSrc.includes('previewError'), '版本预览错误态分支保留');
});
