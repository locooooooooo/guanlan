import React, { useMemo, useState } from 'react';
import {
  ArrowRight,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Clock,
  Compass,
  Eye,
  FileCode,
  FileSpreadsheet,
  FileText,
  FolderSearch,
  GitBranch,
  HelpCircle,
  History,
  RotateCcw,
  Scale,
} from 'lucide-react';
import type { DesktopFileActionCallbacks } from './FileContextMenu';
import { formatUiMeta } from '../utils/formatMeta';
import { Button, Chip } from './ui/primitives';
import {
  Badge,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Frame,
  FramePanel,
  SegmentedControl,
  SegmentedControlItem,
  Toolbar,
  ToolbarGroup,
  ToolbarSeparator,
} from './ui';
import {
  FileRecord,
  ReadingState,
  TimelineEvent,
  TimelineEventKind,
} from '../types/guanlan';
import { hasUnreadChanges, unreadStatusLabel } from '../utils/guanlanEngine';
import { cleanDisplayText } from '../utils/displayText';
import {
  eventKindLabel,
  foldSameFileDayVersions,
  polishChangedSectionTag,
  versionFoldCardTitle,
  versionFoldRangeLabel,
} from '../utils/graphEvents';
import type { SameFileDayVersionGroup } from '../utils/graphEvents';
import {
  basenameOf,
  groupByIdentity,
  isToolNoisePath,
  normalizePath,
} from '../utils/documentIdentity';
import type { IdentityItem } from '../utils/documentIdentity';
import { eventCardStamp, eventFilterDay } from '../utils/timeFormat';
import type { EventDaysResult, EventPage, EventPageItem } from '../services/workspaceClient';
import { taskPackageOf } from '../utils/taskPackages';
import {
  buildTimelineFocusGroups,
  collectNavigableTimelineEvents,
  useTimelineKeyboardNav,
  type TimelineFocusGroup,
  type TimelineRenderGroupSnapshot,
} from '../hooks/useTimelineKeyboardNav';

export { eventCardStamp, eventFilterDay };

interface TimelineViewProps {
  events: TimelineEvent[];
  page?: EventPage | null;
  loadingPage?: boolean;
  undatedOnly?: boolean;
  eventOrder?: 'occurred' | 'observed';
  onToggleOrder?: () => void;
  onLoadMore?: () => void;
  onRefresh?: () => void;
  onToggleUndated?: () => void;
  eventDays?: EventDaysResult | null;
  dateFilter?: string;
  onDateFilterChange?: (date: string) => void;
  kindFilter: TimelineEventKind | 'all';
  onKindFilterChange: (kind: TimelineEventKind | 'all') => void;
  onResetFilters?: () => void;
  files: FileRecord[];
  readingStates: Record<string, ReadingState>;
  selectedEventId: string;
  onSelectEvent: (event: TimelineEvent) => void;
  onOpenFileFromTimeline: (
    fileId: string,
    revisionId: string,
    mode: 'read' | 'diff_since_read' | 'relations' | 'history'
  ) => void;
  onOpenFileTimeline?: (fileId: string) => void;
  onQuickPreview?: (fileId: string, revisionId?: string) => void;
  onOpenDecisionFromTimeline: (decisionId: string) => void;
  onJumpToStarMap?: (day: string) => void;
  systemActions?: DesktopFileActionCallbacks;
}

/** 司辰时光流按日聚组（保序不重排，严格沿用 occurred/observed 当前单一口径） */
export interface TimelineDayBucket<T> {
  day: string;
  label: string;
  items: T[];
  eventCount: number;
}

export function groupTimelineRenderItemsByDay<T>(
  items: readonly T[],
  resolveDay: (item: T) => { day: string; eventCount: number }
): TimelineDayBucket<T>[] {
  const buckets: TimelineDayBucket<T>[] = [];
  for (const item of items) {
    const info = resolveDay(item);
    const dayKey = info.day && /^\d{4}-\d{2}-\d{2}$/.test(info.day) ? info.day : 'undated';
    const last = buckets[buckets.length - 1];
    if (last && last.day === dayKey) {
      last.items.push(item);
      last.eventCount += Math.max(1, info.eventCount);
    } else {
      buckets.push({
        day: dayKey,
        label: dayKey === 'undated' ? '日期待考' : dayKey,
        items: [item],
        eventCount: Math.max(1, info.eventCount),
      });
    }
  }
  return buckets;
}

export function pageItemToEvent(item: EventPageItem): TimelineEvent {
  const payload = (item.payload || {}) as Record<string, unknown>;
  const folder = item.file_path
    ? item.file_path.split(/[\\/]/).slice(0, -1).join('/') || '工作区'
    : '工作区';
  return {
    event_id: item.event_id,
    kind: item.kind as TimelineEvent['kind'],
    file_id: item.file_id || '',
    revision_id: item.revision_id || '',
    observed_at: item.observed_at,
    source_time: item.occurred_at || undefined,
    occurred_source: item.occurred_source ?? null,
    occurred_precision: item.occurred_precision ?? null,
    topic_lane: folder,
    headline: item.headline,
    detail: item.detail,
    format: item.format ?? null,
    changedSections: Array.isArray(payload.changed_sections)
      ? (payload.changed_sections as string[])
      : undefined,
    addedLines: typeof payload.added_lines === 'number' ? payload.added_lines : undefined,
    removedLines:
      typeof payload.removed_lines === 'number' ? payload.removed_lines : undefined,
    isRollback: payload.is_rollback === true,
    action: typeof payload.action === 'string' ? payload.action : undefined,
    time_basis: typeof payload.time_basis === 'string' ? payload.time_basis : null,
    decision_id:
      typeof payload.decision_id === 'string' ? payload.decision_id : undefined,
  };
}

const KIND_CHIP_COLORS: Record<TimelineEventKind, string> = {
  modified: 'bg-[color:var(--stage-ink-exec)]',
  appeared: 'bg-[color:var(--stage-ink-blueprint)]',
  discovered: 'bg-[color:var(--stage-ink-deliver)]',
  workspace_baseline: 'bg-[color:var(--stage-ink-deliver)]',
  read_recovered: 'bg-[color:var(--stage-ink-deliver)]',
  decision_changed: 'bg-[color:var(--stage-ink-plan)]',
  decision_raised: 'bg-[color:var(--stage-ink-plan)]',
  moved_or_copied: 'bg-[color:var(--stage-ink-decision)]',
  file_renamed: 'bg-[color:var(--stage-ink-decision)]',
  file_moved: 'bg-[color:var(--stage-ink-decision)]',
  file_trashed: 'bg-[color:var(--stage-ink-anomaly)]',
  missing: 'bg-[color:var(--stage-ink-anomaly)]',
  read_error: 'bg-[color:var(--stage-ink-anomaly)]',
};

const coreFileNameOf = (path: string): string =>
  normalizePath(path).split('/').pop() || '';

export const TimelineView: React.FC<TimelineViewProps> = ({
  events,
  page,
  loadingPage,
  undatedOnly,
  eventOrder = 'occurred',
  onToggleOrder,
  onLoadMore,
  onRefresh,
  onToggleUndated,
  eventDays = null,
  dateFilter: dateFilterProp,
  onDateFilterChange,
  kindFilter,
  onKindFilterChange,
  onResetFilters,
  files,
  readingStates,
  selectedEventId,
  onSelectEvent,
  onOpenFileFromTimeline,
  onOpenFileTimeline,
  onQuickPreview,
  onOpenDecisionFromTimeline,
  onJumpToStarMap,
  systemActions,
}) => {
  const sourceEvents = useMemo<TimelineEvent[]>(
    () => (page ? page.items.map(pageItemToEvent) : events),
    [page, events]
  );
  const [localDateFilter, setLocalDateFilter] = useState<string>('all');
  const dateFilter = dateFilterProp ?? localDateFilter;
  const changeDateFilter = (next: string) => {
    setLocalDateFilter(next);
    onDateFilterChange?.(next);
  };
  const [coreOnly, setCoreOnly] = useState(true);

  const noisePathByEventId = useMemo(() => {
    const pathById = new Map(files.map((f) => [f.file_id, f.relative_path]));
    const map = new Map<string, boolean>();
    for (const ev of sourceEvents) {
      const path = pathById.get(ev.file_id);
      map.set(ev.event_id, path ? isToolNoisePath(path) : false);
    }
    return map;
  }, [sourceEvents, files]);

  const hiddenNoiseCount = useMemo(
    () =>
      coreOnly
        ? sourceEvents.filter((ev) => noisePathByEventId.get(ev.event_id)).length
        : 0,
    [coreOnly, sourceEvents, noisePathByEventId]
  );
  const [collapsedBatches, setCollapsedBatches] = useState<Record<string, boolean>>({});
  const [openIdentityClusters, setOpenIdentityClusters] = useState<Record<string, boolean>>({});
  const [openVersionHistories, setOpenVersionHistories] = useState<Record<string, boolean>>({});

  const dateOptions = useMemo(() => {
    const dates = new Set<string>();
    if (eventDays && (eventDays.granularity ?? 'day') === 'day') {
      for (const group of eventDays.groups) {
        if (group.date) dates.add(group.date);
      }
    }
    if (dates.size === 0) {
      for (const ev of sourceEvents) {
        const day = eventFilterDay(ev, eventOrder);
        if (day) dates.add(day);
      }
    }
    return Array.from(dates).sort((a, b) => (a < b ? 1 : -1));
  }, [eventDays, sourceEvents, eventOrder]);

  const [dateScope, setDateScope] = useState<'recent7' | 'recent30' | 'all'>('recent30');
  const scopedDateOptions = useMemo(() => {
    if (dateScope === 'all' || dateOptions.length === 0) return dateOptions;
    const days = dateScope === 'recent7' ? 7 : 30;
    const newest = dateOptions[0];
    const cutoff = new Date(
      Date.parse(`${newest}T00:00:00Z`) - (days - 1) * 86400000
    )
      .toISOString()
      .slice(0, 10);
    return dateOptions.filter((d) => d >= cutoff);
  }, [dateOptions, dateScope]);
  const scopedMonthGroups = useMemo(() => {
    const byMonth = new Map<string, string[]>();
    for (const d of scopedDateOptions) {
      const month = d.slice(0, 7);
      const bucket = byMonth.get(month);
      if (bucket) bucket.push(d);
      else byMonth.set(month, [d]);
    }
    return Array.from(byMonth.entries());
  }, [scopedDateOptions]);

  const toggleBatch = (batchId: string) => {
    setCollapsedBatches((prev) => ({ ...prev, [batchId]: !prev[batchId] }));
  };

  const formatRevision = (rev: string) =>
    rev.length > 16 ? `${rev.slice(0, 8)}…${rev.slice(-6)}` : rev;

  const getEventKindLabel = (ev: TimelineEvent) =>
    ev.isRollback
      ? '恢复旧内容'
      : eventKindLabel({ kind: ev.kind, time_basis: ev.time_basis, action: ev.action });

  const filteredEvents = sourceEvents.filter((ev) => {
    if (coreOnly && noisePathByEventId.get(ev.event_id)) return false;
    if (!page && kindFilter !== 'all' && ev.kind !== kindFilter) return false;
    if (dateFilter !== 'all') {
      if (eventFilterDay(ev, eventOrder) !== dateFilter) return false;
    }
    return true;
  });

  const filesById = useMemo(() => new Map(files.map((f) => [f.file_id, f])), [files]);

  const revisionVersionById = useMemo(() => {
    const map = new Map<string, number>();
    for (const file of files) {
      for (const rev of file.revisions) map.set(rev.revision_id, rev.versionNumber);
    }
    return map;
  }, [files]);

  const versionFold = useMemo(
    () =>
      foldSameFileDayVersions(
        filteredEvents.map((ev) => ({
          eventId: ev.event_id,
          fileId: ev.file_id,
          kind: ev.kind,
          day: ev.batch_id ? '' : (eventFilterDay(ev, eventOrder) ?? ''),
          versionNumber: ev.revision_id
            ? revisionVersionById.get(ev.revision_id) ?? null
            : null,
        }))
      ),
    [filteredEvents, eventOrder, revisionVersionById]
  );

  const isClusterableEvent = (ev: TimelineEvent) =>
    Boolean(ev.file_id) &&
    ev.kind !== 'decision_raised' &&
    ev.kind !== 'decision_changed';

  const identityInfoByIndex = useMemo(() => {
    const info = new Map<number, { key: string; displayName: string; prefix: string }>();
    const inputs: IdentityItem<number>[] = [];
    filteredEvents.forEach((ev, i) => {
      if (ev.batch_id || !isClusterableEvent(ev)) return;
      const file = filesById.get(ev.file_id);
      const path = file?.relative_path;
      if (!path) return;
      const hash =
        file.revisions.find((r) => r.revision_id === ev.revision_id)?.content_sha256 ??
        file.revisions[0]?.content_sha256;
      inputs.push({ item: i, path, hash: hash || null });
    });
    for (const group of groupByIdentity(inputs)) {
      for (const idx of group.members) {
        info.set(idx, {
          key: group.key,
          displayName: group.displayName,
          prefix: group.prefix,
        });
      }
    }
    return info;
  }, [filteredEvents, filesById]);

  const identityClusters = useMemo(() => {
    const acc = new Map<
      string,
      { members: TimelineEvent[]; displayName: string; prefix: string; kind: TimelineEventKind }
    >();
    filteredEvents.forEach((ev, i) => {
      if (ev.batch_id) return;
      const ident = identityInfoByIndex.get(i);
      if (!ident) return;
      const stamp = eventCardStamp(ev, eventOrder);
      const timeKey = stamp.dayOnly ? `d:${stamp.stamp}` : `m:${stamp.stamp}`;
      const key = `${ident.key}|${timeKey}|${ev.kind}`;
      const bucket = acc.get(key);
      if (bucket) bucket.members.push(ev);
      else
        acc.set(key, {
          members: [ev],
          displayName: ident.displayName,
          prefix: ident.prefix,
          kind: ev.kind,
        });
    });
    return acc;
  }, [filteredEvents, identityInfoByIndex, eventOrder]);

  const groupedRenderList: Array<
    | { type: 'batch'; batchId: string; batchTitle: string; items: TimelineEvent[] }
    | { type: 'single'; item: TimelineEvent }
    | { type: 'identityCluster'; clusterKey: string }
    | { type: 'versionHistory'; group: SameFileDayVersionGroup }
  > = [];

  const seenBatches = new Set<string>();
  const emittedClusters = new Set<string>();
  const emittedVersionGroups = new Set<string>();
  filteredEvents.forEach((ev, i) => {
    if (ev.batch_id) {
      if (seenBatches.has(ev.batch_id)) return;
      seenBatches.add(ev.batch_id);
      const batchItems = filteredEvents.filter((x) => x.batch_id === ev.batch_id);
      groupedRenderList.push({
        type: 'batch',
        batchId: ev.batch_id,
        batchTitle: ev.batch_title || '一组相关修改',
        items: batchItems,
      });
      return;
    }
    const versionGroup = versionFold.indexToGroup.get(i);
    if (versionGroup) {
      if (emittedVersionGroups.has(versionGroup.key)) return;
      emittedVersionGroups.add(versionGroup.key);
      groupedRenderList.push({ type: 'versionHistory', group: versionGroup });
      return;
    }
    const ident = identityInfoByIndex.get(i);
    if (ident) {
      const stamp = eventCardStamp(ev, eventOrder);
      const timeKey = stamp.dayOnly ? `d:${stamp.stamp}` : `m:${stamp.stamp}`;
      const clusterKey = `${ident.key}|${timeKey}|${ev.kind}`;
      if (emittedClusters.has(clusterKey)) return;
      emittedClusters.add(clusterKey);
      groupedRenderList.push({ type: 'identityCluster', clusterKey });
      return;
    }
    groupedRenderList.push({ type: 'single', item: ev });
  });

  const focusGroupByEventId = useMemo(() => {
    const versionGroups: Array<{ key: string; members: TimelineEvent[] }> = [];
    for (const group of versionFold.groups) {
      const members = group.indices
        .map((idx) => filteredEvents[idx])
        .filter((ev): ev is TimelineEvent => Boolean(ev));
      if (members.length > 0) versionGroups.push({ key: group.key, members });
    }
    const clusterMembers: Array<{ key: string; members: TimelineEvent[] }> = [];
    for (const [key, cluster] of identityClusters.entries()) {
      if (cluster.members.length > 1) {
        clusterMembers.push({ key, members: cluster.members });
      }
    }
    return buildTimelineFocusGroups({
      events: filteredEvents,
      versionGroups,
      clusterMembers,
    });
  }, [filteredEvents, versionFold, identityClusters]);

  const navigableEvents = useMemo(() => {
    const snapshots: TimelineRenderGroupSnapshot[] = [];
    for (const g of groupedRenderList) {
      if (g.type === 'single') {
        snapshots.push({ kind: 'single', members: [g.item], isOpen: true });
      } else if (g.type === 'batch') {
        snapshots.push({
          kind: 'batch',
          members: g.items,
          isOpen: !collapsedBatches[g.batchId],
        });
      } else if (g.type === 'identityCluster') {
        const cluster = identityClusters.get(g.clusterKey);
        if (!cluster || cluster.members.length === 0) continue;
        if (cluster.members.length === 1) {
          snapshots.push({ kind: 'single', members: cluster.members, isOpen: true });
        } else {
          const selectedInside = cluster.members.some((m) => m.event_id === selectedEventId);
          const isOpen =
            g.clusterKey in openIdentityClusters
              ? Boolean(openIdentityClusters[g.clusterKey])
              : selectedInside;
          snapshots.push({ kind: 'cluster', members: cluster.members, isOpen });
        }
      } else {
        const members = g.group.indices
          .map((idx) => filteredEvents[idx])
          .filter((ev): ev is TimelineEvent => Boolean(ev));
        if (members.length === 0) continue;
        const selectedInside = members.some((m) => m.event_id === selectedEventId);
        const isOpen =
          g.group.key in openVersionHistories
            ? Boolean(openVersionHistories[g.group.key])
            : selectedInside;
        snapshots.push({ kind: 'version', members, isOpen });
      }
    }
    return collectNavigableTimelineEvents(snapshots);
  }, [
    groupedRenderList,
    collapsedBatches,
    identityClusters,
    openIdentityClusters,
    openVersionHistories,
    filteredEvents,
    selectedEventId,
  ]);

  const handleKeyboardCollapseGroup = (group: TimelineFocusGroup, collapsed: boolean) => {
    if (group.kind === 'batch') {
      setCollapsedBatches((prev) => ({ ...prev, [group.key]: collapsed }));
    } else if (group.kind === 'cluster') {
      setOpenIdentityClusters((prev) => ({ ...prev, [group.key]: !collapsed }));
    } else {
      setOpenVersionHistories((prev) => ({ ...prev, [group.key]: !collapsed }));
    }
  };

  useTimelineKeyboardNav({
    enabled: true,
    events: navigableEvents,
    selectedEventId,
    onSelectEvent,
    groupByEventId: focusGroupByEventId,
    onCollapseGroup: handleKeyboardCollapseGroup,
  });

  const renderFormatIcon = (ev: TimelineEvent) => {
    const file = files.find((f) => f.file_id === ev.file_id);
    const fmt = ev.format ?? file?.format ?? null;
    if (fmt === 'svg') return <FileCode className="w-4 h-4 text-[#26C0DB] shrink-0" />;
    if (fmt === 'pdf') return <FileSpreadsheet className="w-4 h-4 text-[#F5D90A] shrink-0" />;
    if (fmt === 'md') return <FileText className="w-4 h-4 text-[#F76808] shrink-0" />;
    const meta = formatUiMeta(fmt);
    if (meta.formatClass === 'code') {
      return <FileCode className="w-4 h-4 shrink-0" style={{ color: meta.dotColor }} />;
    }
    if (meta.formatClass === 'spreadsheet') {
      return <FileSpreadsheet className="w-4 h-4 shrink-0" style={{ color: meta.dotColor }} />;
    }
    return <FileText className="w-4 h-4 shrink-0" style={{ color: meta.dotColor }} />;
  };

  const renderEventRow = (ev: TimelineEvent, isInsideBatch = false) => {
    const file = files.find((f) => f.file_id === ev.file_id);
    const st = readingStates[ev.file_id];
    const unread = file
      ? hasUnreadChanges(file, st)
      : { isUnread: false, reason: 'up_to_date' as const, changedSectionsSinceRead: [] as string[] };
    const isSelected = ev.event_id === selectedEventId;
    const stamp = eventCardStamp(ev, eventOrder);

    const cardTitleParts: string[] = [`泳道：${ev.topic_lane}`];
    cardTitleParts.push(`时间依据：${stamp.basis}`);
    if (stamp.dayOnly) cardTitleParts.push('仅日期');
    if (ev.task_code) cardTitleParts.push(`任务号 ${ev.task_code}`);
    if (ev.source_time) cardTitleParts.push(`文档日期：${ev.source_time}`);
    if (ev.commit_time) {
      cardTitleParts.push(`Git提交：${ev.commit_time.slice(5, 16).replace('T', ' ')}`);
    }
    if (file && ev.revision_id) cardTitleParts.push(`版本：${ev.revision_id}`);

    return (
      <div
        key={ev.event_id}
        data-event-id={ev.event_id}
        onClick={() => onSelectEvent(ev)}
        onContextMenu={(e) => {
          if (!file || !systemActions?.onOpenFileContextMenu) return;
          e.preventDefault();
          e.stopPropagation();
          systemActions.onOpenFileContextMenu(e, {
            kind: 'file',
            relativePath: file.relative_path,
            title: file.title,
            fileId: file.file_id,
            revisionId: ev.revision_id || file.current_revision_id,
          });
        }}
        role="button"
        tabIndex={0}
        title={cardTitleParts.join(' · ')}
        onKeyDown={(e) => {
          if (!ev.file_id) return;
          if ((e.code === 'Space' || e.key === ' ') && onQuickPreview) {
            e.preventDefault();
            e.stopPropagation();
            onSelectEvent(ev);
            onQuickPreview(ev.file_id, ev.revision_id || undefined);
            return;
          }
          if (e.key === 'Enter') {
            onOpenFileFromTimeline(ev.file_id, ev.revision_id, 'read');
          }
        }}
        className={`group depth-2-card depth-2-card-hover !rounded-[14px] p-4 cursor-pointer ${
          isInsideBatch ? 'ml-5' : ''
        } ${
          isSelected
            ? 'ring-2 ring-[color:color-mix(in_srgb,var(--accent-iris)_55%,transparent)]'
            : ''
        }`}
      >
        <div className="flex flex-wrap items-center gap-2 text-[length:var(--text-micro)] font-mono text-[color:var(--ink-soft)] tabular-nums">
          <span
            className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--depth-1-bg)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--ink-strong)]"
          >
            <span
              aria-hidden="true"
              className={`size-2 rounded-full shrink-0 ${ev.isRollback ? 'bg-[color:var(--stage-ink-anomaly)]' : KIND_CHIP_COLORS[ev.kind] || 'bg-[color:var(--ink-soft)]'}`}
            />
            <span>{getEventKindLabel(ev)}</span>
          </span>
          <span className="text-[color:var(--ink-soft)]">{stamp.stamp}</span>
          {unread.isUnread && (
            <span
              title={unreadStatusLabel(unread.reason)}
              className="size-1.5 rounded-full bg-[color:var(--accent-wave)]"
            />
          )}
        </div>

        <div className="mt-2 flex items-start justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <h3 className="text-[length:var(--text-item-title)] leading-[var(--lh-item-title)] font-semibold text-[color:var(--ink-strong)] flex items-center gap-2 line-clamp-2">
              {renderFormatIcon(ev)}
              {file && (
                <span
                  title={`任务包：${taskPackageOf(file.relative_path).name}`}
                  className="shrink-0 rounded-[var(--r-ctl)] border border-border/80 bg-muted/65 px-1.5 py-0.5 text-[length:var(--text-micro)] font-mono font-medium leading-none text-muted-foreground"
                >
                  {taskPackageOf(file.relative_path).name}
                </span>
              )}
              <span title={ev.headline}>
                {ev.headline.startsWith('新出现：')
                  ? `新出现：${coreFileNameOf(file ? file.relative_path : ev.headline.slice(4))}`
                  : cleanDisplayText(ev.headline) || ev.headline}
              </span>
            </h3>
            {(() => {
              if (!file) return null;
              const coreName = coreFileNameOf(file.relative_path);
              const verText = ev.revision_id
                ? revisionVersionById.has(ev.revision_id)
                  ? `v${revisionVersionById.get(ev.revision_id)}`
                  : formatRevision(ev.revision_id)
                : '';
              const headlineHasName = ev.headline.includes(coreName);
              const headlineHasVer = Boolean(verText && ev.headline.includes(verText));
              const pkgName = taskPackageOf(file.relative_path).name;
              const folderSegs = normalizePath(file.relative_path).split('/').slice(0, -1);
              const subFolder =
                folderSegs.length > 1 && folderSegs[0] === pkgName
                  ? folderSegs.slice(1).join('/')
                  : folderSegs.length > 0 && folderSegs[0] !== pkgName
                    ? folderSegs.join('/')
                    : '';
              const showName = !headlineHasName;
              const showVer = Boolean(verText && !headlineHasVer);
              if (!showName && !showVer && !subFolder) return null;
              return (
                <div
                  className="flex items-center gap-1.5 text-[length:var(--text-micro)] font-mono text-[color:var(--ink-soft)] truncate"
                  title={`${file.relative_path}${ev.revision_id ? ` · ${ev.revision_id}` : ''}`}
                >
                  {subFolder && <span className="truncate opacity-80">{subFolder}</span>}
                  {subFolder && (showName || showVer) && (
                    <span aria-hidden="true" className="opacity-40">·</span>
                  )}
                  {showName && <span className="truncate">{coreName}</span>}
                  {showName && showVer && (
                    <span aria-hidden="true" className="opacity-40">·</span>
                  )}
                  {showVer && (
                    <span className="shrink-0 text-[color:var(--ink-soft)]">{verText}</span>
                  )}
                </div>
              );
            })()}
          </div>

          <div
            className="flex items-center gap-1.5 shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="glx-hover-actions flex items-center gap-1">
              {ev.prev_revision_id && file?.format === 'md' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    onOpenFileFromTimeline(ev.file_id, ev.revision_id, 'diff_since_read')
                  }
                  className="whitespace-nowrap"
                >
                  <History className="w-3.5 h-3.5 shrink-0" />
                  <span>差异</span>
                </Button>
              )}

              {ev.file_id && onOpenFileTimeline && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenFileTimeline(ev.file_id)}
                  title="查看该文件的完整版本链与相关事件"
                  className="whitespace-nowrap"
                >
                  <Clock className="w-3.5 h-3.5 shrink-0 text-[color:var(--accent-iris)]" />
                  <span>时间线</span>
                </Button>
              )}

              {file &&
                systemActions?.desktopSystemSupported &&
                systemActions.onRevealInExplorer && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => systemActions.onRevealInExplorer?.(file.relative_path)}
                    title="在资源管理器中显示（选中该文件）"
                    className="whitespace-nowrap"
                  >
                    <FolderSearch className="w-3.5 h-3.5 shrink-0 text-[color:var(--ink-soft)]" />
                    <span>目录</span>
                  </Button>
                )}

              {ev.file_id && onQuickPreview && (
                <Button
                  variant="ghost"
                  size="sm"
                  data-action="quick-preview"
                  onClick={() => {
                    onSelectEvent(ev);
                    onQuickPreview(ev.file_id, ev.revision_id || undefined);
                  }}
                  title="QuickLook 原位轻预览 (Space)"
                  className="whitespace-nowrap"
                >
                  <Eye className="w-3.5 h-3.5 shrink-0 text-[color:var(--accent-iris-deep)]" />
                  <span>预览</span>
                </Button>
              )}
            </div>

            {ev.decision_id && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onOpenDecisionFromTimeline(ev.decision_id!)}
                className="whitespace-nowrap"
              >
                <Scale className="w-3.5 h-3.5 shrink-0 text-[color:var(--accent-iris-deep)]" />
                <span>决策</span>
              </Button>
            )}

            {ev.file_id && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onOpenFileFromTimeline(ev.file_id, ev.revision_id, 'read')}
                className="whitespace-nowrap group-hover:border-[color:var(--accent-iris)] group-hover:text-[color:var(--accent-iris-ink)]"
              >
                <span>阅读</span>
                <ArrowRight className="w-3.5 h-3.5 shrink-0 motion-safe:transition-transform group-hover:translate-x-0.5" />
              </Button>
            )}
          </div>
        </div>

        {(() => {
          const rawSections = ev.changedSections ?? [];
          const fmt = ev.format ?? file?.format ?? null;
          const sections = rawSections.map((sec) => polishChangedSectionTag(sec, fmt));
          const detailDuplicatesSections =
            rawSections.length > 0 &&
            ev.detail.trim().startsWith('变更章节：') &&
            rawSections.every((sec) => ev.detail.includes(sec));
          return (
            <>
              {!detailDuplicatesSections && ev.detail && (
                <p className="mt-2 text-[length:var(--text-ui-body)] leading-[var(--lh-ui-body)] text-[color:var(--ink-soft)]">
                  {ev.detail}
                </p>
              )}
              {sections.length > 0 && (
                <div className="mt-2.5 pt-2 border-t border-[color:var(--glass-hairline)] flex flex-wrap items-center gap-1.5 text-[length:var(--text-micro)] font-mono text-[color:var(--ink-soft)]">
                  <span className="text-[color:var(--ink-soft)]">变更</span>
                  {sections.map((sec) => (
                    <span
                      key={sec}
                      className="rounded-full bg-[color:var(--depth-1-bg)] px-2 py-0.5 text-[color:var(--ink-strong)] font-medium"
                    >
                      {sec}
                    </span>
                  ))}
                </div>
              )}
            </>
          );
        })()}

        {ev.sameHashCandidatePaths && (
          <div className="mt-2.5 pt-2 border-t border-[#26243D]/10 text-[length:var(--text-micro)] font-mono text-[color:var(--ink-soft)]">
            同 SHA-256 候选路径：{ev.sameHashCandidatePaths.join('  ⇄  ')}
          </div>
        )}
      </div>
    );
  };

  const renderIdentityClusterCard = (clusterKey: string) => {
    const cluster = identityClusters.get(clusterKey);
    if (!cluster) return null;
    if (cluster.members.length <= 1) {
      return cluster.members.length === 1 ? renderEventRow(cluster.members[0]) : null;
    }
    const newest = cluster.members[0];
    const stamp = eventCardStamp(newest, eventOrder);
    const selectedInside = cluster.members.some((m) => m.event_id === selectedEventId);
    const isOpen = clusterKey in openIdentityClusters
      ? Boolean(openIdentityClusters[clusterKey])
      : selectedInside;
    const kindLabel = getEventKindLabel(newest);

    return (
      <div
        key={clusterKey}
        data-event-id={!isOpen ? newest.event_id : undefined}
        className={`depth-2-card overflow-hidden transition-shadow ${
          !isOpen && selectedInside
            ? 'ring-2 ring-[color:color-mix(in_srgb,var(--accent-iris)_55%,transparent)]'
            : ''
        }`}
      >
        <button
          type="button"
          onClick={() =>
            setOpenIdentityClusters((prev) => ({
              ...prev,
              [clusterKey]: !isOpen,
            }))
          }
          title={`同名拷贝聚合（仅展示层折叠，不改写 batch_id）：${cluster.members.length} 份「${cluster.displayName}」同身份事件 · 时间口径 ${stamp.basis}${stamp.dayOnly ? '（仅日期）' : ''} · 点击展开/收起逐份路径`}
          className="flex w-full items-center gap-2 px-4 py-3.5 text-left transition-colors hover:bg-[color:var(--depth-1-bg)] cursor-pointer"
        >
          <ChevronRight
            className="w-4 h-4 shrink-0 text-[color:var(--ink-soft)] glx-chevron-rot"
            data-open={isOpen ? 'true' : 'false'}
          />
          <span
            aria-hidden="true"
            className={`w-4 h-4 rounded-[var(--r-ctl)] shrink-0 ${KIND_CHIP_COLORS[cluster.kind] || 'bg-[color:var(--ink-soft)]'}`}
          />
          <span className="shrink-0 text-[length:var(--text-micro)] font-mono tabular-nums text-[color:var(--ink-soft)]">
            {stamp.stamp}
          </span>
          <span className="shrink-0 text-[length:var(--text-micro)] font-mono text-[color:var(--ink-soft)]">{kindLabel}</span>
          <span className="shrink-0 rounded-[var(--r-ctl)] border border-[color:color-mix(in_srgb,var(--accent-iris)_60%,transparent)] bg-card/85 px-1.5 py-0.5 text-[length:var(--text-micro)] font-mono font-medium leading-none text-[color:var(--accent-iris-deep)] tabular-nums">
            ×{cluster.members.length}
          </span>
          {(() => {
            const newestFile = newest.file_id ? filesById.get(newest.file_id) : null;
            return newestFile ? (
              <span
                title={`任务包：${taskPackageOf(newestFile.relative_path).name}`}
                className="shrink-0 rounded-[var(--r-ctl)] border border-border bg-muted/75 px-1.5 py-0.5 text-[length:var(--text-micro)] font-mono font-medium leading-none text-[color:var(--ink-soft)]"
              >
                {taskPackageOf(newestFile.relative_path).name}
              </span>
            ) : null;
          })()}
          <span className="min-w-0 truncate text-[length:var(--text-item-title)] leading-[var(--lh-item-title)] font-semibold text-[color:var(--ink-strong)]">
            {cluster.prefix && (
              <span className="font-normal text-[color:var(--ink-soft)]">{cluster.prefix}/</span>
            )}
            {cluster.displayName}
          </span>
          <span className="ml-auto shrink-0 text-[length:var(--text-micro)] font-mono text-[color:var(--ink-soft)]">
            {isOpen ? '收起逐份路径' : `展开 ${cluster.members.length} 份路径`}
          </span>
        </button>

        {isOpen && (
          <div className="space-y-1 px-3 pb-3">
            {cluster.members.map((ev) => {
              const file = filesById.get(ev.file_id);
              const memberStamp = eventCardStamp(ev, eventOrder);
              const memberSelected = ev.event_id === selectedEventId;
              return (
                <div
                  key={ev.event_id}
                  data-event-id={ev.event_id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectEvent(ev)}
                  onContextMenu={(e) => {
                    if (!file || !systemActions?.onOpenFileContextMenu) return;
                    e.preventDefault();
                    e.stopPropagation();
                    systemActions.onOpenFileContextMenu(e, {
                      kind: 'file',
                      relativePath: file.relative_path,
                      title: file.title,
                      fileId: file.file_id,
                      revisionId: ev.revision_id || file.current_revision_id,
                    });
                  }}
                  onKeyDown={(e) => {
                    if (!ev.file_id) return;
                    if ((e.code === 'Space' || e.key === ' ') && onQuickPreview) {
                      e.preventDefault();
                      e.stopPropagation();
                      onSelectEvent(ev);
                      onQuickPreview(ev.file_id, ev.revision_id || undefined);
                      return;
                    }
                    if (e.key === 'Enter') {
                      onOpenFileFromTimeline(ev.file_id, ev.revision_id, 'read');
                    }
                  }}
                  title={`${file?.relative_path || ev.headline} · ${memberStamp.stamp}（${memberStamp.basis}）`}
                  className={`flex items-start justify-between gap-3 rounded-md border px-2.5 py-1.5 cursor-pointer transition-colors ${
                    memberSelected
                      ? 'border-[color:color-mix(in_srgb,var(--accent-iris)_60%,transparent)] bg-accent/80'
                      : 'border-transparent hover:border-border hover:bg-accent/60'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-mono text-[color:var(--ink-strong)] break-all">
                      {file?.relative_path || ev.headline}
                    </div>
                    <div className="mt-0.5 text-[length:var(--text-micro)] font-mono tabular-nums text-[color:var(--ink-soft)]">
                      {memberStamp.stamp} · {memberStamp.basis}
                      {ev.revision_id ? ` · ${formatRevision(ev.revision_id)}` : ''}
                    </div>
                  </div>
                  {ev.file_id && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenFileFromTimeline(ev.file_id, ev.revision_id, 'read');
                      }}
                      className="shrink-0 rounded-[var(--r-ctl)] border border-[#26243D]/10 px-2 py-1 text-[length:var(--text-micro)] font-mono text-[color:var(--accent-iris-deep)] transition-colors hover:border-[color:color-mix(in_srgb,var(--accent-iris)_60%,transparent)]"
                    >
                      阅读
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const renderVersionHistoryCard = (group: SameFileDayVersionGroup) => {
    const members = group.indices
      .map((i) => filteredEvents[i])
      .filter((ev): ev is TimelineEvent => Boolean(ev));
    if (members.length === 0) return null;

    const newest = members[0];
    const file = filesById.get(group.fileId);
    const displayName = file ? basenameOf(file.relative_path) : newest.headline;
    const stamp = eventCardStamp(newest, eventOrder);
    const selectedInside = members.some((m) => m.event_id === selectedEventId);
    const isOpen =
      group.key in openVersionHistories
        ? Boolean(openVersionHistories[group.key])
        : selectedInside;
    const rangeLabel = versionFoldRangeLabel(group);
    const packageName = file ? taskPackageOf(file.relative_path).name : null;
    const bodyId = `vh-body-${group.key}`;

    return (
      <div
        key={`vh-${group.key}`}
        data-testid={`version-history-${group.key}`}
        data-event-id={!isOpen ? newest.event_id : undefined}
        className={`depth-2-card overflow-hidden transition-shadow ${
          selectedInside ? 'ring-2 ring-[color:color-mix(in_srgb,var(--accent-iris)_55%,transparent)]' : ''
        }`}
      >
        <div className="flex items-center gap-2 px-4 py-3.5">
          <button
            type="button"
            onClick={() => onSelectEvent(newest)}
            title={`${versionFoldCardTitle(displayName, group)}\n${
              file?.relative_path || newest.headline
            }\n点击选中最新一次演进；右侧按钮才展开逐版本`}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <span
              aria-hidden="true"
              className={`w-4 h-4 rounded-[var(--r-ctl)] shrink-0 ${KIND_CHIP_COLORS[newest.kind] || 'bg-[color:var(--ink-soft)]'}`}
            />
            <span className="shrink-0 text-[length:var(--text-micro)] font-mono tabular-nums text-[color:var(--ink-soft)]">
              {stamp.stamp}
            </span>
            <span className="shrink-0 text-[length:var(--text-micro)] font-mono text-[color:var(--ink-soft)]">连续更新</span>
            <span className="shrink-0 rounded-[var(--r-ctl)] border border-[color:color-mix(in_srgb,var(--accent-wave)_50%,transparent)] bg-card/85 px-1.5 py-0.5 text-[length:var(--text-micro)] font-mono font-medium leading-none text-[color:var(--accent-wave)] tabular-nums">
              ×{group.count}
            </span>
            {packageName && (
              <span
                title={`任务包：${packageName}`}
                className="shrink-0 rounded-[var(--r-ctl)] border border-border bg-muted/75 px-1.5 py-0.5 text-[length:var(--text-micro)] font-mono font-medium leading-none text-[color:var(--ink-soft)]"
              >
                {packageName}
              </span>
            )}
            <span className="min-w-0 truncate text-[length:var(--text-item-title)] leading-[var(--lh-item-title)] font-semibold text-[color:var(--ink-strong)]">
              {displayName} 检测到连续更新
            </span>
            <span className="ml-auto shrink-0 text-[length:var(--text-micro)] font-mono tabular-nums text-[color:var(--ink-soft)]">
              {rangeLabel}
            </span>
          </button>
          <button
            type="button"
            aria-expanded={isOpen}
            aria-controls={bodyId}
            onClick={() =>
              setOpenVersionHistories((prev) => ({ ...prev, [group.key]: !isOpen }))
            }
            title={
              isOpen
                ? '收起逐版本卡（收起后子卡不挂 DOM）'
                : `展开 ${group.count} 个版本（展开时才挂载子卡）`
            }
            className="shrink-0 rounded-[var(--r-ctl)] border border-[#26243D]/10 px-2 py-1 text-[length:var(--text-micro)] font-medium text-[color:var(--ink-soft)] transition-colors hover:border-[color:color-mix(in_srgb,var(--accent-iris)_60%,transparent)] hover:text-[color:var(--ink-strong)]"
          >
            {isOpen ? '收起历史 ▴' : '展开历史 ▾'}
          </button>
        </div>

        {isOpen && (
          <div id={bodyId} className="space-y-1 px-3 pb-3">
            {members.map((ev, idx) => {
              const memberFile = filesById.get(ev.file_id);
              const memberStamp = eventCardStamp(ev, eventOrder);
              const memberVersion = ev.revision_id
                ? revisionVersionById.get(ev.revision_id) ?? null
                : null;
              const memberSelected = ev.event_id === selectedEventId;
              return (
                <div
                  key={ev.event_id}
                  data-event-id={ev.event_id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectEvent(ev)}
                  onContextMenu={(e) => {
                    if (!memberFile || !systemActions?.onOpenFileContextMenu) return;
                    e.preventDefault();
                    e.stopPropagation();
                    systemActions.onOpenFileContextMenu(e, {
                      kind: 'file',
                      relativePath: memberFile.relative_path,
                      title: memberFile.title,
                      fileId: memberFile.file_id,
                      revisionId: ev.revision_id || memberFile.current_revision_id,
                    });
                  }}
                  onKeyDown={(e) => {
                    if (!ev.file_id) return;
                    if ((e.code === 'Space' || e.key === ' ') && onQuickPreview) {
                      e.preventDefault();
                      e.stopPropagation();
                      onSelectEvent(ev);
                      onQuickPreview(ev.file_id, ev.revision_id || undefined);
                      return;
                    }
                    if (e.key === 'Enter') {
                      onOpenFileFromTimeline(ev.file_id, ev.revision_id, 'read');
                    }
                  }}
                  title={`${memberFile?.relative_path || ev.headline} · ${memberStamp.stamp}（${memberStamp.basis}）`}
                  className={`anim-spring-pop flex items-start justify-between gap-3 rounded-md border px-2.5 py-1.5 cursor-pointer transition-colors ${
                    memberSelected
                      ? 'border-[color:color-mix(in_srgb,var(--accent-iris)_60%,transparent)] bg-accent/80'
                      : 'border-transparent hover:border-border hover:bg-accent/60'
                  }`}
                  style={{ animationDelay: `${idx * 40}ms` }}
                >
                  <div className="min-w-0">
                    <div className="text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-mono text-[color:var(--ink-strong)] break-all">
                      {memberVersion !== null ? (
                        <span className="mr-1.5 text-[color:var(--accent-wave)] tabular-nums">v{memberVersion}</span>
                      ) : null}
                      {memberFile?.relative_path || ev.headline}
                    </div>
                    <div className="mt-0.5 text-[length:var(--text-micro)] font-mono tabular-nums text-[color:var(--ink-soft)]">
                      {memberStamp.stamp} · {getEventKindLabel(ev)}
                      {ev.revision_id ? ` · ${formatRevision(ev.revision_id)}` : ''}
                    </div>
                  </div>
                  {ev.file_id && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenFileFromTimeline(ev.file_id, ev.revision_id, 'read');
                      }}
                      className="shrink-0 rounded-[var(--r-ctl)] border border-[#26243D]/10 px-2 py-1 text-[length:var(--text-micro)] font-mono text-[color:var(--accent-iris-deep)] transition-colors hover:border-[color:color-mix(in_srgb,var(--accent-iris)_60%,transparent)]"
                    >
                      阅读
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  const dayBuckets = useMemo(() => {
    return groupTimelineRenderItemsByDay(groupedRenderList, (group) => {
      if (group.type === 'single') {
        return { day: eventFilterDay(group.item, eventOrder) || 'undated', eventCount: 1 };
      }
      if (group.type === 'batch') {
        const anchor = group.items[0];
        return {
          day: anchor ? eventFilterDay(anchor, eventOrder) || 'undated' : 'undated',
          eventCount: group.items.length,
        };
      }
      if (group.type === 'identityCluster') {
        const cluster = identityClusters.get(group.clusterKey);
        const anchor = cluster?.members[0];
        return {
          day: anchor ? eventFilterDay(anchor, eventOrder) || 'undated' : 'undated',
          eventCount: cluster?.members.length ?? 1,
        };
      }
      const anchor = filteredEvents[group.group.indices[0]];
      return {
        day: anchor ? eventFilterDay(anchor, eventOrder) || 'undated' : 'undated',
        eventCount: group.group.count,
      };
    });
  }, [groupedRenderList, eventOrder, identityClusters, filteredEvents]);

  return (
    <div
      data-timeline-chronos-stream=""
      className="flex-1 h-full overflow-y-auto text-foreground px-6 py-5"
    >
      <div className="max-w-4xl mx-auto space-y-5">
        <div className="space-y-3 pb-3 border-b border-border/75">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h1 className="font-serif-claude text-[20px] leading-[28px] font-semibold tracking-tight text-foreground">
                司辰时光流 · 观察时间线
              </h1>
              <Badge variant="outline" size="sm" className="font-mono tabular-nums">
                {dayBuckets.length} 日 · {filteredEvents.length} 项
              </Badge>
              <span
                title={`${
                  eventOrder === 'observed'
                    ? '当前按观澜采集时间排序；文档记载时间与 Git 提交时间各守原始口径。'
                    : '当前按发生时间排序：材料记载时间优先，未记载时回退观澜采集时间。'
                } 观察边界：接入前的修改历史仅取自可验证的 Git 提交或登记材料；单纯 mtime 改变不生成内容修改卡；A → B → A 恢复旧内容完整保留三次版本。`}
                className="inline-flex items-center text-muted-foreground hover:text-[color:var(--accent-iris-deep)] transition-colors cursor-help"
              >
                <HelpCircle className="w-3.5 h-3.5 shrink-0" />
              </span>
            </div>

            {onToggleOrder && (
              <SegmentedControl size="sm" role="group" aria-label="时间口径">
                <SegmentedControlItem
                  type="button"
                  aria-pressed={eventOrder === 'occurred'}
                  onClick={() => {
                    if (eventOrder !== 'occurred') onToggleOrder();
                  }}
                  title="材料记载时间优先，未记载时回退采集时间"
                >
                  按发生时间
                </SegmentedControlItem>
                <SegmentedControlItem
                  type="button"
                  aria-pressed={eventOrder === 'observed'}
                  onClick={() => {
                    if (eventOrder !== 'observed') onToggleOrder();
                  }}
                  title="严格按观澜扫描采集时间排序"
                >
                  按采集时间
                </SegmentedControlItem>
              </SegmentedControl>
            )}
          </div>

          <Toolbar
            aria-label="时光流筛选工具栏"
            className="flex flex-wrap items-center gap-1.5 rounded-2xl border border-border/80 bg-card/85 p-1.5 shadow-[var(--glass-shadow)]"
          >
            <ToolbarGroup role="group" aria-label="事件类型筛选" className="flex flex-wrap items-center gap-1">
              {(
                [
                  { id: 'all', label: '全部事件' },
                  { id: 'modified', label: '内容修改' },
                  { id: 'decision_raised', label: '提出问题' },
                  { id: 'decision_changed', label: '决策变更' },
                  { id: 'appeared', label: '新出现' },
                  { id: 'workspace_baseline', label: '首次基线' },
                  { id: 'read_error', label: '读取问题' },
                ] as const
              ).map((tab) => (
                <Chip
                  key={tab.id}
                  active={kindFilter === tab.id}
                  onClick={() => onKindFilterChange(tab.id)}
                  className="whitespace-nowrap"
                >
                  {tab.label}
                </Chip>
              ))}
            </ToolbarGroup>

            <ToolbarSeparator className="hidden sm:block" />

            <ToolbarGroup
              role="group"
              aria-label="内容范围筛选"
              data-testid="core-only-filter"
              className="flex items-center"
            >
              <Chip
                active={coreOnly}
                onClick={() => setCoreOnly((v) => !v)}
                data-testid="core-only-toggle"
                title="仅看核心文档与计划：隐藏运行态缓存与机器派生条目；关闭后显示全部。"
                className="glx-pill-tactile whitespace-nowrap"
              >
                核心文档
              </Chip>
            </ToolbarGroup>

            <ToolbarSeparator className="hidden sm:block" />

            <ToolbarGroup
              role="group"
              aria-label="日期筛选"
              className="flex flex-wrap items-center gap-1.5 font-mono tabular-nums"
            >
              <SegmentedControl size="sm" role="group" aria-label="日期范围快捷档">
                {(
                  [
                    { id: 'recent7', label: '近 7 天', title: '下拉候选仅列最近 7 个自然日内有事件的日期' },
                    { id: 'recent30', label: '近 30 天', title: '下拉候选仅列最近 30 个自然日内有事件的日期' },
                    { id: 'all', label: '更早', title: '下拉候选列全部日期（含更早历史）' },
                  ] as const
                ).map((opt) => (
                  <SegmentedControlItem
                    key={opt.id}
                    type="button"
                    aria-pressed={dateScope === opt.id}
                    title={opt.title}
                    onClick={() => setDateScope(opt.id)}
                  >
                    {opt.label}
                  </SegmentedControlItem>
                ))}
              </SegmentedControl>
              <select
                value={dateFilter}
                onChange={(e) => changeDateFilter(e.target.value)}
                aria-label="选择具体日期"
                className="h-[var(--ctl-h-sm)] max-w-[9.5rem] rounded-[var(--r-pill)] bg-card px-2.5 text-[length:var(--text-ui)] leading-none font-medium text-foreground border border-border shadow-xs focus:outline-none focus:border-[color:var(--accent-iris-deep)] cursor-pointer"
              >
                <option value="all">全部日期</option>
                {dateFilter !== 'all' && !scopedDateOptions.includes(dateFilter) && (
                  <optgroup label="当前筛选">
                    <option value={dateFilter}>{dateFilter}（当前）</option>
                  </optgroup>
                )}
                {scopedMonthGroups.map(([month, dates]) => (
                  <optgroup key={month} label={month}>
                    {dates.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </ToolbarGroup>
          </Toolbar>
        </div>

        {groupedRenderList.length === 0 ? (
          <Empty className="rounded-2xl border border-dashed border-border/80 bg-card/65 py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CalendarDays className="size-4" />
              </EmptyMedia>
              <EmptyTitle>当前筛选条件下暂无观察事件</EmptyTitle>
              <EmptyDescription>
                可重置事件类型、日期与核心文档开关，浏览工作区完整时间演进脉络
              </EmptyDescription>
            </EmptyHeader>
            <Button
              variant="secondary"
              onClick={() => {
                if (onResetFilters) {
                  onResetFilters();
                } else {
                  onKindFilterChange('all');
                  changeDateFilter('all');
                }
                setCoreOnly(false);
              }}
              className="mt-2"
            >
              <RotateCcw className="w-3.5 h-3.5 shrink-0" />
              <span>重置时间线筛选</span>
            </Button>
          </Empty>
        ) : (
          <div className="relative pl-7 space-y-5">
            <span
              aria-hidden="true"
              data-timeline-spine=""
              className="pointer-events-none absolute left-[9px] top-4 bottom-4 w-[1.5px] rounded-full"
              style={{
                background:
                  'linear-gradient(180deg, color-mix(in srgb, var(--accent-iris) 65%, transparent) 0%, color-mix(in srgb, var(--accent-wave) 32%, transparent) 45%, color-mix(in srgb, var(--border) 60%, transparent) 85%, transparent 100%)',
              }}
            />
            {dayBuckets.map((bucket, bucketIdx) => (
              <section
                key={`${bucket.day}-${bucketIdx}`}
                data-timeline-day-frame={bucket.day}
                className="relative"
              >
                <span
                  aria-hidden="true"
                  className={`absolute -left-[23px] top-[15px] size-2.5 rounded-full ring-4 ring-background ${
                    bucketIdx === 0
                      ? 'bg-[color:var(--accent-iris)] shadow-[0_0_0_4px_color-mix(in_srgb,var(--accent-iris)_22%,transparent)]'
                      : bucket.day === 'undated'
                        ? 'bg-[color:var(--stage-ink-decision)]'
                        : 'bg-[color:var(--accent-wave)]'
                  }`}
                />
                <Frame className="border border-border/75">
                  <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono text-[12.5px] font-semibold tracking-tight text-foreground tabular-nums">
                        {bucket.label}
                      </span>
                      <Badge variant="outline" size="sm" className="font-mono tabular-nums">
                        {bucket.eventCount} 条沉淀
                      </Badge>
                    </div>
                    {bucket.day !== 'undated' && onJumpToStarMap && (
                      <button
                        type="button"
                        data-timeline-jump-starmap={bucket.day}
                        onClick={() => onJumpToStarMap(bucket.day)}
                        className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-border/80 bg-card/90 px-2.5 py-0.5 text-[11px] font-medium text-[color:var(--accent-iris-deep)] transition-colors hover:border-[color:var(--accent-iris)] hover:bg-[color:color-mix(in_srgb,var(--accent-iris)_10%,transparent)]"
                        title={`在司辰星图中定位并聚焦 ${bucket.day}`}
                      >
                        <Compass className="size-3 shrink-0" aria-hidden="true" />
                        <span>在星图定位此日 →</span>
                      </button>
                    )}
                  </div>

                  <FramePanel className="space-y-3 p-3">
                    {bucket.items.map((group, groupIdx) => {
                      const nodeKey =
                        group.type === 'single'
                          ? group.item.event_id
                          : group.type === 'identityCluster'
                            ? group.clusterKey
                            : group.type === 'versionHistory'
                              ? group.group.key
                              : group.batchId;

                      const renderNodeBody = () => {
                        if (group.type === 'single') {
                          return renderEventRow(group.item, false);
                        }
                        if (group.type === 'identityCluster') {
                          return renderIdentityClusterCard(group.clusterKey);
                        }
                        if (group.type === 'versionHistory') {
                          return renderVersionHistoryCard(group.group);
                        }

                        const isCollapsed = Boolean(collapsedBatches[group.batchId]);
                        const batchSelectedInside = group.items.some((it) => it.event_id === selectedEventId);
                        return (
                          <div
                            data-event-id={isCollapsed && group.items[0] ? group.items[0].event_id : undefined}
                            className={`rounded-xl border border-border/75 bg-muted/40 p-3 space-y-2.5 ${
                              isCollapsed && batchSelectedInside
                                ? 'ring-2 ring-[color:color-mix(in_srgb,var(--accent-iris)_55%,transparent)]'
                                : ''
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2 px-1">
                              <button
                                type="button"
                                onClick={() => toggleBatch(group.batchId)}
                                title={`可折叠并行组 · 包含 ${group.items.length} 份关联变更（含 MD / SVG / PDF）`}
                                className="flex items-center gap-2 text-[length:var(--text-item-title)] leading-[var(--lh-item-title)] font-semibold text-foreground hover:text-[color:var(--accent-iris-deep)] transition-colors cursor-pointer"
                              >
                                {isCollapsed ? (
                                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                                ) : (
                                  <ChevronDown className="w-4 h-4 text-muted-foreground" />
                                )}
                                <GitBranch className="w-3.5 h-3.5 text-[color:var(--accent-iris-deep)]" />
                                <span>{group.batchTitle}</span>
                              </button>
                              <Badge variant="outline" size="sm" className="font-mono tabular-nums">
                                {group.items.length} 份变更
                              </Badge>
                            </div>

                            {!isCollapsed && (
                              <div className="space-y-2.5">
                                {group.items.map((item) => renderEventRow(item, true))}
                              </div>
                            )}
                          </div>
                        );
                      };

                      return (
                        <div
                          key={nodeKey}
                          className="relative glx-row-in"
                          style={{ '--glx-row-idx': Math.min(groupIdx, 12) } as React.CSSProperties}
                        >
                          {renderNodeBody()}
                        </div>
                      );
                    })}
                  </FramePanel>
                </Frame>
              </section>
            ))}
          </div>
        )}

        {(page || undatedOnly) && (
          <div className="flex flex-wrap items-center justify-between gap-3 px-1 py-1 text-[length:var(--text-micro)] font-mono text-[color:var(--ink-soft)] tabular-nums">
            <span>
              {hiddenNoiseCount > 0
                ? `已显示 ${(page?.items.length ?? 0) - hiddenNoiseCount} / 共 ${page?.total_in_window ?? 0} 条 · 另有 ${hiddenNoiseCount} 条运行态缓存已隐藏`
                : `已显示 ${page?.items.length ?? 0} / 共 ${page?.total_in_window ?? 0} 条`}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {page && page.undated_count > 0 && (
                <Chip
                  active={undatedOnly}
                  onClick={onToggleUndated}
                  className="whitespace-nowrap"
                >
                  {undatedOnly ? '返回全部事件' : `日期待考 ${page.undated_count}`}
                </Chip>
              )}
              {page && page.newer_count > 0 && (
                <button
                  type="button"
                  onClick={onRefresh}
                  className="px-2 py-0.5 rounded-[var(--r-pill)] border border-[color:color-mix(in_srgb,var(--accent-wave)_50%,transparent)] text-[color:var(--accent-wave)] hover:bg-[color:color-mix(in_srgb,var(--accent-wave)_10%,transparent)] transition-colors"
                >
                  有新变化 {page.newer_count} 条 · 刷新
                </button>
              )}
              {page && (page.window.from || page.window.to) && (
                <button
                  type="button"
                  onClick={() => changeDateFilter('all')}
                  className="px-2 py-0.5 rounded-[var(--r-pill)] border border-[#26243D]/10 text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)] hover:border-[#26243D]/30 transition-colors"
                >
                  {page.window.from === page.window.to
                    ? `已筛选 ${page.window.from} · 回到全部`
                    : `已筛选 ${page.window.from || '最早'} → ${page.window.to || '至今'} · 回到全部`}
                </button>
              )}
              {page?.has_more && (
                <button
                  type="button"
                  onClick={onLoadMore}
                  disabled={loadingPage}
                  className="px-2.5 py-1 rounded-[var(--r-ctl)] border border-[#26243D]/10 text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)] hover:border-[#26243D]/30 disabled:opacity-50 transition-colors"
                >
                  {loadingPage ? '加载中…' : '加载下一页'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
