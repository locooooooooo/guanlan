import React, { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Compass, Search, X } from 'lucide-react';
import type { FileRecord, TimelineEvent, FileFormat } from '../types/guanlan';
import { localDay } from '../utils/timeFormat';
import { basenameOf, groupByIdentity, minimalDirPrefix } from '../utils/documentIdentity';
import { Button, Chip } from './ui/primitives';
import {
  CALENDAR_ROW_SLICE_STEP,
  CALENDAR_ROW_SLICE_THRESHOLD,
  computeChunkedListSlice,
} from '../utils/virtualSlice';
import {
  Badge,
  CardFrame,
  CardFrameFooter,
  CardFrameHeader,
  Popover,
  PopoverPrimitive,
  ScrollArea,
  SegmentedControl,
  SegmentedControlItem,
  Toolbar,
  ToolbarGroup,
  ToolbarSeparator,
} from './ui';
import type { DesktopFileActionCallbacks } from './FileContextMenu';
import {
  classifyAssetDomain,
  countAssetsByDomain,
  filterAssetsByDomain,
  getCalendarFormatColor,
  type AssetDomainFilter,
} from '../utils/formatMeta';

export { classifyAssetDomain, countAssetsByDomain, filterAssetsByDomain, type AssetDomainFilter };

export interface CalendarBoardViewProps {
  files: FileRecord[];
  events: TimelineEvent[];
  onOpenDocument: (fileId: string) => void;
  initialWindowDays?: number;
  systemActions?: DesktopFileActionCallbacks;
  focusedDate?: string | null;
  hoveredDate?: string | null;
  onFocusDate?: (date: string | null) => void;
  onHoverDate?: (date: string | null) => void;
  onJumpToStarMap?: (date: string) => void;
  compactMode?: 'auto' | 'on' | 'off';
}


/** 极近焦窗口：最近 7 个日历日（高密工程逐日细审）。 */
export const CALENDAR_WINDOW_WEEK = 7;
/** 双周窗口：最近 14 个日历日（冲刺迭代回望）。 */
export const CALENDAR_WINDOW_FORTNIGHT = 14;
/**
 * 宽窗口（可切换档）：最近 90 个「有数据」的日历日。
 * 注意：这是 calendarWindow 纯函数与「近 90 天」按钮的档位常量；
 * 组件的初始默认档走 CALENDAR_WINDOW_SHORT（30 天），二者不同值，勿混用。
 */
export const CALENDAR_WINDOW_DEFAULT = 90;
/** 紧凑窗口（组件默认档）：最近 30 个日历日。 */
export const CALENDAR_WINDOW_SHORT = 30;
/** 顶部 SegmentedControl 四档顺序（近 7 / 14 / 30 / 90 天）。 */
export const CALENDAR_WINDOW_OPTIONS = [
  CALENDAR_WINDOW_WEEK,
  CALENDAR_WINDOW_FORTNIGHT,
  CALENDAR_WINDOW_SHORT,
  CALENDAR_WINDOW_DEFAULT,
] as const;

/**
 * sticky 日期表头的高度单源化（防止锚点滚动时表头压住目标行）。
 * 若表头高度仅靠子节点 h-8（32px）与 1px border-bottom 隐式撑出，锚点滚动
 * （查找定位/焦点滚动/跳日期）会把 48px 目标行落进 33px 表头之下压掉半行。
 * 常量置顶后，表头显式 height 与行 scroll-margin-top 同源取值
 * （供 data-cal-sticky-header / data-cal-row 锚点断言核对）。
 */
export const CALENDAR_STICKY_HEADER_H = 32;
/** 行的 scroll-margin-top = 表头内容高 32 + 表头 border-bottom 1：锚点落点让出整条表头。 */
export const CALENDAR_ROW_SCROLL_MARGIN = CALENDAR_STICKY_HEADER_H + 1;

/** 「历史/更早」聚合槽：窗口起点之前的全部日期。 */
export interface CalendarOlderSlot {
  count: number;
  minDate: string;
  maxDate: string;
}

export interface CalendarWindowResult {
  windowDays: string[];
  start: string | null;
  end: string | null;
  activeDays: string[];
  olderSlot: CalendarOlderSlot | null;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function dayMsOf(day: string): number | null {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00`);
  return Number.isFinite(ms) ? ms : null;
}

function fmtDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 纯日期平移（setDate 逐日推进，跨月/跨年/夏令时均不漂移）。非法日期返回 null。 */
export function shiftCalendarDay(day: string, delta: number): string | null {
  const ms = dayMsOf(day);
  if (ms === null) return null;
  const d = new Date(ms);
  d.setDate(d.getDate() + delta);
  return fmtDay(d);
}

/**
 * 把日期轴截断为「最近 windowDays 天窗口 + 1 个『历史/更早』聚合槽」。
 *
 * 避免早期异常文件时间戳拉长全局时间跨度导致主轴被压成细线和 DOM 膨胀。
 *
 * 口径（改动时不得破坏）：
 * - 输入只接受 `YYYY-MM-DD` 纯日期（调用方已用 localDay 归一；observed_at 是采集时间，禁入）；
 * - 窗口**锚在数据的最后一天**（不锚 today）：这样「最近 90 天」永远落在真实活跃区，
 *   陈旧工作区也不会渲染 90 列空白天；today 是否落在窗口内由调用方另行判断；
 * - 窗口是**连续日历日**（供主轴算列宽/刻度），窗口外的一律进 olderSlot（按日期去重计数）。
 *
 * @param days       全部有数据的日期（可重复、可乱序、可含非法值，本函数负责清洗）
 * @param windowDays 窗口天数（默认 90；非有限值按 90，<1 收敛为 1 天）
 * @param endDate    可选窗口末日（默认 = 数据最后一天；早于数据最后一天时忽略，避免把未来日塞进历史槽）
 */
export function calendarWindow(
  days: string[],
  windowDays: number = CALENDAR_WINDOW_DEFAULT,
  endDate?: string
): CalendarWindowResult {
  const span = Math.max(
    1,
    Math.floor(Number.isFinite(windowDays) ? windowDays : CALENDAR_WINDOW_DEFAULT)
  );

  const seen = new Set<string>();
  const valid: string[] = [];
  for (const raw of days) {
    if (typeof raw !== 'string' || dayMsOf(raw) === null || seen.has(raw)) continue;
    seen.add(raw);
    valid.push(raw);
  }
  valid.sort();

  if (valid.length === 0) {
    return { windowDays: [], start: null, end: null, activeDays: [], olderSlot: null };
  }

  const dataMax = valid[valid.length - 1];
  const end =
    typeof endDate === 'string' && dayMsOf(endDate) !== null && endDate >= dataMax
      ? endDate
      : dataMax;
  const start = shiftCalendarDay(end, -(span - 1)) as string;

  const columns: string[] = [];
  let cursor: string | null = start;
  while (cursor !== null && cursor <= end) {
    columns.push(cursor);
    if (columns.length > span + 1) break;
    cursor = shiftCalendarDay(cursor, 1);
  }

  const activeDays = valid.filter((d) => d >= start && d <= end);
  const older = valid.filter((d) => d < start);
  const olderSlot: CalendarOlderSlot | null =
    older.length > 0
      ? { count: older.length, minDate: older[0], maxDate: older[older.length - 1] }
      : null;

  return { windowDays: columns, start, end, activeDays, olderSlot };
}


/**
 * 同槽可见 pill 上限。超过上限的文档若叠在同位互相覆盖会导致完全不可点；
 * 第 4 份起改由「+N」聚合芯片承载入口，槽内不再有不可点文档。
 */
export const SLOT_PILL_LIMIT = 3;

/**
 * 芯片文案口径（单测校验同一口径）：N = 该槽总份数（实际总数），不是剩余数——
 * 7 份的槽显示「+7」，读者一眼知道这个日期下共 7 份，而不是「还有 4 份没看到」。
 */
export function formatSlotChipLabel(slotTotal: number): string {
  return `+${slotTotal}`;
}

/**
 * 槽渲染拆分（纯函数）：≤3 份全部直渲染（不出芯片）；
 * >3 份取前 3 枚 pill，chipTotal = 该槽总份数（供芯片文案与清单条数校验）。
 */
export function splitSlotForRender<T>(items: T[]): { pills: T[]; chipTotal: number | null } {
  if (items.length <= SLOT_PILL_LIMIT) return { pills: items, chipTotal: null };
  return { pills: items.slice(0, SLOT_PILL_LIMIT), chipTotal: items.length };
}

/**
 * 近 90 天宽窗档下，同槽 >3 份的「+N」长文字芯片（约 34px 宽）在 90 列轴上远超单日列宽（<10px），
 * 会与邻槽重叠互相遮点。该档改用实心小圆点，以 --accent-iris 混色比例与直径微调映射数量，
 * 具体数字收进 hover Tooltip（title）与 aria-label。
 * count ≤ SLOT_PILL_LIMIT 不会到达此处（splitSlotForRender 不出芯片），仍兜底返回最低档保持全域定义。
 */
export function slotHeatDotTier(count: number): { mixPct: number; size: number } {
  if (count >= 100) return { mixPct: 100, size: 14 };
  if (count >= 30) return { mixPct: 70, size: 12 };
  if (count >= 10) return { mixPct: 45, size: 10 };
  return { mixPct: 25, size: 8 };
}

/**
 * 30 天紧凑窗下的碰撞检测（纯函数，单测覆盖）：
 * 当某目录行内同槽 >3 份（需渲染聚合入口）且 2 日内存在其他活跃槽位时，
 * 「3 枚 14px pill + marginLeft:16 的 +N 宽芯片」总宽约 56px，在 18~24px 日列上会与邻槽撞字；
 * 命中碰撞集合的槽位改为「单列居中紧凑热力数字格」（绝不外溢到邻列），孤立槽位则保持原 3 pill + +N 形态。
 */
export function findCrowdedCalendarSlots<T>(
  datedEntries: ReadonlyArray<readonly [string, ReadonlyArray<T>]>,
  dayIdxOf: (date: string) => number
): { crowdedChips: Set<string>; adjacentSparse: Set<string> } {
  const crowdedChips = new Set<string>();
  const adjacentSparse = new Set<string>();
  if (datedEntries.length <= 1) return { crowdedChips, adjacentSparse };
  const indexed = datedEntries.map(([date, items]) => ({
    date,
    idx: dayIdxOf(date),
    count: items.length,
  }));
  for (let i = 0; i < indexed.length; i += 1) {
    const cur = indexed[i];
    let hasNearbyWithin2 = false;
    let hasImmediateNeighbor = false;
    for (let j = 0; j < indexed.length; j += 1) {
      if (i === j) continue;
      const dist = Math.abs(indexed[j].idx - cur.idx);
      if (dist <= 2) hasNearbyWithin2 = true;
      if (dist <= 1) hasImmediateNeighbor = true;
    }
    if (cur.count > SLOT_PILL_LIMIT && hasNearbyWithin2) {
      crowdedChips.add(cur.date);
    } else if (cur.count <= SLOT_PILL_LIMIT && hasImmediateNeighbor) {
      adjacentSparse.add(cur.date);
    }
  }
  return { crowdedChips, adjacentSparse };
}

/** 单列紧凑热力格文案：≤99 直显数字，≥100 收束为 99+（完整数字进 title/aria-label，绝不撑破日列）。 */
export function formatCompactSlotCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/** 无重叠容纳「3 枚 pill + 『+N』聚合芯片」所需的最小单列像素宽（px）。 */
export const CALENDAR_SLOT_PILLS_CHIP_MIN_PX = 58;
/** 极窄宽窗（如 90 天等距列宽 ≤13px）退化为实心热力圆点的像素阈值（px）。 */
export const CALENDAR_SLOT_HEAT_DOT_MAX_PX = 13;

export type CalendarSlotRenderMode =
  | 'pills'
  | 'pills_with_chip'
  | 'compact_heat'
  | 'heat_dot';

/**
 * 日历槽位自适应零碰撞渲染判定（纯函数，单测锁定）：
 * - ≤ 3 份：独立文档胶囊 `pills`；
 * - > 3 份且单列极窄（≤ 13px，如 90 天宽窗）：实心热力圆点 `heat_dot`；
 * - > 3 份且（2 日内有邻槽 且 单列宽 < 58px，不足以无重叠容纳 3 圆 +「+N」；或列宽 < 18px）：
 *   确定性退化为居中热力数字格 `compact_heat`（7 / 36 / 99+），避免连续高密日撞车；
 * - 其余（宽列如近 7 天、或前后 2 日无邻槽的孤立槽）：保留 3 圆 +「+N」`pills_with_chip`。
 */
export function resolveCalendarSlotMode(
  slotPxWidth: number,
  itemsCount: number,
  hasNeighborWithin2Days: boolean
): CalendarSlotRenderMode {
  if (itemsCount <= SLOT_PILL_LIMIT) return 'pills';
  const px = Number.isFinite(slotPxWidth) && slotPxWidth > 0 ? slotPxWidth : 22;
  if (px <= CALENDAR_SLOT_HEAT_DOT_MAX_PX) return 'heat_dot';
  if (hasNeighborWithin2Days && px < CALENDAR_SLOT_PILLS_CHIP_MIN_PX) {
    return 'compact_heat';
  }
  if (px < 18) return 'compact_heat';
  return 'pills_with_chip';
}

/**
 * 构建窗口内「时光累积沉淀」微缩折线路径（纯函数，单测覆盖）：
 * 将每日文档/变动计数沿时间自左→右单调累加，输出 SVG polyline 与 area 路径，
 * 直观传达「时间流逝 → 文档一点一点累积」。
 */
export function buildDailyAccumulationSparkline(
  columns: readonly string[],
  countsByDate: ReadonlyMap<string, number>,
  width = 92,
  height = 20
): { linePath: string; areaPath: string; total: number } {
  if (columns.length === 0) return { linePath: '', areaPath: '', total: 0 };
  const cumulative: number[] = [];
  let running = 0;
  for (const d of columns) {
    running += Math.max(0, countsByDate.get(d) ?? 0);
    cumulative.push(running);
  }
  const maxVal = Math.max(1, running);
  const padY = 2.5;
  const usableH = Math.max(4, height - padY * 2);
  const denom = Math.max(1, columns.length - 1);
  const coords = cumulative.map((val, idx) => {
    const x = Number(((idx / denom) * width).toFixed(1));
    const y = Number((height - padY - (val / maxVal) * usableH).toFixed(1));
    return { x, y };
  });
  const linePath = coords.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
  const areaPath = `${linePath} L${width} ${height} L0 ${height} Z`;
  return { linePath, areaPath, total: running };
}


/**
 * 弹层与触发格之间的「呼吸间距」（px）。
 * 向右展开 = 触发格右缘 + GAP；向左展开 = 触发格左缘 − GAP（popLeft + popWidth ≤ anchorLeft − 8）。
 */
export const CALENDAR_POPOVER_GAP = 8;
/** 弹层贴视口边缘时保留的最小留白（px）。 */
export const CALENDAR_POPOVER_MARGIN = 12;
/**
 * 右侧「当日沉淀聚焦卡 / 最近 7 天」侧栏的安全占位宽度：
 * CalendarSidePanels.tsx:217 的 <aside class="w-[276px] … pr-3.5">——Tailwind 默认 border-box，
 * 276px 已含 14px 右内边距，故侧栏左缘 = 视口宽 − 276（1440 实测 aside.left = 1164）；
 * 本常量再让出 14px 呼吸余量 → 弹层右缘恒 ≤ 视口宽 − 290，零压盖聚焦卡与最近 7 天。
 */
export const CALENDAR_SIDE_PANEL_W = 290;

/** 当日清单弹层尺寸（须与 SlotDayList 的 w-[280px] / max-h-[320px] 逐字保持一致）。 */
export const SLOT_DAY_LIST_POPOVER_W = 280;
export const SLOT_DAY_LIST_POPOVER_H = 320;
/** 更早清单弹层尺寸（须与 OlderSlotList 的 w-[256px] / max-h-[280px] 逐字保持一致）。 */
export const OLDER_LIST_POPOVER_W = 256;
export const OLDER_LIST_POPOVER_H = 280;

/** 触发格在视口中的矩形（getBoundingClientRect 的四边，viewport 坐标）。 */
export interface CalendarPopoverAnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** 弹层自身尺寸（px）。 */
export interface CalendarPopoverSize {
  width: number;
  height: number;
}

/** 视口尺寸（px）。 */
export interface CalendarPopoverViewport {
  width: number;
  height: number;
}

export interface CalendarPopoverPos {
  left: number;
  top: number;
  side: 'left' | 'right';
  flipped: boolean;
}

/**
 * 侧栏安全右界：弹层右缘不得越过此 x（= 右侧「当日沉淀聚焦卡 / 最近 7 天」的左缘）。
 * 视口宽度非法时返回 0（= 不设侧栏约束，交由调用方兜底为整幅视口）。
 */
export function calendarSidePanelSafeRight(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return 0;
  return Math.max(CALENDAR_POPOVER_MARGIN, viewportWidth - CALENDAR_SIDE_PANEL_W);
}

/**
 * 日历 Portal 弹层的智能避让定位（纯函数，无 DOM 依赖，可单测）。
 *
 * 避免弹层恒向右展开而盖住右侧「当日沉淀聚焦卡 / 最近 7 天」侧栏安全界（视口宽减 290）。
 *
 * 规则（顺序即优先级）：
 * 1. 锚点中心落在视口右半区 → **向左展开**（右半区锚点 100% 落在触发格左侧）；
 * 2. 向右展开会越过侧栏安全界（距离右侧栏不足弹层宽度）→ **向左展开**；
 * 3. 向左展开时左侧空间不足 → 回退向右（前提是右向仍不越安全界）；
 * 4. 硬约束：弹层右缘 ≤ 侧栏安全界、左缘 ≥ 视口左留白（永不横向溢出）；
 * 5. 纵向：默认锚点下方展开；下方不足则上翻到锚点上方；仍不足则贴视口底收口。
 *
 * 不变量（右半区且空间允许时）：popLeft + popWidth === anchorLeft − CALENDAR_POPOVER_GAP。
 */
export function computeCalendarPopoverPos(
  anchorRect: CalendarPopoverAnchorRect,
  popoverSize: CalendarPopoverSize,
  viewport: CalendarPopoverViewport,
  sidePanelSafeRight: number
): CalendarPopoverPos {
  const vw = Math.max(1, Math.floor(viewport.width) || 1);
  const vh = Math.max(1, Math.floor(viewport.height) || 1);
  const pw = Math.max(0, Math.floor(popoverSize.width) || 0);
  const ph = Math.max(0, Math.floor(popoverSize.height) || 0);
  const safeRight =
    Number.isFinite(sidePanelSafeRight) && sidePanelSafeRight > 0
      ? Math.min(vw, sidePanelSafeRight)
      : vw;

  const anchorLeft = Math.min(anchorRect.left, anchorRect.right);
  const anchorRight = Math.max(anchorRect.left, anchorRect.right);
  const anchorTop = Math.min(anchorRect.top, anchorRect.bottom);
  const anchorBottom = Math.max(anchorRect.top, anchorRect.bottom);
  const anchorCenterX = (anchorLeft + anchorRight) / 2;

  const rightLeft = anchorRight + CALENDAR_POPOVER_GAP;
  const rightFits = rightLeft + pw <= safeRight;
  const inRightHalf = anchorCenterX >= vw / 2;
  const preferLeft = inRightHalf || !rightFits;

  const leftLeft = anchorLeft - CALENDAR_POPOVER_GAP - pw;
  let side: 'left' | 'right' = preferLeft ? 'left' : 'right';
  let left = side === 'left' ? leftLeft : rightLeft;

  if (side === 'left' && leftLeft < CALENDAR_POPOVER_MARGIN && rightFits) {
    side = 'right';
    left = rightLeft;
  }

  const maxLeft = Math.max(CALENDAR_POPOVER_MARGIN, safeRight - pw);
  left = Math.min(Math.max(left, CALENDAR_POPOVER_MARGIN), maxLeft);

  let top = anchorBottom + CALENDAR_POPOVER_GAP;
  if (top + ph > vh - CALENDAR_POPOVER_MARGIN) {
    const above = anchorTop - CALENDAR_POPOVER_GAP - ph;
    top =
      above >= CALENDAR_POPOVER_MARGIN
        ? above
        : Math.max(CALENDAR_POPOVER_MARGIN, vh - CALENDAR_POPOVER_MARGIN - ph);
  }
  top = Math.max(CALENDAR_POPOVER_MARGIN, top);

  return { left: Math.floor(left), top: Math.floor(top), side, flipped: side === 'left' };
}

/**
 * 触发格矩形：DOMRect → 纯四边（只取布局需要的最小信息面，便于单测构造）。
 * 左右/上下偶有颠倒时按几何真值归一，保证下游避让计算的输入恒为合法矩形。
 */
export function anchorRectOf(rect: {
  left: number;
  right: number;
  top: number;
  bottom: number;
}): CalendarPopoverAnchorRect {
  return {
    left: Math.min(rect.left, rect.right),
    right: Math.max(rect.left, rect.right),
    top: Math.min(rect.top, rect.bottom),
    bottom: Math.max(rect.top, rect.bottom),
  };
}

function legacyAnchorRect(left?: number, top?: number): CalendarPopoverAnchorRect {
  const cx = Number.isFinite(left) ? (left as number) : 0;
  const by = Number.isFinite(top) ? (top as number) : 0;
  return { left: cx - 8, right: cx + 8, top: by - 12, bottom: by };
}


/**
 * 断层槽最小折叠长度：连续空日 ≥ 5 天才折为「空 N 天」断层槽。
 * 更短的空白段折了反而丢时间分辨率（且断层噪音大于收益），一律保留逐日列。
 */
export const CALENDAR_COMPACT_MIN_GAP_DAYS = 5;

/**
 * 空日占比阈值：窗口内空日 ≥ 30% 才值得提供「紧凑活跃」开关。
 * 整段都活跃时压缩只会徒增断层噪音（智能识别的下限）。
 */
export const CALENDAR_COMPACT_MIN_EMPTY_RATIO = 0.3;

/**
 * 断层槽在轴上的权重（相对一个活跃日）。< 1 即「压缩」：
 * 一段 5 天空档折成 0.6 列宽，把横向空间让给近期连续活跃日。
 */
export const CALENDAR_COMPACT_GAP_WEIGHT = 0.6;

/** 轴上的一列：活跃日槽，或被折叠的连续空白段（断层槽）。 */
export interface CalendarAxisSlot {
  kind: 'day' | 'gap';
  date: string;
  endDate: string;
  span: number;
  weight: number;
  startPct: number;
  endPct: number;
  centerPct: number;
  widthShare: number;
}

/** 轴布局：等距（equal）与紧凑活跃（compact）共用的槽位模型。 */
export interface CalendarAxisLayout {
  mode: 'equal' | 'compact';
  slots: CalendarAxisSlot[];
  gaps: CalendarAxisSlot[];
  activeDays: string[];
  foldedDays: number;
  emptyRatio: number;
  maxEmptyRun: number;
  canCompact: boolean;
  slotIndexByDate: Record<string, number>;
  slotCount: number;
}

function normalizeAxisDays(days: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of days) {
    if (typeof raw !== 'string' || dayMsOf(raw) === null || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  out.sort();
  return out;
}

function axisEmptyStats(days: readonly string[], active: ReadonlySet<string>) {
  let emptyDays = 0;
  let maxEmptyRun = 0;
  let run = 0;
  for (const d of days) {
    if (active.has(d)) {
      run = 0;
      continue;
    }
    emptyDays += 1;
    run += 1;
    if (run > maxEmptyRun) maxEmptyRun = run;
  }
  return {
    emptyDays,
    emptyRatio: days.length > 0 ? emptyDays / days.length : 0,
    maxEmptyRun,
  };
}

/**
 * 等距布局（compact 关闭时的唯一形态）：每个日历日一列，权重恒 1。
 *
 * 槽中心百分比 = (i + 0.5) / 总列数 × 100，保证等距模式的像素位置稳定不变。
 */
export function buildEqualCalendarSlots(
  days: readonly string[],
  activeDaySet: ReadonlySet<string> | readonly string[] = []
): CalendarAxisLayout {
  const axisDays = normalizeAxisDays(days);
  const active = activeDaySet instanceof Set ? activeDaySet : new Set(activeDaySet);
  const total = axisDays.length;
  const slots: CalendarAxisSlot[] = axisDays.map((d, i) => ({
    kind: 'day' as const,
    date: d,
    endDate: d,
    span: 1,
    weight: 1,
    startPct: total > 0 ? (i / total) * 100 : 0,
    endPct: total > 0 ? ((i + 1) / total) * 100 : 0,
    centerPct: total > 0 ? ((i + 0.5) / total) * 100 : 0,
    widthShare: total > 0 ? 1 / total : 0,
  }));
  const slotIndexByDate: Record<string, number> = {};
  axisDays.forEach((d, i) => {
    slotIndexByDate[d] = i;
  });
  const stats = axisEmptyStats(axisDays, active);
  return {
    mode: 'equal',
    slots,
    gaps: [],
    activeDays: axisDays.filter((d) => active.has(d)),
    foldedDays: 0,
    emptyRatio: stats.emptyRatio,
    maxEmptyRun: stats.maxEmptyRun,
    canCompact:
      stats.emptyRatio >= CALENDAR_COMPACT_MIN_EMPTY_RATIO &&
      stats.maxEmptyRun >= CALENDAR_COMPACT_MIN_GAP_DAYS,
    slotIndexByDate,
    slotCount: slots.length,
  };
}

/**
 * 紧凑活跃布局（纯函数，无 DOM 依赖，可单测）。
 *
 * 做什么：把窗口内**连续 ≥ minGapDays 天的空白段**折为 1 个断层槽（「空 N 天」），
 * 其余活跃日各占一列；断层槽权重 < 1，故空白段被真实压缩，横向空间让给活跃日。
 *
 * 口径（改动时不得破坏）：
 * - 折叠的「天」是**真实日历天数**（不是列数）：断层 span = 该段连续空日的实际条数；
 * - 活跃日的顺序与集合 100% 守恒：每一个有数据的日期都在输出里出现且仅出现一次，
 *   断层的每个日期仍可经 slotIndexByDate 反查（日期零丢失）；
 * - 短于 minGapDays 的空白段**不折**（保留逐日列，避免丢时间分辨率）；
 * - 等距模式的对偶体是 buildEqualCalendarSlots（同样返回同一套槽位模型）。
 */
export function buildCompactCalendarSlots(
  days: readonly string[],
  activeDaySet: ReadonlySet<string> | readonly string[],
  options: {
    minGapDays?: number;
    gapWeight?: number;
    minEmptyRatio?: number;
  } = {}
): CalendarAxisLayout {
  const minGapDays = Math.max(
    1,
    Math.floor(options.minGapDays ?? CALENDAR_COMPACT_MIN_GAP_DAYS)
  );
  const gapWeight = options.gapWeight ?? CALENDAR_COMPACT_GAP_WEIGHT;
  const minEmptyRatio = options.minEmptyRatio ?? CALENDAR_COMPACT_MIN_EMPTY_RATIO;

  const axisDays = normalizeAxisDays(days);
  const active = activeDaySet instanceof Set ? activeDaySet : new Set(activeDaySet);
  const kept = new Set(axisDays.filter((d) => active.has(d)));

  type RawSlot = {
    kind: 'day' | 'gap';
    date: string;
    endDate: string;
    span: number;
    weight: number;
  };
  const raw: RawSlot[] = [];
  let emptyRun: string[] = [];
  const flushEmptyRun = () => {
    if (emptyRun.length === 0) return;
    if (emptyRun.length >= minGapDays) {
      raw.push({
        kind: 'gap',
        date: emptyRun[0],
        endDate: emptyRun[emptyRun.length - 1],
        span: emptyRun.length,
        weight: gapWeight,
      });
    } else {
      for (const d of emptyRun) {
        raw.push({ kind: 'day', date: d, endDate: d, span: 1, weight: 1 });
      }
    }
    emptyRun = [];
  };
  for (const d of axisDays) {
    if (kept.has(d)) {
      flushEmptyRun();
      raw.push({ kind: 'day', date: d, endDate: d, span: 1, weight: 1 });
    } else {
      emptyRun.push(d);
    }
  }
  flushEmptyRun();

  const totalWeight = raw.reduce((sum, r) => sum + r.weight, 0);
  const denom = totalWeight > 0 ? totalWeight : 1;
  let acc = 0;
  const slots: CalendarAxisSlot[] = raw.map((r) => {
    const startPct = (acc / denom) * 100;
    acc += r.weight;
    const endPct = (acc / denom) * 100;
    return {
      ...r,
      startPct,
      endPct,
      centerPct: (startPct + endPct) / 2,
      widthShare: r.weight / denom,
    };
  });

  const slotIndexByDate: Record<string, number> = {};
  slots.forEach((s, i) => {
    if (s.kind === 'day') {
      slotIndexByDate[s.date] = i;
      return;
    }
    let cur: string | null = s.date;
    for (let k = 0; k < s.span && cur !== null; k += 1) {
      slotIndexByDate[cur] = i;
      cur = shiftCalendarDay(cur, 1);
    }
  });

  const stats = axisEmptyStats(axisDays, kept);
  const gaps = slots.filter((s) => s.kind === 'gap');
  return {
    mode: 'compact',
    slots,
    gaps,
    activeDays: axisDays.filter((d) => kept.has(d)),
    foldedDays: gaps.reduce((sum, s) => sum + s.span, 0),
    emptyRatio: stats.emptyRatio,
    maxEmptyRun: stats.maxEmptyRun,
    canCompact:
      stats.emptyRatio >= minEmptyRatio && stats.maxEmptyRun >= minGapDays,
    slotIndexByDate,
    slotCount: slots.length,
  };
}

/** 日期 → 所属槽（断层内的日期映射到该断层槽）。 */
export function calendarSlotOf(
  layout: CalendarAxisLayout,
  date: string
): CalendarAxisSlot | null {
  const i = layout.slotIndexByDate[date];
  if (i === undefined) return null;
  return layout.slots[i] ?? null;
}

/**
 * 唯一位置映射出口：日期 → 槽中心百分比。
 * 纵贯光束、表头浮标、「今日」呼吸灯标、事件脉冲柱与槽内 pill/芯片全部消费本函数，
 * 等距与紧凑活跃两种模式下 100% 像素对齐（同一日期恒得同一 x）。
 */
export function calendarSlotPct(layout: CalendarAxisLayout, date: string): number | null {
  const slot = calendarSlotOf(layout, date);
  return slot ? slot.centerPct : null;
}

/** 日期 → 槽序号（紧凑模式下即「视觉列序」，用于碰撞判定与入场交错）。 */
export function calendarSlotIndex(layout: CalendarAxisLayout, date: string): number {
  const i = layout.slotIndexByDate[date];
  return i === undefined ? -1 : i;
}

/** 某日所在列的可用宽度占比（紧凑活跃「单列宽度提升」的量化口径）。 */
export function calendarDayWidthShare(
  layout: CalendarAxisLayout,
  date: string
): number | null {
  const slot = calendarSlotOf(layout, date);
  return slot ? slot.widthShare : null;
}

/**
 * 纵贯光束宽度（px）：等距按四档窗口自适应（7 天 36px / 14 天 28px / 30 天 24px / 90 天 12px），
 * 紧凑活跃保持 28px。
 */
export function calendarBeamWidth(mode: 'equal' | 'compact', windowDays: number): number {
  if (mode === 'compact') return 28;
  if (windowDays <= CALENDAR_WINDOW_WEEK) return 36;
  if (windowDays <= CALENDAR_WINDOW_FORTNIGHT) return 28;
  return windowDays <= CALENDAR_WINDOW_SHORT ? 24 : 12;
}

/**
 * 「紧凑活跃」选择的本地持久化键（'auto' | 'on' | 'off'）。
 * 用户手动切换后跨会话保留，并支持宿主/测试显式写入 'on' 强制紧凑。
 */
export const CALENDAR_COMPACT_STORAGE_KEY = 'guanlan.calendarCompact.v1';

/** 持久化值 → 组件态（非法值一律回落 'auto'，绝不猜）。 */
export function normalizeCalendarCompactChoice(raw: string | null | undefined): 'auto' | boolean {
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  return 'auto';
}

function readCalendarCompactChoice(): 'auto' | boolean {
  if (typeof window === 'undefined') return 'auto';
  try {
    return normalizeCalendarCompactChoice(window.localStorage.getItem(CALENDAR_COMPACT_STORAGE_KEY));
  } catch {
    return 'auto';
  }
}

function writeCalendarCompactChoice(choice: 'auto' | boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      CALENDAR_COMPACT_STORAGE_KEY,
      choice === 'auto' ? 'auto' : choice ? 'on' : 'off'
    );
  } catch {
  }
}

const KIND_TICK_COLORS: Record<string, string> = {
  modified: 'var(--stage-ink-exec)',
  appeared: 'var(--stage-ink-blueprint)',
  discovered: 'var(--stage-ink-deliver)',
  workspace_baseline: 'var(--stage-ink-deliver)',
  read_recovered: 'var(--stage-ink-deliver)',
  decision_changed: 'var(--stage-ink-plan)',
  decision_raised: 'var(--stage-ink-plan)',
  moved_or_copied: 'var(--stage-ink-decision)',
  file_renamed: 'var(--stage-ink-decision)',
  file_moved: 'var(--stage-ink-decision)',
  file_trashed: 'var(--stage-ink-anomaly)',
  missing: 'var(--stage-ink-anomaly)',
  read_error: 'var(--stage-ink-anomaly)',
};

const UNDATED_STRIPES = 'repeating-linear-gradient(135deg, rgba(95,99,104,0.45) 0 3px, transparent 3px 6px)';

/** 「历史/更早」列宽（与右侧待考尾槽同为 68px，左右对称） */
export const CALENDAR_OLDER_SLOT_W = 68;
const AXIS_LEFT_WITH_OLDER = CALENDAR_OLDER_SLOT_W + 8;

function docDateOf(f: FileRecord): string | null {
  const sourceTime = f.revisions[0]?.source_time;
  return sourceTime ? localDay(sourceTime) : null;
}

function currentHashOf(f: FileRecord): string | null {
  const rev =
    f.revisions.find((r) => r.revision_id === f.current_revision_id) ?? f.revisions[0];
  return rev?.content_sha256 || null;
}

function evDateOf(ev: TimelineEvent): string | null {
  return ev.source_time ? localDay(ev.source_time) : null;
}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function sortDayEntriesDesc(entries: [string, FileRecord[]][]): [string, FileRecord[]][] {
  return entries.sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
}

interface FolderRow {
  folder: string;
  total: number;
  datedCount: number;
  dated: [string, FileRecord[]][];
  older: FileRecord[];
  olderGroups: [string, FileRecord[]][];
  undated: FileRecord[];
}

export function CalendarBoardView({
  files,
  events,
  onOpenDocument,
  initialWindowDays = CALENDAR_WINDOW_SHORT,
  systemActions,
  focusedDate: focusedDateProp,
  hoveredDate: hoveredDateProp,
  onFocusDate,
  onHoverDate,
  onJumpToStarMap,
  compactMode = 'auto',
}: CalendarBoardViewProps) {
  const [openSlot, setOpenSlot] = useState<{
    date: string;
    items: FileRecord[];
    anchor: CalendarPopoverAnchorRect;
    anchorEl?: HTMLElement | null;
  } | null>(null);
  const [openOlder, setOpenOlder] = useState<{
    label: string;
    groups: [string, FileRecord[]][];
    anchor: CalendarPopoverAnchorRect;
    anchorEl?: HTMLElement | null;
  } | null>(null);
  const axisTrackRef = useRef<HTMLDivElement | null>(null);
  const [axisTrackWidthPx, setAxisTrackWidthPx] = useState<number>(660);
  useEffect(() => {
    const el = axisTrackRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const w = el.getBoundingClientRect().width;
      if (Number.isFinite(w) && w > 0) setAxisTrackWidthPx(w);
    };
    update();
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [windowDays, setWindowDays] = useState<number>(initialWindowDays);
  const [compactChoice, setCompactChoice] = useState<'auto' | boolean>(
    compactMode === 'on' ? true : compactMode === 'off' ? false : readCalendarCompactChoice()
  );
  const [activeFoldersOnly, setActiveFoldersOnly] = useState(false);
  const [localFocusedDate, setLocalFocusedDate] = useState<string | null>(null);
  const [localHoveredDate, setLocalHoveredDate] = useState<string | null>(null);
  const effectiveFocusedDate = focusedDateProp !== undefined ? focusedDateProp : localFocusedDate;
  const effectiveHoveredDate = hoveredDateProp !== undefined ? hoveredDateProp : localHoveredDate;
  const setFocusedDate = (date: string | null) => {
    setLocalFocusedDate(date);
    onFocusDate?.(date);
  };
  const setHoveredDate = (date: string | null) => {
    setLocalHoveredDate(date);
    onHoverDate?.(date);
  };

  const allDates = useMemo(() => {
    const out: string[] = [];
    for (const f of files) {
      const d = docDateOf(f);
      if (d) out.push(d);
    }
    for (const ev of events) {
      const d = evDateOf(ev);
      if (d) out.push(d);
    }
    return out;
  }, [files, events]);

  const win = useMemo(() => calendarWindow(allDates, windowDays), [allDates, windowDays]);

  const compactGate = useMemo(() => {
    const columns = win.windowDays;
    const inWindow = new Set(columns);
    const activeSet = new Set<string>();
    for (const d of allDates) if (inWindow.has(d)) activeSet.add(d);
    const probe = buildEqualCalendarSlots(columns, activeSet);
    return {
      activeSet,
      canCompact: probe.canCompact,
      emptyRatio: probe.emptyRatio,
      maxEmptyRun: probe.maxEmptyRun,
    };
  }, [allDates, win]);

  const compactEnabled = compactChoice === 'auto' ? compactGate.canCompact : compactChoice;
  const toggleCompactChoice = () => {
    const next = !compactEnabled;
    setCompactChoice(next);
    writeCalendarCompactChoice(next);
  };

  const model = useMemo(() => {
    const today = localToday();

    const groups = new Map<string, FileRecord[]>();
    for (const f of files) {
      const key = f.folder === '.' ? '.' : f.folder.split('/')[0];
      const bucket = groups.get(key);
      if (bucket) bucket.push(f);
      else groups.set(key, [f]);
    }

    const axisStart = win.start ?? today;
    const axisEnd = win.end ?? today;
    const columns = win.windowDays.length > 0 ? win.windowDays : [today];
    const totalDays = columns.length;

    const layout = compactEnabled
      ? buildCompactCalendarSlots(columns, compactGate.activeSet)
      : buildEqualCalendarSlots(columns, compactGate.activeSet);
    const slotPct = (date: string): number | null => calendarSlotPct(layout, date);
    const slotIndex = (date: string): number => calendarSlotIndex(layout, date);
    const slotKept = (date: string): boolean => calendarSlotOf(layout, date)?.kind === 'day';

    const monthTicks: { label: string; pct: number }[] = [];
    for (const d of columns) {
      if (d.slice(8, 10) !== '01') continue;
      if (!slotKept(d)) continue;
      const pct = slotPct(d);
      if (pct !== null) monthTicks.push({ label: d.slice(0, 7), pct });
    }

    const weekPcts: number[] = [];
    const weekTicks: { label: string; pct: number }[] = [];
    if (columns.length > 0) {
      const startMs = Date.parse(`${columns[0]}T00:00:00`);
      const firstDow = new Date(startMs).getDay();
      for (let i = (8 - firstDow) % 7; i < totalDays; i += 7) {
        const d = columns[i];
        if (!slotKept(d)) continue;
        const pct = slotPct(d);
        if (pct === null) continue;
        weekPcts.push(pct);
        weekTicks.push({ label: d.slice(5), pct });
      }
    }

    const todayInWindow = today >= axisStart && today <= axisEnd;
    const todayPct = todayInWindow ? slotPct(today) : null;

    const rows: FolderRow[] = Array.from(groups.entries()).map(([folder, groupFiles]) => {
      const byDate = new Map<string, FileRecord[]>();
      const olderByDate = new Map<string, FileRecord[]>();
      const undated: FileRecord[] = [];
      let datedCount = 0;
      for (const f of groupFiles) {
        const d = docDateOf(f);
        if (!d) {
          undated.push(f);
          continue;
        }
        datedCount += 1;
        if (d >= axisStart && d <= axisEnd) {
          const arr = byDate.get(d);
          if (arr) arr.push(f);
          else byDate.set(d, [f]);
        } else {
          const arr = olderByDate.get(d);
          if (arr) arr.push(f);
          else olderByDate.set(d, [f]);
        }
      }
      const olderGroups = sortDayEntriesDesc(Array.from(olderByDate.entries()));
      return {
        folder,
        total: groupFiles.length,
        datedCount,
        dated: Array.from(byDate.entries()),
        older: olderGroups.flatMap(([, items]) => items),
        olderGroups,
        undated,
      };
    });

    const evByDate = new Map<string, TimelineEvent[]>();
    let olderEventCount = 0;
    for (const ev of events) {
      const d = evDateOf(ev);
      if (!d) continue;
      if (d >= axisStart && d <= axisEnd) {
        const arr = evByDate.get(d);
        if (arr) arr.push(ev);
        else evByDate.set(d, [ev]);
      } else {
        olderEventCount += 1;
      }
    }
    const eventTicks = Array.from(evByDate.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([date, list]) => {
        const sorted = [...list].sort((a, b) =>
          (a.source_time ?? '') < (b.source_time ?? '') ? -1 : (a.source_time ?? '') > (b.source_time ?? '') ? 1 : 0
        );
        const primary = sorted[sorted.length - 1];
        const title =
          list.length === 1
            ? `${date} ${primary.kind} ${primary.headline}`
            : `${date} · ${list.length} 条事件\n${sorted
                .slice(0, 6)
                .map((e) => `${e.kind} ${e.headline}`)
                .join('\n')}${list.length > 6 ? `\n…另 ${list.length - 6} 条` : ''}`;
        return {
          date,
          count: list.length,
          pct: slotPct(date) ?? 0,
          color: primary.isRollback ? 'var(--stage-ink-anomaly)' : (KIND_TICK_COLORS[primary.kind] ?? 'var(--ink-soft)'),
          title,
        };
      });

    const olderAllMap = new Map<string, FileRecord[]>();
    for (const row of rows) {
      for (const [d, items] of row.olderGroups) {
        const arr = olderAllMap.get(d);
        if (arr) arr.push(...items);
        else olderAllMap.set(d, [...items]);
      }
    }
    const olderAllGroups = sortDayEntriesDesc(Array.from(olderAllMap.entries()));
    const olderAllCount = rows.reduce((s, r) => s + r.older.length, 0);
    const undatedAllCount = rows.reduce((s, r) => s + r.undated.length, 0);
    const maxEventCount = Math.max(1, ...eventTicks.map((t) => t.count));

    const docsPerDay = new Map<string, number>();
    for (const row of rows) {
      for (const [d, items] of row.dated) {
        docsPerDay.set(d, (docsPerDay.get(d) ?? 0) + items.length);
      }
    }
    const accumSpark = buildDailyAccumulationSparkline(columns, docsPerDay);

    return {
      today,
      todayPct,
      axisStart,
      axisEnd,
      totalDays,
      slotPct,
      slotIndex,
      layout,
      monthTicks,
      weekPcts,
      weekTicks,
      rows,
      eventTicks,
      maxEventCount,
      accumSpark,
      olderEventCount,
      olderSlot: win.olderSlot,
      olderAllGroups,
      olderAllCount,
      hasOlder: olderAllCount > 0 || olderEventCount > 0,
      hasUndated: undatedAllCount > 0,
      windowCount: windowDays,
    };
  }, [files, events, win, compactGate, compactEnabled]);

  const {
    today,
    todayPct,
    axisStart,
    axisEnd,
    totalDays,
    slotPct,
    slotIndex,
    layout,
    monthTicks,
    weekPcts,
    weekTicks,
    rows,
    eventTicks,
    maxEventCount,
    accumSpark,
    olderEventCount,
    olderSlot,
    olderAllGroups,
    olderAllCount,
    hasOlder,
    hasUndated,
  } = model;

  const visibleRows = activeFoldersOnly ? rows.filter((r) => r.dated.length > 0) : rows;
  const [rowRenderLimit, setRowRenderLimit] = useState<number>(CALENDAR_ROW_SLICE_THRESHOLD);
  const rowSlice = computeChunkedListSlice(
    visibleRows.length,
    rowRenderLimit,
    CALENDAR_ROW_SLICE_THRESHOLD,
    CALENDAR_ROW_SLICE_STEP
  );
  const renderedRows = visibleRows.slice(0, rowSlice.visibleCount);
  const activeFolderCount = rows.filter((r) => r.dated.length > 0).length;
  const axisRight = hasUndated ? 76 : 26;
  const activeBeamDate = effectiveHoveredDate ?? effectiveFocusedDate;
  const activeBeamPct =
    activeBeamDate && activeBeamDate >= axisStart && activeBeamDate <= axisEnd
      ? slotPct(activeBeamDate)
      : null;
  const beamWidth = calendarBeamWidth(layout.mode, windowDays);
  const gapSlots = layout.gaps;

  const openOlderList = (
    label: string,
    groups: [string, FileRecord[]][],
    e: React.MouseEvent<HTMLButtonElement>
  ) => {
    if (groups.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setOpenSlot(null);
    setOpenOlder({ label, groups, anchor: anchorRectOf(rect), anchorEl: e.currentTarget });
  };

  const axisLeft = hasOlder ? AXIS_LEFT_WITH_OLDER : 8;

  return (
    <section className="flex-1 min-w-0 h-full pt-2.5 px-3.5 pb-3.5 text-[color:var(--ink-strong)]">
      <CardFrame className="flex h-full min-h-0 flex-col overflow-hidden bg-card/95 backdrop-blur-md">
        <CardFrameHeader className="flex flex-row items-center justify-between gap-3 border-b border-[color:var(--glass-hairline)] bg-card/90 px-4 py-2 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="w-6 h-6 rounded-[8px] bg-[color:color-mix(in_srgb,var(--accent-iris)_12%,transparent)] border border-[color:color-mix(in_srgb,var(--accent-iris)_22%,transparent)] flex items-center justify-center text-[color:var(--accent-iris-deep)] shrink-0">
              <CalendarDays className="w-3.5 h-3.5" strokeWidth={1.7} aria-hidden="true" />
            </span>
            <h2 className="text-[length:var(--text-item-title)] leading-[var(--lh-item-title)] font-semibold tracking-tight text-[color:var(--ink-strong)] truncate">
              文档日历
            </h2>
            <Badge
              variant="secondary"
              size="sm"
              data-calendar-range={axisStart}
              title={`${axisStart} ~ ${axisEnd}（共 ${totalDays} 天 · ${files.length} 份资产）`}
              className="hidden sm:inline-flex font-mono text-[10.5px] tabular-nums"
            >
              {axisStart.slice(5)} — {axisEnd.slice(5)}
            </Badge>
            {accumSpark.total > 0 && accumSpark.linePath && (
              <div
                data-calendar-sparkline=""
                title={`窗口内累计沉淀 ${accumSpark.total} 份文档（左→右按日递增）`}
                className="hidden lg:inline-flex items-center gap-1.5 rounded-full bg-[color:color-mix(in_srgb,var(--accent-iris)_6%,var(--card))] border border-[color:color-mix(in_srgb,var(--accent-iris)_16%,transparent)] px-2 py-0.5"
              >
                <svg
                  width="64"
                  height="14"
                  viewBox="0 0 92 20"
                  className="overflow-visible shrink-0"
                  aria-hidden="true"
                >
                  <path
                    d={accumSpark.areaPath}
                    fill="color-mix(in srgb, var(--accent-iris) 18%, transparent)"
                  />
                  <path
                    key={`spark-${windowDays}-${accumSpark.total}`}
                    d={accumSpark.linePath}
                    fill="none"
                    stroke="var(--accent-iris-deep)"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="glx-spark-draw"
                  />
                </svg>
                <span className="font-mono text-[9.5px] tabular-nums text-[color:var(--accent-iris-ink)]">
                  +{accumSpark.total}
                </span>
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {effectiveFocusedDate && (
              <div className="glx-popover-in hidden md:inline-flex items-center gap-1 rounded-full bg-[color:color-mix(in_srgb,var(--accent-iris)_11%,var(--card))] border border-[color:color-mix(in_srgb,var(--accent-iris)_32%,transparent)] pl-2 pr-1 py-0.5 text-[10.5px]">
                <span className="font-mono font-medium tabular-nums text-[color:var(--accent-iris-ink)]">
                  {effectiveFocusedDate.slice(5)}
                </span>
                {onJumpToStarMap && (
                  <button
                    type="button"
                    data-calendar-jump-starmap={effectiveFocusedDate}
                    onClick={() => onJumpToStarMap(effectiveFocusedDate)}
                    title={`在司辰星图中聚焦 ${effectiveFocusedDate}`}
                    className="inline-flex items-center gap-0.5 rounded-full bg-card/90 px-1.5 py-0.5 font-medium text-[10px] text-[color:var(--accent-iris-deep)] hover:bg-[color:var(--accent-iris-deep)] hover:text-white cursor-pointer motion-safe:transition-colors"
                  >
                    <Compass className="w-2.5 h-2.5" strokeWidth={1.8} aria-hidden="true" />
                    <span>星图</span>
                  </button>
                )}
                <button
                  type="button"
                  aria-label="取消日期聚焦"
                  onClick={() => setFocusedDate(null)}
                  className="w-4 h-4 rounded-full flex items-center justify-center text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)] hover:bg-white/80 cursor-pointer"
                >
                  <X className="w-2.5 h-2.5" strokeWidth={2} aria-hidden="true" />
                </button>
              </div>
            )}
            <Toolbar
              aria-label="日历窗口与视图工具栏"
              className="border-transparent bg-transparent p-0 shadow-none before:hidden gap-1.5"
            >
              <SegmentedControl
                role="group"
                aria-label="日历时间窗口"
                size="sm"
                className="bg-[color:var(--depth-1-bg)]"
              >
                {CALENDAR_WINDOW_OPTIONS.map((n) => (
                  <SegmentedControlItem
                    key={n}
                    data-window-days={n}
                    aria-pressed={model.windowCount === n}
                    onClick={() => setWindowDays(n)}
                    className="whitespace-nowrap px-2 text-[11px]"
                  >
                    近 {n} 天
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
              {(rows.length > 0 && activeFolderCount < rows.length) || compactGate.canCompact ? (
                <ToolbarSeparator orientation="vertical" className="h-4" />
              ) : null}
              <ToolbarGroup>
                {rows.length > 0 && activeFolderCount < rows.length && (
                  <Chip
                    data-calendar-active-only=""
                    active={activeFoldersOnly}
                    onClick={() => setActiveFoldersOnly((v) => !v)}
                    title={
                      activeFoldersOnly
                        ? '当前仅显示近窗口有活跃文档的目录，点击恢复显示全部目录'
                        : `隐藏当前窗口内无活跃文档的 ${rows.length - activeFolderCount} 个目录`
                    }
                    className="glx-pill-tactile whitespace-nowrap"
                  >
                    活跃 {activeFolderCount}/{rows.length}
                  </Chip>
                )}
                {compactGate.canCompact && (
                  <Chip
                    data-calendar-compact=""
                    active={compactEnabled}
                    onClick={toggleCompactChoice}
                    title={
                      compactEnabled
                        ? `紧凑活跃已开启：${compactGate.maxEmptyRun} 天连续空白已折为断层槽，点击恢复等距`
                        : `点击开启紧凑活跃：${compactGate.maxEmptyRun} 天连续空白折为断层槽，活跃日获得更多横向空间`
                    }
                    className="glx-pill-tactile whitespace-nowrap"
                  >
                    紧凑活跃
                  </Chip>
                )}
              </ToolbarGroup>
            </Toolbar>
          </div>
        </CardFrameHeader>

        <ScrollArea scrollFade className="flex-1 min-h-0" viewportClassName="h-full">
          {files.length === 0 ? (
            <div className="m-6 rounded-[var(--r-block)] border border-[#26243D]/10 bg-white/60 p-6 text-center text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] text-[color:var(--ink-soft)]">
              工作区文档索引加载中或为空
            </div>
          ) : (
            <div className="flex min-h-full flex-col">
              <div
                data-cal-sticky-header=""
                className="sticky top-0 z-20 flex bg-[color:var(--glass-page-base)] border-b border-[#26243D]/10"
                style={{ height: CALENDAR_STICKY_HEADER_H }}
              >
                <div className="w-40 shrink-0 border-r border-[#26243D]/10 px-3 flex items-center">
                  <span className="font-mono text-[length:var(--text-micro)] tracking-[0.18em] text-[color:var(--ink-soft)]">目录</span>
                </div>
                <div className="relative flex-1">
                  {hasOlder && (
                    <div className="absolute inset-y-0 left-0 flex w-[68px] flex-col items-center justify-center border-r border-[#26243D]/10 bg-[#26243D]/[0.04]">
                      {olderAllCount > 0 ? (
                        <button
                          type="button"
                          data-older-slot="all"
                          data-older-count={olderAllCount}
                          title={`历史/更早 · ${olderSlot ? `${olderSlot.count} 个日期 · ${olderSlot.minDate} ~ ${olderSlot.maxDate}` : ''} · 共 ${olderAllCount} 份 · 点击展开`}
                          onClick={(e) => openOlderList('历史/更早（全部）', olderAllGroups, e)}
                          className="flex h-full w-full flex-col items-center justify-center gap-0 leading-tight text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)] cursor-pointer"
                        >
                          <span className="font-mono text-[length:var(--text-micro)]">历史</span>
                          <span className="max-w-full truncate font-mono text-[length:var(--text-micro)] tabular-nums font-medium text-[color:var(--ink-soft)]">+{olderAllCount}</span>
                        </button>
                      ) : (
                        <span
                          data-older-slot="events-only"
                          title={`历史/更早 · 窗口前另有 ${olderEventCount} 条事件`}
                          className="flex h-full w-full flex-col items-center justify-center gap-0 leading-tight text-[color:var(--ink-soft)]"
                        >
                          <span className="font-mono text-[length:var(--text-micro)]">历史</span>
                          <span className="max-w-full truncate font-mono text-[length:var(--text-micro)] tabular-nums font-medium">{olderEventCount} 条</span>
                        </span>
                      )}
                    </div>
                  )}
                  {(() => {
                    const startPct = slotPct(axisStart) ?? 0;
                    const endPct = slotPct(axisEnd) ?? 0;
                    const todayNearEnd = todayPct !== null && Math.abs(endPct - todayPct) < 16;
                    const todayNearStart = todayPct !== null && todayPct < 14;
                    const monthPcts = monthTicks.map((m) => m.pct);
                    const beamFloatPct =
                      activeBeamPct !== null &&
                      activeBeamDate !== null &&
                      activeBeamDate !== today
                        ? activeBeamPct
                        : null;
                    const nearBeam = (pct: number) =>
                      beamFloatPct !== null && Math.abs(pct - beamFloatPct) < 12;
                    return (
                      <div
                        ref={axisTrackRef}
                        className="absolute inset-y-0"
                        style={{ left: axisLeft, right: axisRight }}
                      >
                        <div className="absolute inset-y-0 w-px bg-[#26243D]/10" style={{ left: `${startPct}%` }} />
                        {!todayNearStart && !nearBeam(startPct) && (
                          <span
                            className="absolute top-1/2 -translate-y-1/2 pl-1.5 whitespace-nowrap leading-none font-mono text-[length:var(--text-micro)] tabular-nums text-[color:var(--ink-soft)]"
                            style={{ left: `${startPct}%` }}
                          >
                            {axisStart}
                          </span>
                        )}
                        {monthTicks.map((t) => {
                          const tooCloseToEnds = t.pct < 14 || t.pct > 85;
                          const tooCloseToToday = todayPct !== null && Math.abs(t.pct - todayPct) < 13;
                          return (
                            <Fragment key={t.label}>
                              <div className="absolute inset-y-0 w-px bg-[#26243D]/14" style={{ left: `${t.pct}%` }} />
                              {!tooCloseToEnds && !tooCloseToToday && !nearBeam(t.pct) && (
                                <span
                                  className="absolute top-1/2 -translate-y-1/2 pl-1.5 whitespace-nowrap leading-none font-mono text-[length:var(--text-micro)] font-semibold tabular-nums text-[color:var(--ink-strong)]"
                                  style={{ left: `${t.pct}%` }}
                                >
                                  {t.label}
                                </span>
                              )}
                            </Fragment>
                          );
                        })}
                        {windowDays <= CALENDAR_WINDOW_SHORT &&
                          weekTicks.map((wt) => {
                            const tooCloseToEnds = wt.pct < 16 || wt.pct > 84;
                            const tooCloseToToday = todayPct !== null && Math.abs(wt.pct - todayPct) < 13;
                            const tooCloseToMonth = monthPcts.some((mp) => Math.abs(wt.pct - mp) < 11);
                            if (tooCloseToEnds || tooCloseToToday || tooCloseToMonth) return null;
                            if (nearBeam(wt.pct)) return null;
                            return (
                              <span
                                key={`wk-${wt.label}`}
                                className="absolute top-1/2 -translate-y-1/2 pl-1 whitespace-nowrap leading-none font-mono text-[10px] tabular-nums text-[color:var(--ink-faint)]"
                                style={{ left: `${wt.pct}%` }}
                              >
                                {wt.label}
                              </span>
                            );
                          })}
                        <div className="absolute inset-y-0 w-px bg-[#26243D]/10" style={{ left: `${endPct}%` }} />
                        {!todayNearEnd && !nearBeam(endPct) && (
                          <span
                            className="absolute top-1/2 -translate-y-1/2 pr-1.5 whitespace-nowrap leading-none font-mono text-[length:var(--text-micro)] tabular-nums text-[color:var(--ink-soft)]"
                            style={{ left: `${endPct}%`, transform: 'translateX(-100%)' }}
                          >
                            {axisEnd}
                          </span>
                        )}
                        {todayPct !== null && (() => {
                          const beamOverlapsToday =
                            activeBeamPct !== null &&
                            activeBeamDate !== null &&
                            activeBeamDate !== today &&
                            Math.abs(activeBeamPct - todayPct) < 14;
                          return (
                            <>
                              <div
                                className="absolute inset-y-0 w-px bg-[color:color-mix(in_srgb,var(--accent-iris)_75%,transparent)]"
                                style={{ left: `${todayPct}%` }}
                              />
                              <span
                                data-cal-today-marker={today}
                                className={`absolute top-1/2 -translate-y-1/2 z-30 inline-flex items-center gap-1 whitespace-nowrap leading-none rounded-full bg-[color:color-mix(in_srgb,var(--accent-iris)_14%,var(--card))] px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-[color:var(--accent-iris-ink)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--accent-iris)_35%,transparent)] motion-safe:transition-opacity ${
                                  beamOverlapsToday ? 'opacity-0 pointer-events-none' : 'opacity-100'
                                }`}
                                style={{
                                  left: `${todayPct}%`,
                                  transform:
                                    todayPct > 86
                                      ? 'translateX(calc(-100% - 4px))'
                                      : todayPct < 14
                                        ? 'translateX(4px)'
                                        : 'translateX(-50%)',
                                }}
                                title={`今日 · ${today}`}
                              >
                                <span
                                  aria-hidden="true"
                                  className="glx-live-dot size-1.5 rounded-full bg-[color:var(--accent-iris)] text-[color:var(--accent-iris)] shrink-0"
                                />
                                <span>{todayNearEnd ? `今日 ${today.slice(5)}` : '今日'}</span>
                              </span>
                            </>
                          );
                        })()}
                        {activeBeamPct !== null && activeBeamDate && activeBeamDate !== today && (
                          <span
                            data-cal-beam-label={activeBeamDate}
                            className="glx-cal-col-beam pointer-events-none absolute top-1/2 -translate-y-1/2 z-40 whitespace-nowrap leading-none rounded-full bg-[color:var(--accent-iris-deep)] px-1.5 py-0.5 font-mono text-[9.5px] font-semibold tabular-nums text-white shadow-[0_2px_8px_rgba(84,70,160,0.32)]"
                            style={{
                              left: `${activeBeamPct}%`,
                              transform:
                                activeBeamPct > 88
                                  ? 'translateX(-100%)'
                                  : activeBeamPct < 12
                                    ? 'translateX(0)'
                                    : 'translateX(-50%)',
                            }}
                          >
                            {activeBeamDate.slice(5)}
                          </span>
                        )}
                      </div>
                    );
                  })()}
                  {hasUndated && (
                    <div className="absolute inset-y-0 right-0 w-[68px] border-l border-[#26243D]/10 bg-[#26243D]/[0.03] flex items-center justify-center">
                      <span className="whitespace-nowrap leading-none font-mono text-[length:var(--text-micro)] text-[color:var(--ink-soft)]">待考</span>
                    </div>
                  )}
                </div>
              </div>

              <div
                key={`${windowDays}-${activeFoldersOnly ? 'a' : 'all'}`}
                className="relative flex-1 divide-y divide-[#26243D]/[0.06]"
                onMouseLeave={() => setHoveredDate(null)}
              >
                {(activeBeamPct !== null || gapSlots.length > 0) && (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 left-40 right-0 z-0 overflow-hidden"
                  >
                    <div className="absolute inset-y-0" style={{ left: axisLeft, right: axisRight }}>
                      {gapSlots.map((g) => (
                        <div
                          key={g.date}
                          data-cal-gap={g.date}
                          data-cal-gap-days={g.span}
                          title={`${g.date} ~ ${g.endDate} 连续 ${g.span} 天无文档与事件（紧凑活跃已折叠）`}
                          className="glx-fade-in glx-cal-gap absolute inset-y-0 flex flex-col items-center pt-1"
                          style={{ left: `${g.startPct}%`, width: `${g.endPct - g.startPct}%` }}
                        >
                          <span className="glx-cal-gap-label whitespace-nowrap rounded-full bg-card/90 px-1 font-mono text-[length:var(--text-micro)] leading-none tabular-nums text-[color:var(--ink-soft)]">
                            空 {g.span} 天
                          </span>
                          <span
                            aria-hidden="true"
                            className="flex w-full flex-1 items-stretch justify-between"
                          >
                            <span className="glx-cal-gap-rail border-l" />
                            <span className="glx-cal-gap-rail border-r" />
                          </span>
                        </div>
                      ))}
                      {activeBeamPct !== null && (
                        <div
                          data-cal-col-beam={activeBeamDate ?? undefined}
                          className="glx-cal-col-beam absolute inset-y-0 left-0 right-0"
                          style={{ transform: `translateX(${activeBeamPct}%)` }}
                        >
                          <div
                            className="absolute inset-y-0 left-0 -translate-x-1/2"
                            style={{
                              width: beamWidth,
                              background:
                                'linear-gradient(180deg, color-mix(in srgb, var(--accent-iris) 15%, transparent) 0%, color-mix(in srgb, var(--accent-iris) 8%, transparent) 60%, color-mix(in srgb, var(--accent-iris) 14%, transparent) 100%)',
                              borderLeft: '1px solid color-mix(in srgb, var(--accent-iris) 26%, transparent)',
                              borderRight: '1px solid color-mix(in srgb, var(--accent-iris) 26%, transparent)',
                            }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {renderedRows.map((row, rowIdx) => {
                  const { crowdedChips, adjacentSparse } =
                    windowDays === CALENDAR_WINDOW_SHORT
                      ? findCrowdedCalendarSlots(row.dated, slotIndex)
                      : { crowdedChips: new Set<string>(), adjacentSparse: new Set<string>() };
                  const displayFolder = row.folder === '.' ? '根目录' : row.folder;
                  const countText = row.datedCount === row.total ? `${row.total}` : `${row.datedCount}/${row.total}`;
                  return (
                  <div
                    key={row.folder}
                    data-cal-row={row.folder}
                    className="group/calrow glx-row-in relative flex h-12 items-stretch even:bg-muted/25 transition-colors hover:bg-[color:color-mix(in_srgb,var(--accent-iris)_6%,var(--card))]"
                    style={{
                      scrollMarginTop: CALENDAR_ROW_SCROLL_MARGIN,
                      '--glx-row-idx': rowIdx,
                    } as React.CSSProperties}
                  >
                    <div
                      title={`${displayFolder} · 已纳入 ${row.datedCount} / ${row.total} 份`}
                      className="relative w-40 shrink-0 border-r border-[#26243D]/10 px-3 flex items-center justify-between gap-2"
                    >
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-[color:var(--accent-iris)] opacity-0 scale-y-50 group-hover/calrow:opacity-85 group-hover/calrow:scale-y-100 motion-safe:transition-all motion-safe:duration-200"
                      />
                      <span className="text-[12.5px] leading-tight font-medium text-[color:var(--ink-strong)] group-hover/calrow:text-[color:var(--accent-iris-deep)] motion-safe:transition-colors truncate">
                        {displayFolder}
                      </span>
                      <span className="shrink-0 rounded-full bg-[color:var(--depth-1-bg-soft)] group-hover/calrow:bg-[color:color-mix(in_srgb,var(--accent-iris)_12%,white)] group-hover/calrow:text-[color:var(--accent-iris-ink)] px-1.5 py-0.5 font-mono text-[10px] leading-none tabular-nums text-[color:var(--ink-soft)] motion-safe:transition-colors">
                        {countText}
                      </span>
                    </div>
                    <div className="relative flex-1">
                      {hasOlder && (
                        <div className="absolute inset-y-0 left-0 flex w-[68px] items-center justify-center border-r border-[#26243D]/10 bg-[#26243D]/[0.03]">
                          {row.older.length > 0 && (
                            <button
                              type="button"
                              data-older-chip={row.folder}
                              data-older-count={row.older.length}
                              title={`${row.folder === '.' ? '根目录' : row.folder} · 更早 ${row.older.length} 份${
                                row.olderGroups.length > 0
                                  ? ` · ${row.olderGroups[row.olderGroups.length - 1][0]} ~ ${row.olderGroups[0][0]}`
                                  : ''
                              } · 点击展开清单`}
                              onClick={(e) =>
                                openOlderList(
                                  row.folder === '.' ? '根目录 · 更早' : `${row.folder} · 更早`,
                                  row.olderGroups,
                                  e
                                )
                              }
                              className="h-5 rounded-[var(--r-pill)] border border-[color:var(--glass-hairline-strong)] bg-card/90 px-2 font-mono text-[length:var(--text-micro)] font-medium leading-none text-[color:var(--ink-soft)] shadow-[0_1px_2px_rgba(38,36,61,0.05)] tabular-nums hover:border-[color:var(--accent-iris)] hover:text-[color:var(--accent-iris-deep)] transition-colors cursor-pointer"
                            >
                              {row.older.length} 份
                            </button>
                          )}
                        </div>
                      )}
                      <div className="absolute inset-y-1" style={{ left: axisLeft, right: axisRight }}>
                        {weekPcts.map((pct, i) => (
                          <div
                            key={`w${i}`}
                            data-cal-week=""
                            className="absolute inset-y-0 w-px bg-[#26243D]/[0.07]"
                            style={{ left: `${pct}%` }}
                          />
                        ))}
                        {todayPct !== null && (
                          <div
                            className="absolute inset-y-0 w-px bg-[color:color-mix(in_srgb,var(--accent-iris)_55%,transparent)] pointer-events-none z-0"
                            style={{ left: `${todayPct}%` }}
                          />
                        )}
                        {row.dated.flatMap(([date, items]) => {
                          const { pills, chipTotal } = splitSlotForRender(items);
                          const slotLeft = `${slotPct(date) ?? 0}%`;
                          const widthShare = calendarDayWidthShare(layout, date) ?? 1 / Math.max(1, layout.slotCount);
                          const renderedColPx = axisTrackWidthPx * widthShare;
                          const equalColPx = axisTrackWidthPx / Math.max(1, windowDays);
                          const slotPxWidth = Math.min(renderedColPx, equalColPx);
                          const hasNeighborWithin2Days = crowdedChips.has(date);
                          const renderMode = resolveCalendarSlotMode(
                            slotPxWidth,
                            items.length,
                            hasNeighborWithin2Days
                          );
                          const dotTier =
                            renderMode === 'heat_dot' && chipTotal !== null
                              ? slotHeatDotTier(chipTotal)
                              : null;
                          const isTightSparse = adjacentSparse.has(date);
                          const dIdx = slotIndex(date);
                          const waveIdx = rowIdx + Math.min(16, Math.max(0, Math.round((dIdx / Math.max(1, layout.slotCount)) * 14)));
                          const isColActive = activeBeamDate === date;
                          const openDayList = (e: React.MouseEvent<HTMLButtonElement>) => {
                            const rect = e.currentTarget.getBoundingClientRect();
                            setOpenOlder(null);
                            setFocusedDate(date);
                            setOpenSlot({
                              date,
                              items,
                              anchor: anchorRectOf(rect),
                              anchorEl: e.currentTarget,
                            });
                          };
                          if (renderMode === 'compact_heat' && chipTotal !== null) {
                            const tier = slotHeatDotTier(chipTotal);
                            const isPeak = chipTotal >= 100;
                            const isHigh = chipTotal >= 30 && chipTotal < 100;
                            const isMid = chipTotal >= 10 && chipTotal < 30;
                            const cellMaxW = Math.min(26, Math.max(15, Math.floor(slotPxWidth) - 2));
                            return (
                              <button
                                key={date}
                                type="button"
                                data-slot-chip={date}
                                data-slot-compact={chipTotal}
                                onClick={openDayList}
                                onMouseEnter={() => setHoveredDate(date)}
                                onFocus={() => setHoveredDate(date)}
                                aria-label={`${date} 共 ${chipTotal} 份 · 点击展开当日清单`}
                                title={`${date} 共 ${chipTotal} 份 · 点击展开当日清单`}
                                className={`glx-heat-cell ${isPeak ? 'glx-peak-shimmer' : ''} absolute top-1/2 h-[22px] rounded-[6px] border font-mono leading-none tabular-nums cursor-pointer hover:z-20 flex items-center justify-center overflow-hidden ${
                                  isColActive ? 'z-10 ring-2 ring-[color:color-mix(in_srgb,var(--accent-iris)_42%,transparent)]' : 'z-[3]'
                                } ${
                                  isPeak
                                    ? 'px-[1px] text-[8px] font-bold tracking-[-0.05em] border-[color:var(--accent-iris-deep)] text-white shadow-[0_2px_10px_rgba(84,70,160,0.34)]'
                                    : isHigh
                                      ? 'px-[2px] text-[9px] font-semibold border-[color:color-mix(in_srgb,var(--accent-iris)_52%,transparent)] text-[color:var(--accent-iris-ink)] shadow-[0_1px_4px_rgba(84,70,160,0.12)]'
                                      : isMid
                                        ? 'px-[2px] text-[9px] font-semibold border-[color:color-mix(in_srgb,var(--accent-iris)_36%,transparent)] text-[color:var(--accent-iris-ink)]'
                                        : 'px-[2px] text-[9px] font-semibold border-[color:color-mix(in_srgb,var(--accent-iris)_28%,transparent)] text-[color:var(--accent-iris-deep)]'
                                }`}
                                style={{
                                  left: slotLeft,
                                  width: cellMaxW,
                                  '--glx-cell-idx': waveIdx,
                                  backgroundImage: isPeak
                                    ? 'linear-gradient(180deg, #6E5FD4 0%, #4E3EB8 100%)'
                                    : undefined,
                                  backgroundColor: isPeak
                                    ? 'var(--accent-iris-deep)'
                                    : isHigh
                                      ? `color-mix(in srgb, var(--accent-iris) 24%, var(--card))`
                                      : isMid
                                        ? `color-mix(in srgb, var(--accent-iris) 14%, var(--card))`
                                        : `color-mix(in srgb, var(--accent-iris) ${Math.max(8, Math.round(tier.mixPct / 3))}%, var(--card))`,
                                } as React.CSSProperties}
                              >
                                {formatCompactSlotCount(chipTotal)}
                              </button>
                            );
                          }
                          return (
                            <Fragment key={date}>
                              {pills.map((f, j) => {
                                const c = getCalendarFormatColor(f.format);
                                const pillMarginLeft =
                                  isTightSparse && slotPxWidth < 28
                                    ? Math.round((j - (pills.length - 1) / 2) * 3)
                                    : isTightSparse
                                      ? j * 2
                                      : j * 4;
                                return (
                                  <button
                                    key={f.file_id}
                                    type="button"
                                    data-slot-doc-pill={f.file_id}
                                    onClick={() => {
                                      setFocusedDate(date);
                                      onOpenDocument(f.file_id);
                                    }}
                                    onMouseEnter={() => setHoveredDate(date)}
                                    onFocus={() => setHoveredDate(date)}
                                    onContextMenu={(e) => {
                                      if (!systemActions?.onOpenFileContextMenu) return;
                                      e.preventDefault();
                                      e.stopPropagation();
                                      systemActions.onOpenFileContextMenu(e, {
                                        kind: 'file',
                                        relativePath: f.relative_path,
                                        title: f.title,
                                        fileId: f.file_id,
                                        revisionId: f.current_revision_id,
                                      });
                                    }}
                                    title={`${f.title} · ${date}`}
                                    className={`glx-doc-pill absolute top-1/2 rounded-full border cursor-pointer hover:z-20 ${
                                      isColActive ? 'ring-2 ring-[color:color-mix(in_srgb,var(--accent-iris)_36%,transparent)]' : ''
                                    } ${
                                      isTightSparse && slotPxWidth < 28
                                        ? 'h-3.5 w-[9px]'
                                        : isTightSparse
                                          ? 'h-3.5 w-[11px]'
                                          : 'h-4 w-[14px]'
                                    }`}
                                    style={{
                                      left: slotLeft,
                                      '--glx-cell-idx': waveIdx + j,
                                      backgroundColor: c.bg,
                                      borderColor: c.border,
                                      marginLeft: pillMarginLeft,
                                      zIndex: j + 1,
                                    } as React.CSSProperties}
                                  />
                                );
                              })}
                              {chipTotal !== null &&
                                (dotTier ? (
                                  <button
                                    type="button"
                                    data-slot-chip={date}
                                    data-slot-dot={chipTotal}
                                    onClick={openDayList}
                                    onMouseEnter={() => setHoveredDate(date)}
                                    onFocus={() => setHoveredDate(date)}
                                    aria-label={`${date} 共 ${chipTotal} 份 · 点击展开当日清单`}
                                    title={`${date} 共 ${chipTotal} 份 · 点击展开当日清单`}
                                    className={`glx-dot-bloom absolute top-1/2 rounded-full cursor-pointer hover:z-20 ${
                                      isColActive ? 'z-10 ring-2 ring-[color:color-mix(in_srgb,var(--accent-iris)_45%,transparent)]' : 'z-[4]'
                                    }`}
                                    style={{
                                      left: slotLeft,
                                      '--glx-cell-idx': waveIdx,
                                      marginLeft: 16,
                                      width: dotTier.size,
                                      height: dotTier.size,
                                      backgroundColor: `color-mix(in srgb, var(--accent-iris) ${dotTier.mixPct}%, transparent)`,
                                    } as React.CSSProperties}
                                  />
                                ) : (
                                  <button
                                    type="button"
                                    data-slot-chip={date}
                                    onClick={openDayList}
                                    onMouseEnter={() => setHoveredDate(date)}
                                    onFocus={() => setHoveredDate(date)}
                                    title={`${date} 共 ${chipTotal} 份 · 点击展开当日清单`}
                                    className="glx-pill-tactile absolute top-1/2 -translate-y-1/2 h-4 rounded-[var(--r-pill)] border border-[color:color-mix(in_srgb,var(--accent-iris)_60%,transparent)] bg-card/90 px-1 font-mono text-[length:var(--text-micro)] font-medium leading-none text-[color:var(--accent-iris-deep)] cursor-pointer hover:border-[color:var(--accent-iris)] hover:shadow-[0_2px_8px_rgba(108,92,231,0.18)] z-[4]"
                                    style={{ left: slotLeft, marginLeft: 16 }}
                                  >
                                    {formatSlotChipLabel(chipTotal)}
                                  </button>
                                ))}
                            </Fragment>
                          );
                        })}
                      </div>
                      {hasUndated && (
                        <div className="absolute inset-y-0 right-0 w-[68px] border-l border-[#26243D]/10 bg-[#26243D]/[0.04]">
                          {row.undated.map((f, j) => (
                            <span
                              key={f.file_id}
                              title={`${f.title} · 日期待考`}
                              className="absolute top-1/2 -translate-y-1/2 h-4 w-[14px] rounded-full border"
                              style={{ left: 6 + (j % 3) * 20, borderColor: getCalendarFormatColor('undated').border, backgroundImage: UNDATED_STRIPES }}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  );
                })}

                {rowSlice.remainingCount > 0 && (
                  <div
                    data-cal-row-slice="active"
                    data-total-rows={visibleRows.length}
                    data-rendered-rows={renderedRows.length}
                    className="flex flex-wrap items-center justify-between gap-2 bg-muted/40 px-4 py-2 text-[11.5px] text-[color:var(--ink-soft)]"
                  >
                    <span className="font-mono tabular-nums">
                      高密目录切片护栏：已渲染 {renderedRows.length} / {visibleRows.length} 个目录行
                    </span>
                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="secondary"
                        size="sm"
                        data-cal-load-more-rows=""
                        onClick={() => setRowRenderLimit(rowSlice.nextLimit)}
                        className="!h-6 !px-2.5 !text-[11px] cursor-pointer"
                      >
                        展开下 {Math.min(CALENDAR_ROW_SLICE_STEP, rowSlice.remainingCount)} 个目录
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        data-cal-load-all-rows=""
                        onClick={() => setRowRenderLimit(visibleRows.length)}
                        className="!h-6 !px-2 !text-[11px] cursor-pointer"
                      >
                        全部展开
                      </Button>
                    </div>
                  </div>
                )}

              </div>

              {(() => {
                const countByFormat = new Map<string, number>();
                for (const f of files) {
                  countByFormat.set(f.format, (countByFormat.get(f.format) ?? 0) + 1);
                }
                const extraFormats = Array.from(countByFormat.entries())
                  .filter(([fmt]) => fmt !== 'md' && fmt !== 'svg' && fmt !== 'pdf')
                  .sort((a, b) => b[1] - a[1]);
                const mdTotal = countByFormat.get('md') ?? 0;
                const svgTotal = countByFormat.get('svg') ?? 0;
                const pdfTotal = countByFormat.get('pdf') ?? 0;
                const breakdownEntries: Array<[string, number]> = [
                  ...(mdTotal > 0 || extraFormats.length === 0 ? ([['md', mdTotal]] as Array<[string, number]>) : []),
                  ...(svgTotal > 0 || extraFormats.length === 0 ? ([['svg', svgTotal]] as Array<[string, number]>) : []),
                  ...(pdfTotal > 0 || extraFormats.length === 0 ? ([['pdf', pdfTotal]] as Array<[string, number]>) : []),
                  ...extraFormats.slice(0, 6),
                ];
                const total = Math.max(files.length, 1);
                const inWindowEvents = eventTicks.reduce((acc, t) => acc + t.count, 0);
                const peakTick = eventTicks.reduce<(typeof eventTicks)[number] | null>(
                  (best, cur) => (!best || cur.count > best.count ? cur : best),
                  null
                );
                return (
                  <div className="sticky bottom-0 z-10 mt-auto border-t border-[color:var(--glass-hairline)] bg-[color:var(--glass-page-base)]">
                    <div
                      data-cal-row="__events__"
                      className="flex h-12 items-stretch bg-[color:var(--glass-page-base)] transition-colors hover:bg-[color:color-mix(in_srgb,var(--accent-iris)_5%,var(--glass-page-base))]"
                      style={{ scrollMarginTop: CALENDAR_ROW_SCROLL_MARGIN }}
                    >
                      <div className="w-40 shrink-0 border-r border-[#26243D]/10 px-3 flex flex-col justify-center gap-0.5">
                        <span className="text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] font-medium text-[color:var(--ink-strong)]">事件刻度</span>
                        <span className="font-mono text-[length:var(--text-micro)] tabular-nums text-[color:var(--ink-soft)]">{events.length} 条</span>
                      </div>
                      <div className="relative flex-1">
                        {hasOlder && (
                          <div className="absolute inset-y-0 left-0 flex w-[68px] items-center justify-center border-r border-[#26243D]/10 bg-[#26243D]/[0.03]">
                            {olderEventCount > 0 && (
                              <span
                                title={`窗口前（历史/更早）另有 ${olderEventCount} 条事件，不在主轴绘制`}
                                data-older-events={olderEventCount}
                                className="h-5 rounded-[var(--r-pill)] border border-[color:var(--glass-hairline-strong)] bg-card/90 px-2 font-mono text-[length:var(--text-micro)] font-medium leading-none text-[color:var(--ink-soft)] shadow-[0_1px_2px_rgba(38,36,61,0.04)] tabular-nums flex items-center"
                              >
                                {olderEventCount} 条
                              </span>
                            )}
                          </div>
                        )}
                        <div className="absolute inset-y-1" style={{ left: axisLeft, right: axisRight }}>
                          {weekPcts.map((pct, i) => (
                            <div
                              key={`ew${i}`}
                              data-cal-week=""
                              className="absolute inset-y-0 w-px bg-[#26243D]/[0.07]"
                              style={{ left: `${pct}%` }}
                            />
                          ))}
                          {todayPct !== null && (
                            <div
                              className="absolute inset-y-0 w-px bg-[color:color-mix(in_srgb,var(--accent-iris)_55%,transparent)] pointer-events-none z-0"
                              style={{ left: `${todayPct}%` }}
                            />
                          )}
                          {eventTicks.map((t, tickIdx) => {
                            const intensity = Math.log1p(t.count) / Math.log1p(maxEventCount);
                            const barH = Math.round(8 + 22 * intensity);
                            const isSelectedBar = activeBeamDate === t.date;
                            return (
                              <button
                                key={t.date}
                                type="button"
                                data-event-day={t.date}
                                data-event-count={t.count}
                                title={t.title}
                                aria-label={`${t.date} ${t.count} 条事件`}
                                onClick={() =>
                                  setFocusedDate(effectiveFocusedDate === t.date ? null : t.date)
                                }
                                onMouseEnter={() => setHoveredDate(t.date)}
                                onFocus={() => setHoveredDate(t.date)}
                                className={`glx-cal-bar absolute bottom-1.5 rounded-full cursor-pointer ${
                                  windowDays <= CALENDAR_WINDOW_FORTNIGHT
                                    ? 'w-[6px]'
                                    : windowDays <= CALENDAR_WINDOW_SHORT
                                      ? 'w-[5px]'
                                      : 'w-[3px]'
                                } ${
                                  isSelectedBar
                                    ? 'z-20 ring-2 ring-[color:color-mix(in_srgb,var(--accent-iris)_45%,transparent)]'
                                    : 'z-[2]'
                                }`}
                                style={{
                                  left: `${t.pct}%`,
                                  height: barH,
                                  backgroundColor: t.color,
                                  '--glx-bar-idx': tickIdx,
                                } as React.CSSProperties}
                              />
                            );
                          })}
                        </div>
                        {hasUndated && (
                          <div className="absolute inset-y-0 right-0 w-[68px] border-l border-[#26243D]/10 bg-[#26243D]/[0.04]" />
                        )}
                      </div>
                    </div>

                    <div className="px-4 py-2.5 border-t border-[color:var(--glass-hairline)] bg-[color:var(--glass-page-base)]">
                      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px]">
                        <div className="flex items-center gap-2.5 min-w-[180px] flex-1">
                          <div className="h-1.5 w-28 shrink-0 rounded-full bg-[color:var(--depth-1-bg)] overflow-hidden flex gap-px">
                            {breakdownEntries
                              .filter(([, count]) => count > 0)
                              .map(([fmt, count]) => (
                                <span
                                  key={fmt}
                                  className="glx-progress-grow"
                                  style={{
                                    width: `${(count / total) * 100}%`,
                                    backgroundColor: getCalendarFormatColor(fmt).border,
                                  }}
                                  title={`${fmt.toUpperCase()} ${count} 份`}
                                />
                              ))}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-[10.5px] tabular-nums text-[color:var(--ink-soft)]">
                            {breakdownEntries.slice(0, 4).map(([fmt, count]) => (
                              <span key={fmt}>
                                {fmt.toUpperCase()} <strong className="font-medium text-[color:var(--ink-strong)]">{count}</strong>
                              </span>
                            ))}
                            {extraFormats.length > 4 && <span>+{extraFormats.length - 4}</span>}
                          </div>
                        </div>
                        <div className="flex items-center gap-3 font-mono text-[10.5px] tabular-nums text-[color:var(--ink-soft)] shrink-0">
                          <span>
                            <strong className="font-semibold text-[color:var(--ink-strong)]">{eventTicks.length}</strong> 活跃日 · {inWindowEvents} 变动
                          </span>
                          {peakTick && (
                            <button
                              type="button"
                              onClick={() =>
                                setFocusedDate(
                                  effectiveFocusedDate === peakTick.date ? null : peakTick.date
                                )
                              }
                              onMouseEnter={() => setHoveredDate(peakTick.date)}
                              onMouseLeave={() => setHoveredDate(null)}
                              title={`点击聚焦峰值日 ${peakTick.date}（${peakTick.count} 条变动）`}
                              className="glx-pill-tactile rounded-full bg-card/90 px-2 py-0.5 border border-[color:var(--glass-hairline)] hover:border-[color:var(--accent-iris)] text-[color:var(--accent-iris-ink)] cursor-pointer"
                            >
                              峰值 {peakTick.date.slice(5)} · {peakTick.count}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </ScrollArea>

        <CardFrameFooter className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-t border-[color:var(--glass-hairline)] bg-card/85 px-4 py-2 shrink-0">
          <div className="flex flex-wrap items-center gap-3.5">
            {(['md', 'svg', 'pdf'] as const).map((fmt) => {
              const c = getCalendarFormatColor(fmt);
              return (
                <span key={fmt} className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: c.bg, border: `1px solid ${c.border}` }} />
                  <span className="font-mono text-[10px] uppercase text-[color:var(--ink-soft)]">{fmt.toUpperCase()}</span>
                </span>
              );
            })}
            <span className="flex items-center gap-1.5">
              <span
                className="inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-[4px] border border-[color:color-mix(in_srgb,var(--accent-iris)_50%,transparent)] bg-[color:color-mix(in_srgb,var(--accent-iris)_22%,var(--card))] px-1 font-mono text-[8.5px] font-semibold leading-none text-[color:var(--accent-iris-ink)]"
              >
                N
              </span>
              <span className="text-[10.5px] text-[color:var(--ink-soft)]">密集</span>
            </span>
            {hasUndated && (
              <span className="flex items-center gap-1.5">
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ border: `1px solid ${getCalendarFormatColor('undated').border}`, backgroundImage: UNDATED_STRIPES }}
                />
                <span className="font-mono text-[10px] text-[color:var(--ink-soft)]">待考</span>
              </span>
            )}
            {hasOlder && (
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full border border-[color:color-mix(in_srgb,var(--ink-soft)_60%,transparent)] bg-card/75" />
                <span className="text-[10.5px] text-[color:var(--ink-soft)]">更早</span>
              </span>
            )}
            {gapSlots.length > 0 && (
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-[3px] border border-dashed border-[color:color-mix(in_srgb,var(--ink-soft)_45%,transparent)] bg-[color:color-mix(in_srgb,var(--ink-soft)_6%,transparent)]" />
                <span className="text-[10.5px] text-[color:var(--ink-soft)]">空段</span>
              </span>
            )}
            <span className="flex items-center gap-1.5">
              <span className="w-px h-3 bg-[color:var(--accent-iris)]" />
              <span className="text-[10.5px] font-semibold text-[color:var(--accent-iris-deep)]">今日</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--stage-ink-exec)' }} />
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--stage-ink-deliver)' }} />
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--stage-ink-plan)' }} />
              <span className="text-[10.5px] text-[color:var(--ink-soft)]">事件</span>
            </span>
          </div>
        </CardFrameFooter>
      </CardFrame>

      {openSlot && (
        <SlotDayList
          date={openSlot.date}
          items={openSlot.items}
          anchorRect={openSlot.anchor}
          anchorEl={openSlot.anchorEl}
          onOpenDocument={(fileId) => {
            setOpenSlot(null);
            onOpenDocument(fileId);
          }}
          onJumpToStarMap={
            onJumpToStarMap
              ? (d) => {
                  setOpenSlot(null);
                  onJumpToStarMap(d);
                }
              : undefined
          }
          onClose={() => setOpenSlot(null)}
        />
      )}

      {openOlder && (
        <OlderSlotList
          label={openOlder.label}
          groups={openOlder.groups}
          anchorRect={openOlder.anchor}
          anchorEl={openOlder.anchorEl}
          onPickDate={(date, items, e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setOpenOlder(null);
            setOpenSlot({ date, items, anchor: anchorRectOf(rect), anchorEl: e.currentTarget });
          }}
          onJumpToStarMap={
            onJumpToStarMap
              ? (d) => {
                  setOpenOlder(null);
                  onJumpToStarMap(d);
                }
              : undefined
          }
          onClose={() => setOpenOlder(null)}
        />
      )}
    </section>
  );
}

function toPopoverAnchor(
  anchor: CalendarPopoverAnchorRect,
  anchorEl?: HTMLElement | null
) {
  if (anchorEl && anchorEl.isConnected) return anchorEl;
  const width = Math.max(1, anchor.right - anchor.left);
  const height = Math.max(1, anchor.bottom - anchor.top);
  return {
    getBoundingClientRect: () => ({
      x: anchor.left,
      y: anchor.top,
      left: anchor.left,
      top: anchor.top,
      right: anchor.right,
      bottom: anchor.bottom,
      width,
      height,
      toJSON: () => ({}),
    }),
  };
}

function CalendarPopoverShell({
  anchor,
  anchorEl,
  pos,
  onClose,
  children,
}: {
  anchor: CalendarPopoverAnchorRect;
  anchorEl?: HTMLElement | null;
  pos: CalendarPopoverPos;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (typeof document === 'undefined') {
    return (
      <div
        className="fixed z-[60]"
        style={{
          left: pos.left,
          top: pos.top,
          transformOrigin: pos.side === 'left' ? 'top right' : 'top left',
        }}
      >
        {children}
      </div>
    );
  }
  return (
    <Popover
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          anchor={toPopoverAnchor(anchor, anchorEl)}
          side={pos.side}
          align="start"
          sideOffset={CALENDAR_POPOVER_GAP}
          collisionPadding={{
            top: CALENDAR_POPOVER_MARGIN,
            bottom: CALENDAR_POPOVER_MARGIN,
            left: CALENDAR_POPOVER_MARGIN,
            right: CALENDAR_SIDE_PANEL_W + CALENDAR_POPOVER_MARGIN,
          }}
          collisionAvoidance={{ side: 'flip', align: 'shift' }}
          className="z-[60]"
          data-slot="popover-positioner"
        >
          <PopoverPrimitive.Popup
            data-slot="popover-popup"
            className="origin-(--transform-origin) outline-none"
          >
            {children}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </Popover>
  );
}

/**
 * 「历史/更早」槽的展开清单。
 *
 * 按日期分组而非直接平铺文档：窗口外历史数据可能跨多年，平铺会导致大量 DOM 一次性挂载；
 * 日期行最多展示 60 条（超出显式标注），点击某一天再进入当日清单（保持相同的身份折叠口径）。
 */
export function OlderSlotList({
  label,
  groups,
  left,
  top,
  anchorRect,
  anchorEl,
  onPickDate,
  onJumpToStarMap,
  onClose,
}: {
  label: string;
  groups: [string, FileRecord[]][];
  left?: number;
  top?: number;
  anchorRect?: CalendarPopoverAnchorRect;
  anchorEl?: HTMLElement | null;
  onPickDate: (date: string, items: FileRecord[], e: React.MouseEvent<HTMLButtonElement>) => void;
  onJumpToStarMap?: (date: string) => void;
  onClose: () => void;
}) {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const anchor = anchorRect ?? legacyAnchorRect(left, top);
  const pos = computeCalendarPopoverPos(
    anchor,
    { width: OLDER_LIST_POPOVER_W, height: OLDER_LIST_POPOVER_H },
    { width: vw, height: vh },
    calendarSidePanelSafeRight(vw)
  );
  const total = groups.reduce((sum, [, items]) => sum + items.length, 0);
  const shown = groups.slice(0, 60);
  const latestDate = groups[0]?.[0] ?? null;
  const inner = (
    <>
      <div className="sticky top-0 z-10 flex items-start justify-between gap-2 border-b border-[#26243D]/10 bg-popover/95 backdrop-blur-md px-3 py-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="whitespace-nowrap font-mono text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] font-medium tabular-nums text-[color:var(--ink-strong)]">
            {groups.length} 天 · {total} 份
          </span>
          <span
            className="truncate font-mono text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)]"
            title={label}
          >
            {label}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onJumpToStarMap && latestDate && (
            <button
              type="button"
              data-older-jump-starmap={latestDate}
              onClick={() => onJumpToStarMap(latestDate)}
              title={`在司辰星图中溯源最近日 ${latestDate}`}
              className="inline-flex items-center gap-0.5 rounded-full bg-[color:color-mix(in_srgb,var(--accent-iris)_12%,transparent)] px-2 py-0.5 text-[10px] font-medium text-[color:var(--accent-iris-deep)] hover:bg-[color:var(--accent-iris-deep)] hover:text-white cursor-pointer motion-safe:transition-colors"
            >
              <Compass className="w-2.5 h-2.5" strokeWidth={1.8} aria-hidden="true" />
              <span>星图</span>
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭更早清单"
            className="shrink-0 px-1 font-mono text-[length:var(--text-micro)] text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)] cursor-pointer"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="p-1.5">
        {shown.map(([date, items], idx) => (
          <button
            key={date}
            type="button"
            data-older-day={date}
            onClick={(e) => onPickDate(date, items, e)}
            title={`${date} · ${items.length} 份 · 点击展开当日清单`}
            style={{ '--glx-row-idx': Math.min(idx, 10) } as React.CSSProperties}
            className="glx-row-in flex w-full min-w-0 items-center gap-2 rounded-[8px] px-2 py-1.5 text-left hover:bg-[color:color-mix(in_srgb,var(--accent-iris)_8%,transparent)] cursor-pointer motion-safe:transition-colors"
          >
            <span className="font-mono text-[length:var(--text-micro)] tabular-nums text-[color:var(--ink-strong)]">{date}</span>
            <span className="ml-auto shrink-0 rounded-full bg-[color:var(--depth-1-bg-soft)] px-1.5 py-0.5 font-mono text-[10px] leading-none tabular-nums text-[color:var(--ink-soft)]">{items.length} 份</span>
          </button>
        ))}
        {groups.length > shown.length && (
          <p className="px-2 py-1 font-mono text-[length:var(--text-micro)] text-[color:var(--ink-soft)]">
            另有 {groups.length - shown.length} 天未列出（按日期倒序，最近的在前）
          </p>
        )}
      </div>
    </>
  );

  return (
    <CalendarPopoverShell anchor={anchor} anchorEl={anchorEl} pos={pos} onClose={onClose}>
      <div
        data-older-list=""
        className="glass-pop glx-popover-in w-[256px] max-h-[280px] overflow-y-auto rounded-[16px] border border-border bg-popover text-popover-foreground backdrop-blur-xl shadow-[0_18px_44px_rgba(38,36,61,0.16)]"
      >
        {inner}
      </div>
    </CalendarPopoverShell>
  );
}

/**
 * 同槽聚合芯片展开的当日清单 popover（非阻断，选条目即直达文档）。
 * position:fixed 锚在芯片点击时的视口坐标，避免 48px 行高、周轴右端与滚动容器裁剪；
 * 坐标由纯函数 computeCalendarPopoverPos 决定——右半区锚点一律向左展开，
 * 弹层右缘永不越过右侧「当日沉淀聚焦卡 / 最近 7 天」的安全界（vw − 290）。
 * 条目数 = 该槽全部份数（与芯片 +N 同一口径），每条回调 onOpenDocument(file_id)。
 *
 * 清单按「哈希→同名」身份折叠，避免同一文档的多份拷贝逐份刷屏：
 * 单成员身份组保持原条目渲染（data-slot-day-item / data-file-id / 头计数口径不变）；
 * 多成员组折成一行「PLAN ×38 · 12 种内容」（×N=拷贝份数，K=不同内容哈希数，均如实统计），
 * 展开才见每份完整 relative_path（成员行仍逐条携带 data-file-id、回调 onOpenDocument）。
 */
export function SlotDayList({
  date,
  items,
  left,
  top,
  anchorRect,
  anchorEl,
  onOpenDocument,
  onJumpToStarMap,
  onClose,
}: {
  date: string;
  items: FileRecord[];
  left?: number;
  top?: number;
  anchorRect?: CalendarPopoverAnchorRect;
  anchorEl?: HTMLElement | null;
  onOpenDocument: (fileId: string) => void;
  onJumpToStarMap?: (date: string) => void;
  onClose: () => void;
}) {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const anchor = anchorRect ?? legacyAnchorRect(left, top);
  const pos = computeCalendarPopoverPos(
    anchor,
    { width: SLOT_DAY_LIST_POPOVER_W, height: SLOT_DAY_LIST_POPOVER_H },
    { width: vw, height: vh },
    calendarSidePanelSafeRight(vw)
  );
  const [filterText, setFilterText] = useState('');
  const identityGroups = useMemo(
    () =>
      groupByIdentity(
        items.map((f) => ({ item: f, path: f.relative_path, hash: currentHashOf(f) }))
      ),
    [items]
  );
  const filteredGroups = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return identityGroups;
    return identityGroups.filter(
      (g) =>
        g.displayName.toLowerCase().includes(q) ||
        g.prefix.toLowerCase().includes(q) ||
        g.members.some(
          (f) => f.title.toLowerCase().includes(q) || f.relative_path.toLowerCase().includes(q)
        )
    );
  }, [identityGroups, filterText]);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const folderLabel = useMemo(() => {
    const folders = Array.from(
      new Set(items.map((f) => (f.folder && f.folder !== '.' ? f.folder : '根目录')))
    );
    if (folders.length === 0) return '目录待考';
    if (folders.length === 1) return folders[0];
    return `${folders.length} 个目录`;
  }, [items]);
  const inner = (
    <>
      <div className="shrink-0 flex items-start justify-between gap-2 border-b border-[#26243D]/10 bg-popover/95 backdrop-blur-md px-3 py-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="whitespace-nowrap font-mono text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] font-medium tabular-nums text-[color:var(--ink-strong)]">
              {date} · {items.length} 份
            </span>
            <span
              className="truncate font-mono text-[length:var(--text-micro)] leading-[var(--lh-micro)] text-[color:var(--ink-soft)]"
              title={folderLabel}
            >
              {folderLabel} · {identityGroups.length} 类
            </span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {onJumpToStarMap && (
              <button
                type="button"
                data-slot-jump-starmap={date}
                onClick={() => onJumpToStarMap(date)}
                title={`在司辰星图中溯源 ${date}`}
                className="inline-flex items-center gap-0.5 rounded-full bg-[color:color-mix(in_srgb,var(--accent-iris)_12%,white)] px-2 py-0.5 text-[10px] font-medium text-[color:var(--accent-iris-deep)] hover:bg-[color:var(--accent-iris-deep)] hover:text-white cursor-pointer motion-safe:transition-colors"
              >
                <Compass className="w-2.5 h-2.5" strokeWidth={1.8} aria-hidden="true" />
                <span>星图</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭当日清单"
              className="px-1 font-mono text-[length:var(--text-micro)] text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)] cursor-pointer"
            >
              ✕
            </button>
          </div>
        </div>
        {items.length > 6 && (
          <div className="shrink-0 border-b border-border/70 bg-card/75 px-2.5 py-1.5">
            <div className="flex items-center gap-1.5 rounded-[var(--r-ctl)] border border-border bg-card px-2 py-1 focus-within:border-[color:var(--ring)] focus-within:ring-2 focus-within:ring-[color:color-mix(in_srgb,var(--ring)_35%,transparent)]">
              <Search className="w-3 h-3 text-[color:var(--ink-soft)] shrink-0" aria-hidden="true" />
              <input
                type="text"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                placeholder={`筛选当日 ${items.length} 份文档…`}
                aria-label="筛选当日文档"
                className="w-full min-w-0 bg-transparent text-[length:var(--text-micro)] text-[color:var(--ink-strong)] placeholder:text-[color:var(--ink-soft)] focus-visible:outline-none"
              />
              {filterText && (
                <button
                  type="button"
                  onClick={() => setFilterText('')}
                  aria-label="清空筛选"
                  className="text-[10px] text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)] cursor-pointer"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-y-auto p-1.5">
          {filteredGroups.length === 0 ? (
            <p className="px-2 py-4 text-center text-[11px] text-[color:var(--ink-soft)]">
              未匹配到含「{filterText}」的文档
            </p>
          ) : (
            filteredGroups.map((g, gIdx) => {
              if (g.members.length === 1) {
                const f = g.members[0];
                return (
                  <button
                    key={g.key}
                    type="button"
                    data-slot-day-item=""
                    data-file-id={f.file_id}
                    onClick={() => onOpenDocument(f.file_id)}
                    title={`${f.title} · ${f.relative_path}`}
                    style={{ '--glx-row-idx': Math.min(gIdx, 10) } as React.CSSProperties}
                    className="glx-row-in flex w-full min-w-0 items-center gap-2 rounded-[8px] px-2 py-1.5 text-left hover:bg-[color:color-mix(in_srgb,var(--accent-iris)_8%,transparent)] cursor-pointer motion-safe:transition-colors"
                  >
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: getCalendarFormatColor(f.format).border }}
                    />
                    <span className="truncate font-mono text-[length:var(--text-micro)] text-[color:var(--ink-strong)]">{f.title}</span>
                    <span className="ml-auto shrink-0 font-mono text-[length:var(--text-micro)] tabular-nums text-[color:var(--ink-soft)]">{date}</span>
                  </button>
                );
              }
              const open = expandedGroups.has(g.key);
              const kindsLabel =
                g.contentKinds > 0 ? `${g.contentKinds} 种内容` : '内容待考';
              return (
                <div key={g.key} className="mt-0.5">
                  <button
                    type="button"
                    data-slot-day-group={g.key}
                    onClick={() => toggleGroup(g.key)}
                    title={`同一份文档的 ${g.members.length} 份拷贝 · ${kindsLabel} · 点击展开/收起每份完整路径`}
                    className="flex w-full min-w-0 items-center gap-1.5 rounded-[8px] px-2 py-1.5 text-left hover:bg-[color:color-mix(in_srgb,var(--accent-iris)_8%,transparent)] cursor-pointer motion-safe:transition-colors"
                  >
                    <span aria-hidden="true" className="shrink-0 font-mono text-[length:var(--text-micro)] leading-none text-[color:var(--ink-soft)]">
                      {open ? '▾' : '▸'}
                    </span>
                    <span className="min-w-0 truncate font-mono text-[length:var(--text-micro)] font-medium text-[color:var(--ink-strong)]">
                      {g.prefix && (
                        <span className="font-normal text-[color:var(--ink-soft)]">{g.prefix}/</span>
                      )}
                      {g.displayName}
                    </span>
                    <span className="ml-auto flex shrink-0 items-center gap-1">
                      <span className="rounded-[var(--r-ctl)] border border-[color:color-mix(in_srgb,var(--accent-iris)_60%,transparent)] px-1.5 py-0.5 font-mono text-[length:var(--text-micro)] font-medium leading-none text-[color:var(--accent-iris-deep)] tabular-nums">
                        ×{g.members.length}
                      </span>
                      <span className="font-mono text-[length:var(--text-micro)] tabular-nums text-[color:var(--ink-soft)]">{kindsLabel}</span>
                    </span>
                  </button>
                  {open &&
                    g.members.map((f) => (
                      <button
                        key={f.file_id}
                        type="button"
                        data-slot-day-item=""
                        data-file-id={f.file_id}
                        onClick={() => onOpenDocument(f.file_id)}
                        title={`${f.relative_path} · 点击打开该份拷贝`}
                        className="flex w-full min-w-0 items-start gap-2 rounded-[7px] px-2 py-1 pl-4 text-left hover:bg-[color:color-mix(in_srgb,var(--accent-iris)_8%,transparent)] cursor-pointer motion-safe:transition-colors"
                      >
                        <span
                          className="mt-[4px] h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ backgroundColor: getCalendarFormatColor(f.format).border }}
                        />
                        <span className="min-w-0 break-all font-mono text-[length:var(--text-micro)] leading-[1.45] text-[color:var(--ink-strong)]">
                          {(() => {
                            const pfx = minimalDirPrefix(
                              f.relative_path,
                              g.members.map((m) => m.relative_path)
                            );
                            return pfx ? `${pfx}/${basenameOf(f.relative_path)}` : basenameOf(f.relative_path);
                          })()}
                        </span>
                      </button>
                    ))}
                </div>
              );
            })
          )}
        </div>
    </>
  );

  return (
    <CalendarPopoverShell anchor={anchor} anchorEl={anchorEl} pos={pos} onClose={onClose}>
      <div
        className="glass-pop glx-popover-in w-[280px] max-h-[320px] flex flex-col overflow-hidden rounded-[16px] border border-border bg-popover text-popover-foreground backdrop-blur-xl shadow-[0_20px_48px_rgba(38,36,61,0.18)]"
        data-slot-day-list=""
      >
        {inner}
      </div>
    </CalendarPopoverShell>
  );
}
