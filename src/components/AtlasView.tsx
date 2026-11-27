import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FolderOpen,
  FolderSearch,
  LayoutGrid,
  Map as MapIcon,
  Minus,
  Plus,
  RotateCcw,
} from 'lucide-react';
import * as d3 from 'd3';
import type { FileFormat, FileRecord, ReadingState, TimelineEvent } from '../types/guanlan';
import { formatByteSize, formatUiMeta } from '../utils/formatMeta';
import type { StateOverviewResponse } from '../services/apiTypes';
import type { DesktopFileActionCallbacks } from './FileContextMenu';
import {
  Badge,
  CardFrame,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Frame,
  FramePanel,
  ScrollArea,
  SegmentedControl,
  SegmentedControlItem,
  Toolbar,
  ToolbarGroup,
  ToolbarSeparator,
} from './ui';
import { hasUnreadChanges, unreadStatusLabel } from '../utils/guanlanEngine';
import type { UnreadReason } from '../utils/guanlanEngine';
import { getFilePreviewEntry } from '../utils/filePreviewCache';
import { cleanDisplayText } from '../utils/displayText';
import { localDay } from '../utils/timeFormat';
import {
  enrichPackagesWithEvents,
  groupFilesIntoPackages,
  STAGE_ACCENT,
  STAGE_SLOT_ORDER,
} from '../utils/taskPackages';
import type { StageRole, TaskPackage } from '../utils/taskPackages';
import TaskPackageGallery from './TaskPackageGallery';

interface AtlasViewProps {
  files: FileRecord[];
  readingStates: Record<string, ReadingState>;
  onOpenFile: (fileId: string, revisionId: string) => void;
  onQuickPreview?: (fileId: string, revisionId?: string) => void;
  activeFileId: string;
  variant?: 'fullbleed' | 'embedded';
  filterActive?: boolean;
  filterLabel?: string;
  filteredCount?: number;
  onClearFilters?: () => void;
  events?: TimelineEvent[];
  stateOverview?: StateOverviewResponse | null;
  systemActions?: DesktopFileActionCallbacks;
  onMarkFileRead?: (fileId: string, revisionId: string) => void;
  onMarkFileUnread?: (fileId: string) => void;
  onMarkFolderRead?: (folderPath: string) => void;
  onMarkFolderUnread?: (folderPath: string) => void;
}

interface AtlasCardItem {
  file: FileRecord;
  revisionId: string;
  sizeBytes: number;
  observedAt: string;
  unread: boolean;
  unreadReason: UnreadReason;
  dataUri?: string;
  preview?: string;
}

/** 资产库概览视图模式（画布导览：自由拖拽缩放 / 紧凑网格：原生滚轮垂直阅读） */
export type AtlasViewMode = 'canvas' | 'grid';

/** 超大目录默认折叠代表件上限（超过此数量默认收起，点击按需展开，护航 5,500+ 文件 60fps） */
export const ATLAS_LARGE_FOLDER_CAP = 12;

export interface AtlasFolderSliceResult<T> {
  visible: T[];
  hiddenCount: number;
  isTruncated: boolean;
}

/**
 * 超大目录代表件挑选与折叠纯函数：
 * 优先保留未读文件，其次按最近观察时间降序挑选代表件；expanded=true 时全量返回。
 */
export function sliceAtlasFolderItems<T extends { unread: boolean; observedAt: string }>(
  items: readonly T[],
  expanded: boolean,
  cap = ATLAS_LARGE_FOLDER_CAP
): AtlasFolderSliceResult<T> {
  const safeCap = Math.max(1, Math.floor(cap));
  if (expanded || items.length <= safeCap) {
    return { visible: [...items], hiddenCount: 0, isTruncated: false };
  }
  const ranked = [...items].sort((a, b) => {
    if (a.unread !== b.unread) return a.unread ? -1 : 1;
    if (a.observedAt !== b.observedAt) return a.observedAt < b.observedAt ? 1 : -1;
    return 0;
  });
  return {
    visible: ranked.slice(0, safeCap),
    hiddenCount: items.length - safeCap,
    isTruncated: true,
  };
}

function buildFolderFormatRibbon(items: readonly AtlasCardItem[]) {
  const counts = { md: 0, svg: 0, pdf: 0, code: 0, other: 0 };
  for (const it of items) {
    if (it.file.format === 'md') counts.md += 1;
    else if (it.file.format === 'svg') counts.svg += 1;
    else if (it.file.format === 'pdf') counts.pdf += 1;
    else if (formatUiMeta(it.file.format).formatClass === 'code') counts.code += 1;
    else counts.other += 1;
  }
  const total = Math.max(1, items.length);
  return [
    { key: 'md', label: 'MD', count: counts.md, pct: (counts.md / total) * 100, color: 'var(--accent-wave)' },
    { key: 'svg', label: 'SVG', count: counts.svg, pct: (counts.svg / total) * 100, color: 'var(--accent-iris)' },
    { key: 'pdf', label: 'PDF', count: counts.pdf, pct: (counts.pdf / total) * 100, color: 'var(--stage-ink-decision)' },
    { key: 'code', label: '代码', count: counts.code, pct: (counts.code / total) * 100, color: 'var(--stage-ink-deliver)' },
    { key: 'other', label: '其它', count: counts.other, pct: (counts.other / total) * 100, color: 'var(--ink-soft)' },
  ].filter((s) => s.count > 0);
}

interface AtlasRow {
  folder: string;
  items: AtlasCardItem[];
}

function currentRevisionOf(file: FileRecord) {
  return (
    file.revisions.find((r) => r.revision_id === file.current_revision_id) ||
    file.revisions[file.revisions.length - 1]
  );
}

function mdPreviewText(raw: string): string {
  return cleanDisplayText(raw)
    .replace(/[#>*`~_[\]()!-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
}

function formatComposition(items: AtlasCardItem[]): string {
  const counts = new Map<string, number>();
  for (const it of items) {
    counts.set(it.file.format, (counts.get(it.file.format) ?? 0) + 1);
  }
  const pinnedOrder = new Map<string, number>([
    ['md', 0],
    ['svg', 1],
    ['pdf', 2],
  ]);
  const entries = Array.from(counts.entries()).sort((a, b) => {
    const pa = pinnedOrder.get(a[0]);
    const pb = pinnedOrder.get(b[0]);
    if (pa !== undefined && pb !== undefined) return pa - pb;
    if (pa !== undefined) return -1;
    if (pb !== undefined) return 1;
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  const top = entries.slice(0, 5).map(([fmt, count]) => `${fmt.toUpperCase()} ${count}`);
  if (entries.length > 5) {
    top.push(`+${entries.length - 5} 格式`);
  }
  return top.join(' · ');
}

const CARD_BASE =
  'flex w-[200px] h-[130px] flex-col justify-between rounded-xl p-2.5 text-left cursor-pointer';
const CARD_IDLE_LAYER = 'depth-2-card depth-2-card-hover';
const CARD_ACTIVE_LAYER =
  'depth-2-card depth-2-card-hover ring-2 ring-[color:color-mix(in_srgb,var(--accent-iris)_30%,transparent)]';

const CLICK_DRAG_THRESHOLD_PX = 3;

interface FileCardProps {
  item: AtlasCardItem;
  active: boolean;
  onOpenFile: (fileId: string, revisionId: string) => void;
  onQuickPreview?: (fileId: string, revisionId?: string) => void;
  dragStartRef: React.RefObject<{ x: number; y: number } | null>;
  systemActions?: DesktopFileActionCallbacks;
  onMarkFileRead?: (fileId: string, revisionId: string) => void;
  onMarkFileUnread?: (fileId: string) => void;
}

const FileCard = React.memo(function FileCard({
  item,
  active,
  onOpenFile,
  onQuickPreview,
  dragStartRef,
  systemActions,
  onMarkFileRead,
  onMarkFileUnread,
}: FileCardProps) {
  const { file } = item;
  const uiMeta = formatUiMeta(file.format);
  const badge = {
    text: uiMeta.label.slice(0, 4),
    className: uiMeta.badgeClass,
  };
  const metaLabel = `${formatByteSize(item.sizeBytes)} · ${
    item.observedAt ? `入库于 ${localDay(item.observedAt)}` : '日期待考'
  }`;

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    if (
      start &&
      (Math.abs(e.clientX - start.x) > CLICK_DRAG_THRESHOLD_PX ||
        Math.abs(e.clientY - start.y) > CLICK_DRAG_THRESHOLD_PX)
    ) {
      return;
    }
    onOpenFile(file.file_id, item.revisionId);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if ((e.code === 'Space' || e.key === ' ') && onQuickPreview) {
      e.preventDefault();
      e.stopPropagation();
      onQuickPreview(file.file_id, item.revisionId);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpenFile(file.file_id, item.revisionId);
    }
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!systemActions?.onOpenFileContextMenu) return;
    e.preventDefault();
    e.stopPropagation();
    systemActions.onOpenFileContextMenu(e, {
      kind: 'file',
      relativePath: file.relative_path,
      title: file.title,
      fileId: file.file_id,
      revisionId: item.revisionId,
    });
  };

  const isUpdatedAfterRead = item.unread && item.unreadReason === 'updated_since_last_read';
  const canQuickToggleRead = item.unread ? Boolean(onMarkFileRead) : Boolean(onMarkFileUnread);
  const showFloatingActions =
    canQuickToggleRead ||
    Boolean(
      systemActions?.desktopSystemSupported &&
        (systemActions.onRevealInExplorer || systemActions.onOpenWithDefaultApp)
    );

  const unreadDot = item.unread ? (
    isUpdatedAfterRead ? (
      <span
        data-card-unread-reason="updated_since_last_read"
        title={unreadStatusLabel(item.unreadReason)}
        className="inline-flex items-center gap-1 rounded-full px-1.5 py-[0.5px] text-[9.5px] font-medium text-[color:var(--accent-wave)] bg-[color:color-mix(in_srgb,var(--accent-wave)_11%,transparent)] border border-[color:color-mix(in_srgb,var(--accent-wave)_26%,transparent)] shrink-0"
      >
        <span
          aria-hidden="true"
          className="w-1.5 h-1.5 rounded-full bg-[color:var(--accent-wave)] glx-unread-updated-dot shrink-0"
        />
        <span>有更新</span>
      </span>
    ) : (
      <span
        data-card-unread-reason="never_read"
        title={unreadStatusLabel(item.unreadReason)}
        className="w-1.5 h-1.5 rounded-full bg-[color:var(--accent-wave)] shadow-[0_0_0_2px_color-mix(in_srgb,var(--accent-wave)_18%,transparent)] shrink-0 mt-1"
      />
    )
  ) : (
    <span
      data-card-read-check=""
      title={unreadStatusLabel('up_to_date')}
      className="inline-flex items-center text-[color:var(--stage-ink-deliver-text)] dark:text-[color:var(--success-foreground)] opacity-75 shrink-0 mt-0.5"
    >
      <CheckCircle2 className="w-3.5 h-3.5" />
    </span>
  );

  const headerBlock = (titleClamp: string) => (
    <span className="flex items-start justify-between gap-1.5">
      <span className="flex min-w-0 items-start gap-2">
        <span
          className={`w-5 h-5 rounded-md flex items-center justify-center text-[length:var(--text-micro)] font-mono shrink-0 mt-0.5 border ${badge.className}`}
        >
          {badge.text}
        </span>
        <span
          className={`min-w-0 text-[12px] font-semibold font-serif-claude leading-[1.3] text-[var(--ink-strong)] ${titleClamp}`}
        >
          {file.title}
        </span>
      </span>
      {unreadDot}
    </span>
  );

  const metaLine = (
    <span className="font-mono text-[length:var(--text-micro)] text-[var(--ink-soft)] tabular-nums truncate">
      {metaLabel}
    </span>
  );

  const roleFallback = (
    <>
      <span className="font-mono text-[length:var(--text-micro)] tracking-wide text-[var(--ink-soft)] mr-1">
        ROLE
      </span>
      {file.role}
    </>
  );

  return (
    <div
      role="button"
      tabIndex={0}
      draggable={false}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
      title={file.relative_path}
      className={`group relative overflow-hidden ${CARD_BASE} ${
        active ? CARD_ACTIVE_LAYER : CARD_IDLE_LAYER
      } ${
        !active && !item.unread ? 'opacity-[0.88] hover:opacity-100 transition-opacity' : ''
      } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--accent-iris)_50%,transparent)]`}
    >
      {isUpdatedAfterRead && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-[color:var(--accent-wave)]"
        />
      )}
      {showFloatingActions && (
        <div
          className="absolute right-1.5 bottom-1.5 z-10 flex items-center gap-0.5 rounded-[var(--r-ctl)] bg-card px-1 py-0.5 shadow-xs border border-[color:var(--glass-hairline)] opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
          {canQuickToggleRead && (
            <button
              type="button"
              data-card-toggle-read={file.file_id}
              aria-label={item.unread ? `标为已读 ${file.title}` : `标为未读 ${file.title}`}
              title={item.unread ? '标为已读' : '标为未读'}
              onClick={(e) => {
                e.stopPropagation();
                if (item.unread) {
                  onMarkFileRead?.(file.file_id, item.revisionId);
                } else {
                  onMarkFileUnread?.(file.file_id);
                }
              }}
              className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium cursor-pointer transition-colors ${
                item.unread
                  ? 'text-[color:var(--stage-ink-deliver-text)] dark:text-[color:var(--success-foreground)] hover:bg-[color:color-mix(in_srgb,var(--status-green)_14%,transparent)]'
                  : 'text-[color:var(--accent-wave)] hover:bg-[color:color-mix(in_srgb,var(--accent-wave)_12%,transparent)]'
              }`}
            >
              {item.unread ? <Check className="w-3 h-3" /> : <RotateCcw className="w-2.5 h-2.5" />}
              <span>{item.unread ? '已读' : '未读'}</span>
            </button>
          )}
          {systemActions?.desktopSystemSupported && systemActions.onRevealInExplorer && (
            <button
              type="button"
              aria-label={`在资源管理器中显示 ${file.title}`}
              title="在资源管理器中显示"
              onClick={(e) => {
                e.stopPropagation();
                systemActions.onRevealInExplorer?.(file.relative_path);
              }}
              className="p-1 rounded text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)] hover:bg-[color:var(--btn-ghost-bg-hover)] cursor-pointer"
            >
              <FolderSearch className="w-3 h-3" />
            </button>
          )}
          {systemActions?.desktopSystemSupported && systemActions.onOpenWithDefaultApp && (
            <button
              type="button"
              aria-label={`用系统默认应用打开 ${file.title}`}
              title="用系统默认应用打开"
              onClick={(e) => {
                e.stopPropagation();
                systemActions.onOpenWithDefaultApp?.(file.relative_path);
              }}
              className="p-1 rounded text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)] hover:bg-[color:var(--btn-ghost-bg-hover)] cursor-pointer"
            >
              <ExternalLink className="w-3 h-3" />
            </button>
          )}
        </div>
      )}
      {file.format === 'svg' ? (
        <>
          <span className="flex h-[62px] w-full shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[#26243D]/10 bg-[#FAF9F5]">
            {item.dataUri ? (
              <img
                src={item.dataUri}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                draggable={false}
                className="w-full h-full object-contain p-1"
              />
            ) : (
              <span className="font-mono text-[length:var(--text-micro)] text-[var(--ink-soft)]">
                无内联预览
              </span>
            )}
          </span>
          <span className="flex min-w-0 items-start justify-between gap-1.5">
            <span className="min-w-0 truncate text-[12px] font-semibold font-serif-claude leading-[1.3] text-[var(--ink-strong)]">
              {file.title}
            </span>
            {unreadDot}
          </span>
          {metaLine}
        </>
      ) : file.format === 'md' ? (
        <>
          {headerBlock('line-clamp-2')}
          <span className="mt-1.5 line-clamp-2 text-[length:var(--text-micro)] leading-snug text-[var(--ink-soft)]">
            {item.preview ?? roleFallback}
          </span>
          {metaLine}
        </>
      ) : (
        <>
          {headerBlock('line-clamp-2')}
          <span className="line-clamp-1 text-[length:var(--text-micro)] text-[var(--ink-soft)]">
            {roleFallback}
          </span>
          {metaLine}
        </>
      )}
    </div>
  );
});


const FOLDER_ARTWORK: readonly { from: string; to: string }[] = [
  { from: '#8B7FD9', to: '#E3A1C2' },
  { from: '#D97757', to: '#3D4E78' },
  { from: '#7FB0D9', to: '#9B8AFB' },
  { from: '#D9A957', to: '#C25E4C' },
  { from: '#8FBF9F', to: '#6A7BD9' },
  { from: '#C98BC9', to: '#5C8BC9' },
];

function folderArtworkOf(folder: string): { from: string; to: string } {
  let hash = 0;
  for (let i = 0; i < folder.length; i += 1) {
    hash = (hash * 31 + folder.charCodeAt(i)) >>> 0;
  }
  return FOLDER_ARTWORK[hash % FOLDER_ARTWORK.length];
}

const FolderPeekPaper: React.FC<{ item: AtlasCardItem; index: number }> = ({ item, index }) => {
  const rotate = [-5, 2.5, 7][index % 3];
  const formatInk =
    item.file.format === 'md'
      ? '#B05C3B'
      : item.file.format === 'svg'
        ? '#6D5BD0'
        : item.file.format === 'pdf'
          ? '#A8762B'
          : formatUiMeta(item.file.format).dotColor;
  return (
    <div
      className="glx-folder-paper h-[64px] w-[52px] shrink-0 overflow-hidden rounded-md border border-[#26243D]/10 dark:border-white/[0.14] bg-card shadow-[var(--glass-shadow)]"
      style={{ '--peek-rot': `${rotate}deg` } as React.CSSProperties}
      aria-hidden="true"
    >
      {item.dataUri ? (
        <img
          src={item.dataUri}
          alt=""
          loading="lazy"
          draggable={false}
          className="h-full w-full object-cover object-top p-0.5 dark:brightness-[0.88] dark:contrast-[1.06]"
        />
      ) : (
        <div
          className="flex h-full w-full flex-col justify-between p-1 bg-gradient-to-b from-[#FAF9F5] to-[#EFEAF7] dark:from-[#232738] dark:to-[#181B27]"
        >
          <span
            className="text-[length:var(--text-micro)] leading-none font-mono font-medium dark:brightness-125"
            style={{ color: formatInk }}
          >
            {item.file.format.toUpperCase()}
          </span>
          <span className="block h-0.5 w-full rounded bg-[#26243D]/12 dark:bg-white/15" />
          <span className="block h-0.5 w-3/4 rounded bg-[#26243D]/12 dark:bg-white/15" />
        </div>
      )}
    </div>
  );
};

const FolderCard: React.FC<{
  row: AtlasRow;
  onOpenLatest?: () => void;
  systemActions?: DesktopFileActionCallbacks;
}> = ({ row, onOpenLatest, systemActions }) => {
  const art = folderArtworkOf(row.folder);
  const folderRel = row.folder === '.' ? '' : row.folder;
  const svgPeeks = row.items.filter((it) => it.dataUri).slice(0, 3);
  const paperPeeks = row.items
    .filter((it) => !it.dataUri)
    .slice(0, Math.max(0, 3 - svgPeeks.length));
  const papers = [...svgPeeks, ...paperPeeks].slice(0, 3);
  const latest = row.items.reduce(
    (acc, it) => (it.observedAt > acc ? it.observedAt : acc),
    ''
  );
  const unreadCount = row.items.reduce((sum, it) => sum + (it.unread ? 1 : 0), 0);
  const interactive = typeof onOpenLatest === 'function';
  return (
    <div
      data-drop-folder={folderRel}
      onContextMenu={(e) => {
        if (!systemActions?.onOpenFileContextMenu) return;
        e.preventDefault();
        e.stopPropagation();
        systemActions.onOpenFileContextMenu(e, {
          kind: 'folder',
          relativePath: folderRel,
          title: folderRel || '工作区根目录',
        });
      }}
      className={`group relative mt-3.5 h-[120px] w-[236px] shrink-0 ${
        interactive
          ? 'depth-2-card-hover cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--accent-iris)_50%,transparent)] rounded-2xl'
          : ''
      }`}
      title={`${row.folder} · ${row.items.length} 份${interactive ? ' · 点击打开最近更新' : ''}`}
      {...(interactive
        ? {
            role: 'button' as const,
            tabIndex: 0,
            onClick: onOpenLatest,
            onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpenLatest?.();
              }
            },
          }
        : {})}
    >
      <div
        className="absolute -top-2.5 left-5 h-6 w-24 rounded-t-xl border border-b-0 border-white/60 dark:border-white/15"
        style={{ background: `linear-gradient(135deg, ${art.from}CC, ${art.to}CC)` }}
        aria-hidden="true"
      />
      <div
        className="absolute inset-x-0 top-0 bottom-3 overflow-hidden rounded-2xl rounded-bl-md border border-white/55 dark:border-white/15 shadow-[var(--glass-shadow)]"
        style={{ background: `linear-gradient(135deg, ${art.from}, ${art.to})` }}
        aria-hidden="true"
      >
        <div className="absolute inset-0 bg-white/10 backdrop-blur-[1px]" />
      </div>
      <div className="absolute left-5 top-1 flex gap-1.5" style={{ transform: 'translateY(-18px)' }}>
        {papers.map((p, i) => (
          <FolderPeekPaper key={p.file.file_id} item={p} index={i} />
        ))}
      </div>
      <div className="absolute inset-x-0 bottom-0 flex h-[74px] flex-col justify-end overflow-hidden rounded-2xl bg-[var(--depth-2-bg)] shadow-[var(--depth-2-shadow)] px-4 pb-3">
        <span className="truncate text-[13px] font-semibold text-[var(--ink-strong)]" title={row.folder}>
          {row.folder.split('/').pop()}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 font-mono text-[length:var(--text-micro)] text-[var(--ink-soft)] tabular-nums">
          <span>{row.items.length} 份</span>
          {unreadCount > 0 ? (
            <span
              data-folder-card-unread={unreadCount}
              title={`该目录内直接未读 ${unreadCount} 份`}
              className="inline-flex items-center gap-1 rounded-full bg-[color:color-mix(in_srgb,var(--accent-wave)_11%,transparent)] border border-[color:color-mix(in_srgb,var(--accent-wave)_24%,transparent)] px-1.5 text-[color:var(--accent-wave)]"
            >
              <span aria-hidden="true" className="size-1 rounded-full bg-[color:var(--accent-wave)] shrink-0" />
              {unreadCount} 未读
            </span>
          ) : row.items.length > 0 ? (
            <span
              data-folder-card-all-read=""
              title={`该目录全部 ${row.items.length} 份均已读`}
              className="inline-flex items-center gap-0.5 rounded-full bg-[color:color-mix(in_srgb,var(--status-green)_10%,transparent)] border border-[color:color-mix(in_srgb,var(--status-green)_24%,transparent)] px-1.5 text-[color:var(--stage-ink-deliver-text)] dark:text-[color:var(--success-foreground)]"
            >
              <Check className="w-2.5 h-2.5 shrink-0" />
              <span>已读</span>
            </span>
          ) : null}
          <span className="ml-auto">{latest ? `入库于 ${localDay(latest)}` : '日期待考'}</span>
        </span>
        {row.items.length > 0 && (
          <div
            aria-hidden="true"
            data-folder-card-progress=""
            className="pointer-events-none absolute inset-x-4 bottom-1 h-[2px] rounded-full overflow-hidden bg-[color:color-mix(in_srgb,var(--ink-soft)_12%,transparent)]"
          >
            <div
              className="glx-read-meter-fill h-full w-full rounded-full bg-gradient-to-r from-[color:var(--status-green)] to-[color:var(--stage-ink-deliver)] dark:from-[color:var(--success)] dark:to-[color:var(--success-foreground)]"
              style={{
                transform: `scaleX(${Math.max(0, (row.items.length - unreadCount) / row.items.length)})`,
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
};

const FOLDER_WALL_CAP = 12;

const FolderWall: React.FC<{
  rows: AtlasRow[];
  onOpenFile: (fileId: string, revisionId: string) => void;
  systemActions?: DesktopFileActionCallbacks;
}> = ({ rows, onOpenFile, systemActions }) => {
  const totalFiles = rows.reduce((sum, r) => sum + r.items.length, 0);
  const ranked = useMemo(
    () => rows.slice().sort((a, b) => b.items.length - a.items.length),
    [rows]
  );
  const shown = ranked.slice(0, FOLDER_WALL_CAP);
  if (shown.length === 0 || (ranked.length <= 1 && totalFiles <= 1)) return null;
  return (
    <Frame aria-label="资料抽屉" className="border border-border/75">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
        <div className="flex items-baseline gap-2">
          <span
            className="text-[13px] font-semibold tracking-tight text-foreground"
            title="按所在文件夹归纳的快捷入口；右上角标表示未读数，点击直接打开该目录最近更新的文件"
          >
            资料抽屉
          </span>
          <span className="font-mono text-[length:var(--text-micro)] tabular-nums text-muted-foreground">
            {ranked.length <= shown.length
              ? `共 ${ranked.length} 个目录 · 点击打开最近更新`
              : `共 ${ranked.length} 个目录 · 展示前 ${shown.length} 个 · 点击打开最近更新`}
          </span>
        </div>
      </div>
      <FramePanel className="p-4">
        <div className="flex flex-wrap gap-x-5 gap-y-2 pt-1">
          {shown.map((row) => {
            const latestItem = row.items.reduce(
              (acc, it) => ((it.observedAt || '') > (acc.observedAt || '') ? it : acc),
              row.items[0]
            );
            return (
              <FolderCard
                key={row.folder}
                row={row}
                onOpenLatest={() => onOpenFile(latestItem.file.file_id, latestItem.revisionId)}
                systemActions={systemActions}
              />
            );
          })}
        </div>
      </FramePanel>
    </Frame>
  );
};

export const AtlasView: React.FC<AtlasViewProps> = ({
  files,
  readingStates,
  onOpenFile,
  onQuickPreview,
  activeFileId,
  variant = 'fullbleed',
  filterActive = false,
  filterLabel,
  filteredCount,
  onClearFilters,
  events,
  stateOverview,
  systemActions,
  onMarkFileRead,
  onMarkFileUnread,
  onMarkFolderRead,
  onMarkFolderUnread,
}) => {
  const [viewMode, setViewMode] = useState<AtlasViewMode>(
    variant === 'embedded' ? 'grid' : 'canvas'
  );
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [showAllFolderSections, setShowAllFolderSections] = useState(false);
  const toggleFolderExpand = (folder: string) => {
    setExpandedFolders((prev) => ({ ...prev, [folder]: !prev[folder] }));
  };
  const containerRef = useRef<HTMLDivElement | null>(null);
  const zoomBehaviorRef = useRef<d3.ZoomBehavior<HTMLDivElement, unknown> | null>(
    null
  );
  const zoomSelectionRef = useRef<
    d3.Selection<HTMLDivElement, unknown, null, undefined> | null
  >(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const zoomPctLabelRef = useRef<HTMLSpanElement | null>(null);

  const applyTransformDirect = (t: { x: number; y: number; k: number }) => {
    const track = trackRef.current;
    if (track) track.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.k})`;
    const label = zoomPctLabelRef.current;
    if (label) label.textContent = `${Math.round(t.k * 100)}%`;
  };

  useEffect(() => {
    if (viewMode !== 'canvas') return;
    const el = containerRef.current;
    if (!el) return;
    const zoom = d3
      .zoom<HTMLDivElement, unknown>()
      .scaleExtent([0.4, 2.5])
      .on('zoom', (event: d3.D3ZoomEvent<HTMLDivElement, unknown>) => {
        applyTransformDirect(event.transform);
      });
    const selection = d3.select(el).call(zoom);
    zoomBehaviorRef.current = zoom;
    zoomSelectionRef.current = selection;
    return () => {
      selection.on('.zoom', null);
      zoomBehaviorRef.current = null;
      zoomSelectionRef.current = null;
    };
  }, [viewMode]);

  const hasTrack = files.length > 0 && viewMode === 'canvas';
  useEffect(() => {
    if (!hasTrack) return;
    const el = containerRef.current;
    if (!el || !trackRef.current) return;
    applyTransformDirect(d3.zoomTransform(el));
  }, [hasTrack]);

  const handleZoomIn = () => {
    const zoom = zoomBehaviorRef.current;
    const selection = zoomSelectionRef.current;
    if (zoom && selection) zoom.scaleBy(selection, 1.25);
  };

  const handleZoomOut = () => {
    const zoom = zoomBehaviorRef.current;
    const selection = zoomSelectionRef.current;
    if (zoom && selection) zoom.scaleBy(selection, 0.8);
  };

  const handleResetZoom = () => {
    const zoom = zoomBehaviorRef.current;
    const selection = zoomSelectionRef.current;
    if (zoom && selection) zoom.transform(selection, d3.zoomIdentity);
  };

  const handleContainerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    dragStartRef.current = { x: e.clientX, y: e.clientY };
  };

  const svgDataUris = useMemo(() => {
    const map: Record<string, string> = {};
    for (const f of files) {
      if (f.format !== 'svg') continue;
      const uri = getFilePreviewEntry(f).svgDataUri;
      if (uri) map[f.file_id] = uri;
    }
    return map;
  }, [files]);

  const cardItems = useMemo<AtlasCardItem[]>(
    () =>
      files.map((f) => {
        const rev = currentRevisionOf(f);
        const unreadInfo = hasUnreadChanges(f, readingStates[f.file_id]);
        return {
          file: f,
          revisionId: rev?.revision_id ?? f.current_revision_id,
          sizeBytes: rev?.sizeBytes ?? 0,
          observedAt: rev?.observed_at ?? '',
          unread: unreadInfo.isUnread,
          unreadReason: unreadInfo.reason,
          dataUri: svgDataUris[f.file_id],
          preview:
            f.format === 'md' && rev?.markdownContent
              ? mdPreviewText(rev.markdownContent)
              : undefined,
        };
      }),
    [files, readingStates, svgDataUris]
  );

  const rows = useMemo<AtlasRow[]>(() => {
    const byFolder = new Map<string, AtlasCardItem[]>();
    for (const item of cardItems) {
      const list = byFolder.get(item.file.folder);
      if (list) list.push(item);
      else byFolder.set(item.file.folder, [item]);
    }
    return Array.from(byFolder.entries()).map(([folder, items]) => ({
      folder,
      items,
    }));
  }, [cardItems]);

  const packages = useMemo<TaskPackage[]>(() => {
    const base = groupFilesIntoPackages(files);
    return events && events.length > 0 ? enrichPackagesWithEvents(base, events) : base;
  }, [files, events]);

  const fileById = useMemo(() => new Map(files.map((f) => [f.file_id, f])), [files]);

  const openGalleryDoc = (fileId: string) => {
    const rec = fileById.get(fileId);
    if (!rec) return;
    const rev = currentRevisionOf(rec);
    onOpenFile(fileId, rev?.revision_id ?? rec.current_revision_id);
  };

  const stageCounts = useMemo(() => {
    const counts: Record<StageRole, number> = {
      蓝图: 0,
      计划: 0,
      决策: 0,
      执行: 0,
      交付: 0,
      待分类: 0,
    };
    for (const pkg of packages) counts[pkg.stage] += 1;
    return counts;
  }, [packages]);

  const formatCounts = useMemo(() => {
    let svg = 0;
    let md = 0;
    let pdf = 0;
    let other = 0;
    for (const f of files) {
      if (f.format === 'svg') svg += 1;
      else if (f.format === 'md') md += 1;
      else if (f.format === 'pdf') pdf += 1;
      else other += 1;
    }
    return { svg, md, pdf, other };
  }, [files]);

  const renderFolderCardFrame = (row: AtlasRow) => {
    const isExpanded = Boolean(expandedFolders[row.folder]);
    const sliced = sliceAtlasFolderItems(row.items, isExpanded, ATLAS_LARGE_FOLDER_CAP);
    const ribbon = buildFolderFormatRibbon(row.items);
    const unreadCount = row.items.filter((it) => it.unread).length;
    const folderTarget = row.folder === '.' ? '' : row.folder;
    return (
      <CardFrame
        key={row.folder}
        data-atlas-folder-frame={row.folder}
        className="border border-border/75"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
          <div className="flex items-center gap-2 min-w-0">
            <FolderOpen className="size-3.5 shrink-0 text-[color:var(--accent-iris-deep)]" aria-hidden="true" />
            <span className="truncate font-semibold text-[13px] text-foreground" title={row.folder}>
              {row.folder}
            </span>
            <Badge variant="outline" size="sm" className="font-mono tabular-nums whitespace-nowrap shrink-0">
              {row.items.length} 份
            </Badge>
            {unreadCount > 0 ? (
              <span
                data-atlas-section-unread={unreadCount}
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[length:var(--text-micro)] leading-[var(--lh-micro)] tabular-nums text-[color:var(--accent-wave)] bg-[color:color-mix(in_srgb,var(--accent-wave)_11%,transparent)] border border-[color:color-mix(in_srgb,var(--accent-wave)_24%,transparent)] whitespace-nowrap shrink-0"
              >
                <span aria-hidden="true" className="size-1 rounded-full bg-[color:var(--accent-wave)] shrink-0" />
                <span>{unreadCount} 未读</span>
              </span>
            ) : row.items.length > 0 ? (
              <span
                data-atlas-section-all-read=""
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-medium text-[color:var(--stage-ink-deliver-text)] dark:text-[color:var(--success-foreground)] bg-[color:color-mix(in_srgb,var(--status-green)_10%,transparent)] border border-[color:color-mix(in_srgb,var(--status-green)_24%,transparent)] whitespace-nowrap shrink-0"
              >
                <Check className="size-3 shrink-0" aria-hidden="true" />
                <span>本组已读</span>
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {unreadCount > 0 && onMarkFolderRead && (
              <button
                type="button"
                data-atlas-section-mark-read={row.folder}
                title={`将目录「${row.folder}」内未读文档一键标为已读（8 秒内可撤销）`}
                onClick={() => onMarkFolderRead(folderTarget)}
                className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-[color:color-mix(in_srgb,var(--status-green)_28%,transparent)] bg-[color:color-mix(in_srgb,var(--status-green)_9%,transparent)] px-2.5 py-0.5 text-[11px] font-medium text-[color:var(--stage-ink-deliver-text)] dark:text-[color:var(--success-foreground)] transition-colors hover:bg-[color:color-mix(in_srgb,var(--status-green)_16%,transparent)]"
              >
                <CheckCheck className="size-3" aria-hidden="true" />
                <span>本组已读</span>
              </button>
            )}
            {unreadCount === 0 && row.items.length > 0 && onMarkFolderUnread && (
              <button
                type="button"
                data-atlas-section-mark-unread={row.folder}
                title={`将目录「${row.folder}」重置为未读（8 秒内可撤销）`}
                onClick={() => onMarkFolderUnread(folderTarget)}
                className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-border/80 bg-card px-2 py-0.5 text-[11px] font-medium text-[color:var(--ink-soft)] transition-colors hover:border-[color:color-mix(in_srgb,var(--accent-wave)_35%,transparent)] hover:text-[color:var(--accent-wave)]"
              >
                <RotateCcw className="size-2.5" aria-hidden="true" />
                <span>标为未读</span>
              </button>
            )}
            <span className="hidden md:inline font-mono text-[length:var(--text-micro)] text-muted-foreground tabular-nums">
              {formatComposition(row.items)}
            </span>
            {row.items.length > ATLAS_LARGE_FOLDER_CAP && (
              <button
                type="button"
                data-atlas-folder-toggle={row.folder}
                aria-expanded={isExpanded}
                onClick={() => toggleFolderExpand(row.folder)}
                className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-border/80 bg-card px-2.5 py-0.5 text-[11px] font-medium text-[color:var(--accent-iris-deep)] transition-colors hover:border-[color:var(--accent-iris)]"
              >
                {isExpanded ? (
                  <>
                    <ChevronDown className="size-3" aria-hidden="true" />
                    <span>收起至 {ATLAS_LARGE_FOLDER_CAP} 份代表件</span>
                  </>
                ) : (
                  <>
                    <ChevronRight className="size-3" aria-hidden="true" />
                    <span>展开剩余 {sliced.hiddenCount} 份</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>
        {ribbon.length > 0 && (
          <div
            data-atlas-format-ribbon=""
            className="mx-4 mb-2 flex h-1.5 overflow-hidden rounded-full bg-muted"
            title={ribbon.map((s) => `${s.label} ${s.count}`).join(' · ')}
          >
            {ribbon.map((seg) => (
              <span
                key={seg.key}
                style={{ width: `${Math.max(seg.pct, 3)}%`, backgroundColor: seg.color }}
              />
            ))}
          </div>
        )}
        <div className="rounded-xl border border-border/60 bg-card/85 p-3.5">
          <div className="flex flex-wrap gap-3.5">
            {sliced.visible.map((item) => (
              <FileCard
                key={item.file.file_id}
                item={item}
                active={item.file.file_id === activeFileId}
                onOpenFile={onOpenFile}
                onQuickPreview={onQuickPreview}
                dragStartRef={dragStartRef}
                systemActions={systemActions}
                onMarkFileRead={onMarkFileRead}
                onMarkFileUnread={onMarkFileUnread}
              />
            ))}
          </div>
        </div>
      </CardFrame>
    );
  };

  const renderEmbeddedOverviewSections = () => {
    const activeStages = STAGE_SLOT_ORDER.filter((role) => stageCounts[role] > 0);
    const collapseSingleItemContainers = packages.length <= 1 && files.length <= 1;
    const showStageSummary = !collapseSingleItemContainers && (packages.length > 1 || activeStages.length > 1);
    if (collapseSingleItemContainers) {
      return <div data-atlas-single-collapsed="true" className="hidden" />;
    }
    return (
      <>
        {showStageSummary && (
          <Frame className="border border-border/75">
            <div className="flex flex-wrap items-center gap-2 px-3.5 py-2 font-mono text-[length:var(--text-micro)] tabular-nums text-muted-foreground">
              <span
                className="font-sans font-semibold text-[12px] text-foreground pr-2 border-r border-border/80"
                title="按主题目录聚合并排除零值阶段的文档分布"
              >
                {packages.length} 个任务包
              </span>
              {activeStages.map((role) => {
                const count = stageCounts[role];
                return (
                  <span
                    key={role}
                    className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 bg-card text-foreground border border-border/70 shadow-xs"
                  >
                    <span
                      className="size-1.5 rounded-full shrink-0"
                      style={{ backgroundColor: STAGE_ACCENT[role] }}
                      aria-hidden="true"
                    />
                    <span>{role}</span>
                    <span className="font-semibold text-foreground">{count}</span>
                  </span>
                );
              })}
            </div>
          </Frame>
        )}
        <TaskPackageGallery
          packages={packages}
          fileById={fileById}
          svgDataUris={svgDataUris}
          activeFileId={activeFileId}
          onOpenDoc={openGalleryDoc}
          stateOverview={stateOverview}
          onOpenFileContextMenu={systemActions?.onOpenFileContextMenu}
        />
        <FolderWall rows={rows} onOpenFile={onOpenFile} systemActions={systemActions} />
      </>
    );
  };

  return (
    <div
      data-atlas-view-mode={viewMode}
      className="glass-page relative flex-1 flex flex-col min-h-0 overflow-hidden select-none"
    >
      <div className="relative z-20 mx-4 mt-2.5 shrink-0">
        <Toolbar
          aria-label="资产库概览工具栏"
          className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border/80 bg-card/90 px-3 py-1.5 shadow-[var(--glass-shadow)] backdrop-blur-md"
        >
          <ToolbarGroup className="flex flex-wrap items-center gap-2 min-w-0">
            <span className="text-[12px] font-semibold text-foreground tracking-tight whitespace-nowrap">
              资产库概览
            </span>
            <SegmentedControl size="sm" role="group" aria-label="概览视图模式">
              <SegmentedControlItem
                type="button"
                aria-pressed={viewMode === 'grid'}
                onClick={() => setViewMode('grid')}
              >
                <LayoutGrid className="size-3" aria-hidden="true" />
                <span>紧凑网格</span>
              </SegmentedControlItem>
              <SegmentedControlItem
                type="button"
                aria-pressed={viewMode === 'canvas'}
                onClick={() => setViewMode('canvas')}
              >
                <MapIcon className="size-3" aria-hidden="true" />
                <span>画布导览</span>
              </SegmentedControlItem>
            </SegmentedControl>
            {variant === 'embedded' && filterActive && (
              <div className="inline-flex items-center gap-1.5 rounded-full border border-border/75 bg-muted/60 px-2.5 py-0.5 font-mono text-[length:var(--text-micro)] text-muted-foreground">
                <span className="truncate max-w-[200px]" title={filterLabel || '已筛选'}>
                  筛选：{filterLabel || '已筛选'}
                </span>
                <span className="shrink-0 whitespace-nowrap">
                  ·{' '}
                  <strong className="text-foreground tabular-nums">
                    {filteredCount ?? files.length}
                  </strong>{' '}
                  份
                </span>
                {onClearFilters && (
                  <button
                    type="button"
                    onClick={onClearFilters}
                    className="shrink-0 cursor-pointer text-[color:var(--accent-iris-deep)] hover:text-[color:var(--accent-iris-ink)] underline underline-offset-2"
                  >
                    清除筛选
                  </button>
                )}
              </div>
            )}
          </ToolbarGroup>

          <ToolbarGroup className="flex items-center gap-2 shrink-0">
            {(() => {
              const formatSummaryParts = [
                ['MD', formatCounts.md],
                ['SVG', formatCounts.svg],
                ['PDF', formatCounts.pdf],
                ['其它', formatCounts.other],
              ]
                .filter(([, count]) => Number(count) > 0)
                .map(([label, count]) => `${label} ${count}`);
              return (
                <span
                  data-atlas-nonzero-stats=""
                  className="hidden xl:inline font-mono text-[length:var(--text-micro)] text-muted-foreground tabular-nums"
                >
                  {files.length} 文件 · {rows.length} 目录
                  {formatSummaryParts.length > 0 ? ` · ${formatSummaryParts.join(' / ')}` : ''}
                </span>
              );
            })()}
            {viewMode === 'canvas' && (
              <>
                <ToolbarSeparator className="hidden xl:block" />
                <div
                  data-atlas-zoom-controls=""
                  className="inline-flex items-center gap-0.5 rounded-lg border border-border/75 bg-muted/45 px-1.5 py-0.5 text-[11px] font-mono"
                >
                  <button
                    type="button"
                    aria-label="放大"
                    title="放大"
                    onClick={handleZoomIn}
                    className="px-1 py-0.5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-card transition-colors cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="缩小"
                    title="缩小"
                    onClick={handleZoomOut}
                    className="px-1 py-0.5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-card transition-colors cursor-pointer"
                  >
                    <Minus className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="重置为 100%"
                    title="重置为 100%"
                    onClick={handleResetZoom}
                    className="px-1 py-0.5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-card transition-colors cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                  <span ref={zoomPctLabelRef} className="pl-1 text-muted-foreground tabular-nums">
                    100%
                  </span>
                </div>
              </>
            )}
          </ToolbarGroup>
        </Toolbar>
      </div>

      {files.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <Empty className="max-w-md rounded-2xl border border-dashed border-border/80 bg-card/70 py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderOpen className="size-4" />
              </EmptyMedia>
              <EmptyTitle>{filterActive ? '当前筛选下 0 份资料' : '工作区暂无资料卡片'}</EmptyTitle>
              <EmptyDescription>
                {filterActive
                  ? '可放宽左侧筛选条件或清除筛选查看完整资产库'
                  : '同步工作区目录后，专项橱窗与目录卡片将自动汇入此处'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : viewMode === 'grid' ? (
        <ScrollArea scrollFade className="flex-1 min-h-0">
          <div className="mx-auto max-w-[1320px] px-5 py-4 space-y-5">
            {variant === 'embedded' && renderEmbeddedOverviewSections()}
            <div className="space-y-4">
              {(showAllFolderSections ? rows : rows.slice(0, FOLDER_WALL_CAP)).map((row) =>
                renderFolderCardFrame(row)
              )}
              {rows.length > FOLDER_WALL_CAP && (
                <div className="flex justify-center pt-1">
                  <button
                    type="button"
                    data-atlas-show-all-folders=""
                    onClick={() => setShowAllFolderSections((v) => !v)}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border/80 bg-card px-4 py-1.5 text-[12px] font-medium text-foreground shadow-xs transition-colors hover:border-[color:var(--accent-iris)] hover:text-[color:var(--accent-iris-deep)]"
                  >
                    {showAllFolderSections
                      ? `收起目录列表（仅展示前 ${FOLDER_WALL_CAP} 个目录）`
                      : `展开其余 ${rows.length - FOLDER_WALL_CAP} 个目录（共 ${rows.length} 个）`}
                  </button>
                </div>
              )}
            </div>
          </div>
        </ScrollArea>
      ) : (
        <div
          ref={containerRef}
          className="relative flex-1 min-h-0 overflow-hidden cursor-grab active:cursor-grabbing"
          onPointerDown={handleContainerPointerDown}
        >
          <div
            ref={trackRef}
            className="absolute left-0 top-0 px-6 pb-10 pt-5 space-y-7"
            style={{
              transform: 'translate(0px, 0px) scale(1)',
              transformOrigin: '0 0',
              willChange: 'transform',
            }}
          >
            {variant === 'embedded' && renderEmbeddedOverviewSections()}
            {variant === 'fullbleed' && rows.map((row) => renderFolderCardFrame(row))}
          </div>
        </div>
      )}
    </div>
  );
};
