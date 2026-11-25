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
import { formatUiMeta } from '../utils/formatMeta';
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
// 未读角标措辞走 unreadStatusLabel 单一出口（UnreadReason 类型同源）
import { hasUnreadChanges, unreadStatusLabel } from '../utils/guanlanEngine';
import type { UnreadReason } from '../utils/guanlanEngine';
// SVG 预览编码走 per-file 缓存单一出口（原组件内全量重编码实现已收敛进缓存层）
import { getFilePreviewEntry } from '../utils/filePreviewCache';
import { cleanDisplayText } from '../utils/displayText';
// 卡片日期按本地日历日展示（含时刻 ISO 不再直切 UTC）
import { localDay } from '../utils/timeFormat';
// 语义聚合层纯函数（任务包 / 五阶段 / 核心结论）——橱窗数据全部来自这里，组件内零造数
import {
  enrichPackagesWithEvents,
  groupFilesIntoPackages,
  STAGE_ACCENT,
  STAGE_SLOT_ORDER,
} from '../utils/taskPackages';
import type { StageRole, TaskPackage } from '../utils/taskPackages';
// 任务包橱窗复用 TaskPackageGallery（本文件不改 Gallery 源文件）。
// 签名为 TaskPackageGalleryProps；filter/onFilterChange 双缺省时组件内自持——概览不受控；
// onOpenDoc 只回传 fileId，当前版本解析在本组件 openGalleryDoc 内做。
import TaskPackageGallery from './TaskPackageGallery';

interface AtlasViewProps {
  files: FileRecord[];
  readingStates: Record<string, ReadingState>;
  onOpenFile: (fileId: string, revisionId: string) => void;
  onQuickPreview?: (fileId: string, revisionId?: string) => void;
  activeFileId: string;
  /** fullbleed=顶层独占全幅（默认，行为与旧版逐字节等价）；embedded=知识资产库概览态：
   *  塞进三栏中栏——隐藏自带顶部说明条（缩放工具条已退役：网格列表
   *  不需要画布缩放器，仅拆 UI 不拆 d3.zoom 几何——拖拽平移/滚轮缩放仍是该轨道唯一的
   *  视口控制手段；fullbleed 工具条保留）（看板 WorkflowBoard →
   *  TaskPackageGallery 只读复用） */
  variant?: 'fullbleed' | 'embedded';
  /** 概览态是否处于筛选结果中——只决定顶部筛选条与空态文案；
   *  过滤本身在 App 完成（收到的 files 已是 filteredFiles），这里不做二次过滤 */
  filterActive?: boolean;
  /** 当前筛选条件摘要，如「未读 · design」 */
  filterLabel?: string;
  /** 筛选结果份数；缺省取收到的 files 长度 */
  filteredCount?: number;
  onClearFilters?: () => void;
  /** 时间线事件流——回填任务包 eventCount/lastActivity（enrichPackagesWithEvents）；
   *  未传时状态标签不含事件计数/最近活动（0/'' 不渲染，不造数）。 */
  events?: TimelineEvent[];
  /** App 级 /state-overview 唯一数据源，透传任务包橱窗渲染六态徽标 */
  stateOverview?: StateOverviewResponse | null;
  /** 文件卡片右键菜单、资源管理器定位与默认程序打开 */
  systemActions?: DesktopFileActionCallbacks;
  /** 卡片 / 目录组 1-click 已读/未读切换回调 */
  onMarkFileRead?: (fileId: string, revisionId: string) => void;
  onMarkFileUnread?: (fileId: string) => void;
  onMarkFolderRead?: (folderPath: string) => void;
  onMarkFolderUnread?: (folderPath: string) => void;
}

/** 卡片渲染所需的两级信息：当前版本 + 未读态 + 缩略图/预览，全部预先物化以便 memo 卡跳过缩放重渲染 */
interface AtlasCardItem {
  file: FileRecord;
  revisionId: string;
  sizeBytes: number;
  observedAt: string;
  unread: boolean;
  /** 未读角标悬浮文案用三态原文（unreadStatusLabel 的入参），不在各处自造词 */
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

/** 目录格式构成指纹段（用于 CardFrame 顶部微彩带，严格 MECE 守恒） */
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

/** 当前版本解析：revisions 按 seq 升序（seq 1 是基线旧版），必须取 current_revision_id 指向的最新版（App.tsx 同式） */
function currentRevisionOf(file: FileRecord) {
  return (
    file.revisions.find((r) => r.revision_id === file.current_revision_id) ||
    file.revisions[file.revisions.length - 1]
  );
}

/** MD 预览：去掉 #>* 等符号取前 90 字；MD 正文仅当前版本内联时才有，绝不批量请求 /revisions/<id>/content */
function mdPreviewText(raw: string): string {
  return cleanDisplayText(raw)
    .replace(/[#>*`~_[\]()!-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
}

/** 分组头格式构成：由 row.items 现算，保留 MD/SVG/PDF 前序，其余格式按份数降序列示 */
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

/** 卡片基类（与 GraphCanvasView 同款几何）：200×130、rounded-xl、p-2.5；几何零改动。
 *  去框感：1px 边框退役——层级改由白底色阶 + 弥散阴影承担；rounded-xl 与
 *  --depth-2-radius 同为 12px，卡面走 .depth-2-card 工具类，hover 浮起走 .depth-2-card-hover
 *  唯一合法形态（translateY(-2px) + 阴影加深，--dur-1 --ease-spring，index.css:433-440）。 */
const CARD_BASE =
  'flex w-[200px] h-[130px] flex-col justify-between rounded-xl p-2.5 text-left cursor-pointer';
/** 非选中层：depth-2 白底卡（无边框，弥散阴影），hover 浮起由 depth-2-card-hover 提供 */
const CARD_IDLE_LAYER = 'depth-2-card depth-2-card-hover';
/** 选中层（当前阅读文件回指）：常显薰衣草 ring（选中语义不变），hover 同款浮起 */
const CARD_ACTIVE_LAYER =
  'depth-2-card depth-2-card-hover ring-2 ring-[color:color-mix(in_srgb,var(--accent-iris)_30%,transparent)]';

/** 拖拽平移后松手不触发打开：按下/抬起位移超过阈值视为平移而非单击 */
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
  const metaLabel = `${(item.sizeBytes / 1024).toFixed(1)} KB · ${
    item.observedAt ? localDay(item.observedAt) : '日期待考'
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
        /* 措辞走 unreadStatusLabel 单一出口（未读（尚未建立阅读基线）/ 自上次读有更新），不再写死「未读变化」 */
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
          {/* 上：SVG 缩略图区（data-URI img，绝不注入原始 SVG 到 DOM）；暖纸图版统一视口 */}
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
          {/* 预览行：仅当前版本内联正文时渲染，否则回退角色一行 */}
          <span className="mt-1.5 line-clamp-2 text-[length:var(--text-micro)] leading-snug text-[var(--ink-soft)]">
            {item.preview ?? roleFallback}
          </span>
          {metaLine}
        </>
      ) : (
        <>
          {/* PDF 卡：徽标 + 标题 + 角色一行 + 元数据，三段同构不留空洞，不内嵌 iframe */}
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

// ================= 玻璃文件夹卡（浅色玻璃改版新增，参考 macOS 毛玻璃文件夹）=================

/** 文件夹艺术渐变对：由 folder 名 hash 确定性选取（同文件夹跨会话同色，零随机）。
 *  色对为既有调色板族的浅底柔化版，只做装饰衬底，不承载任何语义。 */
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

/** 文件夹口探出的文档纸片：SVG 用真实缩略图，其余为格式着色的渐变纸面 */
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
      className="glx-folder-paper h-[64px] w-[52px] shrink-0 overflow-hidden rounded-md border border-[#26243D]/10 bg-white shadow-[var(--glass-shadow)]"
      style={{ '--peek-rot': `${rotate}deg` } as React.CSSProperties}
      aria-hidden="true"
    >
      {item.dataUri ? (
        <img
          src={item.dataUri}
          alt=""
          loading="lazy"
          draggable={false}
          className="h-full w-full object-cover object-top p-0.5"
        />
      ) : (
        <div
          className="flex h-full w-full flex-col justify-between p-1"
          style={{ background: 'linear-gradient(180deg,#FAF9F5 0%,#EFEAF7 100%)' }}
        >
          {/* 格式微标采用 micro 11px 与 font-medium 字重，保持界面可读性与字重层级 */}
          <span
            className="text-[length:var(--text-micro)] leading-none font-mono font-medium"
            style={{ color: formatInk }}
          >
            {item.file.format.toUpperCase()}
          </span>
          <span className="block h-0.5 w-full rounded bg-[#26243D]/10" />
          <span className="block h-0.5 w-3/4 rounded bg-[#26243D]/10" />
        </div>
      )}
    </div>
  );
};

/** 文件夹卡：舌 tab + 彩色渐变背板 + 文档纸片探出 + depth-2 白底前板（去框感）。
 *  fullbleed 卡阵中作纯装饰分组头；概览（embedded）资料抽屉中带 onOpenLatest，
 *  点击打开该文件夹最近更新的文档（role=button div + Enter/空格，键盘约定不回退）。 */
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
  // hover 浮起对齐 depth 唯一合法形态（depth-2-card-hover：-2px + 阴影加深，
  // --dur-1 --ease-spring），替换旧 transition-transform duration-200 hover:-translate-y-1
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
      {/* folder 舌 tab（参考图背板上的圆舌） */}
      <div
        className="absolute -top-2.5 left-5 h-6 w-24 rounded-t-xl border border-b-0 border-white/70"
        style={{ background: `linear-gradient(135deg, ${art.from}CC, ${art.to}CC)` }}
        aria-hidden="true"
      />
      {/* 背板：彩色渐变艺术层 */}
      <div
        className="absolute inset-x-0 top-0 bottom-3 overflow-hidden rounded-2xl rounded-bl-md border border-white/60 shadow-[var(--glass-shadow)]"
        style={{ background: `linear-gradient(135deg, ${art.from}, ${art.to})` }}
        aria-hidden="true"
      >
        <div className="absolute inset-0 bg-white/10 backdrop-blur-[1px]" />
      </div>
      {/* 文档纸片：上缘探出卡体，下缘压进前板玻璃之下 */}
      <div className="absolute left-5 top-1 flex gap-1.5" style={{ transform: 'translateY(-18px)' }}>
        {papers.map((p, i) => (
          <FolderPeekPaper key={p.file.file_id} item={p} index={i} />
        ))}
      </div>
      {/* 前板：去框感——glass-panel 1px 玻璃框退役，改 depth-2 白底 + 弥散阴影；
          保留 rounded-2xl 16px 与背板/舌 tab 同档（.depth-2-card 类内置 12px 会与 16px 背板错档，
          故用 depth 令牌组合而非整类替换）。艺术层白发丝边随 FOLDER_ARTWORK 豁免口径保留。 */}
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
          <span className="ml-auto">{latest ? localDay(latest) : '日期待考'}</span>
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

/** 概览资料抽屉：按收量取前 12 组文件夹的玻璃文件夹卡（DOM 常量级——
 *  这里只挂 12 张装饰卡，不平铺文档卡阵；点击打开该文件夹最近更新文档）。 */
const FOLDER_WALL_CAP = 12;

const FolderWall: React.FC<{
  rows: AtlasRow[];
  onOpenFile: (fileId: string, revisionId: string) => void;
  systemActions?: DesktopFileActionCallbacks;
}> = ({ rows, onOpenFile, systemActions }) => {
  const ranked = useMemo(
    () => rows.slice().sort((a, b) => b.items.length - a.items.length),
    [rows]
  );
  const shown = ranked.slice(0, FOLDER_WALL_CAP);
  if (shown.length === 0) return null;
  // 外层 Frame 作为资料抽屉分组容器，按收量取前 FOLDER_WALL_CAP 组，内部 FolderCard 保持卡片层级
  return (
    <Frame aria-label="资料抽屉" className="border border-border/75">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold tracking-tight text-foreground">
            资料抽屉
          </span>
          <span className="font-mono text-[length:var(--text-micro)] tabular-nums text-muted-foreground">
            共 {ranked.length} 组 · 显示前 {shown.length} 组（按收量） · 点击打开最近更新
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
  // 支持「画布导览 / 紧凑网格」一键切换；embedded 默认紧凑网格原生顺滑滚动，fullbleed 默认画布导览
  const [viewMode, setViewMode] = useState<AtlasViewMode>(
    variant === 'embedded' ? 'grid' : 'canvas'
  );
  // 超大目录（> ATLAS_LARGE_FOLDER_CAP 份）默认折叠代表件保护 60fps，用户可按目录逐个展开
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
  // 帧直写锚点：transform 唯一消费点是轨道 div 的内联 style（+ 缩放百分比标签），
  // 因此 zoom handler 命令式直写 DOM、不进 React state——旧实现每帧 setState 连带全组件
  // 重渲，2200 张 FileCard memo 浅比较逐帧抖动；两个 ref 由下方 zoom/mount-edge 效应独占写入
  const trackRef = useRef<HTMLDivElement | null>(null);
  const zoomPctLabelRef = useRef<HTMLSpanElement | null>(null);

  /** transform 帧直写：轨道位移/缩放 + 百分比标签一次写齐（zoom 事件与挂载沿共用）。
   *  标签走 textContent：JSX 子节点是静态「100%」，React 重渲前后同值不回写 DOM，
   *  命令式写入得以保留（同 trackRef.style.transform 的逃逸舱纪律）。 */
  const applyTransformDirect = (t: { x: number; y: number; k: number }) => {
    const track = trackRef.current;
    if (track) track.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.k})`;
    const label = zoomPctLabelRef.current;
    if (label) label.textContent = `${Math.round(t.k * 100)}%`;
  };

  // d3.zoom 接线：拖拽平移 + 滚轮缩放；transform 只进 CSS transform，缩放不触发布局重排。
  // 帧内直写（不 setState）：滚轮/拖拽期间组件零重渲，卡片 memo 不再被逐帧浅比较
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- applyTransformDirect 只读稳定 ref
  }, [viewMode]);

  // 空态→有资料沿：轨道 div 此刻才进 DOM。空态期间用户滚轮缩放过画布的话，d3 内部
  // transform 已非恒等——旧 state 方案靠重渲把状态带到新轨道，帧直写后由这里补写一次，
  // 避免首批卡片以恒等变换闪现（有资料首挂载时 k=1，写入与静态占位同值，无感）
  const hasTrack = files.length > 0 && viewMode === 'canvas';
  useEffect(() => {
    if (!hasTrack) return;
    const el = containerRef.current;
    if (!el || !trackRef.current) return;
    applyTransformDirect(d3.zoomTransform(el));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- applyTransformDirect 只读稳定 ref
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

  // SVG 缩略图 data-URI：per-file 预览缓存单一出口（filePreviewCache，与 HomeView/画布分组
  // 同一份）——修订未变 O(1) 命中，仅新到文件/新修订编码一次；这里只按 file_id 装配 Record
  // 喂下游（memo 仍以 files 身份为键，map 引用稳定性与旧实现一致）
  const svgDataUris = useMemo(() => {
    const map: Record<string, string> = {};
    for (const f of files) {
      if (f.format !== 'svg') continue;
      const uri = getFilePreviewEntry(f).svgDataUri;
      if (uri) map[f.file_id] = uri;
    }
    return map;
  }, [files]);

  // 卡片数据物化：当前版本解析 + 未读态 + MD 预览，一次成型供 memo 卡复用
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

  // 分组行：按 folder 首现顺序成行（LeftSidebar.tsx:57 同式语义），一个不落全部上卡
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

  // 任务包数据——全部来自 taskPackages 纯函数导出（组件内零造数）。
  // events 可选：缺省（App 当前调用未传）时 eventCount/lastActivity 保持 0/'' 占位，不渲染。
  const packages = useMemo<TaskPackage[]>(() => {
    const base = groupFilesIntoPackages(files);
    return events && events.length > 0 ? enrichPackagesWithEvents(base, events) : base;
  }, [files, events]);

  // file_id → FileRecord（Gallery onOpenDoc 回传 fileId 后在此解析当前版本走既有 onOpenFile）
  const fileById = useMemo(() => new Map(files.map((f) => [f.file_id, f])), [files]);

  // Gallery 打开文档——onOpenDoc 只回传 fileId，当前版本在此解析（currentRevisionOf 与
  // cardItems 同口径），等价原 WorkflowBoard.openDoc（current_revision_id 指向最新版）
  const openGalleryDoc = (fileId: string) => {
    const rec = fileById.get(fileId);
    if (!rec) return;
    const rev = currentRevisionOf(rec);
    onOpenFile(fileId, rev?.revision_id ?? rec.current_revision_id);
  };

  // 五阶段聚合（原 WorkflowBoard 导读横幅的同源统计——包数按主导阶段计，含待分类；
  // 徽标行只展示 STAGE_SLOT_ORDER 五阶段，待分类不外显，与原横幅口径一致）
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
        {/* 目录格式构成数据指纹彩带 */}
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

  const renderEmbeddedOverviewSections = () => (
    <>
      {/* coss Frame 阶段分布导读条 */}
      <Frame className="border border-border/75">
        <div className="flex flex-wrap items-center gap-2 px-3.5 py-2 font-mono text-[length:var(--text-micro)] tabular-nums text-muted-foreground">
          <span className="font-sans font-semibold text-[12px] text-foreground pr-2 border-r border-border/80">
            {packages.length} 个任务包
          </span>
          {STAGE_SLOT_ORDER.map((role) => {
            const count = stageCounts[role];
            const active = count > 0;
            return (
              <span
                key={role}
                className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 transition-opacity ${
                  active
                    ? 'bg-card text-foreground border border-border/70 shadow-xs'
                    : 'opacity-50'
                }`}
              >
                <span
                  className="size-1.5 rounded-full shrink-0"
                  style={{ backgroundColor: STAGE_ACCENT[role] }}
                  aria-hidden="true"
                />
                <span>{role}</span>
                <span className={active ? 'font-semibold text-foreground' : ''}>{count}</span>
              </span>
            );
          })}
        </div>
      </Frame>
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

  return (
    <div
      data-atlas-view-mode={viewMode}
      className="glass-page relative flex-1 flex flex-col min-h-0 overflow-hidden select-none"
    >
      {/* 统一 coss Toolbar 顶栏（画布导览 / 紧凑网格切换 + 缩放控制器 + 筛选胶囊 + 资产统计） */}
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
            <span className="hidden xl:inline font-mono text-[length:var(--text-micro)] text-muted-foreground tabular-nums">
              {files.length} 文件 · {rows.length} 目录 · MD {formatCounts.md} / SVG {formatCounts.svg} / PDF{' '}
              {formatCounts.pdf}
              {formatCounts.other > 0 ? ` / 其它 ${formatCounts.other}` : ''}
            </span>
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

      {/* 主体：空态 coss Empty / 紧凑网格原生 ScrollArea / 画布导览 d3.zoom */}
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
        /* 缩放画布容器：d3.zoom 挂在这里；点阵背景留在根容器，不随 zoom 变换 */
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
