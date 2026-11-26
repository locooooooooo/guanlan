import React, { useMemo, useState } from 'react';
import { Archive, ArrowRight, Compass, FileText, FileCode, FileSpreadsheet, Info, Sparkles, X } from 'lucide-react';
import type { FileRecord, TimelineEvent, FileFormat } from '../types/guanlan';
import { localDay } from '../utils/timeFormat';
import type { DesktopFileActionCallbacks } from './FileContextMenu';
import { getCalendarFormatColor } from '../utils/formatMeta';
import { Badge, ScrollArea } from './ui';

const DENSITY_LEVEL_BGS = [
  'bg-muted/85',
  'bg-[color:color-mix(in_srgb,var(--accent-iris)_12%,transparent)]',
  'bg-[color:color-mix(in_srgb,var(--accent-iris)_26%,transparent)]',
  'bg-[color:color-mix(in_srgb,var(--accent-iris)_45%,transparent)]',
  'bg-[color:color-mix(in_srgb,var(--accent-iris)_45%,transparent)] border-2 border-[color:var(--accent-iris)]',
];

export interface CalendarRecentItem { file_id: string; title: string; date: string; format: FileFormat; }
export interface CalendarSidePanelsProps {
  files: FileRecord[];
  events: TimelineEvent[];
  recentItems: CalendarRecentItem[];
  onOpenDocument: (fileId: string) => void;
  systemActions?: DesktopFileActionCallbacks;
  focusedDate?: string | null;
  hoveredDate?: string | null;
  onFocusDate?: (date: string | null) => void;
  onHoverDate?: (date: string | null) => void;
  onJumpToStarMap?: (date: string) => void;
}

interface DensityDay { date: string; count: number; }
interface DensityMonth { month: string; cells: DensityDay[]; total: number; activeDays: number; leadingEmpty: number; }

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'] as const;

const DENSITY_MONTH_CAP = 24;

function localToday(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dayLevelClass(n: number, isToday: boolean): string {
  const base =
    n === 0
      ? 'border-border/75 bg-muted/75 text-muted-foreground'
      : n === 1
        ? 'border-border/75 bg-[color:color-mix(in_srgb,var(--accent-iris)_12%,transparent)] text-[color:var(--ink-strong)]'
        : n <= 3
          ? 'border-border/75 bg-[color:color-mix(in_srgb,var(--accent-iris)_26%,transparent)] text-[color:var(--ink-strong)]'
          : n <= 6
            ? 'border-border/75 bg-[color:color-mix(in_srgb,var(--accent-iris)_45%,transparent)] text-[color:var(--ink-strong)]'
            : 'bg-[color:color-mix(in_srgb,var(--accent-iris)_45%,transparent)] border-2 border-[color:var(--accent-iris)] text-[color:var(--ink-strong)] font-semibold';
  return isToday ? base.replace('border-border/75', 'border-[color:color-mix(in_srgb,var(--accent-iris)_60%,transparent)]') : base;
}

/**
 * 活跃日期集合的最大月份（YYYY-MM）。
 * 为什么取最大：脏数据可能把最早有事件的月拉到多年前，迷你月历若按升序默认
 * 停在列表头部，读者第一眼会落在远古历史月；默认定位口径 = 最新活跃月份
 * （如 2026-11）。纯函数供单测断言；输入不要求有序（YYYY-MM-DD 字典序恒
 * 可比，内部取最大即可）；非字符串/非纯日期格式的输入跳过（调用方传来的
 * activeDayKeys 已是合法日历日，此处只作防御）。空集合返回 null（上层不渲染月历）。
 */
export function latestActiveMonth(days: string[]): string | null {
  let max: string | null = null;
  for (const d of days) {
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (max === null || d > max) max = d;
  }
  return max === null ? null : max.slice(0, 7);
}

/** 迷你热力月历远古空月断层判定阈值：相邻活跃月之间连续空白 > 12 个月即折叠为「更早归档」胶囊。 */
export const CALENDAR_ANCIENT_GAP_MONTHS = 12;

export type DensityMonthListEntry<T extends { month: string }> =
  | { kind: 'month'; item: T }
  | {
      kind: 'archive_gap';
      emptyMonths: number;
      newerMonth: string;
      olderMonth: string;
      label: string;
    };

function monthSerialOf(ym: string): number | null {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return null;
  return Number(m[1]) * 12 + (Number(m[2]) - 1);
}

/**
 * 迷你热力月历空月断层折叠纯函数：
 * 输入降序（新→旧）活跃月份序列，当相邻两个活跃月之间连续空月 > maxGapMonths（默认 12 个月）时，
 * 插入「更早归档」断层胶囊（如「更早归档 · 跨 13 年」），消除顶部「跳过 149 个空月」噪音。
 */
export function partitionCalendarDensityMonths<T extends { month: string }>(
  orderedDescMonths: readonly T[],
  maxGapMonths: number = CALENDAR_ANCIENT_GAP_MONTHS
): {
  entries: DensityMonthListEntry<T>[];
  hasAncientGap: boolean;
  ancientGapCount: number;
} {
  const entries: DensityMonthListEntry<T>[] = [];
  let ancientGapCount = 0;
  for (let i = 0; i < orderedDescMonths.length; i += 1) {
    const cur = orderedDescMonths[i];
    if (i > 0) {
      const prev = orderedDescMonths[i - 1];
      const prevSer = monthSerialOf(prev.month);
      const curSer = monthSerialOf(cur.month);
      if (prevSer !== null && curSer !== null) {
        const emptyMonths = prevSer - curSer - 1;
        if (emptyMonths > maxGapMonths) {
          ancientGapCount += 1;
          const years = Math.floor(emptyMonths / 12);
          const label =
            years >= 2
              ? `更早归档 · 跨 ${years} 年`
              : `更早归档 · ${emptyMonths} 个空月`;
          entries.push({
            kind: 'archive_gap',
            emptyMonths,
            newerMonth: prev.month,
            olderMonth: cur.month,
            label,
          });
        }
      }
    }
    entries.push({ kind: 'month', item: cur });
  }
  return {
    entries,
    hasAncientGap: ancientGapCount > 0,
    ancientGapCount,
  };
}

export function CalendarSidePanels({
  files,
  events,
  recentItems,
  onOpenDocument,
  systemActions,
  focusedDate = null,
  hoveredDate = null,
  onFocusDate,
  onHoverDate,
  onJumpToStarMap,
}: CalendarSidePanelsProps) {
  const today = localToday();
  const [showAllMonths, setShowAllMonths] = useState(false);
  const fileById = useMemo(() => new Map(files.map((f) => [f.file_id, f])), [files]);

  const density = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ev of events) {
      if (!ev.source_time) continue;
      const day = localDay(ev.source_time);
      if (!day) continue;
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    const activeDayKeys = Array.from(counts.keys()).sort();
    if (activeDayKeys.length === 0) {
      return {
        months: [] as DensityMonth[],
        activeDayCount: 0,
        skippedMonths: [] as string[],
        latestMonth: null as string | null,
      };
    }

    const monthKeys: string[] = [];
    for (const d of activeDayKeys) {
      const m = d.slice(0, 7);
      if (monthKeys[monthKeys.length - 1] !== m) monthKeys.push(m);
    }
    const activeSet = new Set(monthKeys);

    const skippedMonths: string[] = [];
    const firstMonth = activeDayKeys[0].slice(0, 7);
    const lastMonth = activeDayKeys[activeDayKeys.length - 1].slice(0, 7);
    let [yy, mm] = firstMonth.split('-').map(Number);
    for (let guard = 0; guard < 800; guard += 1) {
      const key = `${yy}-${String(mm).padStart(2, '0')}`;
      if (!activeSet.has(key)) skippedMonths.push(key);
      if (key === lastMonth) break;
      mm += 1;
      if (mm > 12) {
        mm = 1;
        yy += 1;
      }
    }

    const months: DensityMonth[] = monthKeys.map((month) => {
      const [y, m] = month.split('-').map(Number);
      const lastDayOfMonth = new Date(y, m, 0).getDate();
      const firstDowMon = (new Date(y, m - 1, 1).getDay() + 6) % 7;
      const cells: DensityDay[] = [];
      let total = 0;
      let active = 0;
      for (let day = 1; day <= lastDayOfMonth; day += 1) {
        const date = `${month}-${String(day).padStart(2, '0')}`;
        const n = counts.get(date) ?? 0;
        total += n;
        if (n > 0) active += 1;
        cells.push({ date, count: n });
      }
      return { month, cells, total, activeDays: active, leadingEmpty: firstDowMon };
    });

    return {
      months,
      activeDayCount: activeDayKeys.length,
      skippedMonths,
      latestMonth: latestActiveMonth(activeDayKeys),
    };
  }, [events]);

  const orderedMonths = useMemo(() => [...density.months].reverse(), [density.months]);
  const visibleMonths =
    showAllMonths || orderedMonths.length <= DENSITY_MONTH_CAP
      ? orderedMonths
      : orderedMonths.slice(0, DENSITY_MONTH_CAP);
  const foldedMonthCount = density.months.length - visibleMonths.length;
  const partitionedMonths = useMemo(
    () => partitionCalendarDensityMonths(visibleMonths),
    [visibleMonths]
  );
  const focusMonth = density.latestMonth;
  const skippedRange =
    density.skippedMonths.length > 0
      ? `${density.skippedMonths[0]} ~ ${density.skippedMonths[density.skippedMonths.length - 1]}`
      : '';

  const progress = useMemo(() => {
    const totalDocs = files.length;
    const datedDocs = files.filter((f) => Boolean(f.revisions[0]?.source_time)).length;
    const totalEvents = events.length;
    const datedEvents = events.filter((e) => Boolean(e.source_time)).length;
    const totalRevisions = files.reduce((s, f) => s + f.revisions.length, 0);
    const datedRevisions = files.reduce((s, f) => s + f.revisions.filter((r) => Boolean(r.source_time)).length, 0);
    return { datedDocs, totalDocs, datedEvents, totalEvents, datedRevisions, totalRevisions };
  }, [files, events]);

  const focusedDayDetail = useMemo(() => {
    if (!focusedDate) return null;
    const docs = files.filter((f) => {
      const st = f.revisions[0]?.source_time;
      return st ? localDay(st) === focusedDate : false;
    });
    const evCount = events.filter((e) => (e.source_time ? localDay(e.source_time) === focusedDate : false)).length;
    return { date: focusedDate, docs, evCount };
  }, [focusedDate, files, events]);

  const docCoveragePct =
    progress.totalDocs > 0 ? Math.round((progress.datedDocs / progress.totalDocs) * 100) : 0;
  const ringCircumference = 2 * Math.PI * 11.5;
  const ringOffset = Number((ringCircumference * (1 - docCoveragePct / 100)).toFixed(2));

  return (
    <aside className="w-[276px] shrink-0 h-full">
      <ScrollArea scrollFade className="h-full" viewportClassName="pt-2.5 pr-3.5 pb-3.5 pl-0">
      <div className="flex flex-col gap-2.5">
        {focusedDayDetail && (
          <section
            key={`focus-${focusedDayDetail.date}`}
            data-calendar-focus-card={focusedDayDetail.date}
            className="glx-focus-card-in depth-2-card !rounded-[16px] border border-[color:color-mix(in_srgb,var(--accent-iris)_35%,transparent)] bg-[color:color-mix(in_srgb,var(--accent-iris)_6%,var(--card))] p-3.5"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <Sparkles className="w-3.5 h-3.5 text-[color:var(--accent-iris-deep)] shrink-0" aria-hidden="true" />
                <p className="font-mono text-[12px] font-semibold tabular-nums text-[color:var(--accent-iris-ink)] truncate">
                  {focusedDayDetail.date}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {onJumpToStarMap && (
                  <button
                    type="button"
                    data-side-jump-starmap={focusedDayDetail.date}
                    onClick={() => onJumpToStarMap(focusedDayDetail.date)}
                    title={`在司辰星图中查看 ${focusedDayDetail.date}`}
                    className="glx-pill-tactile inline-flex items-center gap-1 rounded-full bg-[color:var(--accent-iris-deep)] px-2 py-0.5 text-[10px] font-medium text-white shadow-[0_2px_8px_rgba(84,70,160,0.28)] hover:brightness-105 cursor-pointer"
                  >
                    <Compass className="w-2.5 h-2.5" strokeWidth={1.8} aria-hidden="true" />
                    <span>星图溯源</span>
                  </button>
                )}
                {onFocusDate && (
                  <button
                    type="button"
                    aria-label="关闭当日聚焦"
                    onClick={() => onFocusDate(null)}
                    className="w-5 h-5 rounded-full flex items-center justify-center text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)] hover:bg-card/85 cursor-pointer"
                  >
                    <X className="w-3 h-3" strokeWidth={2} aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
            <p className="mt-1 font-mono text-[10.5px] tabular-nums text-[color:var(--ink-soft)]">
              {focusedDayDetail.docs.length} 份文档 · {focusedDayDetail.evCount} 条变动
            </p>
            {focusedDayDetail.docs.length > 0 ? (
              <div className="mt-2 space-y-0.5">
                {focusedDayDetail.docs.slice(0, 5).map((f, idx) => {
                  const c = getCalendarFormatColor(f.format);
                  return (
                    <button
                      key={f.file_id}
                      type="button"
                      onClick={() => onOpenDocument(f.file_id)}
                      title={`${f.relative_path} · 点击打开`}
                      style={{ '--glx-row-idx': idx } as React.CSSProperties}
                      className="group/fdoc glx-row-in flex w-full items-center gap-2 rounded-[8px] px-2 py-1 text-left bg-card/75 hover:bg-card cursor-pointer motion-safe:transition-colors"
                    >
                      <span
                        aria-hidden="true"
                        className="size-1.5 rounded-full shrink-0"
                        style={{ backgroundColor: c.border }}
                      />
                      <span className="flex-1 min-w-0 truncate text-[11.5px] text-[color:var(--ink-strong)] group-hover/fdoc:text-[color:var(--accent-iris-deep)] motion-safe:transition-colors">
                        {f.title}
                      </span>
                      <ArrowRight className="w-3 h-3 text-[color:var(--accent-iris-deep)] opacity-0 -translate-x-1 group-hover/fdoc:opacity-100 group-hover/fdoc:translate-x-0 motion-safe:transition-all shrink-0" aria-hidden="true" />
                    </button>
                  );
                })}
                {focusedDayDetail.docs.length > 5 && (
                  <p className="px-2 pt-1 font-mono text-[10px] text-[color:var(--ink-soft)]">
                    另有 {focusedDayDetail.docs.length - 5} 份文档
                  </p>
                )}
              </div>
            ) : (
              <p className="mt-1.5 text-[11px] text-[color:var(--ink-soft)]">当日仅有演变事件记录</p>
            )}
          </section>
        )}

        <section className="depth-2-card !rounded-[16px] p-3.5">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <p className="text-[length:var(--text-item-title)] leading-[var(--lh-item-title)] font-semibold text-[color:var(--ink-strong)]">最近 7 天</p>
            {recentItems.length > 0 && (
              <span className="rounded-full bg-[color:var(--depth-1-bg-soft)] px-2 py-0.5 font-mono text-[10px] leading-none tabular-nums text-[color:var(--ink-soft)]">
                {recentItems.length}
              </span>
            )}
          </div>
          {recentItems.length === 0 ? (
            <p className="mt-1.5 text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] text-[color:var(--ink-soft)]">暂无新文档</p>
          ) : (
            <div className="space-y-0.5" onMouseLeave={() => onHoverDate?.(null)}>
              {recentItems.slice(0, 6).map((it, idx) => {
                const c = getCalendarFormatColor(it.format);
                const targetFile = fileById.get(it.file_id);
                const isRecActive = focusedDate === it.date || hoveredDate === it.date;
                return (
                  <button
                    key={it.file_id}
                    type="button"
                    title={targetFile ? `${targetFile.relative_path} · ${it.date} · ${it.format.toUpperCase()}` : `${it.title} · ${it.date}`}
                    onClick={() => onOpenDocument(it.file_id)}
                    onMouseEnter={() => onHoverDate?.(it.date)}
                    onFocus={() => onHoverDate?.(it.date)}
                    onContextMenu={(e) => {
                      if (!targetFile || !systemActions?.onOpenFileContextMenu) return;
                      e.preventDefault();
                      e.stopPropagation();
                      systemActions.onOpenFileContextMenu(e, {
                        kind: 'file',
                        relativePath: targetFile.relative_path,
                        title: targetFile.title,
                        fileId: targetFile.file_id,
                        revisionId: targetFile.current_revision_id,
                      });
                    }}
                    style={{ '--glx-row-idx': idx } as React.CSSProperties}
                    className={`group/rec glx-row-in flex w-full items-center gap-2 rounded-[8px] px-2 py-1 text-left cursor-pointer motion-safe:transition-colors ${
                      isRecActive
                        ? 'bg-[color:color-mix(in_srgb,var(--accent-iris)_10%,transparent)]'
                        : 'hover:bg-[color:color-mix(in_srgb,var(--accent-iris)_8%,transparent)]'
                    }`}
                  >
                    <span className="shrink-0 opacity-85 group-hover/rec:opacity-100 motion-safe:transition-opacity" style={{ color: c.text }}>
                      {it.format === 'svg' ? <FileCode className="h-3.5 w-3.5" /> : it.format === 'pdf' ? <FileSpreadsheet className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}
                    </span>
                    <span className="flex-1 min-w-0 truncate text-[12px] leading-[18px] text-[color:var(--ink-strong)] group-hover/rec:text-[color:var(--accent-iris-deep)] group-hover/rec:translate-x-[2px] motion-safe:transition-all">{it.title}</span>
                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-[color:var(--ink-soft)] opacity-80">{it.date.slice(5)}</span>
                    <span
                      aria-hidden="true"
                      className="size-1.5 rounded-full shrink-0"
                      style={{ backgroundColor: c.border }}
                    />
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="depth-2-card !rounded-[16px] p-3.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <p className="text-[length:var(--text-item-title)] leading-[var(--lh-item-title)] font-semibold text-[color:var(--ink-strong)]">
                纳入概览
              </p>
              <span
                title="口径：按材料记载时间计入当日；观澜采集时间仅作辅助刻度，不作日期依据。"
                className="inline-flex items-center justify-center text-[color:var(--ink-faint)] hover:text-[color:var(--accent-iris-deep)] cursor-help motion-safe:transition-colors"
                aria-label="日期归属口径说明"
              >
                <Info className="h-3.5 w-3.5" />
              </span>
            </div>
            <div
              className="relative w-7 h-7 flex items-center justify-center shrink-0"
              title={`已纳入有日期文档 ${progress.datedDocs} / ${progress.totalDocs}（${docCoveragePct}%）`}
            >
              <svg width="28" height="28" viewBox="0 0 28 28" className="-rotate-90" aria-hidden="true">
                <circle
                  cx="14"
                  cy="14"
                  r="11.5"
                  fill="none"
                  stroke="color-mix(in srgb, var(--accent-iris) 14%, transparent)"
                  strokeWidth="2.5"
                />
                <circle
                  cx="14"
                  cy="14"
                  r="11.5"
                  fill="none"
                  stroke="var(--accent-iris)"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray={ringCircumference}
                  strokeDashoffset={ringOffset}
                  className="glx-ring-draw"
                  style={{ '--glx-ring-offset': ringOffset } as React.CSSProperties}
                />
              </svg>
              <span className="absolute font-mono text-[8px] font-semibold tabular-nums text-[color:var(--accent-iris-ink)]">
                {docCoveragePct}%
              </span>
            </div>
          </div>
          <div className="mt-2.5 grid grid-cols-3 gap-2">
            {[
              { label: '文档', dated: progress.datedDocs, total: progress.totalDocs, bar: 'var(--accent-iris)' },
              { label: '事件', dated: progress.datedEvents, total: progress.totalEvents, bar: '#26C0DB' },
              { label: '版本', dated: progress.datedRevisions, total: progress.totalRevisions, bar: '#8E8AE6' },
            ].map((item) => {
              const pct = item.total > 0 ? Math.round((item.dated / item.total) * 100) : 0;
              return (
                <div
                  key={item.label}
                  title={`${item.label}：已纳入 ${item.dated} / ${item.total} (${pct}%)`}
                  className="rounded-[10px] bg-[color:var(--depth-1-bg-soft)] px-2.5 py-2"
                >
                  <div className="text-[10px] text-[color:var(--ink-soft)]">{item.label}</div>
                  <div className="mt-0.5 font-mono text-[12px] font-semibold tabular-nums text-[color:var(--ink-strong)] truncate">
                    {item.dated}
                  </div>
                  <div className="mt-1.5 h-1 w-full rounded-full bg-[#26243D]/10 overflow-hidden">
                    <div
                      className="glx-progress-grow h-full rounded-full"
                      style={{ width: `${pct}%`, backgroundColor: item.bar }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="depth-2-card !rounded-[16px] p-3.5">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[length:var(--text-item-title)] leading-[var(--lh-item-title)] font-semibold text-[color:var(--ink-strong)]">{density.activeDayCount} 天有事件</p>
            <span className="font-mono text-[length:var(--text-micro)] tabular-nums text-[color:var(--ink-soft)]">{events.length} 条</span>
          </div>
          {density.months.length === 0 ? (
            <p className="mt-2 text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] text-[color:var(--ink-soft)]">暂无事件</p>
          ) : (
            <>
              <p
                data-density-skipped={density.skippedMonths.length}
                title={density.skippedMonths.length > 0 ? `已跳过 ${density.skippedMonths.length} 个空月：${skippedRange}` : undefined}
                className="mt-0.5 truncate text-[10px] font-mono tabular-nums text-[color:var(--ink-soft)] opacity-80"
              >
                {density.months.length} 个活跃月
                {partitionedMonths.hasAncientGap
                  ? ' · 含更早归档'
                  : density.skippedMonths.length > 0
                    ? ` · 跳过 ${density.skippedMonths.length} 个空月`
                    : ''}
              </p>
              {foldedMonthCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAllMonths(true)}
                  data-density-expand={foldedMonthCount}
                  className="mt-1 text-[length:var(--text-micro)] text-[color:var(--accent-iris-deep)] hover:underline cursor-pointer"
                >
                  展开更早 {foldedMonthCount} 个月 ▾
                </button>
              )}
              <div className="mt-2 space-y-2.5" onMouseLeave={() => onHoverDate?.(null)}>
                {partitionedMonths.entries.map((entry) => {
                  if (entry.kind === 'archive_gap') {
                    return (
                      <div
                        key={`gap-${entry.newerMonth}-${entry.olderMonth}`}
                        data-density-archive-gap={entry.emptyMonths}
                        title={`${entry.olderMonth} 至 ${entry.newerMonth} 之间连续 ${entry.emptyMonths} 个空月已折叠`}
                        className="flex items-center gap-2 py-0.5"
                      >
                        <span aria-hidden="true" className="h-px flex-1 border-t border-dashed border-[#26243D]/18" />
                        <Badge
                          variant="secondary"
                          size="sm"
                          className="gap-1 font-mono text-[9.5px] font-normal text-[color:var(--ink-soft)]"
                        >
                          <Archive className="w-2.5 h-2.5 shrink-0" aria-hidden="true" />
                          <span>{entry.label}</span>
                        </Badge>
                        <span aria-hidden="true" className="h-px flex-1 border-t border-dashed border-[#26243D]/18" />
                      </div>
                    );
                  }
                  const m = entry.item;
                  return (
                  <div
                    key={m.month}
                    data-density-month={m.month}
                    data-density-cells={m.cells.length}
                    data-density-focus={m.month === focusMonth ? 'true' : undefined}
                    className={
                      m.month === focusMonth
                        ? '-mx-1.5 rounded-[10px] bg-[color:color-mix(in_srgb,var(--accent-iris)_6%,transparent)] p-1.5'
                        : undefined
                    }
                  >
                    <div className="mb-1 flex items-center gap-1.5">
                      <span className="text-[length:var(--text-micro)] font-mono font-medium text-[color:var(--accent-iris-deep)] tabular-nums">{m.month}</span>
                      {m.month === focusMonth && (
                        <span
                          data-density-focus-tag=""
                          className="rounded-[var(--r-pill)] border border-[color:color-mix(in_srgb,var(--accent-iris)_55%,transparent)] bg-[color:color-mix(in_srgb,var(--accent-iris)_10%,transparent)] px-1.5 py-0.5 text-[9.5px] font-medium leading-none text-[color:var(--accent-iris-ink)]"
                        >
                          最新
                        </span>
                      )}
                      <span aria-hidden="true" className="h-px flex-1 bg-[#26243D]/10" />
                      <span className="text-[10px] font-mono tabular-nums text-[color:var(--ink-soft)]">
                        {m.total} · {m.activeDays}天
                      </span>
                    </div>
                    <div className="mb-1 grid grid-cols-7 gap-1 text-center font-mono text-[length:var(--text-micro)] text-[color:var(--ink-soft)]">
                      {WEEKDAY_LABELS.map((w) => (
                        <span key={w}>{w}</span>
                      ))}
                    </div>
                    <div className="grid grid-cols-7 gap-1">
                      {Array.from({ length: m.leadingEmpty }).map((_, spIdx) => (
                        <span key={`sp-${spIdx}`} aria-hidden="true" className="h-[22px]" />
                      ))}
                      {m.cells.map((day, cIdx) => {
                        const isFocused = focusedDate === day.date;
                        const isHovered = hoveredDate === day.date;
                        return (
                          <button
                            key={day.date}
                            type="button"
                            data-density-cell={day.date}
                            title={`${day.date} · ${day.count} 条事件${day.count > 0 ? ' · 点击聚焦该日' : ''}`}
                            aria-pressed={isFocused}
                            onClick={() => onFocusDate?.(isFocused ? null : day.date)}
                            onMouseEnter={() => onHoverDate?.(day.date)}
                            onFocus={() => onHoverDate?.(day.date)}
                            style={{ '--glx-mini-idx': cIdx } as React.CSSProperties}
                            className={`glx-mini-cell h-[22px] rounded-[6px] border flex items-center justify-center text-[length:var(--text-micro)] font-mono tabular-nums cursor-pointer hover:z-10 ${dayLevelClass(day.count, day.date === today)} ${
                              isFocused
                                ? 'ring-2 ring-[color:var(--accent-iris-deep)] ring-offset-1 z-10 font-semibold'
                                : isHovered
                                  ? 'ring-1 ring-[color:var(--accent-iris)] z-10'
                                  : ''
                            }`}
                          >
                            {Number(day.date.slice(8, 10))}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  );
                })}
              </div>
              <div className="mt-2 flex items-center gap-1.5">
                <span className="text-[length:var(--text-micro)] text-[color:var(--ink-soft)]">少</span>
                {DENSITY_LEVEL_BGS.map((bg) => (
                  <span key={bg} className={`w-3.5 h-3.5 rounded-[var(--r-ctl)] shrink-0 ${bg}`} />
                ))}
                <span className="text-[length:var(--text-micro)] text-[color:var(--ink-soft)]">多</span>
              </div>
            </>
          )}
        </section>
      </div>
      </ScrollArea>
    </aside>
  );
}
