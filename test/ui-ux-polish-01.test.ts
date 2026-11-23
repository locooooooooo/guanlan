import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

import {
  activeAccumulationSummary,
  compressEmptyRulerGaps,
  computeTrunkAccumulation,
  formatTrunkTickLabel,
  polishChangedSectionTag,
  polishEventCardDigestLine,
  type CanvasRulerTick,
} from '../src/utils/graphEvents';
import {
  anchorRectOf,
  buildCompactCalendarSlots,
  buildDailyAccumulationSparkline,
  buildEqualCalendarSlots,
  CALENDAR_COMPACT_GAP_WEIGHT,
  CALENDAR_COMPACT_MIN_EMPTY_RATIO,
  CALENDAR_COMPACT_MIN_GAP_DAYS,
  CALENDAR_COMPACT_STORAGE_KEY,
  CALENDAR_POPOVER_GAP,
  calendarBeamWidth,
  calendarDayWidthShare,
  calendarSlotIndex,
  calendarSlotPct,
  calendarSidePanelSafeRight,
  CalendarBoardView,
  computeCalendarPopoverPos,
  findCrowdedCalendarSlots,
  formatCompactSlotCount,
  normalizeCalendarCompactChoice,
  OlderSlotList,
  shiftCalendarDay,
  SlotDayList,
} from '../src/components/CalendarBoardView';
import { CalendarSidePanels } from '../src/components/CalendarSidePanels';
import CanvasPillToolbar from '../src/components/canvas/CanvasPillToolbar';
// U03：左侧目录树减噪（零值智能视图收纳 / 目录活跃摘要 / 未读点降噪）
import {
  collectFolderActivitySummaries,
  collectUnreadFileIds,
  estimateSmartViewCollapseGain,
  FolderTreeRows,
  isRecentActiveArtifact,
  LeftSidebar,
  partitionSmartViewsByCount,
  SMART_VIEW_COLLAPSED_CAPSULE_H,
  SMART_VIEW_PILL_W,
  SMART_VIEW_ROW_H,
  summarizeFolderActivity,
} from '../src/components/LeftSidebar';
import {
  BranchFolderRows,
  ProjectTreeBranch,
  SIDEBAR_DENSE_FOLDER_THRESHOLD,
} from '../src/components/sidebar/ProjectTreeBranch';
import type { FileRecord } from '../src/types/guanlan';

let seq = 0;
function makeFile(date: string | null, folder = '01-方案文档'): FileRecord {
  seq += 1;
  return {
    file_id: `f_ux_${String(seq).padStart(4, '0')}`,
    folder,
    title: `文档 ${seq}`,
    relative_path: `${folder}/doc-${seq}.md`,
    format: 'md',
    current_revision_id: `rev_${seq}`,
    coverage: 'full_text',
    revisions: date ? [{ revision_id: `rev_${seq}`, source_time: date }] : [],
  } as unknown as FileRecord;
}

function makeTick(date: string, count = 0): CanvasRulerTick {
  return {
    date,
    label: date.slice(5),
    count,
    kinds: count > 0 ? { modified: count } : {},
    formats: count > 0 ? { md: count } : {},
    hasEvents: count > 0,
  };
}

test('星图主干空档压缩：13年空档（>14天连续空日）折为单枚断层标记，近期活跃日全部保真', () => {
  const ticks: CanvasRulerTick[] = [
    makeTick('2026-11-22', 137),
    makeTick('2026-11-21', 185),
    makeTick('2026-11-20', 0),
    makeTick('2026-11-19', 88),
  ];
  // 模拟 400 天连续 0 事件空档
  const baseMs = Date.parse('2026-11-18T00:00:00Z');
  for (let i = 0; i < 400; i += 1) {
    const d = new Date(baseMs - i * 86_400_000).toISOString().slice(0, 10);
    ticks.push(makeTick(d, 0));
  }
  ticks.push(makeTick('2025-10-01', 3));

  const compressed = compressEmptyRulerGaps(ticks);
  assert.equal(compressed.length, 6, '4 个近期刻度 + 1 个空档断层 + 1 个历史活跃日');
  assert.equal(compressed[4].isGap, true);
  assert.equal(compressed[4].gapDays, 400);
  assert.match(compressed[4].label, /跨越 1 年/);
  assert.equal(compressed[5].date, '2025-10-01');
});

test('星图主干跨年标签：同年度显示 MM-DD，跨年或大步长补齐年份，杜绝 11-22/11-23 假重复', () => {
  assert.equal(formatTrunkTickLabel(makeTick('2026-11-18', 5), '2026', 1), '11-18');
  assert.equal(formatTrunkTickLabel(makeTick('2025-11-22', 0), '2026', 365), '2025-11');
  assert.equal(formatTrunkTickLabel(makeTick('2013-10-16', 2), '2026', 7), '2013-10-16');
});

test('事件卡变更摘要净化：纠偏 .mjs 源码误标二进制，并消除「变更章节：X — 修改X」自我重复', () => {
  assert.equal(
    polishEventCardDigestLine({
      changedSections: ['二进制内容变化'],
      description: '修改二进制内容变化',
      format: 'mjs',
      counts: { added: 13, removed: 0 },
    }),
    '源码内容更新'
  );
  assert.equal(
    polishEventCardDigestLine({
      changedSections: ['二进制内容变化'],
      description: '修改二进制内容变化',
      format: 'txt',
      counts: { added: 2, removed: 1 },
    }),
    '文本内容更新'
  );
  assert.equal(
    polishEventCardDigestLine({
      changedSections: ['发布策略'],
      description: '修改发布策略',
      format: 'md',
    }),
    '变更章节：发布策略'
  );
  // 多章节仍完整保留原有章节拼接语义
  assert.equal(
    polishEventCardDigestLine({
      changedSections: ['背景', '方案'],
      description: '修改背景 等 2 处章节',
      format: 'md',
    }),
    '变更章节：背景 / 方案 — 修改背景 等 2 处章节'
  );
});

test('日历30天密集槽零碰撞：相邻高密日自动转单列居中热力数字格（99+ 封顶），无空待考列与英文混写', () => {
  const files: FileRecord[] = [
    ...Array.from({ length: 94 }, () => makeFile('2026-11-20', '01-方案文档')),
    ...Array.from({ length: 101 }, () => makeFile('2026-11-21', '01-方案文档')),
    ...Array.from({ length: 49 }, () => makeFile('2026-11-22', '01-方案文档')),
    makeFile('2026-10-01', '03-宣讲PPT'), // 仅在历史槽，当前30天窗口无活跃文档
  ];

  // 纯函数碰撞判定
  const crowded = findCrowdedCalendarSlots(
    [
      ['2026-11-20', files.slice(0, 94)],
      ['2026-11-21', files.slice(94, 195)],
      ['2026-11-22', files.slice(195, 244)],
    ],
    (d) => Number(d.slice(8, 10))
  );
  assert.equal(crowded.crowdedChips.has('2026-11-20'), true);
  assert.equal(crowded.crowdedChips.has('2026-11-21'), true);
  assert.equal(crowded.crowdedChips.has('2026-11-22'), true);
  assert.equal(formatCompactSlotCount(101), '99+');
  assert.equal(formatCompactSlotCount(94), '94');

  const html = renderToString(
    createElement(CalendarBoardView, { files, events: [], onOpenDocument: () => {} })
  );
  const text = html.replace(/<!-- -->/g, '');
  // 密集槽使用单列紧凑热力数字格，绝不出现 margin-left:16 外溢
  assert.ok(html.includes('data-slot-compact="94"'));
  assert.ok(html.includes('data-slot-compact="101"'));
  assert.ok(html.includes('>99+</button>'));
  assert.ok(!html.includes('margin-left:16'));
  // 表头修正为「目录」、中文计数去掉英文 of、无待考文档时隐藏空白待考列、提供仅看活跃筛选
  assert.ok(text.includes('>目录<'));
  assert.ok(!text.includes(' of '));
  assert.ok(!text.includes('>待考<'));
  assert.ok(html.includes('data-calendar-active-only'));

  const sideHtml = renderToString(
    createElement(CalendarSidePanels, {
      files,
      events: [],
      recentItems: [],
      onOpenDocument: () => {},
    })
  );
  assert.ok(!sideHtml.replace(/<!-- -->/g, '').includes(' of '));
});

test('二轮减字与动效契约：motion.css 新增动效全量带 reduced-motion 降级、日历去重复「已纳入」、药丸栏精简', () => {
  const motionCss = readFileSync(
    fileURLToPath(new URL('../src/styles/motion.css', import.meta.url)),
    'utf8'
  );
  const reduceSection = motionCss.slice(motionCss.indexOf('@media (prefers-reduced-motion: reduce)'));
  for (const cls of [
    '.glx-view-enter',
    '.glx-heat-cell',
    '.glx-row-in',
    '.glx-floating-dock',
    '.glx-ripple-breathe',
    '.glx-live-dot::after',
    '.glx-chevron-rot',
    '.glx-hover-actions',
    '.glx-pill-tactile',
    '.glx-canvas-card',
  ]) {
    assert.ok(motionCss.includes(cls), `motion.css 应声明 ${cls}`);
    assert.ok(reduceSection.includes(cls), `prefers-reduced-motion 应降级 ${cls}`);
  }

  // 日历主表行头不再每行复读「X / X 已纳入」，且包含热力动效类
  const files: FileRecord[] = [
    ...Array.from({ length: 12 }, () => makeFile('2026-11-20', '01-方案文档')),
    ...Array.from({ length: 18 }, () => makeFile('2026-11-21', '01-方案文档')),
  ];
  const calHtml = renderToString(
    createElement(CalendarBoardView, { files, events: [], onOpenDocument: () => {} })
  );
  const calText = calHtml.replace(/<!-- -->/g, '');
  assert.ok(!calText.includes('>12 / 12 已纳入<'), '行头不再复读已纳入');
  assert.ok(calHtml.includes('glx-heat-cell'), '密集热力格携带弹簧入场动效类');
  assert.ok(!calText.includes('点击任意色点或数字格可展开当日文档清单'), '图例条移除冗长提示句');

  // 底部药丸工具栏瘦身并保留全部交互锚点
  const noop = () => {};
  const dockHtml = renderToString(
    createElement(CanvasPillToolbar, {
      tool: 'pointer',
      onToolChange: noop,
      versionView: 'latest',
      onVersionViewChange: noop,
      chronosSliderOpen: false,
      onToggleChronosSlider: noop,
      onAddContext: noop,
      onShowShortcuts: noop,
      viewSettingsOpen: false,
      onToggleViewSettings: noop,
      zoomPercent: 100,
      onZoomIn: noop,
      onZoomOut: noop,
      onResetView: noop,
      legendOpen: false,
      onToggleLegend: noop,
    })
  );
  assert.ok(dockHtml.includes('glx-floating-dock'), '药丸工具栏携带悬浮入场动效');
  assert.ok(dockHtml.includes('data-testid="canvas-scale-indicator"'), '缩放读数锚点保留');
  assert.ok(dockHtml.includes('data-cv-pill-btn="view-settings"'), '视图设置锚点保留');
  assert.ok(dockHtml.includes('data-cv-pill-btn="legend"'), '图例锚点保留');
  assert.ok(!dockHtml.includes('>添加上下文<'), '已瘦身为精简「上下文」');

  // 共享变更标签纠偏：.mjs 源码不再在列表时间线输出「二进制内容变化」
  assert.equal(polishChangedSectionTag('二进制内容变化', 'mjs'), '源码内容更新');
  assert.equal(polishChangedSectionTag('二进制内容变化', 'pdf'), '文档内容更新');
  assert.equal(polishChangedSectionTag('验收标准', 'md'), '验收标准');
});

test('司辰时光沉淀引擎与品牌核心叙事契约：自底向上单调累积、新增/演进拆分、司辰常驻与时光流转控件', () => {
  // 模拟上新下旧主干序列（含空档断层）：11-22(10) / 11-21(0) / 11-20(6) / gap / 11-10(4)
  const ticks: CanvasRulerTick[] = [
    {
      date: '2026-11-22',
      label: '11-22',
      count: 10,
      kinds: { appeared: 3, modified: 7 },
      formats: { md: 6, svg: 4 },
      hasEvents: true,
    },
    makeTick('2026-11-21', 0),
    {
      date: '2026-11-20',
      label: '11-20',
      count: 6,
      kinds: { appeared: 2, modified: 4 },
      formats: { md: 6 },
      hasEvents: true,
    },
    {
      date: '__gap_2026-11-19_2026-11-11__',
      label: '⋯ 跨越 9 天 ⋯',
      count: 0,
      kinds: {},
      formats: {},
      hasEvents: false,
      isGap: true,
      gapDays: 9,
    },
    {
      date: '2026-11-10',
      label: '11-10',
      count: 4,
      kinds: { workspace_baseline: 4 },
      formats: { md: 4 },
      hasEvents: true,
    },
  ];

  const accum = computeTrunkAccumulation(ticks);
  assert.equal(accum.length, ticks.length);
  // 自底（最早 11-10）向顶（最新 11-22）单调递增：4 → 4(gap) → 10 → 10(empty) → 20
  assert.equal(accum[4].cumulativeEvents, 4);
  assert.equal(accum[4].addedCount, 4);
  assert.equal(accum[4].modifiedCount, 0);
  assert.equal(accum[3].cumulativeEvents, 4, '空档断层继承截至之前的累积沉淀');
  assert.equal(accum[2].cumulativeEvents, 10);
  assert.equal(accum[2].addedCount, 2);
  assert.equal(accum[2].modifiedCount, 4);
  assert.equal(accum[1].cumulativeEvents, 10);
  assert.equal(accum[1].strataIntensity, 0);
  assert.equal(accum[0].cumulativeEvents, 20);
  assert.equal(accum[0].addedCount, 3);
  assert.equal(accum[0].modifiedCount, 7);
  assert.ok(accum[0].accumulationRatio > accum[2].accumulationRatio);
  assert.ok(accum[2].accumulationRatio > accum[4].accumulationRatio);

  // 截至 11-20 摘要：第 2 / 3 个沉淀日，累计 10 / 20（50%）
  const midSummary = activeAccumulationSummary(ticks, accum, '2026-11-20');
  assert.ok(midSummary);
  assert.equal(midSummary.chronologicalOrder, 2);
  assert.equal(midSummary.totalActiveDays, 3);
  assert.equal(midSummary.cumulativeEvents, 10);
  assert.equal(midSummary.cumulativePercent, 50);

  // 药丸工具栏接入时光流转重演按钮
  const noop = () => {};
  const playingDock = renderToString(
    createElement(CanvasPillToolbar, {
      tool: 'pointer',
      onToolChange: noop,
      versionView: 'latest',
      onVersionViewChange: noop,
      chronosSliderOpen: true,
      onToggleChronosSlider: noop,
      isTimeFlowPlaying: true,
      onToggleTimeFlow: noop,
      onAddContext: noop,
      onShowShortcuts: noop,
      viewSettingsOpen: false,
      onToggleViewSettings: noop,
      zoomPercent: 100,
      onZoomIn: noop,
      onZoomOut: noop,
      onResetView: noop,
      legendOpen: false,
      onToggleLegend: noop,
    })
  );
  assert.ok(playingDock.includes('data-cv-pill-btn="time-flow"'));
  assert.ok(playingDock.includes('>暂停<'));

  // 源码级契约：司辰默认常驻执掌时间轴
  const controllerSrc = readFileSync(
    fileURLToPath(new URL('../src/components/graph/useGraphCanvasController.tsx', import.meta.url)),
    'utf8'
  );
  assert.ok(
    controllerSrc.includes('useState(true)'),
    '司辰默认常驻星图时间轴'
  );
});

test('日历全面升级与动效契约：累积微折线、纵贯光束、脉冲柱、聚焦卡、弹层检索与星图直跳 + reduced-motion 全覆盖', () => {
  // 1) motion.css 日历专属动效类全部存在且纳入 prefers-reduced-motion 降级
  const motionCss = readFileSync(
    fileURLToPath(new URL('../src/styles/motion.css', import.meta.url)),
    'utf8'
  );
  const reduceSection = motionCss.slice(motionCss.indexOf('@media (prefers-reduced-motion: reduce)'));
  for (const cls of [
    '.glx-peak-shimmer',
    '.glx-doc-pill',
    '.glx-dot-bloom',
    '.glx-cal-col-beam',
    '.glx-cal-bar',
    '.glx-spark-draw',
    '.glx-progress-grow',
    '.glx-ring-draw',
    '.glx-mini-cell',
    '.glx-focus-card-in',
  ]) {
    assert.ok(motionCss.includes(cls), `motion.css 应声明 ${cls}`);
    assert.ok(reduceSection.includes(cls), `prefers-reduced-motion 应降级 ${cls}`);
  }

  // 2) 纯函数：窗口时光累积微折线（单调递增、合法 SVG 路径）
  const spark = buildDailyAccumulationSparkline(
    ['2026-11-20', '2026-11-21', '2026-11-22'],
    new Map([
      ['2026-11-20', 4],
      ['2026-11-22', 6],
    ])
  );
  assert.equal(spark.total, 10);
  assert.ok(spark.linePath.startsWith('M0 '));
  assert.ok(spark.areaPath.endsWith('Z'));

  // 3) 主日历板 + 右侧联动侧栏渲染：累积微折线、纵贯光束、脉冲柱、聚焦卡与星图直跳
  const files: FileRecord[] = [
    ...Array.from({ length: 14 }, () => makeFile('2026-11-20', '01-方案文档')),
    ...Array.from({ length: 28 }, () => makeFile('2026-11-21', '01-方案文档')),
    ...Array.from({ length: 108 }, () => makeFile('2026-11-22', '01-方案文档')),
  ];
  const events = [
    {
      event_id: 'ev_cal_u1',
      kind: 'modified',
      file_id: files[0].file_id,
      revision_id: 'rev_1',
      observed_at: '2026-11-21T10:00:00Z',
      source_time: '2026-11-21',
      topic_lane: 'docs',
      headline: '更新方案',
      detail: '',
    },
  ] as unknown as import('../src/types/guanlan').TimelineEvent[];

  const boardHtml = renderToString(
    createElement(CalendarBoardView, {
      files,
      events,
      onOpenDocument: () => {},
      focusedDate: '2026-11-21',
      onJumpToStarMap: () => {},
    })
  );
  assert.ok(boardHtml.includes('data-calendar-sparkline'), '顶栏渲染时光累积微缩折线');
  assert.ok(boardHtml.includes('data-cal-col-beam="2026-11-21"'), '渲染纵贯聚焦光束');
  assert.ok(boardHtml.includes('data-cal-beam-label="2026-11-21"'), '表头渲染滑移日期浮标');
  assert.ok(boardHtml.includes('data-calendar-jump-starmap="2026-11-21"'), '顶栏提供星图直跳按钮');
  assert.ok(boardHtml.includes('glx-peak-shimmer'), '≥100 峰值格带琉璃微光动效');
  assert.ok(boardHtml.includes('glx-cal-bar'), '事件刻度升级为波浪脉冲柱');

  const sideHtml = renderToString(
    createElement(CalendarSidePanels, {
      files,
      events,
      recentItems: [],
      onOpenDocument: () => {},
      focusedDate: '2026-11-21',
      onFocusDate: () => {},
      onJumpToStarMap: () => {},
    })
  );
  assert.ok(sideHtml.includes('data-calendar-focus-card="2026-11-21"'), '右侧滑入当日沉淀聚焦卡');
  assert.ok(sideHtml.includes('data-side-jump-starmap="2026-11-21"'), '聚焦卡提供星图溯源直跳');
  assert.ok(sideHtml.includes('glx-ring-draw'), '纳入概览升级为环形琉璃仪表');
  assert.ok(sideHtml.includes('glx-mini-cell'), '迷你月历格具备交互波浪动效');

  // 4) 高密当日弹层：>6 份内置快速筛选框 + 星图溯源按钮
  const popHtml = renderToString(
    createElement(SlotDayList, {
      date: '2026-11-21',
      items: files.slice(0, 10),
      left: 500,
      top: 200,
      onOpenDocument: () => {},
      onJumpToStarMap: () => {},
      onClose: () => {},
    })
  );
  assert.ok(popHtml.includes('aria-label="筛选当日文档"'), '高密日清单内置即时搜索框');
  assert.ok(popHtml.includes('data-slot-jump-starmap="2026-11-21"'), '弹层头支持一键跳转星图');
});

// ---------- U01：日历弹层智能避让 + 头部防截断 ----------

/** 从 SSR 渲染结果里取弹层的定位样式（left/top）。 */
function popoverStyleOf(html: string): { left: number; top: number; raw: string } {
  const m = html.match(/style="([^"]*left:[^"]*)"/);
  assert.ok(m, '弹层应带定位样式');
  const raw = m![1];
  const left = Number(raw.match(/left:([-\d.]+)px/)?.[1]);
  const top = Number(raw.match(/top:([-\d.]+)px/)?.[1]);
  assert.ok(Number.isFinite(left) && Number.isFinite(top), '定位样式应为像素值');
  return { left, top, raw };
}

test('U01 弹层智能避让：右半区锚点 100% 向左展开且 popLeft+popWidth ≤ anchorLeft−8，四向定位零压盖右侧栏', () => {
  const viewport = { width: 1440, height: 900 };
  const size = { width: 280, height: 320 };
  const safeRight = calendarSidePanelSafeRight(viewport.width);
  // 右侧「当日沉淀聚焦卡 / 最近 7 天」侧栏占位 276+14=290 → 安全右界 = vw − 290
  assert.equal(safeRight, 1440 - 290);

  // ① 左区锚点 → 默认向右展开，且不越侧栏安全界
  const leftPos = computeCalendarPopoverPos(
    { left: 300, right: 320, top: 200, bottom: 220 },
    size,
    viewport,
    safeRight
  );
  assert.equal(leftPos.side, 'right');
  assert.equal(leftPos.flipped, false);
  assert.equal(leftPos.left, 320 + CALENDAR_POPOVER_GAP);
  assert.ok(leftPos.left + size.width <= safeRight, '左区弹层右缘不得越过侧栏安全界');

  // ② 中区锚点 → 仍在右半区之外，向右展开但收口在安全界内
  const midPos = computeCalendarPopoverPos(
    { left: 690, right: 710, top: 200, bottom: 220 },
    size,
    viewport,
    safeRight
  );
  assert.equal(midPos.side, 'right');
  assert.ok(midPos.left + size.width <= safeRight);

  // ③ 右区锚点 → 一律向左展开，且 popLeft + popWidth ≤ anchorLeft − 8（空间允许时）
  const rightPos = computeCalendarPopoverPos(
    { left: 1100, right: 1120, top: 200, bottom: 220 },
    size,
    viewport,
    safeRight
  );
  assert.equal(rightPos.side, 'left', '右半区锚点必须向左展开');
  assert.equal(rightPos.flipped, true);
  assert.equal(rightPos.left, 1100 - CALENDAR_POPOVER_GAP - size.width);
  assert.ok(
    rightPos.left + size.width <= 1100 - CALENDAR_POPOVER_GAP,
    '右半区弹层右缘必须落在触发格左缘 − 8 之外'
  );
  assert.ok(rightPos.left + size.width <= safeRight, '右半区弹层零压盖右侧聚焦卡');

  // ④ 底部锚点 → 下方放不下则上翻到触发格上方，且不越视口下沿
  const bottomPos = computeCalendarPopoverPos(
    { left: 690, right: 710, top: 820, bottom: 840 },
    size,
    viewport,
    safeRight
  );
  assert.equal(bottomPos.top, 820 - CALENDAR_POPOVER_GAP - size.height);
  assert.ok(bottomPos.top + size.height <= viewport.height - 12, '底部弹层不越视口下沿');

  // ⑤ 窄视口：锚点虽在左半区，但距右侧栏不足弹层宽度 → 同样向左展开（绝不压盖侧栏）
  const narrowViewport = { width: 900, height: 800 };
  const narrowSafe = calendarSidePanelSafeRight(narrowViewport.width);
  const narrowPos = computeCalendarPopoverPos(
    { left: 400, right: 420, top: 200, bottom: 220 },
    size,
    narrowViewport,
    narrowSafe
  );
  assert.equal(narrowPos.side, 'left', '距右侧栏余量不足时必须向左展开');
  assert.ok(narrowPos.left + size.width <= narrowSafe, '窄视口下同样零压盖侧栏');

  // ⑥ 锚点矩形归一化：DOMRect → 纯四边（左右/上下颠倒也按几何真值归一）
  const norm = anchorRectOf({ left: 120, right: 100, top: 260, bottom: 240 });
  assert.deepEqual(norm, { left: 100, right: 120, top: 240, bottom: 260 });

  // ⑦ 分数像素锚点（1440 实机实测 1109.6875）：取整向下，右缘严格 ≤ anchorLeft − 8
  const fracPos = computeCalendarPopoverPos(
    { left: 1109.6875, right: 1146.09375, top: 212.5, bottom: 228.5 },
    size,
    viewport,
    safeRight
  );
  assert.equal(fracPos.side, 'left');
  assert.equal(fracPos.left, 821);
  assert.ok(
    fracPos.left + size.width <= 1109.6875 - CALENDAR_POPOVER_GAP,
    '分数像素锚点下弹层右缘仍严格落在触发格左缘 − 8 之外'
  );
});

test('U01 弹层头部防截断：SlotDayList 两段式头（左日期·份数主行 + 目录次行，右星图胶囊 + 关闭钮）零省略号', () => {
  const items = Array.from({ length: 10 }, () => makeFile('2026-11-21', '01-方案文档'));
  const html = renderToString(
    createElement(SlotDayList, {
      date: '2026-11-21',
      items,
      anchorRect: { left: 900, right: 920, top: 200, bottom: 220 },
      onOpenDocument: () => {},
      onJumpToStarMap: () => {},
      onClose: () => {},
    })
  );
  const text = html.replace(/<!-- -->/g, '');

  // 主行承载「日期 · 份数」，不得再被 truncate 挤成省略号
  const main = text.match(/<span class="([^"]*)">([^<]*2026-11-21 · 10 份)<\/span>/);
  assert.ok(main, '头部主行承载日期与份数');
  assert.ok(!main![1].includes('truncate'), '头部主行不得使用 truncate（省略号挤压的根因）');
  assert.ok(main![1].includes('whitespace-nowrap'), '头部主行整行不折行');

  // 次行轻标：目录名 + 身份类数（如实统计，不造数）
  assert.ok(text.includes('01-方案文档'), '次行轻标承载目录名');
  assert.match(text, /· \d+ 类/, '次行轻标如实标注身份类数');
  // 头部右侧仍保留星图直跳胶囊与关闭钮
  assert.ok(html.includes('data-slot-jump-starmap="2026-11-21"'), '头部保留星图直跳胶囊');
  assert.ok(html.includes('aria-label="关闭当日清单"'), '头部保留关闭钮');
  // >6 份的内置搜索与按身份并组展开全部保留
  assert.ok(html.includes('aria-label="筛选当日文档"'), '>6 份内置搜索框保留');
  assert.ok(html.includes('data-slot-day-item'), '按身份并组展开的条目保留');

  // 定位：右半区锚点 → 弹层落在触发格左侧，且右缘不越侧栏安全界（SSR 视口 1280）
  const style = popoverStyleOf(html);
  const safeRight = calendarSidePanelSafeRight(1280);
  assert.ok(style.left + 280 <= 900 - CALENDAR_POPOVER_GAP, '弹层右缘落在触发格左缘 − 8 之外');
  assert.ok(style.left + 280 <= safeRight, '弹层右缘零压盖右侧聚焦卡');
  assert.ok(style.left >= 12, '弹层左缘不越视口');
  assert.ok(!style.raw.includes('transition'), '弹层改位为静态定位，不动画 left/top');
  assert.ok(html.includes('glx-popover-in'), '弹层沿用既有入场动效类');
});

test('U01 更早清单头部重排：计数主行不截断 + 星图直跳（跳清单内最近一日）+ 既有计数口径逐字不变', () => {
  const groups: [string, FileRecord[]][] = [
    ['2026-10-14', [makeFile('2026-10-14')]],
    ['2013-10-16', [makeFile('2013-10-16')]],
  ];
  const html = renderToString(
    createElement(OlderSlotList, {
      label: '历史/更早（全部）',
      groups,
      anchorRect: { left: 20, right: 68, top: 200, bottom: 220 },
      onPickDate: () => {},
      onJumpToStarMap: () => {},
      onClose: () => {},
    })
  );
  const text = html.replace(/<!-- -->/g, '');

  // 既有 WF1-P1 计数口径逐字不变（tl-cal-02-window.test.ts 锁「91 天 · 91 份」同型）
  assert.ok(text.includes('2 天 · 2 份'), '头部计数 = 全量（口径逐字不变）');
  const main = text.match(/<span class="([^"]*)">([^<]*2 天 · 2 份)<\/span>/);
  assert.ok(main, '头部计数主行独立成行');
  assert.ok(!main![1].includes('truncate'), '计数主行不得使用 truncate');
  // 标签下沉为次行轻标
  assert.ok(text.includes('历史/更早（全部）'), '标签下沉次行轻标');
  // 星图直跳：跨多日期的更早槽取「清单内最近一日」，锚点如实写进 data 属性
  assert.ok(html.includes('data-older-jump-starmap="2026-10-14"'), '星图直跳取清单内最近一日');
  assert.ok(html.includes('aria-label="关闭更早清单"'), '保留关闭钮');
  // 左侧起点的更早槽 → 弹层向右展开，零压盖右侧栏
  const style = popoverStyleOf(html);
  assert.ok(style.left >= 12 && style.left + 256 <= calendarSidePanelSafeRight(1280));
});

test('U01 三入口统一避让：芯片 / 更早槽头 / 更早清单→当日清单二级跳转共用同一 anchorRect 管线', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../src/components/CalendarBoardView.tsx', import.meta.url)),
    'utf8'
  );
  // 三个点击入口全部写入 anchorRect（槽芯片、更早槽头、更早清单二级跳转）
  assert.equal(
    (src.match(/anchor: anchorRectOf\(rect\)/g) ?? []).length,
    3,
    '三个弹层入口必须共用同一 anchorRect 管线'
  );
  assert.ok(src.includes('anchorRect={openSlot.anchor}'), '当日清单消费触发格矩形');
  assert.ok(src.includes('anchorRect={openOlder.anchor}'), '更早清单消费触发格矩形');
  // 旧的内联定位公式（会压盖右侧聚焦卡）必须已移除
  assert.ok(!src.includes('left - 140'), '旧内联定位公式 left - 140 已移除');
  assert.ok(!src.includes('left - 128'), '旧内联定位公式 left - 128 已移除');
  assert.ok(!src.includes('vw - 292'), '旧内联定位公式 vw - 292 已移除');
  assert.ok(!src.includes('vw - 268'), '旧内联定位公式 vw - 268 已移除');
  // 弹层位移只走静态 left/top（禁动画 width/height/top/left 的共享动效铁律）
  const popoverRoots = src.match(/className="glass-pop[^"]*"/g) ?? [];
  assert.equal(popoverRoots.length, 2, '当日清单 / 更早清单两个弹层根节点');
  for (const root of popoverRoots) {
    assert.ok(!root.includes('transition'), '弹层根不得引入过渡类（改位为静态定位）');
  }
});

// ---------- U02：日历「紧凑活跃」空白周压缩与双态光束对齐 ----------

/** 逐日枚举（本地日历日；与 calendarWindow 的窗口口径同源）。 */
function dayRangeOf(start: string, end: string): string[] {
  const out: string[] = [];
  let cur: string | null = start;
  for (let guard = 0; cur !== null && cur <= end && guard < 4000; guard += 1) {
    out.push(cur);
    cur = shiftCalendarDay(cur, 1);
  }
  return out;
}

/** 本地今日（组件 localToday 的同款口径；勿用 toISOString）。 */
function localTodayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 取渲染串中某个锚点元素自身的 style 属性。 */
function styleAttrAfter(html: string, marker: string): string {
  const idx = html.indexOf(marker);
  assert.ok(idx >= 0, `渲染结果应包含 ${marker}`);
  const seg = html.slice(idx, idx + 800);
  const m = seg.match(/style="([^"]*)"/);
  assert.ok(m, `${marker} 应带 style 属性`);
  return m![1];
}

/** style 里的 left 百分比（轴上 x 位置）。 */
function leftPctOf(style: string): number {
  const m = style.match(/left:([-\d.]+)%/);
  assert.ok(m, `style 应含 left 百分比：${style}`);
  return Number(m![1]);
}

/** style 里的 translateX 百分比（transform 位移口径）。 */
function translateXPctOf(style: string): number {
  const m = style.match(/translateX\(([-\d.]+)%\)/);
  assert.ok(m, `style 应含 translateX 百分比：${style}`);
  return Number(m![1]);
}

/** 浮点近似相等（渲染串经字符串往返后允许 1e-6 级误差）。 */
function near(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

test('U02 纯函数：连续 ≥5 天空段折为「空 N 天」断层槽，活跃日顺序与日期零丢失', () => {
  // 30 天窗口：前 23 天全空，末 7 天连续活跃（任务卡量化验收场景）
  const days = dayRangeOf('2026-10-24', '2026-11-22');
  assert.equal(days.length, 30, '夹具窗口 = 30 个连续日历日');
  const activeDays = dayRangeOf('2026-11-16', '2026-11-22');
  assert.equal(activeDays.length, 7, '末 7 天有数据');

  const layout = buildCompactCalendarSlots(days, new Set(activeDays));
  assert.equal(layout.mode, 'compact');

  // ① 连续 23 天空段折为 1 枚断层槽，「空 N 天」如实统计真实日历天数
  assert.equal(layout.gaps.length, 1, '仅 1 枚断层槽');
  assert.equal(layout.gaps[0].date, '2026-10-24', '断层首日 = 窗口首日');
  assert.equal(layout.gaps[0].endDate, '2026-11-15', '断层末日 = 末个空日');
  assert.equal(layout.gaps[0].span, 23, '断层天数 = 被折叠的真实日历天数（23）');
  assert.equal(layout.foldedDays, 23, '折叠天数合计与断层一致');
  assert.equal(layout.maxEmptyRun, 23, '最长连续空段 = 23 天');
  assert.ok(near(layout.emptyRatio, 23 / 30), '空日占比 = 23/30');

  // ② 活跃日顺序与集合 100% 守恒（无日期丢失、无重排）
  assert.deepEqual(layout.activeDays, activeDays, '活跃日顺序与输入严格一致');
  assert.equal(new Set(layout.activeDays).size, 7, '活跃日不重复');

  // ③ 窗口内每一天都能反查槽位（断层内的日期映射到断层槽）
  for (const d of days) {
    assert.ok(layout.slotIndexByDate[d] !== undefined, `日期 ${d} 不得丢失`);
  }
  assert.equal(calendarSlotIndex(layout, '2026-10-24'), 0, '断层内日期映射到断层槽');
  assert.equal(calendarSlotIndex(layout, '2026-11-16'), 1, '首个活跃日紧随断层');
  assert.equal(calendarSlotIndex(layout, '2026-11-22'), 7, '末活跃日槽序守恒');

  // ④ 短于阈值的空白段不折（保留逐日列，避免丢时间分辨率）
  // 10 天窗口：空段分别为 3 天与 4 天，均 < 5 → 一段都不折
  const shortRun = buildCompactCalendarSlots(
    dayRangeOf('2026-10-24', '2026-11-02'),
    new Set(['2026-10-24', '2026-10-28', '2026-11-02'])
  );
  assert.equal(shortRun.gaps.length, 0, '3/4 天空段（<5）都不折为断层');
  assert.equal(shortRun.slots.length, 10, '未折叠时槽数 = 窗口天数');
  assert.equal(CALENDAR_COMPACT_MIN_GAP_DAYS, 5, '断层最小折叠长度 = 5 天');

  // ⑤ 智能识别门槛：空日占比不足时不给压缩建议
  const dense = buildCompactCalendarSlots(days, new Set(days.slice(0, 25)));
  assert.equal(dense.canCompact, false, '空日占比 16.7% < 阈值 → 不建议压缩');
  const sparse = buildCompactCalendarSlots(days, new Set(activeDays));
  assert.equal(sparse.canCompact, true, '空日占比 76.7% ≥ 阈值 → 建议压缩');
  assert.equal(CALENDAR_COMPACT_MIN_EMPTY_RATIO, 0.3, '空日占比阈值 = 30%');
  assert.ok(CALENDAR_COMPACT_GAP_WEIGHT < 1, '断层槽权重 < 1（压缩而非等宽）');
});

test('U02 量化验收：30 天内仅末 7 天有数据 → 紧凑活跃把活跃日单列可用宽度提升 ≥2 倍', () => {
  const days = dayRangeOf('2026-10-24', '2026-11-22');
  const activeDays = dayRangeOf('2026-11-16', '2026-11-22');
  const active = new Set(activeDays);

  const equal = buildEqualCalendarSlots(days, active);
  const compact = buildCompactCalendarSlots(days, active);

  // 等距：30 天各占 1/30
  const eqShare = calendarDayWidthShare(equal, '2026-11-22')!;
  assert.ok(near(eqShare, 1 / 30), `等距单列占比 = 1/30（实测 ${eqShare}）`);
  assert.equal(equal.slotCount, 30, '等距模式 30 列');
  assert.equal(equal.gaps.length, 0, '等距模式无断层槽');

  // 紧凑：23 天空档折为 1 枚 0.6 权重的断层槽 → 7 个活跃日各占 1/7.6
  const cpShare = calendarDayWidthShare(compact, '2026-11-22')!;
  const ratio = cpShare / eqShare;
  assert.ok(ratio >= 2, `紧凑活跃单列可用宽度提升 ${ratio.toFixed(2)}×（须 ≥2×）`);
  assert.equal(compact.slotCount, 8, '紧凑模式 8 列（1 断层 + 7 活跃）');
  // 全部 7 个活跃日的单列宽度同步提升（顺序守恒，非只提升末列）
  for (const d of activeDays) {
    const s = calendarDayWidthShare(compact, d)!;
    assert.ok(s / eqShare >= 2, `活跃日 ${d} 单列宽度提升 ${(s / eqShare).toFixed(2)}×`);
  }

  // 等距布局逐字等价于旧公式 slotPct(i) = (i + 0.5) / 总列数
  equal.slots.forEach((s, i) => {
    assert.ok(near(s.centerPct, ((i + 0.5) / 30) * 100), `等距第 ${i} 列中心 = 旧公式`);
  });

  // 光束宽度：等距按窗口档二分，紧凑活跃为第三分支
  assert.equal(calendarBeamWidth('equal', 30), 24);
  assert.equal(calendarBeamWidth('equal', 90), 12);
  assert.equal(calendarBeamWidth('compact', 30), 28);
});

test('U02 渲染：顶栏「紧凑活跃」开关 + 断层槽（空 23 天）+ 活跃日与文件数 100% 守恒', () => {
  const activeDays = dayRangeOf('2026-11-16', '2026-11-22');
  const files: FileRecord[] = activeDays.map((d) => makeFile(d, '01-方案文档'));

  const html = renderToString(
    createElement(CalendarBoardView, { files, events: [], onOpenDocument: () => {} })
  );
  const text = html.replace(/<!-- -->/g, '');

  // ① 智能识别命中 → 顶栏提供「紧凑活跃」开关（默认开启）
  assert.ok(html.includes('data-calendar-compact'), '顶栏提供紧凑活跃开关锚点');
  assert.ok(text.includes('紧凑活跃'), '开关文案逐字');
  assert.ok(
    /data-calendar-compact=""[^>]*aria-pressed="true"/.test(html) ||
      /aria-pressed="true"[^>]*data-calendar-compact=""/.test(html),
    '智能识别命中时默认开启紧凑活跃'
  );

  // ② 断层槽：锚点 + 真实天数 + 「空 N 天」文案
  assert.ok(html.includes('data-cal-gap="2026-10-24"'), '断层槽锚点带首日');
  assert.ok(html.includes('data-cal-gap-days="23"'), '断层槽如实标注被折叠的真实天数');
  assert.ok(text.includes('空 23 天'), '断层槽文案逐字「空 N 天」');
  assert.ok(html.includes('glx-cal-gap'), '断层槽携带琉璃虚线槽样式类');
  assert.ok(html.includes('glx-fade-in'), '断层槽入场只走 .glx-fade-in（数据区禁飞）');

  // ③ 活跃日与文件数 100% 守恒（7 个活跃日一枚不少，且不被断层吞掉）
  assert.equal((html.match(/data-slot-doc-pill/g) ?? []).length, 7, '7 个活跃日的 pill 全部渲染');
  assert.ok(html.includes('data-calendar-range="2026-10-24"'), '窗口跨度锚点不变（窗口仍是 30 天）');

  // ④ 等距对照：强制关闭紧凑活跃 → 零断层槽，活跃日与文件数完全一致
  const equalHtml = renderToString(
    createElement(CalendarBoardView, {
      files,
      events: [],
      onOpenDocument: () => {},
      compactMode: 'off',
    })
  );
  assert.ok(!equalHtml.includes('data-cal-gap'), '等距模式零断层槽');
  assert.equal(
    (equalHtml.match(/data-slot-doc-pill/g) ?? []).length,
    7,
    '等距模式活跃日与文件数同样 100% 守恒'
  );
  assert.ok(
    /data-calendar-compact=""[^>]*aria-pressed="false"/.test(equalHtml) ||
      /aria-pressed="false"[^>]*data-calendar-compact=""/.test(equalHtml),
    '强制关闭时开关处于未选中态'
  );
});

test('U02 双态光束对齐：纵贯光束 / 表头浮标 / 今日灯标 / 事件脉冲柱严格同列（同一 x）', () => {
  const today = localTodayStr();
  const days = dayRangeOf(shiftCalendarDay(today, -29)!, today);
  assert.equal(days.length, 30, '窗口 = 最近 30 个日历日');
  const activeDays = dayRangeOf(shiftCalendarDay(today, -6)!, today);
  const beamDate = shiftCalendarDay(today, -3)!;

  const files: FileRecord[] = activeDays.map((d) => makeFile(d, '01-方案文档'));
  const events = [beamDate, today].map((d, i) => ({
    event_id: `ev_u02_${i}`,
    kind: 'modified',
    file_id: files[0].file_id,
    revision_id: 'rev_u02',
    observed_at: `${d}T10:00:00Z`,
    source_time: d,
    topic_lane: 'docs',
    headline: `对齐事件 ${i}`,
    detail: '',
  })) as unknown as import('../src/types/guanlan').TimelineEvent[];

  const html = renderToString(
    createElement(CalendarBoardView, {
      files,
      events,
      onOpenDocument: () => {},
      focusedDate: beamDate,
      onJumpToStarMap: () => {},
    })
  );

  // 纯函数位置映射（与组件同一套槽位模型）
  const layout = buildCompactCalendarSlots(days, new Set(activeDays));
  const beamPct = calendarSlotPct(layout, beamDate)!;
  const todayPct = calendarSlotPct(layout, today)!;
  assert.ok(beamPct > 0 && beamPct < 100, '光束目标列在轴内');

  // ① 表头浮标（data-cal-beam-label）：left 百分比 = 纯函数映射
  const labelStyle = styleAttrAfter(html, `data-cal-beam-label="${beamDate}"`);
  assert.ok(near(leftPctOf(labelStyle), beamPct), '表头浮标与位置映射同 x');

  // ② 事件脉冲柱（data-event-day）：与表头浮标严格同列
  const barStyle = styleAttrAfter(html, `data-event-day="${beamDate}"`);
  assert.ok(near(leftPctOf(barStyle), leftPctOf(labelStyle)), '事件脉冲柱与表头浮标严格同列');

  // ③ 纵贯光束（data-cal-col-beam）：改走 transform 位移，位移量与同一 x 对齐
  const beamStyle = styleAttrAfter(html, `data-cal-col-beam="${beamDate}"`);
  assert.ok(!/left:/.test(beamStyle), '光束禁再走 left 定位（非等宽列下每帧重排）');
  assert.ok(
    near(translateXPctOf(beamStyle), leftPctOf(labelStyle)),
    '光束 transform 位移量与表头浮标同一 x'
  );

  // ④ 「今日」呼吸灯标（data-cal-today-marker）与今日脉冲柱同列
  const todayMarkerStyle = styleAttrAfter(html, `data-cal-today-marker="${today}"`);
  const todayBarStyle = styleAttrAfter(html, `data-event-day="${today}"`);
  assert.ok(near(leftPctOf(todayMarkerStyle), todayPct), '今日灯标与位置映射同 x');
  assert.ok(
    near(leftPctOf(todayMarkerStyle), leftPctOf(todayBarStyle)),
    '今日灯标与今日脉冲柱严格同列'
  );

  // ⑤ 源码契约：四个消费点同源（无第二套手写百分比公式）
  const src = readFileSync(
    fileURLToPath(new URL('../src/components/CalendarBoardView.tsx', import.meta.url)),
    'utf8'
  );
  assert.ok(src.includes('slotPct(activeBeamDate)'), '纵贯光束消费统一位置映射');
  assert.ok(src.includes('slotPct(today)'), '今日灯标消费统一位置映射');
  assert.ok(src.includes('translateX(${activeBeamPct}%)'), '光束改走 transform 位移');
  assert.ok(
    !src.includes('glx-cal-col-beam absolute inset-y-0 -translate-x-1/2'),
    '旧 left 定位写法（-translate-x-1/2 直接挂在光束上）已移除'
  );
  assert.ok(
    src.includes('glx-cal-col-beam absolute inset-y-0 left-0 right-0'),
    '光束外壳改为铺满定位层 + transform 位移'
  );
});

test('U02 动效契约：光束只过渡 transform（禁 left）、断层槽走令牌时长且 reduced-motion 逐类登记', () => {
  const motionCss = readFileSync(
    fileURLToPath(new URL('../src/styles/motion.css', import.meta.url)),
    'utf8'
  );
  const reduceSection = motionCss.slice(motionCss.indexOf('@media (prefers-reduced-motion: reduce)'));

  // ① 纵贯光束：改走 transform / opacity，禁过渡 left（非等宽列下每帧触发重排）
  const beamStart = motionCss.indexOf('.glx-cal-col-beam {');
  assert.ok(beamStart >= 0, 'motion.css 应声明 .glx-cal-col-beam');
  const beamBlock = motionCss.slice(beamStart, motionCss.indexOf('}', beamStart));
  assert.ok(beamBlock.includes('transform'), '光束过渡改走 transform');
  assert.ok(!/\bleft\b/.test(beamBlock), '光束禁过渡 left');
  assert.ok(!beamBlock.includes('will-change'), '禁新增常驻 will-change');
  assert.ok(!/\d+ms/.test(beamBlock), '光束时长只消费 --dur-* 令牌');
  assert.ok(beamBlock.includes('var(--dur-2)') && beamBlock.includes('var(--ease-spring)'));
  assert.ok(reduceSection.includes('.glx-cal-col-beam'), '光束须在 reduced-motion 块登记');

  // ② 断层槽：新类必落 motion.css + reduced-motion 显式停帧，时长只用令牌
  assert.ok(motionCss.includes('.glx-cal-gap'), 'motion.css 应声明 .glx-cal-gap');
  assert.ok(reduceSection.includes('.glx-cal-gap'), '断层槽须在 reduced-motion 块登记');
  const gapStart = motionCss.indexOf('.glx-cal-gap {');
  const gapBlock = motionCss.slice(gapStart, motionCss.indexOf('}', gapStart));
  assert.ok(!/\d+ms/.test(gapBlock), '断层槽禁写死 ms 时长');
  assert.ok(gapBlock.includes('var(--dur-1)') && gapBlock.includes('var(--ease-fade)'));
  assert.ok(!gapBlock.includes('will-change'), '断层槽禁新增常驻 will-change');

  // ③ 数据区入场式：.glx-fade-in（纯 opacity）须在 reduced-motion 块覆盖
  assert.ok(motionCss.includes('.glx-fade-in'), 'motion.css 应声明 .glx-fade-in');
  assert.ok(reduceSection.includes('.glx-fade-in'), '.glx-fade-in 须在 reduced-motion 块停帧');

  // ④ 全局兜底块二仍处停用状态（画布闸未签收，不得越闸启用）
  const globalFallback = reduceSection.slice(reduceSection.indexOf('/* * {'));
  assert.ok(globalFallback.includes('animation-iteration-count: 1 !important'));
  assert.ok(
    reduceSection.includes('/* * {\n    animation-duration: 0.01ms !important;'),
    '全局兜底块须保持注释态（画布闸未签收）'
  );
});

// ---------- U02 实机复核回修：断层标签穿字 / 光束浮标叠字 / 摘要条截断 / 紧凑门槛语义 ----------

/** 取渲染串中所有文本恰为 text 的 <span> 的属性片段。 */
function spanAttrsWithText(html: string, text: string): string[] {
  return [...html.matchAll(/<span([^>]*)>([^<]*)<\/span>/g)]
    .filter((m) => m[2] === text)
    .map((m) => m[1]);
}

test('U02 回修①：断层槽虚线导轨与「空 N 天」标签分行，窄断层下虚线永不穿字', () => {
  const motionCss = readFileSync(
    fileURLToPath(new URL('../src/styles/motion.css', import.meta.url)),
    'utf8'
  );
  const reduceSection = motionCss.slice(motionCss.indexOf('@media (prefers-reduced-motion: reduce)'));

  // ① 槽体自身不再带描边（描边只由导轨承担 → 槽体不可能切到字形）
  const gapStart = motionCss.indexOf('.glx-cal-gap {');
  assert.ok(gapStart >= 0, 'motion.css 应声明 .glx-cal-gap');
  const gapBlock = motionCss.slice(gapStart, motionCss.indexOf('}', gapStart));
  assert.ok(!gapBlock.includes('border-left'), '断层槽体自身禁带左侧描边');
  assert.ok(!gapBlock.includes('border-right'), '断层槽体自身禁带右侧描边');

  // ② 导轨独立成类：虚线样式 + 令牌色，且在 reduced-motion 块登记
  assert.ok(motionCss.includes('.glx-cal-gap-rail'), 'motion.css 应声明 .glx-cal-gap-rail');
  assert.ok(reduceSection.includes('.glx-cal-gap-rail'), '断层导轨须在 reduced-motion 块登记');
  const railStart = motionCss.indexOf('.glx-cal-gap-rail {');
  const railBlock = motionCss.slice(railStart, motionCss.indexOf('}', railStart));
  assert.ok(railBlock.includes('border-style: dashed'), '导轨须为虚线');
  assert.ok(railBlock.includes('var(--ink-soft)'), '导轨颜色走 --ink-soft 令牌（禁裸 hex/rgba）');
  assert.ok(!/\d+ms/.test(railBlock), '导轨禁写死 ms');

  // ③ 渲染结构：标签独占一行，导轨在其下方（两行结构 → 零相交）
  const files: FileRecord[] = dayRangeOf('2026-11-16', '2026-11-22').map((d) => makeFile(d, '01-方案文档'));
  const html = renderToString(
    createElement(CalendarBoardView, { files, events: [], onOpenDocument: () => {} })
  );
  const text = html.replace(/<!-- -->/g, '');
  assert.ok(html.includes('data-cal-gap-days="23"'), '断层槽仍如实标注 23 天');
  assert.ok(text.includes('空 23 天'), '断层标签文案逐字不变');
  assert.ok(html.includes('glx-cal-gap-label'), '断层标签带专属类名');
  assert.ok(html.includes('glx-cal-gap-rail'), '断层导轨带专属类名');

  const gapIdx = html.indexOf('data-cal-gap=');
  const labelIdx = html.indexOf('glx-cal-gap-label');
  const railIdx = html.indexOf('glx-cal-gap-rail');
  assert.ok(gapIdx >= 0 && labelIdx > gapIdx, '标签位于断层槽内');
  assert.ok(railIdx > labelIdx, '导轨排在标签之后（标签独占顶行，导轨自其下方起始）');
  // 导轨容器是标签的兄弟节点（不在标签内部）→ 几何上不可能相交
  const labelTag = html.slice(labelIdx, html.indexOf('</span>', labelIdx));
  assert.ok(!labelTag.includes('glx-cal-gap-rail'), '导轨不得嵌进标签节点内');
});

test('U02 回修②：悬停纵贯光束浮标与同位表头刻度标签不再叠字（浮标同位刻度让位）', () => {
  const files: FileRecord[] = dayRangeOf('2026-11-16', '2026-11-22').map((d) => makeFile(d, '01-方案文档'));

  // ① 对照组：不悬停 → 该周一刻度标签（浅灰 --ink-faint）正常渲染
  const idle = renderToString(
    createElement(CalendarBoardView, { files, events: [], onOpenDocument: () => {}, compactMode: 'off' })
  );
  const idleSpans = spanAttrsWithText(idle, '11-16');
  assert.ok(
    idleSpans.some((a) => a.includes('ink-faint')),
    '无悬停时，周一刻度标签「11-16」正常渲染'
  );

  // ② 悬停该周一 → 光束浮标出现，同位周一刻度标签必须让位（防「11-16 16」重影）
  const hovered = renderToString(
    createElement(CalendarBoardView, {
      files,
      events: [],
      onOpenDocument: () => {},
      hoveredDate: '2026-11-16',
      compactMode: 'off',
    })
  );
  assert.ok(hovered.includes('data-cal-beam-label="2026-11-16"'), '悬停浮标正常渲染');
  const hoveredSpans = spanAttrsWithText(hovered, '11-16');
  assert.ok(
    !hoveredSpans.some((a) => a.includes('ink-faint')),
    '悬停时同位周一刻度标签须隐退（不得与光束浮标叠字）'
  );
  assert.equal(
    hoveredSpans.filter((a) => a.includes('data-cal-beam-label')).length,
    1,
    '同位只剩光束浮标一枚'
  );

  // ③ 源码契约：周一刻度避让新增「光束浮标」判据
  const src = readFileSync(
    fileURLToPath(new URL('../src/components/CalendarBoardView.tsx', import.meta.url)),
    'utf8'
  );
  assert.ok(src.includes('nearBeam'), '周一刻度避让须判光束浮标同位');
  assert.ok(src.includes('if (nearBeam(wt.pct)) return null;'), '同位周一刻度标签须 return null');
});

test('U02 回修③：窗口资产构成/节奏摘要条改 sticky 贴底，不再被卡片底栏从中间切断', () => {
  const files: FileRecord[] = dayRangeOf('2026-11-16', '2026-11-22').map((d) => makeFile(d, '01-方案文档'));
  const html = renderToString(
    createElement(CalendarBoardView, { files, events: [], onOpenDocument: () => {} })
  );
  assert.ok(html.includes('sticky bottom-0'), '摘要条须 sticky 贴底（滚动区底缘不再截断）');
  // 摘要条底色改不透明页基色（sticky 时下方目录行不得透出叠字）
  const summaryIdx = html.indexOf('sticky bottom-0');
  const summaryTag = html.slice(summaryIdx, html.indexOf('>', summaryIdx));
  assert.ok(
    summaryTag.includes('var(--glass-page-base)'),
    '摘要条底色须为不透明页基色（禁止半透明导致下方行透字）'
  );
  // 既有摘要内容与图例口径不变
  const text = html.replace(/<!-- -->/g, '');
  assert.ok(text.includes('活跃日 ·'), '摘要条内容口径不变');
  assert.ok(text.includes('密集'), '图例条目不变');
});

test('U02 回修④：紧凑活跃门槛语义锁定——「每天都有事件」的 30 天窗口不压缩，同夹具 90 天窗口压缩出断层槽', () => {
  // 夹具与门禁镜头同款：最近 30 天每天都有事件（activeSet 覆盖全部 30 天）
  const days = dayRangeOf('2026-10-24', '2026-11-22');
  const events = days.map((d, i) => ({
    event_id: `ev_gate_${i}`,
    kind: 'modified',
    file_id: 'f_gate',
    revision_id: 'rev_gate',
    observed_at: `${d}T10:00:00Z`,
    source_time: d,
    topic_lane: 'docs',
    headline: `事件 ${i}`,
    detail: '',
  })) as unknown as import('../src/types/guanlan').TimelineEvent[];
  const files: FileRecord[] = dayRangeOf('2026-11-16', '2026-11-22').map((d) => makeFile(d, '01-方案文档'));

  // ① 30 天窗口：30 天全有事件 → 0 空日 → 不提供紧凑开关（无空白可折，如实不折）
  const short = renderToString(
    createElement(CalendarBoardView, { files, events, onOpenDocument: () => {} })
  );
  assert.ok(!short.includes('data-calendar-compact'), '30 天窗口零空日 → 不提供紧凑活跃开关');
  assert.ok(!short.includes('data-cal-gap'), '30 天窗口零空日 → 零断层槽');

  // ② 同夹具 90 天窗口：前 60 天全空 → 压缩出 1 枚「空 60 天」断层槽 + 紧凑开关
  const wide = renderToString(
    createElement(CalendarBoardView, {
      files,
      events,
      onOpenDocument: () => {},
      initialWindowDays: 90,
    })
  );
  assert.ok(wide.includes('data-calendar-compact'), '90 天窗口存在空白段 → 提供紧凑活跃开关');
  assert.ok(wide.includes('data-cal-gap-days="60"'), '90 天窗口折叠出「空 60 天」断层槽');
  assert.ok(wide.replace(/<!-- -->/g, '').includes('空 60 天'), '断层标签文案逐字');
  // 事件刻度 30 根全在（折叠只吃空白日，事件日一根不少）
  assert.equal((wide.match(/data-event-day=/g) ?? []).length, 30, '事件刻度零丢失');
});

test('U02 回修⑤：紧凑活跃选择可持久化（跨刷新不丢），且非法值一律回落 auto', () => {
  assert.equal(CALENDAR_COMPACT_STORAGE_KEY, 'guanlan.calendarCompact.v1');
  assert.equal(normalizeCalendarCompactChoice('on'), true);
  assert.equal(normalizeCalendarCompactChoice('off'), false);
  assert.equal(normalizeCalendarCompactChoice('auto'), 'auto');
  assert.equal(normalizeCalendarCompactChoice(null), 'auto', '无值 → 智能识别');
  assert.equal(normalizeCalendarCompactChoice('garbage'), 'auto', '非法值 → 智能识别（绝不猜）');
});

// ══════════════════════════════════════════════════════════════════════════
// U03 · 左侧目录树视觉减噪 / 零值智能视图收纳 / 活跃微标
// ══════════════════════════════════════════════════════════════════════════

/** U03 夹具：构造带目录与阅读基线的最小 FileRecord。 */
function makeSidebarFile(
  id: string,
  folder: string,
  format: 'md' | 'svg' = 'md'
): FileRecord {
  return {
    file_id: id,
    relative_path: `${folder}/${id}.${format}`,
    title: id,
    format,
    folder,
    role: '方案',
    roleProvenance: '来自路径',
    topics: [],
    current_revision_id: `rev_${id}`,
    revisions: [],
    coverage: 'full_text',
  } as unknown as FileRecord;
}

/** U03 夹具：服务端状态机 artifact 行（last_activity_at 走服务端活动口径）。 */
function makeArtifact(
  fileId: string,
  overrides: Partial<{
    last_activity_at: string | null;
    initiative_id: string | null;
    pending_p0: number;
    pending_p1: number;
  }> = {}
) {
  return {
    file_id: fileId,
    initiative_id: overrides.initiative_id ?? 'ini_1',
    current_path: `p/${fileId}.md`,
    title: fileId,
    stage: 'executing',
    state: 'executing',
    selected_revision_id: null,
    checklist_done: 0,
    checklist_total: 0,
    pending_p0: overrides.pending_p0 ?? 0,
    pending_p1: overrides.pending_p1 ?? 0,
    pending_p2: 0,
    last_activity_at:
      overrides.last_activity_at === undefined
        ? new Date(Date.now() - 3600_000).toISOString()
        : overrides.last_activity_at,
  } as unknown as import('../src/services/apiTypes').ArtifactStateView;
}

/** U03 夹具：阅读基线（last_read_revision_id ≠ 当前版 → GL-01「读后有更新」）。 */
function makeReadingState(fileId: string, lastReadRevisionId: string) {
  return {
    file_id: fileId,
    last_read_revision_id: lastReadRevisionId,
    scrollPercent: 30,
    isFullyRead: false,
    bookmarked: false,
    updated_at: '2026-11-20T10:00:00Z',
  } as unknown as import('../src/types/guanlan').ReadingState;
}

test('U03 纯函数：智能视图零值收纳（0 项折叠 / 非 0 项必显 / 选中零值项不失踪）+ 腾出高度 ≥40px', () => {
  // ① 全零：五项皆收折为末尾轻胶囊
  const allZero = partitionSmartViewsByCount(
    {
      updated_after_read: 0,
      awaiting_decision: 0,
      recent_active: 0,
      agent_drafts: 0,
      unassigned: 0,
    },
    null
  );
  assert.equal(allZero.visible.length, 0, '全零时无必显项');
  assert.equal(allZero.collapsedZero.length, 5, '五项零值全部折叠');
  assert.equal(allZero.collapsedLabel, '其余 5 项 (0)');

  // ② 非零项必显（零值折叠）
  const mixed = partitionSmartViewsByCount(
    {
      updated_after_read: 3,
      awaiting_decision: 0,
      recent_active: 7,
      agent_drafts: 0,
      unassigned: 0,
    },
    'all'
  );
  assert.deepEqual(
    mixed.visible.map((v) => v.id),
    ['updated_after_read', 'recent_active'],
    '非零项恒必显且保持既定顺序'
  );
  assert.deepEqual(
    mixed.collapsedZero.map((v) => v.id),
    ['awaiting_decision', 'agent_drafts', 'unassigned'],
    '零值项折叠且保持既定顺序'
  );
  assert.equal(mixed.collapsedLabel, '其余 3 项 (0)');

  // ③ 当前已选中的 0 项仍保持可见（绝不「失踪」）
  const activeZero = partitionSmartViewsByCount(
    {
      updated_after_read: 0,
      awaiting_decision: 0,
      recent_active: 0,
      agent_drafts: 0,
      unassigned: 0,
    },
    'agent_drafts'
  );
  assert.equal(activeZero.visible.length, 1);
  assert.equal(activeZero.visible[0].id, 'agent_drafts', '选中的零值视图恒在可见区');
  assert.equal(
    activeZero.collapsedZero.some((v) => v.id === 'agent_drafts'),
    false,
    '选中的零值视图不得同时出现在折叠区'
  );

  // ④ 腾出的有效可视高度（如实按「折行」模型估算，不虚报）
  assert.equal(SMART_VIEW_ROW_H, 25);
  assert.equal(SMART_VIEW_COLLAPSED_CAPSULE_H, 25);
  assert.equal(SMART_VIEW_PILL_W, 100);
  // 默认 264px 侧栏：每行 2 枚胶囊 → 收折 3 项（2 非零 + 3 零）省 1 行 ≈ 25px
  assert.equal(
    estimateSmartViewCollapseGain(2, 3),
    25,
    '默认宽度下收折 3 项零值 → 净收益 1 行（25px）'
  );
  // 零值 ≥4 项 → 省 2 行 ≈ 50px（满足任务卡「≥ 40px 有效可视高度」口径）
  assert.ok(
    estimateSmartViewCollapseGain(1, 4) >= 40,
    '零值 ≥4 项时腾出高度 ≥40px（任务卡量化口径）'
  );
  // 最小宽度侧栏（220px）→ 每行 1 枚 → 收折 3 项即省 2 行 ≈ 50px
  assert.ok(
    estimateSmartViewCollapseGain(2, 3, 220) >= 40,
    '窄栏（220px）下收折 3 项即腾出 ≥40px'
  );
  assert.equal(estimateSmartViewCollapseGain(2, 0), 0, '无零值可折叠时净收益为 0');
  assert.equal(estimateSmartViewCollapseGain(2, -3), 0, '非法入参不虚报收益');
});

test('U03 纯函数：目录活跃摘要——未读走 GL-01 单一出口，近 7 日活跃走 last_activity_at 窗口', () => {
  const nowMs = Date.parse('2026-11-22T12:00:00Z');
  const files = [
    makeSidebarFile('f_read', 'docs'), // 有基线且版本不同 → 读后有更新（未读）
    makeSidebarFile('f_done', 'docs'), // 有基线且版本相同 → 已读最新（不算未读）
    makeSidebarFile('f_fresh', 'docs'), // 无基线 → never_read（未读）
  ];
  const readingStates: Record<string, import('../src/types/guanlan').ReadingState> = {
    f_read: makeReadingState('f_read', 'rev_old_f_read'),
    f_done: makeReadingState('f_done', 'rev_f_done'),
  };
  const artifacts = new Map<string, import('../src/services/apiTypes').ArtifactStateView>([
    [
      'f_read',
      makeArtifact('f_read', {
        last_activity_at: new Date(nowMs - 2 * 24 * 3600_000).toISOString(),
      }),
    ],
    // 8 天前活跃 → 落在 7 天窗口外（诚实不算）
    ['f_done', makeArtifact('f_done', { last_activity_at: new Date(nowMs - 8 * 24 * 3600_000).toISOString() })],
    // 时间解析非法 → 诚实不算
    ['f_fresh', makeArtifact('f_fresh', { last_activity_at: 'not-a-date' })],
  ]);

  const summary = summarizeFolderActivity({
    directFiles: files,
    readingStates,
    artifactsByFileId: artifacts,
    nowMs,
  });
  assert.equal(summary.directCount, 3);
  assert.equal(summary.unreadCount, 2, 'never_read 与读后有更新均计入未读；已读最新不计');
  assert.equal(summary.active7dCount, 1, '仅窗口内 last_activity_at 计入活跃');
  assert.equal(summary.isDense, false, '3 份远低于高密阈值');

  // 高密判定（V04 调优为直接子文件 >= 15 份）
  const dense = summarizeFolderActivity({
    directFiles: Array.from({ length: SIDEBAR_DENSE_FOLDER_THRESHOLD }, (_, i) =>
      makeSidebarFile(`d_${i}`, 'dense')
    ),
    readingStates: {},
    artifactsByFileId: null,
    nowMs,
  });
  assert.equal(dense.isDense, true, '直接子文件 >= 15 份即判定为高密目录');
  assert.equal(SIDEBAR_DENSE_FOLDER_THRESHOLD, 15);

  // 活跃判定纯函数：窗口边界（7 天整点内算、7 天前一刻不算、非法/缺失诚实不算）
  assert.equal(
    isRecentActiveArtifact(makeArtifact('x', { last_activity_at: new Date(nowMs - 7 * 24 * 3600_000 + 1).toISOString() }), nowMs),
    true,
    '7 天整点内算活跃'
  );
  assert.equal(
    isRecentActiveArtifact(makeArtifact('x', { last_activity_at: new Date(nowMs - 7 * 24 * 3600_000 - 1).toISOString() }), nowMs),
    false,
    '7 天前一刻不算活跃'
  );
  assert.equal(
    isRecentActiveArtifact(makeArtifact('x', { last_activity_at: null }), nowMs),
    false,
    '缺失活动时间诚实不算活跃'
  );
  assert.equal(isRecentActiveArtifact(null, nowMs), false, '无 artifact 行诚实不算活跃');

  // 未读 id 集合与摘要同源（单一事实源，零漂移）
  const ids = collectUnreadFileIds(files, readingStates);
  assert.deepEqual([...ids].sort(), ['f_fresh', 'f_read']);
  assert.equal(ids.size, summary.unreadCount, '文件级未读集合与目录级未读计数同源');
});

test('U03 渲染：智能视图零值收折为末尾轻胶囊（其余 3 项 (0)），选中零值项恒可见不失踪', () => {
  const files = [makeSidebarFile('f_a', '01-方案文档'), makeSidebarFile('f_b', '01-方案文档')];
  const readingStates: Record<string, import('../src/types/guanlan').ReadingState> = {
    f_a: makeReadingState('f_a', 'rev_old_f_a'),
  };
  const artifactsByFileId = new Map<string, import('../src/services/apiTypes').ArtifactStateView>([
    ['f_b', makeArtifact('f_b')],
  ]);

  const render = (quickScope: 'all' | 'agent_drafts' = 'all') =>
    renderToString(
      createElement(LeftSidebar, {
        files,
        readingStates,
        activeFileId: 'f_a',
        filters: { quickScope, folder: 'all', format: 'all', role: 'all', topic: 'all' },
        onUpdateFilters: () => {},
        onResetFilters: () => {},
        onOpenFileToRead: () => {},
        artifactsByFileId,
      })
    );

  // ① 非零项（读后有更新 / 近 7 天活跃）横向舒展展示；零值三项收折为末尾胶囊
  const html = render();
  const text = html.replace(/<!-- -->/g, '');
  assert.ok(html.includes('data-smart-views'), '智能视图区仍在');
  assert.ok(html.includes('data-smart-views-collapsed'), '零值收折胶囊存在');
  assert.ok(text.includes('其余 3 项 (0)'), '收折胶囊文案逐字「其余 3 项 (0)」');
  assert.ok(
    /data-smart-views-collapsed=""[^>]*aria-expanded="false"/.test(html),
    '收折胶囊默认收起态（aria-expanded=false）'
  );
  // 非零项必显（各自带计数徽标）
  assert.ok(html.includes('data-smart-view="updated_after_read"'), '非零项一：读后有更新 必显');
  assert.ok(html.includes('data-smart-view="recent_active"'), '非零项二：近 7 天活跃 必显');
  // 零值项：DOM 内保留（SSR 可见文本不被删改）但默认 hidden（呈现层收折，不改计数口径）
  for (const id of ['awaiting_decision', 'agent_drafts', 'unassigned']) {
    assert.ok(html.includes(`data-smart-view="${id}"`), `零值项 ${id} 仍在 DOM 内（口径不变）`);
  }
  assert.ok(
    /<span hidden=""><button type="button" data-smart-view="awaiting_decision"/.test(html),
    '零值项默认 hidden 收折'
  );

  // ② 当前选中的零值项恒可见（不收折、不失踪）
  const activeHtml = render('agent_drafts');
  assert.ok(
    /data-smart-view="agent_drafts"[^>]*aria-pressed="true"/.test(activeHtml) ||
      /aria-pressed="true"[^>]*data-smart-view="agent_drafts"/.test(activeHtml),
    '选中的零值视图必须可见且处于激活态'
  );
  const activeText = activeHtml.replace(/<!-- -->/g, '');
  assert.ok(activeText.includes('其余 2 项 (0)'), '选中项移出折叠区后收折胶囊计数相应减一');
});

test('U03 渲染：高密目录视觉减噪——格式色点隐去、4px 温琥珀未读点、目录行尾未读数字与近 7 日活跃微点', () => {
  const denseFiles = Array.from({ length: SIDEBAR_DENSE_FOLDER_THRESHOLD + 4 }, (_, i) =>
    makeSidebarFile(`d_${i}`, '01-方案文档')
  );
  const sparseFiles = [makeSidebarFile('s_a', '02-评审'), makeSidebarFile('s_b', '02-评审')];
  const nodes = [
    {
      name: '01-方案文档',
      path: '01-方案文档',
      direct: denseFiles.length,
      total: denseFiles.length,
      isEmpty: false,
      directFiles: denseFiles,
      children: [],
    },
    {
      name: '02-评审',
      path: '02-评审',
      direct: sparseFiles.length,
      total: sparseFiles.length,
      isEmpty: false,
      directFiles: sparseFiles,
      children: [],
    },
  ];
  const nowMs = Date.now();
  const readingStates: Record<string, import('../src/types/guanlan').ReadingState> = {
    s_a: makeReadingState('s_a', 'rev_s_a'),
  };
  const artifactsByFileId = new Map<string, import('../src/services/apiTypes').ArtifactStateView>([
    ['d_0', makeArtifact('d_0', { last_activity_at: new Date(nowMs - 3600_000).toISOString() })],
  ]);
  const summaries = collectFolderActivitySummaries(nodes, {
    readingStates,
    artifactsByFileId,
    nowMs,
  });

  const html = renderToString(
    createElement(FolderTreeRows, {
      nodes: nodes as never,
      depth: 0,
      selected: 'all',
      activeFileId: 's_a',
      expanded: new Set(['01-方案文档', '02-评审']),
      onToggle: () => {},
      onSelect: () => {},
      onOpenFileToRead: () => {},
      folderActivity: summaries,
      unreadFileIds: collectUnreadFileIds([...denseFiles, ...sparseFiles], readingStates),
    })
  );

  // ① 高密目录：文件行不再渲染亮橙格式色点（根治百行橙点刷屏）
  const denseSection = html.slice(0, html.indexOf('02-评审'));
  assert.ok(!denseSection.includes('F76808'), '高密目录文件行零亮橙格式点');
  // 稀疏目录保留格式色点（低密目录观感不变）
  assert.ok(html.includes('F76808'), '稀疏目录仍保留格式色点');

  // ② 未读行渲染 4px 柔和温琥珀点（--accent-wave），静息降噪 + 悬浮提亮由动效类承担
  const unreadDots = (html.match(/data-sidebar-unread-dot/g) ?? []).length;
  assert.equal(unreadDots, denseFiles.length + 1, '未读文件（24 高密 + 1 稀疏）各一枚未读点');
  assert.ok(html.includes('glx-tree-unread-dot'), '未读点携带降噪动效类');
  assert.ok(html.includes('size-1 rounded-full shrink-0 bg-[color:var(--accent-wave)]'), '未读点为 4px 温琥珀');

  // ②b 高密目录：文件行挂「静置留白」标记（未读微点静息态隐去，悬浮/聚焦才浮现）
  assert.ok(html.includes('glx-tree-row-dense'), '高密目录文件行挂静息降噪标记');
  const motionCssU03 = readFileSync(
    fileURLToPath(new URL('../src/styles/motion.css', import.meta.url)),
    'utf8'
  );
  assert.ok(
    motionCssU03.includes('.glx-tree-row-dense .glx-tree-unread-dot'),
    'motion.css 声明高密目录静息态隐去未读微点'
  );

  // ③ 目录行尾：未读数字微标 + 近 7 日活跃微点
  assert.ok(html.includes(`data-folder-unread="${denseFiles.length}"`), '高密目录行尾显示未读数字');
  assert.ok(html.includes('data-folder-active-dot="1"'), '目录行尾显示近 7 日活跃微点');
  assert.ok(html.includes('text-[color:var(--accent-wave)]'), '未读数字走琥珀语义色（AA 达标）');
  assert.ok(html.includes('bg-[color:var(--accent-iris-deep)]'), '活跃微点走薰衣草深档（图形 ≥3:1）');

  // ④ 交错微过渡：稀疏目录行有入场动效类；高密目录整目录瞬时落位（不做数百行同帧淡入）
  assert.ok(html.includes('glx-tree-row-in'), '目录行携带展开交错微过渡类');
  assert.ok(html.includes('--glx-tree-idx'), '交错行序写入 --glx-tree-idx');
});

test('U03 多项目分支：同款减噪（高密隐格式点 / 待拍板数字微标 / 折叠箭头微过渡），无阅读基线不造未读数', () => {
  const denseFiles = Array.from({ length: SIDEBAR_DENSE_FOLDER_THRESHOLD + 3 }, (_, i) => ({
    file_id: `p_${i}`,
    relative_path: `specs/p_${i}.md`,
    title: `p_${i}`,
    format: 'md',
    folder: 'specs',
    current_revision_id: `pr_${i}`,
    updated_at: '2026-11-22T02:00:00Z',
    revision_count: 1,
    pending_decisions: i === 0 ? 2 : 0,
  }));
  const sparseFiles = [
    {
      file_id: 'q_0',
      relative_path: 'notes/q_0.md',
      title: 'q_0',
      format: 'md',
      folder: 'notes',
      current_revision_id: 'qr_0',
      updated_at: '2026-11-22T02:00:00Z',
      revision_count: 1,
      pending_decisions: 1,
    },
  ];
  const project = {
    project_id: 'proj_u03',
    name: '项目 U03',
    root_path: 'H:\\u03',
    readonly: false,
    is_active: false,
    status: 'ready',
    file_count: denseFiles.length + sparseFiles.length,
    folder_count: 2,
    pending_decisions_count: 3,
    index_generation: 1,
    is_scanning: false,
    added_at: '2026-11-22T01:00:00Z',
    last_opened_at: '2026-11-22T02:00:00Z',
  } as unknown as import('../src/services/apiTypes').ProjectEntryDto;

  const html = renderToString(
    createElement(ProjectTreeBranch, {
      project,
      cache: {
        loading: false,
        data: {
          ok: true,
          project_id: 'proj_u03',
          name: '项目 U03',
          root_path: 'H:\\u03',
          readonly: false,
          is_active: false,
          status: 'ready',
          total: denseFiles.length + sparseFiles.length,
          truncated: false,
          folders: ['specs', 'notes'],
          files: [...denseFiles, ...sparseFiles],
        },
      } as never,
      inlineCreate: null,
      inlineCreateBusy: false,
      onOpenFolder: () => {},
      onOpenFile: () => {},
    })
  );

  // ① 折叠箭头微过渡（glx-chevron-rot + data-open），展开/收起不再硬切
  assert.ok(html.includes('glx-chevron-rot'), '多项目分支折叠箭头接入弹簧旋转类');
  assert.ok(html.includes('data-open="false"'), '折叠箭头携带展开态');

  // ② 高密目录隐去亮橙格式点；稀疏目录保留（直接渲染目录行/文件行断言）
  const branchHtml = renderToString(
    createElement(BranchFolderRows, {
      project,
      nodes: [
        {
          name: 'specs',
          path: 'specs',
          total: denseFiles.length,
          isEmpty: false,
          directFiles: denseFiles,
          children: [],
        },
        {
          name: 'notes',
          path: 'notes',
          total: sparseFiles.length,
          isEmpty: false,
          directFiles: sparseFiles,
          children: [],
        },
      ] as never,
      depth: 0,
      expanded: new Set(['specs', 'notes']),
      onToggleDir: () => {},
      inlineCreate: null,
      inlineCreateBusy: false,
      onOpenFolder: () => {},
      onOpenFile: () => {},
    })
  );
  const denseSection = branchHtml.slice(0, branchHtml.indexOf('notes'));
  assert.ok(!denseSection.includes('F76808'), '高密目录文件行零亮橙格式点');
  assert.ok(branchHtml.includes('F76808'), '稀疏目录仍保留格式色点');

  // ③ 目录行尾待拍板数字微标（数据源＝DTO 真有的 pending_decisions）
  assert.ok(branchHtml.includes('data-project-folder-pending="2"'), '高密目录行尾待拍板数字微标');
  assert.ok(branchHtml.includes('glx-tree-pending-dot'), '待拍板点为 4px 降噪微点');

  // ④ 诚实边界：多项目分支无阅读基线 → 绝不渲染未读口径（零造数）
  assert.ok(!branchHtml.includes('data-sidebar-unread-dot'), '多项目分支不得伪造未读点');
  assert.ok(!branchHtml.includes('data-folder-unread'), '多项目分支不得伪造未读数');
});

test('U03 动效契约：新增树动效只动 transform/opacity、只消费令牌时长、reduced-motion 逐类登记', () => {
  const motionCss = readFileSync(
    fileURLToPath(new URL('../src/styles/motion.css', import.meta.url)),
    'utf8'
  );
  const reduceSection = motionCss.slice(motionCss.indexOf('@media (prefers-reduced-motion: reduce)'));

  // ① 四个新增类必须「声明 + reduce 覆盖」双登记
  for (const cls of [
    '.glx-tree-row-in',
    '.glx-tree-unread-dot',
    '.glx-tree-pending-dot',
    '.glx-tree-row-dense',
    '.glx-scroll-slim',
  ]) {
    assert.ok(motionCss.includes(cls), `motion.css 应声明 ${cls}`);
    assert.ok(reduceSection.includes(cls), `prefers-reduced-motion 应降级 ${cls}`);
  }

  // ② 目录行入场：纯 opacity（禁位移/尺寸动画）+ 令牌时长
  const rowInStart = motionCss.indexOf('.glx-tree-row-in {');
  assert.ok(rowInStart >= 0, 'motion.css 应声明 .glx-tree-row-in');
  const rowInBlock = motionCss.slice(rowInStart, motionCss.indexOf('}', rowInStart));
  assert.ok(rowInBlock.includes('var(--dur-1)'), '入场时长只消费 --dur-1 令牌');
  assert.ok(rowInBlock.includes('var(--ease-fade)'), '入场缓动只消费 --ease-fade');
  assert.ok(!rowInBlock.includes('will-change'), '禁新增常驻 will-change');
  assert.ok(!/\b(width|height|top|left)\b/.test(rowInBlock), '禁动画布局属性');
  const keyframes = motionCss.slice(
    motionCss.indexOf('@keyframes glx-tree-row-in'),
    motionCss.indexOf('@keyframes glx-tree-row-in') + 260
  );
  assert.ok(keyframes.includes('opacity'), '入场关键帧只走 opacity');
  assert.ok(!/transform|translate|width|height/.test(keyframes), '入场关键帧禁位移（数据区禁飞精神）');

  // ③ 未读/待拍板微点：只过渡 opacity + transform
  const dotStart = motionCss.indexOf('.glx-tree-unread-dot,');
  const dotBlock = motionCss.slice(dotStart, motionCss.indexOf('}', dotStart));
  assert.ok(dotBlock.includes('opacity') && dotBlock.includes('transform'), '微点过渡只动 opacity/transform');
  assert.ok(!/\b(width|height|top|left)\b/.test(dotBlock), '微点禁过渡布局属性');
  assert.ok(dotBlock.includes('var(--dur-1)') && dotBlock.includes('var(--dur-2)'), '微点时长只用令牌');
  assert.ok(!dotBlock.includes('will-change'), '微点禁新增常驻 will-change');
  // 静息透明度不得跌破图形 3:1 阈（复合到侧栏行底后仍 ≥3:1）
  assert.ok(dotBlock.includes('opacity: 0.75'), '静息透明度锁定 0.75（4px 微点不跌破 3:1）');

  // ④ 滚动条隐身：纯外观类，reduce 下撤过渡但静态外观不变
  const scrollStart = motionCss.indexOf('.glx-scroll-slim {');
  assert.ok(scrollStart >= 0, 'motion.css 应声明 .glx-scroll-slim');
  const scrollBlock = motionCss.slice(scrollStart, motionCss.indexOf('}', scrollStart));
  assert.ok(scrollBlock.includes('scrollbar-width: thin'), '滚动条走细滚动条口径');
  assert.ok(!scrollBlock.includes('will-change'), '滚动条类禁新增常驻 will-change');

  // ⑤ 源码契约：近 7 日活跃只消费 smartViews 的 RECENT_ACTIVE_WINDOW_MS（禁另起窗口口径）
  const sidebarSrc = readFileSync(
    fileURLToPath(new URL('../src/components/LeftSidebar.tsx', import.meta.url)),
    'utf8'
  );
  assert.ok(sidebarSrc.includes('RECENT_ACTIVE_WINDOW_MS'), '活跃窗口常量取自 smartViews 单一出口');
  assert.ok(
    !/7\s*\*\s*24\s*\*\s*60\s*\*\s*1000/.test(sidebarSrc),
    '禁止在侧栏另立 7 天窗口常量（防两套口径漂移）'
  );
  assert.ok(sidebarSrc.includes('last_activity_at'), '活跃判定数据源＝服务端 last_activity_at');
});
