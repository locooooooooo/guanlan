import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowUpDown,
  BookOpen,
  BotMessageSquare,
  Check,
  CheckCheck,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Cog,
  Eye,
  EyeOff,
  FileCode,
  FilePlus2,
  FileText,
  Filter,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Inbox,
  Layers,
  ListChecks,
  Loader2,
  Lock,
  LockOpen,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Tag,
  Trash2,
  Undo2,
  Unlink,
  X,
} from 'lucide-react';
import type { FileContextMenuTarget } from './FileContextMenu';
import {
  ContentRole,
  FileFormat,
  FileRecord,
  ReadingState,
} from '../types/guanlan';
import type {
  ArtifactStateView,
  MountedWorkspaceDto,
  ProjectEntryDto,
} from '../services/apiTypes';
import type { FileFacets } from '../services/workspaceClient';
import type { MountedTreeCacheEntry } from '../hooks/useDirectoryShell';
import type { ProjectTreeCacheEntry } from '../hooks/useMultiProjects';
import { hasUnreadChanges, unreadStatusLabel, type UnreadReason } from '../utils/guanlanEngine';
import { readingRecency } from '../utils/readingStateStore';
import { formatRelativeObservedAt } from '../utils/timeFormat';
import {
  computeSmartViewCounts,
  computeSmartViewFiles,
  isSmartViewScope,
  RECENT_ACTIVE_WINDOW_MS,
  SMART_VIEWS,
  type SmartViewDef,
  type SmartViewId,
} from '../utils/smartViews';
import { useSidebarTreeDrag } from '../hooks/useSidebarTreeDrag';
import {
  buildMergedFolderTree,
  collectSubtreeFileIds,
  collectSubtreePaths,
  computeSiblingSharedPrefixMap,
  filterFolderTreeByQuery,
  formatMiddleEllipsisName,
  isFolderMuted,
  SIDEBAR_WIDTH_DEFAULT,
  sortFolderTreeNodes,
  splitQuickFilterHighlight,
  type FolderNode,
  type GlobalPinnedFile,
  type SidebarTreeSortMode,
} from '../utils/sidebarTree';
import { extractCoreSummary } from '../utils/taskPackages';
import { MountedWorkspacesSection } from './sidebar/MountedWorkspacesSection';
import {
  ProjectTreeBranch,
  SIDEBAR_DENSE_FOLDER_THRESHOLD,
  VirtualFileSlice,
} from './sidebar/ProjectTreeBranch';
import { Button, Chip } from './ui/primitives';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  Badge,
  Button as CossButton,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Popover,
  PopoverPopup,
  PopoverTrigger,
  PreviewCard,
  PreviewCardCreateHandle,
  PreviewCardPopup,
  PreviewCardTrigger,
  ScrollArea,
  SegmentedControl,
  SegmentedControlItem,
} from './ui';
import { formatUiMeta } from '../utils/formatMeta';

export type QuickScope =
  | 'all'
  | 'unread'
  | 'bookmarked'
  | SmartViewId;

export interface SidebarFilters {
  quickScope: QuickScope;
  folder: string | 'all';
  format: FileFormat | 'all';
  role: ContentRole | 'all';
  topic: string | 'all';
}

/** 筛选组合快照（状态栈：一键清空后可回退到清空前的完整组合）。 */
export type SidebarFiltersSnapshot = Readonly<SidebarFilters>;

interface LeftSidebarProps {
  files: FileRecord[];
  dataSource?: 'loading' | 'real' | 'error';
  retryingConnection?: boolean;
  onRetryConnection?: () => void;
  readingStates: Record<string, ReadingState>;
  totalCount?: number;
  activeFileId: string;
  filters: SidebarFilters;
  onUpdateFilters: (next: Partial<SidebarFilters>) => void;
  onResetFilters: () => void;
  onOpenFileToRead: (fileId: string, sectionId?: string) => void;
  onMarkReadingBaseline?: (
    scope: 'workspace' | 'folder',
    folderPrefix?: string
  ) => Promise<boolean> | void;
  onMarkFileRead?: (fileId: string, revisionId: string) => void;
  onMarkFileUnread?: (fileId: string) => void;
  onMarkFolderUnread?: (folderPath: string) => Promise<boolean> | boolean | void;
  mutedFolders?: readonly string[];
  onToggleMuteFolder?: (folderPath: string) => void;
  onUnmuteFolder?: (folderPath: string) => void;
  onClearMutedFolders?: () => void;
  onSelectFile?: (fileId: string, revisionId?: string) => void;
  onQuickPreview?: (fileId: string, revisionId?: string) => void;
  onOpenFileContextMenu?: (e: React.MouseEvent, target: FileContextMenuTarget) => void;
  onImportIntoFolder?: (folderRelativePath: string) => void;
  desktopSystemSupported?: boolean;
  dropHoveredFolder?: string | null;
  artifactsByFileId?: ReadonlyMap<string, ArtifactStateView> | null;
  agentDraftFileIds?: ReadonlySet<string> | null;
  onMoveFile?: (fileId: string, targetDir: string) => void;
  width?: number;
  realFolders?: readonly string[];
  pinnedFileIds?: readonly string[];
  onTogglePinFile?: (fileId: string) => void;
  onCreateFolder?: (parentDir: string, name: string) => Promise<string | null> | void;
  onCreateDocument?: (targetDir: string, name: string) => Promise<string | null> | void;
  onRenameFolder?: (folderPath: string, newName: string) => Promise<boolean> | void;
  onMoveFolder?: (folderPath: string, targetParentDir: string) => Promise<boolean> | void;
  onBatchMoveFiles?: (fileIds: string[]) => void;
  onBatchTrashFiles?: (fileIds: string[]) => void;
  mounts?: MountedWorkspaceDto[];
  mountedTrees?: Record<string, MountedTreeCacheEntry>;
  onExpandMount?: (mountId: string) => void;
  onOpenMountedFile?: (fileId: string, revisionId: string) => void;
  onOpenMountManager?: () => void;
  inlineActionSignal?: {
    seq: number;
    kind: 'create-folder' | 'create-doc' | 'rename-folder';
    folderPath: string;
  } | null;
  projects?: ProjectEntryDto[];
  activeProjectId?: string;
  expandedProjects?: ReadonlySet<string>;
  projectTrees?: Record<string, ProjectTreeCacheEntry>;
  globalPins?: GlobalPinnedFile[];
  onToggleGlobalPin?: (item: GlobalPinnedFile) => void;
  onOpenGlobalPin?: (item: GlobalPinnedFile) => void;
  onToggleProjectExpanded?: (projectId: string) => void;
  onActivateProject?: (projectId: string, opts?: { folder?: string; fileId?: string }) => void;
  onOpenAddProject?: () => void;
  onRenameProject?: (projectId: string, newName: string) => Promise<boolean> | void;
  onToggleProjectReadonly?: (projectId: string, nextReadonly: boolean) => Promise<boolean> | void;
  onRescanProject?: (projectId: string) => void;
  onRemoveProject?: (projectId: string) => void;
  onCreateFolderInProject?: (
    projectId: string,
    parentDir: string,
    name: string
  ) => Promise<string | null> | void;
  onCreateDocumentInProject?: (
    projectId: string,
    targetDir: string,
    name: string
  ) => Promise<string | null> | void;
}

const FILTER_ROW_BASE =
  'w-full flex items-center justify-between gap-1.5 px-2.5 py-1.5 rounded-[10px] border text-[length:var(--text-ui)] leading-[var(--lh-ui)] motion-safe:transition-all';
const FILTER_ROW_ACTIVE =
  'bg-[color:var(--chip-active-bg)] border-[color:var(--chip-active-border)] text-[color:var(--accent-iris-ink)] font-medium';
const FILTER_ROW_IDLE =
  'border-transparent text-[color:var(--ink-soft)] hover:bg-card/75 hover:text-[color:var(--ink-strong)]';
const ROW_COUNT =
  'font-mono text-[length:var(--text-micro)] leading-[var(--lh-micro)] tabular-nums text-[color:var(--ink-soft)] shrink-0';
const TREE_ROW_ACTIVE =
  'bg-card/95 border-transparent text-[color:var(--ink-strong)] font-semibold shadow-[0_2px_8px_-2px_rgba(38,36,61,0.10),0_0_0_1px_var(--glass-hairline)]';
const isSystemDirName = (name: string) => /^_/.test(name) || /^output/i.test(name);

const SMART_VIEW_ICONS: Record<SmartViewId, React.ComponentType<{ className?: string }>> = {
  updated_after_read: BookOpen,
  awaiting_decision: ListChecks,
  recent_active: Activity,
  agent_drafts: BotMessageSquare,
  unassigned: Inbox,
};


/** 智能视图胶囊单行占位高度（px）——11px 字 + py-1 上下各 4px + 2px 描边 ≈ 21px，行间隙 4px。 */
export const SMART_VIEW_ROW_H = 25;
/** 零值收折胶囊自身占位高度（px）——收折后仍占一行（胶囊位）。 */
export const SMART_VIEW_COLLAPSED_CAPSULE_H = 25;
/** 智能视图胶囊的估算宽度（px）——11px 中文字 + 图标 12 + 计数徽标 + 胶囊内距 16。 */
export const SMART_VIEW_PILL_W = 100;

export interface SmartViewPartition {
  visible: SmartViewDef[];
  collapsedZero: SmartViewDef[];
  collapsedLabel: string;
}

/**
 * 智能视图零值收纳分区（呈现层纯函数，零 DOM 依赖）：
 * - 计数 > 0 的视图恒必显（非 0 项必显）；
 * - 计数 = 0 的视图默认收折为末尾轻胶囊（0 项折叠）；
 * - 当前已选中的零值视图恒留在可见区（选中项不失踪，避免筛选态「空手而归」）。
 */
export function partitionSmartViewsByCount(
  counts: Readonly<Record<SmartViewId, number>>,
  activeId: QuickScope | null | undefined
): SmartViewPartition {
  const visible: SmartViewDef[] = [];
  const collapsedZero: SmartViewDef[] = [];
  for (const view of SMART_VIEWS) {
    const count = counts[view.id] ?? 0;
    const isActive = activeId === view.id;
    if (count > 0 || isActive) visible.push(view);
    else collapsedZero.push(view);
  }
  return {
    visible,
    collapsedZero,
    collapsedLabel:
      collapsedZero.length > 0 ? `其余 ${collapsedZero.length} 项 (0)` : '',
  };
}

/**
 * 零值收折为下方项目目录树腾出的有效可视高度（px，如实估算，不虚报）：
 * 收折前＝可见项 + 零值项按每行容量折行；收折后＝可见项 + 1 枚收折胶囊折行；
 * 净收益＝省下的行数 × 行高（SMART_VIEW_ROW_H）。
 *
 * 每行容量按侧栏可用宽度与胶囊估算宽度推得（默认 264px 侧栏 → 每行 2 枚）：
 * - 264px 宽 + 2 非零 + 3 零 → 省 1 行 ≈ 25px；
 * - 220px 窄栏（最小宽度）或 ≥4 项零值 → 省 2 行 ≈ 50px。
 */
export function estimateSmartViewCollapseGain(
  visibleCount: number,
  collapsedZeroCount: number,
  sidebarWidthPx: number = SIDEBAR_WIDTH_DEFAULT
): number {
  if (!Number.isFinite(collapsedZeroCount) || collapsedZeroCount <= 0) return 0;
  const content = Math.max(120, (Number.isFinite(sidebarWidthPx) ? sidebarWidthPx : SIDEBAR_WIDTH_DEFAULT) - 24);
  const itemsPerRow = Math.max(1, Math.floor((content + 4) / (SMART_VIEW_PILL_W + 4)));
  const rowsBefore = Math.ceil((visibleCount + collapsedZeroCount) / itemsPerRow);
  const rowsAfter = Math.ceil((visibleCount + 1) / itemsPerRow);
  return Math.max(0, rowsBefore - rowsAfter) * SMART_VIEW_ROW_H;
}

function parseActivityMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * 近 7 日活跃判定（与「近 7 天活跃」智能视图同一窗口口径）：
 * 服务端状态机 `last_activity_at` 落在 [now−7d, now] 窗口内。
 * 解析失败/缺失/越界一律不算（诚实为「否」）。
 */
export function isRecentActiveArtifact(
  artifact: ArtifactStateView | null | undefined,
  nowMs: number
): boolean {
  if (!artifact) return false;
  const activityMs = parseActivityMs(artifact.last_activity_at);
  if (activityMs === null) return false;
  return activityMs >= nowMs - RECENT_ACTIVE_WINDOW_MS && activityMs <= nowMs;
}

export interface FolderActivitySummary {
  directCount: number;
  unreadCount: number;
  active7dCount: number;
  directUnreadCount: number;
  directActive7dCount: number;
  subtreeAggregated?: boolean;
  isDense: boolean;
}

export interface FolderActivityInput {
  directFiles: readonly FileRecord[];
  readingStates: Readonly<Record<string, ReadingState>>;
  artifactsByFileId: ReadonlyMap<string, ArtifactStateView> | null;
  nowMs: number;
}

/** 单目录活跃摘要（直接子文件未读数 + 近 7 日活跃数 + 高密判定）。 */
export function summarizeFolderActivity(input: FolderActivityInput): FolderActivitySummary {
  let unreadCount = 0;
  let active7dCount = 0;
  for (const file of input.directFiles) {
    if (hasUnreadChanges(file, input.readingStates[file.file_id]).isUnread) unreadCount += 1;
    const artifact = input.artifactsByFileId?.get(file.file_id) ?? null;
    if (isRecentActiveArtifact(artifact, input.nowMs)) active7dCount += 1;
  }
  return {
    directCount: input.directFiles.length,
    unreadCount,
    active7dCount,
    directUnreadCount: unreadCount,
    directActive7dCount: active7dCount,
    isDense: input.directFiles.length >= SIDEBAR_DENSE_FOLDER_THRESHOLD,
  };
}

/**
 * 整棵目录树的活跃摘要索引（folder path → 摘要）：
 * 后序遍历一次、每个文件只判一次，目录行尾未读数与活跃微点按递归子树汇总（与 node.total
 * 口径严格一致，杜绝「父目录 152 份却只显示 2 未读、子目录未读数反而大于父目录」的矛盾）。
 */
export function collectFolderActivitySummaries(
  nodes: readonly FolderNode[],
  input: Omit<FolderActivityInput, 'directFiles'>
): Map<string, FolderActivitySummary> {
  const out = new Map<string, FolderActivitySummary>();
  const walk = (node: FolderNode): FolderActivitySummary => {
    const direct = summarizeFolderActivity({ ...input, directFiles: node.directFiles });
    let totalUnread = direct.directUnreadCount;
    let totalActive7d = direct.directActive7dCount;
    for (const child of node.children) {
      const childSummary = walk(child);
      totalUnread += childSummary.unreadCount;
      totalActive7d += childSummary.active7dCount;
    }
    const merged: FolderActivitySummary = {
      directCount: direct.directCount,
      unreadCount: totalUnread,
      active7dCount: totalActive7d,
      directUnreadCount: direct.directUnreadCount,
      directActive7dCount: direct.directActive7dCount,
      subtreeAggregated: true,
      isDense: direct.isDense,
    };
    out.set(node.path, merged);
    return merged;
  };
  for (const node of nodes) {
    walk(node);
  }
  return out;
}

/** 未读文件 id 集合（单一出口；与左栏顶部未读计数、智能视图同源）。 */
export function collectUnreadFileIds(
  files: readonly FileRecord[],
  readingStates: Readonly<Record<string, ReadingState>>
): Set<string> {
  const out = new Set<string>();
  for (const file of files) {
    if (hasUnreadChanges(file, readingStates[file.file_id]).isUnread) out.add(file.file_id);
  }
  return out;
}

interface FolderDragRowProps {
  onDragOver?: (event: React.DragEvent, folderPath: string) => void;
  onDragLeave?: (event: React.DragEvent, folderPath: string) => void;
  onDrop?: (event: React.DragEvent, folderPath: string) => void;
  dropTarget: boolean;
  dropFlash: boolean;
  dropBlocked: boolean;
}

const InlineCreateRow: React.FC<{
  kind: 'folder' | 'doc';
  depth: number;
  busy: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}> = ({ kind, depth, busy, onSubmit, onCancel }) => {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const commit = () => {
    const trimmed = value.trim();
    if (!trimmed) {
      onCancel();
      return;
    }
    onSubmit(trimmed);
  };

  return (
    <div
      data-inline-create-row={kind}
      className="flex items-center gap-1.5 px-2 py-1 rounded-[9px] bg-card border border-[color:var(--accent-iris-deep)] shadow-sm my-0.5"
    >
      {Array.from({ length: depth }).map((_, i) => (
        <span
          key={i}
          className="w-3 self-stretch shrink-0 border-l border-[color:var(--glass-hairline)]"
        />
      ))}
      {kind === 'folder' ? (
        <FolderPlus className="w-3.5 h-3.5 shrink-0 text-[color:var(--accent-iris-deep)]" />
      ) : (
        <FilePlus2 className="w-3.5 h-3.5 shrink-0 text-[color:var(--accent-iris-deep)]" />
      )}
      <input
        ref={inputRef}
        type="text"
        value={value}
        disabled={busy}
        aria-label={kind === 'folder' ? '新文件夹名' : '新文档名'}
        placeholder={kind === 'folder' ? '输入文件夹名，回车创建…' : '输入文档名（自动补 .md）…'}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        onBlur={() => {
          if (!busy) commit();
        }}
        className="flex-1 min-w-0 bg-transparent text-[length:var(--text-ui)] text-[color:var(--ink-strong)] focus-visible:outline-2 focus-visible:outline-[color:var(--ring)] rounded-[var(--r-ctl)]"
      />
    </div>
  );
};

const BatchCheckbox: React.FC<{ state: 'off' | 'partial' | 'on' }> = ({ state }) => (
  <span
    aria-hidden="true"
    data-batch-checkbox={state}
    className={`size-3.5 shrink-0 rounded-[4px] flex items-center justify-center border ${
      state === 'off'
        ? 'border-[color:var(--ink-faint)] bg-background/80'
        : 'border-[color:var(--accent-iris-deep)] bg-[color:var(--accent-iris-deep)] text-white'
    }`}
  >
    {state === 'on' && <Check className="w-2.5 h-2.5 stroke-[3]" />}
    {state === 'partial' && <span className="w-2 h-0.5 rounded bg-white" />}
  </span>
);

function HighlightedLabel({ text, query }: { text: string; query?: string }) {
  if (!query || !query.trim()) return <>{text}</>;
  const segments = splitQuickFilterHighlight(text, query);
  if (segments.length === 1 && !segments[0].hit) return <>{text}</>;
  return (
    <>
      {segments.map((seg, i) =>
        seg.hit ? (
          <mark
            key={i}
            data-quick-filter-hit=""
            className="rounded-[3px] bg-[color:color-mix(in_srgb,var(--accent-iris)_22%,transparent)] px-0.5 text-[color:var(--accent-iris-ink)]"
          >
            {seg.text}
          </mark>
        ) : (
          <React.Fragment key={i}>{seg.text}</React.Fragment>
        )
      )}
    </>
  );
}

const getSidebarFileKey = (file: FileRecord): string => file.file_id;
const siblingPrefixCache = new WeakMap<readonly FileRecord[], Map<string, number>>();
const mixedFormatCache = new WeakMap<readonly FileRecord[], boolean>();

function getCachedSiblingPrefixMap(files: readonly FileRecord[]): Map<string, number> | null {
  if (files.length <= 1) return null;
  let cached = siblingPrefixCache.get(files);
  if (!cached) {
    cached = computeSiblingSharedPrefixMap(files.map((f) => f.title));
    siblingPrefixCache.set(files, cached);
  }
  return cached;
}

function getCachedMixedFormats(files: readonly FileRecord[]): boolean {
  if (files.length <= 1) return false;
  let cached = mixedFormatCache.get(files);
  if (cached === undefined) {
    const first = files[0].format;
    cached = false;
    for (let i = 1; i < files.length; i += 1) {
      if (files[i].format !== first) {
        cached = true;
        break;
      }
    }
    mixedFormatCache.set(files, cached);
  }
  return cached;
}

const SidebarFileLeafImpl: React.FC<{
  file: FileRecord;
  depth: number;
  active: boolean;
  batchMode?: boolean;
  batchSelected?: boolean;
  onToggleBatchFile?: (fileId: string) => void;
  onSelectFile?: (fileId: string, revisionId?: string) => void;
  onOpenFileToRead: (fileId: string, sectionId?: string) => void;
  onQuickPreview?: (fileId: string, revisionId?: string) => void;
  onOpenContextMenu?: (e: React.MouseEvent, target: FileContextMenuTarget) => void;
  fileDragHandlers?: {
    onDragStart: (event: React.DragEvent) => void;
    onDragEnd: () => void;
  } | null;
  unread?: boolean;
  unreadReason?: UnreadReason;
  onMarkFileRead?: (fileId: string, revisionId: string) => void;
  onMarkFileUnread?: (fileId: string) => void;
  dense?: boolean;
  rowIdx?: number;
  sharedPrefixLen?: number;
  quickFilter?: string;
  previewHandle?: ReturnType<typeof PreviewCardCreateHandle<FileRecord>>;
  showFormat?: boolean;
}> = ({
  file,
  depth,
  active,
  batchMode = false,
  batchSelected = false,
  onToggleBatchFile,
  onSelectFile,
  onOpenFileToRead,
  onQuickPreview,
  onOpenContextMenu,
  fileDragHandlers,
  unread = false,
  unreadReason,
  onMarkFileRead,
  onMarkFileUnread,
  dense = false,
  rowIdx = 0,
  sharedPrefixLen = 0,
  quickFilter = '',
  previewHandle,
  showFormat = true,
}) => {
  const uiMeta = formatUiMeta(file.format);
  const displayTitle = formatMiddleEllipsisName(file.title, sharedPrefixLen, 22);
  const isUpdatedAfterRead = unread && unreadReason === 'updated_since_last_read';
  const unreadLabelText = unread
    ? isUpdatedAfterRead
      ? ' · 读后有更新'
      : ' · 未读'
    : ' · 已读最新';
  const canQuickToggleRead = !batchMode && (unread ? Boolean(onMarkFileRead) : Boolean(onMarkFileUnread));
  const rowEl = (
    <div
      role="button"
      tabIndex={0}
      data-sidebar-file={file.file_id}
      draggable={Boolean(fileDragHandlers) && !batchMode}
      onDragStart={batchMode ? undefined : fileDragHandlers?.onDragStart}
      onDragEnd={fileDragHandlers && !batchMode ? () => fileDragHandlers.onDragEnd() : undefined}
      onClick={() => {
        if (batchMode && onToggleBatchFile) {
          onToggleBatchFile(file.file_id);
          return;
        }
        if (onSelectFile) onSelectFile(file.file_id, file.current_revision_id);
        else onOpenFileToRead(file.file_id);
      }}
      onDoubleClick={() => {
        if (!batchMode) onOpenFileToRead(file.file_id);
      }}
      onKeyDown={(e) => {
        if (batchMode && (e.code === 'Space' || e.key === 'Enter') && onToggleBatchFile) {
          e.preventDefault();
          onToggleBatchFile(file.file_id);
          return;
        }
        if (e.code === 'Space' || e.key === ' ') {
          if (!onQuickPreview) return;
          e.preventDefault();
          e.stopPropagation();
          onQuickPreview(file.file_id, file.current_revision_id);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          onOpenFileToRead(file.file_id);
        }
      }}
      onContextMenu={(e) => {
        if (!onOpenContextMenu) return;
        e.preventDefault();
        e.stopPropagation();
        onOpenContextMenu(e, {
          kind: 'file',
          relativePath: file.relative_path,
          title: file.title,
          fileId: file.file_id,
          revisionId: file.current_revision_id,
        });
      }}
      title={`${file.relative_path} · ${uiMeta.label} · 单击打开（Space 轻预览）${unreadLabelText}`}
      className={`${FILTER_ROW_BASE} group/row glx-tree-row ${dense ? 'glx-tree-row-dense' : ''} cursor-pointer relative ${
        batchSelected
          ? FILTER_ROW_ACTIVE
          : active
            ? TREE_ROW_ACTIVE
            : FILTER_ROW_IDLE
      } ${dense ? '' : 'glx-tree-row-in'}`}
      style={
        dense
          ? undefined
          : ({ '--glx-tree-idx': Math.min(rowIdx, 12) } as React.CSSProperties)
      }
    >
      {Array.from({ length: depth }).map((_, i) => (
        <span
          key={i}
          className="w-2.5 self-stretch shrink-0 border-l border-[color:var(--glass-hairline)] group-hover/row:border-[color:var(--btn-secondary-border-hover)]"
        />
      ))}
      {batchMode && <BatchCheckbox state={batchSelected ? 'on' : 'off'} />}
      <span
        className={`flex-1 min-w-0 text-left truncate text-[12px] ${
          active || batchSelected
            ? ''
            : unread
              ? 'font-medium text-[color:var(--ink-strong)]'
              : 'text-[color:var(--ink-soft)]'
        }`}
        data-full-title={file.title}
      >
        <HighlightedLabel text={displayTitle} query={quickFilter} />
      </span>
      {!batchMode && unread && isUpdatedAfterRead && (
        <span
          aria-hidden="true"
          data-sidebar-unread-dot={file.file_id}
          title="读后有更新"
          className="glx-tree-unread-dot size-1.5 rounded-full shrink-0 bg-[color:var(--accent-wave)] glx-unread-updated-dot"
        />
      )}
      {canQuickToggleRead && (
        <button
          type="button"
          data-sidebar-toggle-read={file.file_id}
          aria-label={unread ? `标为已读 ${file.title}` : `标为未读 ${file.title}`}
          title={unread ? '标为已读' : '标为未读'}
          onClick={(e) => {
            e.stopPropagation();
            if (unread) {
              onMarkFileRead?.(file.file_id, file.current_revision_id);
            } else {
              onMarkFileUnread?.(file.file_id);
            }
          }}
          className={`hidden group-hover/row:flex w-5 h-5 rounded-[6px] items-center justify-center shrink-0 cursor-pointer transition-colors ${
            unread
              ? 'text-[color:var(--ink-soft)] hover:text-[color:var(--stage-ink-deliver-text)] dark:hover:text-[color:var(--success-foreground)] hover:bg-[color:color-mix(in_srgb,var(--status-green)_14%,transparent)]'
              : 'text-[color:var(--ink-soft)] hover:text-[color:var(--accent-wave)] hover:bg-[color:color-mix(in_srgb,var(--accent-wave)_12%,transparent)]'
          }`}
        >
          {unread ? <Check className="w-3.5 h-3.5" /> : <RotateCcw className="w-3 h-3" />}
        </button>
      )}
      {!batchMode && onOpenContextMenu && (
        <button
          type="button"
          aria-label={`更多操作 ${file.title}`}
          title="更多操作"
          onClick={(e) => {
            e.stopPropagation();
            onOpenContextMenu(e, {
              kind: 'file',
              relativePath: file.relative_path,
              title: file.title,
              fileId: file.file_id,
              revisionId: file.current_revision_id,
            });
          }}
          className="hidden group-hover/row:flex w-5 h-5 rounded-[6px] items-center justify-center text-[color:var(--ink-soft)] hover:bg-accent hover:text-[color:var(--ink-strong)] shrink-0 cursor-pointer"
        >
          <MoreHorizontal className="w-3.5 h-3.5" />
        </button>
      )}
      {showFormat && (
        <span
          className={`shrink-0 font-mono text-[9.5px] text-[color:var(--ink-soft)] group-hover/row:hidden ${
            file.format === 'md' ? 'opacity-30' : 'opacity-55'
          }`}
        >
          {uiMeta.label}
        </span>
      )}
    </div>
  );

  if (previewHandle && !batchMode) {
    return (
      <PreviewCardTrigger<FileRecord>
        handle={previewHandle}
        payload={file}
        delay={250}
        closeDelay={120}
        render={rowEl}
      />
    );
  }
  return rowEl;
};
const SidebarFileLeaf = React.memo(SidebarFileLeafImpl);

/** 目录树层级行渲染件（供单测直接渲染断言行尾未读/活跃微标）。 */
export const FolderTreeRows: React.FC<{
  nodes: FolderNode[];
  depth: number;
  selected: string | 'all';
  activeFileId: string;
  expanded: Set<string>;
  dropHoveredFolder?: string | null;
  batchMode?: boolean;
  batchSelectedIds?: ReadonlySet<string>;
  onToggleBatchFile?: (fileId: string) => void;
  onToggleBatchFolder?: (node: FolderNode) => void;
  onToggle: (path: string, opts?: { cascade?: 'open' | 'close' }) => void;
  onSelect: (path: string) => void;
  onSelectFile?: (fileId: string, revisionId?: string) => void;
  onOpenFileToRead: (fileId: string, sectionId?: string) => void;
  onQuickPreview?: (fileId: string, revisionId?: string) => void;
  onOpenContextMenu?: (e: React.MouseEvent, target: FileContextMenuTarget) => void;
  dragRowProps?: ((folderPath: string) => FolderDragRowProps) | null;
  folderDragHandlers?: {
    onDragStart: (event: React.DragEvent, folderPath: string) => void;
    onDragEnd: () => void;
  } | null;
  fileDragHandlers?: {
    onDragStart: (event: React.DragEvent) => void;
    onDragEnd: () => void;
  } | null;
  folderActivity?: ReadonlyMap<string, FolderActivitySummary>;
  unreadFileIds?: ReadonlySet<string>;
  unreadReasonByFileId?: ReadonlyMap<string, UnreadReason>;
  onMarkFileRead?: (fileId: string, revisionId: string) => void;
  onMarkFileUnread?: (fileId: string) => void;
  onMarkFolderRead?: (folderPath: string) => void;
  inlineCreate?: { parentDir: string; kind: 'folder' | 'doc' } | null;
  inlineCreateBusy?: boolean;
  onStartInlineCreate?: (parentDir: string, kind: 'folder' | 'doc') => void;
  onSubmitInlineCreate?: (name: string) => void;
  onCancelInlineCreate?: () => void;
  renamingFolderPath?: string | null;
  renameDraft?: string;
  renameBusy?: boolean;
  onStartRenameFolder?: (folderPath: string, currentName: string) => void;
  onRenameDraftChange?: (next: string) => void;
  onCommitRenameFolder?: () => void;
  onCancelRenameFolder?: () => void;
  mutedFolders?: readonly string[];
  quickFilter?: string;
  previewHandle?: ReturnType<typeof PreviewCardCreateHandle<FileRecord>>;
  emphasizeUnread?: boolean;
}> = ({
  nodes,
  depth,
  selected,
  activeFileId,
  expanded,
  dropHoveredFolder = null,
  batchMode = false,
  batchSelectedIds,
  onToggleBatchFile,
  onToggleBatchFolder,
  onToggle,
  onSelect,
  onSelectFile,
  onOpenFileToRead,
  onQuickPreview,
  onOpenContextMenu,
  dragRowProps = null,
  folderDragHandlers = null,
  fileDragHandlers = null,
  folderActivity,
  unreadFileIds,
  unreadReasonByFileId,
  onMarkFileRead,
  onMarkFileUnread,
  onMarkFolderRead,
  inlineCreate = null,
  inlineCreateBusy = false,
  onStartInlineCreate,
  onSubmitInlineCreate,
  onCancelInlineCreate,
  renamingFolderPath = null,
  renameDraft = '',
  renameBusy = false,
  onStartRenameFolder,
  onRenameDraftChange,
  onCommitRenameFolder,
  onCancelRenameFolder,
  mutedFolders = [],
  quickFilter = '',
  previewHandle,
  emphasizeUnread = false,
}) => (
  <>
    {nodes.map((node, nodeIdx) => {
      const isOpen = expanded.has(node.path);
      const active = selected === node.path;
      const isDropTarget = dropHoveredFolder === node.path;
      const hasChildren = node.children.length > 0;
      const hasExpandable = hasChildren || node.directFiles.length > 0;
      const isCreatingInside = inlineCreate?.parentDir === node.path;
      const isRenaming = renamingFolderPath === node.path;
      const drag = dragRowProps ? dragRowProps(node.path) : null;
      const isDenseFolder = node.directFiles.length >= SIDEBAR_DENSE_FOLDER_THRESHOLD;
      const folderMuted = isFolderMuted(node.path, mutedFolders);
      const siblingPrefixMap = isOpen ? getCachedSiblingPrefixMap(node.directFiles) : null;
      const folderHasMixedFormats = isOpen ? getCachedMixedFormats(node.directFiles) : false;
      const activity = folderActivity?.get(node.path);
      const treeDropTone =
        'bg-[color:var(--chip-active-bg)] border-[color:var(--accent-iris-deep)] text-[color:var(--accent-iris-ink)] font-medium ring-1 ring-[color:var(--accent-iris)]';
      const rowTone = drag?.dropFlash
        ? `${treeDropTone} shadow-[0_0_0_2px_color-mix(in_srgb,var(--accent-iris)_35%,transparent)]`
        : drag?.dropTarget || isDropTarget
          ? treeDropTone
          : active
            ? TREE_ROW_ACTIVE
            : FILTER_ROW_IDLE;
      const activityDetail =
        !node.isEmpty && activity
          ? `${activity.unreadCount > 0 ? ` · 未读 ${activity.unreadCount} 份` : ' · 全部已读'}${
              activity.active7dCount > 0 ? ` · 近 7 天活跃 ${activity.active7dCount} 份` : ''
            }`
          : '';
      const rowTitle = drag?.dropBlocked
        ? `${node.path || '（根目录）'}/ —— 已拦截：不可移入自身、当前父目录或子目录（防成环）`
        : node.isEmpty
          ? `${node.path}/ —— 空文件夹（双击可重命名，悬停可新建文档或子目录）`
          : `${node.path}/ —— 本级 ${node.direct} 份，含子级共 ${node.total} 份${activityDetail}`;

      let folderBatchState: 'off' | 'partial' | 'on' = 'off';
      if (batchMode && batchSelectedIds) {
        const subIds = collectSubtreeFileIds(node);
        if (subIds.length > 0) {
          const hitCount = subIds.filter((id) => batchSelectedIds.has(id)).length;
          if (hitCount === subIds.length) folderBatchState = 'on';
          else if (hitCount > 0) folderBatchState = 'partial';
        }
      }

      return (
        <React.Fragment key={node.path || '__root__'}>
          <div
            data-folder-active={active || undefined}
            data-folder-muted={folderMuted ? 'true' : undefined}
            data-drop-folder={node.path}
            data-empty-folder={node.isEmpty ? 'true' : undefined}
            draggable={Boolean(folderDragHandlers) && !batchMode && !isRenaming}
            onDragStart={
              folderDragHandlers && !batchMode && !isRenaming
                ? (e) => folderDragHandlers.onDragStart(e, node.path)
                : undefined
            }
            onDragEnd={
              folderDragHandlers && !batchMode && !isRenaming
                ? () => folderDragHandlers.onDragEnd()
                : undefined
            }
            onContextMenu={(e) => {
              if (!onOpenContextMenu) return;
              e.preventDefault();
              e.stopPropagation();
              onOpenContextMenu(e, {
                kind: 'folder',
                relativePath: node.path,
                title: node.path || '工作区根目录',
              });
            }}
            onDragOver={drag ? (e) => drag.onDragOver?.(e, node.path) : undefined}
            onDragLeave={drag ? (e) => drag.onDragLeave?.(e, node.path) : undefined}
            onDrop={drag ? (e) => drag.onDrop?.(e, node.path) : undefined}
            className={`${FILTER_ROW_BASE} group/row glx-tree-row cursor-pointer ${rowTone} ${folderMuted ? 'opacity-65 saturate-0' : ''} glx-tree-row-in`}
            style={{ '--glx-tree-idx': Math.min(nodeIdx, 12) } as React.CSSProperties}
            title={rowTitle}
          >
            {Array.from({ length: depth }).map((_, i) => (
              <span
                key={i}
                className="w-2.5 self-stretch shrink-0 border-l border-[color:var(--glass-hairline)] group-hover/row:border-[color:var(--btn-secondary-border-hover)]"
              />
            ))}
            {batchMode && onToggleBatchFolder ? (
              <button
                type="button"
                aria-label={`勾选文件夹 ${node.name} 下全部文件`}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleBatchFolder(node);
                }}
                className="w-4 h-4 shrink-0 flex items-center justify-center cursor-pointer"
              >
                <BatchCheckbox state={folderBatchState} />
              </button>
            ) : hasExpandable || isCreatingInside ? (
              <button
                type="button"
                aria-label={`${isOpen ? '收起' : '展开'} ${node.name}`}
                title={`${isOpen ? '收起' : '展开'} ${node.name}（按住 Alt 点击＝级联${isOpen ? '收起' : '展开'}整棵子树）`}
                className="w-4 h-4 shrink-0 flex items-center justify-center rounded-[var(--r-ctl)] cursor-pointer hover:text-[color:var(--ink-strong)] text-[color:var(--ink-faint)]"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(
                    node.path,
                    e.altKey ? { cascade: isOpen ? 'close' : 'open' } : undefined
                  );
                }}
              >
                <ChevronRight
                  className="w-3 h-3 glx-chevron-rot"
                  data-open={isOpen || isCreatingInside ? 'true' : 'false'}
                />
              </button>
            ) : (
              <span className="w-4 shrink-0" />
            )}
            {isOpen && hasExpandable ? (
              <FolderOpen className="w-3.5 h-3.5 shrink-0 text-[color:var(--ink-faint)]" />
            ) : (
              <Folder className="w-3.5 h-3.5 shrink-0 text-[color:var(--ink-faint)]" />
            )}
            {isRenaming ? (
              <input
                type="text"
                autoFocus
                disabled={renameBusy}
                aria-label={`重命名文件夹 ${node.name}`}
                value={renameDraft}
                onChange={(e) => onRenameDraftChange?.(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    onCommitRenameFolder?.();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    onCancelRenameFolder?.();
                  }
                }}
                onBlur={() => {
                  if (!renameBusy) onCommitRenameFolder?.();
                }}
                className="flex-1 min-w-0 bg-background rounded px-1 py-0.5 text-[12px] text-[color:var(--ink-strong)] border border-[color:var(--accent-iris-deep)] focus:outline-none"
              />
            ) : (
              <button
                type="button"
                className="flex-1 min-w-0 text-left truncate cursor-pointer"
                title={`点击进入目录 ${node.path}/（双击重命名）`}
                onClick={() => {
                  if (hasExpandable && !isOpen) onToggle(node.path);
                  onSelect(active ? 'all' : node.path);
                }}
                onDoubleClick={(e) => {
                  if (batchMode || !onStartRenameFolder) return;
                  e.stopPropagation();
                  onStartRenameFolder(node.path, node.name);
                }}
              >
                <HighlightedLabel text={node.name} query={quickFilter} />
              </button>
            )}
            {!isRenaming && !batchMode && (
              <span className="hidden group-hover/row:flex items-center gap-0.5 shrink-0">
                {!node.isEmpty && activity && activity.unreadCount > 0 && onMarkFolderRead && (
                  <button
                    type="button"
                    data-folder-mark-read={node.path}
                    aria-label={`将 ${node.name} 全部标为已读`}
                    title={`本目录全部标为已读（${activity.unreadCount} 份）`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onMarkFolderRead(node.path);
                    }}
                    className="w-5 h-5 rounded-[6px] flex items-center justify-center text-[color:var(--ink-soft)] hover:text-[color:var(--stage-ink-deliver-text)] dark:hover:text-[color:var(--success-foreground)] hover:bg-[color:color-mix(in_srgb,var(--status-green)_14%,transparent)] cursor-pointer transition-colors"
                  >
                    <CheckCheck className="w-3.5 h-3.5" />
                  </button>
                )}
                {onOpenContextMenu && (
                  <button
                    type="button"
                    aria-label={`目录菜单 ${node.name}`}
                    title="更多操作"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenContextMenu(e, {
                        kind: 'folder',
                        relativePath: node.path,
                        title: node.path,
                      });
                    }}
                    className="w-5 h-5 rounded-[6px] flex items-center justify-center text-[color:var(--ink-soft)] hover:bg-accent hover:text-[color:var(--ink-strong)] cursor-pointer"
                  >
                    <MoreHorizontal className="w-3.5 h-3.5" />
                  </button>
                )}
                {onStartInlineCreate && (
                  <>
                    <button
                      type="button"
                      aria-label={`在 ${node.name} 内新建子文件夹`}
                      title="新建子文件夹"
                      onClick={(e) => {
                        e.stopPropagation();
                        onStartInlineCreate(node.path, 'folder');
                      }}
                      className="w-5 h-5 rounded-[6px] flex items-center justify-center text-[color:var(--ink-soft)] hover:bg-accent hover:text-[color:var(--ink-strong)] cursor-pointer"
                    >
                      <FolderPlus className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={`在 ${node.name} 内新建文档`}
                      title="新建文档"
                      onClick={(e) => {
                        e.stopPropagation();
                        onStartInlineCreate(node.path, 'doc');
                      }}
                      className="w-5 h-5 rounded-[6px] flex items-center justify-center text-[color:var(--ink-soft)] hover:bg-accent hover:text-[color:var(--ink-strong)] cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </>
                )}
              </span>
            )}
            {!isRenaming && (
              <span
                className={`${ROW_COUNT} ${!batchMode ? 'group-hover/row:hidden' : ''} flex items-center gap-1`}
              >
                {folderMuted && (
                  <Badge
                    variant="secondary"
                    size="sm"
                    title="该目录已在星图、日历与列表时间线中静默（点击仍可随时阅读）"
                    className="px-1 h-4 text-[9px] font-normal text-[color:var(--ink-soft)]"
                  >
                    已静默
                  </Badge>
                )}
                {node.isEmpty ? (
                  '空'
                ) : emphasizeUnread && activity && activity.unreadCount > 0 ? (
                  <span
                    data-folder-unread={activity.unreadCount}
                    title={`未读 ${activity.unreadCount} 份 / 共 ${node.total} 份`}
                    className="font-mono text-[10.5px] tabular-nums text-[color:var(--accent-wave)]"
                  >
                    {activity.unreadCount}
                  </span>
                ) : node.total > 0 ? (
                  <span>{node.total}</span>
                ) : null}
              </span>
            )}
          </div>
          {(isOpen || isCreatingInside) && (
            <>
              {isCreatingInside && inlineCreate && onSubmitInlineCreate && onCancelInlineCreate && (
                <InlineCreateRow
                  kind={inlineCreate.kind}
                  depth={depth + 1}
                  busy={inlineCreateBusy}
                  onSubmit={onSubmitInlineCreate}
                  onCancel={onCancelInlineCreate}
                />
              )}
              {hasExpandable && isOpen && (
                <>
                  <FolderTreeRows
                    nodes={node.children}
                    depth={depth + 1}
                    selected={selected}
                    activeFileId={activeFileId}
                    expanded={expanded}
                    dropHoveredFolder={dropHoveredFolder}
                    batchMode={batchMode}
                    batchSelectedIds={batchSelectedIds}
                    onToggleBatchFile={onToggleBatchFile}
                    onToggleBatchFolder={onToggleBatchFolder}
                    onToggle={onToggle}
                    onSelect={onSelect}
                    onSelectFile={onSelectFile}
                    onOpenFileToRead={onOpenFileToRead}
                    onQuickPreview={onQuickPreview}
                    onOpenContextMenu={onOpenContextMenu}
                    dragRowProps={dragRowProps}
                    folderDragHandlers={folderDragHandlers}
                    fileDragHandlers={fileDragHandlers}
                    folderActivity={folderActivity}
                    unreadFileIds={unreadFileIds}
                    unreadReasonByFileId={unreadReasonByFileId}
                    onMarkFileRead={onMarkFileRead}
                    onMarkFileUnread={onMarkFileUnread}
                    onMarkFolderRead={onMarkFolderRead}
                    inlineCreate={inlineCreate}
                    inlineCreateBusy={inlineCreateBusy}
                    onStartInlineCreate={onStartInlineCreate}
                    onSubmitInlineCreate={onSubmitInlineCreate}
                    onCancelInlineCreate={onCancelInlineCreate}
                    renamingFolderPath={renamingFolderPath}
                    renameDraft={renameDraft}
                    renameBusy={renameBusy}
                    onStartRenameFolder={onStartRenameFolder}
                    onRenameDraftChange={onRenameDraftChange}
                    onCommitRenameFolder={onCommitRenameFolder}
                    onCancelRenameFolder={onCancelRenameFolder}
                    mutedFolders={mutedFolders}
                    quickFilter={quickFilter}
                    previewHandle={previewHandle}
                    emphasizeUnread={emphasizeUnread}
                  />
                  <VirtualFileSlice
                    items={node.directFiles}
                    getKey={getSidebarFileKey}
                    activeKey={activeFileId}
                    renderItem={(file, fileIdx) => (
                      <SidebarFileLeaf
                        showFormat={folderHasMixedFormats}
                        file={file}
                        depth={depth + 1}
                        active={file.file_id === activeFileId}
                        batchMode={batchMode}
                        batchSelected={batchSelectedIds?.has(file.file_id) ?? false}
                        onToggleBatchFile={onToggleBatchFile}
                        onSelectFile={onSelectFile}
                        onOpenFileToRead={onOpenFileToRead}
                        onQuickPreview={onQuickPreview}
                        onOpenContextMenu={onOpenContextMenu}
                        fileDragHandlers={fileDragHandlers}
                        unread={unreadFileIds?.has(file.file_id) ?? false}
                        unreadReason={unreadReasonByFileId?.get(file.file_id)}
                        onMarkFileRead={onMarkFileRead}
                        onMarkFileUnread={onMarkFileUnread}
                        dense={isDenseFolder}
                        rowIdx={fileIdx}
                        sharedPrefixLen={siblingPrefixMap?.get(file.title) ?? 0}
                        quickFilter={quickFilter}
                        previewHandle={previewHandle}
                      />
                    )}
                  />
                </>
              )}
            </>
          )}
        </React.Fragment>
      );
    })}
  </>
);

export interface FilterDropdownProps {
  files: FileRecord[];
  filters: SidebarFilters;
  onChange: (next: Partial<SidebarFilters>) => void;
  onReset: () => void;
  facets?: FileFacets | null;
}

const SECTION_LABEL =
  'text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-medium tracking-[0.2em] text-[color:var(--ink-soft)] flex items-center gap-1.5';

export const FilterDropdown: React.FC<FilterDropdownProps> = ({
  files,
  filters,
  onChange,
  onReset,
  facets,
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleDocMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', handleDocMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleDocMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const roles = useMemo(
    () => (open ? Array.from(new Set(files.map((f) => f.role))) : []),
    [files, open]
  );
  const topics = useMemo(
    () => (open ? Array.from(new Set(files.flatMap((f) => f.topics.map((t) => t.name)))) : []),
    [files, open]
  );

  const activeFilterCount =
    (filters.format !== 'all' ? 1 : 0) +
    (filters.role !== 'all' ? 1 : 0) +
    (filters.topic !== 'all' ? 1 : 0);

  return (
    <div ref={rootRef} className="relative">
      <Button
        variant={activeFilterCount > 0 ? 'secondary' : 'ghost'}
        size="sm"
        onClick={() => setOpen((v) => !v)}
        title="按文件格式 / 内容角色 / 主题筛选"
        className="cursor-pointer !h-7 !px-2 !gap-1"
      >
        <Filter className="w-3.5 h-3.5" />
        <span>筛选</span>
        {activeFilterCount > 0 && (
          <span className="font-mono text-[length:var(--text-micro)] leading-[var(--lh-micro)] tabular-nums text-[color:var(--accent-iris-deep)]">
            {activeFilterCount}
          </span>
        )}
      </Button>

      {open && (
        <div
          data-esc-layer="open"
          className="glass-pop absolute right-0 top-full mt-1.5 w-[300px] rounded-[var(--r-card)] z-50 p-3 space-y-3"
        >
          <div className="space-y-1.5">
            <div
              className={SECTION_LABEL}
              title="格式计数取自当前文件扫描快照（含所有已纳管格式）"
            >
              <FileCode className="w-3.5 h-3.5 text-[color:var(--ink-faint)]" />
              <span>文件格式</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {(() => {
                const mergedCounts = new Map<string, number>();
                if (facets?.formats) {
                  for (const [k, v] of Object.entries(facets.formats)) {
                    if (typeof v === 'number' && v >= 0) mergedCounts.set(k, v);
                  }
                } else {
                  for (const f of files) {
                    mergedCounts.set(f.format, (mergedCounts.get(f.format) ?? 0) + 1);
                  }
                }
                for (const pinned of ['md', 'svg', 'pdf']) {
                  if (!mergedCounts.has(pinned)) mergedCounts.set(pinned, 0);
                }
                if (filters.format !== 'all' && !mergedCounts.has(filters.format)) {
                  mergedCounts.set(filters.format, 0);
                }
                const pinnedOrder = new Map<string, number>([
                  ['md', 0],
                  ['svg', 1],
                  ['pdf', 2],
                ]);
                const ordered = Array.from(mergedCounts.entries()).sort((a, b) => {
                  const pa = pinnedOrder.get(a[0]);
                  const pb = pinnedOrder.get(b[0]);
                  if (pa !== undefined && pb !== undefined) return pa - pb;
                  if (pa !== undefined) return -1;
                  if (pb !== undefined) return 1;
                  if (b[1] !== a[1]) return b[1] - a[1];
                  return a[0].localeCompare(b[0]);
                });
                return ordered.map(([fmtId, total]) => {
                  const active = filters.format === fmtId;
                  const ui = formatUiMeta(fmtId);
                  return (
                    <Chip
                      key={fmtId}
                      dot
                      dotColor={ui.dotColor}
                      active={active}
                      count={total}
                      onClick={() => onChange({ format: active ? 'all' : fmtId })}
                      className="min-w-[calc(33.333%-0.2rem)] flex-1 justify-center cursor-pointer"
                    >
                      <span>{ui.label}</span>
                    </Chip>
                  );
                });
              })()}
            </div>
          </div>

          {roles.length > 0 && (
            <div className="space-y-1.5">
              <div
                className={SECTION_LABEL}
                title="内容角色由服务端规则识别，可追溯"
              >
                <Layers className="w-3.5 h-3.5 text-[color:var(--ink-faint)]" />
                <span>内容角色</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {roles.map((role) => {
                  const active = filters.role === role;
                  return (
                    <Chip
                      key={role}
                      active={active}
                      onClick={() => onChange({ role: active ? 'all' : role })}
                      className="cursor-pointer"
                    >
                      {role}
                    </Chip>
                  );
                })}
              </div>
            </div>
          )}

          {topics.length > 0 && (
            <div className="space-y-1.5">
              <div className={SECTION_LABEL}>
                <Tag className="w-3.5 h-3.5 text-[color:var(--ink-faint)]" />
                <span>主题与专项</span>
              </div>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {topics.map((topic) => {
                  const active = filters.topic === topic;
                  const matchingFiles = files.filter((f) =>
                    f.topics.some((t) => t.name === topic)
                  );
                  const sampleProvenance =
                    matchingFiles[0]?.topics.find((t) => t.name === topic)?.provenance ||
                    '来自路径';
                  return (
                    <button
                      key={topic}
                      type="button"
                      onClick={() => onChange({ topic: active ? 'all' : topic })}
                      title={`${sampleProvenance} · ${matchingFiles.length} 份匹配`}
                      className={`${FILTER_ROW_BASE} cursor-pointer ${active ? FILTER_ROW_ACTIVE : FILTER_ROW_IDLE}`}
                    >
                      <span className="truncate">{topic}</span>
                      <span className={ROW_COUNT}>{matchingFiles.length}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="pt-2 border-t border-[color:var(--glass-hairline)] quiet-sep quiet-row">
            <Button
              variant="ghost"
              size="sm"
              fullWidth
              onClick={() => {
                onReset();
                setOpen(false);
              }}
              className="cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              <span>重置筛选</span>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export const LeftSidebar: React.FC<LeftSidebarProps> = ({
  files,
  dataSource = 'real',
  retryingConnection = false,
  onRetryConnection,
  readingStates,
  totalCount,
  activeFileId,
  filters,
  onUpdateFilters,
  onResetFilters,
  onOpenFileToRead,
  onMarkReadingBaseline,
  onMarkFileRead,
  onMarkFileUnread,
  onMarkFolderUnread: _onMarkFolderUnread,
  mutedFolders = [],
  onToggleMuteFolder,
  onUnmuteFolder,
  onClearMutedFolders,
  onSelectFile,
  onQuickPreview,
  onOpenFileContextMenu,
  onImportIntoFolder,
  desktopSystemSupported = false,
  dropHoveredFolder = null,
  artifactsByFileId = null,
  agentDraftFileIds = null,
  onMoveFile,
  width,
  realFolders = [],
  pinnedFileIds = [],
  onTogglePinFile,
  onCreateFolder,
  onCreateDocument,
  onRenameFolder,
  onMoveFolder,
  onBatchMoveFiles,
  onBatchTrashFiles,
  mounts = [],
  mountedTrees = {},
  onExpandMount,
  onOpenMountedFile,
  onOpenMountManager,
  inlineActionSignal = null,
  projects = [],
  activeProjectId = '',
  expandedProjects,
  projectTrees = {},
  globalPins = [],
  onToggleGlobalPin,
  onOpenGlobalPin,
  onToggleProjectExpanded,
  onActivateProject,
  onOpenAddProject,
  onRenameProject,
  onToggleProjectReadonly,
  onRescanProject,
  onRemoveProject,
  onCreateFolderInProject,
  onCreateDocumentInProject,
}) => {
  const [baselineConfirmOpen, setBaselineConfirmOpen] = useState(false);
  const [baselineBusy, setBaselineBusy] = useState(false);

  const fileById = useMemo(() => new Map(files.map((f) => [f.file_id, f])), [files]);

  const continueReadingFiles = useMemo(
    () =>
      files
        .filter((f) => {
          const st = readingStates[f.file_id];
          if (!st) return false;
          const unreadInfo = hasUnreadChanges(f, st);
          if (!unreadInfo.isUnread) return false;
          const updatedSinceBaseline = unreadInfo.reason === 'updated_since_last_read';
          if (st.baselineOnly && !updatedSinceBaseline && st.scrollPercent <= 0 && !st.last_section_id) {
            return false;
          }
          const hasRealProgress =
            st.scrollPercent > 0 ||
            Boolean(st.last_section_id) ||
            updatedSinceBaseline;
          return hasRealProgress;
        })
        .sort(
          (a, b) =>
            readingRecency(readingStates[b.file_id]) - readingRecency(readingStates[a.file_id])
        )
        .slice(0, 2),
    [files, readingStates]
  );

  const pinnedFiles = useMemo(() => {
    if (!pinnedFileIds.length) return [];
    const out: FileRecord[] = [];
    for (const id of pinnedFileIds) {
      const hit = fileById.get(id);
      if (hit) out.push(hit);
    }
    return out;
  }, [fileById, pinnedFileIds]);

  const { unreadFileIds, unreadReasonByFileId } = useMemo(() => {
    const ids = new Set<string>();
    const reasonMap = new Map<string, UnreadReason>();
    for (const file of files) {
      const info = hasUnreadChanges(file, readingStates[file.file_id]);
      if (info.isUnread) ids.add(file.file_id);
      reasonMap.set(file.file_id, info.reason);
    }
    return { unreadFileIds: ids, unreadReasonByFileId: reasonMap };
  }, [files, readingStates]);
  const unreadCount = unreadFileIds.size;
  const totalWorkspaceFiles = files.length;
  const readWorkspaceCount = Math.max(0, totalWorkspaceFiles - unreadCount);
  const readProgressRatio =
    totalWorkspaceFiles > 0 ? readWorkspaceCount / totalWorkspaceFiles : 0;
  const readProgressPct = totalWorkspaceFiles > 0 ? Math.round(readProgressRatio * 100) : 0;
  const handleMarkFolderReadQuick = onMarkReadingBaseline
    ? (folderPath: string) => {
        void onMarkReadingBaseline('folder', folderPath);
      }
    : undefined;
  const { businessUnreadCount, systemUnreadCount } = useMemo(() => {
    let business = 0;
    for (const f of files) {
      if (!unreadFileIds.has(f.file_id)) continue;
      const top = f.folder === '.' ? '' : f.folder.replace(/\\/g, '/').split('/')[0];
      if (top === '' || !isSystemDirName(top)) business += 1;
    }
    return { businessUnreadCount: business, systemUnreadCount: unreadCount - business };
  }, [files, unreadCount, unreadFileIds]);
  const bookmarkedCount = useMemo(() => {
    let count = 0;
    for (const f of files) {
      if (readingStates[f.file_id]?.bookmarked) count += 1;
    }
    return count;
  }, [files, readingStates]);

  const nowMs = useMemo(() => Date.now(), [files]);
  const sidebarFiltersActive =
    filters.quickScope !== 'all' ||
    filters.folder !== 'all' ||
    filters.format !== 'all' ||
    filters.role !== 'all' ||
    filters.topic !== 'all';
  const smartViewFiles = useMemo(
    () =>
      computeSmartViewFiles({
        files,
        readingStates,
        artifactsByFileId,
        agentDraftFileIds,
        nowMs,
      }),
    [agentDraftFileIds, artifactsByFileId, files, nowMs, readingStates]
  );
  const smartViewCounts = useMemo(() => computeSmartViewCounts(smartViewFiles), [smartViewFiles]);
  const [smartViewsOpen, setSmartViewsOpen] = useState(false);
  const [continueReadingOpen, setContinueReadingOpen] = useState(false);
  const smartViewPartition = useMemo(
    () => partitionSmartViewsByCount(smartViewCounts, filters.quickScope),
    [filters.quickScope, smartViewCounts]
  );
  const isSmartViewActive = isSmartViewScope(filters.quickScope);
  const showSmartViewsBody = smartViewsOpen || isSmartViewActive;

  const treeScopeFiles = useMemo(() => {
    if (filters.quickScope === 'all') return files;
    if (filters.quickScope === 'unread') {
      return files.filter((f) => unreadFileIds.has(f.file_id));
    }
    if (filters.quickScope === 'bookmarked') {
      return files.filter((f) => Boolean(readingStates[f.file_id]?.bookmarked));
    }
    if (isSmartViewScope(filters.quickScope)) {
      return smartViewFiles[filters.quickScope] ?? [];
    }
    return files;
  }, [files, filters.quickScope, readingStates, smartViewFiles, unreadFileIds]);

  const { nodes: folderTree, rootFiles } = useMemo(
    () =>
      buildMergedFolderTree(
        treeScopeFiles,
        filters.quickScope === 'all' ? realFolders : []
      ),
    [treeScopeFiles, filters.quickScope, realFolders]
  );
  const { businessNodes, systemNodes } = useMemo(() => {
    const business = folderTree.filter((n) => !isSystemDirName(n.name));
    const system = folderTree.filter((n) => isSystemDirName(n.name));
    return { businessNodes: business, systemNodes: system };
  }, [folderTree]);
  const folderActivity = useMemo(
    () =>
      collectFolderActivitySummaries(folderTree, {
        readingStates,
        artifactsByFileId,
        nowMs,
      }),
    [artifactsByFileId, folderTree, nowMs, readingStates]
  );
  const selectedFolderUnreadCount = useMemo(() => {
    if (filters.folder === 'all') return 0;
    const normalized = filters.folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!normalized) return 0;
    if (filters.quickScope === 'all') {
      return folderActivity.get(normalized)?.unreadCount ?? 0;
    }
    const prefix = `${normalized}/`;
    let count = 0;
    for (const f of files) {
      const p = f.relative_path.replace(/\\/g, '/');
      if ((p === normalized || p.startsWith(prefix)) && unreadFileIds.has(f.file_id)) {
        count += 1;
      }
    }
    return count;
  }, [files, filters.folder, filters.quickScope, folderActivity, unreadFileIds]);
  const [systemGroupOpen, setSystemGroupOpen] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [treeQuickFilter, setTreeQuickFilter] = useState('');
  const [treeSortMode, setTreeSortMode] = useState<SidebarTreeSortMode>('name');
  const emphasizeFolderUnread = filters.quickScope === 'unread' || treeSortMode === 'unread';
  const nextTreeSortMode: SidebarTreeSortMode =
    treeSortMode === 'name' ? 'active7d' : treeSortMode === 'active7d' ? 'unread' : 'name';
  const treeSortLabel =
    treeSortMode === 'name' ? '名称' : treeSortMode === 'active7d' ? '活跃' : '未读';
  const sidebarPreviewHandle = useMemo(() => PreviewCardCreateHandle<FileRecord>(), []);

  const sortedBusinessNodes = useMemo(
    () => sortFolderTreeNodes(businessNodes, treeSortMode, folderActivity),
    [businessNodes, treeSortMode, folderActivity]
  );
  const sortedSystemNodes = useMemo(
    () => sortFolderTreeNodes(systemNodes, treeSortMode, folderActivity),
    [systemNodes, treeSortMode, folderActivity]
  );
  const filteredBusiness = useMemo(
    () => filterFolderTreeByQuery(sortedBusinessNodes, rootFiles, treeQuickFilter),
    [sortedBusinessNodes, rootFiles, treeQuickFilter]
  );
  const filteredSystem = useMemo(
    () => filterFolderTreeByQuery(sortedSystemNodes, [], treeQuickFilter),
    [sortedSystemNodes, treeQuickFilter]
  );
  const effectiveExpandedFolders = useMemo(() => {
    if (!treeQuickFilter.trim()) return expandedFolders;
    const merged = new Set(expandedFolders);
    for (const p of filteredBusiness.autoExpandedPaths) merged.add(p);
    for (const p of filteredSystem.autoExpandedPaths) merged.add(p);
    return merged;
  }, [expandedFolders, filteredBusiness.autoExpandedPaths, filteredSystem.autoExpandedPaths, treeQuickFilter]);
  const displayBusinessNodes = filteredBusiness.nodes;
  const displayRootFiles = filteredBusiness.rootFiles;
  const displaySystemNodes = filteredSystem.nodes;
  const quickFilterActive = treeQuickFilter.trim().length > 0;
  const displayFolderActivity = useMemo(
    () =>
      quickFilterActive
        ? collectFolderActivitySummaries([...displayBusinessNodes, ...displaySystemNodes], {
            readingStates,
            artifactsByFileId,
            nowMs,
          })
        : folderActivity,
    [
      artifactsByFileId,
      displayBusinessNodes,
      displaySystemNodes,
      folderActivity,
      nowMs,
      quickFilterActive,
      readingStates,
    ]
  );
  const displaySystemTotal = displaySystemNodes.reduce((sum, n) => sum + n.total, 0);
  const displaySystemUnread = displaySystemNodes.reduce(
    (sum, n) => sum + (displayFolderActivity.get(n.path)?.unreadCount ?? 0),
    0
  );
  const emptyTreeLabel = quickFilterActive
    ? `未找到匹配「${treeQuickFilter.trim()}」的目录或文件`
    : filters.quickScope === 'unread'
      ? '当前全部文档已读（切换「全部」浏览完整目录）'
      : filters.quickScope === 'bookmarked'
        ? '暂无收藏文档'
        : isSmartViewScope(filters.quickScope)
          ? '当前智能视图暂无匹配文档'
          : '当前项目暂无目录或文件';

  const findFolderNode = (nodes: FolderNode[], targetPath: string): FolderNode | null => {
    for (const n of nodes) {
      if (n.path === targetPath) return n;
      const found = findFolderNode(n.children, targetPath);
      if (found) return found;
    }
    return null;
  };

  const toggleFolder = (path: string, opts?: { cascade?: 'open' | 'close' }) => {
    if (!opts?.cascade) {
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      return;
    }
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      const owner = findFolderNode(folderTree, path);
      const subtree = owner ? collectSubtreePaths(owner) : [path];
      for (const p of subtree) {
        if (opts.cascade === 'open') next.add(p);
        else next.delete(p);
      }
      return next;
    });
  };
  const selectFolder = (path: string) => onUpdateFilters({ folder: path });

  const [inlineCreate, setInlineCreate] = useState<{
    parentDir: string;
    kind: 'folder' | 'doc';
  } | null>(null);
  const [inlineCreateBusy, setInlineCreateBusy] = useState(false);
  const [renamingFolderPath, setRenamingFolderPath] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);

  const [projectMenuId, setProjectMenuId] = useState<string | null>(null);
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [projectRenameDraft, setProjectRenameDraft] = useState('');
  const [projectRenameBusy, setProjectRenameBusy] = useState(false);
  const [projectInlineCreate, setProjectInlineCreate] = useState<{
    projectId: string;
    parentDir: string;
    kind: 'folder' | 'doc';
  } | null>(null);
  const [projectInlineCreateBusy, setProjectInlineCreateBusy] = useState(false);

  useEffect(() => {
    if (!projectMenuId) return;
    const onPointerDown = () => setProjectMenuId(null);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setProjectMenuId(null);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [projectMenuId]);

  const globalPinnedKeys = useMemo(
    () => new Set(globalPins.map((p) => `${p.projectId}:${p.fileId}`)),
    [globalPins]
  );

  const mergedPinnedItems = useMemo(() => {
    const out: Array<
      | { kind: 'global'; pin: GlobalPinnedFile }
      | { kind: 'local'; file: FileRecord }
    > = [];
    const seenActiveIds = new Set<string>();
    for (const pin of globalPins) {
      out.push({ kind: 'global', pin });
      if (!activeProjectId || pin.projectId === activeProjectId) {
        seenActiveIds.add(pin.fileId);
      }
    }
    for (const f of pinnedFiles) {
      if (!seenActiveIds.has(f.file_id)) {
        out.push({ kind: 'local', file: f });
      }
    }
    return out;
  }, [activeProjectId, globalPins, pinnedFiles]);

  const handleSubmitProjectInlineCreate = async (name: string) => {
    if (!projectInlineCreate || projectInlineCreateBusy) return;
    setProjectInlineCreateBusy(true);
    try {
      if (projectInlineCreate.kind === 'folder' && onCreateFolderInProject) {
        await onCreateFolderInProject(
          projectInlineCreate.projectId,
          projectInlineCreate.parentDir,
          name
        );
      } else if (projectInlineCreate.kind === 'doc' && onCreateDocumentInProject) {
        await onCreateDocumentInProject(
          projectInlineCreate.projectId,
          projectInlineCreate.parentDir,
          name
        );
      }
    } finally {
      setProjectInlineCreateBusy(false);
      setProjectInlineCreate(null);
    }
  };

  const handleCommitProjectRename = async () => {
    if (!renamingProjectId || projectRenameBusy || !onRenameProject) {
      setRenamingProjectId(null);
      return;
    }
    const trimmed = projectRenameDraft.trim();
    if (!trimmed) {
      setRenamingProjectId(null);
      return;
    }
    setProjectRenameBusy(true);
    try {
      await onRenameProject(renamingProjectId, trimmed);
    } finally {
      setProjectRenameBusy(false);
      setRenamingProjectId(null);
    }
  };

  const expandAncestors = (folderPath: string) => {
    const segments = folderPath.split('/').filter(Boolean);
    if (segments.length === 0) return;
    if (segments[0] && isSystemDirName(segments[0])) {
      setSystemGroupOpen(true);
    }
    setExpandedFolders((prev) => {
      let allPresent = true;
      let acc = '';
      for (const seg of segments) {
        acc = acc ? `${acc}/${seg}` : seg;
        if (!prev.has(acc)) {
          allPresent = false;
          break;
        }
      }
      if (allPresent) return prev;
      const next = new Set(prev);
      acc = '';
      for (const seg of segments) {
        acc = acc ? `${acc}/${seg}` : seg;
        next.add(acc);
      }
      return next;
    });
  };

  const handleStartInlineCreate = (parentDir: string, kind: 'folder' | 'doc') => {
    if (kind === 'folder' && !onCreateFolder) return;
    if (kind === 'doc' && !onCreateDocument) return;
    setRenamingFolderPath(null);
    if (parentDir) expandAncestors(parentDir);
    setInlineCreate({ parentDir, kind });
  };

  const handleSubmitInlineCreate = async (name: string) => {
    if (!inlineCreate || inlineCreateBusy) return;
    const { parentDir, kind } = inlineCreate;
    setInlineCreateBusy(true);
    try {
      if (kind === 'folder' && onCreateFolder) {
        const created = await onCreateFolder(parentDir, name);
        if (created) expandAncestors(created);
      } else if (kind === 'doc' && onCreateDocument) {
        await onCreateDocument(parentDir, name);
      }
    } finally {
      setInlineCreateBusy(false);
      setInlineCreate(null);
    }
  };

  const handleStartRenameFolder = (folderPath: string, currentName: string) => {
    if (!onRenameFolder) return;
    setInlineCreate(null);
    setRenamingFolderPath(folderPath);
    setRenameDraft(currentName);
  };

  const handleCommitRenameFolder = async () => {
    if (!renamingFolderPath || renameBusy || !onRenameFolder) {
      setRenamingFolderPath(null);
      return;
    }
    const oldBase = renamingFolderPath.split('/').pop() ?? renamingFolderPath;
    const trimmed = renameDraft.trim();
    if (!trimmed || trimmed === oldBase) {
      setRenamingFolderPath(null);
      return;
    }
    setRenameBusy(true);
    try {
      await onRenameFolder(renamingFolderPath, trimmed);
    } finally {
      setRenameBusy(false);
      setRenamingFolderPath(null);
    }
  };

  useEffect(() => {
    if (!inlineActionSignal) return;
    if (inlineActionSignal.kind === 'create-folder') {
      handleStartInlineCreate(inlineActionSignal.folderPath, 'folder');
    } else if (inlineActionSignal.kind === 'create-doc') {
      handleStartInlineCreate(inlineActionSignal.folderPath, 'doc');
    } else if (inlineActionSignal.kind === 'rename-folder' && inlineActionSignal.folderPath) {
      const base = inlineActionSignal.folderPath.split('/').pop() ?? inlineActionSignal.folderPath;
      expandAncestors(inlineActionSignal.folderPath);
      handleStartRenameFolder(inlineActionSignal.folderPath, base);
    }
  }, [inlineActionSignal?.seq]);

  const [batchMode, setBatchMode] = useState(false);
  const [batchSelectedIds, setBatchSelectedIds] = useState<Set<string>>(new Set());
  const batchSupported = Boolean(onBatchMoveFiles || onBatchTrashFiles);

  useEffect(() => {
    if (!batchMode) return;
    const valid = new Set(files.map((f) => f.file_id));
    setBatchSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (valid.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [batchMode, files]);

  const toggleBatchFile = (fileId: string) => {
    setBatchSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  };

  const toggleBatchFolder = (node: FolderNode) => {
    const subIds = collectSubtreeFileIds(node);
    if (subIds.length === 0) return;
    setBatchSelectedIds((prev) => {
      const next = new Set(prev);
      const allChecked = subIds.every((id) => next.has(id));
      for (const id of subIds) {
        if (allChecked) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const exitBatchMode = () => {
    setBatchMode(false);
    setBatchSelectedIds(new Set());
  };

  const prevFiltersRef = useRef<SidebarFiltersSnapshot>(filters);
  const filtersStackRef = useRef<SidebarFiltersSnapshot[]>([]);
  const undoClearRef = useRef<SidebarFiltersSnapshot | null>(null);
  const [undoClearAvailable, setUndoClearAvailable] = useState(false);
  useEffect(() => {
    const prev = prevFiltersRef.current;
    if (prev === filters) return;
    if (
      prev.quickScope !== filters.quickScope ||
      prev.folder !== filters.folder ||
      prev.format !== filters.format ||
      prev.role !== filters.role ||
      prev.topic !== filters.topic
    ) {
      filtersStackRef.current.push(prev);
      if (filtersStackRef.current.length > 40) filtersStackRef.current.shift();
    }
    prevFiltersRef.current = filters;
  }, [filters]);

  const handleClearAllFilters = () => {
    const snapshot: SidebarFiltersSnapshot = { ...filters };
    undoClearRef.current = snapshot;
    setUndoClearAvailable(true);
    onResetFilters();
    window.setTimeout(() => {
      undoClearRef.current = null;
      setUndoClearAvailable(false);
    }, 5200);
  };
  const handleUndoClearFilters = () => {
    const snapshot = undoClearRef.current;
    if (!snapshot) return;
    undoClearRef.current = null;
    setUndoClearAvailable(false);
    onUpdateFilters({ ...snapshot });
  };

  const treeScrollRef = useRef<HTMLDivElement | null>(null);
  const treeDrag = useSidebarTreeDrag({
    enabled: Boolean(onMoveFile || onMoveFolder),
    onAutoExpand: (folderPath) => {
      setExpandedFolders((prev) => {
        if (prev.has(folderPath)) return prev;
        const next = new Set(prev);
        next.add(folderPath);
        return next;
      });
    },
    scrollContainerRef: treeScrollRef,
    onDropMove: (fileId, targetDir) => {
      if (onMoveFile) onMoveFile(fileId, targetDir);
    },
    onDropMoveFolder: onMoveFolder
      ? (folderPath, targetParentDir) => {
          void onMoveFolder(folderPath, targetParentDir);
        }
      : undefined,
  });
  const dragRowProps = useMemo(() => {
    if (!onMoveFile && !onMoveFolder) return null;
    return (folderPath: string): FolderDragRowProps => ({
      onDragOver: treeDrag.handleFolderDragOver,
      onDragLeave: treeDrag.handleFolderDragLeave,
      onDrop: treeDrag.handleFolderDrop,
      dropTarget: treeDrag.isDropTarget(folderPath),
      dropFlash: treeDrag.isDropFlash(folderPath),
      dropBlocked: treeDrag.isDropBlocked(folderPath),
    });
  }, [onMoveFile, onMoveFolder, treeDrag]);
  const fileDragHandlers = useMemo(() => {
    if (!onMoveFile) return null;
    return {
      onDragStart: (event: React.DragEvent) => {
        const row = event.currentTarget as HTMLElement;
        const fileId = row.getAttribute('data-sidebar-file') ?? '';
        const target = fileById.get(fileId);
        if (!target) return;
        treeDrag.beginDrag(event, { file_id: target.file_id, folder: target.folder });
      },
      onDragEnd: () => treeDrag.endDrag(),
    };
  }, [fileById, onMoveFile, treeDrag]);
  const folderDragHandlers = useMemo(() => {
    if (!onMoveFolder) return null;
    return {
      onDragStart: (event: React.DragEvent, folderPath: string) => {
        treeDrag.beginFolderDrag(event, folderPath);
      },
      onDragEnd: () => treeDrag.endDrag(),
    };
  }, [onMoveFolder, treeDrag]);

  useEffect(() => {
    if (filters.folder === 'all') return;
    expandAncestors(filters.folder);
    const raf = requestAnimationFrame(() => {
      document.querySelector('[data-folder-active="true"]')?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(raf);
  }, [filters.folder]);

  useEffect(() => {
    if (!activeFileId) return;
    const hit = fileById.get(activeFileId);
    if (!hit || !hit.folder || hit.folder === '.') return;
    expandAncestors(hit.folder);
  }, [activeFileId]);

  const rootDropActive = treeDrag.isDropTarget('');

  return (
    <aside
      aria-label="阅读状态与目录树"
      data-global-directory-sidebar=""
      style={width ? { width: `${width}px` } : undefined}
      className={`${width ? '' : 'w-[264px]'} shrink-0 bg-card/65 backdrop-blur-xl shadow-[1px_0_0_var(--glass-hairline)] text-[color:var(--ink-strong)] flex flex-col h-full select-none`}
    >
      <div className="px-2.5 pt-2 pb-1.5 space-y-1.5 shrink-0">
        <section className="space-y-1">
          <SegmentedControl
            role="group"
            aria-label="阅读范围筛选"
            size="sm"
            className="grid w-full grid-cols-3 bg-[color:var(--depth-1-bg)]"
          >
            {(
              [
                {
                  id: 'all' as const,
                  label: '全部',
                  count: undefined,
                  title: `全部文档 ${totalCount ?? files.length} 份（点击同时清除目录与状态残留筛选）`,
                  dot: false,
                },
                {
                  id: 'unread' as const,
                  label: '未读',
                  count:
                    unreadCount > 0 && unreadCount < (totalCount ?? files.length)
                      ? unreadCount
                      : undefined,
                  title: `未读 ${unreadCount} 份（业务 ${businessUnreadCount} · 工程 ${systemUnreadCount}；${unreadStatusLabel('never_read')} / ${unreadStatusLabel('updated_since_last_read')}）`,
                  dot: unreadCount > 0,
                },
                {
                  id: 'bookmarked' as const,
                  label: '收藏',
                  count: bookmarkedCount > 0 ? bookmarkedCount : undefined,
                  title: `已收藏 ${bookmarkedCount} 份`,
                  dot: false,
                },
              ]
            ).map((seg) => {
              const active = filters.quickScope === seg.id;
              return (
                <SegmentedControlItem
                  key={seg.id}
                  aria-pressed={active}
                  title={seg.title}
                  onClick={() => {
                    if (seg.id === 'all') {
                      onUpdateFilters({ quickScope: 'all', folder: 'all' });
                      return;
                    }
                    onUpdateFilters({ quickScope: seg.id });
                  }}
                  className="w-full justify-center gap-1 px-1.5 h-7 text-[11.5px]"
                >
                  {seg.dot && (
                    <span
                      aria-hidden="true"
                      className="size-1.5 rounded-full bg-[color:var(--accent-wave)] shrink-0"
                    />
                  )}
                  <span>{seg.label}</span>
                  {seg.count !== undefined && (
                    <span
                      data-sidebar-scope-count={seg.id}
                      className={`font-mono text-[10px] tabular-nums ${
                        active
                          ? 'text-[color:var(--accent-iris-ink)] font-semibold'
                          : 'text-[color:var(--ink-soft)] opacity-80'
                      }`}
                    >
                      {seg.count}
                    </span>
                  )}
                </SegmentedControlItem>
              );
            })}
          </SegmentedControl>

          {totalWorkspaceFiles > 0 && filters.quickScope === 'unread' && (
            <div
              data-sidebar-reading-meter=""
              className="px-0.5 pt-0.5 space-y-1"
            >
              <div className="flex items-center justify-between gap-1.5">
                {unreadCount > 0 ? (
                  readWorkspaceCount > 0 ? (
                    <span className="text-[10.5px] text-[color:var(--ink-soft)] tabular-nums truncate">
                      {`已读 ${readProgressPct}% · 待读 ${unreadCount} 份`}
                    </span>
                  ) : (
                    <span className="sr-only">{`待读 ${unreadCount} 份`}</span>
                  )
                ) : (
                  <span
                    data-sidebar-all-read=""
                    className="inline-flex items-center gap-1 text-[10.5px] font-medium text-[color:var(--stage-ink-deliver-text)] dark:text-[color:var(--success-foreground)]"
                  >
                    <Check className="w-3 h-3 shrink-0 glx-read-confirm-pop" />
                    <span>全部已读</span>
                  </span>
                )}
                {unreadCount > 0 && onMarkReadingBaseline ? (
                  <button
                    type="button"
                    data-mark-baseline-trigger=""
                    disabled={baselineBusy}
                    onClick={() => setBaselineConfirmOpen(true)}
                    title="一键将当前存量文档推进为已读基线（不改写文件、不伪造阅读进度，8 秒内可一键撤销）"
                    className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10.5px] font-medium text-[color:var(--accent-iris-ink)] hover:bg-[color:color-mix(in_srgb,var(--accent-iris)_10%,transparent)] disabled:opacity-50 cursor-pointer transition-colors shrink-0"
                  >
                    <CheckCheck className="w-3 h-3 shrink-0" />
                    <span>确立已读基线</span>
                  </button>
                ) : (
                  <span className="font-mono text-[10px] tabular-nums text-[color:var(--stage-ink-deliver-text)] dark:text-[color:var(--success-foreground)] shrink-0">
                    {readProgressPct}%
                  </span>
                )}
              </div>
              <div
                aria-hidden="true"
                className="h-[2px] w-full rounded-full overflow-hidden bg-[color:color-mix(in_srgb,var(--ink-soft)_12%,transparent)]"
              >
                <div
                  className="glx-read-meter-fill h-full w-full rounded-full bg-[color:var(--status-green)] dark:bg-[color:var(--success)]"
                  style={{ transform: `scaleX(${readProgressRatio})` }}
                />
              </div>
            </div>
          )}
        </section>

        {onMarkReadingBaseline && (
          <AlertDialog open={baselineConfirmOpen} onOpenChange={setBaselineConfirmOpen}>
            <AlertDialogPopup data-mark-baseline-dialog="">
              <AlertDialogHeader>
                <AlertDialogTitle>确立已读基线？</AlertDialogTitle>
                <AlertDialogDescription>
                  将把当前工作区 {unreadCount} 份未读文档的已读基准推进至各自最新版本，帮助你聚焦此后每天新增与发生变化的文档。不会修改任何磁盘文件，也不会伪造阅读进度；确认后 8 秒内可一键撤销。
                  {filters.folder !== 'all' && selectedFolderUnreadCount > 0 && (
                    <> 也可仅确立当前目录「{filters.folder}」（{selectedFolderUnreadCount} 份）。</>
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose
                  render={
                    <CossButton variant="outline" size="sm" disabled={baselineBusy}>
                      取消
                    </CossButton>
                  }
                />
                {filters.folder !== 'all' && selectedFolderUnreadCount > 0 && (
                  <CossButton
                    variant="outline"
                    size="sm"
                    data-confirm-folder-baseline=""
                    disabled={baselineBusy}
                    onClick={() => {
                      if (baselineBusy) return;
                      setBaselineBusy(true);
                      void Promise.resolve(
                        onMarkReadingBaseline('folder', filters.folder)
                      ).finally(() => {
                        setBaselineBusy(false);
                        setBaselineConfirmOpen(false);
                      });
                    }}
                  >
                    <CheckCheck className="w-3.5 h-3.5" />
                    <span>仅当前目录（{selectedFolderUnreadCount} 份）</span>
                  </CossButton>
                )}
                <CossButton
                  variant="default"
                  size="sm"
                  data-confirm-mark-baseline=""
                  disabled={baselineBusy}
                  onClick={() => {
                    if (baselineBusy) return;
                    setBaselineBusy(true);
                    void Promise.resolve(onMarkReadingBaseline('workspace')).finally(() => {
                      setBaselineBusy(false);
                      setBaselineConfirmOpen(false);
                    });
                  }}
                >
                  <CheckCheck className="w-3.5 h-3.5" />
                  <span>{baselineBusy ? '正在确立…' : `确立基线（${unreadCount} 份）`}</span>
                </CossButton>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        )}

        {continueReadingFiles.length > 0 && (
          <section className="space-y-0.5">
            <button
              type="button"
              onClick={() => setContinueReadingOpen((v) => !v)}
              aria-expanded={continueReadingOpen}
              className={`${SECTION_LABEL} w-full justify-between cursor-pointer hover:text-[color:var(--ink-strong)] py-0.5`}
              title="点击折叠/展开最近阅读条目"
            >
              <span className="flex items-center gap-1.5">
                <BookOpen className="w-3 h-3 text-[color:var(--ink-faint)]" />
                <span>继续阅读</span>
                <span className="font-mono text-[9.5px] tracking-normal text-[color:var(--ink-faint)] tabular-nums">
                  {continueReadingFiles.length}
                </span>
              </span>
              <ChevronRight
                className="w-3 h-3 text-[color:var(--ink-faint)] glx-chevron-rot"
                data-open={continueReadingOpen ? 'true' : 'false'}
              />
            </button>
            {continueReadingOpen && (
            <div className="space-y-0.5">
              {continueReadingFiles.map((file) => {
                const st = readingStates[file.file_id];
                const isSelected = file.file_id === activeFileId;
                const reason = unreadReasonByFileId.get(file.file_id);
                const isUpdatedAfterRead = reason === 'updated_since_last_read';
                const pct = Math.max(0, Math.min(100, Math.round(st?.scrollPercent ?? 0)));
                return (
                  <div
                    key={file.file_id}
                    className="group/cr relative rounded-[var(--r-ctl)] overflow-hidden"
                  >
                    <button
                      type="button"
                      data-continue-reading-row={file.file_id}
                      title={
                        st?.updated_at
                          ? `${file.title} · ${formatRelativeObservedAt(st.updated_at)}`
                          : file.title
                      }
                      onClick={() => onOpenFileToRead(file.file_id, st?.last_section_id)}
                      onKeyDown={(e) => {
                        if ((e.code === 'Space' || e.key === ' ') && onQuickPreview) {
                          e.preventDefault();
                          e.stopPropagation();
                          onQuickPreview(file.file_id, file.current_revision_id);
                        }
                      }}
                      onContextMenu={(e) => {
                        if (!onOpenFileContextMenu) return;
                        e.preventDefault();
                        e.stopPropagation();
                        onOpenFileContextMenu(e, {
                          kind: 'file',
                          relativePath: file.relative_path,
                          title: file.title,
                          fileId: file.file_id,
                          revisionId: file.current_revision_id,
                        });
                      }}
                      className={`${FILTER_ROW_BASE} cursor-pointer pb-2 ${
                        isSelected ? TREE_ROW_ACTIVE : FILTER_ROW_IDLE
                      } ${onMarkFileRead ? 'pr-7' : ''}`}
                    >
                      <span className="flex-1 min-w-0 text-left truncate font-medium text-[color:var(--ink-strong)]">
                        {file.title}
                      </span>
                      {isUpdatedAfterRead ? (
                        <span className="shrink-0 rounded-full px-1.5 py-[0.5px] text-[9.5px] font-medium text-[color:var(--accent-wave)] bg-[color:color-mix(in_srgb,var(--accent-wave)_12%,transparent)] border border-[color:color-mix(in_srgb,var(--accent-wave)_24%,transparent)]">
                          有更新
                        </span>
                      ) : pct > 0 ? (
                        <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-[color:var(--accent-iris-ink)]">
                          {pct}%
                        </span>
                      ) : null}
                    </button>
                    {onMarkFileRead && (
                      <button
                        type="button"
                        data-continue-mark-read={file.file_id}
                        aria-label={`标为已读 ${file.title}`}
                        title="标为已读"
                        onClick={(e) => {
                          e.stopPropagation();
                          onMarkFileRead(file.file_id, file.current_revision_id);
                        }}
                        className="hidden group-hover/cr:flex absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded-[6px] items-center justify-center text-[color:var(--ink-soft)] hover:text-[color:var(--stage-ink-deliver-text)] dark:hover:text-[color:var(--success-foreground)] hover:bg-[color:color-mix(in_srgb,var(--status-green)_14%,transparent)] cursor-pointer transition-colors"
                      >
                        <Check className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute left-2 right-2 bottom-[2px] h-[2px] rounded-full overflow-hidden bg-[color:color-mix(in_srgb,var(--ink-soft)_12%,transparent)]"
                    >
                      <div
                        className={`glx-read-meter-fill h-full w-full rounded-full ${
                          isUpdatedAfterRead
                            ? 'bg-[color:var(--accent-wave)]'
                            : 'bg-[color:var(--accent-iris)]'
                        }`}
                        style={{
                          transform: `scaleX(${
                            pct > 0 ? pct / 100 : isUpdatedAfterRead ? 0.35 : 0.12
                          })`,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            )}
          </section>
        )}

        {mergedPinnedItems.length > 0 && (
          <section data-pinned-files-section="" className="space-y-0.5">
            <div className={SECTION_LABEL}>
              <Pin className="w-3 h-3 text-[color:var(--ink-faint)]" />
              <span>置顶</span>
            </div>
            <div className="space-y-0.5">
              {mergedPinnedItems.map((entry) => {
                if (entry.kind === 'global') {
                  const { pin } = entry;
                  const fromOther = Boolean(activeProjectId) && pin.projectId !== activeProjectId;
                  const active = !fromOther && pin.fileId === activeFileId;
                  const uiMeta = formatUiMeta(pin.format as FileFormat);
                  return (
                    <div
                      key={`gpin:${pin.projectId}:${pin.fileId}`}
                      data-pinned-file={pin.fileId}
                      title={`${pin.projectName} / ${pin.relativePath}`}
                      className={`${FILTER_ROW_BASE} group/row cursor-pointer ${
                        active ? TREE_ROW_ACTIVE : FILTER_ROW_IDLE
                      }`}
                      onClick={() => {
                        if (fromOther && onOpenGlobalPin) {
                          onOpenGlobalPin(pin);
                        } else {
                          onOpenFileToRead(pin.fileId);
                        }
                      }}
                    >
                      <span
                        aria-hidden="true"
                        className="size-1.5 rounded-full shrink-0"
                        style={{ backgroundColor: uiMeta.dotColor }}
                      />
                      <span className="flex-1 min-w-0 text-left truncate text-[12px]">
                        {pin.title}
                      </span>
                      {fromOther && (
                        <span className="shrink-0 max-w-[68px] truncate rounded px-1 py-0.5 text-[9.5px] bg-[color:var(--depth-1-bg)] text-[color:var(--ink-soft)] group-hover/row:hidden">
                          {pin.projectName}
                        </span>
                      )}
                      {onToggleGlobalPin && (
                        <button
                          type="button"
                          aria-label={`取消置顶 ${pin.title}`}
                          title="从「置顶」移除"
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleGlobalPin(pin);
                            if (!fromOther && onTogglePinFile && pinnedFileIds.includes(pin.fileId)) {
                              onTogglePinFile(pin.fileId);
                            }
                          }}
                          className="hidden group-hover/row:flex w-4 h-4 rounded items-center justify-center text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)] cursor-pointer shrink-0"
                        >
                          <PinOff className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  );
                }
                const { file } = entry;
                const active = file.file_id === activeFileId;
                const uiMeta = formatUiMeta(file.format);
                return (
                  <div
                    key={file.file_id}
                    data-pinned-file={file.file_id}
                    className={`${FILTER_ROW_BASE} group/row cursor-pointer ${
                      active ? TREE_ROW_ACTIVE : FILTER_ROW_IDLE
                    }`}
                    onClick={() => onOpenFileToRead(file.file_id)}
                  >
                    <span
                      aria-hidden="true"
                      className="size-1.5 rounded-full shrink-0"
                      style={{ backgroundColor: uiMeta.dotColor }}
                    />
                    <span className="flex-1 min-w-0 text-left truncate text-[12px]">
                      {file.title}
                    </span>
                    {onTogglePinFile && (
                      <button
                        type="button"
                        aria-label={`取消置顶 ${file.title}`}
                        title="从「置顶」移除"
                        onClick={(e) => {
                          e.stopPropagation();
                          onTogglePinFile(file.file_id);
                        }}
                        className="hidden group-hover/row:flex w-4 h-4 rounded items-center justify-center text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)] cursor-pointer shrink-0"
                      >
                        <PinOff className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <section>
          <div className="flex items-center justify-between gap-1">
            <button
              type="button"
              onClick={() => setSmartViewsOpen((v) => !v)}
              className={`${SECTION_LABEL} flex-1 justify-between cursor-pointer hover:text-[color:var(--ink-strong)] py-0.5`}
              title="零维护动态视图：成员与计数由同一纯函数即时派生，点击标题可折叠/展开"
            >
              <span className="flex items-center gap-1.5">
                <Layers className="w-3 h-3 text-[color:var(--ink-faint)]" />
                <span>智能视图</span>
              </span>
              <ChevronRight
                className="w-3 h-3 text-[color:var(--ink-faint)] glx-chevron-rot"
                data-open={showSmartViewsBody ? 'true' : 'false'}
              />
            </button>
            {sidebarFiltersActive && !undoClearAvailable && (
              <button
                type="button"
                data-clear-all-filters=""
                onClick={handleClearAllFilters}
                className="glx-pill-tactile inline-flex items-center gap-1 rounded-full border border-[color:var(--glass-hairline)] bg-card/85 hover:bg-card px-2 py-0.5 text-[10.5px] font-medium text-[color:var(--ink-soft)] hover:text-[color:var(--accent-iris-ink)] hover:border-[color:var(--chip-active-border)] cursor-pointer shrink-0"
                title="一键清空目录/状态/格式/角色/主题全部筛选组合（清空后 5 秒内可撤销回退）"
              >
                <RotateCcw className="w-2.5 h-2.5 shrink-0" />
                <span>清空筛选</span>
              </button>
            )}
            {undoClearAvailable && (
              <button
                type="button"
                data-undo-clear-filters=""
                onClick={handleUndoClearFilters}
                className="glx-pill-tactile inline-flex items-center gap-1 rounded-full border border-[color:var(--chip-active-border)] bg-[color:var(--chip-active-bg)] px-2 py-0.5 text-[10.5px] font-medium text-[color:var(--accent-iris-ink)] cursor-pointer shrink-0"
                title="回退到清空前保存的完整筛选组合（状态栈快照）"
              >
                <Undo2 className="w-2.5 h-2.5 shrink-0" />
                <span>撤销</span>
              </button>
            )}
          </div>
          {showSmartViewsBody && (
            <div className="flex flex-wrap gap-1 mt-1" data-smart-views="">
              {smartViewPartition.visible.map((view) => {
                const active = filters.quickScope === view.id;
                const count = smartViewCounts[view.id];
                const ViewIcon = SMART_VIEW_ICONS[view.id];
                const isZero = count === 0 && !active;
                return (
                  <button
                    key={view.id}
                    type="button"
                    data-smart-view={view.id}
                    aria-pressed={active}
                    title={`${view.title} —— 当前 ${count} 份${active ? '（再次点击取消，回到全部）' : ''}`}
                    onClick={() => {
                      if (active) {
                        onUpdateFilters({ quickScope: 'all', folder: 'all' });
                        return;
                      }
                      onUpdateFilters({ quickScope: view.id });
                    }}
                    className={`glx-pill-tactile inline-flex items-center gap-1 rounded-[6px] border px-1.5 py-0.5 text-[10.5px] leading-none cursor-pointer ${
                      active
                        ? 'bg-[color:var(--chip-active-bg)] border-[color:var(--chip-active-border)] text-[color:var(--accent-iris-ink)] font-semibold'
                        : isZero
                          ? 'border-transparent bg-transparent text-[color:var(--ink-soft)] opacity-55 hover:opacity-100 hover:bg-card/80 hover:text-[color:var(--ink-strong)]'
                          : 'border-transparent bg-[color:var(--depth-1-bg)] text-[color:var(--ink-strong)] hover:bg-card hover:border-[color:var(--glass-hairline)]'
                    }`}
                  >
                    <ViewIcon
                      className={`w-3 h-3 shrink-0 ${
                        active ? 'text-[color:var(--accent-iris-deep)]' : 'text-[color:var(--ink-faint)]'
                      }`}
                    />
                    <span className="truncate">{view.label}</span>
                    {count > 0 && count < (totalCount ?? files.length) && (
                      <Badge
                        size="sm"
                        variant={active ? 'default' : 'secondary'}
                        className="font-mono text-[10px] tabular-nums px-1 h-4 min-w-[16px] justify-center"
                      >
                        {count}
                      </Badge>
                    )}
                  </button>
                );
              })}
              {smartViewPartition.visible.length === 0 && (
                <span className="px-1 py-0.5 text-[10.5px] text-[color:var(--ink-faint)]">
                  暂无活跃动态视图
                </span>
              )}
            </div>
          )}
        </section>
      </div>

      <div className="flex-1 min-h-0 flex flex-col border-t border-[color:var(--glass-hairline)] quiet-sep">
        <div
          data-workspace-dir-header=""
          data-drop-folder=""
          onDragOver={dragRowProps ? (e) => treeDrag.handleFolderDragOver(e, '') : undefined}
          onDragLeave={dragRowProps ? (e) => treeDrag.handleFolderDragLeave(e, '') : undefined}
          onDrop={dragRowProps ? (e) => treeDrag.handleFolderDrop(e, '') : undefined}
          className={`px-2.5 py-1.5 flex items-center justify-between gap-1 shrink-0 transition-colors ${
            rootDropActive
              ? 'bg-[color:var(--chip-active-bg)] text-[color:var(--accent-iris-ink)] ring-1 ring-inset ring-[color:var(--accent-iris)]'
              : ''
          }`}
          title={
            treeDrag.isDragging
              ? '释放到此可将文件或文件夹移回当前项目根目录'
              : '多项目真实目录结构（含空文件夹；点击 + 添加本地项目目录，支持多项目同时展开与原地整理）'
          }
        >
          <span className="flex items-center gap-1.5 min-w-0 text-[length:var(--text-micro)] leading-[var(--lh-micro)] font-semibold tracking-wider text-[color:var(--ink-soft)]">
            <Folder className="w-3 h-3 text-[color:var(--ink-faint)] shrink-0" />
            <span className="truncate">
              {rootDropActive
                ? '释放移至根目录'
                : projects.length > 0
                ? '项目目录'
                : '工作区目录'}
            </span>
            {projects.length > 1 && !rootDropActive && (
              <span className="font-mono text-[10px] tabular-nums rounded-full px-1.5 py-0 bg-[color:var(--depth-1-bg)] text-[color:var(--ink-soft)] shrink-0">
                {projects.length}
              </span>
            )}
          </span>
          <div className="flex items-center gap-0.5 shrink-0">
            {onOpenAddProject && (
              <button
                type="button"
                data-add-project-btn=""
                onClick={onOpenAddProject}
                title="添加本地项目文件夹（多项目并列管理，自动索引）"
                aria-label="添加项目"
                className="px-1.5 h-5 rounded-[6px] inline-flex items-center gap-0.5 text-[10.5px] font-medium text-[color:var(--accent-iris-ink)] bg-[color:var(--chip-active-bg)] hover:bg-[color:var(--chip-active-border)]/30 cursor-pointer transition-colors"
              >
                <Plus className="w-3 h-3" />
                <span>项目</span>
              </button>
            )}
            {desktopSystemSupported && onImportIntoFolder && !batchMode && (
              <button
                type="button"
                data-import-external-btn=""
                onClick={() => onImportIntoFolder(filters.folder === 'all' ? '' : filters.folder)}
                title={`导入外部文件到 ${filters.folder === 'all' ? '工作区根目录' : filters.folder}（也可直接拖入窗口）`}
                aria-label="导入文件"
                className="w-5 h-5 rounded-[6px] flex items-center justify-center text-[color:var(--ink-soft)] hover:bg-accent hover:text-[color:var(--ink-strong)] cursor-pointer transition-colors"
              >
                <FolderInput className="w-3.5 h-3.5" />
              </button>
            )}
            {batchSupported && (
              <button
                type="button"
                data-toggle-batch-mode=""
                aria-pressed={batchMode}
                onClick={() => (batchMode ? exitBatchMode() : setBatchMode(true))}
                title={batchMode ? '退出批量整理' : '批量整理当前项目（多选移动 / 移入回收站）'}
                aria-label={batchMode ? '退出批量整理' : '进入批量整理'}
                className={`w-5 h-5 rounded-[6px] flex items-center justify-center cursor-pointer transition-colors ${
                  batchMode
                    ? 'bg-[color:var(--chip-active-bg)] text-[color:var(--accent-iris-ink)]'
                    : 'text-[color:var(--ink-soft)] hover:bg-accent hover:text-[color:var(--ink-strong)]'
                }`}
              >
                <CheckSquare className="w-3.5 h-3.5" />
              </button>
            )}
            {projects.length === 0 && onCreateFolder && (
              <button
                type="button"
                data-create-root-folder-btn=""
                onClick={() => handleStartInlineCreate('', 'folder')}
                title="在工作区根目录新建文件夹"
                aria-label="新建文件夹"
                className="w-5 h-5 rounded-[6px] flex items-center justify-center text-[color:var(--ink-soft)] hover:bg-accent hover:text-[color:var(--ink-strong)] cursor-pointer transition-colors"
              >
                <FolderPlus className="w-3.5 h-3.5" />
              </button>
            )}
            {projects.length === 0 && onCreateDocument && (
              <button
                type="button"
                data-create-root-doc-btn=""
                onClick={() => handleStartInlineCreate('', 'doc')}
                title="在工作区根目录新建 Markdown 文档"
                aria-label="新建文档"
                className="w-5 h-5 rounded-[6px] flex items-center justify-center text-[color:var(--ink-soft)] hover:bg-accent hover:text-[color:var(--ink-strong)] cursor-pointer transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="px-2.5 pb-1 space-y-1 shrink-0">
          <div className="flex items-center gap-1">
            <InputGroup
              data-sidebar-quick-filter=""
              className="h-6.5 flex-1 min-w-0 rounded-[8px] bg-card/80 dark:bg-input/40 text-xs"
            >
              <InputGroupAddon align="inline-start" className="ps-2">
                <Search className="size-3 text-[color:var(--ink-faint)]" aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                size="sm"
                type="text"
                value={treeQuickFilter}
                onChange={(e) => setTreeQuickFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && treeQuickFilter) {
                    e.stopPropagation();
                    setTreeQuickFilter('');
                  }
                }}
                placeholder="快筛目录或文件…"
                aria-label="快筛目录或文件名"
                className="h-6.5 text-[11.5px] px-1.5"
              />
              {quickFilterActive && (
                <InputGroupAddon align="inline-end" className="pe-1.5">
                  <button
                    type="button"
                    aria-label="清空目录快筛"
                    onClick={() => setTreeQuickFilter('')}
                    className="size-4 rounded-full flex items-center justify-center text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)] hover:bg-muted cursor-pointer"
                  >
                    <X className="size-2.5" aria-hidden="true" />
                  </button>
                </InputGroupAddon>
              )}
            </InputGroup>
            <button
              type="button"
              data-sidebar-sort-group=""
              data-sidebar-sort-mode={treeSortMode}
              onClick={() => setTreeSortMode(nextTreeSortMode)}
              aria-label={`目录排序：当前按${treeSortLabel}，点击切换`}
              title={`目录排序：按${treeSortLabel}（点击切换：名称 → 近7日活跃 → 未读数）`}
              className={`h-6.5 shrink-0 inline-flex items-center justify-center gap-1 rounded-[7px] px-1.5 text-[10.5px] cursor-pointer transition-colors ${
                treeSortMode !== 'name'
                  ? 'bg-[color:var(--chip-active-bg)] text-[color:var(--accent-iris-ink)] font-medium'
                  : 'text-[color:var(--ink-soft)] hover:bg-accent hover:text-[color:var(--ink-strong)]'
              }`}
            >
              <ArrowUpDown className="w-3 h-3 shrink-0" />
              {treeSortMode !== 'name' && <span>{treeSortLabel}</span>}
            </button>
          </div>
          {quickFilterActive && (
            <div className="flex items-center justify-between px-0.5 text-[10px] font-mono tabular-nums text-[color:var(--ink-soft)]">
              <span>
                命中 {filteredBusiness.matchedFolderCount + filteredSystem.matchedFolderCount} 目录 ·{' '}
                {filteredBusiness.matchedFileCount + filteredSystem.matchedFileCount} 文件
              </span>
              <button
                type="button"
                onClick={() => setTreeQuickFilter('')}
                className="text-[color:var(--accent-iris-deep)] hover:underline cursor-pointer"
              >
                清除
              </button>
            </div>
          )}
        </div>

        <ScrollArea
          scrollFade
          viewportRef={treeScrollRef}
          className="flex-1 min-h-0"
          viewportClassName="px-1.5 pb-2 quiet-row"
        >
          {projects.length > 0 ? (
            <div className="space-y-1.5" data-multi-project-tree="">
              {projects.map((project) => {
                const isActive = project.project_id === (activeProjectId || projects[0]?.project_id);
                const isExpanded = expandedProjects ? expandedProjects.has(project.project_id) : isActive;
                const isOffline =
                  project.status === 'offline' ||
                  project.status === 'root_in_use' ||
                  project.status === 'error';
                const isRenaming = renamingProjectId === project.project_id;
                const menuOpen = projectMenuId === project.project_id;
                const canWriteProject = !project.readonly && !isOffline;

                return (
                  <div
                    key={project.project_id}
                    data-project-node={project.project_id}
                    data-project-active={isActive ? 'true' : 'false'}
                    className="relative"
                  >
                    <div
                      data-drop-folder={isActive ? '' : undefined}
                      onDragOver={
                        isActive && dragRowProps
                          ? (e) => treeDrag.handleFolderDragOver(e, '')
                          : undefined
                      }
                      onDragLeave={
                        isActive && dragRowProps
                          ? (e) => treeDrag.handleFolderDragLeave(e, '')
                          : undefined
                      }
                      onDrop={
                        isActive && dragRowProps
                          ? (e) => treeDrag.handleFolderDrop(e, '')
                          : undefined
                      }
                      className={`group/proj flex items-center gap-1 px-1.5 py-1.5 rounded-[10px] border transition-colors ${
                        isActive
                          ? 'bg-[color:var(--chip-active-bg)] border-[color:var(--chip-active-border)] text-[color:var(--ink-strong)] font-semibold'
                          : 'border-transparent text-[color:var(--ink-soft)] hover:bg-accent hover:text-[color:var(--ink-strong)]'
                      }`}
                      title={`${project.name} · ${project.root_path}${
                        project.readonly ? '（只读归档保护）' : ''
                      }${project.error ? ` · ${project.error}` : ''}`}
                    >
                      <button
                        type="button"
                        data-project-toggle={project.project_id}
                        aria-label={isExpanded ? `收起项目 ${project.name}` : `展开项目 ${project.name}`}
                        onClick={() => onToggleProjectExpanded?.(project.project_id)}
                        className="w-4 h-4 shrink-0 flex items-center justify-center rounded text-[color:var(--ink-faint)] hover:text-[color:var(--ink-strong)] cursor-pointer"
                      >
                        {isExpanded ? (
                          <ChevronDown className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5" />
                        )}
                      </button>

                      {project.is_scanning ? (
                        <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-[color:var(--accent-iris-deep)]" />
                      ) : project.readonly ? (
                        <Lock
                          className={`w-3.5 h-3.5 shrink-0 ${
                            isActive ? 'text-[color:var(--accent-iris-deep)]' : 'text-[color:var(--ink-faint)]'
                          }`}
                        />
                      ) : isExpanded ? (
                        <FolderOpen
                          className={`w-3.5 h-3.5 shrink-0 ${
                            isActive ? 'text-[color:var(--accent-iris-deep)]' : 'text-[color:var(--ink-faint)]'
                          }`}
                        />
                      ) : (
                        <Folder
                          className={`w-3.5 h-3.5 shrink-0 ${
                            isActive ? 'text-[color:var(--accent-iris-deep)]' : 'text-[color:var(--ink-faint)]'
                          }`}
                        />
                      )}

                      {isRenaming ? (
                        <input
                          type="text"
                          autoFocus
                          disabled={projectRenameBusy}
                          value={projectRenameDraft}
                          onChange={(e) => setProjectRenameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void handleCommitProjectRename();
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              setRenamingProjectId(null);
                            }
                          }}
                          onBlur={() => void handleCommitProjectRename()}
                          className="flex-1 min-w-0 bg-background rounded px-1.5 py-0.5 text-[12px] font-medium text-[color:var(--ink-strong)] border border-[color:var(--accent-iris-deep)] focus:outline-none"
                        />
                      ) : (
                        <button
                          type="button"
                          data-project-select={project.project_id}
                          onClick={() => {
                            if (isActive) {
                              onUpdateFilters({ folder: 'all', quickScope: 'all' });
                              if (!isExpanded) onToggleProjectExpanded?.(project.project_id);
                            } else if (!isOffline) {
                              onActivateProject?.(project.project_id);
                            }
                          }}
                          className="flex-1 min-w-0 text-left truncate text-[12.5px] leading-tight cursor-pointer"
                        >
                          {project.name}
                        </button>
                      )}

                      {!isRenaming && (
                        <span
                          className={`${
                            menuOpen ? 'flex' : 'hidden group-hover/proj:flex'
                          } items-center gap-0.5 shrink-0`}
                        >
                          {canWriteProject && (
                            <>
                              <button
                                type="button"
                                data-project-create-folder={project.project_id}
                                title={`在「${project.name}」根目录新建文件夹`}
                                aria-label={`在 ${project.name} 新建文件夹`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (!isExpanded) onToggleProjectExpanded?.(project.project_id);
                                  if (isActive) {
                                    handleStartInlineCreate('', 'folder');
                                  } else {
                                    setProjectInlineCreate({
                                      projectId: project.project_id,
                                      parentDir: '',
                                      kind: 'folder',
                                    });
                                  }
                                }}
                                className="w-5 h-5 rounded-[6px] flex items-center justify-center text-[color:var(--ink-soft)] hover:bg-accent hover:text-[color:var(--ink-strong)] cursor-pointer"
                              >
                                <FolderPlus className="w-3 h-3" />
                              </button>
                              <button
                                type="button"
                                data-project-create-doc={project.project_id}
                                title={`在「${project.name}」根目录新建 Markdown 文档`}
                                aria-label={`在 ${project.name} 新建文档`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (!isExpanded) onToggleProjectExpanded?.(project.project_id);
                                  if (isActive) {
                                    handleStartInlineCreate('', 'doc');
                                  } else {
                                    setProjectInlineCreate({
                                      projectId: project.project_id,
                                      parentDir: '',
                                      kind: 'doc',
                                    });
                                  }
                                }}
                                className="w-5 h-5 rounded-[6px] flex items-center justify-center text-[color:var(--ink-soft)] hover:bg-accent hover:text-[color:var(--ink-strong)] cursor-pointer"
                              >
                                <Plus className="w-3 h-3" />
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            data-project-menu-btn={project.project_id}
                            aria-label={`项目 ${project.name} 更多操作`}
                            title="项目操作菜单"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              setProjectMenuId((cur) =>
                                cur === project.project_id ? null : project.project_id
                              );
                            }}
                            className="w-5 h-5 rounded-[6px] flex items-center justify-center text-[color:var(--ink-soft)] hover:bg-accent hover:text-[color:var(--ink-strong)] cursor-pointer"
                          >
                            <MoreHorizontal className="w-3.5 h-3.5" />
                          </button>
                        </span>
                      )}

                      {!isRenaming && !menuOpen && (projects.length > 1 || isOffline) && (
                        <span className="flex items-center gap-1 shrink-0 group-hover/proj:hidden">
                          {isOffline ? (
                            <span className="font-mono text-[10px] text-[color:var(--stage-ink-exec-text)]">
                              离线
                            </span>
                          ) : (
                            <span className="font-mono text-[10.5px] tabular-nums text-[color:var(--ink-soft)]">
                              {isActive ? totalCount ?? files.length : project.file_count}
                            </span>
                          )}
                        </span>
                      )}
                    </div>

                    {menuOpen && (
                      <div
                        role="menu"
                        data-project-menu={project.project_id}
                        onPointerDown={(e) => e.stopPropagation()}
                        className="glass-pop absolute right-1 top-8 z-40 w-44 rounded-[11px] border border-[color:var(--glass-hairline)] p-1 shadow-xl space-y-0.5 text-[12px]"
                      >
                        {!isActive && !isOffline && (
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setProjectMenuId(null);
                              onActivateProject?.(project.project_id);
                            }}
                            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[7px] text-left text-[color:var(--ink-strong)] hover:bg-[color:var(--chip-active-bg)] hover:text-[color:var(--accent-iris-ink)] cursor-pointer"
                          >
                            <FolderOpen className="w-3.5 h-3.5 shrink-0" />
                            <span>设为当前聚焦项目</span>
                          </button>
                        )}
                        {canWriteProject && (
                          <>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setProjectMenuId(null);
                                if (!isExpanded) onToggleProjectExpanded?.(project.project_id);
                                if (isActive) {
                                  handleStartInlineCreate('', 'folder');
                                } else {
                                  setProjectInlineCreate({
                                    projectId: project.project_id,
                                    parentDir: '',
                                    kind: 'folder',
                                  });
                                }
                              }}
                              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[7px] text-left text-[color:var(--ink-strong)] hover:bg-accent cursor-pointer"
                            >
                              <FolderPlus className="w-3.5 h-3.5 shrink-0 text-[color:var(--ink-soft)]" />
                              <span>新建文件夹</span>
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setProjectMenuId(null);
                                if (!isExpanded) onToggleProjectExpanded?.(project.project_id);
                                if (isActive) {
                                  handleStartInlineCreate('', 'doc');
                                } else {
                                  setProjectInlineCreate({
                                    projectId: project.project_id,
                                    parentDir: '',
                                    kind: 'doc',
                                  });
                                }
                              }}
                              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[7px] text-left text-[color:var(--ink-strong)] hover:bg-accent cursor-pointer"
                            >
                              <FilePlus2 className="w-3.5 h-3.5 shrink-0 text-[color:var(--ink-soft)]" />
                              <span>新建 Markdown 文档</span>
                            </button>
                          </>
                        )}
                        {!isOffline && onRescanProject && (
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setProjectMenuId(null);
                              onRescanProject(project.project_id);
                            }}
                            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[7px] text-left text-[color:var(--ink-strong)] hover:bg-accent cursor-pointer"
                          >
                            <RefreshCw className="w-3.5 h-3.5 shrink-0 text-[color:var(--ink-soft)]" />
                            <span>重新扫描此项目</span>
                          </button>
                        )}
                        {onRenameProject && (
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setProjectMenuId(null);
                              setRenamingProjectId(project.project_id);
                              setProjectRenameDraft(project.name);
                            }}
                            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[7px] text-left text-[color:var(--ink-strong)] hover:bg-accent cursor-pointer"
                          >
                            <Pencil className="w-3.5 h-3.5 shrink-0 text-[color:var(--ink-soft)]" />
                            <span>重命名显示名</span>
                          </button>
                        )}
                        {onToggleProjectReadonly && (
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setProjectMenuId(null);
                              void onToggleProjectReadonly(project.project_id, !project.readonly);
                            }}
                            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[7px] text-left text-[color:var(--ink-strong)] hover:bg-accent cursor-pointer"
                          >
                            {project.readonly ? (
                              <LockOpen className="w-3.5 h-3.5 shrink-0 text-[color:var(--ink-soft)]" />
                            ) : (
                              <Lock className="w-3.5 h-3.5 shrink-0 text-[color:var(--ink-soft)]" />
                            )}
                            <span>{project.readonly ? '恢复读写模式' : '开启只读保护'}</span>
                          </button>
                        )}
                        {projects.length > 1 && onRemoveProject && (
                          <>
                            <div className="my-1 border-t border-[color:var(--glass-hairline)]" />
                            <button
                              type="button"
                              role="menuitem"
                              data-project-remove={project.project_id}
                              onClick={() => {
                                setProjectMenuId(null);
                                onRemoveProject(project.project_id);
                              }}
                              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-[7px] text-left text-[color:var(--btn-danger-ink)] hover:bg-accent cursor-pointer"
                            >
                              <Unlink className="w-3.5 h-3.5 shrink-0" />
                              <span>移出列表（不删磁盘）</span>
                            </button>
                          </>
                        )}
                      </div>
                    )}

                    {isExpanded &&
                      (isActive ? (
                        <div className="pl-2 mt-0.5 space-y-0.5">
                          {inlineCreate?.parentDir === '' && (
                            <InlineCreateRow
                              kind={inlineCreate.kind}
                              depth={0}
                              busy={inlineCreateBusy}
                              onSubmit={(name) => void handleSubmitInlineCreate(name)}
                              onCancel={() => setInlineCreate(null)}
                            />
                          )}

                          <FolderTreeRows
                            nodes={displayBusinessNodes}
                            depth={0}
                            selected={filters.folder}
                            activeFileId={activeFileId}
                            expanded={effectiveExpandedFolders}
                            dropHoveredFolder={dropHoveredFolder}
                            batchMode={batchMode && !project.readonly}
                            batchSelectedIds={batchSelectedIds}
                            onToggleBatchFile={toggleBatchFile}
                            onToggleBatchFolder={toggleBatchFolder}
                            onToggle={toggleFolder}
                            onSelect={selectFolder}
                            onSelectFile={onSelectFile}
                            onOpenFileToRead={onOpenFileToRead}
                            onQuickPreview={onQuickPreview}
                            onOpenContextMenu={onOpenFileContextMenu}
                            dragRowProps={project.readonly ? null : dragRowProps}
                            folderDragHandlers={project.readonly ? null : folderDragHandlers}
                            fileDragHandlers={project.readonly ? null : fileDragHandlers}
                            folderActivity={displayFolderActivity}
                            unreadFileIds={unreadFileIds}
                            unreadReasonByFileId={unreadReasonByFileId}
                            onMarkFileRead={onMarkFileRead}
                            onMarkFileUnread={onMarkFileUnread}
                            onMarkFolderRead={handleMarkFolderReadQuick}
                            inlineCreate={inlineCreate}
                            inlineCreateBusy={inlineCreateBusy}
                            onStartInlineCreate={
                              !project.readonly && (onCreateFolder || onCreateDocument)
                                ? handleStartInlineCreate
                                : undefined
                            }
                            onSubmitInlineCreate={(name) => void handleSubmitInlineCreate(name)}
                            onCancelInlineCreate={() => setInlineCreate(null)}
                            renamingFolderPath={renamingFolderPath}
                            renameDraft={renameDraft}
                            renameBusy={renameBusy}
                            onStartRenameFolder={
                              !project.readonly && onRenameFolder
                                ? handleStartRenameFolder
                                : undefined
                            }
                            onRenameDraftChange={setRenameDraft}
                            onCommitRenameFolder={() => void handleCommitRenameFolder()}
                            onCancelRenameFolder={() => setRenamingFolderPath(null)}
                            mutedFolders={mutedFolders}
                            quickFilter={treeQuickFilter}
                            previewHandle={sidebarPreviewHandle}
                            emphasizeUnread={emphasizeFolderUnread}
                          />
                          {(() => {
                            const rootPrefixMap = getCachedSiblingPrefixMap(displayRootFiles);
                            const rootDense = displayRootFiles.length >= SIDEBAR_DENSE_FOLDER_THRESHOLD;
                            const rootMixedFormat = getCachedMixedFormats(displayRootFiles);
                            return (
                              <VirtualFileSlice
                                items={displayRootFiles}
                                getKey={getSidebarFileKey}
                                activeKey={activeFileId}
                                renderItem={(file, fileIdx) => (
                                  <SidebarFileLeaf
                                    showFormat={rootMixedFormat}
                                    file={file}
                                    depth={0}
                                    active={file.file_id === activeFileId}
                                    batchMode={batchMode && !project.readonly}
                                    batchSelected={batchSelectedIds.has(file.file_id)}
                                    onToggleBatchFile={toggleBatchFile}
                                    onSelectFile={onSelectFile}
                                    onOpenFileToRead={onOpenFileToRead}
                                    onQuickPreview={onQuickPreview}
                                    onOpenContextMenu={onOpenFileContextMenu}
                                    fileDragHandlers={project.readonly ? null : fileDragHandlers}
                                    unread={unreadFileIds.has(file.file_id)}
                                    unreadReason={unreadReasonByFileId.get(file.file_id)}
                                    onMarkFileRead={onMarkFileRead}
                                    onMarkFileUnread={onMarkFileUnread}
                                    dense={rootDense}
                                    rowIdx={fileIdx}
                                    sharedPrefixLen={rootPrefixMap?.get(file.title) ?? 0}
                                    quickFilter={treeQuickFilter}
                                    previewHandle={sidebarPreviewHandle}
                                  />
                                )}
                              />
                            );
                          })()}
                          {displayBusinessNodes.length === 0 && displayRootFiles.length === 0 && displaySystemNodes.length === 0 && !inlineCreate && (
                            <div className="px-3 py-2 text-[11px] text-[color:var(--ink-faint)]">
                              {emptyTreeLabel}
                            </div>
                          )}

                          {displaySystemNodes.length > 0 && (
                            <>
                              <div className="my-1 mx-2 border-t border-[color:var(--glass-hairline)] quiet-sep" />
                              <div
                                className={`${FILTER_ROW_BASE} group/row quiet-row ${
                                  systemGroupOpen ? 'text-[color:var(--ink-soft)]' : FILTER_ROW_IDLE
                                }`}
                                title="系统生成物与产出目录（output / _tools / _qa 等），与业务文档分区"
                              >
                                <button
                                  type="button"
                                  aria-label={systemGroupOpen ? '收起工程与产出物' : '展开工程与产出物'}
                                  className="w-4 h-4 shrink-0 flex items-center justify-center rounded-[var(--r-ctl)] cursor-pointer hover:text-[color:var(--ink-strong)] text-[color:var(--ink-faint)]"
                                  onClick={() => setSystemGroupOpen((v) => !v)}
                                >
                                  {systemGroupOpen || quickFilterActive ? (
                                    <ChevronDown className="w-3 h-3" />
                                  ) : (
                                    <ChevronRight className="w-3 h-3" />
                                  )}
                                </button>
                                <Cog className="w-3.5 h-3.5 shrink-0 text-[color:var(--ink-faint)]" />
                                <button
                                  type="button"
                                  className="flex-1 min-w-0 text-left truncate cursor-pointer"
                                  onClick={() => setSystemGroupOpen((v) => !v)}
                                >
                                  工程与产出物
                                </button>
                                <span className={`${ROW_COUNT} flex items-center gap-1`}>
                                  {emphasizeFolderUnread && displaySystemUnread > 0 ? (
                                    <span
                                      data-system-group-unread={displaySystemUnread}
                                      title={`工程与产出物未读 ${displaySystemUnread} 份 / 共 ${displaySystemTotal} 份`}
                                      className="font-mono text-[10.5px] tabular-nums text-[color:var(--accent-wave)]"
                                    >
                                      {displaySystemUnread}
                                    </span>
                                  ) : (
                                    displaySystemTotal
                                  )}
                                </span>
                              </div>
                              {(systemGroupOpen || quickFilterActive) && (
                                <FolderTreeRows
                                  nodes={displaySystemNodes}
                                  depth={0}
                                  selected={filters.folder}
                                  activeFileId={activeFileId}
                                  expanded={effectiveExpandedFolders}
                                  dropHoveredFolder={dropHoveredFolder}
                                  batchMode={batchMode && !project.readonly}
                                  batchSelectedIds={batchSelectedIds}
                                  onToggleBatchFile={toggleBatchFile}
                                  onToggleBatchFolder={toggleBatchFolder}
                                  onToggle={toggleFolder}
                                  onSelect={selectFolder}
                                  onSelectFile={onSelectFile}
                                  onOpenFileToRead={onOpenFileToRead}
                                  onQuickPreview={onQuickPreview}
                                  onOpenContextMenu={onOpenFileContextMenu}
                                  dragRowProps={project.readonly ? null : dragRowProps}
                                  folderDragHandlers={project.readonly ? null : folderDragHandlers}
                                  fileDragHandlers={project.readonly ? null : fileDragHandlers}
                                  folderActivity={displayFolderActivity}
                                  unreadFileIds={unreadFileIds}
                                  unreadReasonByFileId={unreadReasonByFileId}
                                  onMarkFileRead={onMarkFileRead}
                                  onMarkFileUnread={onMarkFileUnread}
                                  onMarkFolderRead={handleMarkFolderReadQuick}
                                  inlineCreate={inlineCreate}
                                  inlineCreateBusy={inlineCreateBusy}
                                  onStartInlineCreate={
                                    !project.readonly && (onCreateFolder || onCreateDocument)
                                      ? handleStartInlineCreate
                                      : undefined
                                  }
                                  onSubmitInlineCreate={(name) => void handleSubmitInlineCreate(name)}
                                  onCancelInlineCreate={() => setInlineCreate(null)}
                                  renamingFolderPath={renamingFolderPath}
                                  renameDraft={renameDraft}
                                  renameBusy={renameBusy}
                                  onStartRenameFolder={
                                    !project.readonly && onRenameFolder
                                      ? handleStartRenameFolder
                                      : undefined
                                  }
                                  onRenameDraftChange={setRenameDraft}
                                  onCommitRenameFolder={() => void handleCommitRenameFolder()}
                                  onCancelRenameFolder={() => setRenamingFolderPath(null)}
                                  mutedFolders={mutedFolders}
                                  quickFilter={treeQuickFilter}
                                  previewHandle={sidebarPreviewHandle}
                                  emphasizeUnread={emphasizeFolderUnread}
                                />
                              )}
                            </>
                          )}
                        </div>
                      ) : (
                        <ProjectTreeBranch
                          project={project}
                          cache={projectTrees[project.project_id]}
                          inlineCreate={
                            projectInlineCreate?.projectId === project.project_id
                              ? {
                                  parentDir: projectInlineCreate.parentDir,
                                  kind: projectInlineCreate.kind,
                                }
                              : null
                          }
                          inlineCreateBusy={projectInlineCreateBusy}
                          onStartInlineCreate={
                            canWriteProject && (onCreateFolderInProject || onCreateDocumentInProject)
                              ? (parentDir, kind) =>
                                  setProjectInlineCreate({
                                    projectId: project.project_id,
                                    parentDir,
                                    kind,
                                  })
                              : undefined
                          }
                          onSubmitInlineCreate={(name) =>
                            void handleSubmitProjectInlineCreate(name)
                          }
                          onCancelInlineCreate={() => setProjectInlineCreate(null)}
                          onOpenFolder={(pid, folderPath) =>
                            onActivateProject?.(pid, { folder: folderPath })
                          }
                          onOpenFile={(pid, fileId) =>
                            onActivateProject?.(pid, { fileId })
                          }
                          onToggleGlobalPin={onToggleGlobalPin}
                          globalPinnedKeys={globalPinnedKeys}
                        />
                      ))}
                  </div>
                );
              })}
            </div>
          ) : (
            <>
              {inlineCreate?.parentDir === '' && (
                <InlineCreateRow
                  kind={inlineCreate.kind}
                  depth={0}
                  busy={inlineCreateBusy}
                  onSubmit={(name) => void handleSubmitInlineCreate(name)}
                  onCancel={() => setInlineCreate(null)}
                />
              )}

              <FolderTreeRows
                nodes={displayBusinessNodes}
                depth={0}
                selected={filters.folder}
                activeFileId={activeFileId}
                expanded={effectiveExpandedFolders}
                dropHoveredFolder={dropHoveredFolder}
                batchMode={batchMode}
                batchSelectedIds={batchSelectedIds}
                onToggleBatchFile={toggleBatchFile}
                onToggleBatchFolder={toggleBatchFolder}
                onToggle={toggleFolder}
                onSelect={selectFolder}
                onSelectFile={onSelectFile}
                onOpenFileToRead={onOpenFileToRead}
                onQuickPreview={onQuickPreview}
                onOpenContextMenu={onOpenFileContextMenu}
                dragRowProps={dragRowProps}
                folderDragHandlers={folderDragHandlers}
                fileDragHandlers={fileDragHandlers}
                folderActivity={displayFolderActivity}
                unreadFileIds={unreadFileIds}
                unreadReasonByFileId={unreadReasonByFileId}
                onMarkFileRead={onMarkFileRead}
                onMarkFileUnread={onMarkFileUnread}
                onMarkFolderRead={handleMarkFolderReadQuick}
                inlineCreate={inlineCreate}
                inlineCreateBusy={inlineCreateBusy}
                onStartInlineCreate={
                  onCreateFolder || onCreateDocument ? handleStartInlineCreate : undefined
                }
                onSubmitInlineCreate={(name) => void handleSubmitInlineCreate(name)}
                onCancelInlineCreate={() => setInlineCreate(null)}
                renamingFolderPath={renamingFolderPath}
                renameDraft={renameDraft}
                renameBusy={renameBusy}
                onStartRenameFolder={onRenameFolder ? handleStartRenameFolder : undefined}
                onRenameDraftChange={setRenameDraft}
                onCommitRenameFolder={() => void handleCommitRenameFolder()}
                onCancelRenameFolder={() => setRenamingFolderPath(null)}
                mutedFolders={mutedFolders}
                quickFilter={treeQuickFilter}
                previewHandle={sidebarPreviewHandle}
                emphasizeUnread={emphasizeFolderUnread}
              />
              {(() => {
                const rootPrefixMap = getCachedSiblingPrefixMap(displayRootFiles);
                const rootDense = displayRootFiles.length >= SIDEBAR_DENSE_FOLDER_THRESHOLD;
                const rootMixedFormat = getCachedMixedFormats(displayRootFiles);
                return (
                  <VirtualFileSlice
                    items={displayRootFiles}
                    getKey={getSidebarFileKey}
                    activeKey={activeFileId}
                    renderItem={(file, fileIdx) => (
                      <SidebarFileLeaf
                        showFormat={rootMixedFormat}
                        file={file}
                        depth={0}
                        active={file.file_id === activeFileId}
                        batchMode={batchMode}
                        batchSelected={batchSelectedIds.has(file.file_id)}
                        onToggleBatchFile={toggleBatchFile}
                        onSelectFile={onSelectFile}
                        onOpenFileToRead={onOpenFileToRead}
                        onQuickPreview={onQuickPreview}
                        onOpenContextMenu={onOpenFileContextMenu}
                        fileDragHandlers={fileDragHandlers}
                        unread={unreadFileIds.has(file.file_id)}
                        unreadReason={unreadReasonByFileId.get(file.file_id)}
                        onMarkFileRead={onMarkFileRead}
                        onMarkFileUnread={onMarkFileUnread}
                        dense={rootDense}
                        rowIdx={fileIdx}
                        sharedPrefixLen={rootPrefixMap?.get(file.title) ?? 0}
                        quickFilter={treeQuickFilter}
                        previewHandle={sidebarPreviewHandle}
                      />
                    )}
                  />
                );
              })()}
              {displayBusinessNodes.length === 0 && displayRootFiles.length === 0 && displaySystemNodes.length === 0 && !inlineCreate && (
                dataSource === 'loading' && files.length === 0 ? (
                  <div
                    role="status"
                    aria-busy="true"
                    aria-label="正在加载目录"
                    className="px-3 py-3 space-y-2"
                  >
                    <div className="h-4 w-3/4 rounded-[var(--r-ctl)] bg-muted motion-safe:animate-pulse" />
                    <div className="h-4 w-1/2 rounded-[var(--r-ctl)] bg-muted motion-safe:animate-pulse" />
                    <div className="h-4 w-5/6 rounded-[var(--r-ctl)] bg-muted motion-safe:animate-pulse" />
                  </div>
                ) : dataSource === 'error' && files.length === 0 ? (
                  <div role="alert" className="px-3 py-4 text-center space-y-2">
                    <div className="text-[length:var(--text-micro)] text-[color:var(--stage-ink-exec-text)]">
                      读服务未连接，目录暂不可读
                    </div>
                    {onRetryConnection && (
                      <button
                        type="button"
                        disabled={retryingConnection}
                        onClick={onRetryConnection}
                        className="inline-flex items-center justify-center rounded-[var(--r-ctl)] border border-[color:var(--btn-secondary-border)] bg-[color:var(--btn-secondary-bg)] px-2.5 py-1 text-[length:var(--text-micro)] font-medium text-[color:var(--ink-strong)] hover:bg-[color:var(--btn-secondary-bg-hover)] disabled:opacity-50 cursor-pointer"
                      >
                        {retryingConnection ? '重试中…' : '重试连接'}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="px-3 py-4 text-center text-[length:var(--text-micro)] text-[color:var(--ink-soft)]">
                    {quickFilterActive
                      ? emptyTreeLabel
                      : filters.quickScope === 'all'
                        ? '当前工作区暂无目录或文件'
                        : emptyTreeLabel}
                  </div>
                )
              )}

              {displaySystemNodes.length > 0 && (
                <>
                  <div className="my-1.5 mx-2 border-t border-[color:var(--glass-hairline)] quiet-sep" />
                  <div
                    className={`${FILTER_ROW_BASE} group/row quiet-row ${systemGroupOpen ? 'text-[color:var(--ink-soft)]' : FILTER_ROW_IDLE}`}
                    title="系统生成物与产出目录（output / _tools / _qa 等），与业务文档分区"
                  >
                    <button
                      type="button"
                      aria-label={systemGroupOpen ? '收起工程与产出物' : '展开工程与产出物'}
                      className="w-4 h-4 shrink-0 flex items-center justify-center rounded-[var(--r-ctl)] cursor-pointer hover:text-[color:var(--ink-strong)] text-[color:var(--ink-faint)]"
                      onClick={() => setSystemGroupOpen((v) => !v)}
                    >
                      {systemGroupOpen || quickFilterActive ? (
                        <ChevronDown className="w-3 h-3" />
                      ) : (
                        <ChevronRight className="w-3 h-3" />
                      )}
                    </button>
                    <Cog className="w-3.5 h-3.5 shrink-0 text-[color:var(--ink-faint)]" />
                    <button
                      type="button"
                      className="flex-1 min-w-0 text-left truncate cursor-pointer"
                      onClick={() => setSystemGroupOpen((v) => !v)}
                    >
                      工程与产出物
                    </button>
                    <span className={`${ROW_COUNT} flex items-center gap-1`}>
                      {emphasizeFolderUnread && displaySystemUnread > 0 ? (
                        <span
                          data-system-group-unread={displaySystemUnread}
                          title={`工程与产出物未读 ${displaySystemUnread} 份 / 共 ${displaySystemTotal} 份`}
                          className="font-mono text-[10.5px] tabular-nums text-[color:var(--accent-wave)]"
                        >
                          {displaySystemUnread}
                        </span>
                      ) : (
                        displaySystemTotal
                      )}
                    </span>
                  </div>
                  {(systemGroupOpen || quickFilterActive) && (
                    <FolderTreeRows
                      nodes={displaySystemNodes}
                      depth={0}
                      selected={filters.folder}
                      activeFileId={activeFileId}
                      expanded={effectiveExpandedFolders}
                      dropHoveredFolder={dropHoveredFolder}
                      batchMode={batchMode}
                      batchSelectedIds={batchSelectedIds}
                      onToggleBatchFile={toggleBatchFile}
                      onToggleBatchFolder={toggleBatchFolder}
                      onToggle={toggleFolder}
                      onSelect={selectFolder}
                      onSelectFile={onSelectFile}
                      onOpenFileToRead={onOpenFileToRead}
                      onQuickPreview={onQuickPreview}
                      onOpenContextMenu={onOpenFileContextMenu}
                      dragRowProps={dragRowProps}
                      folderDragHandlers={folderDragHandlers}
                      fileDragHandlers={fileDragHandlers}
                      folderActivity={displayFolderActivity}
                      unreadFileIds={unreadFileIds}
                      unreadReasonByFileId={unreadReasonByFileId}
                      onMarkFileRead={onMarkFileRead}
                      onMarkFileUnread={onMarkFileUnread}
                      onMarkFolderRead={handleMarkFolderReadQuick}
                      inlineCreate={inlineCreate}
                      inlineCreateBusy={inlineCreateBusy}
                      onStartInlineCreate={
                        onCreateFolder || onCreateDocument ? handleStartInlineCreate : undefined
                      }
                      onSubmitInlineCreate={(name) => void handleSubmitInlineCreate(name)}
                      onCancelInlineCreate={() => setInlineCreate(null)}
                      renamingFolderPath={renamingFolderPath}
                      renameDraft={renameDraft}
                      renameBusy={renameBusy}
                      onStartRenameFolder={onRenameFolder ? handleStartRenameFolder : undefined}
                      onRenameDraftChange={setRenameDraft}
                      onCommitRenameFolder={() => void handleCommitRenameFolder()}
                      onCancelRenameFolder={() => setRenamingFolderPath(null)}
                      mutedFolders={mutedFolders}
                      quickFilter={treeQuickFilter}
                      previewHandle={sidebarPreviewHandle}
                      emphasizeUnread={emphasizeFolderUnread}
                    />
                  )}
                </>
              )}
            </>
          )}

          {filters.folder !== 'all' && (
            <button
              type="button"
              onClick={() => onUpdateFilters({ folder: 'all' })}
              className={`${FILTER_ROW_BASE} group/row cursor-pointer border-transparent bg-[color:var(--depth-1-bg-soft)] hover:bg-[color:var(--depth-1-bg)] text-[color:var(--ink-soft)] hover:text-[color:var(--ink-strong)] mt-1`}
            >
              <span className="w-4 shrink-0" />
              <span className="flex-1 min-w-0 text-left truncate">清除文件夹筛选</span>
            </button>
          )}

          {mounts.length > 0 && onOpenMountManager && onExpandMount && onOpenMountedFile && (
            <MountedWorkspacesSection
              mounts={mounts}
              mountedTrees={mountedTrees}
              onExpandMount={onExpandMount}
              onOpenMountedFile={onOpenMountedFile}
              onOpenMountManager={onOpenMountManager}
            />
          )}
        </ScrollArea>

        {mutedFolders.length > 0 && !batchMode && (
          <div className="px-2.5 py-1.5 border-t border-[color:var(--glass-hairline)] bg-[color:var(--depth-1-bg-soft)] shrink-0">
            <Popover>
              <PopoverTrigger
                data-muted-folders-pill={mutedFolders.length}
                className="w-full flex items-center justify-between gap-1.5 rounded-[8px] px-2 py-1 text-[11px] text-[color:var(--ink-soft)] hover:bg-accent hover:text-[color:var(--ink-strong)] cursor-pointer transition-colors"
              >
                <span className="flex items-center gap-1.5 min-w-0">
                  <EyeOff className="w-3 h-3 shrink-0 text-[color:var(--ink-faint)]" aria-hidden="true" />
                  <span className="truncate">已静默 {mutedFolders.length} 个目录</span>
                </span>
                <span className="text-[10px] text-[color:var(--accent-iris-deep)] shrink-0">管理</span>
              </PopoverTrigger>
              <PopoverPopup side="top" align="start" className="w-64 p-0">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2 pb-1.5 border-b border-border">
                    <span className="text-xs font-semibold text-foreground">
                      已静默目录（{mutedFolders.length}）
                    </span>
                    {onClearMutedFolders && (
                      <button
                        type="button"
                        data-clear-muted-folders=""
                        onClick={() => onClearMutedFolders()}
                        className="text-[11px] text-[color:var(--accent-iris-deep)] hover:underline cursor-pointer"
                      >
                        全部恢复
                      </button>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    静默目录仅在星图、日历与列表时间线中隐藏噪点，磁盘零写入，仍可随时阅读或 Ctrl+K 检索。
                  </p>
                  <div className="max-h-40 overflow-y-auto space-y-1">
                    {mutedFolders.map((dir) => (
                      <div
                        key={dir}
                        className="flex items-center justify-between gap-2 rounded-lg bg-muted/60 px-2 py-1 text-xs"
                      >
                        <span className="truncate font-mono text-[11px] text-foreground" title={dir}>
                          {dir}
                        </span>
                        {(onUnmuteFolder || onToggleMuteFolder) && (
                          <button
                            type="button"
                            data-unmute-folder={dir}
                            onClick={() =>
                              onUnmuteFolder ? onUnmuteFolder(dir) : onToggleMuteFolder?.(dir)
                            }
                            className="shrink-0 inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10.5px] font-medium text-[color:var(--accent-iris-ink)] hover:bg-[color:var(--chip-active-bg)] cursor-pointer"
                          >
                            <Eye className="w-3 h-3" aria-hidden="true" />
                            <span>恢复</span>
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </PopoverPopup>
            </Popover>
          </div>
        )}

        {batchMode && (
          <div
            data-batch-action-bar=""
            className="px-2.5 py-2 border-t border-[color:var(--glass-hairline)] bg-card/75 flex items-center justify-between gap-1 shrink-0"
          >
            <span className="text-[length:var(--text-micro)] font-medium text-[color:var(--ink-strong)] tabular-nums truncate">
              已选 {batchSelectedIds.size} 项
            </span>
            <div className="flex items-center gap-1 shrink-0">
              {onBatchMoveFiles && (
                <button
                  type="button"
                  disabled={batchSelectedIds.size === 0}
                  onClick={() => {
                    const ids = Array.from(batchSelectedIds);
                    exitBatchMode();
                    onBatchMoveFiles(ids);
                  }}
                  title="将选中文件批量移动到目标目录"
                  className="px-2 py-1 rounded-[7px] text-[11px] flex items-center gap-1 bg-[color:var(--chip-active-bg)] text-[color:var(--accent-iris-ink)] disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
                >
                  <FolderInput className="w-3 h-3" />
                  <span>移动</span>
                </button>
              )}
              {onBatchTrashFiles && (
                <button
                  type="button"
                  disabled={batchSelectedIds.size === 0}
                  onClick={() => {
                    const ids = Array.from(batchSelectedIds);
                    exitBatchMode();
                    onBatchTrashFiles(ids);
                  }}
                  title="将选中文件批量移入系统回收站"
                  className="px-2 py-1 rounded-[7px] text-[11px] flex items-center gap-1 text-[color:var(--btn-danger-ink)] hover:bg-white disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
                >
                  <Trash2 className="w-3 h-3" />
                  <span>回收站</span>
                </button>
              )}
              <button
                type="button"
                onClick={exitBatchMode}
                title="退出批量整理"
                aria-label="退出批量整理"
                className="w-6 h-6 rounded-[7px] flex items-center justify-center text-[color:var(--ink-soft)] hover:bg-accent hover:text-[color:var(--ink-strong)] cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      <PreviewCard<FileRecord> handle={sidebarPreviewHandle}>
        {({ payload }) => {
          if (!payload) return null;
          const uiMeta = formatUiMeta(payload.format);
          const latestRev =
            payload.revisions.find((r) => r.revision_id === payload.current_revision_id) ??
            payload.revisions[0];
          const summary =
            latestRev?.summaryNote?.trim() || extractCoreSummary(payload)?.trim() || '暂无摘要';
          const unreadInfo = hasUnreadChanges(payload, readingStates[payload.file_id]);
          const updatedText = latestRev?.source_time
            ? latestRev.source_time.slice(0, 10)
            : latestRev?.observed_at
              ? formatRelativeObservedAt(latestRev.observed_at)
              : '';
          return (
            <PreviewCardPopup side="right" align="center" sideOffset={10} data-sidebar-preview-card="">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-[12.5px] text-foreground leading-snug line-clamp-2">
                    {payload.title}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-muted-foreground truncate">
                    {payload.relative_path}
                  </div>
                </div>
                <Badge variant="secondary" size="sm" className="font-mono text-[9.5px] shrink-0">
                  {uiMeta.label}
                </Badge>
              </div>
              <p className="text-[11.5px] leading-relaxed text-muted-foreground line-clamp-3">
                {summary}
              </p>
              <div className="flex items-center justify-between gap-2 pt-1 border-t border-border text-[10px] font-mono text-muted-foreground tabular-nums">
                <span className="flex items-center gap-1.5">
                  {latestRev ? <span>v{latestRev.versionNumber || 1}</span> : null}
                  {unreadInfo.isUnread && (
                    <Badge variant="warning" size="sm" className="text-[9px] h-4 px-1">
                      未读
                    </Badge>
                  )}
                </span>
                {updatedText && <span>{updatedText}</span>}
              </div>
            </PreviewCardPopup>
          );
        }}
      </PreviewCard>
    </aside>
  );
};
