import React, { useEffect, useMemo, useState } from 'react';
import { Archive, BookOpen, Check, CheckCheck, RotateCcw, X } from 'lucide-react';
import type { FileRecord, WorkspaceConfig } from '../types/guanlan';
import type { ReadingStateMap } from '../utils/readingStateStore';
import { unreadStatusLabel } from '../utils/guanlanEngine';
import {
  computeReadingIslandStats,
  formatIslandQuotaLine,
  islandPercent,
  ISLAND_STATUS_COLORS,
  type IslandDocEntry,
  type ReadingIslandStats,
} from '../utils/readingIslandStats';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Frame, FramePanel } from './ui/frame';
import { ScrollArea } from './ui/scroll-area';
import { Sheet, SheetPopup } from './ui/sheet';

/**
 * V02 · 「阅读与存档」顶栏微胶囊 + coss Sheet (inset) 悬浮圆角抽屉。
 *
 * 相比旧版 `fixed right-0 top-1/2` 亮白竖条（U12 截屏实证压盖日历右侧栏、版本时光机右栏
 * 且在夜航画布形成刺眼白块）：
 * - 触发器收编为顶栏工具区的横向紧凑微胶囊（placement="header"），零 fixed 叠加、全站零遮挡、
 *   明暗双态自动跟随 `:root` / `.dark` 语义令牌；
 * - 展开态升级为 Base UI `Sheet (side="right" variant="inset")` 悬浮圆角抽屉，内置
 *   `Frame` 三环中文总览（「已读 / 未读 / 已落盘」）+ `ScrollArea (scrollFade)` 分组清单，
 *   支持 Esc 与遮罩点击关闭；
 * - 全部既有口径（GL-01 hasUnreadChanges、snapshotAvailable、config.quota）与测试锚点
 *   （data-island-ring/pill/panel/doc-row/persist-badge/quota-line/section）100% 保真。
 */

export interface ReadingIslandProps {
  files: FileRecord[];
  readingStates: ReadingStateMap;
  quota: WorkspaceConfig['quota'];
  /** 打开文档：App 侧复用续读入口（钉回上次读到的版本），组件只转发 file_id */
  onOpenDoc: (fileId: string) => void;
  /** 摆放形态：header=顶栏横向微胶囊（默认，零遮挡）；inline=标准三环按钮 */
  placement?: 'header' | 'inline';
  /** 抽屉内单文档 1-click 标为已读 / 标为未读 */
  onMarkFileRead?: (fileId: string, revisionId: string) => void;
  onMarkFileUnread?: (fileId: string) => void;
  /** 抽屉内一键确立当前工作区已读基线 */
  onMarkReadingBaseline?: () => Promise<boolean> | void;
}

// ---------- 迷你进度环 ----------

/**
 * 环描边生长纯函数（U11）：周长口径取整 100（r=15.9155），
 * stroke-dashoffset = 100 - percent（双端钳位 0..100）。
 */
export function islandRingDashOffset(percent: number): number {
  const clamped = Math.min(100, Math.max(0, percent));
  if (!Number.isFinite(clamped)) return 100;
  return Math.max(0, 100 - clamped);
}

interface IslandRingProps {
  /** 环语义名（已读/未读/已落盘），同时作 data-island-ring 标记值 */
  label: string;
  /** 0-100 取整百分比；0 时只画轨道弧 */
  percent: number;
  count: number;
  total: number;
  color: string;
  icon: React.ReactNode;
  /** 顶栏紧凑横向模式（18px 微环 + 百分比并排，零垂直占位） */
  compact?: boolean;
}

export function IslandRing({
  label,
  percent,
  count,
  total,
  color,
  icon,
  compact = false,
}: IslandRingProps) {
  const dashOffset = islandRingDashOffset(percent);
  const aria = `${label} ${count}/${total} · ${percent}%`;

  if (compact) {
    return (
      <div
        className="inline-flex items-center gap-1"
        data-island-ring={label}
        role="img"
        aria-label={aria}
        title={aria}
      >
        <div className="relative h-4 w-4 shrink-0">
          <svg viewBox="0 0 36 36" className="h-4 w-4 -rotate-90" aria-hidden="true">
            <circle
              cx="18"
              cy="18"
              r="15.9155"
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.14"
              strokeWidth="4.2"
            />
            {percent > 0 && (
              <circle
                cx="18"
                cy="18"
                r="15.9155"
                fill="none"
                stroke={color}
                strokeWidth="4.2"
                strokeLinecap="round"
                className="glx-ring-draw opacity-90 motion-safe:transition-opacity group-hover/island-pill:opacity-100"
                style={{ '--glx-ring-offset': String(dashOffset) } as React.CSSProperties}
                strokeDasharray="100"
                strokeDashoffset={dashOffset}
              />
            )}
          </svg>
          <div className="absolute inset-0 flex items-center justify-center text-foreground [&>svg]:size-2">
            {icon}
          </div>
        </div>
        <span className="text-[11px] leading-none font-mono tabular-nums text-muted-foreground group-hover/island-pill:text-foreground">
          {percent}%
        </span>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col items-center gap-1"
      data-island-ring={label}
      role="img"
      aria-label={aria}
      title={aria}
    >
      <div className="relative h-9 w-9">
        <svg viewBox="0 0 36 36" className="h-9 w-9 -rotate-90" aria-hidden="true">
          <circle
            cx="18"
            cy="18"
            r="15.9155"
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.12"
            strokeWidth="3.2"
          />
          {percent > 0 && (
            <circle
              cx="18"
              cy="18"
              r="15.9155"
              fill="none"
              stroke={color}
              strokeWidth="3.2"
              strokeLinecap="round"
              className="glx-ring-draw opacity-90 motion-safe:transition-opacity group-hover/island-pill:opacity-100"
              style={{ '--glx-ring-offset': String(dashOffset) } as React.CSSProperties}
              strokeDasharray="100"
              strokeDashoffset={dashOffset}
            />
          )}
        </svg>
        <div className="absolute inset-0 flex items-center justify-center text-foreground">
          {icon}
        </div>
      </div>
      <span className="text-[length:var(--text-micro)] leading-none font-mono tabular-nums text-muted-foreground">
        {percent}%
      </span>
    </div>
  );
}

// ---------- 展开面板：清单行与分组 ----------

const ISLAND_SECTION_PAGE_CAP = 60;

type IslandFilterTab = 'all' | 'updated' | 'unread' | 'read';

function DocRow({
  entry,
  onOpenDoc,
  onMarkFileRead,
  onMarkFileUnread,
}: {
  entry: IslandDocEntry;
  onOpenDoc: (fileId: string) => void;
  onMarkFileRead?: (fileId: string, revisionId: string) => void;
  onMarkFileUnread?: (fileId: string) => void;
}) {
  const isUnread = entry.readStatus === 'unread';
  const isUpdatedAfterRead = isUnread && entry.unreadReason === 'updated_since_last_read';
  const canToggleRead = isUnread
    ? Boolean(onMarkFileRead && entry.currentRevisionId)
    : Boolean(onMarkFileUnread);

  return (
    <div className="group/row relative flex items-stretch gap-1 rounded-xl border border-border bg-card not-dark:bg-clip-padding hover:bg-accent/60 transition-colors duration-[var(--dur-1)] motion-reduce:transition-none overflow-hidden">
      {isUpdatedAfterRead && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 w-[2.5px] bg-[color:var(--accent-wave)]"
        />
      )}
      <button
        type="button"
        data-island-doc-row={entry.fileId}
        onClick={() => onOpenDoc(entry.fileId)}
        title={entry.dirPrefix ? `${entry.dirPrefix}/${entry.title}` : entry.title}
        className="flex-1 min-w-0 text-left px-3 py-2 space-y-1 cursor-pointer"
      >
        <div className="flex items-center justify-between gap-2 min-w-0">
          <span className="text-xs font-medium text-foreground truncate min-w-0">
            {entry.dirPrefix && (
              <span className="font-mono text-[11px] text-muted-foreground mr-1">
                {entry.dirPrefix}/
              </span>
            )}
            {entry.title}
          </span>
          <Badge
            size="sm"
            variant={entry.persisted ? 'success' : 'warning'}
            data-persist-badge={entry.persisted ? 'on' : 'off'}
            title={
              entry.persisted
                ? '当前版本快照已落盘存档，可随时回看与对比'
                : '当前版本快照已被存档配额淘汰（未落盘），仅剩索引元数据'
            }
          >
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                entry.persisted ? 'bg-success' : 'bg-warning'
              }`}
            />
            {entry.persisted ? '已落盘' : '未落盘'}
          </Badge>
        </div>
        <div className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground">
          <span className="uppercase">{entry.format}</span>
          {isUnread ? (
            isUpdatedAfterRead ? (
              <span className="inline-flex items-center gap-1 rounded-full px-1.5 py-[0.5px] font-sans text-[10px] font-medium text-[color:var(--accent-wave)] bg-[color:color-mix(in_srgb,var(--accent-wave)_11%,transparent)] border border-[color:color-mix(in_srgb,var(--accent-wave)_24%,transparent)]">
                <span
                  aria-hidden="true"
                  className="size-1 rounded-full bg-[color:var(--accent-wave)] glx-unread-updated-dot shrink-0"
                />
                <span>{unreadStatusLabel(entry.unreadReason)}</span>
              </span>
            ) : (
              <span>{unreadStatusLabel(entry.unreadReason)}</span>
            )
          ) : (
            entry.scrollPercent > 0 && (
              <span className="tabular-nums">读到 {entry.scrollPercent}%</span>
            )
          )}
        </div>
        {isUnread && entry.scrollPercent > 0 && (
          <div className="h-1 rounded-full bg-muted overflow-hidden" data-scroll-bar="">
            <div
              className="h-full bg-[color:var(--accent-wave)]"
              style={{ width: `${entry.scrollPercent}%` }}
            />
          </div>
        )}
      </button>
      {canToggleRead && (
        <div className="flex items-center pr-2 shrink-0">
          <button
            type="button"
            data-island-toggle-read={entry.fileId}
            aria-label={isUnread ? `标为已读 ${entry.title}` : `标为未读 ${entry.title}`}
            title={isUnread ? '标为已读' : '标为未读'}
            onClick={(e) => {
              e.stopPropagation();
              if (isUnread && entry.currentRevisionId) {
                onMarkFileRead?.(entry.fileId, entry.currentRevisionId);
              } else if (!isUnread) {
                onMarkFileUnread?.(entry.fileId);
              }
            }}
            className={`inline-flex size-7 items-center justify-center rounded-lg border border-transparent cursor-pointer transition-colors ${
              isUnread
                ? 'text-muted-foreground hover:text-[color:var(--stage-ink-deliver-text)] dark:hover:text-[color:var(--success-foreground)] hover:bg-[color:color-mix(in_srgb,var(--status-green)_12%,transparent)] hover:border-[color:color-mix(in_srgb,var(--status-green)_24%,transparent)]'
                : 'text-muted-foreground hover:text-[color:var(--accent-wave)] hover:bg-[color:color-mix(in_srgb,var(--accent-wave)_12%,transparent)] hover:border-[color:color-mix(in_srgb,var(--accent-wave)_24%,transparent)]'
            }`}
          >
            {isUnread ? <Check className="w-3.5 h-3.5" /> : <RotateCcw className="w-3 h-3" />}
          </button>
        </div>
      )}
    </div>
  );
}

function IslandSection({
  label,
  color,
  entries,
  onOpenDoc,
  onMarkFileRead,
  onMarkFileUnread,
}: {
  label: string;
  color: string;
  entries: IslandDocEntry[];
  onOpenDoc: (fileId: string) => void;
  onMarkFileRead?: (fileId: string, revisionId: string) => void;
  onMarkFileUnread?: (fileId: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const visibleEntries =
    showAll || entries.length <= ISLAND_SECTION_PAGE_CAP
      ? entries
      : entries.slice(0, ISLAND_SECTION_PAGE_CAP);
  const hiddenCount = entries.length - visibleEntries.length;

  return (
    <div data-island-section={label}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold flex items-center gap-1.5" style={{ color }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
          {label}
        </span>
        <span className="text-[11px] font-mono tabular-nums text-muted-foreground">
          {entries.length}
        </span>
      </div>
      {entries.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground text-center">
          暂无
        </div>
      ) : (
        <div className="space-y-1.5">
          {visibleEntries.map((entry) => (
            <DocRow
              key={entry.fileId}
              entry={entry}
              onOpenDoc={onOpenDoc}
              onMarkFileRead={onMarkFileRead}
              onMarkFileUnread={onMarkFileUnread}
            />
          ))}
          {hiddenCount > 0 && (
            <button
              type="button"
              data-island-show-more={label}
              onClick={() => setShowAll(true)}
              className="w-full rounded-lg border border-border/80 bg-card/70 px-3 py-1.5 text-[11px] font-medium text-[color:var(--accent-iris-ink)] hover:bg-accent/60 cursor-pointer transition-colors"
            >
              展开其余 {hiddenCount} 份
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface ReadingIslandPanelProps {
  stats: ReadingIslandStats;
  quota: WorkspaceConfig['quota'];
  onOpenDoc: (fileId: string) => void;
  onClose: () => void;
  /** 是否嵌于 coss Sheet (inset) 内（内嵌时由 Sheet 承担外框与滑入过渡） */
  inSheet?: boolean;
  onMarkFileRead?: (fileId: string, revisionId: string) => void;
  onMarkFileUnread?: (fileId: string) => void;
  onMarkReadingBaseline?: () => Promise<boolean> | void;
}

export function ReadingIslandPanel({
  stats,
  quota,
  onOpenDoc,
  onClose,
  inSheet = false,
  onMarkFileRead,
  onMarkFileUnread,
  onMarkReadingBaseline,
}: ReadingIslandPanelProps) {
  const [entered, setEntered] = useState(inSheet);
  const [filterTab, setFilterTab] = useState<IslandFilterTab>('all');
  const [baselineBusy, setBaselineBusy] = useState(false);

  useEffect(() => {
    if (inSheet) return;
    const raf = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(raf);
  }, [inSheet]);

  const readEntries = stats.entries.filter((e) => e.readStatus === 'read');
  const unreadEntries = stats.entries.filter((e) => e.readStatus === 'unread');
  const updatedEntries = unreadEntries.filter(
    (e) => e.unreadReason === 'updated_since_last_read'
  );
  const readPct = islandPercent(stats.read, stats.total);
  const unreadPct = islandPercent(stats.unread, stats.total);
  const persistedPct = islandPercent(stats.persisted, stats.total);
  const readRatio = stats.total > 0 ? stats.read / stats.total : 0;

  return (
    <div
      className={
        inSheet
          ? 'flex h-full min-h-0 flex-col bg-popover text-popover-foreground'
          : 'glass-pop glx-t-panel flex w-80 max-h-[min(68vh,560px)] flex-col overflow-hidden rounded-2xl'
      }
      style={
        inSheet
          ? undefined
          : {
              transform: entered ? 'none' : 'translateX(16px)',
              opacity: entered ? 1 : 0,
            }
      }
      data-island-panel=""
      aria-label="阅读与存档概览面板"
    >
      <div className="shrink-0 border-b border-border bg-popover px-4 pt-4 pb-3 space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">
              阅读与存档 · {stats.total} 份
            </div>
            <div
              className="text-[11px] font-mono text-muted-foreground mt-0.5"
              data-quota-line=""
            >
              {formatIslandQuotaLine(quota)}
            </div>
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onClose}
            aria-label="收起阅读与存档面板"
          >
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>

        {/* V02：明确中文语义三项总览（已读 / 未读 / 已落盘），消除纯图标盲猜 */}
        <Frame>
          <FramePanel className="grid grid-cols-3 divide-x divide-border p-2.5">
            <div className="flex flex-col items-center gap-0.5 px-1">
              <span className="text-[11px] text-muted-foreground">已读</span>
              <span className="font-mono text-sm font-semibold tabular-nums text-[color:var(--stage-ink-deliver-text)] dark:text-[color:var(--success-foreground)]">
                {readPct}%
              </span>
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                {stats.read}/{stats.total}
              </span>
            </div>
            <div className="flex flex-col items-center gap-0.5 px-1">
              <span className="text-[11px] text-muted-foreground">未读</span>
              <span className="font-mono text-sm font-semibold tabular-nums text-[color:var(--accent-wave)]">
                {unreadPct}%
              </span>
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                {stats.unread}/{stats.total}
              </span>
            </div>
            <div className="flex flex-col items-center gap-0.5 px-1">
              <span className="text-[11px] text-muted-foreground">已落盘</span>
              <span className="font-mono text-sm font-semibold tabular-nums text-[color:var(--accent-iris-deep)]">
                {persistedPct}%
              </span>
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                {stats.persisted}/{stats.total}
              </span>
            </div>
          </FramePanel>
        </Frame>

        {/* 双色阅读覆盖进度轨（GPU scaleX 推进） + 一键确立基线 CTA */}
        <div className="space-y-2">
          <div
            data-island-progress-bar=""
            aria-hidden="true"
            className={`h-1.5 w-full rounded-full overflow-hidden ${
              stats.unread > 0
                ? 'bg-[color:color-mix(in_srgb,var(--accent-wave)_22%,transparent)]'
                : 'bg-muted'
            }`}
          >
            <div
              className="glx-read-meter-fill h-full w-full rounded-full bg-gradient-to-r from-[color:var(--status-green)] to-[color:var(--stage-ink-deliver)] dark:from-[color:var(--success)] dark:to-[color:var(--success-foreground)]"
              style={{ transform: `scaleX(${readRatio})` }}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <div
              data-island-filter-bar=""
              role="group"
              aria-label="筛选阅读状态"
              className="inline-flex items-center gap-1"
            >
              {(
                [
                  { id: 'all', label: '全部' },
                  ...(updatedEntries.length > 0
                    ? [{ id: 'updated' as const, label: `有更新 ${updatedEntries.length}` }]
                    : []),
                  { id: 'unread', label: '未读' },
                  { id: 'read', label: '已读' },
                ] as const
              ).map((tab) => {
                const active = filterTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    data-island-filter={tab.id}
                    aria-pressed={active}
                    onClick={() => setFilterTab(tab.id)}
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium cursor-pointer transition-colors ${
                      active
                        ? 'bg-[color:var(--chip-active-bg)] text-[color:var(--accent-iris-ink)] border border-[color:var(--chip-active-border)]'
                        : 'text-muted-foreground hover:text-foreground hover:bg-accent/60 border border-transparent'
                    }`}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>

            {stats.unread > 0 && onMarkReadingBaseline && (
              <button
                type="button"
                data-island-mark-baseline=""
                disabled={baselineBusy}
                onClick={() => {
                  if (baselineBusy) return;
                  setBaselineBusy(true);
                  void Promise.resolve(onMarkReadingBaseline()).finally(() =>
                    setBaselineBusy(false)
                  );
                }}
                title="一键将当前工作区全部未读文档推进为已读基线（8 秒内可撤销）"
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-[color:var(--accent-iris-ink)] bg-[color:color-mix(in_srgb,var(--accent-iris)_10%,transparent)] hover:bg-[color:color-mix(in_srgb,var(--accent-iris)_18%,transparent)] border border-[color:color-mix(in_srgb,var(--accent-iris)_24%,transparent)] disabled:opacity-50 cursor-pointer transition-colors shrink-0"
              >
                <CheckCheck className="w-3 h-3 shrink-0" />
                <span>{baselineBusy ? '处理中…' : '确立基线'}</span>
              </button>
            )}
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0" overscrollContain scrollFade>
        <div className="px-4 py-3 space-y-4">
          {(filterTab === 'all' || filterTab === 'read') && (
            <IslandSection
              label="已读"
              color={ISLAND_STATUS_COLORS.read}
              entries={readEntries}
              onOpenDoc={onOpenDoc}
              onMarkFileRead={onMarkFileRead}
              onMarkFileUnread={onMarkFileUnread}
            />
          )}
          {(filterTab === 'all' || filterTab === 'unread' || filterTab === 'updated') && (
            <IslandSection
              label="未读"
              color={ISLAND_STATUS_COLORS.unread}
              entries={filterTab === 'updated' ? updatedEntries : unreadEntries}
              onOpenDoc={onOpenDoc}
              onMarkFileRead={onMarkFileRead}
              onMarkFileUnread={onMarkFileUnread}
            />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ---------- 阅读与存档触发胶囊 + Inset Sheet 抽屉 ----------

export default function ReadingIsland({
  files,
  readingStates,
  quota,
  onOpenDoc,
  placement = 'header',
  onMarkFileRead,
  onMarkFileUnread,
  onMarkReadingBaseline,
}: ReadingIslandProps) {
  const [expanded, setExpanded] = useState(false);
  const stats = useMemo(
    () => computeReadingIslandStats(files, readingStates),
    [files, readingStates],
  );
  const compact = placement === 'header';

  return (
    <div
      className="inline-flex items-center select-none"
      data-reading-island=""
      data-island-placement={placement}
    >
      <button
        type="button"
        data-island-pill=""
        aria-expanded={expanded}
        aria-label={expanded ? '收起阅读与存档抽屉' : '打开阅读与存档抽屉'}
        title={`已读 ${stats.read} · 未读 ${stats.unread} · 已落盘 ${stats.persisted} / 共 ${stats.total} 份`}
        onClick={() => setExpanded((v) => !v)}
        className={
          compact
            ? 'group/island-pill relative inline-flex h-7 items-center gap-2 rounded-lg border border-input bg-popover not-dark:bg-clip-padding px-2 text-foreground shadow-xs transition-colors duration-[var(--dur-1)] motion-reduce:transition-none before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_rgba(0,0,0,0.04)] hover:bg-accent/60 dark:bg-input/35 dark:hover:bg-input/60 dark:before:shadow-[0_-1px_rgba(255,255,255,0.06)] cursor-pointer'
            : 'group/island-pill inline-flex items-center gap-3 rounded-xl border border-input bg-popover not-dark:bg-clip-padding px-3 py-2 shadow-xs hover:bg-accent/50 transition-colors duration-[var(--dur-1)] motion-reduce:transition-none cursor-pointer'
        }
      >
        <IslandRing
          compact={compact}
          label="已读"
          percent={islandPercent(stats.read, stats.total)}
          count={stats.read}
          total={stats.total}
          color={ISLAND_STATUS_COLORS.read}
          icon={<Check className="w-3.5 h-3.5" />}
        />
        <IslandRing
          compact={compact}
          label="未读"
          percent={islandPercent(stats.unread, stats.total)}
          count={stats.unread}
          total={stats.total}
          color={ISLAND_STATUS_COLORS.unread}
          icon={<BookOpen className="w-3.5 h-3.5" />}
        />
        <IslandRing
          compact={compact}
          label="已落盘"
          percent={islandPercent(stats.persisted, stats.total)}
          count={stats.persisted}
          total={stats.total}
          color={ISLAND_STATUS_COLORS.persisted}
          icon={<Archive className="w-3.5 h-3.5" />}
        />
      </button>

      {expanded && (
        <Sheet open={expanded} onOpenChange={setExpanded}>
          <SheetPopup
            side="right"
            variant="inset"
            showCloseButton={false}
            data-island-sheet=""
            className="max-w-sm overflow-hidden p-0"
          >
            <ReadingIslandPanel
              inSheet
              stats={stats}
              quota={quota}
              onOpenDoc={(fileId) => {
                onOpenDoc(fileId);
                setExpanded(false);
              }}
              onClose={() => setExpanded(false)}
              onMarkFileRead={onMarkFileRead}
              onMarkFileUnread={onMarkFileUnread}
              onMarkReadingBaseline={onMarkReadingBaseline}
            />
          </SheetPopup>
        </Sheet>
      )}
    </div>
  );
}
